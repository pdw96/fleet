import type { ApiProviderConfig } from '../../../shared/types'
import { sseData } from './sse'
import {
  ApiProviderError,
  defaultHttp,
  requireApiKey,
  textOf,
  type ApiCallOptions,
  type ApiProvider,
  type ChatResult,
  type ChatTurn,
  type ContentBlock,
  type FinishReason,
  type HttpClient,
  type ToolUseBlock,
} from './types'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'
/** 기본 max_tokens. 과거 1024 는 현대 모델에서 쉽게 truncation 을 유발한다. */
const DEFAULT_MAX_TOKENS = 4096

interface AnthropicContent {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}
interface AnthropicResponse {
  content?: AnthropicContent[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** ChatTurn.content → Anthropic 메시지 content(문자열 또는 블록 배열). */
function mapContent(content: string | ContentBlock[]): unknown {
  if (typeof content === 'string') return content
  return content.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text }
      case 'image':
        return { type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } }
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError }
    }
  })
}

function mapToolChoice(choice: ApiCallOptions['toolChoice']): Record<string, string> | undefined {
  if (!choice || choice === 'auto') return undefined
  if (choice === 'none') return { type: 'none' }
  return { type: 'any' } // 'required'
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'content_filter'
    default:
      return reason ? 'other' : 'stop'
  }
}

/** SSE 스트림(messages stream)을 읽어 텍스트 델타를 onToken 으로 흘리고 최종 ChatResult 를 만든다. */
async function readStream(
  body: AsyncIterable<Uint8Array>,
  onToken: (delta: string) => void,
): Promise<ChatResult> {
  let text = ''
  let stop: string | undefined
  const usage: { inputTokens?: number; outputTokens?: number } = {}
  for await (const data of sseData(body)) {
    let ev: {
      type?: string
      delta?: { type?: string; text?: string; stop_reason?: string }
      message?: { usage?: { input_tokens?: number } }
      usage?: { output_tokens?: number }
      error?: { type?: string; message?: string }
    }
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    // HTTP 200 스트림 중에도 error 이벤트(overloaded_error 등)가 올 수 있다. 부분 응답을
    // 성공으로 위장하지 않고 즉시 에러로 표면화한다(silent truncation 방지 — #7).
    if (ev.type === 'error') {
      throw new ApiProviderError('anthropic', 200, JSON.stringify(ev.error ?? { type: 'stream_error' }))
    }
    if (ev.type === 'message_start') usage.inputTokens = ev.message?.usage?.input_tokens ?? usage.inputTokens
    else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      text += ev.delta.text
      onToken(ev.delta.text)
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = ev.delta.stop_reason
      if (ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens
    }
  }
  return { text, toolCalls: [], finishReason: mapFinish(stop), rawFinishReason: stop, usage }
}

/** Anthropic Messages API provider. */
export function createAnthropicProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  return {
    id: config.id,
    provider: 'anthropic',
    model: config.model,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<ChatResult> {
      const apiKey = requireApiKey(config)
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => textOf(m.content))
        .join('\n\n')
      const turns = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: mapContent(m.content) }))

      const temperature = opts.temperature ?? config.temperature
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: opts.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: turns,
      }
      if (system) body.system = system
      if (temperature !== undefined) body.temperature = temperature
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
        const tc = mapToolChoice(opts.toolChoice)
        if (tc) body.tool_choice = tc
      }
      // 도구 미사용 + onToken 이 있으면 SSE 스트리밍으로 요청한다(도구 호출 경로는 버퍼링 유지).
      const streaming = !!opts.onToken && !opts.tools?.length
      if (streaming) body.stream = true

      const res = await http(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (streaming && res.ok && res.body) return readStream(res.body, opts.onToken!)

      const raw = await res.text()
      if (!res.ok) throw new ApiProviderError('anthropic', res.status, raw)

      const parsed = JSON.parse(raw) as AnthropicResponse
      const blocks = parsed.content ?? []
      const text = blocks
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('')
      const toolCalls: ToolUseBlock[] = blocks
        .filter((c) => c.type === 'tool_use')
        .map((c) => ({ type: 'tool_use', id: c.id ?? '', name: c.name ?? '', input: c.input }))
      return {
        text,
        toolCalls,
        finishReason: mapFinish(parsed.stop_reason),
        rawFinishReason: parsed.stop_reason,
        usage: { inputTokens: parsed.usage?.input_tokens, outputTokens: parsed.usage?.output_tokens },
      }
    },
  }
}

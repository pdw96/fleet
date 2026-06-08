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
  type TextBlock,
  type ToolUseBlock,
} from './types'

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}
interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * 추론(reasoning) 계열 모델 여부. o1/o3/o4… 및 gpt-5 계열은 Chat Completions 에서
 * `max_tokens` 대신 `max_completion_tokens` 를 요구하고 temperature/top_p 등 샘플링
 * 파라미터를 거부한다(전송 시 400). 그 외(gpt-4o 등)는 기존 계약을 유지한다.
 */
function isReasoningModel(model: string): boolean {
  return /^(o[0-9]|gpt-5)/i.test(model)
}

/** ChatTurn.content → OpenAI 메시지 content(문자열 또는 멀티모달 part 배열). */
function mapContent(content: string | ContentBlock[]): string | unknown[] {
  if (typeof content === 'string') return content
  const hasImage = content.some((b) => b.type === 'image')
  if (!hasImage) return textOf(content) // 텍스트 전용이면 단순 문자열
  return content.flatMap((b): unknown[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }]
    if (b.type === 'image') return [{ type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.data}` } }]
    // tool_use/tool_result 는 buildMessages 가 별도 메시지(tool_calls·role:'tool')로 처리한다.
    // 여기로 오는 경우는 없지만(buildMessages 가 우회) 방어적 텍스트 폴백을 남긴다.
    return [{ type: 'text', text: textOf([b]) }]
  })
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | unknown[] | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/**
 * ChatTurn[] → OpenAI Chat Completions 메시지 배열.
 * - tool_result 블록을 가진 user 턴 → 블록당 role:'tool' 메시지로 평탄화(1턴이 N메시지).
 * - tool_use 블록을 가진 assistant 턴 → content + tool_calls 필드.
 * - 그 외(텍스트/이미지) → 기존 mapContent 로 단일 메시지.
 */
function buildMessages(turns: ChatTurn[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = []
  for (const m of turns) {
    const blocks: ContentBlock[] | null = typeof m.content === 'string' ? null : m.content
    // 루프는 tool_result 만 담은 user 턴을 만든다. 혼합 턴(텍스트+tool_result)이면 텍스트가 tool 메시지 뒤로 온다.
    if (blocks?.some((b) => b.type === 'tool_result')) {
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content })
      }
      const text = blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('')
      if (text) out.push({ role: 'user', content: text })
      continue
    }
    if (blocks?.some((b) => b.type === 'tool_use')) {
      const toolCalls = blocks
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      const text = blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('')
      out.push({ role: 'assistant', content: text || null, tool_calls: toolCalls })
      continue
    }
    out.push({ role: m.role, content: mapContent(m.content) })
  }
  return out
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'content_filter'
    default:
      return reason ? 'other' : 'stop'
  }
}

/** SSE 스트림(chat completions, stream:true)을 읽어 델타를 흘리고 최종 ChatResult 를 만든다. */
async function readStream(
  body: AsyncIterable<Uint8Array>,
  onToken: (delta: string) => void,
): Promise<ChatResult> {
  let text = ''
  let finish: string | undefined
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  for await (const data of sseData(body)) {
    let ev: {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    const choice = ev.choices?.[0]
    const delta = choice?.delta?.content
    if (delta) {
      text += delta
      onToken(delta)
    }
    if (choice?.finish_reason) finish = choice.finish_reason
    if (ev.usage) usage = { inputTokens: ev.usage.prompt_tokens, outputTokens: ev.usage.completion_tokens }
  }
  return { text, toolCalls: [], finishReason: mapFinish(finish), rawFinishReason: finish, usage }
}

/** OpenAI Chat Completions API provider. */
export function createOpenAiProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  return {
    id: config.id,
    provider: 'openai',
    model: config.model,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<ChatResult> {
      const apiKey = requireApiKey(config)
      const reasoning = isReasoningModel(config.model)

      const body: Record<string, unknown> = {
        model: config.model,
        messages: buildMessages(messages),
      }
      const maxTokens = opts.maxTokens ?? config.maxTokens
      if (maxTokens !== undefined) {
        // 추론 모델은 max_completion_tokens 만 받는다.
        if (reasoning) body.max_completion_tokens = maxTokens
        else body.max_tokens = maxTokens
      }
      // temperature 는 추론 모델에서 거부되므로 전송하지 않는다.
      const temperature = opts.temperature ?? config.temperature
      if (temperature !== undefined && !reasoning) body.temperature = temperature
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
        if (opts.toolChoice) body.tool_choice = opts.toolChoice
      }
      // 도구 미사용 + onToken 이 있으면 SSE 스트리밍. include_usage 로 마지막 청크에 usage 를 받는다.
      const streaming = !!opts.onToken && !opts.tools?.length
      if (streaming) {
        body.stream = true
        body.stream_options = { include_usage: true }
      }

      const res = await http(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (streaming && res.ok && res.body) return readStream(res.body, opts.onToken!)

      const raw = await res.text()
      if (!res.ok) throw new ApiProviderError('openai', res.status, raw)

      const parsed = JSON.parse(raw) as OpenAiResponse
      const choice = parsed.choices?.[0]
      const toolCalls: ToolUseBlock[] = (choice?.message?.tool_calls ?? []).map((c) => ({
        type: 'tool_use',
        id: c.id ?? '',
        name: c.function?.name ?? '',
        input: parseArgs(c.function?.arguments),
      }))
      return {
        text: choice?.message?.content ?? '',
        toolCalls,
        finishReason: mapFinish(choice?.finish_reason),
        rawFinishReason: choice?.finish_reason,
        usage: { inputTokens: parsed.usage?.prompt_tokens, outputTokens: parsed.usage?.completion_tokens },
      }
    },
  }
}

/** tool_call arguments 는 JSON 문자열이다. 파싱 실패 시 원문을 보존한다. */
function parseArgs(args: string | undefined): unknown {
  if (!args) return {}
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

import type { ApiProviderConfig } from '../../../shared/types'
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

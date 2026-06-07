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
    // tool_use/tool_result 는 Chat Completions 에선 별도 메시지 구조가 필요하다(도구 루프 도입 시 확장).
    return [{ type: 'text', text: textOf([b]) }]
  })
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
        messages: messages.map((m) => ({ role: m.role, content: mapContent(m.content) })),
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

      const res = await http(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

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

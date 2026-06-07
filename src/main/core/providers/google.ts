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

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GooglePart {
  text?: string
  functionCall?: { name?: string; args?: unknown }
}
interface GoogleResponse {
  candidates?: Array<{ content?: { parts?: GooglePart[] }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

/** ChatTurn.content → Gemini parts 배열. */
function mapParts(content: string | ContentBlock[]): unknown[] {
  if (typeof content === 'string') return [{ text: content }]
  return content.map((b) => {
    switch (b.type) {
      case 'text':
        return { text: b.text }
      case 'image':
        return { inlineData: { mimeType: b.mimeType, data: b.data } }
      case 'tool_use':
        return { functionCall: { name: b.name, args: b.input } }
      case 'tool_result':
        return { functionResponse: { name: b.toolUseId, response: { result: b.content } } }
    }
  })
}

function mapMode(choice: ApiCallOptions['toolChoice']): string | undefined {
  if (!choice || choice === 'auto') return 'AUTO'
  if (choice === 'none') return 'NONE'
  return 'ANY' // 'required'
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter'
    default:
      return reason ? 'other' : 'stop'
  }
}

/** Google Gemini generateContent API provider. */
export function createGoogleProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  return {
    id: config.id,
    provider: 'google',
    model: config.model,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<ChatResult> {
      const apiKey = requireApiKey(config)
      const temperature = opts.temperature ?? config.temperature
      const maxTokens = opts.maxTokens ?? config.maxTokens

      const systemText = messages
        .filter((m) => m.role === 'system')
        .map((m) => textOf(m.content))
        .join('\n\n')
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: mapParts(m.content) }))

      const generationConfig: Record<string, unknown> = {}
      if (temperature !== undefined) generationConfig.temperature = temperature
      if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens

      const body: Record<string, unknown> = { contents }
      if (systemText) body.systemInstruction = { parts: [{ text: systemText }] }
      if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig
      if (opts.tools?.length) {
        body.tools = [
          {
            functionDeclarations: opts.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ]
        body.toolConfig = { functionCallingConfig: { mode: mapMode(opts.toolChoice) } }
      }

      // API 키는 쿼리스트링(?key=) 대신 헤더로 전송한다 — URL/로그 노출과 키 제한 정책 리스크를 피한다.
      const url = `${BASE}/${encodeURIComponent(config.model)}:generateContent`
      const res = await http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      const raw = await res.text()
      if (!res.ok) throw new ApiProviderError('google', res.status, raw)

      const parsed = JSON.parse(raw) as GoogleResponse
      const cand = parsed.candidates?.[0]
      const parts = cand?.content?.parts ?? []
      const text = parts.map((p) => p.text ?? '').join('')
      const toolCalls: ToolUseBlock[] = parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          type: 'tool_use',
          id: `${p.functionCall?.name ?? 'call'}-${i}`,
          name: p.functionCall?.name ?? '',
          input: p.functionCall?.args,
        }))
      return {
        text,
        toolCalls,
        finishReason: mapFinish(cand?.finishReason),
        rawFinishReason: cand?.finishReason,
        usage: {
          inputTokens: parsed.usageMetadata?.promptTokenCount,
          outputTokens: parsed.usageMetadata?.candidatesTokenCount,
        },
      }
    },
  }
}

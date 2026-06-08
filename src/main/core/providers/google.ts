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

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GooglePart {
  text?: string
  functionCall?: { name?: string; args?: unknown }
}
interface GoogleResponse {
  candidates?: Array<{ content?: { parts?: GooglePart[] }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  /** 프롬프트 자체가 차단되면 candidates 없이 여기에 사유가 온다. */
  promptFeedback?: { blockReason?: string }
}

/**
 * 응답에서 종료 사유를 해소한다. 후보가 없고 promptFeedback.blockReason 이 있으면
 * 프롬프트 차단으로 보고 content_filter 로 매핑한다(silent 빈응답 방지 — #7).
 */
function resolveFinish(parsed: GoogleResponse): { finishReason: FinishReason; raw?: string } {
  const cand = parsed.candidates?.[0]
  const blockReason = parsed.promptFeedback?.blockReason
  if (!cand && blockReason) return { finishReason: 'content_filter', raw: `PROMPT_BLOCKED:${blockReason}` }
  return { finishReason: mapFinish(cand?.finishReason), raw: cand?.finishReason }
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
        return { functionResponse: { name: b.name ?? b.toolUseId, response: { result: b.content } } }
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

/** SSE 스트림(streamGenerateContent?alt=sse)을 읽어 델타를 흘리고 최종 ChatResult 를 만든다. */
async function readStream(
  body: AsyncIterable<Uint8Array>,
  onToken: (delta: string) => void,
): Promise<ChatResult> {
  let text = ''
  let finish: string | undefined
  let blockReason: string | undefined // 프롬프트 차단(후보 없음) 사유
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  for await (const data of sseData(body)) {
    let ev: GoogleResponse
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    const cand = ev.candidates?.[0]
    for (const p of cand?.content?.parts ?? []) {
      if (p.text) {
        text += p.text
        onToken(p.text)
      }
    }
    if (cand?.finishReason) finish = cand.finishReason
    if (!cand && ev.promptFeedback?.blockReason) blockReason = ev.promptFeedback.blockReason
    if (ev.usageMetadata) {
      usage = {
        inputTokens: ev.usageMetadata.promptTokenCount,
        outputTokens: ev.usageMetadata.candidatesTokenCount,
      }
    }
  }
  // 프롬프트 차단은 사유와 무관하게 content_filter 로 표면화한다(#7).
  if (blockReason) return { text, toolCalls: [], finishReason: 'content_filter', rawFinishReason: `PROMPT_BLOCKED:${blockReason}`, usage }
  return { text, toolCalls: [], finishReason: mapFinish(finish), rawFinishReason: finish, usage }
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

      // 도구 미사용 + onToken 이 있으면 SSE 스트리밍 엔드포인트로 요청한다.
      const streaming = !!opts.onToken && !opts.tools?.length
      const method = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'
      // API 키는 쿼리스트링(?key=) 대신 헤더로 전송한다 — URL/로그 노출과 키 제한 정책 리스크를 피한다.
      const url = `${BASE}/${encodeURIComponent(config.model)}:${method}`
      const res = await http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (streaming && res.ok && res.body) return readStream(res.body, opts.onToken!)

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
      const finish = resolveFinish(parsed)
      return {
        text,
        toolCalls,
        finishReason: finish.finishReason,
        rawFinishReason: finish.raw,
        usage: {
          inputTokens: parsed.usageMetadata?.promptTokenCount,
          outputTokens: parsed.usageMetadata?.candidatesTokenCount,
        },
      }
    },
  }
}

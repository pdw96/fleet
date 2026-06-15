import type { ApiProviderConfig } from '../../../shared/types'
import { sseData } from './sse'
import {
  ApiProviderError,
  assertNever,
  defaultHttp,
  requireApiKey,
  sendWithSchemaFallback,
  textOf,
  type ApiCallOptions,
  type ApiProvider,
  type ChatResult,
  type ChatTurn,
  type ContentBlock,
  type FinishReason,
  type HttpClient,
  type HttpResponse,
  type ReasoningEffort,
  type ToolUseBlock,
} from './types'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// ── 모델-인지 thinking 정규화 (오프라인 화이트리스트 — MODEL LAUNCH 시 동기화) ─────────────
// Gemini thinkingConfig 는 세대별 와이어 방언이 다르다(js-genai·ai.google.dev 1차출처 검증):
//   • 2.5(pro/flash/flash-lite): generationConfig.thinkingConfig.thinkingBudget = 정수
//     (0=DISABLED[pro 는 min128 로 불가], -1=AUTOMATIC[동적]). 서브모델마다 정수 범위가 달라
//     (pro 128–32768·flash 0–24576·flash-lite 512–24576) 고정 정수 매핑은 범위이탈 400 위험 →
//     1단계는 -1(AUTOMATIC)로 동적 사고만 켠다. effort 티어→정수 budget 은 서브모델 범위 탐지가
//     필요한 후속(2단계).
//   • 3.x: generationConfig.thinkingConfig.thinkingLevel = 'low'|'medium'|'high'(소문자 enum).
//     토큰 정수가 아니라 범위이탈 위험이 없어 effort→level 티어를 그대로 싣는다.
//   • 그 외(1.5·2.0 등 미지원): thinkingConfig 미전송(보내면 무시/400 → 미전송이 항상 안전).
// `(?![0-9])` 룩어헤드로 'gemini-2.55'·'gemini-30' 같은 미지 모델 부분일치를 차단한다. GEMINI_3 은
// 하이픈형(gemini-3-pro)과 점버전형(gemini-3.5-flash=앱 기본 Google 모델) 둘 다 gen-3 방언으로 의도
// 매칭한다 — `/gemini-3\.\d+/` 로 좁히면 점 없는 gemini-3-pro 를 누락하므로 협소화하지 않는다(적대리뷰 검토).
const GEMINI_25 = /gemini-2\.5(?![0-9])/
const GEMINI_3 = /gemini-3(?![0-9])/

// thinking 활성 시 기본 maxOutputTokens(버퍼/스트림). thinking 토큰이 출력 예산을 함께 소모하므로
// (공식 문서: "reserve more of the token output for your response" + 실키 검증: 낮은 한도→빈 응답
// finish=length) 과소 한도면 가시 답변이 굶는다 → 아래로 floor 한다. 전 Gemini 2.5/3 출력 상한
// (65536) 내라 cap-safe. 스트리밍은 더 긴 출력을 허용한다(Anthropic 버퍼/스트림 2단 관용구와 동형).
const THINKING_BUFFER_MAX_TOKENS = 16384
const THINKING_STREAM_MAX_TOKENS = 32768

/** thinking(2.5/3) 지원 모델이면 true — thinkingConfig 전송 및 starvation maxOutputTokens 가드 적용 여부. */
function isThinkingModel(model: string): boolean {
  return GEMINI_25.test(model) || GEMINI_3.test(model)
}

/** effort → Gemini 3 thinkingLevel(소문자). 상위 티어(xhigh/max)는 high 로 수렴한다(미지원 티어 하향). */
function thinkingLevelOf(effort: ReasoningEffort): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high' // high · xhigh · max
}

/**
 * per-call/config thinking 노브 → generationConfig.thinkingConfig. 반환 undefined = 미전송(현행 동작).
 * thinking 활성(노브 있음 + 지원 모델)이면 사고 요약을 함께 요청한다(includeThoughts) — thinkingLevel/
 * thinkingBudget 유무와 독립이라 3 에서 effort 미지정(knob={})이어도 요약은 받는다(모델 기본 사고 깊이 유지).
 * 세대별 방언: 2.5 는 thinkingBudget(-1=AUTOMATIC 동적), 3 은 thinkingLevel(effort 매핑). 그 외 미지원
 * 모델은 isThinkingModel 가드로 undefined(미전송 — 보내면 400/무시).
 */
function resolveThinkingConfig(model: string, knob: ApiCallOptions['thinking']): Record<string, unknown> | undefined {
  if (!knob || !isThinkingModel(model)) return undefined
  const cfg: Record<string, unknown> = { includeThoughts: true }
  if (GEMINI_3.test(model)) {
    if (knob.effort) cfg.thinkingLevel = thinkingLevelOf(knob.effort)
  } else {
    cfg.thinkingBudget = -1 // GEMINI_25 (isThinkingModel 가드로 그 외는 도달 불가)
  }
  return cfg
}

interface GooglePart {
  text?: string
  /** includeThoughts 로 받은 사고 요약 파트 표식. true 면 가시 답변이 아니라 reasoning 요약(ThinkingBlock). */
  thought?: boolean
  functionCall?: { id?: string; name?: string; args?: unknown }
  /** Part 레벨 thought signature(functionCall·thought 파트의 형제). thinking 모델에서 파트에 붙는다(#17-P1). */
  thoughtSignature?: string
}
interface GoogleResponse {
  candidates?: Array<{ content?: { parts?: GooglePart[] }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  /** 프롬프트 자체가 차단되면 candidates 없이 여기에 사유가 온다. */
  promptFeedback?: { blockReason?: string }
  /** HTTP 200 스트림(alt=sse) 중에도 올 수 있는 error 페이로드. 부분 응답 위장 방지용으로 표면화한다. */
  error?: { code?: number; message?: string; status?: string }
}

/**
 * 응답 functionCall.id 를 ToolUseBlock.id 로 보존한다(#17-P2). Gemini 3.x 는 호출마다 고유 id 를
 * 부여하므로 멀티턴에서 functionResponse.id 로 되돌려 병렬 동일함수 호출을 정확히 상관시킨다.
 * 2.x 는 id 를 안 줄 수 있다 → 합성 id 를 지어내지 않고 빈 문자열을 둔다(회신 시 미전송, name 으로 상관).
 */
function toolUseId(fc: { id?: unknown }): string {
  return typeof fc.id === 'string' && fc.id ? fc.id : ''
}

/**
 * Gemini functionCall 파트 → ToolUseBlock. Part 레벨 thoughtSignature 가 있으면 providerMeta.google 에
 * verbatim 보존한다(#17-P1) — 멀티턴 tool 루프에서 mapParts 가 같은 Part 에 그대로 echo 한다(누락 시 400).
 */
function toToolUse(fc: { id?: string; name?: string; args?: unknown }, thoughtSignature?: string): ToolUseBlock {
  const block: ToolUseBlock = { type: 'tool_use', id: toolUseId(fc), name: fc.name ?? '', input: fc.args }
  if (thoughtSignature !== undefined) block.providerMeta = { google: { thoughtSignature } }
  return block
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
      case 'tool_use': {
        // 실제 Gemini id 가 있을 때만 회신한다(합성/부재면 '' → 미전송). 2.x 에 임의 id 를 보내지 않는다.
        const functionCall: Record<string, unknown> = { name: b.name, args: b.input }
        if (b.id) functionCall.id = b.id
        // thoughtSignature 는 functionCall 의 형제인 Part 레벨 필드다(functionCall 안이 아님 — Gemini wire 계약).
        // 실제 있을 때만 echo(echo-only-when-present, #29 규율). byte-exact 보존.
        const part: Record<string, unknown> = { functionCall }
        const sig = b.providerMeta?.google?.thoughtSignature
        if (sig !== undefined) part.thoughtSignature = sig
        return part
      }
      case 'tool_result': {
        const functionResponse: Record<string, unknown> = {
          name: b.name ?? b.toolUseId,
          response: { result: b.content },
        }
        if (b.toolUseId) functionResponse.id = b.toolUseId // 실제 id 만 회신(병렬 상관)
        return { functionResponse }
      }
      case 'thinking':
        // Gemini thought 파트 재방출은 후속(#11-Gemini-thinking). 현재 Gemini 는 ThinkingBlock 을
        // 생성하지 않아 도달 불가 — exhaustiveness 만족용 방어 텍스트 파트.
        return { text: b.text }
      default:
        return assertNever(b)
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

/**
 * SSE 스트림(streamGenerateContent?alt=sse)을 읽어 델타를 흘리고 최종 ChatResult 를 만든다.
 * 도구 동봉 요청도 스트리밍하므로(SP3) functionCall part 를 순서대로 모아 toolCalls 로 변환한다
 * (Gemini 의 functionCall 은 보통 분할되지 않고 part 단위로 통째 도착한다).
 */
async function readStream(
  body: AsyncIterable<Uint8Array>,
  onToken: (delta: string) => void,
): Promise<ChatResult> {
  let text = ''
  let finish: string | undefined
  let blockReason: string | undefined // 프롬프트 차단(후보 없음) 사유
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  const funcs: Array<{ fc: { id?: string; name?: string; args?: unknown }; sig?: string }> = []
  for await (const data of sseData(body)) {
    let ev: GoogleResponse
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    // HTTP 200 스트림(alt=sse) 중에도 error 페이로드(과부하·rate limit 등)가 올 수 있다. 부분 응답을
    // 성공으로 위장하지 않고 즉시 에러로 표면화한다(silent truncation 방지 — #7, anthropic 과 대칭).
    if (ev.error) {
      throw new ApiProviderError('google', 200, JSON.stringify(ev.error))
    }
    const cand = ev.candidates?.[0]
    for (const p of cand?.content?.parts ?? []) {
      if (p.text) {
        text += p.text
        onToken(p.text)
      } else if (p.functionCall) {
        funcs.push({ fc: p.functionCall, sig: p.thoughtSignature })
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
  const toolCalls: ToolUseBlock[] = funcs.map((f) => toToolUse(f.fc, f.sig))
  // 프롬프트 차단은 사유와 무관하게 content_filter 로 표면화한다(#7).
  if (blockReason) return { text, toolCalls, finishReason: 'content_filter', rawFinishReason: `PROMPT_BLOCKED:${blockReason}`, usage }
  // 클린 종료인데 finishReason 미수신 = 비정상 종료(연결 끊김 등). mapFinish(undefined)='stop' 으로 위장하면
  // 잘린 부분 응답이 성공으로 흡수된다 → silent truncation 표면화(#7, 3사 공통). 프롬프트 차단은 위에서 이미 종결.
  if (finish === undefined) {
    throw new ApiProviderError('google', 200, 'stream ended without finishReason (truncated)')
  }
  return { text, toolCalls, finishReason: mapFinish(finish), rawFinishReason: finish, usage }
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
      // per-call 노브 우선, 미지정이면 세션 기본값(config.thinking) — temperature/maxTokens 관용구와 동일.
      const knob = opts.thinking ?? config.thinking
      const thinkingActive = !!knob && isThinkingModel(config.model)
      // onToken 이 있으면 SSE 스트리밍 엔드포인트로 요청한다(아래 method 분기). starvation floor 단계 결정에도 쓴다.
      const streaming = !!opts.onToken
      // thinking 토큰이 출력 예산을 함께 소모 → 과소/미설정 maxOutputTokens 면 가시 답변이 굶는다. thinking
      // 활성 시 cap-safe 기본으로 끌어올리고 명시값이 그 아래여도 floor 한다(thinking 켠 호출에서 굶는 한도는
      // 의도가 아니다 — 명시 한도가 기본 이상이면 그대로 존중). thinking off 면 기존 동작(미설정=미전송) 그대로.
      let maxTokens = opts.maxTokens ?? config.maxTokens
      if (thinkingActive) {
        const floor = streaming ? THINKING_STREAM_MAX_TOKENS : THINKING_BUFFER_MAX_TOKENS
        maxTokens = Math.max(maxTokens ?? floor, floor)
      }

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
      if (opts.responseSchema) {
        generationConfig.responseMimeType = 'application/json'
        generationConfig.responseSchema = opts.responseSchema.schema
      }
      // thinkingConfig 는 세대별 방언으로 정규화돼 온다(2.5=thinkingBudget·3=thinkingLevel·그 외=미전송).
      const thinkingConfig = resolveThinkingConfig(config.model, knob)
      if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig

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

      // onToken 이 있으면 SSE 스트리밍 엔드포인트로 요청한다 — 도구 동봉 요청도 스트리밍하며 functionCall 을 모은다(SP3).
      // (streaming 플래그는 위에서 starvation floor 단계 결정과 함께 계산했다.)
      const method = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'
      // API 키는 쿼리스트링(?key=) 대신 헤더로 전송한다 — URL/로그 노출과 키 제한 정책 리스크를 피한다.
      const url = `${BASE}/${encodeURIComponent(config.model)}:${method}`
      const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey }
      const send = (): Promise<HttpResponse> =>
        http(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      // 스트리밍도 동일 가드 — 400 재시도 응답이 OK 면 아래 readStream 경로가 그대로 동작한다(#26 후속 b).
      const res = await sendWithSchemaFallback(send, !!opts.responseSchema, () => {
        const gc = body.generationConfig as Record<string, unknown> | undefined
        if (gc) {
          delete gc.responseMimeType
          delete gc.responseSchema
          if (Object.keys(gc).length === 0) delete body.generationConfig
        }
      })

      if (streaming && res.ok && res.body) return readStream(res.body, opts.onToken!)

      const raw = await res.text()
      if (!res.ok) throw new ApiProviderError('google', res.status, raw)

      const parsed = JSON.parse(raw) as GoogleResponse
      const cand = parsed.candidates?.[0]
      const parts = cand?.content?.parts ?? []
      // 가시 답변은 thought 파트를 제외한 text 만 이어붙인다(사고 요약은 가시 토큰이 아님 — textOf 규율).
      const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('')
      const toolCalls: ToolUseBlock[] = parts
        .filter((p) => p.functionCall)
        .map((p) => toToolUse(p.functionCall!, p.thoughtSignature))
      // thought 파트가 1개 이상이면 순서보존 content 를 적재한다(멀티턴 tool 루프 signature 왕복용 — Anthropic
      // 동형). 없으면 미설정 → loop 는 text+toolCalls 폴백(현행 동작 byte-동일, 무회귀).
      const content: ContentBlock[] | undefined = parts.some((p) => p.thought)
        ? parts.flatMap((p): ContentBlock[] => {
            if (p.thought && typeof p.text === 'string')
              return [{ type: 'thinking', text: p.text, providerMeta: p.thoughtSignature !== undefined ? { google: { thoughtSignature: p.thoughtSignature } } : undefined }]
            if (p.functionCall) return [toToolUse(p.functionCall, p.thoughtSignature)]
            if (typeof p.text === 'string') return [{ type: 'text', text: p.text }]
            return [] // 미지 파트(inlineData 등 어시스턴트 응답엔 없음) — content 에서 제외
          })
        : undefined
      const finish = resolveFinish(parsed)
      return {
        text,
        toolCalls,
        content,
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

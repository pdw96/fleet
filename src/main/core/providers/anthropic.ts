import type { ApiProviderConfig } from '../../../shared/types'
import { sseData } from './sse'
import {
  ApiProviderError,
  assertNever,
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
  type HttpResponse,
  type ReasoningEffort,
  type ToolUseBlock,
} from './types'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'
/** 기본 max_tokens. 과거 1024 는 현대 모델에서 쉽게 truncation 을 유발한다. */
const DEFAULT_MAX_TOKENS = 4096
/**
 * thinking 활성 시 기본 max_tokens — 사고 토큰이 max_tokens 예산을 소모하므로 4096 으론 thinking 만으로
 * 한도를 쳐 빈-응답 truncation(unwrap throw)이 잦다. 비스트리밍은 HTTP 타임아웃 위험 한계인 ~16K,
 * 스트리밍은 타임아웃 부담이 없어 Sonnet 4.6 출력 상한(64K) 이내로 상향한다. 명시 설정은 항상 존중.
 */
const THINKING_BUFFERED_MAX_TOKENS = 16_384
const THINKING_STREAMING_MAX_TOKENS = 64_000

// ── 모델-인지 thinking 정규화 (오프라인 화이트리스트 — MODEL LAUNCH 시 동기화) ─────────────
// adaptive thinking·effort(max 포함)는 현행 세대 전용: Fable · Opus 4.6+ · Sonnet 4.6. 구형
// (Opus 4.5 이하·Sonnet 4.5·Haiku)은 adaptive/effort 가 400 → thinking 통째 생략(=off).
// 생략은 항상 안전 — temperature 가드와 동일한 보수 원칙. 미래 모델(opus-4-9 등)도 화이트리스트
// 밖이면 무해하게 off 로 동작한다(장기적으론 Models API capability 조회가 정답 — #13 계열 후속).
// `(?![0-9])` 룩어헤드로 마이너 버전 숫자가 더 긴 숫자로 번지는 부분일치(opus-4-60 이 4-6 으로 매칭)를 막는다 —
// 미지 모델을 off 로 안전 강등하는 게 화이트리스트의 목적이므로 substring 매칭은 그 목적을 무력화한다.
const ADAPTIVE_MODELS = /claude-(fable|opus-4-(6|7|8)|sonnet-4-6)(?![0-9])/
// xhigh effort 와 thinking.display 필드는 Opus 4.7 도입. 4.6 세대는 summarized 가 기본 동작이라
// display 생략이 행동 보존이고, xhigh 는 effort 생략(=서버 기본 high)으로 하향한다.
const OPUS_47_PLUS = /claude-(fable|opus-4-(7|8))(?![0-9])/
// sampling 파라미터(temperature/top_p/top_k) 자체를 400 으로 거부하는 reasoning-native 세대(Fable·Opus 4.7/4.8).
// 현 세대에선 OPUS_47_PLUS(xhigh/display 지원 집합)와 같은 모델 집합이나 의미 축이 독립적이라 별도 상수로 둔다 —
// 미래에 'xhigh 는 지원하되 temperature 는 허용'처럼 두 축이 갈리는 모델이 나와도, OPUS_47_PLUS 수정이 이
// sampling 가드를 조용히 깨지 않도록 분리한다. (fable 토큰은 모든 Fable 세대를 의도적으로 포괄 — Fable 은
// 전 세대가 no-sampling 이라 미지 버전도 temperature 생략이 안전·정합. opus-4-X 의 (?![0-9]) 룩어헤드는
// opus-4-70 이 4-7 로 번지는 부분일치만 차단한다.)
const NO_SAMPLING_MODELS = /claude-(fable|opus-4-(7|8))(?![0-9])/

/**
 * per-call/config thinking 노브를 모델 가용성으로 정규화한다.
 * 반환 undefined = thinking 미전송(off). 지원 모델에서 미지원 effort 티어는 생략으로 하향한다.
 */
function resolveThinking(
  model: string,
  knob: ApiCallOptions['thinking'],
): { effort?: ReasoningEffort } | undefined {
  if (!knob || !ADAPTIVE_MODELS.test(model)) return undefined
  const effort = knob.effort === 'xhigh' && !OPUS_47_PLUS.test(model) ? undefined : knob.effort
  return { effort }
}

interface AnthropicContent {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  /** extended thinking 블록의 가시 reasoning(요약). display:omitted 면 부재. */
  thinking?: string
  /** thinking 블록의 불투명 서명(byte-exact). display 와 무관하게 항상 존재. */
  signature?: string
  /** redacted_thinking 블록의 불투명 암호화 payload(byte-exact 왕복 필수). */
  data?: string
}
interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
interface AnthropicResponse {
  content?: AnthropicContent[]
  stop_reason?: string
  usage?: AnthropicUsage
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
      case 'thinking': {
        // redacted_thinking 은 가시 텍스트/서명 없이 불투명 data 만 — redactedData 로 보존됐으면 그대로 재방출.
        const redacted = b.providerMeta?.anthropic?.redactedData
        if (redacted !== undefined) return { type: 'redacted_thinking', data: redacted }
        // Anthropic 은 도구 사용 중 thinking 블록을 signature 와 함께 tool_use 앞에 echo 해야 한다(순서·byte-exact).
        return { type: 'thinking', thinking: b.text, signature: b.providerMeta?.anthropic?.signature }
      }
      default:
        return assertNever(b)
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

/**
 * 누적된 input_json 문자열을 객체로 파싱한다. 빈 문자열은 빈 객체, 파싱 실패 시 원문을 보존한다
 * (OpenAI parseArgs 와 대칭) — {} 로 무성 흡수하면 빈 인자와 구별되지 않아 다운스트림 진단성이 떨어진다.
 */
function parseToolInput(json: string): unknown {
  if (!json) return {}
  try {
    return JSON.parse(json)
  } catch {
    return json
  }
}

/**
 * SSE 스트림(messages stream)을 읽어 텍스트 델타를 onToken 으로 흘리고 최종 ChatResult 를 만든다.
 * 도구 동봉 요청도 스트리밍하므로(SP3) tool_use 블록을 인덱스별로 누적한다:
 * content_block_start(tool_use) 로 시작, input_json_delta 로 인자 조각을 이어붙여 종료 시 파싱한다.
 */
async function readStream(
  body: AsyncIterable<Uint8Array>,
  onToken: (delta: string) => void,
): Promise<ChatResult> {
  let text = ''
  let stop: string | undefined
  const usage: { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number } = {}
  // 인덱스 → tool_use 누적기(시작 순서 보존). 텍스트 블록과 인덱스가 섞여도 정렬해 복원한다.
  const toolAccum = new Map<number, { id: string; name: string; json: string }>()
  // 인덱스 → thinking 누적기(thinking_delta 텍스트 + signature_delta 서명). 순서보존 content 적재용.
  const thinkingAccum = new Map<number, { text: string; signature: string }>()
  // 인덱스 → text 누적기. content 순서 복원 전용(ChatResult.text 는 아래 평면 text 가 담당).
  // 인덱스 있는 text_delta 만 채운다 → thinking 동반(rich) 응답에서만 쓰이며, 인덱스 없는 델타엔 영향 없음.
  const textByIndex = new Map<number, string>()
  // 인덱스 → redacted_thinking 의 불투명 data(content_block_start 에 통째로 옴, 델타 없음).
  const redactedAccum = new Map<number, string>()
  for await (const data of sseData(body)) {
    let ev: {
      type?: string
      index?: number
      content_block?: { type?: string; id?: string; name?: string; data?: string }
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string }
      message?: { usage?: AnthropicUsage }
      usage?: { output_tokens?: number }
      error?: { type?: string; message?: string }
    }
    try {
      ev = JSON.parse(data) as typeof ev
    } catch {
      continue
    }
    // HTTP 200 스트림 중에도 error 이벤트(overloaded_error 등)가 올 수 있다. 부분 응답을
    // 성공으로 위장하지 않고 즉시 에러로 표면화한다(silent truncation 방지 — #7).
    if (ev.type === 'error') {
      throw new ApiProviderError('anthropic', 200, JSON.stringify(ev.error ?? { type: 'stream_error' }))
    }
    if (ev.type === 'message_start') {
      // 캐시 토큰은 입력측이라 message_start 의 usage 로 온다(message_delta 는 output_tokens 만).
      usage.inputTokens = ev.message?.usage?.input_tokens ?? usage.inputTokens
      usage.cacheCreationInputTokens = ev.message?.usage?.cache_creation_input_tokens ?? usage.cacheCreationInputTokens
      usage.cacheReadInputTokens = ev.message?.usage?.cache_read_input_tokens ?? usage.cacheReadInputTokens
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && typeof ev.index === 'number') {
      toolAccum.set(ev.index, { id: ev.content_block.id ?? '', name: ev.content_block.name ?? '', json: '' })
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking' && typeof ev.index === 'number') {
      thinkingAccum.set(ev.index, { text: '', signature: '' })
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'redacted_thinking' && typeof ev.index === 'number') {
      redactedAccum.set(ev.index, ev.content_block.data ?? '')
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      text += ev.delta.text
      onToken(ev.delta.text)
      if (typeof ev.index === 'number') textByIndex.set(ev.index, (textByIndex.get(ev.index) ?? '') + ev.delta.text)
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta' && typeof ev.index === 'number') {
      const acc = toolAccum.get(ev.index)
      if (acc) acc.json += ev.delta.partial_json ?? ''
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && typeof ev.index === 'number') {
      // thinking 은 onToken 으로 흘리지 않는다(reasoning 은 가시 응답 토큰 아님 — textOf 규율과 일치).
      const acc = thinkingAccum.get(ev.index)
      if (acc) acc.text += ev.delta.thinking ?? ''
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'signature_delta' && typeof ev.index === 'number') {
      const acc = thinkingAccum.get(ev.index)
      if (acc) acc.signature = ev.delta.signature ?? ''
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = ev.delta.stop_reason
      if (ev.usage?.output_tokens != null) usage.outputTokens = ev.usage.output_tokens
    }
  }
  // 클린 종료인데 stop_reason 미수신 = 비정상 종료(연결 끊김 등). mapFinish(undefined)='stop' 으로 위장하면
  // 잘린 부분 응답이 성공으로 흡수된다 → silent truncation 표면화(#7, error 이벤트 가드와 동일 원칙·3사 공통).
  if (stop === undefined) {
    throw new ApiProviderError('anthropic', 200, 'stream ended without stop_reason (truncated)')
  }
  const toolCalls: ToolUseBlock[] = [...toolAccum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ type: 'tool_use', id: t.id, name: t.name, input: parseToolInput(t.json) }))
  // thinking 이 하나라도 있으면 순서보존 content 를 재구성한다. 모든 블록을 content_block 인덱스로
  // 병합·정렬해 원본 wire 순서를 그대로 복원한다(버퍼 경로와 동일 — interleaved thinking 도 안전).
  let content: ContentBlock[] | undefined
  if (thinkingAccum.size > 0 || redactedAccum.size > 0) {
    const byIndex = new Map<number, ContentBlock>()
    for (const [i, t] of thinkingAccum)
      byIndex.set(i, { type: 'thinking', text: t.text, providerMeta: t.signature ? { anthropic: { signature: t.signature } } : undefined })
    for (const [i, d] of redactedAccum)
      byIndex.set(i, { type: 'thinking', text: '', providerMeta: { anthropic: { redactedData: d } } })
    for (const [i, tx] of textByIndex) if (tx) byIndex.set(i, { type: 'text', text: tx })
    for (const [i, t] of toolAccum) byIndex.set(i, { type: 'tool_use', id: t.id, name: t.name, input: parseToolInput(t.json) })
    content = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)
  }
  return { text, toolCalls, content, finishReason: mapFinish(stop), rawFinishReason: stop, usage }
}

/** Anthropic Messages API provider. */
export function createAnthropicProvider(config: ApiProviderConfig, http: HttpClient = defaultHttp): ApiProvider {
  return {
    id: config.id,
    provider: 'anthropic',
    model: config.model,
    nativeContextManagement: true,
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
      // per-call 노브 우선, 미지정이면 세션 기본값(config.thinking) — temperature/maxTokens 관용구와 동일.
      // 모델-인지 정규화: 미지원 모델이면 여기서 undefined 가 되어 아래 가드 전부가 off 경로로 동작한다.
      const thinking = resolveThinking(config.model, opts.thinking ?? config.thinking)
      // onToken 이 있으면 SSE 스트리밍으로 요청한다 — 도구 동봉 요청도 스트리밍하며 tool_use 를 누적한다(SP3).
      const streaming = !!opts.onToken
      const defaultMaxTokens = thinking
        ? streaming
          ? THINKING_STREAMING_MAX_TOKENS
          : THINKING_BUFFERED_MAX_TOKENS
        : DEFAULT_MAX_TOKENS
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: opts.maxTokens ?? config.maxTokens ?? defaultMaxTokens,
        messages: turns,
      }
      // 프롬프트 캐시: top-level cache_control 은 분기점을 *마지막* 캐시 가능 블록(프롬프트 끝)에 둔다 → 캐시
      // 엔트리가 프롬프트 전체를 덮는다. 따라서 **같은 프리픽스가 5분 안에 재전송될 때만** 이득이다: tool loop
      // (최대 8라운드, 라운드마다 history+tools 프리픽스 반복)·멀티턴 chat(history 누적). 반대로 fresh 단발
      // (planner/reviewer/summarizer — 1턴·도구 없음·휘발성 diff/프롬프트)은 다음 호출이 다른 프롬프트라 캐시가
      // 절대 읽히지 않아 쓰기 1.25× 만 순손실이다 → 그 경로는 제외한다. (최소 프리픽스 미만은 어차피 무성 no-op.)
      const cacheable = turns.length > 1 || (opts.tools?.length ?? 0) > 0
      // cacheTtl='1h'(세션/per-call opt-in) + cacheable 면 ttl:'1h' + extended-cache 베타로 5m 초과 tail
      // (긴 빌드·느린 MCP)의 히트를 유지한다(쓰기 ~2× → 기본은 5m 유지). 미지정/5m 은 현행 byte-동일.
      const oneHourCache = cacheable && (opts.cacheTtl ?? config.cacheTtl) === '1h'
      if (cacheable) {
        body.cache_control = oneHourCache ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
      }
      if (system) body.system = system
      // sampling 파라미터(temperature) 정규화 — 두 갈래로 생략한다(생략은 항상 안전):
      //  (1) thinking 켜짐: 확장 thinking 은 temperature 와 충돌(구형은 temperature=1 강제, 신형은 미지원).
      //  (2) no-sampling 모델(Fable·Opus 4.7/4.8): thinking 무관하게 temperature 자체를 거부 → 하드 400.
      //      `!thinking` 만으론 thinking 미지정 + temperature 명시 교집합에서 400 이라 모델 게이트를 동반한다.
      if (temperature !== undefined && !thinking && !NO_SAMPLING_MODELS.test(config.model)) body.temperature = temperature
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
        // 확장 thinking 은 강제 도구사용(tool_choice any/tool)과 비호환(400) → thinking 켜지면 'required'(any)를
        // 기본 auto 로 낮춘다. 'none'/'auto' 는 thinking 과 호환되므로 유지.
        const effectiveChoice = thinking && opts.toolChoice === 'required' ? 'auto' : opts.toolChoice
        const tc = mapToolChoice(effectiveChoice)
        if (tc) body.tool_choice = tc
      }
      // output_config 는 responseSchema(format) 와 thinking(effort) 가 공유 → 단일 객체로 병합.
      const outputConfig: Record<string, unknown> = {}
      if (opts.responseSchema) {
        outputConfig.format = { type: 'json_schema', schema: opts.responseSchema.schema }
      }
      if (thinking) {
        // display:'summarized' 는 4.7 도입 필드 — 4.7+ 에서만 동봉해 thinking 텍스트를 캡처한다(기본 omitted 보정).
        // 4.6 세대는 summarized 가 기본 동작이라 생략이 행동 보존. signature 는 display 와 무관하게 항상 온다.
        body.thinking = OPUS_47_PLUS.test(config.model)
          ? { type: 'adaptive', display: 'summarized' }
          : { type: 'adaptive' }
        if (thinking.effort) outputConfig.effort = thinking.effort
      }
      if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig
      // context management(도구루프 경로): clear_tool_uses edit. native 위임 = 서버 실측 토큰 트리거로
      // 오래된 tool 결과를 per-request 클리어(cache_control·thinking 과 공존). CM 있을 때만 → 무회귀.
      if (opts.contextManagement) {
        body.context_management = {
          edits: [
            {
              type: 'clear_tool_uses_20250919',
              trigger: { type: 'input_tokens', value: opts.contextManagement.triggerInputTokens },
              keep: { type: 'tool_uses', value: opts.contextManagement.keepRecentToolUses },
            },
          ],
        }
      }
      if (streaming) body.stream = true

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      }
      // beta 헤더 누적: context-management·extended-cache-ttl 공존(쉼표 결합). 둘 다 없으면 헤더 부재(무회귀).
      const betas: string[] = []
      if (opts.contextManagement) betas.push('context-management-2025-06-27')
      if (oneHourCache) betas.push('extended-cache-ttl-2025-04-11')
      if (betas.length) headers['anthropic-beta'] = betas.join(',')
      const send = (): Promise<HttpResponse> =>
        http(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      // 두 opt-in 필드(context_management·output_config.format) + 불투명 400 → 한 번에 하나씩 제거해 무고한
      // 필드를 보존한다(PR #63 필드별 격리). 둘 다 set + schema-유발 400 에서 CM 까지 함께 지워 회귀하던
      // 갭(Codex P2)을 막는다. removeSchema 는 format 만 빼고 effort 등은 보존, 복원은 opts 에서 재구성.
      const removeCM = (): void => {
        delete body.context_management
        // CM 토큰만 제거한다(필드별 격리 불변식). extended-cache-ttl 은 별도 opt-in 이고 cache_control.ttl='1h'
        // 의 전제 헤더라, CM-유발 400 재시도에서 함께 지우면 ttl 이 고아가 돼 2차 400 을 유발한다 → 보존.
        if (oneHourCache) headers['anthropic-beta'] = 'extended-cache-ttl-2025-04-11'
        else delete headers['anthropic-beta']
      }
      const removeSchema = (): void => {
        const oc = body.output_config as Record<string, unknown> | undefined
        if (oc) {
          delete oc.format
          if (Object.keys(oc).length === 0) delete body.output_config
        }
      }
      const addSchema = (): void => {
        const oc = (body.output_config as Record<string, unknown> | undefined) ?? {}
        oc.format = { type: 'json_schema', schema: opts.responseSchema!.schema }
        body.output_config = oc
      }
      const hasCM = !!opts.contextManagement
      const hasSchema = !!opts.responseSchema
      // 스트리밍도 동일 — 최종 OK 응답이 body 를 가지면 아래 readStream 경로가 그대로 동작한다(#26 후속 b).
      let res = await send()
      if (!res.ok && res.status === 400 && (hasCM || hasSchema)) {
        if (hasCM && hasSchema) {
          // ① schema 만 제거(CM 보존) → ② 그래도 400 이면 schema 복원·CM 제거(schema 보존) → ③ 둘 다 제거.
          removeSchema()
          res = await send()
          if (!res.ok && res.status === 400) {
            addSchema()
            removeCM()
            res = await send()
            if (!res.ok && res.status === 400) {
              removeSchema()
              res = await send()
            }
          }
        } else if (hasCM) {
          removeCM()
          res = await send()
        } else {
          removeSchema()
          res = await send()
        }
      }

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
      // thinking 이 하나라도 있으면 순서보존 content 를 적재한다(멀티턴 tool 루프 signature 왕복용).
      // 없으면 미설정 → loop 는 text+toolCalls 폴백(현행 동작 byte-동일, 무회귀).
      const content: ContentBlock[] | undefined = blocks.some((c) => c.type === 'thinking' || c.type === 'redacted_thinking')
        ? blocks.flatMap((c): ContentBlock[] => {
            if (c.type === 'thinking')
              return [{ type: 'thinking', text: c.thinking ?? '', providerMeta: c.signature ? { anthropic: { signature: c.signature } } : undefined }]
            if (c.type === 'redacted_thinking')
              return [{ type: 'thinking', text: '', providerMeta: { anthropic: { redactedData: c.data } } }]
            if (c.type === 'text' && typeof c.text === 'string') return [{ type: 'text', text: c.text }]
            if (c.type === 'tool_use') return [{ type: 'tool_use', id: c.id ?? '', name: c.name ?? '', input: c.input }]
            return [] // 미지 블록은 content 에서 제외(어시스턴트 응답엔 image 등 없음)
          })
        : undefined
      return {
        text,
        toolCalls,
        content,
        finishReason: mapFinish(parsed.stop_reason),
        rawFinishReason: parsed.stop_reason,
        usage: {
          inputTokens: parsed.usage?.input_tokens,
          outputTokens: parsed.usage?.output_tokens,
          cacheCreationInputTokens: parsed.usage?.cache_creation_input_tokens,
          cacheReadInputTokens: parsed.usage?.cache_read_input_tokens,
        },
      }
    },
  }
}

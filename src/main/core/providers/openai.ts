import type { ApiProviderConfig } from '../../../shared/types'
import { sseData } from './sse'
import {
  ApiProviderError,
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
  type TextBlock,
  type TokenUsage,
  type ToolUseBlock,
} from './types'

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}
/** OpenAI usage 페이로드(버퍼·스트림 공통). prompt_tokens 는 cached_tokens 를 *포함*한다. */
interface OpenAiUsage {
  prompt_tokens?: number
  completion_tokens?: number
  /** prompt_tokens 중 프롬프트 캐시 적중분(prompt_tokens 의 부분집합). 미캐시/구형 응답이면 부재. */
  prompt_tokens_details?: { cached_tokens?: number }
}
interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string; refusal?: string; tool_calls?: OpenAiToolCall[] }; finish_reason?: string }>
  usage?: OpenAiUsage
}

/**
 * OpenAI usage → Fleet TokenUsage. OpenAI 의 prompt_tokens 는 캐시 적중분(cached_tokens)을 *포함*하지만
 * (Anthropic 은 input_tokens 와 cache_read 가 분리), Fleet 의 TokenUsage 는 두 값을 서로소로 본다.
 * 따라서 동일 모델로 정규화한다: inputTokens=비캐시 입력(prompt-cached), cacheReadInputTokens=cached.
 * 덕분에 cross-provider 비용 누적(addUsage)에서 input+cacheRead 를 합산해도 이중계산이 없다.
 * cached 미보고(prompt_tokens_details 부재)면 prompt 그대로·cacheRead 미설정 → 기존 동작 보존(무회귀).
 */
function mapUsage(u: OpenAiUsage | undefined): TokenUsage {
  const cached = u?.prompt_tokens_details?.cached_tokens
  const prompt = u?.prompt_tokens
  const usage: TokenUsage = {
    inputTokens: cached !== undefined && prompt !== undefined ? Math.max(0, prompt - cached) : prompt,
    outputTokens: u?.completion_tokens,
  }
  if (cached !== undefined) usage.cacheReadInputTokens = cached
  return usage
}

/**
 * 추론(reasoning) 계열 모델 여부. o1/o3/o4… 및 gpt-5 계열은 Chat Completions 에서
 * `max_tokens` 대신 `max_completion_tokens` 를 요구하고 temperature/top_p 등 샘플링
 * 파라미터를 거부한다(전송 시 400). 그 외(gpt-4o 등)는 기존 계약을 유지한다.
 */
function isReasoningModel(model: string): boolean {
  return /^(o[0-9]|gpt-5)/i.test(model)
}

// ── 모델-인지 reasoning_effort 정규화 (오프라인 화이트리스트 — MODEL LAUNCH 시 동기화) ────────
// reasoning_effort 지원 집합은 max_completion_tokens 집합(isReasoningModel)보다 *좁다* → isReasoningModel
// 을 그대로 게이트로 재사용하면 안 된다(그 docstring 은 토큰 필드/temperature 경계용). 거부자(전송 시 400):
//   • chat 변종(gpt-5-chat-latest 등)은 비-reasoning,
//   • o1-mini·o1-preview 는 reasoning_effort 도입 전 o1 초기 모델(파라미터는 프로덕션 o1 부터 추가, codex P2).
// 이들을 명시 배제한 별도 predicate 가 필요하다. 그 외 reasoning 계열(o-series·gpt-5+)만 받는다 — 비-reasoning
// (gpt-4o 등)은 isReasoningModel 이 이미 false. 미지/미래 reasoning 모델은 받아주되 알려진 거부자만 배제
// (Anthropic resolveThinking 의 'unknown→안전' 원칙과 동형 — 장기적으론 Models API capability 조회, #13 후속).
function supportsReasoningEffort(model: string): boolean {
  if (/-chat/i.test(model) || /^o1-(mini|preview)/i.test(model)) return false
  return isReasoningModel(model)
}
// xhigh 가용성: **GPT-5.2+ 세대**(codex 변종 포함 — 5.2·5.2-codex·5.3-codex·5.4·5.5…) 전용. GPT-5.0/5.1 과
// o-series 는 xhigh 미지원(전송 시 400). 마이너 버전을 **숫자로 비교**해 5.2+ 를 빠짐없이 포함하고(정규식
// 열거의 under-match 로 5.2/5.3 가 high 로 무성 강등되던 회귀 차단 — codex P2) 두 자리 마이너(5.10+)도 안전 처리.
function supportsXhigh(model: string): boolean {
  const m = /^gpt-5\.(\d+)/i.exec(model)
  return m ? Number(m[1]) >= 2 : false
}
// 'pro' 계열은 effort 집합이 제한적(검증: gpt-5-pro={high}, gpt-5.2-pro·gpt-5.4-pro={medium,high,xhigh}):
//   • gpt-5-pro(마이너 없음)는 high 만 → 전부 high,
//   • dotted pro(gpt-5.N-pro)는 low 미지원 → 최소 medium 으로 상향(나머지는 일반 규칙).
// 미정규화 시 low/medium 이 gpt-5-pro 에서 400, low 가 dotted pro 에서 400 (codex P2). 정확한 per-pro 티어는 #13.
function isProModel(model: string): boolean {
  return /-pro\b/i.test(model)
}

/**
 * per-call/config thinking 노브를 OpenAI reasoning_effort 값으로 정규화한다.
 * 반환 undefined = reasoning_effort 미전송(미지원 모델 · effort 미지정 → 서버 기본 medium).
 */
function resolveReasoningEffort(model: string, knob: ApiCallOptions['thinking']): string | undefined {
  if (!knob || knob.effort === undefined || !supportsReasoningEffort(model)) return undefined
  const effort = knob.effort
  if (isProModel(model)) {
    if (!/^gpt-5\.\d/i.test(model)) return 'high' // gpt-5-pro: high 만 지원
    if (effort === 'max' || effort === 'xhigh') return supportsXhigh(model) ? 'xhigh' : 'high'
    return effort === 'low' ? 'medium' : effort // dotted pro: low 미지원 → medium 상향
  }
  // 'max'(OpenAI 무효값)·'xhigh'(미지원 세대) 둘 다 모델 최상위 티어로 수렴. low/medium/high 는 그대로.
  if (effort === 'max' || effort === 'xhigh') return supportsXhigh(model) ? 'xhigh' : 'high'
  return effort
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

/**
 * SSE 스트림(chat completions, stream:true)을 읽어 델타를 흘리고 최종 ChatResult 를 만든다.
 * 도구 동봉 요청도 스트리밍하므로(SP3) delta.tool_calls 를 인덱스별로 누적한다 —
 * id/name 은 처음 도착분, arguments(문자열 조각)는 이어붙여 종료 시 파싱한다.
 */
async function readStream(
  body: AsyncIterable<Uint8Array>,
  onToken: (delta: string) => void,
): Promise<ChatResult> {
  let text = ''
  let refusal = ''
  let finish: string | undefined
  let usage: TokenUsage | undefined
  const toolAccum = new Map<number, { id: string; name: string; args: string }>()
  for await (const data of sseData(body)) {
    let ev: {
      choices?: Array<{
        delta?: {
          content?: string
          refusal?: string
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
        }
        finish_reason?: string
      }>
      usage?: OpenAiUsage
      error?: { message?: string; type?: string; code?: string }
    }
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    // HTTP 200 스트림 중에도 error 페이로드(rate limit·서버 과부하 등)가 올 수 있다. 부분 응답을
    // 성공으로 위장하지 않고 즉시 에러로 표면화한다(silent truncation 방지 — #7, anthropic 과 대칭).
    if (ev.error) {
      throw new ApiProviderError('openai', 200, JSON.stringify(ev.error))
    }
    const choice = ev.choices?.[0]
    const delta = choice?.delta?.content
    if (delta) {
      text += delta
      onToken(delta)
    }
    // 구조화 출력 거부는 content 가 아니라 delta.refusal 로 스트리밍된다. content 토큰으로 흘리지 않고 누적만 한다.
    if (choice?.delta?.refusal) refusal += choice.delta.refusal
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const acc = toolAccum.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) acc.id = tc.id
      if (tc.function?.name) acc.name = tc.function.name
      if (tc.function?.arguments) acc.args += tc.function.arguments
      toolAccum.set(idx, acc)
    }
    if (choice?.finish_reason) finish = choice.finish_reason
    if (ev.usage) usage = mapUsage(ev.usage)
  }
  const toolCalls: ToolUseBlock[] = [...toolAccum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ type: 'tool_use', id: t.id, name: t.name, input: parseArgs(t.args) }))
  // 거부가 누적됐고 도구 호출이 없으면 빈 응답으로 흡수하지 않고 content_filter 로 표면화한다(#7, 버퍼 경로와 대칭).
  if (refusal && toolCalls.length === 0) {
    return { text: '', toolCalls: [], finishReason: 'content_filter', rawFinishReason: `refusal: ${refusal}`, usage }
  }
  // 클린 종료인데 finish_reason 미수신 = 비정상 종료(연결 끊김 등). mapFinish(undefined)='stop' 으로 위장하면
  // 잘린 부분 응답이 성공으로 흡수된다 → silent truncation 표면화(#7, 3사 공통). 거부는 위에서 이미 종결.
  if (finish === undefined) {
    throw new ApiProviderError('openai', 200, 'stream ended without finish_reason (truncated)')
  }
  return { text, toolCalls, finishReason: mapFinish(finish), rawFinishReason: finish, usage }
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
      // per-call 노브 우선, 미지정이면 세션 기본값(config.thinking) — temperature/maxTokens 관용구와 동일.
      // 모델-인지 정규화: 비-reasoning 모델/effort 미지정이면 undefined 가 되어 reasoning_effort 미전송.
      const reasoningEffort = resolveReasoningEffort(config.model, opts.thinking ?? config.thinking)
      if (reasoningEffort) body.reasoning_effort = reasoningEffort
      if (opts.tools?.length) {
        body.tools = opts.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
        if (opts.toolChoice) body.tool_choice = opts.toolChoice
      }
      if (opts.responseSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.responseSchema.name, schema: opts.responseSchema.schema, strict: true },
        }
      }
      // onToken 이 있으면 SSE 스트리밍 — 도구 동봉 요청도 스트리밍하며 tool_calls 를 누적한다(SP3).
      // include_usage 로 마지막 청크에 usage 를 받는다.
      const streaming = !!opts.onToken
      if (streaming) {
        body.stream = true
        body.stream_options = { include_usage: true }
      }

      const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
      const send = (): Promise<HttpResponse> =>
        http(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      // 스트리밍도 동일 가드 — 400 재시도 응답이 OK 면 아래 readStream 경로가 그대로 동작한다(#26 후속 b).
      const res = await sendWithSchemaFallback(send, !!opts.responseSchema, () => { delete body.response_format })

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
      // 구조화 출력 거부는 content 가 아니라 message.refusal 로 온다 — 빈 응답으로 흡수하지 않고 content_filter 로 표면화한다(#7).
      const refusal = choice?.message?.refusal
      if (typeof refusal === 'string' && refusal && toolCalls.length === 0) {
        return {
          text: '',
          toolCalls: [],
          finishReason: 'content_filter',
          rawFinishReason: `refusal: ${refusal}`,
          usage: mapUsage(parsed.usage),
        }
      }
      return {
        text: choice?.message?.content ?? '',
        toolCalls,
        finishReason: mapFinish(choice?.finish_reason),
        rawFinishReason: choice?.finish_reason,
        usage: mapUsage(parsed.usage),
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

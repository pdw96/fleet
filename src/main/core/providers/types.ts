import type { ApiProviderConfig, ReasoningEffort, ToolStep } from '../../../shared/types'

// ReasoningEffort 는 렌더러 설정 UI 와 공유돼 shared/types.ts 로 이동(단일 진실 원천) — 기존 import 경로 호환 재export.
export type { ReasoningEffort }

// ── 콘텐츠 블록 (멀티모달 · 도구 호출 대비) ─────────────────────────────────
/**
 * 대화 턴의 내용 단위. 기존 `string` 계약을 깨지 않도록 ChatTurn.content 는
 * `string | ContentBlock[]` 양쪽을 받는다(문자열은 단일 text 블록과 동치).
 * - text        : 일반 텍스트.
 * - image       : base64 인라인 이미지(멀티모달 입력).
 * - tool_use    : 모델이 호출하려는 도구(어시스턴트 턴에서 등장).
 * - tool_result : 도구 실행 결과(사용자 턴으로 모델에 회신).
 */
export interface TextBlock {
  type: 'text'
  text: string
  /** provider 네이티브 메타(Gemini 3 text-part signature 등). 현재 무동작. */
  providerMeta?: ProviderMeta
}
export interface ImageBlock {
  type: 'image'
  /** 예: 'image/png', 'image/jpeg' */
  mimeType: string
  /** base64 인코딩 데이터(데이터 URI 접두사 없이). */
  data: string
}
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  /** 도구 입력 인자(JSON 파싱된 값). */
  input: unknown
  /** provider 네이티브 메타(Gemini thoughtSignature 의 집). 현재 무동작. */
  providerMeta?: ProviderMeta
}
/**
 * provider 네이티브 메타의 불투명 패스스루 채널. 키=provider id, 값=provider 소유(불투명).
 * 레이어는 값 내부를 모른다 — verbatim 보존, 재인코딩 금지(서명 byte-exact). 키 네임스페이스로
 * cross-model 누수를 막는다: 각 provider 재방출은 자기 네임스페이스만 읽는다.
 */
export type ProviderMeta = Partial<Record<ApiProviderConfig['provider'], Record<string, unknown>>>

/** 모델 reasoning(extended thinking) 블록. 어시스턴트 턴에서 tool_use 앞에 온다(Anthropic 순서 요구). */
export interface ThinkingBlock {
  type: 'thinking'
  /** 가시 reasoning. redacted/omitted thinking 은 빈 문자열일 수 있다(서명만 보유). */
  text: string
  /** 예: { anthropic: { signature } }. 불투명. */
  providerMeta?: ProviderMeta
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  /** 도구 이름. Anthropic/OpenAI 는 toolUseId 로 correlate 하지만 Gemini 는 함수 name 으로 correlate 한다. */
  name?: string
  content: string
  isError?: boolean
}
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock

/** 오케스트레이션 계층이 다루는 공통 대화 턴. content 는 문자열 또는 블록 배열. */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** 문자열/블록 양쪽을 받아 항상 ContentBlock[] 로 정규화한다. */
export function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return content
}

/** 블록 배열에서 텍스트만 추출해 이어 붙인다(문자열 content 면 그대로). */
export function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

// ── 도구 정의 (tool calling) ────────────────────────────────────────────────
/** 모델에 노출할 도구 정의. parameters 는 JSON Schema. */
export interface ToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

// ── 응답 메타 ────────────────────────────────────────────────────────────────
/**
 * provider-중립 context management 정책. anthropic 은 native `context_management` wire 로,
 * native 미지원 provider 는 loop 의 client-side 가지치기로 해석한다(동일 정책·실행만 분기).
 */
export interface ContextManagementPolicy {
  /** 누적 입력토큰(anthropic=서버 실측·그 외=client 추정)이 이 값을 넘으면 정리. */
  triggerInputTokens: number
  /** 유지할 최근 도구결과 수. 이보다 오래된 tool_result 부터 정리. */
  keepRecentToolUses: number
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  /** 프롬프트 캐시에 새로 기록된 입력 토큰(쓰기 ~1.25× 과금). Anthropic 캐시 전용 — 미지원/미캐시면 미설정. */
  cacheCreationInputTokens?: number
  /** 프롬프트 캐시에서 읽은 입력 토큰(읽기 ~0.1× 과금). 0/미설정이면 캐시 미적중(무성 무효화 점검 신호). */
  cacheReadInputTokens?: number
}

/**
 * 정규화된 종료 사유.
 * - stop           : 정상 종료(end_turn/stop/STOP).
 * - length         : 토큰 한도로 잘림(max_tokens/length/MAX_TOKENS).
 * - tool_use       : 도구 호출로 일시 정지(tool_use/tool_calls).
 * - content_filter : 안전/콘텐츠 필터·거부(refusal/content_filter/SAFETY/RECITATION).
 * - other          : 그 외/미상.
 */
export type FinishReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'other'

/** provider chat() 의 구조화된 결과. text 는 항상 존재(없으면 빈 문자열). */
export interface ChatResult {
  /** 어시스턴트 텍스트(여러 text 블록을 이어 붙인 값). */
  text: string
  /** 모델이 요청한 도구 호출들(없으면 빈 배열). */
  toolCalls: ToolUseBlock[]
  /**
   * 원본 순서 보존 어시스턴트 블록 전체(thinking→text→tool_use). provider 가 순서/서명을 보존해야
   * 할 때만 채운다. 미설정이면 loop 는 text+toolCalls 폴백(현행 동작 = 무동작 보장).
   */
  content?: ContentBlock[]
  finishReason: FinishReason
  usage?: TokenUsage
  /** 진단용 원본 종료 사유 문자열(provider 네이티브 값). */
  rawFinishReason?: string
}

export interface ApiCallOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /** 모델에 노출할 도구 정의(tool calling). 비면 미전송. */
  tools?: ToolDefinition[]
  /** 도구 선택 강제. 'auto'(기본)/'none'/'required'. */
  toolChoice?: 'auto' | 'none' | 'required'
  /**
   * 토큰 델타 콜백. 지정 시 provider 는 SSE 스트리밍으로 요청해 부분 텍스트가 도착하는 즉시
   * 호출한다(도구 동봉 요청도 스트리밍 — SP3). 미지정이면 버퍼링(최종 1회 파싱).
   */
  onToken?: (delta: string) => void
  /**
   * 도구 단계 콜백. provider 는 소비하지 않는다 — 도구 실행 루프(runToolLoop)가 도구 1개를
   * 실행할 때마다 running → ok/error 단계를 방출하는 라이브 진행 싱크다(SP3).
   */
  onToolStep?: (step: ToolStep) => void
  /**
   * 응답을 JSON 스키마로 강제(네이티브 구조화 출력). 지정 시 provider 는 네이티브 필드를 싣고
   * text 는 마크다운/산문 없는 JSON 문자열이 된다. 미지원 모델(400)은 스키마 없이 1회 재시도한다.
   */
  responseSchema?: { name: string; schema: Record<string, unknown> }
  /**
   * 모델 reasoning(extended thinking) per-call 노브. 미지정이면 provider 가 config.thinking(세션 기본값)으로
   * 폴백한다(temperature/maxTokens 관용구와 동일). 모델-인지 정규화(미지원 모델/티어 하향·생략)는 provider 책임.
   * Anthropic(adaptive thinking)·OpenAI(reasoning_effort) 매핑. Gemini 는 후속. #11-thinking.
   */
  thinking?: { effort?: ReasoningEffort }
}

// ── 주입 가능한 최소 HTTP 클라이언트 (테스트에서 mock) ──────────────────────
export interface HttpInit {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface HttpResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  /** SSE/스트리밍 본문(있으면). 청크 단위 바이트 스트림 — text() 와 둘 중 하나만 소비한다. */
  body?: AsyncIterable<Uint8Array> | null
}

export type HttpClient = (url: string, init: HttpInit) => Promise<HttpResponse>

/** 기본 HTTP 클라이언트: Node 전역 fetch 래핑. */
export const defaultHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, init)
  // Node 의 fetch Response.body 는 async-iterable 한 ReadableStream<Uint8Array> 다.
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    body: res.body as unknown as AsyncIterable<Uint8Array> | null,
  }
}

/** API provider 통합 인터페이스 (요구사항 2B). */
export interface ApiProvider {
  readonly id: string
  readonly provider: ApiProviderConfig['provider']
  readonly model: string
  /** 대화 턴 배열 → 구조화된 어시스턴트 응답(text · 도구호출 · 종료사유 · 사용량). */
  chat(messages: ChatTurn[], opts?: ApiCallOptions): Promise<ChatResult>
}

export class ApiProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`[${provider}] HTTP ${status}: ${detail}`)
    this.name = 'ApiProviderError'
  }
}

export function requireApiKey(config: ApiProviderConfig): string {
  if (!config.apiKey) {
    throw new Error(`[${config.provider}] API 키가 설정되지 않았습니다 (id=${config.id}).`)
  }
  return config.apiKey
}

/**
 * 요청을 구조화-출력 400 graceful degradation 으로 감싼다(버퍼·스트리밍 공통 — #26 후속 b).
 * send() 가 400 을 반환하고 스키마가 있었으면 stripSchema() 로 스키마 필드를 제거한 뒤 1회 재시도한다.
 * (구형 모델이 구조화-출력 필드를 거부해도 폴백 파싱으로 계속 동작하게 — 회귀 차단.)
 */
export async function sendWithSchemaFallback(
  send: () => Promise<HttpResponse>,
  hasSchema: boolean,
  stripSchema: () => void,
): Promise<HttpResponse> {
  const res = await send()
  if (!hasSchema || res.ok || res.status !== 400) return res
  stripSchema()
  return send()
}

/** 분기 누락을 컴파일 타임에 잡는다 — 새 ContentBlock variant 추가 시 모든 switch default 가 TS 에러. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled ContentBlock variant: ${JSON.stringify(x)}`)
}

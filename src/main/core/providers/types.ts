import type { ApiProviderConfig, ToolStep } from '../../../shared/types'

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
}
export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  /** 도구 이름. Anthropic/OpenAI 는 toolUseId 로 correlate 하지만 Gemini 는 함수 name 으로 correlate 한다. */
  name?: string
  content: string
  isError?: boolean
}
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock

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
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
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
 * 비스트리밍 요청을 구조화-출력 400 graceful degradation 으로 감싼다.
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

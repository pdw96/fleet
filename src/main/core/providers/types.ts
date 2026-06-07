import type { ApiProviderConfig } from '../../../shared/types'

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
}

export type HttpClient = (url: string, init: HttpInit) => Promise<HttpResponse>

/** 기본 HTTP 클라이언트: Node 전역 fetch 래핑. */
export const defaultHttp: HttpClient = async (url, init) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status, text: () => res.text() }
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

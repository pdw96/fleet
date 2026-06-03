import type { ApiProviderConfig } from '../../../shared/types'

/** 오케스트레이션 계층이 다루는 공통 대화 턴. */
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ApiCallOptions {
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
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
  /** 대화 턴 배열 → 어시스턴트 응답 텍스트. */
  chat(messages: ChatTurn[], opts?: ApiCallOptions): Promise<string>
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

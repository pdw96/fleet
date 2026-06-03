import type { LlmDescriptor } from '../../../shared/types'

export interface SendOptions {
  signal?: AbortSignal
  /** 스트리밍/부분 출력 콜백 (MVP: 최종 텍스트 1회 전달). */
  onChunk?: (chunk: string) => void
}

/**
 * 통합 LLM 세션 (요구사항 2,4).
 * CLI(TUI) 세션과 API 세션이 동일한 인터페이스를 만족 → 오케스트레이터/채팅방은
 * 세션의 연결 종류를 알 필요가 없다.
 */
export interface LlmSession {
  readonly id: string
  readonly descriptor: LlmDescriptor
  /** 프롬프트 1회 → 응답 텍스트. */
  send(prompt: string, opts?: SendOptions): Promise<string>
  dispose(): Promise<void>
}

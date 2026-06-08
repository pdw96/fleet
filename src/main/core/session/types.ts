import type { LlmDescriptor, ToolStep } from '../../../shared/types'

export interface SendOptions {
  /** 실행 취소용. abort 시 자식 프로세스를 종료한다. */
  signal?: AbortSignal
  /** 스트리밍/부분 출력 콜백 (MVP: 최종 텍스트 1회 전달). */
  onChunk?: (chunk: string) => void
  /** 도구 단계 콜백. API 세션의 도구 루프가 도구 실행 단계를 라이브로 흘린다(SP3). CLI 세션은 무시. */
  onToolStep?: (step: ToolStep) => void
  /**
   * stateful 세션이라도 이 호출만은 맥락 없이 독립 1회 실행한다.
   * 오케스트레이터가 작업 간 맥락 오염 없이 깨끗한 독립 호출(독립 검증)을 보장하는 데 쓴다.
   * 세션의 재개 상태(sessionId/started)와 누적 history 를 건드리지도 참조하지도 않는다.
   */
  fresh?: boolean
  /** 있으면 CLI를 이 디렉터리를 작업 루트로 하는 편집 에이전트로 실행한다. */
  workspace?: string
  /** 이 호출의 타임아웃(ms). 미지정 시 세션 기본값. 편집 에이전트는 길게 잡는다. */
  timeoutMs?: number
}

/** createCliSession 동작 옵션. */
export interface CreateCliSessionOptions {
  /**
   * true + adapter.session 존재 시 스테이트풀(세션 재개) 모드.
   * 기본 false = 헤드리스 1회 실행(독립 호출). 오케스트레이터는 false 로 두어
   * 작업 간 리뷰 맥락이 섞이지 않게(독립 검증 보존) 한다.
   */
  stateful?: boolean
}

/**
 * 통합 LLM 세션 (요구사항 2,4).
 * CLI(TUI) 세션과 API 세션이 동일한 인터페이스를 만족 → 오케스트레이터/채팅방은
 * 세션의 연결 종류를 알 필요가 없다.
 */
export interface LlmSession {
  readonly id: string
  readonly descriptor: LlmDescriptor
  /**
   * 맥락 유지 여부. true 면 send 간 대화 상태를 내부 보유하므로
   * 호출자는 전체 기록이 아닌 '새 메시지'만 전달해야 한다(채팅 델타 분기).
   */
  readonly stateful?: boolean
  /** 프롬프트 1회 → 응답 텍스트. */
  send(prompt: string, opts?: SendOptions): Promise<string>
  dispose(): Promise<void>
}

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
  /** 있으면 CLI를 이 디렉터리를 작업 루트로 하는 편집 에이전트로 실행한다(write 권한). */
  workspace?: string
  /**
   * 읽기 전용 작업 디렉터리. 편집 모드(workspace)를 거치지 않고 headless 실행의 cwd 만 이 경로로
   * 둔다 — 산출물을 워크스페이스에서 평가하되 write 권한은 주지 않는 분석 호출용(summarizer 등, #165).
   * workspace 가 함께 주어지면 편집 모드가 우선하므로 cwd 는 무시된다.
   */
  cwd?: string
  /** 이 호출의 타임아웃(ms). 미지정 시 세션 기본값. 편집 에이전트는 길게 잡는다. */
  timeoutMs?: number
  /** 응답을 JSON 스키마로 강제(네이티브 구조화 출력). API 세션만 적용; CLI 세션은 무시. */
  responseSchema?: { name: string; schema: Record<string, unknown> }
  /** true 면 이 호출은 도구 루프를 건너뛰고 단발 chat 으로 실행한다(planner/reviewer 등 분석 호출). */
  bypassTools?: boolean
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

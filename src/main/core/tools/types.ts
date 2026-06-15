import type { RiskLevel } from '../../../shared/types'
import type { ContextManagementPolicy, ToolDefinition } from '../providers/types'
import type { ApprovalGate } from '../safety/approval'

/** 도구 실행 컨텍스트(취소 신호 등). */
export interface ToolContext {
  signal?: AbortSignal
}

/** 레지스트리에 등록되는 도구. IPC 직렬화되지 않으므로 함수 필드를 둔다. */
export interface FleetTool {
  /** 모델에 노출할 정의(name·description·parameters JSON Schema). */
  definition: ToolDefinition
  /** 입력 기반 위험도. 게이트 통과 후 execute 된다. */
  classify(input: unknown): RiskLevel
  /** 실행. 결과 문자열을 반환하고, 위반/오류는 throw 한다(루프가 isError 로 회신). */
  execute(input: unknown, ctx: ToolContext): Promise<string>
}

/** 이름→도구 조회 레지스트리. */
export interface ToolRegistry {
  /** 모델에 노출할 도구 정의 목록. */
  list(): ToolDefinition[]
  get(name: string): FleetTool | undefined
  has(name: string): boolean
}

/** 도구 루프가 받는 의존성. */
export interface ToolLoopDeps {
  registry: ToolRegistry
  gate: ApprovalGate
  /** 감사 로그 싱크(예: store.appendEvent 래퍼). */
  onAudit?: (type: string, data: Record<string, unknown>) => void
  /** 최대 반복 횟수(기본 8). */
  maxIterations?: number
  /**
   * context management 정책. undefined → DEFAULT_CONTEXT_POLICY(default-on), null → 비활성.
   * native provider 엔 위임, 그 외엔 client-side 가지치기로 적용한다.
   */
  contextPolicy?: ContextManagementPolicy | null
}

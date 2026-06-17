import type { AgentRole, AssignmentPolicy, RoleAssignment } from '../../../shared/types'

export const ALL_ROLES: readonly AgentRole[] = [
  'planner',
  'architect',
  'implementer',
  'reviewer',
  'tester',
  'critic',
  'summarizer',
]

export interface AssignmentInput {
  roles: readonly AgentRole[]
  llmIds: readonly string[]
  policy: AssignmentPolicy
  /** manual 정책용 사용자 지정 배정 */
  manual?: readonly RoleAssignment[]
  /** capability-scored 정책용 선호 맵: llmId → 잘하는 역할들 */
  capabilities?: Record<string, readonly AgentRole[]>
}

/** 역할 ↔ LLM 배정 (요구사항 4). 정책별로 결정론적 결과를 보장한다. */
export function assignRoles(input: AssignmentInput): RoleAssignment[] {
  const { roles, llmIds, policy } = input
  if (llmIds.length === 0) return []

  switch (policy) {
    case 'manual': {
      const map = new Map((input.manual ?? []).map((a) => [a.role, a.llmId]))
      return roles.map((role, i) => ({ role, llmId: map.get(role) ?? llmIds[i % llmIds.length] }))
    }
    case 'round-robin':
      return roles.map((role, i) => ({ role, llmId: llmIds[i % llmIds.length] }))
    case 'capability-scored': {
      // 역할별로 최적 LLM을 고르되 이번 실행의 누적 사용량으로 부하를 분산한다.
      const used = new Map<string, number>()
      return roles.map((role) => {
        const llmId = pickBest(role, llmIds, used, input.capabilities)
        used.set(llmId, (used.get(llmId) ?? 0) + 1)
        return { role, llmId }
      })
    }
    default: {
      const exhaustive: never = policy
      throw new Error(`알 수 없는 배정 정책: ${String(exhaustive)}`)
    }
  }
}

/**
 * 역할 선호(이진 점수) 최고 LLM 선택. 동점이면 이번 실행에서 덜 쓰인 LLM,
 * 그래도 동점이면 첫 번째(인덱스) = 결정론적. 아무도 역할을 선호하지 않으면(전부 0점)
 * 사용량 기준 분산이 그대로 라운드로빈으로 수렴해 한 LLM에 몰리지 않는다.
 */
function pickBest(
  role: AgentRole,
  llmIds: readonly string[],
  used: ReadonlyMap<string, number>,
  capabilities?: Record<string, readonly AgentRole[]>,
): string {
  let best = llmIds[0]
  let bestScore = score(best, role, capabilities)
  let bestUsed = used.get(best) ?? 0
  for (const id of llmIds.slice(1)) {
    const s = score(id, role, capabilities)
    const u = used.get(id) ?? 0
    if (s > bestScore || (s === bestScore && u < bestUsed)) {
      best = id
      bestScore = s
      bestUsed = u
    }
  }
  return best
}

function score(
  llmId: string,
  role: AgentRole,
  capabilities?: Record<string, readonly AgentRole[]>,
): number {
  return capabilities?.[llmId]?.includes(role) ? 1 : 0
}

/** 배정에서 역할의 LLM id 조회 (없으면 fallback 역할로). */
export function resolveLlmForRole(
  assignments: readonly RoleAssignment[],
  role: AgentRole,
  fallbackRole?: AgentRole,
): string | undefined {
  const direct = assignments.find((a) => a.role === role)?.llmId
  if (direct) return direct
  if (fallbackRole) return assignments.find((a) => a.role === fallbackRole)?.llmId
  return undefined
}

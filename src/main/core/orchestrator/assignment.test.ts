import { describe, expect, it } from 'vitest'
import { ALL_ROLES, assignRoles, resolveLlmForRole } from './assignment'

describe('ALL_ROLES', () => {
  it('contains the seven canonical roles', () => {
    expect(ALL_ROLES).toHaveLength(7)
    expect(ALL_ROLES).toContain('planner')
    expect(ALL_ROLES).toContain('summarizer')
  })
})

describe('assignRoles', () => {
  it('round-robin cycles llms across roles', () => {
    const r = assignRoles({ roles: ['planner', 'implementer', 'reviewer'], llmIds: ['a', 'b'], policy: 'round-robin' })
    expect(r.map((x) => x.llmId)).toEqual(['a', 'b', 'a'])
  })

  it('manual honors explicit assignment, falls back by index', () => {
    const r = assignRoles({
      roles: ['planner', 'reviewer'],
      llmIds: ['a', 'b'],
      policy: 'manual',
      manual: [{ role: 'reviewer', llmId: 'b' }],
    })
    expect(resolveLlmForRole(r, 'reviewer')).toBe('b')
    expect(resolveLlmForRole(r, 'planner')).toBe('a')
  })

  it('capability-scored prefers the llm listing the role', () => {
    const r = assignRoles({
      roles: ['reviewer'],
      llmIds: ['a', 'b', 'c'],
      policy: 'capability-scored',
      capabilities: { b: ['reviewer'] },
    })
    expect(r[0].llmId).toBe('b')
  })

  it('capability-scored is deterministic on ties (first wins)', () => {
    const r = assignRoles({ roles: ['reviewer'], llmIds: ['a', 'b'], policy: 'capability-scored' })
    expect(r[0].llmId).toBe('a')
  })

  it('capability-scored spreads roles across equally-capable llms (load balance)', () => {
    const r = assignRoles({
      roles: ['planner', 'reviewer'],
      llmIds: ['a', 'b'],
      policy: 'capability-scored',
      capabilities: { a: ['planner', 'reviewer'], b: ['planner', 'reviewer'] },
    })
    // 둘 다 두 역할에 적합 → 한 LLM이 독식하지 않고 분산된다
    expect(r.map((x) => x.llmId)).toEqual(['a', 'b'])
  })

  it('capability-scored falls back to round-robin for roles no llm is capable of', () => {
    const r = assignRoles({
      roles: ['planner', 'implementer'],
      llmIds: ['a', 'b'],
      policy: 'capability-scored',
      capabilities: {}, // 아무도 적합하지 않음
    })
    // 전부 0점 → llmIds[0] 몰림이 아니라 사용량 기준 분산(round-robin 수렴)
    expect(r.map((x) => x.llmId)).toEqual(['a', 'b'])
  })

  it('capability-scored keeps a specialist on its role even against load balancing', () => {
    const r = assignRoles({
      roles: ['planner', 'implementer', 'reviewer'],
      llmIds: ['a', 'b'],
      policy: 'capability-scored',
      capabilities: { a: ['planner', 'implementer', 'reviewer'] }, // a 만 적합, b 는 무역량
    })
    // 적합도가 부하분산을 이긴다 → a 가 세 역할 모두
    expect(r.map((x) => x.llmId)).toEqual(['a', 'a', 'a'])
  })

  it('returns empty when no llms available', () => {
    expect(assignRoles({ roles: ['planner'], llmIds: [], policy: 'round-robin' })).toEqual([])
  })
})

describe('resolveLlmForRole', () => {
  it('falls back to a fallback role when the primary is unassigned', () => {
    const assignments = [{ role: 'reviewer' as const, llmId: 'rev' }]
    expect(resolveLlmForRole(assignments, 'summarizer', 'reviewer')).toBe('rev')
    expect(resolveLlmForRole(assignments, 'summarizer')).toBeUndefined()
  })
})

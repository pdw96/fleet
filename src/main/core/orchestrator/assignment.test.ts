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

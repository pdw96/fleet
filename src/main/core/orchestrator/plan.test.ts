import { describe, expect, it } from 'vitest'
import type { LlmSession } from '../session/types'
import { buildPlannerPrompt, extractJsonArray, parsePlannedTasks, planTasks } from './plan'

function fakeSession(reply: string): LlmSession {
  return {
    id: 'p',
    descriptor: { id: 'p', kind: 'api', displayName: 'p', ref: 'p', model: '' },
    async send() {
      return reply
    },
    async dispose() {},
  }
}

describe('extractJsonArray', () => {
  it('extracts from a fenced code block', () => {
    expect(extractJsonArray('```json\n[1, 2]\n```')).toEqual([1, 2])
  })
  it('extracts a bare array surrounded by prose', () => {
    expect(extractJsonArray('계획입니다: [{"a":1}] 이상')).toEqual([{ a: 1 }])
  })
  it('throws when there is no array', () => {
    expect(() => extractJsonArray('배열 없음')).toThrow()
  })
})

describe('parsePlannedTasks', () => {
  it('parses valid tasks with roles and deps', () => {
    const tasks = parsePlannedTasks(
      '[{"title":"설계","description":"d","role":"architect"},{"title":"구현","description":"e","role":"implementer","dependsOn":[0]}]',
    )
    expect(tasks).toHaveLength(2)
    expect(tasks[0].role).toBe('architect')
    expect(tasks[1].dependsOn).toEqual([0])
  })

  it('is lenient: drops invalid role, defaults missing title', () => {
    const tasks = parsePlannedTasks('[{"description":"x","role":"bogus"}]')
    expect(tasks[0].title).toBe('작업 1')
    expect(tasks[0].role).toBeUndefined()
  })

  it('throws when the task list is empty', () => {
    expect(() => parsePlannedTasks('[]')).toThrow()
  })
})

describe('buildPlannerPrompt', () => {
  it('embeds the goal and asks for JSON', () => {
    const p = buildPlannerPrompt('멀티 LLM 앱')
    expect(p).toContain('멀티 LLM 앱')
    expect(p).toContain('JSON')
  })
})

describe('planTasks', () => {
  it('decomposes via the planner session', async () => {
    const tasks = await planTasks('goal', fakeSession('[{"title":"T","description":"D"}]'))
    expect(tasks[0].title).toBe('T')
  })
})

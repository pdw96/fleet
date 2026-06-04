import { describe, expect, it } from 'vitest'
import type { LlmConnectionKind } from '../../../shared/types'
import { createSessionManager } from '../session/manager'
import type { LlmSession } from '../session/types'
import { createMemoryStore } from '../store/memory'
import { runProject } from './orchestrator'

function fakeSession(id: string, responder: () => string, kind: LlmConnectionKind = 'api'): LlmSession {
  return {
    id,
    descriptor: { id, kind, displayName: id, ref: id, model: '' },
    async send() {
      return responder()
    },
    async dispose() {},
  }
}

function deterministic() {
  let n = 0
  return { idGen: () => `id-${++n}`, now: () => 1000 + n }
}

describe('runProject', () => {
  it('plans, implements, reviews (approve), and summarizes', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"작업A","description":"a"},{"title":"작업B","description":"b"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession('impl', () => {
        implCalls++
        return '구현 결과'
      }),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    sessions.add(fakeSession('sum', () => '요약: 목표 충족'))

    const events: string[] = []
    const result = await runProject('멀티 LLM 앱', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
        { role: 'summarizer', llmId: 'sum' },
      ],
      onEvent: (e) => events.push(e.type),
    })

    expect(result.tasks).toHaveLength(2)
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(result.summary).toContain('요약')
    expect(implCalls).toBe(2)
    expect(events).toContain('plan.created')
    expect(events).toContain('project.done')
    expect(store.getProject(result.projectId)?.status).toBe('done')
    // 감사 이벤트도 기록됨
    expect(store.listEvents().some((e) => e.type === 'project.done')).toBe(true)
  })

  it('records the resolved implementer llm as assignedLlmId on each task', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
    })
    expect(result.tasks[0].assignedLlmId).toBe('impl')
  })

  it('records the post-fallback llm when a task role has no direct assignment', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // planner 가 architect 역할 작업을 만든다 — architect 는 배정에 없어 implementer 로 폴백
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d","role":"architect"}]'))
    sessions.add(fakeSession('impl', () => '구현'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
    })
    expect(result.tasks[0].role).toBe('architect')
    expect(result.tasks[0].assignedLlmId).toBe('impl') // 폴백 해소된 실제 LLM
  })

  it('runs the re-review loop until approval', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession('impl', () => {
        implCalls++
        return `구현 v${implCalls}`
      }),
    )
    let revCalls = 0
    sessions.add(
      fakeSession('rev', () => {
        revCalls++
        return revCalls < 2 ? 'REVISE: 고쳐라' : 'APPROVE'
      }),
    )

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      maxReviewRounds: 3,
    })
    expect(implCalls).toBe(2)
    expect(result.tasks[0].status).toBe('done')
  })

  it('marks a task failed when review never approves within the round limit', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현'))
    sessions.add(fakeSession('rev', () => 'REVISE: 계속 고쳐'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      maxReviewRounds: 1,
    })
    expect(result.tasks[0].status).toBe('failed')
  })

  it('throws when planner is not assigned', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    await expect(runProject('g', { store, sessions, assignments: [] })).rejects.toThrow('planner')
  })

  it('marks the project failed when planning output is unparseable', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '계획을 못 만들겠습니다'))
    await expect(
      runProject('g', { store, sessions, assignments: [{ role: 'planner', llmId: 'planner' }] }),
    ).rejects.toThrow()
    expect(store.listProjects()[0].status).toBe('failed')
  })
})

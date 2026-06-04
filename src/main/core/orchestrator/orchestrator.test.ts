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

  it('marks the project failed when the planner returns an empty task list', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[]'))
    await expect(
      runProject('g', { store, sessions, assignments: [{ role: 'planner', llmId: 'planner' }] }),
    ).rejects.toThrow()
    expect(store.listProjects()[0].status).toBe('failed')
  })

  it('runs exactly maxReviewRounds implement→review cycles before failing', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession('impl', () => {
        implCalls++
        return '구현'
      }),
    )
    sessions.add(fakeSession('rev', () => 'REVISE: 다시'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      maxReviewRounds: 2,
    })
    expect(implCalls).toBe(2) // 2회 시도 (off-by-one 이면 3회가 됨)
    expect(result.tasks[0].status).toBe('failed')
  })

  it('clamps maxReviewRounds to at least one implement attempt', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession('impl', () => {
        implCalls++
        return '구현'
      }),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      maxReviewRounds: 0,
    })
    expect(implCalls).toBe(1) // 0/음수여도 최소 1회는 구현한다
  })

  it('marks a task failed and continues when the implementer throws', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession('planner', () => '[{"title":"T1","description":"a"},{"title":"T2","description":"b"}]'),
    )
    let calls = 0
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'api', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        calls++
        if (calls === 1) throw new Error('API 호출 실패')
        return '구현'
      },
      async dispose() {},
    }
    sessions.add(impl)
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
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0].status).toBe('failed') // 첫 작업은 예외로 실패
    expect(result.tasks[1].status).toBe('done') // 둘째 작업은 계속 진행
    expect(store.getProject(result.projectId)?.status).toBe('done') // 전체는 중단되지 않음
  })

  function recordingImplementer(sink: string[]): LlmSession {
    return {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'api', displayName: 'impl', ref: 'impl', model: '' },
      async send(prompt: string) {
        const m = /담당 작업: (\S+)/.exec(prompt)
        if (m) sink.push(m[1])
        return '구현'
      },
      async dispose() {},
    }
  }

  it('executes tasks in dependency order (dependsOn)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // A(인덱스0)는 B(인덱스1)에 의존 → 목록 순서와 무관하게 B 가 먼저 실행돼야 한다
    sessions.add(
      fakeSession('planner', () => '[{"title":"A","description":"a","dependsOn":[1]},{"title":"B","description":"b"}]'),
    )
    const order: string[] = []
    sessions.add(recordingImplementer(order))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
    })
    expect(order).toEqual(['B', 'A'])
  })

  it('marks a dependent task failed without running it when its dependency fails', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // B(인덱스1)는 A(인덱스0)에 의존. A 는 리뷰 거절로 실패한다.
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b","dependsOn":[0]}]',
      ),
    )
    const implemented: string[] = []
    sessions.add(recordingImplementer(implemented))
    sessions.add(fakeSession('rev', () => 'REVISE: 고쳐'))

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
    const a = result.tasks.find((t) => t.title === 'A')
    const b = result.tasks.find((t) => t.title === 'B')
    expect(a?.status).toBe('failed')
    expect(b?.status).toBe('failed')
    expect(implemented).toEqual(['A']) // B 는 의존 실패로 실행되지 않음
  })

  it('fails cyclic tasks instead of hanging', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // A→B, B→A 순환
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a","dependsOn":[1]},{"title":"B","description":"b","dependsOn":[0]}]',
      ),
    )
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
    expect(result.tasks.every((t) => t.status === 'failed')).toBe(true)
    expect(store.getProject(result.projectId)?.status).toBe('done')
  })

  it('records a self-review audit event when implementer and reviewer are the same llm', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('solo', () => 'APPROVE')) // 구현·검토를 같은 LLM 이 맡음
    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'solo' },
        { role: 'reviewer', llmId: 'solo' },
      ],
    })
    expect(store.listEvents().some((e) => e.type === 'task.self_review')).toBe(true)
  })

  it('writes implementer file artifacts through the injected file writer', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(
      fakeSession('impl', () => ['구현했습니다.', '```file:src/x.ts', 'export const x = 1', '```'].join('\n')),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const writes: Array<{ path: string; content: string }> = []
    const fileWriter = {
      async write(path: string, content: string) {
        writes.push({ path, content })
        return { ok: true, path }
      },
    }

    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      fileWriter,
    })
    expect(writes).toEqual([{ path: 'src/x.ts', content: 'export const x = 1' }])
  })

  it('runs verification after tasks and surfaces results', async () => {
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
      verify: async () => [
        { kind: 'test', command: 'npm test', passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 },
      ],
    })
    expect(result.verifications).toHaveLength(1)
    expect(result.verifications?.[0].passed).toBe(true)
  })

  it('marks the project failed when verification fails', async () => {
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
      verify: async () => [
        { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', durationMs: 1 },
      ],
    })
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })
})

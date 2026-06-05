import { describe, expect, it } from 'vitest'
import type { LlmConnectionKind } from '../../../shared/types'
import { createSessionManager } from '../session/manager'
import type { LlmSession } from '../session/types'
import { createMemoryStore } from '../store/memory'
import type { DiffResult, Workspace } from '../workspace/git'
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

/** diff/커밋을 기록하는 가짜 워크스페이스. collectDiff 는 호출마다 diffByCall 을 소비한다. */
function fakeWorkspace(diffByCall: DiffResult[] = []): Workspace & { commits: string[]; reverts: number } {
  let i = 0
  const commits: string[] = []
  const ws = {
    commits,
    reverts: 0,
    async ensureRepo() {},
    async checkpoint() {
      return `base-${i}`
    },
    async collectDiff() {
      return diffByCall[i++] ?? { files: ['src/x.ts'], patch: '+x', truncated: false }
    },
    async keep(message: string) {
      commits.push(message)
      return `commit-${commits.length}`
    },
    async revert() {
      ws.reverts++
    },
  }
  return ws
}

describe('runProject', () => {
  it('plans, implements (direct edit), reviews (approve), and summarizes', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"작업A","description":"a"},{"title":"작업B","description":"b"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현 결과'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    sessions.add(fakeSession('sum', () => '요약: 목표 충족'))

    const events: string[] = []
    const ws = fakeWorkspace()
    const result = await runProject('멀티 LLM 앱', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
        { role: 'summarizer', llmId: 'sum' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      onEvent: (e) => events.push(e.type),
    })

    expect(result.tasks).toHaveLength(2)
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(result.summary).toContain('요약')
    expect(implCalls).toBe(2)
    expect(ws.commits).toHaveLength(2) // 승인된 작업마다 keep 1회
    expect(events).toContain('plan.created')
    expect(events).toContain('project.done')
    expect(store.getProject(result.projectId)?.status).toBe('done')
    // 감사 이벤트도 기록됨
    expect(store.listEvents().some((e) => e.type === 'project.done')).toBe(true)
  })

  it('commits a checkpoint per approved task and records changed files', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현 요약', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const ws = fakeWorkspace([{ files: ['src/a.ts', 'src/b.ts'], patch: '+ab', truncated: false }])
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
    })
    expect(result.tasks[0].status).toBe('done')
    expect(ws.commits).toHaveLength(1)
    expect(result.tasks[0].changedFiles).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('bails out on abort: skips remaining tasks, skips summary/verify, ends failed', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession('planner', () => '[{"title":"T1","description":"a"},{"title":"T2","description":"b"}]'),
    )
    const controller = new AbortController()
    let implCalls = 0
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        implCalls++
        // 첫 작업 중간에 취소 발생을 시뮬레이션: abort 후 throw.
        controller.abort()
        throw new Error('aborted mid-task')
      },
      async dispose() {},
    }
    sessions.add(impl)
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    let summarizerCalls = 0
    sessions.add(fakeSession('sum', () => { summarizerCalls++; return '요약' }))

    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
        { role: 'summarizer', llmId: 'sum' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      signal: controller.signal,
      verify: async () => {
        verifyCalls++
        return [{ kind: 'test', command: 'npm test', passed: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }]
      },
    })

    const t1 = result.tasks.find((t) => t.title === 'T1')
    const t2 = result.tasks.find((t) => t.title === 'T2')
    expect(t1?.status).toBe('failed') // 첫 작업은 send 예외로 실패
    expect(t2?.status).toBe('skipped') // 취소 후 남은 작업은 실행 없이 skipped
    expect(implCalls).toBe(1) // 둘째 작업은 실행되지 않음
    expect(summarizerCalls).toBe(0) // 취소 시 요약 생략
    expect(verifyCalls).toBe(0) // 취소 시 검증 생략
    expect(result.summary).toBe('')
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('records the resolved implementer llm as assignedLlmId on each task', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })
    expect(result.tasks[0].assignedLlmId).toBe('impl')
  })

  it('records the post-fallback llm when a task role has no direct assignment', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // planner 가 architect 역할 작업을 만든다 — architect 는 배정에 없어 implementer 로 폴백
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d","role":"architect"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })
    expect(result.tasks[0].role).toBe('architect')
    expect(result.tasks[0].assignedLlmId).toBe('impl') // 폴백 해소된 실제 LLM
  })

  it('runs the re-review loop until approval (reverting rejected attempts)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return `구현 v${implCalls}`
        },
        'cli',
      ),
    )
    let revCalls = 0
    sessions.add(
      fakeSession('rev', () => {
        revCalls++
        return revCalls < 2 ? 'REVISE: 고쳐라' : 'APPROVE'
      }),
    )

    const ws = fakeWorkspace()
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      maxReviewRounds: 3,
    })
    expect(implCalls).toBe(2)
    expect(result.tasks[0].status).toBe('done')
    expect(ws.commits).toHaveLength(1) // 최종 승인본만 keep
    expect(ws.reverts).toBeGreaterThanOrEqual(1) // 첫 거절 시도는 revert
  })

  it('marks a task failed when review never approves within the round limit', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'REVISE: 계속 고쳐'))

    const ws = fakeWorkspace()
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      maxReviewRounds: 1,
    })
    expect(result.tasks[0].status).toBe('failed')
    expect(ws.commits).toHaveLength(0) // 미승인 → keep 없음
  })

  it('marks the project failed (not stuck executing) when ensureRepo throws', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    // ensureRepo 가 거부하는 워크스페이스: 계획(executing) 이후 초기화에서 실패한다.
    const ws: Workspace = {
      async ensureRepo() {
        throw new Error('git init 실패')
      },
      async checkpoint() {
        return 'base'
      },
      async collectDiff(): Promise<DiffResult> {
        return { files: [], patch: '', truncated: false }
      },
      async keep() {
        return 'commit'
      },
      async revert() {},
    }
    await expect(
      runProject('goal', {
        store,
        sessions,
        assignments: [
          { role: 'planner', llmId: 'planner' },
          { role: 'implementer', llmId: 'impl' },
          { role: 'reviewer', llmId: 'rev' },
        ],
        workspace: ws,
        workspaceRoot: '/ws',
      }),
    ).rejects.toThrow('git init 실패')
    // 프로젝트는 ensureRepo 전에 생성됐다 — 거부 후 'executing' 으로 방치되지 않고 failed 여야 한다.
    const projectId = store.listProjects()[0]?.id
    expect(store.getProject(projectId)?.status).toBe('failed')
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
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
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
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
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
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
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
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
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
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        calls++
        if (calls === 1) throw new Error('CLI 호출 실패')
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
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0].status).toBe('failed') // 첫 작업은 예외로 실패
    expect(result.tasks[1].status).toBe('done') // 둘째 작업은 계속 진행
    expect(store.getProject(result.projectId)?.status).toBe('done') // 전체는 중단되지 않음
  })

  function recordingImplementer(sink: string[]): LlmSession {
    return {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
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
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })
    expect(order).toEqual(['B', 'A'])
  })

  it('skips a dependent task without running it when its dependency fails', async () => {
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
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      maxReviewRounds: 1,
    })
    const a = result.tasks.find((t) => t.title === 'A')
    const b = result.tasks.find((t) => t.title === 'B')
    expect(a?.status).toBe('failed') // 실패한 의존 작업 자체는 failed
    expect(b?.status).toBe('skipped') // 의존 실패로 건너뛴 작업은 skipped
    expect(implemented).toEqual(['A']) // B 는 의존 실패로 실행되지 않음
  })

  it('skips an implementer task assigned to an API session', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'api')) // API 세션은 직접 편집 불가
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })
    expect(result.tasks[0].status).toBe('skipped')
  })

  it('skips a task when no workspace is provided', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      // workspace 미지정 → 직접 편집 불가
    })
    expect(result.tasks[0].status).toBe('skipped')
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
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })
    expect(result.tasks.every((t) => t.status === 'failed')).toBe(true)
    expect(store.getProject(result.projectId)?.status).toBe('done')
  })

  it('records a self-review audit event when implementer and reviewer are the same llm', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('solo', () => 'APPROVE', 'cli')) // 구현·검토를 같은 LLM 이 맡음
    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'solo' },
        { role: 'reviewer', llmId: 'solo' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })
    expect(store.listEvents().some((e) => e.type === 'task.self_review')).toBe(true)
  })

  it('requires gate approval for destructive diffs and reverts when rejected', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    // 민감 파일 변경 → classifyDiffRisk 가 destructive 로 분류
    const ws = fakeWorkspace([{ files: ['.env'], patch: '+secret', truncated: false }])
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      // gate 미지정 → 위험 변경은 거부(안전 기본값)
    })
    expect(result.tasks[0].status).toBe('failed')
    expect(ws.commits).toHaveLength(0) // 거부되어 keep 없음
    expect(ws.reverts).toBeGreaterThanOrEqual(1)
  })

  it('applies a destructive diff when the gate approves', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const ws = fakeWorkspace([{ files: ['.env'], patch: '+secret', truncated: false }])
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      gate: { async request() { return 'approved' } },
    })
    expect(result.tasks[0].status).toBe('done')
    expect(ws.commits).toHaveLength(1)
  })

  it('runs verification after tasks and surfaces results', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
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
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 0,
      verify: async () => [
        { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', durationMs: 1 },
      ],
    })
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('re-implements (agent) and re-verifies when verification fails, then succeeds', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const ws = fakeWorkspace()
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      verify: async () => {
        verifyCalls++
        const passed = verifyCalls >= 2 // 1차 실패, 2차(수정 후) 통과
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed,
            exitCode: passed ? 0 : 1,
            stdout: '',
            stderr: passed ? '' : 'boom',
            analysis: passed ? undefined : 'boom',
            durationMs: 1,
          },
        ]
      },
    })

    expect(verifyCalls).toBe(2) // 최초 + 수정 후 재검증 1회
    expect(implCalls).toBe(2) // 작업 구현 1 + 수정 1
    expect(ws.commits).toHaveLength(2) // 작업 keep + 수정 keep
    expect(ws.commits[1]).toContain('verify-fix')
    expect(result.verifications?.[0].passed).toBe(true)
    expect(store.getProject(result.projectId)?.status).toBe('done')
  })

  it('reverts a destructive verify-fix diff when no gate is provided', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // collectDiff 호출 순서: [0] 작업 경로(안전) → keep, [1] verify-fix 경로(파괴적) → 게이트 없음이므로 revert
    const ws = fakeWorkspace([
      { files: ['src/a.ts'], patch: '+a', truncated: false },
      { files: ['.env'], patch: '', truncated: true },
    ])
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 1,
      // gate 미지정 → 위험 verify-fix 변경은 거부(안전 기본값)
      verify: async () => [
        { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', analysis: 'x', durationMs: 1 },
      ],
    })

    // 작업 keep 만 존재하고, verify-fix 는 위험·미승인이라 keep 되지 않아야 한다(revert).
    expect(ws.commits).toHaveLength(1)
    expect(ws.commits.some((c) => c.includes('verify-fix'))).toBe(false)
    // 게이트 없이 위험 수정이 적용되지 않았으므로 프로젝트는 실패로 종료.
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('marks the project failed when verify fixes are exhausted', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const ws = fakeWorkspace()
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 2,
      verify: async () => {
        verifyCalls++
        return [
          { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', analysis: 'x', durationMs: 1 },
        ]
      },
    })

    expect(verifyCalls).toBe(3) // 최초 + 수정 2라운드 재검증
    expect(implCalls).toBe(3) // 작업 1 + 수정 2
    expect(ws.commits).toHaveLength(3) // 작업 keep + 수정 2 keep
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  function timeoutCapturingImplementer(sink: { timeoutMs?: number }): LlmSession {
    return {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send(_p, opts) {
        sink.timeoutMs = opts?.timeoutMs
        return '구현'
      },
      async dispose() {},
    }
  }

  it('injects a 15-minute default task timeout into send when none is requested', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const sink: { timeoutMs?: number } = {}
    sessions.add(timeoutCapturingImplementer(sink))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      // taskTimeoutMs 미지정 → 채팅용 120s 가 아니라 15분 기본이 send 에 도달해야 한다
    })
    expect(sink.timeoutMs).toBe(900_000)
  })

  it('passes an explicit taskTimeoutMs through to send unchanged', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const sink: { timeoutMs?: number } = {}
    sessions.add(timeoutCapturingImplementer(sink))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      taskTimeoutMs: 5000,
    })
    expect(sink.timeoutMs).toBe(5000)
  })

  it('does not attempt fixes when maxVerifyFixRounds is 0', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          return '구현'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const ws = fakeWorkspace()
    let verifyCalls = 0
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      maxVerifyFixRounds: 0,
      verify: async () => {
        verifyCalls++
        return [
          { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'x', durationMs: 1 },
        ]
      },
    })

    expect(verifyCalls).toBe(1) // 수정 시도 없음
    expect(implCalls).toBe(1) // 작업 구현만
    expect(ws.commits).toHaveLength(1) // 작업 keep 만, 수정 keep 없음
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })
})

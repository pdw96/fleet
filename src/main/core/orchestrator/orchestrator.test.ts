import { describe, expect, it, vi } from 'vitest'
import type { LlmConnectionKind, OrchestratorEvent } from '../../../shared/types'
import { createSessionManager } from '../session/manager'
import type { LlmSession } from '../session/types'
import { createMemoryStore } from '../store/memory'
import type { DiffResult, TaskWorktree, Workspace } from '../workspace/git'
import type { IgnoredBaseline, IgnoredChangeSet } from '../workspace/ignored-baseline'
import { runProject } from './orchestrator'

function fakeSession(
  id: string,
  responder: () => string,
  kind: LlmConnectionKind = 'api',
): LlmSession {
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

interface FakeIgnoredOpts {
  /** captureIgnoredBaseline 의 반환값. throw 함수를 넣으면 throw 한다. */
  captureResult?: IgnoredBaseline | (() => Promise<IgnoredBaseline>)
  /** collectIgnoredChanges 의 반환값. */
  collectResult?: IgnoredChangeSet
  /** restoreIgnoredBaseline spy — vi.fn() 으로 자동 생성(호출 여부·인자 기록용). */
  restoreSpy?: (baseline: IgnoredBaseline) => Promise<{ capped: boolean }>
}

/** diff/커밋을 기록하는 가짜 워크스페이스. collectDiff 는 호출마다 diffByCall 을 소비한다. */
function fakeWorkspace(
  diffByCall: DiffResult[] = [],
  ignoredOpts: FakeIgnoredOpts = {},
): Workspace & { commits: string[]; reverts: number } {
  let i = 0
  const commits: string[] = []
  const restoreSpy: (baseline: IgnoredBaseline) => Promise<{ capped: boolean }> =
    ignoredOpts.restoreSpy ?? vi.fn(async (_baseline: IgnoredBaseline) => ({ capped: false }))
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
    // Task 2 신규 API — 오케스트레이터 테스트는 worktree 경로를 아직 사용하지 않으므로 stub.
    async addWorktree() {
      throw new Error('addWorktree stub — not used in orchestrator tests')
    },
    async integrate() {
      return { ok: true }
    },
    async removeWorktree() {},
    async captureIgnoredBaseline(): Promise<IgnoredBaseline> {
      if (typeof ignoredOpts.captureResult === 'function') {
        return ignoredOpts.captureResult()
      }
      return ignoredOpts.captureResult ?? { entries: new Map(), skipped: [] }
    },
    async collectIgnoredChanges(): Promise<IgnoredChangeSet> {
      return ignoredOpts.collectResult ?? { changes: [], unrestorable: [] }
    },
    restoreIgnoredBaseline: restoreSpy,
  }
  return ws
}

/**
 * 병렬 sweep 검증용 가짜 워크스페이스.
 * - addWorktree(taskId, base): 작업별 가짜 worktree 를 반환한다. 그 worktree 의 keep()은
 *   keep 메시지에서 작업 제목을 파싱해 `keep-<title>` 형태의 결정적 해시를 돌려준다
 *   (생성 순서·통합 순서 단언이 제목 기반으로 안정적이도록).
 * - integrate(keepHash): onIntegrate 콜백에 통합 순서를 기록한다. conflictOn 과 일치하면 충돌 반환.
 * - removeWorktree: 정리 횟수를 센다.
 * keepCommitsInCreationOrder 는 worktree 생성(=addWorktree 호출) 순서대로의 keep 해시 목록.
 */
function parallelFakeWorkspace(
  opts: {
    onIntegrate?: (keepHash: string) => void
    conflictOn?: string
    /** 변경 없음(collectDiff 가 빈 files)을 시뮬레이션한다 — P1 #2 빈 worktree 통합 스킵 검증용. */
    emptyDiff?: boolean
  } = {},
): Workspace & {
  worktreesCreated: number
  worktreesRemoved: number
  removed: string[]
  keepCommitsInCreationOrder: string[]
  integrated: string[]
} {
  // keep 메시지 `[<title>] by <impl>` 에서 제목을 뽑아 결정적 해시로 만든다.
  const hashFor = (message: string): string => {
    const m = /^\[(.+?)\]/.exec(message)
    return `keep-${m ? m[1] : message}`
  }
  const state = {
    worktreesCreated: 0,
    worktreesRemoved: 0,
    removed: [] as string[],
    keepCommitsInCreationOrder: [] as string[],
    integrated: [] as string[],
    async ensureRepo() {},
    async checkpoint() {
      return 'base-main'
    },
    async collectDiff(): Promise<DiffResult> {
      return { files: ['src/x.ts'], patch: '+x', truncated: false }
    },
    async keep(message: string) {
      return hashFor(message)
    },
    async revert() {},
    async addWorktree(taskId: string, _base: string): Promise<TaskWorktree> {
      state.worktreesCreated++
      // 작업별 worktree: keep()이 제목 기반 결정적 해시를 반환하고, 생성 순서대로 기록한다.
      const wt: TaskWorktree = {
        path: `/wt/${taskId}`,
        async ensureRepo() {},
        async checkpoint() {
          return `base-${taskId}`
        },
        async collectDiff(): Promise<DiffResult> {
          // emptyDiff 면 변경 없음(원래-빈 worktree) — P1 #2: 호출자가 integrate 를 스킵해야 한다.
          if (opts.emptyDiff) return { files: [], patch: '', truncated: false }
          return { files: [`src/${taskId}.ts`], patch: '+x', truncated: false }
        },
        async keep(message: string) {
          const hash = hashFor(message)
          state.keepCommitsInCreationOrder.push(hash)
          return hash
        },
        async revert() {},
        async addWorktree() {
          throw new Error('중첩 addWorktree 미지원')
        },
        async integrate() {
          return { ok: true }
        },
        async removeWorktree() {},
        async captureIgnoredBaseline() {
          return { entries: new Map(), skipped: [] }
        },
        async collectIgnoredChanges() {
          return { changes: [], unrestorable: [] }
        },
        async restoreIgnoredBaseline() {
          return { capped: false }
        },
      }
      return wt
    },
    async integrate(keepHash: string) {
      state.integrated.push(keepHash)
      state.onIntegrate?.(keepHash)
      if (opts.conflictOn && keepHash === opts.conflictOn) {
        return { ok: false, conflict: `모의 충돌: ${keepHash}` }
      }
      return { ok: true }
    },
    async removeWorktree(taskId: string) {
      state.worktreesRemoved++
      state.removed.push(taskId)
    },
    async captureIgnoredBaseline() {
      return { entries: new Map(), skipped: [] }
    },
    async collectIgnoredChanges() {
      return { changes: [], unrestorable: [] }
    },
    async restoreIgnoredBaseline() {
      return { capped: false }
    },
    onIntegrate: opts.onIntegrate,
  }
  return state
}

describe('runProject', () => {
  it('plans, implements (direct edit), reviews (approve), and summarizes', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"작업A","description":"a"},{"title":"작업B","description":"b"}]',
      ),
    )
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

  it('summarizer는 reviewer처럼 순수 분석 호출: workspace/cwd 없이 변경 파일이 실린 프롬프트로 평가 (#164)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    // 요약 세션이 받은 프롬프트와 workspace 옵션을 포착한다.
    let sumPrompt = ''
    let sumWorkspace: string | undefined = 'UNSET'
    const sumSession: LlmSession = {
      id: 'sum',
      descriptor: { id: 'sum', kind: 'cli', displayName: 'sum', ref: 'sum', model: '' },
      async send(prompt, opts) {
        sumPrompt = prompt
        sumWorkspace = opts?.workspace
        return '요약: 목표 충족'
      },
      async dispose() {},
    }
    sessions.add(sumSession)
    await runProject('goal', {
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
    })
    // workspace 미전달 = 편집 모드·write 권한·fs 재탐색 없음(어댑터/config 무관 안전, #164·#165).
    expect(sumWorkspace).toBeUndefined()
    // 산출물(변경 파일)은 프롬프트에 직접 실린다 — 기본 fakeWorkspace diff = src/x.ts.
    expect(sumPrompt).toContain('src/x.ts')
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
      fakeSession(
        'planner',
        () => '[{"title":"T1","description":"a"},{"title":"T2","description":"b"}]',
      ),
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
    sessions.add(
      fakeSession('sum', () => {
        summarizerCalls++
        return '요약'
      }),
    )

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
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
          },
        ]
      },
    })

    const t1 = result.tasks.find((t) => t.title === 'T1')
    const t2 = result.tasks.find((t) => t.title === 'T2')
    expect(t1?.status).toBe('skipped') // 취소 중 send 예외 → 실행 오류(failed)가 아니라 취소(skipped)
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
    sessions.add(
      fakeSession('planner', () => '[{"title":"T","description":"d","role":"architect"}]'),
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

  it('accepts the final attempt with warnings when review never approves (#162, no cascade fail)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => '{"approved":false,"feedback":"테스트 추가 권장"}'))

    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
    })
    // 미승인이지만 마지막 시도를 채택 → failed 가 아니라 done (cascade 실패 방지)
    expect(result.tasks[0].status).toBe('done')
    expect(ws.commits).toHaveLength(1) // 마지막 시도 keep
    expect(ws.reverts).toBe(0) // 마지막 라운드는 rollback 하지 않는다
    // 감사: task.accepted_with_warnings 이벤트 + feedback 가시(이벤트 data·task.output)
    const warn = events.find((e) => e.type === 'task.accepted_with_warnings')
    expect(warn).toBeDefined()
    expect(warn?.data?.feedback).toContain('테스트 추가 권장')
    expect(result.tasks[0].output).toContain('테스트 추가 권장')
    // #162(Codex#3): 실제 feedback 이 이벤트 message 에도 노출돼야 한다(ProjectPanel 은 message 만 렌더).
    expect(warn?.message).toContain('테스트 추가 권장')
  })

  it('does NOT accept-with-warnings when the reviewer gives no valid verdict (#162 safety)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => '')) // exit 0 이지만 빈 출력 = 유효한 verdict 아님

    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
    })
    // 리뷰어가 유효한 verdict 를 안 냄 → 미검토 채택이 아니라 실패
    expect(result.tasks[0].status).toBe('failed')
    expect(ws.commits).toHaveLength(0)
    expect(events.some((e) => e.type === 'task.accepted_with_warnings')).toBe(false)
  })

  it('does NOT accept-with-warnings an empty final diff (#162 no-op not done)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => '{"approved":false,"feedback":"미완성"}'))

    const events: OrchestratorEvent[] = []
    // 구현이 아무것도 안 고침 → collectDiff 빈 files (산출물 없음)
    const ws = fakeWorkspace([{ files: [], patch: '', truncated: false }])
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
      onEvent: (e) => events.push(e),
    })
    // 빈 산출물은 채택하지 않는다 → done 아니라 failed
    expect(result.tasks[0].status).toBe('failed')
    expect(ws.commits).toHaveLength(0)
    expect(events.some((e) => e.type === 'task.accepted_with_warnings')).toBe(false)
  })

  it('does NOT auto-keep a destructive final-review reject even if the gate approved (#162 safety)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => '{"approved":false,"feedback":"위험 변경 거부"}'))

    const events: OrchestratorEvent[] = []
    // 민감 파일(.env) → destructive. gate 가 승인하지만, reviewer 가 거부 → 위험 변경은 경고 채택 비대상.
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
      maxReviewRounds: 1,
      gate: {
        async request() {
          return 'approved'
        },
      },
      onEvent: (e) => events.push(e),
    })
    // 위험 변경을 reviewer 가 거부 → rollback + failed (accept-with-warnings 로 keep 하지 않음)
    expect(result.tasks[0].status).toBe('failed')
    expect(ws.commits).toHaveLength(0)
    expect(ws.reverts).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.type === 'task.accepted_with_warnings')).toBe(false)
  })

  it('does NOT rescue a destructive-gate rejection via accept-with-warnings (#162 safety)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => '{"approved":false,"feedback":"별로"}'))

    const events: OrchestratorEvent[] = []
    // 민감 파일(.env) → destructive. gate 미지정 → 거부. reviewer 도 거부하지만 destructive 가 먼저.
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
      maxReviewRounds: 1,
      onEvent: (e) => events.push(e),
    })
    expect(result.tasks[0].status).toBe('failed') // destructive 미승인 = hard-fail (accept-with-warnings 아님)
    expect(ws.commits).toHaveLength(0) // keep 없음
    expect(events.some((e) => e.type === 'task.accepted_with_warnings')).toBe(false)
  })

  it('continues dependent tasks when the dependency is accepted-with-warnings (#162 no cascade)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // B(인덱스1)는 A(인덱스0)에 의존. A 는 리뷰 미승인이나 accept-with-warnings 로 done → B 실행돼야.
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b","dependsOn":[0]}]',
      ),
    )
    const implemented: string[] = []
    sessions.add(recordingImplementer(implemented))
    sessions.add(fakeSession('rev', () => '{"approved":false,"feedback":"개선 권장"}'))

    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
    })
    const a = result.tasks.find((t) => t.title === 'A')
    const b = result.tasks.find((t) => t.title === 'B')
    expect(a?.status).toBe('done') // accept-with-warnings
    expect(b?.status).toBe('done') // 의존이 done 이므로 실행됨(cascade 방지)
    expect(implemented).toEqual(['A', 'B'])
    // 부모 경고가 이벤트로 가시
    const warns = events.filter((e) => e.type === 'task.accepted_with_warnings')
    expect(warns.length).toBe(2)
    expect((warns[0].data as { feedback?: string })?.feedback).toContain('개선 권장')
  })

  it('does not emit accept-with-warnings when there is no reviewer (#162 no regression)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    // reviewer 미할당 → approved=true 즉시 → 일반 done (accept-with-warnings 경로 아님)
    const events: OrchestratorEvent[] = []
    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
      onEvent: (e) => events.push(e),
    })
    expect(result.tasks[0].status).toBe('done')
    expect(events.some((e) => e.type === 'task.accepted_with_warnings')).toBe(false)
    expect(events.some((e) => e.type === 'task.done')).toBe(true)
  })

  it('surfaces verify failure even when a task was accepted-with-warnings (#162 not a clean success)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => '{"approved":false,"feedback":"개선 권장"}'))

    const events: OrchestratorEvent[] = []
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
      maxVerifyFixRounds: 0,
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'boom',
          analysis: 'fail',
          durationMs: 1,
        },
      ],
      onEvent: (e) => events.push(e),
    })
    // 리뷰 미승인은 경고로 낮춰 태스크는 done 이지만,
    expect(result.tasks[0].status).toBe('done')
    expect(events.some((e) => e.type === 'task.accepted_with_warnings')).toBe(true)
    // verify 실패는 그대로 표면화 → 최종 성공으로 보이지 않는다.
    expect(result.verifications?.some((v) => !v.passed)).toBe(true)
    expect(events.some((e) => e.type === 'verify.failed')).toBe(true)
    expect(events.some((e) => e.type === 'verify.passed')).toBe(false)
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
      async addWorktree() {
        throw new Error('addWorktree stub')
      },
      async integrate() {
        return { ok: true }
      },
      async removeWorktree() {},
      async captureIgnoredBaseline() {
        return { entries: new Map(), skipped: [] }
      },
      async collectIgnoredChanges() {
        return { changes: [], unrestorable: [] }
      },
      async restoreIgnoredBaseline() {
        return { capped: false }
      },
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
    // planner 검증은 createProject 전에 일어난다 — 고아 프로젝트(planning 영구 정체)를 store 에 남기지 않는다.
    expect(store.listProjects()).toHaveLength(0)
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

  it('runs exactly maxReviewRounds cycles, reverting middle rejects and keeping the last (#162)', async () => {
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
      maxReviewRounds: 2,
    })
    expect(implCalls).toBe(2) // 2회 시도 (off-by-one 이면 3회가 됨)
    // #162: 마지막 라운드 미승인은 accept-with-warnings → failed 가 아니라 done
    expect(result.tasks[0].status).toBe('done')
    expect(ws.reverts).toBe(1) // 중간(round0) 거부만 revert, 마지막(round1)은 keep 위해 revert 안 함
    expect(ws.commits).toHaveLength(1) // 마지막 시도만 keep
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
      fakeSession(
        'planner',
        () => '[{"title":"T1","description":"a"},{"title":"T2","description":"b"}]',
      ),
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
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a","dependsOn":[1]},{"title":"B","description":"b"}]',
      ),
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
    // B(인덱스1)는 A(인덱스0)에 의존. #162 이후 리뷰 거절은 더 이상 실패가 아니므로, A 는
    // 위험(destructive) 변경 미승인이라는 genuine 실패로 실패시킨다.
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b","dependsOn":[0]}]',
      ),
    )
    const implemented: string[] = []
    sessions.add(recordingImplementer(implemented))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // A 의 변경이 민감 파일(.env) → gate 미지정이라 destructive 거부 → A 는 reviewer 도달 전 failed
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
      maxReviewRounds: 1,
    })
    const a = result.tasks.find((t) => t.title === 'A')
    const b = result.tasks.find((t) => t.title === 'B')
    expect(a?.status).toBe('failed') // genuine 실패(destructive 미승인)
    expect(b?.status).toBe('skipped') // 의존 실패로 건너뜀
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
        () =>
          '[{"title":"A","description":"a","dependsOn":[1]},{"title":"B","description":"b","dependsOn":[0]}]',
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
      gate: {
        async request() {
          return 'approved'
        },
      },
    })
    expect(result.tasks[0].status).toBe('done')
    expect(ws.commits).toHaveLength(1)
  })

  it(':301 mixed(tracked+ignored) gate target에 tracked 파일과 ignored reason이 모두 포함된다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const gateRequests: { target: string }[] = []
    // tracked 파일(src/a.ts) + ignored 변경(.secret modified) 동시 발생
    const ws = fakeWorkspace([{ files: ['src/a.ts'], patch: '+a', truncated: false }], {
      collectResult: {
        changes: [{ path: '.secret', change: 'modified', sensitive: true }],
        unrestorable: [],
      },
    })

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
      gate: {
        async request(req) {
          gateRequests.push({ target: req.target })
          return 'approved'
        },
      },
    })

    expect(result.tasks[0].status).toBe('done')
    expect(gateRequests).toHaveLength(1)
    // target에 tracked 파일과 ignored reason이 모두 포함되어야 함
    expect(gateRequests[0].target).toContain('src/a.ts')
    expect(gateRequests[0].target).toContain('.secret')
    // 내용 미노출 — 파일 내용·hash 값 자체는 포함되지 않아야 함(경로·종류만)
    // 참고: 파일명 '.secret' 은 경로로서 포함되는 것은 정상(내용이 아님)
    expect(gateRequests[0].target).not.toMatch(/=[A-Za-z0-9+/]{20,}|sha256:[0-9a-f]{64}/i)
  })

  it('#1: routes a planner task labeled role:"reviewer" through the CLI implementer (runs to done, not skipped)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // planner 가 작업에 role:"reviewer" 를 붙인다 — 모든 작업은 편집하므로 implementer 로 라우팅돼야 한다.
    sessions.add(
      fakeSession('planner', () => '[{"title":"T","description":"d","role":"reviewer"}]'),
    )
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
    sessions.add(fakeSession('rev', () => 'APPROVE', 'api')) // 리뷰어는 API(비편집)
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
    expect(result.tasks[0].role).toBe('reviewer') // 라벨은 보존
    expect(result.tasks[0].status).toBe('done') // 비편집 reviewer 로 오라우팅돼 skipped 되지 않음
    expect(result.tasks[0].assignedLlmId).toBe('impl') // 항상 implementer 로 실행
    expect(implCalls).toBe(1)
  })

  it('#5: does NOT send a sensitive diff to the reviewer when the risk gate has no approver', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    let reviewerCalls = 0
    sessions.add(
      fakeSession('rev', () => {
        reviewerCalls++
        return 'APPROVE'
      }),
    )
    sessions.add(fakeSession('sum', () => '요약')) // 별도 summarizer — 리뷰어가 요약 폴백으로 재사용되지 않게
    // 민감 파일(.env) → destructive. gate 없음 → 리뷰어에게 보내기 전에 거부돼야 한다.
    const ws = fakeWorkspace([{ files: ['.env'], patch: '+secret', truncated: false }])
    const result = await runProject('goal', {
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
      // gate 미지정 → 위험 변경은 거부(안전 기본값)
    })
    expect(result.tasks[0].status).toBe('failed')
    expect(reviewerCalls).toBe(0) // P1: 비밀 diff 가 리뷰어(외부 API 가능)에게 절대 전달되지 않음
    expect(ws.commits).toHaveLength(0)
    expect(ws.reverts).toBeGreaterThanOrEqual(1)
  })

  it('#5: sends to the reviewer only after the gate approves a sensitive diff', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    let reviewerCalls = 0
    sessions.add(
      fakeSession('rev', () => {
        reviewerCalls++
        return 'APPROVE'
      }),
    )
    sessions.add(fakeSession('sum', () => '요약')) // 별도 summarizer — 리뷰어 폴백 재사용 방지
    const ws = fakeWorkspace([{ files: ['.env'], patch: '+secret', truncated: false }])
    const result = await runProject('goal', {
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
      gate: {
        async request() {
          return 'approved'
        },
      },
    })
    expect(result.tasks[0].status).toBe('done')
    expect(reviewerCalls).toBe(1) // 승인 후에는 리뷰어가 호출된다
    expect(ws.commits).toHaveLength(1)
  })

  it('#6: planTasks forwards the abort signal to the planner send', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    const controller = new AbortController()
    let plannerSignal: AbortSignal | undefined
    let sawSignal = false
    sessions.add({
      id: 'planner',
      descriptor: { id: 'planner', kind: 'api', displayName: 'planner', ref: 'planner', model: '' },
      async send(_prompt, opts) {
        plannerSignal = opts?.signal
        sawSignal = opts?.signal !== undefined
        return '[{"title":"T","description":"d"}]'
      },
      async dispose() {},
    })
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
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
      signal: controller.signal,
    })
    expect(sawSignal).toBe(true) // planner send 에 signal 이 전달됨
    expect(plannerSignal).toBe(controller.signal) // 정확히 같은 signal 인스턴스
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
        {
          kind: 'test',
          command: 'npm test',
          passed: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
        },
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
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
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
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          analysis: 'x',
          durationMs: 1,
        },
      ],
    })

    // 작업 keep 만 존재하고, verify-fix 는 위험·미승인이라 keep 되지 않아야 한다(revert).
    expect(ws.commits).toHaveLength(1)
    expect(ws.commits.some((c) => c.includes('verify-fix'))).toBe(false)
    // 게이트 없이 위험 수정이 적용되지 않았으므로 프로젝트는 실패로 종료.
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('replans (append corrective task) and re-verifies to pass when maxReplanRounds > 0', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return plannerCalls === 1
          ? '[{"title":"T","description":"d"}]' // 초기 계획
          : '{"tasks":[{"title":"보정","description":"fix"}]}' // 보정 계획
      }),
    )
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

    const events: OrchestratorEvent[] = []
    let verifyCalls = 0
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
      maxVerifyFixRounds: 0, // verify-fix 격리 — replan 경로만 검증
      maxReplanRounds: 1,
      onEvent: (e) => events.push(e),
      verify: async () => {
        verifyCalls++
        const passed = verifyCalls >= 2 // 1차 실패, 보정 실행 후 2차 통과
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

    expect(verifyCalls).toBe(2) // 최초 + 보정 후 재검증
    expect(implCalls).toBe(2) // 초기 작업 + 보정 작업
    expect(events.some((e) => e.type === 'replan')).toBe(true)
    const tasks = store.listTasks(result.projectId)
    expect(tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['T', '보정'])) // append-only
    expect(tasks.find((t) => t.title === 'T')?.status).toBe('done') // 기존 작업 불변
    expect(store.getProject(result.projectId)?.status).toBe('done')
  })

  it('does not replan when maxReplanRounds is unset (default 0)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return '[{"title":"T","description":"d"}]'
      }),
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
      maxVerifyFixRounds: 0,
      // maxReplanRounds 미지정 → 기본 0(비활성)
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          analysis: 'x',
          durationMs: 1,
        },
      ],
    })
    expect(plannerCalls).toBe(1) // 초기 계획만, 보정 계획 호출 없음
    expect(store.listTasks(result.projectId)).toHaveLength(1)
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('runs exactly maxReplanRounds replan cycles before giving up', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return '{"tasks":[{"title":"보정","description":"fix"}]}' // 초기·보정 모두 1개
      }),
    )
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
    let verifyCalls = 0
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
      maxReplanRounds: 2,
      verify: async () => {
        verifyCalls++
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'x',
            analysis: 'x',
            durationMs: 1,
          },
        ]
      },
    })
    expect(plannerCalls).toBe(3) // 초기 1 + 보정 2라운드 (off-by-one 이면 4)
    expect(verifyCalls).toBe(3) // 최초 + 보정 2라운드 재검증
    expect(implCalls).toBe(3) // 초기 작업 1 + 보정 작업 2
    expect(store.listTasks(result.projectId)).toHaveLength(3) // 초기 1 + 보정 2 append
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('stops replanning early when the planner returns no corrective tasks', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return plannerCalls === 1 ? '[{"title":"T","description":"d"}]' : '{"tasks":[]}'
      }),
    )
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
    let verifyCalls = 0
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
      maxReplanRounds: 3,
      verify: async () => {
        verifyCalls++
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'x',
            analysis: 'x',
            durationMs: 1,
          },
        ]
      },
    })
    expect(plannerCalls).toBe(2) // 초기 + 보정계획 1회(빈 목록) → 조기 break
    expect(implCalls).toBe(1) // 초기 작업만, 보정 작업 실행 0
    expect(store.listTasks(result.projectId)).toHaveLength(1)
    expect(verifyCalls).toBe(1) // 빈 보정이라 재검증 없음
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('surfaces a replan-planning error and stops (does not swallow)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        if (plannerCalls === 1) return '[{"title":"T","description":"d"}]'
        throw new Error('planner timeout') // 보정 계획 호출에서 실패
      }),
    )
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
    const events: OrchestratorEvent[] = []
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
      maxReplanRounds: 2,
      onEvent: (e) => events.push(e),
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          analysis: 'x',
          durationMs: 1,
        },
      ],
    })
    const replanEvent = events.find((e) => e.type === 'replan')
    expect(replanEvent?.message).toContain('보정 계획 실패') // 에러를 이벤트로 표면화(비-silent)
    expect(replanEvent?.message).toContain('planner timeout')
    expect(implCalls).toBe(1) // 보정 작업은 실행되지 않음
    expect(store.listTasks(result.projectId)).toHaveLength(1)
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('skips re-verification when cancelled during a corrective task', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    const controller = new AbortController()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return plannerCalls === 1
          ? '[{"title":"T","description":"d"}]'
          : '{"tasks":[{"title":"보정","description":"fix"}]}'
      }),
    )
    let implCalls = 0
    sessions.add(
      fakeSession(
        'impl',
        () => {
          implCalls++
          if (implCalls === 2) controller.abort() // 보정 작업 실행 중 취소
          return '구현'
        },
        'cli',
      ),
    )
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    let verifyCalls = 0
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
      signal: controller.signal,
      maxVerifyFixRounds: 0,
      maxReplanRounds: 2,
      verify: async () => {
        verifyCalls++
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'x',
            analysis: 'x',
            durationMs: 1,
          },
        ]
      },
    })
    expect(verifyCalls).toBe(1) // 최초 검증만 — 취소 후 재검증(전체 verify 스위트) 생략
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('refreshes the summary after replan appends corrective tasks', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    let plannerCalls = 0
    sessions.add(
      fakeSession('planner', () => {
        plannerCalls++
        return plannerCalls === 1
          ? '[{"title":"T","description":"d"}]'
          : '{"tasks":[{"title":"보정","description":"fix"}]}'
      }),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const summaryPrompts: string[] = []
    const sumSession: LlmSession = {
      id: 'sum',
      descriptor: { id: 'sum', kind: 'api', displayName: 'sum', ref: 'sum', model: '' },
      async send(prompt: string) {
        summaryPrompts.push(prompt)
        return `요약(${summaryPrompts.length})`
      },
      async dispose() {},
    }
    sessions.add(sumSession)
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
      maxVerifyFixRounds: 0,
      maxReplanRounds: 1,
      verify: async () => {
        verifyCalls++
        const passed = verifyCalls >= 2 // 1차 실패 → replan → 2차 통과
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed,
            exitCode: passed ? 0 : 1,
            stdout: '',
            stderr: passed ? '' : 'x',
            analysis: passed ? undefined : 'x',
            durationMs: 1,
          },
        ]
      },
    })
    expect(summaryPrompts).toHaveLength(2) // 최초(보정 전) + replan 후 갱신
    expect(summaryPrompts[1]).toContain('보정') // 갱신본은 append 된 보정 작업을 포함
    expect(result.summary).toBe('요약(2)') // 최종 summary 는 갱신본
    expect(store.getProject(result.projectId)?.status).toBe('done')
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
          {
            kind: 'test',
            command: 'npm test',
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'x',
            analysis: 'x',
            durationMs: 1,
          },
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
          {
            kind: 'test',
            command: 'npm test',
            passed: false,
            exitCode: 1,
            stdout: '',
            stderr: 'x',
            durationMs: 1,
          },
        ]
      },
    })

    expect(verifyCalls).toBe(1) // 수정 시도 없음
    expect(implCalls).toBe(1) // 작업 구현만
    expect(ws.commits).toHaveLength(1) // 작업 keep 만, 수정 keep 없음
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('enriches live onEvent events with projectId for task-level events (not just persisted)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const live: OrchestratorEvent[] = []
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
      onEvent: (e) => live.push(e),
    })
    // 라이브 task 이벤트(원래 data:{taskId})도 projectId 로 enrich 되어야 렌더러 필터를 통과한다.
    const taskDone = live.find((e) => e.type === 'task.done')
    expect(taskDone?.data?.['projectId']).toBe(result.projectId)
    const planCreated = live.find((e) => e.type === 'plan.created')
    expect(planCreated?.data?.['projectId']).toBe(result.projectId)
  })

  it('persists milestones with message+projectId and does NOT persist task.progress', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    // 구현 세션이 토큰 델타(onChunk)를 흘리도록 한다.
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send(_p, opts) {
        opts?.onChunk?.('토큰1')
        opts?.onChunk?.('토큰2')
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

    const persisted = store.listProjectEvents(result.projectId)
    // 모든 영속 이벤트가 해당 projectId 로 태깅된다.
    expect(persisted.every((e) => e.data['projectId'] === result.projectId)).toBe(true)
    // 마일스톤은 메시지와 함께 재생 가능.
    expect(persisted.some((e) => e.type === 'project.created' && !!e.message)).toBe(true)
    expect(persisted.some((e) => e.type === 'project.done' && !!e.message)).toBe(true)
    // task.progress(토큰 델타)는 영속되지 않는다.
    expect(store.listEvents().some((e) => e.type === 'task.progress')).toBe(false)
  })

  // ── 오케스트레이터 정확성 소탕 (#7: 무성흡수 금지 · 정확한 라벨) ──

  it('취소 중 send 예외인 in-flight 작업을 "실행 오류"(failed)가 아니라 취소(skipped)로 라벨한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const controller = new AbortController()
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        controller.abort() // 작업 실행 중 취소 발생
        throw new Error('aborted mid-task')
      },
      async dispose() {},
    }
    sessions.add(impl)
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const events: OrchestratorEvent[] = []
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
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    })
    const t = result.tasks[0]
    expect(t.status).toBe('skipped') // 취소는 실패가 아니다
    expect(t.output).toContain('실행 취소됨')
    expect(t.output).not.toContain('실행 오류') // 취소를 실행 오류로 오라벨하지 않는다
    expect(events.some((e) => e.type === 'task.skipped')).toBe(true)
    expect(events.some((e) => e.type === 'task.failed')).toBe(false) // 취소는 task.failed 로 방출하지 않는다
  })

  it('취소가 아닌 실제 send 예외는 여전히 "실행 오류"(failed)로 라벨한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        throw new Error('CLI 호출 실패') // 취소 없이 순수 오류
      },
      async dispose() {},
    }
    sessions.add(impl)
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
    })
    const t = result.tasks[0]
    expect(t.status).toBe('failed')
    expect(t.output).toContain('실행 오류')
    expect(events.some((e) => e.type === 'task.failed')).toBe(true)
  })

  it('작업 오류 정리 중 revert 실패를 무성흡수하지 않고 표면화한다 (#7)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        throw new Error('CLI 호출 실패')
      },
      async dispose() {},
    }
    sessions.add(impl)
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    // revert 가 거부하는 워크스페이스 — 부분 변경이 잔존하므로 무성흡수하면 안 된다.
    const ws: Workspace = {
      async ensureRepo() {},
      async checkpoint() {
        return 'base'
      },
      async collectDiff(): Promise<DiffResult> {
        return { files: [], patch: '', truncated: false }
      },
      async keep() {
        return 'commit'
      },
      async revert() {
        throw new Error('git reset 실패')
      },
      async addWorktree() {
        throw new Error('addWorktree stub')
      },
      async integrate() {
        return { ok: true }
      },
      async removeWorktree() {},
      async captureIgnoredBaseline() {
        return { entries: new Map(), skipped: [] }
      },
      async collectIgnoredChanges() {
        return { changes: [], unrestorable: [] }
      },
      async restoreIgnoredBaseline() {
        return { capped: false }
      },
    }
    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
    })
    const t = result.tasks[0]
    expect(t.status).toBe('failed')
    expect(t.output).toContain('실행 오류') // 원래 작업 오류
    expect(t.output).toContain('되돌리기 실패') // revert 실패도 표면화(무성흡수 금지)
    expect(t.output).toContain('git reset 실패') // revert 오류 원문 보존
    expect(
      events.some((e) => e.type === 'task.failed' && e.message.includes('되돌리기 실패')),
    ).toBe(true)
  })

  it('verify-fix 정리 중 revert 실패를 무성흡수하지 않고 표면화한다 (#7)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    let implCalls = 0
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        implCalls++
        if (implCalls >= 2) throw new Error('수정 호출 실패') // verify-fix 호출에서 실패
        return '구현' // 첫 작업은 성공(승인→keep, revert 안 함)
      },
      async dispose() {},
    }
    sessions.add(impl)
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    // 작업 경로는 승인되어 revert 미호출. verify-fix catch 에서만 revert 가 호출되며 거부한다.
    const ws: Workspace = {
      async ensureRepo() {},
      async checkpoint() {
        return 'base'
      },
      async collectDiff(): Promise<DiffResult> {
        return { files: ['src/a.ts'], patch: '+a', truncated: false }
      },
      async keep() {
        return 'commit'
      },
      async revert() {
        throw new Error('git clean 실패')
      },
      async addWorktree() {
        throw new Error('addWorktree stub')
      },
      async integrate() {
        return { ok: true }
      },
      async removeWorktree() {},
      async captureIgnoredBaseline() {
        return { entries: new Map(), skipped: [] }
      },
      async collectIgnoredChanges() {
        return { changes: [], unrestorable: [] }
      },
      async restoreIgnoredBaseline() {
        return { capped: false }
      },
    }
    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          analysis: 'x',
          durationMs: 1,
        },
      ],
    })
    const fixEvent = events.find(
      (e) => e.type === 'verify.fixing' && e.message.includes('수정 실패'),
    )
    expect(fixEvent).toBeDefined()
    expect(fixEvent?.message).toContain('되돌리기 실패') // verify-fix revert 실패 표면화
    expect(fixEvent?.message).toContain('git clean 실패') // revert 오류 원문 보존
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('취소된 실행의 project.done 메시지는 "완료"가 아니라 "취소"를 반영한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const controller = new AbortController()
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        controller.abort()
        throw new Error('aborted')
      },
      async dispose() {},
    }
    sessions.add(impl)
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const events: OrchestratorEvent[] = []
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
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    })
    const done = events.find((e) => e.type === 'project.done')
    expect(done).toBeDefined()
    expect(done?.message).toContain('취소') // 취소를 '완료'로 위장하지 않는다
    expect(done?.message).not.toContain('완료')
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('검증 실패 실행의 project.done 메시지는 "완료"가 아니라 "실패"를 반영한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
      ],
    })
    const done = events.find((e) => e.type === 'project.done')
    expect(done).toBeDefined()
    expect(done?.message).toContain('실패') // 검증 실패를 '완료'로 위장하지 않는다
    expect(done?.message).not.toContain('완료')
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('성공한 실행의 project.done 메시지는 "완료"를 유지한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))
    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
    })
    const done = events.find((e) => e.type === 'project.done')
    expect(done?.message).toContain('완료')
    expect(store.getProject(result.projectId)?.status).toBe('done')
  })

  // ── Task 3: makeEditSession 팩토리 ──

  it('RunOptions.makeEditSession 타입이 존재하고 타입 체크를 통과한다', () => {
    // makeEditSession 이 RunOptions 에 선택적 필드로 존재함을 컴파일 타임에 검증한다.
    // 런타임 단언 없음 — 이 테스트가 통과한다는 것 자체가 타입 추가의 증거.
    let made = 0
    const factory: NonNullable<Parameters<typeof runProject>[1]['makeEditSession']> = () => {
      made++
      return fakeSession(`impl-${made}`, () => '구현', 'cli')
    }
    // 팩토리가 올바른 LlmSession 인터페이스를 만족하는지 타입 추론으로 검증
    const session = factory()
    expect(session.id).toMatch(/^impl-/)
    expect(session.descriptor.kind).toBe('cli')
  })

  it('makeEditSession 팩토리는 호출마다 서로 다른 독립 인스턴스를 반환한다', () => {
    // 편집 에이전트가 stateless 라도, 팩토리가 항상 새 독립 chain 을 가진 인스턴스를 만든다는 것을 검증한다.
    // engine 이 구성할 팩토리와 동일한 조건(호출마다 새 fakeSession)을 단위로 검증한다.
    let made = 0
    const makeEditSession = () => {
      made++
      return fakeSession(`impl-${made}`, () => '구현', 'cli')
    }

    const s1 = makeEditSession()
    const s2 = makeEditSession()

    // 팩토리는 호출마다 서로 다른 인스턴스를 반환해야 한다(독립성 핵심 계약).
    expect(s1).not.toBe(s2)
    // 각 인스턴스는 고유한 id 를 갖는다(같은 chain 을 공유하지 않는다).
    expect(s1.id).not.toBe(s2.id)
    expect(made).toBe(2)
  })

  it('makeEditSession 이 RunOptions 에 전달될 때 타입 오류 없이 runProject 에 넘길 수 있다', async () => {
    // makeEditSession 을 실제로 RunOptions 에 넣어 runProject 를 호출해도 타입·런타임 오류 없음 검증.
    // 현재 orchestrator 는 makeEditSession 을 사용하지 않으므로(Task 5 배선 전), 인수 수락 여부만 확인.
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    let factoryCalled = 0
    // runProject 에 makeEditSession 을 넘겨도 타입 오류 없이 실행이 완료돼야 한다.
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
      makeEditSession: () => {
        factoryCalled++
        return fakeSession(`edit-${factoryCalled}`, () => '구현', 'cli')
      },
    })

    // maxConcurrency 미지정(기본 1=순차 모드)이므로 팩토리는 호출되지 않아야 한다(순차 폴백).
    // Task 5(병렬 스케줄러)가 배선되면 maxConcurrency > 1 일 때 factoryCalled > 0 이 된다.
    expect(factoryCalled).toBe(0) // 무회귀: 기본 순차 모드에서 팩토리 미호출 검증
    expect(result.tasks[0].status).toBe('done')
  })

  // Task 4: runTaskIn keep 해시 반환 검증 ─────────────────────────────────────────────────
  // runTaskIn 은 runProject 내부 클로저라 직접 호출 불가. ws.keep spy 를 통해 반환값을
  // 가로채, done 경로에서 runTaskIn 이 keep 반환 해시를 올바르게 수신·캡처했는지 간접 검증.
  it('Task4: done 경로에서 ws.keep 이 반환한 해시가 정상 캡처된다(commit-N 형식)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"T1","description":"d1"},{"title":"T2","description":"d2"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // keep 호출마다 반환 해시를 기록하는 spy workspace
    const keepHashes: string[] = []
    let keepCallCount = 0
    const baseWs = fakeWorkspace()
    const spyWs: typeof baseWs = {
      ...baseWs,
      async keep(message: string) {
        const hash = await baseWs.keep(message)
        keepHashes.push(hash)
        keepCallCount++
        return hash
      },
    }

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: spyWs,
      workspaceRoot: '/ws',
    })

    // 두 작업 모두 done — keep 이 두 번 호출돼야 한다
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(keepCallCount).toBe(2)
    // keep 반환 해시가 commit-N 형식인지 확인 — runTaskIn 이 ws.keep 반환값을 받아 리턴하는 경로 검증
    expect(keepHashes).toEqual(['commit-1', 'commit-2'])
  })

  // ── Task 5: 병렬 sweep 스케줄러 ──

  /** 두 작업이 동시에 편집에 진입함을 관측하는 배리어형 편집 세션 팩토리. */
  function makeBarrierEditFactory(expected: number): {
    factory: () => LlmSession
    maxConcurrentEdits: () => number
  } {
    let inFlight = 0
    let maxInFlight = 0
    let resolveAll: (() => void) | undefined
    const allEntered = new Promise<void>((r) => {
      resolveAll = r
    })
    let n = 0
    const factory = (): LlmSession => {
      const id = `impl-${++n}`
      return {
        id,
        descriptor: { id, kind: 'cli', displayName: id, ref: id, model: '' },
        async send() {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          // 모든 작업이 진입하면 배리어를 푼다 — 직렬 실행이면 첫 진입에서 영영 안 풀린다.
          if (inFlight >= expected) resolveAll?.()
          await allEntered
          inFlight--
          return '구현'
        },
        async dispose() {},
      }
    }
    return { factory, maxConcurrentEdits: () => maxInFlight }
  }

  it('runs independent tasks in parallel and integrates in creation order (maxConcurrency=2)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    // 의존성 없는 A·B — 병렬 실행 가능.
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    // 순차 implementer 도 등록(무회귀 분기 가드는 makeEditSession 으로 병렬 진입).
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const order: string[] = []
    const ws = parallelFakeWorkspace({ onIntegrate: (c) => order.push(c) })
    const { factory, maxConcurrentEdits } = makeBarrierEditFactory(2)
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
      maxConcurrency: 2,
      makeEditSession: factory,
    })

    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(maxConcurrentEdits()).toBe(2) // 두 편집이 실제로 동시 진입(직렬이면 1)
    expect(ws.worktreesCreated).toBe(2)
    expect(ws.worktreesRemoved).toBe(2) // 정리 누락 없음
    // 통합은 생성 순서(병렬 완료 순서 아님) — 결정론.
    expect(order).toEqual(ws.keepCommitsInCreationOrder)
    expect(order).toEqual(['keep-A', 'keep-B'])
  })

  it('isolates a conflicting task as failed without poisoning others (maxConcurrency=2)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // A 의 keep 해시(keep-A) 통합이 충돌한다.
    const ws = parallelFakeWorkspace({ conflictOn: 'keep-A' })
    const { factory } = makeBarrierEditFactory(2)
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
      maxConcurrency: 2,
      makeEditSession: factory,
    })

    const byTitle = Object.fromEntries(result.tasks.map((t) => [t.title, t.status]))
    expect(byTitle.A).toBe('failed') // 통합 충돌 → failed
    expect(byTitle.B).toBe('done') // 다른 작업은 오염되지 않음
    expect(ws.worktreesRemoved).toBe(2) // 충돌이어도 둘 다 정리
    expect(ws.worktreesCreated).toBe(2)
  })

  it('reverts and cleans all in-flight worktrees on abort (maxConcurrency=2)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const controller = new AbortController()
    const ws = parallelFakeWorkspace()
    // 첫 편집(A) 진입 시 취소하고 throw — in-flight 병렬 작업의 abort 시뮬레이션.
    let made = 0
    const makeEditSession = (): LlmSession => {
      const id = `impl-${++made}`
      const isA = made === 1
      return {
        id,
        descriptor: { id, kind: 'cli', displayName: id, ref: id, model: '' },
        async send() {
          if (isA) {
            controller.abort()
            throw new Error('aborted mid-edit')
          }
          return '구현'
        },
        async dispose() {},
      }
    }
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
      maxConcurrency: 2,
      signal: controller.signal,
      makeEditSession,
    })

    expect(store.getProject(result.projectId)?.status).toBe('failed') // 취소=failed 종료
    // 생성한 worktree 는 전부 정리됐다 — 잔존 worktree 0.
    expect(ws.worktreesRemoved).toBe(ws.worktreesCreated)
    expect(ws.worktreesCreated).toBeGreaterThan(0)
    // abort 시 main HEAD 잔존 커밋 0 — integrate 호출 없어야 함.
    expect(ws.integrated).toEqual([])
  })

  // P1 #1: 병렬 편집은 메인 checkout(opts.workspaceRoot)이 아니라 작업별 worktree(wt.path)를 cwd 로 써야 한다.
  // 이를 어기면 모든 병렬 편집이 메인을 수정해 worktree 는 빈 diff, integrate dirty 가드가 실패 → 격리 무력화.
  it('P1#1: 병렬 편집 send 의 workspace cwd 는 메인이 아니라 작업별 worktree 경로다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // 각 편집 send 가 받은 workspace(cwd)를 기록하는 팩토리.
    const editWorkspaces: (string | undefined)[] = []
    let made = 0
    const makeEditSession = (): LlmSession => {
      const id = `impl-${++made}`
      return {
        id,
        descriptor: { id, kind: 'cli', displayName: id, ref: id, model: '' },
        async send(_prompt, opts) {
          editWorkspaces.push(opts?.workspace)
          return '구현'
        },
        async dispose() {},
      }
    }
    const ws = parallelFakeWorkspace()
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
      maxConcurrency: 2,
      makeEditSession,
    })

    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    // 두 편집 모두 worktree 경로(/wt/<taskId>)를 cwd 로 받아야 한다 — 메인('/ws')이면 격리 무력화.
    expect(editWorkspaces).toHaveLength(2)
    expect(editWorkspaces.every((w) => w?.startsWith('/wt/'))).toBe(true)
    expect(editWorkspaces).not.toContain('/ws') // 메인 checkout 으로 새지 않음
  })

  // P1#1(무회귀): 순차 모드는 여전히 메인 워크스페이스 경로(opts.workspaceRoot)를 편집 cwd 로 쓴다.
  it('P1#1(순차): 순차 편집 send 의 workspace cwd 는 메인 워크스페이스 경로(workspaceRoot)다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const editWorkspaces: (string | undefined)[] = []
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send(_prompt, opts) {
        editWorkspaces.push(opts?.workspace)
        return '구현'
      },
      async dispose() {},
    }
    sessions.add(impl)
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
    expect(editWorkspaces).toEqual(['/ws']) // 순차 경로 무회귀: 메인 워크스페이스 cwd 유지
  })

  // P1 #2: 변경 없는(원래-빈) worktree 는 integrate 를 호출하지 않는다.
  // (구버전 git 에서 빈 cherry-pick 이 깨지지 않도록 호출자가 사전 스킵 — 작업은 여전히 done.)
  it('P1#2: 변경 없는 worktree 는 integrate 를 호출하지 않고 done 으로 둔다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const ws = parallelFakeWorkspace({ emptyDiff: true })
    const { factory } = makeBarrierEditFactory(2)
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
      maxConcurrency: 2,
      makeEditSession: factory,
    })

    // 변경이 없어도 작업은 정상 완료(done) — 빈 worktree 는 실패가 아니다.
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    expect(ws.integrated).toEqual([]) // 빈 worktree → integrate 미호출(구버전 빈 cherry-pick 방어)
    expect(ws.worktreesRemoved).toBe(2) // 그래도 정리는 한다
  })

  // P2 #3: worktree 생성 루프 중간에 addWorktree 가 throw 하면, 그 전에 만든 worktree 가
  // 정리 섹션 도달 전 디스크에 잔존한다. 누적된 worktree 를 전부 정리하고 진행해야 한다.
  it('P2#3: addWorktree 가 중간에 실패하면 그때까지 만든 worktree 를 전부 정리한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const base = parallelFakeWorkspace()
    let addCalls = 0
    const removed: string[] = []
    // 첫 addWorktree 는 성공, 둘째는 throw(스테일 .fleet-wt-* 잔존 시뮬레이션).
    const ws: typeof base = {
      ...base,
      async addWorktree(taskId: string, b: string) {
        addCalls++
        if (addCalls === 2) throw new Error('스테일 worktree 잔존: .fleet-wt-B')
        return base.addWorktree(taskId, b)
      },
      async removeWorktree(taskId: string) {
        removed.push(taskId)
        return base.removeWorktree(taskId)
      },
    }
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
      maxConcurrency: 2,
      makeEditSession: () => fakeSession('edit', () => '구현', 'cli'),
    })

    // 생성-실패 배치에서 A 1건 정리 + 재시도 sweep 에서 A 성공 후 정리 1건 = 총 2건.
    // 무관한 정리가 통과 조건이 되던 >=1 대신, 실제 생성+정리 횟수와 일치하는 정확한 값을 단언한다.
    expect(removed.length).toBe(2)
    expect(store.getProject(result.projectId)).toBeDefined()
    // 생성 실패로 배치가 진행 못 하면 무한 루프가 아니라 종료해야 한다(잔여 작업은 failed/skipped).
    expect(result.tasks.length).toBe(2)
    // 모든 작업이 종결 상태(running 잔존 0).
    expect(result.tasks.every((t) => t.status !== 'running')).toBe(true)
  })

  // P2 #4: abort 가 통합을 스킵해도 runTaskIn 이 이미 task 를 done 으로 갱신했다.
  // cherry-pick 안 됐는데 done 보고는 오해 — skipped 로 다운그레이드해야 한다.
  it('P2#4: abort 로 통합이 스킵된 작업은 done 이 아니라 skipped 다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const controller = new AbortController()
    const ws = parallelFakeWorkspace()
    // 두 편집 모두 done 까지 마친 뒤, 통합 직전에 abort 를 건다.
    // B 의 편집 send 가 끝나는 시점에 abort → 통합 루프는 둘 다 스킵해야 한다.
    let made = 0
    const makeEditSession = (): LlmSession => {
      const id = `impl-${++made}`
      const isLast = made === 2
      return {
        id,
        descriptor: { id, kind: 'cli', displayName: id, ref: id, model: '' },
        async send() {
          if (isLast) controller.abort() // 둘 다 편집 완료 직후 취소
          return '구현'
        },
        async dispose() {},
      }
    }
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
      maxConcurrency: 2,
      signal: controller.signal,
      makeEditSession,
    })

    // abort 로 통합이 스킵됐으므로 어떤 작업도 done 으로 남으면 안 된다(main 미반영을 정직 반영).
    expect(result.tasks.some((t) => t.status === 'done')).toBe(false)
    expect(result.tasks.every((t) => t.status === 'skipped')).toBe(true)
    expect(ws.integrated).toEqual([]) // 통합 미수행
    expect(ws.worktreesRemoved).toBe(ws.worktreesCreated) // 정리는 완료
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  // P2 #5: runTaskIn 의 try/catch 밖(예: ws.checkpoint)에서 reject 하면 allSettled 결과가
  // rejected 인데, 현재는 undefined(keepHash 없음)로만 처리돼 task 가 running 인 채 pending 에서 제거된다.
  it('P2#5: 편집 전(checkpoint) reject 한 작업은 running 잔존이 아니라 failed 다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const baseWs = parallelFakeWorkspace()
    // 첫 worktree 의 checkpoint() 가 reject — runTaskIn try 진입 전이라 try/catch 가 못 잡는다.
    let addCalls = 0
    const ws: typeof baseWs = {
      ...baseWs,
      async addWorktree(taskId: string, b: string) {
        addCalls++
        const wt = await baseWs.addWorktree(taskId, b)
        if (addCalls === 1) {
          // 첫 작업의 worktree checkpoint 가 try 밖에서 throw → allSettled rejected
          return Object.assign(wt, {
            async checkpoint() {
              throw new Error('worktree checkpoint 실패(try 밖)')
            },
          })
        }
        return wt
      },
    }
    const events: OrchestratorEvent[] = []
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
      maxConcurrency: 2,
      makeEditSession: () => fakeSession('edit', () => '구현', 'cli'),
      onEvent: (e) => events.push(e),
    })

    // 어떤 작업도 running 으로 영구 잔존하면 안 된다.
    expect(result.tasks.every((t) => t.status !== 'running')).toBe(true)
    // checkpoint 가 reject 한 작업은 failed 로 종결되고 task.failed 가 방출돼야 한다.
    const failedTask = result.tasks.find((t) => t.status === 'failed')
    expect(failedTask).toBeDefined()
    expect(events.some((e) => e.type === 'task.failed')).toBe(true)
    // 그래도 worktree 는 정리된다(잔존 0).
    expect(ws.worktreesRemoved).toBe(ws.worktreesCreated)
  })

  // ── Task 6: ignored baseline/risk/rollback 배선 회귀 ──

  it('회귀1: 기존 .env(sensitive) modified → gate 가 destructive 로 호출되고 거부 시 restoreIgnoredBaseline 호출됨 + reason 에 .env·modified 포함(내용 미포함)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const restoreSpy = vi.fn(async () => ({ capped: false }))
    // ignoredChanges: 기존 .env 가 modified(sensitive)
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: '.env', change: 'modified', sensitive: true }],
      unrestorable: [],
    }
    // diff 는 tracked 변경 없음(ignored 변경만 destructive 트리거)
    const ws = fakeWorkspace([{ files: [], patch: '', truncated: false }], {
      collectResult,
      restoreSpy,
    })

    const gateRequests: Parameters<
      NonNullable<Parameters<typeof runProject>[1]['gate']>['request']
    >[0][] = []
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
      gate: {
        async request(req) {
          gateRequests.push(req)
          return 'rejected' // 승인 거부
        },
      },
    })

    // gate 가 destructive 로 호출됐는지
    expect(gateRequests.length).toBeGreaterThan(0)
    expect(gateRequests[0].risk).toBe('destructive')
    // classifyDiffRisk reasons 는 store output 에도 들어간다 — .env·modified 포함, 내용 미포함
    const taskOutput = result.tasks[0].output ?? ''
    expect(taskOutput).toContain('.env')
    expect(taskOutput).toContain('modified')
    expect(taskOutput).not.toContain('+secret') // 내용 미노출
    // 거부 후 restoreIgnoredBaseline spy 호출됨
    expect(restoreSpy).toHaveBeenCalled()
    // task failed
    expect(result.tasks[0].status).toBe('failed')
  })

  it('회귀2: 새 ignored secret(created, sensitive) → 미승인 시 restoreIgnoredBaseline spy 호출됨', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const restoreSpy = vi.fn(async () => ({ capped: false }))
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: '.env.secret', change: 'created', sensitive: true }],
      unrestorable: [],
    }
    const ws = fakeWorkspace([{ files: [], patch: '', truncated: false }], {
      collectResult,
      restoreSpy,
    })

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
      // gate 미지정 → 거부(안전 기본값)
    })

    // 미승인으로 실패
    expect(result.tasks[0].status).toBe('failed')
    // restoreIgnoredBaseline spy 호출됨(created 삭제 로직이 실행됐음을 검증)
    expect(restoreSpy).toHaveBeenCalled()
  })

  it('회귀4: tracked 변경 + ignored 변경 혼합 → gate reason 에 양쪽(tracked 위험 + ignored 위험) 포함, destructive', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const restoreSpy = vi.fn(async () => ({ capped: false }))
    // tracked: .env 파일 변경(sensitive → destructive)
    // ignored: credentials.json modified(sensitive)
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: 'credentials.json', change: 'modified', sensitive: true }],
      unrestorable: [],
    }
    const ws = fakeWorkspace([{ files: ['.env'], patch: '+tracked', truncated: false }], {
      collectResult,
      restoreSpy,
    })

    let capturedReasons: string[] = []
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
      gate: {
        async request(req) {
          // task output 에 reasons 가 들어가는 경로를 통해 검증하기 위해 요청 요약에서 추출
          capturedReasons = [req.summary, req.target ?? '']
          return 'rejected'
        },
      },
    })

    expect(result.tasks[0].status).toBe('failed')
    // task output 에 tracked 위험(.env) + ignored 위험(credentials.json) 양쪽 포함
    const taskOutput = result.tasks[0].output ?? ''
    expect(taskOutput).toContain('.env') // tracked 위험
    expect(taskOutput).toContain('credentials.json') // ignored 위험
    expect(taskOutput).toContain('modified') // change 종류
    // gate 가 destructive 로 호출됐는지
    expect(capturedReasons.length).toBeGreaterThan(0)
    // restoreIgnoredBaseline 호출됨
    expect(restoreSpy).toHaveBeenCalled()
  })

  it('capture-fail: captureIgnoredBaseline 이 throw 하면 task 가 hard-fail 되고 implement 루프 진입 안 함', async () => {
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

    const ws = fakeWorkspace([], {
      captureResult: async () => {
        throw new Error('민감 파일 stat 실패')
      },
    })

    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
    })

    // 작업은 failed
    expect(result.tasks[0].status).toBe('failed')
    expect(result.tasks[0].output).toContain('민감 ignored 백업 실패')
    expect(result.tasks[0].output).toContain('민감 파일 stat 실패')
    // implement 루프 진입 안 함 — implementer.send 호출 0
    expect(implCalls).toBe(0)
    // task.failed 이벤트 방출됨
    expect(events.some((e) => e.type === 'task.failed')).toBe(true)
  })

  // ── Task 7: verify-fix ignored 가드 배선 회귀 ──

  it('회귀3: verify-fix 중 abort → rollbackWithIgnored(restoreIgnoredBaseline) 호출 + task failed(gate 거절로 runTaskIn 에서 이미 failed, verify-fix catch 는 task 상태 불변)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    const controller = new AbortController()
    let implCalls = 0
    sessions.add({
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        implCalls++
        if (implCalls >= 2) {
          // verify-fix 수정 호출 시 abort + throw
          controller.abort()
          throw new Error('aborted mid-fix')
        }
        return '구현'
      },
      async dispose() {},
    })
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const restoreSpy = vi.fn(async () => ({ capped: false }))
    // ignored: deleted 파일이 있음(deleted → 복구 대상)
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: '.env', change: 'deleted', sensitive: true }],
      unrestorable: [],
    }
    const ws = fakeWorkspace(
      [
        { files: ['src/a.ts'], patch: '+a', truncated: false }, // 작업 경로 diff
        { files: ['src/b.ts'], patch: '+b', truncated: false }, // verify-fix diff
      ],
      { collectResult, restoreSpy },
    )

    const events: OrchestratorEvent[] = []
    // verifyCalls 카운터로 첫 검증은 실패(수정 진입), 수정 중 abort
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
      signal: controller.signal,
      maxVerifyFixRounds: 1,
      onEvent: (e) => events.push(e),
      verify: async () => {
        verifyCalls++
        // 첫 번째 검증은 실패(verify-fix 진입), 이후는 abort 로 도달 불가
        const passed = verifyCalls > 1
        return [
          {
            kind: 'test',
            command: 'npm test',
            passed,
            exitCode: passed ? 0 : 1,
            stdout: '',
            stderr: passed ? '' : 'boom',
            durationMs: 1,
          },
        ]
      },
    })

    // abort 로 취소됐으므로 project 는 failed
    expect(store.getProject(result.projectId)?.status).toBe('failed')
    // 작업은 runTaskIn 내 gate 거절(ignored 민감 변경 → destructive → no gate → rejected)로 'failed' 처리됐다.
    // verify-fix 는 task 상태를 변경하지 않으므로 abort 후에도 'failed' 유지.
    expect(result.tasks[0].status).toBe('failed')
    // verify-fix catch(abort) 에서 rollbackWithIgnored 가 호출됐는지 — restoreIgnoredBaseline spy 검증
    expect(restoreSpy).toHaveBeenCalled()
    // verify-fix 이벤트에 수정 실패 메시지가 있어야 한다
    const fixEvent = events.find(
      (e) => e.type === 'verify.fixing' && e.message.includes('수정 실패'),
    )
    expect(fixEvent).toBeDefined()
  })

  it('회귀5: verify-fix 에서 unrestorable ignored → classifyDiffRisk destructive → gate 호출(escalate), 거부 시 rollback', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const restoreSpy = vi.fn(async () => ({ capped: false }))
    // unrestorable ignored 변경 → classifyDiffRisk 가 '복원 불가' reason 을 포함한 destructive 로 분류해야 한다
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: 'secrets/creds.json', change: 'modified', sensitive: true }],
      unrestorable: [{ path: 'secrets/creds.json', reason: 'over-cap' }],
    }
    const ws = fakeWorkspace(
      [
        { files: ['src/a.ts'], patch: '+a', truncated: false }, // 작업 경로 diff(안전)
        { files: ['src/b.ts'], patch: '+b', truncated: false }, // verify-fix diff
      ],
      { collectResult, restoreSpy },
    )

    const gateRequests: Parameters<
      NonNullable<Parameters<typeof runProject>[1]['gate']>['request']
    >[0][] = []
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
      gate: {
        async request(req) {
          gateRequests.push(req)
          return 'rejected' // 거부 → rollback
        },
      },
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
      ],
    })

    // gate 가 destructive 로 호출됐는지(verify-fix 경로에서 escalate)
    expect(gateRequests.length).toBeGreaterThan(0)
    expect(gateRequests[0].risk).toBe('destructive')
    // rollbackWithIgnored 가 호출됐는지 — restoreIgnoredBaseline spy
    expect(restoreSpy).toHaveBeenCalled()
    // project 는 검증 실패(수정 미승인)
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  it('회귀6: verify-fix 에서 baseline 보유 후 예외 발생 → finally 에서 disposeBaseline 호출(entries 비워짐)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    // taskSendDone: 첫 send(작업 구현)가 완료되면 true 로 전환 — 이후 send 는 verify-fix 수정이므로 예외
    let taskSendDone = false
    sessions.add({
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send() {
        if (taskSendDone) throw new Error('수정 호출 실패') // verify-fix 에서 예외
        taskSendDone = true
        return '구현'
      },
      async dispose() {},
    })
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // 각 captureIgnoredBaseline 호출마다 독립적인 Map 인스턴스와 Buffer 를 생성한다.
    // 공유 Map 을 쓰면 runTaskIn finally 의 disposeBaseline 이 먼저 실행돼 verify-fix 경로의
    // dispose 여부와 무관하게 entries.size === 0 이 돼 거짓 통과(false-pass) 가 발생한다.
    const capturedBaselines: IgnoredBaseline[] = []
    const capturedBackups: Buffer[] = [] // entries 가 clear 된 후에도 Buffer 제로화 여부를 검증하기 위해 보관
    const ws = fakeWorkspace(
      [
        { files: ['src/a.ts'], patch: '+a', truncated: false }, // 작업 경로
        { files: [], patch: '', truncated: false }, // verify-fix diff
      ],
      {
        captureResult: async () => {
          // 호출마다 새 Buffer · 새 Map — 공유 상태 없음
          const backupBuf = Buffer.from('KEY=1')
          capturedBackups.push(backupBuf)
          const entries = new Map<string, import('../workspace/ignored-baseline').IgnoredEntry>([
            [
              '.env',
              {
                path: '.env',
                size: 4,
                mtimeMs: 1000,
                hash: 'abc',
                sensitive: true,
                backup: backupBuf,
                mode: 0o644,
              },
            ],
          ])
          const bl: IgnoredBaseline = { entries, skipped: [] }
          capturedBaselines.push(bl)
          return bl
        },
        collectResult: { changes: [], unrestorable: [] },
      },
    )

    await runProject('goal', {
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
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
      ],
    })

    // 각 경로(runTaskIn + verify-fix)에서 captureIgnoredBaseline 이 각각 호출됐어야 한다.
    // 독립 Map 이므로 각 baseline 이 자신의 disposeBaseline 에 의해 비워진 것을 단독으로 증명한다.
    expect(capturedBaselines.length).toBeGreaterThanOrEqual(1)
    // 모든 캡처된 baseline 의 entries 가 각자의 disposeBaseline 으로 비워졌는지
    for (const bl of capturedBaselines) {
      expect(bl.entries.size).toBe(0) // disposeBaseline 이 호출됐으면 0
    }
    // 각 Buffer 도 disposeBaseline 이 제로화했는지(backup 비밀 내용이 메모리에 잔존하지 않는지)
    for (const buf of capturedBackups) {
      expect(buf.every((b) => b === 0)).toBe(true)
    }
  })

  it('회귀7: 병렬 worktree 경로에서 worktree ws 의 ignored 메서드가 호출되고 ignored_changes 이벤트 방출됨', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // worktree 별 ignored 메서드 호출을 추적하는 parallelFakeWorkspace 확장
    const wtCaptureCalls: string[] = [] // taskId 별 captureIgnoredBaseline 호출 기록
    const wtCollectCalls: string[] = [] // taskId 별 collectIgnoredChanges 호출 기록

    const base = parallelFakeWorkspace()
    // addWorktree 를 오버라이드해 spy 가 포함된 worktree 를 반환한다.
    // collectIgnoredChanges 는 non-empty 변경을 반환해 workspace.ignored_changes 이벤트가
    // store.appendEvent 로 기록되도록 한다(이벤트 방출 경로 검증).
    const ws: typeof base = {
      ...base,
      async addWorktree(taskId: string, b: string) {
        const wt = await base.addWorktree(taskId, b)
        // ignored 메서드에 spy 추가
        const origCapture = wt.captureIgnoredBaseline.bind(wt)
        return {
          ...wt,
          async captureIgnoredBaseline() {
            wtCaptureCalls.push(taskId)
            return origCapture()
          },
          async collectIgnoredChanges(_bl: IgnoredBaseline) {
            wtCollectCalls.push(taskId)
            // non-empty 반환 → orchestrator 가 workspace.ignored_changes 를 store 에 기록한다
            return {
              changes: [{ path: `.env-${taskId}`, change: 'modified' as const, sensitive: true }],
              unrestorable: [],
            }
          },
        }
      },
    }

    const events: OrchestratorEvent[] = []
    const { factory } = makeBarrierEditFactory(2)
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
      maxConcurrency: 2,
      makeEditSession: factory,
      onEvent: (e) => events.push(e),
      // non-empty ignored changes → classifyDiffRisk 'destructive' → gate 필요. 승인해 task 를 done 으로 유도.
      gate: {
        async request() {
          return 'approved'
        },
      },
    })

    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    // 병렬 worktree 각각의 captureIgnoredBaseline 이 호출됐는지
    expect(wtCaptureCalls.length).toBe(2)
    // 각 worktree 의 collectIgnoredChanges 도 호출됐는지
    expect(wtCollectCalls.length).toBe(2)
    // worktree 정리(removeWorktree) 완료 후 잔존 없음 — base 의 카운터를 참조(spread 는 값 복사)
    expect(base.worktreesRemoved).toBe(2)
    // workspace.ignored_changes 이벤트가 store 에 기록됐는지
    // (orchestrator 는 이 이벤트를 store.appendEvent 로 직접 영속화하므로 store.listEvents() 로 검증)
    expect(store.listEvents().some((e) => e.type === 'workspace.ignored_changes')).toBe(true)
  })

  // ── #123-A: Codex PR 리뷰 반영 (P2-1, P2-2, P2-5) ──

  // P2-1: ignored-only destructive 에서 gate target 이 ignored 경로·종류를 포함한다
  it('P2-1: ignored-only destructive → gate target 은 ignored 경로·종류 포함, 내용 미노출', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // diff.files 는 비어 있고, ignored 변경만 destructive 를 유발한다.
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: '.env', change: 'modified', sensitive: true }],
      unrestorable: [],
    }
    const ws = fakeWorkspace([{ files: [], patch: '', truncated: false }], { collectResult })

    const gateRequests: Parameters<
      NonNullable<Parameters<typeof runProject>[1]['gate']>['request']
    >[0][] = []
    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      gate: {
        async request(req) {
          gateRequests.push(req)
          return 'rejected'
        },
      },
    })

    expect(gateRequests.length).toBeGreaterThan(0)
    const target = gateRequests[0].target ?? ''
    // ignored 경로(.env)와 종류(modified)가 target 에 포함돼야 한다
    expect(target).toContain('.env')
    expect(target).toContain('modified')
    // 파일 내용은 노출하지 않는다
    expect(target).not.toContain('+secret')
    expect(target).not.toContain('KEY=')
  })

  // P2-1: verify-fix 경로도 ignored-only destructive 시 gate target 에 ignored 정보 포함
  it('P2-1(verify-fix): ignored-only destructive → verify-fix gate target 은 ignored 경로·종류 포함', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // 작업 경로는 tracked 변경(안전), verify-fix 에서 ignored-only destructive
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: 'secrets/key.pem', change: 'created', sensitive: true }],
      unrestorable: [],
    }
    const ws = fakeWorkspace(
      [
        { files: ['src/a.ts'], patch: '+a', truncated: false }, // 작업 경로 diff(안전)
        { files: [], patch: '', truncated: false }, // verify-fix diff — ignored-only
      ],
      { collectResult },
    )

    const gateRequests: Parameters<
      NonNullable<Parameters<typeof runProject>[1]['gate']>['request']
    >[0][] = []
    await runProject('goal', {
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
      gate: {
        async request(req) {
          gateRequests.push(req)
          // 첫 번째(작업 경로)는 승인, 두 번째(verify-fix)는 거부
          return gateRequests.length === 1 ? 'approved' : 'rejected'
        },
      },
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
      ],
    })

    // verify-fix gate 요청(두 번째)에 ignored 경로·종류 포함
    expect(gateRequests.length).toBeGreaterThanOrEqual(2)
    const vfTarget = gateRequests[1].target ?? ''
    expect(vfTarget).toContain('key.pem')
    expect(vfTarget).toContain('created')
  })

  // P2-2: reviewer 거절 후 rollback 실패 → 재시도 안 함, task failed, rollback note 표면화
  it('P2-2: reviewer 거절 + rollback 실패 → task failed, implementer 재호출 없음', async () => {
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
    // 리뷰어는 항상 거절
    sessions.add(fakeSession('rev', () => 'REVISE: 다시'))

    // revert 가 throw 해 rollbackWithIgnored 가 non-empty note 를 반환하도록 한다
    const ws: Workspace = {
      async ensureRepo() {},
      async checkpoint() {
        return 'base'
      },
      async collectDiff(): Promise<DiffResult> {
        return { files: ['src/a.ts'], patch: '+a', truncated: false }
      },
      async keep() {
        return 'commit'
      },
      async revert() {
        throw new Error('git reset hard 실패')
      },
      async addWorktree() {
        throw new Error('addWorktree stub')
      },
      async integrate() {
        return { ok: true }
      },
      async removeWorktree() {},
      async captureIgnoredBaseline() {
        return { entries: new Map(), skipped: [] }
      },
      async collectIgnoredChanges() {
        return { changes: [], unrestorable: [] }
      },
      async restoreIgnoredBaseline() {
        return { capped: false }
      },
    }

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
      maxReviewRounds: 3, // 재시도 여지를 주되, rollback 실패 시 즉시 중단해야 한다
    })

    // rollback 실패 → task 는 즉시 failed, 재시도 없음
    expect(result.tasks[0].status).toBe('failed')
    // rollback 실패 노트가 output 에 포함돼야 한다
    expect(result.tasks[0].output).toContain('되돌리기 실패')
    // implementer 가 1회 이상 호출됐지만, rollback 실패 후 재시도(2회 이상)는 하지 않는다
    expect(implCalls).toBe(1)
  })

  // P2-5: workspace.ignored_changes 이벤트가 emit 을 통해 projectId 를 갖는다
  it('P2-5: workspace.ignored_changes 이벤트는 listProjectEvents 에 포함된다(projectId 부착)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // non-empty ignored changes → workspace.ignored_changes 이벤트 방출
    const collectResult: IgnoredChangeSet = {
      changes: [{ path: '.env', change: 'modified', sensitive: true }],
      unrestorable: [],
    }
    // diff.files 가 있어야 gate 승인 후 done 으로 진행
    const ws = fakeWorkspace([{ files: ['src/a.ts'], patch: '+a', truncated: false }], {
      collectResult,
    })

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
      gate: {
        async request() {
          return 'approved' // destructive diff 승인
        },
      },
    })

    // listProjectEvents 는 data.projectId 로 필터링 → ignored_changes 이벤트가 포함돼야 한다
    const projectEvents = store.listProjectEvents(result.projectId)
    const ignoredEvt = projectEvents.find((e) => e.type === 'workspace.ignored_changes')
    expect(ignoredEvt).toBeDefined()
    expect(ignoredEvt?.data['projectId']).toBe(result.projectId)
  })

  // P2-5: verify-fix 경로의 workspace.ignored_changes 이벤트도 listProjectEvents 에 포함
  it('P2-5(verify-fix): verify-fix ignored_changes 이벤트도 listProjectEvents 에 포함된다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const collectResult: IgnoredChangeSet = {
      changes: [{ path: '.env', change: 'modified', sensitive: true }],
      unrestorable: [],
    }
    const ws = fakeWorkspace(
      [
        { files: ['src/a.ts'], patch: '+a', truncated: false }, // 작업 경로
        { files: ['src/b.ts'], patch: '+b', truncated: false }, // verify-fix 경로
      ],
      { collectResult },
    )

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
      gate: {
        async request() {
          return 'approved'
        },
      },
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
      ],
    })

    const projectEvents = store.listProjectEvents(result.projectId)
    const ignoredEvts = projectEvents.filter((e) => e.type === 'workspace.ignored_changes')
    // 작업 경로 + verify-fix 경로에서 각각 방출, 모두 projectId 부착
    expect(ignoredEvts.length).toBeGreaterThanOrEqual(2)
    expect(ignoredEvts.every((e) => e.data['projectId'] === result.projectId)).toBe(true)
  })

  it('verify-fix capture-fail: captureIgnoredBaseline 실패 → break + verify.fixing 이벤트(민감 백업 실패)', async () => {
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

    // 첫 captureIgnoredBaseline 호출(작업 경로)은 성공, 두 번째(verify-fix)는 실패
    let captureCalls = 0
    const ws = fakeWorkspace([{ files: ['src/a.ts'], patch: '+a', truncated: false }], {
      captureResult: async () => {
        captureCalls++
        if (captureCalls >= 2) throw new Error('민감 파일 백업 용량 초과')
        return { entries: new Map(), skipped: [] }
      },
    })

    const events: OrchestratorEvent[] = []
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
      onEvent: (e) => events.push(e),
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
      ],
    })

    // verify-fix 루프에서 capture 실패 → break → 수정 미실행
    expect(implCalls).toBe(1) // 작업 구현 1회만, verify-fix 수정 호출 0
    // verify.fixing 이벤트에 민감 백업 실패 메시지
    const captureFailEvent = events.find(
      (e) => e.type === 'verify.fixing' && e.message.includes('민감 ignored 백업 실패'),
    )
    expect(captureFailEvent).toBeDefined()
    expect(captureFailEvent?.message).toContain('민감 파일 백업 용량 초과')
    // project 는 검증 실패
    expect(store.getProject(result.projectId)?.status).toBe('failed')
  })

  // ── [:298] unrestorable-only gate target ──

  it('[:298] unrestorable-only(diff.files 빈, changes 빈) → gate target 이 비지 않고 unrestorable 경로 포함', async () => {
    // 목적: diff.files=[], ignoredChanges.changes=[], ignoredChanges.unrestorable=[...] 케이스
    // 이전 구현은 ignoredReasons = dr.reasons.filter(r => !r.startsWith('복원 불가')) 로 unrestorable reason 을 제외해
    // gateTarget 이 '' → 승인자가 왜 destructive 인지 알 수 없었다.
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // diff 빈 + ignored changes 빈 + unrestorable 만 있음(scan-capped over-cap)
    const collectResult: IgnoredChangeSet = {
      changes: [],
      unrestorable: [{ path: 'scan-capped', reason: 'over-cap' }],
    }
    const ws = fakeWorkspace([{ files: [], patch: '', truncated: false }], { collectResult })

    const gateRequests: Parameters<
      NonNullable<Parameters<typeof runProject>[1]['gate']>['request']
    >[0][] = []
    await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: ws,
      workspaceRoot: '/ws',
      gate: {
        async request(req) {
          gateRequests.push(req)
          return 'rejected'
        },
      },
    })

    // gate 가 호출됐는지(unrestorable → destructive)
    expect(gateRequests.length).toBeGreaterThan(0)
    expect(gateRequests[0].risk).toBe('destructive')
    // [:298] target 이 비어 있으면 안 된다 — unrestorable 경로·이유가 포함되어야 한다
    const target = gateRequests[0].target ?? ''
    expect(target.length).toBeGreaterThan(0)
    expect(target).toContain('복원 불가')
  })

  it('[:298] verify-fix 경로: unrestorable-only → gate target 비지 않음', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    // 작업 경로 safe, verify-fix 에서 unrestorable-only
    const collectResult: IgnoredChangeSet = {
      changes: [],
      unrestorable: [{ path: 'big-secret.dat', reason: 'over-cap' }],
    }
    const ws = fakeWorkspace(
      [
        { files: ['src/a.ts'], patch: '+a', truncated: false }, // task diff
        { files: [], patch: '', truncated: false }, // verify-fix diff — 빈
      ],
      { collectResult },
    )

    const gateRequests: Parameters<
      NonNullable<Parameters<typeof runProject>[1]['gate']>['request']
    >[0][] = []
    await runProject('goal', {
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
      gate: {
        async request(req) {
          gateRequests.push(req)
          return gateRequests.length === 1 ? 'approved' : 'rejected'
        },
      },
      verify: async () => [
        {
          kind: 'test',
          command: 'npm test',
          passed: false,
          exitCode: 1,
          stdout: '',
          stderr: 'x',
          durationMs: 1,
        },
      ],
    })

    // verify-fix gate 요청(두 번째 이상)에서 target 이 비지 않아야 한다
    expect(gateRequests.length).toBeGreaterThanOrEqual(2)
    const vfTarget = gateRequests[1].target ?? ''
    expect(vfTarget.length).toBeGreaterThan(0)
    expect(vfTarget).toContain('복원 불가')
  })

  it('[#128-m1] 병렬 worktree 의 승인된 ignored 변경 폐기 시 workspace.ignored_discarded 를 기록한다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const base = parallelFakeWorkspace()
    const ws: typeof base = {
      ...base,
      async addWorktree(taskId: string, b: string) {
        const wt = await base.addWorktree(taskId, b)
        return {
          ...wt,
          async collectIgnoredChanges(_bl: IgnoredBaseline) {
            // worktree 에 ignored 변경 존재 → 승인 후 done 이지만 main 통합 안 됨(폐기)
            return {
              changes: [{ path: `.env-${taskId}`, change: 'modified' as const, sensitive: true }],
              unrestorable: [],
            }
          },
        }
      },
    }

    const { factory } = makeBarrierEditFactory(2)
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
      maxConcurrency: 2,
      makeEditSession: factory,
      gate: {
        async request() {
          return 'approved'
        },
      },
    })

    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    const discarded = store
      .listProjectEvents(result.projectId)
      .filter((e) => e.type === 'workspace.ignored_discarded')
    // 두 worktree 작업 모두 ignored 변경 보유 + done → 2건
    expect(discarded.length).toBe(2)
    // 각 이벤트에 비어있지 않은 message 가 있어야 한다(빈 행 방지)
    expect(discarded.every((e) => typeof e.message === 'string' && e.message.length > 0)).toBe(true)
    // 경로·종류만 — 내용 비노출(이벤트 data 에 taskId/projectId 만)
    expect(JSON.stringify(discarded)).not.toContain('.env-')
  })

  it('[#128-m1] baseline.skipped(unrestorable) 만 있고 actual changes 없으면 workspace.ignored_discarded 를 기록하지 않는다', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const base = parallelFakeWorkspace()
    const ws: typeof base = {
      ...base,
      async addWorktree(taskId: string, b: string) {
        const wt = await base.addWorktree(taskId, b)
        return {
          ...wt,
          async collectIgnoredChanges(_bl: IgnoredBaseline) {
            // 에이전트가 ignored 파일에 실제 변경 없음, baseline.skipped 항목만 존재
            return {
              changes: [],
              unrestorable: [{ path: 'pre.env', reason: 'over-cap' as const }],
            } satisfies IgnoredChangeSet
          },
        }
      },
    }

    const { factory } = makeBarrierEditFactory(2)
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
      maxConcurrency: 2,
      makeEditSession: factory,
      gate: {
        async request() {
          return 'approved'
        },
      },
    })

    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    const discarded = store
      .listProjectEvents(result.projectId)
      .filter((e) => e.type === 'workspace.ignored_discarded')
    // 실제 changes 없음 → ignored_discarded 이벤트 0건
    expect(discarded.length).toBe(0)
  })

  // [#128-finding5] ignored 감사 이벤트의 라이브(onEvent) 표면화 + 스토어 1회(이중계상 없음)
  it('[#128-finding5] workspace.ignored_changes 는 라이브(onEvent)로 방출되고 eventId 부착 + 스토어 1회만(이중계상 없음)', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const collectResult: IgnoredChangeSet = {
      changes: [{ path: '.env', change: 'modified', sensitive: true }],
      unrestorable: [],
    }
    const ws = fakeWorkspace([{ files: ['src/a.ts'], patch: '+a', truncated: false }], {
      collectResult,
    })

    const live: OrchestratorEvent[] = []
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
      onEvent: (e) => live.push(e),
      gate: {
        async request() {
          return 'approved' // destructive diff 승인
        },
      },
    })

    // 라이브 방출 — 과거 append-only 였으면 onEvent 가 이 타입을 못 받아 0건(RED).
    const liveIgnored = live.filter((e) => e.type === 'workspace.ignored_changes')
    expect(liveIgnored.length).toBe(1)
    // 비어있지 않은 message(과거엔 message 없음 → 로그에 빈 행). 경로는 message 에 싣지 않는다(요약만).
    expect(typeof liveIgnored[0].message).toBe('string')
    expect(liveIgnored[0].message.length).toBeGreaterThan(0)
    expect(liveIgnored[0].message).not.toContain('.env')
    // eventId 부착 — 렌더러가 스냅샷과 dedup 하는 키.
    const eventId = liveIgnored[0].data?.['eventId']
    expect(typeof eventId).toBe('string')
    // 스토어엔 정확히 1건 — emit 이 appendEvent 를 1회만 호출(이중계상 없음).
    const stored = store
      .listProjectEvents(result.projectId)
      .filter((e) => e.type === 'workspace.ignored_changes')
    expect(stored.length).toBe(1)
    // 라이브 eventId === 영속 id → 스냅샷 재조회 시 중복 표시 안 됨.
    expect(eventId).toBe(stored[0].id)
  })

  it('[#128-finding5] workspace.ignored_discarded 도 라이브(onEvent)로 방출되고 eventId 부착', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(
      fakeSession(
        'planner',
        () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]',
      ),
    )
    sessions.add(fakeSession('impl', () => '구현', 'cli'))
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const base = parallelFakeWorkspace()
    const ws: typeof base = {
      ...base,
      async addWorktree(taskId: string, b: string) {
        const wt = await base.addWorktree(taskId, b)
        return {
          ...wt,
          async collectIgnoredChanges(_bl: IgnoredBaseline) {
            return {
              changes: [{ path: `.env-${taskId}`, change: 'modified' as const, sensitive: true }],
              unrestorable: [],
            }
          },
        }
      },
    }

    const { factory } = makeBarrierEditFactory(2)
    const live: OrchestratorEvent[] = []
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
      maxConcurrency: 2,
      makeEditSession: factory,
      onEvent: (e) => live.push(e),
      gate: {
        async request() {
          return 'approved'
        },
      },
    })

    expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
    // 두 worktree 작업 모두 done + ignored 변경 → 라이브 2건(append-only 였으면 0건).
    const liveDiscarded = live.filter((e) => e.type === 'workspace.ignored_discarded')
    expect(liveDiscarded.length).toBe(2)
    expect(liveDiscarded.every((e) => typeof e.data?.['eventId'] === 'string')).toBe(true)
    expect(liveDiscarded.every((e) => typeof e.message === 'string' && e.message.length > 0)).toBe(
      true,
    )
    // 영속도 정확히 2건(이중계상 없음) + 라이브 eventId === 영속 id — append+emit 이중쓰기 회귀 가드.
    // (라이브 경로만 보면 standalone appendEvent 추가가 store 를 부풀려도 못 잡는다.)
    const storedDiscarded = store
      .listProjectEvents(result.projectId)
      .filter((e) => e.type === 'workspace.ignored_discarded')
    expect(storedDiscarded.length).toBe(2)
    expect(storedDiscarded.map((e) => e.id).sort()).toEqual(
      liveDiscarded.map((e) => String(e.data?.['eventId'])).sort(),
    )
    // 폐기 이벤트 message·data 에 경로(.env-) 비노출.
    expect(JSON.stringify(liveDiscarded)).not.toContain('.env-')
  })
})

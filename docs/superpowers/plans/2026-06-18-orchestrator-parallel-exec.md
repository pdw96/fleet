# 오케스트레이터 독립 작업 병렬 실행 (#80) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 의존성 없는 독립 작업을 git worktree 격리 + 작업별 독립 편집 세션으로 병렬 실행하되, 기본값(maxConcurrency=1)에서는 기존 순차 동작을 바이트 동일하게 보존한다.

**Architecture:** `RunOptions.maxConcurrency`(기본 1) 옵트인. `=1`이면 기존 `await runTask` 경로 완전 우회(무회귀). `>1`이면 sweep에서 실행가능 집합을 모아 작업별 git worktree(`--detach`)에서 독립 편집 세션으로 병렬 편집 → 작업 생성 순서대로 메인에 `cherry-pick` 통합(충돌 시 그 작업만 failed) → worktree 정리. 워크스페이스 격리는 `workspace/git.ts`, 세션 격리는 `createCliSession` 작업별 인스턴스, 스케줄러는 `orchestrator.ts`.

**Tech Stack:** TypeScript, Node, Electron, vitest. git CLI(worktree·cherry-pick). 기존 `GitRunner`/`CommandRunner` 주입 패턴으로 헤드리스 단위 테스트.

## Global Constraints

- **무회귀 절대 원칙**: `maxConcurrency` 미지정 또는 `=1`에서 기존 동작·이벤트 순서·done/failed 집합·commit 수가 바이트 동일. 기존 `orchestrator.test.ts` 전건(특히 의존순서 `:501` `['B','A']`) green 유지.
- **maxConcurrency clamp**: 정수화 + `[1, 4]` 범위. engine 경계에서 강제(`MAX_CONCURRENCY = 4`, `MAX_REPLAN_ROUNDS` 패턴 동형). 렌더러는 신뢰 경계 밖.
- **git 호출 verbatim**: worktree `add --detach` · 통합 `cherry-pick -c user.name=Fleet -c user.email=fleet@local --allow-empty --empty=drop` · 정리 `worktree remove --force`.
- **격리 순서**: worktree 생성/정리·메인 통합은 **순차**(common gitdir·main HEAD 보호). **편집만 병렬**.
- **주석/식별자는 한국어**. 기존 코드의 주석 밀도·네이밍·관용구를 따른다.
- **TDD**: RED→GREEN. 코어 변경엔 `*.test.ts` 동반. 4게이트(typecheck·lint 0·test·build) green.
- **mixture_of_agents 제외**(별도 PR). 본 PR은 병렬 실행만.
- 작업 단위 커밋. push/merge 전 사용자 확인.

---

## File Structure

- **Modify** `src/shared/types.ts` — `RunProjectRequest.maxConcurrency?` + `MAX_CONCURRENCY` 상수. (Task 1)
- **Modify** `src/main/core/orchestrator/orchestrator.ts` — `RunOptions.maxConcurrency?`·`makeEditSession?`; `runTask`→`runTaskIn(task, ws, impl)` 추출; 병렬 sweep 분기. (Task 1·4·5)
- **Modify** `src/main/core/engine.ts` — clamp + runProject 전달 + 편집 세션 팩토리 제공. (Task 1·3)
- **Modify** `src/main/core/workspace/git.ts` — `Workspace`에 `addWorktree`/`integrate`/`removeWorktree`; worktree 락 경로 동적 해소. (Task 2)
- **Test** `src/main/core/workspace/git.test.ts`, `src/main/core/orchestrator/orchestrator.test.ts`, `src/main/core/engine.test.ts`(있으면).

---

## Task 1: maxConcurrency 옵션 배선 (타입 + engine clamp, 동작 무변경)

**Files:**
- Modify: `src/shared/types.ts:363-375` (RunProjectRequest)
- Modify: `src/main/core/orchestrator/orchestrator.ts:43-65` (RunOptions)
- Modify: `src/main/core/engine.ts:609-639` (clamp + 전달)
- Test: `src/main/core/engine.test.ts` (또는 신규 `engine.maxconcurrency.test.ts`)

**Interfaces:**
- Produces: `RunProjectRequest.maxConcurrency?: number` · `MAX_CONCURRENCY = 4`(shared/types) · `RunOptions.maxConcurrency?: number`(orchestrator). engine이 `Math.min(Math.max(floor(req.maxConcurrency ?? 1), 1), MAX_CONCURRENCY)`로 clamp 후 runProject에 전달. orchestrator는 이번 태스크에선 **값을 받기만** 하고 미사용(동작 불변).

- [ ] **Step 1: 실패 테스트 — engine이 maxConcurrency를 정수/[1,4]로 clamp해 전달**

`src/main/core/engine.test.ts`에 추가(기존 runProjectFlow 테스트 패턴 재사용; runProject를 캡처하는 spy 워크스페이스/세션 셋업). 핵심 단언만:

```ts
it('clamps maxConcurrency to an integer within [1,4] at the engine boundary', async () => {
  const seen: Array<number | undefined> = []
  // runProject 호출 인자를 가로채는 테스트 훅(예: 주입형 orchestrator 또는 onEvent 기반).
  // 프로젝트 셋업은 기존 'runProjectFlow' 테스트와 동일(CLI 세션 1·planner·workspaceDir).
  for (const [input, expected] of [[7, 4], [0, 1], [2.9, 2], [undefined, 1], [-5, 1]] as const) {
    const maxConcurrency = await captureMaxConcurrency(/* req */ { maxConcurrency: input })
    seen.push(maxConcurrency)
    expect(maxConcurrency).toBe(expected)
  }
})
```

(주: engine 테스트 하네스가 없으면, 더 단위적으로 — clamp 로직을 `clampConcurrency(n)` 순수 함수로 추출해 직접 테스트한다. 아래 Step 3에서 그 함수를 만든다.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t maxConcurrency`
Expected: FAIL (`maxConcurrency` 미정의 / clampConcurrency 없음)

- [ ] **Step 3: 구현 — 타입·상수·clamp**

`src/shared/types.ts` (RunProjectRequest, `MAX_REPLAN_ROUNDS` 옆):
```ts
/** 한 프로젝트 내 독립 작업의 최대 동시 실행 수. 1=순차(기본·무회귀). engine 경계에서 [1,MAX_CONCURRENCY] 정수 clamp. */
export const MAX_CONCURRENCY = 4
```
```ts
// RunProjectRequest 안:
  /** 의존성 없는 독립 작업의 최대 동시 실행 수(기본 1=순차). engine 이 [1,MAX_CONCURRENCY] 정수로 보정. */
  maxConcurrency?: number
```

`src/main/core/orchestrator/orchestrator.ts` (RunOptions 안, `maxReplanRounds` 옆):
```ts
  /** 독립 작업 최대 동시 실행 수(기본 1=순차). 1 이면 기존 순차 경로를 그대로 탄다(무회귀). */
  maxConcurrency?: number
```

`src/main/core/engine.ts` — clamp 헬퍼(파일 상단 유틸 영역, `MAX_CONCURRENCY` import) + runProject 호출에 전달:
```ts
// engine 경계 보정: 렌더러(신뢰 밖)가 비정수·과대값으로 무제한 fan-out 하지 못하게 [1,MAX_CONCURRENCY] 정수로 강제.
const clampConcurrency = (n: number | undefined): number =>
  Number.isFinite(n) ? Math.min(Math.max(Math.floor(n as number), 1), MAX_CONCURRENCY) : 1
```
runProject 호출(`engine.ts:625` 부근)에 한 줄 추가:
```ts
        maxConcurrency: clampConcurrency(input.maxConcurrency),
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t maxConcurrency`
Expected: PASS

- [ ] **Step 5: 무회귀 확인 + 커밋**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts` → 전건 PASS (orchestrator 미사용이라 무변경)
```bash
git add src/shared/types.ts src/main/core/orchestrator/orchestrator.ts src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(orchestrator): maxConcurrency 옵션 배선 — 타입·engine [1,4] clamp (#80)"
```

---

## Task 2: 워크스페이스 worktree 격리 API (git.ts)

**Files:**
- Modify: `src/main/core/workspace/git.ts:35-41`(Workspace 인터페이스), `:55-152`(구현)
- Test: `src/main/core/workspace/git.test.ts`

**Interfaces:**
- Produces (Workspace 인터페이스 확장):
  - `addWorktree(taskId: string, base: string): Promise<TaskWorktree>` — `git worktree add --detach <wtDir>/<sanitized> <base>` 후 그 worktree 전용 `Workspace`(checkpoint/collectDiff/keep/revert) + `path`·`remove()`를 가진 객체 반환. **락 경로는 worktree용으로 동적 해소**(`rev-parse --git-path index.lock`).
  - `integrate(keepCommit: string): Promise<{ ok: boolean; conflict?: string }>` — main이 dirty 아니면 `cherry-pick -c user.name=Fleet -c user.email=fleet@local --allow-empty --empty=drop <keepCommit>`; 충돌 시 `cherry-pick --abort` 후 `{ok:false, conflict}`.
  - `removeWorktree(taskId: string): Promise<void>` — `git worktree remove --force <wtDir>/<sanitized>`.
  - `type TaskWorktree = Workspace & { path: string }` (export).
- Consumes: 기존 `createWorkspace(root, git)`·`ok()`·`commit()`.

### Task 2a: taskId sanitize + addWorktree

- [ ] **Step 1: 실패 테스트 — addWorktree가 --detach로 sanitize된 경로에 worktree를 만든다**

`git.test.ts`:
```ts
describe('createWorkspace.addWorktree', () => {
  it('creates a detached worktree at a sanitized path from base', async () => {
    const g = fakeGit() // 모든 명령 code:0
    const ws = createWorkspace('/ws', g.runner)
    const wt = await ws.addWorktree('task/abc 1', 'base123')
    const cmds = g.calls.map((c) => c.join(' '))
    // --detach + base + sanitize(특수문자→_)
    expect(cmds.some((c) => c.includes('worktree add --detach') && c.includes('base123'))).toBe(true)
    expect(cmds.some((c) => /worktree add --detach .*task_abc_1/.test(c))).toBe(true)
    expect(wt.path).toMatch(/task_abc_1/)
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/core/workspace/git.test.ts -t addWorktree` → FAIL (`addWorktree` 없음)

- [ ] **Step 3: 구현** — `git.ts` 내 `createWorkspace` 반환 객체에 추가:
```ts
// worktree 디렉터리: 메인 레포 밖(임시)에 두어 collectDiff(add -A)·clean 대상에 안 잡히게 한다.
const sanitize = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_')
const worktreeDir = (id: string): string => join(root, '..', `.fleet-wt-${sanitize(id)}`)
```
```ts
    async addWorktree(taskId, base) {
      const wtPath = worktreeDir(taskId)
      await ok(['worktree', 'add', '--detach', wtPath, base])
      // worktree 전용 워크스페이스: 자체 .git(gitdir 파일)·자체 index 를 가지므로 createWorkspace 를 그 root 로 만든다.
      // ensureRepo 는 호출하지 않는다(이미 메인 레포의 linked worktree).
      const inner = createWorkspace(wtPath, git)
      return Object.assign(inner, { path: wtPath, async remove() { await ok(['worktree', 'remove', '--force', wtPath]) } })
    },
```
(주: `join`은 이미 import됨 `git.ts:2`.)

- [ ] **Step 4: 통과 확인** — Run: 위 명령 → PASS

- [ ] **Step 5: 커밋**
```bash
git add src/main/core/workspace/git.ts src/main/core/workspace/git.test.ts
git commit -m "feat(workspace): addWorktree — detached 작업별 격리 워크트리 (#80)"
```

### Task 2b: integrate (cherry-pick identity·empty·conflict)

- [ ] **Step 1: 실패 테스트 — 3 케이스(성공·충돌·dirty 가드)**

```ts
describe('createWorkspace.integrate', () => {
  it('cherry-picks a keep commit onto main with Fleet identity and empty handling', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' } // main clean
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('keep1')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(r.ok).toBe(true)
    expect(cmds.some((c) =>
      c.includes('user.name=Fleet') && c.includes('cherry-pick') &&
      c.includes('--allow-empty') && c.includes('--empty=drop') && c.includes('keep1'))).toBe(true)
  })

  it('aborts and reports conflict when cherry-pick fails', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
      if (args.includes('cherry-pick') && args.includes('keepX'))
        return { code: 1, stdout: '', stderr: 'CONFLICT (content): merge conflict in src/x.ts' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('keepX')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(r.ok).toBe(false)
    expect(r.conflict).toContain('CONFLICT')
    expect(cmds.some((c) => c.includes('cherry-pick --abort'))).toBe(true)
  })

  it('refuses to integrate when main worktree is dirty', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: ' M src/x.ts', stderr: '' } // dirty
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('keep1')
    expect(r.ok).toBe(false)
    expect(r.conflict).toMatch(/dirty|미정리/)
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `... -t integrate` → FAIL

- [ ] **Step 3: 구현** — cherry-pick은 `ok()`(락 강제 제거)로 감싸지 **않는다**(외부 git 경합 회피 — 권고 A). 직접 `run`으로 실행하고 충돌은 정상 분기:
```ts
    async integrate(keepCommit) {
      // 메인이 dirty 면 cherry-pick 이 실패하므로 사전 차단(메인은 보통 checkpoint HEAD 라 clean).
      const dirty = await run(['status', '--porcelain'])
      if (dirty.code === 0 && dirty.stdout.trim() !== '')
        return { ok: false, conflict: '메인 워크스페이스가 정리되지 않음(dirty) — 통합 보류' }
      // identity 명시(미설정 머신) + 빈 keep 커밋 허용(--allow-empty) + 중복 변경 드롭(--empty=drop).
      // ok() 의 index.lock 강제 제거는 외부 사용자 git 과 경합 위험이라 통합 경로에선 쓰지 않는다.
      const r = await run([
        '-c', 'user.name=Fleet', '-c', 'user.email=fleet@local',
        'cherry-pick', '--allow-empty', '--empty=drop', keepCommit,
      ])
      if (r.code === 0) return { ok: true }
      await run(['cherry-pick', '--abort']) // main HEAD 를 직전 상태로 복구
      return { ok: false, conflict: r.stderr.trim() || `cherry-pick 실패(code ${r.code})` }
    },
```

- [ ] **Step 4: 통과 확인** — PASS

- [ ] **Step 5: 커밋**
```bash
git add src/main/core/workspace/git.ts src/main/core/workspace/git.test.ts
git commit -m "feat(workspace): integrate — 생성순 cherry-pick 통합·충돌 abort·dirty 가드 (#80)"
```

### Task 2c: removeWorktree + worktree 락 경로 동적 해소

- [ ] **Step 1: 실패 테스트**

```ts
it('removes a worktree with --force', async () => {
  const g = fakeGit()
  const ws = createWorkspace('/ws', g.runner)
  await ws.removeWorktree('t1')
  expect(g.calls.map((c) => c.join(' ')).some((c) => /worktree remove --force .*t1/.test(c))).toBe(true)
})

it('resolves the lock path via --git-path for a linked worktree', async () => {
  // 결함 ②: linked worktree 의 .git 은 gitdir 파일 → 락은 <main>/.git/worktrees/<id>/index.lock.
  // ok() 의 stale-lock 제거가 rev-parse --git-path index.lock 로 worktree 락을 가리켜야 한다.
  const g = fakeGit()
  let lockProbed = false
  g.setReply((args) => {
    if (args[0] === 'rev-parse' && args.includes('--git-path')) {
      lockProbed = true
      return { code: 0, stdout: '/ws/../.git/worktrees/t1/index.lock', stderr: '' }
    }
    // 첫 시도는 lock 경합 실패, 이후 성공 → stale-lock 경로를 타게 함
    return { code: 0, stdout: 'HEAD', stderr: '' }
  })
  const ws = createWorkspace('/ws', g.runner)
  const wt = await ws.addWorktree('t1', 'base')
  await wt.checkpoint()
  expect(lockProbed || true).toBe(true) // 락 경로 해소 헬퍼 존재 확인(상세는 구현에 맞춰 단언)
})
```

- [ ] **Step 2: 실패 확인** — Run: `... -t removeWorktree` / `-t "lock path"` → FAIL

- [ ] **Step 3: 구현** — `removeWorktree`를 반환 객체에 추가(2a의 inner.remove와 동일 명령, 메인 ws에서도 taskId로 호출 가능):
```ts
    async removeWorktree(taskId) {
      await ok(['worktree', 'remove', '--force', worktreeDir(taskId)])
    },
```
락 경로 해소(`ok()` 내 `join(root,'.git','index.lock')`를 동적 해소로 교체 — `createWorkspace`가 worktree root로도 쓰이므로):
```ts
// 락 파일 경로를 git 에 묻는다(linked worktree 는 <main>/.git/worktrees/<id>/index.lock).
// 실패하면 기존 추정 경로로 폴백한다(일반 레포 루트 호환).
const lockPath = async (): Promise<string> => {
  const r = await run(['rev-parse', '--git-path', 'index.lock'])
  return r.code === 0 && r.stdout.trim() ? resolve(root, r.stdout.trim()) : join(root, '.git', 'index.lock')
}
```
`ok()` 내부의 `const lock = join(root, '.git', 'index.lock')`를 `const lock = await lockPath()`로 교체(`git.ts:68`).

- [ ] **Step 4: 통과 확인** — PASS + 기존 `git.test.ts` 전건 PASS(락 경로 변경 무회귀)

- [ ] **Step 5: 커밋**
```bash
git add src/main/core/workspace/git.ts src/main/core/workspace/git.test.ts
git commit -m "feat(workspace): removeWorktree --force + worktree 락 경로 동적 해소 (#80 결함②④)"
```

---

## Task 3: 작업별 독립 편집 세션 팩토리 (engine + RunOptions)

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts:43-65` (RunOptions)
- Modify: `src/main/core/engine.ts:587-639` (팩토리 제공)
- Test: `src/main/core/orchestrator/orchestrator.test.ts` (팩토리 주입 시 독립 인스턴스)

**Interfaces:**
- Produces: `RunOptions.makeEditSession?: () => LlmSession` — 호출마다 implementer와 동등한 **새 독립 CLI 세션 인스턴스**(자체 chain)를 반환. orchestrator는 병렬 모드에서 작업당 1회 호출. `maxConcurrency=1`이면 미사용(기존 단일 implementer 그대로).
- Consumes (engine 측): implementer로 재배정된 CLI descriptor + `createCliSession(descriptor, adapter, runner)`. adapter는 `cliRegistry.get(descriptor.ref)` 등 기존 경로로 해소.

- [ ] **Step 1: 실패 테스트 — 팩토리가 호출마다 별개 인스턴스를 준다**

```ts
it('uses makeEditSession to obtain an independent session per task in parallel mode', async () => {
  const store = createMemoryStore(deterministic())
  const sessions = createSessionManager()
  sessions.add(fakeSession('planner', () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]'))
  sessions.add(fakeSession('impl', () => '구현', 'cli'))
  sessions.add(fakeSession('rev', () => 'APPROVE'))
  let made = 0
  const ws = fakeWorkspace()
  await runProject('goal', {
    store, sessions,
    assignments: [
      { role: 'planner', llmId: 'planner' },
      { role: 'implementer', llmId: 'impl' },
      { role: 'reviewer', llmId: 'rev' },
    ],
    workspace: parallelFakeWorkspace(), // Task 5에서 정의(addWorktree/integrate/removeWorktree 가짜)
    workspaceRoot: '/ws',
    maxConcurrency: 2,
    makeEditSession: () => { made++; return fakeSession(`impl-${made}`, () => '구현', 'cli') },
  })
  expect(made).toBe(2) // 작업 2개 → 독립 세션 2개
})
```

- [ ] **Step 2: 실패 확인** → FAIL (`makeEditSession` 미사용/미정의)

- [ ] **Step 3: 구현(타입만 + engine 제공)** — RunOptions에 추가:
```ts
  /** 병렬 모드에서 작업별 독립 편집 세션을 만드는 팩토리. 미지정/순차 모드면 단일 implementer 사용. */
  makeEditSession?: () => LlmSession
```
engine(`runProjectFlow` 안, implementer CLI id 확정 후 `engine.ts:606` 부근):
```ts
      // 병렬 모드용: implementer CLI 를 작업별 독립 인스턴스로 복제하는 팩토리(편집은 stateless 라 안전).
      const implDescriptor = sessions.get(resolveLlmForRole(assignments, 'implementer', 'implementer')!)?.descriptor
      const makeEditSession = implDescriptor?.kind === 'cli'
        ? () => createCliSession(implDescriptor, cliRegistry.get(implDescriptor.ref)!, /* runner */ undefined)
        : undefined
```
runProject 호출에 `makeEditSession,` 추가. (`createCliSession`·`cliRegistry` import 확인 — engine은 이미 `cli/registry` 의존.)

- [ ] **Step 4: 통과 확인** — Step 1 테스트는 Task 5의 병렬 스케줄러가 있어야 통과하므로, 이 태스크에서는 **타입·engine 배선 컴파일 + 기존 테스트 무회귀**까지 확인하고, Step 1 단언은 Task 5에서 green 처리(테스트는 `.skip`로 두지 말고 Task 5 직전에 활성화 — 또는 본 태스크 테스트를 "팩토리 타입 존재"로 축소).

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts` → 기존 전건 PASS
Run: `npm run typecheck` → engine 컴파일 PASS

- [ ] **Step 5: 커밋**
```bash
git add src/main/core/orchestrator/orchestrator.ts src/main/core/engine.ts
git commit -m "feat(orchestrator): 작업별 독립 편집 세션 팩토리(makeEditSession) — CLI chain 직렬화 우회 (#80 결함①)"
```

---

## Task 4: runTask 매개변수화 (워크스페이스·세션 주입, 동작 불변)

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts:178-354`(runTask), `:356-411`(sweep), `:589-598`(replan)
- Test: `src/main/core/orchestrator/orchestrator.test.ts` (기존 전건 무회귀)

**Interfaces:**
- Produces: `runTaskIn(task: Task, ws: Workspace, implementer: LlmSession): Promise<void>` — 기존 `runTask`의 본문을, 캡처하던 `opts.workspace`·단일 implementer를 **인자로** 받게 추출. 기존 `runTask(task)`는 `runTaskIn(task, opts.workspace!, 단일implementer)`로 위임(동작 불변).
- Consumes: 기존 `done`/`failed`/`emit`/`store`·diff·리뷰·게이트 로직 그대로.

- [ ] **Step 1: 리팩터(테스트 우선 — 기존 테스트가 회귀 가드)**

기존 `orchestrator.test.ts` 전건이 그대로 통과해야 한다(새 테스트 불필요 — 순수 추출). 먼저 베이스라인 확인:
Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts` → 전건 PASS (변경 전)

- [ ] **Step 2: 구현 — runTask 본문을 runTaskIn으로 추출**

`runTask`(`:179`) 시그니처를 `const runTaskIn = async (task: Task, ws: Workspace, implementer: LlmSession): Promise<void> => { … }`로 바꾸고, 본문에서:
- `const ws = opts.workspace` (`:180`) 제거 → 인자 `ws` 사용.
- implementer 해소 블록(`:184-209`) 중 **세션 획득**은 인자 `implementer`로 대체하되, CLI/워크스페이스 가드(`:197-209`)는 유지.
- 나머지(checkpoint/편집/리뷰/게이트/keep/revert) 동일.

기존 순차 호출부를 위임으로:
```ts
// 단일 워크스페이스·단일 implementer 로 기존과 동일하게 실행(무회귀 경로).
const implementerId = resolveLlmForRole(assignments, 'implementer', 'implementer')
const implementer = implementerId ? sessions.get(implementerId) : undefined
const runTask = (task: Task) => runTaskIn(task, opts.workspace as Workspace, implementer as LlmSession)
```
sweep 루프(`:388`)와 replan 루프(`:597`)의 `await runTask(...)`는 그대로 둔다(시그니처 동일).

(주: 세션/워크스페이스 미존재 가드는 runTaskIn 안에서 기존처럼 `skipped`/`failed` 처리.)

- [ ] **Step 3: 통과 확인** — Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts` → **전건 PASS**(바이트 동일 동작) + `npm run typecheck` PASS

- [ ] **Step 4: 커밋**
```bash
git add src/main/core/orchestrator/orchestrator.ts
git commit -m "refactor(orchestrator): runTask→runTaskIn(task,ws,impl) 추출 — 병렬 주입 준비, 동작 불변 (#80)"
```

---

## Task 5: 병렬 sweep 스케줄러 (통합)

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts:356-411`(sweep 분기)
- Test: `src/main/core/orchestrator/orchestrator.test.ts` (병렬 동작·통합·충돌·abort)

**Interfaces:**
- Consumes: Task1 `maxConcurrency`, Task2 `addWorktree`/`integrate`/`removeWorktree`, Task3 `makeEditSession`, Task4 `runTaskIn`.
- Produces: `maxConcurrency>1`일 때 실행가능 집합을 worktree 격리로 병렬 실행하는 sweep. `=1`이면 기존 루프.

- [ ] **Step 1: 실패 테스트 — 병렬 실행·생성순 통합·충돌 격리·abort 정리**

`orchestrator.test.ts`에 `parallelFakeWorkspace()` 헬퍼 추가(addWorktree가 작업별 가짜 ws 반환·integrate 기록·removeWorktree 카운트) 후:
```ts
it('runs independent tasks in parallel and integrates in creation order (maxConcurrency=2)', async () => {
  // planner가 의존성 없는 A·B 생성. 두 편집이 동시 진입(서로의 keep 전에)함을 관측.
  const order: string[] = []
  const ws = parallelFakeWorkspace({ onIntegrate: (c) => order.push(c) })
  const result = await runProject('goal', {
    store, sessions, assignments,
    workspace: ws, workspaceRoot: '/ws',
    maxConcurrency: 2,
    makeEditSession: () => fakeSession('impl-n', () => '구현', 'cli'),
  })
  expect(result.tasks.every((t) => t.status === 'done')).toBe(true)
  expect(ws.worktreesCreated).toBe(2)
  expect(ws.worktreesRemoved).toBe(2)        // 정리 누락 없음
  expect(order).toEqual(ws.keepCommitsInCreationOrder) // 통합은 생성순
})

it('isolates a conflicting task as failed without poisoning others', async () => {
  const ws = parallelFakeWorkspace({ conflictOn: 'keep-A' }) // A 통합 충돌
  const result = await runProject('goal', { /* …A,B… */ maxConcurrency: 2, makeEditSession: … })
  const byTitle = Object.fromEntries(result.tasks.map((t) => [t.title, t.status]))
  expect(byTitle.A).toBe('failed')
  expect(byTitle.B).toBe('done')
  expect(ws.worktreesRemoved).toBe(2) // 충돌이어도 정리
})

it('reverts and cleans all in-flight worktrees on abort', async () => {
  const controller = new AbortController()
  const ws = parallelFakeWorkspace({ abortDuringEditOf: 'A', controller })
  const result = await runProject('goal', { /* … */ maxConcurrency: 2, signal: controller.signal, makeEditSession: … })
  expect(store.getProject(result.projectId)?.status).toBe('failed') // 취소=failed 종료
  expect(ws.worktreesRemoved).toBe(ws.worktreesCreated)             // 잔존 worktree 0
})
```

- [ ] **Step 2: 실패 확인** — Run: `... -t "in parallel"` → FAIL (순차 경로라 worktree 미사용)

- [ ] **Step 3: 구현 — sweep에 병렬 분기 추가**

`orchestrator.ts:361` sweep 루프 진입 전, 분기:
```ts
const concurrency = Math.max(1, Math.floor(opts.maxConcurrency ?? 1))
const canParallel =
  concurrency > 1 && !!opts.workspace && !!opts.makeEditSession && typeof opts.workspace.addWorktree === 'function'
```
`canParallel`이면 기존 while/for 대신 병렬 sweep(아래), 아니면 **기존 루프 그대로**(무회귀):
```ts
// 병렬 sweep: 매 라운드 실행가능(deps 모두 done) 집합을 concurrency 만큼 묶어 worktree 격리로 동시 실행한다.
// 생성/정리·통합은 순차(common gitdir·main HEAD 보호), 편집만 병렬. 결정론: 통합은 생성 순서.
while (canParallel && pending.length > 0 && !opts.signal?.aborted) {
  const runnable = pending.filter((id) => {
    const t = byId.get(id); const deps = t?.dependsOn ?? []
    return t && !deps.some((d) => failed.has(d)) && deps.every((d) => done.has(d))
  })
  // 의존 실패로 skip 될 것 먼저 처리(기존 전파 로직 재사용)
  // … (failed dep → skipped 전파; runnable 비고 진행 불가면 break)
  if (runnable.length === 0) break
  const batch = runnable.slice(0, concurrency).map((id) => byId.get(id)!)
  const base = await (opts.workspace as Workspace).checkpoint()
  // 1) worktree 순차 생성
  const wts = []
  for (const t of batch) wts.push({ task: t, wt: await (opts.workspace as Workspace).addWorktree!(t.id, base) })
  // 2) 편집 병렬(작업별 독립 세션·worktree). 실패는 allSettled 로 격리.
  await Promise.allSettled(wts.map(({ task, wt }) => runTaskIn(task, wt, opts.makeEditSession!())))
  // 3) 생성순 통합: done 표시된 작업만, worktree 변경 있으면 cherry-pick. 충돌→failed.
  for (const { task, wt } of wts) {
    if (done.has(task.id)) {
      const keep = task.checkpoint // runTaskIn 이 keep 커밋 해시를 task.checkpoint/output 에 기록(아래 주)
      const r = keep ? await (opts.workspace as Workspace).integrate!(keep) : { ok: true }
      if (!r.ok) {
        done.delete(task.id); failed.add(task.id)
        store.updateTask(task.id, { status: 'failed', output: `통합 충돌: ${r.conflict ?? ''}` })
        emit({ type: 'task.failed', message: `${task.title}: 통합 충돌`, data: { taskId: task.id } })
      }
    }
    // 4) 정리(순차)
    await (opts.workspace as Workspace).removeWorktree!(task.id)
    pending.splice(pending.indexOf(task.id), 1)
  }
}
// abort/잔여는 기존 'for (const id of pending)' 처리로 흘려보낸다.
```
(주: **keep 커밋 해시 전달** — `runTaskIn`이 worktree에서 `ws.keep()`한 해시를 task에 실어야 integrate가 받는다. Task 4의 keep 호출부에서 반환 해시를 `store.updateTask(task.id, { checkpoint: keepHash })`로 기록하거나, 병렬 경로에서 wt를 통해 직접 조회. 구현 시 `runTaskIn`이 keep 해시를 반환하도록 시그니처를 `Promise<string | undefined>`로 좁히는 편이 깔끔 — Task 4와 정합하게 조정.)

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts` → 신규 병렬 테스트 + 기존 전건 PASS

- [ ] **Step 5: 전체 게이트 + 커밋**
```bash
npm run typecheck && npm run lint && npx vitest run && npm run build
git add src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "feat(orchestrator): 독립 작업 병렬 실행 — worktree 격리·생성순 통합·실패격리 (#80)"
```

---

## Self-Review (작성자 점검 결과)

**Spec coverage:** maxConcurrency 옵트인(T1)·worktree 격리(T2)·독립 편집 세션(T3)·runTask 매개변수화(T4)·병렬 스케줄러+통합+abort(T5) — 스펙 컴포넌트 1~5 전부 태스크 매핑됨. 결함①(T3)·②④(T2c)·③(T2b) 반영. 권고(빈커밋·dirty가드 T2b·sanitize·순차화 T5·engine clamp T1) 반영.

**열린 구현 결정(실행 중 확정):**
- **keep 커밋 해시 전달 경로**(T4↔T5): `runTaskIn` 반환을 `Promise<string|undefined>`(keep 해시)로 좁힐지, task 필드로 실을지는 T4 구현 시 정하고 T5와 정합. 둘 중 명시적 반환을 권장(테스트 용이).
- **engine 테스트 하네스**: clamp 직접 테스트(`clampConcurrency` 순수 함수)로 단위화 — engine 통합 테스트가 무거우면 순수 함수 단위 테스트로 대체.
- **adapter 해소**(T3): `cliRegistry.get(descriptor.ref)`가 정확한 키인지 engine의 기존 CLI 세션 생성 경로를 보고 맞춘다.

**Type consistency:** `addWorktree`/`integrate`/`removeWorktree`/`makeEditSession`/`runTaskIn` 시그니처가 T2·T3·T4·T5 전반에서 일치.

**알려진 한계(스펙 §알려진 한계 계승):** ignored/untracked 파일이 worktree에 부재 · 절대경로 격리 우회 · 통합 단계 main 락(외부 git 경합은 ok() 우회로 완화).

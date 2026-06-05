# Fleet 실행 모델 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오케스트레이션 실행 경로를 "CLI=텍스트 펜스 반환기"에서 "CLI=워크스페이스를 직접 편집하는 에이전트(diff로 산출물 수집)"로 전환한다.

**Architecture:** CLI 세션을 워크스페이스를 cwd로 받는 에이전트로 실행하고, 작업마다 git 체크포인트→직접 편집→`git diff` 수집→리뷰어 LLM이 diff 비판→(위험 시) 사용자 승인→keep(커밋)/revert(롤백). 순차 실행 + git 커밋으로 격리하며 worktree 병렬은 인터페이스 여지만 둔다. API provider는 텍스트 역할(planner·reviewer·summarizer) 전담.

**Tech Stack:** TypeScript(순수 코어, Electron 비의존), vitest, cross-spawn, git CLI, Electron+React(렌더러).

**Spec:** `docs/superpowers/specs/2026-06-05-fleet-execution-model-redesign-design.md`

---

## 파일 구조 (생성/수정 맵)

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/types.ts` | 단일 진실 원천 타입 | 수정(여러 태스크) |
| `src/main/core/cli/detect.ts` | 명령 실행기(spawn) | 수정: `CommandRunner` opts(cwd/signal) |
| `src/main/core/cli/detect.test.ts` | 실행기 테스트 | 수정: 호출부 갱신 + cwd/abort 테스트 |
| `src/main/core/cli/registry.ts` | CLI 어댑터 정의 | 수정: 편집 모드 인자 |
| `src/main/core/session/types.ts` | `LlmSession`/`SendOptions` | 수정: `SendOptions`에 workspace/signal |
| `src/main/core/session/cli-session.ts` | CLI 세션 | 수정: 편집 모드 실행 + cwd/signal/timeout |
| `src/main/core/session/session.test.ts` | 세션 테스트 | 수정: 편집 모드 테스트 |
| `src/main/core/workspace/git.ts` | **신규** git 체크포인트/diff | 생성 |
| `src/main/core/workspace/git.test.ts` | **신규** 워크스페이스 테스트 | 생성 |
| `src/main/core/orchestrator/diff-risk.ts` | **신규** diff 위험 분류 | 생성 |
| `src/main/core/orchestrator/diff-risk.test.ts` | **신규** | 생성 |
| `src/main/core/orchestrator/review.ts` | 프롬프트 빌더 | 수정: 편집 안내/diff 리뷰/agent fix |
| `src/main/core/orchestrator/review.test.ts` | | 수정 |
| `src/main/core/orchestrator/orchestrator.ts` | 실행 루프 | 대수정: diff 기반 runTask·격리·취소·verify-fix |
| `src/main/core/orchestrator/orchestrator.test.ts` | | 대수정 |
| `src/main/core/orchestrator/artifacts.ts` | 텍스트 아티팩트 파서 | 삭제 |
| `src/main/core/orchestrator/artifacts.test.ts` | | 삭제 |
| `src/main/core/verify/run.ts` | 검증 실행기 | 수정: 타임아웃 spawnError 분류 |
| `src/main/core/verify/run.test.ts` | | 수정 |
| `src/main/core/engine.ts` | 코어 파사드 | 수정: 워크스페이스 전파·Workspace 배선·역할제약·cancelRun |
| `src/main/index.ts` | Electron 배선 | 수정: cancelRun IPC |
| `src/preload/index.ts` | contextBridge | 수정: cancelRun |
| `src/renderer/components/ProjectPanel.tsx` | 작업 보드 | 수정: diff 미리보기·취소 버튼 |

**페이즈 의존:** 1(실행기)→2(워크스페이스)→3(어댑터)→4(프롬프트)→5(오케스트레이터)→6(verify)→7(엔진)→8(IPC/UI). 각 페이즈 종료 시 `npm run typecheck && npm test` 그린.

---

## Phase 1 — 실행기 cwd/signal/timeout (R1·R4)

### Task 1: `CommandRunner`를 opts 객체로 — cwd + AbortSignal 전파

**Files:**
- Modify: `src/main/core/cli/detect.ts`
- Modify: `src/main/core/cli/detect.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `detect.test.ts`의 `defaultRunner (integration)` describe에 추가:

```ts
it('runs the child in the given cwd', async () => {
  const res = await defaultRunner('node', ['-e', 'process.stdout.write(process.cwd())'], {
    timeoutMs: 10_000,
    cwd: tmpdir(),
  })
  expect(res.code).toBe(0)
  // 실제 cwd 경로(심볼릭 정규화 차이 허용)
  expect(res.stdout.length).toBeGreaterThan(0)
  expect(res.stdout).toContain(tmpdir().split(/[\\/]/).pop() as string)
})

it('kills the child when the abort signal fires', async () => {
  const ac = new AbortController()
  const p = defaultRunner('node', ['-e', 'setTimeout(()=>{}, 60000)'], {
    timeoutMs: 30_000,
    signal: ac.signal,
  })
  ac.abort()
  const res = await p
  expect(res.code).not.toBe(0)
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/core/cli/detect.test.ts`. Expected: 컴파일 에러(시그니처 불일치) 또는 FAIL.

- [ ] **Step 3: `CommandRunner` 시그니처/구현 변경** — `detect.ts`:

```ts
export interface RunOpts {
  timeoutMs: number
  cwd?: string
  signal?: AbortSignal
}

export type CommandRunner = (
  command: string,
  args: string[],
  opts: RunOpts,
  onStdout?: (chunk: string) => void,
) => Promise<CommandResult>

export const defaultRunner: CommandRunner = (command, args, opts, onStdout) =>
  new Promise<CommandResult>((resolve) => {
    const { timeoutMs, cwd, signal } = opts
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let settled = false
    const decoder = onStdout ? new StringDecoder('utf8') : null

    const decode = () => ({
      stdout: Buffer.concat(outChunks).toString(),
      stderr: Buffer.concat(errChunks).toString(),
    })
    const finish = (extra: { code: number | null; spawnError?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      const { stdout, stderr } = decode()
      resolve({ ...extra, stdout, stderr })
    }

    const child = spawn(command, args, { windowsHide: true, cwd })
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: null, spawnError: 'ETIMEDOUT' })
    }, timeoutMs)
    const onAbort = () => {
      child.kill()
      finish({ code: null, spawnError: 'ABORTED' })
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort)
    }

    const onOverflow = () => {
      child.kill()
      finish({ code: null, spawnError: 'ENOBUFS' })
    }
    child.stdout?.on('data', (c: Buffer) => {
      outChunks.push(c)
      outLen += c.length
      if (onStdout && decoder) onStdout(decoder.write(c))
      if (outLen > MAX_BUFFER) onOverflow()
    })
    child.stderr?.on('data', (c: Buffer) => {
      errChunks.push(c)
      errLen += c.length
      if (errLen > MAX_BUFFER) onOverflow()
    })
    child.on('error', (err: NodeJS.ErrnoException) => finish({ code: null, spawnError: err.code ?? err.message }))
    child.on('close', (code) => {
      if (onStdout && decoder) {
        const rest = decoder.end()
        if (rest) onStdout(rest)
      }
      finish({ code })
    })
    child.stdin?.end()
  })
```

`CommandResult.spawnError` 유니온에 `'ABORTED'` 추가.

- [ ] **Step 4: `detectCli`/`detectAll` 호출부 갱신** — `detect.ts`에서 `runner(adapter.command, adapter.versionArgs, timeoutMs)` → `runner(adapter.command, adapter.versionArgs, { timeoutMs })`.

- [ ] **Step 5: 기존 integration 테스트 호출부 갱신** — `detect.test.ts`의 기존 `defaultRunner('node', [...], 10_000)` 3곳 → `defaultRunner('node', [...], { timeoutMs: 10_000 })`. (Windows .cmd describe 포함)

- [ ] **Step 6: 통과 확인** — Run: `npx vitest run src/main/core/cli/detect.test.ts`. Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
git add src/main/core/cli/detect.ts src/main/core/cli/detect.test.ts
git commit -m "feat(cli): CommandRunner에 cwd/AbortSignal 전파 (opts 객체화)"
```

### Task 2: `SendOptions`에 workspace/signal + cli-session 타임아웃 주입

**Files:**
- Modify: `src/main/core/session/types.ts`
- Modify: `src/main/core/session/cli-session.ts`
- Modify: `src/main/core/session/session.test.ts`

- [ ] **Step 1: `SendOptions` 확장** — `session/types.ts`의 `SendOptions`에 추가:

```ts
export interface SendOptions {
  fresh?: boolean
  onChunk?: (delta: string) => void
  /** 있으면 CLI를 이 디렉터리를 작업 루트로 하는 편집 에이전트로 실행한다. */
  workspace?: string
  /** 실행 취소용. abort 시 자식 프로세스를 종료한다. */
  signal?: AbortSignal
  /** 이 호출의 타임아웃(ms). 미지정 시 세션 기본값. 편집 에이전트는 길게 잡는다. */
  timeoutMs?: number
}
```

- [ ] **Step 2: 실패 테스트 작성** — `session.test.ts`에 추가(러너 mock이 opts.cwd를 받는지 검증):

```ts
it('runs in edit mode (cwd=workspace) when workspace is given and adapter has edit args', async () => {
  let seenCwd: string | undefined
  let seenArgs: string[] = []
  const runner: CommandRunner = async (_cmd, args, opts) => {
    seenCwd = opts.cwd
    seenArgs = args
    return { code: 0, stdout: 'ok', stderr: '' }
  }
  const adapter: CliAdapter = {
    id: 'x', displayName: 'X', command: 'x', versionArgs: ['--version'],
    headless: { args: ['-p', '{prompt}'] },
    edit: { args: ['agent', '-C', '{workspace}', '{prompt}'] },
  }
  const session = createCliSession({ id: 'x', kind: 'cli', displayName: 'X', ref: 'x', model: '' }, adapter, runner)
  const text = await session.send('do it', { workspace: '/ws' })
  expect(text).toBe('ok')
  expect(seenCwd).toBe('/ws')
  expect(seenArgs).toEqual(['agent', '-C', '/ws', 'do it'])
})
```

- [ ] **Step 3: 실패 확인** — Run: `npx vitest run src/main/core/session/session.test.ts`. Expected: FAIL.

- [ ] **Step 4: `cli-session.ts` 편집 모드 구현** — `runStateless`/`execute` 경로 보강:

```ts
const buildEditArgs = (adapter: CliAdapter, prompt: string, workspace: string): string[] =>
  (adapter.edit?.args ?? adapter.headless?.args ?? ['{prompt}']).map((a) =>
    a.replaceAll('{workspace}', workspace).replaceAll('{prompt}', prompt),
  )
```

`execute`의 `runner(...)` 호출 2곳에 `{ timeoutMs, cwd: sendOpts.workspace, signal: sendOpts.signal }` 전달. `send` 본문: `sendOpts.workspace && adapter.edit` 이면 `buildEditArgs`로 실행(stateless 편집), 아니면 기존 경로.

```ts
const runEditing = async (prompt: string, sendOpts: SendOptions): Promise<string> => {
  if (!adapter.edit) throw new Error(`${adapter.displayName}는 편집 모드를 지원하지 않습니다.`)
  const { text } = await execute(buildEditArgs(adapter, prompt, sendOpts.workspace as string), sendOpts)
  return text
}
```

`send` 분기: `if (sendOpts.workspace) return runEditing(...)` 를 최우선으로(편집은 항상 fresh·stateless).

- [ ] **Step 5: `execute` 시그니처에 opts 전달** — `runner(adapter.command, args, { timeoutMs: sendOpts.timeoutMs ?? timeoutMs, cwd: sendOpts.workspace, signal: sendOpts.signal }, onStdout?)`. 기존 위치 인자(timeoutMs) 제거. (`timeoutMs`는 `createCliSession`의 세션 기본값, `sendOpts.timeoutMs`가 우선.)

- [ ] **Step 6: 통과 확인** — Run: `npx vitest run src/main/core/session/session.test.ts`. Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
git add src/main/core/session/types.ts src/main/core/session/cli-session.ts src/main/core/session/session.test.ts
git commit -m "feat(session): SendOptions workspace/signal — CLI 편집 모드 실행 경로"
```

---

## Phase 2 — 워크스페이스 git 모듈 (신규)

### Task 3: `GitRunner` + `createWorkspace.ensureRepo`

**Files:**
- Create: `src/main/core/workspace/git.ts`
- Create: `src/main/core/workspace/git.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `git.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createWorkspace, type GitRunner, type GitResult } from './git'

function fakeGit(): { runner: GitRunner; calls: string[][]; setReply: (m: (args: string[]) => GitResult) => void } {
  const calls: string[][] = []
  let reply: (args: string[]) => GitResult = () => ({ code: 0, stdout: '', stderr: '' })
  return {
    calls,
    setReply: (m) => { reply = m },
    runner: { async run(args) { calls.push(args); return reply(args) } },
  }
}

describe('createWorkspace.ensureRepo', () => {
  it('initializes a repo and makes an initial commit when not a git repo', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'rev-parse') return { code: 128, stdout: '', stderr: 'not a git repo' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    await ws.ensureRepo()
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds.some((c) => c.startsWith('init'))).toBe(true)
    expect(cmds.some((c) => c.startsWith('commit'))).toBe(true)
  })

  it('does nothing when already a git repo with commits', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'true', stderr: '' }
      return { code: 0, stdout: 'abc123', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    await ws.ensureRepo()
    expect(g.calls.some((c) => c[0] === 'init')).toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/core/workspace/git.test.ts`. Expected: FAIL(모듈 없음).

- [ ] **Step 3: `git.ts` 구현(ensureRepo)** :

```ts
import { defaultRunner } from '../cli/detect'

export interface GitResult { code: number | null; stdout: string; stderr: string }
export interface GitRunner {
  run(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult>
}
export interface DiffResult { files: string[]; patch: string; truncated: boolean }

export interface Workspace {
  ensureRepo(): Promise<void>
  checkpoint(): Promise<string>
  collectDiff(base: string): Promise<DiffResult>
  keep(message: string): Promise<string>
  revert(base: string): Promise<void>
}

const GIT_TIMEOUT_MS = 120_000
const DIFF_CAP = 60_000

export const defaultGitRunner: GitRunner = {
  run: (args, cwd, signal) =>
    defaultRunner('git', args, { timeoutMs: GIT_TIMEOUT_MS, cwd, signal }).then((r) => ({
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    })),
}

export function createWorkspace(root: string, git: GitRunner = defaultGitRunner): Workspace {
  const run = (args: string[]) => git.run(args, root)
  const ok = async (args: string[]): Promise<GitResult> => {
    const r = await run(args)
    if (r.code !== 0) throw new Error(`git ${args[0]} 실패(code ${r.code}): ${r.stderr.trim()}`)
    return r
  }

  return {
    async ensureRepo() {
      const inside = await run(['rev-parse', '--is-inside-work-tree'])
      if (inside.code !== 0) {
        await ok(['init'])
        await ok(['add', '-A'])
        await ok(['commit', '--allow-empty', '-m', 'fleet: 초기 체크포인트'])
      }
    },
    async checkpoint() {
      const r = await ok(['rev-parse', 'HEAD'])
      return r.stdout.trim()
    },
    async collectDiff(base) {
      await ok(['add', '-A'])
      const names = await ok(['diff', '--cached', '--name-only', base])
      const files = names.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const patchRes = await ok(['diff', '--cached', base])
      const truncated = patchRes.stdout.length > DIFF_CAP
      const patch = truncated ? `${patchRes.stdout.slice(0, DIFF_CAP)}\n…(diff 절단)` : patchRes.stdout
      return { files, patch, truncated }
    },
    async keep(message) {
      await ok(['add', '-A'])
      await ok(['commit', '--allow-empty', '-m', message])
      const r = await ok(['rev-parse', 'HEAD'])
      return r.stdout.trim()
    },
    async revert(base) {
      await ok(['reset', '--hard', base])
      await ok(['clean', '-fd'])
    },
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/core/workspace/git.test.ts`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/workspace/git.ts src/main/core/workspace/git.test.ts
git commit -m "feat(workspace): GitRunner + createWorkspace.ensureRepo"
```

### Task 4: `checkpoint` / `collectDiff` / `keep` / `revert` 테스트

**Files:**
- Modify: `src/main/core/workspace/git.test.ts`

- [ ] **Step 1: 테스트 추가**:

```ts
describe('createWorkspace diff/keep/revert', () => {
  it('checkpoint returns trimmed HEAD hash', async () => {
    const g = fakeGit()
    g.setReply((args) => (args[0] === 'rev-parse' ? { code: 0, stdout: 'deadbeef\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }))
    const ws = createWorkspace('/ws', g.runner)
    expect(await ws.checkpoint()).toBe('deadbeef')
  })

  it('collectDiff returns files, patch and truncation flag', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'diff' && args.includes('--name-only')) return { code: 0, stdout: 'a.ts\nb.ts\n', stderr: '' }
      if (args[0] === 'diff') return { code: 0, stdout: 'diff --git a a', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const d = await ws.collectDiff('base1')
    expect(d.files).toEqual(['a.ts', 'b.ts'])
    expect(d.patch).toContain('diff --git')
    expect(d.truncated).toBe(false)
  })

  it('revert resets hard to base and cleans untracked', async () => {
    const g = fakeGit()
    const ws = createWorkspace('/ws', g.runner)
    await ws.revert('base9')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds).toContain('reset --hard base9')
    expect(cmds).toContain('clean -fd')
  })

  it('throws a descriptive error when a git command fails', async () => {
    const g = fakeGit()
    g.setReply(() => ({ code: 1, stdout: '', stderr: 'fatal: bad' }))
    const ws = createWorkspace('/ws', g.runner)
    await expect(ws.checkpoint()).rejects.toThrow('git rev-parse 실패')
  })
})
```

- [ ] **Step 2: 통과 확인** — Run: `npx vitest run src/main/core/workspace/git.test.ts`. Expected: PASS(Task 3 구현으로 이미 충족).

- [ ] **Step 3: 커밋**

```bash
git add src/main/core/workspace/git.test.ts
git commit -m "test(workspace): checkpoint/collectDiff/revert/에러 커버리지"
```

---

## Phase 3 — CLI 어댑터 편집 모드

### Task 5: `CliAdapter.edit` 타입 + 어댑터별 편집 인자

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/core/cli/registry.ts`

> 주의: codex/claude/gemini 편집 플래그는 **각 CLI 버전으로 실측 확정**한다(현 어댑터 주석 관례). 아래는 codex 0.136 기준 검증값이며 claude/gemini는 Step 3에서 확인 후 채운다.

- [ ] **Step 1: `CliAdapter`에 `edit` 필드 추가** — `types.ts`:

```ts
/**
 * 편집 에이전트 1회 실행 인자 템플릿. '{prompt}'·'{workspace}' 토큰이 치환된다.
 * 존재하면 send({workspace}) 호출이 이 인자로 cwd=workspace 에서 에이전트를 실행해
 * 워크스페이스 파일을 직접 편집한다. 미지정 어댑터는 implementer 역할에 쓸 수 없다.
 */
edit?: { args: string[]; parse?: CliOutputFormat }
```

- [ ] **Step 2: codex 어댑터에 편집 인자 추가** — `registry.ts` codex 항목:

```ts
// 워크스페이스 직접 편집: -C 로 작업 루트 지정, -s workspace-write 로 워크스페이스 안만 쓰기 허용.
edit: { args: ['exec', '--json', '-C', '{workspace}', '-s', 'workspace-write', '{prompt}'], parse: 'codex-jsonl' },
```

- [ ] **Step 3: claude/gemini 편집 인자 실측·기입** — 각 CLI의 헤드리스 편집/권한 플래그를 확인:

Run: `claude --help` (비대화형 편집 + 디렉터리/권한 허용 플래그 확인), `gemini --help`.
Expected: 편집 허용 헤드리스 실행 플래그 식별. 확인된 플래그로 `edit: { args: [...] }`를 채운다(워크스페이스는 spawn cwd로 이미 전달되므로 `{workspace}`는 CLI가 cwd 외 루트 지정을 요구할 때만 사용). 불명·미지원이면 해당 어댑터 `edit` 생략(Task 13에서 implementer 비활성 처리).

- [ ] **Step 4: 타입 통과 확인** — Run: `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/main/core/cli/registry.ts
git commit -m "feat(cli): 어댑터 편집 모드 인자 — codex workspace-write"
```

---

## Phase 4 — 프롬프트 (텍스트 펜스 제거 → 직접 작업/diff 리뷰)

### Task 6: `buildImplementPrompt`(편집)·`buildReviewPrompt`(diff)·`buildVerifyFixPrompt`(에이전트)

**Files:**
- Modify: `src/main/core/orchestrator/review.ts`
- Modify: `src/main/core/orchestrator/review.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `review.test.ts`에 추가/교체:

```ts
it('buildImplementPrompt instructs editing the workspace directly (no file fences)', () => {
  const p = buildImplementPrompt('목표', '작업', '설명')
  expect(p).toContain('작업')
  expect(p).not.toContain('```file:')
  expect(p).toContain('워크스페이스')
})

it('buildReviewPrompt embeds the diff and asks APPROVE/REVISE', () => {
  const p = buildReviewPrompt('작업', '설명', 'diff --git a/x b/x')
  expect(p).toContain('diff --git')
  expect(p).toContain('APPROVE')
})

it('buildVerifyFixPrompt asks the agent to fix failures in the workspace', () => {
  const p = buildVerifyFixPrompt('목표', [
    { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'boom', analysis: 'boom', durationMs: 1 },
  ])
  expect(p).toContain('boom')
  expect(p).toContain('워크스페이스')
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/core/orchestrator/review.test.ts`. Expected: FAIL.

- [ ] **Step 3: `review.ts` 빌더 교체** :

```ts
export function buildImplementPrompt(
  goal: string, taskTitle: string, taskDescription: string, feedback?: string,
): string {
  const parts = [
    `프로젝트 목표:\n${goal}`,
    `\n담당 작업: ${taskTitle}\n${taskDescription}`,
    '\n현재 워크스페이스(작업 디렉터리)에서 이 작업을 직접 수행하라. 필요한 파일을 만들거나 수정하라.',
    '작업 범위 밖의 파일은 건드리지 마라. 완료 후 무엇을 왜 변경했는지 한 단락으로 요약하라.',
  ]
  if (feedback && feedback.trim()) parts.push(`\n이전 검토 피드백을 반드시 반영하라:\n${feedback.trim()}`)
  return parts.join('\n')
}

export function buildReviewPrompt(taskTitle: string, taskDescription: string, diff: string): string {
  return [
    '다음은 한 작업으로 발생한 워크스페이스 변경(diff)이다. 비판적으로 검토하라.',
    `작업: ${taskTitle}`,
    `설명: ${taskDescription}`,
    '',
    '변경(diff):',
    diff || '(변경 없음)',
    '',
    '승인하면 첫 줄에 "APPROVE" 만 쓰라. 수정이 필요하면 첫 줄에 "REVISE" 를 쓰고',
    '다음 줄부터 무엇을 어떻게 고칠지 구체적으로 작성하라.',
  ].join('\n')
}
```

`buildVerifyFixPrompt`를 에이전트 스타일로 교체(원장/펜스 제거):

```ts
const FIX_DETAIL_CAP = 2_000
export function buildVerifyFixPrompt(goal: string, failures: ReadonlyArray<VerificationResult>): string {
  const failBlock = failures
    .map((f) => `- [${f.kind}] ${f.command}\n  ${(f.analysis ?? f.stderr ?? '').slice(0, FIX_DETAIL_CAP).replace(/\n/g, '\n  ')}`)
    .join('\n')
  return [
    `프로젝트 목표:\n${goal}`,
    '',
    '검증(verify)이 실패했다. 현재 워크스페이스에서 아래 실패를 모두 직접 고쳐라:',
    failBlock,
    '',
    '필요한 파일을 직접 수정하라. 완료 후 변경 요약을 한 단락으로 작성하라.',
  ].join('\n')
}
```

`buildSummaryPrompt`/`parseReviewVerdict`는 유지. 더 이상 쓰지 않는 import(없음) 정리.

- [ ] **Step 4: `review.test.ts`의 옛 `buildImplementPrompt(... , true)`/`buildVerifyFixPrompt(... , map)` 시그니처 테스트 갱신** — 5번째 인자(`wantsArtifacts`)·3번째 인자(artifacts map) 제거에 맞춰 수정.

- [ ] **Step 5: 통과 확인** — Run: `npx vitest run src/main/core/orchestrator/review.test.ts`. Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/orchestrator/review.ts src/main/core/orchestrator/review.test.ts
git commit -m "feat(orchestrator): 프롬프트를 직접 편집/diff 리뷰/에이전트 수정으로 전환"
```

---

## Phase 5 — 오케스트레이터 재설계

### Task 7: diff 위험 분류 모듈 (신규)

**Files:**
- Create: `src/main/core/orchestrator/diff-risk.ts`
- Create: `src/main/core/orchestrator/diff-risk.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `diff-risk.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyDiffRisk } from './diff-risk'

describe('classifyDiffRisk', () => {
  it('flags sensitive files as destructive', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts', '.env'], patch: '', truncated: false }, 10)
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('.env')
  })
  it('flags bulk deletions as destructive', () => {
    const patch = ['deleted file mode 100644', 'deleted file mode 100644', 'deleted file mode 100644'].join('\n')
    const r = classifyDiffRisk({ files: ['a', 'b', 'c'], patch, truncated: false }, 2)
    expect(r.risk).toBe('destructive')
  })
  it('treats ordinary edits as caution', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts'], patch: '+const x = 1', truncated: false }, 10)
    expect(r.risk).toBe('caution')
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/core/orchestrator/diff-risk.test.ts`. Expected: FAIL.

- [ ] **Step 3: 구현** — `diff-risk.ts`:

```ts
import type { RiskLevel } from '../../../shared/types'
import type { DiffResult } from '../workspace/git'

const SENSITIVE = /\.(env|pem|key|p12|pfx)$|(^|[/\\])\.ssh[/\\]/i

export interface DiffRisk { risk: RiskLevel; reasons: string[] }

/** diff 위험 분류: 민감 파일·대량 삭제 → destructive, 그 외 → caution. */
export function classifyDiffRisk(diff: DiffResult, deleteThreshold = 5): DiffRisk {
  const reasons: string[] = []
  const sensitive = diff.files.filter((f) => SENSITIVE.test(f))
  if (sensitive.length > 0) reasons.push(`민감 파일 변경: ${sensitive.join(', ')}`)
  const deletions = (diff.patch.match(/^deleted file mode/gm) ?? []).length
  if (deletions > deleteThreshold) reasons.push(`대량 삭제 ${deletions}건`)
  return { risk: reasons.length > 0 ? 'destructive' : 'caution', reasons }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/core/orchestrator/diff-risk.test.ts`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/diff-risk.ts src/main/core/orchestrator/diff-risk.test.ts
git commit -m "feat(orchestrator): diff 위험 분류(민감 파일·대량 삭제)"
```

### Task 8: 공유 타입 — TaskStatus/Task/이벤트/옵션 확장

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 타입 변경**:

```ts
export type TaskStatus = 'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped'
```

`Task`에 추가:

```ts
  /** keep 직전 변경된 파일 목록(diff 기반). */
  changedFiles?: string[]
  /** 작업 전 체크포인트 커밋 해시. */
  checkpoint?: string
```

`ApprovalRequest['kind']`에 `'apply-diff'` 추가. `OrchestratorEventType`에서 `'task.artifacts'` 제거, `'task.progress' | 'task.skipped' | 'run.cancelled'` 추가. `RunProjectRequest`에 추가:

```ts
  taskTimeoutMs?: number
  continueOnFailure?: boolean
```

- [ ] **Step 2: 타입 통과 확인** — Run: `npm run typecheck`. Expected: 오케스트레이터/엔진에서 옛 `task.artifacts` 참조 에러(Task 9~에서 해소). 우선 이 파일만 컴파일 의도 — 후속 태스크에서 그린. (이 태스크 단독 커밋은 다음 태스크와 함께 검증)

- [ ] **Step 3: 커밋**

```bash
git add src/shared/types.ts
git commit -m "feat(types): TaskStatus skipped·Task diff 필드·이벤트/옵션 확장"
```

### Task 9: 오케스트레이터 `runTask` diff 기반 재작성

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts`

> 이 태스크는 `RunOptions`에 `workspace?: Workspace`, `gate?: ApprovalGate`, `signal?: AbortSignal`, `taskTimeoutMs?`, `continueOnFailure?`를 추가하고, 기존 `fileWriter`/`writeArtifacts`/`parseArtifacts`/`artifactLedger` 경로를 제거한다.

- [ ] **Step 1: `RunOptions` 갱신 + import 정리** — `orchestrator.ts` 상단:

```ts
import { classifyDiffRisk } from './diff-risk'
import type { Workspace } from '../workspace/git'
import type { ApprovalGate } from '../safety/approval'
// 제거: parseArtifacts, ProjectFileWriter, buildVerifyFixPrompt 의 옛 시그니처 import 등
```

`RunOptions`:

```ts
export interface RunOptions {
  store: Store
  sessions: SessionManager
  assignments: readonly RoleAssignment[]
  maxReviewRounds?: number
  /** 있으면 작업을 git 체크포인트/diff 기반으로 실행한다(직접 편집 모델). 없으면 작업 실행 불가로 스킵. */
  workspace?: Workspace
  /** 워크스페이스 디렉터리 경로. send({workspace})로 CLI 에이전트 cwd에 전달한다. */
  workspaceRoot?: string
  /** diff 위험 승인 게이트. 없으면 위험 변경은 거부(안전 기본값). */
  gate?: ApprovalGate
  verify?: () => Promise<VerificationResult[]>
  maxVerifyFixRounds?: number
  /** 작업 LLM 호출 타임아웃(편집 에이전트는 길다). cli-session에 전달. */
  taskTimeoutMs?: number
  /** true면 작업 실패가 의존 없는 다른 작업을 막지 않는다(부분 진행). */
  continueOnFailure?: boolean
  /** 실행 취소 신호. abort 시 진행 중 작업을 revert 하고 중단한다. */
  signal?: AbortSignal
  onEvent?: (e: OrchestratorEvent) => void
}
```

- [ ] **Step 2: `runTask` 교체** — 본문:

```ts
const runTask = async (task: Task): Promise<void> => {
  const ws = opts.workspace
  const implRole: AgentRole = task.role ?? 'implementer'
  const implementerId = resolveLlmForRole(assignments, implRole, 'implementer')
  const implementer = implementerId ? sessions.get(implementerId) : undefined
  if (!implementer) {
    store.updateTask(task.id, { status: 'failed', output: '구현 역할에 배정된 LLM 없음' })
    emit({ type: 'task.failed', message: `${task.title}: 구현 LLM 미배정`, data: { taskId: task.id } })
    failed.add(task.id)
    return
  }
  // 직접 편집은 CLI 세션만 가능(API는 파일을 못 만짐).
  if (implementer.descriptor.kind !== 'cli' || !ws) {
    store.updateTask(task.id, { status: 'skipped', output: 'CLI 에이전트/워크스페이스 필요(직접 편집 불가)' })
    emit({ type: 'task.skipped', message: `${task.title}: 직접 편집 불가(API 또는 워크스페이스 없음)`, data: { taskId: task.id } })
    failed.add(task.id)
    return
  }
  store.updateTask(task.id, { status: 'running', assignedLlmId: implementerId })
  emit({ type: 'task.started', message: `작업 시작: ${task.title}`, data: { taskId: task.id } })

  const reviewerId = resolveLlmForRole(assignments, 'reviewer')
  if (reviewerId && reviewerId === implementerId) {
    store.appendEvent({ type: 'task.self_review', data: { taskId: task.id, llmId: implementerId } })
  }

  const base = await ws.checkpoint()
  store.updateTask(task.id, { checkpoint: base })
  try {
    let approved = false
    let feedback = ''
    let diff = { files: [] as string[], patch: '', truncated: false }
    for (let round = 0; round < maxRounds; round++) {
      await implementer.send(buildImplementPrompt(goal, task.title, task.description, feedback || undefined), {
        fresh: true,
        workspace: opts.workspaceRoot,
        signal: opts.signal,
        timeoutMs: opts.taskTimeoutMs,
        onChunk: (delta) => emit({ type: 'task.progress', message: delta, data: { taskId: task.id } }),
      })
      diff = await ws.collectDiff(base)
      store.updateTask(task.id, { status: 'review', changedFiles: diff.files })
      emit({ type: 'task.implemented', message: `구현 완료 (라운드 ${round + 1}, 변경 ${diff.files.length}개)`, data: { taskId: task.id, round } })

      const reviewer = sessionForRole('reviewer')
      if (!reviewer) { approved = true; break }
      const verdict = parseReviewVerdict(
        await reviewer.send(buildReviewPrompt(task.title, task.description, diff.patch), { fresh: true, signal: opts.signal }),
      )
      emit({ type: 'task.review', message: verdict.approved ? '리뷰 승인' : '수정 요청', data: { taskId: task.id, approved: verdict.approved, round } })
      if (verdict.approved) { approved = true; break }
      feedback = verdict.feedback
      await ws.revert(base) // 거절된 시도는 되돌리고 다음 라운드 재시도
    }

    if (!approved) {
      await ws.revert(base)
      store.updateTask(task.id, { status: 'failed', output: '미승인(재검토 한도 초과)' })
      emit({ type: 'task.failed', message: `${task.title}: 미승인(재검토 한도 초과)`, data: { taskId: task.id } })
      failed.add(task.id)
      return
    }

    // 위험 게이트
    const dr = classifyDiffRisk(diff)
    if (dr.risk === 'destructive') {
      const decision = opts.gate
        ? await opts.gate.request({ kind: 'apply-diff', summary: `${task.title} 변경 적용`, target: diff.files.join(', '), risk: 'destructive' })
        : 'rejected'
      if (decision !== 'approved') {
        await ws.revert(base)
        store.updateTask(task.id, { status: 'failed', output: `위험 변경 미승인: ${dr.reasons.join('; ')}` })
        emit({ type: 'task.failed', message: `${task.title}: 위험 변경 미승인`, data: { taskId: task.id } })
        failed.add(task.id)
        return
      }
    }

    await ws.keep(`[${task.title}] by ${implementerId}`)
    store.updateTask(task.id, { status: 'done', output: `변경 ${diff.files.length}개 적용`, changedFiles: diff.files })
    emit({ type: 'task.done', message: `${task.title}: 완료(변경 ${diff.files.length}개)`, data: { taskId: task.id } })
    done.add(task.id)
  } catch (err) {
    await ws.revert(base).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    store.updateTask(task.id, { status: 'failed', output: `실행 오류: ${message}` })
    emit({ type: 'task.failed', message: `${task.title}: 실행 오류 - ${message}`, data: { taskId: task.id } })
    failed.add(task.id)
  }
}
```

`workspaceRoot`는 `runProject` 진입부에서 `opts.workspace`와 함께 받는 루트 문자열이 필요하다 → `RunOptions.workspace`를 `{ root: string } & Workspace`로 두거나 별도 `workspaceRoot?: string`를 추가한다. **결정: `RunOptions`에 `workspaceRoot?: string` 추가**(엔진이 워크스페이스 dir과 Workspace 객체를 함께 주입). `send`의 `workspace`는 `workspaceRoot`를 전달.

- [ ] **Step 3: `runProject` 진입부에서 `ensureRepo` 호출** — 작업 루프 전에:

```ts
if (opts.workspace) await opts.workspace.ensureRepo()
```

- [ ] **Step 4: 옛 `writeArtifacts`/`artifactLedger`/`ProjectFileWriter` 제거** — 관련 함수·필드·import 삭제.

- [ ] **Step 5: 타입 확인** — Run: `npm run typecheck`. Expected: verify 섹션·테스트 외 orchestrator.ts 그린(verify 섹션은 Task 11에서). 임시로 verify 섹션의 옛 `buildVerifyFixPrompt(...artifactLedger)` 호출은 다음 태스크에서 교체하므로, 이 태스크에서 함께 수정하거나 주석 처리 후 Task 11에서 완성. **권장: Step 6에서 verify 섹션도 함께 교체**.

- [ ] **Step 6: (이어서) verify-fix 루프를 에이전트 기반으로 교체** — `orchestrator.ts` verify 섹션의 fix 라운드:

```ts
for (let round = 1; round <= maxFix && verifications.some((v) => !v.passed) && !!opts.workspace && !!fixImplementer && fixImplementer.descriptor.kind === 'cli'; round++) {
  const failing = verifications.filter((v) => !v.passed)
  emit({ type: 'verify.fixing', message: `검증 실패 — 수정 시도 (라운드 ${round})`, data: { projectId: project.id, round } })
  const base = await opts.workspace.checkpoint()
  try {
    await fixImplementer.send(buildVerifyFixPrompt(goal, failing), { fresh: true, workspace: opts.workspaceRoot, signal: opts.signal, timeoutMs: opts.taskTimeoutMs })
    await opts.workspace.keep(`[verify-fix r${round}]`)
  } catch (err) {
    await opts.workspace.revert(base).catch(() => {})
    emit({ type: 'verify.fixing', message: `수정 실패: ${err instanceof Error ? err.message : String(err)}`, data: { projectId: project.id, round } })
    break
  }
  verifications = await verifyOnce()
  emitVerify(verifications)
}
```

`fixImplementer`/`fixImplementerId`는 기존 로직 유지하되 `kind === 'cli'` 가드 추가.

- [ ] **Step 7: 타입 통과 확인** — Run: `npm run typecheck`. Expected: PASS(테스트 제외). 테스트는 Task 10에서 개편.

- [ ] **Step 8: 커밋**

```bash
git add src/main/core/orchestrator/orchestrator.ts
git commit -m "feat(orchestrator): diff 기반 runTask + 위험 게이트 + 에이전트 verify-fix"
```

### Task 10: 실패 격리 (skipped vs failed, continueOnFailure) + 오케스트레이터 테스트 개편

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts`
- Modify: `src/main/core/orchestrator/orchestrator.test.ts`

- [ ] **Step 1: 위상 스케줄 루프에 부분 진행 반영** — `orchestrator.ts`의 의존 실패 전파 분기(현 `deps.some((d) => failed.has(d))`)를 다음으로:

```ts
if (deps.some((d) => failed.has(d))) {
  store.updateTask(task.id, { status: 'skipped', output: '의존 작업 실패로 건너뜀' })
  emit({ type: 'task.skipped', message: `${task.title}: 의존 작업 실패로 건너뜀`, data: { taskId: task.id } })
  failed.add(task.id) // 전이 스킵을 위해 failed 집합에는 유지(직접/전이 의존만 영향)
  pending.splice(i, 1)
  progressed = true
  continue
}
```

> `continueOnFailure`는 "의존 없는 독립 작업은 계속 실행"을 이미 보장(위상 루프가 의존 충족 작업만 실행하므로 독립 사슬은 영향 없음). 추가 동작 불필요 — 단, 보드 상태를 `skipped`로 구분해 사용자가 "실패 vs 미실행"을 구분하게 한다.

- [ ] **Step 2: 테스트용 fake Workspace 헬퍼 추가** — `orchestrator.test.ts` 상단(`deterministic` 아래):

```ts
import type { Workspace, DiffResult } from '../workspace/git'

function fakeWorkspace(diffByCall: DiffResult[] = []): Workspace & { commits: string[] } {
  let i = 0
  const commits: string[] = []
  return {
    commits,
    async ensureRepo() {},
    async checkpoint() { return `base-${i}` },
    async collectDiff() { return diffByCall[i++] ?? { files: ['src/x.ts'], patch: '+x', truncated: false } },
    async keep(message) { commits.push(message); return `commit-${commits.length}` },
    async revert() {},
  }
}
```

`fakeSession`의 kind를 implementer는 `'cli'`로 지정해야 함(직접 편집 가드). 헬퍼 호출 시 `fakeSession('impl', () => '구현', 'cli')`.

- [ ] **Step 3: 기존 테스트 개편** — 다음 원칙으로 수정:
  - 모든 `runProject(...)` 호출에 `workspace: fakeWorkspace()` 추가.
  - implementer 세션 `kind: 'cli'`로.
  - `fileWriter`/````file:` 기반 테스트("writes implementer file artifacts", "re-implements and re-verifies"의 writes 단언) → diff/commit 기반으로 교체. 예: keep 호출 수·`commits` 길이 단언.
  - "marks a dependent task failed without running it" → `b?.status`를 `'skipped'`로 기대.

대표 교체(작업 산출물 검증):

```ts
it('commits a checkpoint per approved task (diff 기반 산출물)', async () => {
  const store = createMemoryStore(deterministic())
  const sessions = createSessionManager()
  sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
  sessions.add(fakeSession('impl', () => '구현 요약', 'cli'))
  sessions.add(fakeSession('rev', () => 'APPROVE'))
  const ws = fakeWorkspace()
  const result = await runProject('goal', {
    store, sessions,
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
})

it('skips a task whose dependency failed and marks it skipped', async () => {
  const store = createMemoryStore(deterministic())
  const sessions = createSessionManager()
  sessions.add(fakeSession('planner', () => '[{"title":"A","description":"a"},{"title":"B","description":"b","dependsOn":[0]}]'))
  sessions.add(fakeSession('impl', () => '구현', 'cli'))
  sessions.add(fakeSession('rev', () => 'REVISE: 고쳐'))
  const result = await runProject('goal', {
    store, sessions,
    assignments: [
      { role: 'planner', llmId: 'planner' },
      { role: 'implementer', llmId: 'impl' },
      { role: 'reviewer', llmId: 'rev' },
    ],
    workspace: fakeWorkspace(), workspaceRoot: '/ws', maxReviewRounds: 1,
  })
  expect(result.tasks.find((t) => t.title === 'A')?.status).toBe('failed')
  expect(result.tasks.find((t) => t.title === 'B')?.status).toBe('skipped')
})

it('skips an implementer task assigned to an API session', async () => {
  const store = createMemoryStore(deterministic())
  const sessions = createSessionManager()
  sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
  sessions.add(fakeSession('impl', () => '구현', 'api')) // API → 직접 편집 불가
  sessions.add(fakeSession('rev', () => 'APPROVE'))
  const result = await runProject('goal', {
    store, sessions,
    assignments: [
      { role: 'planner', llmId: 'planner' },
      { role: 'implementer', llmId: 'impl' },
      { role: 'reviewer', llmId: 'rev' },
    ],
    workspace: fakeWorkspace(), workspaceRoot: '/ws',
  })
  expect(result.tasks[0].status).toBe('skipped')
})
```

verify 관련 테스트("re-implements and re-verifies", "verify fixes exhausted", "maxVerifyFixRounds 0")는 `fileWriter` 제거·`workspace`/`workspaceRoot` 추가·implementer `kind:'cli'`로 갱신하고, `writes` 단언 → `ws.commits` 단언으로 교체.

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "feat(orchestrator): 실패 격리(skipped) + diff 기반 테스트 개편"
```

### Task 11: 텍스트 아티팩트 모듈 제거

**Files:**
- Delete: `src/main/core/orchestrator/artifacts.ts`
- Delete: `src/main/core/orchestrator/artifacts.test.ts`

- [ ] **Step 1: 파일 삭제 + 잔여 참조 확인**

```bash
git rm src/main/core/orchestrator/artifacts.ts src/main/core/orchestrator/artifacts.test.ts
```

Run: `npx grep -r "parseArtifacts\|artifacts'" src` (또는 에디터 검색). Expected: 참조 0건(orchestrator에서 이미 제거됨).

- [ ] **Step 2: 통과 확인** — Run: `npm run typecheck && npx vitest run`. Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git commit -m "refactor(orchestrator): 텍스트 아티팩트 파서 제거(diff 모델로 대체)"
```

---

## Phase 6 — verify 실행기 타임아웃 분류

### Task 12: `defaultVerifyRunner` 타임아웃을 spawnError로 분류 + 타임아웃 설정

**Files:**
- Modify: `src/main/core/verify/run.ts`
- Modify: `src/main/core/verify/run.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `run.test.ts`:

```ts
it('classifies an execFile timeout (killed/SIGTERM) as a spawnError', async () => {
  const runner: VerifyRunner = async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ETIMEDOUT' })
  const res = await runVerification({ kind: 'test', command: 'npm', args: ['test'] }, { runner })
  expect(res.passed).toBe(false)
  expect(res.analysis).toContain('ETIMEDOUT')
})
```

(이미 `spawnError` 경로가 `analysis: 명령 실행 실패: …`를 만들므로, 핵심은 `defaultVerifyRunner`가 timeout을 spawnError로 반환하는지 — 아래 통합 테스트로 검증.)

```ts
it('defaultVerifyRunner reports timeout as spawnError, not exit code', async () => {
  const res = await defaultVerifyRunner(
    { kind: 'custom', command: 'node', args: ['-e', 'setTimeout(()=>{},5000)'] },
    200,
  )
  expect(res.spawnError).toBe('ETIMEDOUT')
}, 10_000)
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/core/verify/run.test.ts`. Expected: 두 번째 FAIL(현재 code=1 반환).

- [ ] **Step 3: `defaultVerifyRunner` 보정** — `run.ts`의 콜백:

```ts
(err, stdout, stderr) => {
  const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null
  if (e && e.code === 'ENOENT') {
    resolve({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' })
    return
  }
  if (e && (e.killed || e.signal === 'SIGTERM')) {
    resolve({ code: null, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', spawnError: 'ETIMEDOUT' })
    return
  }
  const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0
  resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/core/verify/run.test.ts`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/verify/run.ts src/main/core/verify/run.test.ts
git commit -m "fix(verify): execFile 타임아웃을 spawnError(ETIMEDOUT)로 분류"
```

---

## Phase 7 — 엔진 배선

### Task 13: 엔진 — Workspace 배선·워크스페이스 전파·역할 제약·cancelRun·타임아웃

**Files:**
- Modify: `src/main/core/engine.ts`
- Modify: `src/main/core/engine.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `engine.test.ts`에 추가(워크스페이스 없으면 실행 거부):

```ts
it('refuses to run a project when no workspace is selected', async () => {
  const engine = createFleetEngine({ store: createMemoryStore(), runner: async () => ({ code: 0, stdout: 'ok', stderr: '' }) })
  engine.registerCliSession('codex')
  await expect(engine.runProjectFlow({ goal: 'g' })).rejects.toThrow(/워크스페이스/)
})
```

(`createFleetEngine` 기존 테스트 패턴에 맞춰 조정. 기존 engine.test.ts의 세션 등록/runner mock 형태를 따른다.)

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/core/engine.test.ts`. Expected: FAIL.

- [ ] **Step 3: 엔진 변경** — `engine.ts`:

```ts
import { createWorkspace } from './workspace/git'
// runProjectFlow 내부
async runProjectFlow(input) {
  const llmIds = sessions.list().map((s) => s.id)
  if (llmIds.length === 0) throw new Error('등록된 LLM 세션이 없습니다. 먼저 세션을 등록하세요.')
  if (!workspaceDir) throw new Error('워크스페이스가 선택되지 않았습니다. 먼저 산출물 워크스페이스를 선택하세요.')
  const capabilities = Object.fromEntries(
    sessions.descriptors().flatMap((d) => (d.capabilities?.length ? [[d.id, d.capabilities]] : [])),
  )
  const assignments = input.assignments ?? assignRoles({ roles: ASSIGNABLE_ROLES, llmIds, policy: input.policy ?? 'round-robin', capabilities })
  const controller = new AbortController()
  activeRuns.set(/* projectId 확보 후 */ '', controller) // 아래 주석 참조
  return runProject(input.goal, {
    store, sessions, assignments,
    maxReviewRounds: input.maxReviewRounds,
    workspace: createWorkspace(workspaceDir),
    workspaceRoot: workspaceDir,
    gate,
    verify: currentVerify(),
    taskTimeoutMs: input.taskTimeoutMs,
    continueOnFailure: input.continueOnFailure,
    signal: controller.signal,
    onEvent: opts.onOrchestratorEvent,
  })
}
```

> projectId는 `runProject` 내부에서 생성되므로 취소 상관을 위해 **AbortController를 onEvent의 `project.created`에서 등록**한다. 구현: 엔진에 `const activeRuns = new Map<string, AbortController>()` 두고, `onEvent` 래퍼에서 `e.type==='project.created'`일 때 `activeRuns.set(e.data.projectId, controller)`, `project.done`에서 삭제. `cancelRun(projectId)`는 `activeRuns.get(projectId)?.abort()` + `run.cancelled` 이벤트.

`cli-session` 타임아웃 주입: `createCliSession(descriptor, adapter, runner, input.taskTimeoutMs)` 경로가 필요 → 세션은 등록 시점에 만들어지므로, 작업 타임아웃은 **`send` 시점에 적용**하는 게 자연스럽다. **결정: `SendOptions`에 `timeoutMs?` 추가**(Task 2 확장)하고 cli-session이 `sendOpts.timeoutMs ?? 기본`을 사용. 오케스트레이터는 `send(..., { timeoutMs: opts.taskTimeoutMs })`. (Task 2/9에 이 인자 반영 — 자기점검에서 일관성 확인.)

`gate`는 이미 `createApprovalGate({ autoApprove: ['safe','caution'], approver, onEvent })`로 생성됨 → `runProject`에 전달.

`FleetEngine` 인터페이스에 `cancelRun(projectId: string): void` 추가 + 구현.

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/core/engine.test.ts`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(engine): Workspace 배선·워크스페이스 필수·역할제약·cancelRun"
```

---

## Phase 8 — IPC / preload / UI

### Task 14: IPC·preload — cancelRun + apply-diff 승인(재사용)

**Files:**
- Modify: `src/shared/types.ts` (FleetBridge)
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: `FleetBridge`에 `cancelRun` 추가** — `types.ts`:

```ts
cancelRun(projectId: string): Promise<void>
```

- [ ] **Step 2: main IPC 핸들러 추가** — `index.ts` `registerIpc`:

```ts
ipcMain.handle('fleet:project:cancel', (_e, projectId: string) => engine.cancelRun(projectId))
```

- [ ] **Step 3: preload 노출** — `preload/index.ts`:

```ts
cancelRun: (projectId: string) => ipcRenderer.invoke('fleet:project:cancel', projectId),
```

`onApprovalRequest`는 기존 그대로 — `apply-diff` kind도 동일 채널로 흐르므로 `ApprovalModal`이 자동 수신(Task 15에서 라벨만 보강).

- [ ] **Step 4: 통과 확인** — Run: `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/types.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(ipc): cancelRun 채널 + apply-diff 승인 재사용"
```

### Task 15: 렌더러 — diff 변경 표시·취소 버튼·apply-diff 라벨

**Files:**
- Modify: `src/renderer/components/ProjectPanel.tsx`
- Modify: `src/renderer/components/ApprovalModal.tsx`
- Modify: `src/renderer/components/ProjectPanel.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `ProjectPanel.test.tsx`에 추가(작업이 변경 파일 수와 skipped 상태를 표시):

```tsx
it('shows changed file count for done tasks and a skipped badge', async () => {
  // 기존 테스트의 fleet mock 패턴을 따라 tasks에 changedFiles/status:'skipped' 포함한 mock 주입
  // done 작업: changedFiles=['a.ts','b.ts'] → "2" 표시, skipped 작업: "건너뜀"/"skipped" 배지 표시
})
```

(기존 `ProjectPanel.test.tsx`의 mock·렌더 패턴을 그대로 따라 구체화. 단언: 변경 파일 수 텍스트, skipped 배지 존재.)

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/components/ProjectPanel.test.tsx`. Expected: FAIL.

- [ ] **Step 3: `ProjectPanel.tsx` 보강** — 작업 행에 `task.status === 'skipped'` 배지와 `task.changedFiles?.length` 표시 추가. 실행 중 프로젝트에 **취소 버튼**(`window.fleet.cancelRun(projectId)`); `task.progress` 이벤트 수신 시 라이브 진행 텍스트(선택). 기존 "Obsidian Command Deck" 토큰/클래스 재사용.

- [ ] **Step 4: `ApprovalModal.tsx`에 `apply-diff` 라벨** — `kind === 'apply-diff'`면 "변경 적용 승인" 제목 + target(파일 목록) 표시. 기존 분기에 케이스 추가만.

- [ ] **Step 5: 통과 확인** — Run: `npx vitest run src/renderer/components/`. Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/components/ProjectPanel.tsx src/renderer/components/ApprovalModal.tsx src/renderer/components/ProjectPanel.test.tsx
git commit -m "feat(ui): 작업 diff 변경 표시·취소 버튼·apply-diff 승인 라벨"
```

---

## 최종 검증

### Task 16: 전체 게이트 + 수동 스모크

- [ ] **Step 1: 전체 품질 게이트** — Run: `npm run typecheck && npm run lint && npm test && npm run build`. Expected: 전부 PASS/그린.

- [ ] **Step 2: (수동·선택) 실제 codex 엔드투엔드 스모크** — 빈 임시 폴더를 워크스페이스로 선택하고 작은 목표(예: "hello world를 출력하는 node 스크립트 `index.js`를 만들어줘")로 실행. 확인: 워크스페이스에 파일 생성됨, `git log`에 작업 커밋, 보드에 변경 파일 수 표시. 실패 시 systematic-debugging으로 회귀.

- [ ] **Step 3: 최종 커밋(필요 시 문서/changelog)**

```bash
git add -A
git commit -m "chore: 실행 모델 재설계 마감 — 게이트 그린"
```

---

## 자기점검(작성자 체크리스트 결과)

- **스펙 커버리지:** 섹션1(데이터플로우)=Task9·10 / 섹션2(실행계층)=Task1·2·5 / 섹션3(git)=Task3·4 / 섹션4(리뷰·승인)=Task6·7·9 / 섹션5(verify)=Task9.6·12 / 섹션6(실패격리)=Task10 / 섹션7(타입·IPC·UI)=Task8·14·15 / 섹션8(테스트)=각 태스크 TDD. ✔
- **타입 일관성:** `SendOptions`에 `workspace`/`signal`/`timeoutMs`(Task2/9/13에서 동일 사용), `Workspace` 인터페이스(Task3) ↔ orchestrator/engine/test 사용 일치, `RunOptions.workspaceRoot` 추가를 Task9·10·13에서 일관 사용. `classifyDiffRisk`(Task7)↔Task9 호출 일치. ✔
- **플레이스홀더:** codex 외 CLI 편집 플래그는 Task5 Step3의 **실측 명령**으로 확정(플레이스홀더 아님, 검증 절차 명시). ✔
- **YAGNI:** worktree 병렬·API 직접편집·작업별 사용자 승인은 비범위. ✔

# #123-A Ignored 파일 변경 탐지·선택 복원 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오케스트레이션 편집 경로에서 `.gitignore` 대상 파일(민감 비밀 포함)의 에이전트 변경을 탐지·승인게이트 surface·실패 시 선택 복원하여, ignored 우회 보안 누수를 닫는다.

**Architecture:** 순수 모듈 `ignored-baseline.ts`(git ignored 열거 + fs 해시·in-memory 백업·비교·선택 복원·캡/fail-closed)를 `Workspace` 가 조합해 3 메서드로 노출하고, `classifyDiffRisk` 를 ignored change 입력으로 확장한다. 오케스트레이터는 공유 `rollbackWithIgnored` 헬퍼 + 인라인 capture/collect/dispose 로 `runTaskIn`(순차·병렬 worktree 공용)과 verify-fix 루프 양쪽을 동일 배선한다.

**Tech Stack:** TypeScript(strict), Node `node:fs`/`node:crypto`/`node:path`, vitest. 테스트 = fakeGit(GitRunner) + 실제 temp 디렉터리 하이브리드.

## Global Constraints

- 품질 게이트(머지 전 전부 green): `typecheck` · `lint` · `format:check` · `test` · `build`. 코드 변경 후 `npm run brain` 재생성.
- 순수 코어(`src/main/core/`)는 Electron import 금지(Node 만). 새 모듈도 동일.
- 비밀 비노출: 파일 **내용·hash 를 로그·approval reason·reviewer patch 에 절대 싣지 않는다**. normalized relative path + 변경종류만.
- 테스트 temp 는 `os.tmpdir()`(네이티브) 사용 — Git Bash `/tmp` 금지. Windows + POSIX 양쪽 의미 검증.
- 민감경로 정규식은 `src/main/core/safety/approval.ts` 의 `SENSITIVE_FILE` 재사용(중복 정의 금지).
- A 슬라이스만: symlink/junction/reparse·프로세스 격리는 B(후속)로 분리 — 이 플랜 범위 외.
- 기존 `revertSafely`(orchestrator.ts:33-41) 패턴 준수: revert/restore 실패는 무성흡수 금지·task output/event 표면화.

---

## File Structure

- **Create** `src/main/core/workspace/ignored-baseline.ts` — 순수 로직(타입·정책·capture·collect·restore·dispose). 단일 책임 = "ignored 파일 baseline 캡처·비교·선택 복원".
- **Create** `src/main/core/workspace/ignored-baseline.test.ts` — 단위 테스트(fakeGit + temp fs).
- **Modify** `src/main/core/workspace/git.ts:37-46`(Workspace 인터페이스) + `:113-218`(createWorkspace) — 3 메서드 추가, 기본 정책 바인딩.
- **Modify** `src/main/core/workspace/git.test.ts` — Workspace 신규 메서드 위임/동작 테스트.
- **Modify** `src/main/core/orchestrator/diff-risk.ts` — `classifyDiffRisk(diff, ignored?)` 확장.
- **Modify** `src/main/core/orchestrator/diff-risk.test.ts` — ignored 분기 테스트.
- **Create** `src/main/core/orchestrator/ignored-guard.ts` — `rollbackWithIgnored` 공유 헬퍼.
- **Create** `src/main/core/orchestrator/ignored-guard.test.ts` — 헬퍼 단위 테스트.
- **Modify** `src/main/core/orchestrator/orchestrator.ts:238-374`(runTaskIn) + `:704-740`(verify-fix) — capture/collect/risk/rollback/dispose 배선.
- **Modify** `src/main/core/orchestrator/orchestrator.test.ts` — 통합 회귀 1~7.

---

## Task 1: `ignored-baseline.ts` — 타입·정책·capture

**Files:**
- Create: `src/main/core/workspace/ignored-baseline.ts`
- Test: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `SENSITIVE_FILE`(`src/main/core/safety/approval.ts`), `GitRunner`(`./git`).
- Produces: `ScanPolicy`, `DEFAULT_IGNORED_POLICY`, `IgnoredEntry`, `IgnoredBaseline`, `captureIgnoredBaseline(root: string, git: GitRunner, policy: ScanPolicy): Promise<IgnoredBaseline>`. 내부 `listIgnored(root, git, policy): Promise<{ files: string[]; skipped: {path; reason: 'over-cap'}[] }>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/workspace/ignored-baseline.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitRunner } from './git'
import { captureIgnoredBaseline, DEFAULT_IGNORED_POLICY } from './ignored-baseline'

// `!! path\0` 레코드(porcelain v1 -z 의 ignored 표기)를 만들어 주는 fake git.
function fakeGitIgnored(paths: string[]): GitRunner {
  const out = paths.map((p) => `!! ${p}`).join('\0') + (paths.length ? '\0' : '')
  return { async run() { return { code: 0, stdout: out, stderr: '' } } }
}

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-ign-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('captureIgnoredBaseline', () => {
  it('captures hash + in-memory backup of an ignored file', async () => {
    writeFileSync(join(root, '.env'), 'SECRET=1')
    const git = fakeGitIgnored(['.env'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const e = base.entries.get('.env')
    expect(e).toBeDefined()
    expect(e!.sensitive).toBe(true)
    expect(e!.backup?.toString()).toBe('SECRET=1')
    expect(base.skipped).toEqual([])
  })

  it('skips denylisted trees (node_modules) entirely', async () => {
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'x.js'), 'big')
    const git = fakeGitIgnored(['node_modules/'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    expect(base.entries.size).toBe(0)
    expect(base.skipped).toEqual([])
  })

  it('throws when a sensitive file cannot be backed up (read failure)', async () => {
    // .env 를 디렉터리로 만들어 readFileSync 가 EISDIR 로 실패하게 한다(민감 백업 실패 = hard-stop).
    mkdirSync(join(root, '.env'))
    const git = fakeGitIgnored(['.env'])
    await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow()
  })

  it('marks an over-per-file-cap general file as skipped(over-cap), not throw', async () => {
    writeFileSync(join(root, 'big.dat'), Buffer.alloc(16))
    const git = fakeGitIgnored(['big.dat'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFileBytes: 8 }
    const base = await captureIgnoredBaseline(root, git, policy)
    expect(base.entries.has('big.dat')).toBe(false)
    expect(base.skipped).toContainEqual({ path: 'big.dat', reason: 'over-cap' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: FAIL — `captureIgnoredBaseline`/`DEFAULT_IGNORED_POLICY` not exported (module 없음).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/core/workspace/ignored-baseline.ts
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { SENSITIVE_FILE } from '../safety/approval'
import type { GitRunner } from './git'

export interface ScanPolicy {
  sensitiveRe: RegExp
  denylistRe: RegExp
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
}

export const DEFAULT_IGNORED_POLICY: ScanPolicy = {
  sensitiveRe: SENSITIVE_FILE,
  denylistRe:
    /(^|\/)(node_modules|\.git|dist|out|build|\.next|coverage|\.cache|target|\.turbo)(\/|$)|(^|\/)\.fleet-wt-/,
  maxFiles: 1000,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
}

export interface IgnoredEntry {
  path: string
  size: number
  mtimeMs: number
  hash: string
  sensitive: boolean
  backup: Buffer | null
}
export interface IgnoredBaseline {
  entries: Map<string, IgnoredEntry>
  skipped: { path: string; reason: 'over-cap' | 'read-failed' }[]
}

// root 기준 슬래시 정규화 상대경로(맵 키·로그 노출용).
const norm = (root: string, rel: string): string => relative(root, resolve(root, rel)).replace(/\\/g, '/')

// git status --ignored 로 in-scope ignored 파일을 열거한다.
// 디렉터리(`!! dir/`)는 denylist 우선 검사 후 fs 재귀; sensitive 는 항상 포함, 그 외는 denylist·maxFiles 적용.
async function listIgnored(
  root: string,
  git: GitRunner,
  policy: ScanPolicy,
): Promise<{ files: string[]; skipped: { path: string; reason: 'over-cap' }[] }> {
  const r = await git.run(['status', '--ignored', '--porcelain=v1', '-z'], root)
  const records = r.code === 0 ? r.stdout.split('\0').filter(Boolean) : []
  const ignored = records.filter((rec) => rec.startsWith('!! ')).map((rec) => rec.slice(3))
  const files: string[] = []
  const skipped: { path: string; reason: 'over-cap' }[] = []
  const inScope = (rel: string): boolean => policy.sensitiveRe.test(rel) || !policy.denylistRe.test(rel)
  const pushFile = (rel: string): void => {
    const key = rel.replace(/\\/g, '/')
    if (!inScope(key)) return
    if (!policy.sensitiveRe.test(key) && files.length >= policy.maxFiles) {
      skipped.push({ path: key, reason: 'over-cap' })
      return
    }
    files.push(key)
  }
  const walk = (relDir: string): void => {
    let names: string[]
    try {
      names = readdirSync(resolve(root, relDir))
    } catch {
      return
    }
    for (const name of names) {
      const rel = `${relDir}/${name}`
      if (!inScope(rel)) continue
      let st
      try {
        st = statSync(resolve(root, rel))
      } catch {
        continue
      }
      if (st.isDirectory()) walk(rel)
      else pushFile(rel)
    }
  }
  for (const e of ignored) {
    const rel = e.replace(/\\/g, '/')
    if (rel.endsWith('/')) {
      const dir = rel.replace(/\/+$/, '')
      if (policy.denylistRe.test(`${dir}/`)) continue
      walk(dir)
    } else {
      pushFile(rel)
    }
  }
  return { files, skipped }
}

export async function captureIgnoredBaseline(
  root: string,
  git: GitRunner,
  policy: ScanPolicy,
): Promise<IgnoredBaseline> {
  const { files, skipped: enumSkipped } = await listIgnored(root, git, policy)
  const entries = new Map<string, IgnoredEntry>()
  const skipped: { path: string; reason: 'over-cap' | 'read-failed' }[] = [...enumSkipped]
  let totalBytes = 0
  for (const path of files) {
    const sensitive = policy.sensitiveRe.test(path)
    const abs = resolve(root, path)
    let st
    try {
      st = statSync(abs)
    } catch (err) {
      if (sensitive) throw new Error(`민감 ignored 파일 stat 실패: ${path}`)
      skipped.push({ path, reason: 'read-failed' })
      continue
    }
    if (st.size > policy.maxFileBytes || totalBytes + st.size > policy.maxTotalBytes) {
      if (sensitive) throw new Error(`민감 ignored 파일이 백업 상한 초과: ${path}`)
      skipped.push({ path, reason: 'over-cap' })
      continue
    }
    let buf: Buffer
    try {
      buf = readFileSync(abs)
    } catch {
      if (sensitive) throw new Error(`민감 ignored 파일 백업 실패: ${path}`)
      skipped.push({ path, reason: 'read-failed' })
      continue
    }
    totalBytes += st.size
    entries.set(path, {
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash: createHash('sha256').update(buf).digest('hex'),
      sensitive,
      backup: buf,
    })
  }
  return { entries, skipped }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(workspace): #123-A ignored baseline 캡처(열거·해시·in-memory 백업·캡/민감 hard-stop)"
```

---

## Task 2: `collectIgnoredChanges` — baseline 대비 변경 산출

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`
- Test: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `IgnoredBaseline`, `listIgnored`(내부), `captureIgnoredBaseline`.
- Produces: `IgnoredChange`, `IgnoredChangeSet`, `collectIgnoredChanges(root: string, git: GitRunner, baseline: IgnoredBaseline, policy: ScanPolicy): Promise<IgnoredChangeSet>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ignored-baseline.test.ts
import { collectIgnoredChanges } from './ignored-baseline'
import { rmSync as rmFile } from 'node:fs'

describe('collectIgnoredChanges', () => {
  it('detects created / modified / deleted ignored changes', async () => {
    writeFileSync(join(root, '.env'), 'A=1')          // 기존(수정될 것)
    writeFileSync(join(root, 'keep.key'), 'orig')     // 기존(삭제될 것)
    const baseGit = fakeGitIgnored(['.env', 'keep.key'])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)

    writeFileSync(join(root, '.env'), 'A=2')           // modify
    rmFile(join(root, 'keep.key'))                     // delete
    writeFileSync(join(root, 'new.pem'), 'NEW')        // create
    const curGit = fakeGitIgnored(['.env', 'new.pem']) // keep.key 사라짐, new.pem 등장
    const cs = await collectIgnoredChanges(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    const byPath = Object.fromEntries(cs.changes.map((c) => [c.path, c.change]))
    expect(byPath).toEqual({ '.env': 'modified', 'keep.key': 'deleted', 'new.pem': 'created' })
    expect(cs.changes.find((c) => c.path === 'new.pem')!.sensitive).toBe(true)
  })

  it('surfaces baseline.skipped as unrestorable', async () => {
    writeFileSync(join(root, 'big.dat'), Buffer.alloc(16))
    const git = fakeGitIgnored(['big.dat'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFileBytes: 8 }
    const baseline = await captureIgnoredBaseline(root, git, policy)
    const cs = await collectIgnoredChanges(root, git, baseline, policy)
    expect(cs.unrestorable).toContainEqual({ path: 'big.dat', reason: 'over-cap' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t collectIgnoredChanges`
Expected: FAIL — `collectIgnoredChanges` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ignored-baseline.ts
export interface IgnoredChange {
  path: string
  change: 'created' | 'modified' | 'deleted'
  sensitive: boolean
}
export interface IgnoredChangeSet {
  changes: IgnoredChange[]
  unrestorable: { path: string; reason: string }[]
}

import { existsSync } from 'node:fs'   // (Task1 import 블록에 합쳐 둘 것)

export async function collectIgnoredChanges(
  root: string,
  git: GitRunner,
  baseline: IgnoredBaseline,
  policy: ScanPolicy,
): Promise<IgnoredChangeSet> {
  const { files } = await listIgnored(root, git, policy)
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  const current = new Set(files)
  const changes: IgnoredChange[] = []
  const unrestorable: { path: string; reason: string }[] = [...baseline.skipped]

  // created: 현재 in-scope ignored 인데 baseline 에도 skipped 에도 없음.
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    changes.push({ path, change: 'created', sensitive: policy.sensitiveRe.test(path) })
  }
  // modified / deleted: baseline 엔트리 기준.
  for (const [path, entry] of baseline.entries) {
    const abs = resolve(root, path)
    if (!existsSync(abs) || !current.has(path)) {
      changes.push({ path, change: 'deleted', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    const buf = readFileSync(abs)
    const hash = createHash('sha256').update(buf).digest('hex')
    if (hash !== entry.hash) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
    }
  }
  return { changes, unrestorable }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t collectIgnoredChanges`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(workspace): #123-A collectIgnoredChanges — created/modified/deleted + unrestorable"
```

---

## Task 3: `restoreIgnoredBaseline` + `disposeBaseline`

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`
- Test: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `IgnoredBaseline`, `listIgnored`(내부).
- Produces: `restoreIgnoredBaseline(root: string, git: GitRunner, baseline: IgnoredBaseline, policy: ScanPolicy): Promise<void>`, `disposeBaseline(baseline: IgnoredBaseline): void`.
- 동작: 현재 in-scope ignored 를 재열거 → baseline 에 없는 created 파일 삭제 → baseline 의 modified/deleted(backup 보유분)를 백업에서 복원. (changeSet 불요 — 재유도, catch-before-collect 경로 견고.)

- [ ] **Step 1: Write the failing test**

```ts
// append to ignored-baseline.test.ts
import { readFileSync as readFile } from 'node:fs'
import { restoreIgnoredBaseline, disposeBaseline } from './ignored-baseline'

describe('restoreIgnoredBaseline', () => {
  it('deletes agent-created, restores modified and deleted ignored files', async () => {
    writeFileSync(join(root, '.env'), 'A=1')
    writeFileSync(join(root, 'keep.key'), 'orig')
    const baseGit = fakeGitIgnored(['.env', 'keep.key'])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)

    writeFileSync(join(root, '.env'), 'A=2')        // modified
    rmFile(join(root, 'keep.key'))                  // deleted
    writeFileSync(join(root, 'new.pem'), 'NEW')     // created
    const curGit = fakeGitIgnored(['.env', 'new.pem'])
    await restoreIgnoredBaseline(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    expect(readFile(join(root, '.env')).toString()).toBe('A=1')   // 원복
    expect(readFile(join(root, 'keep.key')).toString()).toBe('orig') // 복구
    expect(existsSync(join(root, 'new.pem'))).toBe(false)         // 제거
  })
})

describe('disposeBaseline', () => {
  it('zeroizes in-memory backup buffers (best-effort)', async () => {
    writeFileSync(join(root, '.env'), 'SECRET')
    const baseline = await captureIgnoredBaseline(root, fakeGitIgnored(['.env']), DEFAULT_IGNORED_POLICY)
    const buf = baseline.entries.get('.env')!.backup!
    disposeBaseline(baseline)
    expect(buf.every((b) => b === 0)).toBe(true)
    expect(baseline.entries.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t restoreIgnoredBaseline`
Expected: FAIL — not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ignored-baseline.ts (import 블록에 existsSync, mkdirSync, rmSync, writeFileSync 추가)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export async function restoreIgnoredBaseline(
  root: string,
  git: GitRunner,
  baseline: IgnoredBaseline,
  policy: ScanPolicy,
): Promise<void> {
  const { files } = await listIgnored(root, git, policy)
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  // 1) created(현재 in-scope, baseline·skipped 둘 다 없음) → 삭제.
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    rmSync(resolve(root, path), { force: true })
  }
  // 2) modified/deleted(backup 보유) → 백업에서 복원.
  for (const [path, entry] of baseline.entries) {
    if (entry.backup === null) continue // unrestorable — 복원 불가(이미 surface 됨)
    const abs = resolve(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, entry.backup)
  }
}

export function disposeBaseline(baseline: IgnoredBaseline): void {
  for (const entry of baseline.entries.values()) {
    if (entry.backup) entry.backup.fill(0) // best-effort zeroize (JS GC/복사본 → 완전삭제 보장 아님)
  }
  baseline.entries.clear()
  baseline.skipped.length = 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS (전체).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(workspace): #123-A restoreIgnoredBaseline(선택 복원) + disposeBaseline(best-effort zeroize)"
```

---

## Task 4: `classifyDiffRisk(diff, ignored?)` 확장

**Files:**
- Modify: `src/main/core/orchestrator/diff-risk.ts`
- Test: `src/main/core/orchestrator/diff-risk.test.ts`

**Interfaces:**
- Consumes: `IgnoredChangeSet`(`../workspace/ignored-baseline`).
- Produces: `classifyDiffRisk(diff: DiffResult, ignored?: IgnoredChangeSet, deleteThreshold?: number): DiffRisk`. (deleteThreshold 가 2번째 인자였으나, ignored 를 2번째로 넣고 deleteThreshold 를 3번째 옵션으로 이동 — 기존 호출부는 `classifyDiffRisk(diff)` 1-인자라 무회귀; `classifyDiffRisk(diff, 10)` 형태 호출부가 있으면 `classifyDiffRisk(diff, undefined, 10)` 로 갱신.)

- [ ] **Step 1: Write the failing test**

```ts
// append to diff-risk.test.ts
import type { IgnoredChangeSet } from '../workspace/ignored-baseline'

describe('classifyDiffRisk with ignored changes', () => {
  const clean = { files: ['src/a.ts'], patch: '+1', truncated: false }
  it('escalates to destructive on sensitive ignored change (path+kind only, no content)', () => {
    const ig: IgnoredChangeSet = { changes: [{ path: '.env', change: 'modified', sensitive: true }], unrestorable: [] }
    const r = classifyDiffRisk(clean, ig)
    expect(r.risk).toBe('destructive')
    const joined = r.reasons.join(' ')
    expect(joined).toContain('.env')
    expect(joined).toContain('modified')
    expect(joined).not.toContain('SECRET') // 내용 비노출
  })
  it('escalates on general in-scope ignored change', () => {
    const ig: IgnoredChangeSet = { changes: [{ path: 'local.cfg', change: 'created', sensitive: false }], unrestorable: [] }
    expect(classifyDiffRisk(clean, ig).risk).toBe('destructive')
  })
  it('escalates on unrestorable entries', () => {
    const ig: IgnoredChangeSet = { changes: [], unrestorable: [{ path: 'big.dat', reason: 'over-cap' }] }
    const r = classifyDiffRisk(clean, ig)
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('복원 불가')
  })
  it('no ignored changes → behaves as before (caution)', () => {
    expect(classifyDiffRisk(clean, { changes: [], unrestorable: [] }).risk).toBe('caution')
    expect(classifyDiffRisk(clean).risk).toBe('caution')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/orchestrator/diff-risk.test.ts`
Expected: FAIL — `classifyDiffRisk` 가 2번째 인자로 ignored 를 받지 않음.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/core/orchestrator/diff-risk.ts — 전체 교체
import type { RiskLevel } from '../../../shared/types'
import type { IgnoredChangeSet } from '../workspace/ignored-baseline'
import { SENSITIVE_FILE } from '../safety/approval'
import type { DiffResult } from '../workspace/git'

export interface DiffRisk {
  risk: RiskLevel
  reasons: string[]
}

/** diff 위험 분류: 민감 파일·대량 삭제·diff 절단 + ignored 변경 → destructive, 그 외 → caution. */
export function classifyDiffRisk(
  diff: DiffResult,
  ignored?: IgnoredChangeSet,
  deleteThreshold = 5,
): DiffRisk {
  const reasons: string[] = []
  const sensitive = diff.files.filter((f) => SENSITIVE_FILE.test(f))
  if (sensitive.length > 0) reasons.push(`민감 파일 변경: ${sensitive.join(', ')}`)
  const deletions = (diff.patch.match(/^deleted file mode/gm) ?? []).length
  if (deletions > deleteThreshold) reasons.push(`대량 삭제 ${deletions}건`)
  if (diff.truncated) reasons.push('diff 절단(전체 검증 불가)')

  if (ignored) {
    for (const c of ignored.changes) {
      const label = c.sensitive ? '민감 ignored 변경' : 'ignored 변경'
      reasons.push(`${label}: ${c.path} (${c.change})`) // 경로·종류만, 내용 비노출
    }
    if (ignored.unrestorable.length > 0)
      reasons.push(`복원 불가 ignored ${ignored.unrestorable.length}건: ${ignored.unrestorable.map((u) => u.path).join(', ')}`)
  }
  return { risk: reasons.length > 0 ? 'destructive' : 'caution', reasons }
}
```

- [ ] **Step 4: Run tests (diff-risk 전체 — 기존 호출부 시그니처 확인)**

Run: `npx vitest run src/main/core/orchestrator/diff-risk.test.ts`
Expected: PASS. 기존 테스트의 `classifyDiffRisk(diff, 10)` 호출은 `classifyDiffRisk(diff, undefined, 10)` 로 갱신(2개소: 'flags bulk deletions', deleteThreshold 사용처). 갱신 후 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/orchestrator/diff-risk.ts src/main/core/orchestrator/diff-risk.test.ts
git commit -m "feat(orchestrator): #123-A classifyDiffRisk 에 ignored change 입력 추가(경로·종류만)"
```

---

## Task 5: `Workspace` 3 메서드 + createWorkspace 배선

**Files:**
- Modify: `src/main/core/workspace/git.ts` (인터페이스 `:37-46`, createWorkspace return `:113-217`)
- Test: `src/main/core/workspace/git.test.ts`

**Interfaces:**
- Consumes: `captureIgnoredBaseline`/`collectIgnoredChanges`/`restoreIgnoredBaseline`/`DEFAULT_IGNORED_POLICY`(`./ignored-baseline`).
- Produces: `Workspace.captureIgnoredBaseline(): Promise<IgnoredBaseline>`, `Workspace.collectIgnoredChanges(baseline): Promise<IgnoredChangeSet>`, `Workspace.restoreIgnoredBaseline(baseline): Promise<void>`. (worktree 도 `createWorkspace(wtPath, git)` 로 생성되므로 자동 상속.)

- [ ] **Step 1: Write the failing test**

```ts
// append to git.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('createWorkspace ignored baseline methods', () => {
  it('captures, detects, and restores ignored changes on a real temp workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-ws-ign-'))
    try {
      writeFileSync(join(root, '.env'), 'A=1')
      // fakeGit: status --ignored 만 캔드 응답, 그 외 0.
      const g = fakeGit()
      g.setReply((args) => {
        if (args[0] === 'status' && args.includes('--ignored'))
          return { code: 0, stdout: '!! .env\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      })
      const ws = createWorkspace(root, g.runner)
      const baseline = await ws.captureIgnoredBaseline()
      expect(baseline.entries.get('.env')?.sensitive).toBe(true)

      writeFileSync(join(root, '.env'), 'A=2')
      const cs = await ws.collectIgnoredChanges(baseline)
      expect(cs.changes).toContainEqual({ path: '.env', change: 'modified', sensitive: true })

      await ws.restoreIgnoredBaseline(baseline)
      expect(readFileSync(join(root, '.env')).toString()).toBe('A=1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
```
(파일 상단에 `import { readFileSync } from 'node:fs'` 추가.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/workspace/git.test.ts -t "ignored baseline methods"`
Expected: FAIL — `ws.captureIgnoredBaseline` is not a function.

- [ ] **Step 3: Write minimal implementation**

```ts
// git.ts 상단 import 추가
import {
  captureIgnoredBaseline as captureIgnored,
  collectIgnoredChanges as collectIgnored,
  restoreIgnoredBaseline as restoreIgnored,
  DEFAULT_IGNORED_POLICY,
  type IgnoredBaseline,
  type IgnoredChangeSet,
} from './ignored-baseline'
```

```ts
// git.ts: Workspace 인터페이스(:37-46)에 3 메서드 추가
export interface Workspace {
  ensureRepo(): Promise<void>
  checkpoint(): Promise<string>
  collectDiff(base: string): Promise<DiffResult>
  keep(message: string): Promise<string>
  revert(base: string): Promise<void>
  addWorktree(taskId: string, base: string): Promise<TaskWorktree>
  integrate(keepCommit: string): Promise<{ ok: boolean; conflict?: string }>
  removeWorktree(taskId: string): Promise<void>
  captureIgnoredBaseline(): Promise<IgnoredBaseline>
  collectIgnoredChanges(baseline: IgnoredBaseline): Promise<IgnoredChangeSet>
  restoreIgnoredBaseline(baseline: IgnoredBaseline): Promise<void>
}
```

```ts
// git.ts: createWorkspace return 객체(:113~)에 3 메서드 추가(removeWorktree 뒤)
    async captureIgnoredBaseline() {
      return captureIgnored(root, git, DEFAULT_IGNORED_POLICY)
    },
    async collectIgnoredChanges(baseline) {
      return collectIgnored(root, git, baseline, DEFAULT_IGNORED_POLICY)
    },
    async restoreIgnoredBaseline(baseline) {
      return restoreIgnored(root, git, baseline, DEFAULT_IGNORED_POLICY)
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/workspace/git.test.ts`
Expected: PASS(기존 + 신규).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspace/git.ts src/main/core/workspace/git.test.ts
git commit -m "feat(workspace): #123-A Workspace 에 ignored baseline 3 메서드(순차·worktree 공용)"
```

---

## Task 6: `rollbackWithIgnored` 헬퍼 + `runTaskIn` 배선

**Files:**
- Create: `src/main/core/orchestrator/ignored-guard.ts`
- Test: `src/main/core/orchestrator/ignored-guard.test.ts`
- Modify: `src/main/core/orchestrator/orchestrator.ts` (`runTaskIn` `:238-374`)
- Modify: `src/main/core/orchestrator/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Workspace`(`../workspace/git`), `IgnoredBaseline`(`../workspace/ignored-baseline`).
- Produces: `rollbackWithIgnored(ws: Pick<Workspace,'revert'|'restoreIgnoredBaseline'>, base: string, baseline: IgnoredBaseline | null): Promise<string>` — tracked `revert(base)` → `restoreIgnoredBaseline(baseline)` 순서, 실패 누적 노트 반환(빈 문자열=성공). (기존 `revertSafely` 의 ignored-aware 일반화.)

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/orchestrator/ignored-guard.test.ts
import { describe, expect, it, vi } from 'vitest'
import { rollbackWithIgnored } from './ignored-guard'

describe('rollbackWithIgnored', () => {
  it('reverts tracked first, then restores ignored, returns empty note on success', async () => {
    const order: string[] = []
    const ws = {
      revert: vi.fn(async () => { order.push('revert') }),
      restoreIgnoredBaseline: vi.fn(async () => { order.push('restore') }),
    }
    const note = await rollbackWithIgnored(ws, 'base', { entries: new Map(), skipped: [] } as never)
    expect(order).toEqual(['revert', 'restore'])
    expect(note).toBe('')
  })
  it('accumulates failures from both revert and restore (no silent swallow)', async () => {
    const ws = {
      revert: vi.fn(async () => { throw new Error('revert boom') }),
      restoreIgnoredBaseline: vi.fn(async () => { throw new Error('restore boom') }),
    }
    const note = await rollbackWithIgnored(ws, 'base', { entries: new Map(), skipped: [] } as never)
    expect(note).toContain('revert boom')
    expect(note).toContain('restore boom')
  })
  it('skips ignored restore when baseline is null (still reverts tracked)', async () => {
    const ws = { revert: vi.fn(async () => {}), restoreIgnoredBaseline: vi.fn(async () => {}) }
    await rollbackWithIgnored(ws, 'base', null)
    expect(ws.revert).toHaveBeenCalled()
    expect(ws.restoreIgnoredBaseline).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/orchestrator/ignored-guard.test.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/core/orchestrator/ignored-guard.ts
import type { Workspace } from '../workspace/git'
import type { IgnoredBaseline } from '../workspace/ignored-baseline'

/**
 * 거부·실패·취소 경로의 rollback: tracked revert → ignored 선택 복원(순서 고정).
 * 어느 쪽이 실패해도 흡수하지 않고 노트로 누적해 호출자가 task output/event 에 표면화한다(#7).
 * @returns 실패 노트(없으면 ''), 호출자가 출력에 덧붙이는 용도.
 */
export async function rollbackWithIgnored(
  ws: Pick<Workspace, 'revert' | 'restoreIgnoredBaseline'>,
  base: string,
  baseline: IgnoredBaseline | null,
): Promise<string> {
  const notes: string[] = []
  try {
    await ws.revert(base)
  } catch (err) {
    notes.push(` (revert 실패: ${err instanceof Error ? err.message : String(err)})`)
  }
  if (baseline) {
    try {
      await ws.restoreIgnoredBaseline(baseline)
    } catch (err) {
      notes.push(` (ignored 복원 실패: ${err instanceof Error ? err.message : String(err)})`)
    }
  }
  return notes.join('')
}
```

- [ ] **Step 4: Run helper test (PASS)**

Run: `npx vitest run src/main/core/orchestrator/ignored-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `runTaskIn` (orchestrator.ts)**

`runTaskIn` 내부 편집(완전 적용):
1. import 추가: `import { rollbackWithIgnored } from './ignored-guard'` + `import type { IgnoredBaseline } from '../workspace/ignored-baseline'`.
2. `const base = await ws.checkpoint()` (`:238`) 직후:
```ts
    const base = await ws.checkpoint()
    store.updateTask(task.id, { checkpoint: base })
    let ignoredBaseline: IgnoredBaseline | null = null
    try {
      ignoredBaseline = await ws.captureIgnoredBaseline()
    } catch (err) {
      // 민감 ignored 백업 실패 = hard-stop. tracked 변경 없음이므로 revert 만.
      const note = await rollbackWithIgnored(ws, base, null)
      store.updateTask(task.id, {
        status: 'failed',
        output: `민감 ignored 백업 실패: ${err instanceof Error ? err.message : String(err)}${note}`,
      })
      store.appendEvent({ type: 'task.failed', data: { taskId: task.id } })
      emit({ type: 'task.failed', message: `${task.title}: 민감 ignored 백업 실패`, data: { taskId: task.id } })
      failed.add(task.id)
      return undefined
    }
    try {
```
   (기존 `try {` 를 위 capture 블록 다음으로 이동 — 본문 try 는 그대로, 아래 `finally` 추가.)
3. `diff = await ws.collectDiff(base)` (`:258`) 직후 + `classifyDiffRisk` 교체:
```ts
        diff = await ws.collectDiff(base)
        const ignoredChanges = await ws.collectIgnoredChanges(ignoredBaseline)
        store.updateTask(task.id, { status: 'review', changedFiles: diff.files })
        emit({ type: 'task.implemented', message: `구현 완료 (라운드 ${round + 1}, 변경 ${diff.files.length}개)`, data: { taskId: task.id, round } })
        if (ignoredChanges.changes.length > 0 || ignoredChanges.unrestorable.length > 0) {
          store.appendEvent({
            type: 'workspace.ignored_changes',
            data: {
              taskId: task.id,
              changes: ignoredChanges.changes.map((c) => ({ path: c.path, change: c.change, sensitive: c.sensitive })),
              unrestorable: ignoredChanges.unrestorable.map((u) => u.path),
            },
          })
        }
        const dr = classifyDiffRisk(diff, ignoredChanges)
```
4. 승인 거부 경로(`:277-291`)의 `await ws.revert(base)` 를 교체:
```ts
          if (decision !== 'approved') {
            const note = await rollbackWithIgnored(ws, base, ignoredBaseline)
            store.updateTask(task.id, { status: 'failed', output: `위험 변경 미승인: ${dr.reasons.join('; ')}${note}`, changedFiles: [] })
            emit({ type: 'task.failed', message: `${task.title}: 위험 변경 미승인`, data: { taskId: task.id } })
            failed.add(task.id)
            return undefined
          }
```
5. reviewer reject 경로(`:317`)의 `await ws.revert(base)` → `await rollbackWithIgnored(ws, base, ignoredBaseline)` (반환 노트는 재시도 경로라 무시 가능, 단 변수 할당 없이 호출).
6. 한도초과(`:321`)의 `await ws.revert(base)` → `const note = await rollbackWithIgnored(ws, base, ignoredBaseline)` 후 output 에 `${note}` 덧붙임.
7. catch 블록(`:353`)의 `const revertNote = await revertSafely(ws, base)` → `const revertNote = await rollbackWithIgnored(ws, base, ignoredBaseline)` (revertSafely 대체).
8. **finally 추가** — done 반환·모든 return 경로 후 baseline 폐기. 본문 try 에 finally 추가:
```ts
    } catch (err) {
      // ...기존 catch (revertSafely → rollbackWithIgnored 로 교체됨)...
    } finally {
      if (ignoredBaseline) disposeBaseline(ignoredBaseline)
    }
```
   (`import { disposeBaseline } from '../workspace/ignored-baseline'` 추가.)
9. **worktree 비통합 감사**: 병렬 경로(`runTaskIn` 이 worktree ws 로 호출될 때) keep 직전, ignoredChanges 가 있으면 감사 이벤트에 `integrated: false` 표기는 위 `workspace.ignored_changes` 이벤트로 충분(worktree 는 removeWorktree 로 폐기, main 미통합). 별도 코드 불요 — 이벤트 data 에 worktree 여부 구분은 후속.

- [ ] **Step 6: Integration tests (orchestrator) — 회귀 1·2·4**

```ts
// orchestrator.test.ts 에 추가(기존 테스트의 workspace mock 패턴 따름).
// 핵심: ws mock 에 captureIgnoredBaseline/collectIgnoredChanges/restoreIgnoredBaseline 추가.
// 1) 기존 .env 수정 후 승인 거부 → restore 호출됨 + reason 에 .env(modified), 내용 미노출.
// 2) 새 ignored secret 생성 후 실패 → restore 호출(created 삭제).
// 4) tracked + ignored 혼합 → gate 가 호출되고 reason 에 양쪽 포함.
// (실제 단언은 기존 orchestrator.test.ts 의 fake workspace·gate·session 헬퍼 재사용.)
```
구현 시 기존 `orchestrator.test.ts` 의 fake `Workspace`/`gate` 빌더에 신규 3 메서드를 추가하고, gate 가 destructive 로 호출되는지 + 거부 시 `restoreIgnoredBaseline` 가 호출되는지 spy 로 검증한다.

- [ ] **Step 7: Run + Commit**

Run: `npx vitest run src/main/core/orchestrator`
Expected: PASS.
```bash
git add src/main/core/orchestrator/ignored-guard.ts src/main/core/orchestrator/ignored-guard.test.ts src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "feat(orchestrator): #123-A runTaskIn 에 ignored baseline/risk/rollback 배선 + rollbackWithIgnored"
```

---

## Task 7: verify-fix 루프 배선 + 회귀 3·5·6·7 + brain + 전체 게이트

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts` (verify-fix 루프 `:704-740`)
- Modify: `src/main/core/orchestrator/orchestrator.test.ts`

**Interfaces:**
- Consumes: `rollbackWithIgnored`, `ws.captureIgnoredBaseline/collectIgnoredChanges`, `disposeBaseline`, `classifyDiffRisk(diff, ignored)`.

- [ ] **Step 1: Wire verify-fix loop (orchestrator.ts:704-740)**

`const base = await opts.workspace.checkpoint()`(`:707`) 직후 capture + try/finally dispose, `collectDiff` 후 collect + `classifyDiffRisk(diff, ignoredChanges)`, 미승인/예외 경로 `rollbackWithIgnored(opts.workspace, base, ignoredBaseline)`:
```ts
      const base = await opts.workspace.checkpoint()
      let vfBaseline: IgnoredBaseline | null = null
      try {
        vfBaseline = await opts.workspace.captureIgnoredBaseline()
      } catch (err) {
        emit({ type: 'verify.fixing', message: `민감 ignored 백업 실패로 수정 중단: ${err instanceof Error ? err.message : String(err)}`, data: { projectId: project.id, round } })
        break
      }
      try {
        await fixImplementer.send(buildVerifyFixPrompt(goal, failing), { fresh: true, /* 기존 opts */ })
        const diff = await opts.workspace.collectDiff(base)
        const ignoredChanges = await opts.workspace.collectIgnoredChanges(vfBaseline)
        const dr = classifyDiffRisk(diff, ignoredChanges)
        if (dr.risk === 'destructive') {
          const decision = opts.gate ? await opts.gate.request({ kind: 'apply-diff', summary: 'verify-fix 변경 적용', target: diff.files.join(', '), risk: 'destructive' }) : 'rejected'
          if (decision !== 'approved') {
            const note = await rollbackWithIgnored(opts.workspace, base, vfBaseline)
            emit({ type: 'verify.fixing', message: `수정 위험 변경 미승인: ${dr.reasons.join('; ')}${note}`, data: { projectId: project.id, round } })
            break
          }
        }
        await opts.workspace.keep(`[verify-fix r${round}]`)
      } catch (err) {
        const revertNote = await rollbackWithIgnored(opts.workspace, base, vfBaseline)
        // ...기존 수정 실패 표면화에 revertNote 사용...
      } finally {
        if (vfBaseline) disposeBaseline(vfBaseline)
      }
```
(기존 `revertSafely(opts.workspace, base)` 호출을 `rollbackWithIgnored` 로 교체.)

- [ ] **Step 2: Integration tests — 회귀 3·5·6·7**

```ts
// orchestrator.test.ts 추가:
// 3) ignored 삭제 후 취소(abort signal) → restore 호출(deleted 복구) + skipped 라벨.
// 5) 대형 ignored(unrestorable) → gate destructive 호출, reason '복원 불가' 포함.
// 6) 백업 후 예외/abort → finally 에서 disposeBaseline 호출(spy)·Buffer zeroize.
// 7) 병렬 worktree(canParallel) 경로: worktree ws mock 의 ignored 메서드가 호출되고,
//    removeWorktree 후 잔여 0(메인 ws 는 ignored 변경 없음) + workspace.ignored_changes 이벤트 방출.
```
verify-fix 의 capture 실패(민감) 경로도 1건 추가(`captureIgnoredBaseline` reject → 'break' + 이벤트).

- [ ] **Step 3: Run orchestrator tests**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 4: Regenerate brain + full gates**

Run:
```bash
npm run brain
npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build
```
Expected: 전부 green. (brain.md diff 가 신규 모듈/메서드 반영.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(orchestrator): #123-A verify-fix 루프 ignored 가드 배선 + 회귀 3·5·6·7 + brain"
```

---

## Self-Review

**Spec coverage:** 스펙 §3 모듈=Task1-3 · §4 API=Task1-5 · §5 데이터흐름=Task6-7 · §6 위험표면=Task4 · §7 fail-closed(민감 throw=Task1·unrestorable=Task2·rollback 노트=Task6·dispose=Task3) · §8 정책기본값=Task1 · §9 테스트 회귀1-7=Task6-7. 전부 매핑됨.
**Placeholder scan:** 코드 step 은 전부 완전 코드. Task6 Step6·Task7 Step2 통합테스트는 "기존 fake workspace/gate 빌더 재사용" 지시 — 구현자가 기존 `orchestrator.test.ts` 헬퍼를 봐야 하므로 의도된 위임(실제 단언 항목 명시).
**Type consistency:** `captureIgnoredBaseline(root,git,policy)`·`collectIgnoredChanges(root,git,baseline,policy)`·`restoreIgnoredBaseline(root,git,baseline,policy)`·`disposeBaseline(baseline)`·`classifyDiffRisk(diff,ignored?,deleteThreshold?)`·`rollbackWithIgnored(ws,base,baseline)` — Task 간 시그니처 일치 확인. Workspace 메서드는 policy/git 를 closure 바인딩해 무인자/baseline-만.
**리스크 노트:** Task4 의 deleteThreshold 인자 위치 이동(2→3)은 기존 호출부 갱신 필요(diff-risk.test.ts 2개소 + orchestrator 의 `classifyDiffRisk(diff)` 호출은 1-인자라 무영향). Task4 Step4 에 명시.

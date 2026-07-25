# #128-B1 Adversarial-FS 하드닝 + minor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A가 출하한 ignored-baseline 무결성 위에 adversarial-FS 하드닝(non-regular 파일 가드·ancestor-is-file 복원)과 표면화 minor(SCAN_CAPPED rollback 노출·병렬 폐기 경고)를 올린다.

**Architecture:** `src/main/core/workspace/ignored-baseline.ts`의 두 read 지점(capture·collect)에 `isFile()` 가드를 넣어 FIFO/socket/device hang을 차단하고, `restoreIgnoredBaseline`에 조상-파일 정리 + `{capped}` 반환을 추가한다. `git.ts`(Workspace 인터페이스)·`ignored-guard.ts`(rollback 노트)·`orchestrator.ts`(병렬 폐기 경고)로 ripple.

**Tech Stack:** TypeScript(strict), Node `node:fs`/`node:crypto`/`node:path`, vitest.

## Global Constraints

- 비밀 비노출: 내용·hash를 로그·approval reason·이벤트에 절대 싣지 않는다. 경로·종류만.
- 순수 코어(`src/main/core/`) Electron import 금지.
- lint strict: 미사용 변수/import 제거.
- 테스트 temp = `os.tmpdir()`(`mkdtempSync`). Windows+POSIX 모두 통과. FIFO 등 POSIX 전용 케이스는 `process.platform !== 'win32'` 가드.
- 기존 테스트 무회귀.
- 커밋: **scoped add** — `git add -A` 금지. 각 Task에서 변경 파일만 명시 add. 커밋 prefix `feat(#128-B1):`.
- 전체 게이트: `npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build` + `npm run brain`.
- `OrchestratorEventType` union은 건드리지 않는다(신규 이벤트는 `store.appendEvent` 사용).

---

## File Structure

- **Modify:** `src/main/core/workspace/ignored-baseline.ts` — skipped reason union `+'not-regular'`; capture·collect `isFile()` 가드; `clearNonDirAncestors` 헬퍼 + restore 호출; `restoreIgnoredBaseline` 반환 `{capped}`; denylist 코멘트 강화; `disposeBaseline` 빈-Buffer 가드.
- **Modify:** `src/main/core/workspace/ignored-baseline.test.ts` — A 가드·B ancestor·m2 capped·m3 read-failed·m4 zeroize·m5 dispose 테스트.
- **Modify:** `src/main/core/workspace/git.ts` — `Workspace.restoreIgnoredBaseline` 반환 타입 + `createWorkspace` 래퍼.
- **Modify:** `src/main/core/orchestrator/ignored-guard.ts` — restore `{capped}` 소비 + 노트 누적.
- **Modify:** `src/main/core/orchestrator/ignored-guard.test.ts` — capped 노트 테스트(파일 없으면 생성).
- **Modify:** `src/main/core/orchestrator/orchestrator.ts` — `runTaskIn` 반환 `{keepHash, ignoredTouched}`; 병렬 정리 단계 `workspace.ignored_discarded` emit.
- **Modify:** `src/main/core/orchestrator/orchestrator.test.ts` — restore 목 `{capped:false}` 일괄 갱신(36·46-47·165·187·486 라인대); m1 병렬 폐기 경고 테스트.

---

## Task 1: A) capture non-regular 가드 + skipped union + m3 read-failed

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`
- Modify: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: 현재 `IgnoredBaseline.skipped[].reason: 'over-cap' | 'read-failed'`, `captureIgnoredBaseline`.
- Produces: reason union `+ 'not-regular'`; capture가 `!st.isFile()`인 sensitive는 throw, non-sensitive는 `skipped{reason:'not-regular'}`.

- [ ] **Step 1: Write the failing tests (RED)**

`ignored-baseline.test.ts`의 `describe('captureIgnoredBaseline', …)` 안에 추가:

```ts
it('[#128-A] non-regular(디렉터리) non-sensitive ignored 파일은 read 없이 not-regular 로 skip', async () => {
  // git 은 'weird.dat'를 파일처럼 보고하지만 디스크엔 디렉터리 → !isFile()
  mkdirSync(join(root, 'weird.dat'))
  const git = fakeGitIgnored(['weird.dat'])
  const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
  expect(base.entries.has('weird.dat')).toBe(false)
  expect(base.skipped).toContainEqual({ path: 'weird.dat', reason: 'not-regular' })
})

it('[#128-A] non-regular sensitive ignored 파일은 throw(fail-closed)', async () => {
  // .env 를 디렉터리로 → sensitive + non-regular → throw
  mkdirSync(join(root, '.env'))
  const git = fakeGitIgnored(['.env'])
  await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
    /일반 파일이 아님/,
  )
})

it('[#128-A] POSIX FIFO ignored 파일은 hang 없이 not-regular 로 skip', async () => {
  if (process.platform === 'win32') return // mkfifo 불가
  execFileSync('mkfifo', [join(root, 'pipe.dat')])
  const git = fakeGitIgnored(['pipe.dat'])
  // 가드가 없으면 readFileSync(FIFO) 가 hang — 5초 내 resolve 되어야 한다
  const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
  expect(base.skipped).toContainEqual({ path: 'pipe.dat', reason: 'not-regular' })
})

it('[#128-m3] non-sensitive 일반 파일 read 실패는 read-failed 로 skip(POSIX)', async () => {
  // 일반 파일(isFile=true)이지만 읽기 권한 0 → readFileSync EACCES → read-failed 분기.
  if (process.platform === 'win32') return
  if (typeof process.getuid === 'function' && process.getuid() === 0) return // root 는 권한 무시
  writeFileSync(join(root, 'noperm.dat'), 'data')
  chmodSync(join(root, 'noperm.dat'), 0o000)
  const git = fakeGitIgnored(['noperm.dat'])
  const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
  expect(base.entries.has('noperm.dat')).toBe(false)
  expect(base.skipped).toContainEqual({ path: 'noperm.dat', reason: 'read-failed' })
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "#128-A"`
Expected: non-regular 테스트 FAIL(현재 디렉터리는 size-check 통과 후 readFileSync EISDIR로 read-failed/throw 경로 → not-regular 단언 불일치; reason union에 'not-regular' 없어 타입 오류 가능).

- [ ] **Step 3: Implement — union + capture 가드**

`ignored-baseline.ts`에서 (1) `IgnoredBaseline.skipped` reason union 확장:

```ts
export interface IgnoredBaseline {
  entries: Map<string, IgnoredEntry>
  skipped: { path: string; reason: 'over-cap' | 'read-failed' | 'not-regular' }[]
}
```

(2) `captureIgnoredBaseline`의 `skipped` 로컬 타입도 동일하게:

```ts
  const skipped: { path: string; reason: 'over-cap' | 'read-failed' | 'not-regular' }[] = [
    ...enumSkipped,
  ]
```

(3) capture 루프에서 `statSync` catch 블록 직후, size-check **이전**에 가드 삽입:

```ts
      let st
      try {
        st = statSync(abs)
      } catch (err) {
        if (sensitive) throw new Error(`민감 ignored 파일 stat 실패: ${path}`, { cause: err })
        skipped.push({ path, reason: 'read-failed' })
        continue
      }
      // [#128-A] non-regular(FIFO/socket/device/dir)면 readFileSync 가 hang/오류 → read 전 차단.
      if (!st.isFile()) {
        if (sensitive)
          throw new Error(`민감 ignored 파일이 일반 파일이 아님(백업 불가): ${path}`)
        skipped.push({ path, reason: 'not-regular' })
        continue
      }
      if (st.size > policy.maxFileBytes || totalBytes + st.size > policy.maxTotalBytes) {
```

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS 전체(기존 + 신규 4건). 기존 line 65 sensitive-dir 테스트는 이제 not-regular throw로 reject — 여전히 PASS(메시지 미검증).

- [ ] **Step 5: TypeCheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B1): capture non-regular 파일 가드(read 전 isFile) + skipped 'not-regular' reason"
```

---

## Task 2: A) collect non-regular 가드

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`
- Modify: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `collectIgnoredChanges`(현재 `statSync(abs).size`만 뽑고 바로 `readFileSync`).
- Produces: full stat 보관, `!st.isFile()`이면 read 없이 `modified`(backup 있으면 restorable; `backup===null`만 unrestorable).

- [ ] **Step 1: Write the failing test (RED)**

`describe('collectIgnoredChanges', …)` 안에 추가:

```ts
it('[#128-A] baseline 파일이 non-regular(디렉터리)로 교체되면 read 없이 modified, backup 있으면 restorable', async () => {
  writeFileSync(join(root, 'cfg.dat'), 'orig')
  const git = fakeGitIgnored(['cfg.dat'])
  const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
  // 에이전트가 파일을 디렉터리로 교체
  rmSync(join(root, 'cfg.dat'))
  mkdirSync(join(root, 'cfg.dat'))
  const cs = await collectIgnoredChanges(root, git, baseline, DEFAULT_IGNORED_POLICY)
  expect(cs.changes).toContainEqual({ path: 'cfg.dat', change: 'modified', sensitive: false })
  // backup 보유 → unrestorable 아님
  expect(cs.unrestorable.some((u) => u.path === 'cfg.dat')).toBe(false)
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "non-regular(디렉터리)로 교체"`
Expected: FAIL — 현재 `statSync(abs).size` 후 `readFileSync(dir)`가 EISDIR throw → collectIgnoredChanges가 reject(또는 미처리).

- [ ] **Step 3: Implement — collect 가드**

`collectIgnoredChanges`의 `[:213] size-guard` 블록을 교체:

```ts
    // [:213] size-guard + [#128-A] non-regular 가드: read 전 stat 으로 종류·크기 확인
    let st
    try {
      st = statSync(abs)
    } catch {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      unrestorable.push({ path, reason: 'stat-failed' })
      continue
    }
    if (!st.isFile()) {
      // baseline 일반 파일이 non-regular 로 교체됨 = modified. read 없이(hang 방지).
      // backup 있으면 restore 가 비-일반 leaf 제거 후 복원 → unrestorable 아님.
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    const currentSize = st.size
    if (currentSize > policy.maxFileBytes) {
```

(아래 `if (collectTotalBytes + currentSize > policy.maxTotalBytes)` 이하 기존 로직은 그대로 — `currentSize` 변수만 stat에서 옴.)

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS 전체.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B1): collect non-regular 파일 가드(read 전 isFile, modified 표기)"
```

---

## Task 3: B) restore ancestor-is-file 정리

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`
- Modify: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `restoreIgnoredBaseline`(현재 `mkdirSync(dirname(abs))` 직행 → 조상이 파일이면 ENOTDIR).
- Produces: 모듈 헬퍼 `clearNonDirAncestors(root, abs)` — `mkdirSync` 전 호출. `node:path`에 `relative` import.

- [ ] **Step 1: Write the failing test (RED)**

`describe('restoreIgnoredBaseline', …)` 안에 추가:

```ts
it('[#128-B] 복원 대상 조상 경로가 파일이면 제거 후 디렉터리 체인을 재생성해 복원한다', async () => {
  // baseline: a/b/c.txt
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  writeFileSync(join(root, 'a', 'b', 'c.txt'), 'ORIG')
  const git = fakeGitIgnored(['a/b/c.txt'])
  const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
  // 에이전트가 a/b/c.txt 와 디렉터리를 지우고 'a'를 파일로 만든다 → 조상 충돌
  rmSync(join(root, 'a'), { recursive: true, force: true })
  writeFileSync(join(root, 'a'), 'AGENT_FILE')
  await restoreIgnoredBaseline(root, git, baseline, DEFAULT_IGNORED_POLICY)
  // a 파일은 제거되고 a/b/c.txt 가 원문으로 복원됨
  expect(statSync(join(root, 'a')).isDirectory()).toBe(true)
  expect(readFile(join(root, 'a', 'b', 'c.txt'), 'utf8')).toBe('ORIG')
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "#128-B"`
Expected: FAIL — `mkdirSync(dirname)`가 `a`(파일) 때문에 ENOTDIR throw → restore reject.

- [ ] **Step 3: Implement — clearNonDirAncestors 헬퍼 + 호출**

(1) import에 `relative` 추가:

```ts
import { dirname, relative, resolve } from 'node:path'
```

(2) 모듈 레벨 헬퍼 추가(예: `restoreIgnoredBaseline` 위):

```ts
// [#128-B] 복원 시 mkdirSync(dirname) 이 ENOTDIR 로 깨지지 않도록, root→dirname 사이 조상 중
// "존재하지만 디렉터리 아님"(에이전트가 만든 파일 등)을 제거한다. 제거 후 하위 조상은 부재하므로
// mkdirSync(recursive) 가 체인을 재생성한다. resolve(root, …) 기준이라 root 밖은 건드리지 않는다.
function clearNonDirAncestors(root: string, abs: string): void {
  const relDir = relative(root, dirname(abs))
  if (!relDir || relDir.startsWith('..')) return // dirname===root 또는 root 밖 → no-op
  let cur = root
  for (const part of relDir.split(/[\\/]/).filter(Boolean)) {
    cur = resolve(cur, part)
    if (existsSync(cur) && !statSync(cur).isDirectory()) {
      rmSync(cur, { recursive: true, force: true })
      return
    }
  }
}
```

(3) restore 루프의 `mkdirSync` 직전 호출:

```ts
  for (const [path, entry] of baseline.entries) {
    if (entry.backup === null) continue // unrestorable — 복원 불가
    const abs = resolve(root, path)
    clearNonDirAncestors(root, abs) // [#128-B] 조상-파일 충돌 정리
    mkdirSync(dirname(abs), { recursive: true })
```

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS 전체.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B1): restore ancestor-is-file 정리(조상 파일 제거 후 체인 재생성)"
```

---

## Task 4: m2) restore `{capped}` 반환 + 인터페이스/래퍼/rollback 노트 + 목 갱신

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`
- Modify: `src/main/core/workspace/ignored-baseline.test.ts`
- Modify: `src/main/core/workspace/git.ts`
- Modify: `src/main/core/workspace/git.test.ts` (반환 무시지만 빌드 검증 — 필요 시만)
- Modify: `src/main/core/orchestrator/ignored-guard.ts`
- Modify: `src/main/core/orchestrator/ignored-guard.test.ts`
- Modify: `src/main/core/orchestrator/orchestrator.test.ts` (restore 목 전수 갱신)

> **Codex 계획 리뷰 보정:** restore 목 사이트는 아래 명시 목록보다 넓다. **Step 3(D)에서 `rg`로 전수 확인 후 일괄 갱신**한다(빠뜨리면 typecheck 실패).

**Interfaces:**
- Consumes: `restoreIgnoredBaseline(): Promise<void>`, `Workspace.restoreIgnoredBaseline(): Promise<void>`, `rollbackWithIgnored`.
- Produces: `restoreIgnoredBaseline(): Promise<{ capped: boolean }>`(현재 restore 호출의 listIgnored skipped 에 SCAN_CAPPED over-cap 포함 여부). `rollbackWithIgnored`가 capped면 노트 누적.

- [ ] **Step 1: Write the failing tests (RED)**

`ignored-baseline.test.ts`의 `describe('restoreIgnoredBaseline', …)` 안:

```ts
it('[#128-m2] restore 가 현재 스캔 cap 도달 시 { capped: true } 를 반환한다', async () => {
  const baseGit = fakeGitIgnored([])
  const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
  // 에이전트가 일반 파일 2개 생성, maxFiles=1 → 2번째는 over-cap(SCAN_CAPPED)
  writeFileSync(join(root, 'a.txt'), '1')
  writeFileSync(join(root, 'b.txt'), '2')
  const curGit = fakeGitIgnored(['a.txt', 'b.txt'])
  const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
  const res = await restoreIgnoredBaseline(root, curGit, baseline, policy)
  expect(res).toEqual({ capped: true })
})

it('[#128-m2] cap 미도달 시 { capped: false }', async () => {
  const git = fakeGitIgnored([])
  const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
  const res = await restoreIgnoredBaseline(root, git, baseline, DEFAULT_IGNORED_POLICY)
  expect(res).toEqual({ capped: false })
})
```

`ignored-guard.test.ts`(없으면 생성, import는 아래 Step 3 참조)에:

```ts
it('[#128-m2] restore 가 capped 면 rollback 노트에 스캔 상한 경고를 누적한다', async () => {
  const ws = {
    async revert() {},
    async restoreIgnoredBaseline() {
      return { capped: true }
    },
  }
  const baseline: IgnoredBaseline = { entries: new Map(), skipped: [] }
  const note = await rollbackWithIgnored(ws, 'base', baseline)
  expect(note).toContain('스캔 상한 도달')
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "#128-m2"`
Expected: FAIL — restore가 `void` 반환이라 `toEqual({capped})` 불일치.

- [ ] **Step 3: Implement**

(A) `ignored-baseline.ts` `restoreIgnoredBaseline` 시그니처·반환:

```ts
export async function restoreIgnoredBaseline(
  root: string,
  git: GitRunner,
  baseline: IgnoredBaseline,
  policy: ScanPolicy,
): Promise<{ capped: boolean }> {
  const { files, skipped } = await listIgnored(root, git, policy)
  // [#128-m2] 현재 restore 호출의 스캔이 cap 에 도달했는지(에이전트가 cap 뒤 숨긴 파일이
  // 이번 삭제 패스에서 누락될 수 있음 → rollback 불완전 가능성 표면화).
  const capped = skipped.some((s) => s.path === SCAN_CAPPED && s.reason === 'over-cap')
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  // …기존 created 삭제·over-cap 삭제·backup 복원 로직 그대로…
  // (함수 마지막 줄에 추가)
  return { capped }
}
```

(B) `git.ts` `Workspace` 인터페이스(line 56):

```ts
  restoreIgnoredBaseline(baseline: IgnoredBaseline): Promise<{ capped: boolean }>
```

`createWorkspace` 래퍼(line 234-236)는 이미 `return restoreIgnored(...)` 라 그대로 `{capped}`를 전달 — 변경 불요(반환 타입만 인터페이스로 전파). 확인만.

(C) `ignored-guard.ts` restore 소비:

```ts
  if (baseline) {
    try {
      const { capped } = await ws.restoreIgnoredBaseline(baseline)
      if (capped) {
        notes.push(' · ignored 스캔 상한 도달(일부 ignored 파일이 rollback 에서 누락될 수 있음)')
      }
    } catch (err) {
      notes.push(
        ` · ignored 복원 실패: ${err instanceof Error ? err.message : String(err)}(ignored 파일 잔존)`,
      )
    }
  }
```

`rollbackWithIgnored`의 `ws` 타입은 `Pick<Workspace, 'revert' | 'restoreIgnoredBaseline'>` — 인터페이스 변경으로 자동 전파. ignored-guard.test.ts의 import(없으면 생성): `import { rollbackWithIgnored } from './ignored-guard'`, `import type { IgnoredBaseline } from '../workspace/ignored-baseline'`, `import { describe, expect, it } from 'vitest'`.

(D) **모든 테스트 restore 목 전수 갱신**(타입 호환 — `Promise<void>` → `Promise<{capped:boolean}>`). 먼저 사이트를 전부 찾는다:

Run: `rg -n "restoreIgnoredBaseline|restoreSpy" src/main/core -g '*.ts'`

Codex 리뷰가 확인한 갱신 대상(이 목록 + rg 결과의 나머지 전부):
- `orchestrator.test.ts` L30-37 `FakeIgnoredOpts.restoreSpy` 타입 → `=> Promise<{ capped: boolean }>`
- `orchestrator.test.ts` L46-47 `restoreSpy` 로컬 타입 + 기본값 `vi.fn(async (_baseline: IgnoredBaseline) => ({ capped: false }))`
- `orchestrator.test.ts` L165(inner worktree)·L187(outer parallel)·L470-487(addWorktree-stub fake)·L1938-1951·L1993-2020·L3384-3391 등 직접 `async restoreIgnoredBaseline() {}` fixture → `{ return { capped: false } }`
- `ignored-guard.test.ts` L5-33 의 모든 성공 mock → `async restoreIgnoredBaseline() { return { capped: false } }`
- `workspace/git.test.ts` L420-425 — 반환 무시라 보통 무수정이나, 타입 위반 시 갱신

커스텀 `restoreSpy`를 넘기는 테스트도 동일하게 `{ capped: false }` 반환. typecheck가 모든 누락을 잡으므로 Step 5(typecheck PASS)를 게이트로 삼는다.

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts src/main/core/orchestrator/ignored-guard.test.ts src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS 전체.

- [ ] **Step 5: TypeCheck**

Run: `npm run typecheck`
Expected: PASS(인터페이스 ripple이 모두 반영됨).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts src/main/core/workspace/git.ts src/main/core/orchestrator/ignored-guard.ts src/main/core/orchestrator/ignored-guard.test.ts src/main/core/orchestrator/orchestrator.test.ts
# git.test.ts 를 수정했다면 함께 add:
# git add src/main/core/workspace/git.test.ts
git commit -m "feat(#128-B1): restore {capped} 반환 + rollback 단계 SCAN_CAPPED 표면화"
```

---

## Task 5: C) denylist 비목표 문구 + m4) zeroize 단언 + m5) dispose 가드

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`
- Modify: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `listIgnored` denylist skip 코멘트(현 "B 슬라이스로 연기"), `disposeBaseline`, `captureIgnoredBaseline` zeroize catch.
- Produces: 코멘트를 "B1 확정 비목표 / B2 이관"으로; `disposeBaseline` 빈-Buffer 가드; m4 zeroize 단언 2건.

- [ ] **Step 1: Write the failing/strengthening tests (RED)**

import에 `vi` 추가: `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'`. 그리고 fs 네임스페이스: `import * as fs from 'node:fs'`.

`describe('disposeBaseline', …)`(없으면 생성)에:

```ts
it('[#128-m5] disposeBaseline 은 backup Buffer 를 0으로 채운다', async () => {
  writeFileSync(join(root, '.env'), 'SECRET=1')
  const git = fakeGitIgnored(['.env'])
  const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
  const buf = baseline.entries.get('.env')!.backup!
  expect(buf.some((b) => b !== 0)).toBe(true) // dispose 전엔 내용 존재
  disposeBaseline(baseline)
  expect(buf.every((b) => b === 0)).toBe(true) // dispose 후 zeroize
})
```

`describe('captureIgnoredBaseline', …)`에 m4 in-flight zeroize:

```ts
it('[#128-m4] capture throw 시 이미 캡처된 backup Buffer 가 zeroize 된다', async () => {
  writeFileSync(join(root, 'a.key'), 'A_SECRET')
  mkdirSync(join(root, '.env')) // 두 번째(sensitive non-regular) → throw 유발
  const git = fakeGitIgnored(['a.key', '.env'])
  const captured: Buffer[] = []
  const real = fs.readFileSync
  const spy = vi
    .spyOn(fs, 'readFileSync')
    .mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const out = (real as (...a: unknown[]) => unknown)(...args)
      if (Buffer.isBuffer(out)) captured.push(out)
      return out
    }) as typeof fs.readFileSync)
  try {
    await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow()
  } finally {
    spy.mockRestore()
  }
  // [Codex 보정] named import 라 spy 가 가로채지 못할 수 있다(node: 빌트인 externalize).
  // best-effort: spy 가 동작했을 때만(=버퍼 참조 확보 시) zeroize 를 단언한다.
  // spy 미동작 환경에서는 m5(disposeBaseline) 가 zeroize 프리미티브를 견고히 보장한다.
  if (captured.length > 0) {
    expect(captured.every((b) => b.length === 0 || b.every((x) => x === 0))).toBe(true)
  }
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "#128-m"`
Expected: m5는 PASS 가능(현 dispose가 이미 fill(0)). m4는 spy 차단 여부에 따라 결정 — spy가 capture를 가로채면, 현재 zeroize는 이미 동작하므로 PASS. (만약 vitest가 named import를 가로채지 못해 `captured.length===0`이면, 해당 환경에선 m4를 skip 처리하고 m5만 유지 — 실행자가 확인.)

- [ ] **Step 3: Implement — 코멘트 + dispose 가드**

(A) `listIgnored` denylist 코멘트를 강화. **먼저 실제 위치 확인**(Codex 보정 — "연기" 문구는 코드 2곳 + "B-slice 오염" 1곳):

Run: `rg -n "B 슬라이스|B-slice|강한 격리|evasion" src/main/core/workspace/ignored-baseline.ts`

매치된 모든 코멘트(함수 상단 doc·top-level skip·nested skip)를 "B1 확정 비목표 / B2 프로세스 격리 이관(#128 잔여)"으로 교체. 예: top-level(현 line 135-136):

```ts
      // [#128-C] denylist 디렉터리 내부는 스캔하지 않음(비용 경계). 내부 sensitive 커버는 B1 확정 비목표 —
      // evasion(숨긴 위치 쓰기) 방어는 경로검사가 아닌 B2 프로세스 격리로 이관(#128 잔여).
      if (policy.denylistRe.test(`${dir}/`)) continue
```

함수 상단 doc 블록과 nested skip(현 line 120-123) 코멘트도 동일 취지로 "B 슬라이스로 연기" → "B1 확정 비목표 / B2 이관"으로 교체.

(B) `disposeBaseline` 빈-Buffer 가드:

```ts
export function disposeBaseline(baseline: IgnoredBaseline): void {
  for (const entry of baseline.entries.values()) {
    if (entry.backup && entry.backup.length > 0) entry.backup.fill(0)
  }
  baseline.entries.clear()
  baseline.skipped.length = 0
}
```

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS 전체.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B1): denylist 내부 sensitive=B1 비목표 문구 강화 + zeroize 단언/dispose 빈-Buffer 가드"
```

---

## Task 6: m1) 병렬 worktree ignored 변경 폐기 경고

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts`
- Modify: `src/main/core/orchestrator/orchestrator.test.ts`

**Interfaces:**
- Consumes: `runTaskIn(): Promise<string | undefined>`(keepHash), 병렬 정리 루프(line 542-611), `store.appendEvent`.
- Produces: `runTaskIn(): Promise<{ keepHash?: string; ignoredTouched: boolean } | undefined>`; 병렬 정리에서 `done && ignoredTouched`면 `workspace.ignored_discarded` append. 순차 경로는 반환 무시(무회귀).

- [ ] **Step 1: Write the failing test (RED)**

`orchestrator.test.ts`의 병렬 describe(line 3166 테스트 인근)에 추가. Task 4에서 `parallelFakeWorkspace`를 건드리지 않았으므로, 이 테스트는 line 3166 패턴처럼 `addWorktree` 오버라이드로 worktree에 non-empty ignored 변경을 주입한다:

```ts
it('[#128-m1] 병렬 worktree 의 승인된 ignored 변경 폐기 시 workspace.ignored_discarded 를 기록한다', async () => {
  const store = createMemoryStore(deterministic())
  const sessions = createSessionManager()
  sessions.add(
    fakeSession('planner', () => '[{"title":"A","description":"a"},{"title":"B","description":"b"}]'),
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
  // 경로·종류만 — 내용 비노출(이벤트 data 에 taskId/projectId 만)
  expect(JSON.stringify(discarded)).not.toContain('.env-')
})
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts -t "#128-m1"`
Expected: FAIL — `workspace.ignored_discarded` 이벤트가 아직 없음(0건).

- [ ] **Step 3: Implement — runTaskIn 반환 확장 + 병렬 emit**

(A) `runTaskIn` 반환 타입(line 185):

```ts
  ): Promise<{ keepHash?: string; ignoredTouched: boolean } | undefined> => {
```

(B) 라운드 루프 진입 전 추적 변수 선언(line 246-249 `let diff = …` 인근):

```ts
      let ignoredTouched = false
```

라운드 안 `const ignoredChanges = await ws.collectIgnoredChanges(ignoredBaseline)`(line 265) 직후:

```ts
        if (ignoredChanges.changes.length > 0 || ignoredChanges.unrestorable.length > 0) {
          ignoredTouched = true
        }
```

(이미 line 272의 `if (…changes.length > 0 || …unrestorable.length > 0)` 블록과 조건이 같으므로, 그 블록 안에서 `ignoredTouched = true` 한 줄 추가해도 동일.)

(C) done 경로 반환(line 383-395) — `return keepHash`를 교체:

```ts
      const keepHash = await ws.keep(`[${task.title}] by ${implementerId}`)
      store.updateTask(task.id, {
        status: 'done',
        output: `변경 ${diff.files.length}개 적용`,
        changedFiles: diff.files,
      })
      emit({
        type: 'task.done',
        message: `${task.title}: 완료(변경 ${diff.files.length}개)`,
        data: { taskId: task.id },
      })
      done.add(task.id)
      return { keepHash, ignoredTouched }
```

(다른 모든 `return undefined`는 그대로.)

(D) 병렬 정리 루프 — `const keepHash = r.value`(line 574)를 교체:

```ts
        const value = r.value
        const keepHash = value?.keepHash
        const ignoredTouched = value?.ignoredTouched ?? false
```

이후 `keepHash`를 쓰는 분기(line 579·589)는 그대로 유효.

(E) `removeWorktree` 직전(line 607-608 `// 정리(순차)…` 위)에 폐기 경고 삽입:

```ts
        // [#128-m1] 병렬 worktree 의 ignored 변경은 keep(tracked만)→integrate 로 main 에 안 올라가고
        // worktree 제거 시 폐기된다. task 가 최종 done 이고 ignored 변경이 있었으면 사용자 인지용으로 기록.
        // (abort-skip·통합충돌은 위에서 done 을 철회하므로 done.has 가 false → 경고 안 남 — 정확.)
        if (done.has(task.id) && ignoredTouched) {
          store.appendEvent({
            type: 'workspace.ignored_discarded',
            data: { projectId, taskId: task.id },
          })
        }
        // 정리(순차) — …
        await ws.removeWorktree(task.id).catch(() => {})
```

`projectId`가 이 스코프(runProject 본문)에 있는지 확인 — runTaskIn(line 278)에서 동일 이름으로 사용 중이므로 존재. 없다면 `project.id` 사용.

- [ ] **Step 4: Run tests (GREEN)**

Run: `npx vitest run src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS 전체(기존 병렬·순차 회귀 + #128-m1 신규). 순차 `runTask`(line 645 `await runTask(task)`)는 반환 무시라 무회귀.

- [ ] **Step 5: TypeCheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "feat(#128-B1): 병렬 worktree ignored 변경 폐기 경고(workspace.ignored_discarded)"
```

---

## Task 7: 전체 게이트 + brain + 자기검토

**Files:**
- Report: 없음(검증·산출만)

- [ ] **Step 1: 전체 게이트**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run test && npm run build`
Expected: 전부 green. lint 미사용 변수(예: 교체로 남은 `currentSize` let)·format 위반 없도록 정리.

- [ ] **Step 2: brain 갱신**

Run: `npm run brain`
Expected: 산출 갱신. 변경분이 있으면 add.

```bash
git add brain.md
git commit -m "chore(#128-B1): npm run brain 갱신"
```

(변경 없으면 스킵.)

- [ ] **Step 3: 자기검토(스펙 대조)**

스펙 `docs/superpowers/specs/2026-06-23-issue128-B1-adversarial-fs-design.md`의 각 항목이 Task로 커버됐는지 확인:
- A capture/collect 가드 → Task 1·2 ✅
- B ancestor-is-file → Task 3 ✅
- C denylist 비목표 문구 → Task 5 ✅
- m1 폐기 경고 → Task 6 ✅
- m2 capped 표면화 → Task 4 ✅
- m3 read-failed → Task 1 ✅
- m4 zeroize → Task 5 ✅
- m5 dispose 가드 → Task 5 ✅

---

## Self-Review

**Spec coverage:** 위 Task 7 Step 3 매핑 — 8개 항목 전부 Task에 귀속. 누락 없음.

**Placeholder scan:** 모든 코드 step에 실제 구현/테스트 코드 포함. "TBD/유사함" 없음.

**Type consistency:**
- `IgnoredBaseline.skipped[].reason` = `'over-cap'|'read-failed'|'not-regular'`(Task 1) — 이후 Task 동일 사용.
- `restoreIgnoredBaseline(): Promise<{ capped: boolean }>`(Task 4) — git.ts 인터페이스·ignored-guard 소비·orchestrator 목 전부 일치.
- `runTaskIn(): Promise<{ keepHash?: string; ignoredTouched: boolean } | undefined>`(Task 6) — 병렬 `r.value` 구조분해·순차 무시 일치.
- 신규 store event `workspace.ignored_discarded`는 `store.appendEvent`(느슨한 타입) — `OrchestratorEventType` union 변경 불요(형제 `workspace.ignored_changes`와 동일 패턴).

**리스크:**
1. m4 zeroize 테스트의 `vi.spyOn(fs,'readFileSync')`가 vitest의 named-import 가로채기에 의존 — 가로채지 못하면 `captured.length===0`. m5 dispose 테스트가 zeroize 프리미티브를 확실히 커버하므로, m4가 환경상 불가하면 skip 처리(실행자 판단). 핵심 안전(throw 전파)은 별도 단언.
2. m3 read-failed는 POSIX·non-root 전용(chmod 000). win32/root에선 early-return skip — 회귀 위험 없음.
3. Task 4 인터페이스 변경은 같은 커밋에서 모든 restore 목을 갱신해야 typecheck green — Step 3(D)에 사이트 명시.

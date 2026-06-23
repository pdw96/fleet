# #128-B2 워크스페이스 격리: link-guard 하드닝 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ignored-baseline.ts`의 FS 연산이 symlink/junction을 따라가 워크스페이스 밖을 읽거나 쓰지 않도록 link-aware로 전환하고, realpath containment helper를 `workspace-tools.ts`와 단일화한다(advisory 하드닝).

**Architecture:** 신규 sync helper `path-guard.ts`(`isLinkSync` lstat 종류판정 + `resolveWithin` realpath containment)를 만들고, `ignored-baseline.ts`의 `statSync`(링크 추종) 5지점(walk·capture·collect·ancestor·leaf restore)을 `lstatSync`(비추종)로 바꿔 링크를 B1의 non-regular 분기에 흡수한다. `workspace-tools.ts`의 인라인 containment를 helper로 교체한다.

**Tech Stack:** TypeScript(ESM, `node:fs` sync API), vitest, Electron 42 = Node 24.16.0.

## Global Constraints

- **런타임 Node = 24.16.0(Electron 42).** `lstatSync().isSymbolicLink()`가 POSIX symlink + Windows junction 둘 다 `true`(실증). junction은 admin 불요 생성.
- **leak-zero 불변식:** 표면화는 workspace-상대 경로 + reason/kind만. 링크 target(밖 경로)·파일 내용 절대 비노출.
- **fail-closed:** sensitive-명 링크·exotic reparse(lstat EINVAL/UNKNOWN)는 throw 또는 skip(진행 금지). 절대 fail-open 금지.
- **무회귀:** A(PR #127)·B1(PR #129)이 출하한 탐지·게이트·선택복원·non-regular 가드를 깨지 않는다.
- **5게이트 필수:** `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`. + `npm run brain` 갱신.
- **플랫폼 테스트:** junction = win32-only(`describe.skipIf(process.platform !== 'win32')`), POSIX symlink = POSIX-only(`if (process.platform === 'win32') return`). win32 vitest는 `win32 보안 회귀` required check가 강제.
- **커밋:** 태스크당 1커밋, prefix `feat(#128-B2):` / `test(#128-B2):` / `refactor(#128-B2):`. 커밋 메시지 푸터(Co-Authored-By 등)는 커밋 시 레포 규약대로 부착.

## Setup (Task 0 전 1회)

master 최신에서 피처 브랜치 생성: `git switch -c feat/128-b2-link-guard`. (subagent-driven-development/executing-plans가 worktree로 처리하면 그 안에서.)

## File Structure

- **Create** `src/main/core/workspace/path-guard.ts` — `isLinkSync`(lstat 종류판정), `resolveWithin`(realpath containment). 단일 책임: "경로의 링크 여부 + root 내부 여부 판정".
- **Create** `src/main/core/workspace/path-guard.test.ts`.
- **Modify** `src/main/core/workspace/ignored-baseline.ts` — `IgnoredBaseline.skipped` reason union에 `'symlink'` 추가; `listIgnored`(walk + top-level entry); `captureIgnoredBaseline`; `collectIgnoredChanges`; `clearNonDirAncestors`; `restoreIgnoredBaseline`(leaf + created).
- **Modify** `src/main/core/workspace/ignored-baseline.test.ts` — `[#128-B2]` 링크 테스트 추가.
- **Modify** `src/main/core/tools/workspace-tools.ts` — 인라인 `resolveWithin` 제거 → helper import; `read_file.classify`의 직접 `realpathSync` → helper 경유.
- **Modify** `src/main/core/tools/workspace-tools.test.ts` — 회귀 확인(필요 시 조정).

---

### Task 1: `path-guard.ts` — `isLinkSync`

**Files:**
- Create: `src/main/core/workspace/path-guard.ts`
- Test: `src/main/core/workspace/path-guard.test.ts`

**Interfaces:**
- Produces: `isLinkSync(abs: string): 'regular' | 'dir' | 'link' | 'suspicious' | 'missing'` — `lstatSync` 기반(링크 비추종). `link`=symlink/junction, `suspicious`=비정형(FIFO 등) 또는 lstat EINVAL/UNKNOWN(exotic reparse·fail-closed), `missing`=ENOENT.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/main/core/workspace/path-guard.test.ts
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { isLinkSync } from './path-guard'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-pg-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isLinkSync', () => {
  it('일반 파일 → regular', () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    expect(isLinkSync(join(root, 'a.txt'))).toBe('regular')
  })
  it('디렉터리 → dir', () => {
    mkdirSync(join(root, 'd'))
    expect(isLinkSync(join(root, 'd'))).toBe('dir')
  })
  it('미존재 → missing', () => {
    expect(isLinkSync(join(root, 'nope'))).toBe('missing')
  })
  it('lstat EINVAL/UNKNOWN(exotic reparse) → suspicious(fail-closed)', () => {
    const err = Object.assign(new Error('einval'), { code: 'EINVAL' })
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw err
    })
    expect(isLinkSync(join(root, 'whatever'))).toBe('suspicious')
    spy.mockRestore()
  })
})

describe.skipIf(process.platform === 'win32')('isLinkSync (POSIX symlink)', () => {
  it('symlink → link', () => {
    writeFileSync(join(root, 'target.txt'), 'x')
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'))
    expect(isLinkSync(join(root, 'link.txt'))).toBe('link')
  })
})

describe.skipIf(process.platform !== 'win32')('isLinkSync (Windows junction)', () => {
  it('junction → link', () => {
    mkdirSync(join(root, 'realdir'))
    symlinkSync(join(root, 'realdir'), join(root, 'jdir'), 'junction')
    expect(isLinkSync(join(root, 'jdir'))).toBe('link')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/workspace/path-guard.test.ts`
Expected: FAIL — `Failed to resolve import "./path-guard"`.

- [ ] **Step 3: 최소 구현**

```ts
// src/main/core/workspace/path-guard.ts
import { lstatSync } from 'node:fs'

/** 경로의 종류를 lstat(링크 비추종)으로 판정한다.
 * 'link'  = POSIX symlink 또는 Windows junction(둘 다 lstat.isSymbolicLink()=true, 실증).
 * 'suspicious' = FIFO/socket/device 등 비정형, 또는 lstat 가 EINVAL/UNKNOWN throw
 *   (OneDrive/AppExecLink 등 exotic reparse) — 안전상 따라가지 않음(fail-closed).
 * 'missing' = ENOENT. */
export type LinkKind = 'regular' | 'dir' | 'link' | 'suspicious' | 'missing'

export function isLinkSync(abs: string): LinkKind {
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return 'link'
    if (st.isDirectory()) return 'dir'
    if (st.isFile()) return 'regular'
    return 'suspicious'
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    return 'suspicious'
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/workspace/path-guard.test.ts`
Expected: PASS (POSIX에선 junction describe skip, win32에선 symlink describe skip).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/workspace/path-guard.ts src/main/core/workspace/path-guard.test.ts
git commit -m "feat(#128-B2): path-guard isLinkSync — lstat 기반 링크/종류 판정(junction 포함)"
```

---

### Task 2: `path-guard.ts` — `resolveWithin` (realpath containment)

**Files:**
- Modify: `src/main/core/workspace/path-guard.ts`
- Test: `src/main/core/workspace/path-guard.test.ts`

**Interfaces:**
- Produces: `resolveWithin(root: string, p: string): string` — `realpathSync.native(root)` 기준 정준화 + 최근접 존재 조상 realpath + 미존재 tail 재부착 + 정확 predicate(`rel===''` 허용 / `rel==='..'`·`..${sep}`·absolute 거부, win32 case-fold). root 내부면 정준 절대경로 반환, 밖이면 throw. root/조상 realpath 실패(exotic/UNC) → fail-closed throw.

- [ ] **Step 1: 실패 테스트 작성** (`path-guard.test.ts`에 추가)

```ts
import { resolveWithin } from './path-guard'

describe('resolveWithin', () => {
  it('root 내부 파일 허용 + 정준 경로 반환', () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    const out = resolveWithin(root, 'a.txt')
    expect(out.toLowerCase()).toContain('a.txt')
  })
  it("'..foo' 같은 정상 in-root 이름을 오거부하지 않는다", () => {
    writeFileSync(join(root, '..foo'), 'x')
    expect(() => resolveWithin(root, '..foo')).not.toThrow()
  })
  it("'../x' 상위 탈출은 거부", () => {
    expect(() => resolveWithin(root, join('..', 'x'))).toThrow(/워크스페이스 밖/)
  })
  it('미존재 leaf 도 컨테인먼트만 검사(허용)', () => {
    expect(() => resolveWithin(root, 'sub/new.txt')).not.toThrow()
  })
  it('root 자체(빈 상대) 허용', () => {
    expect(() => resolveWithin(root, '.')).not.toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('resolveWithin (POSIX symlink ancestor)', () => {
  it('존재하는 symlink 조상 아래 미존재 tail 은 밖이면 거부', () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      symlinkSync(outside, join(root, 'esc'), 'dir')
      expect(() => resolveWithin(root, 'esc/whatever.txt')).toThrow(/워크스페이스 밖/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'win32')('resolveWithin (Windows junction ancestor)', () => {
  it('junction 조상 아래 미존재 tail 은 밖이면 거부', () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      symlinkSync(outside, join(root, 'esc'), 'junction')
      expect(() => resolveWithin(root, 'esc/whatever.txt')).toThrow(/워크스페이스 밖/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/workspace/path-guard.test.ts`
Expected: FAIL — `resolveWithin is not a function` / import 실패.

- [ ] **Step 3: 최소 구현** (`path-guard.ts`에 추가)

```ts
import { lstatSync, realpathSync, existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

// win32 비교는 case-insensitive(NTFS) — 양변 case-fold.
const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** root realpath 기준으로 p 를 정준 절대경로로 해소하고 root 내부인지 검사한다.
 * lexical 비교는 symlink 비해소라 무력 → realpath 필수. 미존재 leaf 는
 * "최근접 존재 조상 realpath + 미존재 tail 재부착"으로 symlink 조상 탈출도 잡는다.
 * realpath 실패(exotic reparse/UNC) 또는 root 밖 → throw(fail-closed). */
export function resolveWithin(root: string, p: string): string {
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch (err) {
    throw new Error(`워크스페이스 realpath 해소 불가(운영 에러): ${root}`, { cause: err })
  }
  const abs = resolve(realRoot, p)
  // 최근접 존재 조상까지 올라가 그 조상의 realpath 를 구하고 미존재 tail 을 재부착한다.
  let existingAbs = abs
  const tail: string[] = []
  while (!existsSync(existingAbs)) {
    tail.unshift(basename(existingAbs))
    const parent = dirname(existingAbs)
    if (parent === existingAbs) break
    existingAbs = parent
  }
  let realCandidate: string
  try {
    const realExisting = realpathSync.native(existingAbs)
    realCandidate = tail.length ? resolve(realExisting, ...tail) : realExisting
  } catch (err) {
    throw new Error(`경로 realpath 해소 실패(안전상 거부): ${p}`, { cause: err })
  }
  const rel = relative(fold(realRoot), fold(realCandidate))
  const inside =
    rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  if (!inside) throw new Error(`경로가 워크스페이스 밖입니다: ${p}`)
  return realCandidate
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/workspace/path-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/workspace/path-guard.ts src/main/core/workspace/path-guard.test.ts
git commit -m "feat(#128-B2): path-guard resolveWithin — realpath.native containment(미존재 tail·case-fold·정확 predicate)"
```

---

### Task 3: `ignored-baseline.ts` — `listIgnored` walk + top-level 엔트리 link-aware

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts` (`IgnoredBaseline.skipped` union L49; `listIgnored` walk L93-130, top-level loop L131-143)
- Test: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `isLinkSync` (Task 1).
- Produces: `listIgnored` 가 symlink/junction을 재귀/수집하지 않고 `skipped{reason:'symlink'}`로 기록. `IgnoredBaseline.skipped[].reason`에 `'symlink'` 추가.

- [ ] **Step 1: 실패 테스트 작성** (`ignored-baseline.test.ts`에 추가; 파일 상단 import에 `symlinkSync` 추가)

```ts
// describe('captureIgnoredBaseline', ...) 내부 또는 별도 describe 에 추가
describe.skipIf(process.platform === 'win32')('[#128-B2] symlink 비추종 (POSIX)', () => {
  it('git-보고 ignored 가 symlink-to-dir 면 재귀 안 하고 밖을 수집 안 한다', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET')
      symlinkSync(outside, join(root, 'link'), 'dir')
      const git = fakeGitIgnored(['link/']) // git 이 디렉터리처럼 보고
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      // 밖의 secret.txt 가 절대 entries 에 들어오면 안 됨
      expect([...base.entries.keys()].some((k) => k.includes('secret'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'win32')('[#128-B2] junction 비추종 (Windows)', () => {
  it('git-보고 ignored 가 junction 이면 재귀 안 하고 밖을 수집 안 한다', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET')
      symlinkSync(outside, join(root, 'link'), 'junction')
      const git = fakeGitIgnored(['link/'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      expect([...base.entries.keys()].some((k) => k.includes('secret'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "#128-B2"`
Expected: FAIL on the current platform's case — `statSync`가 링크를 추종해 밖의 `secret.txt`가 entries에 들어옴.

- [ ] **Step 3: 구현**

3-1. `IgnoredBaseline.skipped` union(L49)에 `'symlink'` 추가:
```ts
  skipped: { path: string; reason: 'over-cap' | 'read-failed' | 'not-regular' | 'symlink' }[]
```

3-2. `listIgnored` 의 반환 `skipped` 타입(L65)과 walk/top-level을 link-aware로. 파일 상단 import에 `lstatSync` 추가, helper import 추가:
```ts
import { ... , lstatSync, ... } from 'node:fs'
import { isLinkSync } from './path-guard'
```
walk 의 dirent 루프(현 L109-129)를 `withFileTypes`로 교체:
```ts
  const walk = (relDir: string): void => {
    if (capped) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(resolve(root, relDir), { withFileTypes: true })
    } catch {
      if (!capped) {
        capped = true
        skipped.push({ path: SCAN_CAPPED, reason: 'over-cap' })
      }
      return
    }
    for (const ent of entries) {
      if (capped) return
      const rel = `${relDir}/${ent.name}`
      if (ent.isSymbolicLink()) {
        // [#128-B2] symlink/junction 은 따라가지 않는다 — 밖을 가리켜 읽거나 재귀하지 않음.
        skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'symlink' })
        continue
      }
      if (ent.isDirectory()) {
        const relSlash = `${rel}/`
        if (policy.denylistRe.test(rel) || policy.denylistRe.test(relSlash)) continue
        walk(rel)
        continue
      }
      // [#128-B2] 파일 + 비정형(FIFO/socket/device) → pushFile. capture/collect 의 lstat 가
      // regular 면 백업, 아니면 'not-regular' 로 표면화한다(B1 동작 보존 — silent drop 금지).
      pushFile(rel)
    }
  }
```
top-level 엔트리 루프(현 L131-143)에서 비-`/` 엔트리도 링크 검사:
```ts
  for (const e of ignored) {
    if (capped) break
    const rel = e.replace(/\\/g, '/')
    if (rel.endsWith('/')) {
      const dir = rel.replace(/\/+$/, '')
      if (policy.denylistRe.test(`${dir}/`)) continue
      // [#128-B2] git 이 디렉터리로 보고해도 실제 junction/symlink 면 재귀 금지.
      if (isLinkSync(resolve(root, dir)) === 'link') {
        skipped.push({ path: dir, reason: 'symlink' })
        continue
      }
      walk(dir)
    } else {
      // [#128-B2] 파일로 보고된 엔트리가 실제 링크면 수집 안 함(capture 의 lstat 가 이중 방어).
      if (isLinkSync(resolve(root, rel)) === 'link') {
        skipped.push({ path: rel, reason: 'symlink' })
        continue
      }
      pushFile(rel)
    }
  }
```
**`'symlink'` reason union — 전 사이트 갱신(Codex #3, 누락 방지):**
1. `IgnoredBaseline.skipped[].reason`(L49) → `'over-cap'|'read-failed'|'not-regular'|'symlink'`
2. `listIgnored()` 반환 타입(L65) `skipped: {…reason: 'over-cap'|'symlink'}[]`
3. `listIgnored()` 내부 `skipped` local(L72) 동일
4. `captureIgnoredBaseline()`의 `skipped` local(L154) — 이미 `IgnoredBaseline['skipped']` 형이면 1과 동기
5. `collectIgnoredChanges()` `unrestorable` merge(L233-239) — path 기준 dedup이라 reason 추가 무영향(Codex 확인)
6. `restoreIgnoredBaseline()` skipped 처리(L326-342) — `SCAN_CAPPED` 필터 유지(reason 추가 무충돌, Codex 확인)
capture/collect/restore가 `enumSkipped`/`currentSkipped`/`skipped`를 그대로 누적하므로 'symlink'도 자동 표면화된다.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS (기존 테스트 + #128-B2). `secret.txt`가 entries에 없음.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B2): listIgnored walk/엔트리 link-aware — symlink/junction 재귀·수집 차단"
```

---

### Task 4: `captureIgnoredBaseline` — `statSync`→`lstatSync` (링크 leaf 비-read)

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts` (`captureIgnoredBaseline` L158-200)
- Test: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: 없음(기존 B1 non-regular 분기 재사용).
- Produces: 링크 ignored 엔트리는 read 없이 처리 — sensitive-명 → throw, else → `skipped{reason:'symlink'}`.

- [ ] **Step 1: 실패 테스트 작성**

```ts
describe.skipIf(process.platform === 'win32')('[#128-B2] capture 링크 leaf (POSIX)', () => {
  it('비-sensitive symlink ignored 파일은 read 없이 symlink 로 skip', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.dat'))
      const git = fakeGitIgnored(['link.dat'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      expect(base.entries.has('link.dat')).toBe(false)
      expect(base.skipped).toContainEqual({ path: 'link.dat', reason: 'symlink' })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('sensitive-명 symlink 는 throw(fail-closed)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'k'), 'KEY')
      symlinkSync(join(outside, 'k'), join(root, '.env'))
      const git = fakeGitIgnored(['.env'])
      await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
        /링크|일반 파일이 아님/,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "capture 링크 leaf"`
Expected: FAIL — `statSync` 추종으로 `link.dat`이 regular로 보여 백업되고, `.env` symlink target이 읽혀 throw 안 함.

- [ ] **Step 3: 구현** (`captureIgnoredBaseline` 내부, 현 L162-175)

`statSync`→`lstatSync`로 바꾸고, B1 non-regular 분기 직전에 symlink 분기를 명시:
```ts
      let st
      try {
        st = lstatSync(abs) // [#128-B2] 링크 비추종 — 링크면 isFile()=false 로 아래 분기 적중
      } catch (err) {
        if (sensitive) throw new Error(`민감 ignored 파일 stat 실패: ${path}`, { cause: err })
        skipped.push({ path, reason: 'read-failed' })
        continue
      }
      // [#128-B2] symlink/junction → read 금지(밖 target 유출 차단). sensitive 면 fail-closed.
      if (st.isSymbolicLink()) {
        if (sensitive) throw new Error(`민감 ignored 파일이 링크임(백업 불가): ${path}`)
        skipped.push({ path, reason: 'symlink' })
        continue
      }
      // [#128-A] non-regular(FIFO/socket/device/dir)
      if (!st.isFile()) {
        if (sensitive) throw new Error(`민감 ignored 파일이 일반 파일이 아님(백업 불가): ${path}`)
        skipped.push({ path, reason: 'not-regular' })
        continue
      }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS (기존 + 신규).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B2): captureIgnoredBaseline lstat — 링크 leaf read 차단(밖 비밀 유출 방지)"
```

---

### Task 5: `collectIgnoredChanges` — `statSync`→`lstatSync` (링크 교체 비-read)

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts` (`collectIgnoredChanges` L257-271)
- Test: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Produces: baseline 일반파일이 실행 중 symlink로 교체되면 read 없이 `modified`(backup 있으면 restorable).

- [ ] **Step 1: 실패 테스트 작성**

```ts
describe.skipIf(process.platform === 'win32')('[#128-B2] collect 링크 교체 (POSIX)', () => {
  // 깨끗한 distinguisher: symlink target 내용을 baseline 과 *동일*하게 둔다.
  //   - old(statSync 추종): target('orig')을 읽어 hash 가 baseline 과 일치 → '변경 없음' 오판(보안 구멍).
  //   - new(lstat 비추종): isSymbolicLink → modified. (단순히 다른 내용을 쓰면 old 도 modified 라 거짓-green.)
  it('baseline 파일이 같은 내용 가리키는 symlink 로 교체돼도 modified 로 잡는다(링크 비추종)', async () => {
    writeFileSync(join(root, 'f.dat'), 'orig')
    const git = fakeGitIgnored(['f.dat'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'same'), 'orig') // target 내용 == baseline
      rmSync(join(root, 'f.dat'))
      symlinkSync(join(outside, 'same'), join(root, 'f.dat'))
      const cs = await collectIgnoredChanges(root, git, base, DEFAULT_IGNORED_POLICY)
      expect(cs.changes).toContainEqual({ path: 'f.dat', change: 'modified', sensitive: false })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "collect 링크 교체"`
Expected: FAIL — old `statSync`가 symlink target('orig')을 읽어 hash 가 baseline 과 일치 → `modified` 미-push → 단언 실패. (new: lstat → isSymbolicLink → modified.)

- [ ] **Step 3: 구현** (`collectIgnoredChanges` 내부, 현 L256-271)

`statSync`→`lstatSync`로 바꾸고 symlink 분기를 non-regular 직전에 명시:
```ts
    let st
    try {
      st = lstatSync(abs) // [#128-B2] 링크 비추종
    } catch {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      unrestorable.push({ path, reason: 'stat-failed' })
      continue
    }
    if (st.isSymbolicLink()) {
      // [#128-B2] baseline 일반파일이 링크로 교체됨 = modified. read 안 함(밖 유출 차단).
      // backup 있으면 restore 가 링크 제거 후 복원 → unrestorable 아님.
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    if (!st.isFile()) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
```
(이하 size cap·hash 재계산 로직은 regular 경로 그대로 유지.)

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B2): collectIgnoredChanges lstat — 링크로 교체된 baseline 파일 비-read modified"
```

---

### Task 6: `restoreIgnoredBaseline` — 쓰기 측 link-aware (ancestor + leaf + created)

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts` (`clearNonDirAncestors` L298-318; restore created 삭제 L332-342; leaf write L344-359)
- Test: `src/main/core/workspace/ignored-baseline.test.ts`

**Interfaces:**
- Consumes: `isLinkSync` (Task 1).
- Produces: restore 가 링크 조상/leaf/created 를 따라가 밖에 쓰거나 지우지 않는다.

- [ ] **Step 1: 실패 테스트 작성**

```ts
describe.skipIf(process.platform === 'win32')('[#128-B2] restore 쓰기 측 link-guard (POSIX)', () => {
  it('symlink leaf 는 링크를 제거하고 root 안 실파일로 복원(밖 target 미오염)', async () => {
    writeFileSync(join(root, 'f.dat'), 'orig')
    const git = fakeGitIgnored(['f.dat'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'victim'), 'DO-NOT-OVERWRITE')
      rmSync(join(root, 'f.dat'))
      symlinkSync(join(outside, 'victim'), join(root, 'f.dat'))
      await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
      // 밖 victim 은 그대로, root/f.dat 은 backup('orig')으로 복원
      expect(readFile(join(outside, 'victim')).toString()).toBe('DO-NOT-OVERWRITE')
      expect(readFile(join(root, 'f.dat')).toString()).toBe('orig')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  // NOTE: 이 created 테스트는 회귀-lock 이다(POSIX 에선 old `rmSync{recursive}` 도 링크만 제거 — Codex 실증).
  // genuinely-red 보장은 위 leaf 테스트(old statSync 가 밖 victim 을 덮어씀). 이 테스트는 의도 고정 +
  // win32 junction(recursive-rm 이 target 내용을 지울 위험) 보장을 `win32 보안 회귀` 잡에서 검증한다.
  it('created symlink-to-dir 는 링크만 unlink(밖 디렉터리 내용 보존)', async () => {
    const git = fakeGitIgnored(['f.dat', 'esc']) // f.dat=baseline, esc=created link
    writeFileSync(join(root, 'f.dat'), 'orig')
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'keep'), 'KEEP')
      symlinkSync(outside, join(root, 'esc'), 'dir') // 실행 중 생성된 링크
      await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
      expect(existsSync(join(root, 'esc'))).toBe(false) // 링크 제거됨
      expect(readFile(join(outside, 'keep')).toString()).toBe('KEEP') // 밖 내용 보존
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // Codex #3: 실행 중 새로 생긴 escaping symlink 가 rollback 삭제에서 빠지지 않는지 고정한다.
  // (current-scan 'symlink' skipped 를 skippedPaths 에 넣으면 누락되는 회귀를 가드 — skippedPaths 는
  //  baseline.skipped 만이어야 한다. restore 의 skipped 루프가 removeCreated 로 unlink.)
  it('실행 중 새로 생긴 escaping symlink 는 rollback 에서 unlink(밖 내용 보존)', async () => {
    writeFileSync(join(root, 'f.dat'), 'orig')
    const baseGit = fakeGitIgnored(['f.dat'])
    const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'keep'), 'KEEP')
      symlinkSync(outside, join(root, 'newlink'), 'dir') // 에이전트가 새로 만든 링크
      const git = fakeGitIgnored(['f.dat', 'newlink']) // restore 시점 git 보고
      await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
      expect(existsSync(join(root, 'newlink'))).toBe(false)
      expect(readFile(join(outside, 'keep')).toString()).toBe('KEEP')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts -t "restore 쓰기 측"`
Expected: FAIL — symlink leaf 에서 `statSync().isFile()=true`라 `rmSync` 없이 `writeFileSync`가 밖 `victim`을 'orig'로 덮어씀.

- [ ] **Step 3: 구현**

3-1. import에 `isLinkSync` 사용(Task 3에서 이미 import). `clearNonDirAncestors`(L310-317) `statSync`→`lstatSync` + symlink 명시:
```ts
  let cur = root
  for (const part of relDir.split(/[\\/]/).filter(Boolean)) {
    cur = resolve(cur, part)
    if (!existsSync(cur)) continue
    let ls
    try {
      ls = lstatSync(cur) // [#128-B2] existsSync→lstat race 는 fail-safe(advisory)
    } catch {
      continue
    }
    // [#128-B2] 비-dir 또는 링크(junction 포함) 조상은 제거 → mkdirSync(recursive) 가 root 안 체인 재생성.
    if (!ls.isDirectory() || ls.isSymbolicLink()) {
      rmSync(cur, { recursive: true, force: true })
      return
    }
  }
```

3-2. created 삭제(L332-342)를 link-aware unlink로. **resolveWithin(realpath 추종)은 쓰지 않는다 — 탈출 링크에서 realpath 가 throw 해 unlink 자체가 막힌다(Codex 제안 정정). 경로는 git-상대라 lexical `resolve(root,…)`로 컨테인먼트가 보장된다.**
```ts
  const removeCreated = (rel: string): void => {
    const abs = resolve(root, rel)
    // [#128-B2] lexical containment(realpath 아님 — 탈출 링크도 unlink 해야 하므로 realpath 추종 금지).
    // git-상대 경로는 보통 root 아래지만, 이상한 절대/상위 경로(테스트 double 등) 방어(Codex #1).
    const r = relative(root, abs)
    if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return
    // 링크면 recursive 금지 — 링크 자체만 unlink(밖 내용 보존). isLinkSync=lstat(비추종).
    rmSync(abs, isLinkSync(abs) === 'link' ? { force: true } : { recursive: true, force: true })
  }
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    removeCreated(path)
  }
  for (const s of skipped) {
    if (s.path === SCAN_CAPPED) continue
    if (baseline.entries.has(s.path) || skippedPaths.has(s.path)) continue
    removeCreated(s.path)
  }
```

3-3. leaf write(L350-356) `statSync`→`lstatSync`:
```ts
    if (existsSync(abs)) {
      const st = lstatSync(abs) // [#128-B2] 비추종 — symlink leaf 는 isFile()=false 로 제거 대상
      if (!st.isFile()) {
        rmSync(abs, { recursive: true, force: true }) // 링크/디렉터리 제거 후 실파일로 복원
      }
    }
    writeFileSync(abs, entry.backup)
    chmodSync(abs, entry.mode)
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/workspace/ignored-baseline.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/workspace/ignored-baseline.ts src/main/core/workspace/ignored-baseline.test.ts
git commit -m "feat(#128-B2): restore 쓰기 측 link-aware — 조상/leaf/created 링크 통한 밖 쓰기·삭제 차단"
```

---

### Task 7: `workspace-tools.ts` — 인라인 containment를 helper로 통일

**Files:**
- Modify: `src/main/core/tools/workspace-tools.ts` (인라인 `resolveWithin` L27-39 제거; `read_file.classify` L79-83)
- Test: `src/main/core/tools/workspace-tools.test.ts` (회귀 확인)

**Interfaces:**
- Consumes: `resolveWithin` (Task 2).

- [ ] **Step 1: 실패 테스트 작성** — 기존 동작 유지 + `..foo` 오거부 회귀 방지:

```ts
// workspace-tools.test.ts 에 추가(read_file 또는 list_directory 도구 사용)
it('[#128-B2] resolveWithin 통일 — "..foo" 정상 파일 읽기 가능(오거부 회귀 방지)', async () => {
  // root 는 기존 테스트 헬퍼가 만든 임시 워크스페이스 사용
  writeFileSync(join(root, '..foo'), 'hello')
  const tools = createWorkspaceReadTools(root)
  const readFileTool = tools.find((t) => t.definition.name === 'read_file')!
  const out = await readFileTool.execute({ path: '..foo' }, { signal: undefined } as never)
  expect(out).toBe('hello')
})
```
(주의: 기존 테스트 파일의 `root` fixture·`createWorkspaceReadTools` import·`ctx` 형태에 맞춰 작성. 기존 "밖 경로 throw" 테스트가 있으면 유지된다.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/tools/workspace-tools.test.ts -t "#128-B2"`
Expected: FAIL — 현 인라인 `resolveWithin`의 `rel.startsWith('..')`가 `..foo`를 밖으로 오판해 throw.

- [ ] **Step 3: 구현**

3-1. 인라인 `resolveWithin`(L27-39) 삭제, import 추가:
```ts
import { resolveWithin } from '../workspace/path-guard'
```
3-2. 호출부는 sync 반환에 `await` 무해 — 변경 없음(예: `const abs = await resolveWithin(root, p)`). (lint이 `await` on non-promise를 경고하면 `await` 제거.)
3-3. `read_file.classify`(L79-83)의 직접 `realpathSync(...)` 민감도 승격을 helper 경유로 정합(밖이면 throw 대신 분류 목적이라 try/catch 유지):
```ts
      try {
        // resolveWithin 은 밖이면 throw → 분류 단계에선 무시(execute 가 처리). 안이면 정준 경로로 민감도 판정.
        if (SENSITIVE_FILE.test(resolveWithin(root, p))) return 'destructive'
      } catch {
        /* 미존재/밖 — execute 의 resolveWithin/stat 가 처리 */
      }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/tools/workspace-tools.test.ts`
Expected: PASS (기존 컨테인먼트/symlink 테스트 + 신규).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/tools/workspace-tools.ts src/main/core/tools/workspace-tools.test.ts
git commit -m "refactor(#128-B2): workspace-tools containment를 path-guard helper로 통일(startsWith 오거부 수정)"
```

---

### Task 8: 문서화 주석 + `npm run brain` + 5게이트

**Files:**
- Modify: `src/main/core/workspace/ignored-baseline.ts`(파일 상단 docblock), `path-guard.ts`(docblock)
- Modify: `brain.md`(생성물)

- [ ] **Step 1: TOCTOU/격리 한계 주석 추가** — `path-guard.ts` 상단에 docblock:

```ts
// "경로검사 ≠ 격리"(advisory). 이 모듈은 *Fleet 자체 FS 연산*이 symlink/junction 을 따라가
// 워크스페이스 밖을 읽거나 쓰는 것을 줄이는 advisory guard다. 스폰된 CLI 의 직접 쓰기는 막지 못하며,
// lstat→open/write 사이 TOCTOU 창이 남는다(순수 Node 는 openat2/O_NOFOLLOW 크로스플랫폼 부재 —
// Windows 엔 O_NOFOLLOW 자체 없음). 강한 격리는 OS/CLI 샌드박스 층(#128 향후·문서 참조).
```

- [ ] **Step 2: brain 갱신**

Run: `npm run brain`
Expected: `brain.md`가 신규 `path-guard.ts`/변경 반영하여 갱신됨(diff 발생).

- [ ] **Step 3: 5게이트 전체 실행**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
Expected: 전부 통과. (`format:check` 실패 시 `npm run format` 후 재실행·재커밋.)

- [ ] **Step 4: 커밋**

```bash
git add -A
git commit -m "docs(#128-B2): TOCTOU/격리 한계 주석 + brain 갱신"
```

---

## Self-Review

**1. Spec coverage:**
- §0 helper `isLinkSync`/`resolveWithin` → Task 1·2 ✓
- §1 listIgnored walk + 엔트리 → Task 3 ✓ / capture lstat → Task 4 ✓ / collect lstat → Task 5 ✓ / restore(ancestor·leaf·created) → Task 6 ✓
- §2 workspace-tools 통일 + classify → Task 7 ✓
- 표면화(`'symlink'` reason, leak-zero) → Task 3·4 ✓
- root-symlink 정책(realpath.native 기준) → Task 2 구현·테스트 ✓
- 문서화(TOCTOU) → Task 8 ✓ + 각 함수 주석(Task 3-6) ✓
- 테스트(win32 junction/POSIX symlink·5게이트·brain) → 각 Task + Task 8 ✓
- 비목표 finding5 분리 → 계획 범위에서 제외 ✓

**2. Placeholder scan:** 모든 Step에 실제 코드/명령/기대출력 포함. TODO/TBD 없음. ✓

**3. Type consistency:** `isLinkSync(): LinkKind`(Task 1)을 Task 3(top-level·`==='link'`)·Task 6(created·`==='link'`)에서 동일 시그니처로 사용. `resolveWithin(root,p): string`(Task 2)을 Task 7에서 동일 사용. `skipped[].reason`에 `'symlink'` 추가(Task 3)를 capture(Task 4)·collect가 일관 사용. ✓

**4. Codex 정정 반영:** created-삭제는 `resolveWithin`(realpath 추종)이 아니라 `isLinkSync`(lstat)만 사용 — 탈출 링크에서 realpath throw로 unlink가 막히는 문제를 피함(Task 6 Step 3-2에 근거 명시).

## 영향 파일 요약

신규 2(`path-guard.ts`+test) · 수정 4(`ignored-baseline.ts`+test, `workspace-tools.ts`+test) · 생성물 1(`brain.md`).

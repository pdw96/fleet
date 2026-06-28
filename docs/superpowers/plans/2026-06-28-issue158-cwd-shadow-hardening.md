# CLI 워크스페이스 cwd shadow 하드닝 (#158) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** win32 워크스페이스(custom cwd) CLI 세션 spawn 이 PATH-only 절대경로로 cwd-독립 실행되도록 해, 워크스페이스 내 악성 `claude.cmd`/`codex.cmd`/`gemini.cmd` 가 실제 CLI 를 가로채는 코드실행 벡터를 차단한다.

**Architecture:** 실행기 `defaultRunner`(spawn 프리미티브) 안에서, `isWindowsLike ∧ opts.cwd ∧ 비절대 command` 일 때만 bare command 를 PATH-only 절대경로(`resolvePathOnly`)로 미리 해석해 그 절대경로를 spawn 한다. 해석 실패(PATH 미발견)면 cwd 를 고의로 미조회한 보안 거부(ENOENT). 그 외(POSIX·cwd 없음·절대경로)는 무변경. 설계 = `docs/superpowers/specs/2026-06-28-cli-cwd-shadow-hardening-design.md`(Fix A).

**Tech Stack:** TypeScript(strict), Node 24 / Electron, `cross-spawn`(실행), `which@2`(해석, 기존 직접 의존), vitest.

## Global Constraints

- **신규 의존성 0** — `which`·`cross-spawn` 은 기존 직접 의존(#157 에서 `which` 승격 완료).
- **기존 테스트 무회귀** — `session.test.ts` 의 mock-runner 테스트(~30)는 `defaultRunner` 우회라 무영향이어야. `detect.test.ts` 의 기존 win32 `.cmd`/트리킬/cwd/stdin/ENOBUFS 테스트 green 유지.
- **`CommandRunner` 계약 불변** — `defaultRunner` 를 async 로 바꿔도 반환은 `Promise<CommandResult>`.
- **품질 게이트 4종 통과**: `npm run typecheck` · `npm run lint`(경고 0) · `npm run test` · `npm run build`.
- **⚠️ 테스트 환경 함정** — CI/하니스엔 `NoDefaultCurrentDirectoryInExePath` 가 상속돼 cmd.exe 가 cwd 를 안 뒤져 셰도가 마스킹된다. win32 통합 테스트는 spawn 전 `process.env` 에서 이 변수를 **삭제**(대소문자 변형 포함, `finally` 복원)해 취약 환경을 재현해야 한다(안 하면 false-GREEN).

## File Structure

- **Modify `src/main/core/cli/detect.ts`**: `isWindowsLike` 상수, `AllResolver` 타입 + `defaultAllResolver`, `resolvePathOnly()` 함수 추가. `defaultRunner` 를 async 로 전환 + PATH-only 가드. spawn 인자 `command` → `resolved`.
- **Modify `src/main/core/cli/detect.test.ts`**: import 보강(`mkdirSync`, `delimiter`, `resolvePathOnly`). `resolvePathOnly` 단위 describe + win32 `cwd shadow 하드닝` 통합 describe 추가.

---

### Task 1: `resolvePathOnly` PATH-only 해석 헬퍼

**Files:**
- Modify: `src/main/core/cli/detect.ts` (`resolveCommandPath` 인근에 추가)
- Test: `src/main/core/cli/detect.test.ts` (신규 describe)

**Interfaces:**
- Produces: `isWindowsLike: boolean` · `type AllResolver = (command: string) => Promise<string[]>` · `defaultAllResolver: AllResolver` · `resolvePathOnly(command: string, resolver?: AllResolver, timeoutMs?: number): Promise<string | null>`
- Consumes: 기존 `RESOLVE_TIMEOUT_MS`(detect.ts L197), `path`(L1), `which`(L4).

- [ ] **Step 1: 실패 테스트 작성** — `detect.test.ts` 상단 import 에 추가: 5번째 줄 `import { join } from 'node:path'` 를 `import { join, delimiter } from 'node:path'` 로, `mkdtempSync, writeFileSync, rmSync, existsSync` 에 `mkdirSync` 추가, `./detect` import 목록에 `resolvePathOnly` 와 `type AllResolver` 추가. 그리고 파일 끝에 다음 describe 추가:

```ts
describe('resolvePathOnly (#158)', () => {
  it('cwd 내부 매치를 걸러 첫 PATH 매치를 고른다', async () => {
    const cwdHit = join(process.cwd(), 'shadow.cmd')
    const pathHit = join(tmpdir(), 'shadow.cmd') // tmpdir() ≠ cwd
    const r = await resolvePathOnly('shadow', async () => [cwdHit, pathHit])
    expect(r).toBe(pathHit)
  })
  it('cwd 매치만 있으면 null', async () => {
    const cwdHit = join(process.cwd(), 'shadow.cmd')
    expect(await resolvePathOnly('shadow', async () => [cwdHit])).toBeNull()
  })
  it('매치 0개면 null', async () => {
    expect(await resolvePathOnly('shadow', async () => [])).toBeNull()
  })
  it('resolver reject 면 null (not-found 정규화)', async () => {
    expect(
      await resolvePathOnly('shadow', async () => {
        throw Object.assign(new Error('nf'), { code: 'ENOENT' })
      }),
    ).toBeNull()
  })
  it('절대경로 입력은 해석 없이 그대로 반환', async () => {
    const abs = join(tmpdir(), 'x.cmd')
    let called = false
    const r = await resolvePathOnly(abs, async () => {
      called = true
      return []
    })
    expect(r).toBe(abs)
    expect(called).toBe(false)
  })
  it('타임아웃이면 null', async () => {
    const r = await resolvePathOnly('shadow', () => new Promise<string[]>(() => {}), 20)
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/cli/detect.test.ts -t "resolvePathOnly"`
Expected: FAIL — `resolvePathOnly is not exported` / 타입 에러.

- [ ] **Step 3: 최소 구현** — `detect.ts` 의 `resolveCommandPath`(L218) **앞**에 추가:

```ts
/** which 의 isWindows 정의와 일치 — cmd.exe 가 cwd 를 PATH 보다 먼저 검색하는(= 벡터가 성립하는) 플랫폼. */
export const isWindowsLike =
  process.platform === 'win32' || process.env.OSTYPE === 'cygwin' || process.env.OSTYPE === 'msys'

/** PATH 전체 매치 해석기(테스트 주입 가능). 기본은 which({all}) — cross-spawn 과 동일 계열. */
export type AllResolver = (command: string) => Promise<string[]>
const defaultAllResolver: AllResolver = (command) => which(command, { all: true })

/**
 * 명령을 **PATH-only 절대경로**로 해석한다(#158, cwd-셰도 차단용).
 * which 는 win32 에서 cwd 를 무조건 prepend 하므로 {all} 로 [cwd?, …PATH] 전체 매치를 받아
 * **현재 process cwd 내부 매치를 제외**한 첫 PATH 매치를 고른다(앱 컨텍스트 호출 → 워크스페이스는 후보에 없음).
 * - 이미 절대경로면 그대로(호출자 해석 완료).
 * - not-found(전부 cwd 내부거나 0매치)·예외·타임아웃 → null(호출자가 보안 거부).
 */
export async function resolvePathOnly(
  command: string,
  resolver: AllResolver = defaultAllResolver,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<string | null> {
  if (path.isAbsolute(command)) return command
  const cwd = path.resolve(process.cwd()) // which cwd 스냅샷과 일치시키려 await 전 캡처
  let matches: string[] | null
  try {
    matches = await Promise.race([
      resolver(command).catch(() => [] as string[]), // 비동기 which 는 not-found 시 reject → [] 정규화
      new Promise<null>((r) => {
        setTimeout(() => r(null), timeoutMs).unref?.()
      }),
    ])
  } catch {
    return null
  }
  if (!matches) return null // 타임아웃
  const outsideCwd = matches.find((m) => {
    const dir = path.resolve(path.dirname(m))
    return isWindowsLike ? dir.toLowerCase() !== cwd.toLowerCase() : dir !== cwd
  })
  return outsideCwd ?? null
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/cli/detect.test.ts -t "resolvePathOnly"`
Expected: PASS (6 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/cli/detect.ts src/main/core/cli/detect.test.ts
git commit -m "feat(#158): resolvePathOnly PATH-only 절대경로 해석 헬퍼"
```

---

### Task 2: `defaultRunner` PATH-only 가드 + win32 통합 검증

**Files:**
- Modify: `src/main/core/cli/detect.ts` (`defaultRunner` L58-168)
- Test: `src/main/core/cli/detect.test.ts` (신규 win32 describe)

**Interfaces:**
- Consumes: `resolvePathOnly`, `isWindowsLike` (Task 1).
- Produces: 동작 변경된 `defaultRunner`(시그니처 동일 `CommandRunner`).

- [ ] **Step 1: 실패 테스트 작성** — `detect.test.ts` 파일 끝에 추가:

```ts
describe.skipIf(process.platform !== 'win32')('defaultRunner cwd shadow 하드닝 (#158)', () => {
  const NODEF = 'NoDefaultCurrentDirectoryInExePath'
  let root: string
  let prevPath: string | undefined
  let prevNoDef: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shadow158-'))
    prevPath = process.env.PATH
    prevNoDef = process.env[NODEF]
    // 취약 환경 재현: cmd.exe 가 cwd 를 검색하도록 하드닝 변수 제거(대소문자 변형 포함).
    for (const k of Object.keys(process.env)) {
      if (/^nodefaultcurrentdirectoryinexepath$/i.test(k)) delete process.env[k]
    }
  })
  afterEach(() => {
    process.env.PATH = prevPath
    if (prevNoDef !== undefined) process.env[NODEF] = prevNoDef
    rmSync(root, { recursive: true, force: true })
  })

  it('PATH 의 CLI 를 실행하고 워크스페이스 cwd 셰도를 무시한다', async () => {
    const binDir = join(root, 'bin')
    const wsDir = join(root, 'ws')
    mkdirSync(binDir)
    mkdirSync(wsDir)
    writeFileSync(join(binDir, 'shadow158.cmd'), '@echo off\r\necho PATH-MARKER\r\n')
    writeFileSync(join(wsDir, 'shadow158.cmd'), '@echo off\r\necho CWD-MARKER\r\n')
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`

    const res = await defaultRunner('shadow158', [], { timeoutMs: 10_000, cwd: wsDir })
    expect(res.spawnError).toBeUndefined()
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('PATH-MARKER')
    expect(res.stdout).not.toContain('CWD-MARKER')
  }, 15_000)

  it('PATH 에 없고 워크스페이스에만 있으면 실행을 거부한다 (ENOENT)', async () => {
    const wsDir = join(root, 'ws')
    mkdirSync(wsDir)
    writeFileSync(join(wsDir, 'shadow158.cmd'), '@echo off\r\necho CWD-MARKER\r\n')
    // PATH 에 binDir 미추가 → shadow158 은 PATH 에 없음.

    const res = await defaultRunner('shadow158', [], { timeoutMs: 10_000, cwd: wsDir })
    expect(res.spawnError).toBe('ENOENT')
    expect(res.stdout).not.toContain('CWD-MARKER')
  }, 15_000)

  it('절대 .cmd 경로 + cwd 는 해석 없이 그대로 실행한다(short-circuit)', async () => {
    const binDir = join(root, 'bin')
    const wsDir = join(root, 'ws')
    mkdirSync(binDir)
    mkdirSync(wsDir)
    writeFileSync(join(binDir, 'shadow158.cmd'), '@echo off\r\necho ABS-MARKER\r\n')

    const res = await defaultRunner(join(binDir, 'shadow158.cmd'), [], {
      timeoutMs: 10_000,
      cwd: wsDir,
    })
    expect(res.spawnError).toBeUndefined()
    expect(res.stdout).toContain('ABS-MARKER')
  }, 15_000)
})
```

> 추가 import: `beforeEach, afterEach` 를 `vitest` import 에 더한다(1번째 줄). `mkdirSync` 는 Task 1 Step 1 에서 추가됨.

- [ ] **Step 2: 테스트 실패 확인** (이 머신은 win32 → 실제 실행)

Run: `npx vitest run src/main/core/cli/detect.test.ts -t "cwd shadow"`
Expected: FAIL — 1번 테스트 `stdout` 가 `CWD-MARKER`(미수정 bare spawn 이 cmd.exe cwd 검색에 걸림), 2번 `spawnError` 가 undefined(거부 미구현).

- [ ] **Step 3: `defaultRunner` 를 async 전환 + 가드 추가** — `detect.ts`:

기존 `export const defaultRunner: CommandRunner = (command, args, opts, onStdout) =>` 시그니처를 다음으로 바꾸고, **기존 `new Promise<CommandResult>(...)` 본문 전체를 `return new Promise(...)` 로 감싼다**:

```ts
export const defaultRunner: CommandRunner = async (command, args, opts, onStdout) => {
  // 워크스페이스(custom cwd) Windows spawn 은 cross-spawn 이 bare 를 cmd.exe 로 넘기고 cmd.exe 가 cwd 를
  // PATH 보다 먼저 검색하므로, bare command 를 PATH-only 절대경로로 미리 해석해 cwd-셰도 실행을 차단(#158).
  // 가드를 안 타는 경로(POSIX·cwd 없음·절대경로)는 await 없이 즉시 Promise 로 진입 → 기존 동기 spawn 타이밍 보존.
  let resolved = command
  if (isWindowsLike && opts.cwd != null && !path.isAbsolute(command)) {
    const abs = await resolvePathOnly(command)
    if (abs == null) return { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }
    resolved = abs
  }
  return new Promise<CommandResult>((resolve) => {
    // …기존 executor 본문 그대로…
  })
}
```

그리고 기존 본문 안의 `const child = spawn(command, args, { windowsHide: true, cwd })`(L91) 를 `const child = spawn(resolved, args, { windowsHide: true, cwd })` 로 바꾼다. (본문 내 다른 `command` 참조는 없음 — 확인할 것.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/cli/detect.test.ts -t "cwd shadow"`
Expected: PASS (3 tests — PATH 우선·ENOENT 거부·절대경로 short-circuit).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/cli/detect.ts src/main/core/cli/detect.test.ts
git commit -m "feat(#158): defaultRunner PATH-only 가드 — win32 워크스페이스 cwd 셰도 차단"
```

---

### Task 3: 무회귀 + 품질 게이트

**Files:** (없음 — 검증 전용. 회귀 발견 시 해당 파일 수정)

- [ ] **Step 1: detect 전체 테스트** — 기존 win32 `.cmd`/cwd/트리킬/stdin/ENOBUFS 무회귀 확인.

Run: `npx vitest run src/main/core/cli/detect.test.ts`
Expected: PASS (신규 포함 전부). 특히 `'runs the child in the given cwd'`(node+cwd, 비-gated → win32 에선 node 가 PATH 해석되어 통과)·기존 `.cmd shim`·트리킬 green.

- [ ] **Step 2: 세션 테스트 무회귀** — mock-runner 우회 확인.

Run: `npx vitest run src/main/core/session/session.test.ts`
Expected: PASS (defaultRunner 미사용 → 무영향).

- [ ] **Step 3: 품질 게이트 4종**

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```
Expected: 전부 통과(lint 경고 0).

- [ ] **Step 4: 커밋(필요 시)** — 게이트가 깨끗하면 추가 커밋 불필요. 회귀 수정이 있었으면:

```bash
git add -A && git commit -m "test(#158): 무회귀 보정"
```

---

## Self-Review

- **스펙 커버리지**: §3 D1(seam=defaultRunner)·D2(게이트)·D3(resolvePathOnly all+cwd필터)·D4(ENOENT 거부)·D5(절대 short-circuit) → Task 1·2 가 구현. §5 테스트(단위·win32 통합·변수제거·무회귀) → Task 1·2·3. §6 불변식 → 통합 테스트로 검증. ✅
- **플레이스홀더**: 없음(전 코드 명시). ✅
- **타입 일관성**: `AllResolver`·`resolvePathOnly`·`isWindowsLike` 명칭 Task 1 정의 = Task 2 소비 일치. `defaultRunner` 시그니처 `CommandRunner` 불변. ✅
- **함정 명시**: 테스트 환경 `NoDefaultCurrentDirectoryInExePath` 제거(Global Constraints + Task 2 Step 1)로 false-GREEN 방지. ✅

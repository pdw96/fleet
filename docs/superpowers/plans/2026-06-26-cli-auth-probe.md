# CLI 세션 "연결 테스트" probe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** picker 구독 CLI 등록 단계에서 "연결 테스트" 버튼으로 실 모델 1회 왕복 probe 를 돌려 로그인 여부를 transient 하게 확인한다(저장·차단 없음).

**Architecture:** main `probeCliAuth`(순수 함수) → `engine.probeCli`(registry 라우팅) → IPC `fleet:cli:probe`(parity 3곳) → renderer `AddAiWizard` "연결 테스트" 버튼. 기존 `buildHeadlessArgs`·`classifyCliAuthHint`·`defaultRunner` 재사용. 신규 dep 0.

**Tech Stack:** TypeScript · Electron(main/preload/renderer) · vitest · cross-spawn(기존 runner).

스펙: `docs/superpowers/specs/2026-06-26-cli-auth-probe-design.md` (Codex 설계+스펙 리뷰 반영본).

## Global Constraints

- **신규 런타임 dependency 0** — 기존 `buildHeadlessArgs`(`src/main/core/session/cli-session.ts:12`)·`classifyCliAuthHint`(`src/main/core/cli/authHint.ts`)·`defaultRunner`/`CommandRunner`/`CommandResult`(`src/main/core/cli/detect.ts`) 재사용.
- **`probeCliAuth` never-throws** — 모든 분기(spawnError/timeout/auth/error/ok)에서 reject 금지. 테스트로 고정.
- **transient·비저장·비차단** — descriptor/store 확장 금지(`authStatus` 필드 미도입). probe 실패가 등록을 막지 않는다.
- **실 CLI 호출 테스트 금지** — 전부 mock runner. CI/E2E 에서 외부 CLI/로그인/쿼터 의존 금지.
- **IPC 경계 불신** — main/core 의 `cliRegistry.get(adapterId)` 로 검증. unknown id → `{ status: 'error' }`(throw 아님).
- **상수**: `PROBE_PROMPT = 'Reply with: ok'` · `PROBE_TIMEOUT_MS = 20_000` · `DETAIL_MAX = 500`.
- **detail sanitize**: stderr 우선(비면 stdout) → ANSI/제어시퀀스 제거 → `DETAIL_MAX` truncation.
- **품질 게이트 4종 (각 작업 커밋 전/후 관련 항목 green)**: `npm run typecheck` · `npm run lint` · `npm run format:check` · `npm run test`.
- **커밋 트레일러**: 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 와 `Claude-Session: https://claude.ai/code/session_01ATAm6fQgqgDtAPT4skrsaj` 2줄. PR 본문 = `Closes #150` + `Part of #145`.
- 작업 브랜치: `feat/150-cli-auth-probe` (이미 생성·푸시됨).

---

## File Structure

- **Create** `src/main/core/cli/probe.ts` — `ProbeResult` 분류 순수 함수 `probeCliAuth` + `PROBE_PROMPT`/`PROBE_TIMEOUT_MS`/`DETAIL_MAX` 상수 + 로컬 `sanitizeDetail`.
- **Create** `src/main/core/cli/probe.test.ts` — probeCliAuth 단위 테스트(mock runner).
- **Modify** `src/shared/types.ts` — `ProbeStatus`/`ProbeResult` 타입 추가 + `FleetBridge.probeCli` 선언.
- **Modify** `src/main/core/engine.ts` — `FleetEngine.probeCli` 선언(인터페이스) + 팩토리 구현.
- **Modify** `src/main/core/engine.test.ts` — `probeCli` 라우팅·unknown-id 테스트.
- **Modify** `src/main/index.ts` — `fleet:cli:probe` 핸들러.
- **Modify** `src/preload/index.ts` — `probeCli` 브리지.
- **Modify** `src/renderer/components/AddAiWizard.tsx` — "연결 테스트" 버튼 + transient 결과.
- **Modify** `src/renderer/components/AddAiWizard.test.tsx` — 버튼/결과/비차단/비저장 테스트.

---

## Task 1: `probeCliAuth` 순수 함수 + `ProbeResult` 타입

**Files:**
- Create: `src/main/core/cli/probe.ts`
- Create: `src/main/core/cli/probe.test.ts`
- Modify: `src/shared/types.ts` (타입만 — `ProbeStatus`/`ProbeResult` 추가)

**Interfaces:**
- Consumes: `buildHeadlessArgs(adapter: CliAdapter, prompt: string): string[]` (`src/main/core/session/cli-session.ts`) · `classifyCliAuthHint(adapter: CliAdapter, res: CommandResult): string | null` (`src/main/core/cli/authHint.ts`) · `defaultRunner`/`CommandRunner`/`CommandResult` (`src/main/core/cli/detect.ts`).
- Produces: `probeCliAuth(adapter: CliAdapter, runner?: CommandRunner): Promise<ProbeResult>` · `ProbeResult`/`ProbeStatus` (shared) · `PROBE_PROMPT`/`PROBE_TIMEOUT_MS` 상수(export).

- [ ] **Step 1: `ProbeResult` 타입 추가 (shared)**

`src/shared/types.ts` 의 `CliAdapterId`(L17) 근처(또는 CLI 관련 타입 블록 끝)에 추가:

```ts
// CLI 세션 "연결 테스트" probe 결과(#150). transient — 저장하지 않는다.
export type ProbeStatus = 'ok' | 'auth' | 'error' | 'timeout'
export interface ProbeResult {
  status: ProbeStatus
  /** status==='auth' — classifyCliAuthHint 결과(advisory). */
  hint?: string
  /** status==='error' — sanitize 된 stderr/stdout(또는 spawnError). */
  detail?: string
}
```

- [ ] **Step 2: 실패 테스트 작성 (probe.test.ts)**

`src/main/core/cli/probe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CliAdapter } from '../../../shared/types'
import type { CommandResult, CommandRunner, RunOpts } from './detect'
import { PROBE_PROMPT, PROBE_TIMEOUT_MS, probeCliAuth } from './probe'

const claude: CliAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],
  promptVia: 'stdin',
  headless: { args: ['-p'] },
  auth: { loginCommand: 'claude /login', docsUrl: 'https://docs.anthropic.com' },
}

// 호출 인자를 캡처하면서 지정 결과를 돌려주는 mock runner.
function mockRunner(result: CommandResult): {
  runner: CommandRunner
  calls: { command: string; args: string[]; opts: RunOpts; stdin?: string }[]
} {
  const calls: { command: string; args: string[]; opts: RunOpts; stdin?: string }[] = []
  const runner: CommandRunner = (command, args, opts) => {
    calls.push({ command, args, opts, stdin: opts.stdinInput })
    return Promise.resolve(result)
  }
  return { runner, calls }
}

const ok = (over: Partial<CommandResult> = {}): CommandResult => ({
  code: 0,
  stdout: 'ok',
  stderr: '',
  ...over,
})

describe('probeCliAuth', () => {
  it('exit 0 → ok', async () => {
    const { runner } = mockRunner(ok())
    expect(await probeCliAuth(claude, runner)).toEqual({ status: 'ok' })
  })

  it('exit≠0 + auth stderr → auth + hint', async () => {
    const { runner } = mockRunner(ok({ code: 1, stdout: '', stderr: 'Error: not logged in' }))
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('auth')
    expect(r.hint).toContain('claude /login')
  })

  it('exit≠0 + 비-auth stderr → error + detail', async () => {
    const { runner } = mockRunner(ok({ code: 2, stdout: '', stderr: 'syntax error near unexpected token' }))
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('error')
    expect(r.detail).toContain('syntax error')
  })

  it('spawnError ETIMEDOUT → timeout', async () => {
    const { runner } = mockRunner({ code: null, stdout: '', stderr: '', spawnError: 'ETIMEDOUT' })
    expect(await probeCliAuth(claude, runner)).toEqual({ status: 'timeout' })
  })

  it('spawnError ABORTED → timeout', async () => {
    const { runner } = mockRunner({ code: null, stdout: '', stderr: '', spawnError: 'ABORTED' })
    expect(await probeCliAuth(claude, runner)).toEqual({ status: 'timeout' })
  })

  it('spawnError ENOBUFS → error (timeout 아님)', async () => {
    const { runner } = mockRunner({ code: null, stdout: '', stderr: 'x', spawnError: 'ENOBUFS' })
    expect((await probeCliAuth(claude, runner)).status).toBe('error')
  })

  it('argv=buildHeadlessArgs · stdin=PROBE_PROMPT(stdin 어댑터) · timeout 상수 전달', async () => {
    const { runner, calls } = mockRunner(ok())
    await probeCliAuth(claude, runner)
    expect(calls[0].command).toBe('claude')
    expect(calls[0].args).toEqual(['-p'])
    expect(calls[0].stdin).toBe(PROBE_PROMPT)
    expect(calls[0].opts.timeoutMs).toBe(PROBE_TIMEOUT_MS)
  })

  it("promptVia:'arg' 어댑터 → stdin 없음 · argv 에 PROBE_PROMPT 치환", async () => {
    const argAdapter: CliAdapter = {
      ...claude,
      promptVia: 'arg',
      headless: { args: ['run', '{prompt}'] },
    }
    const { runner, calls } = mockRunner(ok())
    await probeCliAuth(argAdapter, runner)
    expect(calls[0].stdin).toBeUndefined()
    expect(calls[0].args).toEqual(['run', PROBE_PROMPT])
  })

  it('headless 없는 어댑터 → buildHeadlessArgs fallback [PROBE_PROMPT]', async () => {
    const noHeadless: CliAdapter = { ...claude, promptVia: 'arg', headless: undefined }
    const { runner, calls } = mockRunner(ok())
    await probeCliAuth(noHeadless, runner)
    expect(calls[0].args).toEqual([PROBE_PROMPT])
  })

  it('detail: ANSI/제어시퀀스 제거 + 500자 truncation', async () => {
    const noisy = `[31mnot a hint[0m ` + 'x'.repeat(600)
    const { runner } = mockRunner(ok({ code: 1, stdout: '', stderr: noisy }))
    const r = await probeCliAuth(claude, runner)
    expect(r.detail).not.toContain('')
    expect((r.detail ?? '').length).toBeLessThanOrEqual(500)
  })

  it('어떤 결과에서도 throw 하지 않는다(never-throws)', async () => {
    for (const res of [
      ok(),
      ok({ code: 1, stderr: 'not logged in' }),
      { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' } as CommandResult,
    ]) {
      const { runner } = mockRunner(res)
      await expect(probeCliAuth(claude, runner)).resolves.toBeDefined()
    }
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/main/core/cli/probe.test.ts`
Expected: FAIL — `probe.ts` 미존재("Cannot find module './probe'").

- [ ] **Step 4: `probe.ts` 구현**

`src/main/core/cli/probe.ts`:

```ts
import type { CliAdapter, ProbeResult } from '../../../shared/types'
import { buildHeadlessArgs } from '../session/cli-session'
import { classifyCliAuthHint } from './authHint'
import { type CommandRunner, defaultRunner } from './detect'

/** probe 최소 프롬프트 — 토큰 최소화. 모델 출력은 검사하지 않는다(exit+stderr만). */
export const PROBE_PROMPT = 'Reply with: ok'
/** probe 타임아웃 — 모델 왕복 여유 + runner kill-tree 보호. */
export const PROBE_TIMEOUT_MS = 20_000
const DETAIL_MAX = 500

// CSI(ANSI) escape sequence + C0 제어문자(탭/개행/CR 제외) 제거 → renderer 인라인 표시 안정화·민감 토막 노출 최소화.
const ANSI_CSI = /\[[0-9;:?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const C0_CTRL = /[ --]/g

function sanitizeDetail(primary: string, fallback: string): string {
  const raw = (primary.trim() || fallback.trim()).replace(ANSI_CSI, '').replace(C0_CTRL, '').trim()
  return raw.slice(0, DETAIL_MAX)
}

/**
 * CLI 세션 "연결 테스트"(#150) — headless 호출 1회로 로그인 여부를 transient 하게 확인한다.
 * never-throws: 모든 실패를 ProbeResult 로 정규화한다(등록 비차단). 결과는 저장하지 않는다.
 */
export async function probeCliAuth(
  adapter: CliAdapter,
  runner: CommandRunner = defaultRunner,
): Promise<ProbeResult> {
  const args = buildHeadlessArgs(adapter, PROBE_PROMPT)
  const stdinInput = adapter.promptVia === 'stdin' ? PROBE_PROMPT : undefined
  const res = await runner(adapter.command, args, { timeoutMs: PROBE_TIMEOUT_MS, stdinInput })

  if (res.spawnError) {
    return res.spawnError === 'ETIMEDOUT' || res.spawnError === 'ABORTED'
      ? { status: 'timeout' }
      : { status: 'error', detail: res.spawnError }
  }
  if (res.code === 0) return { status: 'ok' }

  const hint = classifyCliAuthHint(adapter, res)
  if (hint) return { status: 'auth', hint }
  return { status: 'error', detail: sanitizeDetail(res.stderr, res.stdout) }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/core/cli/probe.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: 게이트 + 커밋**

Run: `npm run typecheck && npm run lint && npm run format:check`
Expected: 모두 통과.

```bash
git add src/main/core/cli/probe.ts src/main/core/cli/probe.test.ts src/shared/types.ts
git commit -m "feat(#150): probeCliAuth 순수 함수 + ProbeResult 타입

headless 1회 호출로 로그인 여부 분류(ok/auth/error/timeout). never-throws·
detail sanitize(ANSI/제어 제거+500자). buildHeadlessArgs·classifyCliAuthHint·
defaultRunner 재사용. mock-only 12 테스트.

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATAm6fQgqgDtAPT4skrsaj"
```

---

## Task 2: `engine.probeCli` 라우팅

**Files:**
- Modify: `src/main/core/engine.ts` (인터페이스 `FleetEngine` ~L113 · 팩토리 return ~L466)
- Modify: `src/main/core/engine.test.ts`

**Interfaces:**
- Consumes: `probeCliAuth` (Task 1) · `cliRegistry.get(id)` · 팩토리 내 `runner`(`engine.ts:186`).
- Produces: `engine.probeCli(adapterId: string): Promise<ProbeResult>`.

- [ ] **Step 1: 실패 테스트 작성 (engine.test.ts)**

`src/main/core/engine.test.ts` 에 추가(기존 `detectClis` 테스트 근처, mock runner 주입 패턴 동형):

```ts
it('probeCli: 알려진 adapter 는 probeCliAuth 결과를 반환한다', async () => {
  const engine = createFleetEngine({
    runner: () => Promise.resolve({ code: 0, stdout: 'ok', stderr: '' }),
  })
  expect(await engine.probeCli('claude')).toEqual({ status: 'ok' })
})

it('probeCli: unknown adapterId → throw 없이 {status:error}', async () => {
  const engine = createFleetEngine({
    runner: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  })
  const r = await engine.probeCli('nope')
  expect(r.status).toBe('error')
})
```

> 참고: `createFleetEngine` 의 정확한 옵션 시그니처는 기존 `engine.test.ts` 의 `detectClis` 테스트(파일 상단)에서 쓰는 형태를 그대로 따른다(runner 주입).

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t probeCli`
Expected: FAIL — `engine.probeCli is not a function`.

- [ ] **Step 3: 인터페이스 + 구현 추가**

`src/main/core/engine.ts` 인터페이스(`detectClis` 선언 아래, ~L113):

```ts
  /** CLI 세션 "연결 테스트"(#150) — headless 1회 호출로 로그인 여부 확인. unknown id → {status:'error'}. */
  probeCli(adapterId: string): Promise<ProbeResult>
```

상단 import 에 `probeCliAuth` 추가 + `ProbeResult` 타입 import:

```ts
import { probeCliAuth } from './cli/probe'
```
(`ProbeResult` 는 `import type { ... } from '../../shared/types'` 기존 묶음에 추가.)

팩토리 return 객체(`detectClis()` 바로 아래, ~L468):

```ts
    probeCli(adapterId) {
      const adapter = cliRegistry.get(adapterId)
      if (!adapter) return Promise.resolve({ status: 'error', detail: 'unknown adapter' })
      return probeCliAuth(adapter, runner)
    },
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t probeCli`
Expected: PASS.

- [ ] **Step 5: 게이트 + 커밋**

Run: `npm run typecheck && npm run lint && npm run format:check`

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(#150): engine.probeCli — registry 라우팅(unknown→error)

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATAm6fQgqgDtAPT4skrsaj"
```

---

## Task 3: IPC parity (main · preload · FleetBridge)

**Files:**
- Modify: `src/shared/types.ts` (`FleetBridge` ~L522, `openCliDocs` 아래)
- Modify: `src/main/index.ts` (~L93, `openDocs` 핸들러 근처)
- Modify: `src/preload/index.ts` (~L25, `openCliDocs` 아래)

**Interfaces:**
- Consumes: `engine.probeCli` (Task 2) · `ProbeResult`/`CliAdapterId` (shared).
- Produces: `window.fleet.probeCli(adapterId: CliAdapterId): Promise<ProbeResult>`.

> 이 작업은 얇은 배선이라 단위 테스트 대신 `typecheck`(3 영역 parity)로 검증한다. 런타임 검증은 Task 4 의 렌더러 테스트가 `window.fleet.probeCli` mock 으로 커버.

- [ ] **Step 1: `FleetBridge` 선언 추가**

`src/shared/types.ts` `openCliDocs(...)`(L522) 아래:

```ts
  /** CLI 세션 "연결 테스트"(#150) — adapterId만 전달, main 이 probe 수행. 결과는 transient(비저장). */
  probeCli(adapterId: CliAdapterId): Promise<ProbeResult>
```

- [ ] **Step 2: main 핸들러 추가**

`src/main/index.ts` `fleet:external:openDocs` 핸들러(L93-95) 아래:

```ts
  ipcMain.handle('fleet:cli:probe', (_e, adapterId: CliAdapterId) => engine.probeCli(adapterId))
```

- [ ] **Step 3: preload 브리지 추가**

`src/preload/index.ts` `openCliDocs`(L25) 아래:

```ts
  probeCli: (adapterId) => ipcRenderer.invoke('fleet:cli:probe', adapterId),
```

- [ ] **Step 4: 게이트(typecheck) + 커밋**

Run: `npm run typecheck && npm run lint && npm run format:check`
Expected: 통과(3곳 parity 일치 — 불일치 시 TS 에러).

```bash
git add src/shared/types.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(#150): probe IPC parity (fleet:cli:probe · preload · FleetBridge)

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATAm6fQgqgDtAPT4skrsaj"
```

---

## Task 4: `AddAiWizard` "연결 테스트" 버튼 + transient 결과

**Files:**
- Modify: `src/renderer/components/AddAiWizard.tsx` (구독 step `installed` 분기 ~L200-261)
- Modify: `src/renderer/components/AddAiWizard.test.tsx`

**Interfaces:**
- Consumes: `window.fleet.probeCli(adapterId): Promise<ProbeResult>` (Task 3).
- Produces: (UI only) — "연결 테스트" 버튼·상태별 transient 결과 텍스트.

- [ ] **Step 1: 실패 테스트 작성 (AddAiWizard.test.tsx)**

기존 테스트의 `window.fleet` mock 패턴을 따라(파일 상단 mock 정의 확인), 구독 step 까지 진입하는 헬퍼를 재사용해 추가:

```tsx
it('연결 테스트 성공 → transient 성공 문구(저장 안 됨) · 등록 비호출', async () => {
  const probeCli = vi.fn().mockResolvedValue({ status: 'ok' })
  const registerCliSession = vi.fn()
  // window.fleet mock 에 probeCli/registerCliSession/detectClis(claude installed) 주입
  // ... (기존 헬퍼로 subscription step + installed 상태 진입)
  await user.click(screen.getByRole('button', { name: '연결 테스트' }))
  expect(probeCli).toHaveBeenCalledWith('claude')
  expect(await screen.findByText(/방금 연결 테스트 성공/)).toBeInTheDocument()
  expect(registerCliSession).not.toHaveBeenCalled() // probe 는 등록과 무관(비저장)
})

it('연결 테스트 실패(auth) → hint 표시 · 등록 버튼 여전히 동작(비차단)', async () => {
  const probeCli = vi.fn().mockResolvedValue({ status: 'auth', hint: '💡 인증 문제일 수 있습니다 — claude /login' })
  // ... 진입
  await user.click(screen.getByRole('button', { name: '연결 테스트' }))
  expect(await screen.findByText(/인증 문제일 수 있습니다/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '검증 없이 등록' })).toBeEnabled()
})
```

> mock/진입 헬퍼의 정확한 형태는 기존 `AddAiWizard.test.tsx` 상단(detectClis·installed 분기 진입 테스트)에서 복사한다. 새 mock 메서드는 `probeCli` 뿐.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx -t 연결`
Expected: FAIL — "연결 테스트" 버튼 미존재.

- [ ] **Step 3: 컴포넌트 구현**

`AddAiWizard.tsx` 상단 상태(L59 `submitting` 아래)에 추가:

```tsx
  // 연결 테스트(probe) — transient 결과(저장 안 함, #150)
  const [probing, setProbing] = useState(false)
  const [probeMsg, setProbeMsg] = useState<string | null>(null)
```

import 에 `ProbeResult` 타입 추가(기존 shared import 묶음).

`installed` 분기의 "검증 없이 등록" 버튼(L237-259) 바로 아래에 추가:

```tsx
            <button
              type="button"
              disabled={probing}
              title="선택한 CLI로 짧은 실제 모델 호출을 1회 실행합니다. 구독/쿼터/요금이 사용될 수 있습니다."
              onClick={() => {
                setProbeMsg(null)
                setProbing(true)
                void window.fleet
                  .probeCli(adapterId)
                  .then((r: ProbeResult) => setProbeMsg(probeResultText(r)))
                  .catch(() => setProbeMsg('⚠ 연결 테스트를 실행하지 못했습니다 — 그래도 등록할 수 있습니다.'))
                  .finally(() => setProbing(false))
              }}
            >
              {probing ? '연결 테스트 중…' : '연결 테스트'}
            </button>
            <p className="meta">
              연결 테스트는 짧은 실제 모델 호출을 1회 실행합니다(구독/쿼터/요금 사용 가능).
            </p>
            {probeMsg && <p role="status">{probeMsg}</p>}
```

컴포넌트 함수 밖(파일 하단 또는 상단 헬퍼 영역)에 상태→문구 매핑 추가:

```tsx
function probeResultText(r: ProbeResult): string {
  switch (r.status) {
    case 'ok':
      return '✓ 방금 연결 테스트 성공 — 이 결과는 저장되지 않습니다.'
    case 'auth':
      return `⚠ ${r.hint ?? '인증 문제일 수 있습니다.'} — 그래도 등록할 수 있습니다.`
    case 'timeout':
      return '⏱ 시간 초과 — 그래도 등록할 수 있습니다.'
    default:
      return `⚠ 연결 테스트 실패 — 그래도 등록할 수 있습니다.${r.detail ? ` (${r.detail})` : ''}`
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS(기존 + 신규).

- [ ] **Step 5: 게이트 + 커밋**

Run: `npm run typecheck && npm run lint && npm run format:check`

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(#150): AddAiWizard '연결 테스트' 버튼 — transient probe 결과

비용 고지·비저장·실패 비차단. ok/auth/timeout/error 문구 분리.

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ATAm6fQgqgDtAPT4skrsaj"
```

---

## Task 5: 전체 게이트 + 자가 적대 리뷰 + PR

- [ ] **Step 1: 전체 품질 게이트 4종**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run test`
Expected: 4종 모두 green. (실패 시 해당 Task 로 복귀.)

- [ ] **Step 2: 자가 적대 리뷰**

`fleet-pr-review` 스킬(또는 다차원 적대 리뷰)로 변경분 점검 — 중점: never-throws 누락·detail 민감정보 잔존·IPC parity·비차단/비저장 회귀·스코프 규율(YAGNI). 발견 사항 반영 후 게이트 재실행.

- [ ] **Step 3: PR 생성**

```bash
git push
gh pr create --title "feat(#150): CLI 세션 '연결 테스트' probe" \
  --body "<요약 · Closes #150 · Part of #145 · 🤖 Generated with [Claude Code](https://claude.com/claude-code)>"
```

- [ ] **Step 4: 봇 리뷰 대기·반영** — Codex + CodeRabbit 자동 리뷰 대기, 인라인 스레드 resolve(fix 푸시마다 재리뷰 → 매 푸시 후 unresolved 재확인). 사용자 확인 후 squash 머지.

---

## Self-Review (계획 vs 스펙)

- **§2 범위(picker-only·transient·비차단)** → Task 4 ✅ · 비목표(authStatus·재테스트·출력파싱)는 어느 Task 도 구현 안 함 ✅.
- **§4.1 probeCliAuth(분류표·buildHeadlessArgs·stdin·timeout·detail sanitize·never-throws)** → Task 1 ✅.
- **§4.2 ProbeResult shared** → Task 1 Step 1 ✅.
- **§4.3 engine.probeCli(unknown→error)** → Task 2 ✅.
- **§4.4 IPC parity 3곳** → Task 3 ✅.
- **§4.5 AddAiWizard 버튼·문구·비용고지** → Task 4 ✅ (스펙 §4.5 파일 참조 SessionsPanel→AddAiWizard 정정 반영).
- **§8 테스트 매트릭스**(ok/auth/error/timeout/ENOBUFS·argv·promptVia:'arg'·headless fallback·never-throws·detail sanitize·engine unknown-id·렌더러 비차단/비저장) → Task 1·2·4 ✅.
- **Placeholder 스캔**: 모든 코드 step 에 실제 코드 포함 · 유일 "기존 헬퍼 복사" 지시(engine.test/AddAiWizard.test mock 패턴)는 해당 파일의 기존 테스트를 권위로 명시 ✅.
- **타입 일관성**: `ProbeResult`/`ProbeStatus`·`probeCliAuth`·`probeCli`·`PROBE_PROMPT`/`PROBE_TIMEOUT_MS` 전 Task 동일 표기 ✅.

# CLI resolved-path 표시 (PATH shadowing 탐지) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** picker 구독 단계에서 각 CLI의 실제 실행될 절대경로를 표시하고, 상대-PATH로 해석되는 shadow 위험을 경고한다(#145 항목5).

**Architecture:** main(`detect.ts`)에서 실행기 cross-spawn과 동일한 `which@2` resolver로 명령 경로를 해석(`resolveCommandPath`), `path.isAbsolute`로 상대-PATH 위험을 판정해 `CliDetectionResult`에 optional 2필드(`resolvedPath`/`pathShadowRisk`)로 실어 기존 `detectClis` IPC로 renderer에 전달. renderer는 boolean/문자열만 받아 표시(클릭/실행 없음).

**Tech Stack:** TypeScript · Electron(main/renderer) · `which@2`(cross-spawn 의존 계열) · vitest · @testing-library/react.

## Global Constraints

- 근거 스펙: `docs/superpowers/specs/2026-06-28-cli-resolved-path-design.md` (Codex 체크포인트 승인).
- 신규 IPC 채널 **0** — 기존 `fleet:cli:detect`(`detectClis`) 결과 확장만.
- 보안 판정(`path.isAbsolute`)은 **main에서만**, renderer는 boolean만 수신.
- `which` 실패(null/throw)가 **`--version` 감지를 깨지 않는다**(resolved-path는 부가 정보).
- 경로는 **표시 전용**: 클릭/실행/열기 버튼 없음, `dangerouslySetInnerHTML` 미사용, telemetry/log/LLM 미전송.
- 경고 **비차단** — 등록 버튼 계속 활성.
- PR 본문 = **`Part of #145`** (`Closes` 금지 — 5항목 묶음).
- 커밋 트레일러: `Part of #145` + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01FfH6dSMD7Ckv3wyosRfsCG`.

---

## File Structure

- `package.json` / `package-lock.json` — `which` deps 승격 + `@types/which` devDeps.
- `src/shared/types.ts` — `CliDetectionResult`에 `resolvedPath?`/`pathShadowRisk?` 추가.
- `src/main/core/cli/detect.ts` — `PathResolver` 타입·`defaultResolver`·`resolveCommandPath` 헬퍼·`detectCli`/`detectAll`에 resolver DI.
- `src/main/core/cli/detect.test.ts` — `resolveCommandPath`/`detectCli` 경로 병합 테스트.
- `src/renderer/components/AddAiWizard.tsx` — 설치 CLI 카드에 경로 표시·risk alert·보조문구.
- `src/renderer/components/AddAiWizard.test.tsx` — UI 표시/경고/미해석 테스트.

---

### Task 1: 의존성 승격 + 타입 필드

**Files:**
- Modify: `package.json` (dependencies/devDependencies), `package-lock.json` (자동)
- Modify: `src/shared/types.ts:120-130` (`CliDetectionResult`)

**Interfaces:**
- Produces: `CliDetectionResult.resolvedPath?: string`, `CliDetectionResult.pathShadowRisk?: boolean`; 런타임에서 `import which from 'which'` 가능.

- [ ] **Step 1: which/@types/which 설치**

Run:
```bash
npm install which@^2.0.2 && npm install -D @types/which@^2.0.2
```
Expected: `package.json` deps에 `"which": "^2.0.2"`, devDeps에 `"@types/which": "^2.0.2"` 추가, `package-lock.json` 갱신, 에러 없음.

- [ ] **Step 2: CliDetectionResult에 필드 추가**

`src/shared/types.ts`의 `CliDetectionResult` 인터페이스 끝(`error?: string` 다음)에 추가:
```ts
  /** which 해석된 실제 실행 경로(절대경로). 미설치/미해석 시 undefined. 표시 전용. */
  resolvedPath?: string
  /** resolvedPath 가 비절대(상대/CWD PATH 엔트리)로 해석된 경우 true — 상대 PATH shadow 위험(main 에서 path.isAbsolute 판정). */
  pathShadowRisk?: boolean
```

- [ ] **Step 3: 타입체크**

Run: `npm run typecheck`
Expected: PASS (필드 추가는 optional이라 기존 소비자 영향 없음).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/shared/types.ts
git commit -F - <<'EOF'
feat(#145): resolvedPath/pathShadowRisk 필드 + which 의존 승격

CliDetectionResult 에 optional 경로 2필드 추가(하위호환). 실행기 cross-spawn
이 쓰는 which@2 계열을 직접 의존으로 명시(@types/which devDep).

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FfH6dSMD7Ckv3wyosRfsCG
EOF
```

---

### Task 2: resolveCommandPath 헬퍼 (TDD)

**Files:**
- Modify: `src/main/core/cli/detect.ts` (import + 헬퍼 추가, `parseVersion` 근처)
- Test: `src/main/core/cli/detect.test.ts`

**Interfaces:**
- Produces: `export type PathResolver = (command: string) => Promise<string | null>`; `export const defaultResolver: PathResolver`; `export async function resolveCommandPath(command: string, resolver?: PathResolver): Promise<{ resolvedPath?: string; pathShadowRisk?: boolean }>`.

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/cli/detect.test.ts` import에 `resolveCommandPath`, `type PathResolver` 추가하고 다음 describe 추가(플랫폼 안정 fixture: `/usr/local/bin/...`=양 OS 절대, `./...`=양 OS 상대):
```ts
describe('resolveCommandPath', () => {
  it('절대경로 → resolvedPath 설정, pathShadowRisk 없음', async () => {
    const r = await resolveCommandPath('claude', async () => '/usr/local/bin/claude')
    expect(r).toEqual({ resolvedPath: '/usr/local/bin/claude' })
  })
  it('상대경로 → pathShadowRisk true', async () => {
    const r = await resolveCommandPath('claude', async () => './claude')
    expect(r).toEqual({ resolvedPath: './claude', pathShadowRisk: true })
  })
  it('null(미해석) → 빈 객체', async () => {
    const r = await resolveCommandPath('claude', async () => null)
    expect(r).toEqual({})
  })
  it('resolver 예외 → 삼킴(빈 객체)', async () => {
    const r = await resolveCommandPath('claude', async () => {
      throw new Error('boom')
    })
    expect(r).toEqual({})
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/cli/detect.test.ts -t resolveCommandPath`
Expected: FAIL ("resolveCommandPath is not a function" / import 에러).

- [ ] **Step 3: 최소 구현**

`src/main/core/cli/detect.ts` 상단 import에 추가:
```ts
import path from 'node:path'
import which from 'which'
```
`parseVersion` 함수 바로 위(또는 아래)에 추가:
```ts
export type PathResolver = (command: string) => Promise<string | null>

/** 기본 경로 해석기: cross-spawn 이 쓰는 which@2 재사용 — 표시 경로 = 실제 실행 경로. */
export const defaultResolver: PathResolver = (command) => which(command, { nothrow: true })

/**
 * 명령이 PATH 에서 해석되는 실제 경로와 상대-PATH shadow 위험을 판정한다.
 * - not-found(null) 또는 해석 예외 → 빈 객체(탐지 본 기능을 깨지 않는다).
 * - 비절대(상대/CWD PATH 엔트리)로 해석되면 pathShadowRisk: true.
 */
export async function resolveCommandPath(
  command: string,
  resolver: PathResolver = defaultResolver,
): Promise<{ resolvedPath?: string; pathShadowRisk?: boolean }> {
  try {
    const p = await resolver(command)
    if (!p) return {}
    return path.isAbsolute(p) ? { resolvedPath: p } : { resolvedPath: p, pathShadowRisk: true }
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/cli/detect.test.ts -t resolveCommandPath`
Expected: PASS (4건).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/cli/detect.ts src/main/core/cli/detect.test.ts
git commit -F - <<'EOF'
feat(#145): resolveCommandPath — which 경로 해석 + 상대-PATH 위험 판정

방어적(null/throw 삼킴)·path.isAbsolute 로 비절대 PATH 엔트리만 위험 플래그.

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FfH6dSMD7Ckv3wyosRfsCG
EOF
```

---

### Task 3: detectCli 통합 (TDD)

**Files:**
- Modify: `src/main/core/cli/detect.ts` (`detectCli`/`detectAll`)
- Test: `src/main/core/cli/detect.test.ts`

**Interfaces:**
- Consumes: `resolveCommandPath`, `PathResolver` (Task 2).
- Produces: `detectCli(adapter, runner?, timeoutMs?, resolver?)`, `detectAll(adapters, runner?, timeoutMs?, resolver?)` — 결과에 `resolvedPath`/`pathShadowRisk` 병합.

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/cli/detect.test.ts`의 `describe('detectCli', ...)` 안에 추가:
```ts
  it('resolvedPath 병합(절대경로 → 위험 없음)', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3', stderr: '' })
    const r = await detectCli(claude, runner, 5000, async () => '/usr/local/bin/claude')
    expect(r.installed).toBe(true)
    expect(r.resolvedPath).toBe('/usr/local/bin/claude')
    expect(r.pathShadowRisk).toBeUndefined()
  })
  it('상대경로 해석 → pathShadowRisk true', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3', stderr: '' })
    const r = await detectCli(claude, runner, 5000, async () => './claude')
    expect(r.pathShadowRisk).toBe(true)
  })
  it('resolver 예외가 --version 감지를 깨지 않음', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3', stderr: '' })
    const r = await detectCli(claude, runner, 5000, async () => {
      throw new Error('boom')
    })
    expect(r.installed).toBe(true)
    expect(r.version).toBe('1.2.3')
    expect(r.resolvedPath).toBeUndefined()
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/cli/detect.test.ts -t "resolvedPath 병합"`
Expected: FAIL (detectCli가 resolver 인자 미사용 → resolvedPath undefined).

- [ ] **Step 3: detectCli/detectAll 수정**

`src/main/core/cli/detect.ts`의 `detectCli`를 교체:
```ts
export async function detectCli(
  adapter: CliAdapter,
  runner: CommandRunner = defaultRunner,
  timeoutMs = 5000,
  resolver: PathResolver = defaultResolver,
): Promise<CliDetectionResult> {
  const base = {
    id: adapter.id,
    displayName: adapter.displayName,
    command: adapter.command,
    kind: 'cli' as const,
  }
  const [res, pathInfo] = await Promise.all([
    runner(adapter.command, adapter.versionArgs, { timeoutMs }),
    resolveCommandPath(adapter.command, resolver),
  ])

  if (res.spawnError) {
    return { ...base, installed: false, error: res.spawnError, ...pathInfo }
  }
  const raw = (res.stdout || res.stderr).trim()
  if (res.code === 0) {
    return { ...base, installed: true, version: parseVersion(raw), raw, ...pathInfo }
  }
  return { ...base, installed: false, raw, error: `exit ${res.code}`, ...pathInfo }
}
```
그리고 `detectAll`에 resolver 파라미터 추가·전달:
```ts
export async function detectAll(
  adapters: readonly CliAdapter[],
  runner: CommandRunner = defaultRunner,
  timeoutMs = 5000,
  resolver: PathResolver = defaultResolver,
): Promise<CliDetectionResult[]> {
  return Promise.all(adapters.map((a) => detectCli(a, runner, timeoutMs, resolver)))
}
```

- [ ] **Step 4: 통과 확인 (전체 detect 스위트)**

Run: `npx vitest run src/main/core/cli/detect.test.ts`
Expected: PASS (기존 + 신규 전부).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/cli/detect.ts src/main/core/cli/detect.test.ts
git commit -F - <<'EOF'
feat(#145): detectCli 가 resolvedPath/pathShadowRisk 병합 (resolver DI·동시실행)

버전 spawn 과 which 해석을 Promise.all 동시 실행(추가 지연 0). resolver
DI 로 테스트 주입(runner DI 동형). resolver 실패는 탐지 비파괴.

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FfH6dSMD7Ckv3wyosRfsCG
EOF
```

---

### Task 4: AddAiWizard UI 표시 (TDD)

**Files:**
- Modify: `src/renderer/components/AddAiWizard.tsx:179`(cli 객체화) 및 설치 branch(`src/renderer/components/AddAiWizard.tsx:228` 직후)
- Test: `src/renderer/components/AddAiWizard.test.tsx`

**Interfaces:**
- Consumes: `CliDetectionResult.resolvedPath`/`pathShadowRisk` (Task 1).

- [ ] **Step 1: 실패 테스트 작성**

`src/renderer/components/AddAiWizard.test.tsx`의 `describe('AddAiWizard', ...)` 안에 추가:
```ts
  it('구독: 설치된 CLI 의 실행 경로 + 보조문구 표시, 위험 없으면 alert 없음', async () => {
    mockFleet({
      detectClis: vi.fn().mockResolvedValue([
        { id: 'claude', displayName: 'Claude Code', command: 'claude', kind: 'cli', installed: true, version: '1.0.0', resolvedPath: '/usr/local/bin/claude' },
      ]),
    })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    await act(async () => {})
    expect(screen.getByText('/usr/local/bin/claude')).toBeTruthy()
    expect(screen.getByText(/공식 CLI 설치 경로인지 확인/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('구독: pathShadowRisk → 상대 PATH 경고 alert', async () => {
    mockFleet({
      detectClis: vi.fn().mockResolvedValue([
        { id: 'claude', displayName: 'Claude Code', command: 'claude', kind: 'cli', installed: true, version: '1.0.0', resolvedPath: './claude', pathShadowRisk: true },
      ]),
    })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    await act(async () => {})
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText(/상대 PATH/)).toBeTruthy()
  })
  it('구독: 설치됐으나 경로 미해석 → "확인할 수 없음"', async () => {
    mockFleet({
      detectClis: vi.fn().mockResolvedValue([
        { id: 'claude', displayName: 'Claude Code', command: 'claude', kind: 'cli', installed: true, version: '1.0.0' },
      ]),
    })
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    fireEvent.click(screen.getByRole('button', { name: /구독/ }))
    await act(async () => {})
    expect(screen.getByText(/확인할 수 없음/)).toBeTruthy()
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx -t "실행 경로"`
Expected: FAIL (경로 텍스트 미렌더).

- [ ] **Step 3: UI 구현**

`src/renderer/components/AddAiWizard.tsx`의 line 179
```ts
    const installed = !!clis.find((c) => c.id === adapterId)?.installed
```
를 교체:
```ts
    const cli = clis.find((c) => c.id === adapterId)
    const installed = !!cli?.installed
```
그리고 설치 branch(`) : (` 다음 `<div>`) 바로 안쪽 맨 위에 삽입:
```tsx
            <p>
              실행 경로: <code>{cli?.resolvedPath ?? '확인할 수 없음'}</code>
            </p>
            {cli?.pathShadowRisk && (
              <p role="alert">
                ⚠ 상대 PATH 항목에서 해석되었습니다. 현재 작업 디렉터리에 따라 다른 실행 파일이
                선택될 수 있습니다.
              </p>
            )}
            <p>의도한 공식 CLI 설치 경로인지 확인하세요.</p>
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS (기존 + 신규 3건).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -F - <<'EOF'
feat(#145): picker 설치 CLI 실행 경로 표시 + 상대-PATH 경고 (표시전용)

설치 카드에 resolvedPath 표시(없으면 "확인할 수 없음")·pathShadowRisk 시
role=alert 경고·항상 "공식 설치 경로 확인" 보조문구. 클릭/실행 없음·비차단.

Part of #145

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FfH6dSMD7Ckv3wyosRfsCG
EOF
```

---

### Task 5: 품질게이트 + 적대리뷰 + PR

**Files:** 없음(검증·푸시·PR)

- [ ] **Step 1: 품질게이트 4종**

Run: `npm run lint && npm run typecheck && npm run test && npm run build`
Expected: 전부 PASS. 실패 시 해당 Task로 돌아가 수정.

- [ ] **Step 2: 적대 자가 리뷰 (4렌즈)**

`fleet-pr-review` 스킬 또는 워크플로로 변경 diff를 4렌즈(보안·정확성·정직성·회귀)로 find→verify. 확정 findings만 반영, 기각은 근거 기록.
점검 포인트: (a) `which` 예외/타임아웃이 정말 탐지를 안 깨는가, (b) 절대/상대 fixture가 양 OS에서 안정인가, (c) 경로가 로그/LLM로 새지 않는가, (d) `installed:false`에 resolvedPath 병합이 UI에 노출 안 되는가, (e) pathShadowRisk false-negative(절대경로 shadow) 보조문구로 고지됐는가.

- [ ] **Step 3: 푸시 + PR 생성**

```bash
git push -u origin feat/145-cli-resolved-path
gh pr create --title "feat(#145): CLI resolved-path 표시 (PATH shadowing 탐지)" --body-file <(cat <<'EOF'
## 요약
picker 구독 단계에서 설치된 CLI 의 실제 실행 경로(`which@2` 해석 = cross-spawn 실행기와 동일)를 표시하고, 상대-PATH 로 해석되는 shadow 위험을 경고. 표시 전용·신규 IPC 0·비차단.

## 정직한 범위 (Codex 보강)
- 절대경로 디렉터리에 심긴 shadow 는 자동 판정하지 않음 → 보조문구로 육안 검증 유도.
- which 실패(null/throw)는 탐지 본 기능을 깨지 않음.

## 검증
- 품질게이트 4종(lint/typecheck/test/build) green.
- 설계 체크포인트 Codex 독립 리뷰 「승인」 5보강 반영([#145 issuecomment-4825835589](https://github.com/pdw96/fleet/issues/145#issuecomment-4825835589)).
- 스펙: `docs/superpowers/specs/2026-06-28-cli-resolved-path-design.md`.

Part of #145

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

- [ ] **Step 4: 봇 리뷰 대기·반영**

Codex/CodeRabbit 자동리뷰 대기 → findings 검증·반영(push마다 재리뷰·unresolved 스레드 재확인) → 스레드 resolve. 사용자 확인 후 squash 머지.

---

## Self-Review

**Spec coverage:**
- §4 데이터 모델 → Task 1. §5 main 해석 → Task 2·3. §6 IPC(채널0) → Task 3(기존 결과 확장). §7 UI 3단 문구 → Task 4. §8 에러/엣지 → Task 2·3 테스트. §9 테스트 → Task 2·3·4. §10 보안 불변식 → Global Constraints + Task 5 적대리뷰 점검. §11 의존성 → Task 1. ✅ 갭 없음.

**Placeholder scan:** TBD/TODO 없음. 모든 코드 스텝에 완전한 코드 포함. ✅

**Type consistency:** `PathResolver`·`resolveCommandPath`·`defaultResolver` 시그니처가 Task 2 정의 ↔ Task 3 사용 일치. `resolvedPath`/`pathShadowRisk` 필드명이 Task 1(타입)↔3(병합)↔4(UI)↔테스트 전부 일치. `cli`/`installed` 변수 변경이 line 179 단일 지점. ✅

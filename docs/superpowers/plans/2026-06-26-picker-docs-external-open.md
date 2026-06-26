# picker 문서 링크 클릭형 외부열기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** picker 구독 단계의 `docsUrl`을 가드된 main IPC 채널로 OS 브라우저에서 열 수 있게 한다(현재 copy-only).

**Architecture:** renderer는 `adapterId`만 IPC로 전달 → main이 정적 `CLI_AUTH_INSTALL_META[adapterId].docsUrl` 도출 → `Object.hasOwn` + `isAllowedDocsUrl`(https·userinfo금지·port금지·exact hostname allowlist) 이중 검증 → `shell.openExternal`. window-guards(renderer 네비 전면차단)는 불변 — 이건 main→OS 핸드오프라는 별도 경로.

**Tech Stack:** Electron(main `shell`), TypeScript, vitest, React(renderer).

## Global Constraints

- 신규 런타임(prod) 의존성 **0** (Electron 내장 `shell`만).
- `src/main/core/*` 에 `electron` import 금지 → 검증/열기 헬퍼는 `src/main/` 직속(`window-guards.ts` 동급).
- 외부열기 유일 경로 = `openCliDocs(adapterId)` IPC. renderer에 `<a href>`/`window.open`/`location.href`/`target=_blank` 추가 금지.
- `loginCommand`/`installHint`는 copy-only 유지(외부열기 대상 아님).
- IPC 채널은 **리터럴 문자열**로만 쓴다(ipc-parity.test 전제). 채널명 = `fleet:external:openDocs`.
- 실패 에러는 path-free·raw URL 미노출.
- 커밋 트레일러: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01ATAm6fQgqgDtAPT4skrsaj`.

---

### Task 1: 검증 함수 `isAllowedDocsUrl` (순수 — 보안 핵심)

**Files:**
- Create: `src/main/external-links.ts`
- Test: `src/main/external-links.test.ts`

**Interfaces:**
- Produces: `export function isAllowedDocsUrl(raw: string): boolean`

- [ ] **Step 1: 실패 테스트 작성** (`src/main/external-links.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { isAllowedDocsUrl } from './external-links'
import { CLI_AUTH_INSTALL_META, DOCS_HOST_ALLOWLIST } from '../shared/cliAuthInstallMeta'

describe('isAllowedDocsUrl — 적대 가드', () => {
  it('allowlist host의 https URL을 허용', () => {
    for (const host of DOCS_HOST_ALLOWLIST) {
      expect(isAllowedDocsUrl(`https://${host}/path`)).toBe(true)
    }
  })
  it('각 adapter의 실제 docsUrl을 허용 (meta↔가드 동기화 회귀)', () => {
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      expect(isAllowedDocsUrl(CLI_AUTH_INSTALL_META[id].docsUrl)).toBe(true)
    }
  })
  it('https 외 스킴 거부', () => {
    expect(isAllowedDocsUrl('http://docs.anthropic.com')).toBe(false)
    expect(isAllowedDocsUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedDocsUrl('javascript:alert(1)')).toBe(false)
  })
  it('비-allowlist host 거부', () => {
    expect(isAllowedDocsUrl('https://evil.com')).toBe(false)
  })
  it('서브도메인 트릭 거부', () => {
    expect(isAllowedDocsUrl('https://docs.anthropic.com.evil.com/x')).toBe(false)
  })
  it('userinfo 트릭 거부 (hostname은 evil)', () => {
    expect(isAllowedDocsUrl('https://docs.anthropic.com@evil.com')).toBe(false)
  })
  it('allowlisted host + userinfo 거부 (심층방어)', () => {
    expect(isAllowedDocsUrl('https://user:pass@docs.anthropic.com')).toBe(false)
  })
  it('비정상 포트 거부', () => {
    expect(isAllowedDocsUrl('https://docs.anthropic.com:8443')).toBe(false)
  })
  it('non-allowlist punycode 거부', () => {
    expect(isAllowedDocsUrl('https://xn--80ak6aa92e.com')).toBe(false)
  })
  it('대문자 host 허용 (hostname lowercase 정규화)', () => {
    expect(isAllowedDocsUrl('https://DOCS.ANTHROPIC.COM/x')).toBe(true)
  })
  it('파싱 불가 입력 거부', () => {
    expect(isAllowedDocsUrl('not a url')).toBe(false)
    expect(isAllowedDocsUrl('')).toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/external-links.test.ts`. Expected: FAIL ("isAllowedDocsUrl is not a function" / 모듈 없음).

- [ ] **Step 3: 최소 구현** (`src/main/external-links.ts`)

```ts
// picker 문서 링크 외부열기 가드. renderer 네비가 아니라 main→OS 브라우저 핸드오프 경로.
// 보증: 핸드오프하는 최초 URL이 컴파일타임 정적 allowlist docs URL임만 보증한다.
// browser-side redirect(핸드오프 이후)는 Fleet 앱 네비가 아니라 보증 범위 밖이다.
import { DOCS_HOST_ALLOWLIST } from '../shared/cliAuthInstallMeta'

/** https + userinfo 금지 + port 금지 + exact hostname allowlist. 사용자/원격/AI 입력 비주입(정적 docsUrl 전용). */
export function isAllowedDocsUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    DOCS_HOST_ALLOWLIST.includes(parsed.hostname)
  )
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/external-links.test.ts`. Expected: PASS (11 케이스).

- [ ] **Step 5: 커밋**

```bash
git add src/main/external-links.ts src/main/external-links.test.ts
git commit -m "feat(#145): isAllowedDocsUrl 외부링크 가드 (https·userinfo/port 금지·exact host allowlist)"
```

---

### Task 2: `openVerifiedCliDocs` (adapterId 가드 + DI shell 위임)

**Files:**
- Modify: `src/main/external-links.ts`
- Test: `src/main/external-links.test.ts`

**Interfaces:**
- Consumes: `isAllowedDocsUrl` (Task 1), `CLI_AUTH_INSTALL_META` (shared), `CliAdapterId` (Task 3에서 타입 확정 — 이 task는 `'claude'|'codex'|'gemini'` 리터럴 유니온으로 우선 작성하고 Task 3에서 교체)
- Produces: `export async function openVerifiedCliDocs(adapterId: string, deps: { openExternal: (url: string) => Promise<void> }): Promise<void>`

- [ ] **Step 1: 실패 테스트 추가** (`external-links.test.ts`에 describe 추가)

```ts
import { openVerifiedCliDocs } from './external-links'

describe('openVerifiedCliDocs — adapter 가드 + 위임', () => {
  function fakeShell() {
    const calls: string[] = []
    return { calls, openExternal: async (u: string) => void calls.push(u) }
  }
  it('유효 adapter → 도출한 docsUrl로 openExternal 호출', async () => {
    const shell = fakeShell()
    await openVerifiedCliDocs('claude', shell)
    expect(shell.calls).toEqual([CLI_AUTH_INSTALL_META.claude.docsUrl])
  })
  it('스푸핑 adapterId → 호출 없이 reject', async () => {
    const shell = fakeShell()
    await expect(openVerifiedCliDocs('__proto__', shell)).rejects.toThrow()
    await expect(openVerifiedCliDocs('evil', shell)).rejects.toThrow()
    expect(shell.calls).toEqual([])
  })
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/main/external-links.test.ts`. Expected: FAIL ("openVerifiedCliDocs is not a function").

- [ ] **Step 3: 구현 추가** (`external-links.ts`)

```ts
import { CLI_AUTH_INSTALL_META } from '../shared/cliAuthInstallMeta'

export async function openVerifiedCliDocs(
  adapterId: string,
  deps: { openExternal: (url: string) => Promise<void> },
): Promise<void> {
  // Object.hasOwn — 프로토타입 체인 스푸핑('__proto__'·'toString') 차단.
  if (!Object.hasOwn(CLI_AUTH_INSTALL_META, adapterId)) {
    throw new Error('unknown adapter')
  }
  const url = CLI_AUTH_INSTALL_META[adapterId as keyof typeof CLI_AUTH_INSTALL_META].docsUrl
  if (!isAllowedDocsUrl(url)) {
    // 정적 맵이라 정상 경로는 항상 통과 — 도달 시 맵 오염 → path-free로 거부.
    throw new Error('docs url failed allowlist')
  }
  await deps.openExternal(url)
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/main/external-links.test.ts`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/external-links.ts src/main/external-links.test.ts
git commit -m "feat(#145): openVerifiedCliDocs — adapterId Object.hasOwn 가드 + shell DI"
```

---

### Task 3: shared 타입 `CliAdapterId` 단일출처 + `FleetBridge.openCliDocs`

**Files:**
- Modify: `src/shared/cliAuthInstallMeta.ts` (Record 키를 명명 타입으로)
- Modify: `src/shared/types.ts` (`FleetBridge.openCliDocs` 추가)
- Modify: `src/main/external-links.ts` (`adapterId: string` → `CliAdapterId`)

**Interfaces:**
- Produces: `export type CliAdapterId = 'claude' | 'codex' | 'gemini'` (in `cliAuthInstallMeta.ts`); `FleetBridge.openCliDocs(adapterId: CliAdapterId): Promise<void>`

- [ ] **Step 1: `CliAdapterId` 타입 정의 + Record 키 적용** (`src/shared/cliAuthInstallMeta.ts`)

```ts
export type CliAdapterId = 'claude' | 'codex' | 'gemini'
// 기존: Record<'claude' | 'codex' | 'gemini', CliAuthInstallMeta>
export const CLI_AUTH_INSTALL_META: Record<CliAdapterId, CliAuthInstallMeta> = { /* 불변 */ }
```

- [ ] **Step 2: `FleetBridge`에 메서드 추가** (`src/shared/types.ts`, CLI 섹션 — `listModels` 아래). `import type { CliAdapterId } from './cliAuthInstallMeta'` 추가.

```ts
  /** picker 문서 링크 외부열기 — adapterId만 전달, main이 정적 docsUrl 도출·검증 후 shell.openExternal */
  openCliDocs(adapterId: CliAdapterId): Promise<void>
```

- [ ] **Step 3: 헬퍼 시그니처 타입화** (`src/main/external-links.ts`) — `openVerifiedCliDocs(adapterId: CliAdapterId, ...)`로 교체, `import type { CliAdapterId } from '../shared/cliAuthInstallMeta'`.

- [ ] **Step 4: 타입체크** — Run: `npm run typecheck` (또는 `npx tsc --noEmit`). Expected: PASS. 기존 `external-links.test.ts`도 통과 유지: `npx vitest run src/main/external-links.test.ts`.

- [ ] **Step 5: 커밋**

```bash
git add src/shared/cliAuthInstallMeta.ts src/shared/types.ts src/main/external-links.ts
git commit -m "feat(#145): CliAdapterId 단일출처 타입 + FleetBridge.openCliDocs 계약"
```

---

### Task 4: IPC 배선 (main 핸들러 + preload)

**Files:**
- Modify: `src/main/index.ts` (`shell` import + `ipcMain.handle`)
- Modify: `src/preload/index.ts` (`openCliDocs` 노출)

**Interfaces:**
- Consumes: `openVerifiedCliDocs` (Task 2/3), channel `'fleet:external:openDocs'`

- [ ] **Step 1: preload 노출** (`src/preload/index.ts`, CLI 섹션 `listModels` 아래)

```ts
  openCliDocs: (adapterId) => ipcRenderer.invoke('fleet:external:openDocs', adapterId),
```

- [ ] **Step 2: main 핸들러** (`src/main/index.ts`) — line 2 import에 `shell` 추가: `import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'`. `import { openVerifiedCliDocs } from './external-links'` 추가. `registerIpc` 내 CLI 핸들러 근처:

```ts
  ipcMain.handle('fleet:external:openDocs', (_e, adapterId: CliAdapterId) =>
    openVerifiedCliDocs(adapterId, { openExternal: (url) => shell.openExternal(url) }),
  )
```
`import type { CliAdapterId } from '../shared/cliAuthInstallMeta'` 추가.

- [ ] **Step 3: parity 통과 확인** — Run: `npx vitest run src/main/ipc-parity.test.ts`. Expected: PASS (`fleet:external:openDocs`가 invoke·handle 양쪽에 등장).

- [ ] **Step 4: 전체 타입체크** — Run: `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "feat(#145): fleet:external:openDocs IPC 배선 (main shell.openExternal + preload)"
```

---

### Task 5: UI "문서 열기" 버튼 (renderer)

**Files:**
- Modify: `src/renderer/components/AddAiWizard.tsx` (구독 단계, L161-165 docsUrl 블록)
- Test: `src/renderer/components/AddAiWizard.test.tsx` (기존 있으면 추가, 없으면 생성)

**Interfaces:**
- Consumes: `window.fleet.openCliDocs(adapterId)`

- [ ] **Step 1: 실패 테스트** — 기존 wizard 테스트 패턴 확인 후, 구독 단계에서 "문서 열기" 버튼 클릭이 `window.fleet.openCliDocs(adapterId)`를 호출하는지. (기존 테스트 파일/모킹 패턴을 따른다. `window.fleet`는 테스트 setup의 mock.) 예시:

```tsx
it('구독 단계 "문서 열기" 버튼이 openCliDocs(adapterId) 호출', async () => {
  const openCliDocs = vi.fn().mockResolvedValue(undefined)
  // window.fleet mock에 openCliDocs 주입 (기존 detectClis mock 패턴 동형)
  // ... provider=anthropic → method → subscription 진입 후
  fireEvent.click(screen.getByText('문서 열기'))
  expect(openCliDocs).toHaveBeenCalledWith('claude')
})
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`. Expected: FAIL (버튼 없음).

- [ ] **Step 3: 버튼 추가** (`AddAiWizard.tsx`, `URL 복사` 버튼 옆 ~L163)

```tsx
        <button type="button" onClick={() => void window.fleet.openCliDocs(adapterId)}>
          문서 열기
        </button>
```
URL `<code>` 표시·복사 버튼은 유지(스펙 §6a "링크 텍스트와 실제 URL 함께 표시").

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`. Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(#145): picker 구독 단계 '문서 열기' 버튼 (copy 유지)"
```

---

### Task 6: ADR 0005 (정책 결정 기록)

**Files:**
- Create: `docs/adr/0005-picker-docs-외부열기.md`

- [ ] **Step 1: ADR 작성** — `docs/adr/TEMPLATE.md` 형식 따름. 내용 = spec §8:
  - 결정: picker docs 외부열기는 renderer navigation이 아니라 main-mediated 정적 URL handoff로만 허용.
  - 대안(기각): copy-only 유지 / URL 전달형 IPC.
  - 보안 불변식: ① renderer는 URL 미전달(식별자만) ② command/install hint copy-only ③ window.open/navigation guard 불변 ④ https + userinfo금지 + port금지 + exact hostname allowlist + 정적 docsUrl.
  - 한계: 핸드오프 이후 browser-side redirect는 Fleet 보증 밖.
  - 스펙 §6a 반복 금지 — "전면차단 모델의 예외가 아니라 별도 통제 경로"라는 결정만.

- [ ] **Step 2: skills:lint 통과 확인** (ADR 시크릿/경로 스캔) — Run: 해당 lint 스크립트(`docs/adr/**` 스캔). Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add docs/adr/0005-picker-docs-외부열기.md
git commit -m "docs(#145): ADR 0005 — picker docs 외부열기 main handoff 정책"
```

---

## 최종 게이트 (전체 task 후)

- [ ] 품질 게이트 4종: `npm run lint` · `npm run typecheck` · `npm test` · `npm run build` 전부 green (AGENTS.md).
- [ ] 자체 4렌즈 적대 리뷰(`fleet-pr-review` 스킬) — 보안(우회 벡터)·정합(window-guards 불변)·테스트 충분성·YAGNI.
- [ ] PR 생성: 본문 **`Part of #145`**(항목4만 완료, 1·2·3·5 잔존 — 묶음 이슈라 `Closes` 금지). Codex/CodeRabbit 봇 리뷰 대기·반영(스레드 resolve). 머지는 사용자 확인 후 squash.

## Self-Review (작성자 체크)

- **Spec 커버리지**: §4 흐름→T4, §5 가드→T1, §6 파일→T1-5, §7 window-guards 불변→T6 ADR+제약, §8 ADR→T6, §9 테스트→T1·T2·T5. ✅ 전 섹션 매핑.
- **Placeholder**: ADR 0005 확정(NNNN 제거). T5 테스트는 기존 wizard 테스트 패턴 확인 후 확정(파일 존재 여부 구현 시 결정) — 명시됨.
- **타입 일관성**: `CliAdapterId`(T3) ← T2 우선 리터럴→T3 교체 명시. `openVerifiedCliDocs(adapterId, deps)` 시그니처 T2/T3/T4 일치. 채널 `fleet:external:openDocs` T4 양쪽 동일.

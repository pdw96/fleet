# 세션 등록 인증 picker 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SessionsPanel의 분리된 CLI/API 등록 섹션을 단일 가이드 picker(`AddAiWizard`)로 통합 — provider-first → 인증방식(구독/API키) → 분기. 구독 분기는 설치/로그인 *안내*(copy-only) + 프로바이더별 위험 배너 + presentational 미검증 배지.

**Architecture:** 대부분 기존 재사용(신규 런타임 dep 0). CLI auth/install 메타는 **`src/shared` 순수 데이터 단일 출처**(registry·wizard 가 함께 import — drift 0·신규 IPC 0). 렌더러에 위험-배너 맵 + `AddAiWizard` 컴포넌트 신설(등록 폼 상태를 SessionsPanel→위자드 이전), CLI 세션 카드에 presentational "미검증" 배지. 기존 IPC(`detectClis`·`registerCliSession`·`registerApiSession`·`listModels`)·`secretCrypto` 그대로.

**Tech Stack:** TypeScript · React 19 · Electron · vitest + @testing-library/react(jsdom docblock) · 기존 `window.fleet` preload 브리지.

## Global Constraints

- 신규 런타임(prod) 의존성 추가 **0** — node-pty·PTY 금지(스펙 D3).
- 코어(`src/main/core/**`)·`src/shared` 는 Electron 비의존 — `CliAdapter`·shared 메타는 **IPC 직렬화 가능(함수 필드 금지·데이터만)**.
- 외부 링크: **v1 copy-only** — `docsUrl`/`loginCommand`/`installHint`는 **텍스트 표시 + 복사 버튼만**. **클릭 가능한 navigation primitive 금지**(`<a href>`·`target=_blank`·`onClick` 외부열기·`shell.openExternal` 전부 금지, window-guard 의존도 금지). `docsUrl`은 정적 shared 데이터만(사용자/원격/AI 입력 비주입). (스펙 §6a · Codex 계획리뷰 P1)
- 로그인 명령은 **표시·복사 전용** — Fleet이 shell 로 실행하지 않음(터미널 자동실행 금지, 스펙 D3).
- CLI 세션은 **로그인 성공을 표현하지 않음** — `kind==='cli'` 기반 **presentational 미검증 배지**(저장 필드 아님, 스펙 §7a).
- 배너 문구는 법률 단정 금지 → 정책 리스크 안내(스펙 §5). 문구는 Task 2 모듈 값 사용.
- **품질 게이트(AGENTS 기준)** = `npm run typecheck && npm run lint && npm test && npm run build`. 최종 Task 7 에서 전부 통과.
- 테스트: 렌더러 컴포넌트 테스트는 파일 상단 `/** @vitest-environment jsdom */` + 기존 `mockFleet`/`renderSettled` 패턴(`SessionsPanel.test.tsx`).
- 커밋: 각 태스크 끝 frequent commit. 브랜치 `feat/session-auth-picker`.

---

### Task 1: CLI auth/install 메타 — `src/shared` 단일 출처

**Files:**
- Create: `src/shared/cliAuthInstallMeta.ts`
- Modify: `src/shared/types.ts` (CliAdapter 에 `auth?`/`install?` 타입)
- Modify: `src/main/core/cli/registry.ts` (shared 메타 import → 어댑터 주입)
- Test: `src/shared/cliAuthInstallMeta.test.ts` · `src/main/core/cli/registry.test.ts`

**Interfaces:**
- Produces: `CLI_AUTH_INSTALL_META: Record<'claude'|'codex'|'gemini', { loginCommand; installHint; docsUrl }>` · `DOCS_HOST_ALLOWLIST: string[]` · `CliAdapter.auth?: {loginCommand:string;docsUrl:string}` · `CliAdapter.install?: {hint:string;docsUrl:string}`. registry(Task1)와 wizard(Task5)가 **동일 shared 메타**를 소비.

- [ ] **Step 1: 실패 테스트 작성**

`src/shared/cliAuthInstallMeta.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CLI_AUTH_INSTALL_META, DOCS_HOST_ALLOWLIST } from './cliAuthInstallMeta'

describe('shared CLI auth/install metadata', () => {
  it('claude/codex/gemini 모두 loginCommand·installHint·https docsUrl', () => {
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const m = CLI_AUTH_INSTALL_META[id]
      expect(m.loginCommand).toBeTruthy()
      expect(m.installHint).toBeTruthy()
      expect(m.docsUrl.startsWith('https://')).toBe(true)
    }
  })
  it('모든 docsUrl host 가 allowlist 안에 있다 (§6a 보안 입력)', () => {
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const host = new URL(CLI_AUTH_INSTALL_META[id].docsUrl).host
      expect(DOCS_HOST_ALLOWLIST).toContain(host)
    }
  })
})
```

`src/main/core/cli/registry.test.ts` (신규):
```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLI_ADAPTERS, createCliRegistry } from './registry'
import { CLI_AUTH_INSTALL_META } from '../../../shared/cliAuthInstallMeta'

describe('CLI adapter auth/install (shared 단일 출처)', () => {
  it('registry 어댑터가 shared 메타와 일치한다 (drift 0)', () => {
    const reg = createCliRegistry()
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const a = reg.get(id)!
      const m = CLI_AUTH_INSTALL_META[id]
      expect(a.auth).toEqual({ loginCommand: m.loginCommand, docsUrl: m.docsUrl })
      expect(a.install).toEqual({ hint: m.installHint, docsUrl: m.docsUrl })
    }
  })
  it('어댑터는 IPC 직렬화 가능 — 함수 필드 없음', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_CLI_ADAPTERS))).toEqual(DEFAULT_CLI_ADAPTERS)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/shared/cliAuthInstallMeta.test.ts src/main/core/cli/registry.test.ts`
Expected: FAIL — 모듈/필드 없음.

- [ ] **Step 3: shared 메타 모듈 작성**

`src/shared/cliAuthInstallMeta.ts`:
```ts
// CLI 구독 로그인/설치 안내 정적 데이터. main(registry)·renderer(wizard) 공용 단일 출처.
// Electron·main 비의존 순수 데이터(렌더러가 main/core import 회피). docsUrl 은 §6a allowlist 호스트만.
export interface CliAuthInstallMeta {
  loginCommand: string
  installHint: string
  docsUrl: string
}

export const CLI_AUTH_INSTALL_META: Record<'claude' | 'codex' | 'gemini', CliAuthInstallMeta> = {
  claude: { loginCommand: 'claude login', installHint: 'npm i -g @anthropic-ai/claude-code', docsUrl: 'https://docs.anthropic.com/en/docs/claude-code' },
  codex: { loginCommand: 'codex login', installHint: 'npm i -g @openai/codex', docsUrl: 'https://developers.openai.com/codex/cli' },
  gemini: { loginCommand: 'gemini', installHint: 'npm i -g @google/gemini-cli', docsUrl: 'https://google-gemini.github.io/gemini-cli/' },
}

// §6a 클릭형 외부열기(가드된 후속) allowlist 의 기준 호스트. v1 copy-only 라 열지 않지만, docsUrl 검증·후속 공유.
export const DOCS_HOST_ALLOWLIST = ['docs.anthropic.com', 'developers.openai.com', 'google-gemini.github.io']
```
> ⚠️ 구현자 메모: login/install 명령·docsUrl·allowlist 호스트는 *현행 추정*. 착수 시 각 CLI 공식 문서로 명령·도메인 재확인(claude 는 `/login` 대화형 변형 가능). 값 수정 시 shared 1곳만 고치면 registry·wizard 동시 반영.

- [ ] **Step 4: 타입 추가 + registry 주입**

`src/shared/types.ts` — `CliAdapter` 인터페이스(`edit?` 근처)에 추가:
```ts
  /** 구독 로그인 안내용 정적 데이터(표시·복사 전용 — Fleet 이 실행하지 않음). shared 단일출처 주입. */
  auth?: { loginCommand: string; docsUrl: string }
  /** 미설치 시 설치 안내용 정적 데이터(표시·복사 전용). shared 단일출처 주입. */
  install?: { hint: string; docsUrl: string }
```
`src/main/core/cli/registry.ts` — 상단 import + 각 어댑터 객체에 주입:
```ts
import { CLI_AUTH_INSTALL_META as META } from '../../../shared/cliAuthInstallMeta'
// claude 어댑터 안:
    auth: { loginCommand: META.claude.loginCommand, docsUrl: META.claude.docsUrl },
    install: { hint: META.claude.installHint, docsUrl: META.claude.docsUrl },
// codex 어댑터 안: META.codex … / gemini 어댑터 안: META.gemini … 동형
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/shared/cliAuthInstallMeta.test.ts src/main/core/cli/registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: 커밋**

```bash
git add src/shared/cliAuthInstallMeta.ts src/shared/cliAuthInstallMeta.test.ts src/shared/types.ts src/main/core/cli/registry.ts src/main/core/cli/registry.test.ts
git commit -m "feat(picker): CLI auth/install 메타 shared 단일 출처 + registry 주입"
```

---

### Task 2: 위험-배너 데이터 모듈 (렌더러)

**Files:**
- Create: `src/renderer/components/authBanners.ts`
- Test: `src/renderer/components/authBanners.test.ts`

**Interfaces:**
- Produces: `type RiskLevel='clean'|'caution'|'warning'` · `interface AuthBanner{level;message;recommendApi;docsUrl?}` · `SUBSCRIPTION_BANNERS: Record<Provider, AuthBanner|null>` · `subscriptionSupported(provider):boolean`. Task 4·5 소비.

- [ ] **Step 1: 실패 테스트 작성**

`src/renderer/components/authBanners.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { SUBSCRIPTION_BANNERS, subscriptionSupported } from './authBanners'

describe('auth banners', () => {
  it('gemini=warning+API권장, codex=caution, anthropic=clean', () => {
    expect(SUBSCRIPTION_BANNERS.google?.level).toBe('warning')
    expect(SUBSCRIPTION_BANNERS.google?.recommendApi).toBe(true)
    expect(SUBSCRIPTION_BANNERS.openai?.level).toBe('caution')
    expect(SUBSCRIPTION_BANNERS.anthropic?.level).toBe('clean')
  })
  it('openai-compatible 은 구독 미지원', () => {
    expect(subscriptionSupported('openai-compatible')).toBe(false)
    expect(subscriptionSupported('anthropic')).toBe(true)
  })
  it('문구는 법률 단정어("위반"·"묵인")를 쓰지 않는다', () => {
    for (const b of Object.values(SUBSCRIPTION_BANNERS)) {
      if (!b) continue
      expect(b.message).not.toContain('위반')
      expect(b.message).not.toContain('묵인')
    }
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/authBanners.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 모듈 작성**

`src/renderer/components/authBanners.ts`:
```ts
import type { ApiProviderConfig } from '../../shared/types'

export type RiskLevel = 'clean' | 'caution' | 'warning'
export interface AuthBanner { level: RiskLevel; message: string; recommendApi: boolean; docsUrl?: string }
type Provider = ApiProviderConfig['provider']

// 스펙 §5 — 법률 단정 금지, 정책 리스크 안내. null = 구독 분기 미제공.
export const SUBSCRIPTION_BANNERS: Record<Provider, AuthBanner | null> = {
  anthropic: { level: 'clean', recommendApi: false,
    message: '공식 Claude Code CLI 인증을 그대로 사용합니다. Fleet 은 Claude 자격증명을 저장/읽지 않습니다.' },
  openai: { level: 'caution', recommendApi: false,
    message: 'Codex CLI 기존 로그인을 사용합니다. Fleet 은 자격증명을 읽지 않습니다. 조직/상업/공유 환경은 OpenAI 약관·계정 정책을 확인하세요. 정책/플랜별 허용 범위가 달라질 수 있어 API 키가 더 명시적입니다.' },
  google: { level: 'warning', recommendApi: true,
    message: 'Gemini CLI 의 Google 계정/OAuth 사용은 Google 정책·Gemini CLI 약관 적용을 받습니다. 제3자 소프트웨어의 OAuth 기반 자동화/우회 통합은 제한·탐지 대상이 될 수 있습니다. 계정 리스크를 피하려면 API 키를 권장합니다. Fleet 은 Google 자격증명을 저장/읽지 않습니다.' },
  'openai-compatible': null,
}

export function subscriptionSupported(provider: Provider): boolean {
  return SUBSCRIPTION_BANNERS[provider] !== null
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/authBanners.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/authBanners.ts src/renderer/components/authBanners.test.ts
git commit -m "feat(picker): 프로바이더별 위험-배너 데이터 모듈"
```

---

### Task 3: CLI 세션 presentational 미검증 배지 (kind 기반)

**Files:**
- Modify: `src/renderer/components/SessionsPanel.tsx` (세션 카드 렌더)
- Test: `src/renderer/components/SessionsPanel.test.tsx`

**Interfaces:**
- Consumes: `LlmDescriptor.kind`.
- Produces: `kind==='cli'` 세션 카드에 텍스트 "로그인 미검증 · 첫 메시지에서 인증 확인" 배지. **저장 필드 아님 — 순수 표시(kind 파생).**

- [ ] **Step 1: 실패 테스트 작성** (describe 안 추가)

```tsx
it('CLI 세션 카드에 presentational 미검증 배지를 표시한다 (§7a)', async () => {
  mockFleet()
  await renderSettled(<SessionsPanel sessions={[{ id: 's1', kind: 'cli' as const, displayName: 'Claude Code', ref: 'claude' }]} onRefresh={vi.fn()} />)
  expect(screen.getByText(/로그인 미검증/)).toBeTruthy()
})
it('API 세션 카드에는 미검증 배지를 표시하지 않는다', async () => {
  mockFleet()
  await renderSettled(<SessionsPanel sessions={[{ id: 's2', kind: 'api' as const, displayName: 'Claude API', ref: 'cfg1' }]} onRefresh={vi.fn()} />)
  expect(screen.queryByText(/로그인 미검증/)).toBeNull()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx -t "미검증"`
Expected: FAIL.

- [ ] **Step 3: 배지 렌더 추가**

`SessionsPanel.tsx` 세션 카드 매핑부(`sessions.map((s) => ...)`)에서:
```tsx
{s.kind === 'cli' && (
  <span className="badge badge-unverified" title="설치만 확인됨 — 로그인/권한은 첫 사용 시 검증됩니다">
    로그인 미검증 · 첫 메시지에서 인증 확인
  </span>
)}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx -t "미검증"`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/SessionsPanel.tsx src/renderer/components/SessionsPanel.test.tsx
git commit -m "feat(picker): CLI 세션 presentational 미검증 배지 (§7a)"
```

---

### Task 4: AddAiWizard — 스캐폴드 + 단계 네비게이션

**Files:**
- Create: `src/renderer/components/AddAiWizard.tsx`
- Test: `src/renderer/components/AddAiWizard.test.tsx`

**Interfaces:**
- Consumes: `subscriptionSupported`(Task 2).
- Produces: `AddAiWizard({ onRegistered }: { onRegistered: () => void })`. 상태 `step:'provider'|'method'|'subscription'|'apikey'`·`provider:Provider`.

- [ ] **Step 1: 실패 테스트 작성**

`src/renderer/components/AddAiWizard.test.tsx`:
```tsx
/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddAiWizard } from './AddAiWizard'

function mockFleet(overrides: Record<string, unknown> = {}) {
  ;(window as unknown as { fleet: unknown }).fleet = {
    detectClis: vi.fn().mockResolvedValue([
      { id: 'claude', displayName: 'Claude Code', command: 'claude', kind: 'cli', installed: true, version: '1.0.0' },
    ]),
    registerCliSession: vi.fn().mockResolvedValue(undefined),
    registerApiSession: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}
async function renderSettled(ui: Parameters<typeof render>[0]) { const r = render(ui); await act(async () => {}); return r }
afterEach(() => { delete (window as unknown as { fleet?: unknown }).fleet; vi.restoreAllMocks() })

describe('AddAiWizard', () => {
  it('provider 선택 → method 단계 전이', async () => {
    mockFleet(); await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    expect(screen.getByRole('button', { name: /구독/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /API 키/ })).toBeTruthy()
  })
  it('openai-호환 은 구독 방식 미노출', async () => {
    mockFleet(); await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /OpenAI 호환/ }))
    expect(screen.queryByRole('button', { name: /구독/ })).toBeNull()
    expect(screen.getByRole('button', { name: /API 키/ })).toBeTruthy()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: FAIL — 컴포넌트 없음.

- [ ] **Step 3: 스캐폴드 구현**

`src/renderer/components/AddAiWizard.tsx`:
```tsx
import { useState } from 'react'
import type { ApiProviderConfig } from '../../shared/types'
import { subscriptionSupported } from './authBanners'

type Provider = ApiProviderConfig['provider']
type Step = 'provider' | 'method' | 'subscription' | 'apikey'

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'Codex (OpenAI)' },
  { id: 'google', label: 'Gemini (Google)' },
  { id: 'openai-compatible', label: 'OpenAI 호환' },
]

export function AddAiWizard({ onRegistered }: { onRegistered: () => void }) {
  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<Provider>('anthropic')

  if (step === 'provider') {
    return (
      <div>
        <h3>AI 추가 — 프로바이더 선택</h3>
        {PROVIDERS.map((p) => (
          <button key={p.id} onClick={() => { setProvider(p.id); setStep('method') }}>{p.label}</button>
        ))}
      </div>
    )
  }
  if (step === 'method') {
    return (
      <div>
        <h3>인증 방식</h3>
        {subscriptionSupported(provider) && <button onClick={() => setStep('subscription')}>구독 (공식 CLI)</button>}
        <button onClick={() => setStep('apikey')}>API 키</button>
        <button onClick={() => setStep('provider')}>뒤로</button>
      </div>
    )
  }
  return <div data-provider={provider} data-step={step}>{/* Task 5·6 */}</div>
}
```
> `onRegistered` 는 Task 5·6 에서 등록 성공 시 호출(현재 미사용 — Task 5 에서 분기 채우며 사용).

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(picker): AddAiWizard 스캐폴드 — provider→method"
```

---

### Task 5: AddAiWizard — 구독 분기 (배너 · 감지 · copy-only · 등록)

**Files:**
- Modify: `src/renderer/components/AddAiWizard.tsx`
- Test: `src/renderer/components/AddAiWizard.test.tsx`

**Interfaces:**
- Consumes: `CLI_AUTH_INSTALL_META`(Task 1 shared)·`SUBSCRIPTION_BANNERS`(Task 2)·`window.fleet.detectClis`/`registerCliSession`·`CliDetectionResult`.
- Produces: 구독 단계 — 배너·미설치/설치됨 분기·**copy-only(앵커 없음)**·`installed→"검증 없이 등록"→registerCliSession(adapterId,{stateful:false})→onRegistered()`.

- [ ] **Step 1: 실패 테스트 작성** (describe 안 추가)

```tsx
it('구독: gemini 경고 배너 + API 권장', async () => {
  mockFleet({ detectClis: vi.fn().mockResolvedValue([]) })
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /Gemini/ }))
  fireEvent.click(screen.getByRole('button', { name: /구독/ }))
  expect(screen.getByText(/제한·탐지 대상/)).toBeTruthy()
})
it('구독: copy-only — 클릭 가능한 link role 이 없다 (§6a)', async () => {
  mockFleet()
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /구독/ }))
  await act(async () => {})
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByText('https://docs.anthropic.com/en/docs/claude-code')).toBeTruthy()
})
it('구독: 설치됨 → "검증 없이 등록" → registerCliSession + onRegistered', async () => {
  const reg = vi.fn().mockResolvedValue(undefined); const onRegistered = vi.fn()
  mockFleet({ registerCliSession: reg })
  await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /구독/ }))
  fireEvent.click(await screen.findByRole('button', { name: /검증 없이 등록/ }))
  await act(async () => {})
  expect(reg).toHaveBeenCalledWith('claude', { stateful: false })
  expect(onRegistered).toHaveBeenCalled()
})
it('구독: 미설치 → 설치 안내(hint) 표시, 등록 버튼 없음', async () => {
  mockFleet({ detectClis: vi.fn().mockResolvedValue([]) })
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /구독/ }))
  expect(await screen.findByText(/npm i -g @anthropic-ai\/claude-code/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /검증 없이 등록/ })).toBeNull()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx -t 구독`
Expected: FAIL.

- [ ] **Step 3: 구독 분기 구현 (shared 메타 import · 앵커 없음)**

`AddAiWizard.tsx` 상단 import + provider→adapterId 매핑:
```tsx
import type { ApiProviderConfig, CliDetectionResult } from '../../shared/types'
import { CLI_AUTH_INSTALL_META } from '../../shared/cliAuthInstallMeta'
import { SUBSCRIPTION_BANNERS, subscriptionSupported } from './authBanners'

const ADAPTER_ID: Partial<Record<Provider, 'claude' | 'codex' | 'gemini'>> = {
  anthropic: 'claude', openai: 'codex', google: 'gemini',
}
```
컴포넌트 상태/핸들러:
```tsx
  const [clis, setClis] = useState<CliDetectionResult[]>([])
  const [err, setErr] = useState<string | null>(null)
  function enterSubscription() {
    setStep('subscription'); setErr(null)
    void window.fleet.detectClis().then(setClis).catch((e) => setErr(String(e)))
  }
```
(method 단계 구독 버튼 onClick → `enterSubscription`.)
구독 단계 렌더 (**`<a>` 금지 — 텍스트 + 복사 버튼만**):
```tsx
  if (step === 'subscription') {
    const adapterId = ADAPTER_ID[provider]!
    const meta = CLI_AUTH_INSTALL_META[adapterId]
    const banner = SUBSCRIPTION_BANNERS[provider]
    const installed = !!clis.find((c) => c.id === adapterId)?.installed
    return (
      <div>
        <h3>구독 (공식 CLI 위임)</h3>
        {banner && <p role="note" data-level={banner.level}>{banner.message}{banner.recommendApi ? ' (API 키 권장)' : ''}</p>}
        <p>공식 문서 URL:</p>
        <code>{meta.docsUrl}</code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(meta.docsUrl)}>URL 복사</button>
        {!installed ? (
          <div>
            <p>CLI 미설치 — 설치 후 "재확인":</p>
            <code>{meta.installHint}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(meta.installHint)}>명령 복사</button>
            <button type="button" onClick={() => void window.fleet.detectClis().then(setClis)}>재확인 (설치 확인)</button>
          </div>
        ) : (
          <div>
            <p>로그인이 안 돼 있다면 터미널에서 실행(복사):</p>
            <code>{meta.loginCommand}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(meta.loginCommand)}>명령 복사</button>
            <button type="button" onClick={async () => {
              setErr(null)
              try { await window.fleet.registerCliSession(adapterId, { stateful: false }); onRegistered() }
              catch (e) { setErr(`등록 실패: ${String(e)}`) }
            }}>검증 없이 등록</button>
          </div>
        )}
        {err && <p role="alert">{err}</p>}
        <button onClick={() => setStep('method')}>뒤로</button>
      </div>
    )
  }
```
> §6a copy-only: `<a href>`·외부열기 없음. URL/명령은 `<code>` 텍스트 + 복사 버튼만. window-guard 의존 0.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS (구독 4 + 기존 2).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(picker): 구독 분기 — 배너·감지·copy-only(앵커 제거)·검증없이등록 (§5·§6a·§7a)"
```

---

### Task 6: AddAiWizard — API 키 분기 (기존 폼 parity 이전, 최소판 아님)

**Files:**
- Modify: `src/renderer/components/AddAiWizard.tsx`
- Test: `src/renderer/components/AddAiWizard.test.tsx`

**목표:** 기존 SessionsPanel API 폼 **기능 동등(parity)** 이전 — 축소 금지(Codex P1). `listModels` 라이브 조회(+자유입력 폴백)·anthropic `effort`·`cacheTtl`·`openai-compatible` `baseUrl` 검증·빈 키 처리.

**Interfaces:**
- Consumes: `window.fleet.registerApiSession`/`listModels`·`ApiProviderConfig`·`ReasoningEffort`·`CacheTtl`.
- Produces: apikey 단계 → `registerApiSession(config)`→onRegistered(). config 는 기존 SessionsPanel 과 동일 shape(provider·model·apiKey·baseUrl?·thinking?.effort?·cacheTtl?).

- [ ] **Step 1: 실패 테스트 작성** (parity 케이스)

```tsx
it('API: anthropic 키+모델 → registerApiSession (effort 선택 시 thinking 반영)', async () => {
  const reg = vi.fn().mockResolvedValue(undefined); const onRegistered = vi.fn()
  mockFleet({ registerApiSession: reg })
  await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
  fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-test' } })
  fireEvent.change(screen.getByLabelText(/thinking|effort/i), { target: { value: 'high' } })
  fireEvent.click(screen.getByRole('button', { name: '등록' }))
  await act(async () => {})
  const cfg = reg.mock.calls[0][0]
  expect(cfg.provider).toBe('anthropic'); expect(cfg.apiKey).toBe('sk-test')
  expect(cfg.thinking?.effort).toBe('high')
  expect(onRegistered).toHaveBeenCalled()
})
it('API: anthropic cacheTtl=1h 선택 시 config 에 반영', async () => {
  const reg = vi.fn().mockResolvedValue(undefined)
  mockFleet({ registerApiSession: reg })
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
  fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'k' } })
  fireEvent.change(screen.getByLabelText(/cache/i), { target: { value: '1h' } })
  fireEvent.click(screen.getByRole('button', { name: '등록' }))
  await act(async () => {})
  expect(reg.mock.calls[0][0].cacheTtl).toBe('1h')
})
it('API: listModels 성공 시 모델 옵션 datalist 표시', async () => {
  mockFleet({ listModels: vi.fn().mockResolvedValue([{ id: 'claude-opus-4-8', label: 'Opus' }] as ModelOption[]) })
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
  fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'k' } })
  await waitFor(() => expect(screen.getByText('claude-opus-4-8', { exact: false })).toBeTruthy())
})
it('API: openai-compatible 은 baseUrl 누락 시 등록 막고 오류 표시', async () => {
  const reg = vi.fn(); mockFleet({ registerApiSession: reg })
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /OpenAI 호환/ }))
  fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
  fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'k' } })
  fireEvent.click(screen.getByRole('button', { name: '등록' }))
  await act(async () => {})
  expect(reg).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toMatch(/base ?url/i)
})
```
(`ModelOption`·`waitFor` import 추가.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx -t API`
Expected: FAIL.

- [ ] **Step 3: API 키 분기 구현 (기존 SessionsPanel 로직 이전)**

`AddAiWizard.tsx` — 기존 `SessionsPanel.tsx` 의 provider/model/apiKey/baseUrl/effort/cacheTtl 상태 + 모델 라이브 조회(`listModels` + `modelReqSeq` 레이스 가드) + thinking 매핑을 위자드 apikey 단계로 **이전**(동일 동작 보존). 핵심 골격:
```tsx
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [effort, setEffort] = useState<'' | ReasoningEffort>('')
  const [cacheTtl, setCacheTtl] = useState<'' | '1h'>('')
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const modelReqSeq = useRef(0)
  const PROVIDER_DEFAULTS: Record<Provider, string> = {
    anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.5', google: 'gemini-3.5-flash', 'openai-compatible': '',
  }
  // 키/baseUrl 변경 시 모델 라이브 조회 (기존 SessionsPanel 레이스 가드 동형)
  // …(useEffect 로 listModels 호출·seq 가드·실패 시 modelOptions=[] 폴백)…

  if (step === 'apikey') {
    async function submit() {
      setErr(null)
      if (provider === 'openai-compatible' && !baseUrl.trim()) { setErr('openai-compatible 은 baseUrl 이 필요합니다.'); return }
      const config: ApiProviderConfig = {
        id: `${provider}-${Date.now()}`, provider, displayName: provider,
        model: model.trim() || PROVIDER_DEFAULTS[provider],
        apiKey: apiKey.trim() || undefined,
        ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
        ...(effort ? { thinking: { effort } } : {}),
        ...(cacheTtl ? { cacheTtl } : {}),
      }
      try { await window.fleet.registerApiSession(config); onRegistered() }
      catch (e) { setErr(`등록 실패: ${String(e)}`) }
    }
    return (
      <div>
        <h3>API 키</h3>
        <label>API 키<input aria-label="API 키" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
        <label>모델<input aria-label="모델" list="wizard-models" value={model} placeholder={PROVIDER_DEFAULTS[provider]} onChange={(e) => setModel(e.target.value)} /></label>
        <datalist id="wizard-models">{modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}</datalist>
        {provider === 'openai-compatible' && <label>Base URL<input aria-label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>}
        {provider === 'anthropic' && (
          <>
            <label>thinking effort<select aria-label="thinking effort" value={effort} onChange={(e) => setEffort(e.target.value as '' | ReasoningEffort)}>
              <option value="">off</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option>
            </select></label>
            <label>cache TTL<select aria-label="cache TTL" value={cacheTtl} onChange={(e) => setCacheTtl(e.target.value as '' | '1h')}>
              <option value="">5m</option><option value="1h">1h</option>
            </select></label>
          </>
        )}
        <button onClick={() => void submit()}>등록</button>
        {err && <p role="alert">{err}</p>}
        <button onClick={() => setStep('method')}>뒤로</button>
      </div>
    )
  }
```
import 추가: `ReasoningEffort`·`CacheTtl`·`ModelOption`·`useEffect`·`useRef`.
> 구현자 메모: `listModels` useEffect + `modelReqSeq` 레이스 가드는 기존 `SessionsPanel.tsx` 의 해당 블록을 그대로 이전(동작 보존). 빈 키여도 기존과 동일하게 등록 시도(검증은 main). `Date.now()` id 는 렌더러 일회성.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS (전체).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(picker): API 키 분기 — 기존 폼 parity 이전(listModels/effort/cacheTtl/baseUrl)"
```

---

### Task 7: SessionsPanel 통합 — 인라인 폼 → AddAiWizard (parity 확인 후 제거)

**Files:**
- Modify: `src/renderer/components/SessionsPanel.tsx`
- Modify: `src/renderer/components/SessionsPanel.test.tsx`

**Interfaces:**
- Consumes: `AddAiWizard`(Task 4-6).

- [ ] **Step 1: 삭제-전 parity 체크리스트 확인**

기존 `SessionsPanel.test.tsx` 의 API/CLI 폼 케이스를 삭제하기 전, **동일 의미 테스트가 `AddAiWizard.test.tsx` 에 존재**하는지 대조(없으면 먼저 위자드 테스트로 이전 — Task 5·6 보강):
```md
[ ] CLI 등록 성공/실패 (registerCliSession 호출·onRefresh) → 구독 분기 테스트(Task5)
[ ] registerApiSession payload shape → API 분기 테스트(Task6)
[ ] anthropic effort 반영 → Task6
[ ] anthropic cacheTtl 반영 → Task6
[ ] listModels 성공(옵션 표시)/실패(자유입력 폴백) → Task6 (실패 폴백 케이스 추가)
[ ] openai-compatible baseUrl 누락 차단 → Task6
```
누락분은 `AddAiWizard.test.tsx` 에 추가한 뒤에만 SessionsPanel 폼 테스트 삭제.

- [ ] **Step 2: 통합 테스트 작성**

```tsx
it('AddAiWizard 를 렌더한다 (등록 진입점)', async () => {
  mockFleet()
  await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
  expect(screen.getByText(/AI 추가/)).toBeTruthy()
})
```
그리고 인라인-폼 의존 케이스('세션 등록' 버튼·effort/cacheTtl/모델 레이스 등)는 **삭제**(parity 가 Step1 로 위자드에 이전됨).

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx`
Expected: FAIL — `AI 추가` 없음 + 구 폼 케이스 실패.

- [ ] **Step 4: SessionsPanel 통합**

`SessionsPanel.tsx`:
- 등록 폼 JSX + 관련 상태/핸들러(`registerCli`·`registerApi`·`detect`·provider/model/apiKey/baseUrl/effort/cacheTtl/modelOptions/modelReqSeq) **제거**(위자드로 이전됨).
- `import { AddAiWizard } from './AddAiWizard'` + 등록 섹션 자리에 `<AddAiWizard onRegistered={onRefresh} />`.
- **유지:** 세션 목록(+Task3 배지)·capability 토글·removeSession·MCP·업데이터 채널 UI.
> 제거 범위는 "등록 폼"으로 한정 — MCP/업데이터/세션목록/배지 과제거 금지.

- [ ] **Step 5: 통과 + 전체 게이트 (AGENTS 기준)**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS.
Run(전체 게이트): `npm run typecheck && npm run lint && npm test && npm run build`
Expected: 전부 PASS (회귀 0).

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/components/SessionsPanel.tsx src/renderer/components/SessionsPanel.test.tsx
git commit -m "feat(picker): SessionsPanel 인라인 폼 → AddAiWizard 통합 (parity 이전 후 제거)"
```

---

## Self-Review

**1. Spec coverage:**
- §3 스코프·§4 흐름 → Task 4-7 ✅
- §5 매트릭스·배너 → Task 2·5 ✅
- §6 아키텍처(신규 IPC 0·재사용) → Task 1·2 ✅
- §6a 외부링크(copy-only·앵커 없음·정적 docsUrl·host allowlist·PATH shadowing) → Task 1(allowlist 데이터)·5(copy-only·link-role-0 테스트)·Global Constraints ✅ (resolved-path 표시는 §후속)
- §7/§7a presentational 미검증 배지·"검증 없이 등록"·"재감지=설치 확인" → Task 3·5 ✅. **첫 사용 auth 실패 라우팅 = 스펙 §7a·계획 모두 후속으로 일치**(Codex P1 모순 해소 — 배지가 v1 정직성).
- §8 에러/엣지 → Task 5·6 err·기존 경로 ✅
- §9 테스트 → 각 태스크 TDD + Task7 parity 체크리스트 ✅

**2. Placeholder scan:** "TBD/적절히" 없음. 모든 코드 스텝 실제 코드. `listModels` useEffect 는 "기존 블록 이전" 지시(구현자 메모) — 기존 코드 위치 명시했으므로 플레이스홀더 아님. ✅

**3. Type consistency:** `CLI_AUTH_INSTALL_META{loginCommand,installHint,docsUrl}`(Task1) ↔ Task5 import 일치 · `CliAdapter.auth{loginCommand,docsUrl}`/`install{hint,docsUrl}`(Task1) ↔ registry 주입 일치 · `AuthBanner{level,message,recommendApi,docsUrl?}`(Task2) ↔ Task5 사용 일치 · `ApiProviderConfig`(thinking.effort·cacheTtl·baseUrl) 기존 타입 일치 · `registerCliSession(id,{stateful})`·`registerApiSession(config)` 기존 IPC 일치 ✅. **단일 출처화로 `CLI_META` 미러 제거 — drift 제거됨**(Codex P1).

**4. Codex 계획리뷰 P1 4건 반영 확인:**
- P1①(앵커=copy-only 위반) → Task5 `<a>` 제거·복사버튼·link-role-0 테스트 ✅
- P1②(CLI_META 이중출처) → Task1 `src/shared/cliAuthInstallMeta.ts` 단일출처·registry 일치 테스트 ✅
- P1③(Task6 최소판 회귀) → Task6 parity 필수화(listModels/effort/cacheTtl/baseUrl)+테스트·Task7 삭제전 체크리스트 ✅
- P1④(§7a vs §10 모순) → 스펙 §7a·계획 모두 라우팅 후속으로 정렬 ✅
- 게이트 누락 → Task7 `npm test`+`npm run build` 추가 ✅
- 배지 명명 → Task3 "presentational"(저장필드 아님) 명시 ✅

## 미해결 / 후속 (계획 외)

- 첫 사용 auth 실패 전용 라우팅(§7a) — chat/orchestrator 에러 경로 조사 후 별도 태스크(배지가 v1 정직성 담당).
- "연결 테스트" probe(§7) · 클릭형 외부링크 열기(가드된 IPC·host allowlist 데이터는 Task1 에 준비됨, §6a) · CLI resolved-path 표시(PATH shadowing) — §후속.
- shared 메타 ↔ 위험배너 맵 통합 여부(현재 분리: 메타=shared/명령·URL, 배너=renderer/문구).

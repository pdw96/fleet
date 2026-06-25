# 세션 등록 인증 picker 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SessionsPanel의 분리된 CLI/API 등록 섹션을 단일 가이드 picker(`AddAiWizard`)로 통합 — provider-first → 인증방식(구독/API키) → 분기. 구독 분기는 설치/로그인 *안내*(copy-only) + 프로바이더별 위험 배너 + authStatus 미검증 계약.

**Architecture:** 대부분 기존 재사용(신규 런타임 dep 0). `CliAdapter`에 정적 `auth`/`install` 데이터 추가, 렌더러에 위험-배너 맵 + `AddAiWizard` 컴포넌트 신설(등록 폼 상태를 SessionsPanel에서 위자드로 이전), CLI 세션 카드에 "미검증" 배지. 기존 IPC(`detectClis`·`registerCliSession`·`registerApiSession`·`listModels`)·`secretCrypto` 그대로.

**Tech Stack:** TypeScript · React 19 · Electron · vitest + @testing-library/react(jsdom docblock) · 기존 `window.fleet` preload 브리지.

## Global Constraints

- 신규 런타임(prod) 의존성 추가 **0** — node-pty·PTY 금지(스펙 D3).
- 코어(`src/main/core/**`)는 Electron 비의존 — `CliAdapter`는 **IPC 직렬화 가능(함수 필드 금지·데이터만)** (`src/shared/types.ts:77` 주석).
- 외부 링크: **v1 copy-only**(클릭 외부열기·`shell.openExternal` 도입 금지) · `docsUrl`은 정적 registry 데이터만(사용자/원격 입력 비주입) (스펙 §6a).
- 로그인 명령은 **표시·복사 전용** — Fleet이 shell 로 실행하지 않음(터미널 자동실행 금지, 스펙 D3).
- CLI 세션은 **로그인 성공을 표현하지 않음** — `authStatus:'unverified'` 계약(스펙 §7a).
- 배너 문구는 법률 단정 금지 → 정책 리스크 안내(스펙 §5 문구 원칙). 문구는 스펙 §5 표의 값을 그대로 사용.
- 테스트: 렌더러 컴포넌트 테스트는 파일 상단 `/** @vitest-environment jsdom */` 도크블록 + 기존 `mockFleet`/`renderSettled` 패턴(`SessionsPanel.test.tsx`) 따름.
- 커밋: 각 태스크 끝 frequent commit. 브랜치 `feat/session-auth-picker`.

---

### Task 1: CliAdapter `auth`/`install` 정적 데이터

**Files:**
- Modify: `src/shared/types.ts` (CliAdapter 인터페이스, `:60-111` 근처)
- Modify: `src/main/core/cli/registry.ts` (claude/codex/gemini 어댑터)
- Test: `src/main/core/cli/registry.test.ts` (신규)

**Interfaces:**
- Produces: `CliAdapter.auth?: { loginCommand: string; docsUrl: string }` · `CliAdapter.install?: { hint: string; docsUrl: string }`. 렌더러 위자드(Task 5)가 소비.

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/cli/registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_CLI_ADAPTERS, createCliRegistry } from './registry'

describe('CLI adapter auth/install metadata', () => {
  it('claude·codex·gemini 어댑터가 auth.loginCommand·install.hint·https docsUrl 을 갖는다', () => {
    const reg = createCliRegistry()
    for (const id of ['claude', 'codex', 'gemini']) {
      const a = reg.get(id)!
      expect(a.auth?.loginCommand).toBeTruthy()
      expect(a.auth?.docsUrl.startsWith('https://')).toBe(true)
      expect(a.install?.hint).toBeTruthy()
      expect(a.install?.docsUrl.startsWith('https://')).toBe(true)
    }
  })

  it('어댑터는 IPC 직렬화 가능하다 — 함수 필드가 없다', () => {
    const json = JSON.stringify(DEFAULT_CLI_ADAPTERS)
    const round = JSON.parse(json)
    expect(round).toEqual(DEFAULT_CLI_ADAPTERS) // 함수가 있으면 직렬화서 사라져 불일치
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/cli/registry.test.ts`
Expected: FAIL — `auth`/`install` undefined.

- [ ] **Step 3: 타입 추가**

`src/shared/types.ts` — `CliAdapter` 인터페이스에 추가(`edit?` 필드 근처, `:110` 앞):
```ts
  /** 구독 로그인 안내용 정적 데이터(표시·복사 전용 — Fleet 이 실행하지 않음). https docsUrl 만. */
  auth?: { loginCommand: string; docsUrl: string }
  /** 미설치 시 설치 안내용 정적 데이터(표시·복사 전용). https docsUrl 만. */
  install?: { hint: string; docsUrl: string }
```

- [ ] **Step 4: registry 데이터 채우기**

`src/main/core/cli/registry.ts` — 각 어댑터 객체에 추가(claude 예시; codex·gemini 동형):
```ts
  // claude 어댑터 안:
    auth: { loginCommand: 'claude login', docsUrl: 'https://docs.anthropic.com/en/docs/claude-code' },
    install: { hint: 'npm i -g @anthropic-ai/claude-code', docsUrl: 'https://docs.anthropic.com/en/docs/claude-code' },
  // codex 어댑터 안:
    auth: { loginCommand: 'codex login', docsUrl: 'https://developers.openai.com/codex/cli' },
    install: { hint: 'npm i -g @openai/codex', docsUrl: 'https://developers.openai.com/codex/cli' },
  // gemini 어댑터 안:
    auth: { loginCommand: 'gemini', docsUrl: 'https://google-gemini.github.io/gemini-cli/' },
    install: { hint: 'npm i -g @google/gemini-cli', docsUrl: 'https://google-gemini.github.io/gemini-cli/' },
```
> ⚠️ 구현자 메모: 위 login/install 명령·docsUrl 은 스펙 §5·§6a 기준 *현행 추정*. 착수 시 각 CLI 공식 문서로 명령·도메인 재확인(claude 는 `/login` 대화형 변형 가능). docsUrl 도메인은 §6a allowlist 와 일치해야 함.

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/main/core/cli/registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: 커밋**

```bash
git add src/shared/types.ts src/main/core/cli/registry.ts src/main/core/cli/registry.test.ts
git commit -m "feat(picker): CliAdapter auth/install 정적 데이터 + 직렬화 테스트"
```

---

### Task 2: 위험-배너 데이터 모듈 (렌더러)

**Files:**
- Create: `src/renderer/components/authBanners.ts`
- Test: `src/renderer/components/authBanners.test.ts` (신규)

**Interfaces:**
- Produces: `type RiskLevel = 'clean' | 'caution' | 'warning'` · `interface AuthBanner { level: RiskLevel; message: string; recommendApi: boolean; docsUrl?: string }` · `SUBSCRIPTION_BANNERS: Record<ApiProviderConfig['provider'], AuthBanner | null>` · `subscriptionSupported(provider): boolean`. Task 4·5 가 소비.

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
export interface AuthBanner {
  level: RiskLevel
  message: string
  recommendApi: boolean
  docsUrl?: string
}

type Provider = ApiProviderConfig['provider']

// 스펙 §5 — 법률 단정 금지, 정책 리스크 안내. null = 구독 분기 미제공.
export const SUBSCRIPTION_BANNERS: Record<Provider, AuthBanner | null> = {
  anthropic: {
    level: 'clean',
    message: '공식 Claude Code CLI 인증을 그대로 사용합니다. Fleet 은 Claude 자격증명을 저장/읽지 않습니다.',
    recommendApi: false,
  },
  openai: {
    level: 'caution',
    message:
      'Codex CLI 기존 로그인을 사용합니다. Fleet 은 자격증명을 읽지 않습니다. 조직/상업/공유 환경은 OpenAI 약관·계정 정책을 확인하세요. 정책/플랜별 허용 범위가 달라질 수 있어 API 키가 더 명시적입니다.',
    recommendApi: false,
  },
  google: {
    level: 'warning',
    message:
      'Gemini CLI 의 Google 계정/OAuth 사용은 Google 정책·Gemini CLI 약관 적용을 받습니다. 제3자 소프트웨어의 OAuth 기반 자동화/우회 통합은 제한·탐지 대상이 될 수 있습니다. 계정 리스크를 피하려면 API 키를 권장합니다. Fleet 은 Google 자격증명을 저장/읽지 않습니다.',
    recommendApi: true,
  },
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

### Task 3: CLI 세션 "미검증" 배지 (authStatus 계약)

**Files:**
- Modify: `src/renderer/components/SessionsPanel.tsx` (세션 카드 렌더 — 각 `LlmDescriptor` 매핑부)
- Test: `src/renderer/components/SessionsPanel.test.tsx` (케이스 추가)

**Interfaces:**
- Consumes: `LlmDescriptor.kind` (`'cli' | 'api'`).
- Produces: CLI 세션 카드에 텍스트 "로그인 미검증 · 첫 메시지에서 인증 확인" 배지.

- [ ] **Step 1: 실패 테스트 작성** (`SessionsPanel.test.tsx` describe 안에 추가)

```tsx
it('CLI 세션 카드에 로그인 미검증 배지를 표시한다 (authStatus 계약)', async () => {
  mockFleet()
  const cliSession = {
    id: 's1', kind: 'cli' as const, displayName: 'Claude Code', ref: 'claude',
  }
  await renderSettled(<SessionsPanel sessions={[cliSession]} onRefresh={vi.fn()} />)
  expect(screen.getByText(/로그인 미검증/)).toBeTruthy()
})

it('API 세션 카드에는 미검증 배지를 표시하지 않는다', async () => {
  mockFleet()
  const apiSession = {
    id: 's2', kind: 'api' as const, displayName: 'Claude API', ref: 'cfg1',
  }
  await renderSettled(<SessionsPanel sessions={[apiSession]} onRefresh={vi.fn()} />)
  expect(screen.queryByText(/로그인 미검증/)).toBeNull()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx -t "미검증"`
Expected: FAIL — 배지 없음.

- [ ] **Step 3: 배지 렌더 추가**

`SessionsPanel.tsx` 세션 카드 매핑부(각 `s: LlmDescriptor` 렌더)에서 displayName 옆/아래에 추가:
```tsx
{s.kind === 'cli' && (
  <span className="badge badge-unverified" title="설치만 확인됨 — 로그인/권한은 첫 사용 시 검증됩니다">
    로그인 미검증 · 첫 메시지에서 인증 확인
  </span>
)}
```
> 구현자 메모: 세션 카드 JSX 위치는 `sessions.map((s) => ...)` 블록. 기존 마크업/클래스 컨벤션 따라 배치.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx -t "미검증"`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/SessionsPanel.tsx src/renderer/components/SessionsPanel.test.tsx
git commit -m "feat(picker): CLI 세션 미검증 배지 (authStatus 계약 §7a)"
```

---

### Task 4: AddAiWizard — 스캐폴드 + 단계 네비게이션

**Files:**
- Create: `src/renderer/components/AddAiWizard.tsx`
- Test: `src/renderer/components/AddAiWizard.test.tsx` (신규)

**Interfaces:**
- Consumes: `window.fleet.detectClis`(Task 외 기존). `subscriptionSupported`(Task 2).
- Produces: `AddAiWizard({ onRegistered }: { onRegistered: () => void })`. 단계 상태 `step: 'provider' | 'method' | 'subscription' | 'apikey'`, `provider`, `method: 'subscription' | 'apikey' | null`.

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
async function renderSettled(ui: Parameters<typeof render>[0]) {
  const r = render(ui); await act(async () => {}); return r
}
afterEach(() => { delete (window as unknown as { fleet?: unknown }).fleet; vi.restoreAllMocks() })

describe('AddAiWizard', () => {
  it('provider 선택 → method 단계로 전이한다', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    expect(screen.getByRole('button', { name: /구독/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /API 키/ })).toBeTruthy()
  })

  it('openai-호환 은 구독 방식을 노출하지 않는다', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
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
          <button key={p.id} onClick={() => { setProvider(p.id); setStep('method') }}>
            {p.label}
          </button>
        ))}
      </div>
    )
  }
  if (step === 'method') {
    return (
      <div>
        <h3>인증 방식</h3>
        {subscriptionSupported(provider) && (
          <button onClick={() => setStep('subscription')}>구독 (공식 CLI)</button>
        )}
        <button onClick={() => setStep('apikey')}>API 키</button>
        <button onClick={() => setStep('provider')}>뒤로</button>
      </div>
    )
  }
  // subscription/apikey 단계는 Task 5·6 에서 채운다.
  return <div data-provider={provider} data-step={step}>{/* Task 5·6 */}</div>
}
```
> `onRegistered` 는 Task 5·6 에서 등록 성공 시 호출. 지금은 미사용(린트 경고 회피 위해 분기 채우기 전까지 `void onRegistered` 불요 — Task 5 에서 사용).

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(picker): AddAiWizard 스캐폴드 — provider→method 단계 전이"
```

---

### Task 5: AddAiWizard — 구독 분기 (위험 배너 · 감지 · copy-only · 등록)

**Files:**
- Modify: `src/renderer/components/AddAiWizard.tsx`
- Test: `src/renderer/components/AddAiWizard.test.tsx` (케이스 추가)

**Interfaces:**
- Consumes: `SUBSCRIPTION_BANNERS`(Task 2)·`window.fleet.detectClis`/`registerCliSession`·`CliDetectionResult`.
- Produces: 구독 단계 — 배너 표시·미설치/설치됨 분기·`installed→ "검증 없이 등록"→registerCliSession(adapterId,{stateful:false})→onRegistered()`.

- [ ] **Step 1: 실패 테스트 작성** (describe 안 추가)

```tsx
it('구독 분기: gemini 경고 배너 표시 + API 권장', async () => {
  mockFleet({ detectClis: vi.fn().mockResolvedValue([]) })
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /Gemini/ }))
  fireEvent.click(screen.getByRole('button', { name: /구독/ }))
  expect(screen.getByText(/제한·탐지 대상/)).toBeTruthy()
})

it('구독 분기: 설치됨 → "검증 없이 등록" → registerCliSession + onRegistered', async () => {
  const reg = vi.fn().mockResolvedValue(undefined)
  const onRegistered = vi.fn()
  mockFleet({ registerCliSession: reg })
  await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /구독/ }))
  fireEvent.click(await screen.findByRole('button', { name: /검증 없이 등록/ }))
  await act(async () => {})
  expect(reg).toHaveBeenCalledWith('claude', { stateful: false })
  expect(onRegistered).toHaveBeenCalled()
})

it('구독 분기: 미설치 → 설치 안내(hint) 표시, 등록 버튼 없음', async () => {
  mockFleet({ detectClis: vi.fn().mockResolvedValue([]) })
  await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /구독/ }))
  expect(await screen.findByText(/npm i -g @anthropic-ai\/claude-code/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /검증 없이 등록/ })).toBeNull()
})
```
> 미설치 테스트는 `install.hint` 가 detectClis 결과가 아니라 어댑터 데이터에서 와야 함 → 위자드가 어댑터 메타를 알아야 한다(아래 Step 3: detectClis 결과의 adapter id 로 정적 메타 매핑, 또는 detectClis 가 어댑터 메타를 포함하도록). v1 단순화: 위자드 내 provider→adapterId·정적 메타(loginCommand/installHint/docsUrl) 상수 맵을 둔다(어댑터 데이터의 렌더러 미러). 또는 별도 IPC 로 어댑터 목록 조회. **결정: 위자드 상수 맵**(신규 IPC 0). Task 1 의 registry 데이터와 동기 — 단위 테스트로 일치 강제는 후속.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx -t 구독`
Expected: FAIL.

- [ ] **Step 3: 구독 분기 구현**

`AddAiWizard.tsx` — provider→{adapterId, loginCommand, installHint, docsUrl} 상수 맵 + 구독 단계 렌더:
```tsx
// 상단 상수 (registry.ts 데이터의 렌더러 미러 — 신규 IPC 회피)
const CLI_META: Partial<Record<Provider, { adapterId: string; loginCommand: string; installHint: string; docsUrl: string }>> = {
  anthropic: { adapterId: 'claude', loginCommand: 'claude login', installHint: 'npm i -g @anthropic-ai/claude-code', docsUrl: 'https://docs.anthropic.com/en/docs/claude-code' },
  openai: { adapterId: 'codex', loginCommand: 'codex login', installHint: 'npm i -g @openai/codex', docsUrl: 'https://developers.openai.com/codex/cli' },
  google: { adapterId: 'gemini', loginCommand: 'gemini', installHint: 'npm i -g @google/gemini-cli', docsUrl: 'https://google-gemini.github.io/gemini-cli/' },
}
```
컴포넌트 내부 상태/핸들러 추가:
```tsx
  const [clis, setClis] = useState<CliDetectionResult[]>([])
  const [err, setErr] = useState<string | null>(null)
  // 구독 단계 진입 시 1회 감지
  function enterSubscription() {
    setStep('subscription')
    void window.fleet.detectClis().then(setClis).catch((e) => setErr(String(e)))
  }
```
(method 단계의 구독 버튼 onClick 을 `enterSubscription` 으로 교체.)
구독 단계 렌더:
```tsx
  if (step === 'subscription') {
    const meta = CLI_META[provider]!
    const banner = SUBSCRIPTION_BANNERS[provider]
    const detected = clis.find((c) => c.id === meta.adapterId)
    const installed = !!detected?.installed
    return (
      <div>
        <h3>구독 (공식 CLI 위임)</h3>
        {banner && <p role="note" data-level={banner.level}>{banner.message}{banner.recommendApi && ' (API 키 권장)'}</p>}
        {!installed ? (
          <div>
            <p>CLI 미설치. 설치 후 "재확인":</p>
            <code>{meta.installHint}</code>
            <a href={meta.docsUrl}>{meta.docsUrl}</a>
            <button onClick={() => window.fleet.detectClis().then(setClis)}>재확인 (설치 확인)</button>
          </div>
        ) : (
          <div>
            <p>로그인이 안 돼 있다면 터미널에서 실행(복사):</p>
            <code>{meta.loginCommand}</code>
            <a href={meta.docsUrl}>{meta.docsUrl}</a>
            <button onClick={async () => {
              setErr(null)
              try { await window.fleet.registerCliSession(meta.adapterId, { stateful: false }); onRegistered() }
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
import 에 `CliDetectionResult`·`SUBSCRIPTION_BANNERS` 추가.
> `<a href>` 는 v1 copy-only 원칙상 **새 탭 외부열기를 트리거하지 않도록** 클릭 핸들러 없이 텍스트+URL 표시 용도. (Electron 렌더러에서 `<a href>` 기본 네비게이션은 window-guards 가 차단 — 외부열기 IPC 미도입. §6a.)

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS (구독 3 + 기존 2).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(picker): 구독 분기 — 위험배너·감지·copy-only·검증없이등록 (§5·§6a·§7a)"
```

---

### Task 6: AddAiWizard — API 키 분기

**Files:**
- Modify: `src/renderer/components/AddAiWizard.tsx`
- Test: `src/renderer/components/AddAiWizard.test.tsx` (케이스 추가)

**Interfaces:**
- Consumes: `window.fleet.registerApiSession`·`listModels`·`ApiProviderConfig`.
- Produces: apikey 단계 — provider+key+model(+anthropic effort/cacheTtl)→`registerApiSession(config)`→onRegistered().

- [ ] **Step 1: 실패 테스트 작성**

```tsx
it('API 키 분기: 키+모델 입력 → registerApiSession + onRegistered', async () => {
  const reg = vi.fn().mockResolvedValue(undefined)
  const onRegistered = vi.fn()
  mockFleet({ registerApiSession: reg })
  await renderSettled(<AddAiWizard onRegistered={onRegistered} />)
  fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
  fireEvent.click(screen.getByRole('button', { name: /API 키/ }))
  fireEvent.change(screen.getByLabelText(/API 키/), { target: { value: 'sk-test' } })
  fireEvent.click(screen.getByRole('button', { name: /등록/ }))
  await act(async () => {})
  expect(reg).toHaveBeenCalled()
  const cfg = reg.mock.calls[0][0]
  expect(cfg.provider).toBe('anthropic')
  expect(cfg.apiKey).toBe('sk-test')
  expect(onRegistered).toHaveBeenCalled()
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx -t "API 키 분기"`
Expected: FAIL.

- [ ] **Step 3: API 키 분기 구현**

`AddAiWizard.tsx` — 상태 + apikey 단계 렌더(기존 SessionsPanel 폼 로직 이식·최소):
```tsx
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')

  if (step === 'apikey') {
    const defaults: Record<Provider, string> = {
      anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.5', google: 'gemini-3.5-flash', 'openai-compatible': '',
    }
    return (
      <div>
        <h3>API 키</h3>
        <label>API 키<input aria-label="API 키" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></label>
        <label>모델<input aria-label="모델" value={model} placeholder={defaults[provider]} onChange={(e) => setModel(e.target.value)} /></label>
        {provider === 'openai-compatible' && (
          <label>Base URL<input aria-label="Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        )}
        <button onClick={async () => {
          setErr(null)
          const config: ApiProviderConfig = {
            id: `${provider}-${Date.now()}`, provider,
            displayName: provider, model: (model.trim() || defaults[provider]),
            apiKey: apiKey.trim() || undefined,
            ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
          }
          try { await window.fleet.registerApiSession(config); onRegistered() }
          catch (e) { setErr(`등록 실패: ${String(e)}`) }
        }}>등록</button>
        {err && <p role="alert">{err}</p>}
        <button onClick={() => setStep('method')}>뒤로</button>
      </div>
    )
  }
```
import 에 `ApiProviderConfig` 추가.
> 구현자 메모: 모델 라이브 조회(`listModels`)·effort·cacheTtl 는 기존 SessionsPanel 로직을 이식하면 좋으나 **v1 최소**는 위처럼 키+모델만. effort/cacheTtl/listModels 이식은 동일 태스크 내 선택 확장(기존 SessionsPanel 핸들러 §라인 참조). `Date.now()` id 생성은 렌더러 일회성 — 결정성 불요.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS (전체).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/AddAiWizard.tsx src/renderer/components/AddAiWizard.test.tsx
git commit -m "feat(picker): API 키 분기 — registerApiSession"
```

---

### Task 7: SessionsPanel 통합 — 기존 인라인 폼 → AddAiWizard

**Files:**
- Modify: `src/renderer/components/SessionsPanel.tsx` (등록 폼 제거 → `<AddAiWizard>`)
- Modify: `src/renderer/components/SessionsPanel.test.tsx` (기존 폼 의존 케이스 마이그레이션)

**Interfaces:**
- Consumes: `AddAiWizard`(Task 4-6).

- [ ] **Step 1: 기존 테스트 마이그레이션 작성**

기존 `SessionsPanel.test.tsx` 의 인라인-폼 의존 케이스(`'세션 등록'` 버튼 클릭, effort/cacheTtl 등)는 폼이 위자드로 이동하므로 **위자드 흐름으로 재작성하거나 `AddAiWizard.test.tsx` 로 이전**. SessionsPanel.test 에는 통합 케이스만 남긴다:
```tsx
it('AddAiWizard 를 렌더한다 (등록 진입점)', async () => {
  mockFleet()
  await renderSettled(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
  expect(screen.getByText(/AI 추가/)).toBeTruthy()
})
```
폼-특정 케이스(`'세션 등록'`·effort·cacheTtl·모델 조회 레이스)는 삭제하고 해당 검증을 `AddAiWizard.test.tsx` 가 커버하는지 확인(Task 5·6). 누락분은 위자드 테스트로 이전.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx`
Expected: FAIL — `AI 추가` 텍스트 없음 + 기존 폼 케이스 실패.

- [ ] **Step 3: SessionsPanel 통합**

`SessionsPanel.tsx`:
- 등록 폼 JSX(provider/model/apiKey/effort/cacheTtl/CLI 목록 등록 버튼)·관련 상태/핸들러(`registerCli`·`registerApi`·`detect`(위자드로 이전 시)·effort/cacheTtl/model state)를 제거.
- import: `import { AddAiWizard } from './AddAiWizard'`.
- 등록 섹션 자리에: `<AddAiWizard onRegistered={onRefresh} />`.
- **유지:** 세션 목록(+Task3 배지)·capability 토글·removeSession·MCP·업데이터 채널 UI.
> 구현자 메모: `detect`·CLI 상태는 위자드가 자체 보유하므로 SessionsPanel 에서 제거. MCP/업데이터/세션목록 상태는 유지. 제거 범위는 "등록 폼"으로 한정 — 과제거 금지.

- [ ] **Step 4: 통과 + 전체 게이트**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx src/renderer/components/AddAiWizard.test.tsx`
Expected: PASS.
Run(전체 게이트): `npm run typecheck && npm run lint && npx vitest run`
Expected: PASS (회귀 0).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/SessionsPanel.tsx src/renderer/components/SessionsPanel.test.tsx
git commit -m "feat(picker): SessionsPanel 인라인 폼 → AddAiWizard 통합"
```

---

## Self-Review

**1. Spec coverage:**
- §3 스코프(통합 picker·provider-first·구독 설치/로그인 안내·배너) → Task 4-7 ✅
- §4 UX 흐름 → Task 4(provider/method)·5(구독)·6(apikey) ✅
- §5 매트릭스·배너 문구 → Task 2(데이터)·5(표시) ✅
- §6 아키텍처(어댑터 데이터·배너 맵·재사용·신규 IPC 0) → Task 1·2 + 전반 ✅
- §6a 외부링크 보안(copy-only·정적 docsUrl·PATH shadowing) → Task 5 copy-only·Global Constraints ✅ (PATH shadowing resolved-path 표시는 §10 후속 — v1 미포함, 명시됨)
- §7/§7a authStatus 미검증 계약·"재감지=설치 확인"·"검증 없이 등록" → Task 3(배지)·5(버튼/재확인 라벨) ✅
- §8 에러/엣지 → Task 5·6 err 상태·기존 경로 재사용 ✅
- §9 테스트 → 각 태스크 TDD ✅
- **갭/후속(명시):** 첫 사용 auth 실패 전용 라우팅(§7a)은 run/chat 에러 경로 별도 — **본 계획 비포함, §10 후속**. probe·클릭형 외부열기·resolved-path 표시도 §10 후속.

**2. Placeholder scan:** "TBD/TODO/적절히" 없음. 모든 코드 스텝에 실제 코드. ✅ (구현자 메모는 검증 지시이지 플레이스홀더 아님.)

**3. Type consistency:** `auth:{loginCommand,docsUrl}`·`install:{hint,docsUrl}`(Task1) ↔ `CLI_META`(Task5 미러, 필드명 일치) · `AuthBanner{level,message,recommendApi,docsUrl?}`(Task2) ↔ Task5 사용 일치 · `registerCliSession(id,{stateful:false})`·`registerApiSession(config)` 기존 IPC 시그니처 일치 ✅. **주의(구현자):** `CLI_META`(렌더러)와 registry `auth/install`(Task1)은 현재 수동 미러 — 값 불일치 시 docsUrl allowlist 어긋남. 후속으로 단일 출처화(IPC 조회) 고려, v1 은 수동 동기 + 코드리뷰.

## 미해결 / 후속 (계획 외)

- 첫 사용 auth 실패 전용 라우팅(§7a) — chat/orchestrator 에러 경로 조사 후 별도 태스크.
- "연결 테스트" probe(§7) · 클릭형 외부링크 열기(가드된 IPC, §6a) · CLI resolved-path 표시(PATH shadowing, §6a) — 전부 §10 후속.
- `CLI_META` 렌더러 미러 ↔ registry 단일 출처화(IPC).
- 모델 라이브 조회(`listModels`)·effort·cacheTtl 의 위자드 API 분기 이식 심화(Task6 최소판 이후).

# OpenAI-compatible Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `provider: 'openai-compatible'` + `baseUrl` 를 추가해 OpenRouter·로컬 vLLM 등 임의 OpenAI Chat Completions 호환 엔드포인트를 GUI 에서 등록·사용한다(200+ 모델 해금).

**Architecture:** 새 서버 없음 — 기존 `openai.ts` provider 를 두 모드 공용으로 파라미터화(엔드포인트만 설정화). 공유 헬퍼(buildMessages·readStream·mapUsage·parseArgs) 재사용, 분기는 엔드포인트·token 필드·reasoning 처리 4점만. reasoning 은 opt-in flat `reasoning_effort` 패스스루 + 400 재시도 가드(OpenAI 모델명 정규화 재사용 금지).

**Tech Stack:** TypeScript, Electron(main: 순수 TS provider), React(renderer SessionsPanel), Vitest + @testing-library/react. raw HTTP(fetch) — SDK 없음.

**Spec:** `docs/superpowers/specs/2026-06-15-openai-compatible-provider-design.md`

---

## File Structure

- `src/shared/types.ts` — `ApiProviderConfig.provider` 유니온 + `baseUrl?` 필드.
- `src/main/core/providers/openai.ts` — 두 모드 공용 파라미터화 + `requireBaseUrl` 헬퍼.
- `src/main/core/providers/registry.ts` — `openai-compatible` case.
- `src/renderer/components/SessionsPanel.tsx` — 드롭다운 옵션·baseUrl 입력·thinkingSupported·검증.
- Tests: `src/main/core/providers/providers.test.ts`, `src/renderer/components/SessionsPanel.test.tsx`.

**커밋 게이트(매 태스크)**: `npm test` 통과 + 가능하면 `npm run typecheck`·`npm run lint` 녹색. Task 1 이 유니온 추가에 따른 컴파일-강제 지점(registry `never`, SessionsPanel `PROVIDER_DEFAULTS` Record)을 함께 최소 처리해 typecheck 를 깨지 않는다.

---

## Task 1: 타입 기반 + registry 라우팅 (컴파일-강제 지점 동시 처리)

**Files:**
- Modify: `src/shared/types.ts:159-172` (ApiProviderConfig)
- Modify: `src/main/core/providers/registry.ts:11-24`
- Modify: `src/main/core/providers/openai.ts` (반환 `provider` 필드)
- Modify: `src/renderer/components/SessionsPanel.tsx:19-23` (PROVIDER_DEFAULTS — Record 컴파일 강제)
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `providers.test.ts` 의 `describe('OpenAiProvider', ...)` 블록 맨 끝(닫는 `})` 직전)에 추가:

```typescript
  it('registry: openai-compatible 를 openai 구현으로 라우팅하고 provider 필드를 보존한다', () => {
    const p = createApiProvider({
      id: 'oc', provider: 'openai-compatible', displayName: 'OC',
      model: 'qwen/qwen3-32b', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1',
    })
    expect(p.provider).toBe('openai-compatible')
    expect(p.model).toBe('qwen/qwen3-32b')
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "openai-compatible 를 openai 구현으로"`
Expected: FAIL — `createApiProvider` 의 switch `default` 가 `지원하지 않는 provider: openai-compatible` throw (그리고 esbuild 는 타입 무시하고 실행).

- [ ] **Step 3: 타입 + registry + 반환필드 + PROVIDER_DEFAULTS 최소 변경**

`src/shared/types.ts` — provider 유니온 + baseUrl:

```typescript
export interface ApiProviderConfig {
  id: string
  provider: 'anthropic' | 'openai' | 'google' | 'openai-compatible'
  displayName: string
  model: string
  apiKey?: string
  /** OpenAI 호환 엔드포인트 베이스 URL(예: https://openrouter.ai/api/v1). provider==='openai-compatible' 일 때 필수, 그 외 무시. */
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  thinking?: { effort?: ReasoningEffort }
}
```

`src/main/core/providers/registry.ts` — case 추가(switch 안, `default` 앞):

```typescript
    case 'openai':
      return createOpenAiProvider(config, http)
    case 'openai-compatible':
      // OpenAI Chat Completions 호환 — 같은 구현, config.baseUrl 이 엔드포인트·동작 결정.
      return createOpenAiProvider(config, http)
    case 'google':
      return createGoogleProvider(config, http)
```

`src/main/core/providers/openai.ts` — 반환 객체의 `provider: 'openai'` 를 `provider: config.provider` 로:

```typescript
  return {
    id: config.id,
    provider: config.provider,
    model: config.model,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<ChatResult> {
```

`src/renderer/components/SessionsPanel.tsx` — PROVIDER_DEFAULTS 에 키 추가(`Record<provider,...>` 컴파일 강제, UI 옵션은 Task 5):

```typescript
const PROVIDER_DEFAULTS: Record<ApiProviderConfig['provider'], string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.5',
  google: 'gemini-3.5-flash',
  'openai-compatible': '',
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "openai-compatible 를 openai 구현으로"`
Expected: PASS

- [ ] **Step 5: typecheck 녹색 확인(유니온 파급 무에러)**

Run: `npm run typecheck`
Expected: 무출력(성공). registry `never`·PROVIDER_DEFAULTS Record 가 위 변경으로 충족.

- [ ] **Step 6: 커밋**

```bash
git add src/shared/types.ts src/main/core/providers/registry.ts src/main/core/providers/openai.ts src/renderer/components/SessionsPanel.tsx src/main/core/providers/providers.test.ts
git commit -m "feat(provider): openai-compatible 유니온+baseUrl 타입·registry 라우팅 (#27)"
```

---

## Task 2: 엔드포인트(baseUrl) + max_tokens + requireBaseUrl

**Files:**
- Modify: `src/main/core/providers/openai.ts` (chat 본문 + 신규 `requireBaseUrl`)
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `describe('OpenAiProvider', ...)` 끝에 추가:

```typescript
  it('openai-compatible: baseUrl 끝슬래시 정규화 + max_tokens 사용(reasoning 게이트 없음)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createOpenAiProvider(
      { id: 'oc', provider: 'openai-compatible', displayName: 'OC', model: 'anthropic/claude-sonnet-4-6', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1/', maxTokens: 100 },
      http,
    )
    await p.chat([{ role: 'user', content: 'hi' }])
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.max_tokens).toBe(100)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('openai-compatible: baseUrl 누락 시 chat 이 throw', async () => {
    const { http } = mockHttp(() => ({ body: '{}' }))
    const p = createOpenAiProvider(
      { id: 'oc', provider: 'openai-compatible', displayName: 'OC', model: 'x', apiKey: 'k' },
      http,
    )
    await expect(p.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/baseUrl/)
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "openai-compatible: baseUrl"`
Expected: FAIL — 현재는 항상 `ENDPOINT`(api.openai.com)로 보내 url 불일치, baseUrl 누락 throw 없음.

- [ ] **Step 3: 구현** — `src/main/core/providers/openai.ts`

파일 하단(`parseArgs` 근처)에 헬퍼 추가:

```typescript
/** openai-compatible 의 baseUrl 을 정규화해 /chat/completions 엔드포인트로 만든다. 누락 시 throw. */
function requireBaseUrl(config: ApiProviderConfig): string {
  const base = config.baseUrl?.trim()
  if (!base) throw new Error(`[openai-compatible] baseUrl 이 설정되지 않았습니다 (id=${config.id}).`)
  return base.replace(/\/+$/, '') + '/chat/completions'
}
```

`chat()` 상단 — `const apiKey = requireApiKey(config)` 다음 줄들을 교체:

```typescript
      const apiKey = requireApiKey(config)
      const compatible = config.provider === 'openai-compatible'
      const endpoint = compatible ? requireBaseUrl(config) : ENDPOINT
      const reasoning = !compatible && isReasoningModel(config.model)
```

`send` 정의에서 `ENDPOINT` → `endpoint`:

```typescript
      const send = (): Promise<HttpResponse> =>
        http(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
```

(이 태스크 시점에선 max_tokens/temperature 분기는 기존 `reasoning` 변수를 그대로 쓰며, compatible 일 때 `reasoning=false` 라 자동으로 `max_tokens`·temperature 전송됨.)

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "openai-compatible: baseUrl"`
Expected: PASS (2 tests)

- [ ] **Step 5: 전체 providers + typecheck 회귀 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts && npm run typecheck`
Expected: 전부 PASS / 무출력

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/providers/openai.ts src/main/core/providers/providers.test.ts
git commit -m "feat(provider): openai-compatible baseUrl 엔드포인트+max_tokens (#27)"
```

---

## Task 3: opt-in reasoning_effort 패스스루 + max→high 다운매핑

**Files:**
- Modify: `src/main/core/providers/openai.ts` (chat 본문 reasoning 분기)
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `describe('OpenAiProvider', ...)` 끝에 추가:

```typescript
  it('openai-compatible: thinking.effort 를 flat reasoning_effort 로 패스스루(모델명 정규화 없이)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    // OpenAI regex 에 안 걸리는 슬러그여도 effort 가 그대로 실려야 한다(resolveReasoningEffort 였다면 drop).
    const p = createOpenAiProvider(
      { id: 'oc', provider: 'openai-compatible', displayName: 'OC', model: 'qwen/qwen3-32b', apiKey: 'k', baseUrl: 'https://x/v1', thinking: { effort: 'high' } },
      http,
    )
    await p.chat([{ role: 'user', content: 'hi' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).reasoning_effort).toBe('high')
  })

  it('openai-compatible: max effort 는 high 로 다운매핑', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createOpenAiProvider(
      { id: 'oc', provider: 'openai-compatible', displayName: 'OC', model: 'x', apiKey: 'k', baseUrl: 'https://x/v1', thinking: { effort: 'max' } },
      http,
    )
    await p.chat([{ role: 'user', content: 'hi' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).reasoning_effort).toBe('high')
  })

  it('openai-compatible: effort 미지정이면 reasoning_effort 미전송', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createOpenAiProvider(
      { id: 'oc', provider: 'openai-compatible', displayName: 'OC', model: 'x', apiKey: 'k', baseUrl: 'https://x/v1' },
      http,
    )
    await p.chat([{ role: 'user', content: 'hi' }])
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).reasoning_effort).toBeUndefined()
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "openai-compatible:" `
Expected: FAIL — compatible 은 현재 `resolveReasoningEffort(config.model, ...)` 를 타는데 'qwen/qwen3-32b'·'x' 는 `isReasoningModel` false → reasoning_effort 미전송이라 첫 두 테스트 실패('max' 케이스도 미전송).

- [ ] **Step 3: 구현** — `src/main/core/providers/openai.ts` chat() 의 reasoning_effort 블록을 분기:

기존:
```typescript
      const reasoningEffort = resolveReasoningEffort(config.model, opts.thinking ?? config.thinking)
      if (reasoningEffort) body.reasoning_effort = reasoningEffort
```

교체:
```typescript
      if (compatible) {
        // opt-in flat 패스스루: 모델명 정규화(resolveReasoningEffort) 미사용 — OpenRouter 슬러그(claude/qwen 등)에서
        // false 가 되어 silent-drop 되는 것을 회피. 'max' 는 OpenAI 스펙 비표준값이라 strict 서버 Literal 검증
        // 400 회피용으로 'high' 다운매핑(그 외 low/medium/high/xhigh 는 그대로).
        const effort = (opts.thinking ?? config.thinking)?.effort
        if (effort !== undefined) body.reasoning_effort = effort === 'max' ? 'high' : effort
      } else {
        const reasoningEffort = resolveReasoningEffort(config.model, opts.thinking ?? config.thinking)
        if (reasoningEffort) body.reasoning_effort = reasoningEffort
      }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "openai-compatible:"`
Expected: PASS (3 reasoning tests + Task2 의 2 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/openai.ts src/main/core/providers/providers.test.ts
git commit -m "feat(provider): openai-compatible opt-in reasoning_effort 패스스루+max다운매핑 (#27)"
```

---

## Task 4: reasoning_effort 400 재시도 가드

**Files:**
- Modify: `src/main/core/providers/openai.ts` (chat 본문 send 가드)
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `describe('OpenAiProvider', ...)` 끝에 추가:

```typescript
  it('openai-compatible: reasoning_effort 가 400 이면 그 필드만 빼고 1회 재시도', async () => {
    const calls: { body: string }[] = []
    const http: HttpClient = async (_url, init) => {
      calls.push({ body: init.body })
      const hasReasoning = (JSON.parse(init.body) as Record<string, unknown>).reasoning_effort !== undefined
      if (hasReasoning) return { ok: false, status: 400, text: async () => 'unknown param: reasoning_effort' }
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }
    }
    const p = createOpenAiProvider(
      { id: 'oc', provider: 'openai-compatible', displayName: 'OC', model: 'x', apiKey: 'k', baseUrl: 'https://x/v1', thinking: { effort: 'high' } },
      http,
    )
    const out = await p.chat([{ role: 'user', content: 'hi' }])
    expect(calls).toHaveLength(2)
    expect((JSON.parse(calls[0].body) as Record<string, unknown>).reasoning_effort).toBe('high')
    expect((JSON.parse(calls[1].body) as Record<string, unknown>).reasoning_effort).toBeUndefined()
    expect(out.text).toBe('ok')
  })
```

(`HttpClient` 는 이미 providers.test.ts 상단에서 `import ... type HttpClient` 됨 — line 7.)

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "400 이면 그 필드만 빼고"`
Expected: FAIL — 현재는 400 을 그대로 ApiProviderError throw(재시도 없음) → `calls` 길이 1, out 없음.

- [ ] **Step 3: 구현** — `src/main/core/providers/openai.ts` chat() 의 `const res = await sendWithSchemaFallback(...)` 앞에 reasoning fallback 래퍼 삽입:

기존:
```typescript
      const send = (): Promise<HttpResponse> =>
        http(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      const res = await sendWithSchemaFallback(send, !!opts.responseSchema, () => { delete body.response_format })
```

교체:
```typescript
      const send = (): Promise<HttpResponse> =>
        http(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      // compatible: reasoning_effort 가 실린 요청이 400 이면 그 필드만 빼고 1회 재시도(strict 서버 graceful
      // degradation — 일부 OpenAI-호환 서버는 미지원 파라미터에 400). 이후 결과는 schema 400 폴백과 조합.
      const sendWithReasoningFallback = async (): Promise<HttpResponse> => {
        const r = await send()
        if (compatible && body.reasoning_effort !== undefined && !r.ok && r.status === 400) {
          delete body.reasoning_effort
          return send()
        }
        return r
      }
      const res = await sendWithSchemaFallback(sendWithReasoningFallback, !!opts.responseSchema, () => { delete body.response_format })
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "400 이면 그 필드만 빼고"`
Expected: PASS

- [ ] **Step 5: 전체 providers 회귀 + typecheck + lint**

Run: `npx vitest run src/main/core/providers/providers.test.ts && npm run typecheck && npm run lint`
Expected: 전부 PASS / 무출력

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/providers/openai.ts src/main/core/providers/providers.test.ts
git commit -m "feat(provider): openai-compatible reasoning_effort 400 재시도 가드 (#27)"
```

---

## Task 5: SessionsPanel UI (드롭다운·baseUrl 입력·thinking·검증)

**Files:**
- Modify: `src/renderer/components/SessionsPanel.tsx` (상태·thinkingSupported·registerApi·렌더·검증)
- Test: `src/renderer/components/SessionsPanel.test.tsx`

- [ ] **Step 1: 실패 테스트 작성** — `SessionsPanel.test.tsx` 의 `describe('SessionsPanel', ...)` 안에 추가:

```typescript
  it('openai-compatible 선택 시 Base URL 입력칸과 effort 셀렉트가 노출된다', async () => {
    mockFleet()
    render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } })
    expect(screen.getByLabelText(/Base URL/i)).toBeTruthy()
    expect(screen.getByLabelText(/Thinking effort/i)).toBeTruthy()
  })

  it('openai-compatible 등록 config 에 baseUrl·provider 가 실린다', async () => {
    const fleet = mockFleet()
    render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-compatible' } })
    fireEvent.change(screen.getByLabelText(/Base URL/i), { target: { value: 'https://openrouter.ai/api/v1' } })
    fireEvent.change(screen.getByLabelText('모델'), { target: { value: 'qwen/qwen3-32b' } })
    fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

    await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
    const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
    expect(cfg.provider).toBe('openai-compatible')
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(cfg.model).toBe('qwen/qwen3-32b')
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx -t "openai-compatible"`
Expected: FAIL — 드롭다운에 openai-compatible 옵션 없음 → `fireEvent.change` value 미반영, Base URL 라벨 없음, 모델 input 라벨 미연결.

- [ ] **Step 3: 구현** — `src/renderer/components/SessionsPanel.tsx`

(a) baseUrl 상태 추가 — `const [apiKey, setApiKey] = useState('')` 다음 줄:

```typescript
  const [baseUrl, setBaseUrl] = useState('')
```

(b) thinkingSupported 에 openai-compatible 포함 (line 47):

```typescript
  const thinkingSupported =
    provider === 'anthropic' || provider === 'openai' || provider === 'google' || provider === 'openai-compatible'
```

(c) registerApi config 에 baseUrl 포함 (line 172-179 config 객체):

```typescript
      const config: ApiProviderConfig = {
        id: `${provider}-${Date.now()}`,
        provider,
        displayName: `${provider} (${model}${thinkingOn ? `, thinking:${effort}` : ''})`,
        model,
        apiKey: apiKey.trim(),
        ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
        ...(thinkingOn ? { thinking: { effort } } : {}),
      }
```

(d) registerApi 가드(line 165) — compatible 은 baseUrl·model 도 필수:

```typescript
  async function registerApi() {
    if (!apiKey.trim()) return
    if (provider === 'openai-compatible' && (!baseUrl.trim() || !model.trim())) return
```

(e) 드롭다운에 옵션 추가 (line 285 `<option value="google">` 다음):

```typescript
              <option value="google">Google</option>
              <option value="openai-compatible">OpenAI-compatible</option>
```

(f) 모델 input 에 라벨 연결(테스트 쿼리 가능하게) — line 288-289 교체:

```typescript
            <label className="field-label" htmlFor="api-model">모델</label>
            <input id="api-model" className="field" value={model} onChange={(e) => setModel(e.target.value)} />
```

(g) baseUrl 입력칸 — `</div>` 로 닫히는 `grid-2` 블록(line 291) 다음, `{thinkingSupported && (` (line 292) 앞에 삽입:

```typescript
        {provider === 'openai-compatible' && (
          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="api-base-url">Base URL</label>
            <input
              id="api-base-url"
              className="field"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://openrouter.ai/api/v1"
            />
            <p className="meta" style={{ marginTop: 6 }}>
              OpenAI Chat Completions 호환 엔드포인트(OpenRouter·로컬 vLLM 등). 키는 해당 서비스의 API 키.
            </p>
          </div>
        )}
```

(h) thinking help text 에 openai-compatible 분기 추가 (line 311-315 삼항을 확장) — `provider === 'openai'` 분기 다음에 openai-compatible 우선 처리:

```typescript
              {provider === 'anthropic'
                ? '현행 세대(Opus 4.6+ · Sonnet 4.6)에서만 적용 — 미지원 모델은 자동 off, 미지원 티어는 기본(high)으로 동작합니다.'
                : provider === 'openai'
                  ? 'reasoning 모델(o-series · GPT-5+, chat·o1 초기 모델 제외)에서만 적용 — 그 외는 미전송, xhigh/max 는 미지원 모델에서 high 로, pro 모델은 지원 티어로 자동 정규화됩니다.'
                  : provider === 'openai-compatible'
                    ? '엔드포인트/모델이 지원할 때만 reasoning_effort 로 적용됩니다(미지원 시 무시 또는 자동 제거). max 는 high 로 보냅니다.'
                    : 'Gemini 3.x(gemini-3-pro · 3.5-flash 등)는 effort→thinking 깊이(low/medium/high)로 적용 · Gemini 2.5 는 동적 사고(effort 티어 세분화는 후속) · 그 외 모델은 미전송. thinking 활성 시 답변 토큰 예산을 자동 상향(굶음 방지)합니다.'}
```

(i) 등록 버튼 비활성 검증(line 329) — compatible 은 baseUrl·model 필수:

```typescript
        <button
          className="btn"
          style={{ marginTop: 14 }}
          onClick={registerApi}
          disabled={busy || !apiKey.trim() || (provider === 'openai-compatible' && (!baseUrl.trim() || !model.trim()))}
        >
          API 세션 등록
        </button>
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx -t "openai-compatible"`
Expected: PASS (2 tests)

- [ ] **Step 5: 전체 게이트(SessionsPanel 전체 + typecheck + lint)**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx && npm run typecheck && npm run lint`
Expected: 전부 PASS / 무출력 (기존 SessionsPanel 테스트 회귀 없음)

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/components/SessionsPanel.tsx src/renderer/components/SessionsPanel.test.tsx
git commit -m "feat(ui): SessionsPanel openai-compatible 옵션+baseUrl 입력+thinking (#27)"
```

---

## Task 6: 전체 게이트 + PR

- [ ] **Step 1: 4 게이트 전체 실행**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 전부 녹색. `npm test` 의 총 테스트 수가 +8 내외(providers 6 + SessionsPanel 2) 증가.

- [ ] **Step 2: PR 생성(머지는 Codex 리뷰 후 — `merge-requires-confirmation`)**

```bash
git push -u origin feat/openai-compatible-provider
gh pr create --repo pdw96/fleet --base master --title "feat(provider): OpenAI-compatible provider (OpenRouter·vLLM 등 200+ 모델)" --body-file -
```
PR 본문: 무엇/왜(모델폭 해금·cutoff-gap·hermes 교집합)/reasoning 패스스루 근거(4출처 검증)/TDD·4게이트. 끝에 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-Review (작성자 체크)

- **Spec coverage**: 타입(T1)·provider 엔드포인트+token(T2)·reasoning 패스스루+다운매핑(T3)·400 가드(T4)·UI 전체(T5) — 스펙 설계 1~4 + 데이터흐름 + 테스트 전부 태스크에 매핑. 비범위(reasoning 출력 캡처·nested reasoning·OpenRouter 헤더·API키 영속)는 의도적 제외.
- **Placeholder scan**: 모든 코드 스텝에 완전한 코드·정확한 파일/라인·실행 명령·기대 출력. TBD 없음.
- **Type consistency**: `provider:'openai-compatible'`·`baseUrl`·`requireBaseUrl`·`compatible`·`sendWithReasoningFallback`·`normalizeBaseUrl(인라인)`·`thinkingSupported` 명칭이 전 태스크 일관. `createOpenAiProvider` 반환 `provider: config.provider` 가 registry 라우팅 테스트(T1)와 정합.
- **순서 안전**: T1 이 유니온 추가의 컴파일-강제 지점(registry `never`·PROVIDER_DEFAULTS Record)을 동시 처리 → 매 태스크 typecheck 녹색.

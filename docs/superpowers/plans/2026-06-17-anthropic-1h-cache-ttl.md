# Anthropic 확장 캐시 TTL 1h (#72) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anthropic provider 에 세션 opt-in 캐시 TTL 노브를 추가해, 사용자가 5m 초과 tail 경로에서 `cache_control.ttl:'1h'` + `extended-cache-ttl-2025-04-11` 베타 헤더를 켤 수 있게 한다(기본 5m 무회귀).

**Architecture:** `thinking` 노브와 동일 패턴 — `ApiProviderConfig.cacheTtl`(세션 기본값·영속) + `ApiCallOptions.cacheTtl`(per-call override), provider 가 `opts.cacheTtl ?? config.cacheTtl` 로 폴백. config 통째 영속(`PersistedApiSession.config`)이라 store/IPC/preload/engine 무변경. SessionsPanel 에 anthropic-한정 UI.

**Tech Stack:** TypeScript, Electron, React, Vitest, ESLint(typed). 4게이트: `npm run typecheck` · `npm run lint` · `npm run test` · `npm run build`.

## Global Constraints

- **무회귀(byte-동일)**: `cacheTtl` 미지정/`'5m'` 경로는 현행 요청 바디·헤더와 byte-동일. 1h 는 `cacheable`(멀티턴 또는 도구 동봉)일 때만 wire 에 반영.
- **타입 안전**: `CacheTtl = '5m' | '1h'` 유니온 — 무효값 컴파일 차단.
- **무변경 시그니처**: store/types.ts, preload, IPC, engine 의 시그니처를 바꾸지 않는다(config 통째 패스로 자동 영속).
- **Anthropic 한정**: OpenAI/Gemini 노브 비구현(별도 백로그 이슈). UI 컨트롤은 `provider==='anthropic'` 일 때만 노출.
- **베타 헤더 토큰명**: `extended-cache-ttl-2025-04-11` (context7 검증). CM 토큰 `context-management-2025-06-27` 과 쉼표 결합 공존.
- **커밋 트레일러**: 각 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- `src/shared/types.ts` — `CacheTtl` 타입 + `ApiProviderConfig.cacheTtl` 추가 (Task 1).
- `src/main/core/providers/types.ts` — `ApiCallOptions.cacheTtl` 추가 (Task 1).
- `src/main/core/providers/anthropic.ts` — `cache_control.ttl` 분기 + 베타 헤더 누적 (Task 1).
- `src/main/core/providers/providers.test.ts` — provider 테스트 5건 (Task 1).
- `src/renderer/components/SessionsPanel.tsx` — anthropic-한정 캐시 TTL 셀렉트 + config 빌드 (Task 2).
- `src/renderer/components/SessionsPanel.test.tsx` — UI 테스트 2건 (Task 2).

---

## Task 1: Anthropic provider — cacheTtl 노브 + 와이어 동작

**Files:**
- Modify: `src/shared/types.ts` (ReasoningEffort 인근 ~156, ApiProviderConfig.thinking 인근 ~173)
- Modify: `src/main/core/providers/types.ts:1` (import), `:168-173` (ApiCallOptions)
- Modify: `src/main/core/providers/anthropic.ts:284-286` (cache_control), `:330-336` (headers)
- Test: `src/main/core/providers/providers.test.ts` (AnthropicProvider describe 블록 내 추가)

**Interfaces:**
- Produces: `export type CacheTtl = '5m' | '1h'` (shared/types.ts); `ApiProviderConfig.cacheTtl?: CacheTtl`; `ApiCallOptions.cacheTtl?: CacheTtl`. provider 동작: cacheable + `(opts.cacheTtl ?? config.cacheTtl)==='1h'` → body.cache_control=`{type:'ephemeral',ttl:'1h'}` 및 headers['anthropic-beta'] 에 `extended-cache-ttl-2025-04-11` 누적.
- Consumes: 없음(기존 `cacheable` 조건·CM 헤더 로직 위 증분).

- [ ] **Step 1: 실패하는 provider 테스트 5건 작성**

`src/main/core/providers/providers.test.ts` 의 `describe('AnthropicProvider', ...)` 블록 안(기존 캐시 테스트 `:127` 근처 뒤)에 추가:

```ts
it('config.cacheTtl=1h + 도구 동봉 → cache_control.ttl=1h + extended-cache 베타 헤더 (#72)', async () => {
  const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
  const p = createAnthropicProvider({ ...baseAnthropic, cacheTtl: '1h' }, http)
  await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 't', parameters: { type: 'object' } }] })
  const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
  expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(String(calls[0].init.headers['anthropic-beta'])).toContain('extended-cache-ttl-2025-04-11')
})

it('cacheTtl=1h + contextManagement → anthropic-beta 에 두 토큰 공존 (#72)', async () => {
  const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
  const p = createAnthropicProvider({ ...baseAnthropic, cacheTtl: '1h' }, http)
  // 멀티턴(cacheable) + CM 동봉 → cache_control(1h) 와 CM 헤더 동시 존재.
  await p.chat(
    [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ],
    { contextManagement: { triggerInputTokens: 150000, keepRecentToolUses: 3 } },
  )
  const betas = String(calls[0].init.headers['anthropic-beta']).split(',')
  expect(betas).toContain('context-management-2025-06-27')
  expect(betas).toContain('extended-cache-ttl-2025-04-11')
})

it('cacheTtl=1h 라도 fresh 단발(비-cacheable)엔 cache_control·extended-cache 베타 부재 (#72)', async () => {
  const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
  const p = createAnthropicProvider({ ...baseAnthropic, cacheTtl: '1h' }, http)
  await p.chat([
    { role: 'system', content: '너는 평가자다' },
    { role: 'user', content: 'q' },
  ])
  const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
  expect(body.cache_control).toBeUndefined()
  expect(calls[0].init.headers['anthropic-beta']).toBeUndefined()
})

it('per-call opts.cacheTtl=1h 가 config 미지정을 덮어 1h 경로를 켠다 (#72 override)', async () => {
  const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
  const p = createAnthropicProvider(baseAnthropic, http)
  await p.chat([{ role: 'user', content: 'q' }], {
    tools: [{ name: 't', parameters: { type: 'object' } }],
    cacheTtl: '1h',
  })
  const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
  expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(String(calls[0].init.headers['anthropic-beta'])).toContain('extended-cache-ttl-2025-04-11')
})

it('cacheTtl 미지정(기본) cacheable → cache_control=ephemeral(ttl 없음)·extended-cache 베타 부재 (#72 무회귀)', async () => {
  const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
  const p = createAnthropicProvider(baseAnthropic, http)
  await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 't', parameters: { type: 'object' } }] })
  const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
  expect(body.cache_control).toEqual({ type: 'ephemeral' })
  const beta = calls[0].init.headers['anthropic-beta']
  if (beta !== undefined) expect(String(beta)).not.toContain('extended-cache-ttl')
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts`
Expected: 처음 4개 신규 테스트 FAIL (cache_control 에 ttl 없음·베타 헤더 부재). 5번째(무회귀)는 현행 동작과 일치해 PASS 가능. 타입 에러로 `cacheTtl` 미인식 가능 — Step 3 에서 타입 추가로 해소.

- [ ] **Step 3: 타입 추가 — `CacheTtl` + config/opts 필드**

`src/shared/types.ts` 의 `ReasoningEffort` 정의(~156) 바로 아래에 추가:

```ts
/** 프롬프트 캐시 TTL. Anthropic cache_control.ttl 매핑('1h'=extended-cache-ttl 베타). 미지정/기본=5m. */
export type CacheTtl = '5m' | '1h'
```

같은 파일 `ApiProviderConfig` 의 `thinking?: { effort?: ReasoningEffort }`(~173) 바로 아래에 추가:

```ts
  /**
   * 프롬프트 캐시 TTL 세션 기본값(Anthropic 한정). '1h' 면 재사용 프리픽스 cache_control 에 ttl:'1h' +
   * extended-cache-ttl 베타를 싣는다(per-call ApiCallOptions.cacheTtl 우선). 미지정=5m(현행). #72.
   */
  cacheTtl?: CacheTtl
```

`src/main/core/providers/types.ts:1` import 에 `CacheTtl` 추가:

```ts
import type { ApiProviderConfig, CacheTtl, ReasoningEffort, ToolStep } from '../../../shared/types'
```

같은 파일 `ApiCallOptions` 의 `contextManagement?` 필드(~173) 바로 위(또는 thinking 인근)에 추가:

```ts
  /**
   * 프롬프트 캐시 TTL per-call override(Anthropic). 미지정이면 config.cacheTtl 로 폴백(thinking 관용구).
   * '1h' 는 cacheable(재사용 프리픽스) 경로에서만 wire 에 반영된다. #72.
   */
  cacheTtl?: CacheTtl
```

- [ ] **Step 4: anthropic.ts — cache_control ttl 분기 + 베타 헤더 누적**

`src/main/core/providers/anthropic.ts:284-286` 의 cache_control 블록을 교체:

```ts
      // 프롬프트 캐시: cacheable(재사용 프리픽스) 경로에서만 분기점을 둔다. cacheTtl='1h'(세션/per-call opt-in)
      // 면 ttl:'1h' + extended-cache 베타로 5m 초과 tail(긴 빌드·느린 MCP)의 히트를 유지(쓰기 2× → 기본은 5m).
      const cacheable = turns.length > 1 || (opts.tools?.length ?? 0) > 0
      const oneHourCache = cacheable && (opts.cacheTtl ?? config.cacheTtl) === '1h'
      if (cacheable) {
        body.cache_control = oneHourCache ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
      }
```

같은 파일 `:335-336` 의 단일 베타 할당을 누적 방식으로 교체:

```ts
      // beta 헤더 누적: CM·extended-cache-ttl 공존(쉼표 결합). 둘 다 없으면 헤더 부재(무회귀).
      const betas: string[] = []
      if (opts.contextManagement) betas.push('context-management-2025-06-27')
      if (oneHourCache) betas.push('extended-cache-ttl-2025-04-11')
      if (betas.length) headers['anthropic-beta'] = betas.join(',')
```

(`removeCM` 의 `delete headers['anthropic-beta']`(~344)는 그대로 둔다 — 400 격리 시 CM·캐시 베타 모두 제거되며, extended-cache 는 400 유발 필드가 아니라 재시도 후에도 cache_control 자체는 body 에 남는다. 무영향.)

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts`
Expected: 신규 5건 + 기존 캐시/CM 테스트(`:101`,`:116`,`:127`,`:580`,`:595`) 전부 PASS.

- [ ] **Step 6: 4게이트 + 커밋**

Run: `npm run typecheck && npm run lint && npx vitest run src/main/core/providers/providers.test.ts`
Expected: 모두 green.

```bash
git add src/shared/types.ts src/main/core/providers/types.ts src/main/core/providers/anthropic.ts src/main/core/providers/providers.test.ts
git commit -m "feat(provider): Anthropic 확장 캐시 TTL 1h 노브 (#72)

cache_control.ttl='1h' + extended-cache-ttl-2025-04-11 베타(조건부 opt-in).
CacheTtl 타입 + ApiProviderConfig.cacheTtl(세션 기본) + ApiCallOptions.cacheTtl
(per-call), provider 가 opts.cacheTtl ?? config.cacheTtl 폴백. cacheable 일 때만
1h 반영·베타 헤더 누적(CM 공존). 기본/5m 경로 byte-동일 무회귀.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SessionsPanel — anthropic-한정 캐시 TTL UI

**Files:**
- Modify: `src/renderer/components/SessionsPanel.tsx` (state ~44, config 빌드 ~178-187, 렌더 thinking 컨트롤 인근 ~316-343)
- Test: `src/renderer/components/SessionsPanel.test.tsx` (describe('SessionsPanel') 내 추가)

**Interfaces:**
- Consumes: `ApiProviderConfig.cacheTtl`(Task 1). config 객체에 `cacheTtl:'1h'` 를 anthropic·선택 시에만 포함.
- Produces: anthropic 에서 라벨 `캐시 TTL` 셀렉트(id `api-cache-ttl`); 선택 '1h' → `registerApiSession` config 에 `cacheTtl:'1h'` + displayName 에 `cache:1h`.

- [ ] **Step 1: 실패하는 UI 테스트 2건 작성**

`src/renderer/components/SessionsPanel.test.tsx` 의 `describe('SessionsPanel', ...)` 안에 추가:

```ts
it('anthropic 에서 캐시 TTL 1h 선택 → registerApiSession config 에 cacheTtl 가 실린다 (#72)', async () => {
  const fleet = mockFleet()
  render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

  fireEvent.change(screen.getByLabelText(/캐시 TTL/i), { target: { value: '1h' } })
  fireEvent.change(screen.getByPlaceholderText('sk-...'), { target: { value: 'key-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'API 세션 등록' }))

  await waitFor(() => expect(fleet.registerApiSession).toHaveBeenCalled())
  const cfg = (fleet.registerApiSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>
  expect(cfg.provider).toBe('anthropic')
  expect(cfg.cacheTtl).toBe('1h')
  expect(String(cfg.displayName)).toContain('cache:1h')
})

it('비-anthropic provider 에는 캐시 TTL 컨트롤이 노출되지 않는다 (#72 anthropic 한정)', async () => {
  mockFleet()
  render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
  // anthropic(기본)에는 노출
  expect(screen.getByLabelText(/캐시 TTL/i)).toBeTruthy()
  // openai 로 전환하면 비노출
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } })
  expect(screen.queryByLabelText(/캐시 TTL/i)).toBeNull()
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx`
Expected: 두 신규 테스트 FAIL (`/캐시 TTL/i` 라벨 부재 → getByLabelText throw).

- [ ] **Step 3: state 추가**

`src/renderer/components/SessionsPanel.tsx` 의 `const [effort, setEffort] = useState<'' | ReasoningEffort>('')`(~44) 바로 아래에 추가:

```tsx
  // 캐시 TTL 세션 기본값(Anthropic 한정). '' = 기본(5m), '1h' = extended-cache. #72.
  const [cacheTtl, setCacheTtl] = useState<'' | '1h'>('')
```

- [ ] **Step 4: config 빌드에 cacheTtl 반영**

`src/renderer/components/SessionsPanel.tsx` 의 `const thinkingOn = thinkingSupported && effort !== ''`(~178) 아래에 추가하고, config 객체·displayName 을 확장:

```tsx
      const thinkingOn = thinkingSupported && effort !== ''
      const cacheOn = provider === 'anthropic' && cacheTtl === '1h'
      const config: ApiProviderConfig = {
        id: `${provider}-${Date.now()}`,
        provider,
        displayName: `${provider} (${model}${thinkingOn ? `, thinking:${effort}` : ''}${cacheOn ? ', cache:1h' : ''})`,
        model,
        apiKey: apiKey.trim(),
        ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
        ...(thinkingOn ? { thinking: { effort } } : {}),
        ...(cacheOn ? { cacheTtl: '1h' } : {}),
      }
```

- [ ] **Step 5: 렌더 — anthropic-한정 캐시 TTL 셀렉트**

`src/renderer/components/SessionsPanel.tsx` 의 thinking effort 컨트롤 블록(`{thinkingSupported && ( ... )}`, ~316-343) **바로 뒤**에 추가:

```tsx
        {provider === 'anthropic' && (
          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="api-cache-ttl">
              캐시 TTL (선택)
            </label>
            <select
              id="api-cache-ttl"
              className="field"
              value={cacheTtl}
              onChange={(e) => setCacheTtl(e.target.value as '' | '1h')}
            >
              <option value="">기본 (5분)</option>
              <option value="1h">1시간 (extended-cache)</option>
            </select>
            <p className="field-help">
              5분을 초과해 같은 프리픽스가 재전송되는 tail 경로(긴 빌드·느린 MCP 도구 루프)에서만 이득입니다.
              1시간 캐시 쓰기는 비용이 약 2배라 평소엔 기본(5분)을 권장합니다.
            </p>
          </div>
        )}
```

(주: `field-help`/`field-label`/`field` 클래스는 기존 thinking 블록과 동일 — 클래스명이 다르면 인근 thinking 블록의 실제 클래스에 맞춘다.)

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx vitest run src/renderer/components/SessionsPanel.test.tsx`
Expected: 신규 2건 + 기존 SessionsPanel 테스트 전부 PASS.

- [ ] **Step 7: 전체 4게이트 + 커밋**

Run: `npm run typecheck && npm run lint && npm run test && npm run build`
Expected: 모두 green.

```bash
git add src/renderer/components/SessionsPanel.tsx src/renderer/components/SessionsPanel.test.tsx
git commit -m "feat(renderer): SessionsPanel Anthropic 캐시 TTL 1h 토글 (#72)

provider==='anthropic' 일 때만 '캐시 TTL' 셀렉트 노출(OpenAI 자동·Gemini 묵시는
노브 무의미). '1h' 선택 시 config.cacheTtl='1h' + displayName cache:1h.
헬프텍스트로 tail-한정 이득·1h 쓰기 2× 비용 안내.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- 와이어 동작(cache_control.ttl + 베타 누적) → Task 1 Step 4 ✓
- 타입(CacheTtl·config·opts) → Task 1 Step 3 ✓
- UI anthropic-한정 → Task 2 ✓
- 영속/IPC 무변경 → 설계상 변경 없음(config 통째 패스) ✓
- 테스트 7건(provider 5 + UI 2) + 기존 무회귀 단언 유지 → Task 1 Step 1·Task 2 Step 1 ✓
- 완료조건 4게이트 → Task 2 Step 7 ✓
- OpenAI/Gemini 상이슈 등록 → 본 plan 범위 밖(머지-동기화 단계, 별도 처리) ✓ (spec 비목표에 명시)

**2. Placeholder scan:** 모든 step 에 실제 코드·명령·기대출력 포함. TODO/TBD 없음 ✓

**3. Type consistency:** `CacheTtl`('5m'|'1h') 일관. `cacheTtl` 필드명 config/opts/provider/UI 전부 동일. UI state 는 `'' | '1h'`(5m 은 '' 로 표현, byte-동일 위해 5m 명시 미전송) — config 의 `cacheTtl?: CacheTtl` 에 '1h' 리터럴만 할당하므로 타입 호환 ✓

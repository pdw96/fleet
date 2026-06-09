# Provider 구조화 출력 (structured output) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 오케스트레이터 planner/reviewer 의 LLM 출력 파싱을 세 provider 네이티브 구조화 출력으로 강제하되, CLI·구형 모델용 관대한 폴백 파서를 병존시켜 회귀 없이 신뢰도를 올린다.

**Architecture:** `ApiCallOptions.responseSchema` 옵션을 `SendOptions`→`createApiSession.send()`→provider 로 관통시킨다. provider 는 네이티브 필드(anthropic `output_config.format` · openai `response_format` · google `responseSchema`)를 싣고, 미지원 모델 400 시 스키마 없이 1회 재시도(graceful degradation). 소비처는 strict `JSON.parse` 우선 + 기존 정규식/토큰 폴백.

**Tech Stack:** TypeScript, vitest, raw HTTP(주입형 `HttpClient`), Electron 비의존 순수 코어.

**작업 브랜치:** `feat/provider-structured-output` (이미 생성·설계 spec 커밋됨).

**참조 spec:** `docs/superpowers/specs/2026-06-09-structured-output-design.md`

**품질 게이트(작업 후 반드시):** `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

---

## 파일 구조 (변경 지도)

- `src/main/core/providers/types.ts` — `ApiCallOptions.responseSchema` 필드 + `sendWithSchemaFallback` 헬퍼.
- `src/main/core/providers/anthropic.ts` — `output_config.format` 매핑 + 400 degradation.
- `src/main/core/providers/openai.ts` — `response_format(json_schema, strict)` 매핑 + 400 degradation.
- `src/main/core/providers/google.ts` — `responseMimeType`+`responseSchema` 매핑 + 400 degradation.
- `src/main/core/providers/providers.test.ts` — 헬퍼 + provider별 매핑/degradation 테스트.
- `src/main/core/session/types.ts` — `SendOptions.responseSchema`.
- `src/main/core/session/api-session.ts` — `send()` 가 `responseSchema` 를 `callOpts` 로 전달.
- `src/main/core/session/session.test.ts` — 전달 테스트.
- `src/main/core/orchestrator/plan.ts` — `PLANNER_SCHEMA`·프롬프트·`parsePlannedTasks`·`planTasks`.
- `src/main/core/orchestrator/plan.test.ts` — 파서/프롬프트 테스트.
- `src/main/core/orchestrator/review.ts` — `REVIEW_SCHEMA`·프롬프트·`parseReviewVerdict`.
- `src/main/core/orchestrator/review.test.ts` — 파서/프롬프트 테스트.
- `src/main/core/orchestrator/orchestrator.ts` — reviewer 호출에 `responseSchema` 전달.

---

## Task 1: `responseSchema` 옵션 + `sendWithSchemaFallback` 헬퍼

**Files:**
- Modify: `src/main/core/providers/types.ts`
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `providers.test.ts` 최상단 import 에 헬퍼를 추가하고, 파일 끝에 describe 추가.

import 라인(파일 상단 `import { ... } from './types'`)에 `sendWithSchemaFallback` 추가:
```ts
import { ApiProviderError, sendWithSchemaFallback, type HttpClient, type HttpInit, type HttpResponse } from './types'
```

파일 맨 끝에 추가:
```ts
describe('sendWithSchemaFallback', () => {
  const ok = (): HttpResponse => ({ ok: true, status: 200, text: async () => 'ok' })
  const bad400 = (): HttpResponse => ({ ok: false, status: 400, text: async () => 'unsupported' })

  it('성공(200)이면 재시도 없이 그대로 반환', async () => {
    let n = 0
    const res = await sendWithSchemaFallback(async () => { n++; return ok() }, true, () => { throw new Error('strip 호출 금지') })
    expect(res.status).toBe(200)
    expect(n).toBe(1)
  })

  it('스키마 있고 400 이면 stripSchema 후 1회 재시도', async () => {
    let n = 0
    let stripped = false
    const res = await sendWithSchemaFallback(
      async () => { n++; return n === 1 ? bad400() : ok() },
      true,
      () => { stripped = true },
    )
    expect(stripped).toBe(true)
    expect(n).toBe(2)
    expect(res.status).toBe(200)
  })

  it('스키마 없으면 400 이라도 재시도하지 않는다', async () => {
    let n = 0
    const res = await sendWithSchemaFallback(async () => { n++; return bad400() }, false, () => { throw new Error('strip 금지') })
    expect(n).toBe(1)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t sendWithSchemaFallback`
Expected: FAIL — `sendWithSchemaFallback` 가 export 되지 않음(타입/런타임 에러).

- [ ] **Step 3: 최소 구현** — `types.ts` 의 `ApiCallOptions` 인터페이스에 필드 추가. `onToolStep?` 항목 바로 뒤(인터페이스 닫는 `}` 직전)에:
```ts
  /**
   * 응답을 JSON 스키마로 강제(네이티브 구조화 출력). 지정 시 provider 는 네이티브 필드를 싣고
   * text 는 마크다운/산문 없는 JSON 문자열이 된다. 미지원 모델(400)은 스키마 없이 1회 재시도한다.
   */
  responseSchema?: { name: string; schema: Record<string, unknown> }
```

그리고 `types.ts` 파일 끝(맨 아래 `requireApiKey` 함수 뒤)에 헬퍼 추가:
```ts
/**
 * 비스트리밍 요청을 구조화-출력 400 graceful degradation 으로 감싼다.
 * send() 가 400 을 반환하고 스키마가 있었으면 stripSchema() 로 스키마 필드를 제거한 뒤 1회 재시도한다.
 * (구형 모델이 구조화-출력 필드를 거부해도 폴백 파싱으로 계속 동작하게 — 회귀 차단.)
 */
export async function sendWithSchemaFallback(
  send: () => Promise<HttpResponse>,
  hasSchema: boolean,
  stripSchema: () => void,
): Promise<HttpResponse> {
  const res = await send()
  if (!hasSchema || res.ok || res.status !== 400) return res
  stripSchema()
  return send()
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t sendWithSchemaFallback`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/types.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): responseSchema 옵션 + sendWithSchemaFallback 헬퍼

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: anthropic — `output_config.format` 매핑 + degradation

**Files:**
- Modify: `src/main/core/providers/anthropic.ts`
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `providers.test.ts` 의 `describe('AnthropicProvider', ...)` 블록 안(마지막 `it` 뒤)에 추가:
```ts
  it('responseSchema → output_config.format(json_schema) 를 body 에 싣는다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'verdict', schema } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } })
  })

  it('구조화-출력 400 → output_config 없이 1회 재시도(graceful degradation)', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'unsupported field output_config' }
        : { body: JSON.stringify({ content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn' }) }
    })
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: {} }
    const out = await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema } })
    expect(calls).toHaveLength(2)
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).output_config).toBeDefined()
    expect((JSON.parse(calls[1].init.body) as Record<string, unknown>).output_config).toBeUndefined()
    expect(out.text).toBe('[]')
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t AnthropicProvider`
Expected: FAIL — output_config 미설정 / 400 에서 throw.

- [ ] **Step 3: 최소 구현** — `anthropic.ts` `chat()` 안. 먼저 `output_config` 추가: `tools` 블록(`if (opts.tools?.length) { ... }`) **바로 뒤**, `const streaming = ...` **앞**에:
```ts
      if (opts.responseSchema) {
        body.output_config = { format: { type: 'json_schema', schema: opts.responseSchema.schema } }
      }
```

그리고 HTTP 호출부를 degradation 으로 감싼다. 기존:
```ts
      const res = await http(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })
```
를 다음으로 교체:
```ts
      const headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      }
      const send = (): Promise<HttpResponse> =>
        http(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      const res = streaming
        ? await send()
        : await sendWithSchemaFallback(send, !!opts.responseSchema, () => { delete body.output_config })
```
import 에 `HttpResponse`·`sendWithSchemaFallback` 추가(파일 상단 `} from './types'` 블록):
```ts
  ApiProviderError,
  defaultHttp,
  requireApiKey,
  sendWithSchemaFallback,
  textOf,
  type ApiCallOptions,
  type ApiProvider,
  type ChatResult,
  type ChatTurn,
  type ContentBlock,
  type FinishReason,
  type HttpClient,
  type HttpResponse,
  type ToolUseBlock,
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t AnthropicProvider`
Expected: PASS (모든 anthropic 테스트)

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/anthropic.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): anthropic 네이티브 구조화 출력 + 400 degradation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: openai — `response_format(json_schema, strict)` 매핑 + degradation

**Files:**
- Modify: `src/main/core/providers/openai.ts`
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `describe('OpenAiProvider', ...)` 블록 안 마지막 `it` 뒤에 추가:
```ts
  it('responseSchema → response_format(json_schema, strict) 를 body 에 싣는다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }) }))
    const p = createOpenAiProvider(baseOpenai, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'verdict', schema } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'verdict', schema, strict: true } })
  })

  it('구조화-출력 400 → response_format 없이 1회 재시도', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'response_format json_schema not supported' }
        : { body: JSON.stringify({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] }) }
    })
    const p = createOpenAiProvider(baseOpenai, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema: { type: 'object' } } })
    expect(calls).toHaveLength(2)
    expect((JSON.parse(calls[0].init.body) as Record<string, unknown>).response_format).toBeDefined()
    expect((JSON.parse(calls[1].init.body) as Record<string, unknown>).response_format).toBeUndefined()
    expect(out.text).toBe('[]')
  })
```

`baseOpenai` 상수가 파일에 없으면 `baseAnthropic` 근처에 추가(이미 OpenAi 테스트가 있으면 기존 상수 재사용 — 파일에서 `createOpenAiProvider(` 호출 시 쓰는 config 변수명을 확인해 그대로 사용). 없을 경우 추가:
```ts
const baseOpenai: ApiProviderConfig = {
  id: 'o1', provider: 'openai', displayName: 'GPT', model: 'gpt-4o', apiKey: 'key-o', maxTokens: 256,
}
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t OpenAiProvider`
Expected: FAIL.

- [ ] **Step 3: 최소 구현** — `openai.ts` `chat()` 안. `tools` 블록 뒤, `const streaming = ...` 앞에:
```ts
      if (opts.responseSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: opts.responseSchema.name, schema: opts.responseSchema.schema, strict: true },
        }
      }
```
HTTP 호출부 교체. 기존:
```ts
      const res = await http(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })
```
→
```ts
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
      const send = (): Promise<HttpResponse> =>
        http(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      const res = streaming
        ? await send()
        : await sendWithSchemaFallback(send, !!opts.responseSchema, () => { delete body.response_format })
```
import 에 `sendWithSchemaFallback`·`type HttpResponse` 추가(`} from './types'` 블록, 알파벳 순 적절 위치).

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t OpenAiProvider`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/openai.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): openai 네이티브 구조화 출력 + 400 degradation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: google — `responseMimeType`+`responseSchema` 매핑 + degradation

**Files:**
- Modify: `src/main/core/providers/google.ts`
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `describe('GoogleProvider', ...)` 블록 안 마지막 `it` 뒤:
```ts
  it('responseSchema → generationConfig.responseSchema + responseMimeType 를 싣는다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }) }))
    const p = createGoogleProvider(baseGoogle, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'verdict', schema } })
    const body = JSON.parse(calls[0].init.body) as { generationConfig?: Record<string, unknown> }
    expect(body.generationConfig?.responseMimeType).toBe('application/json')
    expect(body.generationConfig?.responseSchema).toEqual(schema)
  })

  it('구조화-출력 400 → responseSchema/responseMimeType 없이 1회 재시도', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'responseSchema unsupported' }
        : { body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '[]' }] }, finishReason: 'STOP' }] }) }
    })
    const p = createGoogleProvider(baseGoogle, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema: { type: 'object' } } })
    expect(calls).toHaveLength(2)
    const b1 = JSON.parse(calls[1].init.body) as { generationConfig?: Record<string, unknown> }
    expect(b1.generationConfig?.responseSchema).toBeUndefined()
    expect(b1.generationConfig?.responseMimeType).toBeUndefined()
    expect(out.text).toBe('[]')
  })
```

`baseGoogle` 상수가 없으면 추가(기존 Google 테스트의 config 변수 확인 후 재사용):
```ts
const baseGoogle: ApiProviderConfig = {
  id: 'g1', provider: 'google', displayName: 'Gemini', model: 'gemini-2.5-pro', apiKey: 'key-g', maxTokens: 256,
}
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t GoogleProvider`
Expected: FAIL.

- [ ] **Step 3: 최소 구현** — `google.ts` `chat()` 안. `generationConfig` 를 만드는 부분 뒤(`if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens` 다음), `body` 조립 전에:
```ts
      if (opts.responseSchema) {
        generationConfig.responseMimeType = 'application/json'
        generationConfig.responseSchema = opts.responseSchema.schema
      }
```
(이렇게 하면 그 아래 `if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig` 가 자동으로 첨부한다.)

HTTP 호출부 교체. 기존:
```ts
      const res = await http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: opts.signal,
      })
```
→
```ts
      const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey }
      const send = (): Promise<HttpResponse> =>
        http(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      const res = streaming
        ? await send()
        : await sendWithSchemaFallback(send, !!opts.responseSchema, () => {
            const gc = body.generationConfig as Record<string, unknown> | undefined
            if (gc) {
              delete gc.responseMimeType
              delete gc.responseSchema
              if (Object.keys(gc).length === 0) delete body.generationConfig
            }
          })
```
import 에 `sendWithSchemaFallback`·`type HttpResponse` 추가.

주의: `streaming` 과 `url`/`method` 는 이 교체부보다 위에서 이미 계산됨(기존 코드 순서 유지) — `const streaming = !!opts.onToken` 와 `const url = ...` 가 호출부 앞에 있는지 확인.

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t GoogleProvider`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/google.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): google 네이티브 구조화 출력 + 400 degradation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `SendOptions.responseSchema` + api-session 전달

**Files:**
- Modify: `src/main/core/session/types.ts`, `src/main/core/session/api-session.ts`
- Test: `src/main/core/session/session.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `session.test.ts` 상단 import 의 `import type { ApiProvider, ChatTurn } from '../providers/types'` 를 다음으로 변경:
```ts
import type { ApiCallOptions, ApiProvider, ChatTurn } from '../providers/types'
```
`describe('createApiSession', ...)` 블록 안에 추가:
```ts
  it('send 의 responseSchema 를 provider 로 전달한다(구조화 출력)', async () => {
    let seenOpts: ApiCallOptions | undefined
    const provider: ApiProvider = {
      id: 'fake', provider: 'anthropic', model: 'm',
      async chat(_messages, opts) {
        seenOpts = opts
        return { text: '{}', toolCalls: [], finishReason: 'stop' }
      },
    }
    const s = createApiSession(apiDesc, provider)
    const schema = { type: 'object', additionalProperties: false, properties: {} }
    await s.send('x', { responseSchema: { name: 'v', schema } })
    expect(seenOpts?.responseSchema).toEqual({ name: 'v', schema })
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/session/session.test.ts -t responseSchema`
Expected: FAIL — `SendOptions` 에 `responseSchema` 가 없어 타입 에러 + 전달 안 됨.

- [ ] **Step 3: 최소 구현**

`session/types.ts` 의 `SendOptions` 인터페이스에 추가(`timeoutMs?` 뒤, 닫는 `}` 직전):
```ts
  /** 응답을 JSON 스키마로 강제(네이티브 구조화 출력). API 세션만 적용; CLI 세션은 무시. */
  responseSchema?: { name: string; schema: Record<string, unknown> }
```

`api-session.ts` 의 `callOpts` 조립부를 수정. 기존:
```ts
      const callOpts: ApiCallOptions = { signal: sendOpts.signal, onToken, onToolStep: sendOpts.onToolStep }
```
→
```ts
      const callOpts: ApiCallOptions = {
        signal: sendOpts.signal,
        onToken,
        onToolStep: sendOpts.onToolStep,
        responseSchema: sendOpts.responseSchema,
      }
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/session/session.test.ts`
Expected: PASS (신규 + 기존 모두).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/session/types.ts src/main/core/session/api-session.ts src/main/core/session/session.test.ts
git commit -m "feat(session): SendOptions.responseSchema 를 provider 로 전달

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: plan.ts — 스키마·프롬프트·`parsePlannedTasks`·`planTasks`

**Files:**
- Modify: `src/main/core/orchestrator/plan.ts`
- Test: `src/main/core/orchestrator/plan.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `plan.test.ts` 의 `describe('parsePlannedTasks', ...)` 안에 추가:
```ts
  it('구조화 출력 객체 {tasks:[...]} 를 파싱한다', () => {
    const tasks = parsePlannedTasks('{"tasks":[{"title":"T","description":"D","role":"tester"}]}')
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('T')
    expect(tasks[0].role).toBe('tester')
  })

  it('산문에 둘러싸인 {tasks:[...]} 도 폴백으로 파싱한다', () => {
    const tasks = parsePlannedTasks('계획: {"tasks":[{"title":"A","description":"d"}]} 이상')
    expect(tasks[0].title).toBe('A')
  })

  it('기존 bare 배열 입력은 그대로 파싱한다(회귀)', () => {
    const tasks = parsePlannedTasks('[{"title":"B","description":"d"}]')
    expect(tasks[0].title).toBe('B')
  })
```
`describe('buildPlannerPrompt', ...)` 안에 추가:
```ts
  it('tasks 키를 가진 JSON 객체 형태를 요청한다', () => {
    expect(buildPlannerPrompt('목표')).toContain('tasks')
  })
```

`plan.test.ts` 상단 import 에 `PLANNER_SCHEMA` 를 추가하고 그 형태를 검증하는 테스트도 추가:
```ts
import { buildPlannerPrompt, extractJsonArray, parsePlannedTasks, planTasks, PLANNER_SCHEMA } from './plan'
```
파일 끝에:
```ts
describe('PLANNER_SCHEMA', () => {
  it('루트는 object 이고 tasks 배열을 가진다(OpenAI strict 호환)', () => {
    expect(PLANNER_SCHEMA.type).toBe('object')
    expect((PLANNER_SCHEMA.properties as Record<string, { type?: string }>).tasks.type).toBe('array')
    expect(PLANNER_SCHEMA.additionalProperties).toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/orchestrator/plan.test.ts`
Expected: FAIL — `PLANNER_SCHEMA` 미정의, 프롬프트에 'tasks' 없음, `{tasks}` 미파싱.

- [ ] **Step 3: 최소 구현** — `plan.ts` 수정.

`buildPlannerPrompt` 교체:
```ts
/** 목표 분해를 요청하는 자기완결적 프롬프트 (CLI/API 세션 공통, system 비의존). */
export function buildPlannerPrompt(goal: string): string {
  return [
    '너는 소프트웨어 프로젝트 플래너다. 아래 목표를 실행 가능한 4~8개의 작업으로 분해하라.',
    '반드시 아래 형식의 JSON 객체만 출력하라(설명/마크다운 금지):',
    '{"tasks":[{"title":"작업명","description":"무엇을 어떻게","role":"architect|implementer|reviewer|tester","dependsOn":[의존작업인덱스]}]}',
    '',
    '목표:',
    goal,
  ].join('\n')
}
```

`PLANNER_SCHEMA` 상수 추가(`VALID_ROLES` 선언 근처, `buildPlannerPrompt` 앞):
```ts
/** planner 구조화 출력 스키마(루트 object — OpenAI strict 호환). 수치/문자열 제약 미사용. */
export const PLANNER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          role: { type: 'string', enum: ['architect', 'implementer', 'reviewer', 'tester'] },
          dependsOn: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
}
```

`parsePlannedTasks` 의 첫 줄 `const arr = extractJsonArray(text)` 를 `const arr = coerceTaskArray(text)` 로 바꾸고, `extractJsonArray` 함수 **위**에 헬퍼 추가:
```ts
/** 구조화 출력(깨끗한 JSON)이면 strict 파싱, 아니면 산문 속 배열 슬라이싱으로 폴백한다. */
function coerceTaskArray(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') {
      const tasks = (parsed as Record<string, unknown>).tasks
      if (Array.isArray(tasks)) return tasks
    }
  } catch {
    // 깨끗한 JSON 이 아니면(CLI 산문 등) 폴백으로 진행
  }
  return extractJsonArray(text)
}
```
(`extractJsonArray` 는 폴백으로 **유지** — 삭제 금지.)

`planTasks` 에서 스키마 전달:
```ts
export async function planTasks(goal: string, planner: LlmSession, signal?: AbortSignal): Promise<PlannedTask[]> {
  const reply = await planner.send(buildPlannerPrompt(goal), {
    fresh: true,
    signal,
    responseSchema: { name: 'plan', schema: PLANNER_SCHEMA },
  })
  return parsePlannedTasks(reply)
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/orchestrator/plan.test.ts`
Expected: PASS (신규 + 기존; `[]`·bogus role·fenced 추출 등 기존 테스트 유지).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/plan.ts src/main/core/orchestrator/plan.test.ts
git commit -m "feat(plan): planner 구조화 출력 스키마 + strict/폴백 병존 파싱

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: review.ts — 스키마·프롬프트·`parseReviewVerdict` + orchestrator 배선

**Files:**
- Modify: `src/main/core/orchestrator/review.ts`, `src/main/core/orchestrator/orchestrator.ts`
- Test: `src/main/core/orchestrator/review.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `review.test.ts` 상단 import 에 `REVIEW_SCHEMA` 추가:
```ts
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, buildVerifyFixPrompt, parseReviewVerdict, REVIEW_SCHEMA } from './review'
```
`describe('parseReviewVerdict', ...)` 안에 추가:
```ts
  it('구조화 출력 JSON {approved,feedback} 를 파싱한다', () => {
    const v = parseReviewVerdict('{"approved":false,"feedback":"타입을 고쳐라"}')
    expect(v.approved).toBe(false)
    expect(v.feedback).toBe('타입을 고쳐라')
  })

  it('approved:true JSON 을 승인으로 본다', () => {
    expect(parseReviewVerdict('{"approved":true,"feedback":""}').approved).toBe(true)
  })
```
기존 `buildReviewPrompt` 테스트는 JSON 요청으로 바뀌므로 교체 — `describe('prompt builders', ...)` 안의
`it('buildReviewPrompt embeds the diff and asks APPROVE/REVISE', ...)` 를 다음으로 교체:
```ts
  it('buildReviewPrompt embeds the diff and asks for approved/feedback JSON', () => {
    const p = buildReviewPrompt('작업', '설명', 'diff --git a/x b/x')
    expect(p).toContain('diff --git')
    expect(p).toContain('approved')
    expect(p).toContain('feedback')
  })
```
파일 끝에 스키마 형태 테스트:
```ts
describe('REVIEW_SCHEMA', () => {
  it('approved(boolean)·feedback(string) 객체 스키마', () => {
    const props = REVIEW_SCHEMA.properties as Record<string, { type?: string }>
    expect(props.approved.type).toBe('boolean')
    expect(props.feedback.type).toBe('string')
    expect(REVIEW_SCHEMA.additionalProperties).toBe(false)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/orchestrator/review.test.ts`
Expected: FAIL — `REVIEW_SCHEMA` 미정의, JSON 미파싱, 프롬프트에 'approved' 없음.

- [ ] **Step 3: 최소 구현** — `review.ts` 수정.

`REVIEW_SCHEMA` 추가(파일 상단 `ReviewVerdict` 인터페이스 뒤):
```ts
/** reviewer 구조화 출력 스키마. */
export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'feedback'],
  properties: {
    approved: { type: 'boolean' },
    feedback: { type: 'string' },
  },
}
```

`buildReviewPrompt` 의 마지막 두 줄(APPROVE/REVISE 안내)을 JSON 요청으로 교체:
```ts
export function buildReviewPrompt(taskTitle: string, taskDescription: string, diff: string): string {
  return [
    '다음은 한 작업으로 발생한 워크스페이스 변경(diff)이다. 비판적으로 검토하라.',
    `작업: ${taskTitle}`,
    `설명: ${taskDescription}`,
    '',
    '변경(diff):',
    diff || '(변경 없음)',
    '',
    '반드시 아래 형식의 JSON 객체만 출력하라(설명/마크다운 금지):',
    '{"approved": true 또는 false, "feedback": "승인이면 빈 문자열, 수정이 필요하면 무엇을 어떻게 고칠지"}',
  ].join('\n')
}
```

`parseReviewVerdict` 교체(strict 우선 + 기존 토큰 폴백 유지):
```ts
/** 리뷰 출력 파싱: 구조화 JSON {approved,feedback} 우선, 실패 시 APPROVE/REVISE 토큰 폴백. */
export function parseReviewVerdict(text: string): ReviewVerdict {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>
      if (typeof o.approved === 'boolean') {
        return { approved: o.approved, feedback: typeof o.feedback === 'string' ? o.feedback : '' }
      }
    }
  } catch {
    // 깨끗한 JSON 이 아니면(CLI 산문/토큰 등) 폴백으로 진행
  }
  // 폴백: 앞쪽 마크다운/인용/리스트 마커를 벗기고 첫 토큰 APPROVE/REVISE 를 인식.
  const normalized = text.trim().replace(/^[\s*_`"'>•-]+/, '')
  const approved = /^APPROVED?\b/i.test(normalized)
  const feedback = normalized.replace(/^(APPROVED?|REVISE[DS]?)\b[:\s]*/i, '').trim()
  return { approved, feedback }
}
```

`orchestrator.ts` 의 reviewer 호출에 스키마 전달. import 수정:
```ts
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, buildVerifyFixPrompt, parseReviewVerdict, REVIEW_SCHEMA } from './review'
```
reviewer 호출부 교체. 기존:
```ts
        const verdict = parseReviewVerdict(
          await reviewer.send(buildReviewPrompt(task.title, task.description, diff.patch), { fresh: true, signal: opts.signal }),
        )
```
→
```ts
        const verdict = parseReviewVerdict(
          await reviewer.send(buildReviewPrompt(task.title, task.description, diff.patch), {
            fresh: true,
            signal: opts.signal,
            responseSchema: { name: 'review', schema: REVIEW_SCHEMA },
          }),
        )
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/orchestrator/review.test.ts src/main/core/orchestrator/orchestrator.test.ts`
Expected: PASS (신규 + 기존; 기존 APPROVE/REVISE 토큰 테스트는 폴백으로 계속 통과).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/review.ts src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/review.test.ts
git commit -m "feat(review): reviewer 구조화 출력 스키마 + strict/폴백 병존 파싱

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 전체 품질 게이트

**Files:** 없음(검증만).

- [ ] **Step 1: 전체 게이트 실행**

Run:
```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: 모두 통과. typecheck 0 에러, lint 경고 0, vitest 전 스위트 green, build 성공.

- [ ] **Step 2: 실패 시 수정**

게이트 실패 시 해당 단계만 디버깅(systematic-debugging). lint 경고는 0 으로 만든다(AGENTS.md). 수정 후 Step 1 재실행.

- [ ] **Step 3: 최종 상태 확인 커밋(필요 시)**

게이트 통과를 위해 추가 수정이 있었다면:
```bash
git add -A
git commit -m "chore: 구조화 출력 품질 게이트 통과

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 자가 검토 메모 (작성자 확인 완료)

- **spec 커버리지**: 계약(Task 1,5) · 3 provider 네이티브 매핑+degradation(Task 2,3,4) · planner 소비처(Task 6) · reviewer 소비처+orchestrator(Task 7) · TDD/게이트(전 Task + Task 8). spec 의 모든 섹션이 태스크로 매핑됨.
- **폴백 병존**: `extractJsonArray`·APPROVE/REVISE 토큰 파싱 모두 유지(삭제 단계 없음) → 회귀 차단.
- **타입 일관성**: `responseSchema: { name, schema }` 형태가 `ApiCallOptions`·`SendOptions`·`planTasks`·orchestrator 에서 동일. provider 헬퍼 `sendWithSchemaFallback(send, hasSchema, stripSchema)` 시그니처가 3 provider 에서 동일.
- **비범위**: reasoning/thinking·caching(이슈 #11 나머지), summarizer, 스트리밍+스키마 fallback, 모델 allowlist — 모두 제외(YAGNI).
- **라이브 미검증**: provider 네이티브 필드명/형태는 mock 으로 계약 고정; 실제 API 스키마 준수는 라이브 키로 별도 확인(폴백 존재로 회귀 없음).

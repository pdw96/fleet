# Gemini thought 캡처 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gemini thinking 응답의 사고 요약(thought)을 ThinkingBlock으로 캡처하고 thought-part `thoughtSignature`를 멀티턴 tool 루프에서 byte-exact 왕복한다.

**Architecture:** 순수 `src/main/core/providers/google.ts` 변경. 요청에 `thinkingConfig.includeThoughts:true` 추가 → 응답의 `part.thought===true` 파트를 순서보존 `ChatResult.content`로 파싱(`providerMeta.google.thoughtSignature` 보존) → `mapParts`가 `{thought:true, text, thoughtSignature}`로 재방출. loop/IPC/렌더러는 이미 키스톤-레디(무변경).

**Tech Stack:** TypeScript, vitest. 테스트 헬퍼 `mockHttp`/`mockStreamHttp`(`providers.test.ts` 상단). 게이트: `npm run typecheck && npm run lint && npm test && npm run build`.

---

## File Structure

- **Modify** `src/main/core/providers/google.ts` — `GooglePart.thought` 필드 · `resolveThinkingConfig`(includeThoughts) · 버퍼 파싱(text 교정 + ordered content) · `readStream`(thought 누적 + ordered content) · `mapParts` thinking echo.
- **Modify** `src/main/core/providers/providers.test.ts` — Google 섹션 신규 테스트 + 기존 thinkingConfig 단언 갱신.
- (선택) **Modify** `src/main/core/tools/loop.test.ts` — 라운드트립(키스톤 ordered가 이미 커버하므로 생략 가능).

각 Task는 RED(테스트 실패) → GREEN(구현) → 게이트 → 커밋.

---

### Task 1: includeThoughts 요청 매핑 + 기존 테스트 갱신

**Files:**
- Modify: `src/main/core/providers/google.ts:64-69` (`resolveThinkingConfig`)
- Test: `src/main/core/providers/providers.test.ts` (Google 섹션, `:1180` 부근)

- [ ] **Step 1: 기존 thinkingConfig 단언을 includeThoughts 포함으로 갱신(RED)**

`providers.test.ts`의 기존 4개 단언을 갱신한다(라인은 이동 가능 — 내용으로 매칭):
- `:1185` `expect(...).toEqual({ thinkingLevel: 'low' })` → `{ thinkingLevel: 'low', includeThoughts: true }`
- `:1193` `{ thinkingLevel: 'high' }` → `{ thinkingLevel: 'high', includeThoughts: true }`
- `:1203` `{ thinkingLevel: 'medium' }` → `{ thinkingLevel: 'medium', includeThoughts: true }`
- `:1214` `{ thinkingBudget: -1 }` → `{ thinkingBudget: -1, includeThoughts: true }`

그리고 신규 테스트 추가(gen-3 effort 미지정 + 미지원 모델):

```ts
it('includeThoughts: gen-3 effort 미지정(thinking:{})이어도 includeThoughts만 전송한다', async () => {
  const { http, calls } = mockHttp(okBody)
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
  await p.chat([{ role: 'user', content: 'q' }], { thinking: {} })
  const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
  expect(body.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
})

it('includeThoughts: thinking 미지정이면 thinkingConfig 미설정(무회귀)', async () => {
  const { http, calls } = mockHttp(okBody)
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
  await p.chat([{ role: 'user', content: 'q' }])
  const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
  expect(body.generationConfig?.thinkingConfig).toBeUndefined()
})

it('includeThoughts: thinking 미지원 모델(gemini-2.0)은 thinkingConfig 미전송', async () => {
  const { http, calls } = mockHttp(okBody)
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-2.0-flash', apiKey: 'k' }, http)
  await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
  const body = JSON.parse(calls[0].init.body) as { generationConfig?: { thinkingConfig?: unknown } }
  expect(body.generationConfig?.thinkingConfig).toBeUndefined()
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- providers.test.ts -t includeThoughts` (및 기존 갱신분)
Expected: FAIL — 현재 thinkingConfig에 includeThoughts 없음.

- [ ] **Step 3: `resolveThinkingConfig` 구현**

`google.ts:64-69`를 교체:

```ts
function resolveThinkingConfig(model: string, knob: ApiCallOptions['thinking']): Record<string, unknown> | undefined {
  if (!knob || !isThinkingModel(model)) return undefined
  // thinking 활성이면 사고 요약을 함께 요청한다(includeThoughts). thinkingLevel/Budget 유무와 독립 —
  // gen-3 effort 미지정(knob={})이어도 요약은 받는다(모델 기본 사고 깊이는 유지).
  const cfg: Record<string, unknown> = { includeThoughts: true }
  if (GEMINI_3.test(model)) {
    if (knob.effort) cfg.thinkingLevel = thinkingLevelOf(knob.effort)
  } else {
    cfg.thinkingBudget = -1 // GEMINI_25 (isThinkingModel 가드로 그 외는 도달 불가)
  }
  return cfg
}
```

JSDoc도 includeThoughts 언급으로 갱신.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- providers.test.ts`
Expected: PASS (Google thinkingConfig 단언 전부).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/google.ts src/main/core/providers/providers.test.ts
git commit -m "feat(google): thinkingConfig.includeThoughts 전송 (thinking 활성 시)"
```

---

### Task 2: 버퍼 파싱 — thought → ThinkingBlock + ordered content

**Files:**
- Modify: `src/main/core/providers/google.ts:71-76` (`GooglePart`), `:312-329` (버퍼 파싱)
- Test: `src/main/core/providers/providers.test.ts` (Google 섹션)

- [ ] **Step 1: 버퍼 파싱 테스트(RED)**

```ts
it('버퍼: thought 파트를 ThinkingBlock(sig in providerMeta)로, text/tool_use 순서보존 content 적재', async () => {
  const { http } = mockHttp(() => ({
    body: JSON.stringify({
      candidates: [{ content: { parts: [
        { text: '사고 요약', thought: true, thoughtSignature: 'TSIG' },
        { text: '답변' },
        { functionCall: { id: 'fc1', name: 'lookup', args: { id: 1 } } },
      ] }, finishReason: 'STOP' }],
    }),
  }))
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
  const out = await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' }, tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
  expect(out.text).toBe('답변') // thought 텍스트는 가시 답변에서 제외
  expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'fc1', name: 'lookup', input: { id: 1 } }])
  expect(out.content).toEqual([
    { type: 'thinking', text: '사고 요약', providerMeta: { google: { thoughtSignature: 'TSIG' } } },
    { type: 'text', text: '답변' },
    { type: 'tool_use', id: 'fc1', name: 'lookup', input: { id: 1 } },
  ])
})

it('버퍼: thought 파트의 thoughtSignature가 없으면 providerMeta undefined', async () => {
  const { http } = mockHttp(() => ({
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '사고', thought: true }, { text: '답' }] }, finishReason: 'STOP' }] }),
  }))
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
  const out = await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
  expect(out.content).toEqual([
    { type: 'thinking', text: '사고', providerMeta: undefined },
    { type: 'text', text: '답' },
  ])
})

it('버퍼: thought 파트가 없으면 content undefined(무회귀)', async () => {
  const { http } = mockHttp(() => ({ body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }) }))
  const p = createGoogleProvider(baseGoogle, http)
  const out = await p.chat([{ role: 'user', content: 'q' }])
  expect(out.content).toBeUndefined()
  expect(out.text).toBe('hi')
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- providers.test.ts -t "버퍼: thought"`
Expected: FAIL — `GooglePart.thought` 없음, content 미설정, text에 thought 섞임.

- [ ] **Step 3: 구현**

`GooglePart`(`:71-76`)에 필드 추가:

```ts
interface GooglePart {
  text?: string
  /** includeThoughts로 받은 사고 요약 파트 표식. true면 가시 답변이 아니라 reasoning 요약(ThinkingBlock). */
  thought?: boolean
  functionCall?: { id?: string; name?: string; args?: unknown }
  thoughtSignature?: string
}
```

버퍼 파싱(`:313-318` 부근, `const parsed` 이후 `text`/`toolCalls` 계산부)을 교체:

```ts
const parsed = JSON.parse(raw) as GoogleResponse
const cand = parsed.candidates?.[0]
const parts = cand?.content?.parts ?? []
// 가시 답변은 thought 파트를 제외한 text만 이어붙인다(사고 요약은 가시 토큰 아님).
const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('')
const toolCalls: ToolUseBlock[] = parts
  .filter((p) => p.functionCall)
  .map((p) => toToolUse(p.functionCall!, p.thoughtSignature))
// thought 파트가 1개 이상이면 순서보존 content를 적재(없으면 undefined → 현행 동작 byte-동일).
const content: ContentBlock[] | undefined = parts.some((p) => p.thought)
  ? parts.flatMap((p): ContentBlock[] => {
      if (p.thought && typeof p.text === 'string')
        return [{ type: 'thinking', text: p.text, providerMeta: p.thoughtSignature !== undefined ? { google: { thoughtSignature: p.thoughtSignature } } : undefined }]
      if (p.functionCall) return [toToolUse(p.functionCall, p.thoughtSignature)]
      if (typeof p.text === 'string') return [{ type: 'text', text: p.text }]
      return []
    })
  : undefined
const finish = resolveFinish(parsed)
return { text, toolCalls, content, finishReason: finish.finishReason, rawFinishReason: finish.raw, usage: { inputTokens: parsed.usageMetadata?.promptTokenCount, outputTokens: parsed.usageMetadata?.candidatesTokenCount } }
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- providers.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/google.ts src/main/core/providers/providers.test.ts
git commit -m "feat(google): 버퍼 thought 파트 → ThinkingBlock 순서보존 content 파싱"
```

---

### Task 3: 스트림 파싱 — thought 누적 + ordered content

**Files:**
- Modify: `src/main/core/providers/google.ts:181-229` (`readStream`)
- Test: `src/main/core/providers/providers.test.ts` (streaming 섹션)

- [ ] **Step 1: 스트림 테스트(RED)**

```ts
it('Google 스트림: thought 델타+signature를 ThinkingBlock content로 누적, onToken엔 안 흘림', async () => {
  const { http } = mockStreamHttp([
    'data: {"candidates":[{"content":{"parts":[{"text":"생각중","thought":true,"thoughtSignature":"TSIG"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"안"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"녕"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4}}\n\n',
  ])
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
  const deltas: string[] = []
  const out = await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' }, onToken: (d) => deltas.push(d) })
  expect(deltas).toEqual(['안', '녕']) // 사고 요약은 onToken으로 안 흘림
  expect(out.text).toBe('안녕')
  expect(out.content).toEqual([
    { type: 'thinking', text: '생각중', providerMeta: { google: { thoughtSignature: 'TSIG' } } },
    { type: 'text', text: '안녕' },
  ])
})

it('Google 스트림: thought가 없으면 content undefined(무회귀)', async () => {
  const { http } = mockStreamHttp([
    'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
  ])
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3.5-flash', apiKey: 'k' }, http)
  const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: () => {} })
  expect(out.content).toBeUndefined()
  expect(out.text).toBe('hi')
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- providers.test.ts -t "Google 스트림: thought"`
Expected: FAIL — thought 파트가 text로 흘러 deltas에 '생각중' 포함, content 미설정.

- [ ] **Step 3: 구현**

`readStream`(`:181-229`): 누적 변수 추가 + 파트 루프 분기 + 종료 시 content 재구성.

누적 변수(`const funcs` 부근):
```ts
let thoughtText = ''
let thoughtSig: string | undefined
```

파트 루프(`:203-210`)를 thought 우선 분기로 교체:
```ts
for (const p of cand?.content?.parts ?? []) {
  if (p.thought) {
    if (p.text) thoughtText += p.text // 사고 요약은 onToken으로 안 흘림(가시 토큰 아님)
    if (p.thoughtSignature !== undefined) thoughtSig = p.thoughtSignature
  } else if (p.text) {
    text += p.text
    onToken(p.text)
  } else if (p.functionCall) {
    funcs.push({ fc: p.functionCall, sig: p.thoughtSignature })
  }
}
```

종료부(`:220` `const toolCalls` 이후, blockReason 처리 앞)에서 content 재구성:
```ts
const toolCalls: ToolUseBlock[] = funcs.map((f) => toToolUse(f.fc, f.sig))
// thought가 있으면 순서보존 content 재구성. Gemini는 사고를 답변 앞에 방출하므로
// [thinking, text?, ...toolCalls] 휴리스틱(버퍼는 정확 순서, 스트림은 thought-우선 — Anthropic 동형).
let content: ContentBlock[] | undefined
if (thoughtText || thoughtSig !== undefined) {
  content = [{ type: 'thinking', text: thoughtText, providerMeta: thoughtSig !== undefined ? { google: { thoughtSignature: thoughtSig } } : undefined }]
  if (text) content.push({ type: 'text', text })
  for (const t of toolCalls) content.push(t)
}
```

그리고 두 return 문(blockReason · 정상)에 `content`를 추가:
```ts
if (blockReason) return { text, toolCalls, content, finishReason: 'content_filter', rawFinishReason: `PROMPT_BLOCKED:${blockReason}`, usage }
…
return { text, toolCalls, content, finishReason: mapFinish(finish), rawFinishReason: finish, usage }
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- providers.test.ts`
Expected: PASS (기존 스트림 테스트 포함 — thought 없는 케이스 content undefined 유지).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/google.ts src/main/core/providers/providers.test.ts
git commit -m "feat(google): 스트림 thought 파트 누적 → ThinkingBlock content"
```

---

### Task 4: mapParts thinking echo — 멀티턴 signature 왕복

**Files:**
- Modify: `src/main/core/providers/google.ts:144-147` (`mapParts` `case 'thinking'`)
- Test: `src/main/core/providers/providers.test.ts` (Google 섹션)

- [ ] **Step 1: 왕복 테스트(RED)**

```ts
it('mapParts: thinking 블록을 {thought:true, text, thoughtSignature}로 회신한다', async () => {
  const { http, calls } = mockHttp(okBody)
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
  await p.chat([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      { type: 'thinking', text: '사고', providerMeta: { google: { thoughtSignature: 'TSIG' } } },
      { type: 'tool_use', id: 'fc1', name: 'lookup', input: { id: 1 }, providerMeta: { google: { thoughtSignature: 'FCSIG' } } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fc1', name: 'lookup', content: '값' }] },
  ], { thinking: { effort: 'high' }, tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
  const body = JSON.parse(calls[0].init.body) as { contents: Array<{ role: string; parts: unknown[] }> }
  const model = body.contents.find((c) => c.role === 'model')!
  expect(model.parts[0]).toEqual({ text: '사고', thought: true, thoughtSignature: 'TSIG' })
  expect(model.parts[1]).toEqual({ functionCall: { name: 'lookup', args: { id: 1 }, id: 'fc1' }, thoughtSignature: 'FCSIG' })
})

it('mapParts: thinking 블록에 sig가 없으면 thoughtSignature 미전송', async () => {
  const { http, calls } = mockHttp(okBody)
  const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
  await p.chat([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', text: '사고' }] },
  ], { thinking: { effort: 'high' } })
  const body = JSON.parse(calls[0].init.body) as { contents: Array<{ role: string; parts: unknown[] }> }
  const model = body.contents.find((c) => c.role === 'model')!
  expect(model.parts[0]).toEqual({ text: '사고', thought: true })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- providers.test.ts -t "mapParts: thinking"`
Expected: FAIL — 현재 `case 'thinking'`은 `{ text }`만 반환(thought/thoughtSignature 없음).

- [ ] **Step 3: 구현**

`mapParts` `case 'thinking'`(`:144-147`)을 교체:

```ts
case 'thinking': {
  // includeThoughts로 받은 사고 요약을 받은 그대로 회신한다(thought:true + signature). 멀티턴 tool
  // 루프에서 thought-part thoughtSignature 왕복(누락 시 Gemini 3 함수호출 검증오류). echo-only-when-present(#29).
  const part: Record<string, unknown> = { text: b.text, thought: true }
  const sig = b.providerMeta?.google?.thoughtSignature
  if (sig !== undefined) part.thoughtSignature = sig
  return part
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- providers.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/providers/google.ts src/main/core/providers/providers.test.ts
git commit -m "feat(google): mapParts thinking echo — thought-part signature 멀티턴 왕복"
```

---

### Task 5: 4 게이트 + 라운드트립 확인

**Files:** 없음(검증 전용). 선택적으로 `loop.test.ts` 확인.

- [ ] **Step 1: 4 게이트 전체 실행**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: 전부 PASS, lint 경고 0.

- [ ] **Step 2: 라운드트립 회귀 확인(기존 테스트)**

`loop.test.ts:266-281`(키스톤 ordered)이 `result.content`의 `[thinking, text, tool_use]` 왕복·providerMeta 보존을 이미 검증한다 — provider-중립이라 Google content가 들어와도 동일 경로. 신규 테스트 불필요(스펙 '선택'). 실행해 그린 확인:

Run: `npm test -- loop.test.ts`
Expected: PASS.

- [ ] **Step 3: 최종 커밋(필요 시)**

게이트 통과 확인만이면 커밋 불필요.

---

## Self-Review

**Spec coverage:**
- includeThoughts 노브 → Task 1 ✅
- 버퍼 thought→ThinkingBlock+ordered content → Task 2 ✅
- 스트림 thought 누적 → Task 3 ✅
- mapParts 왕복 → Task 4 ✅
- 기존 thinkingConfig 단언 갱신 → Task 1 Step 1 ✅
- text thought 제외 → Task 2 Step 3 ✅
- 무회귀(thinking off content undefined) → Task 2/3 negative ✅
- 4 게이트 → Task 5 ✅

**Placeholder scan:** 모든 step에 실제 코드/명령/기대출력 포함. 없음.

**Type consistency:** `GooglePart.thought`·`thoughtSignature`·`providerMeta.google.thoughtSignature`·`toToolUse(fc, sig)` 시그니처 일관. `content?: ContentBlock[]`·`ThinkingBlock`은 기존 타입. `ApiCallOptions.thinking` 기존.

## 비범위 (스펙과 동일)

- ① 2.5 effort→정수 budget 세분화(별도 PR).
- text-part thoughtSignature 캡처/왕복(문서화된 한계).

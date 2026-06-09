# Anthropic 인바운드 thinking 캡처 + adaptive 노브 구현 계획 (#11-thinking)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anthropic 응답의 thinking 블록을 버퍼·스트림 양 경로에서 순서보존 `ChatResult.content`로 파싱(signature를 `providerMeta.anthropic`에 byte-exact 보존)하고, `ApiCallOptions.thinking` 노브를 adaptive thinking으로 매핑한다.

**Architecture:** 키스톤(PR #33)이 깔아둔 `ThinkingBlock`/`providerMeta`/`ChatResult.content?`/`assertNever` 채널의 producer를 추가한다. 재방출(`mapContent` `case 'thinking'`)·loop 재구성(`loop.ts:58-62`)은 이미 배선됐으므로 **파싱(producer) + 요청 노브**만 추가하면 멀티턴 tool 루프에서 signature byte-exact 왕복이 완성된다. orchestrator/IPC 미배선(프로덕션 off 착지).

**Tech Stack:** TypeScript, Electron 비의존 순수 코어(`src/main/core/`), vitest. 설계: `docs/superpowers/specs/2026-06-10-anthropic-thinking-parse-design.md`.

**작업 브랜치:** `feat/anthropic-thinking-parse` (이미 생성됨, 설계 문서 커밋 `cca6cfe` 위).

**품질 게이트(AGENTS.md, 매 변경 후):** `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

---

### Task 1: 요청 노브 — `ApiCallOptions.thinking` + Anthropic adaptive 매핑

`opts.thinking` 지정 시 Anthropic에 `thinking:{type:'adaptive', display:'summarized'}`를 싣고, `effort` 지정 시 `output_config.effort`를 싣는다. `output_config`는 `responseSchema`(format)와 공유하므로 단일 객체로 병합하고, 구조화-출력 400 폴백은 `format`만 제거(effort 보존)하도록 교정한다.

**Files:**
- Modify: `src/main/core/providers/types.ts` (`ApiCallOptions` 인터페이스 + `ReasoningEffort` 타입)
- Modify: `src/main/core/providers/anthropic.ts` (요청 body 빌드 + stripSchema 콜백)
- Test: `src/main/core/providers/providers.test.ts` (`describe('AnthropicProvider')` 안)

- [ ] **Step 1: 실패 테스트 작성**

`providers.test.ts`의 `describe('AnthropicProvider', () => {` 블록 안, 기존 `it('ThinkingBlock 을 tool_use 앞에...')` 테스트 **앞**에 추가:

```ts
  it('thinking 노브 → adaptive thinking + display:summarized + effort 를 body 에 싣는다 (#11-thinking)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: { effort: 'high' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  it('effort 없이 thinking 만 주면 thinking 만 싣고 output_config 는 없다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }], { thinking: {} })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toBeUndefined()
  })

  it('thinking 미지정이면 body 에 thinking/output_config 가 없다(현행 동작)', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'q' }])
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  it('responseSchema 와 thinking.effort 공존 시 output_config 에 format+effort 를 병합한다', async () => {
    const { http, calls } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema }, thinking: { effort: 'low' } })
    const body = JSON.parse(calls[0].init.body) as Record<string, unknown>
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema }, effort: 'low' })
  })

  it('구조화-출력 400 폴백 시 format 만 제거하고 effort 는 보존한다', async () => {
    let n = 0
    const { http, calls } = mockHttp(() => {
      n++
      return n === 1
        ? { ok: false, status: 400, body: 'unsupported field output_config' }
        : { body: JSON.stringify({ content: [{ type: 'text', text: '[]' }], stop_reason: 'end_turn' }) }
    })
    const p = createAnthropicProvider(baseAnthropic, http)
    const schema = { type: 'object', additionalProperties: false, properties: {} }
    await p.chat([{ role: 'user', content: 'x' }], { responseSchema: { name: 'v', schema }, thinking: { effort: 'medium' } })
    expect(calls).toHaveLength(2)
    expect((JSON.parse(calls[1].init.body) as Record<string, unknown>).output_config).toEqual({ effort: 'medium' })
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "thinking 노브"`
Expected: FAIL — `body.thinking`는 `undefined`(아직 매핑 없음). 또한 `opts.thinking` 타입이 없어 typecheck도 깨진다.

- [ ] **Step 3: 타입 추가 (`types.ts`)**

`ApiCallOptions` 인터페이스 **바로 앞**에 타입 선언 추가:

```ts
/**
 * 모델 reasoning(extended thinking) 깊이. provider-중립. Anthropic 은 output_config.effort 로 매핑한다.
 * OpenAI(reasoning_effort)/Gemini(thinkingConfig) 매핑은 후속 — low/medium/high 부분집합으로 클램프 예정.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
```

`ApiCallOptions` 인터페이스 안, `responseSchema?` 필드 **뒤**에 추가:

```ts
  /**
   * 모델 reasoning(extended thinking) 노브. 지정 시 provider 가 네이티브 reasoning 을 켠다(미지정=off).
   * 현 슬라이스는 Anthropic 만 adaptive thinking 으로 매핑한다(OpenAI/Gemini 는 후속). #11-thinking.
   */
  thinking?: { effort?: ReasoningEffort }
```

- [ ] **Step 4: 요청 매핑 구현 (`anthropic.ts`)**

`anthropic.ts` chat()에서 기존 블록

```ts
      if (opts.responseSchema) {
        body.output_config = { format: { type: 'json_schema', schema: opts.responseSchema.schema } }
      }
```

를 아래로 교체:

```ts
      // output_config 는 responseSchema(format) 와 thinking(effort) 가 공유 → 단일 객체로 병합.
      const outputConfig: Record<string, unknown> = {}
      if (opts.responseSchema) {
        outputConfig.format = { type: 'json_schema', schema: opts.responseSchema.schema }
      }
      if (opts.thinking) {
        // adaptive 는 현행 모델(4.6/4.7/4.8·Sonnet4.6) 전용 모드. display:'summarized' 로 thinking 텍스트까지
        // 캡처한다(4.7/4.8 기본 omitted 보정). signature 는 display 와 무관하게 항상 온다.
        body.thinking = { type: 'adaptive', display: 'summarized' }
        if (opts.thinking.effort) outputConfig.effort = opts.thinking.effort
      }
      if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig
```

그리고 stripSchema 콜백 — 기존

```ts
        : await sendWithSchemaFallback(send, !!opts.responseSchema, () => { delete body.output_config })
```

를 필드 단위로 교체(effort 보존, google.ts 방식):

```ts
        : await sendWithSchemaFallback(send, !!opts.responseSchema, () => {
            const oc = body.output_config as Record<string, unknown> | undefined
            if (oc) {
              delete oc.format
              if (Object.keys(oc).length === 0) delete body.output_config
            }
          })
```

- [ ] **Step 5: 통과 확인 + 무회귀**

Run: `npx vitest run src/main/core/providers/providers.test.ts`
Expected: PASS — 신규 5개 + 기존 `responseSchema → output_config.format` / `구조화-출력 400` 테스트 그린.

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/providers/types.ts src/main/core/providers/anthropic.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): ApiCallOptions.thinking 노브 — Anthropic adaptive thinking 매핑 (#11-thinking)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 버퍼 파싱 — 응답 thinking 블록 → 순서보존 `ChatResult.content`

비스트림 응답의 `thinking` 블록을 파싱해 `signature`를 `providerMeta.anthropic`에 보존하고, thinking→text→tool_use 원래 순서로 `content`를 구성한다. **thinking 블록이 있을 때만** `content`를 설정(없으면 undefined → 현행 byte-동일).

**Files:**
- Modify: `src/main/core/providers/anthropic.ts` (`AnthropicContent` 인터페이스 + 버퍼 파싱 `:199-214`)
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`describe('AnthropicProvider')` 안에 추가:

```ts
  it('비스트림 thinking 블록을 순서보존 content 로 파싱하고 signature 를 providerMeta 에 보존한다 (#11-thinking)', async () => {
    const { http } = mockHttp(() => ({
      body: JSON.stringify({
        content: [
          { type: 'thinking', thinking: '사고 과정', signature: 'SIG_T' },
          { type: 'text', text: '답변' },
          { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
        ],
        stop_reason: 'tool_use',
      }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.text).toBe('답변') // thinking 은 가시 텍스트에서 제외
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } }])
    expect(out.content).toEqual([
      { type: 'thinking', text: '사고 과정', providerMeta: { anthropic: { signature: 'SIG_T' } } },
      { type: 'text', text: '답변' },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
    ])
  })

  it('비스트림 thinking 블록이 없으면 content 를 설정하지 않는다(무회귀)', async () => {
    const { http } = mockHttp(() => ({ body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }) }))
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }])
    expect(out.content).toBeUndefined()
    expect(out.text).toBe('hi')
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "비스트림 thinking"`
Expected: FAIL — `out.content`가 `undefined`(파싱 미구현).

- [ ] **Step 3: 구현 — `AnthropicContent` 필드 추가**

`anthropic.ts`의 `AnthropicContent` 인터페이스에 두 필드 추가:

```ts
interface AnthropicContent {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  thinking?: string
  signature?: string
}
```

- [ ] **Step 4: 구현 — 버퍼 파싱 ordered content**

버퍼 파싱부의 기존 return

```ts
      const toolCalls: ToolUseBlock[] = blocks
        .filter((c) => c.type === 'tool_use')
        .map((c) => ({ type: 'tool_use', id: c.id ?? '', name: c.name ?? '', input: c.input }))
      return {
        text,
        toolCalls,
        finishReason: mapFinish(parsed.stop_reason),
        rawFinishReason: parsed.stop_reason,
        usage: { inputTokens: parsed.usage?.input_tokens, outputTokens: parsed.usage?.output_tokens },
      }
```

를 아래로 교체(`toolCalls` 줄은 유지, return 직전 content 구성 추가):

```ts
      const toolCalls: ToolUseBlock[] = blocks
        .filter((c) => c.type === 'tool_use')
        .map((c) => ({ type: 'tool_use', id: c.id ?? '', name: c.name ?? '', input: c.input }))
      // thinking 이 하나라도 있으면 순서보존 content 를 적재한다(signature 왕복용). 없으면 미설정 → 현행 동작.
      const content: ContentBlock[] | undefined = blocks.some((c) => c.type === 'thinking')
        ? blocks.flatMap((c): ContentBlock[] => {
            if (c.type === 'thinking')
              return [{ type: 'thinking', text: c.thinking ?? '', providerMeta: c.signature ? { anthropic: { signature: c.signature } } : undefined }]
            if (c.type === 'text' && typeof c.text === 'string') return [{ type: 'text', text: c.text }]
            if (c.type === 'tool_use') return [{ type: 'tool_use', id: c.id ?? '', name: c.name ?? '', input: c.input }]
            return [] // 미지 블록은 content 에서 제외(어시스턴트 응답엔 image 등 없음)
          })
        : undefined
      return {
        text,
        toolCalls,
        content,
        finishReason: mapFinish(parsed.stop_reason),
        rawFinishReason: parsed.stop_reason,
        usage: { inputTokens: parsed.usage?.input_tokens, outputTokens: parsed.usage?.output_tokens },
      }
```

(`ContentBlock`은 anthropic.ts 상단에 이미 `type ContentBlock`으로 import됨 — 추가 import 불필요.)

- [ ] **Step 5: 통과 확인 + 무회귀**

Run: `npx vitest run src/main/core/providers/providers.test.ts`
Expected: PASS — 신규 2개 + 기존 버퍼 테스트(`splits system...`, `parses tool_use blocks` 등) 그린.

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/providers/anthropic.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): Anthropic 비스트림 thinking 블록 파싱 — ordered content + signature 보존 (#11-thinking)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 스트림 파싱 — `thinking_delta`/`signature_delta` 누적

스트림에서 `content_block_start`(thinking)·`thinking_delta`·`signature_delta`를 인덱스별로 누적하고, thinking이 있으면 ordered `content`를 재구성한다. **thinking 델타는 `onToken`으로 흘리지 않는다**(reasoning은 가시 응답 토큰 아님). `text`/`toolAccum`은 무변경.

**Files:**
- Modify: `src/main/core/providers/anthropic.ts` (`readStream` `:98-145`)
- Test: `src/main/core/providers/providers.test.ts` (`describe('provider streaming (SSE)')` 안)

- [ ] **Step 1: 실패 테스트 작성**

`describe('provider streaming (SSE)', () => {` 안에 추가:

```ts
  it('Anthropic 스트림: thinking_delta+signature_delta 를 ordered content 로 누적하고 onToken 엔 안 흘린다 (#11-thinking)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"사고"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG_S"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"답"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const deltas: string[] = []
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: (d) => deltas.push(d) })
    expect(deltas).toEqual(['답']) // thinking 은 onToken 으로 안 흐른다
    expect(out.text).toBe('답')
    expect(out.content).toEqual([
      { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG_S' } } },
      { type: 'text', text: '답' },
    ])
  })

  it('Anthropic 스트림: display:omitted (signature_delta 만) 도 thinking 블록을 보존한다 (#11-thinking)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG_O"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"lookup"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: () => {}, tools: [{ name: 'lookup', parameters: { type: 'object' } }] })
    expect(out.content).toEqual([
      { type: 'thinking', text: '', providerMeta: { anthropic: { signature: 'SIG_O' } } },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: {} },
    ])
    expect(out.toolCalls).toEqual([{ type: 'tool_use', id: 'tu1', name: 'lookup', input: {} }])
  })

  it('Anthropic 스트림: thinking 이 없으면 content 를 설정하지 않는다(무회귀)', async () => {
    const { http } = mockStreamHttp([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ])
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'q' }], { onToken: () => {} })
    expect(out.content).toBeUndefined()
    expect(out.text).toBe('hi')
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "thinking_delta"`
Expected: FAIL — `out.content`가 `undefined`(스트림 thinking 누적 미구현).

- [ ] **Step 3: 구현 — readStream delta 타입 + 누적기**

`readStream`의 `ev` 타입 선언에서 `delta?` 필드에 `thinking`/`signature` 추가:

```ts
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string }
```

`readStream` 함수 상단의 누적기 선언부(`const toolAccum = new Map...` 줄) **다음**에 추가:

```ts
  // 인덱스 → thinking 누적기(thinking_delta 텍스트 + signature_delta 서명). content 순서보존용.
  const thinkingAccum = new Map<number, { text: string; signature: string }>()
```

- [ ] **Step 4: 구현 — start/delta 분기 추가**

`content_block_start`의 `tool_use` 분기 **다음**에 thinking 분기 추가:

```ts
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking' && typeof ev.index === 'number') {
      thinkingAccum.set(ev.index, { text: '', signature: '' })
```

`input_json_delta` 분기 **다음**(message_delta 분기 앞)에 thinking_delta·signature_delta 분기 추가:

```ts
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && typeof ev.index === 'number') {
      const acc = thinkingAccum.get(ev.index)
      if (acc) acc.text += ev.delta.thinking ?? '' // thinking 은 onToken 으로 흘리지 않는다(가시 응답 토큰 아님)
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'signature_delta' && typeof ev.index === 'number') {
      const acc = thinkingAccum.get(ev.index)
      if (acc) acc.signature = ev.delta.signature ?? ''
```

- [ ] **Step 5: 구현 — 종료 시 ordered content 재구성**

`readStream`의 기존 return부

```ts
  const toolCalls: ToolUseBlock[] = [...toolAccum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ type: 'tool_use', id: t.id, name: t.name, input: parseToolInput(t.json) }))
  return { text, toolCalls, finishReason: mapFinish(stop), rawFinishReason: stop, usage }
```

를 아래로 교체:

```ts
  const toolCalls: ToolUseBlock[] = [...toolAccum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({ type: 'tool_use', id: t.id, name: t.name, input: parseToolInput(t.json) }))
  // thinking 이 하나라도 있으면 순서보존 content 를 재구성한다. Anthropic 은 thinking 을 항상 먼저
  // 방출하므로 [thinking…, text, tool_use…] 순서가 'thinking 이 tool_use 앞' 하드 제약을 충족한다.
  let content: ContentBlock[] | undefined
  if (thinkingAccum.size > 0) {
    content = [...thinkingAccum.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]): ContentBlock => ({ type: 'thinking', text: t.text, providerMeta: t.signature ? { anthropic: { signature: t.signature } } : undefined }))
    if (text) content.push({ type: 'text', text })
    content.push(...toolCalls)
  }
  return { text, toolCalls, content, finishReason: mapFinish(stop), rawFinishReason: stop, usage }
```

- [ ] **Step 6: 통과 확인 + 무회귀**

Run: `npx vitest run src/main/core/providers/providers.test.ts`
Expected: PASS — 신규 3개 + 기존 스트리밍 테스트(텍스트 델타·tool_use 누적·error 이벤트·refusal) 전부 그린.

- [ ] **Step 7: 커밋**

```bash
git add src/main/core/providers/anthropic.ts src/main/core/providers/providers.test.ts
git commit -m "feat(providers): Anthropic 스트림 thinking_delta/signature_delta 누적 — ordered content (#11-thinking)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 라운드트립 통합 테스트 (loop echo)

파싱된 thinking content가 `runToolLoop`을 거쳐 다음 send의 `mapContent`에서 tool_use 앞에 signature와 함께 재방출되는지 확인한다(end-to-end 체인 잠금).

**Files:**
- Test: `src/main/core/tools/loop.test.ts`

- [ ] **Step 1: 기존 loop.test.ts 패턴 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts`
먼저 기존 테스트가 그린인지 확인하고, 파일 상단의 provider mock·`runToolLoop` 호출 패턴(어떻게 `ChatResult`를 주입하고 `turns`를 검사하는지)을 읽어 동일 패턴으로 작성한다.

- [ ] **Step 2: 라운드트립 테스트 작성**

`loop.test.ts`에 추가(기존 mock provider 패턴 사용 — 1차 chat은 thinking+tool_use content 반환, 2차 chat은 tool 없는 응답 반환해 종료):

```ts
  it('ordered content(thinking+tool_use)를 어시스턴트 턴으로 보존해 다음 턴에 signature 가 echo 된다 (#11-thinking 라운드트립)', async () => {
    const captured: ChatTurn[][] = []
    let call = 0
    const provider = makeProvider((turns) => {
      captured.push(structuredClone(turns))
      call++
      if (call === 1) {
        return {
          text: '',
          toolCalls: [{ type: 'tool_use', id: 'tu1', name: 'echo', input: {} }],
          content: [
            { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG_R' } } },
            { type: 'tool_use', id: 'tu1', name: 'echo', input: {} },
          ],
          finishReason: 'tool_use',
        }
      }
      return { text: '끝', toolCalls: [], finishReason: 'stop' }
    })
    const turns: ChatTurn[] = [{ role: 'user', content: 'q' }]
    await runToolLoop(provider, turns, {}, deps) // deps: 기존 테스트의 registry/gate(자동 승인) 재사용
    const assistant = turns.find((t) => t.role === 'assistant')!
    expect(assistant.content).toEqual([
      { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG_R' } } },
      { type: 'tool_use', id: 'tu1', name: 'echo', input: {} },
    ])
  })
```

> 주의: `makeProvider`/`deps`/`ChatTurn` 등 정확한 헬퍼·import는 Step 1에서 확인한 `loop.test.ts`의 기존 패턴에 맞춘다. 핵심 단언은 **어시스턴트 턴 content에 thinking 블록(signature 포함)이 tool_use 앞에 보존**되는 것. mapContent의 wire 변환 자체는 `providers.test.ts:170`(ThinkingBlock echo)에서 이미 검증되므로 여기선 loop의 content 보존만 확인한다.

- [ ] **Step 3: 통과 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts`
Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add src/main/core/tools/loop.test.ts
git commit -m "test(tools): thinking ordered content loop 보존 라운드트립 (#11-thinking)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Step 1에서 기존 loop.test.ts가 ordered content 보존을 이미 충분히 커버하면(키스톤 PR #33 테스트), 이 Task는 생략 가능 — 중복 테스트를 만들지 말 것. 생략 시 그 사실을 기록하고 Task 5로 진행한다.

---

### Task 5: 4 게이트 전체 통과 + 로드맵(이슈 #27) 갱신

**Files:**
- (검증 전용) + 필요 시 이슈 #27 코멘트/본문 갱신은 사용자 확인 후.

- [ ] **Step 1: 4 게이트 순차 실행**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: 전부 성공, lint 경고 0.

- [ ] **Step 2: diff 자체 점검**

Run: `git diff master --stat`
Expected: `types.ts`·`anthropic.ts`·`providers.test.ts`(+선택 `loop.test.ts`)·설계/계획 문서만 변경. OpenAI/Gemini 코드 무변경 확인.

- [ ] **Step 3: requesting-code-review 스킬로 자체 리뷰**

구현 완료 후 `superpowers:requesting-code-review`(또는 `pr-review-toolkit:code-reviewer`)로 변경분 리뷰. 지적사항은 `superpowers:receiving-code-review`로 처리.

- [ ] **Step 4: 로드맵 갱신 제안**

이슈 #27 본문/변경이력에 "#11-thinking 슬라이스 — Anthropic adaptive thinking 파싱+노브(레거시 budget_tokens 전제 정정), orchestrator 미배선" 항목 추가를 **사용자에게 제안**(외부 발신이므로 확인 후 실행). PR 생성도 사용자 확인 후.

---

## Self-Review (계획↔스펙 대조)

- **스펙 커버리지:** (1) 요청 노브 adaptive 매핑 → Task 1. (2) output_config 병합 + stripSchema 필드단위 → Task 1. (3) 버퍼 ordered content + signature → Task 2. (4) 스트림 thinking_delta/signature_delta + onToken 제외 + display:omitted → Task 3. (5) loop echo 라운드트립 → Task 4. (6) 4 게이트 + 무회귀 → 각 Task Step + Task 5. ✔ 갭 없음.
- **플레이스홀더:** 모든 코드 스텝에 실제 코드 포함. Task 4만 기존 헬퍼 의존(Step 1에서 확인 후 맞춤) — 명시적 단서 제공.
- **타입 일관성:** `ReasoningEffort`(types.ts) → `ApiCallOptions.thinking.effort`(Task 1) → `body.output_config.effort`(Task 1). `ContentBlock`/`ThinkingBlock`/`providerMeta.anthropic.signature`는 키스톤 기존 타입 그대로 사용(Task 2·3). `thinkingAccum` 시그너처 일관(Task 3 내부). ✔
```

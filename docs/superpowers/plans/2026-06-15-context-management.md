# context management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도구 루프의 무제한 `turns`(tool_result·history) 누적을 provider-중립 정책으로 경계 — anthropic 은 native `context_management` 위임, 나머지 3사는 client-side tool_result 가지치기.

**Architecture:** 코어에 `ContextManagementPolicy` 타입 + `ApiProvider.nativeContextManagement` capability 플래그 추가. `loop.ts` 가 플래그를 보고 native provider 엔 `opts.contextManagement` 를 실어 위임하고, 그 외엔 `pruneToolResults` 로 오래된 `tool_result.content` 를 stub 치환(블록 제거 아님 → 페어링·순서·서명 불변). default-on(보수 트리거 150k·keep 3), `ToolLoopDeps.contextPolicy` 로 비활성/튜닝.

**Tech Stack:** TypeScript(순수 코어), vitest. 변경: `providers/types.ts`·`providers/anthropic.ts`·`tools/types.ts`·`tools/context.ts`(신규)·`tools/loop.ts`. engine/IPC/preload/renderer/shared 무변경.

---

## File Structure

- **Create** `src/main/core/tools/context.ts` — `DEFAULT_CONTEXT_POLICY`·`PRUNE_STUB`·`approxTokens`·`pruneToolResults`(순수 함수, 독립 테스트).
- **Create** `src/main/core/tools/context.test.ts` — context.ts 단위 테스트.
- **Modify** `src/main/core/providers/types.ts` — `ContextManagementPolicy` 인터페이스 + `ApiCallOptions.contextManagement` + `ApiProvider.nativeContextManagement`.
- **Modify** `src/main/core/tools/types.ts` — `ToolLoopDeps.contextPolicy`.
- **Modify** `src/main/core/tools/loop.ts` — provider 분기 없는 capability 라우팅.
- **Modify** `src/main/core/tools/loop.test.ts` — 라우팅 테스트(opts 캡처 헬퍼 추가).
- **Modify** `src/main/core/providers/anthropic.ts` — native 매핑 + 플래그 + CM 400 fallback.
- **Modify** `src/main/core/providers/providers.test.ts` — anthropic CM 테스트.

---

## Task 1: `ContextManagementPolicy` 타입 + `tools/context.ts`(client-side 가지치기)

**Files:**
- Modify: `src/main/core/providers/types.ts` (인터페이스 추가; 현 `TokenUsage` 근처 `ApiCallOptions` 위)
- Create: `src/main/core/tools/context.ts`
- Test: `src/main/core/tools/context.test.ts`

- [ ] **Step 1: `ContextManagementPolicy` 인터페이스 추가**

`src/main/core/providers/types.ts` 의 `TokenUsage` 인터페이스(현 92-100행) 바로 위에 추가:

```ts
/**
 * provider-중립 context management 정책. anthropic 은 native `context_management` wire 로,
 * native 미지원 provider 는 loop 의 client-side 가지치기로 해석한다(동일 정책·실행만 분기).
 */
export interface ContextManagementPolicy {
  /** 누적 입력토큰(anthropic=서버 실측·그 외=client 추정)이 이 값을 넘으면 정리. */
  triggerInputTokens: number
  /** 유지할 최근 도구결과 수. 이보다 오래된 tool_result 부터 정리. */
  keepRecentToolUses: number
}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `src/main/core/tools/context.test.ts` 신규:

```ts
import { describe, expect, it } from 'vitest'
import type { ChatTurn, ToolResultBlock } from '../providers/types'
import { approxTokens, DEFAULT_CONTEXT_POLICY, pruneToolResults, PRUNE_STUB } from './context'

const toolResult = (id: string, content: string): ToolResultBlock => ({ type: 'tool_result', toolUseId: id, content })

describe('approxTokens', () => {
  it('문자열·블록 content 의 대략 토큰(chars/4)을 합산한다', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'aaaaaaaa' }, // 8 chars
      { role: 'user', content: [toolResult('t1', 'bbbbbbbb')] }, // 8 chars
    ]
    expect(approxTokens(turns)).toBe(4) // ceil(16/4)
  })
})

describe('pruneToolResults', () => {
  const policy = { triggerInputTokens: 10, keepRecentToolUses: 1 }
  const big = 'x'.repeat(80) // 20 추정토큰

  it('추정 토큰이 임계 이하면 아무것도 바꾸지 않는다', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: [toolResult('t1', 'short')] }]
    pruneToolResults(turns, policy)
    expect((turns[0].content as ToolResultBlock[])[0].content).toBe('short')
  })

  it('임계 초과 시 오래된 tool_result 만 stub 치환하고 최근 keep 개는 보존한다', () => {
    const turns: ChatTurn[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'e', input: {} }] },
      { role: 'user', content: [toolResult('t1', big)] }, // 오래된 것 → 정리
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'e', input: {} }] },
      { role: 'user', content: [toolResult('t2', big)] }, // 최근(keep=1) → 보존
    ]
    pruneToolResults(turns, policy)
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB)
    expect((turns[3].content as ToolResultBlock[])[0].content).toBe(big)
  })

  it('text·thinking·tool_use 블록은 손대지 않고 블록 수·순서를 보존한다', () => {
    const turns: ChatTurn[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'S' } } },
          { type: 'tool_use', id: 't1', name: 'e', input: { a: 1 } },
        ],
      },
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    pruneToolResults(turns, policy)
    const a = turns[0].content as Array<{ type: string; providerMeta?: unknown }>
    expect(a.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    expect(a[0].providerMeta).toEqual({ anthropic: { signature: 'S' } })
  })

  it('isError 표식은 stub 치환 시 제거한다', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: big, isError: true }] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    pruneToolResults(turns, policy)
    expect((turns[0].content as ToolResultBlock[])[0].isError).toBeUndefined()
  })

  it('idempotent — 재호출해도 동일하다(이미 stub 은 건너뜀)', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    pruneToolResults(turns, policy)
    const after1 = JSON.stringify(turns)
    pruneToolResults(turns, policy)
    expect(JSON.stringify(turns)).toBe(after1)
  })

  it('DEFAULT_CONTEXT_POLICY 는 보수값(150k·keep 3)', () => {
    expect(DEFAULT_CONTEXT_POLICY).toEqual({ triggerInputTokens: 150_000, keepRecentToolUses: 3 })
  })
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/main/core/tools/context.test.ts`
Expected: FAIL — `Failed to resolve import "./context"` (모듈 미존재).

- [ ] **Step 4: `tools/context.ts` 구현** — 신규 파일:

```ts
import type { ChatTurn, ContentBlock, ContextManagementPolicy, ToolResultBlock } from '../providers/types'

/** default-on 도구루프 context management 기본 정책(보수값). engine 미지정 시 loop 가 적용. */
export const DEFAULT_CONTEXT_POLICY: ContextManagementPolicy = {
  triggerInputTokens: 150_000,
  keepRecentToolUses: 3,
}

/** 정리된 tool_result content 를 대체하는 표식(idempotent 검사에도 쓰임). */
export const PRUNE_STUB = '[이전 도구 결과 정리됨 — 컨텍스트 관리]'

/** 블록 1개의 대략 문자수(추정 토큰의 입력). 미지 variant 는 0(안전). */
function blockChars(b: ContentBlock): number {
  switch (b.type) {
    case 'text':
      return b.text.length
    case 'tool_result':
      return b.content.length
    case 'tool_use':
      try {
        return JSON.stringify(b.input ?? {}).length
      } catch {
        return 0
      }
    case 'thinking':
      return b.text.length
    case 'image':
      return b.data.length
    default:
      return 0
  }
}

/**
 * turns 전체의 대략 입력 토큰을 추정한다(정밀 토크나이저 없음 → chars/4). 코드/JSON 은 실토큰이 더
 * 빽빽해 이 추정이 낮게 나오므로 트리거가 늦게(보수적으로) 발화한다 — 안전 방향.
 */
export function approxTokens(turns: ChatTurn[]): number {
  let chars = 0
  for (const t of turns) {
    if (typeof t.content === 'string') chars += t.content.length
    else for (const b of t.content) chars += blockChars(b)
  }
  return Math.ceil(chars / 4)
}

/**
 * client-side context management(native 미지원 provider 용). 추정 입력토큰이 trigger 를 넘으면
 * 오래된 tool_result 의 content 를 PRUNE_STUB 으로 치환한다 — **블록 제거가 아니라 content 축약**이라
 * tool_use↔tool_result 페어링·블록 순서·thinking 서명이 불변(3사 wire 유효성 보존). 최근
 * keepRecentToolUses 개는 보존한다. turns 를 in-place 변이한다(history 영속 → send 간 누적 경계).
 * 이미 stub 인 것은 건너뛴다(idempotent).
 */
export function pruneToolResults(turns: ChatTurn[], policy: ContextManagementPolicy): void {
  if (approxTokens(turns) <= policy.triggerInputTokens) return
  const results: ToolResultBlock[] = []
  for (const t of turns) {
    if (typeof t.content === 'string') continue
    for (const b of t.content) if (b.type === 'tool_result') results.push(b)
  }
  // 최근 keep 개는 보존 → 그 앞(오래된)만 정리 대상.
  const prunable = results.slice(0, Math.max(0, results.length - policy.keepRecentToolUses))
  for (const r of prunable) {
    if (r.content === PRUNE_STUB) continue // idempotent
    r.content = PRUNE_STUB
    delete r.isError // stale 한 에러 표식 제거
    if (approxTokens(turns) <= policy.triggerInputTokens) return
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/main/core/tools/context.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: 타입체크 + 커밋**

Run: `npm run typecheck`
Expected: 에러 없음.

```bash
git add src/main/core/providers/types.ts src/main/core/tools/context.ts src/main/core/tools/context.test.ts
git commit -m "feat(context-management): provider-중립 정책 타입 + client-side tool_result 가지치기

ContextManagementPolicy(providers/types.ts) + tools/context.ts(approxTokens·
pruneToolResults·DEFAULT_CONTEXT_POLICY). 오래된 tool_result.content 를 stub 치환
(블록 제거 아님 → 페어링·순서·서명 불변)·최근 keep 보존·idempotent·in-place.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: capability 플래그 + `ApiCallOptions.contextManagement` + `ToolLoopDeps.contextPolicy` + loop 라우팅

**Files:**
- Modify: `src/main/core/providers/types.ts` (`ApiCallOptions`·`ApiProvider`)
- Modify: `src/main/core/tools/types.ts` (`ToolLoopDeps`)
- Modify: `src/main/core/tools/loop.ts:79-98` (라우팅)
- Test: `src/main/core/tools/loop.test.ts`

- [ ] **Step 1: 타입 필드 추가**

`src/main/core/providers/types.ts` — `ApiCallOptions` 인터페이스(현 129-158행) 끝(닫는 `}` 직전)에 추가:

```ts
  /**
   * provider-중립 context management 정책. native 지원 provider(anthropic)는 이를 wire
   * `context_management` 로 변환한다. native 미지원 provider 는 무시한다(루프가 client-side 처리).
   */
  contextManagement?: ContextManagementPolicy
```

같은 파일 `ApiProvider` 인터페이스(현 191-197행)에 `model` 아래 필드 추가:

```ts
  /** native server-side context management(예: anthropic Messages API context_management) 지원 여부. */
  readonly nativeContextManagement?: boolean
```

`src/main/core/tools/types.ts` — 상단 import 에 타입 추가하고 `ToolLoopDeps` 에 필드 추가:

```ts
import type { ContextManagementPolicy, ToolDefinition } from '../providers/types'
```

```ts
  /** 최대 반복 횟수(기본 8). */
  maxIterations?: number
  /**
   * context management 정책. undefined → DEFAULT_CONTEXT_POLICY(default-on), null → 비활성.
   * native provider 엔 위임, 그 외엔 client-side 가지치기로 적용한다.
   */
  contextPolicy?: ContextManagementPolicy | null
```

(`tools/types.ts` 현 2행 `import type { ToolDefinition } from '../providers/types'` 를 위 줄로 교체.)

- [ ] **Step 2: 실패하는 라우팅 테스트 작성**

`src/main/core/tools/loop.test.ts` — import 에 `ApiCallOptions`·`PRUNE_STUB`·`DEFAULT_CONTEXT_POLICY` 추가하고(파일 상단 import 블록), `describe('runToolLoop', …)` 안 끝부분에 아래 블록 추가:

상단 import 수정:
```ts
import type { ApiCallOptions, ApiProvider, ChatResult, ChatTurn, ContentBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '../providers/types'
import { DEFAULT_CONTEXT_POLICY, PRUNE_STUB } from './context'
```

`describe` 블록 내부(마지막 `it` 뒤) 추가:
```ts
  // ── context management 라우팅 ──────────────────────────────────────────────
  /** turns 와 chat opts 를 모두 캡처하고 nativeContextManagement 플래그를 설정 가능한 provider. */
  function capturingProvider(native: boolean, script: ChatResult[]): {
    provider: ApiProvider
    opts: ApiCallOptions[]
    turns: ChatTurn[][]
  } {
    const opts: ApiCallOptions[] = []
    const turns: ChatTurn[][] = []
    let i = 0
    const provider: ApiProvider = {
      id: 'fake',
      provider: 'anthropic',
      model: 'm',
      nativeContextManagement: native || undefined,
      async chat(messages, o = {}) {
        turns.push(structuredClone(messages))
        opts.push(o)
        return script[Math.min(i++, script.length - 1)]
      },
    }
    return { provider, opts, turns }
  }

  it('native provider 에는 contextManagement 를 opts 로 싣고 turns 를 prune 하지 않는다', async () => {
    const { provider, opts } = capturingProvider(true, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: { triggerInputTokens: 100, keepRecentToolUses: 2 },
    })
    expect(opts[0].contextManagement).toEqual({ triggerInputTokens: 100, keepRecentToolUses: 2 })
  })

  it('native 미지원 provider: contextManagement 미전달 + 임계 초과 시 오래된 tool_result stub', async () => {
    const big = 'x'.repeat(4000)
    const { provider, opts, turns } = capturingProvider(false, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    const start: ChatTurn[] = [
      { role: 'assistant', content: [toolUse('t0', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: big }] },
      { role: 'assistant', content: [toolUse('t1', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: big }] },
      { role: 'user', content: 'go' },
    ]
    await runToolLoop(provider, start, {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: { triggerInputTokens: 100, keepRecentToolUses: 1 },
    })
    expect(opts[0].contextManagement).toBeUndefined()
    const captured = turns[0]
    expect((captured[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // 오래된 t0 정리
    expect((captured[3].content as ToolResultBlock[])[0].content).toBe(big) // 최근 t1 보존
  })

  it('contextPolicy: null 이면 native 위임도 client-side prune 도 하지 않는다', async () => {
    const big = 'x'.repeat(4000)
    const { provider: nativeP, opts: nativeOpts } = capturingProvider(true, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    await runToolLoop(nativeP, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: null,
    })
    expect(nativeOpts[0].contextManagement).toBeUndefined()

    const { provider: clientP, turns } = capturingProvider(false, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    const start: ChatTurn[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: big }] },
      { role: 'user', content: 'go' },
    ]
    await runToolLoop(clientP, start, {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: null,
    })
    expect((turns[0][0].content as ToolResultBlock[])[0].content).toBe(big) // prune 안 함
  })

  it('contextPolicy 미지정이면 DEFAULT_CONTEXT_POLICY 를 native opts 로 싣는다', async () => {
    const { provider, opts } = capturingProvider(true, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(opts[0].contextManagement).toEqual(DEFAULT_CONTEXT_POLICY)
  })
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts`
Expected: FAIL — 새 4개 테스트가 `opts[0].contextManagement` undefined / prune 미발생으로 실패(loop 라우팅 미구현).

- [ ] **Step 4: loop 라우팅 구현**

`src/main/core/tools/loop.ts` 상단 import 에 추가:
```ts
import { DEFAULT_CONTEXT_POLICY, pruneToolResults } from './context'
```

`runToolLoop`(현 79-98행) — 루프 진입 전 정책 해소 추가하고 `provider.chat` 호출부를 라우팅으로 교체.

현재:
```ts
  const tools = deps.registry.list()
  // 매 iter 의 비용을 누적한다 …
  let usageAcc: TokenUsage | undefined

  for (let iter = 0; iter < max; iter++) {
    const result = await provider.chat(turns, { ...opts, tools, toolChoice: 'auto' })
```

교체 후:
```ts
  const tools = deps.registry.list()
  // context management 정책: undefined → 기본(default-on), null → 비활성.
  const policy = deps.contextPolicy === undefined ? DEFAULT_CONTEXT_POLICY : deps.contextPolicy
  // 매 iter 의 비용을 누적한다 …
  let usageAcc: TokenUsage | undefined

  for (let iter = 0; iter < max; iter++) {
    // provider 분기 없이 capability 플래그만 본다: native(anthropic)는 wire 위임, 그 외는 client-side
    // 가지치기. 둘 다 chat 직전에 적용해 매 라운드 누적을 경계한다.
    const chatOpts: ApiCallOptions = { ...opts, tools, toolChoice: 'auto' }
    if (policy) {
      if (provider.nativeContextManagement) chatOpts.contextManagement = policy
      else pruneToolResults(turns, policy)
    }
    const result = await provider.chat(turns, chatOpts)
```

(`ApiCallOptions` 는 이미 loop.ts 상단에서 import 됨 — 현 1-9행 import 블록에 포함.)

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts`
Expected: PASS (기존 + 신규 4 = 전체 통과).

- [ ] **Step 6: 타입체크 + 커밋**

Run: `npm run typecheck`
Expected: 에러 없음.

```bash
git add src/main/core/providers/types.ts src/main/core/tools/types.ts src/main/core/tools/loop.ts src/main/core/tools/loop.test.ts
git commit -m "feat(context-management): capability 라우팅 — native 위임 vs client-side 가지치기

ApiProvider.nativeContextManagement 플래그 + ApiCallOptions.contextManagement +
ToolLoopDeps.contextPolicy. loop 가 provider 분기 없이 플래그만 보고 native 엔
opts.contextManagement 위임·그 외엔 pruneToolResults. default-on(미지정→기본·null→비활성).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: anthropic native 매핑 + 플래그 + CM 400 fallback

**Files:**
- Modify: `src/main/core/providers/anthropic.ts:248-376`
- Test: `src/main/core/providers/providers.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/main/core/providers/providers.test.ts` — `describe('AnthropicProvider', …)` 블록 내부 마지막에 추가(상단 import 의 `createOpenAiProvider`·`createGoogleProvider`·`baseOpenai`·`baseGoogle` 는 기존재):

```ts
  // ── context management (도구루프 경로) ─────────────────────────────────────
  const cmResp = JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })

  it('contextManagement → context_management.clear_tool_uses + beta 헤더를 싣는다', async () => {
    const { http, calls } = mockHttp(() => ({ body: cmResp }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'x' }], { contextManagement: { triggerInputTokens: 150000, keepRecentToolUses: 3 } })
    const body = JSON.parse(calls[0].init.body)
    expect(body.context_management).toEqual({
      edits: [{
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: 150000 },
        keep: { type: 'tool_uses', value: 3 },
      }],
    })
    expect(calls[0].init.headers['anthropic-beta']).toBe('context-management-2025-06-27')
  })

  it('contextManagement 미지정 → context_management·beta 헤더 부재(무회귀)', async () => {
    const { http, calls } = mockHttp(() => ({ body: cmResp }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([{ role: 'user', content: 'x' }], {})
    const body = JSON.parse(calls[0].init.body)
    expect(body.context_management).toBeUndefined()
    expect(calls[0].init.headers['anthropic-beta']).toBeUndefined()
  })

  it('CM 동봉 요청 400 → context_management·beta 제거 후 1회 재시도', async () => {
    const { http, calls } = mockHttp((_url, init) => {
      const body = JSON.parse(init.body)
      if (body.context_management) return { ok: false, status: 400, body: 'unsupported beta' }
      return { body: cmResp }
    })
    const p = createAnthropicProvider(baseAnthropic, http)
    const out = await p.chat([{ role: 'user', content: 'x' }], { contextManagement: { triggerInputTokens: 150000, keepRecentToolUses: 3 } })
    expect(out.text).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(JSON.parse(calls[1].init.body).context_management).toBeUndefined()
    expect(calls[1].init.headers['anthropic-beta']).toBeUndefined()
  })

  it('nativeContextManagement 플래그를 노출한다(anthropic=true·openai/google 부재)', () => {
    expect(createAnthropicProvider(baseAnthropic).nativeContextManagement).toBe(true)
    expect(createOpenAiProvider(baseOpenai).nativeContextManagement).toBeUndefined()
    expect(createGoogleProvider(baseGoogle).nativeContextManagement).toBeUndefined()
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "context management"`
및 `... -t "nativeContextManagement"`
Expected: FAIL — `body.context_management` undefined·`nativeContextManagement` undefined(미구현).

- [ ] **Step 3: anthropic native 매핑 구현**

`src/main/core/providers/anthropic.ts`:

(a) `body.context_management` 주입 — `if (streaming) body.stream = true`(현 315행) **바로 앞**에 추가:
```ts
      // context management(도구루프 경로): clear_tool_uses edit. native 위임 = 서버 실측 토큰 트리거로
      // 오래된 tool 결과를 per-request 클리어(cache_control·thinking 과 공존). CM 있을 때만 → 무회귀.
      if (opts.contextManagement) {
        body.context_management = {
          edits: [
            {
              type: 'clear_tool_uses_20250919',
              trigger: { type: 'input_tokens', value: opts.contextManagement.triggerInputTokens },
              keep: { type: 'tool_uses', value: opts.contextManagement.keepRecentToolUses },
            },
          ],
        }
      }
```

(b) headers 를 가변 타입으로 바꾸고 beta 헤더 추가 — 현 317-321행:
```ts
      const headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      }
```
교체:
```ts
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      }
      // CM beta 헤더는 context_management 동봉 시에만(비-CM 호출 헤더 부재 = 무회귀).
      if (opts.contextManagement) headers['anthropic-beta'] = 'context-management-2025-06-27'
```

(c) CM 400 fallback — 현 322-332행:
```ts
      const send = (): Promise<HttpResponse> =>
        http(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      // 스트리밍도 동일 가드 — 400 재시도 응답이 OK 면 아래 readStream 경로가 그대로 동작한다(#26 후속 b).
      const res = await sendWithSchemaFallback(send, !!opts.responseSchema, () => {
        // 구조화-출력 400 폴백: format 만 제거하고 effort 등 다른 output_config 필드는 보존한다.
        const oc = body.output_config as Record<string, unknown> | undefined
        if (oc) {
          delete oc.format
          if (Object.keys(oc).length === 0) delete body.output_config
        }
      })
```
교체:
```ts
      const send = (): Promise<HttpResponse> =>
        http(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
      // CM 400 회복탄력성: context_management+beta 만 빼고 1회 재시도(무-CM 으로 강등 = 무회귀, beta
      // 미인식/일시오류 흡수). CM ⊥ responseSchema(모든 schema 호출은 bypassTools → 도구루프 우회)라 한
      // 호출에 둘이 공존하지 않아 schema fallback 과 조합 안전(CM 있을 때 hasSchema=false → 바깥 래퍼 통과).
      const sendCM: () => Promise<HttpResponse> = !opts.contextManagement
        ? send
        : async () => {
            const r = await send()
            if (r.ok || r.status !== 400) return r
            delete body.context_management
            delete headers['anthropic-beta']
            return send()
          }
      // 스트리밍도 동일 가드 — 400 재시도 응답이 OK 면 아래 readStream 경로가 그대로 동작한다(#26 후속 b).
      const res = await sendWithSchemaFallback(sendCM, !!opts.responseSchema, () => {
        // 구조화-출력 400 폴백: format 만 제거하고 effort 등 다른 output_config 필드는 보존한다.
        const oc = body.output_config as Record<string, unknown> | undefined
        if (oc) {
          delete oc.format
          if (Object.keys(oc).length === 0) delete body.output_config
        }
      })
```

(d) `nativeContextManagement: true` 노출 — `createAnthropicProvider` 반환 객체(현 249-253행) `model` 아래 추가:
```ts
  return {
    id: config.id,
    provider: 'anthropic',
    model: config.model,
    nativeContextManagement: true,
    async chat(messages: ChatTurn[], opts: ApiCallOptions = {}): Promise<ChatResult> {
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts`
Expected: PASS (기존 anthropic/openai/google + 신규 4 전체 통과).

- [ ] **Step 5: 타입체크 + 커밋**

Run: `npm run typecheck`
Expected: 에러 없음.

```bash
git add src/main/core/providers/anthropic.ts src/main/core/providers/providers.test.ts
git commit -m "feat(context-management): anthropic native context_management 위임 + 400 fallback

nativeContextManagement:true 노출 + opts.contextManagement → body.context_management
(clear_tool_uses_20250919) + anthropic-beta: context-management-2025-06-27 헤더(CM 있을
때만 = 무회귀). CM 400 시 context_management+beta strip-retry(CM⊥schema 구조적 분리로
schema fallback 과 조합 안전).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 전체 품질 게이트

**Files:** 없음(검증 전용).

- [ ] **Step 1: 4 게이트 실행**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: 4개 전부 성공. `npm test` 통과 수가 기존 대비 +신규(context 7 + loop 4 + providers 4 ≈ +15) 증가, 회귀 0.

- [ ] **Step 2: 게이트 실패 시 수정**

실패하면 해당 Task 로 돌아가 수정·재커밋. lint 경고도 0 으로 유지(AGENTS.md 게이트).

---

## 머지 후 잔여(이번 플랜 비범위)

- **라이브 스모크(수동)**: 실 Anthropic 키로 도구루프 긴 세션 → 응답 `context_management.applied_edits[].cleared_input_tokens` 확인(클리어 발생). 실 OpenAI/Gemini 키로 큰 도구 출력 누적 시 client-side stub 동작.
- **후속 슬라이스**: `clear_thinking`·`compact` 전략 · `cleared_input_tokens` 텔레메트리(usage-accounting 연계) · OpenAI/Gemini native(Responses·Managed Agents 전환 종속) · per-model 트리거 튜닝 · UI 노출.
- **PR**: open 후 Codex 봇 자동리뷰 대기·반영 뒤 머지(`merge-requires-confirmation`). 다중 에이전트 적대 리뷰 별도 수행.

---

## Self-Review

**1. Spec coverage:**
- §6.1 타입(ContextManagementPolicy·contextManagement·nativeContextManagement) → Task 1 Step 1 + Task 2 Step 1 ✓
- §6.2 context 모듈(DEFAULT_CONTEXT_POLICY·PRUNE_STUB·approxTokens·pruneToolResults) → Task 1 ✓
- §6.3 loop 라우팅(contextPolicy·capability 분기) → Task 2 ✓
- §6.4 anthropic native 매핑 + 400 fallback + 플래그 → Task 3 ✓
- §6.5 활성화 default-on(engine 무변경, loop 기본값) → Task 2 Step 4(`policy = deps.contextPolicy === undefined ? DEFAULT : …`) + Task 2 Step 1 미지정 테스트 ✓
- 테스트(§테스트): context.test 7 · loop 라우팅 4 · anthropic CM 4 → Task 1/2/3 ✓

**2. Placeholder scan:** TBD/TODO/"적절히 처리"류 없음. 모든 코드 스텝에 완전한 코드 포함 ✓

**3. Type consistency:**
- `ContextManagementPolicy { triggerInputTokens, keepRecentToolUses }` — 전 Task 동일 필드명 ✓
- `pruneToolResults(turns, policy)`·`approxTokens(turns)`·`DEFAULT_CONTEXT_POLICY`·`PRUNE_STUB` — Task1 정의 ↔ Task2 사용 시그니처 일치 ✓
- `nativeContextManagement`(ApiProvider)·`contextManagement`(ApiCallOptions)·`contextPolicy`(ToolLoopDeps) — Task2 정의 ↔ Task2/3 사용 일치 ✓
- anthropic wire: `context_management.edits[0].{type,trigger,keep}` — 스펙 §wire format ↔ Task3 구현 ↔ 테스트 단언 동일 ✓

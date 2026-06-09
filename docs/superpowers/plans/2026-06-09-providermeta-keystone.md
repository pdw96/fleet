# providerMeta 패스스루 채널 (키스톤) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ContentBlock`/`ChatResult`에 provider 네이티브 메타(서명·thinking)를 불투명하게 운반하는 채널을 신설하고 3 provider 재방출 + `loop.ts` 재구성에 완전 배선하되, 어느 provider도 채우지 않아 런타임 동작은 불변(무동작 패스스루).

**Architecture:** `providers/types.ts`에 opaque provider-namespaced `ProviderMeta`, 블록별 `providerMeta?`, `ThinkingBlock` variant, 순서 보존 `ChatResult.content?`, `assertNever` 가드를 추가한다. Anthropic `mapContent`·Google `mapParts`(둘뿐인 exhaustive ContentBlock switch)에 `case 'thinking'` 재방출 + `default: assertNever`를 더하고, Google에는 `thoughtSignature` echo-when-present를 배선한다. `tools/loop.ts:58-62` 재구성이 `result.content`(있으면)를 우선해 원본 순서를 보존한다. OpenAI는 기존 방어적 폴백이 ThinkingBlock을 안전 무시 → 코드 변경 없음(무회귀 테스트만).

**Tech Stack:** TypeScript(strict) · Electron-vite · vitest(헤드리스) · 순수 코어 엔진(`src/main/core/*`, Electron 비의존).

---

## ⚠ 단일 원자 커밋 (로드맵 "부분 적용 금지")

이슈 #27 로드맵은 이 키스톤을 **"계약 확장 + 패스스루 무동작 1커밋"**으로 못박았다(부분 적용 금지).
따라서 **Task 1–5는 커밋하지 않고 작업 트리에 쌓고, Task 6에서 4 게이트 통과 후 단일 커밋**한다.
(`ThinkingBlock`을 union에 넣고 `assertNever`로 exhaustiveness를 강제하므로, 계약과 3 provider 처리가
같은 커밋에 있지 않으면 typecheck가 깨진다 — 원자성이 타입으로도 강제된다.) 서브에이전트 실행으로
중간 WIP 커밋이 생기면 머지 전 1커밋으로 squash 한다.

각 Task는 red→green TDD로 진행하되, "Commit" 단계는 Task 6에만 있다.

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/main/core/providers/types.ts` | 계약(단일 진실 원천) | `ProviderMeta`·블록 `providerMeta?`·`ThinkingBlock`·`ChatResult.content?`·`assertNever` 추가 |
| `src/main/core/providers/google.ts` | Gemini wire 매핑 | `mapParts` thoughtSignature echo + `case 'thinking'` + `default: assertNever` |
| `src/main/core/providers/anthropic.ts` | Anthropic wire 매핑 | `mapContent` `case 'thinking'`(재방출) + `default: assertNever` |
| `src/main/core/tools/loop.ts` | 도구 루프 턴 재구성 | `:58-62` `result.content` 우선 재구성 |
| `src/main/core/providers/providers.test.ts` | provider 테스트 | Google echo(+neg)·Anthropic thinking 재방출·OpenAI 무회귀 |
| `src/main/core/tools/loop.test.ts` | 루프 테스트 | seam 패스스루·ordered content 재구성·폴백 |

**비범위(후속 소비 커밋, 이 플랜 아님):** Gemini parse가 `thoughtSignature` 적재(#17-P1), Anthropic
`thinking` 파싱 + `thinkingConfig` 노브 + streaming `signature_delta`(#11-thinking). 그래서 이 플랜은
inbound wire 타입(`GooglePart.thoughtSignature`·`AnthropicContent.thinking`)을 **건드리지 않는다** —
파싱이 그것들을 쓰는 후속 커밋의 몫(무동작 커밋을 진짜 무동작으로 유지).

---

### Task 1: 채널 계약 타입 (types.ts)

**Files:**
- Modify: `src/main/core/providers/types.ts` (TextBlock:12-15, ToolUseBlock:23-29, ContentBlock:38, ChatResult:86-95)

이 Task는 순수 additive — 모든 변경이 옵셔널/신규라 typecheck는 **녹색을 유지**한다(ThinkingBlock이
union에 들어가도 두 switch는 default가 없어 thinking에 undefined를 반환할 뿐 에러 아님 — assertNever는
Task 2·3에서 도입). 런타임 동작 변경 없음 → 별도 단위 테스트 없이 typecheck로 검증한다.

- [ ] **Step 1: 계약 타입 추가**

`TextBlock`(현재 L12-15)을 다음으로 교체:

```ts
export interface TextBlock {
  type: 'text'
  text: string
  /** provider 네이티브 메타(Gemini 3 text-part signature 등). 현재 무동작. */
  providerMeta?: ProviderMeta
}
```

`ToolUseBlock`(현재 L23-29)을 다음으로 교체:

```ts
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  /** 도구 입력 인자(JSON 파싱된 값). */
  input: unknown
  /** provider 네이티브 메타(Gemini thoughtSignature 의 집). 현재 무동작. */
  providerMeta?: ProviderMeta
}
```

`ToolResultBlock` 선언 바로 위(현재 L30 직전)에 `ProviderMeta`와 `ThinkingBlock`을 추가:

```ts
/**
 * provider 네이티브 메타의 불투명 패스스루 채널. 키=provider id, 값=provider 소유(불투명).
 * 레이어는 값 내부를 모른다 — verbatim 보존, 재인코딩 금지(서명 byte-exact). 키 네임스페이스로
 * cross-model 누수를 막는다: 각 provider 재방출은 자기 네임스페이스만 읽는다.
 */
export type ProviderMeta = Partial<Record<ApiProviderConfig['provider'], Record<string, unknown>>>

/** 모델 reasoning(extended thinking) 블록. 어시스턴트 턴에서 tool_use 앞에 온다(Anthropic 순서 요구). */
export interface ThinkingBlock {
  type: 'thinking'
  /** 가시 reasoning. redacted/omitted thinking 은 빈 문자열일 수 있다(서명만 보유). */
  text: string
  /** 예: { anthropic: { signature } }. 불투명. */
  providerMeta?: ProviderMeta
}
```

`ContentBlock` union(현재 L38)을 다음으로 교체:

```ts
export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock
```

`ChatResult`(현재 L86-95)에 `content?` 필드를 추가(`toolCalls` 다음 줄):

```ts
export interface ChatResult {
  /** 어시스턴트 텍스트(여러 text 블록을 이어 붙인 값). */
  text: string
  /** 모델이 요청한 도구 호출들(없으면 빈 배열). */
  toolCalls: ToolUseBlock[]
  /**
   * 원본 순서 보존 어시스턴트 블록 전체(thinking→text→tool_use). provider 가 순서/서명을 보존해야
   * 할 때만 채운다. 미설정이면 loop 는 text+toolCalls 폴백(현행 동작 = 무동작 보장).
   */
  content?: ContentBlock[]
  finishReason: FinishReason
  usage?: TokenUsage
  /** 진단용 원본 종료 사유 문자열(provider 네이티브 값). */
  rawFinishReason?: string
}
```

파일 끝(마지막 export 다음)에 `assertNever`를 추가:

```ts
/** 분기 누락을 컴파일 타임에 잡는다 — 새 ContentBlock variant 추가 시 모든 switch default 가 TS 에러. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled ContentBlock variant: ${JSON.stringify(x)}`)
}
```

- [ ] **Step 2: typecheck 녹색 확인**

Run: `npm run typecheck`
Expected: PASS (additive 변경 — 기존 switch는 thinking에 undefined 반환, 아직 에러 아님). 실패하면 멈추고 원인 확인.

---

### Task 2: Google `mapParts` — thoughtSignature echo + exhaustiveness (TDD)

**Files:**
- Test: `src/main/core/providers/providers.test.ts` (GoogleProvider describe 블록 내, 기존 #17-P2 echo 테스트 L353 근방에 추가)
- Modify: `src/main/core/providers/google.ts` (mapParts:54-78)

- [ ] **Step 1: 실패 테스트 작성**

`providers.test.ts`의 `describe('GoogleProvider', ...)` 안, "실제 functionCall.id 가 있으면..." 테스트
(L353-372) **뒤**에 추가:

```ts
  it('ToolUseBlock.providerMeta.google.thoughtSignature 를 functionCall 에 echo 한다 (#17-P1 채널)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '조회' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'fc_a1', name: 'lookup', input: { id: 1 }, providerMeta: { google: { thoughtSignature: 'SIG_XYZ' } } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fc_a1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
    // thoughtSignature 는 Part 레벨(functionCall 의 형제)에 실린다 — Gemini wire 계약.
    expect(body.contents.at(-2)!.parts[0]).toEqual({
      functionCall: { name: 'lookup', args: { id: 1 }, id: 'fc_a1' },
      thoughtSignature: 'SIG_XYZ',
    })
  })

  it('providerMeta 가 없으면 functionCall 에 thoughtSignature 를 싣지 않는다 (echo-only-when-present, #29 규율)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }),
    }))
    const p = createGoogleProvider({ id: 'g', provider: 'google', displayName: 'G', model: 'gemini-3-pro', apiKey: 'k' }, http)
    await p.chat([
      { role: 'user', content: '조회' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fc_a1', name: 'lookup', input: { id: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fc_a1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { contents: Array<{ parts: unknown[] }> }
    expect(body.contents.at(-2)!.parts[0]).toEqual({
      functionCall: { name: 'lookup', args: { id: 1 }, id: 'fc_a1' },
    })
  })
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "thoughtSignature"`
Expected: FAIL — 첫 테스트가 `functionCall`에 `thoughtSignature`가 없어 toEqual 불일치(둘째 negative는 통과).

- [ ] **Step 3: mapParts에 echo + exhaustiveness 배선**

`google.ts`의 `mapParts`(L54-78), `case 'tool_use'`(L62-67)를 다음으로 교체하고 `case 'tool_result'` 뒤에 `default`를 추가:

```ts
      case 'tool_use': {
        // 실제 Gemini id 가 있을 때만 회신한다(합성/부재면 '' → 미전송). 2.x 에 임의 id 를 보내지 않는다.
        const functionCall: Record<string, unknown> = { name: b.name, args: b.input }
        if (b.id) functionCall.id = b.id
        // thoughtSignature 는 functionCall 의 형제인 Part 레벨 필드다(functionCall 안이 아님 — Gemini wire 계약).
        // 실제 있을 때만 echo(echo-only-when-present, #29 규율). byte-exact 보존.
        const part: Record<string, unknown> = { functionCall }
        const sig = b.providerMeta?.google?.thoughtSignature
        if (sig !== undefined) part.thoughtSignature = sig
        return part
      }
      case 'thinking':
        // Gemini thought 파트 재방출은 후속(#11-Gemini-thinking). 현재 Gemini 는 ThinkingBlock 을
        // 생성하지 않아 도달 불가 — exhaustiveness 만족용 방어 텍스트 파트.
        return { text: b.text }
      default:
        return assertNever(b)
```

`google.ts` 상단 import에 `assertNever`가 없으면 `'./types'` import에 추가한다(예:
`import { ..., assertNever } from './types'`).

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "thoughtSignature"`
Expected: PASS (두 테스트 모두). 그리고 `npm run typecheck` PASS(mapParts default가 thinking을 케이스로 처리해 never 충족).

---

### Task 3: Anthropic `mapContent` — thinking 재방출 + exhaustiveness (TDD)

**Files:**
- Test: `src/main/core/providers/providers.test.ts` (AnthropicProvider describe 블록 내)
- Modify: `src/main/core/providers/anthropic.ts` (mapContent:39-53)

- [ ] **Step 1: 실패 테스트 작성**

`providers.test.ts`의 `describe('AnthropicProvider', ...)` 안에 추가:

```ts
  it('ThinkingBlock 을 tool_use 앞에 thinking 블록으로 재방출하고 signature 를 보존한다 (#11-thinking 채널)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    }))
    const p = createAnthropicProvider(baseAnthropic, http)
    await p.chat([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG' } } },
          { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<{ role: string; content: unknown }> }
    const assistant = body.messages.find((m) => m.role === 'assistant')!
    expect(assistant.content).toEqual([
      { type: 'thinking', thinking: '사고', signature: 'SIG' },
      { type: 'tool_use', id: 'tu1', name: 'lookup', input: { id: 1 } },
    ])
  })
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "ThinkingBlock 을 tool_use 앞에"`
Expected: FAIL — `mapContent`에 `case 'thinking'`이 없어 thinking 블록이 `undefined`로 매핑됨 → 첫 원소가 `undefined` ≠ 기대값.

- [ ] **Step 3: mapContent에 thinking 재방출 + exhaustiveness 배선**

`anthropic.ts`의 `mapContent`(L39-53), switch의 `case 'tool_result'`(L49-50) 뒤에 추가:

```ts
      case 'thinking':
        // Anthropic 은 도구 사용 중 thinking 블록을 signature 와 함께 tool_use 앞에 echo 해야 한다(순서·byte-exact).
        return { type: 'thinking', thinking: b.text, signature: b.providerMeta?.anthropic?.signature }
      default:
        return assertNever(b)
```

`anthropic.ts` 상단 import에 `assertNever`가 없으면 `'./types'` import에 추가한다.

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "ThinkingBlock 을 tool_use 앞에"`
Expected: PASS. `npm run typecheck` PASS.

---

### Task 4: loop.ts — ordered content 우선 재구성 + 패스스루 (TDD)

**Files:**
- Test: `src/main/core/tools/loop.test.ts` (import 확장 + 신규 테스트)
- Modify: `src/main/core/tools/loop.ts` (재구성 seam:58-62)

- [ ] **Step 1: 실패 테스트 작성**

`loop.test.ts` 상단 import(L3)를 확장:

```ts
import type { ApiProvider, ChatResult, ChatTurn, ContentBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '../providers/types'
```

`describe('runToolLoop', ...)` 안에 추가:

```ts
  it('어시스턴트 재구성 시 ToolUseBlock.providerMeta 를 보존한다 (키스톤 seam 패스스루)', async () => {
    const meta = { google: { thoughtSignature: 'SIG' } }
    const call: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'echo', input: { a: 1 }, providerMeta: meta }
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [call], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    const assistant = calls[1][1] // [user, assistant, user]
    const block = (assistant.content as ContentBlock[]).find((b): b is ToolUseBlock => b.type === 'tool_use')!
    expect(block.providerMeta).toEqual(meta)
  })

  it('result.content 가 있으면 원본 순서(thinking→tool_use)로 어시스턴트 턴을 재구성한다 (키스톤 ordered)', async () => {
    const thinking: ThinkingBlock = { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'TS' } } }
    const call: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'echo', input: {} }
    const ordered: ContentBlock[] = [thinking, { type: 'text', text: '말' }, call]
    const { provider, calls } = scriptedProvider([
      { text: '말', toolCalls: [call], content: ordered, finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    const assistant = calls[1][1]
    expect((assistant.content as ContentBlock[]).map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect((assistant.content as ContentBlock[])[0]).toEqual(thinking) // 서명 보존
  })

  it('result.content 가 없으면 text+toolCalls 로 재구성한다(현행 동작 유지)', async () => {
    const call: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'echo', input: {} }
    const { provider, calls } = scriptedProvider([
      { text: '말', toolCalls: [call], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    const assistant = calls[1][1]
    expect((assistant.content as ContentBlock[]).map((b) => b.type)).toEqual(['text', 'tool_use'])
  })
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts -t "ordered"`
Expected: FAIL — 현재 loop는 `result.content`를 무시하고 text+toolCalls로 재구성 → `['text','tool_use']` ≠ `['thinking','text','tool_use']`. (seam 패스스루·폴백 테스트는 통과 = 회귀 잠금.)

- [ ] **Step 3: 재구성 seam에 ordered content 우선 분기 추가**

`loop.ts`의 어시스턴트 턴 재구성(현재 L58-62):

```ts
    // 어시스턴트 턴 재구성: (텍스트 있으면) + tool_use 블록들.
    const assistant: ContentBlock[] = []
    if (result.text) assistant.push({ type: 'text', text: result.text })
    assistant.push(...result.toolCalls)
    turns.push({ role: 'assistant', content: assistant })
```

를 다음으로 교체:

```ts
    // 어시스턴트 턴 재구성: provider 가 ordered content(순서·서명)를 보존했으면 그대로 사용하고
    // (thinking→text→tool_use 순서·providerMeta 유지), 아니면 (텍스트 있으면) + tool_use 로 재구성한다.
    let assistant: ContentBlock[]
    if (result.content && result.content.length > 0) {
      assistant = result.content
    } else {
      assistant = []
      if (result.text) assistant.push({ type: 'text', text: result.text })
      assistant.push(...result.toolCalls) // ToolUseBlock.providerMeta 는 스프레드로 자동 보존
    }
    turns.push({ role: 'assistant', content: assistant })
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `npx vitest run src/main/core/tools/loop.test.ts`
Expected: PASS (신규 3개 + 기존 전부). `npm run typecheck` PASS.

---

### Task 5: OpenAI 무회귀 잠금 (테스트 전용 — 코드 변경 없음)

**Files:**
- Test: `src/main/core/providers/providers.test.ts` (OpenAiProvider describe 블록 내)

OpenAI(Chat Completions)는 reasoning 아티팩트가 없고 `mapContent`(if/else + `textOf` 폴백)·
`buildMessages`(filter)가 ThinkingBlock을 안전 무시한다 → **코드 변경 없음**. 무동작과 #31 refusal
경로 불변을 잠근다.

- [ ] **Step 1: 무회귀 테스트 작성**

`providers.test.ts`의 `describe('OpenAiProvider', ...)` 안에 추가:

```ts
  it('어시스턴트 턴의 ThinkingBlock 을 안전 무시하고 tool_calls 메시지를 그대로 만든다(무회귀)', async () => {
    const { http, calls } = mockHttp(() => ({
      body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    }))
    const p = createOpenAiProvider(baseOpenai, http)
    await p.chat([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'SIG' } } },
          { type: 'tool_use', id: 'tc1', name: 'lookup', input: { id: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tc1', name: 'lookup', content: '값' }] },
    ])
    const body = JSON.parse(calls[0].init.body) as { messages: Array<Record<string, unknown>> }
    const assistant = body.messages.find((m) => m.role === 'assistant')!
    // thinking 은 wire 로 새지 않는다(tool_calls + content 만). content 는 텍스트 없음 → null.
    expect(assistant.tool_calls).toEqual([
      { id: 'tc1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } },
    ])
    expect(assistant.content).toBeNull()
    expect(JSON.stringify(body)).not.toContain('SIG')
  })
```

- [ ] **Step 2: 테스트 실행 — 통과 확인 (코드 변경 없이 green)**

Run: `npx vitest run src/main/core/providers/providers.test.ts -t "ThinkingBlock 을 안전 무시"`
Expected: PASS (기존 방어적 폴백이 이미 thinking을 drop). 만약 FAIL이면 멈추고 `buildMessages`(:81-88)가
thinking을 어떻게 다루는지 점검 — 다만 코드 추가 없이 통과해야 정상(무회귀 = 무동작).

> 참고: 기존 refusal 표면화 테스트(providers.test.ts:286)는 변경하지 않는다 — 무동작 커밋이 그 경로를
> 건드리지 않음을 전체 스위트가 함께 잠근다.

---

### Task 6: 4 게이트 + 단일 원자 커밋

**Files:** (커밋 대상)
- `src/main/core/providers/types.ts`
- `src/main/core/providers/google.ts`
- `src/main/core/providers/anthropic.ts`
- `src/main/core/tools/loop.ts`
- `src/main/core/providers/providers.test.ts`
- `src/main/core/tools/loop.test.ts`

- [ ] **Step 1: 전체 품질 게이트 (AGENTS.md 4종)**

Run: `npm run typecheck`
Expected: PASS — 특히 `mapContent`·`mapParts`의 `default: assertNever(b)`가 모든 ContentBlock variant
처리를 컴파일로 강제(누락 시 TS 에러). 통과 = exhaustiveness 보장.

Run: `npm run lint`
Expected: PASS (경고 0).

Run: `npm test`
Expected: PASS (전 스위트 — 신규 키스톤 테스트 + 기존 회귀 전부 green).

Run: `npm run build`
Expected: PASS (electron-vite build = 기동 가능성 smoke).

- [ ] **Step 2: 단일 커밋**

```bash
git add src/main/core/providers/types.ts src/main/core/providers/google.ts src/main/core/providers/anthropic.ts src/main/core/tools/loop.ts src/main/core/providers/providers.test.ts src/main/core/tools/loop.test.ts
git commit -m "feat(providers): providerMeta 패스스루 채널 키스톤 — 무동작 (#27)

ContentBlock/ChatResult 에 provider 네이티브 메타(서명·thinking) 불투명 운반 채널 신설.
opaque provider-namespaced ProviderMeta + ThinkingBlock variant + 순서 보존 ChatResult.content?
+ assertNever exhaustiveness 가드. google.mapParts thoughtSignature echo-when-present(#17-P1 채널),
anthropic.mapContent thinking 재방출(#11-thinking 채널), loop.ts 가 result.content 우선 재구성.
어느 provider 도 채널을 채우지 않아 런타임 불변(무동작). 소비(#17-P1 parse·#11 thinking)는 후속.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: 커밋 확인**

Run: `git log --oneline -1 && git status`
Expected: 키스톤 커밋 1개, 작업 트리 clean.

---

## Self-Review (작성자 체크)

**Spec coverage(스펙 대조):**
- 계약(ProviderMeta·ThinkingBlock·content?·assertNever) → Task 1 ✓
- Google thoughtSignature echo + echo-only-when-present → Task 2 ✓
- Anthropic thinking 재방출 + 순서 → Task 3 ✓
- loop.ts ordered content 우선 + providerMeta seam 보존 → Task 4 ✓
- exhaustiveness(2 switch + assertNever) → Task 2·3 + Task 6 typecheck ✓
- OpenAI 무회귀(#31 refusal·thinking 무누출) → Task 5 ✓
- cross-model 격리(자기 네임스페이스만 read) → Task 2·3의 `providerMeta?.<provider>` 접근으로 구조적 보장 ✓
- IPC 불변 → 변경 파일 전부 main/core 내부 ✓
- inbound wire 타입(GooglePart/AnthropicContent)은 의도적 비범위(후속 parse 커밋) — 스펙 "파싱은 후속"과 정합 ✓

**Placeholder scan:** 모든 Step에 실제 코드/명령. "TBD"/"적절히 처리" 없음 ✓

**Type consistency:** `ProviderMeta`·`ThinkingBlock`·`ChatResult.content`·`assertNever` 명칭이 Task 1 정의와
Task 2–5 사용에서 일치. `providerMeta?.google?.thoughtSignature`(Task 2)·`providerMeta?.anthropic?.signature`
(Task 3)는 `ProviderMeta = Partial<Record<provider, Record<string, unknown>>>` 구조와 정합(값은 unknown,
wire 필드에 할당 가능) ✓

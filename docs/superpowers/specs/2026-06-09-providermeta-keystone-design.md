# 설계: providerMeta 패스스루 채널 (키스톤)

- 날짜: 2026-06-09
- 출처: GitHub 이슈 #27 백로그(Next 티어 최우선). **#17-P1**(Gemini `thoughtSignature` 왕복) +
  **#11-thinking**(Anthropic extended thinking)의 **공동 정규화 계약**. 둘 다 같은 계약 변경이라
  함께 설계해 3 provider 회귀를 한 번에 차단한다.
- 범위(이 커밋 = 옵션 A): **최종 계약 + 무동작 패스스루**. `ContentBlock`/`ChatResult`에 provider
  네이티브 메타(서명·thinking)를 **불투명하게 운반**하는 채널을 신설하고, 3 provider 양 경로
  (파싱 attach·재방출 re-emit)와 `tools/loop.ts:58-62` 재구성 seam에 채널을 **완전 배선**한다.
  단 어느 provider도 아직 채널을 **채우지 않으므로** 런타임 동작은 불변(무동작).
- 비범위(후속 소비 커밋): **#17-P1**(Gemini parse가 `thoughtSignature`를 적재), **#11-thinking**
  (Anthropic thinking 파싱 + `thinkingConfig`/`reasoning_effort` 노브 + streaming `signature_delta`).

> **IPC/preload 계약 불변.** `ContentBlock`/`ChatResult`는 `src/main/core/` 내부 타입이며 렌더러로
> 건너가지 않는다(렌더러는 `ChatMessage.content: string` + `ToolStep`만 받는다). 따라서 preload 재시작
> 함정·검은 화면 리스크 없음 — 순수 코어 엔진 변경이라 GUI 없이 vitest로 전 계층 검증 가능.

## 배경 / 문제 (코드 검증)

3 provider 모두 현재 모델 reasoning/signature를 **떨어뜨린다**. 검증된 현황:

| Provider | 비스트림 reasoning/signature | 스트림 | 재직렬화 echo 요구 |
|---|---|---|---|
| **Anthropic** | 버퍼 파싱이 `text`(anthropic.ts:195-198)·`tool_use`(:199-201)만 추출. `AnthropicContent`(:25-31)에 signature/thinking 필드 없음. ChatResult :202-208. **서명 드롭.** | `readStream`(:92-139) delta union(:106)에 `thinking_delta`/`signature_delta` 없음. ChatResult :138. | **YES(엄격).** 도구 사용 중 직전 어시스턴트 턴의 `thinking` 블록을 **byte-exact signature와 원본 순서로 tool_use 앞에** echo해야 함, 아니면 400 invalid_signature. `mapContent` switch(:39-53)에 `thinking` case·`default` **둘 다 없음**. 재방출 지점 :47-48. |
| **OpenAI** | Chat Completions가 `tool_calls`(:228-233)·`content`(:246) 추출, `refusal`(:235)→synthetic `content_filter`(:237-243). reasoning 아티팩트 없음. | `readStream`(:115-168) delta union(:126-132) content/refusal/tool_calls만. `delta.refusal` 누적(:148, PR #31). | **NO.** Chat Completions는 reasoning에 stateless. `tool_call.id` 상관만 왕복(:84 ↔ :75). `buildMessages`(:68-92)는 `{content,tool_calls}`(:86)로 평탄화 — providerMeta는 wire 필드 없어 무해 드롭. |
| **Google/Gemini** | 인라인 파싱 :216-241, toolCalls 맵 :223-230이 `fc.id/name/args`만. `GooglePart`(:22-25)에 `thoughtSignature` 없음. ChatResult :232-241. **서명 드롭(#17-P1 갭).** | `readStream`(:107-150)이 `p.text`(:125)/`p.functionCall`(:128)만 분기. `funcs[]`(:115) `{id?,name?,args?}` 시그너처 슬롯 없음. | **YES.** 멀티턴 도구 사용에서 같은 `functionCall` 파트에 원본 `thoughtSignature` echo 필수(누락→400). **id 채널은 이미 왕복**: `mapParts`(:54-78)가 `functionCall.id`를 `if(b.id)`(:65)로만, `functionResponse.id`를 `if(b.toolUseId)`(:73)로만 echo(#17-P2/PR #29). **서명 채널은 미왕복.** 재방출 지점 :64-66. |

### 핵심 구조적 통찰 — 키스톤은 구조가 다른 두 산출물로 갈린다

- **Gemini `thoughtSignature`(#17-P1)**: `functionCall`에 1:1 결합 → `ToolUseBlock.providerMeta`에
  자연스럽게 탑승 → `loop.ts:58-62`의 `...result.toolCalls` 스프레드가 **seam 변경 0**으로 자동 보존.
- **Anthropic signed `thinking`(#11-thinking)**: tool_use **앞**에 와야 하는 별도 순서 블록. 그런데
  `ChatResult`(types.ts:86-95)는 출력을 joined `text` 문자열로 평탄화해 **원본 순서를 복구 불가** →
  `ThinkingBlock` variant + 순서 보존 `ChatResult.content?`가 필요(더 큰 변경).
- **OpenAI(Chat Completions)**: reasoning 아티팩트 없음 → providerMeta는 inert 패스스루(단 #31 refusal 보존).

### 확정된 함정

- **`mapContent`(anthropic.ts:42-51)·`mapParts`(google.ts:57-76) switch에 `default` arm이 없다** →
  union에 variant 추가 시 case 누락하면 malformed `undefined`를 wire로 방출 → 400. 원자 커밋에서
  3 switch를 함께 막아야 한다.
- 서명/`thoughtSignature`는 불투명·**byte-exact**. JSON 라운드트립의 whitespace/escaping/재인코딩
  mutation이 무효화 → 400. 레이어는 **verbatim 보존, 재인코딩 금지**.
- 이 앱은 한 도구 루프에 **3 provider 공존** → 한 provider 서명을 다른 provider로 forward하면 무효 →
  providerMeta는 provider-namespace 태깅 필수.
- **echo-only-when-present**(PR #29 규율): 서명이 실제 있을 때만 방출. 무조건 방출은 Gemini 2.x/
  non-thinking 요청을 깬다.

## 계약 (단일 진실 원천 — `src/main/core/providers/types.ts`)

```ts
/** provider 네이티브 메타의 불투명 패스스루. 키=provider id, 값=provider 소유(불투명).
 *  레이어는 값 내부를 모른다 — verbatim 보존, 재인코딩 금지(서명 byte-exact). 키 네임스페이스로
 *  cross-model 누수를 막는다: 각 provider 재방출은 자기 네임스페이스만 읽는다. */
export type ProviderMeta = Partial<Record<ApiProviderConfig['provider'], Record<string, unknown>>>

export interface TextBlock {
  type: 'text'
  text: string
  providerMeta?: ProviderMeta // (Gemini 3 text-part signature 등 미래 대비; 현재 무동작)
}

export interface ThinkingBlock {
  type: 'thinking'
  /** 가시 reasoning. redacted/omitted thinking 은 빈 문자열일 수 있다(서명만 보유). */
  text: string
  /** 예: { anthropic: { signature } }. 불투명. */
  providerMeta?: ProviderMeta
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  providerMeta?: ProviderMeta // (Gemini thoughtSignature 의 집; 현재 무동작)
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock

export interface ChatResult {
  text: string
  toolCalls: ToolUseBlock[]
  /** 원본 순서 보존 어시스턴트 블록 전체(thinking→text→tool_use). provider 가 순서/서명을 보존해야
   *  할 때만 채운다. 미설정이면 loop 는 text+toolCalls 폴백(현행 동작 = 무동작 보장). */
  content?: ContentBlock[]
  finishReason: FinishReason
  usage?: TokenUsage
  rawFinishReason?: string
}

/** 분기 누락을 컴파일 타임에 잡는다 — 새 ContentBlock variant 추가 시 모든 switch default 가 TS 에러. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled ContentBlock variant: ${JSON.stringify(x)}`)
}
```

**불변식:**
- `text`·`toolCalls`는 **그대로 유지**(하위호환). `content?`는 옵셔널 추가 — 미설정이 기본.
- `providerMeta` 값은 **불투명**(레이어가 형태를 모름). provider 재방출만 자기 네임스페이스를 읽는다.
- `textOf`(types.ts:53-59)는 `TextBlock`만 필터 → ThinkingBlock 텍스트는 가시 응답에서 자동 제외(정답).
- `toBlocks`(:47-50)는 영향 없음.

## provider 배선 (양 경로 attach + re-emit, 전부 inert)

각 provider는 채널을 **완전 배선**하되 파싱 측이 아직 채우지 않아 inert다. 후속 소비 커밋은
파싱 분기만 추가하면 된다(re-emit·loop·exhaustiveness는 이미 배선됨).

### Anthropic (`anthropic.ts`)

- `AnthropicContent`(:25-31)에 `thinking?: string`·`signature?: string` 옵셔널 필드 추가
  (wire를 타입/판독 가능하게; **파싱은 후속 #11**).
- 버퍼 파싱(:194-201)·스트림(:106·:122-133)은 thinking 분기 미추가(무동작) — 빌드 지점
  (:202-208/:138)은 `content` 미설정.
- **`mapContent`(:39-53) 재방출**: `case 'thinking'` 추가(→ `{type:'thinking',thinking:b.text,
  signature:b.providerMeta?.anthropic?.signature}`, tool_use **앞** 순서 보장) + **`default: assertNever(b)`**.
  inert(ThinkingBlock을 아무도 생성 안 함).

### OpenAI (`openai.ts`)

- ToolUseBlock 리터럴(:228-233 비스트림 / :160-162 스트림)에 `providerMeta` 스루(항상 undefined).
- `buildMessages`(:68-92)는 providerMeta wire 필드 없음 → 재방출 안 함(무해).
- **#31 refusal 단락(:164-166/:237-243) 불변** — providerMeta 배선이 이 경로를 건드리지 않음을 검증.
- **OpenAI에는 exhaustive ContentBlock switch가 없다**: `mapContent`(:42-53)는 if/else + `textOf`
  방어 폴백(:51), `buildMessages`(:68-92)는 `.some`/`.filter` 기반. 새 ThinkingBlock은 둘 다에서
  **안전 무시**(mapContent → `textOf('')` = 빈 텍스트 파트; buildMessages filter 제외) → assertNever
  비적용. 따라서 OpenAI는 무회귀만 검증(컴파일 가드 대상 아님).

### Google/Gemini (`google.ts`)

- `GooglePart`(:22-25)에 `thoughtSignature?: string` 추가. `funcs[]`(:115) 원소 타입 확장
  (**파싱은 후속 #17-P1**).
- 파싱(:223-230 비스트림 / :141-146 스트림)은 thoughtSignature 미적재(무동작).
- **`mapParts`(:54-78) 재방출**: `case 'tool_use'`에서 `if(b.id) functionCall.id=b.id`(:65) 다음,
  `return {functionCall}`(:66) 전에
  `if (b.providerMeta?.google?.thoughtSignature) functionCall.thoughtSignature = b.providerMeta.google.thoughtSignature`
  추가(echo-only-when-present, PR #29 규율 동일) + **`default: assertNever(b)`**. inert(providerMeta 부재).

### cross-model 격리는 공짜

각 provider 재방출이 `b.providerMeta?.<자기provider>`만 읽으므로, 다른 provider 서명을 잘못 echo할
경로가 **구조적으로 없다**(중앙 strip 로직 불필요).

## loop.ts:58-62 재구성 (`src/main/core/tools/loop.ts`)

```ts
// provider 가 ordered content(순서·서명)를 보존했으면 그대로, 아니면 현행 재구성.
let assistant: ContentBlock[]
if (result.content && result.content.length > 0) {
  assistant = result.content            // thinking→text→tool_use 순서 유지
} else {
  assistant = []
  if (result.text) assistant.push({ type: 'text', text: result.text })
  assistant.push(...result.toolCalls)   // ToolUseBlock.providerMeta 는 스프레드로 자동 보존
}
turns.push({ role: 'assistant', content: assistant })
```

`result.content`가 항상 undefined인 현재 → 항상 else 분기 → 현행 동작과 byte-동일(무동작).

## 전역 exhaustiveness 스윕

코드베이스 전수 grep(`switch (b.type)`·`\.type === '`) 결과, ContentBlock을 분기하는 **exhaustive
switch는 정확히 2곳**(main/core 한정; `cli/output.ts` 매치는 codex 이벤트 union으로 무관):

- `mapContent`(anthropic.ts:39-53)·`mapParts`(google.ts:54-78): `case 'thinking'`(재방출) +
  **`default: assertNever(b)`** 추가 → 향후 variant 추가가 **컴파일 에러로 강제**됨(typecheck 1차 가드).
- OpenAI(`mapContent` if/else + `textOf` 폴백, `buildMessages` filter)는 switch가 아니라 ThinkingBlock을
  안전 무시 → assertNever 비적용, 무회귀만 검증.

향후 `ContentBlock` 소비 지점 추가 시 동일 패턴(명시 case + assertNever)을 따른다.

## TDD 계획 (코어 변경엔 *.test.ts 동반 — AGENTS.md)

PR #26(responseSchema fan-out)·PR #29(functionCall.id 조건부 echo) 테스트 패턴 복제:

- **seam 패스스루**(`tools/loop.test.ts`): providerMeta 실은 ToolUseBlock을 loop.ts:58-62 통과 →
  `turns[].content`에 **byte-동일** 생존 단언(스프레드 보존).
- **ordered content 재구성**(`tools/loop.test.ts`): 합성 `ChatResult.content=[thinking,text,tool_use]`
  → loop가 순서 보존(thinking이 tool_use 앞) 단언. `content` 미설정 → text+toolCalls 폴백 단언.
- **Gemini re-emit**(`providers.test.ts`): 합성 providerMeta(`{google:{thoughtSignature}}`) 실은
  ToolUseBlock → `mapParts`가 `thoughtSignature` echo. **negative**: providerMeta 부재 → 미방출
  (#29 echo-only-when-present 규율).
- **Anthropic re-emit**(`providers.test.ts`): 합성 ThinkingBlock(`{anthropic:{signature}}`) → `mapContent`가
  `{type:'thinking',signature}`를 tool_use **앞**에 byte-exact 방출.
- **OpenAI 무회귀**(`providers.test.ts`): `buildMessages` 출력 불변 + refusal 단락(text:''+content_filter)
  불변 — 스냅샷/동등성.
- **exhaustiveness**: 모든 ContentBlock variant가 3 switch에서 정의된 wire 블록으로 매핑(undefined 금지).
- **4 게이트**(AGENTS.md): `npm run typecheck`·`npm run lint`(경고 0)·`npm test`·`npm run build`.

## 영향 파일

- `src/main/core/providers/types.ts` — `ProviderMeta`·`ThinkingBlock`·블록 `providerMeta?`·
  `ChatResult.content?`·`assertNever`.
- `src/main/core/providers/anthropic.ts` — `AnthropicContent` 필드 + `mapContent` `case 'thinking'`/`default`.
- `src/main/core/providers/openai.ts` — ToolUseBlock providerMeta 스루 + ThinkingBlock 안전 무시 검증(switch 아님).
- `src/main/core/providers/google.ts` — `GooglePart.thoughtSignature?`·`funcs[]` 타입 + `mapParts`
  thoughtSignature echo/`default`.
- `src/main/core/tools/loop.ts` — :58-62 ordered content 우선 재구성.
- 대응 `*.test.ts`(`providers.test.ts`·`tools/loop.test.ts`).

## 비범위 (YAGNI / 후속)

- **#17-P1 Gemini parse** — `thoughtSignature`를 실제 파싱→`providerMeta` 적재(양 경로). re-emit은 이미
  배선됨, parse만 추가.
- **#11-thinking** — Anthropic `thinking` 블록 파싱(양 경로)→ordered `content` 적재, `ApiCallOptions`에
  `thinkingConfig`/`reasoning_effort` 노브, streaming `signature_delta`/`thinking_delta` 누적.
- 채널 형태는 **opaque Record**로 확정(typed discriminated union 비채택 — provider 필드 추가마다 계약
  파손, 라운드트립 계약이 레이어가 provider 내부를 모르길 요구).

## 미해결 / 라이브 검증 사항

- **활성화 커플링(순서 의존)**: `thoughtSignature`는 Gemini thinking이 **활성일 때만** 나타난다.
  무동작 패스스루는 단위 테스트(합성 메타)로 검증 가능하나 e2e는 #11 thinking 노브 전엔 불가. 그리고
  **#11이 Gemini thinking을 켜는 순간 모든 Gemini 도구 라운드가 (이제 존재하는) 서명을 드롭→다음 요청
  400**이 된다. 따라서 **#17-P1(Gemini parse)은 Gemini thinking 활성 전에 선행해야 한다** — 순서 위반 금지.
- 3 provider의 정확한 wire 필드명/형태는 단위 테스트(mock)로 계약을 고정하나, 실제 API의 서명 왕복은
  소비 커밋(#17-P1/#11)에서 라이브 키로 별도 확인. 이 커밋은 채널+plumbing이라 라이브 의존 없음.

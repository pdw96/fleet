# 설계: Gemini 인바운드 thought 캡처 + includeThoughts 노브 (gemini-thinkingconfig 2단계 ②)

- 날짜: 2026-06-15
- 출처: GitHub 이슈 #27 백로그 — gemini-thinkingconfig **2단계 잔여 ②**(thought 파트 분리).
  1단계(PR #53 배선 + PR #54 UI 게이트)가 `thinkingConfig`(2.5=`thinkingBudget:-1`·3.x=`thinkingLevel`)를
  **요청**에 실었으나, **응답의 사고 요약(thought summary)을 캡처하지 않는다**. 키스톤(PR #33)이 깔고
  Anthropic(PR #38)이 채운 `providerMeta`/`ThinkingBlock`/`ChatResult.content?` 채널의 **Gemini 소비자**.
- 범위(이 슬라이스): **Gemini 단독, thought 분리만**. (1) thinking 활성 시 `thinkingConfig.includeThoughts:true`
  전송. (2) 응답 thought 파트(`part.thought===true`)를 버퍼·스트림 양 경로에서 순서보존 `ChatResult.content`로
  파싱하고 `thoughtSignature`를 `providerMeta.google`에 byte-exact 보존. (3) `mapParts`의 도달불가
  thinking 방어코드를 정식 echo(`{thought:true, text, thoughtSignature}`)로 승격해 **멀티턴 tool 루프에서
  thought-part signature 왕복** 완성.
- 착지 방식: 1단계와 동일하게 **provider 경계 안에서 완성**. loop/IPC/렌더러는 이미 키스톤-레디(loop.ts:103이
  `result.content` 순서보존 어시스턴트 턴으로 소비, `mapParts`가 재방출). 전 체인(노브 → 요청 → 파싱 →
  ordered content → loop echo → signature 왕복)은 단위/통합 테스트로 검증.

> **IPC/preload 계약 불변.** `ContentBlock`/`ChatResult`/`ApiCallOptions`는 `src/main/core/` 내부 타입이며
> 렌더러로 건너가지 않는다. 순수 코어 엔진 변경 — preload 재시작 함정·검은 화면 리스크 없음, GUI 없이 vitest로
> 전 계층 검증 가능. SessionsPanel UI는 1단계(PR #54)에서 이미 google thinking 게이트를 열었다(무변경).

## 배경 / 문제 (코드·1차출처 검증)

### 1단계가 남긴 갭

1단계(PR #53/#54)는 다음을 완성했다:
- `resolveThinkingConfig`(`google.ts:64`) — 2.5=`{thinkingBudget:-1}`·3.x=`{thinkingLevel}`·그외 미전송.
- starvation maxOutputTokens floor(`google.ts:249`).
- SessionsPanel google thinking 게이트 + help text.

하지만 **응답 파싱이 thought를 떨어뜨린다**:
- `GooglePart`(`google.ts:71-76`)에 `thought` 필드가 없다 → 사고 파트 식별 불가.
- 요청에 `includeThoughts`가 없어 **애초에 thought 파트가 응답에 오지 않는다**.
- `mapParts`의 `case 'thinking'`(`google.ts:144-147`)은 "Gemini는 ThinkingBlock을 생성하지 않아 도달
  불가"라 주석된 방어 텍스트 파트 — producer가 0이라 inert.

→ functionCall 파트의 `thoughtSignature`는 PR #17(`google.ts:208`·`:318` 캡처, `:132-133` 왕복)이
이미 처리하지만, **thought-part signature는 미캡처·미왕복**이다.

### 왜 중요한가 (값 — gap-verification 통과)

1. **앱 기본 모델에 실제 갭.** `PROVIDER_DEFAULTS.google = 'gemini-3.5-flash'`(gen-3, thinking 모델).
   현재 사고 요약을 0 캡처한다.
2. **멀티턴 tool 루프 정확성(핵심).** loop.ts:103이 `result.content`(thinking 블록 포함)를 다음 라운드에
   재전송한다. includeThoughts를 켜면 응답이 `[thought(sig), …, functionCall]`이 되는데, **thought-part
   signature를 왕복하지 않으면 Gemini 3 함수호출 검증 오류**가 난다(1차출처: "pass back any received
   thought signature exactly as received in the next turn's conversation history, especially with Gemini 3
   models during function calling to avoid validation errors"). 즉 includeThoughts를 켜면서 thought-part
   왕복을 안 하면 **회귀**다 → 둘은 한 슬라이스로 묶여야 한다.
3. **3사 thinking-캡처 패리티 완성.** Anthropic(PR #38)·OpenAI는 thinking 처리 완료. Gemini가 마지막 조각.

### 응답 wire 계약 (확정 — ai.google.dev 1차출처, generateContent 엔드포인트)

Fleet은 classic `…/v1beta/models/{model}:generateContent`(+`:streamGenerateContent?alt=sse`)를 쓴다.
신규 `/v1beta/interactions`(`thinking_summaries:"auto"`)는 **비범위** — 엔드포인트 자체가 다르다.

- **요청**: `generationConfig.thinkingConfig.includeThoughts: true` → 응답에 사고 요약 파트 동봉. 비스트림은
  단일 최종 요약, 스트림도 thought 델타로 도착.
- **thought 파트**: `{ text:"<요약>", thought: true, thoughtSignature?:"<불투명>" }`. `thought` 불리언으로
  일반 답변 파트와 구분. thinking 모델(Gemini 3·2.5)에서 thoughtSignature가 응답 파트에 부여될 수 있다.
- **thoughtSignature**: 불투명(암호화 reasoning). 파싱/재인코딩 금지(byte-exact). 받은 그대로 다음 턴
  히스토리에 echo. functionCall 파트 sig는 현행 유지.

## 계약 (단일 진실 원천 — `src/main/core/providers/types.ts`)

`ThinkingBlock`·`ProviderMeta`(`{google:{...}}` 채널)·블록 `providerMeta?`·`ChatResult.content?`·
`assertNever`는 **전부 이미 존재**. `ApiCallOptions.thinking`도 이미 있다(`google.ts`가 이미 소비).
**타입 추가 0** — 순수 `google.ts` 로직 변경.

**불변식:**
- thinking off(노브 미지정 또는 미지원 모델) = 현행 동작 byte-동일. `includeThoughts` 미전송, `content` undefined.
- `thoughtSignature`는 불투명 — 레이어는 값 내부를 모른다. verbatim 보존.
- thought 파트가 0이면 `content` 미설정 → loop는 text+toolCalls 폴백(무회귀).

## provider 배선 — `google.ts`

### 1. 요청 매핑 — includeThoughts

`resolveThinkingConfig`를 `includeThoughts`까지 싣도록 확장한다. **includeThoughts는 thinking 활성 여부에
연동**하되(thinkingLevel/thinkingBudget 유무와 독립), 미지원 모델(1.5/2.0)은 현행대로 미전송:

```ts
function resolveThinkingConfig(model, knob): Record<string, unknown> | undefined {
  if (!knob || !isThinkingModel(model)) return undefined          // thinking off → 현행
  const cfg: Record<string, unknown> = { includeThoughts: true }  // 활성이면 사고 요약 요청
  if (GEMINI_3.test(model)) { if (knob.effort) cfg.thinkingLevel = thinkingLevelOf(knob.effort) }
  else /* GEMINI_25 */      { cfg.thinkingBudget = -1 }
  return cfg
}
```

- gen-3 + effort 미지정(`thinking:{}`): 이전엔 `undefined`(미전송)였으나 이제 `{includeThoughts:true}`
  전송 — 모델 기본 사고는 유지하되 요약만 요청(reasoning 깊이 불변). **의도된 동작 변경**.
- 2.5: `{includeThoughts:true, thinkingBudget:-1}`.

### 2. 응답 파싱 — thought → ThinkingBlock (버퍼)

`GooglePart`에 `thought?: boolean` 추가. 버퍼 경로(`google.ts:312-329`):

- **`text` 추출 교정**: 현재 `parts.map(p => p.text ?? '').join('')`는 thought 파트 텍스트까지 가시 답변에
  섞는다 → **`!p.thought`인 text만** 이어붙인다(thought는 가시 답변 아님 — Anthropic textOf 규율과 일치).
- **ordered `content`**: thought 파트가 1개 이상이면 parts를 원래 순서대로 매핑해 구성(없으면 undefined →
  현행 byte-동일):

```ts
const hasThought = parts.some((p) => p.thought)
const content: ContentBlock[] | undefined = hasThought
  ? parts.flatMap((p): ContentBlock[] => {
      if (p.thought && typeof p.text === 'string')
        return [{ type: 'thinking', text: p.text,
                  providerMeta: p.thoughtSignature !== undefined ? { google: { thoughtSignature: p.thoughtSignature } } : undefined }]
      if (p.functionCall) return [toToolUse(p.functionCall, p.thoughtSignature)]
      if (typeof p.text === 'string') return [{ type: 'text', text: p.text }]
      return []
    })
  : undefined
```

### 3. 응답 파싱 — thought (스트림)

`readStream`(`google.ts:181-229`)에 thought 누적기 추가. 기존 `text` 평면 누적·`funcs`는 무변경:

```ts
let thoughtText = ''
let thoughtSig: string | undefined
// 파트 루프 분기 추가(text·functionCall 분기 앞):
if (p.thought) { if (p.text) thoughtText += p.text; if (p.thoughtSignature !== undefined) thoughtSig = p.thoughtSignature }
else if (p.text) { text += p.text; onToken(p.text) }   // thought는 onToken으로 안 흘림(가시 토큰 아님)
else if (p.functionCall) { … }                          // 현행
```

- 종료 시 `thoughtText`/`thoughtSig`가 있으면 ordered `content` 재구성. Gemini는 사고를 **답변 앞에**
  방출하므로 `[thinking(thoughtText, sig)?, text 있으면 text, …toolCalls]`로 구성(전역 인덱스 추적 대신
  휴리스틱 — 버퍼는 정확 순서, 스트림은 thought-우선 재구성. Anthropic 스트림과 동일 관용구).
- thought 없으면 `content` undefined → 현행 스트림 동작 byte-동일.

### 4. echo / 왕복 — `mapParts`

`case 'thinking'`(`google.ts:144-147`)을 정식 echo로 승격:

```ts
case 'thinking': {
  // includeThoughts로 받은 사고 요약을 받은 그대로 회신(thought:true + signature). 멀티턴 tool 루프에서
  // thought-part signature 왕복(누락 시 Gemini 3 함수호출 검증오류). echo-only-when-present(#29).
  const part: Record<string, unknown> = { text: b.text, thought: true }
  const sig = b.providerMeta?.google?.thoughtSignature
  if (sig !== undefined) part.thoughtSignature = sig
  return part
}
```

functionCall 파트 sig 왕복(`:131-133`)·`toToolUse`는 무변경.

## loop / orchestrator — 무변경

`loop.ts:103`이 ordered `content`를 어시스턴트 턴으로 사용하고, `mapParts`가 thinking을 재방출한다. 파싱이
content를 채우는 순간 멀티턴 tool 루프에서 thoughtSignature byte-exact 왕복이 완성된다. loop.test.ts:266-281
(키스톤 ordered)이 이미 `[thinking, text, tool_use]` 왕복·signature 보존을 검증 — provider-중립이라 무변경.

## Anthropic / OpenAI — 무변경 (무회귀 확인)

이 슬라이스는 `google.ts`만 만진다. 회귀 테스트로 thinking off 시 body·content 불변 확인.

## TDD 계획 (코어 변경엔 *.test.ts 동반 — AGENTS.md)

`providers.test.ts` Google 섹션에 PR #38 파싱 테스트 패턴 복제:

- **요청(includeThoughts)**: gen-3 effort 지정 → `thinkingConfig={thinkingLevel, includeThoughts:true}`;
  gen-3 effort 미지정(`thinking:{}`) → `{includeThoughts:true}`(thinkingLevel 없음); 2.5 →
  `{thinkingBudget:-1, includeThoughts:true}`. **negative**: thinking 미지정 → thinkingConfig 미설정;
  미지원 모델(gemini-2.0) → 미전송.
- **버퍼 파싱**: thought+text+functionCall 응답 → `content`가 `[thinking(sig in providerMeta), text, tool_use]`
  순서·byte-exact / `text`는 thought 제외 / `toolCalls` 불변. thought-part sig 없는 경우 providerMeta
  undefined. **negative**: thought 없음 → `content` undefined.
- **스트림 파싱**: thought 델타+signature 누적 → ordered `content`·sig 보존 + **thought가 onToken으로 안
  흘림** 단언. **negative**: thought 없음 → `content` undefined(기존 스트림 테스트 그린 유지).
- **왕복(mapParts)**: thinking 블록 입력 → 요청 parts에 `{text, thought:true, thoughtSignature}`. sig
  없으면 thoughtSignature 미전송.
- **라운드트립(loop.test.ts, 선택)**: 파싱된 thinking content를 loop가 push → 다음 send의 mapParts가
  thought-part sig를 echo.
- **기존 테스트 갱신**: thinkingConfig 단언(`:1185`·`:1193`·`:1203`·`:1214`)에 `includeThoughts:true` 추가.
- **4 게이트**(AGENTS.md): typecheck · lint(경고 0) · test · build.

## 영향 파일

- `src/main/core/providers/google.ts` — `GooglePart.thought` · `resolveThinkingConfig` includeThoughts ·
  버퍼 text 교정 + ordered content · 스트림 thought 누적 · `mapParts` thinking echo.
- `src/main/core/providers/providers.test.ts` — 신규/갱신 테스트.
- (선택) `src/main/core/tools/loop.test.ts` — 라운드트립.

## 비범위 (YAGNI / 후속)

- **① 2.5 effort→정수 budget 세분화** — 별도 micro-slice(2.5 모델 한정·기본 모델 무관·서브모델 범위탐지
  400 위험). 현행 `thinkingBudget:-1`(AUTOMATIC) 유지.
- **text-part thoughtSignature 캡처/왕복** — 1차출처의 "first part always has a signature"(주로 이미지생성
  맥락)는 thinking-off 경로에도 해당할 수 있으나, (a) 메모리가 ②를 "thought 파트 분리"로 명시, (b) 스트림
  text-part sig 재구성은 불균형 복잡도(델타 평면 누적과 충돌), (c) thinking-off 경로 무회귀(현행 동작 유지),
  (d) thought-part + functionCall-part sig가 함수호출 왕복(문서화된 검증오류 위험)을 커버 → **비범위, 문서화된
  한계**. 실 키 멀티턴서 text-part-only sig 검증오류가 관측되면 후속 편입.
- **orchestrator가 google 세션에 opts.thinking 지정** — 1단계서 이미 config.thinking 경로 활성. 무변경.

## 미해결 / 라이브 검증 사항

- 단위 테스트(mock)로 wire 계약을 고정한다. 실 Gemini 키의 thought 요약 캡처·멀티턴 signature 왕복
  (thinking+tools)은 머지 후 라이브 키로 별도 스모크. 이 슬라이스는 파싱+노브라 라이브 의존 없음.
- `includeThoughts:true` 고정 전송이 일부 모델서 요약 미생성(thought 파트 0)일 수 있다 → 그 경우 `content`
  undefined로 무해 폴백(현행 동작). 굶음(starvation) 가드는 1단계 floor가 이미 처리.

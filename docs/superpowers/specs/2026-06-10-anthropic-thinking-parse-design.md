# 설계: Anthropic 인바운드 thinking 캡처 + adaptive 요청 노브 (#11-thinking)

- 날짜: 2026-06-10
- 출처: GitHub 이슈 #27 백로그(Next 1순위) · 이슈 #11(provider 옵션 확장 — reasoning/thinking).
  키스톤(PR #33)이 깔아둔 `providerMeta`/`ThinkingBlock`/`ChatResult.content?`/`assertNever` 채널의
  **다음 소비자**. #17-P1(PR #34)이 Gemini `thoughtSignature` 파싱으로 채널을 처음 채운 것과 같은 구조
  — 재방출(`mapContent`)·loop 재구성·exhaustiveness 가드는 **이미 배선**됐고, 남은 건 **인바운드 파싱
  (producer)** + **요청 노브**다.
- 범위(이 슬라이스): **Anthropic 단독**. (1) 응답 thinking 블록을 버퍼·스트림 양 경로에서 순서보존
  `ChatResult.content`로 파싱하고 `signature`를 `providerMeta.anthropic`에 byte-exact 보존. (2) 최소
  요청 노브 `ApiCallOptions.thinking`을 신설해 Anthropic을 **adaptive thinking**(`thinking:{type:'adaptive'}`)
  + `output_config.effort`로 매핑.
- 착지 방식: 키스톤/#12 슬라이스와 동일하게 **provider 경계까지만 완성, orchestrator/IPC/렌더러 미배선**.
  전 체인(노브 → 요청 → 파싱 → ordered content → loop echo → signature 왕복)은 단위/통합 테스트로
  검증한다. 프로덕션 활성화(orchestrator가 `opts.thinking`을 지정)는 **의도적 후속**(한 줄).

> **IPC/preload 계약 불변.** `ContentBlock`/`ChatResult`/`ApiCallOptions`는 `src/main/core/` 내부
> 타입이며 렌더러로 건너가지 않는다. preload 재시작 함정·검은 화면 리스크 없음 — 순수 코어 엔진 변경이라
> GUI 없이 vitest로 전 계층 검증 가능.

## 배경 / 문제 (코드·문서 검증)

### 키스톤이 남긴 갭

키스톤(PR #33)은 Anthropic에서 다음을 **배선만** 해뒀다(producer 0이라 inert):

- `ThinkingBlock` variant + `providerMeta` (`providers/types.ts`).
- `mapContent`(`anthropic.ts:52-54`)의 `case 'thinking'` — 직전 어시스턴트 thinking 블록을 signature와
  함께 tool_use **앞에** 재방출(`{type:'thinking', thinking:b.text, signature:b.providerMeta?.anthropic?.signature}`).
- `loop.ts:58-62` — `ChatResult.content`가 있으면 그대로 어시스턴트 턴으로 사용(순서·providerMeta 보존).

하지만 **응답 파싱이 thinking을 떨어뜨린다**:

- 버퍼 파싱(`anthropic.ts:199-214`)은 `text`·`tool_use`만 추출. `AnthropicContent`(`:26-32`)에
  `thinking`/`signature` 필드가 없다.
- 스트림(`readStream` `:98-145`)의 delta 유니온(`:108-116`)에 `thinking_delta`/`signature_delta`가 없다.

→ producer가 0이라 `mapContent`의 echo가 절대 발동하지 않는다. 그리고 **요청 노브가 없어** thinking을
켤 수도 없다.

### 왜 중요한가 (값)

Anthropic extended thinking + **tool use** 멀티턴에서는 직전 어시스턴트 턴의 thinking 블록을
**signature와 함께 그대로 회신**해야 한다 — 누락/변조 시 에러. (출처: platform.claude.com
extended-thinking/adaptive-thinking 문서.) thinking을 켜고 도구를 쓰는 순간, 파싱이 없으면 signature를
드롭 → 다음 요청 에러. 이 슬라이스가 그 체인을 닫는다.

### 핵심 정정 — 로드맵의 레거시 전제 폐기

이슈 #27 로드맵·키스톤 설계는 레거시 extended thinking 계약(`thinking:{type:'enabled', budget_tokens:N}`
+ streaming `signature_delta`)을 가정했다. **현행 타깃 모델에선 틀렸다**(2026-05-26 기준 권위 문서 확인):

| 모델 | thinking 요청 |
|---|---|
| **Opus 4.8 / 4.7** | **adaptive 전용**. `thinking:{type:'adaptive'}`. `enabled`+`budget_tokens` → **400**. thinking은 `{type:'adaptive'}` 명시할 때만 켜짐. `display` 기본 **`omitted`**(thinking 텍스트 빈값, signature는 존재). |
| **Opus 4.6 / Sonnet 4.6** | `thinking:{type:'adaptive'}` 권장. `budget_tokens` 기능하나 **deprecated**. `display` 기본 `summarized`. |
| **Sonnet 4.5 / Opus 4.5 등 구형** | `enabled`+`budget_tokens`만(adaptive 미지원). |

→ 요청 노브는 **adaptive**로 매핑한다. 레거시 `budget_tokens`는 비범위(후속).

### 응답 wire 계약 (확정)

- **비스트림 thinking 블록**: `{ type:"thinking", thinking:"<텍스트 또는 빈값>", signature:"<불투명>" }`.
  **`signature`는 `display`와 무관하게 항상 존재**. `signature`는 불투명 — 파싱/재인코딩 금지(byte-exact).
- **스트림**: `content_block_start`(`content_block:{type:"thinking", thinking:"", signature:""}`) →
  `content_block_delta`(`delta:{type:"thinking_delta", thinking}`) → `content_block_delta`
  (`delta:{type:"signature_delta", signature}`) → `content_block_stop`. `display:"omitted"`이면
  `thinking_delta` 없이 `signature_delta`만 온다.
- `redacted_thinking`: 현행 adaptive 문서엔 별도 블록 타입이 명시돼 있지 않으나(암호화는 `thinking.signature`로
  운반), 안전-redacted reasoning 으로 방출될 가능성(codex P1)에 대비해 **방어적으로 보존**한다 — 불투명 `data`를
  `providerMeta.anthropic.redactedData`로 byte-exact 캡처(버퍼+스트림), `mapContent`가 `{type:'redacted_thinking',
  data}`로 재방출. 블록이 없으면 발동 안 함(무해). ContentBlock union 확장 없이 opaque providerMeta 채널 재사용.

## 계약 (단일 진실 원천 — `src/main/core/providers/types.ts`)

`ThinkingBlock`·`ProviderMeta`·블록 `providerMeta?`·`ChatResult.content?`·`assertNever`는 **이미 존재**
(키스톤). **추가는 `ApiCallOptions`의 노브 하나뿐**:

```ts
/** 모델 reasoning(extended thinking) 깊이. provider-중립 공통집합. Anthropic: output_config.effort 로 매핑.
 *  Anthropic 전용 상위 티어(xhigh=Opus4.7/4.8, max)는 모델별 가용성이 달라 제외 — 모델-인지 활성화 시 재도입.
 *  (codex P2-3: 중립 타입이 xhigh 를 모든 모델에 노출하면 4.6/Sonnet4.6 에서 400.) */
export type ReasoningEffort = 'low' | 'medium' | 'high'

// ApiCallOptions 에 추가:
/**
 * 모델 reasoning(extended thinking) 노브. 지정 시 provider 가 네이티브 reasoning 을 켠다(미지정=off).
 * 현 슬라이스는 Anthropic 만 adaptive thinking 으로 매핑(OpenAI/Gemini 는 후속).
 */
thinking?: { effort?: ReasoningEffort }
```

**불변식:**
- 노브 미지정 = 현행 동작(thinking off). 하위호환 100%.
- `effort` 미지정 시 effort 필드 미전송 → provider 기본(Anthropic adaptive 기본 = `high`).
- `signature`는 불투명 — 레이어는 값 내부를 모른다. verbatim 보존.

## provider 배선 — `anthropic.ts`

### 요청 매핑 (chat())

```ts
// output_config 는 responseSchema(format) 와 effort 가 공유 → 단일 객체로 병합.
const outputConfig: Record<string, unknown> = {}
if (opts.responseSchema) outputConfig.format = { type: 'json_schema', schema: opts.responseSchema.schema }
if (opts.thinking) {
  // adaptive: 현행 모델(4.6/4.7/4.8·Sonnet4.6) 전용 모드. display:'summarized' 로 thinking 텍스트까지
  // 캡처(4.7/4.8 기본 omitted 보정). signature 는 display 와 무관하게 항상 온다.
  body.thinking = { type: 'adaptive', display: 'summarized' }
  if (opts.thinking.effort) outputConfig.effort = opts.thinking.effort
}
if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig
```

- **stripSchema 교정**: 구조화-출력 400 폴백(`sendWithSchemaFallback`)의 strip 콜백을 **필드 단위**로
  바꾼다 — `output_config.format`만 제거하고 effort는 보존, 비면 `output_config` 삭제(google.ts 방식 복제).
  기존엔 `delete body.output_config`(통째)였지만 effort가 끼면 함께 날아가므로 교정.
- **tool_choice 비호환 가드(codex P2-1a)**: 확장 thinking 은 강제 도구사용(`tool_choice` any/tool)과 비호환
  (문서 명시 400). thinking 켜지면 `toolChoice:'required'`(→any)를 기본 auto 로 낮춘다(`none`/`auto` 는 호환 유지).
  runToolLoop 은 항상 auto 라 실무 경로 무영향 — 직접 chat 호출 방어.
- **reasoning 모드 정규화 — temperature(codex P2 재제기 반영)**: thinking 켜지면 temperature 를 생략한다.
  현행 문서엔 thinking+temperature 비호환 명시가 없으나, 구형 extended thinking 은 temperature=1 을 요구했고
  Opus 4.7/4.8 은 temperature 를 전역 거부한다 → 생략이 항상 안전(400 불가)하고 활성화 시 footgun 제거.
  tool_choice 비호환 가드와 동일한 'reasoning 모드 정규화' 원칙. (단 top_p/top_k 는 현 anthropic.ts 가 애초에
  전송 안 함. 비-thinking 경로의 Opus 4.7/4.8 temperature 전역 거부는 여전히 별도 위생 작업.)

### 버퍼 파싱 (`:199-214`)

- `AnthropicContent`(`:26-32`)에 `thinking?: string`·`signature?: string` 추가.
- `text`/`toolCalls`는 **무변경**(text는 여전히 `c.type==='text'`만 → thinking 제외).
- **ordered `content`**: `parsed.content` 배열을 원래 순서대로 매핑해 구성하되, **thinking 블록이 1개
  이상일 때만 설정**(없으면 undefined → 현행 byte-동일, 무회귀):

```ts
const hasThinking = blocks.some((c) => c.type === 'thinking')
const content: ContentBlock[] | undefined = hasThinking
  ? blocks.flatMap((c): ContentBlock[] => {
      if (c.type === 'thinking')
        return [{ type: 'thinking', text: c.thinking ?? '',
                  providerMeta: c.signature ? { anthropic: { signature: c.signature } } : undefined }]
      if (c.type === 'text' && typeof c.text === 'string') return [{ type: 'text', text: c.text }]
      if (c.type === 'tool_use') return [{ type: 'tool_use', id: c.id ?? '', name: c.name ?? '', input: c.input }]
      return [] // 미지(이미지 등 어시스턴트 응답엔 없음) — content 에서 제외
    })
  : undefined
return { text, toolCalls, content, finishReason: ..., ... }
```

### 스트림 파싱 (`readStream`)

- delta 유니온에 `thinking?`(thinking_delta)·`signature?`(signature_delta) 필드, `content_block.type`에
  `'thinking'` 추가.
- 기존 `text` 평면 누적·`toolAccum`은 **무변경**(회귀 위험 최소화). thinking 전용 누적기를 **추가**:

```ts
const thinkingAccum = new Map<number, { text: string; signature: string }>()
// content_block_start: type==='thinking' → thinkingAccum.set(index, {text:'', signature:''})
// content_block_delta thinking_delta → acc.text += delta.thinking   (onToken 호출 안 함 — reasoning 은 가시 토큰 아님)
// content_block_delta signature_delta → acc.signature = delta.signature
```

- 종료 시 `thinkingAccum`가 비어있지 않으면 ordered `content` 재구성. Anthropic은 thinking을 **항상 먼저**
  방출하므로 `[thinking(인덱스순)…, text 있으면 text 블록, tool_use(인덱스순)…]`로 구성 — 'thinking이
  tool_use 앞'이라는 하드 제약을 충족(전역 인덱스 순서 추적 대신 휴리스틱, 회귀 위험↓). `display:omitted`
  케이스(thinking_delta 없이 signature만)도 `text:''`+signature로 보존.
- thinking 없으면 `content` undefined → 현행 동작과 byte-동일.

## echo / loop — 무변경

`mapContent` `case 'thinking'`(PR #33)이 `{type:'thinking', thinking, signature}`를 tool_use 앞에
재방출하고, `loop.ts:58-62`가 ordered `content`를 그대로 어시스턴트 턴으로 사용한다. 파싱이 content를
채우는 순간 멀티턴 tool 루프에서 signature byte-exact 왕복이 완성된다.

## OpenAI / Gemini — 무변경 (무회귀 확인)

이 슬라이스는 `opts.thinking`을 두 provider에서 **매핑하지 않는다**(읽지 않으므로 무해 무시). 후속에서
OpenAI `reasoning_effort`·Gemini `thinkingConfig`로 매핑. 회귀 테스트로 thinking 미지정 시 body 불변 확인.

## TDD 계획 (코어 변경엔 *.test.ts 동반 — AGENTS.md)

`providers.test.ts`(+ 필요 시 `tools/loop.test.ts`)에 PR #34 파싱 테스트 패턴 복제:

- **버퍼 파싱**: thinking 블록 포함 응답 → `content`가 `[thinking(signature in providerMeta), text, tool_use]`
  순서·byte-exact / `text`는 thinking 제외 / `toolCalls` 불변. **negative**: thinking 없음 → `content` undefined.
- **스트림 파싱**: `thinking_delta`+`signature_delta` 누적 → ordered `content`·signature 보존 + **thinking이
  onToken으로 안 흘림** 단언. `display:omitted`(signature_delta만) → thinking 블록 `text:''`+signature.
  **negative**: thinking 없음 → `content` undefined(기존 스트림 테스트 그린 유지).
- **요청 노브**: `opts.thinking` → `body.thinking={type:'adaptive', display:'summarized'}`; `effort` 지정 →
  `body.output_config.effort`; `responseSchema` 공존 → `output_config`에 format+effort 병합; 구조화-출력 400
  폴백 시 format만 제거·effort 보존. **negative**: `opts.thinking` 미지정 → `body.thinking`/`output_config`
  미설정(현행 동작).
- **라운드트립(loop.test.ts, 선택)**: 파싱된 thinking content를 loop가 어시스턴트 턴으로 push → 다음 send의
  `mapContent`가 signature를 tool_use 앞에 echo.
- **4 게이트**(AGENTS.md): `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

## 영향 파일

- `src/main/core/providers/types.ts` — `ReasoningEffort` 타입 + `ApiCallOptions.thinking?`.
- `src/main/core/providers/anthropic.ts` — `AnthropicContent` thinking/signature 필드 · 요청 매핑(adaptive
  +effort, output_config 병합) · stripSchema 필드단위 교정 · 버퍼 ordered content · 스트림 thinking 누적.
- `src/main/core/providers/providers.test.ts` — 신규 테스트.
- (선택) `src/main/core/tools/loop.test.ts` — 라운드트립.

## 비범위 (YAGNI / 후속)

- **레거시 `budget_tokens`**(Sonnet 4.5/Opus 4.5 구형) — adaptive 미지원 모델용. 수요 증거 시 후속.
- **OpenAI `reasoning_effort` · Gemini `thinkingConfig`** 노브 매핑 — 같은 `ApiCallOptions.thinking`을
  소비하는 후속 슬라이스.
- ~~`redacted_thinking` 블록~~ — codex P1 반영으로 **범위에 편입**(방어적 보존, 위 'provider 배선' 참조).
- **Opus 4.7/4.8 temperature/top_p/top_k 400 스트립** — thinking과 무관한 선재 이슈(현 anthropic.ts가
  temperature를 무조건 전송). 별도 위생 작업.
- **orchestrator/IPC/렌더러 배선** — `opts.thinking`을 실제로 지정하는 활성화. 프로덕션 off 착지(키스톤/#12 동일).

## 미해결 / 라이브 검증 사항

- 단위 테스트(mock)로 wire 계약을 고정한다. 실제 API의 signature 왕복(thinking+tools 멀티턴)은 활성화
  커밋(orchestrator 배선)에서 라이브 키로 별도 확인. 이 슬라이스는 파싱+노브라 라이브 의존 없음.
- `display:'summarized'` 고정 전송이 4.6/Sonnet4.6에선 no-op, 4.7/4.8에선 thinking 텍스트 opt-in. signature는
  전 모델 공통이라 echo 값(=핵심)은 display와 독립적으로 항상 확보된다.

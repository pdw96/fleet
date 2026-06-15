# provider-중립 context management 설계 (2026-06-15)

## 배경 / 문제

도구 루프(`tools/loop.ts`)는 매 라운드 어시스턴트 `tool_use` 턴과 사용자 `tool_result` 턴을 `turns`
배열에 **무제한 누적**한다(최대 8라운드). 큰 도구 출력(파일 내용·명령 로그)이 라운드마다 쌓이고,
`api-session.ts` 의 누적 경로는 이 `turns`(=`working`)를 통째로 `history` 에 커밋하므로
(`api-session.ts:153-154` `history.push(...working)`) **send 간에도 도구 라운드가 영구 누적**된다.
결과적으로 긴 도구 세션은 어느 provider 든 컨텍스트 윈도를 압박해 truncation / 비용 폭증 / context-rot
을 일으킨다. 이는 Fleet 의 핵심 워크로드(오케스트레이터 implementer 도구 루프)를 직격하는 갭이다
(`fleet-cutoff-gap-analysis` 메모리, medium·최고가치).

## 핵심 통찰 — 문제는 provider-중립, native 도달성만 비대칭

누적 문제는 **4사(anthropic·openai·google·openai-compatible) 공통**이다. 반면 server-side context
management 기능은 provider 마다 *다른 API 표면*에 있어, Fleet 이 현재 쓰는 엔드포인트에서의 도달성이
다르다(현행문서 검증, 2026-06):

| Provider | native 기능 | Fleet 현재 엔드포인트에서 도달? |
|---|---|---|
| **anthropic** | `context_management`(Messages API `/v1/messages`) | ✅ 도달 — `anthropic.ts` 가 Messages API 직접 사용 |
| **openai** | `context_management:[{type:"compaction"}]` + `responses.compact`(**Responses API 전용**) | ❌ `openai.ts:22` Chat Completions → Responses 전환 선행 필요 |
| **google** | 자동 compaction(~135k, **Managed Agents API 전용**) | ❌ `google.ts:23,362` generateContent → Managed Agents 전환 선행(루프 소유권도 충돌) |
| **openai-compatible** | (게이트웨이별 상이) | ❌ `openai.ts:378` Chat Completions 경로 |

→ 설계 결론: context management 를 **provider-중립 정책**으로 두되 실행만 분기한다.
- **anthropic** → native `context_management` 위임(서버 실측 토큰 트리거·thinking/서명/구조를 서버가 정확
  처리·1차 메커니즘).
- **나머지 3사** → `loop.ts` **client-side 가지치기**(보편 폴백). 훗날 OpenAI→Responses·Gemini→Managed
  Agents 전환 시 각 provider 가 `nativeContextManagement` 플래그를 켜면 자동으로 native 경로로 승격.

provider 분기를 코어에 하드코딩하지 않는다 — `ApiProvider.nativeContextManagement` capability 플래그만
검사한다(레지스트리 패턴, "코어 분기문 금지").

## 목표 (이번 슬라이스 — 슬라이스 1)

1. provider-중립 `ContextManagementPolicy` 타입 + `ApiProvider.nativeContextManagement` capability +
   `ApiCallOptions.contextManagement` 패스스루를 코어에 도입.
2. anthropic native 매핑: `clear_tool_uses_20250919` edit + beta 헤더 `context-management-2025-06-27`,
   CM 400 회복탄력성(strip-retry).
3. client-side 가지치기(`tools/context.ts`): 오래된 `tool_result.content` 를 stub 치환(블록 제거 아님).
4. **default-on**(도구루프 경로, 보수 트리거 150k·keep 3). `ToolLoopDeps.contextPolicy` 로 비활성/튜닝.
5. 전략은 **`clear_tool_uses` 만**(루프 직격·최고가치).

## 비범위 (후속 슬라이스)

- **`clear_thinking_20251015`·`compact_20260112`** 전략(pause_after_compaction·압축블록 응답 처리 복잡).
- **응답 `context_management.applied_edits[].cleared_input_tokens` 텔레메트리** 수집(usage-accounting 연계).
- **OpenAI/Gemini native 위임**(각각 Responses API·Managed Agents API 전환 종속 — 별도 Epic).
- **client-side 가지치기 대상 확장**(현재 tool_result 만; thinking/text/image 정리는 비범위).
- **UI 노출/per-call 설정**: 슬라이스 1 은 코어 default-on·UI 없음(shared/IPC/preload/renderer 무변경 →
  dev 재시작 함정 회피). per-model 트리거 튜닝도 후속.

## 현행문서 검증 결과 (context7 1차출처 + 코드)

### wire format (요청)
- 헤더: `anthropic-beta: context-management-2025-06-27`(beta 헤더 목록서 검증).
- 바디: `context_management: { edits: [{ type:"clear_tool_uses_20250919", trigger:{type:"input_tokens",
  value}, keep:{type:"tool_uses", value} }] }`.

### 검증된 결정 근거(착수 전 추측 → 검증)
| 주장 | 판정 |
|---|---|
| anthropic CM = stateless per-request, 응답은 클리어량만 보고(`context_management.applied_edits[].cleared_input_tokens/cleared_tool_uses`), carry-forward 윈도 미반환 | ✅ 검증 — client 는 계속 full 전송, 서버가 per-request 클리어. OpenAI `responses.compact`(윈도 반환)와 상이 |
| CM ⊥ responseSchema | ✅ 검증·강화 — orchestrator 의 **모든** responseSchema 호출이 `bypassTools:true`(`plan.ts:108,147`·`orchestrator.ts:229`) → 도구루프 우회. CM 은 루프에서만 주입 → 구조적 서로소. **fallback 충돌 원천 부재** |
| CM ↔ `cache_control` 공존 | ✅ 지지 — 응답이 `context_management` + 캐시 `diagnostics`(cache_miss_reason) 동시 운반 → 상호운용 설계. 클리어가 프리픽스 바꿔 일부 캐시미스 유발은 예상·diagnostics 로 표면화 |
| openai=Chat Completions·google=generateContent | ✅ 검증(`openai.ts:22,378`·`google.ts:23,362`) → native 미도달 확정 |
| 트리거 150k 출처 | 정정 — 150k 는 *compact* 문서 기본값. clear_tool_uses 엔 문서상 기본 없음 → **우리가 고른 보수값** |

## 설계

### 1. 타입 (`providers/types.ts`)

```ts
/** provider-중립 context management 정책. anthropic 은 native wire 로, 그 외는 client-side 가지치기로 해석. */
export interface ContextManagementPolicy {
  /** 누적 입력토큰(anthropic=서버 실측·그 외=client 추정)이 이 값을 넘으면 정리. */
  triggerInputTokens: number
  /** 유지할 최근 도구결과 수. 이보다 오래된 tool_result 부터 정리. */
  keepRecentToolUses: number
}
```
- `ApiCallOptions` 에 `contextManagement?: ContextManagementPolicy` 추가(루프가 native provider 에만 실음).
- `ApiProvider` 에 `readonly nativeContextManagement?: boolean` 추가(anthropic 만 true).

> 코어 전용(`providers/types.ts`) — shared/IPC/preload 무변경.

### 2. context 모듈 (`tools/context.ts`, 신규)

정책 기본값 + client-side 가지치기를 독립 테스트 가능한 단위로 분리(loop.ts 비대화 방지).

- `export const DEFAULT_CONTEXT_POLICY: ContextManagementPolicy = { triggerInputTokens: 100_000,
  keepRecentToolUses: 3 }` (트리거 100k — 아래 "Codex 리뷰 반영" 참조)
- `const PRUNE_STUB = '[이전 도구 결과 정리됨 — 컨텍스트 관리]'`
- `approxTokens(turns): number` — `Σ chars / 4`(텍스트·tool_result content·tool_use input(JSON)·thinking
  text·image data 길이 합). 정밀 토크나이저 없음 → 보수적 추정(코드/JSON 은 실토큰이 더 빽빽해 늦게-보수적
  발화, 안전 방향).
- `pruneToolResults(turns, policy): void` — **블록 제거가 아니라 content stub 치환**(가장 안전한 연산):
  1. `approxTokens(turns) ≤ trigger` → no-op 반환.
  2. 전 turns 의 `tool_result` 블록을 순서대로 수집. 최근 `keepRecentToolUses` 개는 보존.
  3. 오래된 것부터(이미 stub 인 것·content===PRUNE_STUB 은 건너뜀=idempotent) `content`=PRUNE_STUB·
     `isError` 제거(stale). 매 치환 후 재추정, `≤ trigger` 되면 중단.
  4. 모두 stub 해도 초과면 best-effort 로 종료(보존 대상 keep 은 손대지 않음).
  - **불변식**: tool_use↔tool_result 페어링·블록 순서·thinking 서명 **불변**(text/thinking/tool_use 미접촉,
    블록 수 불변). → 3사 전부 wire 유효성 보존(OpenAI `tool` 메시지 페어링·Gemini functionResponse·anthropic
    thinking echo 안전). `turns` in-place 변이 → `history`(=working) 영속으로 send 간 누적도 경계.

### 3. 도구 루프 라우팅 (`tools/loop.ts`)

- `ToolLoopDeps` 에 `contextPolicy?: ContextManagementPolicy | null` 추가(tools/types.ts). `undefined` →
  `DEFAULT_CONTEXT_POLICY`(default-on), `null` → 비활성.
- `runToolLoop` 진입 시 `const policy = deps.contextPolicy === undefined ? DEFAULT_CONTEXT_POLICY :
  deps.contextPolicy`.
- 매 iteration `provider.chat` 직전:
  ```ts
  const chatOpts: ApiCallOptions = { ...opts, tools, toolChoice: 'auto' }
  if (policy) {
    if (provider.nativeContextManagement) chatOpts.contextManagement = policy   // 서버 위임, 미-prune
    else pruneToolResults(turns, policy)                                        // client-side, 미-위임
  }
  const result = await provider.chat(turns, chatOpts)
  ```
- provider 분기 없음 — `nativeContextManagement` 플래그만 검사.

### 4. anthropic native 매핑 (`anthropic.ts`)

- 반환 provider 객체에 `nativeContextManagement: true` 추가.
- chat() 에서 `opts.contextManagement` 있으면:
  ```ts
  body.context_management = { edits: [{
    type: 'clear_tool_uses_20250919',
    trigger: { type: 'input_tokens', value: opts.contextManagement.triggerInputTokens },
    keep:    { type: 'tool_uses',    value: opts.contextManagement.keepRecentToolUses },
  }] }
  ```
  그리고 `headers` 에 `'anthropic-beta': 'context-management-2025-06-27'` 추가(CM 있을 때만 → 비-CM 호출
  헤더 부재=무회귀). `headers` 를 가변 객체로 빌드.
- **CM 400 회복탄력성**: CM 동봉 요청이 400 이면 `context_management`+beta 헤더만 제거 후 1회 재시도
  (현행 무-CM 동작으로 강등=무회귀, beta 미인식/일시오류 흡수). 기존 `sendWithSchemaFallback` 과 **조합 안전**:
  ```ts
  const stripCM = () => { delete body.context_management; delete headers['anthropic-beta'] }
  const sendCM = !opts.contextManagement ? send : async () => {
    const r = await send(); if (r.ok || r.status !== 400) return r; stripCM(); return send()
  }
  const res = await sendWithSchemaFallback(sendCM, !!opts.responseSchema, stripSchema)
  ```
  CM ⊥ schema(검증 #2)라 한 호출에 둘 중 하나만 존재 → 중첩 모호성 없음(CM 있을 때 hasSchema=false 라
  바깥 래퍼는 통과). 스트리밍도 동일(최종 OK 면 readStream 진입).
- cache_control(`anthropic.ts:284`)·thinking·tools 와 공존 — 코드 변경 불필요(검증 #3).

### 5. 활성화 (default-on)

- `engine.ts:371` toolDeps 클로저 **무변경** — `contextPolicy` 미지정 → loop 가 `DEFAULT_CONTEXT_POLICY`
  적용(default-on). 보수 트리거(150k)라 평소 소형 세션엔 no-op(무회귀), 큰 세션에서만 동작.
- client-side 는 비-beta(순수 Fleet 로직)·anthropic native 는 §4 400-fallback 안전망 → default-on 안전.
- 테스트/미래 튜닝은 `deps.contextPolicy` 주입으로(예: `null` 비활성).

## 데이터 흐름

```
api-session.runChat → runToolLoop(provider, turns, opts, deps)
  policy = deps.contextPolicy ?? DEFAULT_CONTEXT_POLICY
  loop:
    provider.nativeContextManagement ?
        chatOpts.contextManagement = policy            // anthropic
      : pruneToolResults(turns, policy)                // openai/google/compatible (turns in-place stub)
    provider.chat(turns, chatOpts)
      └ anthropic: body.context_management + beta 헤더 (400 시 strip-retry) → 서버 per-request 클리어
      └ 그 외: 가지치기된 turns 그대로 전송
turns(=working) 변이 → history 영속(send 간 누적 경계, client-side 경로)
```

## 테스트 (TDD)

`tools/context.test.ts`(신규):
- `approxTokens`: 빈/문자열/블록 혼합 추정.
- `pruneToolResults`: 임계 이하 no-op / 초과 시 오래된 tool_result 만 stub·최근 keep 보존 / idempotent
  (재호출 무변화) / text·thinking·tool_use 미접촉 / 블록 수·페어링·순서 불변 / 전량 stub 후에도 초과면
  keep 보존.

`tools/loop.test.ts`(확장):
- `nativeContextManagement:true` provider → `chat` opts 에 `contextManagement` 실림·turns 미-prune.
- 플래그 없음 → `contextManagement` 미전달·turns prune 호출(임계 초과 시 stub).
- `deps.contextPolicy:null` → 양쪽 경로 모두 비활성(opts 미전달·미-prune). 미지정 → 기본 정책 적용.

`providers.test.ts`(anthropic describe):
- `opts.contextManagement` → `body.context_management.edits[0]`(type/trigger/keep) + beta 헤더 방출.
- CM 없음 → `context_management`·beta 헤더 부재(무회귀).
- CM 동봉 요청 400 → context_management+beta 제거 후 1회 재시도(2번째 body 에 부재) → 성공 파싱.
- `nativeContextManagement:true` 노출. (openai/google provider 는 플래그 부재 확인.)

4 게이트(typecheck·lint·test·build) + 다중 에이전트 적대 리뷰 + Codex 봇 리뷰.

## 영향 범위

`src/main/core/providers/types.ts`(타입) · `src/main/core/providers/anthropic.ts`(native 매핑) ·
`src/main/core/tools/types.ts`(`contextPolicy`) · `src/main/core/tools/context.ts`(신규) ·
`src/main/core/tools/loop.ts`(라우팅) (+ 각 테스트). **engine/IPC/preload/renderer/shared 무변경**
(default-on 은 loop 내장 기본값 상속, config 패스스루).

## 미해결 / 리스크

- **client-side 추정 부정확성**: chars/4 는 근사 — 코드/JSON 밀집 토큰에선 실토큰이 더 커 늦게 발화(보수적,
  안전 방향). 정밀 측정(provider count_tokens)은 비범위.
- **anthropic 로컬 history 무경계**: native 는 full 전송 필요(서버가 클리어) → 로컬 history 는 계속 누적·
  재업로드. 모델 컨텍스트는 서버-경계라 정확성 무해(업로드 대역만 비효율). 100k 메시지 요청 한도와 무관.
- **Gemini 1M 윈도에 보수적 트리거**: context-rot 완화 효과로 정당(Google 문서도 명시), per-model 튜닝 후속.
- **default-on + beta**: §4 400-fallback 이 beta 미인식/변경 시 무-CM 으로 강등(무회귀 보장).

## Codex 리뷰 반영 (PR #64, post-review)

세 P2 전건 검증 후 반영(전부 기존 기능을 깨지 않고 정합성을 높이는 방향):

1. **미전송 최신 tool_result 턴 보존** (P2#1) — client-side prune 은 도구루프 iter 시작에 도는데, 직전 iter 가
   추가한 tool_result 턴은 아직 모델에 전송되지 않았다. 한 어시스턴트 턴이 `keepRecentToolUses` 초과 병렬
   도구를 호출하면 그 미전송 배치 일부가 모델이 보기 전에 stub 돼 *명시 요청한 출력 없이* 답하게 된다. →
   `pruneToolResults` 가 **마지막 tool_result 턴을 정리 대상에서 제외**하고, 그 앞(이미 전송된) 결과만 keep
   윈도 적용. (`lastToolResultTurnIndex`)
2. **copy-on-write** (P2#2) — `api-session` 의 `working=[...history]` 는 ContentBlock 객체를 공유하므로
   in-place 변이는 미커밋 send(throw)에도 history 를 손상시킨다(원자 커밋 위반). → stub 시 턴·content·블록을
   **클론**해 turns 슬롯만 교체. 성공 시 커밋(history=working)으로 영속, 실패 시 history 무손상.
3. **기본 트리거 150k→100k** (P2#3) — 150k 는 비-native 메인스트림 윈도(gpt-4o·gpt-4o-mini **128k**)보다 커서
   작은-윈도 모델이 prune 전에 컨텍스트 초과. 100k 로 낮춰 메인스트림 아래로. 더 작은(로컬·openai-compatible)
   ·dense 모델은 `contextPolicy` 하향, 모델-인지 임계는 #13 후속(부분 완화). native 는 서버 실측이라 정밀.

검증: 4게이트 녹색(test 729→**731**, context 12→14: 미전송배치·copy-on-write 신규 테스트). client-side prune
테스트는 미전송-턴 제외 반영해 ≥3 전송 결과로 갱신.

### 라운드 2 (재리뷰 P2 2건 — fresh-batch 정밀화)

라운드1 의 fresh-batch 보존이 두 방향에서 불완전했다(context7 로 `clear_tool_uses` 시맨틱 검증 — `keep` 은
**tool_use 블록 단위 "가장 최근 N개"**, 턴 경계·최신 배치 보호 없음):

4. **client: "마지막 *턴*" 한정** (P2#A) — 라운드1 은 *어디에 있든* 마지막 tool_result 턴을 제외해서, 새 send
   시작(`working=[...history, newPrompt]`)의 *이미 전송된* 과거 배치까지 보호 → 영영 prune 불가, 큰 과거 배치면
   여전히 초과. `lastToolResultTurnIndex`(마지막 tool_result 턴) → `freshToolResultBatchSize`(**마지막 턴이
   tool_result 일 때만** fresh)로 교체. api-session history 는 항상 assistant 로 끝나 새 send 첫 prune 엔
   마지막 턴=user → fresh 0 → 과거 배치 정상 정리.
5. **native: fresh 배치만큼 keep 상향** (P2#B) — server `clear_tool_uses` 도 한 어시스턴트 턴의 병렬 호출이
   `keep` 초과면 모델이 보기 전 일부를 클립한다. loop 가 native 에 정책을 실을 때 `keep =
   max(policy.keep, freshToolResultBatchSize(turns))` 로 이번 요청 한정 상향(client 대칭).

검증: 4게이트 녹색(test 731→**733**: 새-send 과거배치 정리·native fresh-batch keep 상향 신규). 새-send
client 테스트는 갱신(과거 배치 정리 반영).

### 라운드 3 (재리뷰 P2 4건 — 패리티·격리·예산·확장)

6. **native keep 패리티** (P2#1) — 라운드2 의 `max(fresh, policy.keep)` 는 fresh>keep 일 때 직전 kept 결과를
   버려 client(=fresh 배치 + 그 앞 keep 보존)와 불일치 → `keep = fresh + policy.keepRecentToolUses` 로 정정.
7. **anthropic CM+schema 필드 격리** (P2#2) — 둘 다 set 이고 schema 가 400 을 유발하면 기존 sendCM 래퍼가 CM 까지
   함께 삭제 → 둘 다 빠진 채 성공(CM 의존 호출 회귀). PR #63 패턴으로 **한 번에 하나씩 제거**(①schema→②CM→③둘다)
   해 무고한 필드 보존. (현 오케스트레이터는 CM⊥schema 라 미도달이나 코드 차원 보장.)
8. **tools 를 prune 예산에** (P2#3) — client 트리거가 `approxTokens(turns)` 만 봐서 동봉되는 `tools`(큰 MCP
   스키마) 누락 → turns 임계 이하인데 turns+tools 윈도 초과면 prune 미발화. `overheadTokens`(=도구정의 추정,
   1회 계산)를 트리거 판단에 합산.
9. **작은 결과 확장 방지** (P2#4) — `content.length ≤ PRUNE_STUB.length` 면 치환이 외려 키우므로 건너뜀.

선제 적대검증(opus) — 7수정 정확 확인·신규 Critical 0. 보강: CM+schema 의 CM-유발 400(②③)·지속 400 throw
테스트 2건(Finding D), `JSON.stringify(tools)` 가드(Finding B). 검증: 4게이트 녹색(test 733→**739**).

### 라운드 4 (재리뷰 P2 1건 — CJK/dense 과소추정)

10. **approxTokens 보수화** (P2) — chars/4 는 비-ASCII(CJK 등 영어 대비 2~4배 조밀)·dense 콘텐츠를 심하게
    과소추정한다. **트리거 용도에선 과소추정이 위험**(실토큰 > 추정이면 prune 전에 윈도 초과 — 100k 트리거
    128k 모델이 실제론 넘는데 미발화) — 원래 주석의 "과소=안전" 은 역논리였다. ASCII 는 ~4 char/token 유지,
    **비-ASCII 는 1 token/char 이상**으로 보수 추정(ASCII 전용 입력은 기존 동작 byte-동일). 2차 효과로 한국어
    `PRUNE_STUB`(~19 토큰)이 비싸져 **skip-small 비교를 char→토큰 기반**(`estTokens(content) ≤ estTokens(STUB)`)으로
    함께 전환 — 짧은 ASCII 결과를 char 로만 보면 토큰상 외려 키우던 갭 차단. 검증: 4게이트 녹색(test 739→**740**:
    CJK 보수추정 신규). 잔여: ASCII-dense 코드(~3 char/token)는 #13(모델-인지)·contextPolicy 하향으로 커버.

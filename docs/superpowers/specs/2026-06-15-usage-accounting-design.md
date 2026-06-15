# usage-accounting 설계 (2026-06-15)

## 배경 / 문제

3 provider(anthropic/openai/google)는 `ChatResult.usage`(`TokenUsage` — input/output/cache 토큰)를
이미 채운다(`anthropic.ts`·`openai.ts`·`google.ts`). 그러나 **소비처가 0**이다:

- `session/api-session.ts` `unwrap()` 은 `result.text` 만 반환하고 `result.usage` 를 폐기한다.
- `tools/loop.ts` `runToolLoop()` 은 iter 마다 `provider.chat` 을 호출하지만 **마지막 iter 의
  ChatResult 만 반환**한다 → 도구루프(최대 8라운드)의 이전 호출 비용이 통째로 누락된다.
- `LlmSession.send()` 계약이 `Promise<string>` 이라 usage 를 흘릴 채널이 없다.

결과: 토큰/비용 가시성 0. 비용 가시성·예산 가드의 전제가 빠져 있다.

## 목표 (이번 슬라이스)

usage 를 **기존 event 인프라**(`onAudit → store.appendEvent`)로 흘려 즉시 관측 가능하게 한다.
모델-무관. `send()` 의 `string` 계약을 깨지 않는다. shared/types·IPC·preload·renderer 무변경.

비범위(후속 슬라이스): 비용(원화/달러) 환산, 예산 가드/차단, run 단위 집계, 전용 UI 패널.

## 설계 (접근 A — 세션 sink → event 로그)

### 1. 도구루프 누적 (`tools/loop.ts`)

- 헬퍼 `addUsage(acc, next)`: `inputTokens·outputTokens·cacheCreationInputTokens·cacheReadInputTokens`
  를 합산한다. **둘 다 미설정이면 결과도 undefined**(전 구간 usage 없으면 무회귀). 한쪽만 있으면
  있는 값만 누적.
- 루프에서 매 `provider.chat` 결과를 `acc = addUsage(acc, result.usage)` 로 누적.
- 종료 반환(`result.toolCalls.length === 0`) 시 `{ ...result, usage: acc }` 반환 → 최종 호출 포함
  전체 라운드 합산. 도구루프 미사용 단발 chat 경로는 변화 없음(provider.chat 직접 반환).

### 2. usage 표면화 (`session/api-session.ts`)

- `createApiSession(descriptor, provider, opts)` 의 `opts` 에 **세션-레벨** sink 추가:
  `onUsage?: (usage: TokenUsage) => void`. `toolDeps`/`system` 형제. `SendOptions` 는 무변경
  (엔진이 sink 를 소유 → orchestrator/chat 호출부 무배선).
- `send()` 의 fresh·누적 양 경로: `runChat()` 결과(ChatResult)를 받아 **unwrap 전에**
  `if (result.usage) opts.onUsage?.(result.usage)` 호출. 이유: 콘텐츠 필터/토큰 한도로 unwrap 이
  throw 하는 응답도 토큰은 이미 소비되므로 비용을 정확히 집계해야 한다. `runChat` 자체가 throw 하면
  ChatResult 가 없으니 usage 도 없음(정상).
- `TokenUsage` 를 `../providers/types` 에서 import.

### 3. 엔진 배선 (`engine.ts`)

- `registerApiSession` 의 `createApiSession(...)` opts 에 추가:
  `onUsage: (u) => appendAudit('usage', { id, provider: config.provider, ...u })`.
  (`appendAudit` 는 이미 `store.appendEvent({ type, data })` 래퍼.)
- `FleetEvent` 는 generic `{ type, message?, data }` → 'usage' 는 새 type 문자열일 뿐 shared/types·
  IPC·preload·renderer 변경 불요. CLI 세션(`createCliSession`)은 sink 미부여 → usage 이벤트 없음
  (CLI 출력에 토큰 없음, `onToolStep` API-전용과 동형).

## 데이터 흐름

```
provider.chat → ChatResult.usage
  └ (도구루프) runToolLoop: Σ usage over iters → ChatResult.usage(합산)
      └ api-session.send: onUsage(result.usage)  // unwrap 전, usage 있을 때만
          └ engine: appendAudit('usage', {id, provider, ...usage})
              └ store.appendEvent → FleetEvent 스트림(관측)
```

## 테스트 (TDD)

- `tools/loop.test`(providers 또는 신규): 2-iter 도구루프가 두 호출 usage 를 합산해 반환 ·
  cache 토큰 합산 · 전 구간 usage 없으면 undefined(무회귀) · 단발(도구 0)도 정상.
- `session/session.test`: onUsage 가 성공 send 에 발화(fresh+누적) · unwrap-throw(length/filter)
  에도 발화(소비 토큰 집계) · usage 없으면 미발화 · `send()` 가 여전히 string 반환(계약).
- `engine.test`: api 세션 등록 후 send → 'usage' FleetEvent 가 합산 토큰·id·provider 로 방출.

## 영향 범위

`src/main/core/tools/loop.ts` · `src/main/core/session/api-session.ts` ·
`src/main/core/session/types.ts`(미변경 예정 — 확인용) · `src/main/core/engine.ts` (+테스트).
shared/types · IPC · preload · renderer 무변경. 4 게이트 + 다중 에이전트 적대 리뷰 대상.

## 적대 리뷰 반영 (하드닝)

16-에이전트 적대 리뷰(5렌즈×발견별 검증) 확정 3건 반영:

1. **최대 반복 초과 throw 의 usage 미집계(high)** — `runToolLoop` 이 max 라운드 소진 후 throw 하면
   누적 usage(최대 8라운드 = 가장 비싼 경로)가 폐기돼 `onUsage` 미발화. unwrap-throw 는 집계하면서
   이 경로만 누락하는 비대칭. → 신규 `ToolLoopExceededError`(누적 usage 탑재)를 throw 하고,
   api-session `runChatReportingUsage` 가 catch 해서 `emitUsage` 후 재전파.
2. **throw 하는 onUsage sink 이 주 경로 파손(low)** — sink 가 throw 하면 unwrap·history 커밋이 안 돼
   성공한 send 가 거부되고 assistant 턴 유실. → `emitUsage` 가 onUsage 호출을 try/catch 로 격리
   (로깅하되 미전파). 부수기록은 주 send 계약을 깰 수 없다.
3. **all-undefined usage 가 빈 이벤트 발화(low)** — provider buffer 경로가 API 무응답에도 빈 usage
   객체를 만들어 `if(result.usage)` 통과 → 내용 없는 'usage' 이벤트. → `hasTokenData` 가드로 실
   토큰 데이터가 하나라도 있을 때만 발화('usage 없으면 미발화' 계약 일치).

기각 7건은 검증자가 코드 대조로 반증(no-defect 검증기록·의도된 scope·도달불가 abort 경로·미래 필드 nit).

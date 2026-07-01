# #185 — provider 재시도가 Retry-After 존중 (설계)

> 출처: 컷오프 갭 감사 2라운드 error-retry 밴드(2026-07-01). 코드 실측 확정.
> 상태: 설계 승인(2026-07-01). 다음 = 구현 계획(plan) → TDD.

## 문제 (실측)

`HttpResponse` 계약(`src/main/core/providers/types.ts:196-202`)이 `ok·status·text()·body` 만 노출하고
**응답 헤더 접근자가 없다.** `defaultHttp`(:207-221)는 `fetch` 응답의 `res.headers` 를 통째로 버린다.
그래서 `src/main/core/providers/resilient.ts` 는:

- `isRetryable`(:31) = 429 || 5xx — 429/529/503 을 재시도 대상으로 올바르게 분류하나,
- `backoffMs`(:36) = `250 * 2 ** attempt` **고정 지수백오프**(250→500ms)만 쓰고,
- 서버 지정 `Retry-After` / `retry-after-ms` 를 **물리적으로 못 읽는다**(계약에 헤더 부재).

→ 수초 지속 과부하(예: Anthropic 529 `overloaded_error`, `Retry-After: 5`)에서 3시도를 <1s 소진 후 throw.
서버 힌트를 무시한 조기 소진 = robustness 갭.

### 스코프 정직화
메모리의 "Claude API 529 과부하로 서브에이전트 워크플로 전멸"은 `claude -p` **CLI 위임 경로**(resilient 미통과)라
이 수정으로 그 사건 자체는 못 막는다. 이 이슈는 **API-세션 경로**(`createResilientHttp`)의 robustness 한정
— planner/reviewer/summarizer 등 API 기반 오케스트레이션 대상.

## 설계

### 3개 seam

1. **`HttpResponse` 계약 확장** (`types.ts:196`)
   - `header?(name: string): string | null` 추가 — case-insensitive **선택** 메서드.
   - 기존 `body?` 와 일관되게 **선택** — 헤더에 무관심한 mock 은 생략 가능(구현 중 확정: 인라인 mock 다수라
     필수화는 지속적 유지 세금 + `body?` 와 불일치). `defaultHttp` 는 항상 제공. 전체 헤더 materialize 회피.

2. **`defaultHttp` 채움** (`types.ts:207`)
   - `header: (name) => res.headers.get(name)` — Node fetch `Headers.get` 은 이미 case-insensitive·부재 시 `null`.

3. **`resilient.ts` 측정 백오프**
   - `parseRetryAfter(res: HttpResponse, nowMs: number): number | null` **순수 함수** 신설(module-private).
     - `retry-after-ms` (밀리초) 우선 — **`^\d+$`(trim)** 일 때만 수용(정수 ms).
     - `Retry-After`: **`^\d+$`** 이면 초 정수(예: `5`→5000ms), 아니면 **HTTP-date**(`Date.parse` → `date - nowMs`).
     - 비정수(빈 `''`·공백·과학표기 `1e3`·hex `0x10`·부호)·`Date.parse` NaN·과거시각 → `null`(폴백 신호).
       `^\d+$` 엄격 파싱은 `Number("")===0`(빈 헤더 → 0ms 즉시재시도) 등 `Number` 관대함 회피(리뷰 반영).
   - 재시도 대기 계산:
     ```
     const serverWait = parseRetryAfter(res, now())
     const wait = serverWait != null ? Math.min(serverWait, maxRetryAfterMs) : backoffMs(attempt)
     ```
     — 서버 지정값이면 `maxRetryAfterMs` 로 clamp, 없거나 무효면 지수 폴백(clamp 미적용 — catch 경로와 대칭·
     리뷰 반영). `ResilientOptions.maxRetryAfterMs?: number` 기본 `60_000`(승인) — 과대치(3600s) 무한대기 방지.

### 계층 정합 (스코프 out)
- Gemini `RetryInfo.retryDelay` 는 **헤더가 아니라 에러 JSON 바디**에 있다. `resilient` 는
  바디-불가지론·provider-무관 계층이라 거기서 바디를 파싱하면 계층 위반 → **N2 out-of-scope**.
  헤더 기반(`Retry-After`/`retry-after-ms`)만 처리(Anthropic·OpenAI 커버). Gemini body RetryInfo 는 별도 later.

### 에러 처리 / 기존 계약 무회귀
- 사용자 취소(`init.signal` abort) 즉시 throw 유지(:73) — Retry-After 대기로 취소가 묻히지 않게 `sleep(wait, init.signal)` 그대로.
- catch 경로(네트워크 throw)는 헤더가 없으므로 기존 지수 폴백 유지.
- 헤더 부재/파싱실패 = 완전한 기존 동작(무회귀).

## 유닛 경계
- `parseRetryAfter(res, nowMs)` — 순수·주입 nowMs 로 HTTP-date 결정론 테스트. **module-private**(비-export) — `createResilientHttp` 통합 경로로 커버.
- `createResilientHttp` — 통합 지점. 시그니처 불변(옵션 추가만).
- `HttpResponse` — 소비자(각 provider·mock)는 `header` 를 몰라도 됨(**선택**). 헤더 무관심 mock 은 생략 → `providers.test.ts`·`engine.test.ts` **무변경**(선택화 덕분).

## 테스트 (TDD)
mock `HttpResponse`(header 주입 가능) + injected `sleep` 캡처:
1. `Retry-After: 2` → 대기 2000ms.
2. `retry-after-ms: 1500` → 대기 1500ms (초 헤더보다 우선).
3. `Retry-After: <HTTP-date +3s>` (nowMs 주입) → 대기 ≈3000ms.
4. cap 초과(`Retry-After: 3600`) → 대기 = 60000ms(clamp).
5. 헤더 부재 → 기존 지수(250, 500…) 무회귀.
6. 잘못된 값(`Retry-After: abc`·음수 `-5`) → 지수 폴백.
6b. 빈 `''`·공백·비표준(`1e3`·`0x10`) `Retry-After` → **0ms 아니라 지수 폴백**(리뷰 반영 회귀 테스트).
7. 사용자 취소 도중 도착 → 즉시 reject(기존).
8. 기존 resilient 테스트 전량 green(계약 확장 무회귀).

**결정**: `header?` 를 **선택**으로 둔다(`body?` 와 일관·인라인 mock 유지세금 회피). `resilient.test.ts` 의 `resp`
헬퍼만 헤더 주입을 지원하면 되고, 헤더 무관심 mock(`providers.test.ts`·`engine.test.ts`)은 **무변경**.

## 수용 기준
- 429/529 응답의 `Retry-After`(초·HTTP-date)·`retry-after-ms` 파싱해 백오프 대기로 사용(cap 적용).
- 헤더 부재 시 기존 지수백오프 폴백(무회귀).
- mock 헤더 주입 테스트가 측정 대기·cap clamp 단언.
- 사용자 취소 즉시성·타임아웃 재시도 등 기존 resilient 계약 무회귀.
- `npm run verify` green(4게이트 + format:check).

## 비목표
- Gemini body RetryInfo(계층 out) · jitter(별도 later) · mid-stream 200 error 재시도(별도 later) · CLI 경로(resilient 미통과).

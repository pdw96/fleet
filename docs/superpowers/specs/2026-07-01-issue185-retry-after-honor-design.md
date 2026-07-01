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
   - `header(name: string): string | null` 추가 — case-insensitive 단일 메서드(승인).
   - 기존 `text()/body` 메서드 스타일과 일관. 전체 헤더 materialize 회피.

2. **`defaultHttp` 채움** (`types.ts:207`)
   - `header: (name) => res.headers.get(name)` — Node fetch `Headers.get` 은 이미 case-insensitive·부재 시 `null`.

3. **`resilient.ts` 측정 백오프**
   - `parseRetryAfter(res: HttpResponse, nowMs: number): number | null` **순수 함수** 신설.
     - `retry-after-ms` (밀리초 정수) 우선 파싱 → 있으면 그 값.
     - `Retry-After`: **초 정수**(예: `5`→5000ms) 또는 **HTTP-date**(예: `Wed, 21 Oct 2026 07:28:00 GMT` → `date - nowMs`) 파싱.
     - 파싱 실패·음수·NaN·비유한 → `null`(폴백 신호).
   - 재시도 대기 계산:
     ```
     const measured = parseRetryAfter(res, now)
     const wait = Math.min(measured ?? backoffMs(attempt), maxRetryAfterMs)
     ```
     — 헤더 있으면 측정값, 없으면 기존 지수 폴백. 둘 다 `maxRetryAfterMs` 로 clamp.
   - `ResilientOptions.maxRetryAfterMs?: number` 기본 `60_000`(승인) — 과대치(3600s) 무한대기 방지.
     초과해도 throw 아니라 clamp 후 재시도(서버가 여전히 429면 다음 시도서 재대기).

### 계층 정합 (스코프 out)
- Gemini `RetryInfo.retryDelay` 는 **헤더가 아니라 에러 JSON 바디**에 있다. `resilient` 는
  바디-불가지론·provider-무관 계층이라 거기서 바디를 파싱하면 계층 위반 → **N2 out-of-scope**.
  헤더 기반(`Retry-After`/`retry-after-ms`)만 처리(Anthropic·OpenAI 커버). Gemini body RetryInfo 는 별도 later.

### 에러 처리 / 기존 계약 무회귀
- 사용자 취소(`init.signal` abort) 즉시 throw 유지(:73) — Retry-After 대기로 취소가 묻히지 않게 `sleep(wait, init.signal)` 그대로.
- catch 경로(네트워크 throw)는 헤더가 없으므로 기존 지수 폴백 유지.
- 헤더 부재/파싱실패 = 완전한 기존 동작(무회귀).

## 유닛 경계
- `parseRetryAfter(res, nowMs)` — 순수·주입 nowMs 로 HTTP-date 결정론 테스트. resilient 내부(비-export 또는 test-only export).
- `createResilientHttp` — 통합 지점. 시그니처 불변(옵션 추가만).
- `HttpResponse` — 소비자(각 provider·mock) 는 `header()` 를 몰라도 됨(선택 사용). 단 **mock HttpResponse 를 만드는 기존 테스트**가 계약 변경으로 컴파일 깨질 수 있음 → 그 지점 갱신(아래).

## 테스트 (TDD)
mock `HttpResponse`(header 주입 가능) + injected `sleep` 캡처:
1. `Retry-After: 2` → 대기 2000ms.
2. `retry-after-ms: 1500` → 대기 1500ms (초 헤더보다 우선).
3. `Retry-After: <HTTP-date +3s>` (nowMs 주입) → 대기 ≈3000ms.
4. cap 초과(`Retry-After: 3600`) → 대기 = 60000ms(clamp).
5. 헤더 부재 → 기존 지수(250, 500…) 무회귀.
6. 잘못된 값(`Retry-After: abc`·음수) → 지수 폴백.
7. 사용자 취소 도중 도착 → 즉시 reject(기존).
8. 기존 resilient 테스트 전량 green(계약 확장 무회귀).

기존 mock HttpResponse 생성처(providers.test.ts 등)가 `header` 부재로 타입 에러 시 → 옵셔널 아닌 필수 메서드면 갱신 필요.
**결정**: `header` 를 **필수**로 두되(계약 명확), 테스트 헬퍼/기존 mock 에 `header: () => null` 기본 추가로 무회귀.

## 수용 기준
- 429/529 응답의 `Retry-After`(초·HTTP-date)·`retry-after-ms` 파싱해 백오프 대기로 사용(cap 적용).
- 헤더 부재 시 기존 지수백오프 폴백(무회귀).
- mock 헤더 주입 테스트가 측정 대기·cap clamp 단언.
- 사용자 취소 즉시성·타임아웃 재시도 등 기존 resilient 계약 무회귀.
- `npm run verify` green(4게이트 + format:check).

## 비목표
- Gemini body RetryInfo(계층 out) · jitter(별도 later) · mid-stream 200 error 재시도(별도 later) · CLI 경로(resilient 미통과).

# #185 — Retry-After 존중 (구현 계획)

설계: [`../specs/2026-07-01-issue185-retry-after-honor-design.md`](../specs/2026-07-01-issue185-retry-after-honor-design.md)

TDD(RED→GREEN). 파급 확정: 비-test HttpResponse 생성처 = `defaultHttp` 1곳, test 팩토리 3곳(resilient/providers/engine.test.ts).
`header` 는 **필수** 메서드(계약 명확) — 생성처 4곳만 갱신, 내부 소비자(getJson 등)는 무영향.

## Step 1 — 계약 확장 (`providers/types.ts`)
- `HttpResponse` 에 `header(name: string): string | null` 추가(필수).
- `defaultHttp` 반환에 `header: (name) => res.headers.get(name)` 추가(fetch Headers.get = case-insensitive·부재 시 null).
- 이 단계에서 3 test 팩토리가 컴파일 깨짐 → Step 2 에서 함께 green.

## Step 2 — test mock 팩토리 갱신 (무회귀 유지)
- `resilient.test.ts` `resp(status, body, headers={})` → `header: (n) => headers[n.toLowerCase()] ?? null`.
- `providers.test.ts` `mockHttp`/`mockStreamHttp`/`mock400ThenStream` 반환에 `header: () => null`.
- `engine.test.ts` HttpResponse mock 에 `header: () => null`.
- 기존 테스트 전량 green 확인(계약 확장 무회귀).

## Step 3 — RED: parseRetryAfter + 측정 백오프 테스트 (`resilient.test.ts`)
capturing sleep(`ms` 기록) + header 주입 mock 으로:
1. `Retry-After: 2` → 대기 2000.
2. `retry-after-ms: 1500` → 대기 1500(초 헤더보다 우선).
3. `Retry-After: <HTTP-date, nowMs 주입 +3s>` → 대기 ≈3000.
4. `Retry-After: 3600` → 대기 60000(cap clamp).
5. 헤더 부재 → 기존 지수(250, 500).
6. `Retry-After: abc`·음수 → 지수 폴백.
7. (기존) 취소·타임아웃·4xx 무회귀.

nowMs 주입: `parseRetryAfter` 를 test-only export 하거나, `ResilientOptions.now?: () => number` 주입(HTTP-date 결정론). → **now 주입 채택**(순수성·기존 sleep 주입 패턴과 일관).

## Step 4 — GREEN: 구현 (`resilient.ts`)
- `parseRetryAfter(res, nowMs): number | null` 순수 함수:
  - `retry-after-ms` 정수 파싱 우선 → 유효(≥0·유한)면 반환.
  - `Retry-After`: 정수초 → `*1000`; 실패 시 `Date.parse(v) - nowMs`. 음수·NaN·비유한 → null.
- `ResilientOptions`: `maxRetryAfterMs?: number`(기본 60_000), `now?: () => number`(기본 `Date.now`, 테스트 주입).
- 재시도 대기: `Math.min(parseRetryAfter(res, now()) ?? backoffMs(attempt), maxRetryAfterMs)`.
- catch 경로(네트워크 throw)는 헤더 없음 → 기존 지수 유지.
- 사용자 취소 즉시 throw·`sleep(wait, init.signal)` 취소 인지 유지.

## Step 5 — 게이트
- `npm run verify` green(typecheck·lint·test·format:check).
- `npx prettier --version` / `npm run format:check` 로컬 확인(메모리: lint-staged stale 함정).

## Step 6 — 적대 자가리뷰 + PR
- `fleet-pr-review`(다차원 적대) 자가리뷰.
- PR 본문 `Closes #185`. Codex/CodeRabbit 봇 리뷰 대기·반영·스레드 resolve. 사용자 확인 후 squash.

## 무회귀 체크리스트
- [ ] 헤더 부재 시 기존 지수백오프 정확 재현(테스트 5·6).
- [ ] 사용자 취소 즉시성(기존 테스트).
- [ ] 타임아웃 재시도·4xx 미재시도(기존 테스트).
- [ ] `header` 필수화로 깨진 4 생성처 전부 갱신.

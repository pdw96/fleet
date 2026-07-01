# #185 — Retry-After 존중 (구현 계획)

설계: [`../specs/2026-07-01-issue185-retry-after-honor-design.md`](../specs/2026-07-01-issue185-retry-after-honor-design.md)

TDD(RED→GREEN). 파급: 비-test HttpResponse 생성처 = `defaultHttp` 1곳.
`header?` 는 **선택** 메서드(`body?` 와 일관) — 헤더 무관심 mock 은 갱신 불요. `resilient.test.ts` `resp` 헬퍼만
헤더 주입 지원. `providers.test.ts`·`engine.test.ts` **무변경**. 내부 소비자(getJson 등)는 무영향.
(구현 중 정정: 초안은 필수 4곳이었으나 인라인 mock 다수라 선택화 채택 — 리뷰서 재확인.)

## Step 1 — 계약 확장 (`providers/types.ts`)
- `HttpResponse` 에 `header?(name: string): string | null` 추가(**선택**, `body?` 와 일관).
- `defaultHttp` 반환에 `header: (name) => res.headers.get(name)` 추가(fetch Headers.get = case-insensitive·부재 시 null).

## Step 2 — test 헬퍼 (무회귀 유지)
- `resilient.test.ts` `resp(status, body, headers={})` → `header: (n) => headers[n.toLowerCase()] ?? null`.
- 헤더 무관심 mock(`providers.test.ts`·`engine.test.ts`)은 선택화 덕분에 **무변경**.
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

## Step 4 — GREEN: 구현 (`resilient.ts`, module-private)
- `parseRetryAfter(res, nowMs): number | null` 순수 함수(비-export):
  - `retry-after-ms` 우선 — `^\d+$`(trim) 일 때만 수용(정수 ms).
  - `Retry-After`: `^\d+$` 이면 정수초 → `*1000`; 아니면 `Date.parse(v) - nowMs`. 비정수(빈/공백/`1e3`/`0x10`/부호)·NaN·과거 → null.
    (`Number` 관대함 회피 — `Number("")===0` 로 빈 헤더가 0ms 즉시재시도 되던 것 방지, 리뷰 반영.)
- `ResilientOptions`: `maxRetryAfterMs?: number`(기본 60_000·양수), `now?: () => number`(기본 `Date.now`, 테스트 주입).
- 재시도 대기: `const s = parseRetryAfter(res, now()); wait = s != null ? Math.min(s, maxRetryAfterMs) : backoffMs(attempt)`
  — clamp 는 서버 지정값에만(지수 폴백·catch 경로와 대칭, 리뷰 반영).
- catch 경로(네트워크 throw)는 헤더 없음 → 기존 지수 유지.
- 사용자 취소 즉시 throw·`sleep(wait, init.signal)` 취소 인지 유지. docstring 에 신동작 반영.

## Step 5 — 게이트
- `npm run verify` green(typecheck·lint·test·format:check).
- `npx prettier --version` / `npm run format:check` 로컬 확인(메모리: lint-staged stale 함정).

## Step 6 — 적대 자가리뷰 + PR
- `fleet-pr-review`(다차원 적대) 자가리뷰.
- PR 본문 `Closes #185`. Codex/CodeRabbit 봇 리뷰 대기·반영·스레드 resolve. 사용자 확인 후 squash.

## 무회귀 체크리스트
- [x] 헤더 부재 시 기존 지수백오프 정확 재현(테스트 5·6).
- [x] 빈/공백/비표준 헤더 → 0ms 아니라 지수 폴백(리뷰 반영 회귀 테스트).
- [x] 사용자 취소 즉시성(기존 테스트).
- [x] 타임아웃 재시도·4xx 미재시도(기존 테스트).
- [x] `header?` 선택화 → `providers.test.ts`·`engine.test.ts` 무변경(생성처 갱신 불요).

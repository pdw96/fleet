# CLI 세션 인증 실패 advisory recovery hint — 설계

- **이슈**: #148 (부모 #145 항목1 · 메타 #27)
- **근거**: 세션 인증 picker 스펙 `2026-06-25-session-auth-picker-design.md` §7a·§10 · 계획 `2026-06-25-session-auth-picker.md` 「미해결/후속」("첫 사용 auth 실패 전용 라우팅 — chat/orchestrator 에러 경로 조사 후 별도 태스크")
- **체크포인트 리뷰**: Codex 독립 설계 리뷰(#148, 2026-06-26) — 방향 승인 + 정규식 견고성 4건 반영(아래 §6에 명문화).

## 1. 목표

CLI 세션(claude/codex/gemini)은 인증을 **첫 실제 사용 시 lazy 검증**한다(설치만 사전 확인). 미로그인·토큰 만료·플랜 권한 없음 등 **인증 문제**로 실행이 실패하면, 사용자는 제네릭 오류(`<command> 종료코드 N: <stderr>`)만 보고 복구 방법(재로그인)을 모른다. 이 슬라이스는 실패 메시지가 *인증 문제로 보일 때* **advisory recovery hint** 한 줄을 덧붙여 정직하게 복구를 안내한다.

## 2. 비목표 (스코프 규율 · solo pre-1.0)

- 정확한 per-CLI stderr/exit 시그니처 실측·고정 (advisory 휴리스틱으로 충분).
- pre-flight "연결 테스트" probe (스펙 §7 후속).
- `authStatus` 저장 필드 (스펙 §7a — descriptor/store 무확장).
- 터미널 자동 로그인 실행 (D3 copy-only — command-injection·ApprovalGate 우회 회피).
- 구조화 IPC/렌더러 변경 (최소 인라인 선택 — 아래 §5).
- first-use 게이팅 (모든 auth-형 실패에 적용).

## 3. 아키텍처 결정 (브레인스토밍 확정)

| 갈림길 | 결정 | 근거 |
|---|---|---|
| 탐지 | **advisory 휴리스틱** | 정확 시그니처 미상에 강건(놓침→제네릭 폴백=무회귀, 오탐→단정 안 함=안전). §7a 단정-회피 정직성 정합. 외부 probing 0. |
| 배선 | **최소 인라인** | 순수 함수가 hint 문자열 반환 → 단일 seam(`assertRunOk`)에서 합성. IPC/렌더러 무변경 → chat·run 자동 커버. |
| 트리거 | **모든 auth-형 실패** | 세션 중간 토큰 만료도 커버. first-call 추적 불필요. 스펙 '첫 사용'은 lazy 검증 *시점* 설명. |

## 4. 컴포넌트

### 4.1 `classifyCliAuthHint(adapter, res): string | null` (신규, 순수)

- **위치**: `src/main/core/cli/authHint.ts` (CLI 어댑터 옆. `cli-session.ts`는 import만 — 파일 책임 분리·테스트 seam 명확).
- **시그니처**: `(adapter: CliAdapter, res: CommandResult) => string | null`.
- **반환**: 인증 문제로 보이면 advisory hint 문자열, 아니면 `null`.
- **가드(모두 충족 시에만 hint)**:
  1. `!res.spawnError` — spawn/timeout/abort/overflow(ENOENT·ETIMEDOUT·ABORTED·ENOBUFS)는 설치·실행·취소 실패라 auth 아님.
  2. `res.code !== 0`.
  3. `adapter.auth?.loginCommand`가 존재 — 없으면 안내할 명령이 없음.
  4. 텍스트가 §6 패턴 판정에서 auth로 분류됨.

### 4.2 배선 — `assertRunOk` 시그니처 확장

`cli-session.ts`의 `assertRunOk(command: string, res)` → `assertRunOk(adapter: CliAdapter, res)`:

```ts
function assertRunOk(adapter: CliAdapter, res: CommandResult): void {
  if (res.spawnError) throw new Error(`${adapter.command} 실행 실패: ${res.spawnError}`)
  if (res.code !== 0) {
    const hint = classifyCliAuthHint(adapter, res)
    const base = `${adapter.command} 종료코드 ${res.code}: ${res.stderr.trim()}`
    throw new Error(hint ? `${base}\n\n${hint}` : base)
  }
}
```

- 호출부 2곳(streaming `cli-session.ts:123`·buffering `:141`)에서 `adapter.command` → `adapter`.
- 에러 메시지는 계속 `adapter.command` 사용(`displayName` 금지 — 기존 메시지 형식 보존 = 무회귀).

## 5. 데이터 흐름 / 표출

```
execute() → runner() → CommandResult{code,stdout,stderr,spawnError}
  → assertRunOk(adapter, res)
      → (code≠0) classifyCliAuthHint(adapter,res) → hint|null
      → throw Error(base [+ "\n\n" + hint])
  → session.send() rethrow → controller.askLlm() → streamedAsk catch
      → chat:  ChatStreamEvent{kind:'error', message}  → ChatPanel StreamBubble (⚠ message)
      → run:   orchestrator task.failed/plan.failed{message} → ProjectPanel 오류 표시
```

**IPC/렌더러 스키마 변경 0** — 에러 메시지 문자열만 풍부해지므로 chat·run 양 경로가 기존 렌더로 hint를 그대로 표시한다. `loginCommand`·`docsUrl`은 텍스트로만 노출(사용자 수동 복사 = §6a copy-only·D3 비목표 충족).

**hint 문구(한국어, advisory)**:
```
💡 인증 문제일 수 있습니다 — 터미널에서 `<loginCommand>` 실행 후 다시 시도해 보세요. (문서: <docsUrl>)
```

## 6. auth 패턴 분류 (Codex 리뷰 반영: exclude-first + strong-auth + forbidden-context)

판정 절차(명세):

```
checkAuth(text, allowForbiddenContext):
  if NON_AUTH_PATTERN.test(text):            return false   // exclude-first (rate-limit/quota 우선 제외)
  if STRONG_AUTH_PATTERN.test(text):         return true
  if allowForbiddenContext
     && FORBIDDEN_AUTH_CONTEXT_PATTERN.test(text): return true
  return false

isAuth(res):
  err = res.stderr.trim()
  if err !== '':  return checkAuth(err, /*allowForbiddenContext*/ true)   // stderr: forbidden-context 허용
  return checkAuth(res.stdout, /*allowForbiddenContext*/ false)            // stdout 폴백: strong-auth만, exclude-first 유지
```

- stderr가 비어 있을 때만 stdout으로 폴백한다(stderr 비매치는 stdout 검사로 넘어가지 않음 — stderr가 1차 진실원).
- 두 경로 모두 `NON_AUTH_PATTERN` exclude-first가 가장 먼저 적용된다.
- `FORBIDDEN_AUTH_CONTEXT_PATTERN`은 stderr 경로에서만 허용(stdout엔 모델출력/JSON 혼재 → strong-auth만).

> **체크포인트 기록과의 차이(의도적 조임)**: Codex 리뷰 답글에선 "stderr가 비었거나 *미매치*일 때 stdout 폴백"으로 합의했으나, 설계 확정 시 **"stderr 비었을 때만"**으로 좁혔다. 이유: stderr에 비-auth 오류가 있는데 stdout에 우연히 strong-auth 어구가 섞이는 *충돌 신호* 오탐을 차단하고 stderr를 1차 진실원으로 삼기 위함. Codex의 "stdout은 보수적으로" 의도를 더 강하게 따르는 방향이라 무회귀·정직성에 유리하다.

```ts
// 1) rate-limit/quota 류는 auth 아님 → 항상 우선 제외
const NON_AUTH_PATTERN =
  /\b(rate[- ]?limit(?:ed)?|quota|overload(?:ed)?|too many requests|429)\b/i

// 2) auth 문맥이 충분히 강한 어구 (stderr·stdout 공통)
const STRONG_AUTH_PATTERN =
  /\b(not logged in|unauthori[sz]ed|unauthenticated|authentication (?:failed|required|error)|requires authentication|login required|log in to continue|please .{0,40}(?:log ?in|sign in|authenticate)|sign in|session expired|token (?:expired|invalid)|invalid token|expired credentials|invalid (?:api key|credential)|no credentials found|missing credentials|api key required|401)\b/i

// 3) 403/forbidden은 auth 문맥과 근접(±80자)할 때만 (stderr 경로 한정)
const FORBIDDEN_AUTH_CONTEXT_PATTERN =
  /\b(?:403|forbidden)\b.{0,80}\b(?:auth|login|log in|sign in|token|credential|api key|account|subscription|permission)\b|\b(?:auth|login|log in|sign in|token|credential|api key|account|subscription|permission)\b.{0,80}\b(?:403|forbidden)\b/i
```

**미채택**: `permission denied` 단독(파일권한과 충돌 — Codex도 단독 비추천), `credential`/`forbidden` 단독(문맥 결합으로만).

## 7. 에러 / 엣지 (무회귀)

`classifyCliAuthHint`가 반드시 `null`을 반환:

- `res.spawnError` 존재(어떤 auth 문구가 있어도) → 기존 `${command} 실행 실패: <spawnError>` 그대로.
- `res.code === 0`.
- `adapter.auth?.loginCommand` 없음.
- 빈 stderr & 빈 stdout.
- `NON_AUTH_PATTERN` 매치(rate-limit/quota/overload/429/too many requests).
- auth 패턴 미매치 → 기존 `${command} 종료코드 N: <stderr>` 그대로.

## 8. 테스트 (TDD: RED→GREEN)

### 8.1 `authHint.test.ts` (신규 단위)

**Positive**(어댑터별 loginCommand·docsUrl 포함 단언):
- claude `not logged in` → hint, `claude auth login` 포함.
- codex `Error: unauthorized` → hint, `codex login` 포함.
- gemini `authentication required` → hint.
- `401` / `session expired` / `invalid api key` / `please log in` 변형.
- `403 forbidden: invalid token` → hint(forbidden-context).
- stderr 비고 stdout에 `unauthenticated` → hint(stdout 폴백).

**Negative**(→ `null`):
- `rate limit exceeded; please login later` → null(exclude-first가 strong-auth 이김).
- `forbidden` 단독 → null.
- `permission denied` 단독 → null.
- `syntax error` / `file not found` / `ENOENT` 류 텍스트 → null.
- 빈 stderr+stdout / `code:0` / auth 메타 없는 어댑터 → null.
- stdout에 `forbidden`(strong 아님) → null(stdout은 strong-only).

### 8.2 `cli-session.test.ts` 보강(통합)

- `spawnError:'ABORTED'` + stderr `not logged in` → throw 메시지에 hint 없음(우선순위 명시).
- `spawnError:'ETIMEDOUT'` + stderr `authentication required` → hint 없음.
- `code:1` + stderr auth-형 → throw 메시지에 base + hint 포함.
- `code:1` + 비-auth stderr → 기존 메시지 그대로(무회귀).

## 9. 파일 변경 범위

- **신규**: `src/main/core/cli/authHint.ts` · `src/main/core/cli/authHint.test.ts`.
- **수정**: `src/main/core/session/cli-session.ts`(`assertRunOk` 시그니처 + 호출부 2곳) · `src/main/core/session/cli-session.test.ts`(보강).
- **ADR 불필요**: 국소 구현 결정 — 환원불가한 교차 관례 아님.

## 10. 품질 게이트

`typecheck · lint · test · build` 4종 green + Windows vitest 회귀. PR 본문 `Closes #148` · `Part of #145`(#145 잔여 항목 2·3·5 미완 — 조기 종료 금지).

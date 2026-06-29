# #166 오케스트레이션 최종 status 정직화 — 설계

- **이슈**: [#166](https://github.com/pdw96/fleet/issues/166) (area:orchestrator · bug · tier:next)
- **체크포인트 리뷰**: [Codex 독립 설계 리뷰](https://github.com/pdw96/fleet/issues/166#issuecomment-4831263083) → "진행 권장"
- **날짜**: 2026-06-29

## 문제 (근본 원인)

오케스트레이션이 8 task 중 **1 done · 1 failed · 6 skipped** 로 끝났는데도 앱이 성공처럼 표시한다.
dogfood r4(2026-06-29) 실측: `verify.passed: 검증 통과` → `project.done: 프로젝트 완료` 인데
같은 화면의 LLM 요약 패널은 `## 평가 결과: 목표 미달성`. **앱 내부 상태가 자기모순.**

두 개의 독립적인 결함:

### Bug A — 최종 status가 task 집계를 무시
`src/main/core/orchestrator/orchestrator.ts:994-1002`:

```js
const signalAborted = opts.signal?.aborted === true
const verifyFailed = !!opts.verify && !(verifications !== undefined && verifications.length > 0 && verifications.every((v) => v.passed))
store.updateProject(project.id, { status: signalAborted || verifyFailed ? 'failed' : 'done' })
```

최종 status는 `aborted || verifyFailed` 만 보고 결정하며 **task 결과(done/failed/skipped)를
전혀 보지 않는다.** 렌더러(`ProjectPanel.tsx:295`)는 `p.status` 를 `statusColor()` 칩으로 그대로
표시하므로, 저장된 status 가 거짓이면 UI 칩도 필연적으로 거짓("done")이 된다.

### Bug B — no-op verify 를 "검증 통과"로 표시
`orchestrator.ts:804-817` 의 `emitVerify` 는 verify 결과가 모두 `passed` 면 `검증 통과` 를 방출한다.
verify 는 워크스페이스 `package.json` 스크립트(`npm run typecheck/lint/test`, `verify/run.ts:119-125`)를
맹목 실행하는데, seed 가 `"exit 0"` (no-op) 이면 정당하게 exit 0 → `passed:true` → `검증 통과`.
앱은 이것이 의미상 no-op(실제 검사 0) 인지 알 수 없다.

## 결정 (확정 — Codex 리뷰 반영)

1. **Bug A**: `Project.status` union 에 새 `'partial'` 상태 추가 (메시지만 보정하면 칩이 여전히 거짓).
2. **Bug B**: 이 PR 에서 함께 처리. `package.json` 스크립트를 읽어 no-op 탐지.

## 설계

### Bug A — `partial` status (task 집계 반영)

**타입** (`src/shared/types.ts:298`): `Project.status` union 에 `'partial'` 추가
→ `'planning' | 'executing' | 'verifying' | 'done' | 'partial' | 'failed'`.

**집계 로직** (`orchestrator.ts:994-1011`): 종료 후 `store.listTasks(project.id)` 로 카운트
(`doneCount` = status `'done'`, `failedCount` = `'failed'`, `skippedCount` = `'skipped'`, `total` = 전체).

**최종 status 우선순위** (위→아래, 첫 매치 적용):

| 조건 | status |
|---|---|
| `signalAborted` | `failed` (취소 계약 유지) |
| `verifyFailed` | `failed` (검증 = 최종 품질 게이트, task 집계보다 **우선**) |
| `total === 0` | `done` (유효한 빈 플랜; plan 실패는 `plan.failed` 별도 경로) |
| `doneCount === total` | `done` |
| `doneCount > 0` | `partial` |
| (`doneCount === 0 && total > 0`) | `failed` (아무것도 완료 못함) |

**`project.done` 메시지** (event type·`data.projectId` 불변):

- aborted → `프로젝트 취소됨: <title>`
- verifyFailed → `프로젝트 실패: <title> (검증 실패 · 총 N · 완료 D · 실패 F · 건너뜀 S)` ← **breakdown 추가(Codex)**
- partial → `프로젝트 부분 완료: <title> (총 N · 완료 D · 실패 F · 건너뜀 S)`
- 집계 failed(doneCount 0) → `프로젝트 실패: <title> (총 N · 완료 D · 실패 F · 건너뜀 S)`
- done → `프로젝트 완료: <title>`

> **단일 breakdown 헬퍼**를 verify-fail·partial·집계-failed 메시지가 공유(포맷 drift 방지 · Codex).
> F/S 는 실제 task status 로 카운트(구현불가 경로가 `failed`/`skipped` 어느 쪽이든 정확).

**렌더러** (`src/renderer/ui.ts` `statusColor`): `case 'partial': return 'var(--warn)'`
(앰버 — done `--ok` 초록 / failed `--bad` 빨강과 구분). 칩은 `p.status` 그대로 표시.

**불변식**: event type `'project.done'`·`data.projectId` 그대로 유지 → engine `activeRuns` 정리·렌더러
running 잠금(둘 다 event-type 기반)에 영향 없음. **오직 project status 값과 메시지 텍스트만 변경.**

### Bug B — no-op verify 정직화

**타입** (`src/shared/types.ts` `VerificationResult`): optional `noop?: boolean` 추가(하위호환).

**`verify/run.ts`**:
- `VerifyCommand` 에 `noop?: boolean` 추가.
- 신규 `isNoOpScript(body?: string): boolean` — `body` trim 후 **끝 세미콜론 1개만 제거**(`exit 0;;`
  는 비-noop)하고 `'' | 'exit 0' | 'true' | ':'` 중 하나면 `true`. 그 외 모두 `false`.
  (보수적 — `echo`·`printf`·`... || true`·`sh -c "exit 0"` wrapper 는 의도적 제외; 오탐 0 우선.)
- `npmVerifyCommands(cwd)` — `<cwd>/package.json` 을 **동기 `readFileSync`** 로 읽어 `scripts` 파싱,
  각 명령에 `noop: isNoOpScript(scripts?.[name])` 태그. **읽기 실패·`JSON.parse` 실패·`package.json`
  없음·`scripts` 없음·개별 script 없음 → 모두 `noop` 미설정**(undefined = 비-noop, 보수적).
  **함수는 동기 유지** → 호출부(`engine.ts:216`) ripple 없음(Codex).
- `runVerification` — `cmd.noop` 를 `result.noop` 로 전파.

**`orchestrator.ts` `emitVerify`**: `ok && v.length > 0 && v.every(r => r.noop)` 이면 메시지를
`검증 항목 없음 (no-op 스크립트 — 실제 검사 없음)` 으로. **event type 은 `verify.passed` 유지**
(렌더러 전이 영향 없음). 일부만 no-op 인 경우는 이번 PR 범위 밖 — `검증 통과` 유지(YAGNI).

**status 무영향**: no-op verify 는 "실패"가 아니라 "검증 신뢰도 없음" → `verifyFailed` 에 영향 없음.
실제 부분완료는 Bug A 의 task 집계가 결정. `allPassed()` 도 그대로(no-op 은 실패 아님).

## 테스트 (TDD)

### `src/main/core/verify/run.test.ts`
- `isNoOpScript`: `'exit 0'`·`'true'`·`':'`·`''`·`'exit 0;'` → true; `'echo ok'`·`'npm run test:unit'`·`'tsc'` → false.
- `npmVerifyCommands`: package.json 스크립트 `exit 0` → 명령 `noop:true`; 실제 스크립트 → `noop:false`; package.json 누락/스크립트 누락 → `noop` undefined.
- `runVerification`: `cmd.noop` → `result.noop` 전파.

### `src/main/core/orchestrator/orchestrator.test.ts`
- 일부 done + 일부 skipped + verify 없음/통과 → `partial`; event type `project.done` 유지; 메시지에 breakdown 포함.
- 일부 done + verify 실패 → `failed`(partial 보다 우선); 메시지 `프로젝트 실패` + breakdown.
- 모두 done + verify 통과 → `done` 유지.
- 모두 skipped/failed(doneCount 0) → `failed`.
- abort → `failed` 유지.
- `total === 0`(유효 빈 플랜, plan.failed 아님) → `done` (의도 고정 — named 테스트).
- emitVerify: 전부 noop → `검증 항목 없음...`; 실제 스크립트 → `검증 통과`.
- **기존 project status 기대값 전수 감사** — 일부 task 실패에도 전체 진행하는 기존 테스트가 `done`→`partial` 로 바뀔 수 있음(Codex 핵심 ripple 경고). 의도대로 갱신. **구체 지목**: "첫 작업 failed·둘째 done 인데 전체는 done" 류 테스트 → `partial` 로 갱신하고 **테스트 이름/주석도** "전체 실행은 계속되지만 최종 status 는 partial" 로 수정(스펙 가시화).

### `src/renderer/ui.test.ts`
- `statusColor('partial') === 'var(--warn)'`.

## 범위 밖 (YAGNI)
- 일부만 no-op 일 때의 세분화 메시지(`검증 통과 (일부 no-op: …)`).
- 새 event type 추가(verify.* 는 passed/failed 2종 유지).
- `allPassed` 시그니처 변경.
- #167(스폰 CLI 승인 게이트·ETIMEDOUT) — 별개 이슈.

## 품질 게이트
`npm run typecheck` · `npm run lint` · `npm run test` · `npm run format:check` 4종 green.

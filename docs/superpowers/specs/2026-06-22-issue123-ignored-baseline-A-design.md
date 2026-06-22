# #123-A 설계 — Ignored 파일 변경 탐지·선택 복원

- **이슈**: #123 (오케스트레이션 워크스페이스 무결성), A 슬라이스
- **티어/타입**: tier:next · type:security · area:orchestrator
- **날짜**: 2026-06-22
- **상태**: 설계 확정 (브레인스토밍 + Codex 설계 리뷰 `#123 issuecomment-4767114631`/`-4767117202` 반영)

## 1. 배경 / 문제

`Workspace.collectDiff()` 는 `git add -A` 기반이라 `.gitignore` 대상 파일을 스테이징하지 않는다(`src/main/core/workspace/git.ts:144-147`, 주석에 한계 명시). 따라서 구현 에이전트가 ignored 파일(대표적으로 `.env`·키·credential)을 생성·수정·삭제해도:

- diff·`classifyDiffRisk()`·`ApprovalGate`·reviewer 경로에 나타나지 않는다.
- `revert()` 의 `git reset --hard` + `git clean -ffd`(`-x` 없음, `git.ts:166-170`)로도 제거·복원되지 않아 오염이 영속한다.

병렬 worktree(`.fleet-wt-*`, 레포 밖)는 작업 종료 시 `removeWorktree`(`worktree remove --force`)로 ignored 잔여물이 자동 폐기되지만 **탐지·감사되지 않는다**. 순차 경로(사용자 workspace 직접 편집)는 잔여물이 **실제로 남는다**. "모든 위험 변경은 승인 게이트를 통과한다"는 프로젝트 안전 계약을 깨는 비대칭 보안 누수다.

## 2. 목표 / 비목표

**목표 (A 슬라이스)**
- 정책 범위 내 ignored 파일의 생성·수정·삭제를 별도 change set 으로 탐지.
- 민감 ignored 변경을 reviewer 전송 전에 승인 게이트로 surface(내용 비노출, 경로·종류만).
- 승인 거부·reviewer 실패·검증 실패·사용자 취소 시 기존 ignored 파일 선택 복원(에이전트 신규 파일만 삭제, 변조·삭제된 기존 파일만 백업에서 복원).
- 순차·병렬 worktree·verify-fix 경로가 동일 무결성 계약 만족.

**비목표 (→ B 슬라이스, A 를 blocking dependency 로 한 별도 `type:security` sub-issue)**
- symlink/junction/reparse point 경계검사 (이슈 회귀 8·9).
- 프로세스 수준 workspace 격리(disposable worktree/OS sandbox).
- `git clean -xffd` 식 ignored 일괄 정리(사용자 기존 파일 파괴 — 금지).
- json-to-sqlite, append-only store.

## 3. 아키텍처

신규 순수 모듈 **`src/main/core/workspace/ignored-baseline.ts`** 가 모든 로직(열거·해시·in-memory 백업·비교·선택 복원·캡/fail-closed)을 소유한다. `GitRunner` 주입(테스트), `node:fs`/`node:crypto` 직접 사용(git.ts 패턴).

`createWorkspace`(git.ts)가 이를 조합해 `Workspace` 인터페이스에 3 메서드를 추가한다. baseline 은 호출자(orchestrator)가 **값으로 보유**한다(closure 은닉 금지 → 추론·테스트 용이, 병렬 경로의 per-task 보유와 자연 정렬).

오케스트레이터 통합은 **공유 헬퍼 `withIgnoredGuard`** 로 단일화한다(Codex 권고 1). 편집 가능한 mutation(implement / verify-fix)을 감싸 capture→collect→risk merge→restore/dispose 를 일관 적용한다. 호출자(`runTaskIn` 의 라운드 루프, verify-fix 루프)는 각자 루프 제어만 유지하고 ignored 가드는 헬퍼가 책임진다 — 두 경로가 drift 하지 않게 한다.

## 4. 타입 / API

```ts
// ignored-baseline.ts (순수)
interface ScanPolicy {
  sensitiveRe: RegExp
  denylistRe: RegExp
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
}
interface IgnoredEntry {
  path: string        // root 기준 normalized relative path
  size: number
  mtimeMs: number
  hash: string        // sha256(content)
  sensitive: boolean
  backup?: Buffer      // in-memory 내용 (per-file cap 초과 시 omitted)
}
interface IgnoredBaseline {
  entries: Map<string, IgnoredEntry>
  skipped: { path: string; reason: 'over-cap' | 'read-failed' }[]
}
interface IgnoredChange {
  path: string
  change: 'created' | 'modified' | 'deleted'
  sensitive: boolean
}
interface IgnoredChangeSet {
  changes: IgnoredChange[]
  unrestorable: { path: string; reason: string }[]   // over-cap/read-fail → escalate
}

function captureIgnoredBaseline(root, git, policy): Promise<IgnoredBaseline>  // 민감 백업실패 → throw
function collectIgnoredChanges(root, git, baseline, policy): Promise<IgnoredChangeSet>
function restoreIgnoredBaseline(root, baseline, changeSet): Promise<void>     // created 삭제·mod/del 백업복원
function disposeBaseline(baseline): void                                      // Buffer best-effort zeroize
```

**Workspace 인터페이스 추가** (git.ts):
- `captureIgnoredBaseline(): Promise<IgnoredBaseline>`
- `collectIgnoredChanges(baseline: IgnoredBaseline): Promise<IgnoredChangeSet>`
- `restoreIgnoredBaseline(baseline: IgnoredBaseline, changeSet: IgnoredChangeSet): Promise<void>`

(`disposeBaseline` 은 순수 헬퍼, 인터페이스 외 — 호출자 `finally` 에서 호출.)

**열거 방식** (Codex 권고 6):
- `git status --ignored --porcelain=v1 -z` → `!! ` prefix 엔트리만 baseline 대상(untracked 등 다른 상태 제외).
- 디렉터리(`!! dir/`)는 denylist 우선 검사 → 미-denylist 면 policy/cap 내 재귀 스캔.
- 개별 파일은 직접. `SENSITIVE_FILE` 매칭 파일은 항상 in-scope.
- 경로는 NUL 구분 그대로 파싱, normalized relative path 만 로그/approval 에 사용(내용·hash 비노출).

## 5. 데이터 흐름 (`withIgnoredGuard`, 순차·병렬·verify-fix 공용)

1. `base = checkpoint()` 직후 `baseline = ws.captureIgnoredBaseline()`. 본문 `try`, `finally` 에서 `disposeBaseline(baseline)`(모든 종료경로 폐기).
   - capture 가 throw(민감 백업 실패) → catch: tracked revert + ignored 가능분 복원 + task hard-fail + 감사.
2. 편집(implement / fix) 후 `diff = collectDiff(base)` + `changeSet = ws.collectIgnoredChanges(baseline)`.
3. `dr = classifyDiffRisk(diff, changeSet)` — sensitive 변경 / unrestorable / 일반 in-scope ignored 변경 존재 → **destructive** + 경로·종류 reasons.
4. destructive → `gate.request`(reasons 에 ignored 경로·종류 포함, **내용 0**).
   - 미승인 → **rollback(아래 순서)** → failed.
   - 승인 → 진행.
5. reviewer reject → rollback → 재시도(baseline 동일 유지, 매 라운드 깨끗한 기준으로 복원).
6. 승인 + 리뷰 통과 → `keep`. **순차**: ignored 변경은 게이트 승인됨 → working tree 에 유지·감사. **병렬 worktree**: tracked 만 `keep`/`integrate`(cherry-pick)로 main 통합, **ignored 변경은 main 에 통합되지 않고 worktree 제거로 폐기**(Codex 권고 2 — 승인 문구에 "병렬 worktree ignored 변경은 작업 산출물로 미채택" 명시).
7. catch(예외) → rollback; abort → rollback + skipped. `finally` dispose.

**Rollback 순서 (고정, Codex 권고 3)**:
1. `ws.revert(base)` — tracked 변경 원복.
2. `ws.restoreIgnoredBaseline(baseline, changeSet)` — ignored 선택 복원.
3. 둘 중 하나라도 실패하면 실패 내용을 **누적해 task output/event 에 표면화**(`revertSafely` 패턴, #7 무성흡수 금지).

기존 reject 경로 두 곳(`orchestrator.ts:278` 승인거부, `:317` reviewer reject)과 `:321` 한도초과, `:350-369` catch 전부에 restore 를 빠짐없이 추가한다.

## 6. 위험 표면화 / 승인 (내용 비노출)

`classifyDiffRisk(diff, ignored?: IgnoredChangeSet)` 로 확장 — 위험 로직 단일 위치 유지:
- sensitive ignored 변경 → reason `"민감 ignored 변경: <path> (<kind>)"` + destructive.
- 일반 in-scope ignored 변경 → reason `"ignored 변경: <path> (<kind>)"` + destructive(*승인 없이 keep 금지* 계약; denylist 로 실빈도 낮음).
- unrestorable(over-cap/read-fail) → reason `"복원 불가 ignored N건: <paths>"` + destructive(escalate).

reason·gate `target` = **경로 + 변경종류만**. 파일 내용·patch·hash 미포함. reviewer 에게 가는 patch 는 기존대로 ignored 제외(무노출). 감사: `onEvent('workspace.ignored_changes', { paths, kinds, sensitive })` — 경로·종류만, worktree 경로 포함.

## 7. fail-closed

- **민감 baseline 실패**(capture read/backup) → `throw` → task hard-fail → reviewer/keep 경로 진입 금지(비밀 복원 보장 불가 시 진행 금지 = 최대 안전).
- **일반 baseline skipped**(over-cap/read-fail) → `changeSet.unrestorable` 로 표면화 → destructive escalate(승인=진행·미복원 인지, 거부=rollback).
- **restore 실패** → `revertSafely` 처럼 task output/event 에 누적 표면화(무성흡수 금지).
- **백업 폐기** → `disposeBaseline` 이 보유 Buffer 를 **best-effort zeroize**(`Buffer.fill(0)`), 모든 종료경로 `finally` 호출. 완료조건 표현은 "영속 store/log/prompt 에 비밀 미잔존 + finally best-effort zeroize"(JS GC/복사본 → 암호학적 완전삭제 보장 아님, Codex 권고 4).

## 8. 스코프 정책 기본값 (상수, 추후 config화 여지)

- `sensitiveRe` = `SENSITIVE_FILE`(`approval.ts:19` 재사용 — `.env*`·`.pem/key/p12/pfx`·`.ssh/`; non-global 이라 `.test()` lastIndex 문제 없음).
- `denylistRe` = `node_modules` · `.git` · `dist` · `out` · `build` · `.next` · `coverage` · `.cache` · `target` · `.turbo` · `.fleet-wt-*`.
- caps: `maxFiles 1000` · `maxTotalBytes 32MB` · `maxFileBytes 4MB`.

## 9. 테스트

**단위 (`ignored-baseline.unit`)** — capture/diff/restore(created 삭제·modified 복원·deleted 복원) · cap 초과 → unrestorable escalate · 민감 백업실패 → throw · Buffer zeroize · `!! ` prefix 파싱·디렉터리 재귀·NUL 구분. **Windows + POSIX**(경로 구분자·대소문자).

**통합 (`orchestrator`)** — 이슈 회귀 1~7:
1. 기존 ignored `.env` 수정 후 승인 거부 → 원문 복구, 내용 로그·prompt 미노출.
2. 새 ignored secret 파일 생성 후 실패 → 파일 제거.
3. ignored 파일 삭제 후 취소 → 복구.
4. tracked + ignored 변경 혼합 → 두 변경군 모두 감사·승인.
5. 대형 ignored 디렉터리/파일 → 상한 적용 및 escalate(승인=진행, 거부=가능분 복원).
6. 백업 생성 후 timeout/abort/예외 → 백업 폐기(dispose).
7. 병렬 linked worktree 종료 후 ignored 잔여물 0 + 탐지·감사됨(main 미통합).

**회귀** — tracked diff 동작·사용자 기존 dirty 변경 보존 무회귀. verify-fix 경로도 동일 가드 적용(Codex 권고 1).

(이슈 회귀 8·9 = symlink/junction/reparse = B 슬라이스로 분리.)

**게이트**: `typecheck · lint · format:check · test · build` + `npm run brain`.

## 10. 후속 (B 슬라이스)

A 머지 후, 본 이슈를 blocking dependency 로 한 별도 `type:security` sub-issue 로 분리:
- symlink/junction/reparse point 사전·사후 검사(workspace 밖 대상 차단).
- 프로세스 수준 격리(disposable worktree/OS sandbox), TOCTOU 한계 문서화.
- 이슈 회귀 8·9.

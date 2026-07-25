# #128-B1 설계 — Adversarial-FS 하드닝 + minor (Codex 리뷰 반영판)

> **이슈:** #128 (부모 #123) · **선행:** #123-A 머지(PR #127, `a08d835`)
> **체크포인트:** 설계 코멘트 [#4769968306](https://github.com/pdw96/fleet/issues/128#issuecomment-4769968306) + Codex 독립 리뷰(이슈 #128 스레드, chatgpt-codex-connector 2026-06-22) 반영.
> **날짜:** 2026-06-23

## 배경 / 스코프

#128은 난이도가 극단적으로 갈려 한 스펙/PR로 묶지 않는다. 이 슬라이스 **B1**은 `ignored-baseline.ts` 중심의 **adversarial-FS 하드닝 + 표면화 minor**만 다룬다.

- **분리(다음 슬라이스 B2):** 프로세스 수준 워크스페이스 격리(symlink/junction/reparse 사전·사후 검사, 순차→disposable worktree, CLI별 sandbox, TOCTOU 문서화). 아키텍처급·feasibility 검토가 본론 → 독립 설계 사이클.
- **무회귀:** A(PR #127)가 출하한 탐지·승인 게이트·선택 복원·fail-closed·비밀 비노출은 건드리지 않는다.

## 핵심 결정 (확정)

**denylist 디렉터리 내부 sensitive(`node_modules/.ssh/id_rsa`·`dist/.env`)는 B1 명시적 비목표.**
근거: ① denylist는 비용 경계(node_modules 통째 해싱 금지=A 비목표) ② bounded-scan + fail-closed-on-budget은 node_modules 있는 실프로젝트마다 cap 발화→매번 fail-closed→오케스트레이션 불가 ③ 이슈 원칙 #4("경로검사 ≠ 격리") — evasion 방어는 **B2 프로세스 격리**이지 스캔이 아님 ④ 얕은 depth-limit는 adversary가 더 깊이 중첩하면 우회. → 코드·스펙에 "보장하지 않는 것"을 명시하고 evasion 위협은 B2로 이관.

---

## 컴포넌트 설계

### A) non-regular 파일 가드 — read 전 `isFile()`

FIFO/socket/device로 교체된 ignored 파일에 `readFileSync` 하면 hang/오류. **위험 read 지점은 capture·collect 두 곳**(restore는 `writeFileSync`만, created 삭제는 `rmSync`만 — read 없음).

**capture (`captureIgnoredBaseline`):** `statSync` 직후, `readFileSync`/size-check 이전에 가드.
```ts
if (!st.isFile()) {
  if (sensitive) throw new Error(`민감 ignored 파일이 일반 파일이 아님(백업 불가): ${path}`)
  skipped.push({ path, reason: 'not-regular' })
  continue
}
```
- sensitive + non-regular → throw(fail-closed; 백업 불가한 민감 파일을 진행하면 fail-open 위험).
- non-sensitive + non-regular → `skipped{reason:'not-regular'}`("복원 불확실" 범주, 기존 `read-failed`와 형제).

**collect (`collectIgnoredChanges`):** 현재 `statSync(abs).size`만 뽑던 것을 full stat 보관 후 가드.
```ts
let st
try { st = statSync(abs) } catch { /* stat-failed → modified + unrestorable */ continue }
if (!st.isFile()) {
  // baseline 엔트리(원래 일반 파일)가 비-일반으로 교체됨 = modified. read 없이 표기(hang 방지).
  changes.push({ path, change: 'modified', sensitive: entry.sensitive })
  if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
  continue
}
const currentSize = st.size
// …이하 기존 size-cap·hash 로직 동일…
```
- backup 있으면 복원 가능(restore가 비-일반 leaf 제거 후 `writeFileSync`) → unrestorable 아님.
- `backup===null`은 현 구조상 capture 성공 엔트리엔 거의 없지만 타입 계약(`Buffer|null`)상 방어적 유지.

**타입 변경:** `IgnoredBaseline.skipped` reason union `'over-cap' | 'read-failed'` → `+ 'not-regular'`.

### B) restore ancestor-is-file 정리

중첩 백업 복원 시 **조상 경로가 파일**이면 `mkdirSync(dirname(abs))`이 ENOTDIR. 기존 P1-b는 leaf만 처리. → `restoreIgnoredBaseline`의 `mkdirSync` 직전, `root`→`dirname(abs)` 사이 조상 중 "존재하지만 디렉터리 아님"을 제거.
```ts
const clearNonDirAncestors = (abs: string): void => {
  const relDir = relative(root, dirname(abs))
  if (!relDir || relDir.startsWith('..')) return // dir===root 또는 root 밖 → no-op
  let cur = root
  for (const p of relDir.split(/[\\/]/).filter(Boolean)) {
    cur = resolve(cur, p)
    if (existsSync(cur) && !statSync(cur).isDirectory()) {
      rmSync(cur, { recursive: true, force: true })
      return // 파일 조상 제거됨 → 하위 조상은 부재 → mkdirSync recursive 가 체인 재생성
    }
  }
}
```
- 경로 정규화: `resolve(root, path)` 기준으로 root 하위만 처리(restore는 이미 `resolve(root, path)` 사용).
- baseline 내부엔 `a`(파일)·`a/b/c`(파일)가 동시 존재 불가(git 보고 모순)라 충돌 없음.
- import: `node:path`에 `relative` 추가.

### C) denylist 내부 sensitive = 명시적 비목표 (문서화)

`listIgnored`의 denylist skip 코멘트(현 "B 슬라이스로 연기")를 **"B1 확정 비목표 / evasion 방어는 B2 프로세스 격리로 이관(#128 잔여)"** 로 강화(상단 함수 doc + top-level skip + nested skip 세 곳). 기존 `[P2-6]` 반전 테스트가 경계를 이미 고정 → 코드 변경 없음, 코멘트+테스트 명칭만.

### D) minor 하드닝

**m1 — 병렬 worktree ignored 변경 폐기 경고 (A:303).**
병렬에서 승인된 ignored 변경은 `keep`(tracked만)→`integrate`(cherry-pick)로 main에 안 올라가고 worktree force-remove 시 폐기. Codex 권고대로 **경고는 병렬 통합/정리 단계**(정의상 worktree 경로)에서 task가 최종 `done`일 때만 낸다 → fragile한 `editRoot` 문자열 비교 불필요.
- `runTaskIn` 반환: `Promise<string | undefined>` → `Promise<{ keepHash?: string; ignoredTouched: boolean } | undefined>`.
  - `ignoredTouched` = 마지막 라운드 `collectIgnoredChanges` 결과에 `changes` 또는 `unrestorable`가 있었는지.
  - done 경로: `{ keepHash, ignoredTouched }`. 실패/스킵/취소/미승인: `undefined`(기존과 동일 의미).
- 순차 `runTask`/스케줄러: 반환의 `ignoredTouched`는 무시(순차는 ignored 변경을 main에 실제 적용 → 폐기 아님). **착수 전 확인:** 순차 토폴로지 루프가 `runTaskIn` 반환값을 done/failed 판정에 쓰지 않고 내부 set 으로만 처리하는지(현재 그러함) 재확인 후 구조 분해.
- 병렬: `integrate` 성공 후(=task 최종 done) `ignoredTouched`면 `store.appendEvent('workspace.ignored_discarded', { projectId, taskId })`.
  - **이벤트 타입:** 형제 `workspace.ignored_changes`와 동일하게 `store.appendEvent`(느슨한 타입) 사용 → `OrchestratorEventType` union 변경 **불필요**. (live UI 노출이 추후 필요하면 그때 union 확장.)

**m2 — SCAN_CAPPED를 rollback 단계서도 표면화 (A:294).**
- `restoreIgnoredBaseline`(standalone): `Promise<void>` → `Promise<{ capped: boolean }>`. capped = **현재 restore 호출**의 `listIgnored` skipped 에 `SCAN_CAPPED`(over-cap) 포함 여부 (`skipped.some(s => s.path === SCAN_CAPPED && s.reason === 'over-cap')`). baseline 시점이 아니라 현재 시점이어야 "에이전트가 cap 뒤에 숨겨 rollback 누락" 의미가 분명.
- `Workspace.restoreIgnoredBaseline` 인터페이스 반환 타입 동기화 + `createWorkspace` 래퍼.
- `rollbackWithIgnored`: 반환의 `capped`면 노트 누적 `" · ignored 스캔 상한 도달(일부 ignored 파일이 rollback 에서 누락될 수 있음)"`.
- **ripple:** ignored-baseline standalone · Workspace 인터페이스 · createWorkspace 래퍼 · rollbackWithIgnored 소비 · orchestrator 테스트의 mock/stub Workspace(restore 가 `{capped}` 반환하도록).

**m3 — capture 비-sensitive `read-failed` 분기 테스트** 추가(not-regular 와 분리 회귀 고정).

**m4 — `:143` zeroize 단언 강화:** `vi.spyOn(node:fs,'readFileSync')`로 백업 Buffer 참조를 잡아 throw 후 실제 `.fill(0)`(모두 0) 검증.

**m5 — `disposeBaseline` 빈-Buffer 가드:** `if (entry.backup && entry.backup.length > 0) entry.backup.fill(0)`(의도 명확화, 무해).

---

## 데이터/인터페이스 변경 요약

| 심볼 | 전 | 후 |
|---|---|---|
| `IgnoredBaseline.skipped[].reason` | `'over-cap'\|'read-failed'` | `+ 'not-regular'` |
| `restoreIgnoredBaseline()` (standalone) | `Promise<void>` | `Promise<{ capped: boolean }>` |
| `Workspace.restoreIgnoredBaseline()` | `Promise<void>` | `Promise<{ capped: boolean }>` |
| `runTaskIn()` 반환 | `string \| undefined` | `{ keepHash?: string; ignoredTouched: boolean } \| undefined` |
| 신규 store event | — | `workspace.ignored_discarded`(appendEvent, union 변경 없음) |

## 에러 처리 / fail-closed 불변식

- 민감 파일 비-일반·백업 불가 → capture throw → orchestrator hard-stop(기존 민감 백업 실패 경로 재사용).
- 비밀 비노출: 모든 신규 표면(경고 이벤트·rollback 노트·gate target)은 **경로·종류만**, 내용·hash 비노출.
- SCAN_CAPPED 합성 마커는 실-경로 아님 — restore 삭제/표면화에서 계속 제외.

## 테스트 매트릭스

| 항목 | 플랫폼 | 방식 |
|---|---|---|
| A capture 가드(로직) | Win+POSIX | fake git이 비-디렉터리 의도 경로 반환 + 디스크엔 디렉터리 → `!isFile()` 발화(크로스플랫폼) |
| A capture FIFO 실 hang | POSIX-only | `child_process` `mkfifo` (`process.platform!=='win32'` 가드) |
| A collect 비-일반→modified | Win+POSIX | baseline 캡처 후 파일→디렉터리 교체 |
| B ancestor-is-file | Win+POSIX | baseline `a/b/c.txt` 캡처 → `a`를 파일로 → restore 시 `a` 제거+복원 |
| m2 capped 반환+노트 | Win+POSIX | maxFiles=1, 2파일 → `{capped:true}` + rollback 노트 |
| m1 폐기 경고 | Win+POSIX | 병렬 worktree task done+ignored 변경 → `ignored_discarded` append |
| m3 read-failed | Win+POSIX | 비-sensitive read 실패 skip |
| m4 zeroize | Win+POSIX | fs spy 버퍼 참조 |

## 영향 파일

- `src/main/core/workspace/ignored-baseline.ts` (+`.test.ts`) — A·B·C·m2(standalone)·m5
- `src/main/core/workspace/git.ts` — Workspace 인터페이스 + createWorkspace 래퍼(m2)
- `src/main/core/orchestrator/ignored-guard.ts` (+`.test.ts`) — m2 노트 누적
- `src/main/core/orchestrator/orchestrator.ts` (+`.test.ts`) — m1(runTaskIn 반환·병렬 emit)

## 검증

5게이트 `typecheck · lint · format:check · test · build` + `npm run brain` 갱신. scoped commit(변경 파일만, `git add -A` 금지).

## 비목표

B2 프로세스 격리(symlink/junction·disposable worktree·sandbox) · denylist 내부 sensitive 스캔 · A 출하분 재구현 · `OrchestratorEventType` union 확장(store.appendEvent로 회피).

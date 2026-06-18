# 오케스트레이터 독립 작업 병렬 실행 (#80) 설계

- **날짜**: 2026-06-18
- **대상**: GitHub 이슈 #80 `후속(오케스트레이터): 독립 작업 병렬 실행 + mixture_of_agents 집계`
- **유형**: 코어 실행 모델 변경 — 오케스트레이터(스케줄러) + 워크스페이스(git 격리) + CLI 세션 레이어
- **교차검증**: context7(git 현행 문서) + `codex exec`(gpt-5.5, 실코드 read-only) — **치명 4 / 권고 6 반영**

## 배경 / 문제

Fleet 오케스트레이터는 작업을 `dependsOn` 위상 순서로 스케줄하지만, **의존성이 없는 독립 작업도 한 번에 하나씩 순차 `await`** 로 실행한다.

- 위상 sweep 루프 `orchestrator.ts:356-411` 이 의존성이 모두 `done` 인 작업을 찾으면 `await runTask(task)`(`orchestrator.ts:387-388`)로 직렬 실행 → 독립인 A·B 도 A 끝→B 시작.
- 보정 replan 실행도 순차: `orchestrator.ts:589-598` 의 `for (const ct of corrective) { … await runTask(created) }`.
- **순차가 강제되는 근본 원인 = 단일 공유 워크스페이스.** 모든 작업이 하나의 git 워크스페이스에서 `checkpoint`/`collectDiff`/`keep`/`revert` 를 공유한다(`runTask` 내 `ws.checkpoint()` `orchestrator.ts:222`). git 구현은 단일 레포 HEAD 에 `reset --hard` + `clean -ffd`(`git.ts:146-150`).
- 이 전제는 엔진에 명시적으로 박혀 있다: `runProjectFlow` 는 `activeRuns.size > 0` 이면 두 번째 **프로젝트** 실행을 거부한다(`engine.ts:556-564`).
- mixture_of_agents 집계는 **코드에 전무**(grep 0).

Hermes Agent(#344) 비교에서 도출된 신규 갭. 가치는 실행 시간 단축(독립 작업 N개 병렬화)이나 **effort/risk 상** — 워크스페이스 격리가 비용 대부분이고, 코어 안전 모델을 건드린다.

## 결정 (사용자 승인 완료)

1. **옵트인 병렬 — 한 PR**. `RunOptions.maxConcurrency`(기본 1). `=1` 이면 기존 경로 **바이트 동일 무회귀**, `>1` 에서만 병렬.
2. **워크스페이스 격리 = git worktree per task**(`--detach`). 디렉토리 복제(무거움)·단일 트리 브랜치(동시 편집 불가)는 비채택.
3. **메인 통합 = 작업 생성 순서(결정론)대로 `cherry-pick`**. 다른 파일=무충돌, 같은 파일=3-way 충돌 시 `--abort` 후 **그 작업만 failed 격리**(기존 실패-격리 계약과 일관).
4. **CLI 세션 레이어 포함**(결함 ①). worktree 격리만으론 `cli-session.ts` 직렬화 때문에 실제 병렬이 안 되므로, **작업별 독립 편집 세션**을 함께 도입. 둘을 분리하면 worktree 격리가 데드코드가 된다.
5. **mixture_of_agents 집계는 제외**(이슈도 "별도 PR 권장"). 본 PR은 병렬 실행만.

## 교차검증 결과 (착수 전 반영 필수)

### context7 (git 현행 문서) — 확인·보강 4

- **A. 락 격리 ✅** — worktree 는 "per-worktree files such as HEAD, index" 를 별도 보유. 작업별 index 가 `<main>/.git/worktrees/<id>/index` 로 분리되어 `git.ts:57-59` 의 index.lock 경합이 구조적으로 사라진다.
- **E. `--detach` 필수** — 같은 브랜치가 다른 곳에 체크아웃돼 있으면 `worktree add` 가 거부(`--force` 필요). detached HEAD 로 base 커밋에서 생성해 브랜치 경합 회피.
- **B. `--allow-empty --empty=drop` 필수** — 기본 빈 커밋 cherry-pick 은 실패, 중복 변경은 `--empty=stop`. `keep()` 이 `--allow-empty`(`git.ts:88`)라 필요.
- **롤백 안전 ✅** — `cherry-pick --abort` 가 working tree 를 이전 상태로 복구.

### codex exec (gpt-5.5, 실코드 read-only) — 치명 4 / 권고 6

| # | 결함 | 근거(file:line) | 반영 |
|---|---|---|---|
| ① **치명** | worktree 를 나눠도 실제 편집 에이전트는 **병렬 실행 안 됨** | `cli-session.ts:208-227` `send()` 가 `chain` 직렬화(workspace 달라도 같은 큐) + engine 이 implementer 를 단일 CLI 세션으로 재배정 `engine.ts:599-606` | **작업별 독립 편집 세션 인스턴스**(편집은 stateless 라 안전 — `cli-session.ts:230` "유지 리소스 없음") |
| ② | linked worktree 락 제거 경로 오류 | `ok()` 가 `join(root,'.git','index.lock')` 만 제거 `git.ts:68`. 실제 락은 `<main>/.git/worktrees/<id>/index.lock`(worktree 의 `.git` 은 `gitdir:` 파일) | worktree 워크스페이스는 락 경로를 `git rev-parse --git-path index.lock` 으로 동적 해소 |
| ③ | cherry-pick committer identity 재발 | 내부 commit 은 `-c user.name=Fleet -c user.email=fleet@local` `git.ts:80-91`, cherry-pick 엔 없음 → identity 미설정 머신 실패 | 통합 cherry-pick 에 동일 `-c` 부여 |
| ④ | worktree 정리 실패 | `collectDiff` 가 `add -A`(ignored 미수집) `git.ts:124-127`, `revert` 가 `clean -ffd`(ignored 잔존) `git.ts:146-150` → ignored 산출물(node_modules·dist·.env)로 `worktree remove` dirty 거부 | `worktree remove --force` |

**권고(반영):**
- B-보강: `keep()` 항상 `--allow-empty`(`git.ts:140-145`) → 변경 0개 작업이 main 에 빈 커밋을 남길 수 있음 → **통합 전 worktree 변경 여부 확인(빈 worktree 는 통합 스킵)**.
- B-보강: 통합 cherry-pick 중 main worktree 가 dirty 면 실패 → **통합 직전 main `status --porcelain` dirty 가드**.
- A-보강: 통합 단계 cherry-pick 을 기존 `ok()` 로 감싸면 main `.git/index.lock` 강제 제거가 **외부 사용자 git 프로세스와 경합** 위험 → 통합 단계는 락 강제 제거를 하지 않는 경로 사용(또는 main 워크스페이스 한정 신중 적용).
- E-보강: worktree 경로/이름은 **taskId sanitize**. `worktree add/remove` 자체는 common gitdir 를 만지므로 **생성/정리는 순차화**(편집만 병렬).
- C-보강: `maxConcurrency` 는 `shared/types.ts` RunProjectRequest(~:365)·engine(`engine.ts:625`)에 **미존재** → 추가 + **engine 경계 정수/상한 clamp**(`[1,4]`).
- D-보강: 편집 cwd 를 worktree 로 바꾸면 절대경로/ignored·untracked 파일(.env·로컬설정·generated)이 worktree 에 없어 동작이 달라질 수 있음 → 알려진 한계로 문서화.

## 아키텍처

### 컴포넌트 (각 단위의 책임·인터페이스·의존)

1. **maxConcurrency 옵션 배선** — `shared/types.ts` `RunProjectRequest.maxConcurrency?` 추가 → `engine.ts:625` runProject 호출에 정수/`[1,4]` clamp 후 전달 → `RunOptions.maxConcurrency`. UI(`ProjectPanel`)는 본 PR 범위 밖(기본 1 사용); engine 경계 clamp 가 신뢰 경계. **의존**: 없음(순수 옵션 추가).

2. **워크스페이스 격리 API** (`workspace/git.ts`) — `Workspace` 인터페이스에 작업별 격리 메서드 추가:
   - `addWorktree(taskId, base): Promise<Workspace>` — `git worktree add --detach <tmp>/<sanitized> <base>` 후, 그 worktree root + **자체 락 경로**(`rev-parse --git-path index.lock`)를 가진 `Workspace` 를 반환. 반환된 워크스페이스의 `checkpoint`/`collectDiff`/`keep`/`revert` 는 worktree 안에서 동작.
   - `integrate(taskWorktree): Promise<{ ok: boolean; conflict?: string }>` — 변경 있으면 main dirty 가드 → `cherry-pick -c user.name=Fleet -c user.email=fleet@local --allow-empty --empty=drop <keepCommit>`; 충돌 시 `cherry-pick --abort` 후 `{ ok:false }`. 빈 worktree 는 no-op `{ ok:true }`.
   - `removeWorktree(taskId): Promise<void>` — `git worktree remove --force`.
   - 단위 검증 가능(GitRunner mock 주입, 기존 패턴 `git.test.ts`). **의존**: `cli/detect`(기존).

3. **작업별 독립 편집 세션** (결함 ① 해결) — `RunOptions.makeEditSession?: (descriptor) => LlmSession` 팩토리 주입. engine 이 implementer CLI descriptor 로 **작업당 새 `createCliSession` 인스턴스**(독립 chain)를 만들어 줌. 편집은 stateless 라 상태 공유·dispose 불요. `maxConcurrency=1` 이면 팩토리 미사용(기존 단일 세션). **의존**: `session/cli-session`(기존 `createCliSession`), engine 의 adapter/runner 접근.

4. **병렬 sweep 스케줄러** (`orchestrator.ts`) — `maxConcurrency>1` 전용 분기. 실행가능(deps done) 집합 수집 → worktree 순차 생성 → `Promise.allSettled` 로 작업별(독립 세션·worktree) `runTaskIn(task, taskWorkspace, editSession)` 병렬 → 생성순 순차 통합 → 순차 정리. **의존**: 위 1~3.

5. **runTask 매개변수화** — 기존 `runTask(task)` 가 클로저로 `opts.workspace`·단일 implementer 를 캡처하는 것을, `runTaskIn(task, ws, implementer)` 로 워크스페이스·세션을 주입받게 추출. `maxConcurrency=1` 경로는 기존과 동일 인자(메인 ws·단일 세션)로 호출 → **동작 불변**.

### 실행 흐름

**`maxConcurrency > 1`:**
```
실행가능 집합 수집 (deps 모두 done)
  → [순차] 각 작업: addWorktree(taskId, checkpoint)        # common gitdir 보호
  → [병렬] Promise.allSettled: runTaskIn(task, wt, editSession(task))
            (편집→리뷰→위험게이트→worktree-local keep; 락 경로 worktree별)
  → [순차·생성순] main dirty 가드 → integrate(wt)
            (변경있음→cherry-pick; 충돌→abort+failed; 빈 worktree→스킵)
  → [순차] removeWorktree(taskId)
  → 다음 sweep (새로 deps 충족된 작업)
```

**`maxConcurrency = 1`(기본):** 위 분기를 **완전 우회** — 기존 `while…for(await runTask(task))` 루프(`orchestrator.ts:361-411`) 바이트 동일. worktree·cherry-pick·편집 팩토리 미진입.

### 결정론

- **통합 순서 = 작업 생성 순서**(병렬 완료 순서 아님) → main HEAD 진행·done/failed 집합 결정론.
- **이벤트 순서**: `maxConcurrency>1` 에선 `task.started`/`task.implemented` 가 인터리브(새 동작, 새 테스트로 검증). `=1` 에선 기존 순서 보존(`orchestrator.test.ts:501` `['B','A']` 의존순서 green 유지).
- **실패 격리**: 한 작업 실패(편집 throw·미승인·통합 충돌)가 다른 작업/전체를 오염시키지 않음(현 `orchestrator.ts:253-268` 계약의 병렬 버전).

## 에러 처리 / abort

- 편집/리뷰 throw → 해당 worktree revert(`revertSafely`)·작업 failed, 다른 작업 무영향(`Promise.allSettled`).
- 통합 cherry-pick 충돌 → `--abort` 후 그 작업 failed(메인 깨끗 유지), 후속 작업 통합 계속.
- **abort(취소)**: in-flight 병렬 작업 전체가 `opts.signal` 로 중단 → 각 worktree revert → **모든 worktree 정리**(잔존 변경 없음) → 통합 스킵. 기존 abort 계약(`orchestrator.ts:336-344` 취소=skipped, failed 집계 제외)의 병렬 버전.
- worktree add/remove 실패 → 해당 작업 격리(순차 폴백 또는 failed), 전체 중단 안 함.

## 테스트 전략 (TDD)

- **무회귀(최우선)**: 기존 `orchestrator.test.ts` 전건 green(특히 `:501` 의존순서). `maxConcurrency` 미지정/=1 에서 이벤트·commit·done/failed 바이트 동일.
- **병렬 동작**: 독립 작업 2개가 격리 워크스페이스에서 동시 실행(가짜 워크스페이스로 동시성 관측 — 두 편집이 서로의 keep 전에 진입) + 직렬 대비 wall-clock 단축.
- **통합 결정론**: 생성순 cherry-pick, 충돌 작업만 failed, 나머지 적용. 빈 worktree 스킵. main dirty 가드.
- **격리 단위**(`git.test.ts`): addWorktree(`--detach`)·integrate(identity·`--allow-empty --empty=drop`·충돌 abort)·removeWorktree(`--force`)·락 경로 동적 해소(GitRunner mock).
- **편집 세션 병렬성**: 작업별 독립 세션이 chain 직렬화를 우회함(같은 descriptor 두 인스턴스가 동시 send).
- **abort**: 병렬 in-flight 취소 → 전 worktree 정리·통합 스킵·failed 종료.
- **폴백**: worktree 미지원/non-git → 순차.
- 4 게이트(typecheck·lint 0·test·build) green + 적대 리뷰.

## 검증 (완료 조건)

- [ ] 독립 작업 ≥2 가 격리 워크스페이스에서 동시 실행되고 직렬 대비 wall-clock 단축(테스트 확인).
- [ ] `maxConcurrency` 기본값에서 기존 순차 동작·결정론·이벤트 순서 보존(회귀 green).
- [ ] 병렬 작업 실패가 다른 작업/전체를 오염시키지 않음.
- [ ] abort 시 모든 in-flight worktree revert·정리, 잔존 변경 0.
- [ ] 결함 ①~④ + 권고 전건 코드 반영(작업별 독립 세션·worktree 락 경로·cherry-pick identity·`--force` 정리·빈커밋 스킵·main dirty 가드·생성정리 순차화·sanitize·engine clamp).
- [ ] 4 게이트 green + CI(ubuntu+win).

## 비목표 (YAGNI)

- **mixture_of_agents 집계**(이슈도 별도 PR 권장 — 본 PR은 병렬 실행만).
- `maxConcurrency` UI 노출(기본 1; 후속 슬라이스).
- 동시 **프로젝트** 실행(`engine.ts:556-564` 가드 유지 — 한 프로젝트 내 작업 병렬과 별개).
- submodule 워크스페이스 완전 지원(드묾; 알려진 한계로 둠).

## 알려진 한계

- **ignored/untracked 파일**: worktree 에는 main 의 `.env`·로컬설정·generated 파일이 없다. 편집 에이전트가 이에 의존하면 병렬 모드에서 동작이 달라질 수 있다(maxConcurrency=1 기본이라 옵트인 시에만).
- **절대경로**: 편집 에이전트가 cwd(worktree) 밖 절대경로를 만지면 격리 우회(기존에도 존재하는 신뢰 경계). Codex 는 `-C`+sandbox 로 상대적으로 안전, claude/gemini adapter 보장은 다름.
- **통합 단계 main 락**: 통합 cherry-pick 은 main 워크스페이스를 만지므로, 외부 사용자 git 과의 경합은 락 강제 제거를 피하는 경로로 완화하되 완전 차단은 아니다.

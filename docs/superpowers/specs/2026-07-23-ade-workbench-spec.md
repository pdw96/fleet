# ADE 1축 스펙 — Workbench 병렬 작업 공간 (체크포인트 2 · 스펙)

이슈 #251 (Part of #250). 체크포인트 1(설계, `2026-07-22-ade-workbench-design.md` · Codex 24R **Approved**)을
**구현 가능한 계약**으로 확정한다. 이 문서는 **무엇(계약·불변식·parity·테스트)** 을 정의하고,
**어떻게(태스크 순서·분할)** 는 체크포인트 3(계획, fleet-plan-panel)에 위임한다.

> **실측 기반 작성**: 본 스펙은 28기 병렬 실측 에이전트(코드 10 · 플랫폼 실현가능성 6 · 열린질문 12)의
> 결과 위에 썼다. 모든 계약은 파일:라인 또는 실행 재현 근거를 가진다. 실측 결과 **설계 원문과 사실이
> 어긋나는 P1 항목 12건**이 확인됐고(§0.1), 이는 스펙에서 정정 계약으로 선반영한다.
> **§0.1 이 설계 원문에 우선한다** — Codex 재리뷰는 §0.1 을 반영한 계약을 대상으로 해주기 바란다.
>
> **적대 반증 반영(로컬 8렌즈 · 2026-07-23)**: 초안을 fail-closed·race·타입/parity·테스트 false-green·
> 설계 정합·Codex 6항·범위·정직성 8렌즈로 사전 반증했다. **정직성 감사에서 인용 30여 곳·수치 실측
> 전량이 재현되어 사실 층은 반증 실패**했으나(허위 인용 0건), **정정이 만든 2차 효과와 스펙 내부 모순
> 12건이 확정**돼 아래에 반영했다: ①POSIX 락 회수의 이중 소유(§W-3 L-6/L-7·회수 뮤텍스 신설)
> ②L-5 자기위반(§W-9·§W-18 승인 2-페이즈) ③C10↔C12 모순(§W-6 경로 seam) ④W-16 ①의 트리 사망 증거
> 부재 ⑤C6 미전파로 integration-ready 막다른 길(§W-18 I11 재정의·`abandon` 액션) ⑥계약 2·5항 검증
> 불가(T14/T19 재작성 — **in-process 2인스턴스는 같은 ESM 모듈을 공유하므로 모듈 캐시 구현이 GREEN
> 통과**) ⑦계약 4항 브랜드 토큰이 spawn 을 막지 못함(launcher 필수 인자로 교체) ⑧win32 강등이 revision
> 단조를 깨고 4번째 분기 앵커가 발화 불가(ref-앵커로 교체) ⑨미지 schemaVersion 이 신버전 권위를 삭제하는
> 경로(`incompatible-version`·I12) ⑩코디네이션 영역 위협 모델 미선언 ⑪ProjectPanel parity 누락
> ⑫PR 규모 실측(6~9). **범위 대안은 §7.**
>
> **계획 체크포인트 3 반영(판사 패널 · 2026-07-23)**: `fleet-planner`×3(리스크/MVP/계약) → `fleet-plan-judge`×2
> (공백 렌즈 / Codex 강점 렌즈). **두 판사 승자 일치 = 초안 A(리스크 우선)**. 판사가 **코드를 직접 열어**
> 교차 확정한 스펙 결함을 본문에 선반영했다 — **P1 4건**: ①**L-5 스코프**(무스코프 문안이 §W-16 과 충돌해
> bench 런의 승인 4경로를 전부 불가능하게 만듦 · `mcp/host.ts:245` 전역 `setServers` 가 단독 반증)
> ②**`execGate` 전이 시점 미정**(spawn 뒤면 살아있는 자식을 "0줄 실행"으로 오분류 = fail-open)
> ③**POSIX 트리 사망 배관 부재**(`kill-tree.ts` win32 전용 · `detached` 필드 없음 · §2 미등재)
> ④**§3-T58 검증 수단이 fs mock 금지와 구현 불가능하게 충돌**. **P2 12건**(store 인터페이스 자기모순 ·
> `revalidate` 부재 · `release()` 정준 링크 · 슬롯 개수 분열 · fixtures 무신호 · 킬스위치 부재 ·
> 승인 카드 bench 식별 · T13/T42 반증력 · 조건부 스키마 §3 행 부재 · 통합 WAL 순서 단언 부재 등).
> **커버리지 산술 정정**: 구속 메트릭은 브랜치가 아니라 **statements**(여유 2.25pt)이고, **분모 이동**과
> **CI 플랫폼 비대칭**(win32 코드가 분모에만 들어감)을 반영해 §3.1 을 신설했다.

---

## 0. 현행 계약 (코드 실측 — 근거 라인)

| 지점 | 현행 동작 | 근거 |
|---|---|---|
| git 표면 | export 는 정확히 8개 — 타입 5(`GitResult`·`GitRunner`·`DiffResult`·`TaskWorktree`·`Workspace`) + 값 3(`createGitRunner`·`defaultGitRunner`·`createWorkspace`). `sanitize`·`worktreeDir`·`ok`·`lockPath` 는 **모듈 프라이빗** | `workspace/git.ts:24,29,32,43,45,66,76,84` |
| worktree 경로 | `join(root,'..','.fleet-wt-'+sanitize(id))` — **디렉터리 인자 없음**(내부 유도). `addWorktree(taskId, base)`·`removeWorktree(taskId)` | `git.ts:79-82,189,232` |
| `sanitize` | `id.replace(/[^a-zA-Z0-9_-]/g,'_')` — **비단사**(`a/b`·`a?b`→`a_b` 붕괴) | `git.ts:79` |
| `ok()` | index.lock 재시도 4회 + `attempt>=1` 시 락 파일 **강제 rmSync**. 안전 근거 주석 = "오케스트레이터는 순차 실행". `integrate` 는 의도적으로 우회 | `git.ts:86-116,205` |
| `lockPath()` | `rev-parse --git-path index.lock` 을 **그 Workspace 의 root** 에서 실행 → `worktree add/remove`(공통 gitdir 다툼)에서는 **오조준 삭제** | `git.ts:91-96` |
| git 실행 | `defaultRunner('git',…,{timeoutMs:120_000,cwd,signal,env})`. 타임아웃/취소/10MB 초과 = `code:null` | `git.ts:59,66-73` · `cli/detect.ts:49,120,156` |
| `createWorkspace` 내부 `run` | `git.run(args, root)` — **signal 미전달**. 현행 모든 Workspace git 연산은 취소 불가 | `git.ts:85` vs `git.ts:30` |
| 영속화 | `createJsonFileStore` = 생성 시 1회 로드 + 매 변경마다 **전체 `StoreState` 스냅숏 tmp→rename 덮어쓰기**. `persist: (state)=>void`, 오류 catch 삼킴, **fsync 0** | `store/json-file.ts:29,32-45,50-57` · `store/types.ts:79` · `store/memory.ts:85-87` |
| 단일 활성 런 가드 | `activeRuns.size > 0` → 두 번째 `runProjectFlow` 거부 | `engine.ts:653` |
| 런 루트 파생 | 런 1회에 **3값**: `workspace: currentWorkspace()` · `workspaceRoot: workspaceDir` · `verify: currentVerify(signal)`(=`npmVerifyCommands(dir)`) | `engine.ts:255,258-268,742-745` |
| `getRunActivity()` | `{activeProjectIds}` — 소비자 3곳이 **전역 의미**로 읽음: `workspace:set` 차단 · 드레인 대기 · 렌더러 running 잠금. 정확일치 단언 5건 | `engine.ts:783-788` · `set-workspace.ts:26` · `boot.ts:680` · `ProjectPanel.tsx:213-217` · `engine.test.ts:630,652,657,683,688` |
| 채팅 경로 | workspace 를 **한 번도 전달하지 않음**. `SendOptions.workspace` 는 cli-session 에서 **편집 모드(항상 stateless/fresh) 스위치** | `engine.ts:815-825` · `session/types.ts:17` · `cli-session.ts:169,226-227` |
| spawn 관문 | 사용자 코드 spawn 지점 **2개** — `cli/detect.ts:120`(defaultRunner) **및 `mcp/stdio.ts:17`(cross-spawn 직접)**. 후자는 관문 밖 | `detect.ts:120` · `mcp/stdio.ts:15,17,37-40` |
| killTree | **win32 전용** — POSIX 는 `child.kill()` 단발(손자 잔존) | `cli/kill-tree.ts:49,60-63` · `detect.ts:145-152` |
| 승인 게이트 | C1 완료형 — hold·expiresAt·`ApprovalOutcome`·signal 관통·tombstone·`listPendingApprovals`. `kind` 는 게이트 내부 분기 없는 pass-through | `safety/approval.ts` · `approval-bridge.ts` |
| 프로덕션 승인 TTL | **30분**(`FLEET_APPROVAL_TTL_MS=1800000`, 상한 `APPROVAL_TTL_MAX_MS`) | `deploy/.env:43` · `boot.ts:234` |
| 채널 게이트 | `CHANNEL_FIXTURES` 는 `Record<BothInvokeChannel,…>` — **push 채널 미커버**. 서버 push 배선(`wsHost.broadcast`) 강제 게이트 **0건** | `transport/fixtures.ts:112` · `serialization.test.ts:13-15` · `ws-host.ts:34` |
| 커서 계약 | hello 는 **채널 무관 전역 커서 1쌍**, 클라 전진은 `onOrchestratorEvent` 단일 구독에만 결속 | `protocol.ts:53-57` · `ws-host.ts:75-79` · `hydration.tsx:54-56` |
| e2e 게이트 | playwright 는 **PR CI 게이트 아님**(dispatch + nightly cron). `verify` 순서상 vitest 가 `build` **앞** → vitest 는 `out/` 산출물 의존 불가 | `.github/workflows/e2e.yml:7-10` · `ci.yml:99-100` · `package.json:44` |
| 기본 탭 전제 | `approval-hold.web.e2e.ts:52-59` 는 탭 클릭 없이 `#mcp-servers` 조작(세션 탭 기본 전제) · `App.test.tsx:17,23-25` 동일 | 해당 라인 |
| 컨테이너 | `init: true` 실재 · fleet-data 전용 named volume + Dockerfile `USER node` 이전 mkdir+chown 선례 · `/workspace` 는 fleet·ttyd **양쪽 마운트** | `deploy/docker-compose.yml:27,36-37,71,98-110,147-149` · `Dockerfile:62-65,70,75` |
| fs mock | `vi.spyOn(node:fs)` 는 win32 ESM 에서 non-configurable 실패 → 기존 테스트가 **조용한 skip** 처리. `vi.mock('node:fs')` 선례 0건 | `ignored-baseline.test.ts:142-149,244-247` · `path-guard.test.ts:29-35` |

---

## 0.1 설계 원문 대비 **정정 계약** (P1 · 실측 근거)

설계 문서는 24라운드 누적 개정이라 폐기된 모델의 잔재와 플랫폼 사실과 어긋난 문장이 남아 있다.
아래 12건은 **스펙이 설계에 우선**한다.

| # | 설계 원문 | 실측 | 정정 계약 |
|---|---|---|---|
| **C1** | 결과 ref = `refs/fleet/integrated/<benchId>`(428·440·388·803·824행) **와** `.../<benchId>/<txnId>`(456행) 공존 | git 은 같은 이름이 ref이자 ref-디렉터리일 수 없다 — `fatal: '…/<benchId>' exists; cannot create '…/<benchId>/<txnId>'` **exit 128**(loose·packed·reftable 전부). `check-ref-format` 은 둘 다 통과시켜 문법검증으로 못 잡음 | **`refs/fleet/integrated/<benchId>/<txnId>` 단일 문법.** `<benchId>` 는 **ref 로 절대 생성하지 않는 디렉터리 전용 접두사**. 발행 전 프로브에 "`<benchId>` 가 ref 로 해석됨" 검사 추가 → 존재 시 `REF_NAMESPACE_CONFLICT` fail-closed(자동 삭제 금지). 소비자 명령·§5 완료정의 문자열 전부 txn 형태로 정정 |
| **C2** | "OS 자문 락은 프로세스 종료 시 자동 해제 → 획득 가능 = 소유자 부재 증명"(408-410행), 메커니즘 = "파일 락" | Node 24.16.0 에 `fs.flock`/`fs.constants.LOCK_EX`/`O_EXLOCK` **전부 부재**. 의존성 6종 전부 순수 JS. `wx`/mkdir 은 자동 해제 없음 → "연령 삭제 금지"와 결합 시 영구 고착. **POSIX AF_UNIX 는 SIGKILL 후 소켓 파일이 남아 `listen` 이 계속 EADDRINUSE** — 설계가 실제로 의존하는 **역명제(획득 실패 ⇒ 소유자 생존)가 거짓** | 메커니즘 = **`node:net` 엔드포인트 배타 바인딩**(win32 named pipe / POSIX 유닉스 도메인 소켓). 부재 증명식을 백엔드별로 분리(§W-3). stale 회수 근거는 **연령이 아니라 커널의 ECONNREFUSED(거절 증거)** — 408행 금지 원칙 유지 |
| **C3** | "파일 + **부모 디렉터리** fsync 를 요건으로 한다"(697-700행) | win32: `fs.openSync(dir,'r')` 은 성공하나 `fsyncSync(dirFd)` = **EPERM**. libuv `fs__fsync`=`FlushFileBuffers`, `O_DIRECTORY` 부재. rename 도 `MOVEFILE_WRITE_THROUGH` 미지정 | **`DurabilityLevel = 'file+dir' | 'file-only'`** 를 레코드에 기록. 부팅 1회 실측 프로브로 결정, win32 = `'file-only'` **명시 강등**(조용한 스킵 금지·UI/런북 노출). **복구 4번째 분기 신설**(§W-7-복구). ⚠ **이는 Codex 3항의 충족이 아니라 회피이며 win32 의 안전 등급은 실제로 낮다** — 그 파급(revision 단조 미보장·탐지 앵커를 권위 파일 밖 git ref 로 이동)을 §W-4·§W-7 에 명시한다 |
| **C4** | "확인-응답 쓰기 = 원자적 rename + 오류 전파"(665-667행) | win32 `rename` 은 **대상에 열린 핸들이 하나라도 있으면 EPERM**(읽기 전용·동일 프로세스 포함). 설계가 요구하는 다중 부팅 표면 공유 저널이 정확히 그 조건 | rename 실패 코드 `{EPERM,EBUSY,EACCES}` **유한 재시도**(4회·백오프) 후 `io-failure` 승격. **리더 규율 불변식**: 권위·저널 파일은 `readFileSync` 즉시-close 만 허용, 장기 핸들·watch 금지 |
| **C5** | `targetHeadAfterIntegration` 캡처 + 결과 종별 `applied|already-applied`(668-672·685·690-693행) | 17R 확정(Fleet 은 baseRef 를 **어떤 경우에도** 전진시키지 않음)으로 `after === before` 가 항상 참 → **판별력 0**. 결과가 발행 직후 target 에서 도달 불가한 것이 **정상** | 필드 폐기. `resultOid`·`resultTree`·`resultKind` 로 교체. "이미 반영됨" = **결과 트리 == 캡처된 base 트리** 로 재정의. 6R 잔재 제거 |
| **C6** | "미결 저널 = reconciliation-required(실행·통합 차단)"(38-39·288-289·713-714행) | 2단 발행에서 `published` 저널은 **소비자 완결까지 무기한 열려 있는 정상 상태**. 문자대로 구현하면 모든 integration-ready bench 가 즉시 차단 → **D3 자기모순** | 저널을 **stage별 판정**으로 재규정: `prepared`·`composed` 잔존(락/리스 미보유) = 크래시 잔재 = reconciliation-required / **`published` = 정상 대기**(차단 아님) / `finalized`·`abandoned` 잔존 = 청소 복구 |
| **C7** | WAL 3단계 `prepared→git-applied→finalized`(678행) | `prepared` 이후 크래시 시 "ref 는 생겼는데 resultOid 기록 전" 이 유일한 진짜 모호 구간 | **4단계 + 종결 1**: `prepared → composed → published → finalized` (+ `abandoned`). `composed` 에서 `resultOid` 선기록 → 발행 전후 크래시가 **등식 판정**으로 닫힘(추론 0) |
| **C8** | 컨테이너 ② 증거 = "**컨테이너 인스턴스 신원(부팅 마커)**"(587-589행) | `/proc/sys/kernel/random/boot_id` 는 **호스트 값** — 컨테이너 4회 재시작 내내 동일(실측). 인스턴스마다 변한 건 `/proc/1/stat` field22 starttime 뿐 | 인스턴스 마커 = **`sha256(hostBootId + ':' + pid1StartTicks)` 쌍**. `boot_id` 단독·`hostname`·`machine-id` 는 **부적격**(fail-open) |
| **C9** | "`cgroup.procs` 공백 = 사후 증거"(577-578·615-616행) | `cgroup.procs` 는 **직접 소속 PID 만** 나열 — 자손 cgroup 프로세스는 안 보임. systemd 자신도 `cgroup.events:populated` 로 판정 | (U1 절삭으로 이번 슬라이스 비범위) 후속 이슈에 이 정정을 이월 |
| **C10** | 중첩 worktree = "bench worktree **안에서** #80 태스크 worktree 동작"(754-755행) · §6 "benchRoot 안 vs 형제 관례"(873행) | 현행 유도식 `join(root,'..')` 때문에 bench 를 root 로 쓰면 태스크 worktree 는 **benchRoot 직하**에 떨어진다 — §6 의 두 선택지는 같은 값으로 수렴하는 비-선택지. bench **안** 배치는 `add -A` gitlink 오염 · `clean -ffd` 파괴로 Fleet 연산과 **비양립**(실측 3건) | `taskWorktreeDir = join(benchRoot, '.fleet-wt-<benchId>', '.fleet-wt-<sanitize(taskId)>')` — bench **밖**, benchRoot **안**, bench별 전용 홈. 접두사 `.fleet-wt-` 유지 근거 = 기존 ignored denylist 정규식 무수정 재사용(`ignored-baseline.ts:30-33`). **이 경로를 만드는 코드는 §W-6 의 `taskWorktreeDir` seam 이다**(C12 와 양립하도록 — 반증 반영) |
| **C11** | §3.2.1-9 "발행 모델 = base 전진은 **비체크아웃 시에만**"(647-649행) | 17R(435-438행)이 자동 전진을 **완전 제거**했다. 647-649 는 16R 시점 문장의 미갱신 잔재 — 살아 있으면 `integration-ready → integrated` 전이 경로가 2개가 되어 상태 기계가 열림 | 647-649 폐기. **base 전진은 어떤 조건에서도 Fleet 이 수행하지 않는다.** §5 완료정의(826-827행)와 정합 |
| **C12** | §3.2 "`git.ts` 에 named-branch worktree **변형 추가**"(373행) | 현행 `addWorktree`/`removeWorktree` 는 **디렉터리 인자가 없다**(내부 유도) → "형제 함수 추가"로 재사용 불가. 경로 유도식이 원리적으로 다름 | 신규 표면 `GitRepo` 추가(§W-6). `Workspace` **인터페이스는 무변경**, 단 **태스크 worktree 경로 유도만 옵셔널 seam 으로 개방**(`createWorkspace(root, git, opts?: {taskWorktreeDir?})` · 미주입 = 현행 바이트 동일 = 무회귀) — C10 이 요구하는 2단 경로를 만드는 코드가 이것뿐이므로 "한 줄도 건드리지 않는다"는 원안은 C10 과 양립 불가였다(반증 반영). `ok()` 는 신규 연산에 **사용 금지**. **`sanitize` 금지 스코프는 bench 디렉터리명(=ULID)에 한정** — 태스크 worktree 의 taskId 는 현행 `sanitize` 유지(#80 무회귀) |

부수 정정(P2, 계약에 반영): §1 표의 `src/server/channels.ts` → **`src/shared/transport/channels.ts`** · §3.5 "리뷰 대기" 배지는 정의 부재 → 폐기 · `publish-pending`(137행)·`checkout-behind`(146행)은 16R/17R 로 전제 소멸 → **상태로 채택하지 않는다**.

---

## 0.2 사용자 결정 (2026-07-23)

| # | 질문 | 결정 | 스펙 영향 |
|---|---|---|---|
| **U1** | 가디언 런처 범위 | **절삭** — 엔진 소유 리스 + 보수 3분류 | win32 Job Object·linux subreaper 는 Node 공개 API 도달 불가(네이티브 필요)이고, 가디언 유무와 무관하게 **변이 적격 판정표는 동일**(양쪽 다 크래시 → fail-closed). ADR-0003 ROI 게이트 적용. §W-16 이 절삭판 계약 |
| **U2** | bench verify 와 node_modules 부재 | **verify 미가용 정직 보고** | `verify.unavailable` 보고 + verify-fix/replan 미진입(#166 정직성 선례 동형). 의존성 준비는 후속 이슈 |
| **U3** | bench 대화 statefulness | **`SendOptions.cwd` 신설** | 편집 모드와 직교한 cwd 필드로 대화 경로 statefulness 보존. API 세션 워크스페이스 도구도 bench 스코프화(§W-11) |
| **U4** | win32 내구성 | **등급 명시 강등 허용** | `DurabilityLevel` 타입 승격 + win32 4번째 복구 분기 + UI/런북 노출. 도그푸드 유지 |

---

## 1. 계약

### W-1. 도메인 · ID · 경로 유도

```ts
// src/shared/types.ts — 렌더러/서버 공유 표면
export type BenchLifecycle = 'open' | 'integrated' | 'archived'

/** 영속되지 않는 런타임 뷰. path 는 항상 유도값. */
export interface Workbench {
  readonly id: string            // ULID ^[0-9A-HJKMNP-TV-Z]{26}$
  readonly title: string
  readonly branch: string        // ^fleet/[a-z0-9][a-z0-9-]{0,40}$
  /** 정준 **로컬 브랜치명**. 문법 계약(반증 반영 — 초안은 주석뿐이라 신뢰 불가 입력에 구멍):
   *  `git check-ref-format --branch` 통과 ∧ `^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$` ∧
   *  선행 `-` 금지(옵션 오인) ∧ `..`·`@{`·`~`·`^`·`:`·`?`·`*`·`[`·제어문자 금지 ∧ `.lock` 종료 금지 ∧
   *  `refs/` 접두 금지(로컬 브랜치만) ∧ 원격 추적명(`origin/…`) 금지. 검증 실패 = 거부(정규화 금지). */
  readonly baseRef: string
  readonly path: string          // benchDir(benchRoot, id) — 유도
  readonly lifecycle: BenchLifecycle
  readonly createdAt: number
  readonly archivedBranch?: 'preserved' | 'deleted'
}
```

- **`id` = 엔진 생성 ULID.** 경로 유도의 유일 가변 성분이며 `sanitize` 없이 그대로 디렉터리명(단사).
  `git.ts:79` 의 비단사 `sanitize` 는 bench 경로에 **사용 금지**(C12).
- **ULID 는 자체 구현**(`src/main/core/workbench/ulid.ts`, ~25행 · Crockford Base32 + 48bit ms + 80bit 랜덤).
  npm `ulid` 도입 대비 이득 없음 — AGENTS.md 「코어는 Node 표준 + 소수 순수 패키지」 정합. 신규 의존성 **0**.
- **`path` 는 영속화하지 않는다**(설계 1R). `benchDir = join(benchRoot, id)`.
- **benchRoot = 부팅 구성·검증되는 엔진 소유 경로**: 데스크톱 기본 `<workspaceRoot>/../.fleet-wb/`,
  서버 = `FLEET_BENCH_ROOT` 명시. 미설정 = **기능 비활성 + warn**, 설정 후 검증 실패 = **throw**
  (`resolveDrainTimeoutMs`(boot.ts:267-277) fail-fast 관용구 승계).
- **킬스위치 명시(신설 · P2 · 판사 2기 공통 지적)**: 위 문면대로면 **데스크톱은 기본값이 있어 배선 착지
  즉시 상시 활성**이 된다("미설정 = 비활성"은 서버 문면일 뿐이다). 별도 opt-in 플래그
  **`FLEET_WORKBENCH=1`**(미설정 = 데스크톱·서버 **양쪽 비활성**)를 신설한다 — 롤백이 코드 revert 가 아니라
  **런타임 스위치 1개**여야 한다.
- **`StoreState` 무변경이 불변식.** bench 권위 상태는 기존 store 에 넣지 않는다(§W-4 근거). `snapshot()`
  키 집합 불변 단언을 계약 테스트로 고정.

**W-1-a. 복원 신원 검증**은 설계 §3.1.1(0~6단계 · lifecycle-인지)을 그대로 계약으로 채택한다. 단
0단계 검증 실패 레코드는 **어떤 git 호출·경로 probe 에도 전달하지 않는다**를 불변식 I-2 로 승격.

### W-2. 코디네이션 영역

```text
<canonical common gitdir>/fleet/            # 0700(posix) · 영역 루트
├── area.json                               # 스키마 버전 · lockBackend · 생성 신원
│   # ⚠ 소켓 디렉터리 없음 — 락 endpoint 는 **커널 네임스페이스**에 있다(§W-3):
│   #   Linux `\0fleet.wb.<digest>.<key>` (abstract) · win32 `\\.\pipe\fleet.wb.<digest>.<key>`
│   #   pathname 이 아니므로 사고성 삭제·경로 예산·회수 프로토콜이 전부 무관하다.
├── active-instance.json                    # 인스턴스 배타(§W-2-b ①) — create-only `wx` 점유 · 마커
│   # ⚠ **`locks/<key>.json`·`owner/<key>.json` 은 두지 않는다**(서버 단일 표면 축소 · §W-3):
│   #   락 소유 권위 레코드의 epoch·state·netNsId 판정은 cross-ns 를 막으려 도입됐는데 cross-ns 가
│   #   §W-2-b 로 소멸했고, 같은 ns 안에서는 커널 배타성이 완전하다. 진단 미러(owner/)도 락마다 디스크
│   #   쓰기를 되살려 L-6 「디스크 I/O 0」·§3-T10 「락 소유 권위 레코드 부재」와 충돌한다.
├── authority/<benchId>.json                # 공유 권위 레코드(revision-CAS)
├── activity/<benchId>.json                 # 활동 신원 · 인스턴스 마커
└── journal/<benchId>/<txnId>.json          # 연산 WAL(tmp 는 같은 디렉터리 — 아래)
```

- **별도 `tmp/` 디렉터리는 두지 않는다**(원안 폐기 · 계획 정정 165ⓑ). 확인-응답 쓰기의 rename 소스는
  **대상과 같은 디렉터리**에 만든다 — 권위 `authority/<benchId>.json.<ownerToken>.tmp`(착지 코드가 이미
  그렇다) · 저널 `journal/<benchId>/<txnId>.json.<ownerToken>.tmp`. 동일 볼륨 보장은 같은 디렉터리라는
  사실에서 더 강하게 따라오고, 원안 문면대로 별도 디렉터리를 뒤지는 수확기(§W-5)는 **영원히 0건**이 된다.

- **위치 확정 근거(실측)**: `gc --prune=now --aggressive`·`repack -ad`·`prune`·`reflog expire`·
  `clean -xffd`·`worktree prune`·`fsck` 전량 통과, `git status --porcelain` 무출력, 0700 보존
  (win git 2.54.0 / linux git 2.39.5). 경쟁 후보 `.git/worktrees/<id>/` 는 **`git worktree prune` 이
  커스텀 파일까지 삭제**함이 실측으로 기각(gc 가 이를 자동 호출).
- **win32 는 `s/` 를 쓰지 않는다** — 락/리스는 named pipe 네임스페이스(`\\.\pipe\fleet.wb.<digest>.<key>`).
  실측: win32 에서 파일시스템 경로 `listen` 은 EACCES(libuv 는 `\\.\pipe\` 만 지원).
- **정준화**: `git rev-parse --path-format=absolute --git-common-dir`(git ≥2.31) — **옵션 없으면 메인
  worktree 가 상대 `.git` 을 반환해 정상 상태를 broken 오판**한다. 이후 `realpathSync.native` →
  `isLinkSync==='dir'` → (posix) `statSync().uid === getuid()`.
- **경로 예산 preflight(posix)**: 최장 소켓 경로가 **108바이트 초과면 throw**(실측: 108 OK / 109 EINVAL) →
  기능 비활성 + 안내(조용한 폴백 금지).
- 링크 검사 대상 한정: 디렉터리 = `isLinkSync==='dir'`, JSON = `'regular'|'missing'`,
  **소켓 경로에는 `isLinkSync` 를 적용하지 않는다**(라이브 소켓이 `'suspicious'` 로 분류돼 자기 락을 거부 —
  실측). 소켓은 `lstatSync().isSocket()` 전용 분류기.

> ⚠ **[ADR-0013 으로 정정됨 · #251 PR1c]** 아래 절의 프리미티브·논증 일부는 착지 구현과 다르다 — `docs/adr/0013-인스턴스-배타-커널-endpoint-우선-container_name-배포집행.md` 와 계획 정정표 ㊲~㊿ 가 우선한다.
> 요지: ①획득 순서 = **커널 endpoint bind 먼저 → 성공 시에만 파일 점유** ②파일 프리미티브 = `wx` 가
> 아니라 **tmp + `link`(create-only)** — 발행·회수 양쪽 ③마커 = **3성분**(`bootId:pid1StartTicks:pidNsIno`)
> — 2성분은 동시 기동 컨테이너에서 충돌한다(실측) ④마커 불일치 회수의 증거 등급은 커널 강제가 아니라
> **배포 전제 의존**이며, 그 구간을 런타임이 차단하지는 않는다.

**W-2-b. 인스턴스 배타 — 단일 활성 인스턴스 (사용자 결정 2026-07-23 · 서버 단일 표면 축소)**

> **범위 축소(사용자 결정)**: Workbench 는 **서버(컨테이너) 표면 전용**이다. 데스크톱 Electron 의
> Workbench 는 **후속 이슈**로 분리한다. 이 결정으로 **cross-namespace 조정 문제가 원천 소멸**하고,
> 토폴로지 게이트(`workbenchOwner`·`ownershipGeneration`)·handoff 상태 기계·`netNsId` 판정·
> §W-16 ②의 cross-ns 부분·§3-T9b·T9c·T9d·T9f·T10c·T10e·T10g·선행 실측 M1 이 **전부 계약에서 사라진다**.
> 배경: 이 층은 Codex 6라운드 + 로컬 적대 검증 P1 12건 동안 **패치가 수렴하지 않았고**, 실패는 전부
> "레포 권위 범위는 파일시스템으로 공유되는데 endpoint 배타 범위는 net namespace 로 분할된다"는
> 하나의 불일치에서 나왔다. 표면을 하나로 좁히면 그 불일치 자체가 없어진다.

**남는 프리미티브는 4개뿐이다**(로컬 단순화 렌즈: "환원 불가한 것은 4개인데 8개를 얹고 있었다"):

| # | 프리미티브 | 담당 | 왜 환원 불가한가 |
|---|---|---|---|
| ① | `open(<area>/active-instance.json, 'wx')` | **인스턴스 배타**(동시 기동 차단) | create-only 는 **공유 파일시스템 위에서 net ns 와 무관하게 정확히 한 프로세스만 성공**하고 liveness 판단을 요구하지 않는다(실측: 별개 ns 두 컨테이너의 400개 동시 경쟁 생성 → double-create 0건) |
| ② | 커널 endpoint(Linux 추상 소켓 `\0fleet.wb.<digest>.<key>`) | **락 배타 + liveness** | pathname 이 없어 삭제 불가 · 프로세스 사망 시 커널 자동 회수. Node 에 `flock` 이 없다는 실측(C2)이 대안을 배제한다 |
| ③ | WAL + revision-CAS(§W-4·W-7) | **크래시 복구(시간 축)** | 동시성이 아니라 시간 축 문제 — 프로세스를 1개로 줄여도 사라지지 않는다 |
| ④ | in-process 뮤텍스(`withAuthority`) | 같은 heap 직렬화 | ②는 프로세스 간만 막는다 |

**①의 계약 — `active-instance.json`**

```ts
readonly activeInstance: {
  readonly engineInstanceId: string      // ULID · 진단
  readonly instanceMarker: string        // sha256(hostBootId + ':' + pid1StartTicks) — 실측 확인(§0.1 C8)
  readonly acquiredAt: number            // 진단
}
```
- 부팅 시 `open('wx')` 로 점유한다. **EEXIST = 이미 다른 인스턴스가 있음** → 파일을 읽어 판정:
  - **`instanceMarker` 일치** = 같은 컨테이너 인스턴스의 잔재(같은 PID ns) → 커널 endpoint probe 로
    생존 확인(EADDRINUSE = 생존 → `AreaOpenResult{disabled,'instance-active'}` / listen 성공 = 사망 → 회수)
  - **`instanceMarker` 불일치** = **이전 PID 네임스페이스 소멸 확정** → 회수 적격.
    ⚠ 이 판정이 안전한 이유는 **①이 동시 기동을 이미 배제했기 때문**이다 — 두 인스턴스가 동시에 살아
    있으면 `wx` 가 한쪽을 막으므로, "마커가 다른데 둘 다 살아있다"가 성립하지 않는다. (초안이 이 판정을
    fail-open 으로 만들었던 이유는 동시 기동을 아무것도 막지 않은 채 마커만 봤기 때문이다.)
  - 회수 = 파일을 자기 신원으로 교체(확인-응답 쓰기). **연령·pid·사용자 승인은 근거로 쓰지 않는다.**
- **정상 종료 시 제거**한다(§C3 drain 의 `shutdown()` 자원 정리에 포함). 잔재는 위 판정으로 회수된다 —
  **`held` 잔존이 영구 고착을 만들던 경로가 구조적으로 소멸**한다(로컬 검증 렌즈 2 P1).
- **마커 손상·판정 불가 = 자동 삭제 금지 → `reconciliation-required`**(Codex 체크포인트 3 승인 조건 ③).
  회수의 근거는 **단일-컨테이너 배포 전제 + 마커 판정**뿐이며 **사용자 승인·pid 숫자는 근거가 아니다**(조건 ②).
- **정상 종료에서 마커 제거가 실패하면 성공 종료로 위장하지 않는다**(조건 ⑤) — 실패를 종료 경로에서
  기록하고, 다음 부팅이 **명확히 회수 또는 `reconciliation-required` 경로로** 진입해야 한다.
- **획득 실패자는 `listen()` 을 포함해 Workbench 초기화의 어떤 부수효과도 수행하지 않는다**(조건 ①).
- **배포 계약을 실제 파일로 집행한다**(스펙 문면만으로는 집행이 아니다 — 실측상 `--scale fleet=3` 이
  경고 없이 성공했고 `container_name` 은 레포 어디에도 없었다):
  `deploy/docker-compose.yml` 의 `fleet` 서비스에 **`container_name` 고정**(compose 는 `container_name`
  설정 시 `scale>1` 을 거부한다) + `deploy/smoke.sh` 에 **그 키 존재 단언**(PR#227 의 compose 라벨 필터 +
  정확 1개 가드 선례 재사용). 이 두 변경은 **#254 가 아니라 #251 범위**다 — ①의 안전 논증이 여기 의존한다.

**W-2-a. 위협 모델 (명시 선언 · 반증 반영)**

프로덕션에서 이 영역은 `/workspace/.git/fleet/` 이고 `/workspace` 는 **fleet 컨테이너와 ttyd 컨테이너에
동시 bind 마운트**되며 양쪽 다 uid 1000 이다(`docker-compose.yml:36-37,109-110`). 따라서 **0700 +
`statSync().uid === getuid()` 는 ttyd 셸 사용자와 Fleet 이 spawn 하는 CLI 에이전트에 대해 격리를 제공하지
않는다.** 이를 비목표로 **명시 선언**한다 — 은폐하지 않는다.

- 이는 설계 §3.2.1-9 가 이미 수용한 신뢰 모델의 연장이다: "ttyd = 같은 신뢰 도메인의 두 번째 문 …
  목표는 적대 셸의 절대 배제(불가능)가 아니라 **선의의 동시 사용에서 무손상**"(설계 636-640행).
- 따라서 코디네이션 영역의 무결성 보장 범위 = **사고·경합**이지 **악의적 변조**가 아니다.
  HMAC 무결성 태깅·별도 볼륨 격리는 이 슬라이스의 비목표(§4).
- 대안 검토(기각): 영역을 `FLEET_DATA_DIR/coord/<repoDigest>/`(ttyd 미마운트)로 옮기면 격리는 얻는다.
  ⚠ **원래 적었던 기각 근거(「`tmp/`→`authority/` rename 의 동일 볼륨 요건이 깨진다」)는 정정 165ⓑ 로
  소멸했다** — tmp 는 대상과 **같은 디렉터리**에 만들므로 영역을 어디에 두든 rename 은 볼륨을 넘지 않는다.
  남는 기각 근거는 위 「위치 확정 근거(실측)」뿐이다(영역이 레포와 함께 이동·정리되어야 하고 gc·prune·
  clean 전량을 통과함이 실측됐다). 볼륨 논거를 인용하지 않는다.

### W-3. 자문 락 (서버 단일 표면 · 커널 endpoint)

`LockBackend = 'uds-abstract'`. **파일시스템 pathname 소켓은 폐기한다.**

3라운드에 걸쳐 같은 층에서 P1 이 반복된 궤적 — ①이중 소유 허용 ②그걸 막다 **영구 고착** ③전수 probe 의
**부정 판정 fail-open**(`ENOENT` 는 사망 증거가 아니다) — 은 전부 뿌리가 하나였다: **삭제 가능한 pathname 을
소유권 증거로 삼음.** 커널 네임스페이스 endpoint 는 그 뿌리를 제거한다.

```text
listen() 성공   = 소유자 부재 증명 → 획득
EADDRINUSE      = 소유자 생존      → held(정상 대기)
그 외 오류       = unavailable(fail-closed)
```

- **키**: `'r'`(레포 변이 락) · `<benchId>`(bench 활동 리스) · `slot-<i>`(상한).
- **소켓 파일·경로 예산·회수 프로토콜·`connect` 프로브·ino 재검증·L-7 이 전부 불요**하다
  (추상 소켓은 pathname 이 없다). 영역 디렉터리에 소켓 파일은 **0개**다.
- **락 소유 권위 레코드(`locks/<key>.json`)를 두지 않는다**(로컬 단순화 렌즈 확정). 그 레코드의 `epoch`·
  `state`·`netNsId` 판정은 cross-ns 를 막으려 도입됐는데 **cross-ns 는 §W-2-b 축소로 소멸**했고, 같은 ns
  안에서는 커널 배타성이 완전하다. 남아 있던 유일한 효용(in-process 해제 후 오사용)은 L-6 이 디스크 I/O
  0 으로 잡는다.

**불변식**
- **L-1** 어떤 경로에서도 **연령·mtime·pid 생존**으로 소유를 판정하지 않는다. 소유 판정의 유일 근거 =
  **커널의 bind 배타성**(`listen` 성공 / EADDRINUSE).
- **L-2** `tryAcquire` 는 절대 블로킹하지 않으며 모호(`unavailable`)는 항상 fail-closed.
- **L-3** 락 서열 = ①`r` → ②`<benchId>` → ③슬롯(**비대기 try-acquire 전용** — 대기 간선을 추가하지
  않으므로 사이클 불가). 역순 금지.
- **L-5 (스코프 한정 · 판사 2기 교차 확정)** **승인 대기 중에는 자기 스코프 밖의 진행을 차단하는 락을
  보유하지 않는다** — 레포 변이 락(`r`) 및 통합/보관 트랜잭션 구간 보유 중 `gate.request` 금지.
  **bench 활동 리스는 명시 예외**(그 리스는 해당 bench 만 차단하며 그게 의도된 의미론이다).
  근거: 실측상 오케 런 중 `gate.request` 호출부가 4곳(`orchestrator.ts:353`·`:928`·`tools/loop.ts:180`·
  `mcp/host.ts:245`)이고, 특히 `mcp/host.ts:245` 는 bench 무관 전역 `setServers` 라 무스코프 금지는
  **어느 bench 하나만 살아 있어도 MCP 서버 등록을 불가능**하게 만든다.
- **L-5a** **`r` 보유 중 bench 리스 대기 금지** — `held` 면 `r` 을 즉시 해제하고 백오프 재시도.
- **L-6 (보유자 재검증 · 축소판)** 리스 보유자는 락이 인가하는 **모든 변이 직전**에 자기 서버가 여전히
  `listening` 인지 확인한다(**로컬 불리언 · 디스크 I/O 0**). 불일치 = `lease-lost` → 변이 중단(fail-closed).
  ※ 추상 소켓에서는 소유자가 살아있는 한 endpoint 를 외부가 없앨 수 없으므로 이는 **in-process 오사용
  (해제 후 계속 변이) 방어**이며, cross-process 방어는 커널이 담당한다.

### W-4. 공유 권위 레코드 · revision-CAS  ← **Codex 지정 계약 1·2·3·4항**

> ⚠ **[#251 PR2a 착지 시 정정 — 계획 정정 53·55·57·58이 우선]**
> ⓐ **`DurableWriteStep` 을 rename 경계로 쪼갠다** — `PreCommitStep`(mkdir…rename) / `PostCommitStep`
> (open-dir·fsync-dir·close-dir). 하나로 두면 `io-failure{step:'fsync-dir'}` 가 **타입상 합법**이 되어
> §3-T16 과 §3-T17e 가 같은 주입에 상반된 반환을 요구하고, Codex 체크포인트 2 P1-5 가 닫은 구분이
> 되돌아온다. `io-failure.step: PreCommitStep` · `commit-uncertain.step: PostCommitStep`.
> ⓑ **`BENCH_LEASE`·`LeaseCheck`·`BenchLeaseToken` 소유는 `locks.ts`**(PR1b 랜딩)다 — 아래 코드블록이
> 이들을 다시 싣고 있으나 `unique symbol` 은 선언마다 별개 타입이라 재선언하면 라이브 핸들이 민팅한
> 토큰이 대입되지 않는다. `authority.ts` 는 `import type` 단방향 소비.
> ⓒ **`SpawnOpts` 는 레포에 없는 이름**이다(실제는 `RunOpts` 이고 그것은 spawn 인자가 아니다) — 런처
> 옵션은 **신규 정의**이며 `createCommandRunner` 4-arg 합성은 불가하므로 브랜드 강제를 **팩토리 인자**
> (`createBenchLauncher(commit)`)로 옮긴다. 실 배선(`detect.ts`·`mcp/stdio.ts`)은 **PR7 이월**(폐포 핀 보존).

> ⚠ **[#251 PR2c 착수 시 정정 — 계획 정정 100~110 이 우선 · 6렌즈 감사 P1 14건의 재판정 결과]**
> ⓓ **런처 반환은 판별 유니온이다.** 아래 계약 4항 코드펜스의 `=> ChildProcess` 와 그 뒤 산문의
> 「불일치는 throw 가 아니라 판별 유니온 반환」이 **같은 함수에 상반된 반환을 요구**했다(4렌즈 독립 수렴).
> 확정형 = `BenchSpawnResult = {kind:'spawned'; child} | {kind:'refused'; reason}` 이고 `reason` 은
> `commit-not-minted | commit-spent | gate-not-released | identity-mismatch | activity-mismatch |
> generation-mismatch`. `opts` 타입은 **workbench 자체 정의**(`BenchSpawnOptions`) — ⓒ 가 이미 `SpawnOpts`
> 부재를 정정했으나 코드펜스 본문은 그대로였다. **workbench 는 `core/cli`·`core/mcp` 를 import 하지
> 않는다**(폐포 핀은 방향성이라 이 역전을 못 잡는다 → 구조 핀으로 별도 고정).
> ⓔ **3필드 대조의 상대는 팩토리 인자다.** `mintCommit` 이 identity·sourceGeneration·activityId 를
> **커밋 자신에 싣기 때문에** 팩토리가 commit 만 받으면 대조는 **항상 참인 vacuous 검사**가 된다 →
> `createBenchLauncher({ spawn, commit, expected })`. `spawn` 도 **주입**이라 팩토리는 실 spawn 을
> 호출하지 않는다(실 배선은 PR7). **소비 시점 = launcher 호출**(팩토리는 확인만) — 팩토리에서 소비하면
> 만들어진 launcher 를 반복 호출해 **한 커밋에 자식 N개**가 되고 §W-16 의 1:1 가정이 무너진다.
> ⓕ **`AuthorityCommit` 에 민팅 원장과 `execGate` 증거를 싣는다.** 형제 크레덴셜 2종(`MINTED_READS`·
> `MINTED_LEASES`)은 Codex P1 으로 원장을 강제당했는데 커밋만 비대칭이라 `{...commit}` 복제가
> **캐스트 0개로** 단일 사용 WeakSet 을 우회한다. 그리고 commit1(gated)·commit2(running)이 `revision`
> 말고는 구별되지 않아 「launcher 에 넘기는 것은 commit2」가 **관례로만** 존재했다 → `execGate` 를 커밋에
> 싣고 런처가 `!== 'running'` 을 `refused{gate-not-released}` 로 거부한다(관례 → 계약 승격).
> ⓖ **gated-orphan 회수의 PR2c 산출물은 순수 함수 2개뿐이다** — `classifyStaleActivity(record)` 와
> `reclaimDraft(record)`. 아래 「`commit-uncertain` 복구」 문단은 **능력 서술**이라 오늘 이미 참이고
> (`activeActivity` 를 뺀 draft 의 CAS 는 PR2b 상태에서 추가 코드 0으로 성공한다), 반대로 「`running`
> 비대상」을 CAS 층 불변식으로 넣으면 **정상 활동 종료**(아래 「spawn 실패 시 활동 종결 CAS 필수」)까지
> 봉쇄된다. **회수 CAS 호출부는 PR7**(T30b). **회수 draft 보존 계약**(지금까지 어느 문서에도 없었다):
> `activeActivity` **만** 소멸 · `sourceGeneration` 무변(되돌리지 않는다 — §W-8 세대 귀속 보존) ·
> `lifecycle`·`schemaVersion`·`identity`·통합 4필드 **바이트 동일 보존** · 구현 규범은 **rest 구조분해**.
> ⓗ **재시도 = 초기 1회 + 재시도 4회(rename 총 5회 시도) · 대기 [10,20,40,80] · 총 150ms.** 문면의
> 「4회」가 총 시도인지 재시도인지 미정이었다 — 백오프 원소 4개를 전부 소비하는 해석으로 확정한다.
> 대기는 **주입 `sleep` seam**(`BenchAuthorityStoreOptions` 필수 필드)으로 수행한다. seam 이 없으면
> 백오프 0ms·순서 역전 구현이 T17·T17b·T17c 를 전부 GREEN 으로 통과한다 → **§3-T17g 신설**.
> **재시도 대상이 아닌 코드(ENOENT·EISDIR·`code` 부재 등)는 즉시 실패**하고, 재시도는 **rename 단계에만**
> 적용된다(둘 다 `countOf` exact 단언으로 고정 — 없으면 「쓰기 전체를 감싸 재시도」 구현이 통과한다).
> 3면 실측: 재시도 대상 3코드 중 **일시성이 확인된 것은 win32 EPERM(열린 핸들) 하나**이고 같은 EPERM 이
> 대상=디렉터리·읽기전용에서도 나오며 그 둘은 **영구 실패**다(errno 로 구분 불가 · 150ms 소모 후
> `io-failure`). EBUSY 는 3면 어디서도 재현되지 않았다 — 집합은 방어적으로 유지하되 근거 없음을 명기한다.

**레이아웃 = bench 당 파일 1개** `<area>/authority/<benchId>.json`.
단일 파일 기각 근거: (a) 무관 bench 간 revision 충돌로 fail-closed 폭증 (b) 활동 경로가 레포-전역
직렬화를 획득하게 되어 **락 서열(L-3) 위반** (c) N bench 마다 O(N) 전량 재직렬화.
**현행 `createJsonFileStore` 를 쓰지 않는다** — 전체 스냅숏 tmp→rename 덮어쓰기라 두 프로세스가 붙으면
**last-writer-wins 전체 클로버**로 상대 세대 기록이 조용히 소멸한다(`json-file.ts:32-45,50-57`).

```ts
// src/main/core/workbench/authority.ts
export interface BenchAuthorityIdentity {
  readonly commonGitDir: string   // 정준화 — 대조 전용
  readonly benchRoot: string      // 정준화 — 대조 전용(12R 크로스 표면 신원 쌍)
  readonly benchId: string        // ULID
}

export type DurabilityLevel = 'file+dir' | 'file-only'   // U4 · C3

export interface BenchAuthorityRecord {
  readonly schemaVersion: 1        // 지원 범위 초과 = 'incompatible-version'(≠ invalid — 아래 I12)
  readonly identity: BenchAuthorityIdentity
  /** 단조. 최초 1. CAS 성공마다 정확히 +1.
   *  ⚠ 단 `durability==='file-only'` 표면에서는 머신 크래시 시 디렉터리 엔트리 유실로 단조성이
   *  보장되지 않는다(C3 · **win32 전용이 아니다** — dirfd fsync 불가 마운트 위의 POSIX 도 같은 등급).
   *  그 표면의 **보조** 탐지가 §W-7 **ref-앵커**이며, 「git ref 는 독립 매체라 동시 롤백이 불가하다」는
   *  **거짓**이다(git 소스 대조 · 계획 정정 133·152·156) — 앵커는 권위 쪽 단독 롤백만 탐지하고
   *  ref 쪽 롤백·동시 롤백에는 **fail-open** 이다. */
  readonly revision: number
  readonly lifecycle: BenchLifecycle
  readonly archivedBranch?: 'preserved' | 'deleted'
  readonly sourceGeneration: number            // 활동 시작마다 +1
  readonly currentIntegrationTxnId?: string
  /** ⚠ 상태 어휘는 **한 벌**이다 — `IntegrationStage`(§W-7 WAL 단계)와 별개 유니온을 만들지 않는다.
   *  파생 표시 상태(`integration-ready`·`stale-attempt`·`partially-integrated`)는 §W-18
   *  `IntegrationDerived` 가 소유하며 **영속하지 않는다**. 여기 저장되는 것은 WAL 단계뿐이다. */
  readonly currentIntegrationStage?: IntegrationStage
  readonly currentIntegrationTxnGeneration?: number
  readonly currentIntegrationResultOid?: string
  readonly completedIntegrationTxnId?: string  // lifecycle==='integrated' 일 때만
  readonly activeActivity?: BenchActivityRecord
  readonly writtenBy: { ownerToken: string; at: number; durability: DurabilityLevel }
}
```

> **미정의 참조 타입 확정(반증 반영)**: `BenchActivityRecord`(activityId·kind·generation·ownerToken·
> **`execGate: 'gated' | 'running'`**·startedAt) · `AuthorityTx`(임계 구역 안에서만 `readFresh`/
> `compareAndSwap` 을 노출하는 핸들) · `BenchAuthorityDraft = Omit<BenchAuthorityRecord,'revision'|'writtenBy'>` ·
> `DurableWriteStep`(§W-5) · `IntegrationStage`(§W-7) · `SpawnOpts`(현행 `detect.ts` 타입 재사용) ·
> `WorktreeEntry`·`RefCasResult`·`MergeTreeResult`(§W-6) · `AuthzResult`(§W-18) — 전부 계획 단계에서
> 파일 배치까지 확정한다. 스펙 본문에 정의가 없는 타입을 구현이 임의 창작하지 않는다.

**조건부 스키마 불변식(0단계 검증)**
1. `archivedBranch` 존재 ⟺ `lifecycle==='archived'`
2. `completedIntegrationTxnId` 존재 ⟺ `lifecycle==='integrated'`
3. `currentIntegrationStage`/`…Generation` 존재 ⟺ `currentIntegrationTxnId` 존재
4. `currentIntegrationTxnGeneration <= sourceGeneration`
5. `activeActivity.generation === sourceGeneration`
6. `lifecycle==='integrated' ∧ activeActivity` **금지**(설계 527행 `integrated ∧ busy` 도달 불가)
7. `lifecycle==='archived' ∧ activeActivity` 금지
8. `revision >= 1` ∧ 정수 · 9. `identity` 3필드 전부 엔진 유도값과 정확 일치(불일치 = `identity-mismatch`)

**CAS API — 계약 1·2항**

```ts
/** 브랜드 심볼 **미export** · 민팅은 `locks.ts` 의 **라이브 핸들에서만**(위조 불가). */
declare const BENCH_LEASE: unique symbol
export type LeaseCheck = { kind: 'owned' } | { kind: 'lost'; reason: 'released' | 'stolen' }
export interface BenchLeaseToken {
  readonly [BENCH_LEASE]: true
  readonly identity: BenchAuthorityIdentity
  readonly ownerToken: string
  /** L-6 per-retry 재검증 수단(계획 체크포인트 확정). 이게 없으면 `authority.ts → locks.ts`
   *  **의존 역전**이 강제된다. 클로저는 호출자가 아니라 **락 모듈이 소유**한다.
   *  기각한 대안: `createBenchAuthorityStore(fs, {leaseChecker})` 주입 — 의존 역전은 없으나
   *  per-lease 정밀도가 떨어져(store 단위 checker) 리스별 탈취 판정이 흐려진다. */
  revalidate(): LeaseCheck
}

declare const FRESH_READ: unique symbol
export interface FreshReadToken { readonly [FRESH_READ]: true; readonly identity: BenchAuthorityIdentity
  readonly observedRevision: number      // 부재 레코드 = 0
  readonly leaseOwnerToken: string
  readonly readSeq: number }             // 모듈 내부 단조 — 단일 사용 강제

export type AuthorityReadResult =
  | { kind: 'found';  record: BenchAuthorityRecord; read: FreshReadToken }
  | { kind: 'absent'; read: FreshReadToken }
  | { kind: 'invalid'; path: string; violations: readonly string[] }
  /** 문법 위반과 버전 스큐는 다른 사실이다 — 섞으면 구 버전이 신 버전 권위를 삭제한다(I12). */
  | { kind: 'incompatible-version'; path: string; found: number; supported: number }
  | { kind: 'identity-mismatch'; expected: BenchAuthorityIdentity; found: BenchAuthorityIdentity }
  /** 임계 구역 진입 시점에 리스가 이미 유실된 경우 — `withAuthority<T>` 는 `T` 를 반환해야 하므로
   *  값으로 보고할 자리가 필요하다(throw 는 "판별 유니온 반환" 원칙과 충돌). */
  | { kind: 'lease-invalid'; reason: 'released' | 'stolen' }
  | { kind: 'io-failure'; step: 'read'; path: string; cause: unknown }

declare const AUTHORITY_COMMIT: unique symbol
export interface AuthorityCommit { readonly [AUTHORITY_COMMIT]: true
  readonly identity: BenchAuthorityIdentity; readonly revision: number
  readonly sourceGeneration: number; readonly activityId?: string
  readonly durability: DurabilityLevel }

export type CasResult =
  | { kind: 'committed'; record: BenchAuthorityRecord; commit: AuthorityCommit }
  | { kind: 'revision-mismatch'; expected: number; observed: BenchAuthorityRecord }
  | { kind: 'lease-invalid'; reason: 'released' | 'foreign-owner' | 'identity-mismatch' | 'stolen' }
  | { kind: 'read-token-spent'; readSeq: number }
  | { kind: 'invariant-violation'; violations: readonly string[] }
  /** rename **성공 전** 실패(재시도 소진 포함) = 디스크 무변이. */
  | { kind: 'io-failure'; step: DurableWriteStep; path: string; cause: unknown }
  /** rename **성공 후** 후속 내구 단계(POSIX dir fsync) 실패 = **디스크 revision 은 이미 전진**했는데
   *  커밋 토큰은 발급하지 않는다. "쓰기 실패·상태 무변"과 반드시 구분한다(Codex 체크포인트 2 P1-5). */
  | { kind: 'commit-uncertain'; step: 'fsync-dir'; advancedRevision: number; cause: unknown }

/** 임계 구역 안에서만 존재하는 핸들. lease 는 클로저 캡처 — 인자로 다시 받지 않는다. */
export interface AuthorityTx {
  /** **항상 디스크에서 읽는다.** 반증 수단 = 주입 `DurableFs.readFileUtf8` 호출 카운트(1회당 정확히 1회).
   *  ("캐시 필드 부재"는 관찰 불가능한 서술이므로 계약 문면에서 제외.) */
  readFresh(): AuthorityReadResult
  /** `read` 는 **같은 임계 구역**에서 발급된 미사용 토큰. 성공 시에만 AuthorityCommit 발급. */
  compareAndSwap(read: FreshReadToken, next: BenchAuthorityDraft): Promise<CasResult>
}

export interface BenchAuthorityStore {
  /** **유일한 public 진입점.** bench identity 별 in-process 뮤텍스를 보유한 채
   *  `readFresh → 불변식 검사 → compareAndSwap 완료(내구 확정)` 전체를 하나의 임계 구역으로 실행한다. */
  withAuthority<T>(lease: BenchLeaseToken, fn: (tx: AuthorityTx) => Promise<T>): Promise<T>
}
```

> **인터페이스 정정(계획 체크포인트 · 판사 2기 교차 확정)**: 초안은 `readFresh`·`compareAndSwap`·
> `withAuthority` 셋을 모두 store public 으로 두면서 `withAuthority` 를 "유일한 진입점"이라 규정한
> **문면 내부 모순**이었다. 셋이 다 public 이면 **뮤텍스 밖에서 `store.readFresh(lease)` 를 호출하는 코드가
> 정상 컴파일**되어 직렬화 경계가 **타입이 아니라 규약으로 강등**된다. 두 메서드를 `AuthorityTx` 로 옮긴다 —
> **이름·시그니처·시맨틱은 전부 보존**되므로 §5 가 금지한 폐기 이름(`*Sync`) 재유입이 아니다.

**동기/비동기 모델 확정 — 비동기 CAS + 명시 in-process 뮤텍스 (Codex 체크포인트 2 P1 반영)**

초안은 `compareAndSwapSync`(동기)로 in-process 인터리브를 막으면서 동시에 C4 의 rename 재시도를
"재시도 층만 async"로 규정해 **두 계약이 양립 불가**였다. 지적된 다섯 실패 모드가 전부 성립한다 —
첫 실패 즉시 반환 = 필수 재시도 미수행 / 내부 async 후 즉시 반환 = acknowledged 아님 / `Promise` 화 =
인터리브 창 재개방 / 동기 sleep·`Atomics.wait` = 스펙이 명시 기각한 이벤트루프 차단 / 재시도 중 리스·토큰·
경쟁자 처리 미정의. **비동기 모델로 확정**한다 — "그 사이에 `await` 가 없어야 한다"는 규약은 미래 편집이
`await` 한 줄만 넣어도 조용히 깨지므로 애초에 구조적 보장이 아니었다.

- **직렬화 경계 이원화**: 동일 bench identity 의 `fresh read → 불변식 검사 → 내구 쓰기 완료` 전체를 하나의
  **in-process 임계 구역**(`withAuthority`)으로 묶는다. 이 뮤텍스는 **OS-가시 리스와 별개**이며 같은
  JavaScript heap 의 복수 호출을 직렬화한다. **리스 = 프로세스 간, 뮤텍스 = 프로세스 안.**
- **재시도 중 보유**: rename 재시도가 진행되는 동안 **OS 리스와 in-process 뮤텍스를 모두 계속 보유**한다.
- **재시도마다 리스 재검증(L-6)**: 각 rename 시도 **직전에** 정준 소켓/파이프 소유를 재확인하고, 유실 시
  **이후 재시도와 rename 을 중단**하고 `lease-invalid{reason:'stolen'}` 을 반환한다.
- **`FreshReadToken` 소비 시점 = 첫 CAS 시도 진입**. 내부 재시도는 **동일 CAS 시도의 연속**이며 호출자
  수준의 토큰 재제출로 보이지 않는다. 실패 후 재시도는 **반드시 새 `readFresh`** 를 거친다(같은 토큰 재제출 =
  `read-token-spent`).
- **`commit-uncertain` 복구**: 커밋 토큰을 발급하지 않으므로 **CLI 는 실행되지 않는다.** 그러나 디스크에는
  새 revision(및 `activeActivity{execGate:'gated'}`)이 남을 수 있다. 다음 `readFresh` 가
  **`execGate:'gated'` 인 `activeActivity`** 를 발견하면 그것이 곧 **"게이트가 해제된 적 없음 = 사용자 코드
  0줄 실행"의 증거**이므로, 리스를 보유한 소유자가 CAS 로 그 항목을 **정리(gated-orphan 회수)** 할 수 있다.
  `execGate:'running'` 항목에는 이 회수를 적용하지 않는다(§W-16 해제 판정 대상).

**`execGate` 전이 시점 = 활동 시작 순서 고정 (계획 체크포인트 P1 · 판사 2기 교차 확정)**

초안은 `gated`/`running` 판정만 규정하고 **전이 시점을 정하지 않았다.** 전이를 spawn **뒤**에 두면
「commit → spawn → 크래시」 창이 **살아있는 자식 + 디스크 `gated`** 를 만들고, 위 gated-orphan 회수가
**살아있는 자식을 "0줄 실행"으로 오분류해 변이**한다(리스는 원 소유자 사망으로 이미 획득 가능) = **fail-open**.

```text
CAS1(activeActivity{execGate:'gated'})  →  [commit1]
  → CAS2(execGate:'running')            →  commit2   ← launcher 에 넘기는 것은 **commit2**
    → BenchLauncher(cmd, args, opts, commit2)  ← spawn 은 최종 acknowledged durability 이후
```
- **launcher 에 전달하는 commit 은 CAS2 의 것**이다(§3-T17f "최종 acknowledged durability 보다 먼저 발생하지
  않음"을 만족하려면 CAS2 여야 한다).
- 새로 열리는 창 [CAS2 커밋 … spawn]은 **"디스크 `running` + 자식 부재"** 이며 §W-16 판정이 ③
  reconciliation(데스크톱) 또는 ②(컨테이너 ns 소멸 = 트리 사망 확정 — 실제로 자식이 없었으므로 정답)로
  사상된다 — **양쪽 다 안전 방향**.
- **CAS1 을 생략하고 단일 CAS(`running`)로 줄이지 않는다** — `commit-uncertain` 회수가 위 저비용 경로를 잃는다.
- **spawn 실패(ENOENT/EACCES 등) 시 활동 종결 CAS 가 필수**다. 없으면 `activeActivity{running}` 이 프로세스
  종료까지 남아 다음 부팅이 ③ reconciliation 으로 사상된다(fail-closed 이나 사용자 고착).
- **`revision` 은 저장소만 배정**한다(`BenchAuthorityDraft = Omit<…,'revision'|'writtenBy'>`) — 호출자 조작 불가.
- **자동 병합·last-writer-wins 금지**: `revision-mismatch` 는 재조회 후 fail-closed. 병합 코드가 존재하지 않음이 계약(계약 6항).

**내구 쓰기 순서 — 계약 3항** (각 단계 실패 = 즉시 `io-failure` 반환, 다음 단계 진행 금지)

```text
mkdir(dir) → openExclusive(tmp) → writeAll → fsync(tmpFd) → close(tmpFd)
  → rename(tmp, target)                                  ← 여기까지 성공해야 "커밋"
  → [POSIX] openDir → fsync(dirFd) → close   ⇒ durability:'file+dir'
  → [win32] 생략(EPERM 실측)                  ⇒ durability:'file-only'   ← 조용한 스킵 아님, 레코드에 기록
```
- tmp 이름은 **ownerToken 포함 고유**(`<benchId>.json.<ownerToken>.tmp`) — 현행 고정 `.tmp`(json-file.ts:29)는
  다중 프로세스에 안전하지 않다.
- `rename` **성공 전** 실패 = 디스크 무변이(tmp 만 잔존, 다음 CAS 가 회수) → `io-failure`.
  **성공 후** dir fsync 실패 → **`commit-uncertain`**(디스크 revision 은 전진·커밋 토큰 미발급 — 두 경우를
  같은 종별로 뭉개지 않는다).
- **rename 재시도 계약(C4)**: `{EPERM,EBUSY,EACCES}` 4회·백오프 `[10,20,40,80]ms`, 소진 시 `io-failure`.
  재시도는 **`compareAndSwap`(async) 내부**에서 수행하며, 리스·뮤텍스를 계속 보유하고 매 시도 전에
  L-6 소유 재검증을 한다. **재시도가 CAS 결과 밖으로 새지 않는다** — 최종 rename 성공/실패와 내구 확정이
  전부 반환값에 실린다(acknowledged).
- **리더 규율(불변식 D-9)**: 권위·저널 파일은 `readFileSync` 즉시-close 만. 장기 핸들·`createReadStream`·
  watch 금지 — 그 자체가 타 표면의 쓰기를 EPERM 으로 무한 차단하는 DoS 표면이다.

**exec 게이트 미해제의 타입 강제 — 계약 4항 (반증 반영: 게이트를 spawn 인자에 둔다)**

원안은 `releaseExecGate(child, commit)` 이었으나 **브랜드 토큰이 강제하는 것은 게이트 해제 호출뿐이고
spawn 자체가 아니었다** — 실측상 spawn 지점 2개(`detect.ts:120`·`mcp/stdio.ts:17`)는 호출 즉시 자식이
실행을 시작하며, U1(가디언 절삭)으로 `CREATE_SUSPENDED` 도 없으므로 "정지 상태로 존재하는 `GatedChild`"
는 정의 불가다. CAS 를 아예 호출하지 않고 `defaultRunner` 를 직접 부르는 코드가 정상 컴파일된다.

```ts
/** bench 스코프 실행의 유일한 진입점. AuthorityCommit 없이는 **인자 부족으로 컴파일되지 않는다**. */
export type BenchLauncher =
  (cmd: string, args: string[], opts: SpawnOpts, commit: AuthorityCommit) => ChildProcess

export function createCommandRunner(deps: { launcher?: BenchLauncher }): CommandRunner
```
- `AuthorityCommit` 은 **CAS 성공 시에만 존재하는 브랜드 타입**(unique symbol 미export) → CAS 를 건너뛰거나
  실패를 무시한 채 bench CLI 를 띄우는 코드는 컴파일되지 않는다. `GatedChild`/`releaseExecGate` 는 **폐기**.
- 런타임 추가 방어: commit **단일 사용**(모듈 내부 WeakSet 소비) · `commit.activityId`·`commit.sourceGeneration`·
  identity 3필드 대조. 불일치는 throw 가 아니라 판별 유니온 반환(spawn 미수행).
- **정직한 한계**: 이 레포에 반환값 무시를 잡는 lint 룰이 없다(`--max-warnings 0` 도 무력). 브랜드 **인자**가
  1차 방어이고, 우회로(러너를 안 거치는 직접 spawn)는 `no-restricted-syntax` 구조 가드로 막되
  (`eslint.config.mjs` ELECTRON_DYNAMIC_IMPORT_SYNTAX 선례) **정적 가드는 computed 키를 못 잡는다**는
  원리적 한계를 계약 문면에 병기한다. 가드 존재 자체를 config 객체 단언으로 핀한다(T16c).
- 모든 `CasResult`/`ExecGateResult` 소비는 `switch (r.kind)` + `default: assertNever(r)`
  (`noFallthroughCasesInSwitch`, tsconfig.base.json:8 과 결합해 새 실패 종별이 미처리 호출부를 컴파일 에러로).

### W-5. 내구 쓰기 seam (`DurableFs`)

> ⚠ **[#251 PR2a 착지 시 정정 — 계획 정정 59·61·65·66·72가 우선]** 인터페이스 3점이 바뀌었다:
> ⓐ **`statKind(path)` 신설** — 형제 모듈이 굳힌 「읽기 전 종류 확인」 규율(FIFO 무한 블록 · symlink 권위
> 탈취 방어)을 seam 위에서 재현할 수단이 원안에 없었다. ⓑ **`mkdirRecursive(path, mode)`** — mode 인자가
> 없으면 권위 디렉터리 0700 을 주입 경로로 만들 수 없다. ⓒ **`openExclusive(path, mode)`**.
> 그리고 아래 「부팅 1회 실측 프로브」는 **win32 에서 시도하지 않는다**(상한 `'file-only'` 고정) — 3면 실측상
> win32 는 `openSync(dir,'r+')` 로 열면 fsync 가 **성공**하지만 MS 문서가 디렉터리 핸들 의미론을 규정하지
> 않아 POSIX 등가 보장이 아니고, 그것을 등급으로 올리면 U4 「조용한 강등 금지」의 쌍대인 **조용한 승격**이
> 된다. `area.json` 기록은 `AreaRecord` 확장(PR7/T29)까지 **미착지**이며 PR2 는 `writtenBy.durability` 에만 쓴다.

```ts
// ⚠ 아래는 **PR2a 착지 계약**이다(원안 대비 정정 3점은 위 블록 참조 · 소유 = core/workbench/durable-fs.ts).
export type PreCommitStep = 'mkdir'|'open-tmp'|'write'|'fsync-file'|'close-tmp'|'rename'
export type PostCommitStep = 'open-dir'|'fsync-dir'|'close-dir'
export type DurableWriteStep = PreCommitStep | PostCommitStep   // rename 경계로 분할(§W-4 정정)
export interface PathKind { readonly kind: 'regular'|'missing'|'other'; readonly size: number }
export interface DurableFs {
  readFileUtf8(path: string): string
  statKind(path: string): PathKind     // 신설 — 읽기 전 종류 확인(FIFO 블록·symlink 권위 탈취 방어)
  mkdirRecursive(path: string, mode: number): void   // mode 필수(권위 디렉터리 0700)
  openExclusive(path: string, mode: number): number  // create-only
  writeAll(fd: number, data: string): void
  fsync(fd: number): void
  close(fd: number): void
  rename(from: string, to: string): void
  openDir(path: string): number        // POSIX 전용 — 구현은 openSync(path,'r')
  unlinkIfExists(path: string): void
}
/** 부분 쓰기 재개(순수 · 바이트 오프셋). 실 FS 로는 부분 쓰기를 결정론적으로 만들 수 없어 seam 으로 뺀다. */
export function writeAllBytes(write: (b: Buffer, off: number, len: number) => number, data: string): void
export function createNodeDurableFs(): DurableFs
export function probeDurability(fs: DurableFs, dir: string, platform: NodeJS.Platform): DurabilityLevel
export function createBenchAuthorityStore(fs: DurableFs, opts?: {...}): BenchAuthorityStore   // PR2b
```
- **IO 전량 주입이 계약**(`GitRunner`(git.ts:29-31)·`idGen`(memory.ts:25) 선례 동형).
  **`vi.spyOn(node:fs)`/`vi.mock('node:fs')` 를 계약 테스트에 사용 금지** — win32 ESM 에서 조용히 skip 되어
  fsync 실패 주입 테스트 전체가 **false-GREEN** 이 된다(실측 선례: `ignored-baseline.test.ts:142-149,244-247`).
- 내구 등급은 **프로브가 유일 권위**이고 쓰기 경로가 그 값을 소비한다(판정자 이원화 금지 — 쓰기가
  플랫폼으로 분기하고 등급은 프로브로 정하면 「갖지 않은 내구성을 레코드가 주장」/「매 CAS 가
  `commit-uncertain`」 두 어긋남이 실재한다). 프로브 = 코디네이션 영역에서 실제 `openDir`+`fsync` 시도.
  **단 win32 는 시도하지 않고 `'file-only'` 로 상한 고정한다** — API 는 `'r+'` 로 성공하지만 그 성공이
  문서화된 의미론이 아니므로 등급으로 올리면 U4 「조용한 강등 금지」의 쌍대인 **조용한 승격**이 된다.
  기록처 = 레코드 `writtenBy.durability`(PR2b). ~~`area.json`~~ 은 `AreaRecord` 확장이 **PR7/T29 이월**이라
  이 슬라이스에서 자리가 없다. UI/런북 노출은 #253/#254.

### W-6. git 계층 — 신규 표면 `GitRepo`

기존 `Workspace`(작업 트리 편집 · #80 전용)는 **한 줄도 건드리지 않는다**(C12). 같은 파일에 레포 단위
read/ref 연산만 담은 신규 표면을 추가한다.

> **⚠ 아래 코드펜스는 #251 PR3a 착수 전 4면 git 실측으로 개정됐다**(계획 정정 112~121). 개정 전 문면은
> ⓐ실패 채널을 throw 로 두어 같은 절의 「실패를 값으로 반환」 관용구와 모순이었고 ⓑ**열거 메서드가 없어**
> §W-7 의 확정 판정식(`for-each-ref` 열거)을 이 표면으로 구현할 수 없었으며 ⓒ`isAncestor` 를 boolean 으로
> 접어 `merge-base --is-ancestor` 의 **128(해소 불가 OID)** 을 「비조상」으로 오분류했다.

```ts
/** 실패를 값으로 답하는 공통 꼬리. */
type GitFailure = { status: 'failed'; stderr: string; code: number | null }

export type GitRefListResult = { status: 'ok'; refs: { ref: string; oid: string }[] } | GitFailure
export type RefCasResult =
  | { status: 'updated' }
  /** `actual` = **실패 후 열거로 재조회한 디스크 값**. 「이미 존재」와 「기대값 불일치」가 둘 다 exit 128 이고
   *  문면은 버전마다 달라질 수 있어 **문자열로 분류하지 않는다**(그 방식이 `LOCK_RE` 계열의 재발이다). */
  | { status: 'rejected'; actual: string | null }
  | GitFailure
export type MergeTreeResult =
  | { status: 'clean'; tree: string }
  | { status: 'conflict'; tree: string; conflicts: string[] }
  | GitFailure

export interface GitRepo {
  commonGitDir(): Promise<GitRepoDirResult>               // rev-parse --path-format=absolute --git-common-dir
  listWorktrees(): Promise<GitWorktreeListResult>         // worktree list --porcelain
  /** for-each-ref 열거. **접두는 경로 성분 경계로 매칭**되고 bare 부모는 exact 항목으로 나타난다. */
  listRefs(prefix: string): Promise<GitRefListResult>
  addNamedWorktree(dir: string, branch: string, base: string): Promise<GitOpResult>  // worktree add -b
  addDetachedWorktreeAt(dir: string, base: string): Promise<GitOpResult>             // worktree add --detach
  removeWorktreeAt(dir: string, force: boolean): Promise<GitOpResult>
  revParse(rev: string): Promise<{ status: 'ok'; oid: string } | { status: 'absent' } | GitFailure>
  /** **열거 기반**이다 — `rev-parse --verify` 로 구현하면 win32 packed 공존에서 실존 ref 를 부재로 답한다. */
  refExists(ref: string): Promise<{ status: 'ok'; exists: boolean } | GitFailure>
  /** 정확 old-OID 조건부 갱신. ff-only(조상 검사)는 CAS 가 아니므로 발행에 쓰지 않는다(15R). */
  casUpdateRef(ref: string, newOid: string, expectedOldOid: string | null): Promise<RefCasResult>
  mergeTree(base: string, head: string): Promise<MergeTreeResult>   // merge-tree --write-tree --name-only
  commitTree(tree: string, parents: string[], message: string): Promise<{ status: 'ok'; oid: string } | GitFailure>
  /** **3값**이다(0/1/128). boolean 으로 접으면 오류가 「미완결」로 조용히 오분류된다(U4 쌍대). */
  isAncestor(a: string, b: string): Promise<{ status: 'yes' } | { status: 'no' } | GitFailure>
  /** merge-tree --write-tree 지원 여부(부팅 1회). 미지원이면 통합만 fail-closed 비활성 — 폴백 없음. */
  probeMergeTree(): Promise<{ supported: boolean }>
}
```
- **`mergeTree` 판별식은 종료코드가 아니라 stdout 첫 줄**이다(4면 실측): 충돌도 exit 1, **인자 오류도 exit 1**
  이며 갈리는 것은 stdout 뿐(충돌 = 첫 줄이 트리 OID · 오류 = 빈 문자열). 무관 히스토리는 128.
  **`--merge-base` 금지** — 배포 런타임 git 2.39.5 에 없는 옵션이다(exit 129).
- **발행 왕복 검증**: `casUpdateRef` 성공 후 **열거로 재확인**하고 값이 다르면 fail-closed. win32 packed D/F 는
  git 이 성공을 자칭해도 그 ref 가 해소되지 않는 상태를 만든다.
- **발행은 `--no-deref` 로 한다**(PR3a · Codex 2R): 기본 `update-ref` 는 symref 를 따라가므로, 대상 자리가
  dangling symbolic ref 면 create-if-absent 가 **네임스페이스 밖 ref 를 만들고** exit 0 을 내며 왕복 검증까지
  통과한다(실측). 결과 ref 가 **가변 대상의 별칭**이 되는 것을 구조적으로 막는다.
- **열거 완전성은 로케일 독립 규칙으로 판정한다**(PR3a · Codex 2R): 손상 경고 문면은 git 의 번역 대상이라
  영어 매칭은 비영어 로케일에서 빗나간다 → 「exit 0 인데 stderr 가 비어 있지 않다」를 불완전 신호로 쓴다.
- **`mergeTree` 의 충돌은 exit 1 뿐이다**(PR3a · Codex 2R): 러너는 취소·타임아웃·출력 상한에서 부분 stdout 을
  보존한 채 `code: null` 을 돌려주므로, 「0 이 아니면 충돌」은 **중단된 연산을 완료된 충돌로** 기록한다.
- 재사용하는 관용구는 4개로 한정: 실행 seam `GitRunner.run(args,cwd,signal)` · 에러 메시지 템플릿
  (`git.ts:115`) · `resolve(root, stdout.trim())` 파싱 · **실패를 값으로 반환**하는 `integrate` 계약.
- **태스크 worktree 경로 seam(C10↔C12 해소 · 반증 반영)**:
  ```ts
  export function createWorkspace(root: string, git?: GitRunner,
    opts?: { taskWorktreeDir?: (taskId: string) => string }): Workspace
  ```
  미주입 = 현행 `worktreeDir(root, taskId)` 그대로(**바이트 동일 · #80 무회귀**). bench 런은 engine 이
  `(taskId) => join(benchRoot, '.fleet-wt-' + benchId, '.fleet-wt-' + sanitize(taskId))` 를 주입한다
  (`src/main/core/workbench/bench-workspace.ts`). `Workspace` **인터페이스·오케스트레이터는 무변경** —
  `orchestrator.ts:611` 의 `ws.addWorktree(task.id, base)` 호출은 그대로다.
- **`ok()` 를 신규 연산에 쓰지 않는다**(불변식 G-1). ⚠ **근거를 실측으로 정정한다**(계획 정정 114·115):
  원문은 「`worktree add/remove` 가 공통 gitdir 을 다투므로 오조준 삭제」였으나, **메인 `index.lock` 아래에서
  `worktree add`·`update-ref`·`merge-tree` 는 4면 전부 exit 0** 이라 그 축에서는 재시도·삭제가 애초에
  발화하지 않는다. 오조준이 **실재하는 경로는 ref `.lock` 경합**이다 — `update-ref` 가 그때 exit 128 +
  `Another git process…`(레거시 `LOCK_RE` 매칭)를 내고, `ok()` 는 그 실패를 락 경합으로 분류해
  `lockPath()` 가 가리키는 **무관한 `index.lock` 을 삭제**한다. 따라서 신규 연산은 **삭제 금지·유계 지수
  백오프 재시도-only**(그 스코프는 **신규 한정**이며 레거시는 무변경 — 레거시 두 경로는 5종 락 선점
  전부에서 exit 0 이라 전환의 관측 이득이 0 이다).
- `signal` 을 전 신규 연산에 관통(현행 `createWorkspace` 는 미전달 — 취소 불가).
  **착지 형태(PR3a)**: `createGitRepo(root, git, { signal })` — **레포 스코프 주입**이고 내부 `run` 래퍼가
  전 메서드에 전달한다. 메서드마다 인자를 늘리지 않은 이유는 소비자가 「한 bench 작업이 자기 `GitRepo` 를
  만들어 쓰는」 형태(PR7 배선)이기 때문이다. **재시도 루프는 대기 전에 `aborted` 를 재검사**한다 —
  그러지 않으면 취소 후에도 백오프가 마저 도는 구간이 남는다(CodeRabbit PR#268).
- **git 능력 프로브(부팅 1회)**: `merge-tree --write-tree`(git ≥2.38) 미지원이면 **Workbench 통합 기능만
  fail-closed 비활성**. 두 번째 구현 경로(squash 폴백)를 만들지 않는다. 실측: 컨테이너 git 2.39.5 ✅.
  **결과는 3분류다**(PR3a · Codex PR#268): `supported` / `unsupported`(= **옵션 미인식** 증거 — pre-2.38 의
  `unknown rev --write-tree` · 구형 usage · exit 0 인데 OID 아닌 에코) / `indeterminate`(그 외 실패).
  **부팅 배선 규범**: `unsupported` 는 영구 비활성(버전 증거) · **`indeterminate` 는 비활성하되
  `ensureRepo`·첫 커밋 이후 재프로브**한다 — 프로브가 `HEAD` 를 쓰므로 **커밋 없는 레포**에서는 최신 git
  이어도 실패하고, 그것을 영구 비활성으로 굳히면 재시작 없이 되살릴 수 없다.
- **열거의 성공 판정은 종료코드만으로 하지 않는다**(PR3a · Codex PR#268 P1 · 2면 실측): `for-each-ref` 는
  손상된 loose ref 를 **exit 0 인 채 목록에서 빼고** `warning: ignoring broken ref …` 만 낸다. 복구 판정이
  **부재를 「발행되지 않았다」의 증거**로 쓰므로 그대로 두면 손상된 결과 ref 가 포기 적격이 된다 →
  손상 경고는 **fail-closed**. 단 경고는 **질의 접두 안에 손상이 있을 때만** 나므로 무관한 단일 ref 조회까지
  막지는 않는다(과잉 차단 시 손상 하나가 레포 전 연산을 멈춘다).
- `update-ref --stdin` 사용 시 **`--batch-updates` 금지**(CAS 거부에도 exit 0 — git 2.54 실측).
  ⚠ 그 옵션은 **배포 런타임 2.39.5·2.30.2 에는 존재조차 하지 않는다**(exit 129). 발행은 **단발
  `update-ref <ref> <new> <old>`** 이고 `<old>` 빈 문자열이 create-if-absent 다(40×0 은 SHA-256 레포에서
  길이가 달라진다).
- `worktree add -b` 는 브랜치 중복만 exit 255 — **종료 코드값을 계약으로 전제하지 않는다**(stderr 분류 병행).

### W-7. 통합 트랜잭션 · WAL · 결과 ref

**통합 계산 = worktree-less.** 설계 13R 의 "프라이빗 통합 worktree" 를 **`merge-tree --write-tree` 기반
worktree-less 프라이빗 계산**으로 축소한다(설계 대비 더 강한 무접촉 — worktree 를 아예 만들지 않으므로
`CHERRY_PICK_HEAD`·`AUTO_MERGE`·sequencer 잔재가 **원천 부재**).

```text
① 리스 안에서 bench 자동 keep(스냅숏 커밋) → sourceSnapshot 캡처
② baseRef OID 캡처 → targetHeadBeforeIntegration
③ merge-tree --write-tree <base> <sourceSnapshot>   → resultTree (충돌 시 값으로 보고 · **ref 변이 0**)
④ commit-tree resultTree -p <base> -p <sourceSnapshot>  → resultOid
⑤ casUpdateRef(refs/fleet/integrated/<benchId>/<txnId>, resultOid, null)  ← create-if-absent CAS
```
- `cherry-pick` 계열 기각: 증분·N커밋·sequencer 잔존. `merge --squash` 기각: 프라이빗 worktree 필요 ·
  `MERGE_HEAD` 미기록으로 `merge --abort` 불가 → reset-only 복구 = 설계 696행 금지 조항과 충돌.
- 결과가 2-parent 머지 커밋이므로 소비자 `merge --ff-only <resultRef>` 가 성립하고, bench 전체 스냅숏
  의미론(21R "증분 아님")이 구조적으로 보장된다.
- **정직한 단서(반증 반영)**: `merge-tree --write-tree` 는 이름대로 **병합 결과 트리·블롭을 오브젝트 DB 에
  실제로 기록**한다 — "git 변이 0" 이 아니라 **"ref 변이 0 · working tree 무접촉 · sequencer 무생성"** 이
  정확한 진술이다. ③④ 사이에 생긴 오브젝트는 어떤 ref 에서도 도달 불가하므로 동시 실행된
  `git gc --prune=now` 에 수거될 수 있다. 따라서 **③→④→⑤ 는 같은 락 구간 안에서 연속 수행**하고,
  복구 판정은 오브젝트 존재가 아니라 **결과 ref 존재**를 근거로 한다(§W-7 복구표와 정합).

**WAL 4단계 + 종결 1 (C7)**

```ts
export type IntegrationStage = 'prepared' | 'composed' | 'published' | 'finalized' | 'abandoned'
export type AbandonReason = 'user-abandon' | 'superseded' | 'stale-attempt'

export interface IntegrationTxnRecord {
  readonly schemaVersion: 1        // ⚠ 원안 `schema` 폐기 — 권위 레코드와 이름을 통일했고(계획 정정 141)
                                   //    **문법 검사보다 먼저** 본다(초과 = 'incompatible-version' · I12)
  readonly txnId: string; readonly benchId: string           // ULID
  readonly repoCommonGitDir: string; readonly benchRoot: string   // 대조 전용
  readonly sourceBranch: string; readonly sourceSnapshot: string  // auto-keep OID
  readonly sourceGeneration: number
  readonly targetBranch: string; readonly targetHeadBeforeIntegration: string
  readonly resultRef: string        // 문법 소유 = PR3c(정정 166 이 세대 결속으로 바꾼다) —
                                    // 저널은 비어 있지 않은 문자열까지만 본다(정정 174)
  readonly startedAt: number; readonly ownerEngineId: string      // 진단용
  readonly stage: IntegrationStage  // 단계 전진 = **같은 파일 덮어쓰기**(txn 당 1파일 · 정정 178)
  readonly resultTree?: string; readonly resultOid?: string   // stage >= 'composed' 필수
  readonly publishedAt?: number                               // stage >= 'published' 필수
  readonly abandonedAt?: number; readonly abandonReason?: AbandonReason   // 'abandoned' 필수

  // ── 권위 CAS 결속(Codex 3R · 계획 정정 167) — 저널은 **선기록**이므로 「무엇을 기대하고 썼는지」를
  //    함께 남겨야 복구가 「자동 승격 가능 / reconciliation-required」를 가를 수 있다. 그 **대조자는
  //    PR3c** 이므로 PR3b 안에서는 값이 기록만 되고 소비되지 않는다(vacuous 로 계상).
  readonly expectedAuthorityRevision: number   // 이 저널에 이어질 CAS 가 맞출 revision
  readonly previousAuthorityStage?: IntegrationStage  // 부재 = 진행 중 통합 없음(트랜잭션 첫 단계)
  readonly nextAuthorityStage?: IntegrationStage      // 부재 = 후속 CAS 가 통합 필드를 **소거**한다(포기)
  readonly integrationGeneration: number       // 발행자는 PR3c(prepared 마다 +1)
  readonly draftDigest: string                 // 제출될 권위 draft 의 정준 JSON sha256
}
```
**폐기 필드**: `targetHeadAfterIntegration` · 결과 종별 `applied|already-applied`(C5).
`resultKind: 'applied' | 'already-applied'` 는 **결과 트리 == 캡처된 base 트리** 로 재정의.

**저널 매체 계약(신설 · PR3b · 계획 정정 165·176·178)** — 원안은 레코드 타입만 규정하고 「그것을 어디에
어떻게 쓰는가」를 0건 규정해, 배치·tmp·리스·재시도가 전부 구현 재량이었다.

- **배치** = `<area>/journal/<benchId>/<txnId>.json`. txn 당 파일 **1개**이고 단계 전진은 **같은 파일
  덮어쓰기**다(§3-T64). `benchId`·`txnId` 는 경로 성분이 되기 **전에** ULID 문법 검증을 통과해야 한다
  (§W-1 과 같은 규율 — 정규화하지 않고 거부).
- **tmp** = **대상과 같은 디렉터리**의 `<txnId>.json.<ownerToken>.tmp`(별도 `tmp/` 없음 · §W-2).
  `<ownerToken>` 의 출처는 **bench 리스뿐**이며 문자열 인자로 받지 않는다 — PR3d 수확기의 배타원
  (「그 benchId 의 리스 보유자 · 다른 token = 죽은 잔재」)이 이 사실 위에 선다.
- **쓰기는 bench 리스 아래에서만**(§3-T70): 출처 확인(`isMintedLease`) + 리스↔레코드 identity 대조 +
  **rename 시도 회차마다 재검증**(L-6 동형).
- **내구 쓰기는 §W-4 C4 를 그대로 상속**한다 — create-only tmp → `writeAll` → fsync → rename, win32
  `rename` EPERM **유한** 재시도(§3-T68). rename **전** 실패 = 디스크 무변이, rename **후** 디렉터리 내구
  단계 실패 = 파일은 이미 게시됐으므로 **별도 종별**로 답한다(§W-4 의 `commit-uncertain` 과 같은 구분).
- **읽기는 D-9** — `readFileUtf8` 즉시-close 만. 비정규 노드는 **읽기 전** 거부(FIFO 무기한 블록 차단).
- **열거는 순수 필터**다 — 디렉터리 순회 프리미티브 신설은 PR3d 이므로, PR3b 는 **주어진 이름 목록**에
  대한 7종 검증(§3-T65)만 착지시킨다. 이 사실을 「열거가 있다」로 읽지 않는다.
- **WAL 전이는 저널이 강제**한다(§3-T66). 권위 레코드 쪽 전이 불변식 계층은 **PR3c**.
- **결속은 값으로 검사한다**(Codex PR#269 P1 · 계획 정정 184): ⓐ`previousAuthorityStage` 는 **디스크의
  현재 단계와 같아야** 한다 — 전이 검사는 「디스크 → 새 stage」만 보므로, 이것이 없으면 저널이 **결속이
  없던 전이를 증언**하고 복구가 그 거짓 위에서 판정한다 ⓑ**크레덴셜 1개 = 전이 1개** — revision 결속만
  두면 같은 커밋으로 두 단계를 써 **저널이 권위를 앞선다**. 저널 **지역** 원장으로 결속하고(형제
  `SPENT_COMMITS` 는 런처가 소비하므로 공유하지 않는다) **같은 전이의 정확 재시도는 허용**한다
  ⓔ**결과 증거는 한 번 나타나면 동결**된다(`resultTree`·`resultOid`·`publishedAt` — 처음 등장은 단계의
  계약이고 **교체가 금지**다. txn 당 파일이 하나라 교체하면 원본 증거가 그 자리에서 소멸한다)
  ⓕ읽기 증거는 **소진되지 않았고 발급 구역이 살아 있어야** 한다(민팅 조회만으로는 그 CAS 를 인가할 수
  없는 읽기에 활성 WAL 증거가 남는다) ⓖ`draftDigest` 는 **CAS 가 기록할 투영**을 해시한다(호출자 draft 의
  초과 키가 섞이면 같은 의도가 다른 증거로 보인다)
  ⓒ`abandoned → abandoned` 는 **정확한 멱등 재생만** 허용한다 — 파일이 하나라 다른 사유·시각으로
  재기록하면 원본 감사 증거가 그 자리에서 소멸한다 ⓓ**출처를 먼저 본다** — 크레덴셜이 권위 모듈의
  민팅 원장에 있어야 한다(`isMintedCommit`·`isMintedRead`). 스프레드 복제는 브랜드를 보존한 채 **새
  객체**라 ⓑ의 동일성 키 원장을 빈 채로 조회하게 만든다. **조회일 뿐 소진이 아니다** — 소진은 런처
  계약이고, 저널이 함께 소비하면 「CAS2 → 저널 → spawn」이 구조적으로 불가능해진다.
- **`schemaVersion` 판정은 최상위 객체 확인 직후**다 — 오염 키·형태 검사보다 앞선다. 상위 버전 파일은
  무엇이 더 들어 있든 `incompatible-version` 이며, 그 종별만이 파괴적 조치를 차단한다(I12).
- **옵션은 생성 시점 스냅숏**이고 **원장·겹침 가드는 모듈 스코프**다 — 전자는 호출자가 나중에
  `journalDir` 를 바꿔 쓰기 경계를 재조준하는 것을, 후자는 두 번째 store 를 만들어 1:1 결속을 우회하는
  것을 막는다(형제 계획 정정 95 와 같은 근거).
- **호출자의 권위 임계 구역 생존을 주입받는다**(`sectionLive` · 필수). 재시도 백오프가 이 모듈의 첫
  `await` 라, 호출자가 쓰기를 `await` 하지 않고 `withAuthority` 콜백을 끝내면 **뮤텍스가 풀린 뒤에도**
  쓰기가 살아남아 다음 임계 구역이 갱신한 bench 위에 rename 한다. 그때 **리스는 여전히 유효**하므로
  L-6 재검증으로는 막지 못한다 — 그래서 별도 종별(`section-closed`)로 답한다.
- **심링크를 따라가지 않는다**: `mkdirRecursive` 는 기존 심링크를 그대로 따라가므로, 쓰기 직전
  `<journalDir>/<benchId>` 의 종류를 보고 심링크·정규 파일이면 거부한다. 조상 경로는 **호출자의 정준화
  계약**이다(형제 `authorityDir` 와 동형). 이 판정을 위해 `PathKind` 에 `'symlink'` 를 **추가**했다 —
  기존 소비자는 전부 `!== 'regular'` 비교라 읽기 측 계약은 무변경이다.

**복구 판정(순수 함수 · 무변이 관찰만 · git 변이 0)**

| stage | resultRef 값 | 판정 |
|---|---|---|
| — | (`refs/fleet/integrated/<benchId>` 가 ref 로 존재) | `REF_NAMESPACE_CONFLICT` **최우선** fail-closed |
| `prepared` | 부재 | `no-mutation`(포기·재준비 적격) |
| `prepared` | 존재 | `RESULT_REF_UNATTRIBUTED` → reconciliation |
| `composed` | 부재 | `no-mutation` |
| `composed` | `=== resultOid` | `promote-published` |
| `composed` | `!== resultOid` | `RESULT_REF_MISMATCH` → reconciliation |
| `published` | — | **정상 대기**(차단 아님 · C6) |
| `finalized`/`abandoned` 잔존 | — | 청소 복구(멱등) |
| **ref-앵커 재조정 불일치** | — | **reconciliation(win32 `file-only` 전용 4번째 분기 · C3/U4)** |

- **ref-앵커 재조정(반증 반영 — 원안 폐기)**: 원안은 "저널 부재 ∧ `lastObservedTargetHead` 불일치"였으나
  두 겹으로 발화하지 않는다 — ⓐ앵커를 **롤백 대상인 권위 레코드 안에** 두었으므로 권위 파일이 통째로
  이전 세대로 되돌아가면 앵커도 함께 되돌아간다 ⓑFleet 은 baseRef 를 어떤 조건에서도 전진시키지 않으므로
  (C11) target HEAD 는 애초에 움직이지 않아 "불일치"가 win32 크래시 주 경로에서 성립하지 않는다.
- **확정 판정식**: 부팅 시 `git for-each-ref refs/fleet/integrated/<benchId>/` 를 열거해,
  권위 레코드의 `currentIntegrationTxnId`·`completedIntegrationTxnId` **어디에도 귀속되지 않는 txnId 의
  결과 ref 가 1건이라도 존재하면 `reconciliation-required`**(권위 롤백 탐지). 앵커가 권위 파일 **밖**에
  있어야 하는 이유는 안에 두면 롤백 시 함께 되돌아가 발화하지 않기 때문이다.
- ⚠ **「독립 매체라 동시 롤백이 불가능하다」는 거짓이다**(git 소스 대조로 확정 · 계획 정정 133·152·156).
  git 은 기본 설정에서 ref 를 fsync 하지 않고(`FSYNC_COMPONENTS_DEFAULT` 에 REFERENCE 부재 ·
  `core.fsync=all` 로도 loose ref 게시 rename 경로에는 디렉터리 fsync 가 없다) 권위 파일은 rename **전에**
  fsync 되므로, **ref 가 더 약한 매체**다. 따라서 앵커는 **권위 쪽 단독 롤백만** 탐지하는 확률적 보조
  신호이며 **ref 쪽 롤백·양쪽 동시 롤백에는 fail-open** 이다. 안전 근거로 인용하지 않는다.
- `lastObservedTargetHead` 는 **보조 신호로 강등**(외부 소비자 완결 관측용). 그 값의 부재는 reconciliation
  사유가 아니다.
- 복구 중 **자동 재시도·cherry-pick·reset·abort·skip·삭제 일절 금지**(설계 696행 유지).

**포기(abandon) 의미론** — 저널·권위 레코드만 종결한다. **git 변이 0.**

| 대상 | 포기가 하는 일 |
|---|---|
| 저널 | `stage:'abandoned'` 확인-응답 기록 → 권위 CAS. ⚠ **「엔트리 제거」는 「활성 집합에서 제외」로 읽는다**(계획 정정 135) — 파일은 **삭제하지 않고 감사 보존**한다(1109행이 후행 개정이자 목적 명시라 권위다). 765행 복구표의 「청소 복구」도 **멱등 종결**이지 삭제가 아니며, 그 표 문면 개정은 PR3c 소관이라 그때까지 스펙은 이 축에서 부분 모순으로 남는다(은폐하지 않는다) |
| 권위 레코드 | `currentIntegrationTxnId → null`(revision CAS) · `lifecycle` **무변** · `sourceGeneration` **무변** |
| 결과 ref | **삭제하지 않는다**(소비자가 이미 머지했을 수 있음) |
| auto-keep 커밋 | **bench 브랜치에 보존**(사용자 작업 무손실 = 포기가 안전한 근거) |
| bench lifecycle | `open` 을 떠난 적이 없다 — 파생 상태만 소거 |

- **거부 불변식**: `resultOid` 가 현재 base 에서 도달 가능하면 포기 거부(`reachable-from-base`).
- **롤백은 unsupported** — Fleet 은 baseRef 를 움직인 적이 없고(17R) 외부 worktree 무접촉이며, 되돌릴
  대상인 auto-keep 커밋의 되감기는 `reset --hard`(파괴적)이므로 포기의 일부가 될 수 없다.

### W-8. 완결 관측 · 세대 모델

- `integrated` = ⓐ`baseRef === resultOid` 또는 ⓑ**`resultOid` 가 현재 base 의 조상**(`merge-base --is-ancestor`)
  ∧ 저널 `targetHeadBeforeIntegration` 과의 구성 관계 검증. 동등 내용·빈 머지·stderr 텍스트·source 조상성으로
  완결을 추론하지 않는다.
- 완결은 **권위 시도만**: `currentIntegrationTxnId` 의 resultOid 도달성만 인정. superseded 결과만 도달
  가능하면 **`partially-integrated`**(integrated 금지). 완결 귀속은 `completedIntegrationTxnId` 로 기록.
- **완결 관측 경로도 같은 리스 + 조건부 CAS**: txn 동일 ∧ valid/current ∧ **현 소스 세대 대표** ∧
  활성/시작-중 편집 활동 없음 ∧ 전이 가능 — 전부 리스 안 재검증 후 기록.
- **stale-attempt**: 완결 명령 노출 전(및 관측 시마다) 현재 base 에서 ff 가능성 검사 → 불가하면 명령 노출
  **중단** + `stale-attempt` 전환. 재준비는 명시 액션 = 새 txn/WAL 세대(기존 시도 신원·ref 불변 superseded).

### W-9. 생성 · 보관 트랜잭션 · 고아

**고아는 크래시 잔재가 아니라 정상 실패 경로의 정규 산출물이다(실측 · 종료코드 정정)**:
`git worktree add -b` 의 실패는 원인별로 **다른 코드와 다른 잔재**를 남긴다 —
| 실패 원인 | 종료 코드 | 브랜치 잔재 |
|---|---|---|
| 대상 디렉터리가 비어 있지 않게 선점됨 | **128** | **남는다**(고아 브랜치) |
| 브랜치 이름 중복 | **255** | 남지 않음(생성 자체가 거부) |

즉 **"원자적이라 고아를 남기지 않는다"는 브랜치 중복 경로에만 참**이고, 디렉터리 선점 경로에서는 거짓이다
(초안이 §W-9 와 §W-17 에서 같은 명령에 정반대 실측을 주장한 것을 정정 — 반증 반영).
**종료 코드값을 계약으로 전제하지 않고**(§W-6) stderr 분류를 병행한다.

- 생성도 **WAL 선기록**(`prepared` → git 생성 → `finalized`). git 호출 **전에**
  `benchId↔branch↔benchDir↔txnId` 를 내구 결속 — 그래야 고아 브랜치를 ttyd 사용자의 정당한 브랜치와 구분할 수 있다.
- **생성 저널은 통합의 `prepared` 규칙을 상속하지 않는다**: 생성의 효과는 전부 이름으로 지정 가능하므로
  (경로=f(id)·브랜치=f(slug)) 3채널 열거로 {없음·부분·완전} 판정이 결정론적 → `prepared` + 산출물 0건은
  reconciliation 없이 **`never-applied` 로 종결**한다.
- **「자동 삭제 금지」의 스코프 명시**: 설계는 그 금지를 **복원(368-369행)과 복구(696행)에만** 걸었고
  라이브 트랜잭션 중단은 다룬 적이 없다. 트랜잭션 내 되감기는 R1~R4 **AND** 조건에서만 허용한다 —
  ①동일 프로세스 라이브 ②txn 소유 증명 ③사용자 작업 0 증명 ④미-finalized. 크래시 복구 경로는 R1 을
  구조적으로 만족할 수 없어 **자동 삭제가 원천 차단**된다.
- 고아 표현: bench 레코드가 없으므로 카드가 아니라 **레포 스코프 「정리 필요」 목록**. 액션 = 삭제(승인 경유)
  **및 「채택」**(그 브랜치로 bench 재구성) — 막다른 길을 만들지 않는다.
- **보관도 WAL**: `prepared`(의도 + `archivedBranch` 선택) → 자동 keep → worktree 제거 → 브랜치 삭제(선택) →
  `finalized`. **미통합 변경이 남은 브랜치의 삭제 보관만 `ApprovalGate` 경유**(risk `'destructive'`).
  `archivedBranch:'preserved'` 보관은 **게이트 비경유**(승인 피로 방지).
- **승인 2-페이즈(L-5 준수 · 반증 반영)**: `ApprovalGate` 는 **WAL `prepared` 기록·락 획득 이전**,
  즉 **락/리스 미보유 상태에서** 호출한다. ①락 밖: 무락 관찰로 사전조건 스냅숏(`revision`·`sourceGeneration`·
  브랜치 OID·저널 stage)을 캡처하고 `gate.request` 로 의도 인가 획득 → ②레포 락 → bench 리스 →
  ③락 안에서 캡처 스냅숏과 **정확 일치 재검사** → 일치할 때만 집행 → ④불일치면 **승인을 소모 없이 폐기**
  하고 fail-closed. 원안(게이트가 WAL·락 안에 놓임)은 L-5 를 위반해 프로덕션 TTL 30분 동안 레포 변이 락을
  점유했다.

### W-10. 엔진 배선

```ts
export interface RunProjectRequest { goal: string; /* … */ benchId?: string }   // 단일 타입 확장으로 IPC/WS/preload 관통
export interface ActiveRunRef { projectId: string; benchId?: string }
export interface RunActivity {
  activeProjectIds: string[]        // ★ 레거시+bench 전체 집합 — 드레인 판정의 유일 권위
  activeRuns: ActiveRunRef[]        // required additive
}
export function hasLegacyRun(a: RunActivity): boolean   // benchId 부재 런만 — workspace:set·렌더러 잠금
```
- **불변식 R-1**: 전 스코프 런은 `activeProjectIds` 에 나타난다. bench 런을 빼면 SIGTERM 시 진행 중 bench
  런이 **무성 절단**된다(`waitForRunDrain` 은 `activeProjectIds.length===0` 만 본다 — boot.ts:297-316,680).
  설계 전문에 drain 언급이 0건이라 이 갭은 문서화되지 않았다.
- **불변식 R-2**: 레거시 스코프 판정은 `benchId` 부재로만 한다(`workspace:set` 차단 · `ProjectPanel` 잠금).
- **불변식 R-3**: 런 루트 3값은 항상 같은 루트에서 파생 — `resolveRunRoots(benchId?) → {workspace, workspaceRoot, verify}`
  단일 파생 함수. `workspaceRoot` 만 bench 로 바꾸면 편집은 bench, 검증은 메인인 **split-brain** 이 된다(engine.ts:742-745).
- **U2 · verify 미가용**: bench worktree 에는 `node_modules` 가 없다(이 레포 639MB · `worktree add` 는 tracked 만
  체크아웃). 의존성 미설치 감지 시 **`verify.unavailable`** 로 보고하고 verify-fix/replan 에 **진입하지 않는다**
  (#166 「검증 항목 없음」 정직 표면화 동형). 완주 판정은 verify 없이 성립한다.
- 가드 재편: `activeRuns.size > 0`(engine.ts:653) → **스코프별** 판정. bench 없는 레거시 런은 종전대로 전역 1개.
- **불변식 R-4 (설계 §3.2.1-7 승계 · 초안 누락 정정)**: 메인 워크스페이스 **레거시 런과 bench 통합은
  상호배제**한다. 레거시 `revert`(`reset --hard`)가 완료된 통합 커밋을 되감는 것은 **의미 충돌**이라 순서
  직렬화로 막을 수 없다 — 레거시 런 활성 중 bench 통합 거부, 통합 트랜잭션 중 레거시 런 시작 거부
  (레포 변이 락의 보호 대상에 main worktree 사용권을 포함). 레거시 런이 후속 슬라이스에서 bench 로
  흡수되면 이 규정도 소멸한다.
- **불변식 R-5 (설계 §3.2.1-8 승계)**: `ok()` 의 "오케스트레이터는 순차 실행" 전제는 bench 병렬로 무효다.
  스테일 `index.lock` 강제 제거는 **자기 worktree index 만 만지는 명령**(`add -A`·`commit`)에 한정하고,
  **공통 gitdir 변이 명령**(`worktree add`/`remove`)은 **삭제 금지·지수 백오프 재시도-only** 로 분리한다
  (현행 `lockPath()` 는 cwd 의 index.lock 을 해소하므로 오조준 삭제가 된다).

### W-11. 세션 cwd (U3)

```ts
export interface SendOptions {
  workspace?: string   // 기존 — 편집 모드(항상 stateless/fresh) 스위치. 의미 무변경
  cwd?: string         // 신설 — 편집 모드와 직교. 대화 경로의 작업 디렉터리만 바꾼다
}
```
- **인용 정정(반증 반영)**: `cli-session.ts:125·146` 은 "대화 분기"가 아니라 `runStateless`·`runStateful`·
  **`runEditing` 이 공유하는 `execute()` 내부**다. 따라서 그 자리에서 `sendOpts.cwd ?? sendOpts.workspace`
  로 치환하면 **편집 경로의 cwd 의미까지 바뀐다**. 올바른 계약: **분기 지점(226-227행 `if (sendOpts.workspace)
  return runEditing(...)`)은 `workspace` 로만 판정**하고(편집 모드 의미 무변경), `execute()` 에는
  **호출자별로 이미 결정된 cwd 를 인자로 내려보낸다** — 대화 경로는 `sendOpts.cwd`, 편집 경로는
  `sendOpts.workspace`. `SendOptions.cwd` 는 **편집 모드를 트리거하지 않는다**가 불변식이다.
- **누출 차단**: API 세션의 워크스페이스 읽기 도구 클로저(`engine.ts:448` `workspaceDir ? createWorkspaceReadTools(workspaceDir) : []`)도
  bench 스코프화한다 — 안 하면 bench 대화가 메인 워크스페이스 파일을 읽는다.

### W-12. 상한

| 상수 | 기본 | 성격 | 초과 시 |
|---|---|---|---|
| `WORKBENCH_MAX` | 8 (`lifecycle!=='archived'` 계수) | 상수 + env `FLEET_WORKBENCH_MAX` | 생성 거부 |
| `WORKBENCH_MAX_ACTIVE` | 2 (절대 상한 4) | 상수 + env `FLEET_WORKBENCH_MAX_ACTIVE` | 활동 시작 거부 |

- 하한 2 = **§5 완료 정의가 강제**(서로 다른 bench 2개 동시), 상한 4 = 활동당 최악 메모리 실측(~208MiB) 구속.
- **운영자 env = fail-fast throw**(`resolveDrainTimeoutMs` 관용구) / **렌더러 입력 = 조용한 clamp**
  (`clampConcurrency`, engine.ts:202-204) — 두 관용구를 명시 분리.
- **동시 활동 상한은 엔진-로컬 카운터로 집행하지 않는다**(설계 7R/23R 정면 위반 — Electron+server 가 각각
  상한을 허용하는 fail-open). 코디네이션 영역의 **고정 개수 명명 슬롯 리스**
  (`<area>/s/slot-<i>.s`, i∈[0,max)) + **비대기 try-acquire**(락 서열에 대기 간선 추가 금지) +
  **i 오름차순 고정 스캔**(임의 순서면 두 인스턴스가 서로 다른 순서로 훑어 상호 방해로 과소 허용).
- **슬롯 개수는 `area.json` 에 고정 기록한다**(신설 · P2). `max` 를 env 로만 두면 **두 표면의 env 가 다를 때
  상한이 갈라진다**(fail-open — 이 계약이 막으려던 바로 그 실패). 현재 env 와 `area.json` 기록이 불일치하면
  **어떤 슬롯 획득도 시도하지 않고 fail-closed**(L-4 동형).
- 초과 판정은 **자원 점유(worktree/브랜치 생성·exec 게이트 해제) 이전에** 수행하고 `{reason,cap,current}`
  감사 이벤트를 남긴다(`pending-cap` 관용구). UI 비활성은 보조.

### W-13. 이벤트

- **push 채널 신설 금지.** bench 오케 런 이벤트·bench lifecycle 이벤트 모두 기존 `fleet:orchestrator:event`
  로 방출한다. 근거: hello 는 **채널 무관 전역 커서 1쌍**이고 클라 커서 전진은 `onOrchestratorEvent` 단일
  구독에만 결속 — 새 채널의 seq 는 커서를 전진시키지 못해 **재접속마다 `hasEventGap` 오탐이 상시화**된다.
  broadcast 는 같은 소켓 FIFO 라 채널 분리의 순서/격리 이득도 0이다.
- **구분자 = `data.benchId`**(옵셔널 규약 키). `FleetEvent`/`OrchestratorEvent` 타입 변경 0
  (`types.ts:374,414` 가 이미 `Record<string, unknown>`).
- bench lifecycle 은 `OrchestratorEventType` 유니온에 **`bench.*` 5종** 추가
  (`bench.created`·`bench.integration_ready`·`bench.integrated`·`bench.archived`·`bench.reconciliation_required`).
  이들은 `projectId` 를 싣지 않으므로 `ProjectPanel` 필터(ProjectPanel.tsx:182)가 자동으로 걸러진다.
- **⚠ 그러나 bench *런* 이벤트는 `projectId` 를 싣는다**(`project.created`/`project.done` 등) — 자동 필터가
  성립하지 않는다(반증 반영). 레거시 `ProjectPanel` 이 bench 런을 자기 런으로 오인해 자동 선택·running
  잠금하는 회귀가 생기므로, ProjectPanel 의 (a) `onOrchestratorEvent` 3분기(created/done·cancelled·log)와
  (b) `getRunActivity` 하이드레이션이 **`data.benchId` 및 `RunActivity.activeRuns[].benchId` 로 레거시
  스코프를 걸러야 한다**(R-2). §2 parity 표에 해당 파일을 등재한다.
- **`verify.unavailable` 도 `OrchestratorEventType` 유니온에 추가**(6번째 · 신설). §2 는 `verify/run.ts` 에
  "보고 경로"를 두라고 했으나 그 파일엔 이벤트 방출기가 없다 — **순수 술어는 `verify/run.ts`, 방출은 engine**.
- **승인 카드의 bench 식별(신설 · P2)**: 다중 bench 에서 승인 카드가 어느 bench 것인지 구분되지 않으면
  C1/C2 승인 UX 가 무너진다. 4개 `gate.request` 호출부 중 **오케 런 경로 2곳**(`orchestrator.ts:353`
  apply-diff · `:928` verify-fix)과 **도구 경로**(`tools/loop.ts:180`)에 bench 컨텍스트를 실을 지점을
  계획이 지정한다. `mcp/host.ts:245` 는 전역 `setServers` 라 bench 무관 — **명시 비범위**.
- **seq 는 전역 단조 1개 유지, bench별 커서 도입 금지.**
- 영속+라이브+seq 스탬프 이디엄을 공용 헬퍼 `emitPersisted` 로 추출(engine.ts:772-774 주석이 경고한
  "우회 생산자 seq 비대칭" 클래스의 3회차 재발 차단).

### W-14. 채널/브리지 parity — **invoke 8면 · push 5면**

설계 §3.6 의 "3중 게이트"는 **both-invoke 전용**이다(`fixtures.ts:112` = `Record<BothInvokeChannel,…>`).
서버 push 배선(`wsHost.broadcast`)을 강제하는 게이트는 **0건**이라, bench 이벤트가 웹에서 무성 미방출되는
실패를 아무것도 잡지 못한다. 게이트 표를 재정의하고 누락 2면을 이번 슬라이스에서 신설한다.

| 종류 | 강제면 |
|---|---|
| invoke(7) | `channels.ts` · `types.ts`(FleetBridge) · `preload/index.ts` · `main/index.ts`(registerIpc) · `ws-bridge.ts` · `handlers.ts`(ChannelMethodMap+테이블) · `fixtures.ts`+`serialization.test` |
| push(5) | `channels.ts` · `preload`(on+removeListener) · `main` send · `ws-bridge` subscribe · **★서버 broadcast 배선(신설)** |

- **신설 게이트 2**: ① `boot.ts` 소스 스크레이핑 parity — 실제 호출부는 **`wsHost?.broadcast(`(옵셔널
  체이닝)** 이므로 `wsHost.broadcast('` 리터럴로 스크레이핑하면 **0건 매칭 = vacuous GREEN** 이다(반증
  반영). 정규식은 `wsHost\??\.broadcast\(\s*'([^']+)'` 로 하고 **매칭 건수 > 0 을 먼저 단언**한다.
  ② `PUSH_FIXTURES satisfies Record<BothPushChannel, unknown>` 신설 + `serialization.test` 확장.
- bench 채널 = **invoke 6 + push 0**(W-13), 전부 `scope:'both'`.
- **invoke 강제면은 8이다(정정)**: 위 7면 + `ws-bridge-binding.test.ts` 의 `BINDINGS` 테이블
  (both-invoke 채널 전수를 대조하므로 누락 시 실패).
- **범위 주의**: 신설 게이트 2건은 bench 와 결합이 0이다(bench push 채널 = 0). 이번 슬라이스에서 이 게이트가
  잡는 회귀는 **기존 push 채널**의 것이며, 슬라이스 축소가 필요하면 1순위 절삭 후보다(§7).
- push 페이로드는 **bare string 금지 · 판별 유니온 객체 · 경로/토큰 미탑재**를 계약으로 명문화.

### W-15. UI

- 탭 3점 세트(유니온 · `TABS` 배열 · `useState` 기본값)를 **코드 리터럴로 고정**하고,
  **기본 탭 변경의 필수 동반 수정 3건**을 계약 항목으로 등재:
  `approval-hold.web.e2e.ts:55` 앞 세션 탭 클릭 삽입 · `App.test.tsx:17,23-25` mockFleet 에 bench 목록 목 추가 +
  주석 갱신 · `mobile-responsive.web.e2e.ts:16`. (그 외 e2e 8파일은 탭을 명시 클릭하므로 안전 — 실측.)
- 재하이드레이션은 새 컨텍스트를 만들지 않고 `useHydration().nonce` 를 effect deps 에 넣는 **기존 4개
  소비처와 동일한 단일 관용구**. 설계 §3.6 "스냅샷에 bench 포함" 문면은 메커니즘을 오도하므로
  "패널이 nonce deps 로 자기 스냅샷 재조회 + 라이브-우선 가드"로 정정.
- **카드 표현 = primary 배지 1 + 차단 사유 칩 N.** 현행 단일 배지 렌더(ProjectPanel.tsx:373-375)를 그대로
  쓰면 `broken ∧ 미결 저널`에서 사유 하나가 소실된다. e2e 셀렉터 고정: `[data-bench-badge]` 정확히 1개,
  `[data-bench-chip]` 은 차단 사유 수와 동수.
- 액션 **8종**: `run`·`chat`·`prepare-integration`·`re-prepare`·`abandon`·`archive`·`delete-record`·`reconcile`.
  (`abandon` 은 반증 반영 신설 — §W-7 이 `AbandonReason:'user-abandon'` 을 정의해 사용자 포기를 전제하는데
  액션 목록에 없어 integration-ready bench 의 탈출 경로가 0개였다.)
  **버튼 활성의 유일 근거는 배지가 아니라 인가 결과**(§W-18).
- 모바일은 CSS-only 가 아니다(JSX 신규 불가피). #221 규약을 5개 기계 검증 규칙으로 풀어 계약화:
  ①640px 셸 블록(styles.css:1198) 안에만 추가 ②safe-area additive ③vh→dvh 병기 ④기존 `.btn`/`button.chip`
  재사용으로 44px 상속 ⑤reduced-motion 은 블록 안 중첩.
- 카드 그리드는 선례 없음(`auto-fill` 0곳) → 신규 클래스 확정. `.panel` 을 카드 셸로 재사용하고 `.stack` 은
  쓰지 않는다(nth-child(6) stagger 한계). 상태 배지는 `statusColor` 확장이 아니라 **`benchStatusColor` 신설**
  (D5 타입 충돌 회피 원칙 정합).

### W-16. 자식 수명 · 해제 판정 (U1 절삭판)

> ⚠ **[ADR-0013 으로 정정됨 · #251 PR1c]** 아래 절의 프리미티브·논증 일부는 착지 구현과 다르다 — `docs/adr/0013-인스턴스-배타-커널-endpoint-우선-container_name-배포집행.md` 와 계획 정정표 ㊲~㊿ 가 우선한다.
> ②의 「마커 불일치 ⇒ PID 네임스페이스 소멸 = 트리 사망 확정(커널 강제)」는 과장이다 — 마커 불일치가
> 증명하는 것은 「기록자가 현 인스턴스가 아니다」뿐이고, 사망 추론은 **단일 인스턴스 배포 계약**에 의존한다.
> 착지 구현은 그 차이를 `ReclaimEvidence`(`kernel-proven` / `deployment-premise`)로 값에 남긴다.

가디언 런처·플랫폼 봉쇄는 **이번 슬라이스 비범위**. 리스는 **엔진 인스턴스가 보유**한다.

**해제 판정 3분류(보수적)**
| # | 조건 | 변이 적격 |
|---|---|---|
| ① | 정상 해제 — **트리 사망 증거** + 활동 종료 레코드를 확인-응답 기록 후 리스 해제 | ✅ |
| ② | **컨테이너 표면 한정** — 기록된 인스턴스 마커 `sha256(hostBootId:pid1StartTicks)` ≠ 현 인스턴스 ⇒ PID 네임스페이스 소멸 = 트리 사망 확정(커널 강제) | ✅ |
| ③ | 그 외 전부(데스크톱 크래시 · 마커 부재/불일치 불확실 · **트리 사망 미증명**) | ❌ **reconciliation-required** |

**②의 정확한 논증 범위(로컬 적대 검증 반영 · 서버 단일 표면 축소 후)**: 마커 불일치는 엄밀히는
"**기록자가 현 인스턴스가 아니다**"만 증명한다. "기록자가 소멸했다"로 넘어가려면 **같은 코디네이션 영역을
보는 인스턴스가 동시에 둘 이상 존재하지 않는다**는 전제가 필요하다.
- 초안은 이 전제를 **compose 배포 계약으로 명문화한다**고만 썼는데, 실측상 `container_name` 은 레포 어디에도
  없었고 `--scale fleet=3` 이 경고 없이 성공했다 — **문면이 전제를 집행하지 못했다.**
- **축소 후 이 전제는 §W-2-b ①(`open(active-instance.json,'wx')`)이 런타임에서 집행한다** +
  compose `container_name` 고정(`scale>1` 거부)이 파일로 뒷받침한다. 두 인스턴스가 동시에 살아 있으면
  `wx` 가 한쪽을 막으므로 **"마커가 다른데 둘 다 살아있다"가 성립하지 않고**, 그래서 ②가 비로소 안전하다.
- 초안이 요구했던 "라이브 소켓을 쥔 다른 인스턴스 부재 확인"은 **삭제한다** — 추상 소켓은 net ns 스코프라
  그 확인이 원리적으로 불가능하고(살아있는 타 ns 보유자에 대해 '없음'이라는 **긍정 오답**을 낸다),
  그 자리를 `wx` 배타가 대체한다.

**①의 전제 = 트리 사망 증거(반증 반영 · P1)** — 원안의 ①은 종료 레코드만 요구해 **자식 트리 사망 증거를
하나도 요구하지 않았다.** 스펙 자신이 "현행 `killTree` 는 win32 전용이며 Linux 에서 트리 소멸을 증명하지
않는다"고 인정하면서 ③으로 사상한 것은 `KILL_GRACE_MS` 만료 정착뿐이었다. 결과적으로 **POSIX(컨테이너
프로덕션 표면 + linux 데스크톱)에서 CLI 가 정상 exit 한 경로는 손자 생존과 무관하게 전부 ①** 이 되어,
에이전트가 남긴 dev 서버·watcher 가 bench worktree 를 편집하는 중에 auto-keep·merge-tree·
`worktree remove --force`·브랜치 삭제가 수행될 수 있었다. 이는 비-크래시 경로의 구멍이라 U1 절삭의
안전 논증("양쪽 다 크래시 → fail-closed")이 다루지 않는다.

- **트리 사망 증거의 표면별 정의**: win32 = `killTree`(taskkill /T) 완료 확인 / **POSIX = 활동을
  `detached:true` 로 띄워 프로세스 그룹을 만들고, 종료 시 `kill(-pgid, SIGKILL)` **집행** 후 그룹 부재
  확인** / 컨테이너 크래시 경로 = ②의 ns 소멸.
- **배관 계약(P1 · §2 표 보강)**: 현행 `killTree` 는 **win32 전용**(`src/main/core/process/kill-tree.ts:57-63`
  — POSIX 는 `child.kill()` 단발)이고, `RunOpts` 및 실제 spawn 옵션(`cli/detect.ts:17-36,120-124`)에
  **`detached` 필드가 없다.** 따라서 이 계약은 파일 2개의 수정을 필연적으로 요구한다:
  - `src/main/core/process/kill-tree.ts` — `killTree(child, { processGroup?: boolean })` **opt-in**
    (미지정 = 현행 바이트 동일 · #80/MCP 무회귀). **§2 parity 표에 등재**한다.
  - `SpawnOpts` 에 `detached?: boolean`. (`RunOpts` 확장은 **선택** — launcher 가 자체적으로 넣을 수 있다.)
- **집행과 판정의 구분(설계 616행과 병기)**: 설계가 금지한 것은 `kill(-pgid, 0)` 을 **생존 판정**에 쓰는
  것이다(fail-open). 여기서 추가하는 것은 **종료 집행** 경로이며, 집행 후 부재 확인이 실패하면 ③이다.
- 확인 실패·미구현 표면(macOS 등)의 활동 종료는 **③ reconciliation-required**(변이 적격 아님).

- ②는 **가디언을 요구하지 않는다** — 엔진이 부팅 마커를 활동 레코드에 기록하면 얻어지는 플랫폼 사실이다.
  compose `init: true` 실재(docker-compose.yml:27,71)로 전제 충족.
- **pid 부재·리스 획득 가능·clean 스냅숏·사용자 승인은 어느 것도 정지 증거가 아니다**(설계 617-619행 유지).
  `kill(-pgid, 0)` 의 사망 판정 사용 **금지**(fail-open 실측).
- **현행 `killTree` 는 win32 전용**(kill-tree.ts:60-63)이며 Linux 에서 트리 소멸을 증명하지 않는다.
  `KILL_GRACE_MS` 만료 정착(detect.ts:145-152)도 **③으로 사상**한다.
- **exec 게이트는 유지**(§W-4 계약 4항) — 봉쇄가 없어도 "CAS 성공 전 CLI 0줄 실행"은 성립한다.
- spawn seam 2개를 계약에 명시: `detect.ts:120`(defaultRunner 팩토리 승격) **및 `mcp/stdio.ts:17`**
  (`createDefaultSpawn(baseEnv, launcher)`). MCP 를 봉쇄 범위 밖으로 두려면 **명시 배제 + ADR 기록**
  (무언의 누락 금지).
- 활동 컨텍스트(리스 키·활동 토큰)는 `RunOpts` 에 싣지 않고 **engine 층 러너 래퍼로 클로저 주입**한다 —
  렌더러 신뢰 경계 밖에서 오는 값에 보안 식별자를 두면 위조 가능(engine.ts:217-222 동형).
- **macOS**: 이 슬라이스에서 활동 시작을 `'platform-unsupported'` 로 거부(첫 부수효과 이전).

### W-17. slug 유도 (한글 주류 경로)

한글 title 은 ASCII-잔여 전략에서 **항상 빈 slug** 를 낸다(`'한글'.normalize('NFKD')` → 자모, ASCII strip 후 `""` — 실측).
사용자 주 언어가 한국어이므로 이는 예외가 아니라 주류 경로다.

```text
ⓐ zero-dep 한글 음역(유니코드 Hangul 분해 산술 + 자모 3표, ~25행 · 신규 의존성 0)
ⓑ NFC 선행 → NFKD + 결합기호 제거(라틴 확장 café→cafe · 전각 ＡＢ１→ab1 · 터키어 İ)
ⓒ 결과가 빈 문자열이면 `wb-<lowercase(ULID)>` 폴백(Crockford Base32 소문자화가 [a-z0-9] 안에서 단사 → 충돌 구조적 불가)
```
- **정규화 순서(NFC 선행)는 계약** — 어기면 macOS NFD 한글이 조용히 소멸한다.
- 설계 §3.1 문안을 "title 에서 유도" → **"title 에서 유도하되 유도 불가 시 id 기반 폴백(둘 다 branch 문법 만족)"** 으로 개정.
- **충돌은 생성이 권위**: 사전 `for-each-ref` 조회는 UX 힌트로만 쓰고, win32/macOS 대소문자 무시 FS
  때문에 조회가 비어도 **생성 실패를 정상 분기**로 처리한다. **단 "생성이 원자적"은 브랜치 중복
  경로(exit 255)에만 성립**하며 디렉터리 선점 경로(exit 128)는 고아 브랜치를 남긴다 — §W-9 의 고아 모델
  참조(초안의 상충 진술 정정).
- **git D/F 충돌 3종**(동명·후손·조상) 중 **조상**(`refs/heads/fleet` 자체가 ref)만 판별자로 해소 불가 →
  부팅 검증에 편입.
- 불변식(유도 출력이 항상 branch 문법 만족)은 **시드 고정 PRNG 퍼징**으로 고정(fast-check 도입 불필요).

### W-18. 파생 상태 · 인가

```ts
export type BenchDerivedKind = 'broken' | 'reconciliation-required' | 'busy'
                             | 'stale-attempt' | 'partially-integrated' | 'integration-ready'
export type BenchAction = 'run' | 'chat' | 'prepare-integration' | 're-prepare' | 'abandon'
                        | 'archive' | 'delete-record' | 'reconcile'
```

**활성 저널 집합의 정의(C6 전파 · 반증 반영)**: **활성 저널 = stage ∈ {`prepared`, `composed`}** 뿐이다.
`published` 는 소비자 완결까지 무기한 열려 있는 **정상 대기**이므로(C6) 활성 집합에 넣지 않는다.
원안은 I11 의 "미종결 저널"을 재정의하지 않아 **18R 이 이 슬라이스의 정상 완료 범위로 확정한
integration-ready bench 가 액션 0개의 막다른 길**이 됐다(`delete-record` = I11 거부 · `reconcile` =
reconciliation 아니라 미인가 · `abandon` = 액션 목록 부재).
- **파생 상태는 절대 영속화하지 않는다**(설계 287-289행). `busy` 는 **표시 전용**이며 인가는 **리스 획득
  시도 결과**로 판정한다(엔진-로컬 파생은 인가 근거가 아니다 — 515-516행).
- **reconciliation 을 2-스코프로 분해**: `BenchReconciliation`(benchId 보유 · 카드 노출) /
  `RepoReconciliation`(benchId 없음 · **레포 배너** · `reconcile-orphan-journal` 액션). 고아 저널에는
  대응 bench 레코드가 없어 상태를 부착할 대상이 없다 — 설계 706행의 스코프 모순 해소.
- **우선순위는 표시 전용.** 인가는 우선순위로 고르지 않고 **성립한 모든 상태의 거부 규칙 합집합**으로
  계산한다. 이 분리가 없으면 `broken`(삭제만 허용) ∧ 미결 저널(레포 차단)에서 무엇을 골라도 오답이 된다.

**핵심 불변식**
| # | 불변식 | 위반 시 |
|---|---|---|
| I1 | `integrated ∧ busy` 도달 불가(프로세스 경계 넘어) | reconciliation 승격 |
| I2 | `broken ∨ reconciliation ⟹ 통합 파생 = 'unknown'`(git 호출 전면 금지) | 프로그래밍 오류(단언 실패) |
| I3 | `busy ⟹ 모든 파괴 액션 거부` | fail-closed |
| **I4** | **`broken ∧ busy` 는 도달 가능** — 이때 설계 357행 "삭제만 허용"은 성립하지 않는다 | **전 액션 거부 + 리스 해제 대기 안내** |
| I6 | `partially-integrated ⟹ lifecycle==='open'` | reconciliation 승격 |
| I8 | `archived ∧ integration-ready` 도달 가능(결과 ref 보존 · "결과 미적용" 명시) | 정상 |
| **I11** | **고아 저널을 새로 만들지 않는다** — **활성 저널**(stage ∈ {`prepared`,`composed`})이 있는 bench 레코드는 제거 불가. `published` 는 활성이 아니므로 **integration-ready bench 의 `delete-record` 는 허용** | `delete-record` 거부(`journal-pending`) |
| **I12** | **`incompatible-version`(지원 범위 초과 schemaVersion) bench 는 `reconciliation-required` 로만 노출하고 `delete-record` 를 포함한 모든 파괴 액션을 거부**(사유 `newer-schema` · 안내 = "더 새 버전의 Fleet 으로 열 것") | 파괴 액션 거부 |

- **`incompatible-version` 을 `invalid` 로 분류하지 않는 이유(반증 반영)**: `invalid` → broken → "삭제만
  허용"이면 **구 버전 표면(업데이트 안 된 데스크톱)이 신 버전 서버가 쓴 권위 레코드를 삭제**하는 것이
  정상 UI 경로가 된다 — Codex 6항이 막으려던 "임의 선택"보다 나쁜 결말이다. 버전 스큐는 5항이 상정한
  Electron/server 공존의 자연스러운 부산물이므로 별도 종별이 필수다. `area.json.schemaVersion` 초과 시에도
  **어떤 락 획득도 시도하지 않고 기능 전체 fail-closed 비활성**(L-4 동형).
- **레포 교착 탈출구(설계 신설 · L-5 준수 3구간)**: `broken ∧ 활성 저널`의 유일 탈출구는
  **`abandon-and-discard`** 이며 **단일 트랜잭션이 아니라 3구간**이다(반증 반영 — 원안은 L-5 를 정면
  위반해, 레포 동결을 푸는 유일한 탈출구가 승인 대기 동안 레포를 최대 30분 동결시켰다):
  ① **락 밖**: 레포 락·리스 **미보유** 상태에서 `gate.request`(risk `'destructive'`, 대상 txnId·resultOid·
  tombstone 대상 명시)로 의도 인가 획득 → ② 레포 변이 락 → bench 리스 획득 → ③ **락 안에서 사전조건
  전량 재검사**(txn 신원·저널 stage·revision·리스 소유) → 통과 시에만 저널 `abandoned` 확인-응답 기록 +
  레코드 tombstone 을 **단일 CAS** 로 확정. 재검사 실패 = 승인을 **소모 없이 폐기**하고 fail-closed.
  **락 안에서는 어떤 승인도 요청하지 않는다.**
- `abandoned` 저널은 삭제하지 않고 감사 보존하되 활성 집합에서 제외해 레포 차단에 기여하지 않게 한다.
- 인가는 **`authorizeBenchAction` 단일 초크포인트**로 두고 IPC/WS 핸들러 옵션의 **비옵셔널** 필드로 주입해
  (선례 `handlers.ts:73-77`) 웹 채널 무가드 경로를 tsc 가 막게 한다.

---

## 2. parity 표면 (동시 갱신 — 누락 = 컴파일/CI fail)

| 파일 | 변경 |
|---|---|
| `src/shared/types.ts` | `Workbench`·`BenchLifecycle`·`BenchDerivedKind`·`BenchAction`·`BenchCardView` · `FleetBridge` bench 메서드 6 · `RunActivity.activeRuns` · `RunProjectRequest.benchId` |
| `src/shared/transport/channels.ts` | bench invoke 채널 6(scope `'both'`) · **push 0** |
| `src/shared/transport/fixtures.ts` | `CHANNEL_FIXTURES` 6 추가 · **`PUSH_FIXTURES` 신설** |
| `src/shared/transport/serialization.test.ts` | push 왕복 검증 확장 |
| `src/main/core/workbench/` **(신설)** | `ulid.ts` · `slug.ts` · `authority.ts` · `journal.ts` · `locks.ts` · `coord-area.ts` · `integration.ts` · `registry.ts` · `derive.ts` · `authorize.ts` · **`bench-workspace.ts`**(태스크 경로 seam 주입) |
| `src/main/core/durable/` **(신설)** | `DurableFs` 구현 + 등급 프로브 (기존 store 무변경) |
| `src/main/core/workspace/git.ts` | `GitRepo` 표면 추가 + `createWorkspace` 에 `taskWorktreeDir` **옵셔널 seam**(미주입 = 현행 바이트 동일) |
| `src/renderer/components/ProjectPanel.tsx` | **라이브 이벤트 핸들러 3분기 + `getRunActivity` 하이드레이션의 benchId 스코프화(R-2)** — 누락 시 CI 가 잡지 못하는 **조용한 회귀** |
| `src/main/core/engine.test.ts` | `getRunActivity` 정확일치 단언 5건(630·652·657·683·688)을 `activeRuns` 필드 추가에 맞춰 마이그레이션 |
| `src/shared/transport/fixtures.ts` **(행 갱신)** | `'fleet:project:activity'` 픽스처(:58)에 `activeRuns: []` 추가. ⚠ **`ChannelFixture.result: unknown`(:11-14) 이라 tsc 가 잡지 못하고, `serialization.test.ts` 도 키 parity + JSON 왕복만 검사해 타입 대조가 0이다** — 이 행만은 "누락 = 컴파일/CI fail" 전제가 성립하지 않는 **무신호 drift 지점**이므로 수동 등재 |
| `src/main/core/process/kill-tree.ts` | `killTree(child, { processGroup?: boolean })` opt-in(미지정 = 현행 바이트 동일). POSIX 트리 사망 집행(§W-16) |
| `ws-bridge-binding.test.ts` · `boot-drain.test.ts` · `api-session.ts` | 채널 6·드레인 판정·세션 cwd 파급 |
| `src/main/core/engine.ts` | `resolveRunRoots` · 가드 스코프화 · `RunActivity` 확장 · bench 레지스트리 주입 · 러너 래퍼 활동 컨텍스트 |
| `src/main/core/cli/detect.ts` | `createCommandRunner({launcher})` 팩토리 승격(무주입=현행 동일) |
| `src/main/core/mcp/stdio.ts` | `createDefaultSpawn(baseEnv, launcher)` |
| `src/main/core/session/types.ts` · `cli-session.ts` | `SendOptions.cwd` 신설 · 대화 분기 분리 |
| `src/main/core/verify/run.ts` | `verify.unavailable` 보고 경로 |
| `src/server/boot.ts` | `FLEET_BENCH_ROOT` 파싱(미설정=비활성+warn / 검증 실패=throw) · 상한 env fail-fast · 코디네이션 영역 준비 |
| `src/server/handlers.ts` | `ChannelMethodMap` 6 + 핸들러 · `authorizeBenchAction` 비옵셔널 주입 |
| `src/renderer/bridge/ws-bridge.ts` · `src/preload/index.ts` · `src/main/index.ts` | bench 메서드 6 배선 |
| `src/renderer/App.tsx` · `components/BenchPanel.tsx`(신설) · `styles.css` | 기본 탭 · 카드 그리드 · 640px 블록 |
| `deploy/docker-compose.yml` · `Dockerfile` · `smoke.sh` | bench 전용 named volume(`/workbenches`) · UID 1000 초기화 · **ttyd 비마운트 canary** · safe.directory 확장 |
| e2e/test | `approval-hold.web.e2e.ts` · `App.test.tsx` · `mobile-responsive.web.e2e.ts` 동반 수정 |

---

## 3. 계약 테스트 (완료 조건 · 2층)

**게이트 열**: `verify` = PR 필수 게이트(vitest) / `nightly` = playwright e2e(dispatch + cron, 여정 스모크).
**계약 단언을 nightly 에 의존시키지 않는다**(e2e 는 PR 게이트가 아니고, vitest 는 `build` 앞이라 `out/` 의존 불가).
⚠ **`nightly(docker)` 는 현재 존재하지 않는 게이트다**(반증 반영) — nightly cron 은 `e2e.yml` 하나이고
playwright(ubuntu, 컨테이너 없음)만 돈다. 해당 행(T55·N2·N3·N4)은 **수동 실행 절차 + 신설 워크플로 잡**을
계획 단계에서 함께 만들어야 하며, 만들지 않으면 **영구 미실행**이다. 이 사실을 표에 명시한다.

| # | 테스트 | 게이트 |
|---|---|---|
| **T1** | ULID 문법·단사 매핑 — 검증 통과한 서로 다른 두 id 가 같은 경로로 정규화되지 않음 | verify |
| **T2** | slug 파이프라인 퍼징 200k — 한글/이모지/공백/전각/터키어 İ/빈 문자열/긴 문자열에서 **항상** branch 문법 만족 | verify |
| **T3** | 복원 검증 lifecycle-인지 — open/integrated=신원 검증 · archived=부재 검증 · 실패 시 broken(자동 정리 0) | verify |
| **T4** | 0단계 검증 실패 레코드가 **어떤 git 호출·경로 probe 에도 전달되지 않음**(fake GitRunner 호출 0 단언) | verify |
| **T5** | 코디네이션 영역 정준화 — 메인/linked/bare/서브모듈/separate-git-dir 5형태에서 동일 영역 해소(실 git) | verify |
| **T6** | `--path-format=absolute` 부재 시 상대 `.git` 오판 회귀 가드 | verify |
| **T8** | **락 자동 해제 — 순수 JS `node -e` 자식이 락 보유 → SIGKILL → 즉시 재획득 성공.** `wx`/mkdir 구현이면 반드시 RED | verify |
| **T7** | **커널 endpoint 는 삭제 대상이 아님** — 영역 디렉터리에 소켓 파일이 **0개**이고(`s/` 부재), 파일시스템 어디를 지워도 보유 중인 락이 영향받지 않음. 파일시스템 소켓 구현이면 RED | verify |
| **T10** | **회수 = 커널 배타성 단독** — 소유자 SIGKILL 후 `listen` 성공 → 즉시 획득. **연령·pid·사용자 승인 어느 것도 근거로 쓰지 않음**(주입 계층 호출 단언). 락 소유 권위 레코드가 존재하지 않음을 구조 단언으로 함께 고정 | verify |
| **T8b** | **인스턴스 배타(`wx` 점유)** — 두 프로세스가 `open(active-instance.json,'wx')` 를 배리어로 동시 실행 → **정확히 한쪽만 성공** · 패자는 `AreaOpenResult{disabled,'instance-active'}` 로 **`listen()` 호출 0 · git/WAL 변이 0건**. 별개 net ns 컨테이너 2개로도 동일(실측 근거: 400개 동시 경쟁 생성에서 double-create 0) | verify + nightly(docker) |
| **T8c** | **잔재 회수** — ⓐ`instanceMarker` 일치 + endpoint EADDRINUSE → `instance-active`(대기) ⓑ마커 일치 + `listen` 성공 → 회수 ⓒ**마커 불일치 → 회수**(이전 PID ns 소멸 확정 — `wx` 가 동시 기동을 배제했으므로 안전) ⓓ정상 종료 시 파일 제거 확인. **`held` 잔존으로 영구 고착되는 경로가 존재하지 않음**을 함께 단언 | verify |
| **T8d** | **배포 계약 집행** — `deploy/docker-compose.yml` 의 `fleet` 서비스에 `container_name` 키 존재 · `deploy/smoke.sh` 의 기존 compose 불변식 검사 블록(fleet 서비스 블록 추출 canary·마운트 경계·포트 비공개·drain)에 동일 위치로 단언 추가. **문면이 아니라 파일로 집행됨**을 고정(실측상 `--scale fleet=3` 이 경고 없이 성공했었다) | verify |
| **T8e** | **행동 테스트(Codex 승인 조건 ④)** — 키 **존재 여부만이 아니라** `docker compose --scale fleet=2` 가 **실제로 거부되는지**를 단언. 존재 단언만 두면 compose 버전·구성 변화로 거부가 사라져도 무신호다 | nightly(docker) |
| **T8f** | **서버 전용 범위 일관성(조건 ⑥)** — Electron 표면이 `FLEET_WORKBENCH=1` 만으로 **우회 활성화되지 않음**. 데스크톱 경로에서 Workbench 초기화 진입점이 구조적으로 부재함을 단언(구현·문서·킬스위치 3면 일관) | verify |
| **T10d** | **`key==='r'` 이중 소유 불가(결정론 · 실 fork)** — A 가 `r` 보유 중 B 가 획득 시도 → **EADDRINUSE = `held`** 로 차단되고 B 가 변이 구간에 **진입하지 못함**. A 가 살아있는 동안 **어떤 파일시스템 조작으로도** B 가 획득에 성공할 수 없음을 함께 단언(추상 소켓 전환의 핵심 성질 — pathname 기반 구현이면 RED) | verify |
| **T11** | 락 서열 — 역순 획득 시도가 코드 경로에 존재하지 않음(구조 단언) + 데드락 부재 | verify |
| **T12** | **L-5: `gate.request` 는 어떤 `AdvisoryLockHandle` 도 미보유인 상태에서만 발생**(락 보유 구간 진입/이탈을 계측하는 더블로 카운트 0 단언). **표본에 `abandon-and-discard` 와 삭제-보관 두 경로를 반드시 포함**(원안은 이 두 경로가 규칙을 위반해 T12 가 자체 RED 였다 — 반증 반영) | verify |
| **T12b** | 락 안 사전조건 재검사 실패 시 **승인이 소모되지 않음**(재요청 가능) · 집행 0 | verify |
| **T13** | **revision-CAS(계약 1·6항 · 행동 단언으로 재정의)** — "병합/LWW **코드 부재**"는 관찰 불가능한 서술이므로(T14 는 같은 이유로 이미 재작성됨) 3개 행동 단언으로 대체: ⓐ두 상충 draft 를 순차 CAS 하면 두 번째가 **항상** `revision-mismatch` ⓑ커밋 후 디스크 레코드가 첫 draft 의 필드를 **하나도** 포함하지 않음 ⓒ`revision` 이 호출자 draft 에서 오지 않음(`Omit` 타입 핀) | verify |
| **T14** | **fresh read 강제(계약 2항 · 재작성)** — 주입 `DurableFs.readFileUtf8` 호출 카운터로 `readFresh` 1회당 대상 경로 읽기가 **정확히 1회** 발생함을 단언 · 리스 해제→재획득 사이에 외부에서 디스크 파일을 교체하면 다음 `readFresh` 가 **반드시** 새 revision 을 반환(캐시 구현이면 RED) · 같은 `FreshReadToken` 재사용 시 `read-token-spent`. ("캐시 필드 부재"는 관찰 불가라 단언 대상이 아니다 — 반증 반영) | verify |
| **T15** | **내구 순서 — `DurableFs` fake 로 단계 시퀀스 단언(fsync-file → rename → [posix] fsync-dir)**(계약 3항). `DurableFs` 는 동기 프리미티브지만 **CAS 는 async** 이므로, 시퀀스 단언은 `withAuthority` 완료 후의 전체 타임라인을 대상으로 한다 | verify |
| **T16** | **단계별 실패 주입 — `fsync-file`/`rename`/`fsync-dir` 각각 throw 시 `io-failure{step}` 반환 · lifecycle 무변 · CLI 미실행**(계약 4항) | verify |
| **T17** | **rename EPERM 재시도 — 열린 핸들 하에서 유한 재시도 후 `io-failure`, 게이트는 닫힌 채 유지**(C4). **PR2c 정정 ⓗ**: 소진 시 `countOf('rename') === 5` **exact**(초기 1 + 재시도 4) · 재시도 **비대상** 코드(ENOENT·EISDIR·`code` 부재)는 `=== 1` · rename 아닌 단계 실패 시 그 단계 `=== 1`(재시도 범위 falsifier — 없으면 「쓰기 전체를 감싸 재시도」 구현이 통과한다) | verify(win32 실측 고정) |
| **T17b** | **재시도 끝에 성공** — 첫 3회 `EPERM`, 4회차 성공 → **정확히 1회 commit** · `AuthorityCommit` 1개 · 디스크 revision +1(초안은 "실패"만 고정해 성공 경로가 열려 있었다 — Codex P1-6). **PR2c 정정**: 「commit 1개」의 관측면은 **디스크 revision(+1) + `countOf('openExclusive')`(=1)** 이다 — 후자가 「재시도가 쓰기 전체를 되감지 않았다」의 직접 증거다. ⚠ 원장(`MINTED_COMMITS`)은 **`WeakSet` 이라 크기를 셀 수 없다**(CodeRabbit) — 착지물과 다른 관측면을 적어 두면 그 자체가 「선언만 하고 실재하지 않는 핀」이 된다 | verify |
| **T17c** | **재시도 중 리스 탈취** — 재시도 사이에 리스를 삭제/탈취 → **이후 rename 이 실행되지 않고** `lease-invalid{stolen}` (L-6 per-retry 재검증) | verify |
| **T17g** | **백오프 스케줄(신설 · PR2c 정정 ⓗ)** — 주입 `sleep` 이 기록한 지연 배열이 `[10,20,40,80]` 과 **정확히 일치**한다. 이 행이 없으면 백오프 0ms·순서 역전·고정값 구현이 T17·T17b·T17c 를 **전부 GREEN** 으로 통과하고 C4 의 존재 이유(상대 핸들이 닫히기를 기다리는 시간 창)가 미검증 출하된다 | verify |
| **T17d** | **same-process 인터리브** — 같은 bench 에 대한 두 `withAuthority` 호출을 배리어로 겹쳐도 **stale draft 가 commit 되지 않음**(뮤텍스 부재 구현이면 RED) | verify |
| **T17e** | **rename 성공 후 `fsync-dir` 실패** → 디스크 revision 은 전진하되 `commit-uncertain` 반환 · `AuthorityCommit` 미발급 · **CLI 미실행**(⚠ 런처 소비자 부재로 **PR2c 에서 vacuous** — 정직 표기) · 재시작 복구가 `execGate:'gated'` 를 **gated-orphan 으로 분류**해 회수(=`running` 은 회수 대상 아님). **PR2c 정정 ⓖ**: 회수분의 조작화는 **순수 함수 2개**로 재정의한다 — `classifyStaleActivity` 의 `it.each` 전수표(gated→`gated-orphan` · running→`live-activity` · 부재→`none`) + 「running 입력에 `gated-orphan` 을 답하면 RED」 음성 통제 + `reclaimDraft` 의 「`activeActivity` 만 소멸 · 나머지 전 필드 바이트 동일 생존」 1행. **회수 CAS 호출부는 PR7 T30b** | verify |
| **T17f** | **순서 보장** — `AuthorityCommit` 발급·CLI spawn 이 **최종 acknowledged durability 보다 먼저 발생하지 않음**(DurableFs 단계 타임라인과 launcher 호출 순서 대조). ⚠ **PR7 T30b 이월**(PR2c 정정) — 이 순서를 만드는 것은 CAS1→CAS2→spawn **시퀀서**이고 PR2c 는 소비자 0 을 유지하므로, 여기서 쓰면 「프로덕션이 순서를 지키는가」가 아니라 「테스트가 순서대로 배열했는가」를 증명한다 | verify(PR7) |
| **T16b** | **type-level(`@ts-expect-error`)** — `AuthorityCommit` 인자 없는 bench launcher 호출이 tsc 에러임을 고정(계약 4항의 1차 방어) | verify |
| **T16c** | `no-restricted-syntax` bench-spawn 가드가 eslint flat config 에 `'error'` 로 존재함을 **config 객체 단언**으로 핀(`eslint-config-purity.test.ts` 동형) | verify |
| **T18** | 내구 등급 — win32 `'file-only'` 가 레코드에 기록되고 조용히 스킵되지 않음(U4) | verify |
| **T18b** | **file-only 롤백 시뮬레이션** — 권위 파일을 이전 세대 바이트로 되돌린 뒤 재부팅 → **ref-앵커 재조정**이 reconciliation 을 강제하고 되돌아간 revision 위에 새 CAS 가 커밋되지 않음(C3 파급) | verify |
| **T19** | **크로스 프로세스 stale-cache(계약 5항 · 재작성)** — **같은 표면의 두 엔진 인스턴스**(재시작 전후·컨테이너 교체·데스크톱 다중 창 — §W-2-b 로 두 표면 동시는 배제됐으므로 시나리오를 이렇게 고정). 두 인스턴스는 **`vi.resetModules()` + 동적 `import()` 2회로 모듈 인스턴스를 격리**하고 각자 별도 `DurableFs` 를 주입한다(모듈 상태 공유 금지가 테스트 셋업 계약). 원안의 단순 in-process 2인스턴스는 **같은 ESM 모듈을 공유**하므로 — 스펙 자신이 `readSeq`·commit WeakSet 을 "모듈 내부"로 규정하므로 이는 가정이 아니라 확정 — `Map<path,record>` 모듈 캐시 구현이 **GREEN 통과**하고 실제 2프로세스 배포에서만 RED 가 된다. 인스턴스1 이 T1 무효화·G2 기록 후 리스 해제 → 인스턴스2 가 낡은 T1/G1 투영으로 리스 획득 → 공유 권위 G2 fresh read 로 `integrated` **거부**. **negative control 2중**: ⓐ전이 직전 `projection.currentIntegrationTxnId===T1 ∧ sourceGeneration===G1` ⓑ**모듈 격리 자기검사** — 인스턴스 A 의 모듈 스코프 카운터가 B 에서 초기값임을 단언(격리가 깨지면 이 행이 먼저 RED) | verify |
| **T20** | stale 전체 스냅숏 순차 기록이 최신 세대를 되돌리지 못함(revision-CAS) | verify |
| **T21** | **마이그레이션 충돌(계약 6항)** — 두 표면이 같은 bench 에 상충 권위 필드를 만든 상태에서 자동 병합·LWW 없이 `reconciliation-required`. **"기존 로컬 레코드 없음" 전제의 근거 = `StoreState` 무변경(T53)** — 이 근거를 계약 문면에 명시해 6항 미충족 재지적을 차단한다 | verify |
| **T21c** | **버전 스큐(I12)** — 지원 범위 초과 `schemaVersion` 레코드 → `incompatible-version` 분류 · `delete-record` 거부 · git 호출 0 · area 락 획득 시도 0(구 버전이 신 버전 권위를 삭제하면 RED) | verify |
| **T22** | 실 fork 2 프로세스 + 파일 배리어 — 리스 배타성이 in-process Map 뮤텍스로는 통과 불가함을 증명 | verify |
| **T23** | **ref D/F — `<benchId>` bare ref 선점 시 통합 준비가 fail-closed 거부하고 어떤 ref 도 삭제하지 않음 · `<benchId>/<txn>` 2세대 생성 성공**(C1). **PR3a 정정**: loose 축만 두면 **git 의 네이티브 거부에 얹혀가는 구현**이 통과한다 — win32 는 packed 상태에서 D/F 를 막지 못하므로(플랫폼 축) ⓐ`pack-refs --all` 을 끼운 실 git 축(win32 에서만 공존 도달 · 그 외 OS 는 거부를 확인하고 종료)과 ⓑ**주입 러너 쌍둥이**(열거는 답하는데 원시 해소는 부재 — 양 OS·전 버전에서 실행)를 **함께** 둔다. 단일 ref 재조회가 **exact** 임도 함께 고정(접두 매칭이면 「자식이 있으니 부모도 있다」로 오답) | verify(실 git + 주입) |
| **T24** | 정확 old-OID CAS — 조상 이동(ff 가능)에도 CAS 거부(ff-only 를 발행에 쓰지 않음 · 15R). **PR3a 정정**: 거부만 단언하면 **무조건 거부 구현**이 통과하므로 **양성 대조**를 짝으로 둔다 — ⓐ정확 일치 시 성공 + ref 가 실제로 이동 ⓑcreate-if-absent 성공 후 재시도는 `rejected{actual}`. 또한 **존재하지 않는 객체로의 발행**(외부 `gc --prune=now` 경합)이 값으로 실패하고 ref 가 생기지 않음 | verify(실 git) |
| **T25** | `merge-tree --write-tree` 충돌이 **값으로 보고**되고 git 상태 변이 0 · sequencer 파일 부재. **PR3a 정정 — 음성 통제 필수**: 충돌과 **인자 오류(비커밋 인자·없는 rev)가 같은 exit 1** 이므로(4면 실측) 그 둘이 **다른 종별로 분류됨**을 함께 단언한다. 없으면 「종료코드로 충돌 판정」 구현이 전 행을 통과한다 | verify(실 git) |
| **T26** | git 능력 프로브 — `merge-tree --write-tree` 미지원 시 통합 기능만 fail-closed 비활성(폴백 경로 부재). **PR3a 정정**: 배포·CI git 이 전부 ≥2.38 이라 실 git 만으로는 미지원 분기가 **영구 미실행**이다 → **주입 러너로 pre-2.38 응답**(`exit 128 · fatal: unknown rev --write-tree`)을 재현하고, 비활성 후 **추가 git 호출 0**을 함께 단언한다. exit 0 이어도 첫 줄이 OID 가 아니면 미지원(구형 git 의 옵션 에코 방어) | verify(주입) |
| **T27** | 결과=2-parent 커밋 → 소비자 `merge --ff-only` 성립 · bench 전체 스냅숏 포함(증분 아님 — R1 건너뛰고 R2 만 적용해도 무손실) | verify(실 git) |
| **T28** | 완결 관측 레이스 — base=R 후 새 커밋 N 을 얹어도 **R 조상 도달성**으로 완결 · 강제 이동으로 도달 불가면 완결 **안 함** | verify(실 git) |
| **T29** | 다중 시도 **형제 그래프** — R1 만 머지 → `partially-integrated` · T2 ff 불가 감지 → 명령 노출 중단 → `stale-attempt` → 재준비 T3 후에만 완결, 완결은 **T3 귀속** | verify(실 git) |
| **T30** | 다중 시도 **조상 그래프** — R1 적용 후 T2 준비 → 정상 ff → 완결이 정확히 T2 귀속 · 저널 순회 순서 무관 | verify(실 git) |
| **T31** | 활동-무효화 원자성 — exec 게이트 직전 정지 후 R1 소비자 머지와 완료 관측 동시 실행 → ⓐ또는ⓑ **하나만** 성립 · 무효화 저장 실패 시 **CLI 0줄 실행** | verify |
| **T32** | WAL 복구 판정 순수 함수 — `prepared`/`composed` × ref 유무 6조합 + `REF_NAMESPACE_CONFLICT` 최우선 | verify |
| **T33** | **`published` 저널은 차단하지 않는다**(C6) — integration-ready bench 가 실행·통합 가능, **그리고 `delete-record`·`abandon` 도 허용**(활성 저널 집합 = `prepared`·`composed` 뿐) | verify |
| **T34** | **ref-앵커 재조정** — 권위 레코드의 어느 txnId 에도 귀속되지 않는 결과 ref 가 존재하면 reconciliation(win32 4번째 분기 · C3). 앵커를 권위 파일 안에 두면 롤백 시 함께 되돌아가 발화하지 않으므로 **git ref 열거가 판정식**임을 고정 | verify(실 git) |
| **T35** | 포기 — git 변이 0 · 결과 ref/keep 커밋 보존 · `lifecycle` 무변 · `reachable-from-base` 거부 | verify(실 git) |
| **T36** | 생성 고아 — 디렉터리 선점으로 `worktree add -b` 실패 시 브랜치 잔존을 **결정론적으로 재현**하고 R1~R4 되감기 허용 · 크래시 경로는 R1 미충족으로 자동 삭제 차단 | verify(실 git) |
| **T37** | 상태×액션 인가 표 **전수 테이블 테스트**(표 자체가 단일 권위). ⚠ 완료 조건의 "엔진 거부 집합 == **UI 액션 여집합**"은 §7 범위 분리(UI = #253)와 충돌하므로 **UI 여집합 일치는 #253 완료 조건으로 이관**한다 | verify |
| **T61** | **조건부 스키마 불변식 1~9 전수 테이블 테스트**(신설) — §W-4 가 9개 불변식을 명시했으나 §3 에 대응 행이 없어 구현 재량으로 누락돼도 **무신호**였다 | verify |
| **T62** | **L-2 · D-9 · benchRoot env fail-fast**(신설) — 셋 다 §3 행 부재였다. L-2: `tryAcquire` 가 동일 tick 내 반환(논블로킹)·미지 errno → `unavailable` / D-9: 권위·저널 경로에 `createReadStream`·`watch`·장기 fd 부재(매칭 대상 파일 수 > 0 선단언) / env: 운영자 오설정 throw · 미설정 비활성+warn | verify |
| **T63** | **통합 WAL 순서 단언(신설 · T17f 등가물)** — `composed`(resultOid 선기록)가 `casUpdateRef` **보다 먼저 acknowledged** 되었음을 강제한다. 이 행이 없으면 구현이 ref 를 먼저 만들고 저널을 나중에 써도 전부 GREEN 이 되어 C7 의 "추론 0" 논증이 무너진다 | verify(실 git) |
| **T64** | **저널 배치·tmp 문법(신설 · PR3b)** — 엔트리는 정확히 `<journalDir>/<benchId>/<txnId>.json` 에만 생기고 tmp 는 **대상과 같은 디렉터리**의 `<txnId>.json.<ownerToken>.tmp` 다. 쓰기 전후 **전 경로 스냅숏 diff** 로 「`<benchId>` 디렉터리 밖에 생긴 파일 0」을 단언한다(flat 배치·별도 `tmp/` 구현이 RED) · 성공 후 tmp 부재 · 실패 경로에서도 **자기 tmp 만** 제거 · `benchId`/`txnId` 가 ULID 문법이 아니면 경로를 만들기 전에 거부(경로 성분 주입 차단) | verify |
| **T65** | **저널 열거 7종 검증(신설 · PR3b)** — ⓐ`.json` **정확** 접미(`.json.<token>.tmp` 잔재·`x.jsonx` 거부) ⓑbasename ULID 문법 ⓒ내부 `txnId` == basename ⓓ`benchId` == 상위 디렉터리 ⓔ`schemaVersion` 최우선 ⓕ**regular file 만**(비정규 노드는 **읽기 전** 거부 — FIFO `readFileSync` 무기한 블록 차단) ⓖtmp 접미는 저널로 읽지 않음. 필터 없는 구현은 `.tmp` 잔재를 `txnId="<…>.json.<token>"` 로 오독해 RED | verify |
| **T66** | **WAL 전이 술어 전수표(신설 · PR3b)** — 초기 진입(엔트리 부재) 5값 + 기존 stage 5 × 목표 stage 5 **전수**. 합법은 부재→`prepared` · `prepared→composed→published→finalized` · 임의 단계→`abandoned` 뿐이고 나머지는 거부. **양성·음성 대조 동반**이라 「무조건 허용」·「무조건 거부」 두 뮤턴트가 **모두** RED 다(역행 `published→prepared` · 부활 `abandoned→composed` · 자기 전이 `composed→composed`) | verify |
| **T67** | **저널 버전 스큐(신설 · PR3b · T21c 의 저널 판)** — 지원 범위 초과 `schemaVersion` 엔트리는 `incompatible-version` 으로 분류하고 **덮어쓰지 않는다**(쓰기 0 · unlink 0). 픽스처는 「초과 버전 **∧** 다른 필드 형태 위반」이라 문법을 먼저 보는 구현은 `invalid` 를 답해 RED — 구 버전이 신 버전 저널을 지우는 I12 의 저널 표면 | verify |
| **T68** | **저널 rename 유한 재시도(신설 · PR3b · C4 상속)** — `EPERM` 3연속 후 4회차 성공 = 성공이고 **exact 호출 계수**(rename 4 · sleep 3 · 인자 `[10,20,40]` 순서)를 고정한다 · 백오프 소진(5회 실패)은 `io-failure{step:'rename'}` + 디스크 무변이 · **비대상 errno(`ENOENT`)와 `code` 부재 Error 는 재시도 0**(즉시 실패). 권위 store 전용이던 §3-T17·T17g 가 저널을 덮지 않아 신설한다 | verify |
| **T69** | **저널 쓰기 크레덴셜 강제(신설 · PR3b)** — `append` 는 `AuthorityCommit`(직전 단계 CAS 성공 증거) 또는 **첫 단계 한정** `FreshReadToken` 없이는 **타입 수준에서 호출 불가**(`@ts-expect-error` 로 고정) · 첫 단계가 아닌데 `FreshReadToken` 이면 런타임 거부 · `expectedAuthorityRevision !== prev.revision` 이면 거부. ⚠ **행동 단언(abort-on-CAS-failure)의 생산자는 PR5 T18** 이라 이 PR 에서 그 축은 vacuous 다 | verify |
| **T70** | **저널 쓰기는 bench 리스 아래에서만(신설 · PR3b)** — 비민팅(복제) 리스면 파일시스템 **무접촉**(쓰기 0) · 리스 identity ↔ 레코드 3필드 대조 실패 시 거부 · tmp 이름의 `<ownerToken>` 은 **리스에서만** 취한다(문자열 인자 부재 = 위조 불가) · rename **회차마다** `revalidate()` 를 다시 보므로 「1회차 실패 → 그 사이 탈취 → 2회차 성공」 구현이 RED(L-6 동형). PR3d 수확기의 배타원이 이 계약 위에 선다 | verify |
| **T71** | **저널 레코드 불변 필드·조건부 결속(신설 · PR3b)** — 단계 전진에서 불변 12필드(`txnId`·`benchId`·`repoCommonGitDir`·`benchRoot`·`sourceBranch`·`sourceSnapshot`·`sourceGeneration`·`targetBranch`·`targetHeadBeforeIntegration`·`resultRef`·`startedAt`·`ownerEngineId`) 중 하나라도 바뀌면 거부(「전이는 합법인데 내용이 통째로 바뀐」 레코드 차단) · `stage ≥ composed` → `resultOid`·`resultTree` 필수 · `published` → `publishedAt` 필수 · `abandoned` → `abandonedAt`·`abandonReason` 필수 ∧ `nextAuthorityStage` **부재**(포기 CAS 는 통합 필드를 소거한다) · 그 외 stage 는 `stage === nextAuthorityStage` | verify |
| **T72** | **생성 저널 3채널 판정 규칙(신설 · PR4 T16)** — {①저널 엔트리 ②worktree 디렉터리 ③git 브랜치} **8조합 전수**를 {없음·부분·완전}으로 사상하는 **순수 술어** + 그 판정을 소비하는 생성 트랜잭션의 행동 단언. 생성은 통합의 `prepared` 규칙을 상속하지 않으므로 「없음」은 reconciliation 없이 종결 가능해야 한다. ⚠ **귀속이 PR3b → PR4 로 바뀌었다**(계획 정정 182): 규칙만 먼저 착지시키면 「판정 함수가 자기 입력의 생산자보다 먼저 서는」 배치가 되어 정정 159 가 방금 제거한 안티패턴을 되살린다. 대상 레코드도 통합 WAL 이 아니라 **생성 저널**이라 PR3b 모듈의 계약이 아니다 | verify |
| **T38** | **I4: `broken ∧ busy` → 전 액션 거부**(크로스 프로세스 리스 보유) | verify |
| **T39** | **I11 분리** — `prepared`/`composed` 잔존 bench 만 `delete-record` 거부(`journal-pending`) · **integration-ready(`published`) bench 는 허용** · `broken ∧ 활성 저널`은 `abandon-and-discard` 3구간으로만 탈출(락 밖 승인 → 락 안 재검사 → 단일 CAS) | verify |
| **T39b** | bench 런 진행 중 **레거시 ProjectPanel 의 running 잠금·자동 선택이 발생하지 않음**(라이브 이벤트 + 하이드레이션 두 경로 · R-2) | verify |
| **T39c** | **POSIX 트리 사망 증거** — CLI 가 손자를 남기고 정상 exit → 다음 프로세스의 변이 적격 판정이 **③**(현행 killTree 가 win32 전용인 한 반드시 RED) | verify(posix) |
| **T40** | 드레인 권위 — bench hang 런이 `activeProjectIds` 에 나타나고 SIGTERM 드레인이 **기다린다**(R-1) | verify + nightly canary |
| **T41** | 런 루트 3값 동일 파생 — bench 런의 verify 명령 cwd === bench.path(R-3) | verify |
| **T42** | **`verify.unavailable`(U2 · 반증 조건 신설)** — 원안("verify-fix/replan 미진입")만으로는 **vacuous-GREEN** 이다: engine 이 bench 런에 verify 를 아예 주입하지 않는 구현이면 그 경로가 애초에 없어 "미진입"이 구현과 무관하게 항진한다. 반증 조건 3항 필수 — ⓐ`verify.unavailable` 이벤트가 **1건 발생**(양성 단언) ⓑ최종 status ≠ failed ⓒ**node_modules 존재 시 verify 가 bench cwd 로 실제 실행**(T41 과 짝) | verify |
| **T43** | bench 대화 statefulness — `SendOptions.cwd` 경로가 편집 모드로 분기하지 않음 · 워크스페이스 읽기 도구가 bench 스코프(U3 누출 차단) | verify |
| **T44** | 중첩 worktree 배치 — 태스크 worktree 가 `<benchRoot>/.fleet-wt-<benchId>/` 안 · bench 내부 배치 금지 근거(gitlink 오염·clean 파괴) 고정 · 교차 bench 삭제 불가 | verify(실 git) |
| **T45** | 격리 계약 — bench A 런이 `<benchRoot>/.fleet-wt-<A>/` 밖 어떤 경로도 생성/삭제하지 않음(benchRoot 전수 스냅숏 diff) | verify |
| **T46** | 슬롯 리스 상한 — 두 인스턴스 합산으로 `WORKBENCH_MAX_ACTIVE` 초과 불가(엔진-로컬 카운터면 RED) | verify |
| **T47** | env fail-fast vs clamp 분리 — 운영자 env 오설정 throw / 렌더러 값 clamp | verify |
| **T48** | 채널 parity — invoke 7면 · **push 5면(서버 broadcast 배선 스크레이핑 신설)** · `PUSH_FIXTURES` 왕복 | verify |
| **T49** | 커서 무회귀 — `pushChannels()` 집합 불변 · bench 이벤트가 기존 채널로 방출되어 `hasEventGap` 오탐 0 | verify |
| **T50** | 기본 탭 = '작업' 단언 + 동반 수정 3건 무회귀 | verify |
| **T51** | `[data-bench-badge]` 1개 · `[data-bench-chip]` == 차단 사유 수 | verify |
| **T52** | 640px 셸 블록 셀렉터 결합 핀(#221 규약 5규칙) | verify |
| **T53** | `StoreState` 키 집합 불변(권위 상태가 기존 store 에 새지 않음) | verify |
| **T54** | 코디네이션 영역 git 내성 — `gc`·`repack`·`prune`·`clean -xffd`·`worktree prune`·`fsck` 후 전량 생존 | verify(실 git) |
| **T56** | **L-4** — `area.json.lockBackend` 불일치(win32 데스크톱 ↔ linux 컨테이너가 같은 레포) 시 **어떤 획득도 시도하지 않고** fail-closed | verify |
| **T57** | **R-4** — 레거시 런 활성 중 bench 통합 거부 · 통합 트랜잭션 중 레거시 런 시작 거부(설계 §3.2.1-7) | verify |
| **T58** | **R-5(검증 수단 재-재정의 · PR3a 실측)** — 원안의 "주입 fs 스파이"는 구현 불가능(`git.ts` 가 `rmSync` 를 정적 바인딩 · fs mock 금지)이었고, 그 대체안(「실 `index.lock` 을 만들고 공통 gitdir 변이 연산을 **실패시킨다**」)도 **실측으로 구성 불가능**이다 — 4면 전부 `worktree add`·`update-ref`·`merge-tree` 가 index.lock 아래에서 **exit 0** 이라 실패가 발생하지 않는다. **성립하는 조작화**: 대상 ref 의 `.lock` 을 선점해 `update-ref` 를 128(`Another git process…` = 레거시 `LOCK_RE` 매칭)로 떨어뜨리고, **무관한 `index.lock` 을 함께 둔 뒤** ⓐ그 파일이 **보존**되고 ⓑ경합 `.lock` 도 삭제되지 않으며 ⓒ재시도가 **유계**임을 단언한다. 백오프 스케줄은 **주입 sleep + 리터럴**로 고정(상수와만 대조하면 「상수를 비움」 뮤턴트가 함께 통과한다). 구조 근거 = `createGitRepo` 본문에 `ok(`·`rmSync`·`existsSync` 0건(자기검사 앵커 동반) | verify(실 git + 주입) |
| **T58b** | **레거시 무변경 증명(PR3a 실측으로 성격 반전)** — 원문은 「R-5 전환이 레거시 #80 worktree 생성의 **성공률을 바꾼다**」였으나 실측이 반증했다: 레거시가 실제로 쓰는 `worktree add --detach`(`git.ts:304`)·`worktree remove --force`(`:346`)는 **5종 락 선점**(index·packed-refs·HEAD·refs/heads·worktree admin) 전부에서 **exit 0** 이라 `ok()` 의 재시도·삭제 분기가 **도달 불가**다. 따라서 R-5 는 **신규 연산 한정**이고 레거시는 무변경이며, 이 행은 그 **무변경을 고정하는 회귀 핀**이다(`createWorkspace` 가 `ok()` 를 계속 쓴다는 구조 단언). `ok()` 의 삭제가 실제로 도는 곳은 **인덱스 경로**(`ensureRepo`·`collectDiff`·`keep`·`revert`)이며 그 위험은 이 슬라이스 밖에 남는다(정직 표기) | verify |
| **T59** | **실 `DurableFs` 어댑터를 실 파일시스템에 대고 검증**(페이크 위에서만 서는 계약 3항의 공백 보완) — tmp 고유성·rename 후 tmp 부재·0600/0700 · POSIX dir fsync 성공 / win32 `'file-only'` 등급 반환 | verify |
| **T60** | **T8 보강** — SIGKILL 재획득만으로는 pid-생존판정 lockfile 구현도 통과한다. 따라서 **① 프로토콜이 `connect` 이외의 생존 판정을 쓰지 않음**(주입 계층 호출 단언)과 **② pid 재사용 시나리오**(기록 pid 를 살아있는 무관 프로세스 pid 로 치환 → 획득이 `held` 로 오판되지 않음)를 함께 단언 | verify |
| **T55** | 컨테이너 인스턴스 마커 — `boot_id` 단독 사용 금지 회귀(재시작 후 동일값이면 RED) | nightly(docker) |
| **N1** | 여정 스모크: 카드 생성→런→변경 확인→**통합 준비(integration-ready)**→소비자 `merge --ff-only`→`integrated` 관측→보관. **Fleet 액션 단독으로는 integration-ready 까지만 도달함을 단언**(18R 2단 약속) | nightly |
| **N2** | 기본 배포 상태 통합 — base 가 `/workspace` 체크아웃인 채 ttyd 에서 무관한 변경을 stage → **Fleet 이 baseRef 에 `update-ref` 를 일절 실행하지 않고** base·HEAD·index·worktree 무변 | nightly(docker) |
| **N3** | 외부 작성자 경합 — 통합 중 ttyd 에서 대상 브랜치 전진 → 정확 CAS 발행 또는 fail-closed(비소유 git 상태 무정리) | nightly(docker) |
| **N4** | 배포 수명주기 — bench 생성 → 볼륨 보존 컨테이너 교체 → 동일 worktree·브랜치 복원 → 런/보관 성공 | nightly(docker) |
| **N5** | 라이브: 실 터널+폰에서 카드 그리드·bench 런 승인·**통합 준비까지 폰 완결** | 라이브 1회 |

**verify 7게이트 GREEN** + 커버리지 floor 유지.

### 3.1 커버리지 예산 — 정정 (판사 A 공통 결함 ①②)

초안의 "신규 export 함수 수 예산"은 **메트릭 자체가 아니다**(함수 1회 호출로 함수 커버는 100%, 그 안의
fail-closed 분기 8개는 0%). 실측 정정:

- **구속 메트릭은 브랜치도 함수도 아닌 `statements`** — 실측 L94.9/S93.25/F92.86/B86.05, floor
  L92/S91/F90/B83 ⇒ 여유는 **S 2.25 < L 2.9 < F 2.86 < B 3.05pt**.
- **분모 이동을 계산해야 한다** — 기존 코어 9,965행(48파일) + 신규 src 3,400~4,500 = **+34~45%**.
  이 가중치에서 **신규 코드가 자체적으로 충족해야 하는 비율 = stmt ≥85.4%**(lines ≥84.8 · funcs ≥82.9 ·
  branches ≥75.4).
- ⚠ **플랫폼 비대칭이 그 여유를 통째로 먹는다**: `ci.yml` 의 quality(ubuntu) 잡만 `test:coverage` 를
  돌리고 windows-tests 는 `npm test`(커버리지 없음)다. 이 슬라이스는 **win32 전용 코드**(npipe 백엔드 ·
  `'file-only'` 강등 · rename EPERM 재시도)를 대량 추가하는데 그 행들은 **분모에는 들어가고 분자에는
  들어가지 않는다** — 보수적으로 150~250행만 잡아도 statements **1.1~1.8pt** 소진 = 여유 2.25pt 의 대부분.
- ⚠ 대칭으로 **POSIX 전용 테스트**(T7·T9·T10·T10b·T39c)는 개발자 로컬(win32) `verify` 에서 skip 되어
  **로컬 GREEN 과 CI GREEN 이 서로 다른 것을 증명**한다 — 이 레포가 명문화한 "로컬 == CI" 원칙이 이
  슬라이스에서 처음 깨지고, `vitest.config.ts` 의 "플랫폼 분기는 상쇄돼 영향 미미" 주석이 거짓이 된다.
- **필수 대응(택1을 계획이 확정)**: ⓐ백엔드를 주입 seam 뒤에 두고 **양 백엔드 계약 테스트를 양 OS 에서
  페이크로** 돌린 뒤 실 어댑터만 플랫폼 게이트 / ⓑ신규 플랫폼 전용 파일을 `coverage.exclude` +
  별도 windows 커버리지 잡. 어느 쪽이든 **PR 마다 4메트릭 실측치를 PR 본문에 기록**하고,
  신규 모듈 **자체 statements ≥86%** 를 태스크 완료 조건으로 둔다.
- 실 git·실 fork 헬퍼는 `__testing__/` 에 두고 `coverage.exclude` 에 등재 + **그 exclude 를 config 객체
  단언으로 핀**(`all: true` + `include: src/main/core/**` 라 헬퍼가 분모에 들어간다).

### 3.2 테스트 결정론 정책 (판사 A 공통 결함 ⑤)

vitest 는 파일 병렬이 기본이고 이 레포엔 win 병렬 spawn flake 전례가 있다. 실 fork(T22)·배리어
(T10·T17d)·실 git 20여 행이 동시에 도는 조건에서 배리어 타임아웃 flake 는 확률이 아니라 예정이다.
- 소켓·spawn·실 git 밀집 파일은 **`--no-file-parallelism`** 을 명시하고, 그 목록을 계획이 확정한다.
- 소켓 경로는 **테스트마다 mkdtemp 격리** + §W-3 의 sun_path preflight 를 테스트도 공유한다.
- **크래시 주입의 도달 가능성 검증(신설 · 판사 A 공통 결함 ④)**: 복구 판정을 순수 함수로 만들고 상태를
  **직접 구성**하면 "각 단계 직후 실제로 죽었을 때 디스크가 그 상태가 되는가"(구성 가능 상태 vs **도달 가능**
  상태)를 아무도 검증하지 않는다. 최소 1행: `DurableFs` 훅에서 자식이 자살(`node -e`)하고 부모가 디스크를
  관측하는 **실 프로세스 행**.

---

## 4. 비목표 (명시)

- **자식 프로세스 봉쇄 없음**(U1) — win32 Job Object·linux cgroup/subreaper·macOS 지원은 후속 이슈.
  이번 슬라이스의 데스크톱 크래시는 **전부 ③ reconciliation-required**(fail-closed 방향).
- **자동 base 전진 없음**(17R·C11) — 어떤 조건에서도. 토폴로지 분리(#252)에서만 재검토.
- **롤백 없음**(W-7) — 포기만 제공.
- **bench 의존성 준비 없음**(U2) — verify 는 미가용 보고.
- **lifecycle 회귀(재개) 없음** — `integrated` 후 추가 작업은 새 bench.
- **`/workbenches` 를 ttyd 에 마운트하지 않는다** — 향후 마운트는 별도 소유권 모델 이슈.
- **다중 사용자·승인 위임 없음** — v3 단일 사용자 전제 유지.
- **Workbench 는 서버(컨테이너) 표면 전용**(사용자 결정 2026-07-23 · §W-2-b). **데스크톱 Electron 의
  Workbench 는 후속 이슈**로 분리한다. 이는 23R 이 상정한 "Electron·server 동시 접근 직렬화" 안전 목표의
  **명시적 축소**이며, 사용자 확인을 받아 완료 정의·테스트·배포 계약을 함께 변경했다.
  근거: 이 층은 Codex 6라운드 + 로컬 적대 검증 P1 12건 동안 패치가 수렴하지 않았고, 실패는 전부
  **"레포 권위 범위는 파일시스템으로 공유되는데 endpoint 배타 범위는 net namespace 로 분할된다"** 는 하나의
  불일치에서 나왔다. 표면을 하나로 좁히면 그 불일치가 원천 소멸한다.
- **동시 인스턴스 2개 이상은 지원하지 않는다** — `open(active-instance.json,'wx')` 가 런타임에서 배제하고,
  compose `container_name` 고정이 `scale>1` 을 거부한다(**문면이 아니라 파일로 집행** — 실측상 현행
  구성에서는 `--scale fleet=3` 이 경고 없이 성공했다). 남은 크로스 프로세스 계약(공유 권위·revision-CAS·
  fresh read)은 **같은 표면의 순차 인스턴스**(재시작 전후·컨테이너 교체)에 그대로 적용된다.
- **macOS 미지원**(추상 소켓 부재 · §W-16 이 이미 `platform-unsupported` 로 배제).
- **코디네이션 영역의 악의적 변조 방어 없음**(§W-2-a) — HMAC 무결성 태깅·별도 볼륨 격리는 비목표.
  보장 범위는 사고·경합이며, 이는 설계 §3.2.1-9 신뢰 모델("무제한 셸을 자문 프로토콜로 막을 수 없다")의 연장이다.
- **win32 머신-크래시 내구성 없음**(C3·U4) — `process-durable` 이 상한이다. 탐지(ref-앵커 재조정)는 하되
  **예방은 하지 못한다**. Codex 3항의 충족이 아니라 회피임을 명시한다.
- **내장 터미널(②)·diff 리뷰 루프(③)·리디자인(④) 아님** — #250 후속 축.

---

## 5. 계획(체크포인트 3) 위임 항목

> **API 이름 재유입 금지(Codex 체크포인트 2 승인 시 명시 요청)**: 폐기된 `readFreshSync`·
> `compareAndSwapSync` 이름과 **"CAS 구간에 `await` 가 없다"** 는 문구를 계획·구현에 다시 들이지 않는다.
> 살아있는 계약은 `readFresh` · `compareAndSwap(): Promise<CasResult>` · `withAuthority` 셋이며,
> §W-4 의 두 언급은 **폐기 이력 기록**이다. 계획 태스크 문안에 이 이름들이 등장하면 리뷰에서 되돌린다.

- **선행 실측 1건**: 실컨테이너에서 `/workspace` 레포 → `/workbenches/<id>` worktree 생성 후 git 명령이
  **dubious-ownership 없이** 도는지(현재 `safe.directory` 는 `/workspace` 1줄 — Dockerfile:70).
  이 계열 버그는 B6 에서 리뷰 전량 통과 후 **라이브에서만** 적발된 전례가 있다.
- **PR 분할 — 설계 §4 의 "3~4개" 추정은 실측으로 기각한다.** 이 레포 기준선(코드 순증) = 평균 1,447행·
  최대 1,918행(B3 1,265 / B4 1,518 / B5 1,918 / B6 1,505 / C1 1,642 / C3 832). 본 슬라이스 추정
  8,500~10,500행 → **6~9 PR**. **PR당 순증 1,900행을 상한**으로 두고 초과 시 더 쪼갠다.
  참고 분할: ①durable+authority(CAS·내구) ②locks+coord-area ③journal+integration(실 git)
  ④GitRepo+registry(생성/보관/고아) ⑤engine 배선+run roots+drain ⑥채널 parity+handlers+preload
  ⑦BenchPanel+styles ⑧deploy+nightly ⑨라이브.
  T8·T10b·T13~T18(락·CAS·내구)는 **①② PR 안에서 RED→GREEN** 이어야 이후 층이 안전하다.
  **T19(크로스 프로세스)는 예외** — `bootServer` 2인스턴스를 요구하므로 첫 PR 범위 밖이며,
  ⑤(engine 배선) 이후로 배치한다(초안의 "T19 를 첫 PR 에" 는 자기모순 — 반증 반영).
- ⚠ **선행 실측 ②(컨테이너 bind 마운트 UDS `listen` EACCES = M1)는 폐기한다** — 로컬 검증에서
  Docker Desktop 29.6.2 의 3종 마운트(호스트 bind · VM 내부 bind · named volume) 전부 `listen` 성공으로
  **재현되지 않았다**. 구형 gRPC-FUSE/9p 한정 관측을 일반 사실로 인용했던 것이며, 애초에 추상 소켓 전환으로
  파일시스템 소켓을 쓰지 않으므로 무관하다. 아래 항목은 이 정정 전 문안이다(①③만 유효).
- **선행 실측 3건**(1건이 아니다): ①`safe.directory` × `/workbenches`(아래) ②컨테이너 bind 마운트 위에서
  **UDS `listen` 이 실제로 가능한지**(개발기에서 이미 EACCES 관측) ③`/workbenches` named volume 과
  `/workspace` bind 마운트가 **서로 다른 볼륨**일 때 `git worktree add` 의 admin 파일과 §W-2 확인-응답
  쓰기가 성립하는지. ⚠ **rename 축은 정정 165ⓑ 로 소멸**했다 — tmp 가 대상과 같은 디렉터리라 볼륨을
  넘지 않는다. 남는 미검증은 `git worktree add` admin 파일 쪽뿐이다.
- 커버리지 floor 여유(≈20~28 함수) 안에서 신규 export 함수 수 관리.
- `emitPersisted` 헬퍼 추출 범위(기존 이벤트 경로 회귀 0 확인).
- 중형+ → fleet-plan-panel(판사 패널) 각도 3(리스크/MVP/계약).

---

## 6. 검증 요청 포인트 (체크포인트 2 리뷰 대상)

> ⚠ **이 절은 체크포인트 2 시점의 리뷰 요청 이력**이다. 이후 「서버 단일 표면 축소」(2026-07-23)로 일부
> 문안이 폐기됐다(아래 2·3항에 표시). **구현 계약은 §1·§3 이 권위**이며, 이 절을 근거로 폐기 모델
> (`*Sync` CAS · `connect` 프로브 · ino 재검증)을 되살리지 않는다.

1. **§0.1 정정 계약 12건** — 특히 C1(ref D/F)·C2(락 프리미티브)·C5/C7(WAL 재편)·C6(published 비차단)이
   설계 안전 논증을 약화시키지 않고 **정확히 복원**하는가. 놓친 잔재가 더 있는가.
2. **W-4 revision-CAS 의 in-process 직렬화 경계** — "리스는 프로세스 간 경합만 막고 in-process 인터리브는
   뮤텍스로 닫는다"가 옳은 경계 설정인가. ⚠ **원문의 「sync 채택」은 폐기 문안**이다 — 살아있는 계약은
   `readFresh` · `compareAndSwap(): Promise<CasResult>` · `withAuthority` 이며(§5 머리말), 이 항목을
   sync 로 읽고 구현하면 폐기 API 를 재도입하게 된다(CodeRabbit PR #257 지적). `AuthorityCommit` 브랜드 토큰이 계약 4항(게이트 미해제)의 **기계적** 집행으로 충분한가
   (반환값 무시 lint 부재라는 정직한 한계 포함).
3. ~~**W-3 부재 증명식의 백엔드 분리** — POSIX `connect` ECONNREFUSED · `link` EEXIST + ino 재검증~~
   **폐기 문안**(체크포인트 2 시점) — 서버 단일 표면 축소로 `connect` 프로브·ino 재검증·pathname 소켓이
   전부 소멸했고, 부재 증명은 **커널 bind 배타성 단독**이다(§W-3). 이 절은 리뷰 이력이라 남기되
   구현 근거로 쓰지 않는다.
4. **W-7 worktree-less 통합**(`merge-tree --write-tree` + `commit-tree` 2-parent) — 13R 프라이빗 worktree
   모델 대비 안전 논증이 강해졌는가 약해졌는가. 2-parent 결과가 §5 완료 정의·21R 전체 스냅숏 요건을 만족하는가.
5. **U1 절삭의 잔여 위험** — 봉쇄 없이 ③ 보수 판정만으로 "Fleet 이 잘못된 변이를 하지 않는다"가
   실제로 성립하는가. 데스크톱 크래시 후 고아 CLI 가 bench 를 계속 편집하는 동안 Fleet 이 안전한가.
6. **W-10 R-1(드레인 권위)·W-13(채널 무증가)** — bench 를 `activeProjectIds` 에 넣는 것이 레거시 소비자
   3곳(workspace:set·렌더러 잠금·드레인)에 회귀를 만들지 않는가.
7. **테스트 표의 층 배치** — 계약 5항 핵심을 `verify`(in-process 2인스턴스 + negative control)에 두고
   실 2프로세스를 nightly 로 보낸 판단이 false-green 을 남기는가. T19 의 negative control 이 충분한가.
8. **범위** — §3 에 빠진 케이스. 후속으로 미룬 것 중 이번 계약에 필수인 분. **그리고 §7 의 범위 대안
   (MVP-A)에 대한 판단** — 크로스 프로세스 좌표계를 이번 슬라이스에 넣는 것이 옳은가.
9. **정직한 한계 3건의 수용 가능성** — ⓐ**Codex 3항은 win32 에서 충족이 아니라 회피**이며 안전 등급이
   실제로 낮다(ref-앵커로 탐지는 하되 예방은 못 한다). ⓑ§W-2-a 위협 모델 — 코디네이션 영역은 ttyd·CLI
   에이전트와 **같은 신뢰 도메인**이며 악의적 변조에 대한 무결성 보장이 없다(설계 §3.2.1-9 신뢰 모델의 연장).
   ⓒ계약 4항의 정적 가드는 computed 키를 못 잡는다. 이 셋을 §4 비목표로 두는 것이 타당한가.

---

## 7. 범위 대안 (리뷰 판단 요청)

적대 반증의 범위 렌즈가 실측 기준선으로 **6~9 PR** 을 산출했다. 단일 이슈 안에서 그 수를 굴리면
C1~C5 에서 확립된 「체크포인트 단위 리뷰」 입도가 붕괴한다. 두 안을 제시한다.

**안 1 (본 스펙 = 전체 유지)** — 크로스 프로세스 좌표계(§W-2/W-3/W-4)를 이번 슬라이스에 포함.
설계 7R~23R 의 논증을 그대로 이행한다. 대가: 6~9 PR, 그리고 이번 반증에서 가장 크게 흔들린 층
(락 프리미티브·부재 증명식·CAS 프로토콜)이 **가장 검증이 어려운 층**이기도 하다.

**안 2 (MVP-A = 단일 표면 배타)** — §W-2/W-3/W-4 의 **공유 권위·리스 층을 후속 이슈로** 미루고,
`area.json` 자리에 **단일 표면 배타 마커**(부팅 시 배타 획득 실패 = Workbench 기능 fail-closed 비활성 +
안내)를 둔다. stale 회수는 **자동으로 하지 않고** 사용자 명시 액션으로만(부팅 1회라 마찰 최소).
- 이번 슬라이스 = 「단일 표면에서 bench 생성 / 런 / 통합 준비 / 보관」. 규모 4,500~5,500행(**3~4 PR** —
  설계 §4 추정과 일치).
- **안전 논증은 오히려 강해진다**: 두 표면 동시 사용이 구조적으로 불가능해지므로 23R 이 막으려던
  stale-cache·권위 충돌 클래스가 **발생 자체를 못 한다**. 7R 이 지적한 위험(두 표면이 각자 권위)을
  더 강하게 막는 셈이다.
- 이번 반증에서 확정된 P1 중 **락 이중 소유·모듈 격리 false-green·버전 스큐 3건이 동시에 소멸**한다
  (전부 크로스 프로세스 층의 산물).
- 잃는 것 = 「데스크톱과 서버를 같은 레포에 **동시에** 붙이는」 시나리오. 순차 사용은 정상 동작.

**Codex 판정(체크포인트 2 · 2026-07-23) — 안 2 기각, 안 1 유지 + 이슈/체크포인트 분리**

> "MVP-A 는 현재 문안만으로는 7R~23R 의 안전 목표를 약화 없이 대체하지 못한다."

기각 근거(수용): 단일 표면 배타 마커도 결국 ⓐ프로세스 수명에 결속된 OS-가시 primitive 인지 ⓑ영속 마커면
크래시 후 소유자 부재를 무엇으로 증명하는지 ⓒ"사용자 명시 stale 회수"가 기존 프로세스와 관리 자식의 종료를
무엇으로 증명하는지 ⓓ어느 표면이 권위를 얻었고 다른 표면이 시작 전에 확실히 비활성화되는지 ⓔ컨테이너 교체
후 잔존 마커가 영구 차단도 fail-open 회수도 아닌지 — **동일한 계약 전부를 다시 요구**한다.
특히 설계가 이미 확정했듯 **사용자 승인은 소유자 부재·자식 트리 정지의 증거가 아니다**. 따라서
"사용자 액션으로만 회수"는 안전 약화이고, 회수 불가로 두면 정상 크래시 후 기능이 영구 고착된다.
**복잡성이 제거되는 게 아니라 크래시 회수 의미론으로 이동할 뿐이다.**

**확정 = 안 1 유지 + 범위 분리.** 크로스 프로세스 권위·리스 계층(§W-2/W-3/W-4)은 이번 계약에 유지하고,
**UI(§W-15)·deploy(§2 마지막 행)·push-parity 신설 게이트(§W-14)** 등 **독립적인 후반 범위를 별도
이슈/체크포인트로 절삭**한다. PR 수가 많다는 이유만으로 권위 계층을 단순 마커로 치환하지 않는다.

제안 분리(사용자 확인 필요):
- **#251 (본 계약)** = 코어 — durable·authority CAS·locks·coord-area·journal·integration(실 git)·
  GitRepo·registry·engine 배선. 5~6 PR.
- **신규 sub-issue A** = UI '작업' 탭·카드 그리드·모바일(§W-15) + 채널/브리지 배선(§W-14 bench invoke 6).
- **신규 sub-issue B** = deploy(`FLEET_BENCH_ROOT` 볼륨·ttyd 비마운트 canary)·nightly(docker) 잡 신설·
  라이브 여정(N1~N5) + push-parity 신설 게이트 2건(bench 결합 0이므로 분리 가능).

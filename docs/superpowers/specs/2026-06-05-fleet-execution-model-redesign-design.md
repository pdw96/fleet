# 실행 모델 근본 재설계: 에이전틱 직접 편집 + git 체크포인트 + diff 리뷰 — 설계

- 날짜: 2026-06-05
- 브랜치: `redesign/agentic-execution-model`
- 범위: 오케스트레이션 **실행 경로**를 "CLI=텍스트 반환기" 모델에서 "CLI=워크스페이스를 직접 편집하는 에이전트" 모델로 전환. 채팅·세션 등록·API provider·UI 셸은 보존(필요한 최소 변경만).

## 배경 — 진단된 근본 원인

Fleet은 임의의 목표를 받아 분해→구현→리뷰→검증하는 **범용 오케스트레이터**다(게임 비종속; 목표 문자열은 `runProject(goal)` → `buildPlannerPrompt(goal)` → `buildImplementPrompt(goal, …)`로 그대로 흐를 뿐). 실제 실행이 첫 단계에서 실패하는 원인을 코드 근거로 추적·검증했다(7개 에이전트 반증 검증 + codex 실측).

| | 근본 원인 | 근거 |
|---|---|---|
| **R1** | CLI send 타임아웃 **120초 고정·설정 불가**. 에이전틱 CLI는 사소한 작업도 ~11초(입력 24.5k 토큰 로드), 실제 구현은 수 분 | `cli-session.ts:7`, `engine.ts:186`(undefined 전달), `detect.ts:62` |
| **R2** | 무의존 첫 작업 1건 실패 → 의존 작업 전체로 전파 → 보드 전체 실패 | `orchestrator.ts:215-218` |
| **R3** | (가장 깊음) 오케스트레이터는 CLI가 ` ```file:경로 ` **텍스트 펜스**를 반환하면 파싱(`parseArtifacts`)해 기록하는 모델인데, `codex exec`는 **스스로 파일을 편집하는 에이전트**라 최종 요약(`agent_message`)만 반환 → 타임아웃을 늘려도 `parseArtifacts`가 빈 결과 → 워크스페이스에 아무것도 안 써짐 | `review.ts:21-24`, `artifacts.ts:16`, `registry.ts:29`, `output.ts:36` |
| **R4** | `spawn()`에 cwd 미전파 + codex 어댑터에 `-C` 없음 → 에이전트가 워크스페이스 아닌 Electron CWD(=fleet 레포)에서 실행 | `detect.ts:60`, `registry.ts:29` |

> 실행 시 요약기가 "fleet 레포 자체"를 평가한 현상은 R4의 부작용(요약기 CLI가 fleet 레포 CWD에서 그곳 파일을 읽음)으로 설명된다.

## 확정된 결정 (브레인스토밍)

| 항목 | 결정 |
|---|---|
| 성공 결과물 | 워크스페이스에 **실제 파일** + 다른 LLM의 **교차 리뷰** (둘 다) |
| 실행 모델 | CLI 에이전트가 워크스페이스를 **직접 편집**. 산출물은 **git diff**로 수집 |
| 격리·동시성 | **순차 + git 체크포인트**. worktree 병렬은 인터페이스로 확장 여지만 확보(미구현) |
| 승인 수준 | **리뷰어 LLM 1차** 게이트 + 사용자는 **위험·최종만** 승인(긴 실행 안 멈춤) |
| API provider 역할 | **텍스트 역할 전담**(planner·reviewer·summarizer). implementer는 CLI 세션만 |
| 채택 접근 | 에이전틱 직접 편집 + git 체크포인트 + diff 리뷰/승인 |
| 기각 | (B) 텍스트-펜스 강화 — 에이전틱 CLI 본성과 충돌 · (C) 2경로 하이브리드 — 복잡도/유지비, YAGNI |

---

## 섹션 1 — 새 실행 경로 (데이터 플로우)

```
goal
 └─ Planner(LLM·텍스트) ──▶ TaskGraph (작업 분해)
      각 작업 (순차, dependsOn 위상):
        ① git 체크포인트       ← 작업 전 HEAD 해시 기록 (워크스페이스 = git 레포)
        ② Implementer(CLI 에이전트, cwd=워크스페이스) ──▶ 파일 직접 편집
        ③ git diff 수집         ← 산출물 = 텍스트 파싱 대신 실제 diff
        ④ Reviewer(LLM·텍스트) ──▶ diff 비판 리뷰 → APPROVE/REVISE
              REVISE → 같은 에이전트 재실행(피드백 주입), 최대 N라운드
        ⑤ 위험 판정 → (위험 시) 사용자 승인 게이트
        ⑥ keep(작업 커밋 확정) | revert(체크포인트 롤백) → done/failed/skipped
 └─ Verify(typecheck/lint/test, cwd=워크스페이스) ──▶ 실패 시 에이전트 수정 루프
 └─ Summarizer(LLM·텍스트) ──▶ 목표 대비 점검 (git log/diff 근거)
```

**3가지 전환점:** ① CLI = 텍스트 반환기 → **워크스페이스를 cwd로 받는 에이전트** · ② 산출물 = `artifacts.ts` 텍스트 파싱 → **git diff** · ③ 워크스페이스 = **단일 진실 원천(git 레포)**, 없으면 Fleet이 `git init`.

---

## 섹션 2 — 에이전트 실행 계층

### CommandRunner에 cwd 전파 (R4)
`CommandRunner` 시그니처에 `cwd` 추가, `defaultRunner`가 `spawn(cmd, args, { cwd, windowsHide: true })`로 전달. `createCliSession`이 워크스페이스를 받아 `runner(...)` 호출 시 전달.

```ts
// cli/detect.ts
export type CommandRunner = (
  command: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string; signal?: AbortSignal },
  onStdout?: (chunk: string) => void,
) => Promise<CommandResult>
```
> 기존 (command, args, timeoutMs, onStdout) 위치 인자를 opts 객체로 묶어 cwd·signal을 함께 싣는다. detect 호출부(`detectCli`)도 함께 갱신.

### 어댑터 편집 모드 + codex 인자 (R3)
어댑터에 "에이전틱 편집" 인자 템플릿을 둔다. `{workspace}` 토큰을 cwd로 치환.

| CLI | 편집 실행 인자(개략) |
|---|---|
| codex | `exec --json -C {workspace} -s workspace-write {prompt}` |
| claude | 헤드리스 + 편집 권한 플래그(예: 권한/디렉터리 허용) + cwd=워크스페이스 |
| gemini | 헤드리스 + 편집 권한 플래그 + cwd=워크스페이스 |

- codex `-s workspace-write`: 에이전트가 **워크스페이스 안만** 쓰기 가능 → **1차 안전 경계**.
- 정확한 claude/gemini 편집 플래그는 구현 단계에서 각 CLI 버전으로 실측 확정(현 어댑터 주석의 실측 관례 유지). 미지원/불명 시 해당 어댑터는 implementer 비활성.

### 타임아웃 분리·상향 (R1)
`DEFAULT_TIMEOUT_MS` 고정 제거 → 작업 타임아웃을 `RunOptions.taskTimeoutMs`(기본 ~15분)로 주입, 엔진/IPC로 노출. 채팅 등 짧은 호출은 별도(짧은) 기본값 유지 가능.

### 진행 가시성 + 취소
- 기존 스트리밍 `onChunk`(`adapter.streaming`) 재사용 → 오케스트레이터가 `task.progress` 이벤트로 라이브 표시.
- **취소**: `AbortSignal`을 러너까지 전달, abort 시 `child.kill()`. `cancelRun(projectId)` IPC로 진행 중 실행 중단(현재 작업 revert).

### 역할-종류 제약
implementer로 배정된 세션이 API(`kind==='api'`)면 직접 편집 불가 → 해당 작업 **skip + 경고 이벤트**(또는 배정 단계에서 CLI 세션으로 폴백). planner/reviewer/summarizer는 CLI·API 모두 허용.

---

## 섹션 3 — 체크포인트 & diff 수집 (신규 모듈 `core/workspace/git.ts`)

주입 가능한 `GitRunner`(테스트 mock) 뒤로 git을 캡슐화. cross-spawn 기반 실행기 재사용.

```ts
export interface GitRunner {
  run(args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number|null; stdout: string; stderr: string }>
}
export interface Workspace {
  ensureRepo(): Promise<void>                 // git 아니면 init + 초기 커밋(.gitignore 시드)
  checkpoint(): Promise<string>               // 현재 HEAD 해시 반환(베이스)
  collectDiff(base: string): Promise<{ files: string[]; patch: string; truncated: boolean }>
  keep(base: string, message: string): Promise<string>   // add -A + commit, 새 커밋 해시
  revert(base: string): Promise<void>         // reset --hard base + clean -fd
}
```

| 시점 | 동작 |
|---|---|
| 실행 시작 | `ensureRepo()` — git 아니면 `git init` + 초기 커밋(`.gitignore` 시드) |
| 작업 전 ① | `checkpoint()` = 베이스 커밋 해시 |
| 작업 후 ③ | `git add -A` → `git diff --cached`(파일 목록 + 패치). 바이너리·대용량은 요약·상한(`truncated`) |
| keep ⑥ | `git commit -m "[작업제목] by {llmId}"` |
| revert ⑥ | `git reset --hard {base}` + `git clean -fd` |

> 격리는 "작업 단위 커밋"으로 달성(각 작업 = 베이스→커밋 1개). worktree 병렬 확장 시 `Workspace`를 worktree별로 인스턴스화하면 됨(인터페이스 그대로).

---

## 섹션 4 — 리뷰 & 승인

### 리뷰어 입력 전환
산출물 텍스트 → **diff**. `buildReviewPrompt(taskTitle, taskDescription, diff)`로 변경 자체를 비판 리뷰. `parseReviewVerdict`의 `APPROVE`/`REVISE` 파싱(`review.ts:48`)은 그대로. REVISE 시 같은 에이전트에 피드백 주입 재실행(최대 `maxReviewRounds`). 대용량 diff는 상한 캡 후 `…(절단)` 표기.

### 위험 게이트(2차 방어)
keep 직전 diff를 검사해 다음이면 `ApprovalGate` destructive → 사용자 승인:
- (a) 워크스페이스 밖 경로 변경(샌드박스가 1차 차단, diff로 2차 확인)
- (b) 민감 파일 `.env/.pem/.key/.p12/.pfx/.ssh` (`approval.ts:19` `SENSITIVE_FILE` 재사용)
- (c) 대량 삭제(삭제 파일 수 임계 초과)

그 외 = 리뷰어 APPROVE 시 **auto-keep**(결정: 긴 실행 안 멈춤). `ApprovalRequest.kind`에 `'apply-diff'` 추가, `summary`=작업/변경 요약, `target`=변경 파일 목록. 기존 `ApprovalModal.tsx` + `approval-bridge.ts` IPC 왕복 재사용.

---

## 섹션 5 — Verify & 수정 루프

- verify cwd = 워크스페이스(`run.ts` 유지). 현재도 `npmVerifyCommands(cwd)`로 cwd를 받음 — 워크스페이스 보장만 추가.
- fix 루프를 **텍스트 재구현 → 에이전트 재실행**으로 전환: implementer CLI를 cwd=워크스페이스로 실행하며 실패 로그(`analysis`/`stderr`) 주입 → diff 재수집 → 재검증. 현 `orchestrator.ts:292-316`의 `buildVerifyFixPrompt`+`writeArtifacts` 경로를 대체.
- verify 타임아웃 분리·상향(`run.ts:61` 120초 고정 → 설정값). 부차 버그 교정: `defaultVerifyRunner`가 execFile 타임아웃(`killed`/`signal`)을 `spawnError`로 분류(현재 code=1로 뭉개짐, `run.ts:35`).

---

## 섹션 6 — 실패 격리 (R2 해소)

- 무의존 첫 작업 1건 실패가 **보드 전체를 죽이지 않도록** 변경: 실패의 **직접/전이 의존만** 스킵, 독립 사슬은 계속 실행(`orchestrator.ts:206-238`).
- 작업 단위 **재시도 1회** 옵션(일시 spawn 오류·타임아웃 대비, `RunOptions.taskRetries`).
- 보드 상태 구분: `failed`(실제 실패) vs `skipped`(의존 실패로 미실행). `TaskStatus`에 `'skipped'` 추가.

---

## 섹션 7 — 공유 타입 / IPC / UI 변경

### shared/types.ts
- `CommandRunner` 시그니처에 `cwd`/`signal`(섹션 2).
- `TaskStatus`에 `'skipped'` 추가.
- `Task`에 `changedFiles?: string[]`, `diffSummary?: string`, `checkpoint?: string`.
- `ApprovalRequest['kind']`에 `'apply-diff'` 추가.
- `RunProjectRequest`/`RunOptions`에 `taskTimeoutMs?`, `continueOnFailure?`, `taskRetries?`.
- `OrchestratorEventType`에 `'task.progress'`, `'task.skipped'`, `'run.cancelled'` 추가. 기존 `'task.artifacts'`는 제거(diff 기반 `task.review`로 대체).
- 어댑터에 편집 인자 템플릿 필드.

### IPC (FleetBridge)
- `cancelRun(projectId: string): Promise<void>` 추가.
- 워크스페이스 **필수화**: 실행 전 미선택이면 거부 + 안내(`index.ts:40` buildEngine이 workspace 미설정인 점 정리; UI에서 선택 강제).

### UI
- 작업 보드에 작업별 **diff 미리보기**(변경 파일/요약) + (위험 시) 승인 + **취소** 버튼. 최소 범위, 기존 디자인 토큰 재사용.

### 축소/제거
- `artifacts.ts`(`parseArtifacts`)와 fileops 텍스트-아티팩트 기록은 직접편집 경로에서 미사용 → 오케스트레이터에서 제거(파일·관련 테스트 정리). `fileops`의 `read`/`confine`(경로 제한)은 안전 유틸로 유지 가능.
- `buildImplementPrompt`의 ` ```file: ` 형식 안내(`review.ts:21-24`) 제거 → "워크스페이스에서 직접 작업하라" 안내로 교체.

---

## 섹션 8 — 테스트 전략

- **`workspace/git.test.ts`**(신규): `GitRunner` mock으로 `ensureRepo`(init 분기)/`checkpoint`/`collectDiff`(파일·패치·truncated)/`keep`/`revert` 단위 테스트.
- **`cli/detect.test.ts`**(확장): `defaultRunner` cwd·signal 전파, abort 시 kill.
- **`orchestrator.test.ts`**(개편): diff 기반 리뷰 흐름, 위험 게이트(민감 파일 변경 시 승인 요청), **부분 실패 격리**(독립 작업 계속 실행), 취소, 역할-종류 제약(API implementer skip). 가짜 세션 + 가짜 `Workspace`.
- **`verify/run.test.ts`**(확장): execFile 타임아웃의 `spawnError` 분류.
- 기존 텍스트-아티팩트 가정 테스트 제거/갱신.
- (선택·수동) 실제 codex 1회 엔드투엔드 스모크 — 작은 목표로 워크스페이스에 파일 생성 확인.

## 검증 게이트
`npm run typecheck` / `npm run lint` / `npm test`(개편 후 그린) / `npm run build`.

## 비범위 (YAGNI)
- worktree 기반 **병렬** 실행(인터페이스 여지만 확보).
- API provider 직접 편집(텍스트 역할 전담).
- diff의 그래픽 3-way 머지 UI(텍스트 미리보기로 충분).
- 작업별 사용자 승인(결정: 리뷰어 1차 + 위험/최종만).
- 원격/멀티 워크스페이스, 커밋 푸시 자동화.

## 알려진 한계
- **gitignore 된 파일은 diff 모델 밖이다.** 체크포인트/diff 수집은 `git add -A` 기반이라
  `.gitignore` 로 무시되는 경로(예: gitignore 된 `.env`)에 대한 에이전트 편집은 스테이징되지
  않는다. 따라서 (a) diff 위험 게이트(`classifyDiffRisk`)에 노출되지 않아 검토 없이 변경될 수
  있고, (b) revert 의 `git clean -fd` 가 untracked-but-ignored 파일을 지우지 않아 되돌려지지도
  않는다. 완화책: Fleet 워크스페이스에서는 민감 파일을 gitignore 하지 말 것.
  완전한 해결은 범위 밖이다 — 무시 파일을 강제 스테이징(`git add -f`)하면 `node_modules` 까지
  커밋되고, `git clean -fdx` 로 지우면 사용자의 기존 무시 파일까지 삭제된다.

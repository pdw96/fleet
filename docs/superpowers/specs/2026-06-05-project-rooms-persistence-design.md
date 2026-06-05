# 프로젝트 탭 영속 "방 목록" — 설계

- 날짜: 2026-06-05
- 브랜치: `feature/project-rooms-persistence`
- 범위: 보기 전용(view-only). 중단된 run 이어실행·세션/워크스페이스 영속화는 **비목표**.

## 1. 배경 / 문제

채팅 탭은 ChatGPT/Claude처럼 왼쪽에 "작업방(대화방)" 목록이 영속된다. 탭을 옮기거나 앱을 껐다 켜도 방이 그대로 남고, 클릭하면 전체 대화가 복원된다.

반면 **프로젝트 탭은 다른 탭으로 갔다 오면 진행하던 내용이 사라진 것처럼 보인다.** 사용자 요청: "채팅창에 대화방이 남는 것처럼 프로젝트창에도 방으로 남아있으면 좋겠다."

### 진단 — 왜 채팅은 남고 프로젝트는 사라지나

데이터는 **이미 디스크에 영속**된다(`%APPDATA%/fleet/fleet/fleet-store.json`). 차이는 *렌더러가 마운트 시 저장소를 다시 읽느냐*뿐이다.

| | 채팅 (`ChatPanel.tsx`) | 프로젝트 (`ProjectPanel.tsx`) |
|---|---|---|
| 마운트 시 저장소 재조회 | O — `refreshRooms()` → `listRooms()` (`ChatPanel.tsx:45-47, 92-96`) | **X** — `listProjects()`/`getProjectTasks()` 호출 안 함 |
| 화면 데이터 출처 | 저장소(`listRooms`/`roomHistory`) | **휘발성** — `runProject` 약속 반환값 `result?.tasks`(`ProjectPanel.tsx:82`) + 라이브 이벤트 스트림(`:15,24-34`) |
| 탭 전환 | 언마운트되어도 재조회로 복원 | 언마운트(`App.tsx:64` `{tab==='project' && <ProjectPanel/>}`) 시 React state 전부 소실 → 빈 화면 |

`listProjects()`/`getProjectTasks()` 다리는 **이미 존재**하나 렌더러에서 한 번도 안 쓰인다(`preload/index.ts:17-18`, `shared/types.ts:324-325`).

진행 로그(`ProjectPanel.tsx:170-177`)는 라이브 `OrchestratorEvent` 스트림으로만 그려진다. 오케스트레이터는 이벤트를 `store.appendEvent({type, data})`로 영속(`orchestrator.ts:57-60`)하지만 **`message`를 버리고**, 태스크 이벤트의 `data`는 `{taskId}`만 담아 **projectId로 필터 불가**하다. 또 `task.progress`는 토큰 델타마다 emit→append 되어(`orchestrator.ts:166`) 전체 스냅샷을 매 토큰 재기록한다.

## 2. 목표 / 비목표

**목표**
- 프로젝트 탭 왼쪽에 영속 "방 목록"(= `projects[]`)을 두고, 방 클릭 시 **작업 보드 + 진행 로그**를 저장소에서 재구성한다.
- 탭 전환·앱 재시작 후에도 마지막 보던 프로젝트가 복원된다(채팅 패턴 미러링).

**비목표 (YAGNI)**
- 중단된 run 이어서 실행/재개.
- 세션(LLM·API키)·워크스페이스 경로 영속화.
- 멀티 윈도우. (현재 단일 BrowserWindow·탭 기반)
- 방 이름변경/삭제/아카이브 (채팅에도 아직 없음 — 본 작업서 추가 안 함).

## 3. 설계

채팅의 **"마운트 시 저장소 재조회 + 사이드바 목록 + 선택 시 상세 로드"** 패턴을 프로젝트 탭에 입힌다. 데이터는 **섞지 않는다**(프로젝트/채팅 탭 분리 유지). 접근법 비교 후 채택: `projects[]`를 그대로 "방"으로 재사용(채팅 `rooms[]`에 `kind` 디스크리미네이터로 통합하는 대안은 탭 분리 의도와 어긋나고 채팅 코드까지 건드려 기각).

### 3.1 데이터 (`shared/types.ts`, `store/types.ts`, `store/memory.ts`)

거의 그대로 재사용. `projects[]`/`tasks[]`는 이미 영속. 추가:

1. **`FleetEvent.message?: string`** 추가(`shared/types.ts:237-243`). 진행 로그 라인이 `{type, message}` 형태로 재생되도록 저장소가 message를 보존한다.
2. **이벤트의 projectId 일관 태깅.** 오케스트레이터 `emit`이 영속 시 항상 `data.projectId`를 포함하도록 한다(아래 3.3).
3. **`Store.listProjectEvents(projectId)`** 추가 — `events` 중 `data.projectId === projectId`인 것을 ts 순으로 반환하되 `task.progress`는 제외(재생 로그는 마일스톤만; 토큰 델타는 라이브 전용).
4. **`StoreState.ui?: { lastActiveProjectId?: string }`** + `Store.setLastActiveProject(id)` / 스냅샷 노출 — "마지막 보던 방" 복원용(없으면 최신 프로젝트 자동 선택). 작게 유지.
5. **`StoreState.version: number`**(=1) 추가 — 향후 마이그레이션 안전망(synthesis 권고). 로드 시 누락이면 0으로 간주.

> 모두 같은 `fleet-store.json` 스냅샷에 실린다. 새 저장소 계층 없음.

### 3.2 진행 로그 영속화 — `task.progress` 처리 (핵심 결정)

- **마일스톤 이벤트**(`project.created`/`plan.created`/`task.started`/`task.implemented`/`task.review`/`task.done`/`task.failed`/`task.skipped`/`summary`/`verify.*`/`project.done`)는 `message`+`projectId`와 함께 영속 → 재생 가능.
- **`task.progress`(토큰 델타)는 영속하지 않는다.** 라이브 뷰에만 `onEvent`로 흐른다. 이유: (a) 재생 시 토큰 단위 라인은 노이즈, (b) 현재 토큰마다 전체 JSON 재기록하는 잠재 성능 문제를 함께 제거(작업 중인 코드의 타깃 개선). 태스크별 최종 산출물은 `Task.output`/`changedFiles`로 이미 영속되어 보드에서 보인다.

### 3.3 메인 / IPC

- `orchestrator.ts`의 `emit`(현 `:57-60`)을 수정: 영속 호출을 `store.appendEvent({ type: e.type, message: e.message, data: { projectId, ...e.data } })`로. 단 `e.type === 'task.progress'`면 `appendEvent` 생략(라이브 onEvent만). `projectId`는 `createProject` 직후 확보되는 값을 클로저로 캡처(현재 `emit`이 `project` 생성 이전 줄에 정의되어 있어, 정의 위치 조정 또는 `let projectId` 캡처 필요).
- `engine.ts`: `listProjectEvents(projectId)` → `store.listProjectEvents` 위임 추가. (`listProjects`/`getProjectTasks`는 이미 위임 존재.)
- `main/index.ts`: IPC 핸들러 `fleet:project:events` 등록(기존 `fleet:project:list`/`:tasks` 옆).
- `preload/index.ts` + `shared/types.ts(FleetBridge)`: `listProjectEvents(projectId: string): Promise<FleetEvent[]>` 다리 추가. 필요 시 `setLastActiveProject`도.

### 3.4 렌더러 (`ProjectPanel.tsx` 재작성)

채팅 구조를 미러링한다.

- **레이아웃**: `<div className="chat">` 형 2단 — 왼쪽 `<aside className="panel rooms">`에 프로젝트 목록(각 버튼에 제목 + status chip), 오른쪽에 기존 보드/로그/요약 패널. "+새 프로젝트"는 목표 입력 + 정책 + `runProject` 흐름(기존 `run()` 재사용).
- **마운트 시**: `listProjects()`로 목록 로드 → `lastActiveProjectId`(없으면 최신) 자동 선택.
- **프로젝트 선택 시**: `getProjectTasks(id)` → 보드(`result?.tasks` 대신 store 기준), `listProjectEvents(id)` → 진행 로그, `projects[]`에서 status/goal/요약(요약은 `summary` 이벤트 또는 `Task.output` 기반; **결정: 요약 패널은 store에서 복원 불가하면 라이브 때만 표시** — 비목표 처리). 선택 시 `setLastActiveProject(id)`.
- **라이브**: 기존 `onOrchestratorEvent` 구독 유지하되, **선택된 프로젝트의 `data.projectId` 매칭 이벤트만** 로그에 append(현재는 모든 이벤트를 무조건 append — 크로스-프로젝트 누수도 함께 수정). `project.created` 도착 시 목록 새로고침 + 새 프로젝트 자동 선택.
- **취소 버튼**: 기존 로직 유지(`activeProjectId`는 "실행 중 프로젝트"로 의미 유지; 새로 도입하는 "선택된 프로젝트"와 구분).

### 3.5 `App.tsx`

`:64`의 조건부 마운트(언마운트) **그대로 둔다.** 채팅과 동일하게 마운트 재조회로 복원하므로 패널을 숨겨두는 변경 불필요. (탭 자체 `tab` state가 휘발이라 마지막 탭 복원은 별도 — 본 작업 범위 밖.)

## 4. 데이터 흐름

```
[실행]  ProjectPanel.run() → fleet:project:run → engine.runProjectFlow → orchestrator.runProject
          → store.createProject/createTask/updateTask + appendEvent(milestone, projectId, message)
          → onEvent broadcast(fleet:orchestrator:event) → 선택된 프로젝트면 라이브 로그 append
[복원]  ProjectPanel mount → listProjects() → 목록 + 자동선택
          → getProjectTasks(id)=보드, listProjectEvents(id)=로그   (둘 다 store에서)
```

읽기/쓰기 모두 기존 경로(renderer → preload → IPC → engine → store) 동일. 새 경로 없음.

## 5. 에러 처리

- `listProjects`/`getProjectTasks`/`listProjectEvents` 실패 → 빈 목록/보드/로그 + 에러 표시(채팅의 빈 상태 처리 답습). 치명적 아님.
- 깨진 `fleet-store.json` → 기존 `.corrupt` 백업+빈 상태 복구 경로 유지(`json-file.ts`).
- 라이브 이벤트가 현재 선택 안 된 프로젝트 것이면 무시(누수 방지). 백그라운드 프로젝트의 진행은 다시 선택 시 store에서 재생.

## 6. 테스트 (TDD — 구현 전 작성)

- **store 단위**(`store/*.test.ts`): `appendEvent`가 `message` 보존; `listProjectEvents(pid)`가 projectId로 필터 + ts 정렬 + `task.progress` 제외; `setLastActiveProject`/스냅샷 왕복; `version` 기본값.
- **orchestrator 단위**: 마일스톤 이벤트가 `projectId`+`message`로 영속됨; `task.progress`는 영속 안 됨(=`listEvents`에 미포함)·`onEvent`로는 방출됨. 기존 emit 단언 테스트 갱신.
- **engine 단위**: `listProjectEvents` 위임.
- **ProjectPanel**(Testing Library + `window.fleet` mock): 마운트 시 `listProjects` 호출; 프로젝트 선택 시 `getProjectTasks`+`listProjectEvents` 호출하고 보드/로그 렌더; **언마운트→재마운트 후 보드/로그 복원**(약속 반환값 의존 제거 검증); 비선택 프로젝트의 라이브 이벤트가 현재 로그에 안 새는지.
- **회귀**: 채팅 동작 불변. 기존 오케스트레이터/스토어 테스트 그린.

## 7. 리스크 / 의사결정

- **`emit` 시그니처/페이로드 변경**이 기존 오케스트레이터·스토어 테스트의 `appendEvent` 단언에 영향 → 테스트 동반 갱신 필요(리스크 낮음, 국소적).
- **`task.progress` 영속 중단**은 현재 동작 변경. `fleet:events:list`(감사) 소비처가 progress에 의존하지 않는지 확인(확인 결과 미사용으로 보이나 구현 시 재확인). 의존 시 "감사엔 남기되 `listProjectEvents`에서만 제외"로 후퇴 가능.
- **요약 패널 복원**: `summary`는 이벤트 message로는 남으나 본문 전체(`RunResult.summary`)는 store에 별도 영속 안 됨. 보기 전용 범위에서 요약 본문 복원은 비목표(이벤트 한 줄로 "요약 완료"만 재생). 추후 `Project.summary` 필드로 확장 가능.
- **`activeProjectId`(실행 중) vs 선택된 프로젝트** 두 개념 혼동 주의 — 명확히 분리.

## 8. 영향 파일

| 파일 | 변경 |
|---|---|
| `src/shared/types.ts` | `FleetEvent.message?`, `FleetBridge.listProjectEvents`(+옵션 `setLastActiveProject`) |
| `src/main/core/store/types.ts` | `StoreState.version`/`ui`, `Store.listProjectEvents`/`setLastActiveProject` |
| `src/main/core/store/memory.ts` | 위 구현 + `appendEvent` message 보존 |
| `src/main/core/store/json-file.ts` | (필요 시) version 기본값/로드 보정 |
| `src/main/core/orchestrator/orchestrator.ts` | `emit` — message+projectId 영속, `task.progress` 영속 제외 |
| `src/main/core/engine.ts` | `listProjectEvents` 위임 |
| `src/main/index.ts` | `fleet:project:events` IPC 핸들러 |
| `src/preload/index.ts` | `listProjectEvents` 다리 |
| `src/renderer/components/ProjectPanel.tsx` | 사이드바 목록 + 마운트 재조회 + store 기준 보드/로그 (핵심 재작성) |
| `src/renderer/styles.css` | (재사용으로 최소) 프로젝트 사이드바 스타일 |
| 각 `*.test.ts(x)` | 위 테스트 추가/갱신 |

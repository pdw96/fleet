# #197 B1 — run 이벤트 커서 (코어 계약) 구현 계획

> Part of #197 (Phase B) · 권위: #197 본문 B1 항목 + 체크포인트 2 리뷰(Codex 조건부 승인 §2·§5).
> 착수일 2026-07-03. 코어 계약만 — IPC/preload/WS/renderer 무변경(전송층은 B2~).

## 목표

Electron IPC→WS 전환(Phase B) 시 **재접속 후 이벤트 재생·갭 감지**의 기반이 되는 단조 커서를
코어 store 계약에 심는다. store 가 모든 영속 이벤트에 단조 `seq` 를 스탬프하고, 재접속 시
`hello` 가 실을 `{maxEventSeq, minRetainedEventSeq}` 를 노출한다. **이번 PR 은 이 계약과 그
테스트만** — 실제 hello/WS 배선은 B2~.

## 설계 결정 (코드 실측 기반)

### 1. `FleetEvent.seq?: number` — optional, store 단조 스탬프
- `src/shared/types.ts` `FleetEvent` 에 `seq?: number` 추가.
- **왜 optional**: 구파일(pre-B1 `fleet-store.json`)엔 부재 → 로드 시 백필. 빈 상태·구파일을
  깨지 않으려 기존 `droppedEventCount?`·`updaterChannel?` 의 "옵셔널·부재는 미기록" 관례를 답습.
  store 가 append/백필로 보장하므로 **store 반환 이벤트는 항상 numeric seq 보유**(테스트로 단언).
- store 가 유일한 FleetEvent 생성 지점(`memory.ts` `appendEvent`) → seq 스탬프 단일 choke point.

### 2. `StoreState.eventSeq?: number` — optional, lazily 설정, 비후퇴
- `src/main/core/store/types.ts` `StoreState` 에 `eventSeq?: number`(마지막 배정 seq = 최대).
- **빈 상태 미기록**: `store.test.ts` "starts empty" 가 `snapshot()` 을 6키 객체와 deep-equal
  단언 → `eventSeq` 를 emptyState 에 넣으면 회귀. 첫 `appendEvent` 에서 lazily 설정(=1).
- **rotation 비후퇴**: `enforceEventCap` 이 앞(오래된)부터 폐기해도 `eventSeq`(카운터)는 불변.
  다음 append 는 항상 `eventSeq+1` → 폐기된 seq 재사용 없음.

### 3. `minRetainedEventSeq` — **파생**(영속 안 함), `store.eventCursor()` 로 노출
- 신규 store 메서드 `eventCursor(): { maxEventSeq: number; minRetainedEventSeq: number }`.
  - `maxEventSeq = state.eventSeq ?? 0`
  - `minRetainedEventSeq = state.events[0]?.seq ?? (maxEventSeq + 1)` (비어있으면 "다음 생성 seq")
- **왜 파생(StoreState 필드 아님)**: `events[0].seq` 가 정확한 최소 보존 seq — 별도 필드로
  영속하면 rotation·load·백필마다 동기화 부담 + drift 위험(AGENTS.md 코어 순수성). 파생은
  drift 불가. hello(B2)가 필요로 하는 값은 이 메서드가 정확히 제공(체크포인트 2 §2 갭 감지).
- **갭 감지 계약**: 클라이언트 커서 `C` 는 `C >= minRetainedEventSeq - 1` 이면 연속(재하이드레이션이
  `(C, max]` 를 덮음). 아니면 갭 → 스냅숏 권위(RunActivity)로 강제 전체 재하이드레이션(B4).

### 4. `OrchestratorEvent.seq?: number` — 영속 성공 후 스탬프
- `src/shared/types.ts` `OrchestratorEvent` 에 `seq?: number` 추가(top-level — 이슈 명명 일치).
- `orchestrator.ts` `emit()` 의 비-`task.progress` 분기에서 `store.appendEvent()` 반환 `persisted.seq`
  를 라이브 방출 이벤트에 실음: `onEvent?.({ ...enriched, seq: persisted.seq, data: {..., eventId} })`.
  `appendEvent` 는 동기 → append+seq 배정과 emit 사이 인터리브 없음(레이스 없음, 체크포인트 2 §5).
- **`task.progress`(비영속)는 seq 없음** — 재접속 재생 불가를 명시적 비범위(RunActivity 스냅숏이
  상태 권위). emit 의 task.progress 분기는 `onEvent?.(enriched)` 그대로(seq 미부착).

### 5. 구파일 백필 (`memory.ts` 로드 정규화)
- 배열 정규화(`Array.isArray`) 직후, `enforceEventCap` 전에 실행:
  1. `maxSeq` = 기존 `state.eventSeq`(있으면) 와 각 이벤트의 numeric seq 중 최대.
  2. seq 미보유(구파일) 이벤트에 배열 순서(=시간순)로 `++maxSeq` 배정 — 기존 최대 위로(충돌 방지).
  3. `maxSeq > 0` 이면 `state.eventSeq = maxSeq`(0/부재는 미기록 유지).
- 순수 구파일: 1..N 배정, `eventSeq=N`. 순수 신규파일: seq 보유 → 백필 없음, `eventSeq` 유지.

## 비범위 (defer)
- hello/WS 프로토콜·ws-bridge·renderer 재접속 필터 → B2~B4.
- `task.progress` 델타 재생 → 영구 비범위(RunActivity 스냅숏 권위).
- IPC/preload/FleetBridge 변경 없음(FleetEvent/OrchestratorEvent 는 generic payload 라 optional
  필드 추가가 IPC 왕복에 하위호환 — 데스크톱 무회귀).

## 테스트 (TDD RED→GREEN)

### `src/main/core/store/store.test.ts` — 신규 describe "이벤트 커서 seq (#197 B1)"
1. `appendEvent` 가 1부터 단조 증가 seq 스탬프(연속 3건 → seq 1,2,3, 삽입순 일치).
2. `snapshot().eventSeq` 가 마지막 seq 노출(N건 → N).
3. 빈 store `snapshot().eventSeq` 부재(무회귀).
4. rotation(cap 3, 5 append): 남은 events seq `[3,4,5]`(재번호 없음) + `eventSeq===5`(비후퇴).
5. `eventCursor()` 빈 store → `{max:0, minRetained:1}`.
6. `eventCursor()` cap 없이 N append → `{max:N, minRetained:1}`.
7. `eventCursor()` rotation 후(cap 3, 5건) → `{max:5, minRetained:3}`(갭 감지 핵심).
8. 구파일 백필: initial.events(seq 부재 N건) → 각 seq 1..N + `eventSeq===N`.
9. 신규파일: initial.events(seq `[5,6,7]`)+`eventSeq:7` → seq 불변, 다음 append seq===8.
10. 백필+rotation: initial 4건(seq 부재)+cap 2 → 백필 1..4 → 폐기 [1,2] → 남은 seq `[3,4]`,
    `eventSeq===4`, `minRetained===3`, `droppedEventCount===2`.
11. json-file round-trip: 디스크 영속 후 새 인스턴스에서 seq·eventSeq 동일 복원 + 다음 append 연속.

### `src/main/core/engine.test.ts` — OrchestratorEvent.seq 스탬프
12. 단순 run(roleRunner): 영속(비-task.progress) 라이브 이벤트는 numeric seq 보유 +
    `data.eventId` 로 매칭되는 영속 FleetEvent.seq 와 일치 + 방출 순서 단조·유일.
13. 커스텀 세션이 `onChunk` 델타 방출 → 라이브 `task.progress` 이벤트는 `seq === undefined`
    (비영속 무스탬프), 동시에 주변 영속 이벤트는 numeric seq.

## 게이트
- `npm run verify` GREEN(typecheck·lint·test·coverage·build·format·skills:lint·brain).
- 데스크톱 무회귀(preload/IPC 무변경 → dev 재시작 불요, 단 코어 변경이라 `npm run brain` 갱신).
- 적대 리뷰(fleet-pr-review: find=fleet-finder / verify=fleet-refuter).

## 적대 리뷰 결과 (6렌즈·25에이전트·refute 15)

확정 3건 반영/이월:
- **[반영] cancelRun 라이브 run.cancelled 에 seq 누락**(engine.ts) — emit() 을 우회하는 유일한 또 다른
  영속 라이브 orchestrator 이벤트 생산자라, 영속본(seq 보유)과 라이브본(seq 부재)이 비대칭 → B1 계약
  위반. `seq: persisted.seq` 1줄 추가 + cancelRun 테스트에 seq 패리티 단언 보강.
- **[반영] 손상 eventSeq 미정화**(memory.ts) — `{eventSeq:'x'}` 가 빈 events 시 생존해 `'x'+1='x1'`.
  sessions=42·events=42 와 동일 위협 클래스. 비음수 정수 가드 + else delete + 테스트 2건 추가.
- **[이월] task.failed 이중 영속**(orchestrator.ts:267 민감 ignored 백업 실패 경로) — B1 이 도입한
  결함 아님(#128-era 선행)·커서 계약과 직교. 코어 스코프 엄수 위해 별도 후속으로 이월(refuter 도
  "tier:later 이월 가능" 판정).

refute 로 기각: minRetainedEventSeq 파생 vs StoreState 필드(파생 방어 견고 — 계획 §3)·eventCursor
store-epoch 부재(B2 소비자 미출하)·병렬 emit seq 레이스(appendEvent 동기라 원자적)·백필 혼합배열
순서역전(도달 불가 — append 는 항상 끝에 push)·소비자 부재(계약-우선 범위 명시 인가).

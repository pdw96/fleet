# #128 finding5 설계 — ignored 감사 이벤트 라이브(onEvent) 표면화

> **이슈:** #128 (부모 #123·#27) · **선행:** #128-B1(PR #129 `35a4b97`) · #128-B2(PR #130 `a53bb34`) 머지
> **근거:** B2 설계 리뷰 #5(Codex) — "finding5(`ignored_discarded` live emit)는 B2 본체와 분리, 별도 PR" 권장. B2 본체는 보안 link-guard 핵심, finding5 는 UX 표면화·union 확장 별건.
> **날짜:** 2026-06-24

## 배경 / 스코프

`#123-A`·B1 이 도입한 워크스페이스 무결성 감사 이벤트 두 종이 **store 영속만 되고 라이브 표면화가 안 됐다**:

- `workspace.ignored_changes` — 작업/verify-fix 중 ignored 파일 변경 감지(경로·종류).
- `workspace.ignored_discarded` — 병렬 worktree 의 승인된 ignored 변경이 통합에서 제외돼 폐기됨(main 미반영).

둘 다 `store.appendEvent()` **직접 호출**이라 `opts.onEvent` 라이브 스트림에 안 실린다. 그 결과:

1. **라이브 미표면화** — 실행 중 발생해도 렌더러는 스냅샷 재조회(프로젝트 재선택 등) 전엔 못 본다.
2. **`ignored_changes` 빈 행** — `message` 필드가 아예 없어 스냅샷 로드 시 로그에 빈 행(`e.message ?? ''`)으로 뜬다.

finding5 = 이 둘을 `emit()` 으로 보내 **store 영속(1회) + 라이브(onEvent) 동시 표면화** + 의미있는 message 부여.

## 핵심 결정

### 1. append→emit 전환 (이중계상 없음)

`emit()`(orchestrator.ts)은 이미 **통합 경로**다: non-`task.progress` 이벤트에 대해

```text
store.appendEvent(...) 1회   +   opts.onEvent?.({ ...enriched, data.eventId = persisted.id }) 1회
```

를 한다. 즉 **append 를 emit 으로 "교체"**(추가 아님)하면 영속은 그대로 1회, 추가로 라이브 1회가 붙고, 라이브 페이로드의 `data.eventId === 영속 FleetEvent.id` 라 렌더러가 스냅샷과 **id 기준 dedup**(ProjectPanel L207-215)한다 → 중복 표시 없음. B2 리뷰 #5 가 짚은 "store append + emit 이중계상" 리스크는 *교체*로 해소된다(나란히 둘 다 호출하면 이중계상이지만 그렇게 안 함).

`emit()` 은 `data.projectId` 를 클로저 projectId 로 부착하므로 P2-5 의 `listProjectEvents(data.projectId)` 필터도 그대로 통과(전환 전 명시 projectId 와 동일값).

### 2. union 확장

`emit()` 시그니처가 `OrchestratorEvent`(= `type: OrchestratorEventType`)를 받으므로 `shared/types.ts` 의 union 에 두 타입 추가. `store.appendEvent` 는 느슨한 `type: string` 이라 전엔 불필요했다. 코드베이스에 `OrchestratorEventType` exhaustive switch/`assertNever` 없음 → 확장 안전(렌더러는 if-chain, 미지 타입도 로그에 흐름).

### 3. path-free message (비밀 비노출 유지)

`ignoredChangesSummary(c)` 헬퍼 — 경로·파일명·내용 없이 카운트 요약만(`ignored 파일 변경 N건 · 복원불가 M건`). 경로·종류는 기존대로 `data.changes`(A 계약: 감사 로그에 경로+종류 surface, 내용·hash 비노출)에만. `ignored_discarded` 의 message 는 기존 task.title 기반 문구 유지(경로 없음), data 는 taskId/projectId 만.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `src/shared/types.ts` | `OrchestratorEventType` union 에 `workspace.ignored_changes`·`workspace.ignored_discarded` 추가 |
| `src/main/core/orchestrator/orchestrator.ts` | `ignoredChangesSummary()` 헬퍼 추가 · 3 호출부(runTaskIn ignored_changes · 병렬정리 ignored_discarded · verify-fix ignored_changes) `store.appendEvent`→`emit` |
| `src/main/core/orchestrator/orchestrator.test.ts` | finding5 라이브 방출 + eventId + 스토어 1회(이중계상 없음) + path 비노출 테스트 2건 |

## 테스트 (RED→GREEN)

- `[#128-finding5] ignored_changes 는 라이브로 방출 + eventId 부착 + 스토어 1회만` — onEvent 로 1건 수신, `data.eventId === stored.id`, 스토어 1건, message 비어있지 않고 `.env` 미포함. (RED: append-only 라 라이브 0건)
- `[#128-finding5] ignored_discarded 도 라이브로 방출 + eventId 부착` — 병렬 2 worktree done → 라이브 2건, 전부 eventId·비어있지 않은 message, JSON 에 `.env-` 미노출.
- 기존 회귀(regression7·P2-5·m1) green 유지 — emit 이 여전히 appendEvent 하므로 store 기반 단언 무회귀.

## 비목표

- A/B1/B2 가 출하한 탐지·gate·복원·fail-closed·link-guard 계약 변경(무회귀).
- 새 렌더러 전용 UI 컴포넌트(기존 라이브 로그 흐름 재사용).

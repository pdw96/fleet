# #126 설계 — EventLog cap (events rotation + 폐기 관측)

> **이슈:** #126 (부모 #27) · **브랜치:** `feat/eventlog-cap`
> **체크포인트:** 설계 코멘트 [#4795712925](https://github.com/pdw96/fleet/issues/126#issuecomment-4795712925) + `@codex review` 독립 리뷰
> **날짜:** 2026-06-25

## 배경 / 스코프

audit·approval·task·usage 영속 경로가 모두 `appendEvent` 를 통과하는데, 두 가지가 결합해 **유일하게 무한
증가하는 collection** 을 만든다:

- `src/main/core/store/memory.ts:156` — `state.events.push(event)` 로 events 배열에 **상한/회전 없이 누적**
  (project·task·session·room 은 bounded, events 만 무한).
- `appendEvent` → `save()` → `src/main/core/store/json-file.ts:52`
  `writeFileSync(tmp, JSON.stringify(state, null, 2))` = **이벤트 1건마다 스토어 전체 스냅샷을 동기 재직렬화·재기록**.

→ events 길이 N 에서 매 append 비용 O(N), 누적 **O(N²)**. 장기 세션/대량 도구루프에서 `fleet-store.json`
비대 + 메인 스레드 동기 write 지연(체감 누적).

**해법:** events 에 **최근 N=5000 rotation cap** 을 건다. N 이 상한에서 멈춰 per-append write 가 **O(cap) 로
bounded** → 근본 치유. cap 우선 — SQLite 마이그레이션·append-only 쓰기는 #126 명시 비목표.

## 핵심 결정 (확정)

1. **cap = 5000** (도구호출당 ~4 이벤트 → ~1250 호출 분량 보존). `StoreOptions.eventCap` 으로 주입 가능
   (테스트는 작은 값 e.g. `3`; 기본 5000). `now`/`idGen` 결정론 주입 선례와 동형.
2. **rotation(slice — 앞에서 폐기)**. ring-buffer(순환 인덱스·삽입순서 관리)는 단일 5000 배열엔 과설계, append-only
   쓰기는 스토어 추상화 영역(#126 비목표) → 둘 다 기각.
3. **폐기 관측(완료조건: 조용한 손실 금지):** `StoreState.droppedEventCount` 누적 카운터(`snapshot()` 포함 →
   영속·관측) + **첫 폐기(0→양수 전환) 시 `console.warn` 1회**(임계 돌파 알림, 이후 노이즈 0). IPC/렌더러 노출은
   완료조건("관측 가능")을 넘는 UI 표시라 **비목표**(YAGNI).
4. **로드 시 1회 정규화:** `initial.events` 가 cap 초과면 store 생성 시 trim + 카운터 가산 → 이미 비대해진
   `fleet-store.json` 도 즉시 치유. 기존 `sessions` 비배열 정규화(memory.ts:30) 선례와 같은 "로드 시 1회 정규화".
5. **ADR 생략:** cap 크기·rotation 은 설계 선택이나 *단일 기능의 구현 파라미터*(교차 운영 정책 아님). 근거는 본
   spec + #126 본문에 보존. ADR-0003(솔로 pre-1.0 과설계 ROI 경계) 존중.

## 컴포넌트 설계 (전부 코어 — Electron 비의존, vitest 직접 검증)

### A) cap 적용 — `appendEvent` (memory.ts)

```ts
appendEvent(input) {
  const event: FleetEvent = { id: idGen(), type: input.type, message: input.message,
    data: input.data ?? {}, ts: now() }
  state.events.push(event)
  const overflow = state.events.length - cap
  if (overflow > 0) {
    const firstDrop = (state.droppedEventCount ?? 0) === 0
    state.events.splice(0, overflow)            // 가장 오래된 것부터 폐기
    state.droppedEventCount = (state.droppedEventCount ?? 0) + overflow
    if (firstDrop) console.warn(`[fleet] 이벤트 로그 상한(${cap}) 도달 — 가장 오래된 이벤트부터 폐기(누적 ${state.droppedEventCount}건).`)
  }
  save()
  return structuredClone(event)
}
```
- 정상 동작 시 overflow 는 1(append 1건). 로그는 **첫 도달 1회만** → 도구 루프 노이즈 없음.
- 로그 메시지는 **cap·누적 카운트만** — 이벤트 내용·경로 비노출.

### B) 로드 시 정규화 — `createMemoryStore` (memory.ts)

`state` 초기화 직후, `sessions` 정규화 인접 위치:
```ts
const cap = opts.eventCap ?? 5000
if (!Array.isArray(state.sessions)) state.sessions = []
if (state.events.length > cap) {
  const overflow = state.events.length - cap
  state.events.splice(0, overflow)
  state.droppedEventCount = (state.droppedEventCount ?? 0) + overflow
}
```
- `droppedEventCount` 는 로드된 `initial.droppedEventCount`(있으면)에 가산 — 누적 보존.
- 로드 정규화는 **메모리 상태만** 보정. 디스크 파일은 다음 `save()`(첫 변경) 때 cap 적용본으로 재기록된다.

### C) 카운터 타입·노출

- `StoreState.droppedEventCount?: number` (optional → 구버전 파일·신규 = 미설정, 0 으로 해석).
- `snapshot()` 이 전체 state clone 이라 카운터 자동 포함(영속·main 관측).
- `listEvents()` / `listProjectEvents()` **무변경** — cap 된 `state.events` 에서 그대로 동작. 렌더러는 #133
  `onEvent` 실시간 스트림 + `eventId` dedup 이라 스냅샷 truncation 에 견딘다(회귀 없음).

## 데이터/인터페이스 변경 요약

| 심볼 | 전 | 후 |
|---|---|---|
| `StoreOptions.eventCap` | — | `+ eventCap?: number`(기본 5000) |
| `StoreState.droppedEventCount` | — | `+ droppedEventCount?: number` |
| `appendEvent` 동작 | 무한 push | push + cap 초과 시 앞에서 폐기 + 카운터 |
| `createMemoryStore` 로드 | sessions 만 정규화 | events 도 cap 정규화 |
| `json-file.ts` | — | **무변경**(persist 가 state 전체 직렬화 → 카운터 자동 영속) |

## 에러 처리 / 불변식

- cap 은 **events 에만** 적용 — projects·tasks·rooms·messages·sessions 무영향.
- 폐기는 **정상 동작**(에러 아님). "조용한 손실 방지" = 누적 카운터 + 첫 폐기 경고.
- **비밀 비노출:** 경고 로그는 cap·누적 카운트만, 이벤트 `message`/`data` 비노출.
- 원자적 write(json-file `tmp`+`rename`) 경로 무변경.

## 테스트 매트릭스 (`store.test.ts`, RED→GREEN; `eventCap` 주입으로 소형 검증)

| 항목 | 검증 |
|---|---|
| cap 초과 → 상한 유지 | `eventCap:3`, 5건 append → `listEvents().length === 3` |
| 가장 오래된 폐기·최근 보존 | append 순서 id 추적 → 최근 3건만 남음 |
| 카운터 정확성 | 폐기량 누적 = `snapshot().droppedEventCount`(2단계 폐기 합산) |
| 첫 폐기 경고 1회 | `vi.spyOn(console,'warn')` → cap 도달 시 1회, 이후 append 폐기엔 미호출 |
| 로드 시 정규화 | `initial.events` cap 초과로 store 생성 → 즉시 `length===cap` + 카운터 |
| 소비처 무회귀 | cap 후 `listProjectEvents` 가 projectId 필터·`task.progress` 제외 정상 |
| cap 미만 회귀 | cap 미만이면 폐기 0, `droppedEventCount` 미설정/0(기존 동작 동일) |

## 영향 파일

- `src/main/core/store/memory.ts` — A(cap 적용) · B(로드 정규화)
- `src/main/core/store/types.ts` — `StoreOptions.eventCap` · `StoreState.droppedEventCount`
- `src/main/core/store/store.test.ts` — cap 테스트군(위 매트릭스)
- (`json-file.ts` 무변경)

## 검증

`typecheck · lint · format:check · test · build` 5게이트 green + 구조 변동 시 `npm run brain` 갱신.
scoped commit(변경 파일만, `git add -A` 금지). 적대 자가리뷰(`fleet-pr-review`; Codex 봇 한도 시 대체).

## 비목표

SQLite 마이그레이션 · append-only 쓰기 · eventlog 뷰어/타임라인 UI · 폐기 카운터의 IPC/렌더러 표면화 ·
events 외 collection cap · ADR 작성.

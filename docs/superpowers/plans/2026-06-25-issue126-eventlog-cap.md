# EventLog cap (#126) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `events` collection에 최근 5000건 rotation cap 을 걸어 무한 증가 + 매 append O(N) 동기 재직렬화(누적 O(N²))를 O(cap) 로 bounded 한다.

**Architecture:** 순수 인메모리 store(`createMemoryStore`)에 `enforceEventCap()` 헬퍼를 도입한다 — append 후·로드 시 호출해 cap 초과분을 앞(가장 오래된)에서 `splice` 하고 `droppedEventCount` 를 누적한다. cap 크기는 `StoreOptions.eventCap`(기본 5000) 으로 주입 가능(테스트 소형 값). 영속(`json-file.ts`)·소비처(`listEvents`/`listProjectEvents`)·IPC 는 무변경.

**Tech Stack:** TypeScript(코어 — Electron 비의존), vitest.

## Global Constraints

- cap 기본값 **5000**, `StoreOptions.eventCap?: number` 로 주입(미지정 시 5000).
- `StoreState.droppedEventCount?: number` 는 **optional** — `emptyState()`(memory.ts:5)·`EMPTY`(json-file.ts:6) 에 **추가 금지**. (기존 `starts empty`/`fills missing top-level keys` 테스트가 `snapshot()` 을 정확히 6키와 `toEqual` 검증 → 추가하면 회귀.)
- 폐기 경고는 **첫 폐기(0→양수) 1회만** `console.warn`, 메시지엔 **cap·누적 카운트만**(이벤트 `message`/`data` 비노출).
- 코어 `src/main/core/*` 는 `electron`/DOM import 금지.
- 주석/식별자 한국어. scoped commit(변경 파일만, `git add -A` 금지).
- 검증 게이트: `npm run typecheck · lint · format:check · test · build`.

---

### Task 1: 타입 + appendEvent rotation cap (카운터·count-only 경고)

**Files:**
- Modify: `src/main/core/store/types.ts` (`StoreOptions`·`StoreState`)
- Modify: `src/main/core/store/memory.ts` (`createMemoryStore` — `enforceEventCap` 헬퍼 + `appendEvent` 배선)
- Test: `src/main/core/store/store.test.ts`

**Interfaces:**
- Produces: `StoreOptions.eventCap?: number` (기본 5000) · `StoreState.droppedEventCount?: number` · `createMemoryStore` 내부 `enforceEventCap(): void`(Task 2 가 로드 시점에 재사용).
- Consumes: 기존 `appendEvent(input)`·`state.events`·`state.droppedEventCount`.

- [ ] **Step 1: 타입 추가**

`src/main/core/store/types.ts` 의 `StoreState`(49-62행 인터페이스)에 필드 추가 — 닫는 `}` 직전:
```ts
  /** 자동 업데이트 채널 선호(#98). 미설정(구버전 파일·신규)이면 stable 로 해석. */
  updaterChannel?: UpdaterChannel
  /** events rotation cap(#126) 으로 폐기된 이벤트 누적 수. 미설정=0. 폐기 발생 시에만 기록(emptyState 엔 미포함). */
  droppedEventCount?: number
}
```
같은 파일 `StoreOptions`(64-73행)에 추가 — 닫는 `}` 직전:
```ts
  /** 변경 후 호출되는 영속화 훅 */
  persist?: (state: StoreState) => void
  /** events 상한(#126). 초과 시 가장 오래된 것부터 폐기. 미지정 기본 5000(테스트는 소형 값 주입). */
  eventCap?: number
}
```

- [ ] **Step 2: 실패 테스트 작성**

`src/main/core/store/store.test.ts` 의 `describe('memory store — chat & events', ...)` 블록 끝(120행 `})` 다음, 닫는 `})`(139행) **이전**에 아래 추가:
```ts
  describe('events rotation cap (#126)', () => {
    afterEach(() => vi.restoreAllMocks())

    it('cap 초과 시 events 가 상한을 넘지 않고 가장 오래된 것부터 폐기한다', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = createMemoryStore({ ...deterministic(), eventCap: 3 })
      for (let i = 0; i < 5; i++) store.appendEvent({ type: `e${i}` })
      const events = store.listEvents()
      expect(events).toHaveLength(3)
      // 최근 3건(e2·e3·e4)만 보존, e0·e1 폐기
      expect(events.map((e) => e.type)).toEqual(['e2', 'e3', 'e4'])
    })

    it('폐기량을 droppedEventCount 에 누적한다(snapshot 노출)', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = createMemoryStore({ ...deterministic(), eventCap: 2 })
      for (let i = 0; i < 5; i++) store.appendEvent({ type: `e${i}` })
      // 5건 중 2건 유지 → 3건 폐기
      expect(store.snapshot().droppedEventCount).toBe(3)
    })

    it('첫 폐기 시에만 console.warn 1회(이후 폐기엔 미호출)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = createMemoryStore({ ...deterministic(), eventCap: 2 })
      store.appendEvent({ type: 'e0' }) // 1건 — 미폐기
      store.appendEvent({ type: 'e1' }) // 2건 — 미폐기
      expect(warn).not.toHaveBeenCalled()
      store.appendEvent({ type: 'e2' }) // 3건째 → 첫 폐기 → 경고 1회
      store.appendEvent({ type: 'e3' }) // 추가 폐기 → 경고 미호출
      expect(warn).toHaveBeenCalledTimes(1)
      // 경고 메시지엔 cap·카운트만, 이벤트 내용 비노출
      const msg = warn.mock.calls[0]?.[0] as string
      expect(msg).toContain('2')
      expect(msg).not.toContain('e0')
    })

    it('cap 미만이면 폐기 0·droppedEventCount 미설정(기존 동작 무회귀)', () => {
      const store = createMemoryStore({ ...deterministic(), eventCap: 10 })
      store.appendEvent({ type: 'e0' })
      store.appendEvent({ type: 'e1' })
      expect(store.listEvents()).toHaveLength(2)
      expect(store.snapshot().droppedEventCount).toBeUndefined()
    })

    it('기본 cap 은 5000(미지정 시)', () => {
      const store = createMemoryStore(deterministic())
      for (let i = 0; i < 10; i++) store.appendEvent({ type: 'e' })
      expect(store.listEvents()).toHaveLength(10) // 5000 미만 → 전부 보존
      expect(store.snapshot().droppedEventCount).toBeUndefined()
    })
  })
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/main/core/store/store.test.ts -t "rotation cap"`
Expected: FAIL — `eventCap` 미적용으로 `toHaveLength(3)` 가 5, `droppedEventCount` 가 undefined.

- [ ] **Step 4: memory.ts 구현**

`src/main/core/store/memory.ts` 의 `createMemoryStore` 상단 — `now` 선언 다음, `state` 선언 다음 `if (!Array.isArray(...))` 직후에 `cap`·`enforceEventCap` 도입:
```ts
  const now = opts.now ?? (() => Date.now())
  const cap = opts.eventCap ?? 5000
  const state: StoreState = opts.initial ? structuredClone(opts.initial) : emptyState()
  // 손상 store 파일이 비배열 sessions(유효 JSON → .corrupt 미발동)를 실으면 putSession/deleteSession 의
  // findIndex 가 throw 한다. 로드 시 1회 정규화해 모든 소비처(CRUD·listSessions·엔진 복원 루프)를 보호한다.
  if (!Array.isArray(state.sessions)) state.sessions = []

  // events rotation cap(#126): 상한 초과 시 가장 오래된 것부터 폐기 + 누적 카운터. 매 append 마다 전체 state 를
  // 동기 재직렬화하므로(json-file.ts) cap 이 없으면 events 길이 N 에서 누적 O(N²). cap 으로 per-append O(cap) bounded.
  const enforceEventCap = (): void => {
    const overflow = state.events.length - cap
    if (overflow <= 0) return
    const firstDrop = (state.droppedEventCount ?? 0) === 0
    state.events.splice(0, overflow) // 앞(가장 오래된)부터 제거 — 삽입 순서 = 시간순
    state.droppedEventCount = (state.droppedEventCount ?? 0) + overflow
    if (firstDrop) {
      console.warn(
        `[fleet] 이벤트 로그 상한(${cap}) 도달 — 가장 오래된 이벤트부터 폐기(누적 ${state.droppedEventCount}건).`,
      )
    }
  }
```
그리고 `appendEvent`(현 148-159행)의 `state.events.push(event)` 와 `save()` 사이에 `enforceEventCap()` 삽입:
```ts
    appendEvent(input) {
      const event: FleetEvent = {
        id: idGen(),
        type: input.type,
        message: input.message,
        data: input.data ?? {},
        ts: now(),
      }
      state.events.push(event)
      enforceEventCap()
      save()
      return structuredClone(event)
    },
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/core/store/store.test.ts -t "rotation cap"`
Expected: PASS (5 테스트 전부 green).

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/store/types.ts src/main/core/store/memory.ts src/main/core/store/store.test.ts
git commit -m "feat(#126): events rotation cap(5000) + 폐기 카운터·count-only 경고"
```

---

### Task 2: 로드 시 1회 정규화 (비대 파일 즉시 치유)

**Files:**
- Modify: `src/main/core/store/memory.ts` (`createMemoryStore` 초기화에 `enforceEventCap()` 호출 추가)
- Test: `src/main/core/store/store.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `enforceEventCap()`·`cap`.

- [ ] **Step 1: 실패 테스트 작성**

`store.test.ts` 의 `describe('events rotation cap (#126)', ...)` 블록 안(Task 1 이 추가한 마지막 `it` 다음)에 추가:
```ts
    it('로드 시 initial.events 가 cap 초과면 store 생성 시 정규화한다', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const initial: StoreState = {
        projects: [],
        tasks: [],
        rooms: [],
        messages: [],
        events: [
          { id: 'a', type: 'old0', data: {}, ts: 1 },
          { id: 'b', type: 'old1', data: {}, ts: 2 },
          { id: 'c', type: 'keep0', data: {}, ts: 3 },
          { id: 'd', type: 'keep1', data: {}, ts: 4 },
        ],
        sessions: [],
      }
      const store = createMemoryStore({ ...deterministic(), eventCap: 2, initial })
      expect(store.listEvents().map((e) => e.type)).toEqual(['keep0', 'keep1'])
      expect(store.snapshot().droppedEventCount).toBe(2)
    })

    it('로드 정규화는 기존 droppedEventCount 에 누적한다', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const initial: StoreState = {
        projects: [],
        tasks: [],
        rooms: [],
        messages: [],
        events: [
          { id: 'a', type: 'old', data: {}, ts: 1 },
          { id: 'b', type: 'keep', data: {}, ts: 2 },
        ],
        sessions: [],
        droppedEventCount: 7,
      }
      const store = createMemoryStore({ ...deterministic(), eventCap: 1, initial })
      expect(store.snapshot().droppedEventCount).toBe(8) // 7 + 1
    })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/store/store.test.ts -t "로드"`
Expected: FAIL — 로드 시 cap 미적용으로 events 4건/2건 그대로, droppedEventCount 미설정/7.

- [ ] **Step 3: memory.ts 에 로드 정규화 호출 추가**

`src/main/core/store/memory.ts` 의 `enforceEventCap` 정의 **직후**(Task 1 에서 추가한 헬퍼 닫는 `}` 다음)에 1줄 추가:
```ts
    }
  }
  enforceEventCap() // 로드 시 1회 정규화 — 이미 비대해진 fleet-store.json 을 메모리에서 즉시 cap(다음 save 시 디스크 반영)

  const save = (): void => {
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/core/store/store.test.ts -t "로드"`
Expected: PASS (2 테스트 green).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/store/memory.ts src/main/core/store/store.test.ts
git commit -m "feat(#126): 로드 시 events cap 정규화 — 비대 파일 즉시 치유"
```

---

### Task 3: 소비처·영속 무회귀 가드 (구현 변경 없음)

**Files:**
- Test: `src/main/core/store/store.test.ts`

**Interfaces:**
- Consumes: Task 1·2 의 cap 동작. 새 프로덕션 코드 없음 — cap 이 소비처/영속에 새지 않음을 고정하는 회귀 가드.

- [ ] **Step 1: 회귀 테스트 작성**

`store.test.ts` 의 `describe('events rotation cap (#126)', ...)` 블록 안에 추가:
```ts
    it('cap 후에도 listProjectEvents 가 projectId 필터·task.progress 제외를 유지한다', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = createMemoryStore({ ...deterministic(), eventCap: 3 })
      store.appendEvent({ type: 'project.created', data: { projectId: 'p1' } }) // 폐기 대상
      store.appendEvent({ type: 'task.progress', data: { projectId: 'p1' } })
      store.appendEvent({ type: 'task.done', data: { projectId: 'p1' } })
      store.appendEvent({ type: 'task.done', message: '최신', data: { projectId: 'p1' } })
      // cap=3 → 가장 오래된 project.created 폐기. 남은 3건 중 task.progress 제외 → task.done 2건
      const events = store.listProjectEvents('p1')
      expect(events.map((e) => e.type)).toEqual(['task.done', 'task.done'])
    })
```

`store.test.ts` 의 `describe('json-file store', ...)` 블록 안에 추가(영속 왕복 후 cap 유지 + 카운터 생존):
```ts
    it('eventCap 을 적용하고 droppedEventCount 를 디스크 왕복 후에도 보존한다(#126)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const a = createJsonFileStore(dir, { ...deterministic(), eventCap: 2 })
      for (let i = 0; i < 5; i++) a.appendEvent({ type: `e${i}` })
      expect(a.listEvents()).toHaveLength(2)
      expect(a.snapshot().droppedEventCount).toBe(3)

      // 새 인스턴스로 reload — 디스크에 cap·카운터가 영속됐는지
      const b = createJsonFileStore(dir, { eventCap: 2 })
      expect(b.listEvents()).toHaveLength(2)
      expect(b.snapshot().droppedEventCount).toBe(3)
      warn.mockRestore()
    })
```

- [ ] **Step 2: 전체 store 테스트 통과 확인**

Run: `npx vitest run src/main/core/store/store.test.ts`
Expected: PASS — 신규 회귀 가드 포함 전부 green. 특히 기존 `starts empty when no file exists`·`fills missing top-level keys` 가 여전히 통과(`droppedEventCount` 를 emptyState/EMPTY 에 안 넣었으므로 `snapshot()` 6키 `toEqual` 무회귀).

- [ ] **Step 3: 커밋**

```bash
git add src/main/core/store/store.test.ts
git commit -m "test(#126): cap 후 소비처·디스크 영속 무회귀 가드"
```

---

### Task 4: 품질 게이트 + brain drift 확인

**Files:** 없음(검증).

- [ ] **Step 1: 5게이트 실행**

Run:
```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build
```
Expected: 전부 통과(경고 0). `format:check` 실패 시 `npm run format` 후 변경 파일만 재커밋.

- [ ] **Step 2: brain drift 확인**

Run: `npm run brain`
Expected: 새 파일 추가 없음(기존 파일만 수정) → `brain.md` 구조 변동 없음(의존/IPC 그래프 동일). diff 가 나오면 검토 후 커밋, 없으면 no-op.

- [ ] **Step 3: (drift 있을 때만) 커밋**

```bash
git add brain.md
git commit -m "chore(#126): brain.md 갱신"
```

---

## Self-Review

**1. Spec coverage:**
- cap=5000 + eventCap 주입 → Task 1 Step 1·4, 테스트 "기본 cap 5000".
- rotation(앞 splice) → Task 1 Step 4 `splice(0, overflow)`, 테스트 "가장 오래된 것부터 폐기".
- droppedEventCount 카운터 + snapshot 노출 → Task 1 "누적", Task 3 디스크 왕복.
- 첫 폐기 1회 경고·내용 비노출 → Task 1 "첫 폐기 1회".
- 로드 시 정규화 + 기존 카운터 누적 → Task 2.
- 소비처 무변경(listProjectEvents) → Task 3.
- emptyState/EMPTY 미변경 회귀 → Task 3 Step 2 명시.
- 5게이트 + brain → Task 4.
- 모든 spec 요구사항이 task 로 커버됨. 갭 없음.

**2. Placeholder scan:** "TBD"/"add error handling" 류 없음 — 모든 코드 step 에 실제 코드·실제 vitest `-t` 명령·기대 결과 포함.

**3. Type consistency:** `eventCap`·`droppedEventCount`·`enforceEventCap` 명칭이 Task 1→2→3 전반 동일. `StoreState` 필드는 Task 1 에서 선언, Task 2 테스트의 `initial: StoreState` 가 동일 타입 사용. `createMemoryStore`/`createJsonFileStore` 시그니처는 기존 그대로(`eventCap` 은 `StoreOptions` → `createJsonFileStore` 의 `Omit<StoreOptions,'initial'|'persist'>` 에 포함).

## 영향 파일 요약

| 파일 | 변경 |
|---|---|
| `src/main/core/store/types.ts` | `StoreOptions.eventCap?` · `StoreState.droppedEventCount?` |
| `src/main/core/store/memory.ts` | `cap`·`enforceEventCap()` 헬퍼 + `appendEvent` 배선 + 로드 정규화 호출 |
| `src/main/core/store/store.test.ts` | rotation cap·로드 정규화·소비처/영속 회귀 테스트군 |
| `src/main/core/store/json-file.ts` | **무변경** |

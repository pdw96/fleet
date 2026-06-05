# 프로젝트 탭 영속 "방 목록" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 채팅 탭처럼 프로젝트 탭에도 프로젝트가 "방 목록"으로 영속되어, 탭/창 전환·앱 재시작 후에도 진행 로그와 작업 보드가 저장소에서 복원되게 한다(보기 전용).

**Architecture:** 데이터(`projects[]`/`tasks[]`)는 이미 `fleet-store.json`에 영속된다. 채팅의 "마운트 시 저장소 재조회" 패턴을 `ProjectPanel`에 입히고, 진행 로그만 영속 가능하게 보강한다(`FleetEvent.message` 보존 + `projectId` 태깅 + `listProjectEvents`). 토큰 델타(`task.progress`)는 라이브 전용으로 영속 제외. 실행은 이미 메인 프로세스에서 돌므로 탭 전환 시 중단되지 않는다.

**Tech Stack:** Electron 33, React 18 + TypeScript, electron-vite, Vitest 2 + Testing Library, JSON-file 저장소.

> **스펙 대비 변경 1건(승인 필요 시 구현 전 확인):** 스펙 §3.1의 `StoreState.version` 필드는 **제외**한다. 이번 변경의 신규 필드는 전부 optional·additive 라 구(舊) store 파일이 그대로 로드되고(Task 3의 로드 머지로 보강), 실제 마이그레이션 코드가 이번 릴리스에 없으므로 YAGNI. 마이그레이션이 처음 생길 때 도입.

**검증 커맨드(전 구간 공통):** `npm test` (vitest run), `npm run typecheck`, `npm run lint`.

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/shared/types.ts` | 공유 타입·IPC 계약 | `FleetEvent.message?`, `StoreState`는 store/types 소관, `FleetBridge`에 3개 메서드 |
| `src/main/core/store/types.ts` | Store 인터페이스·StoreState | `StoreState.lastActiveProjectId?`, `Store.listProjectEvents`/`setLastActiveProject`, `appendEvent` 입력에 `message?` |
| `src/main/core/store/memory.ts` | 인메모리 store 구현 | 위 메서드 구현 + `appendEvent` message 보존 |
| `src/main/core/store/json-file.ts` | 디스크 영속 | 로드 시 결측 키 머지(전방 호환) |
| `src/main/core/orchestrator/orchestrator.ts` | 오케스트레이션 | `emit`: message+projectId 영속, `task.progress` 영속 제외 |
| `src/main/core/engine.ts` | 파사드 | `listProjectEvents`/`getLastActiveProject`/`setLastActiveProject` |
| `src/main/index.ts` | IPC 등록 | 3개 핸들러 |
| `src/preload/index.ts` | 렌더러 다리 | 3개 메서드 |
| `src/renderer/components/ProjectPanel.tsx` | 프로젝트 탭 UI | **재작성**: 사이드바 방 목록 + store 기준 보드/로그 |
| `src/renderer/styles.css` | 스타일 | `.project-layout`/`.project-main`/`.proj-*` 추가 |
| `*.test.ts(x)` | 테스트 | 각 Task에 추가/갱신 |

---

## Task 1: 공유 타입 확장 (types only)

**Files:**
- Modify: `src/shared/types.ts` (`FleetEvent` ~237-243, `FleetBridge` ~323-332)
- Modify: `src/main/core/store/types.ts` (`StoreState` 12-18, `Store` 32-80)

- [ ] **Step 1: `FleetEvent.message?` 추가**

`src/shared/types.ts`의 `FleetEvent`(현재):
```typescript
export interface FleetEvent {
  id: string
  type: string
  /** 자유 형식 payload */
  data: Record<string, unknown>
  ts: number
}
```
를 다음으로 변경:
```typescript
export interface FleetEvent {
  id: string
  type: string
  /** 사람이 읽는 진행 메시지(오케스트레이터 이벤트 재생용, 감사 이벤트엔 없을 수 있음). */
  message?: string
  /** 자유 형식 payload */
  data: Record<string, unknown>
  ts: number
}
```

- [ ] **Step 2: `FleetBridge`에 프로젝트 영속 메서드 3개 추가**

`src/shared/types.ts`의 `FleetBridge` 내 "프로젝트 / 오케스트레이션" 블록(`getProjectTasks` 줄 아래)에 추가:
```typescript
  /** 프로젝트의 진행 이벤트(영속된 마일스톤)를 시간순 반환. task.progress 토큰 델타는 제외. */
  listProjectEvents(projectId: string): Promise<FleetEvent[]>
  /** 마지막으로 본 프로젝트 id 조회(없으면 null). */
  getLastActiveProject(): Promise<string | null>
  /** 마지막으로 본 프로젝트 id 저장(null 이면 해제). */
  setLastActiveProject(projectId: string | null): Promise<void>
```
(`FleetEvent` 는 이미 같은 파일에 정의되어 있으므로 import 불필요.)

- [ ] **Step 3: `StoreState`에 `lastActiveProjectId?` 추가**

`src/main/core/store/types.ts`의 `StoreState`:
```typescript
export interface StoreState {
  projects: Project[]
  tasks: Task[]
  rooms: ChatRoom[]
  messages: ChatMessage[]
  events: FleetEvent[]
  /** 프로젝트 탭에서 마지막으로 본 프로젝트(렌더러 복원용). 미설정이면 부재. */
  lastActiveProjectId?: string
}
```

- [ ] **Step 4: `Store` 인터페이스에 메서드 추가 + `appendEvent` 입력 확장**

`src/main/core/store/types.ts`의 `Store` 인터페이스에서 audit 블록을 다음으로 변경:
```typescript
  // ── audit events ──
  appendEvent(input: { type: string; message?: string; data?: Record<string, unknown> }): FleetEvent
  listEvents(): FleetEvent[]
  /** 한 프로젝트의 영속 이벤트(시간순). task.progress 는 제외. */
  listProjectEvents(projectId: string): FleetEvent[]

  // ── ui 상태 ──
  setLastActiveProject(projectId: string | null): void
```

- [ ] **Step 5: 타입체크 — 미구현으로 실패 확인**

Run: `npm run typecheck`
Expected: FAIL — `memory.ts`가 `Store`의 `listProjectEvents`/`setLastActiveProject`를 구현하지 않아 오류.

- [ ] **Step 6: 커밋**

```bash
git add src/shared/types.ts src/main/core/store/types.ts
git commit -m "types: FleetEvent.message·StoreState.lastActiveProjectId·Store 프로젝트 이벤트 메서드 선언

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 메모리 스토어 구현 (appendEvent message · listProjectEvents · setLastActiveProject)

**Files:**
- Modify: `src/main/core/store/memory.ts`
- Test: `src/main/core/store/store.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/store/store.test.ts`의 `describe('memory store — chat & events', ...)` 블록 끝(닫는 `})` 직전)에 추가:
```typescript
  it('preserves message on appended events', () => {
    const store = createMemoryStore(deterministic())
    store.appendEvent({ type: 'task.done', message: '작업 완료', data: { projectId: 'p1' } })
    expect(store.listEvents()[0].message).toBe('작업 완료')
  })

  it('lists a project events in order and excludes task.progress', () => {
    const store = createMemoryStore(deterministic())
    store.appendEvent({ type: 'project.created', message: '생성', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.progress', message: '토큰', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.done', message: '완료', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.done', message: '다른 프로젝트', data: { projectId: 'p2' } })

    const events = store.listProjectEvents('p1')
    expect(events.map((e) => e.type)).toEqual(['project.created', 'task.done']) // progress 제외, p2 제외
    expect(events.map((e) => e.message)).toEqual(['생성', '완료'])
  })

  it('stores and exposes the last active project id', () => {
    const store = createMemoryStore(deterministic())
    expect(store.snapshot().lastActiveProjectId).toBeUndefined()
    store.setLastActiveProject('p9')
    expect(store.snapshot().lastActiveProjectId).toBe('p9')
    store.setLastActiveProject(null)
    expect(store.snapshot().lastActiveProjectId).toBeUndefined()
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- store.test`
Expected: FAIL — `listProjectEvents`/`setLastActiveProject`가 함수가 아님, `message` undefined.

- [ ] **Step 3: 구현**

`src/main/core/store/memory.ts`의 `appendMessage`/`appendEvent`는 message 미보존이다. `appendEvent`를 다음으로 교체(현재 144-154):
```typescript
    // ── audit events ──
    appendEvent(input) {
      const event: FleetEvent = {
        id: idGen(),
        type: input.type,
        message: input.message,
        data: input.data ?? {},
        ts: now(),
      }
      state.events.push(event)
      save()
      return structuredClone(event)
    },
    listEvents() {
      return structuredClone(state.events)
    },
    listProjectEvents(projectId) {
      // 토큰 델타(task.progress)는 영속 노이즈라 제외한다. 삽입 순서가 곧 시간순.
      return structuredClone(
        state.events.filter((e) => e.type !== 'task.progress' && e.data?.['projectId'] === projectId),
      )
    },
```
이어서 `// ── persistence ──` 블록 바로 위에 ui 상태 메서드를 추가:
```typescript
    // ── ui 상태 ──
    setLastActiveProject(projectId) {
      if (projectId) state.lastActiveProjectId = projectId
      else delete state.lastActiveProjectId
      save()
    },
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- store.test`
Expected: PASS (신규 3개 포함, 기존 빈-스냅샷 `toEqual` 테스트도 그대로 통과 — `lastActiveProjectId`는 미설정 시 부재).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/store/memory.ts src/main/core/store/store.test.ts
git commit -m "store: appendEvent message 보존·listProjectEvents·setLastActiveProject 구현

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: json-file 로드 머지 (전방 호환)

**Files:**
- Modify: `src/main/core/store/json-file.ts`
- Test: `src/main/core/store/store.test.ts`

신규 optional 필드가 없는 구(舊) 파일을 로드해도 결측 키가 기본값으로 채워지게 한다.

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/store/store.test.ts`의 `describe('json-file store', ...)` 블록 끝(닫는 `})` 직전)에 추가:
```typescript
  it('fills missing top-level keys when loading an older store file', () => {
    // lastActiveProjectId 없는 구버전 파일 + 신규 필드 부재
    writeFileSync(
      join(dir, 'fleet-store.json'),
      JSON.stringify({ projects: [{ id: 'p1', goal: 'g', title: 'T', status: 'done', createdAt: 0, updatedAt: 0 }] }),
      'utf8',
    )
    const s = createJsonFileStore(dir)
    expect(s.listProjects()).toHaveLength(1)
    expect(s.snapshot().tasks).toEqual([]) // 결측 배열이 기본값으로 보강됨
    expect(s.snapshot().events).toEqual([])
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- store.test`
Expected: FAIL — `parsed`에 `tasks`가 없어 `snapshot().tasks`가 `undefined` (또는 이후 접근 시 오류).

- [ ] **Step 3: 구현**

`src/main/core/store/json-file.ts`의 로드 부분(현재 22-34)에서 파싱 라인을 머지로 교체:
```typescript
  let initial: StoreState = EMPTY
  if (existsSync(file)) {
    try {
      // 결측 최상위 키를 EMPTY 기본값으로 보강(구버전 파일·부분 손상 방어).
      initial = { ...EMPTY, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreState>) }
    } catch {
      // 손상 파일을 덮어쓰기 전에 백업해 원본을 보존한다(조용한 데이터 손실 방지).
      try {
        renameSync(file, `${file}.corrupt`)
      } catch {
        /* 백업 실패는 무시하고 빈 상태로 진행 */
      }
      initial = EMPTY
    }
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- store.test`
Expected: PASS (신규 + 기존 json-file 테스트 모두).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/store/json-file.ts src/main/core/store/store.test.ts
git commit -m "store(json-file): 로드 시 결측 최상위 키 보강(전방 호환)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 오케스트레이터 emit — message·projectId 영속, task.progress 제외

**Files:**
- Modify: `src/main/core/orchestrator/orchestrator.ts` (`emit` 57-60, `project` 생성 66)
- Test: `src/main/core/orchestrator/orchestrator.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/orchestrator/orchestrator.test.ts`의 `describe('runProject', ...)` 안 맨 끝(파일 마지막 `})` 직전)에 추가. 구현 implementer가 `onChunk`를 호출하도록 만들어 `task.progress` 영속 제외를 검증한다:
```typescript
  it('persists milestones with message+projectId and does NOT persist task.progress', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add(fakeSession('planner', () => '[{"title":"T","description":"d"}]'))
    // 구현 세션이 토큰 델타(onChunk)를 흘리도록 한다.
    const impl: LlmSession = {
      id: 'impl',
      descriptor: { id: 'impl', kind: 'cli', displayName: 'impl', ref: 'impl', model: '' },
      async send(_p, opts) {
        opts?.onChunk?.('토큰1')
        opts?.onChunk?.('토큰2')
        return '구현'
      },
      async dispose() {},
    }
    sessions.add(impl)
    sessions.add(fakeSession('rev', () => 'APPROVE'))

    const result = await runProject('goal', {
      store,
      sessions,
      assignments: [
        { role: 'planner', llmId: 'planner' },
        { role: 'implementer', llmId: 'impl' },
        { role: 'reviewer', llmId: 'rev' },
      ],
      workspace: fakeWorkspace(),
      workspaceRoot: '/ws',
    })

    const persisted = store.listProjectEvents(result.projectId)
    // 모든 영속 이벤트가 해당 projectId 로 태깅된다.
    expect(persisted.every((e) => e.data['projectId'] === result.projectId)).toBe(true)
    // 마일스톤은 메시지와 함께 재생 가능.
    expect(persisted.some((e) => e.type === 'project.created' && !!e.message)).toBe(true)
    expect(persisted.some((e) => e.type === 'project.done' && !!e.message)).toBe(true)
    // task.progress(토큰 델타)는 영속되지 않는다(listProjectEvents 가 이미 필터하지만, 저장 자체가 안 됨).
    expect(store.listEvents().some((e) => e.type === 'task.progress')).toBe(false)
  })
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- orchestrator.test`
Expected: FAIL — 현재 emit이 `task.progress`를 store에 저장하고, message·projectId 를 빠뜨린다.

- [ ] **Step 3: 구현**

`src/main/core/orchestrator/orchestrator.ts`의 `emit`(현재 57-60)을 다음으로 교체:
```typescript
  // 현재 실행의 projectId — createProject 직후 설정되어 모든 영속 이벤트에 태깅된다.
  let currentProjectId: string | undefined
  const emit = (e: OrchestratorEvent): void => {
    // task.progress(토큰 델타)는 영속하지 않는다 — 재생 로그 노이즈 + 매 토큰 전체 스냅샷 재기록 방지(라이브 onEvent 만).
    if (e.type !== 'task.progress') {
      const pid =
        currentProjectId ?? (typeof e.data?.['projectId'] === 'string' ? (e.data['projectId'] as string) : undefined)
      store.appendEvent({
        type: e.type,
        message: e.message,
        data: { ...(e.data ?? {}), ...(pid ? { projectId: pid } : {}) },
      })
    }
    opts.onEvent?.(e)
  }
```
이어서 `const project = store.createProject({ goal })`(현재 66) 바로 다음 줄에 추가:
```typescript
  currentProjectId = project.id
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- orchestrator.test`
Expected: PASS (신규 + 기존 오케스트레이터 테스트 전부 — 기존 테스트는 `onEvent` 배열과 `listEvents`의 `project.done`/`task.self_review`만 보므로 영향 없음).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/orchestrator/orchestrator.ts src/main/core/orchestrator/orchestrator.test.ts
git commit -m "orchestrator: 마일스톤 이벤트에 message·projectId 영속, task.progress 영속 제외

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 엔진 — listProjectEvents · get/setLastActiveProject

**Files:**
- Modify: `src/main/core/engine.ts` (`FleetEngine` 인터페이스 98-119, 구현 232-238 근처)
- Test: `src/main/core/engine.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/engine.test.ts` 맨 끝에 새 describe 블록을 추가(파일 상단의 import에 `createMemoryStore`가 없으면 `import { createMemoryStore } from './store/memory'` 추가):
```typescript
describe('FleetEngine — 프로젝트 영속 읽기', () => {
  it('lists a project events via the store (excluding task.progress)', () => {
    const store = createMemoryStore({ idGen: (() => { let n = 0; return () => `id-${++n}` })(), now: () => 1 })
    store.appendEvent({ type: 'project.created', message: '생성', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.progress', message: '토큰', data: { projectId: 'p1' } })
    const engine = createFleetEngine({ store })
    const events = engine.listProjectEvents('p1')
    expect(events.map((e) => e.type)).toEqual(['project.created'])
    expect(events[0].message).toBe('생성')
  })

  it('round-trips the last active project id', () => {
    const engine = createFleetEngine({ store: createMemoryStore() })
    expect(engine.getLastActiveProject()).toBeNull()
    engine.setLastActiveProject('p7')
    expect(engine.getLastActiveProject()).toBe('p7')
    engine.setLastActiveProject(null)
    expect(engine.getLastActiveProject()).toBeNull()
  })
})
```
> 참고: 위에서 `task.progress`가 store에 들어간 건 테스트가 직접 `appendEvent`로 넣었기 때문이며, `listProjectEvents`의 필터가 제외하는지를 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `npm test -- engine.test`
Expected: FAIL — `engine.listProjectEvents`/`getLastActiveProject`/`setLastActiveProject`가 함수가 아님.

- [ ] **Step 3: 인터페이스 선언 추가**

`src/main/core/engine.ts`의 `FleetEngine` 인터페이스 "프로젝트 / 오케스트레이션" 블록에서 `getProjectTasks` 줄 아래에 추가:
```typescript
  /** 프로젝트의 영속 진행 이벤트(시간순, task.progress 제외). */
  listProjectEvents(projectId: string): FleetEvent[]
  /** 마지막으로 본 프로젝트 id(없으면 null). */
  getLastActiveProject(): string | null
  /** 마지막으로 본 프로젝트 id 저장(null 이면 해제). */
  setLastActiveProject(projectId: string | null): void
```

- [ ] **Step 4: 구현 추가**

`src/main/core/engine.ts`의 반환 객체에서 `getProjectTasks(projectId) { ... }` 바로 다음에 추가:
```typescript
    listProjectEvents(projectId) {
      return store.listProjectEvents(projectId)
    },

    getLastActiveProject() {
      return store.snapshot().lastActiveProjectId ?? null
    },

    setLastActiveProject(projectId) {
      store.setLastActiveProject(projectId)
    },
```

- [ ] **Step 5: 통과 확인**

Run: `npm test -- engine.test`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "engine: listProjectEvents·get/setLastActiveProject 위임

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: IPC + preload 배선

**Files:**
- Modify: `src/main/index.ts` (프로젝트 IPC 블록 74-88)
- Modify: `src/preload/index.ts` (프로젝트 다리 17-22)

> main/index.ts·preload는 얇은 패스-스루이며 코드베이스 관례상 단위 테스트가 없다(타입체크 + 렌더러/엔진 테스트로 커버). 본 Task는 테스트 대신 typecheck로 검증.

- [ ] **Step 1: IPC 핸들러 추가**

`src/main/index.ts`의 "프로젝트 / 오케스트레이션" 블록에서 `fleet:project:tasks` 줄 아래에 추가:
```typescript
  ipcMain.handle('fleet:project:events', (_e, projectId: string) => engine.listProjectEvents(projectId))
  ipcMain.handle('fleet:project:lastActive:get', () => engine.getLastActiveProject())
  ipcMain.handle('fleet:project:lastActive:set', (_e, projectId: string | null) =>
    engine.setLastActiveProject(projectId),
  )
```

- [ ] **Step 2: preload 다리 추가**

`src/preload/index.ts`의 "프로젝트 / 오케스트레이션" 블록에서 `getProjectTasks` 줄 아래에 추가:
```typescript
  listProjectEvents: (projectId) => ipcRenderer.invoke('fleet:project:events', projectId),
  getLastActiveProject: () => ipcRenderer.invoke('fleet:project:lastActive:get'),
  setLastActiveProject: (projectId) => ipcRenderer.invoke('fleet:project:lastActive:set', projectId),
```

- [ ] **Step 3: 타입체크 통과 확인**

Run: `npm run typecheck`
Expected: PASS — `FleetBridge`(Task 1)와 preload 구현이 일치.

- [ ] **Step 4: 커밋**

```bash
git add src/main/index.ts src/preload/index.ts
git commit -m "ipc: fleet:project:events·lastActive get/set 배선

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: ProjectPanel 재작성 (사이드바 방 목록 + store 기준 보드/로그)

**Files:**
- Modify (전면 교체): `src/renderer/components/ProjectPanel.tsx`
- Modify (전면 교체): `src/renderer/components/ProjectPanel.test.tsx`

- [ ] **Step 1: 테스트 파일 전면 교체(실패 상태)**

`src/renderer/components/ProjectPanel.test.tsx` 전체를 다음으로 교체:
```tsx
/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmDescriptor, OrchestratorEvent, Project, Task } from '../../shared/types'
import { ProjectPanel } from './ProjectPanel'

function mockFleet(overrides: Record<string, unknown> = {}) {
  let emit: ((e: OrchestratorEvent) => void) | undefined
  const fleet = {
    onOrchestratorEvent: vi.fn((cb: (e: OrchestratorEvent) => void) => {
      emit = cb
      return () => {
        emit = undefined
      }
    }),
    getWorkspace: vi.fn().mockResolvedValue(null),
    selectWorkspace: vi.fn().mockResolvedValue(null),
    runProject: vi.fn().mockResolvedValue({ projectId: 'p', tasks: [], summary: '' }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue([]),
    getProjectTasks: vi.fn().mockResolvedValue([]),
    listProjectEvents: vi.fn().mockResolvedValue([]),
    getLastActiveProject: vi.fn().mockResolvedValue(null),
    setLastActiveProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return Object.assign(fleet, { fire: (e: OrchestratorEvent) => act(() => emit?.(e)) })
}

const SESSION: LlmDescriptor = { id: 'llm-1', kind: 'cli', displayName: 'Claude', ref: 'claude' }
const P1: Project = { id: 'p1', goal: '로그인', title: '로그인 기능', status: 'done', createdAt: 1, updatedAt: 2 }
const P2: Project = { id: 'p2', goal: '결제', title: '결제 연동', status: 'executing', createdAt: 3, updatedAt: 4 }
const T1: Task = {
  id: 't1', projectId: 'p1', title: '구현 A', description: '', status: 'done',
  dependsOn: [], changedFiles: ['a.ts', 'b.ts'], createdAt: 0, updatedAt: 0,
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('ProjectPanel', () => {
  it('shows the workspace-inactive hint and disables run without sessions', async () => {
    mockFleet()
    render(<ProjectPanel sessions={[]} />)
    expect(await screen.findByText(/워크스페이스 미설정/)).toBeTruthy()
    const runBtn = screen.getByRole('button', { name: '오케스트레이션 실행' }) as HTMLButtonElement
    expect(runBtn.disabled).toBe(true)
  })

  it('shows the active workspace path when one is set', async () => {
    mockFleet({ getWorkspace: vi.fn().mockResolvedValue('/tmp/ws') })
    render(<ProjectPanel sessions={[]} />)
    expect(await screen.findByText(/산출물·검증 활성/)).toBeTruthy()
  })

  it('lists existing projects in the sidebar on mount', async () => {
    mockFleet({ listProjects: vi.fn().mockResolvedValue([P1, P2]) })
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('로그인 기능')).toBeTruthy()
    expect(screen.getByText('결제 연동')).toBeTruthy()
  })

  it('loads board and log from the store when a project is auto-selected', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks: vi.fn().mockResolvedValue([T1]),
      listProjectEvents: vi.fn().mockResolvedValue([
        { id: 'e1', type: 'plan.created', message: '2개 작업으로 분해', data: { projectId: 'p1' }, ts: 1 },
      ]),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy() // 보드: getProjectTasks 기준
    expect(screen.getByText('2개 작업으로 분해')).toBeTruthy() // 로그: listProjectEvents 기준
    expect(fleet.getProjectTasks).toHaveBeenCalledWith('p1')
    expect(fleet.listProjectEvents).toHaveBeenCalledWith('p1')
  })

  it('restores the board after unmount/remount without relying on the runProject return', async () => {
    mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks: vi.fn().mockResolvedValue([T1]),
    })
    const view = render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy()
    view.unmount()
    // 다른 탭 갔다 온 상황 — 새 인스턴스가 store 재조회만으로 복원(runProject 호출 없음).
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy()
  })

  it('ignores live events for a project other than the selected one', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    fleet.fire({ type: 'task.done', message: '다른 프로젝트 작업 완료', data: { projectId: 'OTHER' } })
    expect(screen.queryByText('다른 프로젝트 작업 완료')).toBeNull()
  })

  it('shows a 취소 button while running and calls cancelRun with the in-flight projectId', async () => {
    const fleet = mockFleet({ runProject: vi.fn(() => new Promise(() => {})) })
    render(<ProjectPanel sessions={[SESSION]} />)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    fleet.fire({ type: 'project.created', message: '프로젝트 생성', data: { projectId: 'proj-9' } })
    const cancelBtn = await screen.findByRole('button', { name: '취소' })
    fireEvent.click(cancelBtn)
    await act(async () => {})
    expect(fleet.cancelRun).toHaveBeenCalledWith('proj-9')
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- ProjectPanel`
Expected: FAIL — 신규 테스트들이 사이드바/store 로딩을 기대하나 현재 컴포넌트엔 없음.

- [ ] **Step 3: 컴포넌트 전면 교체**

`src/renderer/components/ProjectPanel.tsx` 전체를 다음으로 교체:
```tsx
import { useEffect, useRef, useState } from 'react'
import type { AgentRole, AssignmentPolicy, LlmDescriptor, Project, Task } from '../../shared/types'
import { ASSIGNABLE_ROLES } from '../../shared/types'
import { statusColor } from '../ui'

interface Props {
  sessions: LlmDescriptor[]
}

/** 진행 로그 한 줄 — 저장소 재생(FleetEvent)과 라이브(OrchestratorEvent)를 동일 형태로 보관. */
interface LogLine {
  type: string
  message: string
}

export function ProjectPanel({ sessions }: Props) {
  // 새 프로젝트 폼 상태
  const [goal, setGoal] = useState('')
  const [policy, setPolicy] = useState<AssignmentPolicy>('round-robin')
  const [manual, setManual] = useState<Partial<Record<AgentRole, string>>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  // 진행 중 실행의 projectId — 취소 버튼용. project.created 이벤트에서 잡는다.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  // 방 목록 + 선택된 프로젝트 상세(저장소 기준)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [log, setLog] = useState<LogLine[]>([])
  // 라이브 요약(영속 안 됨 — 실행 직후에만 표시).
  const [summary, setSummary] = useState('')

  // 비동기 콜백이 '도착 시점'의 선택 방을 알도록 최신 selectedId 를 ref 로 추적(스테일 클로저 방지).
  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  async function refreshProjects(): Promise<Project[]> {
    const list = await window.fleet.listProjects()
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt) // 최신순
    setProjects(sorted)
    return sorted
  }

  async function refreshTasks(projectId: string): Promise<void> {
    const t = await window.fleet.getProjectTasks(projectId)
    if (selectedIdRef.current === projectId) setTasks(t)
  }

  // 마운트: 방 목록 로드 + 마지막 보던(없으면 최신) 프로젝트 자동 선택.
  useEffect(() => {
    void (async () => {
      const list = await refreshProjects()
      const last = await window.fleet.getLastActiveProject()
      const pick = last && list.some((p) => p.id === last) ? last : (list[0]?.id ?? null)
      if (pick) setSelectedId(pick)
    })()
  }, [])

  // 마운트: 워크스페이스 상태.
  useEffect(() => {
    void window.fleet
      .getWorkspace()
      .then(setWorkspace)
      .catch(() => undefined)
  }, [])

  // 마운트: 오케스트레이터 라이브 이벤트 구독(방 필터는 selectedIdRef 로).
  useEffect(() => {
    const unsub = window.fleet.onOrchestratorEvent((e) => {
      const pid = typeof e.data?.['projectId'] === 'string' ? (e.data['projectId'] as string) : undefined
      // 취소 버튼용 in-flight id.
      if (e.type === 'project.created' && pid) {
        setActiveProjectId(pid)
        void refreshProjects()
        setSelectedId(pid) // 새 프로젝트를 바로 연다
      }
      if ((e.type === 'project.done' || e.type === 'run.cancelled') && pid) {
        setActiveProjectId((cur) => (cur === pid ? null : cur))
      }
      // 현재 열려 있는 프로젝트의 이벤트만 라이브 로그/보드에 반영(크로스-프로젝트 누수 방지).
      if (pid && pid === selectedIdRef.current) {
        setLog((prev) => [...prev, { type: e.type, message: e.message }])
        if (e.type !== 'task.progress') void refreshTasks(pid) // 보드는 마일스톤에서만 갱신
      }
    })
    return unsub
  }, [])

  // 선택 변경: 보드/로그를 저장소에서 로드 + 마지막 선택 영속.
  useEffect(() => {
    if (!selectedId) {
      setTasks([])
      setLog([])
      return
    }
    void window.fleet.setLastActiveProject(selectedId)
    void (async () => {
      const [t, ev] = await Promise.all([
        window.fleet.getProjectTasks(selectedId),
        window.fleet.listProjectEvents(selectedId),
      ])
      if (selectedIdRef.current !== selectedId) return // 응답 도착 시 다른 방이면 무시
      setTasks(t)
      setLog(ev.map((e) => ({ type: e.type, message: e.message ?? '' })))
      setSummary('') // 다른 방으로 전환 시 라이브 요약 초기화
    })()
  }, [selectedId])

  async function pickWorkspace() {
    try {
      setWorkspace(await window.fleet.selectWorkspace())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function cancel() {
    if (!activeProjectId) return
    try {
      await window.fleet.cancelRun(activeProjectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function run() {
    if (!goal.trim()) return
    setRunning(true)
    setError(null)
    setActiveProjectId(null)
    setSummary('')
    try {
      const assignments =
        policy === 'manual'
          ? ASSIGNABLE_ROLES.map((role) => ({ role, llmId: manual[role] ?? sessions[0]?.id ?? '' }))
          : undefined
      const r = await window.fleet.runProject({ goal: goal.trim(), policy, assignments })
      setSummary(r.summary)
      await refreshProjects()
      if (selectedIdRef.current) await refreshTasks(selectedIdRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      setActiveProjectId(null)
    }
  }

  const canRun = sessions.length > 0 && goal.trim().length > 0 && !running
  const llmName = (id?: string) => (id ? (sessions.find((s) => s.id === id)?.displayName ?? id) : undefined)
  // capability-scored 인데 어떤 세션에도 역량이 없으면 사실상 round-robin — 침묵 격하 경고(2개 이상일 때만 의미).
  const noCapsConfigured =
    policy === 'capability-scored' && sessions.length > 1 && !sessions.some((s) => s.capabilities?.length)
  const selected = projects.find((p) => p.id === selectedId)

  return (
    <div className="project-layout">
      <aside className="panel rooms">
        <span className="eyebrow">프로젝트</span>
        <button className="room-btn" data-active={selectedId === null} onClick={() => setSelectedId(null)}>
          + 새 프로젝트
        </button>
        {projects.map((p) => (
          <button key={p.id} className="room-btn" data-active={p.id === selectedId} onClick={() => setSelectedId(p.id)}>
            <span className="proj-title">{p.title}</span>
            <span className="proj-status" style={{ color: statusColor(p.status) }}>
              {p.status}
            </span>
          </button>
        ))}
        {projects.length === 0 && <p className="empty">프로젝트가 없습니다.</p>}
      </aside>

      <div className="project-main">
        {/* 새 프로젝트 폼 — 항상 표시(새 실행 시작 경로). */}
        <section className="panel">
          <div className="panel-head">
            <span className="eyebrow">01 — GOAL</span>
            <h2 className="panel-title">새 프로젝트</h2>
          </div>
          {sessions.length === 0 && (
            <p className="note-warn" style={{ marginTop: 0 }}>
              먼저 [세션] 탭에서 LLM 세션을 1개 이상 등록하세요.
            </p>
          )}
          <textarea
            className="field"
            placeholder="예: 사용자 인증이 있는 할 일 관리 REST API 를 만든다…"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <div className="row" style={{ alignItems: 'flex-end', marginTop: 12 }}>
            <div style={{ width: 220 }}>
              <label className="field-label">역할 배정 정책</label>
              <select className="field" value={policy} onChange={(e) => setPolicy(e.target.value as AssignmentPolicy)}>
                <option value="round-robin">round-robin</option>
                <option value="capability-scored">capability-scored</option>
                <option value="manual">manual</option>
              </select>
            </div>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={run} disabled={!canRun}>
              {running ? '실행 중…' : '오케스트레이션 실행'}
            </button>
            {running && activeProjectId && (
              <button className="btn btn-danger" onClick={() => void cancel()}>
                취소
              </button>
            )}
          </div>
          <div className="row" style={{ alignItems: 'center', marginTop: 12, gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => void pickWorkspace()}>
              워크스페이스 선택
            </button>
            <span className="meta">
              {workspace
                ? `산출물·검증 활성 → ${workspace}`
                : '워크스페이스 미설정 — 파일 기록/검증 비활성(텍스트 산출물만)'}
            </span>
          </div>
          {noCapsConfigured && (
            <p className="note-warn" style={{ marginBottom: 0 }}>
              capability-scored 선택됨 — 어떤 세션에도 역량이 설정되지 않아 사실상 round-robin 으로 동작합니다. [세션] 탭에서
              역할을 지정하세요.
            </p>
          )}
          {policy === 'manual' && sessions.length > 0 && (
            <div className="grid-2" style={{ marginTop: 12 }}>
              {ASSIGNABLE_ROLES.map((role) => (
                <div key={role}>
                  <label className="field-label">{role}</label>
                  <select
                    className="field"
                    value={manual[role] ?? sessions[0]?.id ?? ''}
                    onChange={(e) => setManual((m) => ({ ...m, [role]: e.target.value }))}
                  >
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          {error && <p className="note-bad" style={{ marginBottom: 0 }}>오류: {error}</p>}
        </section>

        {/* 선택된 프로젝트 — 저장소 기준 진행 로그 + 보드. 탭/창 전환·재마운트해도 복원된다. */}
        {selectedId && (
          <>
            <section className="panel">
              <div className="panel-head">
                <span className="eyebrow">02 — STREAM</span>
                <h2 className="panel-title">진행 상황{selected ? ` · ${selected.title}` : ''}</h2>
                {selected && (
                  <div className="right">
                    <span className="chip" style={{ color: statusColor(selected.status), borderColor: 'currentColor' }}>
                      {selected.status}
                    </span>
                  </div>
                )}
              </div>
              <div className="log">
                {log.length === 0 && <p className="empty">기록된 진행 로그가 없습니다.</p>}
                {log.map((e, i) => (
                  <div key={i} className="log-line">
                    <span className="t">{e.type}</span>
                    <span>{e.message}</span>
                  </div>
                ))}
              </div>
            </section>

            {tasks.length > 0 && (
              <section className="panel">
                <div className="panel-head">
                  <span className="eyebrow">03 — BOARD</span>
                  <h2 className="panel-title">작업 보드</h2>
                  <div className="right">
                    <span className="chip">{tasks.length} tasks</span>
                  </div>
                </div>
                <ul className="list">
                  {tasks.map((t) => (
                    <li key={t.id} className="line-item">
                      <span
                        className="chip"
                        style={{ color: statusColor(t.status), borderColor: 'currentColor', minWidth: 62, justifyContent: 'center' }}
                      >
                        {t.status === 'skipped' ? '건너뜀' : t.status}
                      </span>
                      <span className="name">{t.title}</span>
                      {t.role && <span className="meta">{t.role}</span>}
                      {t.assignedLlmId && (
                        <span className="meta" title="실행 LLM" style={{ color: 'var(--accent, currentColor)' }}>
                          → {llmName(t.assignedLlmId)}
                        </span>
                      )}
                      {t.changedFiles && t.changedFiles.length > 0 && (
                        <span className="chip" title={t.changedFiles.join('\n')} style={{ marginLeft: 'auto' }}>
                          변경 {t.changedFiles.length}개
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {summary && (
              <section className="panel">
                <div className="panel-head">
                  <span className="eyebrow">04 — SUMMARY</span>
                  <h2 className="panel-title">최종 요약 / 누락 점검</h2>
                </div>
                <pre className="summary">{summary}</pre>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- ProjectPanel`
Expected: PASS (7개 모두).

- [ ] **Step 5: 커밋**

```bash
git add src/renderer/components/ProjectPanel.tsx src/renderer/components/ProjectPanel.test.tsx
git commit -m "ProjectPanel: 사이드바 방 목록 + store 기준 보드/로그(마운트 재조회로 복원)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: CSS — 프로젝트 레이아웃

**Files:**
- Modify: `src/renderer/styles.css` (채팅 섹션 끝부분 뒤에 추가)

- [ ] **Step 1: 스타일 추가**

`src/renderer/styles.css`의 채팅 관련 규칙들 뒤(예: `.chat-main`/`.transcript` 블록 다음)에 추가:
```css
/* ── 프로젝트 ─────────────────────────────────────────────────────────── */
.project-layout {
  display: grid;
  grid-template-columns: 232px 1fr;
  gap: 18px;
  align-items: start;
}
.project-main {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.project-layout .room-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.proj-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-status {
  font-family: var(--mono);
  font-size: 11px;
  flex-shrink: 0;
}
```

- [ ] **Step 2: 빌드/타입체크로 회귀 없음 확인**

Run: `npm run build`
Expected: PASS (renderer 번들에 CSS 포함, 오류 없음).

- [ ] **Step 3: 커밋**

```bash
git add src/renderer/styles.css
git commit -m "styles: 프로젝트 탭 사이드바 레이아웃(.project-layout/.proj-*)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 전체 검증

- [ ] **Step 1: 전체 테스트**

Run: `npm test`
Expected: PASS — 전 스위트 그린(신규 store/orchestrator/engine/ProjectPanel 테스트 포함).

- [ ] **Step 2: 타입체크 + 린트**

Run: `npm run typecheck && npm run lint`
Expected: PASS, 경고/오류 없음.

- [ ] **Step 3: 스모크(메인 부팅 + IPC 등록)**

Run (PowerShell): `$env:FLEET_SMOKE='1'; npm run build; npx electron . ; Remove-Item Env:FLEET_SMOKE`
Expected: 메인 프로세스 부팅 → IPC 등록 → 윈도우 생성 후 ~2초 뒤 종료(0). 콘솔에 영속화/IPC 오류 없음.
> 헤드리스 CI라 GUI를 못 띄우면 이 단계는 생략하고 수동 `npm run dev`로 대체.

- [ ] **Step 4: 수동 확인(선택, `npm run dev`)**

다음을 눈으로 확인:
1. 프로젝트 실행 → 사이드바에 새 방 생성·선택됨, 진행 로그·보드 라이브 갱신.
2. [채팅] 탭으로 갔다가 [프로젝트] 탭 복귀 → 보드·진행 로그가 그대로 복원(빈 화면 아님).
3. 앱 재시작 → 프로젝트 방 목록·선택 프로젝트의 보드/로그가 마지막 상태로 복원(단, 실행 재개는 안 됨 — 설계 범위).

---

## Self-Review (작성자 점검 결과)

**Spec coverage:**
- §3.1 데이터(message·lastActiveProjectId·listProjectEvents) → Task 1·2. `version` 제외(상단 노트로 변경 명시). ✓
- §3.2 task.progress 영속 제외 → Task 4. ✓
- §3.3 메인/IPC(emit·engine·IPC·preload) → Task 4·5·6. ✓
- §3.4 ProjectPanel 재작성(마운트 재조회·projectId 라이브 필터·lastActive) → Task 7. ✓
- §3.5 App.tsx 무변경 → 계획에 변경 없음(언마운트 유지, 마운트 재조회로 복원). ✓
- §2.5 실행 지속성 → 코드 무변경(이미 메인 프로세스). Task 9 Step4 수동확인 2번으로 검증. ✓
- §6 테스트 → 각 Task의 TDD 스텝. ✓

**Placeholder scan:** "TBD/적절히/등" 없음. 모든 코드 스텝에 실제 코드 포함. ✓

**Type consistency:** `listProjectEvents`(Store/Engine/Bridge 동일 시그니처), `setLastActiveProject(projectId: string|null)`, `getLastActiveProject(): string|null`(Engine)/`Promise<string|null>`(Bridge), `FleetEvent.message?: string`, `LogLine{type,message}` — Task 1↔5↔7 간 일치 확인. ✓

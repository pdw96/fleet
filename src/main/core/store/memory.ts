import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRoom, FleetEvent, Project, Task } from '../../../shared/types'
import type { Store, StoreOptions, StoreState } from './types'

const emptyState = (): StoreState => ({
  projects: [],
  tasks: [],
  rooms: [],
  messages: [],
  events: [],
  sessions: [],
})

/** 목표 문자열에서 짧은 제목 도출. */
function deriveTitle(goal: string): string {
  const firstLine = goal.trim().split('\n')[0]?.trim() ?? '제목 없음'
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine
}

/**
 * 순수 인메모리 저장소. Electron/디스크 비의존 → vitest 로 직접 검증 가능.
 * 영속화가 필요하면 opts.persist 훅으로 스냅샷을 받아 직렬화한다 (json-file.ts 참조).
 */
export function createMemoryStore(opts: StoreOptions = {}): Store {
  const idGen = opts.idGen ?? (() => randomUUID())
  const now = opts.now ?? (() => Date.now())
  const cap = opts.eventCap && opts.eventCap > 0 ? opts.eventCap : 5000 // 0/음수는 전부 폐기(조용한 손실) → 기본값 폴백
  const state: StoreState = opts.initial ? structuredClone(opts.initial) : emptyState()
  // 손상 store 파일이 비배열 sessions(유효 JSON → .corrupt 미발동)를 실으면 putSession/deleteSession 의
  // findIndex 가 throw 한다. 로드 시 1회 정규화해 모든 소비처(CRUD·listSessions·엔진 복원 루프)를 보호한다.
  if (!Array.isArray(state.sessions)) state.sessions = []
  // 손상 파일이 비배열 events(유효 JSON → .corrupt 미발동)를 실으면 아래 로드 정규화의 length/splice 가
  // throw → UI 열기 전 부팅 크래시. sessions 와 동일 손상 클래스 — 로드 시 1회 정규화로 방어(#126 Codex 리뷰).
  if (!Array.isArray(state.events)) state.events = []

  // 이벤트 커서 seq 정규화(#197 B1): 구파일(seq 미보유)·신규파일 공통. store 가 유일 스탬프 지점이라
  // 로드 시 불변식(모든 이벤트 numeric seq · eventSeq=최대)을 복원한다. enforceEventCap 전에 실행해
  // 폐기 후에도 남은 이벤트가 배정 당시 seq 를 유지하게 한다(재번호 금지). seq 는 비음수 정수만 유효로 봐
  // 손상 파일(유효 JSON·잘못된 타입 — sessions=42·events=42 와 동일 위협 클래스)의 오염을 걸러낸다.
  {
    const validSeq = (v: unknown): v is number =>
      typeof v === 'number' && Number.isInteger(v) && v >= 0
    let maxSeq = validSeq(state.eventSeq) ? state.eventSeq : 0
    // 1패스: 기존 유효 seq 최대(신규파일은 이미 seq 보유 — 백필하지 않고 카운터 하한만 확보).
    for (const e of state.events) {
      if (validSeq(e.seq) && e.seq > maxSeq) maxSeq = e.seq
    }
    // 2패스: seq 미보유(구파일)·손상 seq 만 배열 순서(=시간순)로 백필 — 기존 최대 위로 배정해 충돌을 막는다.
    for (const e of state.events) {
      if (!validSeq(e.seq)) e.seq = ++maxSeq
    }
    // maxSeq>0 이면 카운터 확정, 아니면 손상 eventSeq(문자열·음수·비정수)를 제거한다 — 남기면 appendEvent
    // 의 `(state.eventSeq ?? 0)+1` 이 'x'+1='x1'·-4 로 seq 를 오염시킨다(?? 는 null/undefined 만 거름).
    if (maxSeq > 0) state.eventSeq = maxSeq
    else delete state.eventSeq // 0/부재/손상 → 미기록(빈 상태·구파일 무회귀)
  }

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
  enforceEventCap() // 로드 시 1회 정규화 — 이미 비대해진 fleet-store.json 을 메모리에서 즉시 cap(다음 save 시 디스크 반영)

  const save = (): void => {
    if (opts.persist) opts.persist(structuredClone(state))
  }

  const store: Store = {
    // ── projects ──
    createProject(input) {
      const ts = now()
      const project: Project = {
        id: idGen(),
        goal: input.goal,
        title: input.title ?? deriveTitle(input.goal),
        status: 'planning',
        createdAt: ts,
        updatedAt: ts,
      }
      state.projects.push(project)
      save()
      return structuredClone(project)
    },
    getProject(id) {
      const p = state.projects.find((x) => x.id === id)
      return p ? structuredClone(p) : undefined
    },
    listProjects() {
      return structuredClone(state.projects)
    },
    updateProject(id, patch) {
      const p = state.projects.find((x) => x.id === id)
      if (!p) return undefined
      if (patch.title !== undefined) p.title = patch.title
      if (patch.status !== undefined) p.status = patch.status
      p.updatedAt = now()
      save()
      return structuredClone(p)
    },

    // ── tasks ──
    createTask(input) {
      const ts = now()
      const task: Task = {
        id: idGen(),
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        status: 'pending',
        role: input.role,
        dependsOn: input.dependsOn ?? [],
        createdAt: ts,
        updatedAt: ts,
      }
      state.tasks.push(task)
      save()
      return structuredClone(task)
    },
    getTask(id) {
      const t = state.tasks.find((x) => x.id === id)
      return t ? structuredClone(t) : undefined
    },
    listTasks(projectId) {
      return structuredClone(state.tasks.filter((t) => t.projectId === projectId))
    },
    updateTask(id, patch) {
      const t = state.tasks.find((x) => x.id === id)
      if (!t) return undefined
      if (patch.status !== undefined) t.status = patch.status
      if (patch.role !== undefined) t.role = patch.role
      if (patch.assignedLlmId !== undefined) t.assignedLlmId = patch.assignedLlmId
      if (patch.output !== undefined) t.output = patch.output
      if (patch.title !== undefined) t.title = patch.title
      if (patch.description !== undefined) t.description = patch.description
      if (patch.dependsOn !== undefined) t.dependsOn = patch.dependsOn
      if (patch.changedFiles !== undefined) t.changedFiles = patch.changedFiles
      if (patch.checkpoint !== undefined) t.checkpoint = patch.checkpoint
      t.updatedAt = now()
      save()
      return structuredClone(t)
    },

    // ── chat rooms + messages ──
    createRoom(input) {
      const room: ChatRoom = {
        id: idGen(),
        title: input.title,
        participants: input.participants ?? [],
        createdAt: now(),
      }
      state.rooms.push(room)
      save()
      return structuredClone(room)
    },
    getRoom(id) {
      const r = state.rooms.find((x) => x.id === id)
      return r ? structuredClone(r) : undefined
    },
    listRooms() {
      return structuredClone(state.rooms)
    },
    appendMessage(input) {
      const message: ChatMessage = {
        id: idGen(),
        roomId: input.roomId,
        author: input.author,
        role: input.role,
        content: input.content,
        ts: now(),
      }
      state.messages.push(message)
      save()
      return structuredClone(message)
    },
    listMessages(roomId) {
      return structuredClone(state.messages.filter((m) => m.roomId === roomId))
    },

    // ── audit events ──
    appendEvent(input) {
      // 단조 seq 스탬프(#197 B1) — rotation 폐기와 무관하게 카운터는 증가만(재사용 없음).
      const seq = (state.eventSeq ?? 0) + 1
      state.eventSeq = seq
      const event: FleetEvent = {
        id: idGen(),
        seq,
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
    listEvents() {
      return structuredClone(state.events)
    },
    listProjectEvents(projectId) {
      // 토큰 델타(task.progress)는 영속 노이즈라 제외한다. 삽입 순서가 곧 시간순.
      return structuredClone(
        state.events.filter(
          (e) => e.type !== 'task.progress' && e.data?.['projectId'] === projectId,
        ),
      )
    },
    eventCursor() {
      const maxEventSeq = state.eventSeq ?? 0
      // 최소 보존 seq = 가장 오래된(앞) 이벤트의 seq. 로드 백필로 events 는 항상 numeric seq 를 가지나
      // 방어적으로 타입 가드. 비어있으면 "다음 생성 seq"(maxEventSeq+1)라 커서 0 은 갭 없음으로 판정된다.
      const oldest = state.events[0]?.seq
      const minRetainedEventSeq = typeof oldest === 'number' ? oldest : maxEventSeq + 1
      return { maxEventSeq, minRetainedEventSeq }
    },

    // ── ui 상태 ──
    setLastActiveProject(projectId) {
      if (projectId) state.lastActiveProjectId = projectId
      else delete state.lastActiveProjectId
      save()
    },
    getLastActiveProjectId() {
      return state.lastActiveProjectId
    },

    // ── updater 채널(#98) ──
    getUpdaterChannel() {
      return state.updaterChannel ?? 'stable' // 미설정(구버전·신규)은 안전 기본 stable
    },
    setUpdaterChannel(channel) {
      state.updaterChannel = channel
      save()
    },

    // ── persisted sessions ──
    putSession(session) {
      // upsert-by-id 만 — 배열을 filter-rewrite 하지 않아 미지 kind 엔트리(전방호환)를 보존한다.
      const i = state.sessions.findIndex((s) => s.id === session.id)
      if (i >= 0) state.sessions[i] = session
      else state.sessions.push(session)
      save()
    },
    deleteSession(id) {
      const i = state.sessions.findIndex((s) => s.id === id)
      if (i >= 0) {
        state.sessions.splice(i, 1)
        save()
      }
    },
    patchSessionCapabilities(id, capabilities) {
      const s = state.sessions.find((x) => x.id === id)
      if (s) {
        s.capabilities = [...capabilities]
        save()
      }
    },
    listSessions() {
      return structuredClone(state.sessions)
    },

    // ── persistence ──
    snapshot() {
      return structuredClone(state)
    },
  }

  return store
}

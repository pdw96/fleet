import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRoom, FleetEvent, Project, Task } from '../../../shared/types'
import type { Store, StoreOptions, StoreState } from './types'

const emptyState = (): StoreState => ({
  projects: [],
  tasks: [],
  rooms: [],
  messages: [],
  events: [],
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
  const state: StoreState = opts.initial ? structuredClone(opts.initial) : emptyState()

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
      const event: FleetEvent = {
        id: idGen(),
        type: input.type,
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

    // ── persistence ──
    snapshot() {
      return structuredClone(state)
    },
  }

  return store
}

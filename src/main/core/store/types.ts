import type {
  AgentRole,
  ChatAuthor,
  ChatMessage,
  ChatRoom,
  FleetEvent,
  Project,
  Task,
} from '../../../shared/types'

/** 직렬화 가능한 전체 상태 스냅샷. */
export interface StoreState {
  projects: Project[]
  tasks: Task[]
  rooms: ChatRoom[]
  messages: ChatMessage[]
  events: FleetEvent[]
}

export interface StoreOptions {
  /** id 생성기 (테스트에서 결정론적 주입) */
  idGen?: () => string
  /** 시계 (테스트에서 고정값 주입) */
  now?: () => number
  /** 초기 상태 (영속 저장소에서 로드) */
  initial?: StoreState
  /** 변경 후 호출되는 영속화 훅 */
  persist?: (state: StoreState) => void
}

/** 상태 + 대화 로그 + 감사 이벤트 저장소 (요구사항 6,7). */
export interface Store {
  // ── projects ──
  createProject(input: { goal: string; title?: string }): Project
  getProject(id: string): Project | undefined
  listProjects(): Project[]
  updateProject(id: string, patch: Partial<Pick<Project, 'title' | 'status'>>): Project | undefined

  // ── tasks ──
  createTask(input: {
    projectId: string
    title: string
    description: string
    role?: AgentRole
    dependsOn?: string[]
  }): Task
  getTask(id: string): Task | undefined
  listTasks(projectId: string): Task[]
  updateTask(
    id: string,
    patch: Partial<Pick<Task, 'status' | 'role' | 'assignedLlmId' | 'output' | 'title' | 'description'>>,
  ): Task | undefined

  // ── chat rooms + messages ──
  createRoom(input: { title: string; participants?: string[] }): ChatRoom
  getRoom(id: string): ChatRoom | undefined
  listRooms(): ChatRoom[]
  appendMessage(input: { roomId: string; author: ChatAuthor; role?: AgentRole; content: string }): ChatMessage
  listMessages(roomId: string): ChatMessage[]

  // ── audit events ──
  appendEvent(input: { type: string; data?: Record<string, unknown> }): FleetEvent
  listEvents(): FleetEvent[]

  // ── persistence ──
  snapshot(): StoreState
}

import type {
  AgentRole,
  ApiProviderConfig,
  ChatAuthor,
  ChatMessage,
  ChatRoom,
  FleetEvent,
  Project,
  Task,
  UpdaterChannel,
} from '../../../shared/types'

/** 재시작 간 복원할 직렬화 세션. cli|api 판별 유니온. */
export type PersistedSession = PersistedCliSession | PersistedApiSession

/**
 * CLI 세션(#52). 구독 CLI 는 자체 인증을 가져 저장할 비밀값이 없다.
 * mcpConfig 는 의도적 제외(인라인 JSON 이 secret 운반 가능 → 평문 영속 금지).
 */
export type PersistedCliSession = {
  kind: 'cli'
  /** 디스크립터 id (= `cli:${adapterId}`). upsert/삭제 키. */
  id: string
  /** CliAdapter.id. 복원 시 cli/registry 조회 키. */
  adapterId: string
  /** 빈 문자열/미지정이면 CLI 기본 모델. */
  model?: string
  stateful?: boolean
  /** 사용자 수정 가능 → 복원 시 재시드하지 않고 이 값을 적용. */
  capabilities?: AgentRole[]
}

/**
 * API 세션(Epic B). apiKey 는 평문 미기록 — safeStorage 암호문(base64+버전프리픽스)만.
 * config 는 ApiProviderConfig 에서 apiKey 만 뺀 나머지(provider/model/displayName/baseUrl/thinking 등 비밀 아님).
 */
export type PersistedApiSession = {
  kind: 'api'
  /** 디스크립터 id (= `api:${config.id}`). upsert/삭제 키. */
  id: string
  /** apiKey 제외 — 복원 시 decrypt 한 키와 합쳐 라이브 재구성. */
  config: Omit<ApiProviderConfig, 'apiKey'>
  /** safeStorage 암호화된 apiKey 토큰. 복호화 실패/미지 포맷이면 복원 skip. */
  encryptedApiKey: string
  /** 사용자 수정 가능 → 복원 시 재시드하지 않고 이 값을 적용. */
  capabilities?: AgentRole[]
}

/** 직렬화 가능한 전체 상태 스냅샷. */
export interface StoreState {
  projects: Project[]
  tasks: Task[]
  rooms: ChatRoom[]
  messages: ChatMessage[]
  events: FleetEvent[]
  /** 재시작 복원용 영속 세션 디스크립터(cli·api 판별 유니온 — 평문 apiKey 미기록, secret 은 암호문만). */
  sessions: PersistedSession[]
  /** 프로젝트 탭에서 마지막으로 본 프로젝트(렌더러 복원용). 미설정이면 부재. */
  lastActiveProjectId?: string
  /** 자동 업데이트 채널 선호(#98). 미설정(구버전 파일·신규)이면 stable 로 해석. */
  updaterChannel?: UpdaterChannel
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
    patch: Partial<
      Pick<
        Task,
        | 'status'
        | 'role'
        | 'assignedLlmId'
        | 'output'
        | 'title'
        | 'description'
        | 'dependsOn'
        | 'changedFiles'
        | 'checkpoint'
      >
    >,
  ): Task | undefined

  // ── chat rooms + messages ──
  createRoom(input: { title: string; participants?: string[] }): ChatRoom
  getRoom(id: string): ChatRoom | undefined
  listRooms(): ChatRoom[]
  appendMessage(input: {
    roomId: string
    author: ChatAuthor
    role?: AgentRole
    content: string
  }): ChatMessage
  listMessages(roomId: string): ChatMessage[]

  // ── audit events ──
  appendEvent(input: { type: string; message?: string; data?: Record<string, unknown> }): FleetEvent
  listEvents(): FleetEvent[]
  /** 한 프로젝트의 영속 이벤트(시간순). task.progress 는 제외. */
  listProjectEvents(projectId: string): FleetEvent[]

  // ── ui 상태 ──
  /** 마지막 본 프로젝트 저장. */
  setLastActiveProject(projectId: string | null): void
  /** 마지막 본 프로젝트 id 경량 읽기 — 전체 상태 clone(snapshot) 없이 한 필드만 반환. */
  getLastActiveProjectId(): string | undefined

  /** 업데이트 채널 경량 읽기 — 미설정이면 기본 'stable'. #98 */
  getUpdaterChannel(): UpdaterChannel
  /** 업데이트 채널 영속 설정. #98 */
  setUpdaterChannel(channel: UpdaterChannel): void

  // ── persisted sessions (재시작 복원) ──
  /** CLI 세션 디스크립터 upsert(id 키). engine.removeSession 과 구분 위해 delete-. */
  putSession(session: PersistedSession): void
  deleteSession(id: string): void
  listSessions(): PersistedSession[]
  /** 영속 세션의 capabilities 만 in-place 갱신(부재 시 no-op). 키 재암호화 없이 capabilities 만 바꾸는 경로. */
  patchSessionCapabilities(id: string, capabilities: AgentRole[]): void

  // ── persistence ──
  snapshot(): StoreState
}

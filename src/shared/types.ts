/**
 * 단일 진실 원천 타입 — main / preload / renderer 가 공유한다.
 * 런타임/DOM/Node 의존이 없는 순수 타입 선언만 둔다.
 */

// ── 앱 메타 ────────────────────────────────────────────────────────────────
export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
}

// ── LLM 연결 ────────────────────────────────────────────────────────────────
export type LlmConnectionKind = 'cli' | 'api'

/** 등록 가능한 CLI 어댑터 (요구사항 2A). 새 CLI 는 이 형태로 레지스트리에 추가. */
export interface CliAdapter {
  id: string
  displayName: string
  /** 실행 명령 (예: 'claude') */
  command: string
  /** 버전 확인 인자 (예: ['--version']) */
  versionArgs: string[]
  /** TUI 세션 spawn 시 인자 (없으면 대화형 기본 실행) */
  spawnArgs?: string[]
  /** 헤드리스(비대화형) 1회 실행 인자 템플릿. '{prompt}' 토큰이 프롬프트로 치환된다. */
  headless?: { args: string[] }
}

/** CLI 감지 결과 — IPC 로 renderer 에 전달. */
export interface CliDetectionResult {
  id: string
  displayName: string
  command: string
  kind: 'cli'
  installed: boolean
  version?: string
  /** 원본 --version 출력 */
  raw?: string
  error?: string
}

/** API provider 설정 (요구사항 2B). */
export interface ApiProviderConfig {
  id: string
  provider: 'anthropic' | 'openai' | 'google'
  displayName: string
  model: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
}

/** 등록된 LLM 디스크립터 (CLI 또는 API 통합). */
export interface LlmDescriptor {
  id: string
  kind: LlmConnectionKind
  displayName: string
  /** kind==='cli' → CliAdapter.id, kind==='api' → ApiProviderConfig.id */
  ref: string
  model?: string
}

// ── 채팅 / 메시지 (요구사항 3) ────────────────────────────────────────────
export type ChatAuthor = { type: 'user' } | { type: 'system' } | { type: 'llm'; llmId: string }

export interface ChatMessage {
  id: string
  roomId: string
  author: ChatAuthor
  /** 발화 시의 역할(있으면) */
  role?: AgentRole
  content: string
  /** epoch ms */
  ts: number
}

export interface ChatRoom {
  id: string
  title: string
  /** 참여 LLM id 목록 */
  participants: string[]
  createdAt: number
}

// ── 오케스트레이션 (요구사항 4,5) ──────────────────────────────────────────
export type AgentRole =
  | 'planner'
  | 'architect'
  | 'implementer'
  | 'reviewer'
  | 'tester'
  | 'critic'
  | 'summarizer'

export interface RoleAssignment {
  role: AgentRole
  llmId: string
}

export type AssignmentPolicy = 'manual' | 'round-robin' | 'capability-scored'

export type TaskStatus = 'pending' | 'running' | 'review' | 'done' | 'failed'

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  /** 담당 역할 */
  role?: AgentRole
  /** 배정된 LLM */
  assignedLlmId?: string
  /** 의존 작업 id */
  dependsOn: string[]
  /** 산출물 요약 */
  output?: string
  createdAt: number
  updatedAt: number
}

export interface Project {
  id: string
  goal: string
  title: string
  status: 'planning' | 'executing' | 'verifying' | 'done' | 'failed'
  createdAt: number
  updatedAt: number
}

// ── 검증 (요구사항 5) ──────────────────────────────────────────────────────
export type VerifyKind = 'test' | 'lint' | 'typecheck' | 'smoke' | 'custom'

export interface VerificationResult {
  kind: VerifyKind
  command: string
  passed: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** 실패 원인 분석(선택) */
  analysis?: string
  durationMs: number
}

// ── 안전 (요구사항 6) ──────────────────────────────────────────────────────
export type RiskLevel = 'safe' | 'caution' | 'destructive'

export interface ApprovalRequest {
  id: string
  kind: 'file-write' | 'file-delete' | 'shell'
  summary: string
  /** 대상 경로 또는 명령 */
  target: string
  risk: RiskLevel
  ts: number
}

export type ApprovalDecision = 'approved' | 'rejected'

// ── 감사 로그 (요구사항 6) ────────────────────────────────────────────────
export interface FleetEvent {
  id: string
  type: string
  /** 자유 형식 payload */
  data: Record<string, unknown>
  ts: number
}

// ── 오케스트레이션 결과 / 이벤트 (IPC 계약 표면) ─────────────────────────────
export interface RunResult {
  projectId: string
  tasks: Task[]
  summary: string
}

export type OrchestratorEventType =
  | 'project.created'
  | 'plan.created'
  | 'plan.failed'
  | 'task.started'
  | 'task.implemented'
  | 'task.review'
  | 'task.done'
  | 'task.failed'
  | 'summary'
  | 'project.done'

export interface OrchestratorEvent {
  type: OrchestratorEventType
  message: string
  data?: Record<string, unknown>
}

export interface RunProjectRequest {
  goal: string
  policy?: AssignmentPolicy
  maxReviewRounds?: number
}

// ── preload 가 노출하는 브리지 계약 ────────────────────────────────────────
export interface FleetBridge {
  getAppInfo(): Promise<AppInfo>

  // 세션 / CLI
  detectClis(): Promise<CliDetectionResult[]>
  listAdapters(): Promise<CliAdapter[]>
  registerCliSession(adapterId: string): Promise<LlmDescriptor>
  registerApiSession(config: ApiProviderConfig): Promise<LlmDescriptor>
  listSessions(): Promise<LlmDescriptor[]>
  removeSession(id: string): Promise<void>

  // 프로젝트 / 오케스트레이션
  listProjects(): Promise<Project[]>
  getProjectTasks(projectId: string): Promise<Task[]>
  runProject(req: RunProjectRequest): Promise<RunResult>

  // 채팅
  createRoom(title: string, participants?: string[]): Promise<ChatRoom>
  listRooms(): Promise<ChatRoom[]>
  roomHistory(roomId: string): Promise<ChatMessage[]>
  postUserMessage(roomId: string, content: string): Promise<ChatMessage>
  askLlm(roomId: string, llmId: string): Promise<ChatMessage>
  discussRoom(roomId: string, llmIds: string[], rounds?: number): Promise<ChatMessage[]>

  // 감사 / 이벤트 스트림
  listEvents(): Promise<FleetEvent[]>
  /** 오케스트레이터 진행 이벤트 구독 (해제 함수 반환). */
  onOrchestratorEvent(callback: (event: OrchestratorEvent) => void): () => void
}

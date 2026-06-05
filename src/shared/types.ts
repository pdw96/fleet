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

/**
 * 헤드리스 stdout 정제 전략.
 * - 'text'        : 트림만 (기본). claude `-p`, gemini `-p` 처럼 응답만 출력하는 CLI.
 * - 'codex-jsonl' : codex `exec --json` 의 JSONL 이벤트에서 최종 agent_message 만 추출.
 */
export type CliOutputFormat = 'text' | 'codex-jsonl'

/**
 * 스테이트풀 세션의 id 획득 전략.
 * - 'preassigned'  : 우리가 UUID 를 생성해 startArgs/resumeArgs 에 주입(추출 불필요). claude/gemini.
 * - 'codex-thread' : 첫 응답 JSONL 의 `thread.started` 이벤트에서 thread_id 를 추출. codex.
 */
export type SessionIdSource = 'preassigned' | 'codex-thread'

/**
 * CLI 자체 세션 재개로 프로세스 간 대화 맥락을 유지하는 사양('길 A').
 * 미지정 어댑터는 헤드리스 1회 실행(stateless)만 지원한다.
 */
export interface CliSessionSpec {
  /** 새 세션 첫 호출 인자. '{prompt}','{sessionId}' 토큰이 치환된다. */
  startArgs: string[]
  /** 세션 재개 후속 호출 인자. '{prompt}','{sessionId}' 토큰이 치환된다. */
  resumeArgs: string[]
  idSource: SessionIdSource
}

/**
 * 스트림 라인 → 텍스트 델타 추출 전략(실측 확정).
 * - 'claude-stream' : `{type:'stream_event', event.delta:{type:'text_delta', text}}` 의 text.
 * - 'gemini-stream' : `{type:'message', role:'assistant', delta:true, content}` 의 content.
 * - 'codex-jsonl'   : `{type:'item.completed', item:{type:'agent_message', text}}` 의 text(이벤트 단위).
 */
export type StreamParseFormat = 'claude-stream' | 'gemini-stream' | 'codex-jsonl'

/** 토큰/이벤트 스트리밍 사양('길 A' 2단계). onChunk 가 주어질 때만 활성화된다. */
export interface CliStreamSpec {
  /** 스트리밍 활성 추가 인자(base 인자 뒤에 덧붙는다). codex 는 base 에 --json 이 이미 있어 []. */
  args: string[]
  parse: StreamParseFormat
}

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
  /**
   * 헤드리스(비대화형) 1회 실행 인자 템플릿. '{prompt}' 토큰이 프롬프트로 치환된다.
   * `parse` 로 stdout 정제 전략을 지정한다(미지정 시 'text' = 트림만).
   */
  headless?: { args: string[]; parse?: CliOutputFormat }
  /**
   * 스테이트풀 세션 재개 사양('길 A'). 존재해도 기본은 stateless 이며,
   * createCliSession 의 `stateful` 옵션이 켜질 때만 활성화된다. stdout 정제는
   * headless.parse 를 재사용한다(codex 는 'codex-jsonl', claude/gemini 는 'text').
   */
  session?: CliSessionSpec
  /** 토큰/이벤트 스트리밍 사양('길 A' 2단계). 미지정 시 버퍼링(최종 1회). */
  streaming?: CliStreamSpec
  /**
   * 편집 에이전트 1회 실행 인자 템플릿. '{prompt}'·'{workspace}' 토큰이 치환된다.
   * 존재하면 send({workspace}) 호출이 이 인자로 cwd=workspace 에서 에이전트를 실행해
   * 워크스페이스 파일을 직접 편집한다. 미지정 어댑터는 implementer 역할에 쓸 수 없다.
   */
  edit?: { args: string[]; parse?: CliOutputFormat }
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
  /** CLI 세션이 맥락 유지(세션 재개) 모드로 등록되었는지. */
  stateful?: boolean
  /** 이 LLM 이 잘하는 역할들 (capability-scored 배정 정책의 선호 근거). 세션 수명 동안 유지. */
  capabilities?: AgentRole[]
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

/** 오케스트레이터가 실제로 배정·실행하는 역할 집합 (요구사항 8 MVP). 배정 UI·채점도 이 집합으로 제한한다. */
export const ASSIGNABLE_ROLES: readonly AgentRole[] = ['planner', 'implementer', 'reviewer', 'summarizer']

export type TaskStatus = 'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped'

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
  /** keep 직전 변경된 파일 목록(diff 기반). */
  changedFiles?: string[]
  /** 작업 전 체크포인트 커밋 해시. */
  checkpoint?: string
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
  kind: 'file-write' | 'file-delete' | 'shell' | 'apply-diff'
  summary: string
  /** 대상 경로 또는 명령 */
  target: string
  risk: RiskLevel
  ts: number
}

export type ApprovalDecision = 'approved' | 'rejected'

/** destructive 승인 무응답 시 자동 거부까지의 시간(메인 측 권위 + 렌더러 카운트다운 공용). */
export const APPROVAL_TIMEOUT_MS = 60_000

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
  /** 검증 단계가 실행된 경우의 결과(요구사항 5). 미실행이면 undefined. */
  verifications?: VerificationResult[]
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
  | 'task.progress'
  | 'task.skipped'
  | 'run.cancelled'
  | 'verify.passed'
  | 'verify.failed'
  | 'verify.fixing'
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
  /** manual 정책용 사용자 지정 역할↔LLM 배정. 지정 시 policy 보다 우선한다. */
  assignments?: RoleAssignment[]
  maxReviewRounds?: number
  taskTimeoutMs?: number
  continueOnFailure?: boolean
}

// ── 채팅 토큰 스트리밍 (IPC 이벤트 채널) ─────────────────────────────────────
/**
 * LLM 응답을 토큰 단위로 렌더러에 흘리는 이벤트(메인 → 렌더러 브로드캐스트).
 * 최종 ChatMessage.id 는 store 영속 시점에야 정해지므로, in-flight 응답은
 * 메인이 발급한 `streamId` 로 식별한다. 한 발언(askLlm 1회)이 한 streamId 다.
 *
 *  - start : 발언 시작. 렌더러는 빈 말풍선(작성자/역할 표시)을 즉시 띄운다.
 *  - delta : 토큰/이벤트 증분 텍스트. 누적해 말풍선에 이어 붙인다.
 *  - end   : 발언 완료. 영속된 최종 메시지를 싣는다(스트리밍 말풍선 → 확정 메시지로 교체).
 *  - error : 발언 실패. 렌더러는 말풍선을 에러 표시로 바꾸거나 제거한다.
 *
 * 모든 변형에 roomId 를 실어 렌더러가 활성 방이 아닌 이벤트를 쉽게 거른다.
 * 비스트리밍 세션(API/스트리밍 미지원 CLI)은 delta 가 최종 텍스트 1회로 도착한다.
 */
export type ChatStreamEvent =
  | { kind: 'start'; streamId: string; roomId: string; llmId: string; role?: AgentRole }
  | { kind: 'delta'; streamId: string; roomId: string; delta: string }
  | { kind: 'end'; streamId: string; roomId: string; message: ChatMessage }
  | { kind: 'error'; streamId: string; roomId: string; message: string }

// ── preload 가 노출하는 브리지 계약 ────────────────────────────────────────
export interface FleetBridge {
  getAppInfo(): Promise<AppInfo>

  // 세션 / CLI
  detectClis(): Promise<CliDetectionResult[]>
  listAdapters(): Promise<CliAdapter[]>
  registerCliSession(adapterId: string, opts?: { stateful?: boolean }): Promise<LlmDescriptor>
  registerApiSession(config: ApiProviderConfig): Promise<LlmDescriptor>
  listSessions(): Promise<LlmDescriptor[]>
  removeSession(id: string): Promise<void>
  /** 세션의 적합 역할(capabilities)을 설정한다. capability-scored 배정의 근거. */
  setSessionCapabilities(id: string, roles: AgentRole[]): Promise<LlmDescriptor>

  // 프로젝트 / 오케스트레이션
  listProjects(): Promise<Project[]>
  getProjectTasks(projectId: string): Promise<Task[]>
  runProject(req: RunProjectRequest): Promise<RunResult>
  /** 산출물 기록·검증 워크스페이스 조회. null 이면 비활성(파일 기록/검증 안 함). */
  getWorkspace(): Promise<string | null>
  /** 워크스페이스 디렉터리 선택(취소 시 기존 값 유지). 적용된 경로(또는 null) 반환. */
  selectWorkspace(): Promise<string | null>

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
  /** 채팅 응답 토큰 스트림 구독 (해제 함수 반환). */
  onChatStream(callback: (event: ChatStreamEvent) => void): () => void
  /** destructive 작업 승인 요청 구독 (해제 함수 반환). */
  onApprovalRequest(callback: (req: ApprovalRequest) => void): () => void
  /** 승인 모달 결정 회신(메인이 id 로 상관). */
  respondApproval(id: string, approved: boolean): Promise<void>
}

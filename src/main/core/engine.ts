import { randomUUID } from 'node:crypto'
import type {
  AgentRole,
  ApiProviderConfig,
  ApprovalRequest,
  AssignmentPolicy,
  ChatMessage,
  ChatRoom,
  ChatStreamEvent,
  CliAdapter,
  CliDetectionResult,
  FleetEvent,
  LlmDescriptor,
  Project,
  RoleAssignment,
  Task,
} from '../../shared/types'
import { ASSIGNABLE_ROLES } from '../../shared/types'
import { createChatController, type AskOptions, type ChatController } from './chat/room'
import { defaultRunner, detectAll, type CommandRunner } from './cli/detect'
import { createCliRegistry, type CliRegistry } from './cli/registry'
import { assignRoles, resolveLlmForRole } from './orchestrator/assignment'
import { runProject, type OrchestratorEvent, type RunResult } from './orchestrator/orchestrator'
import { createApiProvider } from './providers/registry'
import { createResilientHttp } from './providers/resilient'
import { defaultHttp, type HttpClient } from './providers/types'
import { createApprovalGate } from './safety/approval'
import { createApiSession } from './session/api-session'
import { createCliSession } from './session/cli-session'
import { createSessionManager, type SessionManager } from './session/manager'
import { createMemoryStore } from './store/memory'
import type { Store } from './store/types'
import { npmVerifyCommands, runAllVerifications, type VerifyRunner } from './verify/run'
import { createWorkspace, type GitRunner } from './workspace/git'

/**
 * CLI 어댑터 id / API provider 별 기본 적합 역할 시드.
 * 등록 즉시 서로 다른 역할로 채워져 capability-scored 가 한 LLM 독식 없이 바로 의미를 가진다.
 * 사용자는 [세션] 탭에서 언제든 덮어쓸 수 있다. 전부 ASSIGNABLE_ROLES 범위 내.
 */
const DEFAULT_CAPABILITIES: Record<string, readonly AgentRole[]> = {
  claude: ['reviewer'],
  codex: ['implementer'],
  gemini: ['planner', 'summarizer'],
  anthropic: ['reviewer'],
  openai: ['implementer'],
  google: ['planner', 'summarizer'],
}

const seedCapabilities = (key: string): AgentRole[] => [...(DEFAULT_CAPABILITIES[key] ?? [])]

// 오케스트레이션 검증은 실제 빌드/테스트라 채팅용 120s 로는 부족하다 — 10분으로 상향(spec §5 분리·상향).
const VERIFY_TIMEOUT_MS = 600_000

export interface FleetEngineOptions {
  store?: Store
  sessions?: SessionManager
  cliRegistry?: CliRegistry
  http?: HttpClient
  runner?: CommandRunner
  onOrchestratorEvent?: (e: OrchestratorEvent) => void
  /** 채팅 응답 토큰 스트림 싱크(미지정 시 버퍼링: end 에서 최종 메시지만). */
  onChatStream?: (e: ChatStreamEvent) => void
  /** 산출물 기록·검증의 워크스페이스 루트. 미지정 시 파일 기록/검증 비활성(기존 동작 보존). */
  workspaceDir?: string
  /** 위험(destructive) 작업 승인 콜백. 미지정 시 위험 작업은 거부된다(안전 기본값). */
  approver?: (req: ApprovalRequest) => Promise<boolean>
  /** 검증 실행기 주입(테스트용). 기본은 child_process 기반. */
  verifyRunner?: VerifyRunner
  /** git 실행기 주입(테스트용). 기본은 child_process 기반 defaultGitRunner. */
  gitRunner?: GitRunner
}

export interface RunProjectInput {
  goal: string
  assignments?: RoleAssignment[]
  policy?: AssignmentPolicy
  maxReviewRounds?: number
  taskTimeoutMs?: number
  continueOnFailure?: boolean
}

/**
 * Fleet 코어 파사드 — store / sessions / cli / providers / orchestrator / chat 를 묶어
 * IPC 계층에 단일 진입점을 제공한다. 전부 순수 TS 라 헤드리스로 검증 가능.
 */
export interface FleetEngine {
  // ── CLI / 세션 ──
  detectClis(): Promise<CliDetectionResult[]>
  listAdapters(): CliAdapter[]
  registerCliSession(adapterId: string, opts?: { stateful?: boolean }): LlmDescriptor
  registerApiSession(config: ApiProviderConfig): LlmDescriptor
  listSessions(): LlmDescriptor[]
  removeSession(id: string): Promise<void>
  /** 세션의 적합 역할(capability-scored 근거)을 설정하고 갱신된 descriptor 를 반환한다. */
  setSessionCapabilities(id: string, roles: AgentRole[]): LlmDescriptor

  // ── 프로젝트 / 오케스트레이션 ──
  listProjects(): Project[]
  getProjectTasks(projectId: string): Task[]
  runProjectFlow(input: RunProjectInput): Promise<RunResult>
  /** 진행 중인 프로젝트 실행을 취소한다(현재 작업 revert 후 중단). 미존재 id 는 무시. */
  cancelRun(projectId: string): void
  /** 산출물 기록·검증 워크스페이스 조회/설정(null 이면 비활성). */
  getWorkspace(): string | null
  setWorkspace(dir: string | null): void

  // ── 채팅 ──
  createRoom(title: string, participants?: string[]): ChatRoom
  listRooms(): ChatRoom[]
  roomHistory(roomId: string): ChatMessage[]
  postUserMessage(roomId: string, content: string): ChatMessage
  askLlm(roomId: string, llmId: string, opts?: AskOptions): Promise<ChatMessage>
  /** 여러 LLM 이 방의 대화를 보고 rounds 회 순차 발언 (AI 간 자동 토론). */
  discussRoom(roomId: string, llmIds: string[], rounds?: number): Promise<ChatMessage[]>

  // ── 감사 ──
  listEvents(): FleetEvent[]
}

export function createFleetEngine(opts: FleetEngineOptions = {}): FleetEngine {
  const store = opts.store ?? createMemoryStore()
  const sessions = opts.sessions ?? createSessionManager()
  const cliRegistry = opts.cliRegistry ?? createCliRegistry()
  // 주입이 없으면 타임아웃·재시도를 갖춘 기본 HTTP 를 쓴다(네트워크 무한 대기/일시 오류 방어).
  const http = opts.http ?? createResilientHttp(defaultHttp)
  const runner = opts.runner ?? defaultRunner

  // 안전 계층: 파일 쓰기는 caution(자동승인), 민감/삭제는 destructive(approver 필요)로 게이트한다.
  const appendAudit = (type: string, data: Record<string, unknown>): void => {
    store.appendEvent({ type, data })
  }
  const gate = createApprovalGate({ autoApprove: ['safe', 'caution'], approver: opts.approver, onEvent: appendAudit })
  // 워크스페이스는 런타임에 바꿀 수 있다(렌더러에서 선택). null 이면 파일 기록/검증 비활성.
  let workspaceDir: string | null = opts.workspaceDir ?? null
  // 진행 중 실행: projectId → AbortController. project.created 에서 등록, project.done 에서 해제.
  const activeRuns = new Map<string, AbortController>()
  const currentWorkspace = () =>
    workspaceDir ? createWorkspace(workspaceDir, opts.gitRunner) : undefined
  const currentVerify = (signal?: AbortSignal) => {
    const dir = workspaceDir
    return dir ? () => runAllVerifications(npmVerifyCommands(dir), { runner: opts.verifyRunner, timeoutMs: VERIFY_TIMEOUT_MS, signal }) : undefined
  }

  /**
   * 한 발언(askLlm 1회)을 스트리밍 이벤트로 감싼다 — 채팅 단일 질문과 AI 토론이 균일하게 흐른다.
   * onChatStream 싱크가 없으면 그대로 위임(스트리밍 비활성). 있으면 streamId 를 발급해
   * start → delta* → end(영속 메시지) 를 방출하고, 실패 시 error 를 방출한 뒤 그대로 rethrow 한다
   * (호출자 IPC 가 여전히 reject 되어 렌더러의 busy 해제 경로가 정상 동작하도록).
   */
  const streamedAsk = async (
    controller: ChatController,
    roomId: string,
    llmId: string,
    askOpts?: AskOptions,
  ): Promise<ChatMessage> => {
    const emit = opts.onChatStream
    if (!emit) return controller.askLlm(llmId, askOpts)
    const streamId = randomUUID()
    emit({ kind: 'start', streamId, roomId, llmId, role: askOpts?.role })
    try {
      const message = await controller.askLlm(llmId, {
        ...askOpts,
        onToken: (delta) => emit({ kind: 'delta', streamId, roomId, delta }),
      })
      emit({ kind: 'end', streamId, roomId, message })
      return message
    } catch (err) {
      emit({ kind: 'error', streamId, roomId, message: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  return {
    detectClis() {
      return detectAll(cliRegistry.list(), runner)
    },

    listAdapters() {
      return cliRegistry.list()
    },

    registerCliSession(adapterId, sessionOpts) {
      const adapter = cliRegistry.get(adapterId)
      if (!adapter) throw new Error(`알 수 없는 CLI 어댑터: ${adapterId}`)
      const id = `cli:${adapterId}`
      // 기본 stateless. stateful 은 채팅 등 연속성이 필요한 경로에서만 opt-in (오케스트레이터 독립성 보존).
      const descriptor: LlmDescriptor = {
        id,
        kind: 'cli',
        displayName: adapter.displayName,
        ref: adapterId,
        model: '',
        stateful: !!sessionOpts?.stateful,
        capabilities: seedCapabilities(adapterId),
      }
      sessions.add(createCliSession(descriptor, adapter, runner, undefined, { stateful: sessionOpts?.stateful }))
      store.appendEvent({ type: 'session.registered', data: { id, kind: 'cli', stateful: !!sessionOpts?.stateful } })
      return descriptor
    },

    registerApiSession(config) {
      const id = `api:${config.id}`
      const descriptor: LlmDescriptor = {
        id,
        kind: 'api',
        displayName: config.displayName,
        ref: config.id,
        model: config.model,
        capabilities: seedCapabilities(config.provider),
      }
      sessions.add(createApiSession(descriptor, createApiProvider(config, http)))
      store.appendEvent({ type: 'session.registered', data: { id, kind: 'api', provider: config.provider } })
      return descriptor
    },

    listSessions() {
      return sessions.descriptors()
    },

    setSessionCapabilities(id, roles) {
      const descriptor = sessions.setCapabilities(id, roles)
      if (!descriptor) throw new Error(`알 수 없는 세션: ${id}`)
      store.appendEvent({ type: 'session.capabilities', data: { id, roles: [...roles] } })
      return descriptor
    },

    removeSession(id) {
      return sessions.remove(id)
    },

    listProjects() {
      return store.listProjects()
    },

    getProjectTasks(projectId) {
      return store.listTasks(projectId)
    },

    async runProjectFlow(input) {
      const llmIds = sessions.list().map((s) => s.id)
      if (llmIds.length === 0) throw new Error('등록된 LLM 세션이 없습니다. 먼저 세션을 등록하세요.')
      // 직접 편집 모델은 산출물 워크스페이스가 필수다(없으면 작업이 전부 skip 되어 의미가 없다).
      if (!workspaceDir) throw new Error('워크스페이스가 선택되지 않았습니다. 먼저 산출물 워크스페이스를 선택하세요.')
      // 세션별 적합 역할을 capability-scored 채점 맵으로 모은다(끊겼던 연결고리). 역량 없는 세션은 제외.
      const capabilities = Object.fromEntries(
        sessions.descriptors().flatMap((d) => (d.capabilities?.length ? [[d.id, d.capabilities]] : [])),
      )
      let assignments =
        input.assignments ??
        assignRoles({ roles: ASSIGNABLE_ROLES, llmIds, policy: input.policy ?? 'round-robin', capabilities })
      // 구현(implementer) 역할은 워크스페이스를 직접 편집할 수 있는 CLI 세션이어야 한다.
      // capability-scored/round-robin 이 CLI 가 있는데도 API 를 implementer 슬롯에 넣을 수 있으므로,
      // CLI 세션이 하나라도 있으면 그쪽으로 재배정한다. CLI 가 전혀 없을 때만 계획 전에 fail-fast 한다.
      const cliSessionIds = sessions.list().filter((s) => s.descriptor.kind === 'cli').map((s) => s.id)
      if (cliSessionIds.length === 0) {
        throw new Error('구현(implementer) 역할에는 워크스페이스를 직접 편집할 수 있는 CLI 세션이 필요합니다. CLI 세션(claude/codex/gemini)을 등록하세요.')
      }
      const curImplId = resolveLlmForRole(assignments, 'implementer', 'implementer')
      const curImpl = curImplId ? sessions.get(curImplId) : undefined
      if (!curImpl || curImpl.descriptor.kind !== 'cli') {
        const cliId = cliSessionIds[0]
        assignments = [...assignments.filter((a) => a.role !== 'implementer'), { role: 'implementer', llmId: cliId }]
        store.appendEvent({ type: 'assignment.implementer_reassigned', data: { to: cliId } })
      }
      // 이 실행 전용 취소 컨트롤러. project.created 에서 projectId 와 상관시켜 등록한다.
      const controller = new AbortController()
      const onEvent = (e: OrchestratorEvent) => {
        const pid = e.data?.['projectId']
        if (e.type === 'project.created' && typeof pid === 'string') activeRuns.set(pid, controller)
        if (e.type === 'project.done' && typeof pid === 'string') activeRuns.delete(pid)
        opts.onOrchestratorEvent?.(e)
      }
      try {
        return await runProject(input.goal, {
          store,
          sessions,
          assignments,
          maxReviewRounds: input.maxReviewRounds,
          taskTimeoutMs: input.taskTimeoutMs,
          continueOnFailure: input.continueOnFailure,
          workspace: currentWorkspace(),
          workspaceRoot: workspaceDir ?? undefined,
          gate,
          verify: currentVerify(controller.signal),
          signal: controller.signal,
          onEvent,
        })
      } finally {
        // 정상 경로는 project.done 에서 제거되지만, 조기 throw 시에도 누수 없이 정리한다.
        for (const [pid, c] of activeRuns) if (c === controller) activeRuns.delete(pid)
      }
    },

    cancelRun(projectId) {
      const c = activeRuns.get(projectId)
      if (!c) return // 미존재 id 는 무해한 no-op
      c.abort()
      activeRuns.delete(projectId)
      store.appendEvent({ type: 'run.cancelled', data: { projectId } })
      opts.onOrchestratorEvent?.({ type: 'run.cancelled', message: '실행 취소됨', data: { projectId } })
    },

    getWorkspace() {
      return workspaceDir
    },

    setWorkspace(dir) {
      workspaceDir = dir
      store.appendEvent({ type: 'workspace.set', data: { dir } })
    },

    createRoom(title, participants = []) {
      return store.createRoom({ title, participants })
    },

    listRooms() {
      return store.listRooms()
    },

    roomHistory(roomId) {
      return store.listMessages(roomId)
    },

    postUserMessage(roomId, content) {
      return createChatController({ store, sessions, roomId }).postUser(content)
    },

    askLlm(roomId, llmId, askOpts) {
      return streamedAsk(createChatController({ store, sessions, roomId }), roomId, llmId, askOpts)
    },

    async discussRoom(roomId, llmIds, rounds = 1) {
      const controller = createChatController({ store, sessions, roomId })
      const out: ChatMessage[] = []
      for (let r = 0; r < rounds; r++) {
        for (const id of llmIds) {
          try {
            out.push(await streamedAsk(controller, roomId, id))
          } catch {
            // 한 LLM 의 실패가 나머지 토론을 중단시키지 않게 격리한다(에러는 streamedAsk 가 스트림 이벤트로 방출).
          }
        }
      }
      return out
    },

    listEvents() {
      return store.listEvents()
    },
  }
}

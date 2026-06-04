import type {
  AgentRole,
  ApiProviderConfig,
  AssignmentPolicy,
  ChatMessage,
  ChatRoom,
  CliAdapter,
  CliDetectionResult,
  FleetEvent,
  LlmDescriptor,
  Project,
  RoleAssignment,
  Task,
} from '../../shared/types'
import { createChatController, type AskOptions } from './chat/room'
import { defaultRunner, detectAll, type CommandRunner } from './cli/detect'
import { createCliRegistry, type CliRegistry } from './cli/registry'
import { assignRoles } from './orchestrator/assignment'
import { runProject, type OrchestratorEvent, type RunResult } from './orchestrator/orchestrator'
import { createApiProvider } from './providers/registry'
import { defaultHttp, type HttpClient } from './providers/types'
import { createApiSession } from './session/api-session'
import { createCliSession } from './session/cli-session'
import { createSessionManager, type SessionManager } from './session/manager'
import { createMemoryStore } from './store/memory'
import type { Store } from './store/types'

/** MVP 오케스트레이션 역할 (요구사항 8). */
const MVP_ROLES: readonly AgentRole[] = ['planner', 'implementer', 'reviewer', 'summarizer']

export interface FleetEngineOptions {
  store?: Store
  sessions?: SessionManager
  cliRegistry?: CliRegistry
  http?: HttpClient
  runner?: CommandRunner
  onOrchestratorEvent?: (e: OrchestratorEvent) => void
}

export interface RunProjectInput {
  goal: string
  assignments?: RoleAssignment[]
  policy?: AssignmentPolicy
  maxReviewRounds?: number
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

  // ── 프로젝트 / 오케스트레이션 ──
  listProjects(): Project[]
  getProjectTasks(projectId: string): Task[]
  runProjectFlow(input: RunProjectInput): Promise<RunResult>

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
  const http = opts.http ?? defaultHttp
  const runner = opts.runner ?? defaultRunner

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
      const descriptor: LlmDescriptor = { id, kind: 'cli', displayName: adapter.displayName, ref: adapterId, model: '' }
      // 기본 stateless. stateful 은 채팅 등 연속성이 필요한 경로에서만 opt-in (오케스트레이터 독립성 보존).
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
      }
      sessions.add(createApiSession(descriptor, createApiProvider(config, http)))
      store.appendEvent({ type: 'session.registered', data: { id, kind: 'api', provider: config.provider } })
      return descriptor
    },

    listSessions() {
      return sessions.descriptors()
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
      const assignments =
        input.assignments ?? assignRoles({ roles: MVP_ROLES, llmIds, policy: input.policy ?? 'round-robin' })
      return runProject(input.goal, {
        store,
        sessions,
        assignments,
        maxReviewRounds: input.maxReviewRounds,
        onEvent: opts.onOrchestratorEvent,
      })
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
      return createChatController({ store, sessions, roomId }).askLlm(llmId, askOpts)
    },

    async discussRoom(roomId, llmIds, rounds = 1) {
      const controller = createChatController({ store, sessions, roomId })
      const out: ChatMessage[] = []
      for (let r = 0; r < rounds; r++) {
        for (const id of llmIds) {
          out.push(await controller.askLlm(id))
        }
      }
      return out
    },

    listEvents() {
      return store.listEvents()
    },
  }
}

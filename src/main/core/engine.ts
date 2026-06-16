import { randomUUID } from 'node:crypto'
import type {
  AgentRole,
  ApiProviderConfig,
  ApprovalRequest,
  ChatActivity,
  ChatMessage,
  ChatRoom,
  ChatStreamEvent,
  CliAdapter,
  CliDetectionResult,
  FleetEvent,
  LlmDescriptor,
  McpServerSpec,
  McpServerStatus,
  Project,
  RunActivity,
  RunProjectRequest,
  Task,
  ToolStep,
} from '../../shared/types'
import { ASSIGNABLE_ROLES, MAX_REPLAN_ROUNDS } from '../../shared/types'
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
import { createMcpHost } from './mcp/host'
import type { McpHost } from './mcp/types'
import { createToolRegistry } from './tools/registry'
import { createWorkspaceReadTools } from './tools/workspace-tools'
import { createMemoryStore } from './store/memory'
import type { Store } from './store/types'
import { npmVerifyCommands, runAllVerifications, type VerifyRunner } from './verify/run'
import { createWorkspace, type GitRunner } from './workspace/git'
import type { SecretCrypto } from './secret/types'

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
  'openai-compatible': ['implementer'],
  google: ['planner', 'summarizer'],
}

const seedCapabilities = (key: string): AgentRole[] => [...(DEFAULT_CAPABILITIES[key] ?? [])]

// SecretCrypto 미주입(테스트·헤드리스·CLI) 기본값 — 암호화 미가용 → API 세션 미영속(현행 동작 보존).
// isAvailable()===false 가드 뒤에서만 encrypt/decrypt 가 호출되므로 throw 는 정상 경로에 도달하지 않는다.
const NOOP_CRYPTO: SecretCrypto = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('시크릿 암호화 미가용(SecretCrypto 미주입)')
  },
  decrypt: () => {
    throw new Error('시크릿 복호화 미가용(SecretCrypto 미주입)')
  },
}

// 오케스트레이션 검증은 실제 빌드/테스트라 채팅용 120s 로는 부족하다 — 10분으로 상향(spec §5 분리·상향).
const VERIFY_TIMEOUT_MS = 600_000

// 신호 미지정 LLM 호출(채팅 경로)의 기본 HTTP 타임아웃. thinking 활성 응답(사고 토큰 포함 스트림)은
// 기존 120s 를 쉽게 넘기므로 5분으로 상향 — 무한 대기 방지 목적은 유지(#11-thinking 활성화).
// 오케스트레이터 경로는 run AbortController 의 signal 이 있어 이 기본값과 무관하다.
const LLM_HTTP_TIMEOUT_MS = 300_000

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
  /** MCP 호스트 주입(테스트용). 기본은 stdio 기반 createMcpHost. */
  mcpHost?: McpHost
  /** 시크릿(apiKey) 암복호화 백엔드. 미주입 시 API 세션 미영속(현행 동작). main 이 safeStorage 어댑터 주입. */
  secretCrypto?: SecretCrypto
}

/**
 * Fleet 코어 파사드 — store / sessions / cli / providers / orchestrator / chat 를 묶어
 * IPC 계층에 단일 진입점을 제공한다. 전부 순수 TS 라 헤드리스로 검증 가능.
 */
export interface FleetEngine {
  // ── CLI / 세션 ──
  detectClis(): Promise<CliDetectionResult[]>
  listAdapters(): CliAdapter[]
  registerCliSession(
    adapterId: string,
    opts?: { stateful?: boolean; model?: string; mcpConfig?: string },
  ): LlmDescriptor
  registerApiSession(config: ApiProviderConfig): LlmDescriptor
  listSessions(): LlmDescriptor[]
  removeSession(id: string): Promise<void>
  /** 세션의 적합 역할(capability-scored 근거)을 설정하고 갱신된 descriptor 를 반환한다. */
  setSessionCapabilities(id: string, roles: AgentRole[]): LlmDescriptor

  // ── 프로젝트 / 오케스트레이션 ──
  listProjects(): Project[]
  getProjectTasks(projectId: string): Task[]
  /** 프로젝트의 영속 진행 이벤트(시간순, task.progress 제외). */
  listProjectEvents(projectId: string): FleetEvent[]
  /** 마지막으로 본 프로젝트 id(없으면 null). */
  getLastActiveProject(): string | null
  /** 마지막으로 본 프로젝트 id 저장(null 이면 해제). */
  setLastActiveProject(projectId: string | null): void
  runProjectFlow(input: RunProjectRequest): Promise<RunResult>
  /** 진행 중인 프로젝트 실행을 취소한다(현재 작업 revert 후 중단). 미존재 id 는 무시. */
  cancelRun(projectId: string): void
  /**
   * 프로젝트 실행 진행 상태 스냅샷(단일 소스 오브 트루스). 렌더러가 ProjectPanel 마운트 시 조회해
   * 진행 표시·취소 버튼을 복원한다. 탭 전환으로 렌더러 state 가 날아가도 main(activeRuns)이 권위.
   */
  getRunActivity(): RunActivity
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
  /**
   * 채팅 진행 상태 스냅샷(단일 소스 오브 트루스). 렌더러가 ChatPanel 마운트 시 조회해
   * 진행 표시·라이브 말풍선을 복원한다. 탭 전환으로 렌더러 state 가 날아가도 main 이 권위.
   */
  getChatActivity(): ChatActivity

  // ── MCP 호스트 ──
  /** MCP 서버 목록 설정(전체 교체). 연결 후 서버별 상태 반환. */
  setMcpServers(servers: McpServerSpec[]): Promise<McpServerStatus[]>
  /** 현재 MCP 서버 연결 상태/도구 목록. */
  getMcpStatus(): McpServerStatus[]
  /** 엔진 종료 — 세션·MCP 자식 프로세스 정리. */
  dispose(): Promise<void>

  // ── 감사 ──
  listEvents(): FleetEvent[]
}

export function createFleetEngine(opts: FleetEngineOptions = {}): FleetEngine {
  const store = opts.store ?? createMemoryStore()
  const sessions = opts.sessions ?? createSessionManager()
  const cliRegistry = opts.cliRegistry ?? createCliRegistry()
  // 주입이 없으면 타임아웃·재시도를 갖춘 기본 HTTP 를 쓴다(네트워크 무한 대기/일시 오류 방어).
  const http = opts.http ?? createResilientHttp(defaultHttp, { timeoutMs: LLM_HTTP_TIMEOUT_MS })
  const runner = opts.runner ?? defaultRunner
  // Task 4(영속 register)·Task 5(복원 decrypt)에서 사용된다 — 지금은 주입 결선만.
  const secretCrypto = opts.secretCrypto ?? NOOP_CRYPTO
  void secretCrypto // noUnusedLocals 억제 — Task 4 에서 실사용 시 이 줄을 제거한다.

  // 안전 계층: 파일 쓰기는 caution(자동승인), 민감/삭제는 destructive(approver 필요)로 게이트한다.
  const appendAudit = (type: string, data: Record<string, unknown>): void => {
    store.appendEvent({ type, data })
  }
  const gate = createApprovalGate({ autoApprove: ['safe', 'caution'], approver: opts.approver, onEvent: appendAudit })
  // MCP 호스트: 외부 MCP 서버의 도구를 FleetTool 로 노출한다(setMcpServers 로 연결).
  // gate 를 주입해 새 서버 spawn(임의 로컬 프로세스 실행)이 승인 게이트를 통과하게 한다(안전 우선).
  const mcpHost = opts.mcpHost ?? createMcpHost({ onAudit: appendAudit, gate })
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

  // ── 채팅 진행 상태(단일 소스 오브 트루스) ──────────────────────────────────
  // 렌더러는 ChatPanel 마운트 시 getChatActivity 로 복원하고 busy/idle·delta 로 라이브 동기화한다.
  // 탭 언마운트로 렌더러 state(busy/streams)가 날아가도 진행의 권위는 항상 main 에 있다.
  const emitChat = opts.onChatStream
  /** in-flight 스트림의 누적 버퍼(텍스트·도구 단계). start 에서 생성, delta/tool 에서 누적(seq++), end/error 에서 제거. */
  const activeStreams = new Map<
    string,
    { roomId: string; llmId: string; role?: AgentRole; text: string; seq: number; steps: ToolStep[] }
  >()
  /** roomId → 진행 중 ask/discuss 연산 수. 0→1 에서 busy, 1→0 에서 idle 을 방출한다. */
  const activeOps = new Map<string, number>()

  const enterOp = (roomId: string): void => {
    const n = (activeOps.get(roomId) ?? 0) + 1
    activeOps.set(roomId, n)
    if (n === 1) emitChat?.({ kind: 'busy', roomId }) // 첫 연산 경계
  }
  const exitOp = (roomId: string): void => {
    const n = (activeOps.get(roomId) ?? 1) - 1
    if (n <= 0) {
      activeOps.delete(roomId)
      emitChat?.({ kind: 'idle', roomId }) // 마지막 연산 경계
    } else {
      activeOps.set(roomId, n)
    }
  }

  /**
   * 한 발언(askLlm 1회)을 스트리밍 이벤트로 감싼다 — 채팅 단일 질문과 AI 토론이 균일하게 흐른다.
   * onChatStream 싱크가 없으면 그대로 위임(스트리밍 비활성). 있으면 streamId 를 발급해
   * start → delta* → end(영속 메시지) 를 방출하고, 실패 시 error 를 방출한 뒤 그대로 rethrow 한다
   * (호출자 IPC 가 여전히 reject 되어 렌더러의 busy 해제 경로가 정상 동작하도록).
   * 진행 중에는 activeStreams 에 누적 텍스트를 보관해 재마운트한 렌더러가 catch-up 할 수 있게 한다.
   */
  const streamedAsk = async (
    controller: ChatController,
    roomId: string,
    llmId: string,
    askOpts?: AskOptions,
  ): Promise<ChatMessage> => {
    const emit = emitChat
    if (!emit) return controller.askLlm(llmId, askOpts)
    const streamId = randomUUID()
    activeStreams.set(streamId, { roomId, llmId, role: askOpts?.role, text: '', seq: 0, steps: [] })
    emit({ kind: 'start', streamId, roomId, llmId, role: askOpts?.role })
    try {
      const message = await controller.askLlm(llmId, {
        ...askOpts,
        onToken: (delta) => {
          const cur = activeStreams.get(streamId)
          if (cur) {
            cur.text += delta // 재마운트 catch-up 용 누적
            cur.seq += 1
          }
          // seq(1부터 증가)로 렌더러가 멱등 적용·하이드레이션 레이스를 정렬한다.
          emit({ kind: 'delta', streamId, roomId, delta, seq: cur?.seq ?? 0 })
        },
        // 도구 단계: id 로 in-place 갱신(running→ok/error)하고 텍스트와 공유 seq 로 흘린다(SP3).
        onToolStep: (step) => {
          const cur = activeStreams.get(streamId)
          if (cur) {
            const i = cur.steps.findIndex((s) => s.id === step.id)
            if (i >= 0) cur.steps[i] = step
            else cur.steps.push(step)
            cur.seq += 1
          }
          emit({ kind: 'tool', streamId, roomId, step, seq: cur?.seq ?? 0 })
        },
      })
      activeStreams.delete(streamId)
      emit({ kind: 'end', streamId, roomId, message })
      return message
    } catch (err) {
      activeStreams.delete(streamId)
      emit({ kind: 'error', streamId, roomId, message: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }

  // 라이브 CLI 세션을 만들어 매니저에 추가한다(순수 — store/audit 부작용 없음). register·restore 공용.
  // 복원이 session.registered 재방출/store 재기록 없이 재구성하게 하는 silent 빌드 지점.
  const buildCliSession = (input: {
    adapterId: string
    model?: string
    stateful?: boolean
    mcpConfig?: string
    capabilities?: AgentRole[]
  }): LlmDescriptor => {
    const adapter = cliRegistry.get(input.adapterId)
    if (!adapter) throw new Error(`알 수 없는 CLI 어댑터: ${input.adapterId}`)
    const descriptor: LlmDescriptor = {
      id: `cli:${input.adapterId}`,
      kind: 'cli',
      displayName: adapter.displayName,
      ref: input.adapterId,
      // 모델 미지정(빈 값)이면 CLI 기본 모델. 지정 시 cli-session 이 --model 로 전달.
      model: input.model?.trim() || '',
      stateful: !!input.stateful,
      // MCP 설정(경로/인라인 JSON). adapter.mcpConfigFlag 가 있는 CLI(claude)에만 적용된다.
      mcpConfig: input.mcpConfig?.trim() || undefined,
      // capabilities 미지정(신규 등록)이면 시드, 지정(복원)이면 그 값을 적용.
      capabilities: input.capabilities ?? seedCapabilities(input.adapterId),
    }
    sessions.add(createCliSession(descriptor, adapter, runner, undefined, { stateful: input.stateful }))
    return descriptor
  }

  // 라이브 CLI descriptor → 영속 store 미러(단일 지점). mcpConfig 는 의도적 제외(secret 평문 금지).
  const syncPersistedSession = (descriptor: LlmDescriptor): void => {
    if (descriptor.kind !== 'cli') return // API 영속은 safeStorage 후속(Epic B)
    store.putSession({
      kind: 'cli',
      id: descriptor.id,
      adapterId: descriptor.ref,
      model: descriptor.model,
      stateful: descriptor.stateful,
      capabilities: descriptor.capabilities,
    })
  }

  // 라이브 API 세션을 만들어 매니저에 추가한다(순수 — store/audit 부작용 없음). register·restore 공용.
  // capabilities 미지정(신규 등록)이면 provider 시드, 지정(복원)이면 그 값을 적용한다(buildCliSession 대칭).
  const buildApiSession = (config: ApiProviderConfig, capabilities?: AgentRole[]): LlmDescriptor => {
    const id = `api:${config.id}`
    const descriptor: LlmDescriptor = {
      id,
      kind: 'api',
      displayName: config.displayName,
      ref: config.id,
      model: config.model,
      capabilities: capabilities ?? seedCapabilities(config.provider),
    }
    sessions.add(
      createApiSession(descriptor, createApiProvider(config, http), {
        // 토큰 사용량을 'usage' 감사 이벤트로 기록한다(usage-accounting). 도구루프는 합산값.
        // FleetEvent 는 generic {type,data} 라 IPC/preload/renderer 변경 없이 이벤트 스트림에 흐른다.
        onUsage: (usage) => appendAudit('usage', { id, provider: config.provider, ...usage }),
        // 워크스페이스 도구 + MCP 도구를 병합 노출한다. 둘 다 없으면 단발 chat(완전 하위호환).
        // 클로저라 런타임 워크스페이스/MCP 변경을 추종한다.
        toolDeps: () => {
          const wsTools = workspaceDir ? createWorkspaceReadTools(workspaceDir) : []
          const mcpTools = mcpHost.tools()
          if (wsTools.length === 0 && mcpTools.length === 0) return undefined
          return {
            registry: createToolRegistry([...wsTools, ...mcpTools]),
            gate,
            onAudit: appendAudit,
            maxIterations: 8,
          }
        },
      }),
    )
    return descriptor
  }

  // 재시작 복원: 영속 CLI 세션을 라이브로 재구성한다. registry 에 있는 adapter 만(등록≠탐지 — 탐지는 별개).
  // 복원은 store 를 재기록하지 않고(이미 있음) session.registered 도 재방출하지 않는다(에코·중복 audit 회피).
  // 한계(R9): 복원된 stateful 세션은 fresh(started=false·resume id 미영속)라 첫 post-restart ask 가
  // room.ts 의 lastOwn 델타만 받아 재시작-전 맥락을 잃는다. main 대비 순개선(세션 소실→사용가능)이라
  // 이 슬라이스는 여기서 멈추고, resume id 영속/컨트롤러 첫-ask full history 는 후속으로 둔다.
  // 손상/미지 엔트리가 엔진 생성을 막지 않도록 전체/엔트리별로 격리한다(앱 부팅 brick 방지).
  // Array.isArray 가드 = '전체' 격리: 손상 store 파일의 최상위 sessions 가 비배열(유효 JSON 이라
  // .corrupt 백업 미발동)이면 for...of 가 try 밖에서 TypeError → createFleetEngine 전체 throw → 부팅 brick.
  const persisted = store.listSessions()
  for (const ps of Array.isArray(persisted) ? persisted : []) {
    try {
      if (ps.kind !== 'cli') continue // 미지 kind(전방호환) skip
      if (!cliRegistry.get(ps.adapterId)) {
        console.warn('[fleet] 세션 복원 skip — 미지 어댑터:', ps.id, ps.adapterId)
        continue
      }
      buildCliSession({
        adapterId: ps.adapterId,
        model: ps.model,
        stateful: ps.stateful,
        // 손상 capabilities(비배열)는 버리고 재시드 — 렌더러 SessionsPanel 의 .includes 크래시 방지.
        capabilities: Array.isArray(ps.capabilities) ? ps.capabilities : undefined,
      })
    } catch (err) {
      console.error('[fleet] 세션 복원 실패:', ps?.id, err)
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
      // 기본 stateless. stateful 은 채팅 등 연속성이 필요한 경로에서만 opt-in (오케스트레이터 독립성 보존).
      // buildCliSession 이 미지 adapter 면 throw — 기존 계약 보존. capabilities 미지정 → 내부에서 시드.
      const descriptor = buildCliSession({
        adapterId,
        model: sessionOpts?.model,
        stateful: sessionOpts?.stateful,
        mcpConfig: sessionOpts?.mcpConfig,
      })
      syncPersistedSession(descriptor) // 영속(재시작 복원용)
      store.appendEvent({ type: 'session.registered', data: { id: descriptor.id, kind: 'cli', stateful: !!sessionOpts?.stateful } })
      return descriptor
    },

    registerApiSession(config) {
      const descriptor = buildApiSession(config)
      // 영속은 Task 4 에서 추가(현재는 register 만 — 동작 무변경).
      store.appendEvent({ type: 'session.registered', data: { id: descriptor.id, kind: 'api', provider: config.provider } })
      return descriptor
    },

    listSessions() {
      return sessions.descriptors()
    },

    setSessionCapabilities(id, roles) {
      const descriptor = sessions.setCapabilities(id, roles)
      if (!descriptor) throw new Error(`알 수 없는 세션: ${id}`)
      syncPersistedSession(descriptor) // 수정된 capabilities 영속(cli 만 — 내부에서 분기)
      store.appendEvent({ type: 'session.capabilities', data: { id, roles: [...roles] } })
      return descriptor
    },

    async removeSession(id) {
      await sessions.remove(id)
      store.deleteSession(id) // 라이브 제거 후 영속 삭제(재시작 부활 방지)
    },

    listProjects() {
      return store.listProjects()
    },

    getProjectTasks(projectId) {
      return store.listTasks(projectId)
    },

    listProjectEvents(projectId) {
      return store.listProjectEvents(projectId)
    },

    getLastActiveProject() {
      return store.getLastActiveProjectId() ?? null
    },

    setLastActiveProject(projectId) {
      store.setLastActiveProject(projectId)
    },

    async runProjectFlow(input) {
      // 동시 실행 권위 가드: 이미 진행 중인 실행이 있으면 거부한다 — 두 번째 실행이 같은 워크스페이스를
      // 편집하며 첫 실행의 revert 와 경합해 워크스페이스를 파괴하는 것을 막는다(DESIGN.md 순차 전제).
      // activeRuns 는 project.created(runProject 첫 await 이전 동기 방출)에서 채워지므로, 진입 시점에
      // 이미 반영돼 있어 신뢰 가능하다. cancelRun/project.done/dispose 가 비우면 다음 실행이 허용된다.
      if (activeRuns.size > 0) throw new Error('이미 진행 중인 프로젝트 실행이 있습니다. 완료 또는 취소 후 다시 시도하세요.')
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
      // 렌더러는 main 기준 신뢰 경계 바깥이다 — UI 셀렉트(0..MAX_REPLAN_ROUNDS)를 우회한 devtools/커스텀
      // 렌더러가 임의 큰 값으로 무한정 planner/구현/검증 사이클(검증이 계속 실패하는 한)을 돌리지 못하도록
      // engine 경계에서 상한을 강제한다(하한·정수·유한성도 함께 보정 — orchestrator 에 sane 값만 넘어가게).
      const requestedReplan = Math.floor(input.maxReplanRounds ?? 0)
      const maxReplanRounds = Number.isFinite(requestedReplan) ? Math.min(Math.max(requestedReplan, 0), MAX_REPLAN_ROUNDS) : 0
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
          maxReplanRounds,
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
      if (!c || c.signal.aborted) return // 미존재 id·이미 취소 진행 중 → 무해한 no-op(중복 run.cancelled 방지)
      c.abort()
      // activeRuns 에서 즉시 제거하지 않는다 — 실행은 abort 후에도 현재 작업을 revert(git reset --hard·clean)
      // 하며 unwinding 중이고 project.done 을 방출할 때까지 워크스페이스를 계속 건드린다. 그때까지 활성으로
      // 유지해야 동시 실행 가드(activeRuns.size>0)와 getRunActivity 스냅샷이 '취소 정리 중'을 정확히 반영해
      // revert 완료 전 두 번째 실행이 같은 워크스페이스를 편집(파괴)하는 것을 막는다. 제거는 revert 후 방출되는
      // project.done(onEvent) 또는 runProjectFlow finally 가 수행한다.
      // 영속 이벤트 id 를 라이브 페이로드(data.eventId)에도 실어 보낸다 — 렌더러가 스냅샷 재조회 시
      // 라이브로 받은 run.cancelled 와 영속본을 같은 id 로 dedup 하도록(중복 '실행 취소됨' 방지).
      const persisted = store.appendEvent({ type: 'run.cancelled', message: '실행 취소됨', data: { projectId } })
      opts.onOrchestratorEvent?.({ type: 'run.cancelled', message: '실행 취소됨', data: { projectId, eventId: persisted.id } })
    },

    getRunActivity() {
      // activeRuns 는 project.created 에서 등록·project.done/dispose 에서 제거되는 in-flight 실행의 권위
      // 소스다(cancelRun 은 abort 만 하고 제거는 revert 후 project.done 에 맡긴다 — 정리 윈도우도 활성 유지).
      // 키(projectId) 스냅샷만 노출해 렌더러가 running·취소 버튼을 복원한다(순차 전제상 0~1건).
      return { activeProjectIds: [...activeRuns.keys()] }
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
      // 연산 경계(busy/idle)는 한 발언 전체를 감싼다 — 단일 질문도 진행 표시 대상.
      enterOp(roomId)
      return streamedAsk(createChatController({ store, sessions, roomId }), roomId, llmId, askOpts).finally(() =>
        exitOp(roomId),
      )
    },

    async discussRoom(roomId, llmIds, rounds = 1) {
      // busy 는 토론 시작에 1회, idle 은 전체 토론 종료에 1회 — 턴 사이 공백에도 진행 표시가 유지된다.
      enterOp(roomId)
      try {
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
      } finally {
        exitOp(roomId)
      }
    },

    getChatActivity() {
      return {
        busyRooms: [...activeOps.keys()],
        streams: [...activeStreams.entries()].map(([streamId, s]) => ({
          streamId,
          roomId: s.roomId,
          llmId: s.llmId,
          role: s.role,
          text: s.text,
          seq: s.seq,
          steps: s.steps,
        })),
      }
    },

    async setMcpServers(servers) {
      const status = await mcpHost.setServers(servers)
      store.appendEvent({ type: 'mcp.servers.set', data: { count: servers.length, names: servers.map((s) => s.name) } })
      return status
    },

    getMcpStatus() {
      return mcpHost.status()
    },

    async dispose() {
      // 진행 중 실행을 먼저 취소한다 — 종료 중에도 run 의 HTTP/CLI 가 계속 돌며 워크스페이스를
      // 건드리거나 무한 대기(타임아웃 복원 전이라면)하는 것을 막는다. abort 는 동기라 정리보다 앞선다.
      for (const c of activeRuns.values()) c.abort()
      activeRuns.clear()
      // 한쪽 정리 실패가 다른 쪽(특히 MCP 자식 프로세스) 정리를 막지 않도록 격리한다 — 좀비 방지가 목적.
      await Promise.allSettled([sessions.disposeAll(), mcpHost.dispose()])
    },

    listEvents() {
      return store.listEvents()
    },
  }
}

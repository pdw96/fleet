import type {
  AppInfo,
  ChatActivity,
  ChatMessage,
  ChatRoom,
  CliAdapter,
  CliDetectionResult,
  FleetBridge,
  FleetEvent,
  LlmDescriptor,
  McpServerStatus,
  ModelOption,
  ProbeResult,
  Project,
  RunActivity,
  RunResult,
  Task,
  UpdateEvent,
  UpdaterChannel,
} from '../../shared/types'
import { type ClientFrame, decodeFrame } from '../../shared/transport/protocol'

/**
 * ws-bridge(#197 B2) — Electron IPC(`window.fleet`) 대체용 FleetBridge WS 구현.
 *
 * 문 ②(브라우저 오케스트레이션 UI)를 여는 전송층: preload/main 의 IPC 4대 시맨틱을 WS 프레임으로
 * 재현한다. **WebSocket 팩토리 주입식**이라 DOM 없이 node vitest 로 전 계약을 검증할 수 있고, 이
 * 모듈은 아직 **미배선**(window.fleet 부재 시 폴백 배선은 B4). desktop 전용 표면(자동 업데이트)은
 * server 미등록이라 로컬 no-op/idle 스텁으로 채운다(reject 아님 — UI 는 AppInfo.runtime 으로 숨김).
 */

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'

/**
 * 주입되는 소켓의 최소 계약(브라우저 WebSocket 부분집합). 팩토리가 이 형태를 만족하는 객체를 준다 —
 * B4 는 `() => new WebSocket(url)` 어댑터를, 테스트는 페이크를 주입한다.
 */
export interface WsLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: ((err?: unknown) => void) | null
}

export type WsFactory = () => WsLike

export interface WsBridgeOptions {
  /** 새 소켓 생성 팩토리. 최초 접속·매 재접속마다 호출된다. */
  connect: WsFactory
  /**
   * per-request 타임아웃(ms). **미지정=무제한** — Electron invoke 는 타임아웃이 없고 runProject·
   * discuss 는 수 분씩 정당하게 pending 하므로 기본은 IPC 동형(무제한). 소켓 close 시 pending 은
   * 전원 reject 되므로 연결 소실은 이미 정리된다. 이 값은 "소켓은 살아있는데 서버 핸들러가 무응답"
   * 인 병리적 경우의 백스톱으로만 켠다(B4/deploy 가 장시간 채널을 피해 설정).
   */
  requestTimeoutMs?: number
  /** 재접속 초기 백오프(ms). 기본 1000. */
  initialBackoffMs?: number
  /** 재접속 백오프 상한(ms). 기본 30000. */
  maxBackoffMs?: number
  /** 자동 재접속 여부. 기본 true. false 면 예기치 않은 close 시 곧장 closed. */
  autoReconnect?: boolean
}

export interface WsBridge {
  /** window.fleet 를 대체하는 FleetBridge 구현. */
  fleet: FleetBridge
  /** 접속 상태 변화 구독(웹 전용 — B4 재하이드레이션 트리거). 해제 함수 반환. */
  onConnectionState(cb: (state: ConnectionState) => void): () => void
  /** 최근 hello 의 이벤트 커서 워터마크(재접속 gap 판정용 — B4). 미수신이면 null. */
  getEventCursor(): { maxEventSeq: number; minRetainedEventSeq: number } | null
  /** 현재 접속 상태. */
  connectionState(): ConnectionState
  /** 브리지 종료 — 소켓 close·pending 전원 reject·재접속 중단. */
  dispose(): void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

/** 끝의 undefined 인자를 잘라 데스크톱 IPC(structuredClone, undefined 보존)와 JSON 직렬화를 맞춘다. */
function trimTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return end === args.length ? args : args.slice(0, end)
}

export function createWsBridge(opts: WsBridgeOptions): WsBridge {
  const initialBackoff = opts.initialBackoffMs ?? 1000
  const maxBackoff = opts.maxBackoffMs ?? 30000
  const autoReconnect = opts.autoReconnect ?? true

  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const sendQueue: string[] = []

  let socket: WsLike | null = null
  let isOpen = false
  let disposed = false
  let lastId = 0
  let backoff = initialBackoff
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let state: ConnectionState = 'connecting'
  let hello: { maxEventSeq: number; minRetainedEventSeq: number } | null = null

  function setState(next: ConnectionState): void {
    if (next === state) return
    state = next
    for (const cb of [...stateListeners]) cb(next)
  }

  function send(frame: ClientFrame): void {
    const data = JSON.stringify(frame)
    if (socket && isOpen) socket.send(data)
    else sendQueue.push(data)
  }

  function invoke<T>(ch: string, ...args: unknown[]): Promise<T> {
    if (disposed) return Promise.reject(new Error('전송 브리지가 종료됨'))
    return new Promise<T>((resolve, reject) => {
      const id = ++lastId
      let timer: ReturnType<typeof setTimeout> | undefined
      if (opts.requestTimeoutMs != null) {
        timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`요청 시간 초과: ${ch}`))
        }, opts.requestTimeoutMs)
      }
      pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
      send({ t: 'req', id, ch, args: trimTrailingUndefined(args) })
    })
  }

  function subscribe<E>(ch: string, cb: (event: E) => void): () => void {
    let set = listeners.get(ch)
    if (!set) {
      set = new Set()
      listeners.set(ch, set)
    }
    const wrapped = cb as (event: unknown) => void
    set.add(wrapped) // 동일 참조 재구독은 Set 이 dedup(채널별 멱등)
    return () => {
      set.delete(wrapped)
    }
  }

  function handleMessage(data: unknown): void {
    const frame = decodeFrame(typeof data === 'string' ? data : String(data))
    if (!frame) return
    if (frame.t === 'res') {
      const entry = pending.get(frame.id)
      if (!entry) return // 무관/중복 응답 무시(멱등)
      pending.delete(frame.id)
      if (entry.timer) clearTimeout(entry.timer)
      if (frame.ok) entry.resolve(frame.value)
      else entry.reject(new Error(frame.error.message))
    } else if (frame.t === 'push') {
      const set = listeners.get(frame.ch)
      if (set) for (const cb of [...set]) cb(frame.event) // 스냅샷 순회 — 콜백이 해제해도 안전
    } else {
      hello = { maxEventSeq: frame.maxEventSeq, minRetainedEventSeq: frame.minRetainedEventSeq }
    }
  }

  function rejectAllPending(err: Error): void {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
    pending.clear()
    sendQueue.length = 0 // 미전송 요청도 폐기(대응 pending 은 위에서 reject 됨)
  }

  function flushQueue(): void {
    if (!socket) return
    for (const data of sendQueue) socket.send(data)
    sendQueue.length = 0
  }

  function scheduleReconnect(): void {
    setState('reconnecting')
    const delay = backoff
    backoff = Math.min(backoff * 2, maxBackoff)
    reconnectTimer = setTimeout(openSocket, delay)
  }

  function handleClose(): void {
    isOpen = false
    rejectAllPending(new Error('전송 연결이 끊김'))
    if (disposed || !autoReconnect) {
      setState('closed')
      return
    }
    scheduleReconnect()
  }

  function openSocket(): void {
    socket = opts.connect()
    socket.onopen = (): void => {
      isOpen = true
      backoff = initialBackoff // 성공 접속 시 백오프 리셋
      setState('connected')
      flushQueue()
    }
    socket.onmessage = (ev): void => handleMessage(ev.data)
    socket.onclose = (): void => handleClose()
    socket.onerror = (): void => {
      /* 브라우저는 error 뒤에 close 를 발화 — 재접속은 onclose 단일 경로에서 처리 */
    }
  }

  openSocket()

  const fleet: FleetBridge = {
    getAppInfo: () => invoke<AppInfo>('fleet:app:info'),

    // 세션 / CLI
    detectClis: () => invoke<CliDetectionResult[]>('fleet:cli:detect'),
    listAdapters: () => invoke<CliAdapter[]>('fleet:cli:adapters'),
    registerCliSession: (adapterId, opts_) =>
      invoke<LlmDescriptor>('fleet:session:registerCli', adapterId, opts_),
    registerApiSession: (config) => invoke<LlmDescriptor>('fleet:session:registerApi', config),
    listSessions: () => invoke<LlmDescriptor[]>('fleet:session:list'),
    removeSession: (id) => invoke<void>('fleet:session:remove', id),
    setSessionCapabilities: (id, roles) =>
      invoke<LlmDescriptor>('fleet:session:capabilities', id, roles),
    listModels: (config) => invoke<ModelOption[]>('fleet:session:listModels', config),
    // 웹은 Electron shell 이 없다 — server 가 검증된 docsUrl 을 반환(desktop 은 void), 브리지가 여기서
    // window.open(noopener). FleetBridge.openCliDocs 표면은 Promise<void> 로 데스크톱과 동일 유지.
    openCliDocs: async (adapterId) => {
      const url = await invoke<unknown>('fleet:external:openDocs', adapterId)
      if (typeof url === 'string' && url) {
        ;(
          globalThis as { open?: (url: string, target: string, features: string) => unknown }
        ).open?.(url, '_blank', 'noopener')
      }
    },
    probeCli: (adapterId) => invoke<ProbeResult>('fleet:cli:probe', adapterId),

    // 프로젝트 / 오케스트레이션
    listProjects: () => invoke<Project[]>('fleet:project:list'),
    getProjectTasks: (projectId) => invoke<Task[]>('fleet:project:tasks', projectId),
    listProjectEvents: (projectId) => invoke<FleetEvent[]>('fleet:project:events', projectId),
    getLastActiveProject: () => invoke<string | null>('fleet:project:lastActive:get'),
    setLastActiveProject: (projectId) => invoke<void>('fleet:project:lastActive:set', projectId),
    runProject: (req) => invoke<RunResult>('fleet:project:run', req),
    cancelRun: (projectId) => invoke<void>('fleet:project:cancel', projectId),
    getRunActivity: () => invoke<RunActivity>('fleet:project:activity'),
    getWorkspace: () => invoke<string | null>('fleet:workspace:get'),
    selectWorkspace: () => invoke<string | null>('fleet:workspace:select'),

    // 채팅
    createRoom: (title, participants) =>
      invoke<ChatRoom>('fleet:chat:createRoom', title, participants),
    listRooms: () => invoke<ChatRoom[]>('fleet:chat:listRooms'),
    roomHistory: (roomId) => invoke<ChatMessage[]>('fleet:chat:history', roomId),
    postUserMessage: (roomId, content) =>
      invoke<ChatMessage>('fleet:chat:postUser', roomId, content),
    askLlm: (roomId, llmId) => invoke<ChatMessage>('fleet:chat:askLlm', roomId, llmId),
    discussRoom: (roomId, llmIds, rounds) =>
      invoke<ChatMessage[]>('fleet:chat:discuss', roomId, llmIds, rounds),
    cancelChat: (roomId) => invoke<void>('fleet:chat:cancel', roomId),
    getChatActivity: () => invoke<ChatActivity>('fleet:chat:activity'),

    // MCP 호스트
    setMcpServers: (servers) => invoke<McpServerStatus[]>('fleet:mcp:setServers', servers),
    getMcpStatus: () => invoke<McpServerStatus[]>('fleet:mcp:getStatus'),

    // 감사 / 이벤트
    listEvents: () => invoke<FleetEvent[]>('fleet:events:list'),
    onOrchestratorEvent: (callback) => subscribe('fleet:orchestrator:event', callback),
    onChatStream: (callback) => subscribe('fleet:chat:stream', callback),
    onApprovalRequest: (callback) => subscribe('fleet:approval:request', callback),
    respondApproval: (id, approved) => invoke<void>('fleet:approval:respond', id, approved),

    // 자동 업데이트 — Electron 전용(server 미등록). 웹에선 no-op/idle 스텁(reject 아님).
    getUpdateState: () => Promise.resolve<UpdateEvent>({ kind: 'unsupported' }),
    checkForUpdate: () => Promise.resolve(),
    downloadUpdate: () => Promise.resolve(),
    installUpdate: () => Promise.resolve(),
    dismissUpdate: () => Promise.resolve(),
    onUpdateEvent: () => () => {
      /* 웹은 업데이트 이벤트 없음 — 구독은 no-op 해제 함수 */
    },
    getUpdaterChannel: () => Promise.resolve<UpdaterChannel>('stable'),
    setUpdaterChannel: () => Promise.resolve(),
  }

  return {
    fleet,
    onConnectionState: (cb) => {
      stateListeners.add(cb)
      return () => {
        stateListeners.delete(cb)
      }
    },
    getEventCursor: () => (hello ? { ...hello } : null),
    connectionState: () => state,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      rejectAllPending(new Error('전송 브리지가 종료됨'))
      socket?.close()
      setState('closed')
    },
  }
}

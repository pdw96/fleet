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
import { decodeFrame, type ReqFrame } from '../../shared/transport/protocol'

/**
 * ws-bridge(#197 B2) — Electron IPC(`window.fleet`) 대체용 FleetBridge WS 구현.
 *
 * 문 ②(브라우저 오케스트레이션 UI)를 여는 전송층: preload/main 의 IPC 4대 시맨틱을 WS 프레임으로
 * 재현한다. **WebSocket 팩토리 주입식**이라 DOM 없이 node vitest 로 전 계약을 검증할 수 있고, 이
 * 모듈은 아직 **미배선**(window.fleet 부재 시 폴백 배선은 B4). desktop 전용 표면(자동 업데이트)은
 * server 미등록이라 로컬 no-op/idle 스텁으로 채운다(reject 아님 — UI 는 AppInfo.runtime 으로 숨김).
 */

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'

/** 전송층 사유. B4 가 이 사유로 "전송 문제(재접속·재하이드레이션)"를 "연산 실패"와 구분한다. */
export type TransportErrorReason = 'disconnected' | 'closed' | 'timeout'

/**
 * 전송층 유래 reject(#197 B2 리뷰 Codex P2). 소켓 드롭·종료·요청 타임아웃으로 pending 이 reject 될 때
 * 서버 연산 실패(plain Error)와 구분되는 타입을 실어, B4 호출부가 이를 연산 완료/실패로 오인하지 않고
 * 재접속→RunActivity 스냅숏 재하이드레이션으로 복구하게 한다(correlation 은 소켓별이라 pending 보존 불가).
 */
export class TransportError extends Error {
  readonly reason: TransportErrorReason
  constructor(reason: TransportErrorReason, message: string) {
    super(message)
    this.name = 'TransportError'
    this.reason = reason
  }
}

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
  /**
   * 접속 상태 변화 구독(웹 전용). 해제 함수 반환. 'connected' 는 소켓 open + offline 큐 flush 완료를
   * 뜻한다(리스너 read 가 큐잉된 write 를 앞지르지 않음). 단 이벤트 커서(hello)는 그 직후 비동기로
   * 도착하므로, **재하이드레이션 트리거는 onEventCursor 를 쓴다**(onConnectionState 는 전송 상태 표시용).
   */
  onConnectionState(cb: (state: ConnectionState) => void): () => void
  /**
   * 이벤트 커서(hello) 수신 통지(웹 전용 — B4 재하이드레이션의 실제 트리거). 소켓 open 후 서버가
   * hello 를 보내면 발화하며, 이 시점에 getEventCursor() 도 갱신돼 있다. 재접속마다 새 hello 로 다시
   * 발화 → B4 는 커서로 gap 을 판정해 전체/증분 재하이드레이션을 결정한다. 해제 함수 반환.
   */
  onEventCursor(
    cb: (cursor: { maxEventSeq: number; minRetainedEventSeq: number }) => void,
  ): () => void
  /**
   * 최근 hello 의 이벤트 커서 워터마크(재접속 gap 판정용 — B4). hello 수신 전·재접속 직후엔 null
   * (이전 연결의 stale 커서를 노출하지 않는다). 준비 시점은 onEventCursor 로 통지된다.
   */
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

  type EventCursor = { maxEventSeq: number; minRetainedEventSeq: number }
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const cursorListeners = new Set<(cursor: EventCursor) => void>()
  // 미open 중 발행된 요청 프레임(id 태그 — flush 시 이미 타임아웃/취소된 고아 프레임을 거른다).
  const sendQueue: { id: number; data: string }[] = []

  let socket: WsLike | null = null
  let isOpen = false
  let disposed = false
  let lastId = 0
  let backoff = initialBackoff
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let state: ConnectionState = 'connecting'
  let hello: EventCursor | null = null

  function setState(next: ConnectionState): void {
    if (next === state) return
    state = next
    // 콜백 예외 격리 — 리스너 throw 가 재접속 스케줄 등 상태 전이 후속을 막지 않게(push/cursor 와 동형).
    for (const cb of [...stateListeners]) {
      try {
        cb(next)
      } catch {
        /* 소비자 콜백 오류는 전송층에서 삼킨다 */
      }
    }
  }

  function send(frame: ReqFrame): void {
    const data = JSON.stringify(frame)
    if (socket && isOpen) socket.send(data)
    else sendQueue.push({ id: frame.id, data })
  }

  function invoke<T>(ch: string, ...args: unknown[]): Promise<T> {
    // terminal 상태(종료·재접속 없는 close)에서는 요청이 큐에 갇혀 영구 hang 하므로 즉시 reject.
    if (disposed || state === 'closed') {
      return Promise.reject(new TransportError('closed', '전송 브리지가 종료됨'))
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++lastId
      let timer: ReturnType<typeof setTimeout> | undefined
      if (opts.requestTimeoutMs != null) {
        timer = setTimeout(() => {
          pending.delete(id)
          reject(new TransportError('timeout', `요청 시간 초과: ${ch}`))
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
      if (set) {
        // 스냅샷 순회(콜백이 해제해도 안전) + 콜백 예외 격리(한 리스너 throw 가 나머지·소켓 루프를 깨지 않게).
        for (const cb of [...set]) {
          try {
            cb(frame.event)
          } catch {
            /* 소비자 콜백 오류는 전송층에서 삼킨다 — 관측은 콜백 내부 책임 */
          }
        }
      }
    } else {
      hello = { maxEventSeq: frame.maxEventSeq, minRetainedEventSeq: frame.minRetainedEventSeq }
      // 커서 준비 통지(B4 재하이드레이션 트리거) — 콜백 예외는 격리해 소켓 루프를 지킨다.
      const cursor = hello
      for (const cb of [...cursorListeners]) {
        try {
          cb({ ...cursor })
        } catch {
          /* 소비자 콜백 오류는 전송층에서 삼킨다 */
        }
      }
    }
  }

  /** 전원 reject + 큐 폐기(dispose·terminal close 용). */
  function rejectAllPending(err: Error): void {
    for (const entry of pending.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
    pending.clear()
    sendQueue.length = 0
  }

  /**
   * transient close(재접속 예정) 용 — **이미 전송된** 요청만 reject(응답 소실). 아직 미전송인
   * 큐(sendQueue) 요청은 보존해 다음 open 의 flush 에 태운다(offline 큐의 목적). id 가 sendQueue 에
   * 남아있으면 미전송으로 판정한다.
   */
  function rejectSentPending(err: Error): void {
    const queuedIds = new Set(sendQueue.map((q) => q.id))
    for (const [id, entry] of [...pending]) {
      if (queuedIds.has(id)) continue // 미전송 — 보존
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
      pending.delete(id)
    }
    // sendQueue 는 유지(보존된 pending 과 짝).
  }

  function flushQueue(): void {
    if (!socket) return
    // 아직 pending 인 요청만 전송 — 큐잉 후 타임아웃/취소된 고아 프레임은 건너뛴다.
    for (const q of sendQueue) if (pending.has(q.id)) socket.send(q.data)
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
    hello = null // 재접속 후 이전 연결의 stale 커서를 노출하지 않는다(gap 오판 방지).
    if (disposed || !autoReconnect) {
      // terminal — 큐 포함 전원 reject(재접속으로 flush 될 기회가 없다).
      rejectAllPending(new TransportError('disconnected', '전송 연결이 끊김'))
      setState('closed')
      return
    }
    // transient — 전송된 것만 reject, 미전송 큐는 다음 open 까지 보존.
    rejectSentPending(new TransportError('disconnected', '전송 연결이 끊김'))
    scheduleReconnect()
  }

  function openSocket(): void {
    socket = opts.connect()
    socket.onopen = (): void => {
      isOpen = true
      backoff = initialBackoff // 성공 접속 시 백오프 리셋
      // 큐를 먼저 flush 한 뒤 통지 — 'connected' 리스너의 read 가 offline 큐잉된 write 를 앞지르지 않게.
      flushQueue()
      setState('connected')
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
      // 서버(B3)가 allowlist 검증 후 URL 을 반환하지만, 클라도 http(s) 스킴만 열어 javascript:/data:
      // 같은 위험 스킴을 방어(defense-in-depth). noopener 로 opener 접근 차단.
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
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
    onEventCursor: (cb) => {
      cursorListeners.add(cb)
      return () => {
        cursorListeners.delete(cb)
      }
    },
    getEventCursor: () => (hello ? { ...hello } : null),
    connectionState: () => state,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      rejectAllPending(new TransportError('closed', '전송 브리지가 종료됨'))
      socket?.close()
      setState('closed')
    },
  }
}

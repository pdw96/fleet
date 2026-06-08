import type { McpCallResult, McpClient, McpClientOptions, McpToolInfo, McpTransport } from './types'

/** 우리가 보내는 MCP 프로토콜 버전. 서버가 더 낮은 버전을 echo 해도 하드 실패하지 않는다. */
const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** tools/list 페이지네이션 추종 상한 — 악의/버그 서버의 무한 페이지네이션을 결정론적으로 끊는다. */
const MAX_TOOLS_LIST_PAGES = 100
/** clientInfo.version — package.json 과 동기화(드리프트 시 수정). */
const CLIENT_VERSION = '0.1.0'

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: unknown
  /** abort 리스너 해제(있으면). settle 이 호출해 공유 signal 에 리스너가 누적되지 않게 한다. */
  detach?: () => void
}

/**
 * 단일 MCP 서버와의 JSON-RPC 2.0 세션. transport(프레이밍)는 주입받는다.
 * id 로 요청/응답을 상관하고, 타임아웃·abort·연결 종료 시 대기 요청을 정리한다.
 */
export function createMcpClient(transport: McpTransport, opts: McpClientOptions = {}): McpClient {
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const pending = new Map<number, Pending>()
  let nextId = 1
  let closed = false
  let closeError: Error | undefined
  let closeHandler: ((err?: Error) => void) | undefined

  /**
   * 대기 요청 1개를 정리한다 — pending 제거 + 타이머 클리어 + abort 리스너 해제. 모든 종료 경로
   * (응답 수신·타임아웃·abort)가 이 한 곳을 거쳐 타이머/리스너 누수와 이중 settle 을 막는다.
   * 이미 정리됐으면 undefined 를 돌려 중복 호출이 no-op 이 되게 한다(이중 취소 알림 방지).
   */
  function settle(id: number): Pending | undefined {
    const p = pending.get(id)
    if (!p) return undefined
    pending.delete(id)
    clearTimer(p.timer)
    p.detach?.()
    return p
  }

  transport.onMessage((msg) => {
    // 서버 발신 요청/알림은 method 를 가진다 — 응답(result/error)과 구분한다. 이걸 안 하면
    // 서버 요청 id 가 우리 pending id 와 겹칠 때 엉뚱한 요청을 resolve 해버린다.
    if (typeof msg['method'] === 'string') {
      const reqId = msg['id']
      if (reqId == null) return // 알림(notifications/*) — 무시
      // 서버 발신 요청: ping 만 빈 결과로 응답하고, 그 외 미지원 메서드는 method-not-found 로 회신.
      if (msg['method'] === 'ping') {
        transport.send({ jsonrpc: '2.0', id: reqId, result: {} })
      } else {
        transport.send({
          jsonrpc: '2.0',
          id: reqId,
          error: { code: -32601, message: `method not found: ${String(msg['method'])}` },
        })
      }
      return
    }
    // 응답: id 로 pending 요청과 상관한다. settle 이 타이머/abort 리스너까지 정리한다.
    const id = msg['id']
    if (typeof id !== 'number') return
    const p = settle(id)
    if (!p) return
    if (msg['error']) {
      const e = msg['error'] as { message?: string; code?: number }
      p.reject(new Error(`MCP 오류 ${e.code ?? ''}: ${e.message ?? 'unknown'}`.trim()))
    } else {
      p.resolve((msg['result'] as Record<string, unknown>) ?? {})
    }
  })

  transport.onClose((err) => {
    closed = true
    closeError = err ?? new Error('MCP 연결이 종료되었습니다.')
    for (const [, p] of pending) {
      clearTimer(p.timer)
      p.detach?.() // abort 리스너 해제(공유 signal 누수 방지)
      p.reject(closeError)
    }
    pending.clear()
    closeHandler?.(closeError) // 외부(호스트) 구독자에게 종료를 통지
  })

  /**
   * 진행 중 요청을 서버측에서도 중단시킨다(MCP cancellation). abort/타임아웃으로 로컬 pending 을
   * 버릴 때만 호출 — 알림을 안 보내면 long-running/destructive 도구가 서버측에서 계속 실행된다.
   * 호출부에서 (a) 아직 in-flight 인 요청에 대해서만, (b) initialize 가 아닐 때만, (c) 연결이
   * 닫히기 전에만 부르므로 스펙의 전송 조건을 만족한다. closed 가드는 방어적 중복.
   * 스펙: https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/cancellation
   */
  function notifyCancelled(id: number, reason: string): void {
    if (closed) return
    transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } })
  }

  function request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (closed) return Promise.reject(closeError ?? new Error('MCP 연결이 닫혔습니다.'))
    if (signal?.aborted) return Promise.reject(new Error('요청이 취소되었습니다.'))
    const id = nextId++
    // initialize 는 취소 대상이 아니다(MCP 스펙) — 그 외 요청만 abort/타임아웃 시 서버에 취소 알림.
    const cancellable = method !== 'initialize'
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // abort 핸들러 — settle 로 정리(중복 settle no-op)하고 in-flight 였으면 서버에 취소 알림.
      // AbortSignal 은 'abort' 를 최대 1회만 dispatch 하므로 once 옵션 없이도 중복 발화는 없다.
      const onAbort = (): void => {
        const p = settle(id)
        if (p) {
          if (cancellable) notifyCancelled(id, '클라이언트가 요청을 취소했습니다.')
          p.reject(new Error('요청이 취소되었습니다.'))
        }
      }
      const timer = setTimer(() => {
        const p = settle(id)
        if (p) {
          if (cancellable) notifyCancelled(id, `요청 타임아웃(${timeoutMs}ms)`)
          p.reject(new Error(`MCP 요청 타임아웃(${method}, ${timeoutMs}ms).`))
        }
      }, timeoutMs)
      // detach 로 정상 종료 경로에서도 리스너를 제거한다(공유 per-run signal 에 리스너 누적 방지).
      pending.set(id, {
        resolve,
        reject,
        timer,
        detach: signal ? () => signal.removeEventListener('abort', onAbort) : undefined,
      })
      if (signal) signal.addEventListener('abort', onAbort)
      transport.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  return {
    async initialize() {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'fleet', version: CLIENT_VERSION },
      })
      transport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    },
    async listTools(): Promise<McpToolInfo[]> {
      // nextCursor 를 따라 모든 페이지를 모은다(MCP 페이지네이션). 결정론적 종료:
      // (a) nextCursor 가 문자열이 아니면(부재 포함) 끝 — 단 '존재하는' 빈 문자열은 유효한 불투명
      //     커서로 취급한다(스펙: nextCursor 가 존재하면 더 있음; 커서는 불투명이라 ''도 토큰일 수 있음),
      // (b) 같은 커서 반복(서버 버그) 시 중단, (c) 페이지 상한 초과 시 중단
      //  — (b)·(c) 가드가 ''를 토큰으로 따라가더라도 무한 페이지네이션을 막는다.
      const all: McpToolInfo[] = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 1; ; page++) {
        const result = await request('tools/list', cursor != null ? { cursor } : {})
        const tools = result['tools']
        if (Array.isArray(tools)) all.push(...(tools as McpToolInfo[]))
        const next = result['nextCursor']
        if (typeof next !== 'string') break // nextCursor 부재/비문자열 = 더 이상 페이지 없음
        if (seenCursors.has(next)) {
          console.warn('MCP tools/list 가 동일 nextCursor 를 반복했습니다 — 페이지네이션 추종을 중단합니다(서버 버그 의심).')
          break
        }
        if (page >= MAX_TOOLS_LIST_PAGES) {
          console.warn(`MCP tools/list 페이지가 상한(${MAX_TOOLS_LIST_PAGES})을 초과했습니다 — 이후 페이지는 생략합니다.`)
          break
        }
        seenCursors.add(next)
        cursor = next
      }
      return all
    },
    async callTool(name, args, callOpts): Promise<McpCallResult> {
      const result = await request('tools/call', { name, arguments: args ?? {} }, callOpts?.signal)
      const content = result['content']
      return {
        content: Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [],
        isError: result['isError'] === true,
      }
    },
    onClose(handler) {
      closeHandler = handler
    },
    close() {
      transport.close()
    },
  }
}

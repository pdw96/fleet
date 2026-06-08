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
    // 응답: id 로 pending 요청과 상관한다.
    const id = msg['id']
    if (typeof id !== 'number') return
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimer(p.timer)
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
      p.reject(closeError)
    }
    pending.clear()
    closeHandler?.(closeError) // 외부(호스트) 구독자에게 종료를 통지
  })

  function request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (closed) return Promise.reject(closeError ?? new Error('MCP 연결이 닫혔습니다.'))
    if (signal?.aborted) return Promise.reject(new Error('요청이 취소되었습니다.'))
    const id = nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimer(() => {
        if (pending.delete(id)) reject(new Error(`MCP 요청 타임아웃(${method}, ${timeoutMs}ms).`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            const p = pending.get(id)
            if (p) {
              pending.delete(id)
              clearTimer(p.timer)
              p.reject(new Error('요청이 취소되었습니다.'))
            }
          },
          { once: true },
        )
      }
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

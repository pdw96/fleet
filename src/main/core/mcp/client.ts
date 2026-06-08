import type { McpCallResult, McpClient, McpClientOptions, McpToolInfo, McpTransport } from './types'

/** 우리가 보내는 MCP 프로토콜 버전. 서버가 더 낮은 버전을 echo 해도 하드 실패하지 않는다. */
const PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
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
    const id = msg['id']
    if (typeof id !== 'number') return // 알림/미상 응답 — 무시
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
      const result = await request('tools/list', {})
      if (result['nextCursor'] != null) {
        // 페이지네이션 미구현(후속) — 첫 페이지만 사용한다. 잘림을 조용히 넘기지 않고 경고로 표면화(#7).
        console.warn('MCP tools/list 가 페이지네이션으로 잘렸습니다(nextCursor 존재) — 첫 페이지 도구만 노출됩니다.')
      }
      const tools = result['tools']
      return Array.isArray(tools) ? (tools as McpToolInfo[]) : []
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

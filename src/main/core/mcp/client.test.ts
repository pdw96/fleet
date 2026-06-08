import { describe, expect, it, vi } from 'vitest'
import { createMcpClient } from './client'
import type { McpTransport } from './types'

/** 인메모리 fake transport — send 캡처·응답/종료 주입. */
function fakeTransport() {
  let onMsg: (m: Record<string, unknown>) => void = () => {}
  let onClose: (e?: Error) => void = () => {}
  const sent: Record<string, unknown>[] = []
  const transport: McpTransport = {
    send: (m) => sent.push(m),
    onMessage: (h) => {
      onMsg = h
    },
    onClose: (h) => {
      onClose = h
    },
    close: () => onClose(new Error('closed')),
  }
  return { transport, sent, reply: (m: Record<string, unknown>) => onMsg(m), kill: (e?: Error) => onClose(e) }
}

describe('createMcpClient', () => {
  it('initialize 후 initialized 알림을 보낸다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.initialize()
    expect(f.sent[0]).toMatchObject({ method: 'initialize', id: 1 })
    f.reply({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })
    await p
    expect(f.sent[1]).toMatchObject({ method: 'notifications/initialized' })
    expect(f.sent[1]['id']).toBeUndefined()
  })

  it('listTools 는 tools 배열을 반환한다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.listTools()
    f.reply({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't' }] } })
    expect(await p).toEqual([{ name: 't' }])
  })

  it('callTool 은 name/arguments 를 보내고 content·isError 를 매핑한다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.callTool('t', { a: 1 })
    expect(f.sent[0]).toMatchObject({ method: 'tools/call', params: { name: 't', arguments: { a: 1 } } })
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }], isError: true } })
    expect(await p).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: true })
  })

  it('JSON-RPC error 응답은 reject 한다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.listTools()
    f.reply({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no method' } })
    await expect(p).rejects.toThrow(/no method/)
  })

  it('transport 종료 시 대기 요청을 reject 한다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.listTools()
    f.kill(new Error('child died'))
    await expect(p).rejects.toThrow(/child died/)
  })

  it('요청 타임아웃 시 reject 한다', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => {} })
    const p = c.listTools()
    fire!()
    await expect(p).rejects.toThrow(/타임아웃/)
  })

  it('abort 신호로 요청을 취소한다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac = new AbortController()
    const p = c.callTool('t', {}, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow(/취소/)
  })

  it('tools/list 의 nextCursor 를 따라 모든 페이지를 모은다(커서를 params 로 전달)', async () => {
    const pages: Record<string, { tools: { name: string }[]; nextCursor?: string }> = {
      '': { tools: [{ name: 'a' }], nextCursor: 'c1' },
      c1: { tools: [{ name: 'b' }], nextCursor: 'c2' },
      c2: { tools: [{ name: 'c' }] },
    }
    let onMsg: (m: Record<string, unknown>) => void = () => {}
    const sentCursors: (string | undefined)[] = []
    const transport: McpTransport = {
      send: (m) => {
        if (m['method'] !== 'tools/list') return
        const cursor = (m['params'] as { cursor?: string }).cursor
        sentCursors.push(cursor)
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id: m['id'], result: pages[cursor ?? ''] }))
      },
      onMessage: (h) => {
        onMsg = h
      },
      onClose: () => {},
      close: () => {},
    }
    const c = createMcpClient(transport)
    expect(await c.listTools()).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    expect(sentCursors).toEqual([undefined, 'c1', 'c2'])
  })

  it('tools/list 가 동일 nextCursor 를 반복하면 추종을 멈춘다(무한루프 방지)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let onMsg: (m: Record<string, unknown>) => void = () => {}
    let count = 0
    const transport: McpTransport = {
      send: (m) => {
        if (m['method'] !== 'tools/list') return
        count++
        const id = m['id']
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id, result: { tools: [{ name: `t${count}` }], nextCursor: 'same' } }))
      },
      onMessage: (h) => {
        onMsg = h
      },
      onClose: () => {},
      close: () => {},
    }
    const c = createMcpClient(transport)
    const tools = await c.listTools()
    // 1페이지(커서 없음)→'same', 2페이지(커서 'same')→또 'same' → 반복 감지 후 중단.
    expect(count).toBe(2)
    expect(tools).toHaveLength(2)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('tools/list 페이지가 상한을 넘으면 경고하고 멈춘다(결정론적 종료)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let onMsg: (m: Record<string, unknown>) => void = () => {}
    let count = 0
    const transport: McpTransport = {
      send: (m) => {
        if (m['method'] !== 'tools/list') return
        count++
        const id = m['id']
        // 매 페이지 새 고유 커서 → 상한이 없으면 무한. 상한에서 멈춰야 한다.
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id, result: { tools: [{ name: `t${count}` }], nextCursor: `c${count}` } }))
      },
      onMessage: (h) => {
        onMsg = h
      },
      onClose: () => {},
      close: () => {},
    }
    const c = createMcpClient(transport)
    const tools = await c.listTools()
    expect(count).toBe(100) // MAX_TOOLS_LIST_PAGES
    expect(tools).toHaveLength(100)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('상한'))
    warn.mockRestore()
  })

  it('연결 종료를 onClose 핸들러로 통지한다(호스트의 죽은 서버 무효화용)', () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    let err: Error | undefined
    c.onClose((e) => {
      err = e
    })
    f.kill(new Error('죽음'))
    expect(err?.message).toBe('죽음')
  })

  it('서버가 보낸 ping 요청에 빈 결과로 응답한다', () => {
    const f = fakeTransport()
    createMcpClient(f.transport)
    f.reply({ jsonrpc: '2.0', id: 7, method: 'ping' })
    expect(f.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
  })

  it('미지원 서버 요청은 method-not-found 로 회신하고 같은 id 의 pending 을 건드리지 않는다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.callTool('t', {}) // pending id 1
    // 서버가 우리 pending 과 같은 id(1)로 요청을 보내도 응답으로 오인해 resolve 하면 안 된다.
    f.reply({ jsonrpc: '2.0', id: 1, method: 'sampling/createMessage' })
    expect(f.sent.at(-1)).toMatchObject({ id: 1, error: { code: -32601 } })
    // pending 은 살아있어야 한다 — 실제 응답(method 없음)으로만 resolve.
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    expect(await p).toEqual({ content: [], isError: false })
  })
})

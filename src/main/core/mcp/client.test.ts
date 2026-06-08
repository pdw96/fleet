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

  it('tools/list 가 nextCursor 로 잘리면 경고를 표면화한다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.listTools()
    f.reply({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 't' }], nextCursor: 'next' } })
    expect(await p).toEqual([{ name: 't' }])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

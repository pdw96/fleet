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

  it('abort 시 진행 중 요청에 notifications/cancelled 를 보낸다(requestId 상관, 알림이라 id 없음)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac = new AbortController()
    const p = c.callTool('t', {}, { signal: ac.signal })
    expect(f.sent[0]).toMatchObject({ method: 'tools/call', id: 1 })
    ac.abort()
    await expect(p).rejects.toThrow(/취소/)
    // 서버측이 long-running/destructive 도구 실행을 중단하도록 같은 id 로 취소 알림을 보낸다.
    expect(f.sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 1 } })
    expect(typeof f.sent.at(-1)?.['params']).toBe('object')
    expect((f.sent.at(-1)?.['params'] as { reason?: unknown })['reason']).toEqual(expect.any(String))
    expect(f.sent.at(-1)?.['id']).toBeUndefined()
  })

  it('요청 타임아웃 시 notifications/cancelled 를 보낸다', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => {} })
    const p = c.callTool('t', {})
    fire!()
    await expect(p).rejects.toThrow(/타임아웃/)
    expect(f.sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 1 } })
  })

  it('initialize 는 타임아웃돼도 취소 알림을 보내지 않는다(스펙: initialize 취소 불가)', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => {} })
    const p = c.initialize()
    fire!()
    await expect(p).rejects.toThrow(/타임아웃/)
    expect(f.sent.some((m) => m['method'] === 'notifications/cancelled')).toBe(false)
  })

  it('이미 응답이 도착한 요청은 이후 abort 해도 취소 알림을 보내지 않는다(완료 요청 미취소)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac = new AbortController()
    const p = c.callTool('t', {}, { signal: ac.signal })
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await p
    ac.abort()
    expect(f.sent.some((m) => m['method'] === 'notifications/cancelled')).toBe(false)
  })

  it('transport 종료 후 abort 해도 취소 알림을 보내지 않는다(닫힌 연결엔 미전송)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac = new AbortController()
    const p = c.callTool('t', {}, { signal: ac.signal })
    f.kill(new Error('child died'))
    await expect(p).rejects.toThrow(/child died/)
    ac.abort()
    expect(f.sent.some((m) => m['method'] === 'notifications/cancelled')).toBe(false)
  })

  it('동시 in-flight 요청 중 abort 된 요청의 id 로만 취소 알림을 보낸다(requestId 상관)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const p1 = c.callTool('a', {}, { signal: ac1.signal }) // id 1
    const p2 = c.callTool('b', {}, { signal: ac2.signal }) // id 2
    ac2.abort()
    await expect(p2).rejects.toThrow(/취소/)
    // 마지막 id·nextId-1 이 아니라 '취소된 그 요청(2)'의 id 여야 한다 — 엉뚱한 요청을 취소하면 안 됨.
    expect(f.sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 2 } })
    expect(
      f.sent.some((m) => m['method'] === 'notifications/cancelled' && (m['params'] as { requestId?: number }).requestId === 1),
    ).toBe(false)
    // p1 은 살아있어 정상 응답으로 resolve 된다(잘못 취소되지 않음).
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    expect(await p1).toEqual({ content: [], isError: false })
  })

  it('동시 요청 중 첫 요청만 abort 하면 첫 요청 id 로만 취소 알림을 보낸다(대칭)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    const p1 = c.callTool('a', {}, { signal: ac1.signal }) // id 1
    const p2 = c.callTool('b', {}, { signal: ac2.signal }) // id 2
    ac1.abort()
    await expect(p1).rejects.toThrow(/취소/)
    expect(f.sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 1 } })
    f.reply({ jsonrpc: '2.0', id: 2, result: { content: [] } })
    expect(await p2).toEqual({ content: [], isError: false })
  })

  it('취소 후 늦게 도착한 동일 id 응답은 무시한다(스펙 규칙4: 이중 settle 금지)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac = new AbortController()
    const p = c.callTool('t', {}, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toThrow(/취소/)
    // 취소 후 서버가 뒤늦게 같은 id 로 결과를 보내도 throw 없이 무시되어야 한다(pending 비어 있음).
    expect(() => f.reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'late' }] } })).not.toThrow()
    await expect(p).rejects.toThrow(/취소/) // 재-resolve 되지 않는다
  })

  it('abort 와 타임아웃이 같은 요청에 겹쳐도 취소 알림은 한 번만 보낸다(idempotency)', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => {} })
    const ac = new AbortController()
    const p = c.callTool('t', {}, { signal: ac.signal })
    fire!() // 타임아웃 먼저
    ac.abort() // 이어서 abort — 두 번째 settle 은 no-op
    await expect(p).rejects.toThrow()
    expect(f.sent.filter((m) => m['method'] === 'notifications/cancelled')).toHaveLength(1)
  })

  it('initialize 가 아닌 요청(listTools)도 타임아웃 시 취소 알림을 보낸다(per-request 취소)', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, { setTimer: (fn) => ((fire = fn), 1), clearTimer: () => {} })
    const p = c.listTools()
    fire!()
    await expect(p).rejects.toThrow(/타임아웃/)
    expect(f.sent.at(-1)).toMatchObject({ method: 'notifications/cancelled', params: { requestId: 1 } })
  })

  it('요청 완료 시 abort 리스너를 제거한다(공유 signal 리스너 누수 방지)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac = new AbortController()
    const remove = vi.spyOn(ac.signal, 'removeEventListener')
    const p = c.callTool('t', {}, { signal: ac.signal })
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await p
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
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

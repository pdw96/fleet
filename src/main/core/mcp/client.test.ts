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
  return {
    transport,
    sent,
    reply: (m: Record<string, unknown>) => onMsg(m),
    kill: (e?: Error) => onClose(e),
  }
}

describe('createMcpClient', () => {
  it('initialize 후 initialized 알림을 보낸다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.initialize()
    expect(f.sent[0]).toMatchObject({ method: 'initialize', id: 1 })
    f.reply({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } })
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
    expect(f.sent[0]).toMatchObject({
      method: 'tools/call',
      params: { name: 't', arguments: { a: 1 } },
    })
    f.reply({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'ok' }], isError: true },
    })
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
    const c = createMcpClient(f.transport, {
      setTimer: (fn) => ((fire = fn), 1),
      clearTimer: () => {},
    })
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
    expect(f.sent.at(-1)).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    })
    expect(typeof f.sent.at(-1)?.['params']).toBe('object')
    expect((f.sent.at(-1)?.['params'] as { reason?: unknown })['reason']).toEqual(
      expect.any(String),
    )
    expect(f.sent.at(-1)?.['id']).toBeUndefined()
  })

  it('요청 타임아웃 시 notifications/cancelled 를 보낸다', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, {
      setTimer: (fn) => ((fire = fn), 1),
      clearTimer: () => {},
    })
    const p = c.callTool('t', {})
    fire!()
    await expect(p).rejects.toThrow(/타임아웃/)
    expect(f.sent.at(-1)).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    })
  })

  it('initialize 는 타임아웃돼도 취소 알림을 보내지 않는다(스펙: initialize 취소 불가)', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, {
      setTimer: (fn) => ((fire = fn), 1),
      clearTimer: () => {},
    })
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
    expect(f.sent.at(-1)).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: 2 },
    })
    expect(
      f.sent.some(
        (m) =>
          m['method'] === 'notifications/cancelled' &&
          (m['params'] as { requestId?: number }).requestId === 1,
      ),
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
    expect(f.sent.at(-1)).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    })
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
    expect(() =>
      f.reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'late' }] } }),
    ).not.toThrow()
    await expect(p).rejects.toThrow(/취소/) // 재-resolve 되지 않는다
  })

  it('abort 와 타임아웃이 같은 요청에 겹쳐도 취소 알림은 한 번만 보낸다(idempotency)', async () => {
    const f = fakeTransport()
    let fire: (() => void) | undefined
    const c = createMcpClient(f.transport, {
      setTimer: (fn) => ((fire = fn), 1),
      clearTimer: () => {},
    })
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
    const c = createMcpClient(f.transport, {
      setTimer: (fn) => ((fire = fn), 1),
      clearTimer: () => {},
    })
    const p = c.listTools()
    fire!()
    await expect(p).rejects.toThrow(/타임아웃/)
    expect(f.sent.at(-1)).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    })
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

  it('존재하는 빈 문자열 nextCursor 는 유효한 커서로 취급해 다음 페이지를 요청한다(스펙: 존재=더 있음)', async () => {
    let onMsg: (m: Record<string, unknown>) => void = () => {}
    const sentCursors: (string | undefined)[] = []
    let n = 0
    const transport: McpTransport = {
      send: (m) => {
        if (m['method'] !== 'tools/list') return
        sentCursors.push((m['params'] as { cursor?: string }).cursor)
        n++
        const id = m['id']
        // 1번째 응답: 빈 문자열 커서(끝 아님). 2번째 응답: 커서 없음(끝).
        const result =
          n === 1 ? { tools: [{ name: 'a' }], nextCursor: '' } : { tools: [{ name: 'b' }] }
        queueMicrotask(() => onMsg({ jsonrpc: '2.0', id, result }))
      },
      onMessage: (h) => {
        onMsg = h
      },
      onClose: () => {},
      close: () => {},
    }
    const c = createMcpClient(transport)
    expect(await c.listTools()).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(sentCursors).toEqual([undefined, '']) // 빈 커서로 2페이지를 요청했다(누락 없음)
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
        queueMicrotask(() =>
          onMsg({
            jsonrpc: '2.0',
            id,
            result: { tools: [{ name: `t${count}` }], nextCursor: 'same' },
          }),
        )
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
        queueMicrotask(() =>
          onMsg({
            jsonrpc: '2.0',
            id,
            result: { tools: [{ name: `t${count}` }], nextCursor: `c${count}` },
          }),
        )
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

  it('notifications/tools/list_changed 수신 시 onToolsChanged 핸들러를 호출한다(응답 없음)', () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const onChanged = vi.fn()
    c.onToolsChanged(onChanged)
    // 서버 발신 알림(id 없음) — 런타임 도구 목록이 바뀌었음을 통지(MCP tools.listChanged).
    f.reply({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(f.sent).toHaveLength(0) // 알림에는 응답하지 않는다(JSON-RPC)
  })

  it('알 수 없는 알림은 무시한다(onToolsChanged 미호출·응답 없음)', () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const onChanged = vi.fn()
    c.onToolsChanged(onChanged)
    f.reply({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
    expect(onChanged).not.toHaveBeenCalled()
    expect(f.sent).toHaveLength(0)
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

  it('initialize 는 최신 프로토콜 버전(2025-11-25)을 보낸다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.initialize()
    expect(f.sent[0]).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    })
    f.reply({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25' } })
    await p
  })

  it('callTool 은 structuredContent 를 함께 보존한다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.callTool('t', {})
    f.reply({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{"temp":22}' }],
        structuredContent: { temp: 22 },
      },
    })
    expect(await p).toEqual({
      content: [{ type: 'text', text: '{"temp":22}' }],
      isError: false,
      structuredContent: { temp: 22 },
    })
  })

  it('structuredContent 가 없으면 결과에 그 키를 넣지 않는다(기존 소비자 무회귀)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.callTool('t', {})
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } })
    const r = await p
    expect('structuredContent' in r).toBe(false)
  })

  it('callTool 에 onProgress 를 주면 요청 params._meta.progressToken 을 실어 보낸다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.callTool('t', { a: 1 }, { onProgress: () => {} })
    const params = (f.sent[0] as { params: Record<string, unknown> }).params
    expect((params['_meta'] as { progressToken?: unknown }).progressToken).toBeDefined()
    // 기존 인자는 보존된다(_meta 만 추가).
    expect(params['arguments']).toEqual({ a: 1 })
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await p
  })

  it('onProgress 없이 호출하면 _meta 를 싣지 않는다(와이어 byte 무회귀)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const p = c.callTool('t', {})
    expect((f.sent[0] as { params: Record<string, unknown> }).params['_meta']).toBeUndefined()
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await p
  })

  it('notifications/progress 를 해당 요청의 onProgress 로 라우팅한다(progressToken 은 params 최상위)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const events: Array<{ progress: number; total?: number; message?: string }> = []
    const p = c.callTool('t', {}, { onProgress: (e) => events.push(e) })
    const token = (f.sent[0] as { params: { _meta: { progressToken: unknown } } }).params._meta
      .progressToken
    // 알림(id 없음)이며 progressToken 은 params 최상위(요청 _meta 와 위치가 다름).
    f.reply({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 50, total: 100, message: '절반' },
    })
    f.reply({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 100, total: 100 },
    })
    expect(events).toEqual([
      { progress: 50, total: 100, message: '절반' },
      { progress: 100, total: 100 },
    ])
    expect(f.sent).toHaveLength(1) // 알림에는 응답하지 않는다(JSON-RPC)
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await p
  })

  it('요청 완료 후 늦게 온 progress 알림은 콜백을 호출하지 않는다(토큰 해제)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const events: unknown[] = []
    const p = c.callTool('t', {}, { onProgress: (e) => events.push(e) })
    const token = (f.sent[0] as { params: { _meta: { progressToken: unknown } } }).params._meta
      .progressToken
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await p
    expect(() =>
      f.reply({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: token, progress: 10 },
      }),
    ).not.toThrow()
    expect(events).toHaveLength(0)
  })

  it('알 수 없는 progressToken 의 progress 알림은 안전하게 무시한다', () => {
    const f = fakeTransport()
    createMcpClient(f.transport)
    expect(() =>
      f.reply({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'nope', progress: 1 },
      }),
    ).not.toThrow()
    expect(f.sent).toHaveLength(0)
  })

  it('거대 progress message 는 잘라서 전달한다(무바운드 영속/표면화 방지)', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    let received: { progress: number; message?: string } | undefined
    const p = c.callTool('t', {}, { onProgress: (e) => (received = e) })
    const token = (f.sent[0] as { params: { _meta: { progressToken: unknown } } }).params._meta
      .progressToken
    f.reply({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 1, message: 'm'.repeat(5000) },
    })
    expect(received?.message).toBeDefined()
    expect(received!.message!.length).toBeLessThanOrEqual(1024)
    f.reply({ jsonrpc: '2.0', id: 1, result: { content: [] } })
    await p
  })

  it('abort 시 progressToken 도 해제해 이후 progress 가 새지 않는다', async () => {
    const f = fakeTransport()
    const c = createMcpClient(f.transport)
    const ac = new AbortController()
    const events: unknown[] = []
    const p = c.callTool('t', {}, { signal: ac.signal, onProgress: (e) => events.push(e) })
    const token = (f.sent[0] as { params: { _meta: { progressToken: unknown } } }).params._meta
      .progressToken
    ac.abort()
    await expect(p).rejects.toThrow(/취소/)
    f.reply({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: 50 },
    })
    expect(events).toHaveLength(0)
  })
})

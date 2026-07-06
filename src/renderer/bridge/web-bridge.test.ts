/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetBridge } from '../../shared/types'
import type { WsLike } from './ws-bridge'
import { browserSocket, initWebBridge, type WebBridgeWindow } from './web-bridge'

function fakeSocket(): WsLike & { sent: string[] } {
  return {
    sent: [],
    send(d: string) {
      this.sent.push(d)
    },
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
}

describe('initWebBridge(#197 B4)', () => {
  it('window.fleet 이 이미 있으면(데스크톱) no-op — null 반환·무변경', () => {
    const existing = { marker: true } as unknown as FleetBridge
    const win = {
      fleet: existing,
      location: { protocol: 'http:', host: 'x' },
    } as unknown as WebBridgeWindow
    expect(initWebBridge(win, () => fakeSocket())).toBeNull()
    expect(win.fleet).toBe(existing)
  })

  it('window.fleet 부재면 ws-bridge 를 생성해 주입한다', () => {
    const win = { location: { protocol: 'http:', host: 'x' } } as unknown as WebBridgeWindow
    const bridge = initWebBridge(win, () => fakeSocket())
    expect(bridge).not.toBeNull()
    expect(win.fleet).toBe(bridge!.fleet)
    expect(typeof win.fleet!.listSessions).toBe('function')
    bridge!.dispose()
  })

  it('기본 팩토리는 nonce 선취 후 location 기반 ws(s) URL 로 접속(404 → nonce 없이)', async () => {
    installFakeWebSocket()
    vi.stubGlobal('fetch', makeFetch({ status: 404 }))
    try {
      const win = {
        location: { protocol: 'https:', host: 'fleet.example:8443' },
      } as unknown as WebBridgeWindow
      const bridge = initWebBridge(win)
      await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))
      expect(fakeSockets[0]!.url).toBe('wss://fleet.example:8443/ws')
      bridge!.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ── browserSocket 지연 소켓(#197 B5 T8) ────────────────────────────────────────
class FakeWebSocket {
  url: string
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  send = vi.fn()
  close = vi.fn()
  constructor(url: string) {
    this.url = url
    fakeSockets.push(this)
  }
}
let fakeSockets: FakeWebSocket[] = []
function installFakeWebSocket(): void {
  fakeSockets = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
}
/** fetch 스텁 — status(+nonce) 응답 또는 'reject'(네트워크 실패). */
function makeFetch(response: { status: number; nonce?: string } | 'reject') {
  return vi.fn(async () => {
    if (response === 'reject') throw new Error('network')
    return {
      status: response.status,
      json: async () => ({ nonce: response.nonce }),
    } as unknown as Response
  })
}

describe('browserSocket — nonce 선취 지연 소켓(#197 B5 T8)', () => {
  const WS = 'ws://x/ws'
  const NONCE = 'http://x/auth/ws-nonce'
  afterEach(() => {
    vi.unstubAllGlobals()
    fakeSockets = []
  })

  it('① 200 → ?nonce=<값> URL 로 접속 · POST /auth/ws-nonce', async () => {
    const fetchFn = makeFetch({ status: 200, nonce: 'abc123' })
    installFakeWebSocket()
    vi.stubGlobal('fetch', fetchFn)
    browserSocket(WS, NONCE)
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))
    expect(fakeSockets[0]!.url).toBe('ws://x/ws?nonce=abc123')
    expect(fetchFn).toHaveBeenCalledWith(NONCE, expect.objectContaining({ method: 'POST' }))
  })

  it.each([404, 405])(
    '② %s → nonce 쿼리 없이 접속(loopback endpoint 부재 — 405=정적 method guard)',
    async (status) => {
      installFakeWebSocket()
      vi.stubGlobal('fetch', makeFetch({ status }))
      browserSocket(WS, NONCE)
      await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))
      expect(fakeSockets[0]!.url).toBe('ws://x/ws')
    },
  )

  it.each([{ status: 401 }, { status: 403 }])(
    '③ $status → onclose 발화·소켓 미생성(영구 hang 금지)',
    async ({ status }) => {
      installFakeWebSocket()
      vi.stubGlobal('fetch', makeFetch({ status }))
      const sock = browserSocket(WS, NONCE)
      const onclose = vi.fn()
      sock.onclose = onclose
      await vi.waitFor(() => expect(onclose).toHaveBeenCalled())
      expect(fakeSockets).toHaveLength(0)
    },
  )

  it('③b fetch reject(네트워크) → onclose 발화', async () => {
    installFakeWebSocket()
    vi.stubGlobal('fetch', makeFetch('reject'))
    const sock = browserSocket(WS, NONCE)
    const onclose = vi.fn()
    sock.onclose = onclose
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(fakeSockets).toHaveLength(0)
  })

  it('④ 개설 전 send → no-op(throw 금지) · open 후 real 로 전달', async () => {
    installFakeWebSocket()
    vi.stubGlobal('fetch', makeFetch({ status: 200, nonce: 'abc' }))
    const sock = browserSocket(WS, NONCE)
    expect(() => sock.send('early')).not.toThrow() // real 미생성 → no-op
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(1))
    sock.send('data')
    expect(fakeSockets[0]!.send).toHaveBeenCalledWith('data')
  })

  it('⑤ fetch 중 close() → 소켓 미생성(누수 없음)', async () => {
    let resolveFetch!: (v: unknown) => void
    const fetchFn = vi.fn(() => new Promise((r) => (resolveFetch = r)))
    installFakeWebSocket()
    vi.stubGlobal('fetch', fetchFn)
    const sock = browserSocket(WS, NONCE)
    sock.close() // fetch 진행 중 close
    resolveFetch({ status: 200, json: async () => ({ nonce: 'abc' }) })
    await new Promise((r) => setTimeout(r, 10))
    expect(fakeSockets).toHaveLength(0)
  })

  it('⑥ 재호출(재접속)마다 fetch 재수행 → 매번 새 nonce', async () => {
    const fetchFn = makeFetch({ status: 200, nonce: 'abc' })
    installFakeWebSocket()
    vi.stubGlobal('fetch', fetchFn)
    browserSocket(WS, NONCE)
    browserSocket(WS, NONCE)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2))
  })
})

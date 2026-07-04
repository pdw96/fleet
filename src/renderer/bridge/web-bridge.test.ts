/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import type { FleetBridge } from '../../shared/types'
import type { WsLike } from './ws-bridge'
import { initWebBridge, type WebBridgeWindow } from './web-bridge'

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

  it('기본 팩토리는 location 기반 ws(s) URL 로 브라우저 WebSocket 을 연다(어댑터 이벤트 전달)', () => {
    const instances: FakeWebSocket[] = []
    class FakeWebSocket {
      url: string
      onopen: (() => void) | null = null
      onmessage: ((ev: { data: unknown }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: ((e?: unknown) => void) | null = null
      constructor(url: string) {
        this.url = url
        instances.push(this)
      }
      send = vi.fn()
      close = vi.fn()
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    try {
      const win = {
        location: { protocol: 'https:', host: 'fleet.example:8443' },
      } as unknown as WebBridgeWindow
      const bridge = initWebBridge(win)
      expect(instances[0]!.url).toBe('wss://fleet.example:8443/ws')
      bridge!.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

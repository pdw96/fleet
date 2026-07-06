import type { FleetBridge } from '../../shared/types'
import { createWsBridge, type WsBridge, type WsFactory, type WsLike } from './ws-bridge'

/**
 * 웹모드 폴백 배선(#197 B4) — preload 가 없는 배포(브라우저)에서 ws-bridge 를 window.fleet 로 주입한다.
 * renderer 호출부(40여 곳)는 전역 window.fleet 직접 참조라 이 주입 한 곳으로 전 표면이 전환된다
 * (데스크톱은 preload 가 이미 주입 → no-op·무회귀). per-request timeout 은 IPC 동형(무제한 — B2 계약:
 * runProject/discuss 는 수 분 pending 이 정당, 연결 소실은 close 시 pending 전원 reject 가 정리).
 */
export type WebBridgeWindow = Pick<Window, 'location'> & { fleet?: FleetBridge }

/**
 * nonce 선취 지연 소켓(#197 B5) — WsFactory 동기 계약을 유지하며(ws-bridge 무변경) 즉시 WsLike 를 돌려주되,
 * 내부에서 same-origin `POST /auth/ws-nonce` 를 먼저 쳐서 실 소켓 접속을 지연시킨다:
 *   · 200 → `?nonce=<값>` 부착 접속(access 실경로).
 *   · 404 → nonce 없이 접속(loopback 하위호환 — endpoint 부재).
 *   · 그 외(401/403/네트워크/타임아웃) → onclose 발화 = 기존 백오프 재접속 합류(영구 hang 금지).
 * 재접속 = 팩토리 재호출 = 매번 새 nonce(단일사용 정합). 발급 중 close() 는 소켓 생성을 취소(누수 없음).
 */
export function browserSocket(wsUrl: string, nonceUrl: string): WsLike {
  let real: WebSocket | null = null
  let closed = false
  const like: WsLike = {
    send: (d) => real?.send(d), // real 미생성 = 미open 이므로 no-op(ws-bridge 는 onopen 후에만 send)
    close: () => {
      closed = true
      real?.close()
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }

  const openWith = (url: string): void => {
    if (closed) return // 발급 중 close() → 소켓 생성 취소(누수 없음)
    const ws = new WebSocket(url)
    real = ws
    ws.onopen = () => like.onopen?.()
    ws.onmessage = (ev) => like.onmessage?.({ data: ev.data })
    ws.onclose = () => like.onclose?.()
    ws.onerror = (e) => like.onerror?.(e)
  }
  const fail = (): void => {
    if (closed) return
    closed = true
    like.onclose?.() // 소켓 미생성 상태로 disconnect 통지 → 백오프 재접속
  }

  void (async () => {
    try {
      const res = await fetch(nonceUrl, { method: 'POST', signal: AbortSignal.timeout(10_000) })
      if (closed) return
      if (res.status === 200) {
        const body = (await res.json()) as { nonce?: string }
        if (typeof body.nonce === 'string' && body.nonce.length > 0) {
          openWith(`${wsUrl}?nonce=${encodeURIComponent(body.nonce)}`)
        } else {
          fail() // 200 인데 nonce 없음(형식 이상) → 재접속
        }
      } else if (res.status === 404) {
        openWith(wsUrl) // loopback — endpoint 부재
      } else {
        fail() // 401/403 등 → 재접속(access 서버가 발급 거부)
      }
    } catch {
      fail() // fetch reject/타임아웃/네트워크
    }
  })()

  return like
}

export function initWebBridge(win: WebBridgeWindow = window, connect?: WsFactory): WsBridge | null {
  if (win.fleet) return null // 데스크톱 — preload 브리지가 권위
  const proto = win.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const origin = `${win.location.protocol}//${win.location.host}`
  const bridge = createWsBridge({
    connect:
      connect ??
      (() => browserSocket(`${proto}//${win.location.host}/ws`, `${origin}/auth/ws-nonce`)),
  })
  win.fleet = bridge.fleet
  return bridge
}

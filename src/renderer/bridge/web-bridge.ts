import type { FleetBridge } from '../../shared/types'
import { createWsBridge, type WsBridge, type WsFactory, type WsLike } from './ws-bridge'

/**
 * 웹모드 폴백 배선(#197 B4) — preload 가 없는 배포(브라우저)에서 ws-bridge 를 window.fleet 로 주입한다.
 * renderer 호출부(40여 곳)는 전역 window.fleet 직접 참조라 이 주입 한 곳으로 전 표면이 전환된다
 * (데스크톱은 preload 가 이미 주입 → no-op·무회귀). per-request timeout 은 IPC 동형(무제한 — B2 계약:
 * runProject/discuss 는 수 분 pending 이 정당, 연결 소실은 close 시 pending 전원 reject 가 정리).
 */
export type WebBridgeWindow = Pick<Window, 'location'> & { fleet?: FleetBridge }

/** 브라우저 WebSocket → WsLike 어댑터. 프로퍼티 시그니처 차이(이벤트 인자)를 전달 클로저로 맞춘다. */
function browserSocket(url: string): WsLike {
  const ws = new WebSocket(url)
  const like: WsLike = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  ws.onopen = () => like.onopen?.()
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data })
  ws.onclose = () => like.onclose?.()
  ws.onerror = (e) => like.onerror?.(e)
  return like
}

export function initWebBridge(win: WebBridgeWindow = window, connect?: WsFactory): WsBridge | null {
  if (win.fleet) return null // 데스크톱 — preload 브리지가 권위
  const proto = win.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const bridge = createWsBridge({
    connect: connect ?? (() => browserSocket(`${proto}//${win.location.host}/ws`)),
  })
  win.fleet = bridge.fleet
  return bridge
}

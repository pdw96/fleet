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
 *   · 404/405 → nonce 없이 접속(loopback 하위호환 — endpoint 부재. loopback 은 정적 method guard 가 POST 를
 *     405 로 자르므로 404·405 둘 다 "endpoint 없음"으로 취급).
 *   · 그 외(401/403/503/네트워크/타임아웃) → onclose 발화 = 기존 백오프 재접속 합류(영구 hang 금지).
 * 재접속 = 팩토리 재호출 = 매번 새 nonce(단일사용 정합). 발급 중 close() 는 소켓 생성을 취소(누수 없음).
 */

/**
 * 10s 타임아웃 신호(#197 B5 · Codex 재리뷰 P2) — AbortSignal.timeout 미지원 환경(구형 브라우저·일부 dev)
 * 에서 호출이 throw 하지 않도록 가드하고 AbortController+setTimeout 으로 폴백. 둘 다 없으면 undefined
 * (타임아웃 없이 fetch — 기능은 유지). 지연 소켓 async 본문 밖에서 던지지 않는 게 핵심(아래 microtask 주석).
 */
function makeTimeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  if (typeof AbortController === 'function') {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), ms)
    return ctrl.signal
  }
  return undefined
}

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

  // queueMicrotask 로 지연 — 이 본문의 어떤 동기 throw(예: 구형 브라우저 fetch/AbortSignal 부재)라도
  // browserSocket 이 반환되고 ws-bridge 가 onclose 를 배선한 뒤에 발생하도록 보장한다. 동기 발화 시
  // fail()→like.onclose?.() 가 아직 null 인 onclose 를 건드려 종료 통지를 잃고 'connecting' 에 영구
  // 정지하는 race 를 차단(#197 B5 · Codex 재리뷰 P2). 정상 경로(await 뒤)는 어차피 비동기라 무영향.
  queueMicrotask(() => {
    void (async () => {
      try {
        const res = await fetch(nonceUrl, { method: 'POST', signal: makeTimeoutSignal(10_000) })
        if (closed) return
        if (res.status === 200) {
          const body = (await res.json()) as { nonce?: string }
          if (typeof body.nonce === 'string' && body.nonce.length > 0) {
            openWith(`${wsUrl}?nonce=${encodeURIComponent(body.nonce)}`)
          } else {
            fail() // 200 인데 nonce 없음(형식 이상) → 재접속
          }
        } else if (res.status === 404 || res.status === 405) {
          openWith(wsUrl) // loopback — endpoint 부재(정적 method guard 405 포함)
        } else {
          fail() // 401/403/503 등 → 재접속(access 서버가 발급 거부)
        }
      } catch {
        fail() // fetch reject/타임아웃/네트워크
      }
    })()
  })

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

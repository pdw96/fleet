import type { BothPushChannel } from '../shared/transport/channels'
import {
  decodeClientFrame,
  makeErrFrame,
  makeOkFrame,
  type HelloFrame,
  type PushFrame,
  type ReqFrame,
} from '../shared/transport/protocol'
import type { HandlerTable } from './handlers'

/**
 * WS 세션 호스트(#197 B3) — Electron IPC 의 서버측 대체. 실 `ws` 소켓 타입에 의존하지 않는
 * 최소 계약(WsSocket) 주입식이라 node vitest 로 전 시맨틱을 검증한다(ws-bridge 의 WsLike 와 동형 전략).
 *  - attach 첫 프레임 = hello(이벤트 커서 워터마크 — B1 store.eventCursor, 재접속 gap 판정용)
 *  - req 디스패치: 핸들러 await → ok/err res. 에러는 message 만(스택 미노출 — 프로토콜 계약).
 *  - 미지 채널(desktop 전용 포함)은 명시 에러 res — 무응답이면 클라 pending 이 영구 hang 한다.
 *  - 신뢰 경계: decodeClientFrame 위반 프레임은 무시(id 신뢰 불가 → correlation res 불가).
 *  - presence: clientCount() — B5 전 loopback 한정의 임시 presence(approver hasWindow 대체).
 */
export interface WsSocket {
  send(data: string): void
  close(): void
}

export interface WsClientBinding {
  onMessage(data: string): void
  onClose(): void
}

export interface WsHost {
  attach(socket: WsSocket): WsClientBinding
  broadcast(ch: BothPushChannel, event: unknown): void
  clientCount(): number
}

export interface WsHostOptions {
  handlers: HandlerTable
  /** 접속 인사(hello)에 실을 이벤트 커서 워터마크 — store.eventCursor 를 주입. */
  eventCursor(): { maxEventSeq: number; minRetainedEventSeq: number }
}

export function createWsHost(opts: WsHostOptions): WsHost {
  const clients = new Set<WsSocket>()
  // 인덱스 접근용 — 테이블 키 밖 채널은 undefined → 명시 에러 res.
  const handlers = opts.handlers as Partial<Record<string, (...args: unknown[]) => unknown>>

  const safeSend = (socket: WsSocket, data: string): void => {
    try {
      socket.send(data)
    } catch {
      /* 죽은 소켓 send 실패 격리 — 정리는 close 콜백 몫 */
    }
  }

  async function dispatch(socket: WsSocket, frame: ReqFrame): Promise<void> {
    const handler = handlers[frame.ch]
    if (!handler) {
      safeSend(socket, JSON.stringify(makeErrFrame(frame.id, `알 수 없는 채널: ${frame.ch}`)))
      return
    }
    try {
      const value = await handler(...frame.args)
      safeSend(socket, JSON.stringify(makeOkFrame(frame.id, value)))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      safeSend(socket, JSON.stringify(makeErrFrame(frame.id, message)))
    }
  }

  return {
    attach(socket) {
      clients.add(socket)
      const cursor = opts.eventCursor()
      const hello: HelloFrame = { t: 'hello', ...cursor }
      safeSend(socket, JSON.stringify(hello))
      return {
        onMessage(data) {
          const frame = decodeClientFrame(data)
          if (!frame) return
          void dispatch(socket, frame)
        },
        onClose() {
          clients.delete(socket)
        },
      }
    },
    broadcast(ch, event) {
      const frame: PushFrame = { t: 'push', ch, event }
      const data = JSON.stringify(frame)
      for (const c of clients) safeSend(c, data)
    },
    clientCount: () => clients.size,
  }
}

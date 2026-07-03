import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeErrFrame, makeOkFrame, type ClientFrame } from '../../shared/transport/protocol'
import { createWsBridge, TransportError, type ConnectionState, type WsLike } from './ws-bridge'

/**
 * ws-bridge 동작 계약(#197 B2). 주입된 WebSocket 팩토리 + 페이크 소켓으로 Electron IPC 의 네 시맨틱
 * (correlation·응답보장·푸시구독·재접속)이 WS 위에서 재현되는지 핀한다. B2 시점엔 미배선(window.fleet
 * 대체는 B4) — 여기서는 전송층 단독으로 검증한다.
 */

/** 테스트가 open/message/close/error 를 구동하고 send 를 캡처하는 페이크 소켓. */
class FakeWs implements WsLike {
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((err?: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }

  // ── 테스트 구동 ──
  open(): void {
    this.onopen?.()
  }
  message(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }
  fireClose(): void {
    this.onclose?.()
  }
  /** 마지막 전송 프레임을 파싱. */
  lastReq(): ClientFrame {
    return JSON.parse(this.sent[this.sent.length - 1]) as ClientFrame
  }
}

function harness() {
  const sockets: FakeWs[] = []
  return {
    sockets,
    connect: (): FakeWs => {
      const ws = new FakeWs()
      sockets.push(ws)
      return ws
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ws-bridge 접속 수명주기', () => {
  it('생성 즉시 팩토리를 호출하고 connecting 상태다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    expect(h.sockets).toHaveLength(1)
    expect(bridge.connectionState()).toBe('connecting')
  })

  it('open 시 connected 로 전이하고 상태 리스너에 통지한다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    const states: ConnectionState[] = []
    bridge.onConnectionState((s) => states.push(s))
    h.sockets[0].open()
    expect(bridge.connectionState()).toBe('connected')
    expect(states).toEqual(['connected'])
  })

  it('open 시 큐를 먼저 flush 한 뒤 connected 를 통지한다(리스너 read 가 offline write 를 앞지르지 않게)', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    const p = bridge.fleet.listRooms() // 미open → 큐잉
    p.catch(() => {})
    let sentAtNotify = -1
    bridge.onConnectionState((s) => {
      if (s === 'connected') sentAtNotify = h.sockets[0].sent.length
    })
    h.sockets[0].open()
    expect(sentAtNotify).toBe(1) // 통지 시점에 큐 프레임이 이미 전송됨(flush 선행)
  })

  it('재접속 close 시 stale 이벤트 커서를 비운다(getEventCursor null)', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, autoReconnect: false })
    h.sockets[0].open()
    h.sockets[0].message({ t: 'hello', maxEventSeq: 5, minRetainedEventSeq: 1 })
    expect(bridge.getEventCursor()).toEqual({ maxEventSeq: 5, minRetainedEventSeq: 1 })
    h.sockets[0].fireClose()
    expect(bridge.getEventCursor()).toBeNull() // 이전 연결 커서를 재접속 후 노출 금지
  })
})

describe('ws-bridge 요청/응답 correlation', () => {
  it('동시 요청을 id 로 다중화해 올바른 응답에 매칭한다', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()

    const pRooms = bridge.fleet.listRooms()
    const reqRooms = h.sockets[0].lastReq()
    expect(reqRooms.ch).toBe('fleet:chat:listRooms')

    const pProjects = bridge.fleet.listProjects()
    const reqProjects = h.sockets[0].lastReq()
    expect(reqProjects.ch).toBe('fleet:project:list')
    expect(reqProjects.id).not.toBe(reqRooms.id)

    // 역순으로 응답해도 correlation 이 지켜진다.
    h.sockets[0].message(makeOkFrame(reqProjects.id, [{ id: 'p1' }]))
    h.sockets[0].message(makeOkFrame(reqRooms.id, [{ id: 'r1' }]))

    expect(await pRooms).toEqual([{ id: 'r1' }])
    expect(await pProjects).toEqual([{ id: 'p1' }])
  })

  it('인자를 args 튜플로 싣는다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    void bridge.fleet.getProjectTasks('proj-9')
    expect(h.sockets[0].lastReq()).toMatchObject({
      t: 'req',
      ch: 'fleet:project:tasks',
      args: ['proj-9'],
    })
  })

  it('생략된 후행 optional 인자(undefined)는 잘라 데스크톱 IPC 와 직렬화를 맞춘다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    // createRoom(title, participants?) — participants 생략 → args 는 [title] 만(끝의 undefined→null 오염 방지).
    void bridge.fleet.createRoom('My Room')
    expect(h.sockets[0].lastReq().args).toEqual(['My Room'])
  })

  it('null 인자는 정당한 값이라 보존한다(undefined 트림과 구분)', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    void bridge.fleet.setLastActiveProject(null)
    expect(h.sockets[0].lastReq().args).toEqual([null])
  })

  it('에러 응답은 message 로 reject 하고 서버 스택을 옮기지 않는다', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    const p = bridge.fleet.runProject({ goal: 'x' })
    const id = h.sockets[0].lastReq().id
    h.sockets[0].message(makeErrFrame(id, '실행 실패'))
    await expect(p).rejects.toThrow('실행 실패')
  })

  it('소켓 open 전 요청은 큐잉했다가 open 시 flush 한다', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    const p = bridge.fleet.getAppInfo()
    expect(h.sockets[0].sent).toHaveLength(0) // 아직 미전송
    h.sockets[0].open()
    expect(h.sockets[0].sent).toHaveLength(1) // flush
    const id = h.sockets[0].lastReq().id
    h.sockets[0].message(makeOkFrame(id, { name: 'Fleet', runtime: 'web' }))
    expect(await p).toMatchObject({ runtime: 'web' })
  })
})

describe('ws-bridge close → pending 전원 reject', () => {
  it('소켓 close 시 미해결 요청을 전부 reject 한다', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, autoReconnect: false })
    h.sockets[0].open()
    const p1 = bridge.fleet.listRooms()
    const p2 = bridge.fleet.listProjects()
    h.sockets[0].fireClose()
    await expect(p1).rejects.toThrow()
    await expect(p2).rejects.toThrow()
  })

  it('close reject 는 reason=disconnected 의 TransportError 다(B4 가 완료 아닌 재접속으로 구분)', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, autoReconnect: false })
    h.sockets[0].open()
    const p = bridge.fleet.runProject({ goal: 'x' })
    h.sockets[0].fireClose()
    await expect(p).rejects.toBeInstanceOf(TransportError)
    await expect(p).rejects.toMatchObject({ reason: 'disconnected' })
  })

  it('terminal closed(autoReconnect=false) 후 새 invoke 는 즉시 reject 된다(hang 방지)', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, autoReconnect: false })
    h.sockets[0].open()
    h.sockets[0].fireClose()
    expect(bridge.connectionState()).toBe('closed')
    // 재접속 없는 terminal 상태 — 새 요청이 큐에 갇혀 영구 hang 하면 안 된다.
    await expect(bridge.fleet.listRooms()).rejects.toThrow()
  })
})

describe('ws-bridge per-request timeout', () => {
  it('타임아웃 설정 시 무응답 요청을 시간 초과로 reject 한다', async () => {
    vi.useFakeTimers()
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, requestTimeoutMs: 5000 })
    h.sockets[0].open()
    const p = bridge.fleet.getRunActivity()
    p.catch(() => {}) // 미처리 rejection 경고 방지
    vi.advanceTimersByTime(5000)
    await expect(p).rejects.toThrow(/시간 초과/)
  })

  it('타임아웃 미설정(기본)이면 장시간 요청이 계속 pending 이다(runProject 보존)', async () => {
    vi.useFakeTimers()
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    const p = bridge.fleet.runProject({ goal: 'long' })
    let settled = false
    void p.then(
      () => (settled = true),
      () => (settled = true),
    )
    vi.advanceTimersByTime(10 * 60 * 1000)
    await Promise.resolve()
    expect(settled).toBe(false)
    // 완료되면 정상 resolve.
    const id = h.sockets[0].lastReq().id
    h.sockets[0].message(makeOkFrame(id, { projectId: 'p', tasks: [], summary: 'ok' }))
    expect(await p).toMatchObject({ summary: 'ok' })
  })

  it('타임아웃된 요청의 큐 프레임은 이후 flush 에서 전송되지 않는다(고아 방지)', () => {
    vi.useFakeTimers()
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, requestTimeoutMs: 5000 })
    // 소켓 미open(connecting) 상태에서 요청 → sendQueue 로 밀림.
    const p = bridge.fleet.listRooms()
    p.catch(() => {})
    expect(h.sockets[0].sent).toHaveLength(0)
    vi.advanceTimersByTime(5000) // 타임아웃 → 해당 pending 삭제
    h.sockets[0].open() // flush 시도
    expect(h.sockets[0].sent).toHaveLength(0) // 고아 프레임 미전송
  })
})

describe('ws-bridge 불량 프레임 견고성', () => {
  it('구조 불량 res(error 누락)는 무시하고 소켓 루프를 깨지 않는다(crash/hang 방지)', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    const p = bridge.fleet.listRooms()
    const id = h.sockets[0].lastReq().id
    // error 필드 없는 ok:false 프레임 — decodeFrame 이 null 로 떨궈 무시(무크래시).
    expect(() => h.sockets[0].message(`{"t":"res","id":${id},"ok":false}`)).not.toThrow()
    // pending 은 유지돼 정상 응답으로 해소 가능.
    h.sockets[0].message(makeOkFrame(id, [{ id: 'r1' }]))
    expect(await p).toEqual([{ id: 'r1' }])
  })

  it('구독 콜백이 던져도 다른 콜백/소켓 루프를 깨지 않는다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    let second = false
    bridge.fleet.onChatStream(() => {
      throw new Error('bad listener')
    })
    bridge.fleet.onChatStream(() => (second = true))
    expect(() =>
      h.sockets[0].message({ t: 'push', ch: 'fleet:chat:stream', event: { kind: 'idle' } }),
    ).not.toThrow()
    expect(second).toBe(true) // 첫 콜백 예외가 둘째를 막지 않음
  })
})

describe('ws-bridge 푸시 구독', () => {
  it('매칭 채널만 콜백에 전달하고 unsubscribe 후 멈춘다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    const events: unknown[] = []
    const off = bridge.fleet.onOrchestratorEvent((e) => events.push(e))

    h.sockets[0].message({ t: 'push', ch: 'fleet:orchestrator:event', event: { type: 'summary' } })
    h.sockets[0].message({ t: 'push', ch: 'fleet:chat:stream', event: { kind: 'idle' } }) // 다른 채널
    expect(events).toEqual([{ type: 'summary' }])

    off()
    h.sockets[0].message({ t: 'push', ch: 'fleet:orchestrator:event', event: { type: 'summary' } })
    expect(events).toHaveLength(1) // 해제 후 무통지
  })

  it('동일 콜백 중복 구독은 이벤트당 1회만 호출한다(채널별 Set 멱등)', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    let calls = 0
    const cb = (): void => {
      calls++
    }
    bridge.fleet.onApprovalRequest(cb)
    bridge.fleet.onApprovalRequest(cb) // 동일 참조 재구독
    h.sockets[0].message({ t: 'push', ch: 'fleet:approval:request', event: { id: 'a' } })
    expect(calls).toBe(1)
  })

  it('unsubscribe 를 두 번 호출해도 안전하다(멱등)', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    const off = bridge.fleet.onChatStream(() => {})
    off()
    expect(() => off()).not.toThrow()
  })
})

describe('ws-bridge desktop 전용 표면 스텁(update)', () => {
  it('getUpdateState 는 와이어 없이 unsupported(배너 숨김)를 반환한다', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    await expect(bridge.fleet.getUpdateState()).resolves.toEqual({ kind: 'unsupported' })
    expect(h.sockets[0].sent).toHaveLength(0) // 서버 미등록 채널 → invoke 안 함
  })

  it('getUpdaterChannel 은 stable, check/download 등은 no-op void 다', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    await expect(bridge.fleet.getUpdaterChannel()).resolves.toBe('stable')
    await expect(bridge.fleet.checkForUpdate()).resolves.toBeUndefined()
    await expect(bridge.fleet.dismissUpdate()).resolves.toBeUndefined()
    expect(h.sockets[0].sent).toHaveLength(0)
  })

  it('onUpdateEvent 는 no-op 해제 함수를 주며 절대 발화하지 않는다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    let fired = false
    const off = bridge.fleet.onUpdateEvent(() => (fired = true))
    h.sockets[0].message({ t: 'push', ch: 'fleet:update:event', event: { kind: 'checking' } })
    expect(fired).toBe(false)
    expect(() => off()).not.toThrow()
  })
})

describe('ws-bridge openCliDocs (검증 URL 수신 → window.open)', () => {
  it('fleet:external:openDocs 를 invoke 하고 node(window 부재)에서도 크래시 없이 resolve 한다', async () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    const p = bridge.fleet.openCliDocs('claude')
    const req = h.sockets[0].lastReq()
    expect(req).toMatchObject({ ch: 'fleet:external:openDocs', args: ['claude'] })
    h.sockets[0].message(makeOkFrame(req.id, 'https://docs.anthropic.com/claude-code'))
    await expect(p).resolves.toBeUndefined()
  })
})

describe('ws-bridge hello 이벤트 커서', () => {
  it('hello 수신 전엔 커서 null, 수신 후 워터마크를 노출한다', () => {
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect })
    h.sockets[0].open()
    expect(bridge.getEventCursor()).toBeNull()
    h.sockets[0].message({ t: 'hello', maxEventSeq: 42, minRetainedEventSeq: 10 })
    expect(bridge.getEventCursor()).toEqual({ maxEventSeq: 42, minRetainedEventSeq: 10 })
  })
})

describe('ws-bridge 재접속(지수 백오프)', () => {
  it('예기치 않은 close 후 백오프 뒤 재접속하며 상태를 전이한다', () => {
    vi.useFakeTimers()
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, initialBackoffMs: 1000 })
    const states: ConnectionState[] = []
    bridge.onConnectionState((s) => states.push(s))
    h.sockets[0].open()
    h.sockets[0].fireClose()
    expect(bridge.connectionState()).toBe('reconnecting')
    expect(h.sockets).toHaveLength(1) // 아직 미재접속
    vi.advanceTimersByTime(1000)
    expect(h.sockets).toHaveLength(2) // 팩토리 재호출
    h.sockets[1].open()
    expect(bridge.connectionState()).toBe('connected')
    expect(states).toEqual(['connected', 'reconnecting', 'connected'])
  })

  it('연속 재접속 실패 시 백오프가 지수적으로 증가한다', () => {
    vi.useFakeTimers()
    const h = harness()
    createWsBridge({ connect: h.connect, initialBackoffMs: 1000, maxBackoffMs: 30000 })
    h.sockets[0].open()
    h.sockets[0].fireClose() // 재접속 예약: delay 1000, 다음 2000
    vi.advanceTimersByTime(1000)
    expect(h.sockets).toHaveLength(2)
    h.sockets[1].fireClose() // open 없이 실패 → delay 2000
    vi.advanceTimersByTime(1999)
    expect(h.sockets).toHaveLength(2) // 아직
    vi.advanceTimersByTime(1)
    expect(h.sockets).toHaveLength(3) // 2000 경과 후 재접속
  })

  it('성공 open 후엔 백오프가 초기값으로 리셋된다', () => {
    vi.useFakeTimers()
    const h = harness()
    createWsBridge({ connect: h.connect, initialBackoffMs: 1000 })
    h.sockets[0].open()
    h.sockets[0].fireClose()
    vi.advanceTimersByTime(1000)
    h.sockets[1].open() // 성공 → 리셋
    h.sockets[1].fireClose()
    vi.advanceTimersByTime(1000) // 리셋됐으면 1000 만에 재접속
    expect(h.sockets).toHaveLength(3)
  })

  it('백오프는 상한(maxBackoffMs)을 넘지 않는다', () => {
    vi.useFakeTimers()
    const h = harness()
    createWsBridge({ connect: h.connect, initialBackoffMs: 1000, maxBackoffMs: 1500 })
    h.sockets[0].open()
    h.sockets[0].fireClose() // delay 1000, 다음 min(2000,1500)=1500
    vi.advanceTimersByTime(1000)
    h.sockets[1].fireClose() // delay 1500(상한)
    vi.advanceTimersByTime(1499)
    expect(h.sockets).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(h.sockets).toHaveLength(3)
  })
})

describe('ws-bridge dispose', () => {
  it('종료 시 소켓을 닫고 pending 을 reject 하며 재접속하지 않는다', async () => {
    vi.useFakeTimers()
    const h = harness()
    const bridge = createWsBridge({ connect: h.connect, initialBackoffMs: 1000 })
    h.sockets[0].open()
    const p = bridge.fleet.listRooms()
    p.catch(() => {})
    bridge.dispose()
    expect(bridge.connectionState()).toBe('closed')
    expect(h.sockets[0].closed).toBe(true)
    await expect(p).rejects.toMatchObject({ name: 'TransportError', reason: 'closed' })
    vi.advanceTimersByTime(60000)
    expect(h.sockets).toHaveLength(1) // 재접속 안 함
  })
})

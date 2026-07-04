import { describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '../shared/types'
import { createWsHost, type WsSocket } from './ws-host'
import type { HandlerTable } from './handlers'

class FakeSocket implements WsSocket {
  readonly sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s))
  }
}

const APP_INFO = { name: 'Fleet', runtime: 'web' } as AppInfo

/** 테스트 전용 최소 핸들러 테이블 — 실 테이블 계약은 handlers.test.ts 가 담당. */
function stubHandlers(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    'fleet:app:info': () => APP_INFO,
    'fleet:session:remove': () => undefined, // void 채널 — value 생략 검증용
    'fleet:cli:probe': () => {
      throw new Error('보이는 메시지')
    },
    ...overrides,
  } as unknown as HandlerTable
}

function build(handlers = stubHandlers()) {
  return createWsHost({
    handlers,
    eventCursor: () => ({ maxEventSeq: 42, minRetainedEventSeq: 7 }),
  })
}

describe('ws-host(#197 B3)', () => {
  it('attach 즉시 hello 프레임(커서 워터마크)을 보낸다', () => {
    const host = build()
    const s = new FakeSocket()
    host.attach(s)
    expect(s.frames()[0]).toEqual({ t: 'hello', maxEventSeq: 42, minRetainedEventSeq: 7 })
  })

  it('req → ok res (correlation id 보존)', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 3, ch: 'fleet:app:info', args: [] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    expect(s.frames()[1]).toEqual({ t: 'res', id: 3, ok: true, value: APP_INFO })
  })

  it('void 반환 → value 키 생략(프로토콜 고정 정책)', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 4, ch: 'fleet:session:remove', args: ['x'] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    expect(s.frames()[1]).toEqual({ t: 'res', id: 4, ok: true })
    expect(Object.keys(s.frames()[1] as object)).not.toContain('value')
  })

  it('핸들러 throw → error.message 만(스택/원인 미노출)', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 5, ch: 'fleet:cli:probe', args: ['claude'] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    expect(s.frames()[1]).toEqual({
      t: 'res',
      id: 5,
      ok: false,
      error: { message: '보이는 메시지' },
    })
  })

  it('미지 채널(desktop 전용 등) → hang 이 아니라 명시 에러 res', async () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage(JSON.stringify({ t: 'req', id: 6, ch: 'fleet:update:check', args: [] }))
    await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
    const res = s.frames()[1] as { ok: boolean; error: { message: string } }
    expect(res.ok).toBe(false)
    expect(res.error.message).toContain('fleet:update:check')
  })

  it('위조/깨진 프레임은 무시(무응답·크래시 없음)', () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    b.onMessage('{broken')
    b.onMessage(JSON.stringify({ t: 'res', id: 1, ok: true }))
    b.onMessage(JSON.stringify({ t: 'req', id: 'x', ch: 'fleet:app:info', args: [] }))
    expect(s.frames()).toHaveLength(1) // hello 뿐
  })

  it('broadcast 는 전 클라에 push — 한 클라 send 실패가 나머지를 막지 않는다', () => {
    const host = build()
    const ok1 = new FakeSocket()
    const bad: WsSocket = {
      send: () => {
        throw new Error('죽은 소켓')
      },
      close: () => {},
    }
    const ok2 = new FakeSocket()
    host.attach(ok1)
    host.attach(bad)
    host.attach(ok2)
    host.broadcast('fleet:orchestrator:event', { kind: 'x' })
    for (const s of [ok1, ok2]) {
      expect(s.frames()[1]).toEqual({
        t: 'push',
        ch: 'fleet:orchestrator:event',
        event: { kind: 'x' },
      })
    }
  })

  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    '프로토타입 멤버명(%s) 위조 채널 → 명시 에러 res (fail-open 차단)',
    async (ch) => {
      const host = build()
      const s = new FakeSocket()
      const b = host.attach(s)
      b.onMessage(JSON.stringify({ t: 'req', id: 9, ch, args: [] }))
      await vi.waitFor(() => expect(s.frames()).toHaveLength(2))
      const res = s.frames()[1] as { ok: boolean; error: { message: string } }
      expect(res.ok).toBe(false)
      expect(res.error.message).toContain(ch)
    },
  )

  it('close 후엔 push 미수신·clientCount 감소(presence)', () => {
    const host = build()
    const s = new FakeSocket()
    const b = host.attach(s)
    expect(host.clientCount()).toBe(1)
    b.onClose()
    expect(host.clientCount()).toBe(0)
    host.broadcast('fleet:chat:stream', {})
    expect(s.frames()).toHaveLength(1) // hello 뿐
  })
})

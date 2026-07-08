import { describe, expect, it } from 'vitest'
import { installShutdownHandlers, type ShutdownDeps } from './shutdown-handlers'
import type { RunningServer } from './boot'

/** 다음 매크로태스크까지 — 중첩 then(running→shutdown→exit) 마이크로태스크 전부 배수. */
const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeServer(shutdown: () => Promise<void>, drainTimeoutMs = 25_000): RunningServer {
  return {
    port: 0,
    host: '127.0.0.1',
    mode: 'loopback',
    clientCount: () => 0,
    drainTimeoutMs,
    shutdown,
    close: () => Promise.resolve(),
  }
}

function harness(running: Promise<RunningServer>) {
  const exits: number[] = []
  const backstops: Array<{ fn: () => void; ms: number }> = []
  const handlers = new Map<string, () => void>()
  const deps: ShutdownDeps = {
    onSignal: (sig, h) => handlers.set(sig, h),
    exit: (c) => exits.push(c),
    setBackstop: (fn, ms) => backstops.push({ fn, ms }),
  }
  installShutdownHandlers(running, deps)
  return { exits, backstops, fire: (sig: string) => handlers.get(sig)!() }
}

describe('installShutdownHandlers(#216 C3 T4)', () => {
  it('SIGINT·SIGTERM 둘 다 핸들러 등록', () => {
    const h = harness(Promise.resolve(fakeServer(() => Promise.resolve())))
    expect(() => h.fire('SIGINT')).not.toThrow()
    const h2 = harness(Promise.resolve(fakeServer(() => Promise.resolve())))
    expect(() => h2.fire('SIGTERM')).not.toThrow()
  })

  it('정상: SIGTERM → shutdown → exit(0) · 백스톱 = drainTimeoutMs+3000', async () => {
    const s = fakeServer(() => Promise.resolve(), 25_000)
    const h = harness(Promise.resolve(s))
    h.fire('SIGTERM')
    await tick()
    expect(h.backstops).toHaveLength(1)
    expect(h.backstops[0].ms).toBe(28_000) // 25000 + 3000
    expect(h.exits).toEqual([0])
  })

  it('teardown 실패: shutdown reject → exit(1)', async () => {
    const s = fakeServer(() => Promise.reject(new Error('dispose hang')))
    const h = harness(Promise.resolve(s))
    h.fire('SIGTERM')
    await tick()
    expect(h.exits).toEqual([1])
  })

  it('teardown hang: shutdown 미해소 시 백스톱 fn 발화 → exit(1)(최후 강제 종료)', async () => {
    // shutdown 이 영구 pending(teardown hang) → shutdown-handlers 는 스스로 종료 못 함. 백스톱 fn 이 유일 종착.
    const s = fakeServer(() => new Promise<void>(() => {}))
    const h = harness(Promise.resolve(s))
    h.fire('SIGTERM')
    await tick()
    expect(h.exits).toEqual([]) // shutdown hang → 아직 미종료
    expect(h.backstops).toHaveLength(1)
    h.backstops[0].fn() // 백스톱 발화(setTimeout 콜백에 대응) — teardown hang 최후 안전망
    expect(h.exits).toEqual([1])
  })

  it('2차 시그널: 재-SIGTERM → 즉시 exit(1)(shutdown 재호출 없음)', async () => {
    let shutdownCalls = 0
    const s = fakeServer(() => {
      shutdownCalls++
      return new Promise<void>(() => {}) // 첫 shutdown 은 hang(진행 중)
    })
    const h = harness(Promise.resolve(s))
    h.fire('SIGTERM') // 1차 — shutdown 시작(hang)
    await tick()
    expect(h.exits).toEqual([]) // 아직 종료 안 됨(shutdown hang)
    h.fire('SIGTERM') // 2차 — 즉시 강제
    expect(h.exits).toEqual([1])
    expect(shutdownCalls).toBe(1) // shutdown 재호출 없음
  })

  it('boot reject 중 signal → exit(1)', async () => {
    const running = Promise.reject(new Error('boot fail'))
    const h = harness(running)
    h.fire('SIGTERM') // 동기로 running.then(_, onRej) 배선 → reject 처리(unhandled 없음)
    await tick()
    expect(h.exits).toEqual([1])
  })

  it('boot pending 중 signal → 핸들러 대기(미종료)·2차 signal 강제 exit(1)', async () => {
    // running 은 미resolve(테스트 종료까지 pending) — boot-pending 중 SIGTERM 이 유실되지 않음을 핀.
    const running = new Promise<RunningServer>(() => {})
    const h = harness(running)
    h.fire('SIGTERM') // boot 미완료 — 핸들러 설치·shutdown 대기
    await tick()
    expect(h.exits).toEqual([]) // boot 대기 중 → 미종료(핸들러 유실 아님)
    expect(h.backstops).toHaveLength(0) // 백스톱은 boot resolve 후만 무장
    h.fire('SIGTERM') // 2차 — 즉시 강제(로컬 fallback)
    expect(h.exits).toEqual([1])
  })

  it('boot pending → 이후 resolve 시 shutdown 진행·exit(0)', async () => {
    let resolveBoot!: (s: RunningServer) => void
    const running = new Promise<RunningServer>((res) => {
      resolveBoot = res
    })
    const h = harness(running)
    h.fire('SIGTERM')
    await tick()
    expect(h.exits).toEqual([]) // boot 대기
    resolveBoot(fakeServer(() => Promise.resolve(), 30_000))
    await tick()
    expect(h.backstops[0].ms).toBe(33_000) // boot resolve 후 백스톱 무장(30000+3000)
    expect(h.exits).toEqual([0])
  })
})

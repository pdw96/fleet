import { describe, expect, it, vi } from 'vitest'
import { APPROVAL_MAX_PENDING, type ApprovalRequest } from '../../../shared/types'
import { createApprovalGate } from './approval'
import { createIpcApprover } from './approval-bridge'

/**
 * approver 키스톤 계약(#216 C1 · 계획 T2). 픽스처 시계 규율(전역 전제): `expiresAt` 는 approver 가 읽는
 * **동일 주입 clock**(fakeClock)에서 파생한다. real Date.now + 소값 expiresAt 혼용 금지(delay=0 즉시발화
 * false-green 차단). hold 생존은 **동기 pendingCount 금지** — clock 양방향(TTL-1 pending / TTL 거부)으로 단언.
 */
function fakeClock(start = 0) {
  let t = start
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): number => {
      const id = nextId++
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimer: (h: unknown): void => {
      timers.delete(h as number)
    },
    /** 시간을 ms 만큼 진행하고 만료된 타이머를 due 순서로 발화한다. */
    advance: (ms: number): void => {
      t += ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined
        for (const e of timers) if (e[1].at <= t && (!next || e[1].at < next[1].at)) next = e
        if (!next) break
        timers.delete(next[0])
        next[1].fn()
      }
    },
    timerCount: (): number => timers.size,
  }
}

type Clock = ReturnType<typeof fakeClock>

const req = (id: string, expiresAt = 60_000): ApprovalRequest => ({
  id,
  kind: 'file-write',
  summary: 's',
  target: 't',
  risk: 'destructive',
  ts: 0,
  expiresAt,
})

/** hold 정책 + 주입 clock approver(서버 조립 대응). */
function holdApprover(clock: Clock, extra: Partial<Parameters<typeof createIpcApprover>[0]> = {}) {
  const send = vi.fn()
  const a = createIpcApprover({
    send,
    hasWindow: () => true,
    presencePolicy: 'hold',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  })
  return { a, send }
}

describe('createIpcApprover — reject-immediate 회귀(데스크톱 무회귀)', () => {
  // #1 reject-immediate 회귀 0
  it('#1 presence=0 → 즉시 {approved:false}·send 없음', async () => {
    const send = vi.fn()
    const a = createIpcApprover({ send, hasWindow: () => false })
    expect(await a.approver(req('1'))).toEqual({ approved: false })
    expect(send).not.toHaveBeenCalled()
    expect(a.pendingCount()).toBe(0)
  })

  it('#1b 창 있으면 enqueue·resolve 왕복(기존 동작 보존)', async () => {
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
    const p = a.approver(req('1'))
    expect(a.pendingCount()).toBe(1)
    a.resolve('1', true)
    expect(await p).toEqual({ approved: true })
    expect(a.pendingCount()).toBe(0)
  })
})

describe('createIpcApprover — hold 정책(서버 원격 승인)', () => {
  // #2 hold 생존 양방향
  it('#2 presence=0·hold → 거부 없이 pending 유지(동기 count 금지·clock 양방향)', async () => {
    const clock = fakeClock()
    const send = vi.fn()
    const a = createIpcApprover({
      send,
      hasWindow: () => false,
      presencePolicy: 'hold',
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    let settled: unknown
    const p = a.approver(req('1', 60_000)).then((o) => (settled = o))
    expect(send).toHaveBeenCalledTimes(1) // presence=0 이어도 브로드캐스트(스냅숏 재제시)
    clock.advance(59_999)
    await Promise.resolve()
    expect(a.pendingCount()).toBe(1) // TTL-1 → 여전히 대기
    expect(settled).toBeUndefined()
    clock.advance(1)
    await p
    expect(settled).toEqual({ approved: false }) // 만료 → 거부
    expect(a.pendingCount()).toBe(0)
  })

  // #3 list() + expiresAt 순수 필터
  it('#3 list() 는 미만료 pending req 를 반환하고 expiresAt<=now 를 제외한다(순수 필터·pendingCount 정합)', async () => {
    const clock = fakeClock()
    const { a } = holdApprover(clock)
    void a.approver(req('a', 10_000))
    void a.approver(req('b', 20_000))
    expect(
      a
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['a', 'b'])
    expect(a.pendingCount()).toBe(2)
    clock.advance(10_000) // a 만료(타이머 발화 → 제거)
    await Promise.resolve()
    expect(a.list().map((r) => r.id)).toEqual(['b'])
    expect(a.pendingCount()).toBe(1)
  })

  // #4 TTL 만료 3연쇄
  it('#4 만료 → resolve {approved:false} · list 제거 · late resolve no-op · onWithdraw 1회', async () => {
    const clock = fakeClock()
    const withdrawn: string[] = []
    const { a } = holdApprover(clock, { onWithdraw: (id) => withdrawn.push(id) })
    let settled: unknown
    const p = a.approver(req('1', 5_000)).then((o) => (settled = o))
    clock.advance(5_000)
    await p
    expect(settled).toEqual({ approved: false })
    expect(a.list()).toEqual([])
    expect(withdrawn).toEqual(['1'])
    a.resolve('1', true) // late resolve — 무시(재해소 없음)
    expect(withdrawn).toEqual(['1'])
  })

  // #5 다중 pending 멱등
  it('#5 다중 pending 개별 resolve 멱등·list 정합', async () => {
    const clock = fakeClock()
    const { a } = holdApprover(clock)
    const p1 = a.approver(req('a'))
    const p2 = a.approver(req('b'))
    expect(a.pendingCount()).toBe(2)
    a.resolve('b', false)
    a.resolve('b', true) // 이미 해소 — 무시
    a.resolve('a', true)
    expect(await p1).toEqual({ approved: true })
    expect(await p2).toEqual({ approved: false })
    expect(a.list()).toEqual([])
  })

  // #6 maxPending 경계
  it('#6 maxPending 경계 — 정확히 max hold·(max+1) 즉시 {approved:false, reason:pending-cap}·회복', async () => {
    const clock = fakeClock()
    const { a } = holdApprover(clock, { maxPending: 2 })
    void a.approver(req('a'))
    void a.approver(req('b'))
    expect(a.pendingCount()).toBe(2)
    expect(await a.approver(req('c'))).toEqual({ approved: false, reason: 'pending-cap' })
    expect(a.pendingCount()).toBe(2) // cap-reject 는 enqueue 안 함
    a.resolve('a', true) // 용량 회복
    expect(a.pendingCount()).toBe(1)
    void a.approver(req('d'))
    expect(a.pendingCount()).toBe(2)
  })

  it('#6b maxPending 기본값 = APPROVAL_MAX_PENDING', () => {
    const clock = fakeClock()
    const { a } = holdApprover(clock)
    for (let i = 0; i < APPROVAL_MAX_PENDING; i++) void a.approver(req(`k${i}`))
    expect(a.pendingCount()).toBe(APPROVAL_MAX_PENDING)
  })
})

describe('createIpcApprover — onWithdraw 전경로 + best-effort(불변식 ①④)', () => {
  // #7 onWithdraw 전경로
  it('#7 resolve/만료/abort/rejectAll 각 onWithdraw(id) 1회', async () => {
    const clock = fakeClock()
    const withdrawn: string[] = []
    const { a } = holdApprover(clock, { onWithdraw: (id) => withdrawn.push(id) })
    // resolve
    void a.approver(req('r'))
    a.resolve('r', true)
    // 만료
    void a.approver(req('e', 1_000))
    clock.advance(1_000)
    // abort
    const ctrl = new AbortController()
    void a.approver(req('x'), { signal: ctrl.signal })
    ctrl.abort()
    // rejectAll
    void a.approver(req('z'))
    a.rejectAll()
    await Promise.resolve()
    expect(withdrawn.sort()).toEqual(['e', 'r', 'x', 'z'])
    // 각 정확히 1회
    expect(new Set(withdrawn).size).toBe(withdrawn.length)
  })

  // #7b onWithdraw throw 격리(불변식 ④·스펙수정 #3)
  it('#7b onWithdraw throw 해도 {approved:false} 해소 선행 보존·만료 타이머 self-DoS 크래시 없음', async () => {
    const clock = fakeClock()
    const { a } = holdApprover(clock, {
      onWithdraw: () => {
        throw new Error('boom')
      },
    })
    let settled: unknown
    const p = a.approver(req('1', 1_000)).then((o) => (settled = o))
    expect(() => clock.advance(1_000)).not.toThrow() // 만료 콜백이 크래시 안 함
    await p
    expect(settled).toEqual({ approved: false }) // resolve 선행 보존
    expect(a.pendingCount()).toBe(0)
  })
})

describe('createIpcApprover — send/rejectAll best-effort(불변식 ①③⑤)', () => {
  // #8 send throw
  it('#8 send 예외 → pending 유지·promise reject 없음·좀비 없음(만료 종착)', async () => {
    const clock = fakeClock()
    const a = createIpcApprover({
      send: () => {
        throw new Error('broadcast down')
      },
      hasWindow: () => true,
      presencePolicy: 'hold',
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    let rejected = false
    let settled: unknown
    const p = a.approver(req('1', 1_000)).then(
      (o) => (settled = o),
      () => (rejected = true),
    )
    expect(a.pendingCount()).toBe(1) // send throw 에도 pending 유지
    clock.advance(1_000)
    await p
    expect(rejected).toBe(false) // promise 는 reject 안 됨
    expect(settled).toEqual({ approved: false }) // 만료 종착
    expect(a.pendingCount()).toBe(0)
  })

  // #9 rejectAll 재진입 onWithdraw
  it('#9 rejectAll 재진입 onWithdraw 주입해도 id당 resolve·onWithdraw 1회(불변식 ①)', async () => {
    const clock = fakeClock()
    const withdrawn: string[] = []
    let reentrant: (() => void) | null = null
    const holder = holdApprover(clock, {
      onWithdraw: (id) => {
        withdrawn.push(id)
        reentrant?.() // 재진입: onWithdraw 안에서 다시 rejectAll
      },
    })
    const a = holder.a
    reentrant = () => a.rejectAll()
    const p1 = a.approver(req('a'))
    const p2 = a.approver(req('b'))
    a.rejectAll()
    expect(await p1).toEqual({ approved: false })
    expect(await p2).toEqual({ approved: false })
    // id당 정확히 1회(재진입에도 재withdraw 없음)
    expect(withdrawn.sort()).toEqual(['a', 'b'])
    expect(new Set(withdrawn).size).toBe(2)
  })

  // #10 중복 id enqueue
  it('#10 중복 id enqueue → 첫 pending 미고아·둘째 거부', async () => {
    const clock = fakeClock()
    const { a } = holdApprover(clock)
    const p1 = a.approver(req('dup'))
    expect(a.pendingCount()).toBe(1)
    expect(await a.approver(req('dup'))).toEqual({ approved: false }) // 둘째 즉시 거부
    expect(a.pendingCount()).toBe(1) // 첫 pending 미고아
    a.resolve('dup', true)
    expect(await p1).toEqual({ approved: true })
  })
})

describe('createIpcApprover — 취소 signal 배선(불변식 ②·리스너 정리)', () => {
  // #11 abort 즉시 해소
  it('#11 보류 중 abort → 즉시 {approved:false}·onWithdraw(id)·리스너 정리', async () => {
    const clock = fakeClock()
    const withdrawn: string[] = []
    const { a } = holdApprover(clock, { onWithdraw: (id) => withdrawn.push(id) })
    const ctrl = new AbortController()
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener')
    const p = a.approver(req('1', 999_999), { signal: ctrl.signal })
    expect(a.pendingCount()).toBe(1)
    ctrl.abort()
    expect(await p).toEqual({ approved: false }) // TTL(999999) 무관 — 즉시
    expect(withdrawn).toEqual(['1'])
    expect(a.pendingCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  // #12 진입 시 aborted
  it('#12 이미 aborted signal → enqueue/send 없이 즉시 {approved:false}(불변식 ②)', async () => {
    const clock = fakeClock()
    const { a, send } = holdApprover(clock)
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await a.approver(req('1'), { signal: ctrl.signal })).toEqual({ approved: false })
    expect(send).not.toHaveBeenCalled()
    expect(a.pendingCount()).toBe(0)
  })

  // #13 리스너 정리 전경로
  it('#13 정상 resolve/만료/rejectAll 각각 후 리스너 잔존 0·정상 resolve 후 abort 재해소 0', async () => {
    const clock = fakeClock()
    const withdrawn: string[] = []
    const { a } = holdApprover(clock, { onWithdraw: (id) => withdrawn.push(id) })
    // 정상 resolve 후 abort → 재해소·재withdraw 없음
    const ctrl = new AbortController()
    const remove = vi.spyOn(ctrl.signal, 'removeEventListener')
    const p = a.approver(req('1', 999_999), { signal: ctrl.signal })
    a.resolve('1', true)
    expect(await p).toEqual({ approved: true })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)) // 리스너 정리
    ctrl.abort() // 정리됐으므로 재해소 없음
    expect(withdrawn).toEqual(['1']) // resolve 시 1회만
  })
})

describe('취소 그래프 통합 관통 — 실 gate + 실 approver(hold) + signal (P1-1·§3-14)', () => {
  // #14 3-seam end-to-end (mock-arg 확인 금지)
  it('#14 gate.request(partial,{signal}) → pending → abort → gate "rejected"·approver {approved:false}·onWithdraw 1회·리스너 정리', async () => {
    const clock = fakeClock()
    const withdrawn: string[] = []
    const ipc = createIpcApprover({
      send: vi.fn(),
      hasWindow: () => false, // presence=0 이어도 hold → 대기
      presencePolicy: 'hold',
      onWithdraw: (id) => withdrawn.push(id),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })
    const gate = createApprovalGate({ approver: ipc.approver, now: clock.now, ttlMs: 600_000 })
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let decision: string | undefined
    const p = gate
      .request(
        { kind: 'shell', summary: '', target: 'x', risk: 'destructive' },
        { signal: controller.signal },
      )
      .then((d) => (decision = d))
    await Promise.resolve()
    expect(ipc.pendingCount()).toBe(1) // pending (hold)
    controller.abort()
    await p
    // approver 는 throw/reject 가 아니라 {approved:false} 로 해소 → gate 는 'rejected' 결정 반환(예외 아님)
    expect(decision).toBe('rejected')
    expect(ipc.pendingCount()).toBe(0)
    expect(withdrawn).toEqual([expect.any(String)]) // onWithdraw 1회(id=gate 생성 UUID)
    expect(withdrawn).toHaveLength(1)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)) // 리스너 정리
  })
})

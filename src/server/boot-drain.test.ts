import { describe, expect, it } from 'vitest'
import { waitForRunDrain } from './boot'
import type { RunActivity } from '../shared/types'

/**
 * waitForRunDrain 순수 단위 테스트(#216 C3 T1). WS/electron 무의존 — 자기완결 fakeClock 으로 결정론.
 * bootServer 통합으로는 결정론 불가(e2e hang 러너가 signal 미honor → activeRuns 안 비움 · 스펙 §5) →
 * 순수 함수 추출이 정답. boot-access.test.ts 의 fakeClock 과 동형이나 여기 복제해 ripple 격리(계획 C 이식).
 */
function fakeClock(startMs: number) {
  let current = startMs
  const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = []
  const clock = {
    now: () => current,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, at: current + ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimeout: (h: unknown) => {
      if (h && typeof h === 'object' && 'cleared' in h) (h as { cleared: boolean }).cleared = true
    },
  }
  const advanceTo = (ms: number): void => {
    current = ms
    for (;;) {
      const due = timers.find((t) => !t.cleared && t.at <= current)
      if (!due) break
      due.cleared = true
      due.fn() // 재무장(re-arm) 시 새 timer 가 push 되어 루프가 재수집
    }
  }
  return { clock, advanceTo, activeCount: () => timers.filter((t) => !t.cleared).length }
}

const empty: RunActivity = { activeProjectIds: [] }
const busy: RunActivity = { activeProjectIds: ['p1'] }

describe('waitForRunDrain(#216 C3 T1)', () => {
  it('초기 무런 → 즉시 drained · 타이머 무장 0', async () => {
    const fc = fakeClock(0)
    await expect(waitForRunDrain(() => empty, fc.clock, 25_000, 250)).resolves.toBe('drained')
    expect(fc.activeCount()).toBe(0)
  })

  it('런 해제 → poll 발화 시 drained + 형제 cap 타이머 clear(누수 0)', async () => {
    const fc = fakeClock(0)
    let activity = busy
    const p = waitForRunDrain(() => activity, fc.clock, 25_000, 250)
    fc.advanceTo(250) // 첫 poll: 여전히 busy → 재무장(미settle)
    activity = empty
    fc.advanceTo(500) // 다음 poll: empty → drained
    await expect(p).resolves.toBe('drained')
    expect(fc.activeCount()).toBe(0) // cap 타이머까지 clear
  })

  it('상한 초과(계속 busy) → timeout + 형제 poll 타이머 clear', async () => {
    const fc = fakeClock(0)
    const p = waitForRunDrain(() => busy, fc.clock, 1_000, 250)
    fc.advanceTo(1_000) // cap 발화
    await expect(p).resolves.toBe('timeout')
    expect(fc.activeCount()).toBe(0) // poll 타이머까지 clear
  })

  it.each([0, -1])('pollMs<=0(%d) → throw(재귀 폭주 방지)', (pollMs) => {
    const fc = fakeClock(0)
    expect(() => waitForRunDrain(() => busy, fc.clock, 1_000, pollMs)).toThrow()
  })

  it('cap==poll 동시 발화 → 단일 settled 래치 1회 · 좀비 재스케줄 0', async () => {
    const fc = fakeClock(0)
    const p = waitForRunDrain(() => busy, fc.clock, 250, 250) // cap==poll 동시각
    fc.advanceTo(250)
    const r = await p
    expect(['drained', 'timeout']).toContain(r) // 어느 쪽이든 1회 해소
    expect(fc.activeCount()).toBe(0)
    fc.advanceTo(10_000) // 추가 전진 — 재-resolve·좀비 재스케줄 없음
    expect(fc.activeCount()).toBe(0)
  })
})

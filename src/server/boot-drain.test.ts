import { describe, expect, it } from 'vitest'
import { waitForRunDrain } from './boot'
import { hasLegacyRun, type RunActivity } from '../shared/types'

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

const empty: RunActivity = { activeProjectIds: [], activeRuns: [] }
const busy: RunActivity = { activeProjectIds: ['p1'], activeRuns: [{ projectId: 'p1' }] }
/** bench 스코프 런만 진행 중인 스냅숏 — R-1 검증용(#251 PR0). */
const benchBusy: RunActivity = {
  activeProjectIds: ['p1'],
  activeRuns: [{ projectId: 'p1', benchId: 'b1' }],
}

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

  it('cap==poll 동시 발화 → 단일 settled 래치 1회 해소 · 좀비 재스케줄 0', async () => {
    const fc = fakeClock(0)
    const p = waitForRunDrain(() => busy, fc.clock, 250, 250) // cap==poll 동시각
    fc.advanceTo(250)
    // busy 유지(activeProjectIds 비지 않음)라 'drained' 는 정당하게 불가 — 반드시 'timeout'(spurious-drain 회귀
    // 차단). fakeClock 은 삽입 순서 첫 매치를 발화하고 waitForRunDrain 이 capH 를 pollH 보다 먼저 삽입하므로 tie 는
    // 항상 cap 승. settled 래치가 형제 poll 을 clear → 이중 해소 없음(activeCount 0 · 추가 전진서 재-resolve 0).
    await expect(p).resolves.toBe('timeout')
    expect(fc.activeCount()).toBe(0)
    fc.advanceTo(10_000) // 추가 전진 — 재-resolve·좀비 재스케줄 없음
    expect(fc.activeCount()).toBe(0)
  })
})

/**
 * R-1 드레인 권위(#251 PR0 · 스펙 §W-10) — **전 스코프** 런이 `activeProjectIds` 에 나타난다.
 *
 * bench 런을 빼면 SIGTERM 시 진행 중 bench 런이 무성 절단된다(`waitForRunDrain` 은 이 필드만 본다).
 * 동시에 같은 스냅숏에서 레거시 잠금(R-2)은 풀려 있어야 한다 — 두 불변식이 한 필드로 붕괴하지 않음을
 * 드레인 함수 실행으로 종단 확인한다.
 *
 * 반증력: `waitForRunDrain` 이 `activeRuns` 의 레거시분만 세도록 바뀌면 첫 케이스가 즉시 'drained' 로
 * RED. 반대로 `hasLegacyRun` 이 `activeProjectIds` 를 보도록 바뀌면 두 번째 단언이 RED.
 *
 * ⚠ 범위 정직성: 이 계약은 **서버 표면 전용**이다. 데스크톱은 `will-quit` 이 곧장 `engine.dispose()` +
 * 3s 하드 타이머로 끝내 드레인이 아예 없다(main/index.ts) — `waitForRunDrain` 의 호출부는 boot.ts 하나뿐.
 * 데스크톱 Workbench(#255)는 R-1 을 자동 상속하지 않는다.
 */
describe('R-1 — 드레인은 bench 런도 기다린다(#251 PR0)', () => {
  it('bench 런만 진행 중이어도 drained 가 아니다(cap 만료까지 대기)', async () => {
    const fc = fakeClock(0)
    const p = waitForRunDrain(() => benchBusy, fc.clock, 1_000, 250)
    fc.advanceTo(1_000)
    await expect(p).resolves.toBe('timeout')
    // 같은 스냅숏에서 레거시 잠금은 걸리지 않는다(R-2) — 두 불변식 비붕괴.
    expect(hasLegacyRun(benchBusy)).toBe(false)
  })

  it('bench 런 종료 → drained(전 스코프 집합이 비면 종료 진행)', async () => {
    const fc = fakeClock(0)
    let activity = benchBusy
    const p = waitForRunDrain(() => activity, fc.clock, 25_000, 250)
    fc.advanceTo(250)
    activity = empty
    fc.advanceTo(500)
    await expect(p).resolves.toBe('drained')
    expect(fc.activeCount()).toBe(0)
  })
})

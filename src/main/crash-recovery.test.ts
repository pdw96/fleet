import { describe, expect, it, vi } from 'vitest'
import {
  installChildProcessObserver,
  installCrashRecovery,
  type ChildProcessGoneInfo,
  type ChildProcessObservable,
  type CrashRecoveryOptions,
  type RecoverableWebContents,
  type RenderProcessGoneInfo,
} from './crash-recovery'

/** webContents 의 크래시 관련 표면만 흉내내는 페이크 — render-process-gone 리스너를 캡처해 발화를 시뮬레이트한다. */
function fakeWebContents() {
  let listener: ((e: unknown, d: RenderProcessGoneInfo) => void) | undefined
  let destroyed = false
  const reload = vi.fn()
  const wc: RecoverableWebContents = {
    on: (_event, l) => {
      listener = l
      return wc
    },
    reload,
    isDestroyed: () => destroyed,
  }
  return {
    wc,
    reload,
    /** 창 닫힘(파괴) 시뮬레이트. */
    destroy: () => {
      destroyed = true
    },
    /** render-process-gone 발화 → 설치된 리스너 호출. */
    crash: (reason: string, exitCode = 0) => listener?.({}, { reason, exitCode }),
  }
}

/** 수동 실행 가능한 결정론적 스케줄러 — 예약된 콜백과 지연을 캡처한다. */
function fakeScheduler() {
  const pending: Array<{ fn: () => void; ms: number }> = []
  return {
    schedule: (fn: () => void, ms: number) => {
      pending.push({ fn, ms })
    },
    /** 지금까지 예약된 모든 콜백을 실행(예약 큐는 비운다). */
    runAll: () => {
      const batch = pending.splice(0, pending.length)
      for (const p of batch) p.fn()
    },
    /** 예약된 지연(ms) 목록 — 백오프 검증용. */
    delays: () => pending.map((p) => p.ms),
  }
}

/** resetMs 보다 충분히 큰 시계 진행으로 '안정 구간 경과'를 만든다. */
const STABLE_GAP_MS = 60_000

describe('installCrashRecovery', () => {
  it('비정상 크래시(crashed)면 백오프 후 해당 wc 를 reload 한다', () => {
    const f = fakeWebContents()
    const sched = fakeScheduler()
    installCrashRecovery(f.wc, { log: () => {}, schedule: sched.schedule, now: () => 0 })

    f.crash('crashed', 134)
    // 즉시 reload 가 아니라 기준 백오프(500ms) 후 예약.
    expect(sched.delays()).toEqual([500])
    expect(f.reload).not.toHaveBeenCalled()

    sched.runAll()
    expect(f.reload).toHaveBeenCalledTimes(1)
  })

  it.each(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure'])(
    '복구 대상 reason(%s)은 reload 한다',
    (reason) => {
      const f = fakeWebContents()
      const sched = fakeScheduler()
      installCrashRecovery(f.wc, { log: () => {}, schedule: sched.schedule, now: () => 0 })
      f.crash(reason)
      sched.runAll()
      expect(f.reload).toHaveBeenCalledTimes(1)
    },
  )

  it('정상 종료(reason=clean-exit)는 reload 하지 않는다', () => {
    const f = fakeWebContents()
    const sched = fakeScheduler()
    installCrashRecovery(f.wc, { log: () => {}, schedule: sched.schedule, now: () => 0 })
    f.crash('clean-exit')
    expect(sched.delays()).toEqual([])
    sched.runAll()
    expect(f.reload).not.toHaveBeenCalled()
  })

  it('외부 kill(reason=killed) 렌더러는 창이 살아있으므로 reload 로 복구한다 (Codex P2 회귀 방지)', () => {
    // killed = SIGTERM 등 외부 강제 종료 또는 webContents.forcefullyCrashRenderer() — BrowserWindow 는
    // 살아있고 렌더러만 사라진 흰 화면 상태다. killed 를 teardown 으로 오인해 생략하면 복구가 무력화된다.
    const f = fakeWebContents()
    const sched = fakeScheduler()
    installCrashRecovery(f.wc, { log: () => {}, schedule: sched.schedule, now: () => 0 })
    f.crash('killed', 0)
    expect(sched.delays()).toEqual([500])
    sched.runAll()
    expect(f.reload).toHaveBeenCalledTimes(1)
  })

  it('앱 종료 진행 중(isShuttingDown)이면 비정상 크래시여도 reload 하지 않는다', () => {
    // teardown 억제는 reason 이 아니라 종료 플래그로 판정 — 종료 중엔 어떤 사유든 reload 로 종료와 싸우지 않는다.
    const f = fakeWebContents()
    const sched = fakeScheduler()
    installCrashRecovery(f.wc, {
      log: () => {},
      schedule: sched.schedule,
      now: () => 0,
      isShuttingDown: () => true,
    })
    f.crash('crashed')
    sched.runAll()
    expect(f.reload).not.toHaveBeenCalled()
  })

  it('연속 크래시마다 지수 백오프로 간격을 벌린다', () => {
    const f = fakeWebContents()
    const sched = fakeScheduler()
    let t = 0
    const opts: CrashRecoveryOptions = { log: () => {}, schedule: sched.schedule, now: () => t }
    installCrashRecovery(f.wc, opts)

    f.crash('crashed') // 1회차 → 500
    t = 100
    f.crash('crashed') // 2회차 → 1000
    t = 200
    f.crash('crashed') // 3회차 → 2000
    expect(sched.delays()).toEqual([500, 1000, 2000])
  })

  it('연속 크래시가 maxReloads 를 넘으면 reload 를 포기한다(무한 루프 차단)', () => {
    const f = fakeWebContents()
    const sched = fakeScheduler()
    let t = 0
    installCrashRecovery(f.wc, {
      log: () => {},
      schedule: sched.schedule,
      now: () => t,
      maxReloads: 3,
    })

    for (let i = 0; i < 5; i++) {
      f.crash('crashed')
      t += 100 // 안정 구간(30s) 미만이라 연속으로 누적.
    }
    // 4·5회차는 예약조차 되지 않는다 → 3건만 예약.
    expect(sched.delays()).toHaveLength(3)
    sched.runAll()
    expect(f.reload).toHaveBeenCalledTimes(3)
  })

  it('안정 구간(resetMs)이 지나면 연속 카운트를 리셋해 다시 복구한다', () => {
    const f = fakeWebContents()
    const sched = fakeScheduler()
    let t = 0
    installCrashRecovery(f.wc, {
      log: () => {},
      schedule: sched.schedule,
      now: () => t,
      maxReloads: 1,
    })

    f.crash('crashed') // 1회차 → 예약(백오프 500)
    expect(sched.delays()).toEqual([500])
    sched.runAll()

    // maxReloads=1 이므로 안정 구간 없이 곧장 또 크래시하면 포기해야 한다.
    f.crash('crashed')
    expect(sched.delays()).toEqual([])

    // 충분히 시간이 지난 뒤의 크래시는 새 사건 → 카운트 리셋 → 다시 백오프 500 으로 예약.
    t += STABLE_GAP_MS
    f.crash('crashed')
    expect(sched.delays()).toEqual([500])
    sched.runAll()
    expect(f.reload).toHaveBeenCalledTimes(2)
  })

  it('백오프 대기 중 창이 파괴되면 reload 하지 않는다', () => {
    const f = fakeWebContents()
    const sched = fakeScheduler()
    installCrashRecovery(f.wc, { log: () => {}, schedule: sched.schedule, now: () => 0 })

    f.crash('crashed')
    f.destroy() // 타이머 발화 전에 창 닫힘.
    sched.runAll()
    expect(f.reload).not.toHaveBeenCalled()
  })

  it('백오프는 maxDelayMs 로 상한된다', () => {
    const f = fakeWebContents()
    const sched = fakeScheduler()
    let t = 0
    installCrashRecovery(f.wc, {
      log: () => {},
      schedule: sched.schedule,
      now: () => t,
      maxReloads: 10,
      baseDelayMs: 500,
      maxDelayMs: 1500,
    })
    for (let i = 0; i < 4; i++) {
      f.crash('crashed')
      t += 100
    }
    // 500·1000·2000·4000 → 상한 1500 적용 → 500·1000·1500·1500
    expect(sched.delays()).toEqual([500, 1000, 1500, 1500])
  })
})

/** app 의 child-process-gone 표면만 흉내내는 페이크. */
function fakeApp() {
  let listener: ((e: unknown, d: ChildProcessGoneInfo) => void) | undefined
  const app: ChildProcessObservable = {
    on: (_event, l) => {
      listener = l
      return app
    },
  }
  return {
    app,
    fire: (details: ChildProcessGoneInfo) => listener?.({}, details),
  }
}

describe('installChildProcessObserver', () => {
  it('보조 프로세스 비정상 종료는 진단 로그만 남긴다(reload 없음)', () => {
    const f = fakeApp()
    const log = vi.fn()
    installChildProcessObserver(f.app, log)
    f.fire({ type: 'GPU', reason: 'crashed', exitCode: 139, name: 'GPU Process' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('type=GPU')
    expect(log.mock.calls[0][0]).toContain('reason=crashed')
  })

  it('정상 종료(clean-exit/killed)는 기록하지 않는다', () => {
    const f = fakeApp()
    const log = vi.fn()
    installChildProcessObserver(f.app, log)
    f.fire({ type: 'Utility', reason: 'clean-exit', exitCode: 0 })
    f.fire({ type: 'Utility', reason: 'killed', exitCode: 0 })
    expect(log).not.toHaveBeenCalled()
  })
})

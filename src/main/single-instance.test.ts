import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  acquireSingleInstanceLock,
  type LockableApp,
  type RestorableWindow,
} from './single-instance'

/**
 * 이중 기동 배타 계약(#293 W1).
 *
 * 핵심 단언은 두 가지다: (1) 락을 못 잡으면 즉시 quit 하고 `false` 를 돌려준다 — 호출자가 부팅을
 * 진행하지 않게 하는 유일한 신호다. (2) 락을 잡은 인스턴스는 이후 기동 시도에 첫 창을 복원·포커스한다.
 *
 * 여기에 더해 **부팅 배선이 이 반환값 뒤에 온다**는 것을 `index.ts` 소스 스캔으로 핀한다 — 엔진·store
 * 생성이 락 앞으로 새면 두 번째 인스턴스가 `fleet-store.json` 을 열어 유실 창이 다시 열리는데,
 * 그 회귀는 타입체커가 잡지 못한다(ipc-parity.test.ts 와 같은 정적 텍스트 가드 패턴).
 */

function fakeApp(locked: boolean) {
  const quit = vi.fn(() => {})
  const listeners: Array<() => void> = []
  return {
    quit,
    fireSecondInstance: () => listeners.forEach((l) => l()),
    app: {
      requestSingleInstanceLock: () => locked,
      quit,
      on: (_event: 'second-instance', listener: () => void) => listeners.push(listener),
    } satisfies LockableApp,
  }
}

function fakeWindow(minimized: boolean) {
  return {
    isMinimized: () => minimized,
    restore: vi.fn(() => {}),
    show: vi.fn(() => {}),
    focus: vi.fn(() => {}),
  } satisfies RestorableWindow
}

describe('acquireSingleInstanceLock', () => {
  it('락 획득 실패 시 quit 을 요청하고 false 를 반환한다(부팅 중단 신호)', () => {
    const { app, quit } = fakeApp(false)
    const getWindows = vi.fn(() => [] as RestorableWindow[])

    expect(acquireSingleInstanceLock(app, { getWindows })).toBe(false)
    expect(quit).toHaveBeenCalledTimes(1)
    // 창 조회조차 하지 않는다 — 두 번째 인스턴스는 어떤 상태도 건드리지 않고 나간다.
    expect(getWindows).not.toHaveBeenCalled()
  })

  it('락 획득 성공 시 true 를 반환하고 quit 하지 않는다', () => {
    const { app, quit } = fakeApp(true)

    expect(acquireSingleInstanceLock(app, { getWindows: () => [] })).toBe(true)
    expect(quit).not.toHaveBeenCalled()
  })

  it('second-instance 에서 최소화된 첫 창을 복원·표시·포커스한다', () => {
    const { app, fireSecondInstance } = fakeApp(true)
    const win = fakeWindow(true)

    acquireSingleInstanceLock(app, { getWindows: () => [win] })
    fireSecondInstance()

    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('최소화되지 않은 창은 restore 없이 포커스만 한다', () => {
    const { app, fireSecondInstance } = fakeApp(true)
    const win = fakeWindow(false)

    acquireSingleInstanceLock(app, { getWindows: () => [win] })
    fireSecondInstance()

    expect(win.restore).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('창이 없으면 second-instance 는 무해하게 지나간다', () => {
    const { app, fireSecondInstance } = fakeApp(true)

    acquireSingleInstanceLock(app, { getWindows: () => [] })
    expect(() => fireSecondInstance()).not.toThrow()
  })
})

describe('main/index.ts 부팅 배선', () => {
  const mainSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

  it('락 획득 이후에만 whenReady 부팅을 배선한다', () => {
    const guardAt = mainSrc.indexOf('if (acquireSingleInstanceLock(')
    const readyAt = mainSrc.indexOf('app.whenReady(')

    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(readyAt).toBeGreaterThan(guardAt)
    // whenReady 배선은 단 한 곳 — 가드 밖의 두 번째 배선이 생기면 이 단언이 RED.
    expect(mainSrc.split('app.whenReady(')).toHaveLength(2)
  })

  it('엔진·store 생성은 whenReady 콜백(bootstrap) 안에서만 일어난다', () => {
    const bootstrapAt = mainSrc.indexOf('function bootstrap(')
    const buildAt = mainSrc.indexOf('= buildEngine()')

    expect(bootstrapAt).toBeGreaterThanOrEqual(0)
    expect(buildAt).toBeGreaterThan(bootstrapAt)
    expect(mainSrc.split('= buildEngine()')).toHaveLength(2) // 호출 부위는 한 곳뿐
  })
})

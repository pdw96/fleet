/** @vitest-environment jsdom */
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WsBridge } from './ws-bridge'
import { ConnectionBanner, HydrationProvider, useHydration } from './hydration'

/** onEventCursor/onConnectionState 만 구동하는 페이크 브리지. */
function fakeBridge() {
  let cursorCb: ((c: { maxEventSeq: number; minRetainedEventSeq: number }) => void) | undefined
  let stateCb: ((s: 'connecting' | 'connected' | 'reconnecting' | 'closed') => void) | undefined
  const bridge = {
    fleet: { onOrchestratorEvent: vi.fn(() => () => {}) },
    onEventCursor: vi.fn((cb) => {
      cursorCb = cb
      return () => {
        cursorCb = undefined
      }
    }),
    onConnectionState: vi.fn((cb) => {
      stateCb = cb
      return () => {
        stateCb = undefined
      }
    }),
    getEventCursor: () => null,
    connectionState: () => 'connecting' as const,
    dispose: vi.fn(),
  } as unknown as WsBridge
  return {
    bridge,
    hello: (max: number, min = 1) =>
      act(() => cursorCb?.({ maxEventSeq: max, minRetainedEventSeq: min })),
    setState: (s: 'connecting' | 'connected' | 'reconnecting' | 'closed') =>
      act(() => stateCb?.(s)),
  }
}

function Probe() {
  const { nonce, connection } = useHydration()
  return <div data-testid="probe">{`n=${nonce} c=${connection ?? 'desktop'}`}</div>
}

describe('HydrationProvider(#197 B4)', () => {
  it('bridge=null(데스크톱): nonce 0 고정·connection null', () => {
    render(
      <HydrationProvider bridge={null}>
        <Probe />
      </HydrationProvider>,
    )
    expect(screen.getByTestId('probe').textContent).toBe('n=0 c=desktop')
  })

  it('최초 hello 는 nonce 를 올리지 않고, 재접속 hello 마다 +1', () => {
    const f = fakeBridge()
    render(
      <HydrationProvider bridge={f.bridge}>
        <Probe />
      </HydrationProvider>,
    )
    f.hello(10)
    expect(screen.getByTestId('probe').textContent).toContain('n=0')
    f.hello(20)
    expect(screen.getByTestId('probe').textContent).toContain('n=1')
    f.hello(30)
    expect(screen.getByTestId('probe').textContent).toContain('n=2')
  })

  it('gap(커서+1 < minRetained)이면 console.warn 으로 관측한다', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = fakeBridge()
    render(
      <HydrationProvider bridge={f.bridge}>
        <Probe />
      </HydrationProvider>,
    )
    f.hello(10) // 커서=10
    f.hello(50, 40) // 10+1 < 40 → gap
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('이벤트 gap'))
    warn.mockRestore()
  })

  it('connection 상태를 전파한다', () => {
    const f = fakeBridge()
    render(
      <HydrationProvider bridge={f.bridge}>
        <Probe />
      </HydrationProvider>,
    )
    f.setState('reconnecting')
    expect(screen.getByTestId('probe').textContent).toContain('c=reconnecting')
  })
})

describe('ConnectionBanner(#197 B4)', () => {
  it('데스크톱(null)에선 아무것도 렌더하지 않는다', () => {
    render(
      <HydrationProvider bridge={null}>
        <ConnectionBanner />
      </HydrationProvider>,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reconnecting 이면 재접속 배너, closed 면 종료 배너', () => {
    const f = fakeBridge()
    render(
      <HydrationProvider bridge={f.bridge}>
        <ConnectionBanner />
      </HydrationProvider>,
    )
    f.setState('reconnecting')
    expect(screen.getByRole('status').textContent).toContain('재접속 중')
    f.setState('closed')
    expect(screen.getByRole('status').textContent).toContain('새로고침')
  })

  it('재접속 완료(nonce 증가) 후 스냅숏 권위·델타 유실 통지를 표시한다(체크포인트 2-R 노트 3)', () => {
    const f = fakeBridge()
    render(
      <HydrationProvider bridge={f.bridge}>
        <ConnectionBanner />
      </HydrationProvider>,
    )
    f.hello(10)
    f.setState('reconnecting')
    f.setState('connected')
    f.hello(20) // 재하이드레이션 트리거
    const text = screen.getByRole('status').textContent ?? ''
    expect(text).toContain('유실')
    expect(text).toContain('스냅숏')
  })
})

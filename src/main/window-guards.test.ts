import { describe, expect, it, vi } from 'vitest'
import { installNavigationGuards, type GuardableWebContents } from './window-guards'

type NavEvent = 'will-navigate' | 'will-redirect' | 'will-frame-navigate'

/** webContents 의 가드 관련 표면만 흉내내는 페이크 — 설치된 핸들러를 캡처해 호출을 시뮬레이트한다. */
function fakeWebContents() {
  let windowOpenHandler: ((d: { url: string }) => { action: 'deny' | 'allow' }) | undefined
  const navListeners = new Map<string, Array<(e: { preventDefault: () => void }) => void>>()
  const wc: GuardableWebContents = {
    setWindowOpenHandler: (h) => {
      windowOpenHandler = h
    },
    on: (event: string, listener: (e: { preventDefault: () => void }) => void) => {
      const arr = navListeners.get(event) ?? []
      arr.push(listener)
      navListeners.set(event, arr)
      return wc
    },
  }
  return {
    wc,
    /** window.open / target=_blank / 새 창 요청 시 main 이 부르는 핸들러의 응답. */
    requestOpen: (url: string) => windowOpenHandler?.({ url }),
    /** 해당 네비게이션 이벤트 발생 시뮬레이트 → preventDefault 호출 여부 반환. */
    fireNav: (event: NavEvent) => {
      const preventDefault = vi.fn()
      for (const l of navListeners.get(event) ?? []) l({ preventDefault })
      return preventDefault.mock.calls.length > 0
    },
  }
}

describe('installNavigationGuards', () => {
  it('denies every window-open request (window.open / target=_blank / new window)', () => {
    const f = fakeWebContents()
    installNavigationGuards(f.wc)
    expect(f.requestOpen('https://evil.example')).toEqual({ action: 'deny' })
    expect(f.requestOpen('file:///etc/passwd')).toEqual({ action: 'deny' })
  })

  it('blocks page-initiated navigation on all channels (main-frame, redirect, subframe)', () => {
    const f = fakeWebContents()
    installNavigationGuards(f.wc)
    // 메인 프레임 네비(드롭 file://·외부 링크·주입 location), 리다이렉트(3xx/meta-refresh), 서브프레임 네비를 모두 차단.
    expect(f.fireNav('will-navigate')).toBe(true)
    expect(f.fireNav('will-redirect')).toBe(true)
    expect(f.fireNav('will-frame-navigate')).toBe(true)
  })
})

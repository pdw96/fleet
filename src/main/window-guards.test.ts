import { describe, expect, it, vi } from 'vitest'
import { installNavigationGuards, type GuardableWebContents } from './window-guards'

/** webContents 의 가드 관련 표면만 흉내내는 페이크 — 설치된 핸들러를 캡처해 호출을 시뮬레이트한다. */
function fakeWebContents() {
  let windowOpenHandler: ((d: { url: string }) => { action: 'deny' | 'allow' }) | undefined
  const navListeners: Array<(e: { preventDefault: () => void }, url: string) => void> = []
  const wc: GuardableWebContents = {
    setWindowOpenHandler: (h) => {
      windowOpenHandler = h
    },
    on: (event, listener) => {
      if (event === 'will-navigate') navListeners.push(listener)
      return wc
    },
  }
  return {
    wc,
    /** window.open / target=_blank / 새 창 요청 시 main 이 부르는 핸들러의 응답. */
    requestOpen: (url: string) => windowOpenHandler?.({ url }),
    /** 페이지발 네비게이션 발생 시뮬레이트 → preventDefault 호출 여부 반환. */
    navigateTo: (url: string) => {
      const preventDefault = vi.fn()
      for (const l of navListeners) l({ preventDefault }, url)
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

  it('blocks page-initiated navigation — dropped file://, external links, injected location changes', () => {
    const f = fakeWebContents()
    installNavigationGuards(f.wc)
    expect(f.navigateTo('file:///C:/Users/secret.txt')).toBe(true) // 드롭된 파일 네비 차단
    expect(f.navigateTo('https://evil.example/phish')).toBe(true) // 외부 링크/주입 네비 차단
  })
})

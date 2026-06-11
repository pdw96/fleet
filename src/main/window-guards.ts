/**
 * 윈도우 네비게이션 하드닝 — Electron 비의존(webContents 유사 객체만 받는다)이라 헤드리스로 검증 가능.
 *
 * Fleet 은 단일 창 SPA 다: 외부 창을 열거나 다른 문서로 네비게이트하는 정상 경로가 없다. 따라서
 * (1) 모든 새 창/window.open 을 거부하고, (2) 페이지발 네비게이션을 전부 차단한다 — 워크스페이스로
 * 드롭된 file:// 로의 네비게이션, 외부 링크, LLM 출력이 주입했을 수 있는 location 변경을 막는 안전 가드다.
 * 최초 loadURL/loadFile 와 in-page 해시 변경은 will-navigate 를 발생시키지 않으므로 정상 동작은 불변.
 */

export interface WindowOpenHandlerResponse {
  action: 'deny' | 'allow'
}

/** installNavigationGuards 가 필요로 하는 webContents 의 최소 표면(실제 Electron.WebContents 가 구조적으로 만족). */
export interface GuardableWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResponse): void
  on(event: 'will-navigate', listener: (event: { preventDefault: () => void }, url: string) => void): unknown
}

export function installNavigationGuards(wc: GuardableWebContents): void {
  // 새 창/window.open/target=_blank 전부 거부 — 외부 창을 여는 정상 경로가 없다.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 페이지발 네비게이션 차단 — 드롭된 file://, 외부 링크, 주입된 location 변경을 모두 막는다.
  wc.on('will-navigate', (event) => event.preventDefault())
}

/**
 * 윈도우 네비게이션 하드닝 — Electron 비의존(webContents 유사 객체만 받는다)이라 헤드리스로 검증 가능.
 *
 * Fleet 은 단일 창 SPA 다: 외부 창을 열거나 다른 문서로 네비게이트하는 정상 경로가 없다. 따라서
 * (1) 모든 새 창/window.open 을 거부하고, (2) 페이지발 네비게이션을 `will-navigate`·`will-redirect`·
 * `will-frame-navigate` 세 채널 모두에서 차단한다 — 워크스페이스로 드롭된 file://(메인 프레임 네비),
 * 리다이렉트 체인(HTTP 3xx/meta-refresh, `will-navigate` 미발화 → 별도 차단 필요), 서브프레임 네비,
 * 외부 링크, LLM 출력이 주입했을 수 있는 location 변경을 빠짐없이 막는 안전 가드다.
 * 최초 loadURL/loadFile 와 in-page 해시 변경은 이 이벤트들을 발생시키지 않으므로 정상 동작은 불변(프로덕션 e2e 로 확인).
 */

export interface WindowOpenHandlerResponse {
  action: 'deny' | 'allow'
}

/** preventDefault 만 사용하는 네비게이션 이벤트 리스너 — url 등 추가 인자는 무시한다(무조건 차단이라 불필요). */
type NavigationListener = (event: { preventDefault: () => void }) => void

/** installNavigationGuards 가 필요로 하는 webContents 의 최소 표면(실제 Electron.WebContents 가 구조적으로 만족). */
export interface GuardableWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResponse): void
  on(event: 'will-navigate', listener: NavigationListener): unknown
  on(event: 'will-redirect', listener: NavigationListener): unknown
  on(event: 'will-frame-navigate', listener: NavigationListener): unknown
}

export function installNavigationGuards(wc: GuardableWebContents): void {
  // 새 창/window.open/target=_blank 전부 거부 — 외부 창을 여는 정상 경로가 없다.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 페이지발 네비게이션을 세 채널 모두에서 차단(드롭 file://·리다이렉트·서브프레임·외부 링크·주입 location).
  const block: NavigationListener = (event) => event.preventDefault()
  wc.on('will-navigate', block)
  wc.on('will-redirect', block)
  wc.on('will-frame-navigate', block)
}

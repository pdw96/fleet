/**
 * 권한 하드닝 — Electron 비의존(권한 setter 를 가진 Session 유사 객체만 받는다)이라 헤드리스로 검증 가능.
 *
 * Fleet 은 단일 로컬 SPA 다: 카메라·마이크·지오로케이션·알림·클립보드·WebUSB/Bluetooth/Serial 장치 접근의
 * 정상 경로가 없다. LLM 출력이 렌더러로 주입되는 신뢰경계 앱이므로, 주입된 스크립트가 권한 API 를 호출하는
 * 경로를 deny-by-default 로 막는다 — window-guards.ts(네비게이션 전부 거부)와 동일한 심층방어를 session 축에서.
 * 세 핸들러(요청/조회/장치) 전부 무조건 거부한다(allowlist 없음 — 현재 정상 경로로 필요한 웹 권한이 0).
 */

/** installPermissionGuards 가 필요로 하는 Electron Session 의 최소 표면(실제 Electron.Session 이 구조적으로 만족). */
export interface GuardableSession {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void
  setDevicePermissionHandler(handler: (details: unknown) => boolean): void
}

export function installPermissionGuards(session: GuardableSession): void {
  // 비동기 권한 요청(미디어·지오·알림·클립보드 등) 전부 거부 — 정상 경로가 없는 로컬 SPA.
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  // 동기 권한 조회(navigator.permissions.query·getUserMedia 프리플라이트) 전부 거부 — 일관되게 denied 보고.
  session.setPermissionCheckHandler(() => false)
  // WebUSB / Bluetooth / Serial 장치 선택 전부 거부.
  session.setDevicePermissionHandler(() => false)
}

/**
 * 권한 하드닝 — Electron 비의존(권한 setter 를 가진 Session 유사 객체만 받는다)이라 헤드리스로 검증 가능.
 *
 * Fleet 은 단일 로컬 SPA 다: 카메라·마이크·지오로케이션·알림·클립보드·WebUSB/Serial/HID 장치 접근의
 * 정상 경로가 없다. LLM 출력이 렌더러로 주입되는 신뢰경계 앱이므로, 주입된 스크립트가 권한 API 를 호출하는
 * 경로를 deny-by-default 로 막는다 — window-guards.ts(네비게이션 전부 거부)와 동일한 심층방어를 session 축에서.
 * 세 핸들러(요청/조회/장치) 전부 무조건 거부한다(allowlist 없음 — 현재 정상 경로로 필요한 웹 권한이 0).
 *
 * 범위 주의: Web Bluetooth(navigator.bluetooth)는 이 세 핸들러가 아니라 webContents 의
 * `select-bluetooth-device` 이벤트로 게이트된다(setDevicePermissionHandler 의 deviceType 은 hid/serial/usb
 * 한정, setPermissionRequestHandler/CheckHandler 권한 열거에도 bluetooth 없음). 이 모듈은 BT 를 능동 거부하지
 * 않으며, 리스너 미부착 시 Electron 이 모든 BT 요청을 취소(거부)하는 기본동작에 의존한다 — Fleet 에 BT 정상
 * 경로가 없어 별도 select-bluetooth-device 핸들러는 비범위(중복). 명시 거부가 필요해지면 webContents 축에 추가.
 */

/** installPermissionGuards 가 필요로 하는 Electron Session 의 최소 표면(실제 Electron.Session 이 구조적으로 만족). */
export interface GuardableSession {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void
  setDevicePermissionHandler(handler: (details: unknown) => boolean): void
}

export function installPermissionGuards(session: GuardableSession): void {
  // 비동기 권한 요청(미디어·지오·알림·클립보드 등) 전부 거부 — 정상 경로가 없는 로컬 SPA.
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  // 동기 권한 조회(navigator.permissions.query·getUserMedia 프리플라이트) 전부 거부 — 일관되게 denied 보고.
  session.setPermissionCheckHandler(() => false)
  // WebUSB / Serial / HID 장치 선택 전부 거부 (deviceType=usb/serial/hid). Web Bluetooth 는 미경유 — 위 범위 주의 참조.
  session.setDevicePermissionHandler(() => false)
}

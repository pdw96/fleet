import { describe, expect, it } from 'vitest'
import { installPermissionGuards, type GuardableSession } from './permission-guards'

/** Electron Session 의 권한 setter 만 흉내내는 페이크 — 설치된 핸들러를 캡처해 호출을 시뮬레이트한다. */
function fakeSession() {
  let requestHandler:
    | ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void)
    | undefined
  let checkHandler: ((wc: unknown, permission: string) => boolean) | undefined
  let deviceHandler: ((details: unknown) => boolean) | undefined
  const session: GuardableSession = {
    setPermissionRequestHandler: (h) => {
      requestHandler = h
    },
    setPermissionCheckHandler: (h) => {
      checkHandler = h
    },
    setDevicePermissionHandler: (h) => {
      deviceHandler = h
    },
  }
  return {
    session,
    /** 비동기 권한 요청 시뮬레이트 → 핸들러가 callback 으로 넘긴 boolean 반환. */
    requestPermission: (permission: string) => {
      let granted: boolean | undefined
      requestHandler?.(null, permission, (g) => {
        granted = g
      })
      return granted
    },
    /** 동기 권한 조회 시뮬레이트 → 반환 boolean. */
    checkPermission: (permission: string) => checkHandler?.(null, permission),
    /** 장치 선택 시뮬레이트 → 반환 boolean. */
    requestDevice: () => deviceHandler?.({}),
  }
}

describe('installPermissionGuards', () => {
  it('denies every async permission request (media / geolocation / notifications / clipboard)', () => {
    const f = fakeSession()
    installPermissionGuards(f.session)
    expect(f.requestPermission('media')).toBe(false)
    expect(f.requestPermission('geolocation')).toBe(false)
    expect(f.requestPermission('notifications')).toBe(false)
    expect(f.requestPermission('clipboard-read')).toBe(false)
  })

  it('denies every synchronous permission check (navigator.permissions.query / getUserMedia preflight)', () => {
    const f = fakeSession()
    installPermissionGuards(f.session)
    expect(f.checkPermission('media')).toBe(false)
    expect(f.checkPermission('geolocation')).toBe(false)
  })

  it('denies every device permission request (WebUSB / Bluetooth / Serial)', () => {
    const f = fakeSession()
    installPermissionGuards(f.session)
    expect(f.requestDevice()).toBe(false)
  })
})

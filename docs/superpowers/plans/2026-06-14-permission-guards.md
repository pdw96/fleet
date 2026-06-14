# deny-by-default 권한 가드 (permission-handler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Electron `Session` 에 deny-by-default 권한 핸들러 3종(request/check/device)을 설치해, 정상 경로가 없는 로컬 SPA 의 웹 권한(미디어·지오·알림·클립보드·WebUSB/BT/Serial) 자동 승인 갭을 막는다.

**Architecture:** `window-guards.ts`(네비게이션 하드닝) 패턴 정확 미러 — Electron 비의존 순수 모듈 `permission-guards.ts` 가 최소 `GuardableSession` 인터페이스만 받아 세 핸들러를 무조건 거부로 설치. `index.ts createWindow` 한 줄 배선. 페이크 단위검증 + 실 Electron e2e 스모크. IPC/preload/렌더러 무변경.

**Tech Stack:** TypeScript, Electron(Session API), Vitest(단위), Playwright `_electron`(e2e).

**Spec:** `docs/superpowers/specs/2026-06-14-permission-guards-design.md`

---

## File Structure

- **Create** `src/main/permission-guards.ts` — `GuardableSession` 인터페이스 + `installPermissionGuards(session)`. 한 책임: Session 에 deny-by-default 권한 핸들러 설치.
- **Create** `src/main/permission-guards.test.ts` — 페이크 session 으로 세 핸들러 거부 단위검증.
- **Modify** `src/main/index.ts` — import 1줄 + `createWindow` 배선 1줄.
- **Modify** `e2e/window-hardening.e2e.ts` — docstring 갱신 + 권한 프로브 2개(geolocation 요청/조회).

---

## Task 1: `permission-guards.ts` 순수 모듈 + 단위검증 (TDD)

**Files:**
- Create: `src/main/permission-guards.ts`
- Test: `src/main/permission-guards.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/main/permission-guards.test.ts` 신설. `window-guards.test.ts` 의 페이크 패턴을 복제 — 설치된 핸들러를 캡처해 호출을 시뮬레이트한다.

```ts
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/permission-guards.test.ts`
Expected: FAIL — `Failed to resolve import "./permission-guards"` (모듈 미존재).

- [ ] **Step 3: 최소 구현 작성**

`src/main/permission-guards.ts` 신설. `window-guards.ts` 의 헤더 주석 스타일을 따른다.

```ts
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/permission-guards.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add src/main/permission-guards.ts src/main/permission-guards.test.ts
git commit -m "feat(security): deny-by-default 권한 가드 순수 모듈 + 단위검증 (#27 permission-handler)"
```

---

## Task 2: `index.ts` 배선

**Files:**
- Modify: `src/main/index.ts` (import 블록 + `createWindow` `:150` 직후)

- [ ] **Step 1: import 추가**

`src/main/index.ts:17` 의 `import { installNavigationGuards } from './window-guards'` **바로 아래**에 추가:

```ts
import { installPermissionGuards } from './permission-guards'
```

- [ ] **Step 2: createWindow 배선**

`src/main/index.ts` `createWindow` 의 `installNavigationGuards(win.webContents)` (`:150`) **바로 아래**에 추가:

```ts
  // 권한 하드닝: 카메라·마이크·지오·알림·클립보드·WebUSB/BT/Serial 전부 거부(정상 경로 없는 로컬 SPA). 계약은 permission-guards.ts 참조.
  installPermissionGuards(win.webContents.session)
```

배선 후 해당 구간은 다음과 같다:

```ts
  // 네비게이션 하드닝: 새 창/window.open 거부 + 모든 페이지발 네비게이션(드롭 file://·리다이렉트·
  // 서브프레임·외부 링크·주입 location) 차단(안전 우선). 상세 계약은 window-guards.ts 참조.
  installNavigationGuards(win.webContents)

  // 권한 하드닝: 카메라·마이크·지오·알림·클립보드·WebUSB/BT/Serial 전부 거부(정상 경로 없는 로컬 SPA). 계약은 permission-guards.ts 참조.
  installPermissionGuards(win.webContents.session)

  win.on('ready-to-show', () => win.show())
```

- [ ] **Step 3: typecheck 통과 확인 (실 Electron Session → GuardableSession 구조 적합성)**

Run: `npm run typecheck`
Expected: PASS — 에러 0. (실 Electron `Session` 이 `GuardableSession` 을 구조적으로 만족함을 컴파일 타임에 확정. 실패 시 `GuardableSession` 시그니처를 실 Electron 타입에 맞춰 조정.)

- [ ] **Step 4: 커밋**

```bash
git add src/main/index.ts
git commit -m "feat(security): createWindow 에 권한 가드 배선 (#27 permission-handler)"
```

---

## Task 3: e2e 권한 프로브 (window-hardening 확장)

**Files:**
- Modify: `e2e/window-hardening.e2e.ts` (docstring + 테스트 2개 추가)

- [ ] **Step 1: docstring 갱신**

`e2e/window-hardening.e2e.ts:6-10` 의 블록 주석을 네비게이션+권한 양쪽으로 갱신. 기존:

```ts
/**
 * 회귀 가드: 윈도우 네비게이션 하드닝(installNavigationGuards)이 실제 Electron 에서 발화하는지 검증한다.
 * 단위 테스트는 페이크 webContents 로 헬퍼 배선만 증명하므로, 실 WebContents 가 setWindowOpenHandler 를
 * 존중하고 페이지발 네비게이션을 실제로 차단하는지는 빌드된 앱을 띄워 확인해야 한다(로드맵 '수동 기동 검증'의 자동화).
 */
```

을 다음으로 교체:

```ts
/**
 * 회귀 가드: 윈도우 하드닝(installNavigationGuards 네비게이션 + installPermissionGuards 권한)이 실제
 * Electron 에서 발화하는지 검증한다. 단위 테스트는 페이크 webContents/session 으로 헬퍼 배선만 증명하므로,
 * 실 WebContents 가 setWindowOpenHandler 를 존중하고 페이지발 네비게이션을 차단하는지, 실 Session 이
 * 권한 요청/조회를 거부하는지는 빌드된 앱을 띄워 확인해야 한다(로드맵 '수동 기동 검증'의 자동화).
 */
```

- [ ] **Step 2: 권한 프로브 테스트 2개 추가 (실패 가능성 확인 = 실 Electron 발화)**

`e2e/window-hardening.e2e.ts` 파일 끝(마지막 `test(...)` 블록 뒤)에 추가:

```ts
test('지오로케이션 권한 요청을 거부한다 (setPermissionRequestHandler deny)', async () => {
  // 권한 핸들러가 deny 면 getCurrentPosition 은 PERMISSION_DENIED(code 1) error 콜백으로 즉시 실패한다.
  const code = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => resolve(0), // 성공 = 가드 누락
          (err) => resolve(err.code), // 1 === PERMISSION_DENIED
        )
      }),
  )
  expect(code).toBe(1)
})

test('지오로케이션 권한 조회가 denied 다 (setPermissionCheckHandler deny)', async () => {
  const state = await page.evaluate(() => navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state))
  expect(state).toBe('denied')
})
```

- [ ] **Step 3: 빌드 확인 (e2e 는 `out/` 의 빌드 산출물을 띄움)**

Run: `npm run build`
Expected: PASS — typecheck + electron-vite 빌드 성공. (e2e 자체는 4게이트 밖이라 CI/로컬 수동 실행. 빌드가 그린이면 배선이 `out/main/index.js` 에 반영됨.)

- [ ] **Step 4: 커밋**

```bash
git add e2e/window-hardening.e2e.ts
git commit -m "test(e2e): window-hardening 에 권한 거부 프로브 2개 추가 (#27 permission-handler)"
```

---

## Task 4: 4 게이트 전체 검증

**Files:** 없음(검증 전용)

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: PASS — 에러 0.

- [ ] **Step 2: lint (경고 0)**

Run: `npm run lint`
Expected: PASS — 경고 0.

- [ ] **Step 3: 전체 테스트**

Run: `npm test`
Expected: PASS — 기존 + 신규 3 테스트 그린. (메모리상 직전 베이스라인 test 647 → permission-guards 3 추가로 650 전후.)

- [ ] **Step 4: build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: (게이트 통과 시 추가 커밋 없음 — 코드 변경 없이 검증만)**

게이트가 전부 그린이면 구현 완료. 실패 시 해당 Task 로 돌아가 수정.

---

## Self-Review 결과 (작성자 점검)

- **Spec coverage**: ① `permission-guards.ts`/`GuardableSession`/`installPermissionGuards`(세 핸들러 deny) = Task 1 ✅. ② `index.ts` 배선 = Task 2 ✅. ③ window-hardening e2e 확장(docstring+프로브) = Task 3 ✅. ④ 4게이트 = Task 4 ✅. 갭 0.
- **Placeholder scan**: TBD/TODO/"적절히 처리" 0건. 모든 코드 스텝에 완전한 코드 블록.
- **Type consistency**: `GuardableSession`(Task 1 정의) ↔ `installPermissionGuards(win.webContents.session)`(Task 2 사용) 시그니처 일치. 페이크 setter 명(`setPermissionRequestHandler`/`setPermissionCheckHandler`/`setDevicePermissionHandler`)이 인터페이스·구현·실 Electron API 명과 동일.

## 비범위 (스펙 재확인)

- 권한 allowlist(YAGNI), CSP/`@electron/fuses`/`senderFrame` IPC 게이트(별도 보안 하위트랙), Electron 33→42(packaging 종속) — 전부 후속.

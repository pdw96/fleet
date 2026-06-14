# 설계: deny-by-default 권한 가드 (permission-handler)

- 날짜: 2026-06-14
- 출처: GitHub 이슈 #27 백로그(🟡 Next · 랭크6 `permission-handler`, 가치3·노력1·리스크1).
  6차 재랭킹이 식별: `src/main` 전체에 `setPermissionRequestHandler`/`setPermissionCheckHandler` grep
  **0건** → `createWindow` 는 `webPreferences`(contextIsolation·sandbox)만 하드닝하고 웹 권한은
  **Electron 기본(자동 승인 위임)**에 맡겨져 있다. LLM 출력이 렌더러로 주입되는 신뢰경계 앱의 심층방어 갭.
- 범위(이 슬라이스): **Electron 메인 프로세스 단독**. Fleet 의 Electron `Session` 에 deny-by-default 권한
  핸들러 3종(`setPermissionRequestHandler`·`setPermissionCheckHandler`·`setDevicePermissionHandler`)을
  설치한다. 신규 순수 모듈 `window-guards.ts` 형제(`permission-guards.ts`) + `index.ts` 한 줄 배선.
- 착지 방식: `window-guards.ts`(네비게이션 하드닝) 패턴 **정확 미러** — Electron 비의존 순수 함수(최소
  `GuardableSession` 인터페이스만 수령) → 페이크로 헤드리스 단위검증 + 실 Electron e2e 스모크.

> **IPC/preload/렌더러 계약 불변.** 권한 핸들러는 메인 프로세스 `Session` 레벨 설정으로, shared 타입·
> preload 브릿지·렌더러 어디에도 닿지 않는다. preload 재시작 함정·검은 화면 리스크 없음.

## 배경 / 문제 (코드 검증)

`src/main/index.ts:133-160` `createWindow` 는 다음만 하드닝한다:

- `webPreferences`: `contextIsolation:true` + `sandbox:true` (`:140-145`).
- `installNavigationGuards(win.webContents)` (`:150`) — 네비게이션을 **webContents 축**에서 차단.

하지만 **웹 권한 축은 무방비**다. Electron 은 `Session` 에 권한 핸들러가 미설정이면 다수 권한을 기본
승인하거나 Chromium 기본 동작에 위임한다. Fleet 은 단일 로컬 SPA(채팅·프로젝트·승인 모달)로 카메라·
마이크·지오로케이션·알림·클립보드·WebUSB/Bluetooth/Serial 장치 접근의 **정상 경로가 없다**. LLM 출력이
렌더러에 주입되는 신뢰경계 앱이므로, 주입된 스크립트가 권한 API 를 호출하는 경로를 deny-by-default 로
막는 것이 `installNavigationGuards`(전부 거부)와 동일한 심층방어다.

### 왜 별도 모듈인가 (격리)

`window-guards.ts` 는 **webContents 축**(네비게이션)을 다루고 `GuardableWebContents` 인터페이스를 받는다.
권한은 **session 축**(웹 파티션 전역)이라 다른 객체(`Session`)·다른 메서드 집합을 받는다. 두 관심사를
한 함수에 섞으면 인터페이스가 혼탁해지므로 형제 모듈로 격리한다 — 단, **`-guards` 접미사 컨벤션**(="보안
deny 설치기")은 유지해 `window-guards` 와 한 family 임을 시그널한다.

> 네이밍: `permission-guards.ts`(채택) — `-guards` family 유지 + 관심사 정확. `window-permissions` 는
> 핸들러가 session 전역이라 `window-` 접두가 부정확하고 `-guards` 시그널을 잃어 기각. `session-guards` 는
> "session" 이 Fleet 의 LLM-세션 어휘(SessionManager·CLI/API 세션·Store sessions)와 충돌해 기각.

## 계약 — `src/main/permission-guards.ts` (신규)

```ts
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

**불변식:**
- 세 핸들러 전부 **무조건 거부**(allowlist 없음 — YAGNI, `installNavigationGuards` 의 무조건 차단과 동형).
  현재 앱이 정상 경로로 요구하는 웹 권한이 0이라 deny=동작 불변.
- `GuardableWebContents`(window-guards) 와 동일 전략: 핸들러는 인자를 **무시**(무조건 거부라 불필요)하고,
  실 Electron `Session` 이 `GuardableSession` 을 **구조적으로 만족**(메서드 bivariance) → typecheck 게이트로 확인.
- 메서드 시그니처에 `unknown` 사용 — Electron 타입 의존 없이 컴파일, 핸들러 내부는 값을 안 읽음.

## 배선 — `src/main/index.ts`

`createWindow` 에서 `installNavigationGuards(win.webContents)` **직후** 한 줄 추가:

```ts
import { installPermissionGuards } from './permission-guards'
// ...
installNavigationGuards(win.webContents)
// 권한 하드닝: 카메라·마이크·지오·알림·클립보드·WebUSB/BT/Serial 전부 거부(정상 경로 없는 로컬 SPA).
installPermissionGuards(win.webContents.session)
```

- 앱이 기본 partition 을 쓰므로(`webPreferences` 에 `partition` 미지정) `win.webContents.session ===
  session.defaultSession`. webContents 별 호출이라 기존 `installNavigationGuards` 호출부와 대칭.
- 핸들러는 session 전역이라 다창이어도 1회 설치로 충분하나, 현 앱은 단일 창(`activate` 시 재생성도 동일
  defaultSession) — 동일 핸들러 재설정은 멱등(덮어쓰기)이라 무해.

## TDD 계획 (메인 변경엔 *.test.ts 동반 — AGENTS.md)

`window-guards.test.ts` 의 페이크 패턴 복제 → `permission-guards.test.ts`:

- **페이크 session**: 세 setter 를 받아 설치된 핸들러를 캡처. `requestPermission(permission)` →
  `callback` 으로 전달된 boolean 반환, `checkPermission(...)`·`requestDevice(...)` → 반환 boolean.
- **단언**:
  - `installPermissionGuards` 후 임의 권한 요청(`'media'`·`'geolocation'`·`'notifications'`) → 전부 `false`(거부).
  - 권한 조회(`'media'` 등) → `false`.
  - 장치 요청 → `false`.
- **e2e**(`e2e/window-hardening.e2e.ts` **확장** — 신규 파일 부팅세 회피, 같은 앱 재사용): docstring 을
  "윈도우 하드닝(네비게이션 + 권한)" 으로 갱신 + 권한 프로브 추가 —
  - `navigator.geolocation.getCurrentPosition(ok, err)` → `err.code === 1`(PERMISSION_DENIED) [요청 핸들러].
  - `navigator.permissions.query({ name: 'geolocation' })` → `state === 'denied'` [조회 핸들러].
  - (장치 핸들러는 사용자 제스처/WebUSB 필요로 e2e 프로브가 불안정 → 단위테스트가 커버, e2e 생략.)
- **4 게이트**(AGENTS.md): `npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build`.

## 영향 파일

- `src/main/permission-guards.ts` — **신규**. `GuardableSession` + `installPermissionGuards`.
- `src/main/permission-guards.test.ts` — **신규**. 페이크 session 단위검증.
- `src/main/index.ts` — import 1줄 + `createWindow` 배선 1줄.
- `e2e/window-hardening.e2e.ts` — docstring 갱신 + 권한 프로브 2개.

## 비범위 (YAGNI / 후속)

- **권한 allowlist** — 현재 정상 경로로 필요한 웹 권한이 0이라 무조건 거부로 충분. 미래에 특정 권한이
  필요해지면 그때 파라미터화(현 시점 도입은 사용처 없는 추상화).
- **CSP(`onHeadersReceived`) · `@electron/fuses` · `senderFrame` IPC 게이트** — 이슈 #27 의 별도 보안
  하위트랙(electron-csp-fuses-senderframe, Later). 권장 시퀀싱상 후속 1 PR 로 묶을 수 있으나 이 슬라이스는
  권한 핸들러 단독으로 독립 착지.
- **Electron 33→42 업그레이드** — packaging-pipeline 하류 종속(이슈 #27), 별개 트랙.

## 라이브 검증 사항

- 단위 테스트가 핸들러 배선·거부를 격리 증명. e2e 가 실 Electron `Session` 에서 요청/조회 핸들러가 실제
  발화함을 스모크. 장치 핸들러는 단위테스트로만 커버(WebUSB e2e 불안정).
- typecheck 게이트가 실 Electron `Session` → `GuardableSession` 구조 적합성을 컴파일 타임 확정.

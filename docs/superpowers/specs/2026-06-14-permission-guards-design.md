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
  // WebUSB / Serial / HID 장치 선택 전부 거부 (deviceType=usb/serial/hid). Web Bluetooth 미경유 — 아래 '적대 리뷰 반영' 참조.
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
- **명시 `select-bluetooth-device` 거부** — Web Bluetooth 는 이 세 핸들러가 아니라 webContents 의 별도
  이벤트로 게이트되고, Fleet 에 BT 정상 경로가 없어 Electron 무리스너 기본동작(전부 취소=거부)이 이미 막는다.
  명시 핸들러는 그 기본동작과 중복이고 session 축 모듈을 webContents 축에 결합 → 비범위. 필요해지면 webContents
  축(window-guards 인근)에 1줄 추가. (적대 리뷰 #1 반영 — 아래 참조.)
- **CSP(`onHeadersReceived`) · `@electron/fuses` · `senderFrame` IPC 게이트** — 이슈 #27 의 별도 보안
  하위트랙(electron-csp-fuses-senderframe, Later). 권장 시퀀싱상 후속 1 PR 로 묶을 수 있으나 이 슬라이스는
  권한 핸들러 단독으로 독립 착지.
- **Electron 33→42 업그레이드** — packaging-pipeline 하류 종속(이슈 #27), 별개 트랙.

## 적대 리뷰 반영 (23 에이전트 · 5차원 × 3렌즈, 2026-06-14)

원시 6 → **확정 3 / 기각 3**(전건 코드·Electron 1차문서 대조). 확정 3건 전부 런타임 영향 0(low/nit):

- **#1 (low, 3/3) — 'Bluetooth 거부' 문구 부정확**: `setDevicePermissionHandler` 의 deviceType 은
  hid/serial/usb 한정이고 권한 열거에 bluetooth 없음 → 세 핸들러는 Web Bluetooth 를 게이트하지 않는다(유일
  게이트는 webContents `select-bluetooth-device`). 런타임은 Electron 무리스너 기본동작이 BT 를 취소해 안전하나
  주석/테스트명이 능동거부를 과장. **반영**: 검증자 3/3 권장안(Option 2 — 문구 정정·기본동작 의존 명시)을 채택,
  명시 BT 핸들러(Option 1)는 중복·축결합으로 비범위 처리. `permission-guards.ts` docstring·device 주석,
  `index.ts` 배선 주석, 테스트명을 'WebUSB/Serial/HID' 로 정정 + BT 범위 주의 추가.
- **#2 (low/nit/n/a, 2/3) — device 핸들러 e2e 부재**: 제안된 e2e 프로브는 3번째 검증자가 반증
  (`navigator.usb.requestDevice` 는 user-gesture 요구로 핸들러 도달 전 SecurityError → 거짓신뢰 테스트;
  `permissions.query({name:'usb'})` 는 Chromium PermissionName enum 비유효로 TypeError). **반영**: 플레이키
  프로브를 추가하지 않고, e2e docstring 에 '장치 축은 단위테스트 전용(헤드리스 e2e 불안정·무효)'을 명시해 갭 표면화.
- **#3 (nit, 3/3) — 무조건거부 불변식 미단언**: 알려진 4문자열만 검증, 임의/미지 문자열 케이스 부재 →
  부분 allowlist 도입 회귀를 못 잡음. **반영**: request/check 테스트에 `'any-future-permission'`·`'totally-unknown'`
  거부 단언 추가(프로덕션 무변경, 불변식 앵커).

**기각 3건**: device 단위테스트 '동어반복'(1/3 — 프로덕션 배선 검증하는 정당 스모크), 무회귀 단언(1/3 —
결함 아닌 *입증된 무회귀*, 권한-게이트 Web API 정상 사용 0건), geolocation 프로브 '원인 구분 잠재'(0/3 —
거부가 측위 전 동기 발화라 code 1 결정론적).

## 라이브 검증 사항

- 단위 테스트가 핸들러 배선·거부를 격리 증명. e2e 가 실 Electron `Session` 에서 요청/조회 핸들러가 실제
  발화함을 스모크. 장치 핸들러는 단위테스트로만 커버(WebUSB e2e 불안정).
- typecheck 게이트가 실 Electron `Session` → `GuardableSession` 구조 적합성을 컴파일 타임 확정.

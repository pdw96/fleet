# 이슈 #74 후속(PR2) — electron-updater autoUpdater 도입 (notify·user-controlled) 설계

- **날짜**: 2026-06-20
- **대상**: GitHub 이슈 #74 `후속(배포): Electron 패키징 파이프라인 (builder/forge·autoUpdater·코드서명)` (pdw96/fleet, `area:electron` `tier:later`) 의 **후속 슬라이스 PR2**
- **유형**: 빌드/배포 + 런타임 배선 (앱 코어 로직 무변경 · main 프로세스에 업데이트 모듈 1개 + IPC 1네임스페이스 + 렌더러 배너 1개 추가)
- **브랜치**: `feat/electron-autoupdater`
- **상위 트랙**: #74(packaging) → #75(toolchain bump) → #76(electron major). 본 PR은 #74 의 **PR1(#93) 이후 autoUpdater 슬라이스**.

## 배경 / 문제

#74 PR1(PR #93, squash `6084874`)이 unsigned **Windows NSIS + Linux AppImage** 산출 + 태그 기반 GitHub Release CI(prepare→build→release 3-잡)를 출하했고, `electron-builder.yml` 의 `publish: github` 가 릴리스마다 `latest.yml`/`latest-linux.yml` 업데이트 메타데이터를 생성한다(autoUpdater forward-compat). 그러나 **앱에는 그 피드를 소비하는 자동 업데이트 경로가 전혀 없다** — `src` 전체에 `autoUpdater`/`electron-updater` 사용 0건(grep 검증). 즉 새 릴리스를 게시해도 기존 설치 사용자는 수동 재설치해야만 갱신된다.

10차 백로그 큐레이션(#27)에서 사용자가 "Fleet 실배포 의향 O" 를 확정 → 배포 채널(PR1) 위에 **자동 업데이트가 출하 트랙의 다음 가치 슬라이스**다. autoUpdater 가 있어야 #76 Electron 메이저 업그레이드의 보안(EOL/CVE) 페이로드도 비로소 사용자에게 **무마찰 도달**한다.

#74 의 잔여 후속 4종(autoUpdater · macOS DMG+notarization · 코드서명 · 커스텀 아이콘) 중 **autoUpdater 만이 유료 인증서·Mac 하드웨어 종속 없이 즉시 구현 가능**하다(나머지는 유료 인증서/Mac 러너에 막힘). PR1 설계문서 §"범위 외 — 후속 PR — 시퀀싱" 1번이 명시한 그 항목이다.

## 검증 출처 (cross-verification 규율)

AGENTS.md 「리뷰 피드백 교차검증」 + context7 규칙에 따라 현행 문서로 양면 검증:

- **context7 — electron-builder/electron-updater(`/electron-userland/electron-builder`)**:
  - autoUpdater 는 `electron-updater` 패키지에서 import(`import electronUpdater from 'electron-updater'` — CJS interop 때문에 destructure 권장, issue #7976). GitHub provider 는 `publish: github` 설정으로 동작.
  - 이벤트: `error`·`checking-for-update`·`update-available`·`update-not-available`·`download-progress`·`update-downloaded`. `autoDownload=true` 면 available 직후 자동 다운로드.
  - **packaging 사실(crux)**: "`package.json` and `node_modules/**/*` (production only) are always included regardless of `files` patterns." → `files: [out/**, package.json]` 인 현 설정에서도 **production `dependencies` 는 자동으로 asar 에 포함**. 따라서 `electron-updater` 를 prod dependency 로만 추가하면 패키징됨. "Cannot find module" 트러블슈팅 항목: 반드시 `dependencies`(not devDependencies)에 둘 것.
  - **AppImage**: 실 AppImage 런치 시 `APPIMAGE` env 자동 설정(미설정 환경은 워크어라운드 필요). AppImage auto-update 지원.
  - **dev 가드**: `dev-app-update.yml` 부재 시 dev 에서 동작 안 함(`forceDevUpdateConfig` 로만 강제). 패키지드(`app.isPackaged`)에서만 정상.
- **실제 레포 대조**:
  - `src/main/index.ts`: `app.whenReady()` → `buildEngine` → `registerIpc` → `installChildProcessObserver` → `will-quit`(preventDefault→`engine.dispose()`→re-quit, 3s 백스톱) → `createWindow()`. autoUpdater 무장 지점 = `createWindow()` 직후.
  - **`install*(deps)` 모듈 패턴 존재**: `crash-recovery.ts`(`installCrashRecovery(webContents, {isShuttingDown})`)·`window-guards.ts`·`permission-guards.ts` 모두 의존성 주입형 + 페이크로 유닛 테스트. → `auto-update.ts` 도 동일 패턴 채택(electron 비의존 유닛 테스트 가능).
  - **IPC parity 가드**: `ipc-parity.test.ts` 가 preload `invoke`↔main `handle`, preload `on`↔main `webContents.send`↔`removeListener` 채널 집합을 **소스 텍스트 대조로 정확 일치 강제**. 신규 채널은 양쪽에 리터럴로 정확히 추가해야 RED 회피. `FleetBridge`(`shared/types.ts`) 가 preload 메서드 컴파일타임 계약.
  - **렌더러 이벤트 패턴**: `onOrchestratorEvent`/`onChatStream`/`onApprovalRequest` = `ipcRenderer.on` 구독→unsubscribe 반환. `App.tsx` 는 topbar+footer 셸 → 비차단 배너 안착 지점.
  - **권한 가드 무영향**: `permission-guards.ts` 는 렌더러 Web Notifications 거부하나, autoUpdater 이벤트는 main→IPC→인앱 배너라 무관(네이티브 OS 알림 미사용).
  - **electron-vite 번들링**: `electron.vite.config.ts` 에 `externalizeDepsPlugin` 없음 → 기본적으로 deps 를 번들(PR1 이 cross-spawn/safe-regex 번들 확인). `electron-updater` 는 동적 require 가 많아 번들 시 깨짐 → **main 빌드에서 외부화 필수**.

## 결정

| # | 결정 | 근거 |
|---|---|---|
| 1 | **패키지 = electron-updater** (electron-builder 의 표준 페어) | context7 + PR1 설계 §범위외 1. NSIS·AppImage 모두 지원. |
| 2 | **UX = notify + user-controlled** (사용자 승인) | `autoDownload=false`. 기동 시 조용히 체크 → available 시 비차단 배너 → 사용자 [다운로드] → 진행률 → [지금 재시작]/[나중에]. unsigned·pre-1.0·장시간 오케스트레이션 앱에 가장 투명·안전(예기치 않은 재시작 없음). |
| 3 | **prerelease = 허용** (사용자 승인) | `allowPrerelease=true`. 안정 릴리스 0건·앱 전체 pre-1.0 → prerelease 빌드 제공. 안정 1.x 출하 시 재검토. **런타임 노브**(electron-builder.yml 아님). |
| 4 | **모듈 = `auto-update.ts` 의존성 주입형** | 기존 `install*` 패턴 일치 → electron 없이 유닛 테스트. `installAutoUpdate({updater, send, isPackaged, isE2E, logger})`. |
| 5 | **dev/E2E/smoke 가드** | `app.isPackaged` false 또는 `FLEET_E2E==='1'`/`FLEET_SMOKE` 면 네트워크 체크 무장 안 함(`app-update.yml` 부재 throw 회피). 컨트롤러 메서드는 미무장 시 안전 no-op + `unsupported` 회신(렌더러 안전). |
| 5a | **IPC 리터럴은 전부 `index.ts` 에** | `ipc-parity.test.ts` 가 `src/main/index.ts`·`src/preload/index.ts` **소스 텍스트**의 `ipcMain.handle`/`webContents.send` **리터럴**만 추출·대조. → `auto-update.ts` 는 IPC 를 등록하지 않고 컨트롤러(`{check,download,install}`)만 반환, `index.ts` 가 리터럴 채널 3 handle + 1 send 를 소유. (모듈이 채널을 등록하거나 `registerHandler(ch,fn)` 래퍼로 비리터럴 등록하면 parity 테스트의 리터럴-카운트 단언이 RED.) |
| 6 | **패키징 = prod dependency + main 외부화** | `electron-updater` 를 `dependencies`(런타임 로드) + `electron.vite.config.ts` main `rollupOptions.external: ['electron-updater']`(동적 require 보존). electron-builder 가 prod dep 자동 포함(context7 확인) → `electron-builder.yml`/`files` 무변경. |
| 7 | **autoInstallOnAppQuit = 기본(true) 유지** | 사용자가 [다운로드] 로 이미 동의 → [나중에] 선택 시 다음 자연 종료에 적용(기대 일치). [지금] 은 `quitAndInstall()` 즉시. |
| 8 | **아이콘 = 후속 PR** (사용자 승인) | 디자인 자산·`build/` gitignore 결정 래빗홀 회피. PR1 deferral 패턴 유지. |
| 9 | **electron-builder.yml 변경 없음** | 피드(`publish:github`)·`latest*.yml` 메타는 PR1 이 세움. prerelease 는 런타임 노브. |

## 상세 설계 (파일별)

### 1. `package.json` — dependency

```jsonc
// dependencies 추가 (devDependencies 아님 — main 런타임 로드)
"electron-updater": "^6.6.2"   // context7: electron-builder ~26.x 와 페어, 현행 메이저 ~6.x
```

> 버전은 구현 시 설치된 최신 ~6.x 로 핀. electron-builder 가 prod dep 를 자동 포함하므로 `files`/`electron-builder.yml` 무변경.

### 2. `electron.vite.config.ts` — main 외부화

```ts
main: {
  build: {
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/main/index.ts') },
      external: ['electron-updater'],   // 동적 require 보존 — 번들 금지, 런타임 asar node_modules 로드
    },
  },
},
```

> cross-spawn/safe-regex 는 계속 번들(무회귀). `electron-updater` 만 외부화 → rollup 이 그 transitive deps(builder-util-runtime·js-yaml 등)를 추적하지 않고, electron-builder 가 prod dep 로 함께 asar 에 포함.

### 3. `src/shared/types.ts` — 계약

```ts
// 업데이트 이벤트 판별 유니온 (main → 렌더러 브로드캐스트 페이로드)
export type UpdateEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }      // 0–100
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }                     // dev/E2E/비패키지드

// FleetBridge 에 추가
checkForUpdate(): Promise<void>
downloadUpdate(): Promise<void>
installUpdate(): Promise<void>
onUpdateEvent(cb: (e: UpdateEvent) => void): () => void
```

### 4. `src/main/auto-update.ts` (신규) — 의존성 주입형 모듈 (IPC 비등록)

```ts
// 최소 인터페이스(페이크 주입용) — electron-updater 의 AppUpdater 표면 일부
export interface UpdaterPort {
  autoDownload: boolean
  allowPrerelease: boolean
  on(event: string, listener: (...args: unknown[]) => void): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface AutoUpdateDeps {
  updater: UpdaterPort
  send: (e: UpdateEvent) => void          // BrowserWindow 브로드캐스트(index.ts 가 리터럴 send 보유)
  isPackaged: boolean
  isE2E: boolean                          // FLEET_E2E==='1' || FLEET_SMOKE
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

// 컨트롤러 반환 — IPC 는 등록하지 않는다(parity 리터럴은 index.ts 소유, 결정 5a).
export interface UpdateController {
  check(): Promise<void>
  download(): Promise<void>
  install(): void
}

export function installAutoUpdate(deps: AutoUpdateDeps): UpdateController
```

동작:
- **가드**: `!isPackaged || isE2E` → 이벤트 리스너/네트워크 무장 안 함. 반환 컨트롤러의 메서드는 호출 시 안전 no-op + `send({kind:'unsupported'})`(렌더러는 조용히 무시).
- **무장(packaged·non-E2E)**: `updater.autoDownload=false`·`updater.allowPrerelease=true`·`updater.logger` 설정. 이벤트 매핑:
  - `checking-for-update`→`{kind:'checking'}` · `update-available`(info)→`{kind:'available',version}` · `update-not-available`→`{kind:'not-available'}` · `download-progress`(p)→`{kind:'progress',percent}` · `update-downloaded`(info)→`{kind:'downloaded',version}` · `error`(e)→`{kind:'error',message}`.
  - 기동 시 `check()` 1회 자동 호출(에러는 `error` 이벤트로 흡수, throw 안 함).
- **컨트롤러**: `check()`→`checkForUpdates()` · `download()`→`downloadUpdate()` · `install()`→`quitAndInstall()`(모두 미무장 시 no-op+`unsupported`).

### 5. `src/main/index.ts` — 배선 (IPC 리터럴 소유)

```ts
import electronUpdater from 'electron-updater'
import { installAutoUpdate } from './auto-update'

// broadcastOrchestratorEvent 동형 헬퍼 — 리터럴 send (parity send 채널 충족)
function broadcastUpdateEvent(event: UpdateEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:update:event', event)
  }
}

// whenReady 내 createWindow() 직후 — 컨트롤러 생성
const updater = installAutoUpdate({
  updater: electronUpdater.autoUpdater,       // CJS interop: default import 후 .autoUpdater
  send: broadcastUpdateEvent,
  isPackaged: app.isPackaged,
  isE2E: process.env['FLEET_E2E'] === '1' || !!process.env['FLEET_SMOKE'],
  logger: console,
})

// IPC 리터럴 핸들러 — registerIpc 와 같은 파일(index.ts)에 직접 등록(parity, 결정 5a)
ipcMain.handle('fleet:update:check', () => updater.check())
ipcMain.handle('fleet:update:download', () => updater.download())
ipcMain.handle('fleet:update:install', () => updater.install())
```

> `installAutoUpdate` 는 `createWindow()` 뒤(첫 창 생성 후 기동-체크가 배너로 도달 가능)에 호출. 컨트롤러를 `whenReady` 스코프에서 만들고 핸들러도 같은 스코프에 리터럴로 등록하므로, `registerIpc(engine,…)` 와 별개여도 parity 테스트는 index.ts 텍스트에서 3 handle 리터럴을 본다.

### 6. `src/preload/index.ts` — 브리지

```ts
checkForUpdate: () => ipcRenderer.invoke('fleet:update:check'),
downloadUpdate: () => ipcRenderer.invoke('fleet:update:download'),
installUpdate: () => ipcRenderer.invoke('fleet:update:install'),
onUpdateEvent: (callback) => {
  const listener = (_e, ev: UpdateEvent) => callback(ev)
  ipcRenderer.on('fleet:update:event', listener)
  return () => ipcRenderer.removeListener('fleet:update:event', listener)
},
```

### 7. `src/renderer/components/UpdateBanner.tsx` (신규) — 비차단 배너 상태기계

- `useEffect` 로 `window.fleet.onUpdateEvent` 구독(unsubscribe 정리). 상태: `idle`|`available(version)`|`downloading(percent)`|`downloaded(version)`|`error`.
- 렌더: `available`→"vX 사용 가능 [다운로드]" · `downloading`→진행률 바 · `downloaded`→"재시작해 적용 [지금][나중에]" · `error`→"업데이트 확인 실패"(닫기 가능). `idle`/`not-available`/`unsupported`→null.
- 액션: [다운로드]→`downloadUpdate()` · [지금]→`installUpdate()` · [나중에]/[닫기]→`idle`(로컬 dismiss).
- `App.tsx` 에 `<UpdateBanner />` 1줄 마운트(footer 위 또는 topbar 아래).

## 데이터 흐름

```
앱 기동(packaged·non-E2E)
  └ installAutoUpdate → autoUpdater.checkForUpdates()
       ├ checking → 배너 조용
       ├ not-available → 배너 없음
       ├ available(vX) → 배너 "vX 사용 가능 [다운로드]"
       │    └ [다운로드] → downloadUpdate()
       │         ├ progress(%) → 진행률 바
       │         └ downloaded(vX) → "재시작해 적용 [지금][나중에]"
       │              └ [지금] → quitAndInstall() → will-quit(dispose) → 설치·재기동
       └ error → "업데이트 확인 실패"(비차단)
```

## 에러처리 / 리스크

- **dev/E2E/smoke**: 가드로 네트워크 체크 미무장 → `app-update.yml` 부재 throw 회피. 기존 e2e/smoke 무영향.
- **will-quit 상호작용**: `quitAndInstall()`→`app.quit()`→기존 `will-quit`(preventDefault→`engine.dispose()`→re-quit, 3s 백스톱)와 공존. dispose 지연이 설치를 막지 않는지 **수동/E2E 검증**.
- **AppImage**: 실 AppImage 런치는 `APPIMAGE` 자동 설정. 미설정 환경 워크어라운드(`process.env.APPIMAGE=...`)는 문서 노트만(PR2 무코드).
- **macOS**: mac 타깃 미산출 → `latest-mac.yml` 없음 → mac 은 update-not-available(모듈은 제네릭, 후속 트랙).
- **unsigned 업데이트**: NSIS unsigned 는 서명검증 skip 으로 동작, AppImage 는 서명 무관 — 둘 다 동작.
- **번들링**: `electron-updater` 외부화 누락 시 동적 require 깨짐 → `dist:dir` 언팩서 `node_modules/electron-updater` 존재 + 기동 smoke 로 검출.
- **IPC parity**: 신규 4채널을 preload/main 양쪽 리터럴로 정확 추가 — `ipc-parity.test.ts` 가 강제.

## 테스트 / 검증 (완수 정의)

- **`src/main/auto-update.test.ts`**(신규): 페이크 `updater`(EventEmitter 유사)+페이크 `send` 주입, 반환 컨트롤러 직접 호출 →
  - 미패키지드/E2E → 이벤트 미무장·컨트롤러 메서드 호출 시 `unsupported` send + 실 updater no-op.
  - 패키지드 → `autoDownload=false`·`allowPrerelease=true` 설정 확인.
  - 각 updater 이벤트(emit) → 대응 `UpdateEvent` 브로드캐스트 매핑.
  - 기동 시 `checkForUpdates` 1회·throw 흡수→`error` 이벤트.
  - `controller.download()`/`install()` → `downloadUpdate`/`quitAndInstall` 통과.
- **`src/main/ipc-parity.test.ts`**: 신규 채널 자동 강제(통과).
- **`src/renderer/components/UpdateBanner.test.tsx`**(신규): `onUpdateEvent` 목 → 상태기계 렌더(available→download 클릭→progress→downloaded→install 클릭) + dismiss.
- **로컬(Windows dev)**: `npm run dist:dir` → 언팩 asar 에 `node_modules/electron-updater` 존재 확인 + 기동 smoke.
- **(선택) CI release E2E**: PR1 처럼 `v0.1.0-pre.2` 태그 1회 → 3-잡 green + 패키지드 앱 updater 무장 기동(검증 후 release/tag 정리, master 무오염).
- **4 게이트**: `typecheck`·`lint`·`format:check`·`test` green + CI(win+ubuntu) green.

## 범위 외 (후속 PR — 시퀀싱)

1. **macOS DMG + notarization** (Apple Developer ID, 유료) + `latest-mac.yml`.
2. **코드서명** (Windows Authenticode / macOS, 유료 인증서) — 서명되면 NSIS 업데이트 서명검증 활성.
3. **커스텀 앱 아이콘** (`build/` 아이콘 자산 + gitignore 결정).
4. **autoUpdater 설정 UI** (채널 토글·자동체크 on/off) — 현재는 코드 기본값 고정(YAGNI).
5. **#75 툴체인 번프 → #76 Electron 메이저** — 배포+업데이트 채널 위에서 보안 페이로드 출하.

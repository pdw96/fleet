# 이슈 #74 후속(PR2) — electron-updater autoUpdater 도입 (notify·user-controlled) 설계

- **날짜**: 2026-06-20 (v2 — codex exec gpt-5.5 적대리뷰 반영: P1 기동 이벤트 유실·P2a CJS interop·P2b 백그라운드 에러 노이즈·P2c darwin)
- **대상**: GitHub 이슈 #74 `후속(배포): Electron 패키징 파이프라인 (builder/forge·autoUpdater·코드서명)` (pdw96/fleet, `area:electron` `tier:later`) 의 **후속 슬라이스 PR2**
- **유형**: 빌드/배포 + 런타임 배선 (앱 코어 로직 무변경 · main 프로세스에 업데이트 모듈 1개 + IPC 1네임스페이스 + 렌더러 배너 1개 추가)
- **브랜치**: `feat/electron-autoupdater`
- **상위 트랙**: #74(packaging) → #75(toolchain bump) → #76(electron major). 본 PR은 #74 의 **PR1(#93) 이후 autoUpdater 슬라이스**.

## 배경 / 문제

#74 PR1(PR #93, squash `6084874`)이 unsigned **Windows NSIS + Linux AppImage** 산출 + 태그 기반 GitHub Release CI(prepare→build→release 3-잡)를 출하했고, `electron-builder.yml` 의 `publish: github` 가 릴리스마다 `latest.yml`/`latest-linux.yml` 업데이트 메타데이터를 생성한다(autoUpdater forward-compat). 그러나 **앱에는 그 피드를 소비하는 자동 업데이트 경로가 전혀 없다** — `src` 전체에 `autoUpdater`/`electron-updater` 사용 0건(grep 검증). 즉 새 릴리스를 게시해도 기존 설치 사용자는 수동 재설치해야만 갱신된다.

10차 백로그 큐레이션(#27)에서 사용자가 "Fleet 실배포 의향 O" 를 확정 → 배포 채널(PR1) 위에 **자동 업데이트가 출하 트랙의 다음 가치 슬라이스**다. autoUpdater 가 있어야 #76 Electron 메이저 업그레이드의 보안(EOL/CVE) 페이로드도 비로소 사용자에게 **무마찰 도달**한다.

#74 의 잔여 후속 4종(autoUpdater · macOS DMG+notarization · 코드서명 · 커스텀 아이콘) 중 **autoUpdater 만이 유료 인증서·Mac 하드웨어 종속 없이 즉시 구현 가능**하다(나머지는 유료 인증서/Mac 러너에 막힘). PR1 설계문서 §"범위 외 — 후속 PR — 시퀀싱" 1번이 명시한 그 항목이다.

## 검증 출처 (cross-verification 규율)

AGENTS.md 「리뷰 피드백 교차검증」 + context7 규칙 + **codex exec(gpt-5.5, read-only) 적대 사전검증**으로 양면 검증:

- **context7 — electron-builder/electron-updater(`/electron-userland/electron-builder`)**:
  - autoUpdater 는 `electron-updater` 패키지에서 import. 이벤트: `error`·`checking-for-update`·`update-available`·`update-not-available`·`download-progress`·`update-downloaded`. `autoDownload=true` 면 available 직후 자동 다운로드 → 본 설계는 **`autoDownload=false`**.
  - **packaging 사실(crux)**: "`package.json` and `node_modules/**/*` (production only) are always included regardless of `files` patterns." → `files: [out/**, package.json]` 인 현 설정에서도 **production `dependencies` 는 자동으로 asar 에 포함**. 따라서 `electron-updater` 를 prod dependency 로만 추가하면 패키징됨. "Cannot find module" 트러블슈팅: 반드시 `dependencies`(not devDependencies)에.
  - **AppImage**: 실 AppImage 런치 시 `APPIMAGE` env 자동 설정(미설정 환경만 워크어라운드). AppImage auto-update 지원.
  - **dev 가드**: `dev-app-update.yml` 부재 시 dev 에서 동작 안 함(`forceDevUpdateConfig` 로만 강제). 패키지드(`app.isPackaged`)에서만 정상.
- **CJS interop 정정 (codex P2a)**: `tsconfig.base.json` = `module:ESNext`·`moduleResolution:Bundler`·`verbatimModuleSyntax:true`·`esModuleInterop:true`. electron-vite main 은 CJS 로 emit + 본 설계가 `electron-updater` 를 `external` 처리 → Rollup CJS interop 에서 **default import(`import x from 'electron-updater'`)는 `{default:exports}` 래핑으로 `x.autoUpdater`=undefined 위험**. → **named import `import { autoUpdater } from 'electron-updater'`** 사용(외부 CJS 의 `module.exports.autoUpdater` 를 `require(...).autoUpdater` 로 정확 접근). 안 되면 `import * as electronUpdater` 네임스페이스 폴백. (context7 의 "default import 후 destructure" 가이드는 ESM-compiled 앱용 — 본 레포(CJS emit+external)엔 부적합하므로 채택 안 함.)
- **실제 레포 대조**:
  - `src/main/index.ts`: `app.whenReady()` → `buildEngine` → `registerIpc` → `installChildProcessObserver` → `will-quit`(preventDefault→`engine.dispose()`→re-quit, 3s 백스톱) → `createWindow()`. **`createWindow()` 는 `loadFile/loadURL` 전에 리턴** → 기동 직후 fire-and-forget `send` 는 렌더러 미준비라 유실(codex P1).
  - **`install*(deps)` 모듈 패턴**: `crash-recovery.ts`·`window-guards.ts`·`permission-guards.ts` 모두 의존성 주입형 + 페이크 유닛 테스트 → `auto-update.ts` 동일 패턴.
  - **스냅샷/하이드레이션 패턴(P1 해법 근거)**: `engine.getChatActivity()`/`getRunActivity()` + `ChatPanel`/`ProjectPanel` 의 하이드레이션 레이스 가드(스냅샷 IPC 로 마운트 시 복원, 라이브 우선). 업데이트도 **main 이 last-state 스냅샷 보유 + `getState` IPC** 로 동형 해결.
  - **IPC parity 가드**: `ipc-parity.test.ts` 가 `src/main/index.ts`·`src/preload/index.ts` **소스 텍스트**의 `ipcMain.handle`/`webContents.send`/`ipcRenderer.invoke`/`.on`/`.removeListener` **리터럴**만 추출·정확 일치 + 리터럴-카운트 단언. codex 가 "index.ts 의 whenReady 스코프(=registerIpc 밖) 등록도 통과" 확인.
  - **렌더러 이벤트 패턴**: `onOrchestratorEvent`/`onChatStream`/`onApprovalRequest` = `ipcRenderer.on`→unsubscribe. `App.tsx` topbar+footer 셸 → 비차단 배너 안착.
  - **권한 가드 무영향**: `permission-guards.ts` 는 렌더러 Web Notifications 거부하나, autoUpdater 는 main→IPC→인앱 배너라 무관(네이티브 OS 알림 미사용).
  - **electron-vite 번들링**: `electron.vite.config.ts` 에 `externalizeDepsPlugin` 없음 → 기본 deps 번들(PR1 이 cross-spawn/safe-regex 번들 확인). `electron-updater` 는 동적 require 多 → **main 빌드 외부화 필수**.

## 결정

| # | 결정 | 근거 |
|---|---|---|
| 1 | **패키지 = electron-updater** | context7 + PR1 설계 §범위외 1. NSIS·AppImage 지원. |
| 2 | **UX = notify + user-controlled** (사용자 승인) | `autoDownload=false`. 기동 조용히 체크 → available 시 비차단 배너 → [다운로드] → 진행률 → [지금 재시작]/[나중에]. unsigned·pre-1.0·장시간 앱에 투명·안전. |
| 3 | **prerelease = 허용** (사용자 승인) | `allowPrerelease=true`. 안정 릴리스 0건·앱 전체 pre-1.0. **런타임 노브**(electron-builder.yml 아님). 안정 1.x 출하 시 재검토. |
| 4 | **모듈 = `auto-update.ts` 의존성 주입형, IPC 비등록** | 기존 `install*` 패턴 → electron 없이 유닛 테스트. 컨트롤러(`{getState,check,download,install}`) 반환. |
| 5 | **가드 = `app.isPackaged` false ‖ E2E/smoke ‖ `process.platform==='darwin'`** (codex P2c) | dev/E2E 는 `app-update.yml` 부재 throw 회피. **darwin 은 mac 타깃·`latest-mac.yml` 미산출이라 feed 에러 → 하드 비활성**(mac 출하 트랙서 해제). 미무장 시 컨트롤러 = no-op + `unsupported`. |
| 5a | **IPC 리터럴은 전부 `index.ts` 에** | parity 테스트가 index.ts/preload 텍스트의 리터럴만 대조(codex P3 확인). 모듈은 컨트롤러만 반환, `index.ts` 가 4 handle + 1 send 리터럴 소유. |
| 6 | **패키징 = prod dependency + main 외부화** | `electron-updater` 를 `dependencies` + `electron.vite.config.ts` main `rollupOptions.external:['electron-updater']`(동적 require 보존). electron-builder prod dep 자동 포함 → `electron-builder.yml`/`files` 무변경. |
| 7 | **autoInstallOnAppQuit = 기본(true) 유지** | [다운로드]로 이미 동의 → [나중에] = 다음 자연 종료에 적용. [지금] = `quitAndInstall()` 즉시. |
| 8 | **CJS = named import** `import { autoUpdater } from 'electron-updater'` (codex P2a) | external+CJS interop 서 default import 래핑 위험 회피. |
| 9 | **스냅샷/하이드레이션** (codex P1) | main 이 last `UpdateEvent` 스냅샷 보유 + `fleet:update:getState` IPC. 배너는 마운트 시 **구독 먼저 → 라이브 미수신이면 getState 로 하이드레이트**(라이브 우선). 기동 자동 체크가 렌더러 준비 전 발화해도 유실 없음. |
| 10 | **백그라운드 체크 에러 = log-only** (codex P2b) | 기동 자동 체크(오프라인·신규릴리스 없음·전송실패)는 매 기동 배너 노이즈 → **log 만**, 배너 미표시(state=not-available 유지). **사용자 액션(download/install) 에러만 배너 표시**. 모듈이 `lastUserAction` 플래그로 구분. |
| 11 | **아이콘 = 후속 PR** (사용자 승인) | 디자인 자산·`build/` gitignore 래빗홀 회피. |
| 12 | **electron-builder.yml 변경 없음** | 피드(`publish:github`)·`latest*.yml` 는 PR1 이 세움. prerelease 는 런타임 노브. |

## 상세 설계 (파일별)

### 1. `package.json` — dependency

```jsonc
// dependencies 추가 (devDependencies 아님 — main 런타임 로드)
"electron-updater": "^6.6.2"   // 구현 시 설치된 최신 ~6.x 로 핀
```

### 2. `electron.vite.config.ts` — main 외부화

```ts
main: {
  build: {
    rollupOptions: {
      input: { index: resolve(__dirname, 'src/main/index.ts') },
      external: ['electron-updater'],   // 동적 require 보존 — 런타임 asar node_modules 로드
    },
  },
},
```

> cross-spawn/safe-regex 는 계속 번들(무회귀, dist:dir 로 검증). `electron-updater` 만 외부화 → rollup 이 transitive deps 추적 안 함, electron-builder 가 prod dep 로 asar 포함.

### 3. `src/shared/types.ts` — 계약

```ts
// 업데이트 이벤트/스냅샷 판별 유니온 (main → 렌더러)
export type UpdateEvent =
  | { kind: 'idle' }                            // 초기 스냅샷 기본값 — 배너 미표시
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }       // 0–100
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }          // 사용자 액션 에러만(백그라운드는 log-only)
  | { kind: 'unsupported' }                      // dev/E2E/darwin/비패키지드

// FleetBridge 에 추가
getUpdateState(): Promise<UpdateEvent>          // 마운트 하이드레이트(스냅샷)
checkForUpdate(): Promise<void>
downloadUpdate(): Promise<void>
installUpdate(): Promise<void>
onUpdateEvent(cb: (e: UpdateEvent) => void): () => void
```

> 렌더러는 `idle`/`not-available`/`unsupported` → 배너 null.

### 4. `src/main/auto-update.ts` (신규) — 의존성 주입형 모듈 (IPC 비등록)

```ts
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
  send: (e: UpdateEvent) => void          // index.ts 의 리터럴 broadcast
  isPackaged: boolean
  isE2E: boolean                          // FLEET_E2E==='1' || FLEET_SMOKE
  platform: NodeJS.Platform               // process.platform — darwin 가드
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

export interface UpdateController {
  getState(): UpdateEvent                 // 스냅샷(하이드레이트)
  check(): Promise<void>                   // 기동 자동 = 백그라운드(에러 log-only)
  download(): Promise<void>                // 사용자 액션(에러 배너)
  install(): void                          // 사용자 액션
}

export function installAutoUpdate(deps: AutoUpdateDeps): UpdateController
```

동작:
- **가드**: `!isPackaged || isE2E || platform==='darwin'` → 미무장. `currentState={kind:'unsupported'}`, 컨트롤러 메서드 = no-op(+ `unsupported` 1회 send). 이벤트 리스너/네트워크 없음.
- **무장**: `updater.autoDownload=false`·`updater.allowPrerelease=true`·`updater.logger` 설정. `currentState={kind:'idle'}` 로 시작. 내부 `lastUserAction: 'download'|'install'|null`.
  - 이벤트 매핑(각각 `currentState` 갱신 + `send`): `checking-for-update`→`checking` · `update-available`(info)→`available{version}` · `update-not-available`→`not-available` · `download-progress`(p)→`progress{percent}` · `update-downloaded`(info)→`downloaded{version}`.
  - **`error`(e)**: `lastUserAction` 있으면 → `error{message}` 갱신+send(배너). 없으면(=백그라운드 체크) → **logger.warn 만**, `currentState`=`not-available` 로 정리(배너 무노출), `send` 안 함. (codex P2b·P2c)
  - 기동 시 `check()` 1회(백그라운드). 스냅샷+하이드레이트(결정 9)로 타이밍 유실 무해.
- **컨트롤러**: `getState()`→`currentState` · `check()`→`lastUserAction=null`→`checkForUpdates()`(throw 흡수→백그라운드 에러 경로) · `download()`→`lastUserAction='download'`→`downloadUpdate()` · `install()`→`lastUserAction='install'`→`quitAndInstall()`.

### 5. `src/main/index.ts` — 배선 (IPC 리터럴 소유)

```ts
import { autoUpdater } from 'electron-updater'   // codex P2a: named import
import { installAutoUpdate } from './auto-update'

// broadcastOrchestratorEvent 동형 — 리터럴 send (parity)
function broadcastUpdateEvent(event: UpdateEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fleet:update:event', event)
  }
}

// whenReady 내 createWindow() 직후 — 컨트롤러 생성
const updater = installAutoUpdate({
  updater: autoUpdater,
  send: broadcastUpdateEvent,
  isPackaged: app.isPackaged,
  isE2E: process.env['FLEET_E2E'] === '1' || !!process.env['FLEET_SMOKE'],
  platform: process.platform,
  logger: console,
})

// IPC 리터럴 핸들러 — index.ts 직접 등록(parity, 결정 5a)
ipcMain.handle('fleet:update:getState', () => updater.getState())
ipcMain.handle('fleet:update:check', () => updater.check())
ipcMain.handle('fleet:update:download', () => updater.download())
ipcMain.handle('fleet:update:install', () => updater.install())
```

### 6. `src/preload/index.ts` — 브리지

```ts
getUpdateState: () => ipcRenderer.invoke('fleet:update:getState'),
checkForUpdate: () => ipcRenderer.invoke('fleet:update:check'),
downloadUpdate: () => ipcRenderer.invoke('fleet:update:download'),
installUpdate: () => ipcRenderer.invoke('fleet:update:install'),
onUpdateEvent: (callback) => {
  const listener = (_e, ev: UpdateEvent) => callback(ev)
  ipcRenderer.on('fleet:update:event', listener)
  return () => ipcRenderer.removeListener('fleet:update:event', listener)
},
```

### 7. `src/renderer/components/UpdateBanner.tsx` (신규) — 비차단 배너 + 하이드레이션

- `useEffect`(마운트 1회): **먼저 `onUpdateEvent` 구독**(unsubscribe 정리) → 그 다음 `getUpdateState()` 호출, **단 그 사이 라이브 이벤트를 이미 받았으면 스냅샷으로 덮어쓰지 않음**(라이브 우선; `ChatPanel`/`ProjectPanel` 하이드레이션 가드와 동형, ref 플래그 1개).
- 상태: `UpdateEvent`. 렌더: `available`→"vX 사용 가능 [다운로드]" · `progress`→진행률 바(percent) · `downloaded`→"재시작해 적용 [지금][나중에]" · `error`→"업데이트 확인 실패 [닫기]" · `idle`/`checking`/`not-available`/`unsupported`→null.
- 액션: [다운로드]→`downloadUpdate()` · [지금]→`installUpdate()` · [나중에]/[닫기]→로컬 dismiss(`idle`).
- `App.tsx` 에 `<UpdateBanner />` 1줄 마운트(footer 위 또는 topbar 아래).

## 데이터 흐름

```
앱 기동(packaged·non-E2E·non-darwin)
  └ installAutoUpdate → currentState=idle → check()(백그라운드)
       ├ checking → currentState/배너 조용
       ├ not-available → 배너 없음
       ├ available(vX) → 배너 "vX 사용 가능 [다운로드]"
       │    └ [다운로드] → download()(lastUserAction='download')
       │         ├ progress(%) → 진행률 바
       │         └ downloaded(vX) → "재시작해 적용 [지금][나중에]"
       │              └ [지금] → install()→quitAndInstall() → will-quit(dispose) → 설치·재기동
       └ error(백그라운드) → log only(배너 X)   |   error(다운로드/설치) → 배너

렌더러 배너 마운트 → onUpdateEvent 구독 → (라이브 미수신 시) getUpdateState() 하이드레이트
```

## 에러처리 / 리스크

- **기동 이벤트 유실(P1)**: main 스냅샷 + `getUpdateState` 하이드레이트로 해결(결정 9). 배너는 구독 먼저→하이드레이트(라이브 우선).
- **백그라운드 에러 노이즈(P2b)**: 기동 체크 에러는 log-only, 배너 무노출(결정 10).
- **macOS(P2c)**: `platform==='darwin'` 하드 비활성 — mac 출하 트랙서 `latest-mac.yml`·코드서명과 함께 해제.
- **CJS interop(P2a)**: named import. dist:dir + 기동 smoke 로 `autoUpdater` 실로딩 검증.
- **will-quit 상호작용**: `quitAndInstall()`→`app.quit()`→기존 `will-quit`(preventDefault→`engine.dispose()`→re-quit, 3s 백스톱). `isQuitting` 가드로 데드락 아님(지연만) — **다운로드 완료 후 실제 install 경로를 명시 테스트**(codex P3).
- **AppImage**: 실 런치는 `APPIMAGE` 자동 설정. 미설정 환경 워크어라운드는 문서 노트만.
- **unsigned 업데이트**: NSIS unsigned 서명검증 skip 동작, AppImage 서명 무관.
- **번들링(P3)**: 외부화 누락 시 동적 require 깨짐 → dist:dir 언팩서 **(a)** `out/main/index.js` 에 cross-spawn/safe-regex `require` 무회귀 + **(b)** `node_modules/electron-updater` 존재 이중 단언 + 기동 smoke.
- **IPC parity**: 신규 5채널(getState/check/download/install + event) preload/main 리터럴 정확 추가 — `ipc-parity.test.ts` 강제.

## 테스트 / 검증 (완수 정의)

- **`src/main/auto-update.test.ts`**(신규): 페이크 `updater`(EventEmitter 유사)+페이크 `send` 주입, 컨트롤러 직접 호출 →
  - 미패키지드/E2E/**darwin** → 미무장·메서드 `unsupported`·실 updater no-op.
  - 패키지드(non-darwin) → `autoDownload=false`·`allowPrerelease=true` 설정.
  - 각 updater 이벤트(emit) → 대응 `UpdateEvent` 매핑 + `getState()` 스냅샷 반영.
  - **백그라운드 `error`(check 후) → send 안 함·log 만·state=not-available**; **download/install 후 `error` → `error` 이벤트 send**.
  - 기동 시 `checkForUpdates` 1회·throw 흡수.
  - `download()`/`install()` → `downloadUpdate`/`quitAndInstall` 통과 + `lastUserAction` 설정.
- **`src/main/ipc-parity.test.ts`**: 신규 5채널 자동 강제(통과).
- **`src/renderer/components/UpdateBanner.test.tsx`**(신규): 구독→하이드레이트(라이브 우선 가드)·상태기계(available→download→progress→downloaded→install)·dismiss.
- **로컬(Windows dev)**: `npm run dist:dir` → 언팩서 cross-spawn/safe-regex 무회귀 + `node_modules/electron-updater` 존재 + 기동 smoke.
- **(선택) CI release E2E**: PR1 처럼 `v0.1.0-pre.2` 태그 1회 → 3-잡 green + 패키지드 앱 updater 무장 기동(검증 후 release/tag 정리, master 무오염).
- **4 게이트**: `typecheck`·`lint`·`format:check`·`test` green + CI(win+ubuntu) green.

## 범위 외 (후속 PR — 시퀀싱)

1. **macOS DMG + notarization** (Apple Developer ID, 유료) + `latest-mac.yml` → darwin 가드 해제.
2. **코드서명** (Windows Authenticode / macOS, 유료) — 서명되면 NSIS 업데이트 서명검증 활성.
3. **커스텀 앱 아이콘** (`build/` 자산 + gitignore 결정).
4. **autoUpdater 설정 UI** (채널 토글·자동체크 on/off·수동 "업데이트 확인" 버튼) — 현재 코드 기본값 고정(YAGNI).
5. **#75 툴체인 번프 → #76 Electron 메이저** — 배포+업데이트 채널 위에서 보안 페이로드 출하.

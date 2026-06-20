# 이슈 #76 Electron 33→42 메이저 업그레이드 (EOL/CVE 위생) — 설계·검증

- **날짜**: 2026-06-20
- **대상**: GitHub 이슈 #76 `후속(보안): Electron 33→41/42 메이저 업그레이드 (EOL/CVE)` (pdw96/fleet, `area:electron` `tier:later` `type:security`)
- **유형**: 의존성 메이저 범프 (앱 로직 무변경 — `package.json`/`package-lock.json` 2파일만)
- **브랜치**: `feat/electron-42-major`
- **상위 트랙**: #74(packaging ✅) → #75(toolchain bump ✅) → **#76(electron major, 본 PR)**. packaging·autoUpdater·툴체인이 모두 머지되어 #76 의 선행 차단이 전부 해소됨 → EOL/CVE 보안 페이로드가 비로소 출하 채널을 통해 유저에 도달 가능.

## 배경 / 문제

Fleet 은 `electron ^33.0.0`(설치 33.4.11)에 고정돼 있었다. Electron 지원 정책은 "최신 3개 메이저"만 보안 픽스를 받으므로 **33 은 EOL** 이며, 그 위 Chromium/Node 의 누적 CVE 가 픽스되지 않는다. #74(packaging)·#94(autoUpdater)가 머지되어 배포 채널이 생긴 지금, EOL 의존성을 출하 전에 정리하는 것이 본 작업이다.

직전(9차/툴체인 #95) 노트의 우려 — "electron-vite 가 vite 메이저 천장 결정자이므로 #76 도 동일 매트릭스 재확인 필요" — 를 정찰로 해소했다(아래 §검증 출처 2 참조).

## 검증 출처 (cross-verification 규율 — AGENTS.md 「리뷰 피드백 교차검증」 + context7)

착수 전 4축 병렬 정찰(context7 현행 문서 ↔ 코드 file:line 대조) + 실증으로 양면 검증:

### 1. 타깃 버전 = **v42** (context7 Electron timelines/versioning)
- 2026-06-20 기준 v42 가 최신 stable(Chromium M148, Node 24.16, ~2026-05), v43 beta. 지원창 = 최신 3 메이저(v42·v41·v40).
- v42 는 "v45 release 까지", v41 은 "v44 release 까지" 지원. **둘 다 동일 latest-3-majors 정책(지원 기간 ~24주 동일)** — v42 가 "더 긴 runway"인 것은 **아니다**(적대검증 정정). 다만 v42 가 최신 stable 이고 캘린더상 1메이저 늦게 EOL 앵커를 가지므로, 범프 시점에 가장 최신을 고르는 것이 합리적 → v41 대신 v42.
- **실증**: `electron@42.4.1` 설치 확인.

### 2. electron-vite 천장 = **제약 없음** (context7 electron-vite dependency-handling) — #95 우려 해소
- electron-vite v5 는 `electron` 을 **peer 가 아닌 external 로 처리** → electron 메이저에 cap 을 두지 않는다. 유일한 버전 요구는 toolchain(Node 20.19+/22.12+ · Vite 5.0+)뿐.
- electron-vite stable 5 의 vite 천장(^7)은 electron 메이저와 무관 — Fleet 의 `vite ^7.3.5` 가 이미 충족.
- **즉 #95 의 "천장 매트릭스" 우려는 vite↔electron-vite 축에만 해당하고, electron 메이저 선택과는 독립**. 추가 툴체인 범프 불요.

### 3. Breaking Changes (33→42) = Fleet 표면에 닿는 것 **전부 verify-only** (context7 breaking-changes 가이드)
9 메이저 점프이나 Fleet 이 쓰는 API 는 안정적 표면만이라 코드 변경이 필요한 breaking 이 **0건**.

| 메이저 | 변경 | Fleet 영향 | 조치 |
|---|---|---|---|
| 41 | `dialog.showHiddenFiles`(Linux) deprecate | Fleet `showOpenDialog` 는 `{title, properties:[openDirectory,createDirectory]}` 만 — 미사용 | verify-only |
| 42 | `electron` npm postinstall 바이너리 다운로드 제거 | 런타임 API 아님 — CI/build 메커닉만. `--ignore-scripts` 시 바이너리 부재 | **build-pipeline 검증**(아래 §실증) |
| 42 | `Session.clearStorageData(quotas)` 제거 | Fleet 미사용(권한 핸들러만) | verify-only |
| 42 | PDF 가 별도 WebContents 미생성 | Fleet PDF 미처리·자식 WebContents 미열거 | verify-only |
| 35 | `dialog.defaultPath`(Linux portal) 거동 변화 | Fleet `defaultPath` 미전달 | verify-only |

**불변 확인(33→42)**: app 라이프사이클(whenReady·will-quit·window-all-closed·activate) · BrowserWindow `webPreferences{contextIsolation,sandbox}` · ipcMain/ipcRenderer · contextBridge · 네비게이션 가드(setWindowOpenHandler·will-navigate/redirect/frame-navigate) · 권한 핸들러(Request/Check/DevicePermission, Fleet 은 전부 무조건 deny → 신규 enum 자동 커버) · crash-recovery(render-process-gone reason enum·child-process-gone, Fleet 은 unknown reason 을 recoverable 처리 → 신규 값 안전) · safeStorage 동기 API.

### 4. safeStorage = **동기 유지**(async 는 별도 후속) · Node floor = **불변**
- **동기 API 비-deprecate**: `encryptString`/`decryptString` 은 v41/42 에서 deprecated/removed 가 **아니다**(async 는 "권장"일 뿐, sync 는 "may be deprecated in a future version"). `secret-crypto.ts` 는 그대로 컴파일·동작.
- **async 마이그레이션은 별도 PR 로 분리**: `SecretCrypto` 포트(`core/secret/types.ts`)가 동기 계약(encrypt/decrypt→string, isAvailable→boolean)이고 `engine.ts` 의 restore/register 경로가 동기 소비 → async 전환 시 포트를 Promise 로 넓히고 호출부를 await 해야 해 engine.ts 까지 파급(비자명). `secret-crypto.ts` 의 `v1:` 프리픽스가 이미 마이그레이션 식별자를 마련해 둠(decrypt-on-read-old `v1`→sync, encrypt-on-write-new `v2`→async, 지연 re-key). **Linux 주의**: sync(kwallet/gnome-libsecret) ↔ async(Portal Secret D-Bus/Secret Service)는 키 프로바이더가 달라 cross-decrypt 보장 없음 → v1 은 반드시 sync 로 복호.
- **Node engines floor 불변**: 현 `>=22.22.1 <23 || >=24` 가 v42(Node 22→24)를 이미 커버. electron 번들 Node 는 toolchain Node(npm ci/electron-vite/vitest)와 무관. **실증**: 범프 후 `npm install` 시 EBADENGINE 0.

## 변경 (최소 표면)

```jsonc
// package.json devDependencies
"electron": "^33.0.0"  →  "^42.0.0"
```

그 외 `package-lock.json` 만 갱신(-7/+5 패키지, +77/-109 줄). **src/ 코드 변경 0**.

## 검증 결과 (전 게이트 + e2e — 실 Electron v42)

| 게이트 | 결과 |
|---|---|
| `typecheck`(tsc node/web/e2e) | ✅ pass — electron 42 `electron.d.ts` 와 타입 호환(breaking verify-only 실증) |
| `lint`(eslint) | ✅ pass (경고 0) |
| `format:check`(prettier) | ✅ pass (변경 2파일 정상 — 무관한 `.claude/settings.local.json` 은 글로벌 gitignore·untracked·CI 미포함) |
| `test`(vitest) | ✅ **872 passed / 1 skipped** (win32 보안 회귀 포함) |
| `build`(electron-vite smoke) | ✅ main 180.5kB·preload·renderer 빌드 |
| **e2e**(playwright, 실 Electron v42 launch) | ✅ **9/9 passed** — window-hardening(setWindowOpenHandler deny·will-navigate 차단·권한 deny)·chat-progress·mcp-host·project-activity·ui-controls |

**v42 postinstall 변화 실증 (적대검증 핵심 — "개발자 워크플로 broken" 의혹 반증)**: 설치 직후 `node_modules/electron` 에 바이너리 부재(`path.txt`/`dist/` 없음, electron `package.json scripts:{}` — postinstall **제거** 확인). 의혹은 "fresh clone + `npm ci` + `npm run dev` 가 바이너리 부재로 ENOENT 실패"였으나, electron v42 `index.js` 의 `getElectronPath()` 가 **first-`require()` 시 lazy download** 로 전환된 것이 핵심: path.txt 부재 → `downloadElectron()`(install.js spawn → `@electron/get`) 자동 호출.

- **실증(임시 디렉토리 fresh-clone 시뮬레이션)**: `electron@42 --ignore-scripts` 설치 → 바이너리 부재(path.txt=False·dist=False) → `require('electron')` 호출 시 `Downloading Electron binary...` 출력 후 `RESOLVED: …/dist/electron.exe` 반환, **exit 0**. 즉 electron-vite dev 는 `require('electron')` 로 경로를 얻으므로 **실패가 아니라 첫 실행 1회 자동 다운로드(지연)**. eager(postinstall, v33) → lazy(first-require, v42) 로 타이밍만 이동, 기능 회귀 없음(`--ignore-scripts` 보안 환경 대응 설계).
- **CI/release 영향 없음**: `ci.yml`/`release.yml` 은 `--ignore-scripts` 미사용. `quality` 잡의 `build`(electron-vite build)는 바이너리 불요(번들링만), `windows-tests`(vitest)도 불요(`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 은 v42 에서 no-op·무해). `release.yml` 의 `electron-builder` 는 `@electron/get` 으로 v42 바이너리를 자체 다운로드(node_modules 바이너리 부재 무관, #93 서 검증된 메커니즘).

## 후속 (별도 이슈/PR)

- **safeStorage 동기→async 마이그레이션**: `SecretCrypto` 포트 async 확장 + `v1:`→`v2:` 지연 re-key(위 §4). 비-블로킹·품질 개선.
- **CI checkout/setup-node @v4→@v5**: #95 노트의 node20 deprecation 경고(별개 위생).
- **macOS DMG + notarization · 코드서명(유료 인증서) · 커스텀 아이콘**: #74 잔여(하드웨어/유료 종속).

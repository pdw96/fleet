# 이슈 #74 Electron 패키징 파이프라인 (PR1 슬라이스) — electron-builder · unsigned · CI release 설계

- **날짜**: 2026-06-19
- **대상**: GitHub 이슈 #74 `후속(배포): Electron 패키징 파이프라인 (builder/forge·autoUpdater·코드서명)` (pdw96/fleet, `area:electron` `tier:later`)
- **유형**: 빌드/배포 툴체인 신설 (앱 로직 무변경)
- **브랜치**: `feat/electron-packaging`
- **상위 트랙**: #74(packaging) → #75(toolchain bump) → #76(electron major). 본 PR은 #74 의 **최소 출하 슬라이스**.

## 배경 / 문제

Fleet 은 Electron 데스크톱 앱이지만 배포 산출물(설치 파일)을 만드는 파이프라인이 없다. `electron-vite` 가 `out/` 에 번들만 만들 뿐 — 설치 가능한 바이너리·자동 업데이트·릴리스 경로가 전무하다(`package.json:30-56` 에 packaging 툴 0건, `electron-builder.{json,yml}`/`forge.config.*` 글롭 0건, 워크플로는 `ci.yml` 단독). `version 0.1.0` · `private: true` · 릴리스/태그 0 → 설치 유저 0명.

10차 백로그 큐레이션(#27)에서 **사용자가 "Fleet 을 실제 사용자에게 배포할 의향 있음"** 을 확정 → 이 트랙의 가치가 "이론적"에서 "실현 대상 있음"으로 전환됐다. 배포 채널이 생겨야 #76 Electron 메이저 업그레이드의 보안(EOL/CVE) 페이로드도 비로소 유저에게 도달한다(역방향 시퀀싱: packaging 이 출하 선행조건).

## 검증 출처 (cross-verification 규율)

AGENTS.md 「리뷰 피드백 교차검증」 + context7 규칙에 따라 현행 문서로 양면 검증:

- **context7 — Electron 지원정책(`/websites/electronjs`)**: 최신 3개 stable 메이저만 지원("if the latest release is 42.1.x, then 41.0.x and 40.2.x are supported"), 8주마다 새 메이저, 3개 밖 = 보안 픽스 없음. → 현행 latest ≈ v42 라인, **Electron 33 은 EOL**(본 PR 의 직접 대상은 아니나 #76 의 근거).
- **context7 — electron-builder(`/electron-userland/electron-builder`)**: win/mac/linux + auto-update 표준 솔루션. **unsigned 빌드 1급 지원** — Windows `sign: false`/`null` 로 코드서명 비활성(아이콘/메타데이터는 편집). `directories.output` 으로 산출 디렉터리 지정. → **유료 인증서 없이 NSIS/AppImage 산출 가능** 확인(이전 큐레이션의 "코드서명 유료 종속" 강등 근거가 unsigned 경로로 회피됨).
- **실제 레포 대조**: `out/{main,preload,renderer}` 존재(빌드됨), `package.json:7 main=./out/main/index.js`, `.gitignore` 에 `dist/`·`build/`·`out/` 이미 포함, dependencies = `cross-spawn`·`safe-regex`(둘 다 순수 JS, 네이티브 바인딩 없음).

## 결정 (사용자 승인 완료)

| # | 결정 | 비고 |
|---|---|---|
| 1 | **패키징 도구 = electron-builder** | context7 + 큐레이션 일치. forge 는 electron-vite 통합 약함, 수동은 인스톨러/업데이트 메타 재구현 → 기각 |
| 2 | **타깃 = Windows NSIS(.exe) + Linux AppImage** | dev=Windows 11, 기존 CI=win+ubuntu 러너와 정합. macOS DMG 는 후속(Mac 러너 + notarization 유료) |
| 3 | **unsigned** | `win.sign: false`. AppImage 는 서명 무관. SmartScreen 경고는 unsigned 정상거동(문서화). 유료 인증서 불요 |
| 4 | **CI release 워크플로 포함** | `release.yml` 태그 push(`v*`) → win+ubuntu 매트릭스 → `electron-builder --publish always` → GitHub Release. Linux AppImage 는 Windows dev 로컬 빌드 곤란이라 CI 가 사실상 유일 산출 경로 |
| 5 | **autoUpdater = 후속 PR** | 릴리스 피드(GitHub Releases) 선행 필요. 본 PR 이 그 피드·`latest*.yml` 메타데이터를 세워 forward-compat 확보 |
| 6 | **커스텀 아이콘 = 후속** | PR1 은 electron-builder 기본 아이콘. 디자인 자산 래빗홀 회피 |

## 상세 설계 (파일별)

### 1. `package.json` — devDep · scripts

```jsonc
// devDependencies 추가
"electron-builder": "^26.0.0"   // context7: electron-vite 와 표준 페어링, 현행 메이저 ~26.x

// scripts 추가
"dist": "electron-vite build && electron-builder",        // 번들→패키지 (현재 플랫폼 기본 타깃)
"dist:dir": "electron-vite build && electron-builder --dir" // 언팩(빠른 로컬 기동 확인)
```

> `version: 0.1.0`·`private: true` 유지. `private: true` 는 electron-builder publish 와 무관(publish 는 `--publish` 플래그·`publish` 설정으로 제어).

### 2. `electron-builder.yml` (신규)

```yaml
appId: dev.pdw96.fleet
productName: Fleet
directories:
  output: dist            # 이미 .gitignore
files:
  - out/**                # electron-vite 산출 번들 (main/preload/renderer)
  - package.json
asar: true
publish:
  provider: github        # latest*.yml 업데이트 메타 생성(향후 autoUpdater forward-compat)
win:
  target: nsis
  sign: false             # unsigned (context7 확인) — 유료 인증서 불요
linux:
  target: AppImage
  category: Development
```

> **`buildResources` 생략**: electron-builder 기본 `build/` 인데 레포 `.gitignore` 가 `build/` 를 무시한다. PR1 은 커스텀 자산이 없어(기본 아이콘) 무관하나, **아이콘 후속 PR 은 `build/` 의 gitignore 해제 또는 비-무시 디렉터리 사용을 결정**해야 한다(본 PR 범위 외, 노트만).
> **`files` 와 deps**: electron-vite 의 main/preload 번들이 `dependencies`(`cross-spawn`·`safe-regex`)를 외부화하는지(externalizeDepsPlugin) 구현 시 확인한다. 외부화면 `node_modules/{cross-spawn,safe-regex}/**` 를 `files` 에 추가(electron-builder 가 prod deps 기본 포함하지만 명시 안전), 번들되면 `out/**` 만으로 충분. 둘 다 순수 JS → `electron-rebuild`/네이티브 리빌드 불요.
> **로컬 `dist` 는 publish 안 함**: `publish: github` 설정이 있어도 electron-builder 는 CI + 태그 + 토큰 컨텍스트에서만 자동 publish. 로컬 `npm run dist` 는 `--publish` 플래그·`GH_TOKEN` 부재라 산출물만 생성(게시 없음). CI 만 `--publish always` 로 명시 게시.

### 3. `.github/workflows/release.yml` (신규)

```yaml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write          # GitHub Release 생성/업로드
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    env:
      HUSKY: 0
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
      - run: npm ci
      - run: npm run build            # electron-vite build → out/
      - run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> 기존 `ci.yml` 패턴(checkout@v4 · setup-node@v4 `.nvmrc` · `HUSKY: 0`) 재사용. 러너 OS 가 자기 플랫폼 타깃만 빌드(windows→nsis, ubuntu→AppImage). `--publish always` 가 동일 태그의 Release 에 양쪽 산출물 누적 게시.

### 4. `DESIGN.md` 갱신

- §11 MVP 범위: "패키징/배포 의도 제외" → **packaging in-scope(unsigned win+linux)** 로 정정, autoUpdater/서명/macOS 는 후속 명시.
- §12 품질 게이트: `npm run dist`(산출물 생성) + 릴리스 절차(태그 push → release.yml) 문서화. 기존 `build = smoke` 정의는 유지.

## 데이터 흐름

```
npm run dist
  └ electron-vite build → out/{main,preload,renderer}
  └ electron-builder
       ├ main(out/main/index.js) + files + (필요시) prod deps
       ├ asar 팩
       └ dist/  →  Fleet Setup x.y.z.exe (NSIS) / Fleet-x.y.z.AppImage

git tag v0.1.0-pre1 && git push --tags
  └ release.yml (windows-latest + ubuntu-latest 병렬)
       └ electron-builder --publish always
            └ GitHub Release(v0.1.0-pre1): .exe + .AppImage + latest.yml/latest-linux.yml
```

## 에러처리 / 리스크

- **unsigned Windows**: 설치 시 SmartScreen "알 수 없는 게시자" 경고 — unsigned 정상거동. README/DESIGN 에 문서화. 코드서명은 별도 후속(유료 인증서).
- **CI release 권한**: `permissions: contents: write` + `GH_TOKEN=GITHUB_TOKEN`. 태그 push 로만 트리거(일반 push/PR 무영향).
- **electron-vite 외부화 불확실성**: §2 주석대로 구현 시 `files`/deps 확정(번들 vs 외부화 확인). 네이티브 deps 0 → 리빌드 리스크 없음.
- **macOS 부재**: PR1 은 win+linux 만. mac 유저 미지원(문서화), 후속 PR.
- **기존 게이트 무영향**: 패키징은 additive — typecheck/lint/test/build(smoke) 불변. `electron-builder.yml`(prettier `*.yml` 대상) 포맷 준수.

## 테스트 / 검증 (완수 정의)

- **로컬(Windows dev)**: `npm run dist:dir` 언팩 기동 smoke → `npm run dist` 로 NSIS `.exe` 생성 → 설치 → 기동 smoke(수동 1회).
- **CI**: pre-release 태그(`v0.1.0-pre1`)로 `release.yml` 1회 검증 — windows+ubuntu 양 잡 그린, GitHub Release 에 `.exe`·`.AppImage`·`latest*.yml` 게시 확인.
- **4 게이트**: `typecheck`·`lint`·`test`·`build` 그린 + CI(ubuntu+win) 그린.
- **범위 외**: 패키지드 인스톨러의 **자동** 기동 테스트(기존 Playwright e2e 는 electron-vite 빌드 기동이지 인스톨러 아님) — PR1 수동 smoke 로 대체, 자동화는 후속.

## 범위 외 (후속 PR — 시퀀싱)

1. **autoUpdater** (`electron-updater` + 업데이트 확인/적용 UX) — 본 PR 이 세운 GitHub Releases 피드·`latest*.yml` 의존.
2. **macOS DMG + notarization** (Apple Developer ID, 유료).
3. **코드서명** (Windows Authenticode / macOS, 유료 인증서).
4. **커스텀 앱 아이콘** (`build/` 아이콘 자산).
5. **#75 툴체인 번프 → #76 Electron 메이저** — 배포 채널 위에서 보안 페이로드 출하.

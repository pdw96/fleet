# Electron 패키징 파이프라인 (PR1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** electron-builder 로 Fleet 의 unsigned Windows NSIS(.exe) + Linux AppImage 설치 산출물과 태그 기반 GitHub Release CI 워크플로를 추가한다 (#74 의 첫 출하 슬라이스).

**Architecture:** `electron-vite build` 가 `out/{main,preload,renderer}` 번들을 만들고, electron-builder 가 이를 입력으로 asar 팩 → 플랫폼별 인스톨러를 `dist/` 에 생성한다. CI(`release.yml`)는 태그 push 시 windows+ubuntu 러너에서 게이트→빌드→`--publish always` 로 GitHub Release 에 산출물·`latest*.yml` 을 게시한다. autoUpdater·macOS·코드서명·커스텀 아이콘은 후속 PR.

**Tech Stack:** electron-builder ^26 · electron-vite · GitHub Actions · YAML.

## Global Constraints

- **unsigned 전용**: `win.sign: false`. 코드서명/유료 인증서 일절 추가 안 함.
- **타깃 = Windows NSIS + Linux AppImage 만**. macOS DMG 추가 금지(후속).
- **electron-builder 메이저 = ^26.x** (착수 시 `npm view electron-builder version` 으로 현행 확인 후 핀).
- **release 태그 = `v${package.json.version}`** — electron-builder 는 산출물 버전을 package.json 에서 읽는다(태그 아님). 불일치 금지.
- **모든 신규/수정 YAML·JSON·MD 는 prettier-clean** — `format:check` 가 CI 게이트(`ci.yml:36`). 정렬용 다중 공백 주석 금지. 파일 생성 후 `npm run format` 1회.
- **기존 ci.yml 패턴 재사용**: `actions/checkout@v4` · `actions/setup-node@v4` (`node-version-file: '.nvmrc'`, `cache: npm`) · `env: HUSKY: 0`.
- **Node engines**: `>=22.22.1 <23 || >=24` (package.json:8-10) — 변경 금지.
- **범위 외(절대 추가 금지)**: autoUpdater(`electron-updater`) · macOS · 코드서명 · 커스텀 아이콘 · 패키지드 인스톨러 자동 기동 테스트.
- **확정 사실(codex exec 검증)**: electron-vite 가 `cross-spawn`/`safe-regex` 를 번들(externalize 안 함) → `files: out/** + package.json` 으로 충분. asarUnpack 불요(순수 JS·node-pty 없음).

## File Structure

- **Modify** `package.json` — devDep `electron-builder`, scripts `dist`/`dist:dir`, `repository` 필드.
- **Create** `electron-builder.yml` (레포 루트) — 패키징 설정.
- **Create** `.github/workflows/release.yml` — 태그 기반 릴리스 CI.
- **Modify** `DESIGN.md` — §11 MVP 범위 + §12 게이트(패키징 in-scope·릴리스 절차).

---

### Task 1: electron-builder 의존성 + package.json 스크립트·메타데이터

**Files:**
- Modify: `package.json` (devDependencies, scripts, repository)

**Interfaces:**
- Produces: npm scripts `dist`(= `electron-vite build && electron-builder`), `dist:dir`(= `electron-vite build && electron-builder --dir`); devDep `electron-builder`; `repository` 메타.

- [ ] **Step 1: 현행 electron-builder 메이저 확인**

Run: `npm view electron-builder version`
Expected: `26.x.y` 형태(예: `26.0.12`). 메이저가 26 이 아니면 그 메이저로 핀(스펙 Global Constraints 갱신).

- [ ] **Step 2: electron-builder 를 devDependency 로 설치**

Run: `npm install --save-dev electron-builder@^26`
Expected: `package.json` devDependencies 에 `"electron-builder": "^26.x.y"` 추가, `package-lock.json` 갱신, peer 경고 0(있으면 기록).

- [ ] **Step 3: scripts·repository 필드 추가**

`package.json` 의 `scripts` 에 추가(`build` 줄 뒤, prettier 정렬):

```jsonc
"dist": "electron-vite build && electron-builder",
"dist:dir": "electron-vite build && electron-builder --dir",
```

`package.json` 최상위(`author` 뒤)에 추가:

```jsonc
"repository": {
  "type": "git",
  "url": "https://github.com/pdw96/fleet.git"
},
```

- [ ] **Step 4: 포맷·게이트 검증**

Run: `npm run format && npm run format:check && npm run typecheck && npm run lint && npm test`
Expected: 전부 통과(test 850 passed 수준). electron-builder 설치는 런타임 코드 무변경이라 기존 테스트 영향 0.

- [ ] **Step 5: 커밋**

```bash
git add package.json package-lock.json
git commit -m "build(packaging): electron-builder 도입 + dist 스크립트·repository 메타"
```

---

### Task 2: electron-builder.yml + 로컬 패키징 검증 (Windows)

**Files:**
- Create: `electron-builder.yml`

**Interfaces:**
- Consumes: Task 1 의 `dist`/`dist:dir` 스크립트, `out/{main,preload,renderer}` (electron-vite build 산출).
- Produces: `dist/win-unpacked/Fleet.exe` (`--dir`), `dist/Fleet Setup <version>.exe` (NSIS).

- [ ] **Step 1: `electron-builder.yml` 생성 (prettier-clean)**

```yaml
appId: dev.pdw96.fleet
productName: Fleet
directories:
  output: dist
files:
  - out/**
  - package.json
asar: true
publish:
  provider: github
  owner: pdw96
  repo: fleet
win:
  target: nsis
  sign: false
linux:
  target: AppImage
  category: Development
```

> 주석/정렬 공백 없이 작성(스펙 결정 #9·codex P3). `directories.output: dist` 는 `.gitignore` 에 이미 포함.

- [ ] **Step 2: 포맷 검증**

Run: `npm run format && npm run format:check`
Expected: 통과(`electron-builder.yml` 포함, 재작성 diff 없음).

- [ ] **Step 3: 언팩 빌드 — 패키징 배선 검증**

Run: `npm run dist:dir`
Expected: 성공 종료. `dist/win-unpacked/Fleet.exe` 생성. 로그에 `cross-spawn`/`safe-regex` 모듈 누락 에러 없음(번들 확인됨).

- [ ] **Step 4: 언팩 앱 기동 smoke (수동)**

Run: `./dist/win-unpacked/Fleet.exe` (또는 탐색기 더블클릭)
Expected: Fleet 창이 뜨고 렌더러가 로드됨(흰 화면/모듈 에러 없이 정상 UI). 확인 후 종료.

- [ ] **Step 5: NSIS 인스톨러 빌드**

Run: `npm run dist`
Expected: 성공. `dist/Fleet Setup 0.1.0.exe` (NSIS) 생성 + `dist/latest.yml`. publish 시도 없음(로컬·토큰 없음).

- [ ] **Step 6: 설치·기동 smoke (수동)**

`dist/Fleet Setup 0.1.0.exe` 실행 → (unsigned 라 SmartScreen "추가 정보→실행") → 설치 → Fleet 기동 → UI 정상 확인 후 종료·제거.

- [ ] **Step 7: 커밋** (`dist/` 는 gitignore 라 yml 만)

```bash
git add electron-builder.yml
git commit -m "build(packaging): electron-builder.yml — unsigned win NSIS + linux AppImage"
```

---

### Task 3: release.yml CI 워크플로

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Task 1 스크립트, Task 2 `electron-builder.yml`.
- Produces: 태그 `v*` push 시 windows+ubuntu 러너가 게이트→build→`electron-builder --publish always` 로 GitHub Release 게시.

- [ ] **Step 1: `.github/workflows/release.yml` 생성 (prettier-clean)**

```yaml
name: Release
on:
  push:
    tags:
      - 'v*'
permissions:
  contents: write
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
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run format:check
      - run: npm test
      - run: npm run build
      - run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

> 게이트(typecheck/lint/format:check/test)가 build·publish 선행(codex P2-1). 각 러너는 자기 플랫폼 타깃만 빌드(win→nsis, ubuntu→AppImage). `electron-builder --publish always` 가 `GH_TOKEN` 으로 동일 태그 Release 에 산출물 누적 게시.

- [ ] **Step 2: 포맷 검증**

Run: `npm run format && npm run format:check`
Expected: 통과(재작성 diff 없음).

- [ ] **Step 3: 워크플로 YAML 유효성 확인**

Run: `node -e "const fs=require('node:fs');const s=fs.readFileSync('.github/workflows/release.yml','utf8');if(!/name:\s*Release/.test(s)||!/tags:/.test(s)||!/--publish always/.test(s))throw new Error('release.yml malformed');console.log('release.yml OK')"`
Expected: `release.yml OK`. (prettier 가 이미 YAML 파싱하므로 구문 유효성은 Step 2 에서 보장 — 본 스텝은 핵심 키 존재 확인.)

- [ ] **Step 4: 커밋**

```bash
git add .github/workflows/release.yml
git commit -m "ci(packaging): release.yml — 태그 push 시 게이트→다플랫폼 빌드→GitHub Release"
```

---

### Task 4: DESIGN.md 갱신

**Files:**
- Modify: `DESIGN.md` (§11 MVP 범위, §12 품질 게이트)

**Interfaces:**
- Consumes: Task 1-3 의 스크립트·워크플로(문서가 참조).

- [ ] **Step 1: §11 MVP 범위에 패키징 항목 추가**

`DESIGN.md` §11 의 완수 정의 목록(현재 1-9) 뒤에 추가:

```markdown
10. (배포) electron-builder 로 unsigned Windows NSIS + Linux AppImage 산출 + 태그 기반 GitHub Release CI. autoUpdater·macOS·코드서명·커스텀 아이콘은 후속(#74 트랙).
```

- [ ] **Step 2: §12 품질 게이트에 패키징·릴리스 절차 추가**

`DESIGN.md` §12 의 게이트 목록(현재 4줄) 뒤에 추가:

```markdown

### 배포 (#74)

- `npm run dist` — `electron-vite build` 후 electron-builder 로 현재 플랫폼 인스톨러를 `dist/` 에 생성(`build` 의 smoke 정의와 별개).
- 릴리스: `package.json` version 을 올리고 일치 태그(`v${version}`)를 push → `release.yml` 이 windows+ubuntu 에서 게이트→빌드→GitHub Release 게시(unsigned).
```

- [ ] **Step 3: 포맷 검증**

Run: `npm run format && npm run format:check`
Expected: 통과.

- [ ] **Step 4: 커밋**

```bash
git add DESIGN.md
git commit -m "docs(packaging): DESIGN.md §11/§12 — 패키징 in-scope·릴리스 절차"
```

---

### Task 5: PR 생성 + E2E 릴리스 검증 (태그 push — outward action)

**Files:** 없음(검증·PR 단계). version 일시 범프는 검증 후 원복.

**Interfaces:**
- Consumes: Task 1-4 전체.

- [ ] **Step 1: PR 생성**

```bash
git push -u origin feat/electron-packaging
```
GitHub 에 PR 생성(base master). 본문에 스펙·codex 검증·범위(unsigned win+linux, 후속 항목) 요약. **Codex 봇 자동 리뷰 대기**(머지 전 확인·반영 — 레포 규율).

- [ ] **Step 2: 4 게이트 로컬 최종 확인**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`
Expected: 전부 green.

- [ ] **Step 3: E2E 릴리스 검증 (사용자 확인 후 — 실제 GitHub Release 생성·CI 소비)**

> **OUTWARD ACTION — 사용자 확인 필수.** 태그 push 는 GitHub Release 를 만들고 CI 분을 소비한다. PR 머지 전 검증하려면 태그를 feat 브랜치 HEAD 에 달아도 됨(워크플로는 태그 커밋의 release.yml 을 사용).

version 을 prerelease 로 범프(태그 일치 — Global Constraint):

```bash
# package.json version 0.1.0 → 0.1.0-pre.1 로 수정 후
git add package.json && git commit -m "chore(release): v0.1.0-pre.1 검증 태그용 버전 범프"
git tag v0.1.0-pre.1 && git push origin HEAD --tags
```

- [ ] **Step 4: release.yml 실행 관찰**

Run: `gh run watch` (또는 Actions 탭)
Expected: `Release` 워크플로 windows-latest + ubuntu-latest 양 잡 green(게이트→build→publish).

- [ ] **Step 5: GitHub Release 산출물 확인**

Run: `gh release view v0.1.0-pre.1`
Expected: 자산에 `Fleet Setup 0.1.0-pre.1.exe`(NSIS) · `Fleet-0.1.0-pre.1.AppImage` · `latest.yml` · `latest-linux.yml` 게시.

- [ ] **Step 6: 검증 정리**

검증 Release/태그 삭제(`gh release delete v0.1.0-pre.1 --cleanup-tag`) + version 을 `0.1.0` 으로 원복 커밋(정식 릴리스는 별도 시점). PR 에 검증 결과 기록.

---

## Self-Review

**Spec coverage (스펙 결정 #1-9 대조):**
- #1 electron-builder → Task 1·2 ✓
- #2 win NSIS + linux AppImage → Task 2(yml) ✓
- #3 unsigned(`win.sign:false`) → Task 2 yml ✓
- #4 CI release 워크플로 → Task 3 ✓
- #5 autoUpdater 후속 → 범위 외 명시(Global Constraints) ✓
- #6 아이콘 후속 → 범위 외 명시 ✓
- #7 release 게이트 → Task 3 Step 1(typecheck/lint/format:check/test 선행) ✓
- #8 태그=`v${version}` → Global Constraints + Task 5 Step 3(0.1.0-pre.1 범프) ✓
- #9 publish owner/repo + repository 메타 → Task 2 yml(owner/repo) + Task 1(repository) ✓
- DESIGN.md 갱신 → Task 4 ✓

**Placeholder scan:** 모든 스텝에 실제 코드/명령/기대출력 명시. "TODO"/"적절히"/"등" 없음. ✓

**Type consistency:** 스크립트명 `dist`/`dist:dir` (Task 1 정의 → Task 2·DESIGN 참조 일치), 산출물 경로 `dist/win-unpacked/Fleet.exe`·`dist/Fleet Setup <version>.exe` 일관, appId `dev.pdw96.fleet`·owner `pdw96`/repo `fleet` 일관. ✓

**Note:** 패키징/인프라 작업이라 단위테스트(vitest) 신규 0 — 검증은 빌드 성공 + 산출물 존재 + 기동 smoke(수동) + CI green 으로 구성(스펙 「테스트/검증」 정의대로). 기존 850 테스트는 무영향(런타임 코드 무변경).

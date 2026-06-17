# 이슈 #14 개발 위생 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Node 버전을 핀하고, Prettier로 포맷을 일관화하며, pre-commit 훅으로 staged 파일을 자동 포맷/린트한다.

**Architecture:** 설정 전용 변경(앱 로직 무변경). 5개 커밋으로 분리 — EOL 정규화 → Node 핀 → Prettier 셋업 → 전체 리포맷 → husky+lint-staged. squash 머지하므로 중간 커밋 CI 상태는 무관(PR head만 게이트).

**Tech Stack:** Node 22, npm(engine-strict), Prettier 3, eslint-config-prettier 10(flat), husky 9, lint-staged 16, ESLint 9 flat config, electron-vite, vitest.

**스펙:** `docs/superpowers/specs/2026-06-17-issue-14-dev-hygiene-design.md`

## Global Constraints

모든 태스크에 암묵 적용 (스펙에서 verbatim):

- `engines.node` = **`">=22.13.0"`** (transitive `eslint-visitor-keys` 바닥; `>=22`는 engine-strict 하 22.0~22.12에서 EBADENGINE).
- `.npmrc` `engine-strict=true` (하드 에러 격상).
- Prettier 옵션: `semi:false`, `singleQuote:true`, `trailingComma:"all"`, `proseWrap:"preserve"`, `printWidth:100`, `endOfLine:"lf"`.
- `*.md`는 Prettier 대상에서 **제외**(한글 prose 47개, 의도적 정책).
- husky v9 훅 본문 = 명령만(shebang/`husky.sh` 보일러플레이트 금지). lint-staged 명령에 glob 금지(staged 절대경로 자동 append).
- 훅 본문 = `npx --no-install lint-staged`. lint-staged eslint = `eslint --fix --no-warn-ignored`.
- 커밋 메시지 한글 conventional + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- dev = Windows 11(PowerShell 주). 검증 명령은 npm/git(셸 무관). 브랜치 `feat/dev-hygiene`.

---

## File Structure

| 파일 | 역할 | 태스크 |
|---|---|---|
| `.gitattributes` | EOL 정규화(text=auto eol=lf, .husky LF 보장) | 1 |
| `.nvmrc` | 로컬 Node 버전 활성화(`22`) | 2 |
| `package.json` `engines` | Node 바닥 강제(`>=22.13.0`) | 2 |
| `.npmrc` | `engine-strict=true` | 2 |
| `.github/workflows/ci.yml` | `node-version-file`·`format:check`·`HUSKY:0` | 2·3·5 |
| `.prettierrc.json` | Prettier 옵션 | 3 |
| `.prettierignore` | 포맷 제외 대상 | 3 |
| `eslint.config.mjs` | `eslint-config-prettier/flat` last | 3 |
| `package.json` scripts | `format`·`format:check`·`prepare` | 3·5 |
| `package.json` `lint-staged` | staged glob→명령 | 5 |
| `.husky/pre-commit` | `npx --no-install lint-staged` | 5 |

---

## Task 1: EOL 정규화 (.gitattributes)

**Files:**
- Create: `.gitattributes`

**Interfaces:**
- Produces: 모든 텍스트 파일이 LF로 정규화 보장. 후속 Task 4(Prettier `endOfLine:lf`)·Task 5(`.husky/*` 훅)가 이에 의존.

- [ ] **Step 1: `.gitattributes` 생성**

```
# 모든 텍스트 파일을 LF로 정규화 (Windows 워킹트리 CRLF 차이로 인한 prettier --check 거짓실패 방지).
* text=auto eol=lf
# husky 훅은 sh 로 실행 → 반드시 LF.
.husky/** text eol=lf
```

- [ ] **Step 2: 정규화 적용 + churn 확인**

Run:
```bash
git add .gitattributes
git add --renormalize .
git status --short
```
Expected: `A  .gitattributes` 만 (또는 그에 준하는 최소). index가 이미 LF라 renormalize는 내용 변경 거의 없음. 만약 다수 파일이 staged 되면 `git diff --cached --stat`으로 내용 diff(공백 외)가 없는지 확인 — EOL만이면 정상.

- [ ] **Step 3: 커밋**

```bash
git commit -m "chore(devx): EOL 정규화 — .gitattributes (text=auto eol=lf)

husky 훅 LF 보장 + Windows 워킹트리 CRLF 로 인한 prettier --check 거짓실패 예방.
index 는 이미 전부 LF(git ls-files --eol 확인) → renormalize churn 0.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Node 핀 (.nvmrc · engines · .npmrc · CI)

**Files:**
- Create: `.nvmrc`, `.npmrc`
- Modify: `package.json` (engines 추가), `.github/workflows/ci.yml` (두 잡 node-version → node-version-file)

**Interfaces:**
- Produces: Node `>=22.13.0` 강제. CI가 `.nvmrc`를 단일출처로 사용.

- [ ] **Step 1: `.nvmrc` 생성**

```
22
```

- [ ] **Step 2: `.npmrc` 생성**

```
engine-strict=true
```

- [ ] **Step 3: `package.json`에 engines 추가**

`"main": "./out/main/index.js",` 줄 바로 다음에 삽입:
```json
  "engines": {
    "node": ">=22.13.0"
  },
```

- [ ] **Step 4: CI 두 잡의 setup-node 수정**

`.github/workflows/ci.yml`에서 **두 곳** 모두:
```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
```
→
```yaml
      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'
          cache: npm
```

- [ ] **Step 5: engine-strict 통과 검증**

Run:
```bash
npm ci
```
Expected: 성공(설치 완료, `EBADENGINE` 에러 없음). dev Node 24 ≥ 22.13.0. (느리면 시간 소요 정상 — node_modules 재설치.)

- [ ] **Step 6: 커밋**

```bash
git add .nvmrc .npmrc package.json package-lock.json .github/workflows/ci.yml
git commit -m "chore(devx): Node 22.13+ 핀 — .nvmrc·engines·engine-strict + CI node-version-file

engines.node='>=22.13.0'(transitive eslint-visitor-keys 바닥)·engine-strict=true.
CI 두 잡을 node-version-file:.nvmrc 로 단일출처화.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
> `npm ci`가 `package-lock.json`을 건드리지 않으면 add 목록에서 제외.

---

## Task 3: Prettier 셋업 (리포맷 전)

**Files:**
- Create: `.prettierrc.json`, `.prettierignore`
- Modify: `eslint.config.mjs`, `package.json` (scripts), `.github/workflows/ci.yml` (format:check 스텝)

**Interfaces:**
- Consumes: 없음.
- Produces: `npm run format` / `npm run format:check` 사용 가능. eslint가 prettier와 충돌 안 함.

- [ ] **Step 1: prettier + eslint-config-prettier 설치**

Run:
```bash
npm i -D --save-exact prettier@3
npm i -D eslint-config-prettier
```
Expected: 두 패키지 devDependencies 추가. prettier는 정확 버전(캐럿 없음).

- [ ] **Step 2: `.prettierrc.json` 생성**

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "proseWrap": "preserve",
  "printWidth": 100,
  "endOfLine": "lf"
}
```

- [ ] **Step 3: `.prettierignore` 생성**

```
# 빌드 산출물 / 의존성
node_modules
out
dist
build
coverage
test-results
playwright-report
.playwright-mcp
fleet-data
# npm 관리 (포맷 금지)
package-lock.json
# Second Brain 자동 생성물
fleet-brain.html
brain.tmp.json
# 손으로 다듬은 한글 prose 문서 — 차후 opt-in
*.md
```

- [ ] **Step 4: `eslint.config.mjs`에 eslint-config-prettier 추가**

파일 최상단 import 블록에 추가:
```js
import eslintConfigPrettier from 'eslint-config-prettier/flat'
```
그리고 `tseslint.config(` 의 **마지막 인자**로(닫는 `)` 직전, 기존 마지막 블록 뒤에 콤마+한 줄):
```js
  eslintConfigPrettier,
)
```

- [ ] **Step 5: `package.json` scripts 추가**

`"lint": "eslint .",` 다음에 삽입:
```json
    "format": "prettier --write .",
    "format:check": "prettier --check .",
```

- [ ] **Step 6: CI `quality` 잡에 format:check 스텝 추가**

`.github/workflows/ci.yml`의 `quality` 잡, `Lint` 스텝 다음에:
```yaml
      - name: Format check (prettier)
        run: npm run format:check
```

- [ ] **Step 7: eslint 설정 무결성 검증 (리포맷 전)**

Run:
```bash
npm run lint
```
Expected: PASS(에러 0). eslint-config-prettier가 끄는 스타일룰이 현재 없어 동작 불변.

Run:
```bash
npm run format:check
```
Expected: **FAIL** — 다수 파일이 "Code style issues found". 리포맷 전이라 정상. (Task 4에서 green.)

- [ ] **Step 8: 커밋**

```bash
git add .prettierrc.json .prettierignore eslint.config.mjs package.json package-lock.json .github/workflows/ci.yml
git commit -m "chore(devx): Prettier 3 도입 — 설정·eslint-config-prettier·format 스크립트

semi:false·singleQuote:true·printWidth:100·endOfLine:lf, *.md 제외.
eslint-config-prettier/flat last 로 충돌 스타일룰 비활성. CI format:check 스텝.
(전체 리포맷은 다음 커밋.)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 전체 1회 리포맷

**Files:**
- Modify: 포맷 대상 전체(ts/tsx/js/mjs/cjs/json/css/yml/html, `.prettierignore` 제외분 빼고)

**Interfaces:**
- Consumes: Task 3의 `.prettierrc.json`·`.prettierignore`.
- Produces: `format:check` clean 상태.

- [ ] **Step 1: `scripts/brain/template.html` 템플릿 안전성 확인**

Run:
```bash
npx prettier --check scripts/brain/template.html
```
그리고 파일을 열어 치환 문법(`{{…}}`, `<%…%>`, `${…}` 등) 확인. 만약 Prettier가 훼손할 템플릿 문법이 있으면 `.prettierignore`에 `scripts/brain/template.html` 한 줄 추가 후 재커밋(Task 3 수정). 일반 HTML이면 그대로 진행.

- [ ] **Step 2: 전체 리포맷 실행**

Run:
```bash
npm run format
```
Expected: 다수 파일 "formatted". 수천 줄 변경(기계적).

- [ ] **Step 3: format:check clean 검증**

Run:
```bash
npm run format:check
```
Expected: PASS — "All matched files use Prettier code style!"

- [ ] **Step 4: 게이트 4종 검증 (리포맷이 코드 의미 불변 확인)**

Run:
```bash
npm run typecheck
npm run lint
npm test
npm run build
```
Expected: 전부 PASS. `npm test` 기존 통과 수 유지(회귀 0). lint/typecheck/build 깨짐 없음.

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "style(devx): Prettier 전체 1회 리포맷

기계적 변경 — printWidth:100·no-semi·single-quote 적용. 코드 의미 불변(게이트 4종 green).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: husky + lint-staged pre-commit 훅

**Files:**
- Create: `.husky/pre-commit`
- Modify: `package.json` (devDeps·prepare·lint-staged), `.github/workflows/ci.yml` (HUSKY:0)

**Interfaces:**
- Consumes: Task 3의 Prettier·format, Task 1의 `.husky/*` LF 보장.
- Produces: 커밋 시 staged 파일 자동 포맷/린트.

- [ ] **Step 1: husky + lint-staged 설치 및 초기화**

Run:
```bash
npm i -D husky lint-staged
npx husky init
```
Expected: `.husky/pre-commit`(샘플 `npm test`) 생성, `package.json`에 `"prepare": "husky"` 추가, `.husky/_/`(self-ignored) 생성.

- [ ] **Step 2: `package.json`에 prepare 스크립트 확인**

`package.json` scripts에 `"prepare": "husky"`가 있는지 확인(`npx husky init`이 추가). 없으면 수동 추가:
```json
    "prepare": "husky",
```

- [ ] **Step 3: `.husky/pre-commit` 본문 교체**

`.husky/pre-commit` 전체 내용을(샘플 `npm test` 삭제하고) 정확히 한 줄로:
```
npx --no-install lint-staged
```
> shebang·`husky.sh` source 줄 없음(v9 형식).

- [ ] **Step 4: `package.json`에 lint-staged 설정 추가**

최상위(`devDependencies` 다음 등 적절한 위치)에 추가:
```json
  "lint-staged": {
    "*.{ts,tsx,js,mjs,cjs}": ["prettier --write", "eslint --fix --no-warn-ignored"],
    "*.{json,css,yml,yaml,html}": ["prettier --write"]
  }
```

- [ ] **Step 5: CI 두 잡에 HUSKY:0 추가**

`.github/workflows/ci.yml`의 각 잡(`quality`·`windows-tests`)에 잡 레벨 env 추가(잡 이름·`runs-on` 아래, `steps` 위):
```yaml
  quality:
    name: typecheck · lint · test · build
    runs-on: ubuntu-latest
    env:
      HUSKY: 0
    steps:
```
`windows-tests` 잡도 동일하게 `env: { HUSKY: 0 }` 추가.

- [ ] **Step 6: 훅 스모크 테스트 — 자동 포맷**

오포맷 임시 파일로 훅 동작 확인:
```bash
printf 'export const x = {a:1,b:2}\n\n\nconst y= "z"\n' > src/_hook_smoke.ts
git add src/_hook_smoke.ts
git commit -m "test: hook smoke (임시)"
```
Expected: 커밋 성공. 커밋된 `src/_hook_smoke.ts`가 prettier로 재포맷됨(single-quote·정렬). 확인:
```bash
git show HEAD:src/_hook_smoke.ts
```
Expected: `export const x = { a: 1, b: 2 }` 처럼 포맷됨.

- [ ] **Step 7: 훅 스모크 정리(임시 커밋·파일 제거)**

```bash
git reset --soft HEAD~1
git restore --staged src/_hook_smoke.ts
rm src/_hook_smoke.ts
git status --short
```
Expected: 워킹트리에 `_hook_smoke.ts` 없음, 임시 커밋 제거됨.

- [ ] **Step 8: 최종 게이트 검증**

Run:
```bash
npm run format:check
npm run lint
npm run typecheck
npm test
```
Expected: 전부 PASS.

- [ ] **Step 9: 커밋**

```bash
git add .husky/pre-commit package.json package-lock.json .github/workflows/ci.yml
git commit -m "chore(devx): pre-commit 훅 — husky 9 + lint-staged 16

.husky/pre-commit=npx --no-install lint-staged. staged: prettier→eslint --fix
--no-warn-ignored(ignored config 노이즈 억제). CI HUSKY:0. typecheck/test 는 CI 위임.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (작성자 체크)

**Spec coverage:**
- Node 핀(engines>=22.13.0·.nvmrc·.npmrc·engine-strict) → Task 2 ✓
- CI node-version-file → Task 2 ✓
- Prettier(설정·ignore·eslint 배선·scripts·md 제외) → Task 3 ✓
- 전체 리포맷(별도 커밋·template.html 검토·게이트) → Task 4 ✓
- husky+lint-staged(--no-install·--no-warn-ignored·prepare) → Task 5 ✓
- CI format:check → Task 3, HUSKY:0 → Task 5 ✓
- EOL 정규화(.gitattributes·.husky LF) → Task 1 ✓
- 검증(게이트 4종·format:check·npm ci·훅 스모크) → Task 2/4/5 ✓

**Placeholder scan:** template.html은 조건부 실제 행동(검토→필요시 ignore), TBD 아님. 그 외 placeholder 없음.

**Type/이름 일관성:** `format`/`format:check`/`prepare` 스크립트명, `eslintConfigPrettier` 식별자, `--no-warn-ignored`/`--no-install` 플래그가 태스크 전반 일치 ✓.

**비범위 확인:** md 포맷·pre-push·devEngines 미포함(스펙 비범위와 일치) ✓.

# 이슈 #14 개발 위생 — Node 핀 · Prettier · pre-commit 훅 설계

- **날짜**: 2026-06-17
- **대상**: GitHub 이슈 #14 `후속: 개발 위생 — Node 버전 핀 · Prettier · pre-commit 훅` (pdw96/fleet, `area:devx` `tier:next`)
- **유형**: 툴체인/설정 변경 (앱 로직 무변경)
- **브랜치**: `feat/dev-hygiene`

## 배경 / 문제

레포가 솔로/소형이라 선택사항이지만 재현성·일관성에 도움. 현재 세 가지 공백/불일치:

1. **Node 버전 불일치**: dev 머신 Node 24, CI Node 22, `@types/node` `^22`. 핀(`engines`/`.nvmrc`) 부재.
2. **포맷 일관성 도구 부재**: Prettier 없음. ESLint flat config는 **의도적으로 스타일룰 0**(버그탐지 전용 — typed-linting + react-hooks). 코드 스타일은 사실상 no-semi·single-quote로 손으로 유지 중.
3. **pre-commit 훅 부재**: husky/lint-staged 없음 → 포맷/린트 회귀가 CI에서만 잡힘.

## 검증 출처 (cross-verification 규율)

AGENTS.md 「리뷰 피드백 교차검증」 + context7 규칙에 따라 현행 문서·실제 레포로 양면 검증:

- **context7 (현행 API/버전)**: husky **9.x**(v10서 보일러플레이트 제거), lint-staged **16.x**(`--shell` 제거·nano-spawn), prettier **3.x**(`--check` CI 게이트·`endOfLine` 기본 lf) / eslint-config-prettier **10.x**(`/flat` 서브패스 last), npm 11 `engines`·`engine-strict`.
- **codex exec (gpt-5.5, read-only, 실제 실행)**: 락파일 전체 `semver.satisfies` 스캔 + config 파일 eslint 실행으로 **2개 실질 결함 발견**(아래 §결정에 반영). 단 결함 ②의 심각도("커밋 깨짐")는 직접 재현 결과 **exit 0(노이즈)**로 정정 — 수정안은 미래방어 가치로 채택.
- **자체 측정**: 코드 줄길이 분포(>80자 21.9%), EOL 현황(`git ls-files --eol`: index 전부 LF, 워킹트리만 CRLF → 정규화 churn ≈ 0).

## 결정 (사용자 승인 완료)

| # | 결정 | 비고 |
|---|---|---|
| 1 | **Node 핀**: `.nvmrc`=`22`, `engines.node`=**`">=22.13.0"`**, `.npmrc` `engine-strict=true` | 바닥 22.13.0 = transitive `eslint-visitor-keys` 실제 요구치(codex 발견). CI `node-version-file: .nvmrc`로 단일출처화 |
| 2 | **Prettier 3 + 전체 1회 리포맷** | no-semi·single-quote·`printWidth:100`·`endOfLine:lf`. `eslint-config-prettier/flat` last. `*.md` 제외(한글 prose, 의도적 정책) |
| 3 | **husky 9 + lint-staged 16** | `.husky/pre-commit` = `npx --no-install lint-staged`. staged: prettier→eslint. typecheck/test는 CI 위임 |
| 4 | **engine-strict ON** (권장안) | 유일한 하드페일 노브. 22.13.0 바닥 박아 오늘 안전. `.npmrc` 한 줄 제거로 즉시 advisory 회귀 가능 |
| 5 | **printWidth 100** | >80자 21.9%라 80은 대량 재줄바꿈. 코멘트/문자열은 Prettier 미변경이라 실제 코드 churn은 더 적음 |

## 상세 설계 (파일별 정확 내용)

### 1. Node 핀

**`.nvmrc`** (신규):
```
22
```

**`package.json`** (추가):
```json
"engines": { "node": ">=22.13.0" }
```
> `>=22`이 아닌 `>=22.13.0`: 락파일의 transitive `eslint-visitor-keys`가 `"^20.19.0 || ^22.13.0 || >=24"`를 요구. codex가 `semver.satisfies`로 Node 22.0.0→**BAD 1**, 22.13.0→0, 24.0.0→0 확인. `engine-strict` 하에서 22.0~22.12는 `npm ci` EBADENGINE. 바닥을 정직하게 22.13.0으로.

**`.npmrc`** (신규):
```
engine-strict=true
```
> advisory(warn) → 하드 에러(EBADENGINE) 격상. dev(24)·CI(최신 22.x ≥ 22.13)·바닥(22.13) 모두 통과.

### 2. Prettier + 리포맷

설치: `npm i -D --save-exact prettier@3` (minor간 출력차로 인한 머신간 diff 방지) + `npm i -D eslint-config-prettier`.

**`.prettierrc.json`** (신규):
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

**`.prettierignore`** (신규):
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
> 구현 중 `scripts/brain/template.html` 검토: 템플릿 치환 문법(`{{…}}` 등)이 있으면 `.prettierignore`에 추가. `src/renderer/index.html`은 일반 HTML이라 포맷 대상 유지.

**`eslint.config.mjs`** (수정): import 추가 + `tseslint.config(...)`의 **마지막 인자**로 추가.
```js
import eslintConfigPrettier from 'eslint-config-prettier/flat'
// ... tseslint.config( 의 모든 기존 블록 뒤, 맨 마지막에:
  eslintConfigPrettier,
)
```
> 충돌하는 스타일룰을 끈다. 현재 스타일룰 0이라 즉효는 미미하나 미래 가드. `/flat` 서브패스(v10.1.1+)는 config-inspector용 `name` 부여.

**`package.json` scripts** (추가):
```json
"format": "prettier --write .",
"format:check": "prettier --check ."
```

### 3. husky + lint-staged

설치: `npm i -D husky lint-staged` → `npx husky init`(자동으로 `"prepare":"husky"` + `.husky/` + 샘플 pre-commit 생성 — **결과 `package.json` 확인**).

**`.husky/pre-commit`** (본문 전체 — v9 형식, shebang/`husky.sh` 보일러플레이트 없음):
```
npx --no-install lint-staged
```
> `--no-install`: lint-staged는 항상 devDep이므로 레지스트리 fetch 차단(미설치 시 조용히 받지 않고 loud fail).

**`package.json` lint-staged** (추가):
```json
"lint-staged": {
  "*.{ts,tsx,js,mjs,cjs}": ["prettier --write", "eslint --fix --no-warn-ignored"],
  "*.{json,css,yml,yaml,html}": ["prettier --write"]
}
```
> 배열=순차(prettier→eslint). `--no-warn-ignored`: eslint가 `*.config.*`를 ignore하므로, config `.ts`를 stage 시 "File ignored" 경고 발생(검증: exit 0이라 커밋은 안 깨지나 노이즈 + 향후 `--max-warnings 0` 도입 시 깨짐) → 선제 억제. lint-staged는 매치된 staged 절대경로를 명령 끝에 append하므로 명령에 glob 금지. `.prettierignore` 대상(package-lock·md 등)은 명시 전달돼도 prettier가 skip.

### 4. CI (`.github/workflows/ci.yml`)

- 두 잡(`quality`·`windows-tests`)의 `setup-node`: `node-version: '22'` → **`node-version-file: '.nvmrc'`** (단일출처).
- `quality` 잡: `Lint` 뒤에 스텝 추가:
  ```yaml
  - name: Format check (prettier)
    run: npm run format:check
  ```
- 두 잡: `env: HUSKY: 0` 추가(`npm ci` 시 husky 셋업 skip — 공식 권장, 무해).

## 구현 순서 (커밋 분리 — squash 머지)

> #27 절차상 squash 머지 → 중간 커밋 CI 상태는 무관(PR head·squash 결과만 게이트). 노이즈 큰 리포맷을 분리해 리뷰 용이성 확보.

1. **EOL 정규화**: `.gitattributes`(`* text=auto eol=lf` + `.husky/** text eol=lf`) + `git add --renormalize .`. index가 이미 LF라 내용 churn ≈ 0 확인.
2. **Node 핀**: `.nvmrc`·`engines`·`.npmrc` + CI `node-version-file`. `npm ci`로 engine-strict 통과 검증.
3. **Prettier 셋업**: deps + `.prettierrc.json`·`.prettierignore`·eslint 배선·format 스크립트 + CI `format:check` 스텝 (리포맷 전).
4. **전체 리포맷**: `npm run format` (커밋 단독 — 기계적 변경).
5. **husky + lint-staged**: deps + `npx husky init` + `.husky/pre-commit`·lint-staged 설정·`prepare` + CI `HUSKY: 0`.

## 검증 계획

설정 전용 변경 → 신규 vitest 테스트 없음(AGENTS.md TDD 범위 = 코어 변경). 검증 = 게이트 + 스모크:

- **게이트 4종 green**: `npm run typecheck` · `npm run lint` · `npm test`(기존 790 유지) · `npm run build`.
- **`npm run format:check` clean** (리포맷 후 0 diff).
- **`npm ci` 성공** (engine-strict, dev Node 24).
- **훅 스모크**: ① 오포맷 `.ts` stage → `git commit` → prettier가 자동수정·재스테이지 후 커밋 성공. ② 수정불가 lint 에러 stage → 커밋 차단(non-zero). ③ `git commit --no-verify`로 우회 가능 확인.

## 리스크 / 트레이드오프

- **리포맷 diff 규모**: 101 TS/TSX 파일에 걸쳐 수천 줄(기계적). 커밋 4로 격리, 리뷰는 "기계적"으로 처리. Prettier 설정을 기존 스타일(no-semi·single-quote)에 맞춰 churn 최소화.
- **engine-strict 미래 서프라이즈**: 차후 dep이 엔진 바닥을 올리면 `npm ci`가 실패할 수 있음(유용한 신호이기도). `.npmrc` 한 줄 제거로 즉시 advisory 회귀.
- **stale 로컬 22.x**: 기여자가 이미 설치된 22.0~22.12에서 `nvm use`(=.nvmrc `22`가 그 구버전 선택)하면 engine-strict EBADENGINE. 에러 메시지가 명확하고 `nvm install 22`(최신 22.x 재설치)로 자가해결 — 드물고 회복 쉬움.
- **Windows 훅 실행**: husky v9 훅은 Git for Windows의 `sh.exe`로 실행(터미널 커밋 OK). GUI git 클라이언트는 PATH 누락 가능(`~/.config/husky/init.sh`로 해결) — dev는 터미널 사용이라 비해당.
- **`template.html`**: 템플릿 문법 시 Prettier가 훼손 가능 → 구현 중 검토·필요시 ignore.

## 비범위 (Out of scope)

- **Markdown 포맷**(47개 한글 prose 문서): 의도적 제외. Prettier가 proseWrap:preserve여도 구조(표·리스트·헤딩)를 재정렬해 churn/가독성 리스크. 차후 별도 opt-in.
- **pre-push 훅**(typecheck/test): 전체프로젝트·느림 → CI 위임.
- **`devEngines` 필드**: engine-strict로 충분, 미도입.

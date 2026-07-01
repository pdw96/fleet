# #180 코어 커버리지 floor + Node24 CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `src/main/core/**` v8 커버리지 floor 를 `verify` 게이트로 강제하고, 출하 런타임(Node 24) 회귀를 잡는 advisory CI 잡을 추가한다.

**Architecture:** vitest v4 `coverage.thresholds`(전역 4메트릭)로 코어 커버리지 회귀 backstop 을 세우고, `test:coverage` 스크립트를 `verify` 에 접어 로컬==ubuntu CI 를 동일 강제(#175). Node24 는 matrix 대신 별도 잡으로 required status check 이름을 보존한다.

**Tech Stack:** vitest 4.1.9 · `@vitest/coverage-v8`(v8 provider) · GitHub Actions(ubuntu/node24) · npm scripts.

## Global Constraints

- **신규 runtime dep 0** — devDependency `@vitest/coverage-v8@^4.1.9` 1개만 추가.
- **required CI check 이름 `typecheck · lint · test · build` 불변** — `quality` 잡에 matrix 금지(체크명 분기 → required check 소멸 → PR 영구 블록).
- **워크플로 액션은 SHA 핀 + `persist-credentials: false`**(#137). 신규 잡은 기존 잡의 pinned SHA 를 그대로 재사용.
- **커버리지 범위 = `src/main/core/**` 한정**(렌더러 UI 제외).
- **수동 ratchet 만** — `coverage.thresholds.autoUpdate` 미사용.
- **`verify` = 로컬==CI 단일 집계**(#175) — coverage 강제는 `verify` 안에서.
- `.nvmrc`=22.22.3 유지(dev floor). `.gitignore` 는 이미 `coverage/` 포함 → 변경 불요.
- Node 실측: `src/main/core/**`(Windows/전 테스트) Lines 94.8 · Stmts 93.19 · Funcs 93.03 · Branches 86.05. ubuntu 는 win32 skipIf 로 더 낮을 수 있음(§Task 3 calibration).

---

### Task 1: 코어 커버리지 floor 게이트 (dep + config + verify 배선 + 문서)

**Files:**
- Modify: `package.json` (devDep · `test:coverage` 스크립트 · `verify` 교체)
- Modify: `package-lock.json` (devDep lock — `npm install` 자동)
- Modify: `vitest.config.ts` (coverage 블록)
- Modify: `AGENTS.md:27` + 품질 게이트 섹션(ratchet/Node24 노트)
- (No change: `.gitignore` 는 이미 `coverage/` 포함)

**Interfaces:**
- Produces: npm 스크립트 `test:coverage`(= `vitest run --coverage`) · `verify` 가 이를 호출 · `vitest.config.ts` `test.coverage.thresholds` 전역 4메트릭.

- [ ] **Step 1: `@vitest/coverage-v8` devDep 설치**

Run:
```bash
npm install --save-dev @vitest/coverage-v8@^4.1.9
```
Expected: `package.json` `devDependencies` 에 `"@vitest/coverage-v8": "^4.1.9"` 추가, `package-lock.json` 갱신. 종료코드 0.

- [ ] **Step 2: `test:coverage` 스크립트 추가**

`package.json` `scripts` 에 `test:watch` 아래 한 줄 추가:
```json
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest",
```
(`test` 는 coverage-free 유지 — watch/빠른 반복·windows CI 잡용.)

- [ ] **Step 3: (RED) coverage 블록을 의도적으로 높은 임계로 추가**

`vitest.config.ts` 전체를 아래로 교체 — `thresholds.lines` 를 **의도적으로 99**(현재치 94.8 초과)로 두어 강제가 실제 동작함을 입증:
```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // 기본은 node. 렌더러 컴포넌트 테스트는 파일 상단 `@vitest-environment jsdom` 도크블록으로 전환.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // 순수 TS 코어만 floor 강제(렌더러 UI 는 별개 성숙도). 회귀 backstop 이지 100% ratchet 아님.
      include: ['src/main/core/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts'],
      all: true,
      thresholds: { lines: 99, statements: 88, functions: 88, branches: 80 },
    },
  },
})
```

- [ ] **Step 4: (RED) coverage 강제가 fail 하는지 확인**

Run:
```bash
npm run test:coverage
```
Expected: **FAIL** — 테스트는 전부 통과하나 말미에 `ERROR: Coverage for lines (94.8%) does not meet global threshold (99%)` 류 메시지 + 종료코드 1.

- [ ] **Step 5: (GREEN) floor 를 보수 초기값으로 하향**

`vitest.config.ts` `thresholds` 줄만 교체:
```ts
      thresholds: { lines: 90, statements: 88, functions: 88, branches: 80 },
```

- [ ] **Step 6: (GREEN) coverage 통과 확인**

Run:
```bash
npm run test:coverage
```
Expected: **PASS** — 커버리지 summary(Lines ~94.8% 등) 출력, threshold 에러 없음, 종료코드 0.

- [ ] **Step 7: `verify` 에 coverage 접기**

`package.json` `verify` 스크립트의 `npm test` 를 `npm run test:coverage` 로 교체:
```json
    "verify": "npm run skills:lint && npm run brain:check && npm run format:check && npm run typecheck && npm run lint && npm run test:coverage && npm run build",
```

- [ ] **Step 8: AGENTS.md 갱신 (test 라인 + ratchet/Node24 정책)**

(8a) `AGENTS.md` 품질 게이트 주석 블록의 `test` 라인 교체:
```
#   test:coverage   vitest --coverage — 코어 단위/통합 + src/main/core/** 커버리지 floor(헤드리스)
```
(8b) `npm run test:e2e ... 수동 실행.` 문단 바로 아래에 문단 추가:
```
**커버리지 floor**: `test:coverage` 가 `src/main/core/**` 전역 4메트릭 floor(회귀 backstop)를 강제한다.
커버리지가 유의하게 오르면 `vitest.config.ts` 의 `coverage.thresholds` 를 수동 상향(ratchet) — `autoUpdate`
는 config 자가변경 churn 회피 위해 미사용. **Node24 smoke**: 출하 런타임(Electron 42=Node 24) 회귀는
advisory `test-node24` 잡(ubuntu·node24·`npm test`)이 잡는다(required 아님 — required check 이름 보존).
```

- [ ] **Step 9: 전 게이트 green 확인**

Run:
```bash
npm run verify
```
Expected: **PASS** — skills:lint·brain:check·format:check·typecheck·lint·test:coverage(커버리지 통과)·build 전부 통과, 종료코드 0.

- [ ] **Step 10: 커밋**

```bash
git add package.json package-lock.json vitest.config.ts AGENTS.md
git commit -m "feat(#180): 코어 커버리지 floor 를 verify 에 강제 (v8·전역 4메트릭·수동 ratchet)

Part of #180"
```

---

### Task 2: CI Node24 advisory 잡

**Files:**
- Modify: `.github/workflows/ci.yml` (신규 `test-node24` 잡)

**Interfaces:**
- Consumes: 기존 잡의 pinned SHA(`actions/checkout@9c091bb…` · `actions/setup-node@48b55a…`).
- Produces: advisory CI 잡 `test-node24`(node24 `npm test`). required 아님.

- [ ] **Step 1: `test-node24` 잡 추가**

`.github/workflows/ci.yml` 의 `windows-tests` 잡 끝(마지막 `run: npm test` 라인) **다음**, 파일 말미 `# NOTE: E2E…` 주석 **앞**에 삽입:
```yaml

  # 출하 런타임 = Electron 42 = Node 24 인데 .nvmrc/CI 기본은 Node 22(dev floor). 이 잡이 Node 24 에서
  # vitest 를 돌려 출하 런타임 고유 회귀를 smoke 한다. matrix 를 quality 잡에 걸면 required check 이름
  # (`typecheck · lint · test · build`)이 `... (22)`/`... (24)` 로 분기해 사라지므로, 별도 잡으로
  # required check 를 보존한다(advisory — required 아님).
  test-node24:
    name: node24 vitest (출하 런타임 smoke)
    runs-on: ubuntu-latest
    env:
      HUSKY: 0
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
        with:
          persist-credentials: false

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: '24'
          cache: npm

      - name: Install
        run: npm ci
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'

      - name: Test (vitest — Node 24 출하 런타임 회귀)
        run: npm test
```

- [ ] **Step 2: 로컬 게이트 확인 (SHA 핀·포맷)**

Run:
```bash
npm run skills:lint && npm run format:check
```
Expected: **PASS** — `skills:lint` 가 신규 잡의 액션 SHA 핀을 검증 통과(#137), `format:check` 가 yaml 포맷 통과. 종료코드 0. (실 node24 실행은 Task 3 의 PR CI 에서 검증.)

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(#180): Node24 출하 런타임 smoke 잡 추가 (advisory·required check 이름 보존)

Part of #180"
```

---

### Task 3: 푸시 · PR · 첫 CI 실측으로 floor 확정

**Files:**
- Modify: `vitest.config.ts` (floor 조정 — 필요 시)

**Interfaces:**
- Consumes: `quality` 잡의 ubuntu coverage summary(첫 CI run).
- Produces: 확정된 `coverage.thresholds`(ubuntu 실측 ~2pt 아래).

- [ ] **Step 1: 브랜치 푸시**

```bash
git push -u origin feat/180-core-coverage-node24-ci
```
Expected: 원격 브랜치 생성.

- [ ] **Step 2: PR 생성**

```bash
gh pr create --title "feat(#180): 코어 커버리지 floor + Node24 CI" --body "$(cat <<'EOF'
Closes #180

#174 트리오(PR #179)에서 분리된 잔여 2항목.

## 변경
- `src/main/core/**` v8 커버리지 floor(전역 4메트릭·수동 ratchet)를 `verify` 에 접어 로컬==ubuntu CI 동일 강제(#175). `windows-tests` 는 coverage-free 유지.
- CI `test-node24` advisory 잡 추가(출하 런타임 Node 24 smoke) — matrix 대신 별도 잡으로 required check 이름(`typecheck · lint · test · build`) 보존.
- devDep `@vitest/coverage-v8` 1개, 신규 runtime dep 0.

## 설계·근거
- 스펙: `docs/superpowers/specs/2026-07-01-issue180-coverage-node24-design.md`
- 계획: `docs/superpowers/plans/2026-07-01-issue180-coverage-node24.md`
- Codex 설계 체크포인트: #180 comment-4853557900

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL 반환.

- [ ] **Step 3: 첫 CI 대기 · ubuntu coverage 실측 확인**

Run(잡 완료까지 폴링):
```bash
gh pr checks --watch
gh run view --log --job "$(gh run list --branch feat/180-core-coverage-node24-ci --limit 1 --json databaseId -q '.[0].databaseId')" 2>/dev/null | grep -iE 'Coverage (summary|for)|Lines|Statements|Functions|Branches|threshold' | head -20
```
Expected: `quality` 잡 로그의 coverage summary(ubuntu 수치). win32 skipIf 로 Windows 측정치(94.8 등)보다 낮을 수 있음.

- [ ] **Step 4: floor 확정 (필요 시 조정)**

판정:
- ubuntu 각 메트릭이 현재 floor(L90/S88/F88/B80)보다 **높으면**: 그대로 두거나 각 메트릭을 ubuntu 실측 ~2pt 아래로 소폭 상향(회귀 민감도↑).
- ubuntu 어느 메트릭이 floor보다 **낮아 `quality` 잡이 red 면**(win32 코드 대량 uncovered): 해당 임계를 ubuntu 실측 ~2pt 아래로 하향.

조정 시 `vitest.config.ts` `thresholds` 편집 후:
```bash
npm run test:coverage   # 로컬(Windows) green 재확인
git add vitest.config.ts
git commit -m "test(#180): coverage floor 를 첫 ubuntu CI 실측 ~2pt 아래로 확정

Part of #180"
git push
```
Expected: 조정 후 `quality` 잡 green. (조정 불요 시 이 스텝 skip.)

- [ ] **Step 5: 봇 리뷰 대기·반영 (Codex + CodeRabbit)**

- PR open 후 Codex·CodeRabbit 자동 리뷰 대기(메모리 `merge-requires-confirmation`). 인라인 스레드 반영·resolve. **fix 푸시마다 재리뷰로 새 스레드 추가 가능 → 매 푸시 후 unresolved 재확인.**
- Codex 봇이 "커밋했다"는 SHA 는 유령 가능(`codex-cloud-phantom-commits`) — `git cat-file`/`gh pr view` 로 검증 후 미존재면 직접 랜딩.

- [ ] **Step 6: 사용자 확인 후 squash 머지**

- 전 required check green(quality·windows) + advisory node24 확인 + 봇 스레드 resolve + 사용자 승인 후 squash. 머지 시 #180 자동 close(`Closes #180`).

---

## Self-Review

**1. Spec coverage** (스펙 §7 수용 기준 대조):
- devDep 추가·runtime dep 0 → Task 1 Step 1. ✅
- `test:coverage` 미달 시 fail(RED 입증)·baseline 통과 → Task 1 Step 3-6. ✅
- `verify` 가 coverage 강제·`windows-tests` `npm test` 유지 → Task 1 Step 7(verify) · Task 2(windows 잡 미변경). ✅
- `.gitignore` `/coverage` → 이미 존재(변경 불요, Global Constraints 명시). ✅
- `quality` 잡 이름 불변·`test-node24` advisory → Task 2. ✅
- 첫 ubuntu CI 실측 후 floor 확정 → Task 3 Step 3-4. ✅
- AGENTS.md ratchet 정책·`verify` green → Task 1 Step 8-9. ✅

**2. Placeholder scan:** TBD/TODO/"적절히 처리" 없음. 모든 코드 스텝에 완전한 코드·정확 명령·기대 출력 포함. ✅

**3. Type consistency:** 스크립트명 `test:coverage`·잡명 `test-node24`·`quality`·임계 키(lines/statements/functions/branches)가 전 태스크 일관. ✅

**주의(실행 함정):**
- Step 4(RED)는 lines 99 로 반드시 fail — 통과하면 coverage 미측정(config 오배선) 의심.
- `npm run test:coverage` 가 로컬 Windows 에선 POSIX skipIf 로 win32 대비 커버리지 분포가 다름 — floor 확정 권위는 **ubuntu CI**(Task 3).
- ci.yml 편집 후 반드시 `skills:lint` 통과(SHA 핀 미준수 시 #137 게이트 fail).

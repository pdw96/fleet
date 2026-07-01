# #180 테스트 하네스 커버리지 floor + CI Node24 (설계)

- **이슈**: #180 (tier:later, area:devx) — #174 트리오(PR #179)에서 분리된 잔여 2항목.
- **날짜**: 2026-07-01
- **상태**: 설계 — Codex 체크포인트 리뷰 ✅ (issue #180 [comment-4853557900](https://github.com/pdw96/fleet/issues/180#issuecomment-4853557900), 4개 결정 포인트 반론 없이 그대로 구현 = 검증; 단 샌드박스 커밋 `ea36ec5`·PR 은 **유령**[GitHub 미랜딩·테스트 미실행]이라 미채택 → 직접 TDD).
- **브랜치**: `feat/180-core-coverage-node24-ci`

## 1. 배경 / 문제

`tier:next` 부재로 tier:later 중 #180 선정(사용자 지시). 두 항목 모두 "테스트 하네스 성숙도"로, 한 PR 로 진행(응집·소규모).

1. **커버리지 측정 0** — `vitest.config.ts` 에 coverage 블록이 없어 삭제된 테스트/미커버 분기 회귀가 green 으로 통과.
2. **CI Node24 부재** — 출하 런타임 = Electron 42 = **Node 24**(메모리 `fleet-runtime-node-version`)인데 CI/`​.nvmrc` = Node 22 단일. Node24 고유 런타임 회귀를 CI 가 못 잡음.

## 2. 범위 결정

**포함 (이번 PR)**: (A) `src/main/core/**` v8 커버리지 floor + `verify` 강제, (B) 별도 advisory Node24 CI 잡.
**신규 runtime dep 0** (devDep `@vitest/coverage-v8` 1개).

## 3. Grounding (실측 2026-07-01)

- **현재 커버리지** (Windows / 전 테스트, `src/main/core/**` 테스트 제외):
  Lines **94.8%**(2846/3002) · Statements **93.19%**(3232/3468) · Functions **93.03%**(561/603) · Branches **86.05%**(2104/2445). 테스트 1296 passed / 19 skipped.
- **낮은 파일**: `registry.ts` 71 · `stdio.ts` 74 · `types.ts` 75 · `ignored-baseline.ts` 84 · `path-guard.ts` 86 · `kill-tree.ts` 91 · `detect.ts` 93 (나머지 95~100).
- **⚠️ 양방향 플랫폼 분기**: `describe.skipIf(process.platform !== 'win32')`(win32 전용)와 `describe.skipIf(process.platform === 'win32')`(POSIX 전용) 테스트가 **공존** — `path-guard.test.ts`·`ignored-baseline.test.ts`·`kill-tree.test.ts`·`detect.test.ts`. 따라서:
  - **ubuntu**(CI `quality` 잡 = 강제 지점): win32 junction/taskkill 경로 uncovered → Windows 측정치보다 **낮음**.
  - **Windows**: POSIX symlink 경로 uncovered.
  - 어느 단일 플랫폼도 100% 커버 불가 → **단일 측정치로 tight floor 잡으면 타 플랫폼 flaky**.
- vitest v4.1.9 coverage API (context7 `/vitest-dev/vitest/v4.1.6` 확인): `coverage.provider:'v8'` · `reporter` · `include`/`exclude`/`all` · `thresholds.{lines,functions,branches,statements}`(전역, 미달 시 run fail) · per-glob thresholds · `autoUpdate`(미사용) · `@vitest/coverage-v8` 필수 · 리포트 `./coverage/`.

## 4. 설계

### 항목 A — coverage floor

**A1. 의존성**: `@vitest/coverage-v8@^4.1.9` → `devDependencies`(vitest 4.1.9 major/minor 정합).

**A2. `vitest.config.ts`** `test.coverage` 신설:
```ts
coverage: {
  provider: 'v8',
  reporter: ['text', 'text-summary'],
  include: ['src/main/core/**/*.{ts,tsx}'],
  exclude: ['**/*.test.ts'],
  all: true,
  thresholds: { lines: 90, statements: 88, functions: 88, branches: 80 },
}
```
- `include` 을 `src/main/core/**` 로 한정 — 순수 TS 코어만 강제(렌더러 React UI 는 jsdom 컴포넌트 테스트 성숙도 별개, 범위 밖).
- `all: true` — 테스트가 import 안 한 코어 파일도 분모 포함 → 테스트 파일 통째 삭제 시 커버리지 급락으로 회귀 포착.
- `exclude: ['**/*.test.ts']` — 테스트 자신은 분자/분모서 제외(v8 는 include 로 이미 대부분 제외하나 명시).

**A3. floor 값 (보수적) + 확정 절차**:
- 초기값 **L90 / S88 / F88 / B80** — Windows 측정치(94.8/93.19/93.03/86.05) 대비 ~4-6pt 아래.
- **취지**: 플랫폼 분기(§3)로 ubuntu 수치가 Windows 보다 낮고, floor 는 "커버리지 붕괴(테스트 파일 삭제·모듈 통째 미테스트) 포착"이 목적인 **회귀 backstop**이지 100% ratchet 이 아니므로 플랫폼 min 아래로 잡아 flaky 회피.
- **확정**: TDD 중 **첫 ubuntu CI coverage 실측치**를 보고 각 메트릭을 그 **~2pt 아래**로 조정(GREEN 후 tighten). CI 수치가 초기 floor(90/88/88/80)보다 높으면 그대로 두거나 소폭 상향, 낮으면(win32 경로 대량) 그 아래로 하향.

**A4. 강제 배선** (`#175` local==CI 원칙):
- `package.json` `"test:coverage": "vitest run --coverage"` 신설.
- `verify` 체인의 `npm test` → `npm run test:coverage` 로 교체(테스트를 두 번 돌리지 않음 — coverage 실행이 곧 test 실행). 로컬 `npm run verify` 와 CI `quality` 잡이 byte-for-byte 동일 강제.
- `"test": "vitest run"` **유지**(coverage-free) — watch/빠른 반복 및 `windows-tests` CI 잡용.
- **`windows-tests` CI 잡은 `npm test` 유지**(coverage 미실행) — 플랫폼 분기로 win32 커버리지가 ubuntu 와 갈려 동일 floor 적용 시 flaky + 중복 비용. coverage 는 ubuntu `quality` 단일 강제.
- `.gitignore` 에 `/coverage` 추가.

**A5. 수동 ratchet 정책** — AGENTS.md 「품질 게이트」에 1줄: coverage floor 는 회귀 backstop, 커버리지가 유의하게 오르면 floor 를 수동 상향, `autoUpdate` 미사용(config 자가변경 churn 회피).

### 항목 B — CI Node24 (advisory 잡)

**B1. 제약**: master ruleset required status check 이름 = `typecheck · lint · test · build`(정확 일치, ci.yml `quality` 잡 표시명). `quality` 에 `strategy.matrix` 를 걸면 체크명이 `... (22)`/`... (24)` 로 분기 → **required check 소멸 → 모든 PR 영구 블록**(#174 spec §2 경고).

**B2. 접근** — matrix 대신 별도 잡:
- `quality`(ubuntu·node22[`.nvmrc`]·required·+coverage) **그대로** → required check 이름 보존.
- 신규 `test-node24`(ubuntu·**node 24**·`npm test`) — 출하 런타임(Electron 42=Node 24) 런타임 회귀 smoke. `permissions: contents: read`·`persist-credentials: false`·SHA-pinned actions(#137 정책)·`ELECTRON_SKIP_BINARY_DOWNLOAD:'1'`(vitest 는 electron 불필요, `windows-tests` 선례). node 24 는 `setup-node` `node-version: '24'`(`.nvmrc`=22 유지). **advisory**(required 아님 — ruleset 등재는 #98 트랙 별건).
- `npm test` 만 — typecheck/lint/format 은 node 버전 무관, build(esbuild/vite) 도 대체로 무관 → 최소 비용. coverage 미실행(커버리지는 완결성 게이트지 런타임 버전 게이트 아님).

**결과**: CI 3잡 — `quality`(ubuntu/node22, required, +coverage) · `windows-tests`(windows/node22) · `test-node24`(ubuntu/node24, 신규·advisory).

## 5. TDD 순서

1. **A1**: `@vitest/coverage-v8` devDep 추가(`npm install --save-dev`), `npm ci` 정합.
2. **A2 RED**: `vitest.config.ts` coverage 블록 추가 + `thresholds` 를 **의도적으로 현재치보다 높게**(예: lines 99) 설정 → `npm run test:coverage` 가 threshold 미달로 **fail**(강제가 실제 동작함을 입증).
3. **A3 GREEN**: floor 를 보수 초기값(L90/S88/F88/B80)으로 하향 → `npm run test:coverage` pass. (로컬 Windows 실측으로 우선 통과 확인.)
4. **A4**: `test:coverage` 스크립트 + `verify` 교체 + `test` 유지 + `.gitignore`. `npm run verify` green.
5. **A5**: AGENTS.md ratchet 정책 1줄.
6. **B**: `ci.yml` 에 `test-node24` 잡 추가. (로컬선 워크플로 문법만; 실 node24 실행은 PR CI 에서 검증.)
7. **최종 `npm run verify` green** + push → **첫 ubuntu CI coverage 실측 확인 → A3 floor 확정**(필요 시 조정 커밋).

## 6. 영향 파일 (신규 runtime dep 0)
- `package.json` (devDep `@vitest/coverage-v8` · `test:coverage` 스크립트 · `verify` 교체)
- `package-lock.json` (devDep lock)
- `vitest.config.ts` (coverage 블록)
- `.gitignore` (`/coverage`)
- `.github/workflows/ci.yml` (`test-node24` 잡)
- `AGENTS.md` (ratchet 정책 1줄)

## 7. 수용 기준
- [ ] `@vitest/coverage-v8` devDep 추가·lock 정합, 신규 runtime dep 0.
- [ ] `npm run test:coverage` 가 `src/main/core/**` 전역 thresholds(4메트릭) 미달 시 fail(RED 로 입증), 현 baseline 통과.
- [ ] `verify` 가 `npm run test:coverage` 로 coverage 를 강제(로컬==ubuntu CI). `windows-tests` 는 `npm test` 유지.
- [ ] `.gitignore` 가 `/coverage` 무시.
- [ ] `ci.yml` `quality` 잡 표시명 `typecheck · lint · test · build` **불변**(required check 보존). `test-node24` 잡이 node 24 로 `npm test` 실행(advisory).
- [ ] 첫 ubuntu CI coverage 실측 후 floor 를 그 ~2pt 아래로 확정(green 유지).
- [ ] AGENTS.md 에 수동 ratchet 정책 명시. `npm run verify` 전 게이트 green.

## 8. Out of scope
- 렌더러 React 컴포넌트 커버리지(jsdom 성숙도 별개) · per-file/per-glob threshold(전역 1세트로 충분) · `autoUpdate` ratchet(config 자가변경 회피) · Node24 required check 등재(#98 ruleset 트랙) · windows/mac CI Node24 matrix(비용, 필요 시 후속) · lcov/html 리포터 업로드(Codecov 등 외부 서비스 미도입).

## 9. 참조
- Codex 체크포인트: issue #180 comment-4853557900 (설계 그대로 구현·반론 0; 커밋/PR 은 유령).
- #174 spec `docs/superpowers/specs/2026-06-30-issue174-harness-maturity-trio-design.md` §2·§8 (분리 근거).
- #175 PR#178 — `verify` 단일 집계(로컬==CI drift 방지) 원칙.
- #137 — workflow SHA 핀·`persist-credentials:false` 정책.
- 메모리: `fleet-runtime-node-version`(출하=Node24) · `codex-cloud-phantom-commits`(유령 커밋 검증) · `fleet-ci-format-check-prettier-version`.

# #173 하네스 강제화 — 코어 순수성·FLEET_E2E 가드 기계적 게이트 (설계)

- 이슈: [#173](https://github.com/pdw96/fleet/issues/173) (parent #27) · 라벨 `area:devx`·`area:electron`·`type:security`·`tier:next`
- 출처: 2026-06-30 하네스 엔지니어링 렌즈 작업-하네스 감사(P1 #1/#5)
- 설계 체크포인트 독립 리뷰: [#173 issuecomment-4840881317](https://github.com/pdw96/fleet/issues/173#issuecomment-4840881317) → Codex 봇 긍정(사각 0). _Codex 의 구현/커밋/PR(`8121770`)은 phantom(미랜딩) 으로 실측 확인 → 구현은 본 절차로 직접 수행._

## 문제

AGENTS.md 「Fleet 특화 P1 신호」 중 **기계적 강제가 0인** 두 건. CI 4게이트·tsc 전부 통과하므로 Codex/사람 리뷰가 유일 백스톱(가이드 스스로 약한 백스톱이라 명시). 두 신호 모두 **현재 위반 0건** — 따라서 동작 변경이 아니라 **회귀 가드 추가**다.

### 사전 조사 (코드 실측)
- `src/main/core/**` 에 `from 'electron'`·DOM 전역(`window.`/`document.`) **현재 0건**(grep).
- `eslint.config.mjs` 에 `no-restricted-imports`/`no-restricted-globals` **전무**.
- `src/main/index.ts` 의 E2E 판정 술어가 **두 곳에서 불일치**:
  - `:56` `process.env['FLEET_E2E'] === '1'` — 페이크 러너 주입.
  - `:234` `process.env['FLEET_E2E'] === '1' || !!process.env['FLEET_SMOKE']` — auto-update `isE2E`.
  - → 단일 헬퍼로 통합 불가. `FLEET_E2E` 술어만 헬퍼로 핀하고, `FLEET_SMOKE` OR 는 호출부에 유지(별도 스모크-모드 의미).
- `src/main/index.ts:2` 가 `electron` 을 직접 import → vitest 스코프 밖. 헬퍼는 electron-free `src/main/e2e.ts`(node + core import만)로 추출해야 단위 테스트 가능.
- 부가: `AGENTS.md:50` 산문이 `(src/main/index.ts:38)` 을 가리키나 실제는 `:56` (**stale 주소**).

## 비목표 (YAGNI)
- vitest fitness 텍스트 스캔 게이트(대안) — ESLint AST 가 import/global 을 더 정확히 잡으므로 병행하지 않는다.
- `FLEET_SMOKE` 술어를 별도 헬퍼로 추출 — 자명 truthy 체크라 핀 가치 낮음.
- 코어의 다른 순수성 차원(노드 내장 외 부수효과 등) — 이슈 범위 밖.

## 변경

### 변경 1 — P1 #1: 코어 순수성 ESLint 게이트
`eslint.config.mjs` 의 `eslintConfigPrettier`(반드시 last) **앞**에 스코프 블록 추가:
- `files: ['src/main/core/**/*.ts']`
- `no-restricted-imports`(error): `paths: ['electron']` + `patterns: ['electron/*']`.
  - `electron-updater` 는 slash 없어 비대상(정상). type-only import 도 차단(electron 결합 방지).
- `no-restricted-globals`(error): `window`, `document`.
  - 값 참조만 차단(`typeof window` 타입참조·`globalThis` Node 전역 무영향). `src/main/core/**` 에만 스코프되어 렌더러/jsdom 인접 파일 무영향.
- core `*.test.ts` 도 스코프에 포함(의도) — 테스트도 electron/DOM 결합을 정상화하지 않는다. core 테스트는 Node/test 전역을 import 로 쓰므로 영향 없음.

### 변경 2 — P1 #5: `isE2EActive` 헬퍼 추출 + 단위테스트
- `src/main/e2e.ts` 에 추가:
  ```ts
  /** E2E 활성화는 FLEET_E2E === '1' 일 때만(엄격 핀). 그 외 값은 프로덕션 경로. */
  export function isE2EActive(env: NodeJS.ProcessEnv): boolean {
    return env['FLEET_E2E'] === '1'
  }
  ```
- `src/main/e2e.test.ts`(기존 파일에 describe 추가): `'1'`→true; `''`/`'0'`/`'false'`/`'TRUE'`/`undefined`→false.
- `src/main/index.ts`:
  - import 추가: `isE2EActive` (기존 `'./e2e'` import 에 합류).
  - `:56` → `const e2e = isE2EActive(process.env)`.
  - `:234` → `isE2E: isE2EActive(process.env) || !!process.env['FLEET_SMOKE']`.

### 부수 정리 (scope 내)
- `AGENTS.md:50` 의 stale 주소 `(src/main/index.ts:38)` → `isE2EActive`(`src/main/e2e.ts`) 참조로 갱신.

## 테스트 전략 (TDD)
- **헬퍼**: `e2e.test.ts` 를 먼저 작성(RED — 함수 미존재) → `isE2EActive` 구현(GREEN).
- **ESLint 규칙**: 규칙 추가 후, core 파일에 `import { app } from 'electron'`·`window.x` 임시 삽입 → `npm run lint` red 확인 → 제거(규칙 작동 입증).
- **회귀 안전**: 기존 테스트·`index.ts` 동작 불변(헬퍼는 술어 동치).

## 검증 / 수용 기준
- 게이트: `typecheck` · `lint` · `test` · `build` (로컬 4종) + `format:check` · `skills:lint` (CI 추가 2종) 전부 green.
- 수용 기준(이슈): 두 위반을 의도적으로 심으면 `npm run lint` 또는 `npm test` 가 red.
- PR 전 적대 리뷰(자체 다렌즈 또는 Codex 봇).

## 영향 / 위험
- 동작 불변(현 위반 0). 위험 표면은 ESLint 설정 오작성(과·소 차단) 한정 → RED 입증으로 방어.
- 파일: `eslint.config.mjs`, `src/main/e2e.ts`(+test), `src/main/index.ts`, `AGENTS.md`. 모두 작은 국소 변경.

## 적대 리뷰 반영 (2026-06-30, 5렌즈 find→refute)

17 findings 중 5 confirmed → 전부 반영(receiving-code-review 검증 후):

- **동적 `import('electron')` 미차단 [medium]**: ESLint `no-restricted-imports` 는 `ImportExpression` 을 미방문(정적 import·`import type`·`require`만 차단)하고 TS 도 electron 타입 보유라 컴파일 통과 → 백스톱 부재. `no-restricted-syntax` 로 `ImportExpression[source.value='electron']`·`[source.value=/^electron\//]` 차단 추가.
- **`globalThis.window` 멤버 우회 [low]**: `no-restricted-globals` legacy 위치배열 form 은 `checkGlobalObject` 가 false 고정 → object form(`{globals:[…], checkGlobalObject:true}`)으로 전환(메시지 유지). TS(DOM lib 부재)가 이미 1차 백스톱이나 defense-in-depth.
- **게이트 자체 fitness 테스트 부재 [medium]**: core 블록을 통째 삭제하거나 `error`→`warn` 약화해도 lint green(현 위반 0·`--max-warnings` 미사용)이라 무신호. `scripts/eslint-config-purity.test.ts` 로 config 객체 형태(규칙 존재·`error` severity·핵심 옵션)를 단언(zero-dep). isE2EActive 와 동일한 테스트 철학을 게이트에도 적용.
- **spec/plan 'Create' 오기재 [low]**: `e2e.test.ts` 는 기존 파일(e2eRunner 테스트) → 'Modify' 로 정정(구현은 처음부터 append 로 올바름).
- _refuted 12건_: require('electron')(=no-require-imports 가 이미 차단)·.tsx/.mts 글롭 누락(현 0건·core 에 비현실)·기타 DOM 전역(TS DOM lib 부재로 컴파일 차단)·동치 검증 통과·생성 산출물 fleet-analysis.html stale(untracked·PR 범위 밖) 등 — 근거는 워크플로 결과에 보존.

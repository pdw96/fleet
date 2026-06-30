# #173 하네스 강제화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AGENTS.md P1 신호 두 건(코어 Electron/DOM-free · FLEET_E2E 가드)을 산문에서 기계적 게이트로 승격한다.

**Architecture:** 동작 변경 없음(현 위반 0). (1) `eslint.config.mjs` 에 `src/main/core/**` 스코프 `no-restricted-imports`/`no-restricted-globals` 규칙으로 회귀 가드. (2) `index.ts` 의 `FLEET_E2E === '1'` 술어를 electron-free `e2e.ts` 의 `isE2EActive(env)` 로 추출해 단위 테스트로 핀.

**Tech Stack:** TypeScript, ESLint(flat config, typescript-eslint), Vitest. 새 dependency 0(zero-dep).

## Global Constraints

- Node engines: `>=22.22.1 <23 || >=24` (출하 런타임 = Electron Node 24). 새 의존성 추가 금지.
- 주석·ESLint message 는 레포 컨벤션대로 한국어.
- 품질 게이트: `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` + CI 추가 `npm run format:check` · `npm run skills:lint` 전부 green.
- `eslint.config.mjs` 에 절대경로(`C:\Users\...`)·사용자명 리터럴 금지(skills:lint BANNED_PATTERNS).
- `eslintConfigPrettier` 는 반드시 config 배열의 **last**(prettier 충돌 비활성 보장).

---

### Task 1: `isE2EActive` 헬퍼 추출 + 단위테스트 + 배선

**Files:**
- Modify: `src/main/e2e.ts` (헬퍼 추가)
- Modify: `src/main/e2e.test.ts` (기존 e2eRunner 테스트에 isE2EActive describe 블록 추가 — 기존 블록 보존)
- Modify: `src/main/index.ts:22` (import), `:56`, `:234`
- Modify: `AGENTS.md:50` (stale 주소)

**Interfaces:**
- Produces: `isE2EActive(env: NodeJS.ProcessEnv): boolean` — `env['FLEET_E2E'] === '1'` 일 때만 true. (`src/main/e2e.ts` export)

- [ ] **Step 1: 실패 테스트 작성** — `src/main/e2e.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { isE2EActive } from './e2e'

describe('isE2EActive — FLEET_E2E 엄격 핀', () => {
  it("정확히 '1' 일 때만 활성", () => {
    expect(isE2EActive({ FLEET_E2E: '1' })).toBe(true)
  })

  it.each(['', '0', 'false', 'TRUE', 'yes', '2', ' 1', '1 '])(
    '느슨한 값은 비활성: %j',
    (v) => {
      expect(isE2EActive({ FLEET_E2E: v })).toBe(false)
    },
  )

  it('FLEET_E2E 미설정(undefined)은 비활성', () => {
    expect(isE2EActive({})).toBe(false)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/e2e.test.ts`
Expected: FAIL — `isE2EActive` is not exported / not a function.

- [ ] **Step 3: 헬퍼 구현** — `src/main/e2e.ts` 의 import 블록 바로 아래(파일 상단, `e2eRunner` export 전)에 추가

```ts
/**
 * E2E 활성화는 FLEET_E2E === '1' 일 때만(엄격 핀). `0`/`false`/빈 값/대소문자 변형은
 * 모두 프로덕션 경로 — 이 술어가 느슨해지면 페이크 러너(영구 in-flight)·E2E 픽스처가
 * 프로덕션 런치로 샌다(AGENTS.md 「Fleet 특화 P1 신호」). 순수 함수라 단위 테스트로 핀.
 */
export function isE2EActive(env: NodeJS.ProcessEnv): boolean {
  return env['FLEET_E2E'] === '1'
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run src/main/e2e.test.ts`
Expected: PASS (10 케이스).

- [ ] **Step 5: `index.ts` 배선** — 3곳 수정

`src/main/index.ts:22` import 에 `isE2EActive` 합류:

```ts
import { e2eRunner, isE2EActive, seedE2eFixtures } from './e2e'
```

`src/main/index.ts:56` (주석 유지, 술어만 헬퍼로):

```ts
  const e2e = isE2EActive(process.env)
```

`src/main/index.ts:234`:

```ts
    isE2E: isE2EActive(process.env) || !!process.env['FLEET_SMOKE'],
```

- [ ] **Step 6: AGENTS.md stale 주소 갱신** — `AGENTS.md:50` 의 `(src/main/index.ts:38)` 를 헬퍼 참조로 교체

기존(주소가 drift):
```
- **E2E 활성화는 `FLEET_E2E === '1'` 일 때만.** (`src/main/index.ts:38`) `0`/`false`/빈 값은
```
변경:
```
- **E2E 활성화는 `FLEET_E2E === '1'` 일 때만.** (`isE2EActive` — `src/main/e2e.ts`) `0`/`false`/빈 값은
```

- [ ] **Step 7: 게이트 — typecheck·lint·test**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 전부 PASS(신규 테스트 포함, 기존 회귀 0).

- [ ] **Step 8: 커밋**

```bash
git add src/main/e2e.ts src/main/e2e.test.ts src/main/index.ts AGENTS.md
git commit -m "feat(#173): FLEET_E2E 술어를 isE2EActive 헬퍼로 추출·단위테스트 핀"
```

---

### Task 2: 코어 순수성 ESLint 게이트

**Files:**
- Modify: `eslint.config.mjs` (`eslintConfigPrettier` 앞에 스코프 블록 추가)

**Interfaces:**
- Consumes: 없음(설정 변경). 검증 대상 = `src/main/core/**/*.ts`.

- [ ] **Step 1: ESLint 스코프 블록 추가** — `eslint.config.mjs` 에서 `eslintConfigPrettier`(현재 마지막 줄) **바로 앞**에 삽입

```js
  // 코어 순수성 게이트(AGENTS.md 「Fleet 특화 P1 신호」 #1): src/main/core 는 electron/DOM-free
  // 순수 TS 계약. 한 줄의 electron import·DOM 전역도 4게이트를 통과하므로(현 위반 0=관례일 뿐)
  // 회귀를 기계적으로 차단한다. core *.test.ts 도 포함 — 테스트도 결합을 정상화하지 않는다.
  {
    files: ['src/main/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '코어(src/main/core)는 electron-free 여야 한다(AGENTS.md P1). Electron 의존은 어댑터 계층으로 분리하라.',
            },
          ],
          patterns: [
            {
              group: ['electron/*'],
              message: '코어는 electron-free 여야 한다(AGENTS.md P1). electron 하위경로 import 금지.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: '코어는 DOM-free 여야 한다(AGENTS.md P1). 렌더러 전역 window 금지.' },
        {
          name: 'document',
          message: '코어는 DOM-free 여야 한다(AGENTS.md P1). 렌더러 전역 document 금지.',
        },
      ],
    },
  },
```

- [ ] **Step 2: 게이트 green 확인(기존 코어 무위반)**

Run: `npm run lint`
Expected: PASS — 현 `src/main/core/**` 위반 0(사전 grep 확인 완료).

- [ ] **Step 3: RED 입증 — import 위반 임시 삽입**

`src/main/core/engine.ts` 최상단에 임시 한 줄 추가:
```ts
import { app } from 'electron'
```

Run: `npm run lint`
Expected: FAIL — `no-restricted-imports` electron 메시지. (전역도 함께 확인하려면 `app` 미사용 경고 외 restricted-imports error 가 떠야 함.)

- [ ] **Step 4: RED 입증 — DOM 전역 위반 임시 삽입**

위 import 줄을 제거하고, 대신 `src/main/core/engine.ts` 의 아무 함수 본문에 임시 한 줄:
```ts
  void window
```

Run: `npm run lint`
Expected: FAIL — `no-restricted-globals` window 메시지.

> **Fallback (Step 4 가 red 안 될 때)**: ESLint `no-restricted-globals` 는 환경 globals 에 선언된 전역만 본다. 이 레포는 node 환경이라 `window`/`document` 가 globals 목록에 없으면 규칙이 침묵할 수 있다. 그 경우 `no-restricted-globals` 를 빼고 `no-restricted-syntax` 로 전환한다(AST 식별자 직접 매칭, 환경 무관):
> ```js
> 'no-restricted-syntax': [
>   'error',
>   { selector: "Identifier[name='window']", message: '코어는 DOM-free 여야 한다(AGENTS.md P1).' },
>   { selector: "Identifier[name='document']", message: '코어는 DOM-free 여야 한다(AGENTS.md P1).' },
> ],
> ```
> 단 `no-restricted-syntax` Identifier 매칭은 동명 프로퍼티/지역변수까지 걸 수 있으니, core 전체 lint green 을 Step 2 에서 먼저 확인해 오탐 0 을 보장한 뒤 채택한다(현 core 에 `window`/`document` 식별자 0 = 사전 grep 확인).

- [ ] **Step 5: 임시 위반 제거 후 green 복구**

`engine.ts` 의 임시 줄을 모두 제거.

Run: `npm run typecheck && npm run lint && npm test && npm run format:check && npm run skills:lint`
Expected: 전부 PASS.

- [ ] **Step 6: 커밋**

```bash
git add eslint.config.mjs
git commit -m "feat(#173): 코어 순수성 ESLint 게이트 — src/main/core electron/DOM-free 강제"
```

---

## 수용 기준 (이슈 #173)
- core 파일에 `electron` import 또는 DOM 전역(`window`/`document`)을 의도적으로 심으면 `npm run lint` 가 red. (Task 2 Step 3·4 로 입증)
- `FLEET_E2E` 활성화 술어가 단위 테스트로 핀 — `'1'` 만 true. (Task 1)

## 완료 후
- 전체 게이트(typecheck·lint·test·build·format:check·skills:lint) 재확인.
- 적대 다렌즈 리뷰(자체 또는 Codex 봇) → PR(`Closes #173`) → Codex/CodeRabbit 리뷰 대기·반영 → 사용자 확인 후 squash.

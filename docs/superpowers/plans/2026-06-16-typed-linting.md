# typed-linting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `eslint.config.mjs` 에 타입인지(type-aware) 린팅을 추가하고 측정된 위반(src ~18 + auto-fix 17)을 전건 수정해 즉시 `error` 게이트로 착륙한다.

**Architecture:** `parserOptions.project` 배열(node/web/e2e tsconfig)로 타입정보를 공급(projectService 는 루트 tsconfig.json 부재로 불가 — 스펙 §검증). `recommendedTypeChecked` 를 `**/*.{ts,tsx}` 에 적용, JS/mjs 는 `disableTypeChecked`. `require-await` off(테스트 스텁 251/252), 테스트 파일 `no-unsafe-*` off. 나머지는 전건 수정.

**Tech Stack:** typescript-eslint ^8.10(설치본 8.60.1, 신규 dep 0), ESLint flat config, React/Electron.

**스펙:** `docs/superpowers/specs/2026-06-16-typed-linting-design.md`

**커밋 전략:** Task 1(config) 활성화 시 `npm run lint` 가 RED(게이트 작동 증명). Task 2~7 수정으로 0 으로 수렴. **Task 8 에서 4게이트 전부 녹색 확인 후 단일 커밋**(config+fixes 가 원자적 lint-gate 변경 — 중간 working-tree RED 는 정상, 커밋은 항상 녹색).

---

### Task 1: 타입인지 린팅 활성화 (config)

**Files:**
- Modify: `eslint.config.mjs`

- [ ] **Step 1: `eslint.config.mjs` 를 아래로 교체**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'build/**', 'node_modules/**', '*.config.*', '*.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // 타입인지 린팅: 타입정보가 필요한 룰(no-floating-promises·no-misused-promises·no-unsafe-* 등).
  // projectService 는 루트 tsconfig.json 을 찾는데 이 레포는 node/web/e2e 커스텀명이라 명시 project 배열을 쓴다.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json', './tsconfig.e2e.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // JS/mjs 는 tsconfig 비포함이라 타입정보 없음 → 타입인지 룰 비활성.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [...tseslint.configs.disableTypeChecked],
  },
  // 테스트 파일은 파싱 JSON·부분 fixture 를 의도적으로 다룬다 → unsafe-* 완화(src 는 strict 유지).
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    rules: {
      // TS 가 미정의 식별자를 검증하므로 core no-undef 는 끈다 (브라우저/노드 전역 오탐 방지).
      'no-undef': 'off',
      // async 스텁(테스트 목 251건)·인터페이스 충족 dispose 가 대부분 → 스타일 룰이라 끈다(버그탐지 0).
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
)
```

- [ ] **Step 2: lint 실행 — 게이트 작동(RED) 확인**

Run: `npm run lint`
Expected: FAIL. 남은 위반 = `no-misused-promises`(10)·`no-floating-promises`(1)·`no-unsafe-assignment`(3 src)·`no-unsafe-argument`(1)·`prefer-promise-reject-errors`(2)·`await-thenable`(2)·`no-unnecessary-type-assertion`(~13)·`no-redundant-type-constituents`(~4). `require-await`·테스트 `no-unsafe-*` 는 0(끔/완화 확인).

> 커밋하지 않는다. Task 8 까지 working-tree RED 유지.

---

### Task 2: 자동 수정 (no-unnecessary-type-assertion · no-redundant-type-constituents)

**Files:** `eslint --fix` 가 결정(타입 전용 변경, 런타임 무영향).

- [ ] **Step 1: 자동 수정 적용**

Run: `npx eslint . --fix`
Expected: `no-unnecessary-type-assertion`(불필요 `as`/`!` 제거)·`no-redundant-type-constituents`(중복 union 멤버 제거) 자동 수정.

- [ ] **Step 2: diff 검토 — 타입 전용 변경인지 확인**

Run: `git diff --stat`
Expected: 변경은 타입 표기 제거뿐(값/제어흐름 불변). 의심스러운 변경 있으면 해당 파일 수동 검토.

- [ ] **Step 3: 타입체크·테스트 녹색 확인**

Run: `npm run typecheck && npm test`
Expected: PASS(자동 수정이 회귀 없음).

- [ ] **Step 4: lint 재실행 — 두 룰 0 확인**

Run: `npm run lint`
Expected: `no-unnecessary-type-assertion`·`no-redundant-type-constituents` 0. 남은: misused-promises·floating·unsafe(src)·prefer-reject·await-thenable.

---

### Task 3: 렌더러 async onClick 래핑 (no-misused-promises, 10)

비동기 핸들러를 `() => void` 자리에 넘겨 미처리 rejection 위험. `() => void fn()` 으로 래핑(코드베이스 기존 패턴 `() => void cancel()` 과 일치, 동작 보존).

**Files:**
- Modify: `src/renderer/App.tsx:64`
- Modify: `src/renderer/components/ChatPanel.tsx:291,357,381,398`
- Modify: `src/renderer/components/ProjectPanel.tsx:325`
- Modify: `src/renderer/components/SessionsPanel.tsx:207,257,355,401`

- [ ] **Step 1: App.tsx:64 — onRefresh 래핑**

`onRefresh: () => void`(SessionsPanel `Props`, fire-and-forget 호출). async `refreshSessions` 를 래핑:
```tsx
{tab === 'sessions' && <SessionsPanel sessions={sessions} onRefresh={() => void refreshSessions()} />}
```

- [ ] **Step 2: ChatPanel.tsx — 4개 onClick 래핑**

```tsx
// :291
<button className="btn btn-sm" onClick={() => void createRoom()}>
// :357
<button className="btn btn-live btn-sm" disabled={busy || sessions.length < 2} onClick={() => void discuss()}>
// :381
<button key={s.id} className="ask-btn" disabled={busy} onClick={() => void ask(s.id)}>
// :398
<button className="btn" onClick={() => void postMessage()}>
```

- [ ] **Step 3: ProjectPanel.tsx:325 — run 래핑**

```tsx
<button className="btn" style={{ marginLeft: 'auto' }} onClick={() => void run()} disabled={!canRun}>
```

- [ ] **Step 4: SessionsPanel.tsx — 4개 onClick 래핑**

```tsx
// :207
<button className="btn btn-ghost btn-sm" onClick={() => void detect()} disabled={detecting}>
// :257
onClick={() => void registerCli(c.id)}
// :355
onClick={() => void registerApi()}
// :401
onClick={() => void toggleCapability(s, role)}
```

- [ ] **Step 5: lint + 렌더러 테스트 녹색 확인**

Run: `npm run lint && npx vitest run src/renderer`
Expected: `no-misused-promises` 0. 렌더러 테스트(App/ChatPanel/ProjectPanel/SessionsPanel/ApprovalModal) PASS(래핑은 동작 보존).

---

### Task 4: 부유 Promise 표면화 (no-floating-promises, 1)

**Files:**
- Modify: `src/main/core/mcp/stdio.ts:33`

- [ ] **Step 1: `killTree(child)` 를 `void` 로 명시**

`kill: () => void` 계약이라 await 불가 → fire-and-forget 의도를 `void` 로 명시:
```ts
    kill: () => {
      // Windows 에서 cross-spawn 은 cmd.exe 셰임 경유라 child.kill() 은 껍데기만 죽인다 → 트리 킬.
      void killTree(child)
    },
```

- [ ] **Step 2: lint + 해당 테스트 녹색**

Run: `npm run lint && npx vitest run src/main/core/mcp`
Expected: `no-floating-promises` 0. mcp 테스트 PASS.

---

### Task 5: src 타입 안전성 (no-unsafe-assignment 3 · no-unsafe-argument 1)

`JSON.parse` 결과(`any`)를 선언 타입으로 캐스팅(스트림 파싱, 런타임 불변).

**Files:**
- Modify: `src/main/core/providers/anthropic.ts:183`
- Modify: `src/main/core/providers/google.ts:236`
- Modify: `src/main/core/providers/openai.ts:208`
- Modify: `src/renderer/components/SessionsPanel.tsx:161`

- [ ] **Step 1: anthropic.ts:183 — 선언 타입으로 캐스팅**

```ts
      ev = JSON.parse(data) as typeof ev
```

- [ ] **Step 2: google.ts:236 — 명명 타입으로 캐스팅**

```ts
      ev = JSON.parse(data) as GoogleResponse
```

- [ ] **Step 3: openai.ts:208 — 선언 타입으로 캐스팅**

```ts
      ev = JSON.parse(data) as typeof ev
```

- [ ] **Step 4: SessionsPanel.tsx:161 — param 타입으로 캐스팅**

`setMcpServers(servers: McpServerSpec[])` 계약. `Array.isArray` 가드 뒤 `specs`(unknown) 를 캐스팅:
```tsx
      setMcpStatus(await window.fleet.setMcpServers(specs as McpServerSpec[]))
```
`McpServerSpec` import 확인(파일 상단 import 에 없으면 `import type { McpServerSpec } from '../../shared/types'` 추가 — 기존 shared/types import 경로 따름).

- [ ] **Step 5: lint + typecheck + provider/SessionsPanel 테스트**

Run: `npm run lint && npm run typecheck && npx vitest run src/main/core/providers src/renderer`
Expected: `no-unsafe-assignment`·`no-unsafe-argument` 0. typecheck PASS. 테스트 PASS.

---

### Task 6: Promise reject 에러화 (prefer-promise-reject-errors, 2)

`reject(signal.reason)` — abort 사유를 의도적으로 전파(reason 은 관례상 DOMException 이나 타입이 `any` 라 룰 발화). 전파를 유지하되 룰 충족.

**Files:**
- Modify: `src/main/core/providers/resilient.ts:15,21`

- [ ] **Step 1: 두 reject 에 disable 주석 + 사유**

```ts
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    // abort 사유(signal.reason)를 그대로 전파한다 — 취소 사유 보존이 의도. reason 은 관례상 DOMException.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(signal.reason)
      },
      { once: true },
    )
  })
```

- [ ] **Step 2: lint + resilient 테스트**

Run: `npm run lint && npx vitest run src/main/core/providers/resilient`
Expected: `prefer-promise-reject-errors` 0. resilient 테스트 PASS(abort 즉시 reject 동작 불변).

---

### Task 7: 테스트 await-thenable 제거 (await-thenable, 2)

`fire: (e) => act(() => emit?.(e))` — sync `act` 는 `void` 반환. `await fleet.fire(...)` 2곳의 `await` 는 no-op → 제거(나머지 ~20개 `fleet.fire` 는 비-await, 동작 동일).

**Files:**
- Modify: `src/renderer/components/ProjectPanel.test.tsx:414,415`

- [ ] **Step 1: 두 `await fleet.fire(...)` 에서 `await` 제거**

```tsx
    fleet.fire({ type: 'project.created', message: '생성', data: { projectId: 'pX' } }) // pX 선택
    fleet.fire({ type: 'task.done', message: 'pX작업완료', data: { projectId: 'pX' } }) // pX 라이브 로그
```

- [ ] **Step 2: lint + ProjectPanel 테스트**

Run: `npm run lint && npx vitest run src/renderer/components/ProjectPanel`
Expected: `await-thenable` 0. ProjectPanel 테스트 PASS(sync act 라 타이밍 불변).

---

### Task 8: 4게이트 전체 녹색 + 단일 커밋

**Files:** 없음(검증·커밋).

- [ ] **Step 1: lint 클린 확인 (0 errors)**

Run: `npm run lint`
Expected: PASS, 0 errors. (잔여 warn 은 기존 `no-explicit-any`/`no-unused-vars` 만 — 허용.)

- [ ] **Step 2: 4게이트 전부 실행**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: 4개 전부 PASS. test 수는 회귀 0(기존 740 유지 — 신규 테스트 없음, lint-gate 변경).

- [ ] **Step 3: 변경 파일 스테이징·커밋**

```bash
git add eslint.config.mjs src/
git commit -m "feat(lint): 타입인지 린팅 게이트 — recommendedTypeChecked + project 배열

eslint.config.mjs 에 type-aware 룰 추가(project 배열 파서, projectService 는
루트 tsconfig.json 부재로 불가). require-await off(테스트 스텁 251/252)·
테스트 no-unsafe-* off. src 전건 수정: 렌더러 onClick void 래핑 10·
stdio floating 1·provider JSON.parse 캐스팅 3·SessionsPanel unsafe-arg 1·
resilient prefer-reject 2·test await-thenable 2 + auto-fix 17. 즉시 error 착륙.

context7 현행문서 교차검증(#65). 4게이트 녹색. 이슈 #27 7차 Now.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: 커밋 확인**

Run: `git log --oneline -1 && git status`
Expected: 커밋 생성, working-tree clean.

---

## 검증 / 회귀 잠금

- **게이트가 곧 테스트**: `npm run lint` 0 exit = 타입인지 게이트 실효. 향후 신규 미처리 Promise·async 핸들러 오용·unsafe 흐름이 `error` 로 CI 차단.
- **무회귀 근거**: onClick `() => void fn()` 래핑은 fire-and-forget 동작 보존(기존 핸들러 내부 try/catch 유지). JSON.parse 캐스팅·`void killTree`·reject 주석·await 제거·auto-fix 는 전부 런타임 동작 불변. 기존 740 테스트 그린 유지.
- **CI**: ubuntu+windows 녹색 확인(머지 전).

## 후속 (비범위)

- `eslint-plugin-react-hooks` v6(7차 Next #2, 별도 PR), `no-explicit-any` warn→error, 테스트 fixture 근본 타이핑.

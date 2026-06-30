# #174 테스트 하네스 성숙도 트리오 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ApprovalGate 안전 계약을 기계강제로 보강하고, 산문 게이트(`경고 0`)를 실 게이트로 만들며, 오해 유발 dead classifier 를 제거한다.

**Architecture:** 3개 독립 변경 — (1) eslint `--max-warnings 0`, (2) dead classifier 삭제, (3) `src/main/core/tools/**` raw fs 변형·spawn 을 eslint 로 구조 차단 + 등록 도구 read-only 행동 계약 테스트. 신규 runtime dep 0.

**Tech Stack:** TypeScript, ESLint flat config (typescript-eslint), Vitest.

## Global Constraints

- 신규 runtime/dev dependency 추가 금지(0).
- `src/main/core/**` 는 electron/DOM-free 유지(기존 P1 가드 불변).
- `SENSITIVE_FILE` 정규식은 삭제 금지(diff-risk·workspace-tools·ignored-baseline 사용).
- ESLint flat config: 같은 rule-key 는 블록 간 병합이 아니라 **교체** — 공유 const spread 로 electron 보호 유실 방지.
- 모든 코멘트/메시지 한국어(레포 컨벤션).
- 최종 게이트: `npm run verify` green.

---

### Task 1: tools/** read-only 구조 가드 (eslint 3a + config 자가단언 3b)

**Files:**
- Modify: `eslint.config.mjs` (electron 규칙 공유 const 추출 + tools 블록 추가)
- Test: `scripts/eslint-config-purity.test.ts` (tools 블록 단언 추가)

**Interfaces:**
- Produces: `eslint.config.mjs` 최상위 const `ELECTRON_IMPORT_PATHS`, `ELECTRON_IMPORT_PATTERNS`, `ELECTRON_DYNAMIC_IMPORT_SYNTAX`, `FS_MUTATION_NAMES`, `FS_MUTATION_SELECTOR`, `FS_MUTATION_IMPORT_NAMES`, `TOOLS_FORBIDDEN_IMPORT_PATHS`; `files: ['src/main/core/tools/**/*.ts']` 블록.

- [ ] **Step 1: config 자가단언 테스트 추가(RED)** — `scripts/eslint-config-purity.test.ts` 끝(마지막 `})` 다음)에 추가:

```ts
const toolsBlock = blocks.find((c) => c.files?.includes('src/main/core/tools/**/*.ts'))

describe('도구 read-only 구조 가드 ESLint 게이트 (#174)', () => {
  it('tools 블록 존재 + files/ignores 스코프', () => {
    expect(toolsBlock).toBeDefined()
    expect(toolsBlock?.files).toContain('src/main/core/tools/**/*.ts')
    expect((toolsBlock as { ignores?: string[] })?.ignores).toContain(
      'src/main/core/tools/**/*.test.ts',
    )
  })

  it('no-restricted-imports 가 child_process 와 fs 변형 importNames 를 금지', () => {
    const rule = toolsBlock?.rules?.['no-restricted-imports']
    expect(rule?.[0]).toBe('error')
    const opts = rule?.[1] as { paths?: { name: string; importNames?: string[] }[] }
    const names = (opts.paths ?? []).map((p) => p.name)
    expect(names).toContain('child_process')
    expect(names).toContain('node:child_process')
    const fsProm = opts.paths?.find((p) => p.name === 'node:fs/promises')
    expect(fsProm?.importNames).toContain('writeFile')
    expect(fsProm?.importNames).toContain('rm')
  })

  it('no-restricted-syntax 가 fs 변형 메서드 selector 를 보유', () => {
    const rule = toolsBlock?.rules?.['no-restricted-syntax']
    expect(rule?.[0]).toBe('error')
    const selectors = (rule?.slice(1) as { selector?: string }[])
      .map((s) => s.selector ?? '')
      .join('  ')
    expect(selectors).toMatch(/MemberExpression\[property\.name=.*writeFile/)
  })

  it('tools 블록이 electron 정적·동적 import 보호를 재선언(override 함정 방지)', () => {
    const imp = toolsBlock?.rules?.['no-restricted-imports']?.[1] as {
      paths?: { name: string }[]
      patterns?: { group: string[] }[]
    }
    expect(imp.paths?.some((p) => p.name === 'electron')).toBe(true)
    expect(imp.patterns?.some((p) => p.group?.includes('electron/*'))).toBe(true)
    const syn = toolsBlock?.rules?.['no-restricted-syntax']
    const sel = (syn?.slice(1) as { selector?: string }[]).map((s) => s.selector ?? '').join('  ')
    expect(sel).toContain("ImportExpression[source.value='electron']")
  })
})
```

- [ ] **Step 2: 실패 확인(RED)** — Run: `npx vitest run scripts/eslint-config-purity.test.ts`
  Expected: FAIL — `toolsBlock` undefined (tools 블록 아직 없음).

- [ ] **Step 3: electron 규칙 공유 const 추출 + tools 블록 추가(GREEN)** — `eslint.config.mjs` 의 `export default tseslint.config(` 위에 상단 const 삽입:

```js
// 코어/도구 공유 electron 가드(공유 const) — flat config 는 같은 rule-key 를 블록 간 병합이 아니라
// 교체하므로, tools 전용 블록이 no-restricted-imports/syntax 를 재선언할 때 electron 보호가 유실되지
// 않도록 양쪽에서 spread 한다(#174).
const ELECTRON_IMPORT_PATHS = [
  {
    name: 'electron',
    message:
      '코어(src/main/core)는 electron-free 여야 한다(AGENTS.md P1). Electron 의존은 어댑터 계층으로 분리하라.',
  },
]
const ELECTRON_IMPORT_PATTERNS = [
  {
    group: ['electron/*'],
    message: '코어는 electron-free 여야 한다(AGENTS.md P1). electron 하위경로 import 금지.',
  },
]
const ELECTRON_DYNAMIC_IMPORT_SYNTAX = [
  {
    selector: "ImportExpression[source.value='electron']",
    message: '코어는 electron-free 여야 한다(AGENTS.md P1). 동적 import(electron) 금지.',
  },
  {
    selector: 'ImportExpression[source.value=/^electron\\//]',
    message: '코어는 electron-free 여야 한다(AGENTS.md P1). 동적 import(electron 하위경로) 금지.',
  },
]

// 도구 read-only 구조 가드(#174): ApprovalGate 는 tool.classify() 자가신고만 신뢰하므로(loop.ts:171),
// classify:'safe' 인 신규 도구가 raw fs 변형/spawn 하면 무프롬프트로 워크스페이스를 바꾼다.
// 도구 execute 는 read-only 계약이라야 한다 → 변형 메서드·child_process·fs 변형 import 를 기계 차단.
const FS_MUTATION_NAMES = [
  'writeFile', 'appendFile', 'rm', 'rmdir', 'unlink', 'mkdir', 'mkdtemp', 'rename',
  'copyFile', 'cp', 'truncate', 'ftruncate', 'chmod', 'chown', 'lchmod', 'lchown',
  'symlink', 'link', 'utimes', 'futimes', 'write', 'writev', 'createWriteStream',
]
// fs.writeFile·fs.promises.rm·nodeFs.unlinkSync 등 객체명 무관 변형 메서드 호출 차단.
// anchored property-name 매칭이라 `truncated` 같은 식별자는 미포착.
const FS_MUTATION_SELECTOR = `MemberExpression[property.name=/^(${FS_MUTATION_NAMES.join('|')})(Sync)?$/]`
// import { writeFile } from 'node:fs/promises' 후 bare writeFile() 누락(MemberExpression 미포착) 봉쇄.
const FS_MUTATION_IMPORT_NAMES = FS_MUTATION_NAMES.flatMap((n) => [n, `${n}Sync`])
const TOOLS_FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises']
const TOOLS_FORBIDDEN_IMPORT_PATHS = [
  {
    name: 'child_process',
    message:
      '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). 실행은 sub-agent CLI 경계에 위임.',
  },
  {
    name: 'node:child_process',
    message:
      '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). 실행은 sub-agent CLI 경계에 위임.',
  },
  ...TOOLS_FS_MODULES.map((name) => ({
    name,
    importNames: FS_MUTATION_IMPORT_NAMES,
    message: `도구는 read-only — ${name} 변형 함수 import 금지(#174).`,
  })),
]
```

  같은 파일의 core 블록(`files: ['src/main/core/**/*.ts']`) 내 두 rule 을 공유 const 로 교체:
  - `'no-restricted-imports'` 의 `[1]` 을 `{ paths: ELECTRON_IMPORT_PATHS, patterns: ELECTRON_IMPORT_PATTERNS }` 로.
  - `'no-restricted-syntax'` 를 `['error', ...ELECTRON_DYNAMIC_IMPORT_SYNTAX]` 로.
  (`no-restricted-globals` 는 불변.)

  core 블록 닫힘 `},` 다음(=`eslintConfigPrettier` 앞)에 tools 블록 삽입:

```js
  // 도구 read-only 구조 가드(#174). core 블록보다 뒤라 no-restricted-imports/syntax 를 교체하므로
  // electron 보호를 공유 const 로 재선언(유실 방지). no-restricted-globals 는 미선언 → core 상속.
  // 테스트는 임시 워크스페이스 준비로 fs 변형을 정상 사용 → ignores 로 제외.
  {
    files: ['src/main/core/tools/**/*.ts'],
    ignores: ['src/main/core/tools/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...ELECTRON_IMPORT_PATHS, ...TOOLS_FORBIDDEN_IMPORT_PATHS],
          patterns: ELECTRON_IMPORT_PATTERNS,
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...ELECTRON_DYNAMIC_IMPORT_SYNTAX,
        {
          selector: FS_MUTATION_SELECTOR,
          message:
            '도구(src/main/core/tools)는 read-only 계약 — raw fs 변형 메서드 호출 금지(#174). 변형이 필요하면 ApprovalGate 경유 경로를 쓰라.',
        },
      ],
    },
  },
```

- [ ] **Step 4: 통과 확인(GREEN) + 위반 0 확인** — Run:
  `npx vitest run scripts/eslint-config-purity.test.ts && npx eslint .`
  Expected: 테스트 PASS(기존 core 단언 포함 전부) · `eslint .` 위반 0(현 tools 코드 read-only).

- [ ] **Step 5: 커밋**

```bash
git add eslint.config.mjs scripts/eslint-config-purity.test.ts
git commit -m "feat(#174): tools/** read-only 구조 가드 — raw fs 변형·spawn eslint 차단 + config 자가단언"
```

---

### Task 2: 등록 도구 read-only 행동 계약 테스트 (3c)

**Files:**
- Test: `src/main/core/tools/workspace-tools.test.ts` (스냅샷 계약 테스트 추가)

**Interfaces:**
- Consumes: `createWorkspaceReadTools(root: string): FleetTool[]` (기존). 각 `FleetTool.execute(input, ctx)` — ctx 는 `{ signal }`.

- [ ] **Step 1: 행동 계약 테스트 추가** — `workspace-tools.test.ts` 상단 import 에 누락분 추가하고(파일에 이미 일부 import 있을 수 있음 — 중복 선언 금지) 새 describe 추가:

```ts
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import * as osm from 'node:os'
import * as pathm from 'node:path'

type SnapEntry = { rel: string; kind: 'file' | 'dir' | 'symlink'; size?: number; hash?: string; link?: string }

async function snapshotTree(root: string): Promise<SnapEntry[]> {
  const out: SnapEntry[] = []
  async function walk(dir: string): Promise<void> {
    const dirents = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const d of dirents) {
      const full = pathm.join(dir, d.name)
      const rel = pathm.relative(root, full).split(pathm.sep).join('/')
      if (d.isSymbolicLink()) {
        out.push({ rel, kind: 'symlink', link: await fsp.readlink(full) })
      } else if (d.isDirectory()) {
        out.push({ rel, kind: 'dir' })
        await walk(full)
      } else if (d.isFile()) {
        const buf = await fsp.readFile(full)
        out.push({ rel, kind: 'file', size: buf.length, hash: createHash('sha256').update(buf).digest('hex') })
      }
    }
  }
  await walk(root)
  return out
}

describe('워크스페이스 read 도구 read-only 행동 계약 (#174)', () => {
  it('등록 도구 실행은 워크스페이스를 변경하지 않는다(스냅샷 불변)', async () => {
    const root = await fsp.mkdtemp(pathm.join(osm.tmpdir(), 'fleet-tools-ro-'))
    try {
      await fsp.writeFile(pathm.join(root, 'a.txt'), 'hello world')
      await fsp.mkdir(pathm.join(root, 'sub'))
      await fsp.writeFile(pathm.join(root, 'sub', 'b.ts'), 'export const x = 1\n')

      const before = await snapshotTree(root)
      const tools = createWorkspaceReadTools(root)
      const inputs: Record<string, unknown> = {
        read_file: { path: 'a.txt' },
        list_directory: { path: '.' },
        grep: { pattern: 'x' },
        glob: { pattern: '**/*' },
      }
      const ac = new AbortController()
      for (const t of tools) {
        await t.execute(inputs[t.definition.name] ?? {}, { signal: ac.signal }).catch(() => undefined)
      }
      const after = await snapshotTree(root)
      expect(after).toEqual(before)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
```

  주: 이 파일은 Task 1 의 tools eslint 가드에서 `ignores` 로 제외되므로 `fsp.writeFile`/`mkdir`/`rm` 사용이 허용된다. 기존 import 와 충돌 시 별칭(`fsp`/`osm`/`pathm`) 유지로 회피.

- [ ] **Step 2: 통과 확인** — Run: `npx vitest run src/main/core/tools/workspace-tools.test.ts`
  Expected: PASS(현 도구 read-only → 스냅샷 불변).

- [ ] **Step 3: 커밋**

```bash
git add src/main/core/tools/workspace-tools.test.ts
git commit -m "test(#174): 등록 워크스페이스 도구 read-only 행동 계약(스냅샷 불변)"
```

---

### Task 3: dead classifier 삭제 (항목 2)

**Files:**
- Modify: `src/main/core/safety/approval.ts` (`classifyCommandRisk`·`classifyFileRisk`·`DESTRUCTIVE_PATTERNS` 삭제 + 주석)
- Test: `src/main/core/safety/approval.test.ts` (classifier 테스트 + import 제거)

**Interfaces:**
- Produces: `approval.ts` 는 `SENSITIVE_FILE`, `ApprovalGate`, `GateOptions`, `createApprovalGate` 만 export(+타입). `classifyCommandRisk`/`classifyFileRisk`/`DESTRUCTIVE_PATTERNS` 제거.

- [ ] **Step 1: 테스트에서 classifier 블록·import 제거** — `approval.test.ts`:
  - 2행 import 를 `import { createApprovalGate } from './approval'` 로 교체.
  - 4–18행 `describe('risk classification', …)` 블록 전체 삭제(`createApprovalGate` describe 는 유지).

- [ ] **Step 2: 실패 확인(RED)** — Run: `npx vitest run src/main/core/safety/approval.test.ts`
  Expected: PASS(삭제된 테스트는 더는 실행 안 됨) — 단 이 단계에서 `approval.ts` 는 아직 함수 보유라 타입 OK. (RED 는 다음 typecheck 가 아니라 "dead export 잔존" 을 Step 4 lint 가 잡는 구조.)

- [ ] **Step 3: `approval.ts` 에서 dead 코드 삭제 + 주석 갱신**:
  - 4–17행 `DESTRUCTIVE_PATTERNS` 상수 삭제.
  - 21–29행 `classifyCommandRisk`·`classifyFileRisk` 함수 삭제.
  - `SENSITIVE_FILE`(19행) 유지. import(`randomUUID`, `ApprovalDecision`/`ApprovalRequest`/`RiskLevel`) 유지.
  - `createApprovalGate` JSDoc 를 아래로 교체:

```ts
/**
 * 승인 게이트 (요구사항 6). destructive 작업은 approver 승인 없이는 거부된다.
 * 게이트는 무엇이 destructive 인지 *판정하지 않는다* — 호출자(도구)가 신고한 req.risk 를
 * 집행할 뿐이다(risk classification 아닌 risk enforcement). 셸/명령 위험 분류는 코어가 아니라
 * sub-agent CLI 경계에 위임된다(#167/#170 — 코어 내 명령 denylist 없음).
 * 모든 요청/결정은 onEvent 로 감사 로그에 남는다.
 */
```

- [ ] **Step 4: 통과 확인(GREEN)** — Run:
  `npx vitest run src/main/core/safety/ && npx tsc -p tsconfig.node.json --noEmit && npx eslint .`
  Expected: 테스트 PASS · typecheck 0 에러(dangling 참조 없음) · lint 0(미사용 export 경고 없음).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/safety/approval.ts src/main/core/safety/approval.test.ts
git commit -m "refactor(#174): dead classifier(classifyCommandRisk/FileRisk·DESTRUCTIVE_PATTERNS) 삭제 + 게이트 계약 주석 명시"
```

---

### Task 4: `eslint . --max-warnings 0` (항목 1)

**Files:**
- Modify: `package.json` (lint 스크립트)
- Modify: `eslint.config.mjs` (react-hooks 블록 주석)

- [ ] **Step 1: lint 스크립트 변경** — `package.json` 의 `"lint": "eslint .",` → `"lint": "eslint . --max-warnings 0",`.

- [ ] **Step 2: eslint 주석 정정** — `eslint.config.mjs` react-hooks 블록 주석에서 "eslint 가 --max-warnings 0 미사용이라 warn 은 CI 를 못 막음" 문장을 아래로 교체:
  "lint 는 `--max-warnings 0`(package.json) 이라 모든 warn 이 CI 를 막는다. exhaustive-deps 는 의도 명시를 위해 error 로 유지한다."

- [ ] **Step 3: 게이트 통과 확인** — Run: `npm run lint`
  Expected: PASS(현 baseline 경고 0). 

- [ ] **Step 4: 강제 동작 실증(회귀 가드 확인, 비커밋)** — 임시로 `src/main/core/safety/approval.ts` 에 `const _unused = 1` 추가 → Run `npm run lint` → Expected: FAIL(`no-unused-vars` warn 이 차단). 확인 후 임시 줄 제거.

- [ ] **Step 5: 커밋**

```bash
git add package.json eslint.config.mjs
git commit -m "feat(#174): lint --max-warnings 0 — 경고 0 산문 게이트를 기계강제"
```

---

### Task 5: 최종 게이트 + 수용 기준 확인

- [ ] **Step 1: 전체 verify** — Run: `npm run verify`
  Expected: skills:lint · brain:check · format:check · typecheck · lint · test · build 전부 PASS.

- [ ] **Step 2: 수용 기준 체크**(spec §7): max-warnings 강제 · dead classifier 제거(SENSITIVE_FILE 유지) · tools/** 변형 차단 · electron 보호 유지 · 행동 계약 테스트 · verify green.

---

## Self-Review

**Spec coverage:** §4 항목1=Task4 · 항목2=Task3 · 항목3a/3b=Task1 · 항목3c=Task2. §7 수용기준=Task5. coverage·Node24=Out of scope(spec §2/§8). 누락 없음.

**Placeholder scan:** 모든 코드 step 에 실제 코드/명령/기대출력 명시. TBD/TODO 없음.

**Type consistency:** `createWorkspaceReadTools`/`FleetTool.execute(input, ctx)` 시그니처 일치. `SnapEntry` 타입 일관. eslint const 이름(`FS_MUTATION_NAMES` 등) Task1 내 일관. `toolsBlock` 단언 키가 tools 블록 실제 rule 키와 일치.

**주의(실행자용):** Task 순서는 spec TDD 순서(3b RED→3a→3c→삭제→max-warnings). Task3 Step2 는 "삭제 전 테스트가 여전히 green" 특성상 전통적 RED 가 아님 — 삭제의 안전 신호는 Step4 typecheck+lint(dangling/미사용 0). Task1 의 별칭 충돌(`fsp` 등)·기존 import 중복 선언 주의.

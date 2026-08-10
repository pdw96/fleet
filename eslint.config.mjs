import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

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
  'writeFile',
  'appendFile',
  'rm',
  'rmdir',
  'unlink',
  'mkdir',
  'mkdtemp',
  'rename',
  'copyFile',
  'cp',
  'truncate',
  'ftruncate',
  'chmod',
  'chown',
  'lchmod',
  'lchown',
  'symlink',
  'link',
  'utimes',
  'futimes',
  'write',
  'writev',
  'createWriteStream',
  // open('w'/'a'/'wx' 등)은 첫 write* 전에 파일 생성/truncate → 변형. 읽기('r') open 은 각 site inline-disable.
  'open',
  // fd 기반 메타데이터 변형 + Node24 mkdtempDisposable(스냅샷이 mode/owner/times 미포함이라 행동테스트도 놓침).
  'fchmod',
  'fchown',
  'lutimes',
  'mkdtempDisposable',
]
const FS_MUTATION_PATTERN = `/^(${FS_MUTATION_NAMES.join('|')})(Sync)?$/`
// fs.writeFile·fs.promises.rm·nodeFs.unlinkSync 등 dot 접근 변형 메서드 차단(anchored — `truncated` 미포착).
const FS_MUTATION_SELECTOR = `MemberExpression[property.name=${FS_MUTATION_PATTERN}]`
// computed 접근 fs['writeFile'](...) 우회 봉쇄(Literal 키만 — 변수 키 fs[name] 은 정적 분석 불가, 한계 명시).
const FS_MUTATION_COMPUTED_SELECTOR = `MemberExpression[computed=true][property.value=${FS_MUTATION_PATTERN}]`
// bare 호출 writeFile(...) 봉쇄 — 정적 namespace import 에서 const { writeFile } = fs 구조분해(또는 named/동적
// import 구조분해) 후 bare 호출은 MemberExpression 이 아니라 selector 미포착. callee.name 으로 포착(Codex P2).
const FS_MUTATION_CALL_SELECTOR = `CallExpression[callee.name=${FS_MUTATION_PATTERN}]`
// import { writeFile } from 'node:fs/promises' 후 bare writeFile() 누락(MemberExpression 미포착) 봉쇄.
const FS_MUTATION_IMPORT_NAMES = FS_MUTATION_NAMES.flatMap((n) => [n, `${n}Sync`])
const TOOLS_FS_MODULES = ['fs', 'node:fs', 'fs/promises', 'node:fs/promises']

/**
 * **코어에서 `fs` 를 만져도 되는 모듈 — 닫힌 allowlist**(#282 · Codex 5R).
 *
 * 여기 없는 `src/main/core/**` 파일은 정적·동적 어느 형태로도 fs 를 import 할 수 없다. 이 경계가
 * 필요한 이유는 실측이다 — 「변이 API 이름을 정규식으로 분류」하는 접근은 5라운드 내내 회피 형태가
 * 새로 나왔다(promise 형 · `{ promises as fs }` · `fs.promises.x` · bare 지정자 · 동적 import ·
 * FileHandle · re-export 체인 · 네임스페이스 구조분해). 동적 언어에서 그 꼬리는 끝나지 않는다.
 *
 * **import 경계는 유한하다.** fs 가 코어에 들어오는 문은 import 하나뿐이므로(동적 import 도 함께
 * 차단) 여기서 막으면 위 형태 전부가 한 번에 무의미해진다. 신규 모듈이 fs 를 쓰려면 반드시 이
 * 목록에 이름을 올려야 하고, 그 편집이 곧 리뷰 지점이다.
 *
 * 두 티어로 나눠 선언하는 이유: `CORE_FS_MUTATING` 은 AGENTS.md 「ApprovalGate 예외」 열거와
 * **교차 검증**된다(`scripts/approval-gate-exceptions.test.ts`). 읽기 전용 소비자를 같은 목록에
 * 섞으면 그 교차 검증이 성립하지 않는다.
 */
const CORE_FS_READONLY = [
  'src/main/core/tools/workspace-tools.ts',
  'src/main/core/verify/run.ts',
  'src/main/core/workbench/instance-marker-proc.ts',
  'src/main/core/workspace/path-guard.ts',
  'src/main/core/workspace/set-workspace.ts',
]
/** fs 를 **변이**하는 코어 모듈 = AGENTS.md 「ApprovalGate 예외」 중 fs 를 직접 import 하는 것들. */
const CORE_FS_MUTATING = [
  'src/main/core/store/json-file.ts',
  'src/main/core/workbench/active-instance.ts',
  'src/main/core/workbench/coord-area.ts',
  'src/main/core/workbench/durable-fs.ts',
  'src/main/core/workspace/git.ts',
  'src/main/core/workspace/ignored-baseline.ts',
]
const CORE_FS_ALLOWLIST = [...CORE_FS_READONLY, ...CORE_FS_MUTATING]

/**
 * import 문 밖의 **대체 로더 경로**(Codex PR#282 6R). `no-restricted-imports`/ImportExpression 만으로는
 * `process.getBuiltinModule('fs')` · `createRequire(import.meta.url)('node:fs')` · `require('fs')` ·
 * `import('node:' + 'fs')`(비-리터럴 소스)가 전부 통과한다. tools/**(#174)가 이미 쓰는 가드를 코어
 * 경계에도 건다 — 메시지만 코어용으로 바꾼 동형이다.
 */
const CORE_LOADER_GUARD_SYNTAX = [
  "CallExpression[callee.name='createRequire']",
  "MemberExpression[property.name='createRequire']",
  "CallExpression[callee.name='require']",
  "MemberExpression[property.name='require']",
  "MemberExpression[property.name='getBuiltinModule']",
  "ImportExpression[source.type!='Literal']",
].map((selector) => ({
  selector,
  message:
    '코어(src/main/core)는 allowlist 밖에서 대체 로더로 모듈을 얻지 않는다(#282). createRequire·require·getBuiltinModule·비-리터럴 동적 import 금지 — fs 경계 우회 차단.',
}))

/**
 * **raw fs 재-export 금지**(6R): allowlist 안의 모듈이 `export { writeFileSync } from 'node:fs'` 로
 * 능력을 흘리면, 그걸 import 하는 모듈은 fs 지정자를 안 쓰고도 변이할 수 있다. 재-export 는 정당한
 * 용도가 없으므로 **코어 전역**에서 막는다(allowlist 안팎 모두).
 *
 * ⚠ **잔여 한계(은폐하지 않음)**: 「fs 를 감싼 *함수*를 export 」하는 것까지는 막지 못한다 — 그건
 * 원리적으로 `DurableFs` 와 같은 형태이고, Fleet 은 그런 의도적 seam 을 **지정자 목록으로 추적**한다
 * (`scripts/approval-gate-exceptions.test.ts` 의 seam 판정). 새 seam 을 만들면 그 목록에 등재해야 한다.
 */
const CORE_FS_REEXPORT_SYNTAX = ['ExportNamedDeclaration', 'ExportAllDeclaration'].flatMap((kind) =>
  TOOLS_FS_MODULES.map((m) => ({
    selector: `${kind}[source.value='${m}']`,
    message:
      '코어(src/main/core)는 raw fs 를 재-export 하지 않는다(#282). 능력을 흘리면 소비자가 allowlist 를 우회한다 — 의도적 seam 은 durable-fs 처럼 추적 가능한 모듈로 만들라.',
  })),
)

/** allowlist 밖 코어 모듈의 fs 동적 import 차단(정적 가드는 ImportExpression 을 미방문). */
const CORE_FS_DYNAMIC_IMPORT_SYNTAX = TOOLS_FS_MODULES.map((m) => ({
  selector: `ImportExpression[source.value='${m}']`,
  message: `코어(src/main/core)는 allowlist 밖에서 fs 를 만지지 않는다(#282). 동적 import('${m}') 금지 — 필요하면 eslint.config.mjs 의 CORE_FS_ALLOWLIST 에 등재하고 AGENTS.md 예외 열거를 함께 갱신하라.`,
}))

// 프로세스 spawn 차단(#174, Codex P2): child_process/cross-spawn 을 어떤 경로로 얻든(static/dynamic
// import·createRequire·process.getBuiltinModule) 실제 spawn/fork 등 **호출 지점**을 dot/computed/bare/
// 구조분해 형태로 잡는다 → 로더 종류를 일일이 쫓을 필요 없음. import 금지는 흔한 경로의 조기 명확 에러용.
// `exec` 포함(member cp.exec·구조분해 모두 차단). tools/** 는 regex `.exec` 미사용이라 충돌 0 — 향후
// regex.exec 추가 시 각 site inline-disable.
const PROCESS_SPAWN_NAMES = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]
const PROCESS_SPAWN_PATTERN = `/^(${PROCESS_SPAWN_NAMES.join('|')})$/`
const PROCESS_SPAWN_SYNTAX = [
  { selector: `MemberExpression[property.name=${PROCESS_SPAWN_PATTERN}]` },
  { selector: `MemberExpression[computed=true][property.value=${PROCESS_SPAWN_PATTERN}]` },
  { selector: `CallExpression[callee.name=${PROCESS_SPAWN_PATTERN}]` },
  // const { spawn } = cp / const { spawn: s } = cp — 별칭 무관 구조분해 키로 포착(식별자 키·리터럴 키 양쪽).
  { selector: `ObjectPattern > Property[key.name=${PROCESS_SPAWN_PATTERN}]` },
  { selector: `ObjectPattern > Property[key.value=${PROCESS_SPAWN_PATTERN}]` },
].map((s) => ({
  ...s,
  message:
    '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). spawn/fork/exec 등 호출·구조분해 금지 — 실행은 sub-agent CLI 경계에 위임.',
}))
// 별칭 구조분해 const { writeFile: wf } = fs / const { 'writeFile': wf } = fs 봉쇄 — bare-call(callee.name)
// 은 별칭 wf 를 놓침. 키 이름(식별자)·키 값(문자열 리터럴) 양쪽으로 포착.
const FS_MUTATION_DESTRUCTURE_SELECTORS = [
  `ObjectPattern > Property[key.name=${FS_MUTATION_PATTERN}]`,
  `ObjectPattern > Property[key.value=${FS_MUTATION_PATTERN}]`,
]
// 정적 템플릿 computed fs[`writeFile`]·cp[`exec`] 봉쇄 — property.value(Literal) selector 가 TemplateLiteral
// 을 놓침. tools/** 는 템플릿 computed 멤버 접근을 쓰지 않으므로 blanket 차단(정적 키는 dot 표기로).
const TEMPLATE_COMPUTED_SELECTOR = `MemberExpression[computed=true][property.type='TemplateLiteral']`

/** 읽기 전용 티어에 거는 fs 변형 차단(6R) — tools/**(#174)와 동형. 티어 라벨이 선언에 그치지 않게 한다. */
const CORE_FS_READONLY_SYNTAX = [
  {
    // ⚠ **별칭 import 봉쇄**(실측: 이게 없으면 `import { writeFileSync as w }` + `w(p, x)` 가 전 가드를
    // 통과한다 — bare-call 셀렉터는 호출명 `w` 를 못 잡는다). `imported.name` 은 별칭과 무관하다.
    // `no-restricted-imports` 의 `importNames` 로는 못 한다 — 그건 `import * as fs` 까지 막아
    // 읽기 전용 네임스페이스 사용을 오탐한다.
    selector: `ImportSpecifier[imported.name=${FS_MUTATION_PATTERN}]`,
    message:
      '읽기 전용 티어(CORE_FS_READONLY)는 fs 변형 API 를 import 하지 않는다(#282 · 별칭 포함). 변형이 필요하면 CORE_FS_MUTATING 으로 옮기고 AGENTS.md 예외 열거·근거 절을 함께 갱신하라.',
  },
  {
    selector: FS_MUTATION_SELECTOR,
    message:
      '읽기 전용 티어(CORE_FS_READONLY)는 raw fs 변형 메서드를 호출하지 않는다(#282). 변형이 필요하면 CORE_FS_MUTATING 으로 옮기고 AGENTS.md 예외 열거·근거 절을 함께 갱신하라.',
  },
  {
    selector: FS_MUTATION_COMPUTED_SELECTOR,
    message: '읽기 전용 티어는 computed fs 변형 호출(fs["writeFile"])을 하지 않는다(#282).',
  },
  {
    selector: FS_MUTATION_CALL_SELECTOR,
    message: '읽기 전용 티어는 구조분해된 fs 변형 함수의 bare 호출을 하지 않는다(#282).',
  },
  ...FS_MUTATION_DESTRUCTURE_SELECTORS.map((selector) => ({
    selector,
    message: '읽기 전용 티어는 fs 변형 함수를 구조분해하지 않는다(#282).',
  })),
  {
    selector: TEMPLATE_COMPUTED_SELECTOR,
    message: '읽기 전용 티어는 템플릿 computed 멤버 접근을 쓰지 않는다(#282).',
  },
]
// createRequire 차단(#174, Codex P2): import('cross-spawn')/child_process 정적·동적 import 는 막히나
// createRequire(import.meta.url)('cross-spawn') 로 임의 별칭 로드 후 호출하면 import 가드·callee 선택자
// 모두 우회. tools 는 createRequire 가 불필요하므로 import·호출·멤버 전부 차단.
const CREATEREQUIRE_SYNTAX = [
  `CallExpression[callee.name='createRequire']`,
  `MemberExpression[property.name='createRequire']`,
].map((selector) => ({
  selector,
  message:
    '도구(src/main/core/tools)는 createRequire 로 모듈을 로드하지 않는다(#174). spawn/fs 변형 우회 차단 — 정적 import 만 사용.',
}))
// 난독화 로더/구문 blanket(#174, Codex P2) — tools 는 아래를 전혀 쓰지 않으므로 충돌 없이 차단:
//   · 비-문자열-리터럴 동적 import 소스: import(`cross-spawn`)·import('a'+'b') 등 정적 분석 회피.
//   · CJS require(): ESM tools 에 불필요 — const run = require('cross-spawn') 우회 차단.
//   · computed 구조분해 키: const { [`writeFile`]: wf } = fs 같은 별칭 우회 차단.
// (변수키 computed fs[v]·string-concat fs['w'+'F'] 는 정당한 arr[i+1] 과 구분 불가→정적 차단 불가,
//  boundary 에 명시. 난독화 자체가 리뷰 레드플래그.)
const OBFUSCATION_GUARD_SYNTAX = [
  {
    selector: "ImportExpression[source.type!='Literal']",
    message:
      '도구(src/main/core/tools)는 동적 import 소스에 문자열 리터럴만 쓴다(#174). 템플릿/연산 소스로 로더 우회 금지.',
  },
  {
    // bare require(...) 와 member require(module.require/x.require) 양쪽 — createRequire member 는 별도 차단.
    selector: "CallExpression[callee.name='require'], MemberExpression[property.name='require']",
    message:
      '도구(src/main/core/tools)는 CJS require(bare·member)를 쓰지 않는다(#174). 정적 import 만 — spawn/fs 변형 우회 차단.',
  },
  {
    selector: 'ObjectPattern > Property[computed=true]',
    message:
      '도구(src/main/core/tools)는 computed 구조분해 키를 쓰지 않는다(#174). const { [`writeFile`]: wf } = fs 같은 우회 차단.',
  },
]
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
  {
    // cross-spawn 은 레포 의존(core CLI 러너 사용) — 도구가 import spawn from 'cross-spawn' 로 우회 가능(Codex P2).
    name: 'cross-spawn',
    message:
      '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). cross-spawn 등 spawn 래퍼 import 금지.',
  },
  ...TOOLS_FS_MODULES.map((name) => ({
    name,
    importNames: FS_MUTATION_IMPORT_NAMES,
    message: `도구는 read-only — ${name} 변형 함수 import 금지(#174).`,
  })),
  ...['module', 'node:module'].map((name) => ({
    // 전체 금지(importNames 아님) — import * as mod from 'node:module'; const { createRequire: cr } = mod
    // 같은 네임스페이스 별칭 우회까지 봉쇄(Codex P2). tools 는 node:module 자체가 불필요.
    name,
    message: `도구는 node 모듈 로더(module/createRequire)를 import 하지 않는다(#174). spawn/fs 변형 우회 차단.`,
  })),
]
// child_process 동적 import 차단 — 정적 import 는 위 paths 로 막히나 import('node:child_process')
// 는 ImportExpression 이라 no-restricted-imports 가 미방문 → spawn 우회. electron 동적 import 가드와 동형(#173).
const CHILD_PROCESS_DYNAMIC_IMPORT_SYNTAX = [
  {
    selector: "ImportExpression[source.value='child_process']",
    message:
      '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). 동적 import(child_process) 금지.',
  },
  {
    selector: "ImportExpression[source.value='node:child_process']",
    message:
      '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). 동적 import(node:child_process) 금지.',
  },
  {
    // const { default: crossSpawn } = await import('cross-spawn') — 정적뿐 아니라 동적도 봉쇄(Codex P2).
    selector: "ImportExpression[source.value='cross-spawn']",
    message:
      '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). 동적 import(cross-spawn) 금지.',
  },
  {
    // const { createRequire: cr } = await import('node:module') — 리터럴 동적 import 도 봉쇄(정적 ban·
    // non-literal source ban 둘 다 통과하던 createRequire 동적 로더 경로, Codex P2).
    selector: "ImportExpression[source.value='node:module']",
    message:
      '도구(src/main/core/tools)는 node 모듈 로더를 동적 import 하지 않는다(#174). createRequire 우회 차단.',
  },
  {
    selector: "ImportExpression[source.value='module']",
    message:
      '도구(src/main/core/tools)는 node 모듈 로더를 동적 import 하지 않는다(#174). createRequire 우회 차단.',
  },
]
// fs 모듈 동적 import 차단 — const { writeFile } = await import('node:fs/promises') 구조분해 우회 봉쇄.
// 도구는 정적 import 로 읽기만 하므로 fs 모듈 동적 import 자체를 금지(read 포함 — 현 위반 0).
const TOOLS_FS_DYNAMIC_IMPORT_SYNTAX = TOOLS_FS_MODULES.map((m) => ({
  selector: `ImportExpression[source.value='${m}']`,
  message: `도구(src/main/core/tools)는 fs 모듈 동적 import 금지(구조분해 변형 우회 봉쇄, #174). 정적 import 로 읽기만.`,
}))

export default tseslint.config(
  // .claude/** 는 eslint 대상에서 제외(워크플로 worktree·Workflow DSL 글로벌 때문).
  // 단 .claude/skills·workflows 일부는 git 추적되며 보안/규약은 `npm run skills:lint`(lint-staged·CI)가 담당.
  {
    ignores: [
      'out/**',
      'dist/**',
      'build/**',
      'node_modules/**',
      '.claude/**',
      '.dogfood/**',
      // 라이브 하니스 기본 워크스페이스(gitignore·사용자 프로젝트/생성물) — CI 엔 없고 로컬 verify 만
      // 깨뜨리는 로컬↔CI 비대칭이라 lint 대상에서 제외(#221 서 실측).
      // 계약: 이 경로에 git 추적 파일을 두지 말 것 — 두게 되면 blanket ignore 라 무신호 lint 사각이
      // 되므로 이 항목을 재검토한다.
      'deploy/workspace/**',
      '*.config.*',
      '*.config.mjs',
    ],
  },
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
    extends: [tseslint.configs.disableTypeChecked],
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
      // 스타일 룰(버그탐지 아님)이라 끈다. no-unnecessary-type-assertion 은 lint program 이
      // testing-library 타입을 build tsc 와 다르게 해석해 .disabled 접근용 `as HTMLButtonElement`
      // 를 거짓 양성으로 제거(빌드 깨짐) → 게이트는 비동기/unsafe 버그탐지에 집중한다.
      // no-redundant-type-constituents 는 detect.ts spawnError 의 LiteralUnion 문서패턴과 충돌.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // 렌더러 훅 회귀 가드(react-hooks v7 flat.recommended). lint 는 `--max-warnings 0`(package.json)
  // 이라 모든 warn 이 CI 를 막는다 — exhaustive-deps 는 의도 명시를 위해 error 로 유지한다. flat.recommended 의 나머지
  // 룰(set-state-in-effect·set-state-in-render·immutability·refs·purity 등)은 그대로 둔다 — 현 위반 0건이라
  // 공짜 회귀 가드. 의도적 예외(마운트-once·id-keyed effect·set-state-in-effect false-positive/카운트다운
  // 리셋)는 룰 자체를 끄지 않고 전부 각 site 인라인 disable 로 명시한다 → 룰이 다른 곳·향후 신규 코드에서 가드 유지.
  {
    files: ['src/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  // 코어 순수성 게이트(AGENTS.md 「Fleet 특화 P1 신호」 #1): src/main/core 는 electron/DOM-free
  // 순수 TS 계약. 한 줄의 electron import·DOM 전역도 4게이트를 통과하므로(현 위반 0 = 관례일 뿐)
  // 회귀를 기계적으로 차단한다. core *.test.ts 도 포함 — 테스트도 결합을 정상화하지 않는다.
  // #197 B3 부터 서버 전송층(src/server)·공유 전송 계약(src/shared/transport)도 동일 게이트 —
  // 서버는 컨테이너 Node 에서 돌므로 한 줄의 electron import 도 런타임 크래시다.
  {
    files: ['src/main/core/**/*.ts', 'src/server/**/*.ts', 'src/shared/transport/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ELECTRON_IMPORT_PATHS, patterns: ELECTRON_IMPORT_PATTERNS },
      ],
      // object form(globals[]+checkGlobalObject). legacy 위치배열 form 은 checkGlobalObject 가
      // false 로 고정돼 `globalThis.window`·`self.document` 멤버 접근 우회를 놓친다 → object form 채택.
      'no-restricted-globals': [
        'error',
        {
          globals: [
            {
              name: 'window',
              message: '코어는 DOM-free 여야 한다(AGENTS.md P1). 렌더러 전역 window 금지.',
            },
            {
              name: 'document',
              message: '코어는 DOM-free 여야 한다(AGENTS.md P1). 렌더러 전역 document 금지.',
            },
          ],
          checkGlobalObject: true,
        },
      ],
      // no-restricted-imports 는 ImportExpression(동적 import())을 미방문 → 동적 import('electron')
      // 이 정적 import 가드를 우회한다(TS 도 electron 타입 보유라 컴파일 통과). no-restricted-syntax 로 보완.
      'no-restricted-syntax': ['error', ...ELECTRON_DYNAMIC_IMPORT_SYNTAX],
    },
  },
  // 도구 read-only 구조 가드(#174). core 블록보다 뒤라 no-restricted-imports/syntax 를 교체하므로
  // electron 보호를 공유 const 로 재선언(유실 방지). no-restricted-globals 는 미선언 → core 상속.
  // 테스트는 임시 워크스페이스 준비로 fs 변형을 정상 사용 → ignores 로 제외.
  //
  // 의도적 경계 = 정적 분석의 원리적 한계(여기가 floor — 잔여는 행동 계약 테스트[파일 변형 스냅샷]+코드리뷰):
  //   · **계산식 키** computed 접근 — `fs[name]`(런타임 변수)·`fs['w'+'F']`(BinaryExpression)·
  //     `fs[atob(..)]`·`Reflect.get(fs,'writeFile')` 등 키를 식으로 계산하는 경로는 정적 차단 불가.
  //     특히 string-concat 은 정당한 `glob[i+1]`(동일 BinaryExpression computed)과 구분 불가 →
  //     차단 시 false-positive. 임의 컴파일타임 평가는 린터가 풀 수 없음(undecidable).
  //   · eval/Function·process.binding/네이티브 애드온 = 메타프로그래밍 — read 도구에선 비현실적이고
  //     난독화 자체가 리뷰 레드플래그(이 가드는 회귀 트립와이어이지 적대적 샌드박스가 아님).
  // 설계 원칙: 모듈 로더(static/dynamic import·createRequire·require·getBuiltinModule)와 fs변형·spawn 의
  // **호출 지점**을 dot/computed[Literal·Template]/bare/구조분해[식별자·리터럴 키] 형태로 차단 →
  // 정적으로 표현 가능한(키가 상수 리터럴인) 모든 경로를 어떤 로더·별칭이든 포착한다.
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
        ...CHILD_PROCESS_DYNAMIC_IMPORT_SYNTAX,
        ...TOOLS_FS_DYNAMIC_IMPORT_SYNTAX,
        {
          selector: FS_MUTATION_SELECTOR,
          message:
            '도구(src/main/core/tools)는 read-only 계약 — raw fs 변형 메서드 호출 금지(#174). 변형이 필요하면 ApprovalGate 경유 경로를 쓰라.',
        },
        {
          selector: FS_MUTATION_COMPUTED_SELECTOR,
          message:
            '도구(src/main/core/tools)는 read-only 계약 — computed fs 변형 메서드 호출(fs["writeFile"]) 금지(#174).',
        },
        {
          selector: FS_MUTATION_CALL_SELECTOR,
          message:
            '도구(src/main/core/tools)는 read-only 계약 — 구조분해된 fs 변형 함수의 bare 호출(const { writeFile } = fs) 금지(#174).',
        },
        ...FS_MUTATION_DESTRUCTURE_SELECTORS.map((selector) => ({
          selector,
          message:
            '도구(src/main/core/tools)는 read-only 계약 — fs 변형 함수의 별칭 구조분해(const { writeFile: wf } = fs) 금지(#174).',
        })),
        {
          selector: TEMPLATE_COMPUTED_SELECTOR,
          message:
            '도구(src/main/core/tools)는 정적 템플릿 computed 멤버 접근(obj[`name`]) 금지 — 정적 키는 dot 표기(#174). fs변형/spawn 우회 차단.',
        },
        ...CREATEREQUIRE_SYNTAX,
        ...OBFUSCATION_GUARD_SYNTAX,
        ...PROCESS_SPAWN_SYNTAX,
      ],
    },
  },
  // fs 접근 경계 게이트(#282 · Codex PR#282 5R). `ApprovalGate` 예외 열거가 실제와 어긋나지 않게
  // 하는 **구조적 층** — 변이 API 를 이름으로 분류하는 대신 **fs 가 코어에 들어오는 문 자체**를 닫는다.
  // core 블록보다 뒤라 no-restricted-imports/syntax 를 교체하므로 electron 보호를 재선언한다(유실 방지).
  // tools/** 는 자체 블록이 더 강한 계약(read-only)을 걸고 있어 제외 — 여기서 덮으면 그게 약화된다.
  // 테스트·테스트 더블은 임시 워크스페이스 준비로 fs 를 정상 사용 → 제외.
  {
    files: ['src/main/core/**/*.{ts,tsx}'],
    ignores: [
      ...CORE_FS_ALLOWLIST,
      'src/main/core/**/*.test.{ts,tsx}',
      'src/main/core/**/__testing__/**',
      'src/main/core/tools/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ELECTRON_IMPORT_PATHS,
          patterns: [
            ...ELECTRON_IMPORT_PATTERNS,
            {
              group: TOOLS_FS_MODULES,
              message:
                '코어(src/main/core)는 allowlist 밖에서 fs 를 만지지 않는다(#282). 필요하면 eslint.config.mjs 의 CORE_FS_ALLOWLIST 에 등재하고, 변이한다면 AGENTS.md 「ApprovalGate 예외」 열거와 모듈 근거 절을 함께 갱신하라.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...ELECTRON_DYNAMIC_IMPORT_SYNTAX,
        ...CORE_FS_DYNAMIC_IMPORT_SYNTAX,
        ...CORE_LOADER_GUARD_SYNTAX,
        ...CORE_FS_REEXPORT_SYNTAX,
      ],
    },
  },
  // 읽기 전용 티어 집행(#282 · Codex 6R). allowlist 를 「읽기 전용/변이」로 나눠 적어도, 읽기 전용
  // 항목이 어느 날 writeFileSync 를 부르기 시작하면 blanket ignore 라 lint 도 대조 테스트도 무신호였다
  // (티어 라벨이 수동 선언에 그침). tools/**(#174)와 동형 가드를 걸어 라벨을 집행으로 만든다.
  // tools/** 는 더 강한 자체 블록이 있어 제외(여기서 덮으면 약화된다).
  {
    files: CORE_FS_READONLY.filter((f) => !f.startsWith('src/main/core/tools/')),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ELECTRON_IMPORT_PATHS,
          // ⚠ `importNames` 는 쓰지 않는다 — `import * as fs` 를 「전체 import」로 보고 무조건 막아
          // 읽기 전용 네임스페이스 사용(`path-guard.ts` 의 `fs.lstatSync`)까지 오탐한다(실측).
          // 집행은 아래 **호출 지점 셀렉터**(CORE_FS_READONLY_SYNTAX)가 한다 — 별칭·구조분해·computed
          // 전 형태를 잡으므로 import 이름 제한보다 정확하다.
          patterns: ELECTRON_IMPORT_PATTERNS,
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...ELECTRON_DYNAMIC_IMPORT_SYNTAX,
        ...CORE_FS_READONLY_SYNTAX,
        ...CORE_FS_REEXPORT_SYNTAX,
        ...CORE_LOADER_GUARD_SYNTAX,
      ],
    },
  },
  // raw fs 재-export 는 allowlist 안에서도 금지(#282 · 6R). 변이 티어가 능력을 흘리면 소비자가
  // 경계를 우회한다. 코어 전역에 걸되 electron 가드를 함께 재선언한다(rule-key 교체 함정).
  {
    files: CORE_FS_MUTATING,
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ELECTRON_IMPORT_PATHS, patterns: ELECTRON_IMPORT_PATTERNS },
      ],
      'no-restricted-syntax': [
        'error',
        ...ELECTRON_DYNAMIC_IMPORT_SYNTAX,
        ...CORE_FS_REEXPORT_SYNTAX,
      ],
    },
  },
  // 브랜드 위조 차단(#251 PR1b · 스펙 §W-3/§W-4). `BenchLeaseToken`·`Held<L>` 은 미export
  // `unique symbol` 브랜드로 「라이브 핸들에서만 민팅」을 표현하는데, **미export 는 위조를 막지 못한다** —
  // `as unknown as`·`as never`·`Parameters<typeof f>[0]`·`keyof` 로 타입을 구조적으로 재획득하는 우회 4종이
  // tsc 를 전부 통과함이 실측됐다. 이 룰만이 그 4종을 기계적으로 잡는다(어떤 프리셋에도 없는 순수 옵트인).
  //
  // ⚠ 스코프는 **민팅 파일이 아니라 워크벤치 프로덕션 전체**다(Codex PR#259 P1). 민팅 2파일로 한정하면
  // **크레덴셜 소비자가 무방비**로 남는다 — 장차 `authority.ts` 가 `as unknown as BenchLeaseToken` 으로
  // 「`revalidate()` 가 항상 `owned` 를 답하는」 토큰을 지어내면 `withLeaseGuard` 의 변이 인가가 통째로
  // 무력화되는데 tsc·기존 lint 는 둘 다 통과한다. 정당한 협소화(catch 의 `unknown` → `ErrnoException` 등)는
  // 사유를 단 인라인 disable 로 남긴다 = 캐스트가 리뷰에 보이게 만드는 것이 이 룰의 목적이다.
  // 테스트는 제외한다(출하되지 않고, 더블 구성이 정상 관용구다).
  {
    files: ['src/main/core/workbench/**/*.ts'],
    ignores: ['src/main/core/workbench/**/*.test.ts'],
    rules: { '@typescript-eslint/no-unsafe-type-assertion': 'error' },
  },
  // 실패 종별 소진 강제(#251 PR2a · 스펙 §W-4 「모든 CasResult 소비는 default: assertNever」). `CasResult`/`AuthorityReadResult` 는 실패 종별이
  // 10 종을 넘고 PR2b~PR2c·PR3 이 계속 늘린다. `noFallthroughCasesInSwitch` 는 **fall-through 만** 잡고
  // exhaustiveness 는 보지 않으므로, `default: assertNever(x)` 가 있어야 비로소 새 종별이 미처리 호출부를
  // **컴파일 에러**로 만든다. 「default 가 없거나 assertNever 를 부르지 않는 switch」를 `:not(:has(…))` 로
  // 잡는다(실측: ESLint 10.7.0 에서 두 오답 모두 error · 정상형 통과).
  //
  // ⚠ 스코프가 두 파일뿐인 이유는 **랜딩된 `locks.ts` 의 switch 2곳이 즉시 RED** 이기 때문이다(둘 다
  // 반환 타입으로 exhaustive 를 보장하며 `default:` 가 없다) — 무관한 파일 수정을 PR 에 끌어들이지 않는다.
  // ⚠ `no-restricted-syntax` 는 코어 블록(:333)이 이미 쓰는 키다. flat config 는 같은 키를 **교체**하므로
  // (tools 블록 :361 과 같은 함정 · #174) `ELECTRON_DYNAMIC_IMPORT_SYNTAX` 를 여기서 **재선언**하지 않으면
  // 이 두 파일에서 electron 동적 import 보호가 유실된다. `scripts/eslint-config-purity.test.ts` 가 핀한다.
  {
    // ⚠ **디렉터리 전수여야 한다**(#251 PR2b 자체 적대 리뷰 FRAME-09). 파일 2개 exact 로 두면 신규
    // 워크벤치 파일이 `CasResult` 를 소비해도 소진 강제가 **무신호로 적용되지 않는다** — 구조 가드 4종은
    // 전수로 올렸는데 정작 「새 실패 종별을 잡는」 이 게이트만 목록에 남아 있었다.
    // ⚠ `ignores` 로 랜딩된 `locks.ts`·`lock-order.ts` 를 제외한다 — 둘은 반환 타입으로 exhaustive 를
    // 보장하며 `default:` 가 없어 즉시 RED 이고, 무관한 파일 수정을 이 PR 로 끌고 오지 않는다.
    files: ['src/main/core/workbench/**/*.ts'],
    ignores: [
      'src/main/core/workbench/**/*.test.ts',
      'src/main/core/workbench/locks.ts',
      'src/main/core/workbench/lock-order.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ELECTRON_DYNAMIC_IMPORT_SYNTAX,
        {
          selector:
            "SwitchStatement:not(:has(SwitchCase[test=null] CallExpression[callee.name='assertNever']))",
          message:
            '판별 유니온 소비는 `default: assertNever(x)` 로 소진을 강제해야 한다(#251 §W-4) — 새 실패 종별이 추가돼도 미처리 분기가 조용히 통과한다.',
        },
      ],
    },
  },
  // Prettier 와 충돌하는 ESLint 스타일룰 비활성 (반드시 last). 현재 스타일룰 0 이라 즉효는
  // 미미하나, 향후 stylistic 룰 추가 시 포맷 책임을 Prettier 가 단독으로 갖도록 보장하는 가드.
  eslintConfigPrettier,
)

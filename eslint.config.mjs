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
  // Prettier 와 충돌하는 ESLint 스타일룰 비활성 (반드시 last). 현재 스타일룰 0 이라 즉효는
  // 미미하나, 향후 stylistic 룰 추가 시 포맷 책임을 Prettier 가 단독으로 갖도록 보장하는 가드.
  eslintConfigPrettier,
)

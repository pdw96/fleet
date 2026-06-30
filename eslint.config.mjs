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
// import·createRequire·process.getBuiltinModule) 실제 spawn/fork 등 **호출 지점**을 dot/computed/bare
// 형태로 잡는다 → 로더 종류를 일일이 쫓을 필요 없음. import 금지는 흔한 경로의 조기 명확 에러용.
// bare `exec` 는 RegExp.exec 충돌로 제외(execSync/execFile 등은 child_process 전용이라 포함).
const PROCESS_SPAWN_NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork']
const PROCESS_SPAWN_PATTERN = `/^(${PROCESS_SPAWN_NAMES.join('|')})$/`
const PROCESS_SPAWN_SYNTAX = [
  { selector: `MemberExpression[property.name=${PROCESS_SPAWN_PATTERN}]` },
  { selector: `MemberExpression[computed=true][property.value=${PROCESS_SPAWN_PATTERN}]` },
  { selector: `CallExpression[callee.name=${PROCESS_SPAWN_PATTERN}]` },
].map((s) => ({
  ...s,
  message:
    '도구(src/main/core/tools)는 프로세스를 스폰하지 않는다(#174). spawn/fork/execFile 등 호출 금지 — 실행은 sub-agent CLI 경계에 위임.',
}))
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
  {
    files: ['src/main/core/**/*.ts'],
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
  // 의도적 경계(정적 분석 한계 — 잔여는 행동 계약 테스트[파일 변형 스냅샷]+코드리뷰가 보완):
  //   · 변수 키 computed 접근 `fs[name]`(name=런타임 변수)은 정적 판정 불가 — Literal 키만 차단.
  //   · bare `exec`(child_process)는 RegExp.exec 충돌로 제외 — execSync/execFile/spawn/fork 는 차단.
  //   · process.binding/eval/Function·네이티브 애드온 등 우회는 범위 밖(도구에선 비현실적).
  // 설계 원칙: 모듈 로더(static/dynamic import·createRequire·getBuiltinModule)를 쫓지 않고 fs변형·
  // spawn 의 **호출 지점**(dot/computed/bare)을 차단 → 어떻게 로드하든 실제 호출이 잡힌다.
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
        ...PROCESS_SPAWN_SYNTAX,
      ],
    },
  },
  // Prettier 와 충돌하는 ESLint 스타일룰 비활성 (반드시 last). 현재 스타일룰 0 이라 즉효는
  // 미미하나, 향후 stylistic 룰 추가 시 포맷 책임을 Prettier 가 단독으로 갖도록 보장하는 가드.
  eslintConfigPrettier,
)

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default tseslint.config(
  // .claude/** = Claude Code 세션/툴링 상태(gitignore 됨). 특히 워크플로 isolation:worktree 가
  // .claude/worktrees/agent-* 에 레포 복사본(각자 tsconfig·eslint config 보유)을 남기면 typed-lint 의
  // tsconfigRootDir 자동탐지가 "multiple candidate roots" 로 전 파일 파싱에러를 낸다. CI 는 클린
  // 체크아웃이라 무영향이나 로컬 `npm run lint` 가 막힌다 → 린트 대상에서 제외(eslint 는 .gitignore 비적용).
  {
    ignores: [
      'out/**',
      'dist/**',
      'build/**',
      'node_modules/**',
      '.claude/**',
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
  // 렌더러 훅 회귀 가드(react-hooks v7 flat.recommended). exhaustive-deps 는 error 로 승격해 하드
  // 게이트화한다(eslint 가 --max-warnings 0 미사용이라 warn 은 CI 를 못 막음). flat.recommended 의 나머지
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
  // Prettier 와 충돌하는 ESLint 스타일룰 비활성 (반드시 last). 현재 스타일룰 0 이라 즉효는
  // 미미하나, 향후 stylistic 룰 추가 시 포맷 책임을 Prettier 가 단독으로 갖도록 보장하는 가드.
  eslintConfigPrettier,
)

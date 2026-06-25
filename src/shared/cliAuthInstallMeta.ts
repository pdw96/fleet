// CLI 구독 로그인/설치 안내 정적 데이터. main(registry)·renderer(wizard) 공용 단일 출처.
// Electron·main 비의존 순수 데이터(렌더러가 main/core import 회피). docsUrl 은 §6a allowlist 호스트만.
export interface CliAuthInstallMeta {
  loginCommand: string
  installHint: string
  docsUrl: string
}

export const CLI_AUTH_INSTALL_META: Record<'claude' | 'codex' | 'gemini', CliAuthInstallMeta> = {
  claude: {
    loginCommand: 'claude auth login',
    installHint: 'npm i -g @anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    loginCommand: 'codex login',
    installHint: 'npm i -g @openai/codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
  },
  gemini: {
    loginCommand: 'gemini',
    installHint: 'npm i -g @google/gemini-cli',
    docsUrl: 'https://google-gemini.github.io/gemini-cli/',
  },
}

// §6a 클릭형 외부열기(가드된 후속) host allowlist. v1 copy-only 라 열지 않지만 docsUrl 검증·후속 공유.
// 스펙 §6a 9-host 와 동일 집합(현 docsUrl 호스트는 이 중 3개 부분집합 — 테스트가 ⊆ 강제).
export const DOCS_HOST_ALLOWLIST = [
  'docs.anthropic.com',
  'support.anthropic.com',
  'claude.ai',
  'developers.openai.com',
  'help.openai.com',
  'openai.com',
  'ai.google.dev',
  'cloud.google.com',
  'google-gemini.github.io',
]

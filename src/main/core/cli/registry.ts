import type { CliAdapter } from '../../../shared/types'

/**
 * 기본 CLI 어댑터 (요구사항 2A). 구독제/TUI 기반 LLM CLI.
 * 새 CLI 는 여기에 추가하거나 런타임에 registry.register() 로 확장한다.
 */
export const DEFAULT_CLI_ADAPTERS: readonly CliAdapter[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    headless: { args: ['-p', '{prompt}'] },
    // 세션 재개(검증: v2.1.162). UUID 사전지정 → 첫 호출 --session-id, 이후 --resume.
    session: {
      startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
      resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
      idSource: 'preassigned',
    },
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    // --json: 사람용 배너/thinking/토큰 메타 대신 JSONL 이벤트로 출력 → agent_message 만 정제.
    headless: { args: ['exec', '--json', '{prompt}'], parse: 'codex-jsonl' },
    // 세션 재개(실측: codex 0.136). id 사전지정 불가 → 첫 응답 thread.started 의 thread_id 캡처.
    // resume 시그니처: `exec resume [OPTIONS] <SESSION_ID> <PROMPT>` (옵션 먼저).
    session: {
      startArgs: ['exec', '--json', '{prompt}'],
      resumeArgs: ['exec', 'resume', '--json', '{sessionId}', '{prompt}'],
      idSource: 'codex-thread',
    },
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    versionArgs: ['--version'],
    headless: { args: ['-p', '{prompt}'] },
    // 세션 재개(실측: gemini 0.45.0, 코드워드 왕복 통과). claude 와 동형(UUID 사전지정).
    session: {
      startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
      resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
      idSource: 'preassigned',
    },
  },
]

export interface CliRegistry {
  list(): CliAdapter[]
  register(adapter: CliAdapter): void
  get(id: string): CliAdapter | undefined
}

/** 확장 가능한 CLI 레지스트리 — 기본 어댑터로 시드된다. */
export function createCliRegistry(seed: readonly CliAdapter[] = DEFAULT_CLI_ADAPTERS): CliRegistry {
  const map = new Map<string, CliAdapter>(seed.map((a) => [a.id, a]))
  return {
    list: () => [...map.values()],
    register: (adapter) => {
      map.set(adapter.id, adapter)
    },
    get: (id) => map.get(id),
  }
}

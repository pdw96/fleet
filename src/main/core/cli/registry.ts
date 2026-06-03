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
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    headless: { args: ['exec', '{prompt}'] },
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    versionArgs: ['--version'],
    headless: { args: ['-p', '{prompt}'] },
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

import { describe, expect, it } from 'vitest'
import { CLI_AUTH_INSTALL_META, DOCS_HOST_ALLOWLIST } from './cliAuthInstallMeta'

describe('shared CLI auth/install metadata', () => {
  it('claude/codex/gemini 모두 loginCommand·installHint·https docsUrl', () => {
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const m = CLI_AUTH_INSTALL_META[id]
      expect(m.loginCommand).toBeTruthy()
      expect(m.installHint).toBeTruthy()
      expect(m.docsUrl.startsWith('https://')).toBe(true)
    }
  })
  it('모든 docsUrl host 가 allowlist 안에 있다 (§6a 보안 입력)', () => {
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const host = new URL(CLI_AUTH_INSTALL_META[id].docsUrl).host
      expect(DOCS_HOST_ALLOWLIST).toContain(host)
    }
  })
})

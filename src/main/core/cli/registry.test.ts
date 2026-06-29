import { describe, expect, it } from 'vitest'
import { DEFAULT_CLI_ADAPTERS, createCliRegistry } from './registry'
import { CLI_AUTH_INSTALL_META } from '../../../shared/cliAuthInstallMeta'

describe('CLI adapter auth/install (shared 단일 출처)', () => {
  it('registry 어댑터가 shared 메타와 일치한다 (drift 0)', () => {
    const reg = createCliRegistry()
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const a = reg.get(id)!
      const m = CLI_AUTH_INSTALL_META[id]
      expect(a.auth).toEqual({ loginCommand: m.loginCommand, docsUrl: m.docsUrl })
      expect(a.install).toEqual({ hint: m.installHint, docsUrl: m.docsUrl })
    }
  })
  it('어댑터는 IPC 직렬화 가능 — 함수 필드 없음', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_CLI_ADAPTERS))).toEqual(DEFAULT_CLI_ADAPTERS)
  })
  it('codex 분석(headless)은 read-only 샌드박스 + 승인 억제로 강제하고 편집만 workspace-write 다 (#165 P1/P2)', () => {
    const codex = createCliRegistry().get('codex')!
    // 분석(planner/reviewer/summarizer)은 config 기본값과 무관하게 read-only + 비인터랙티브 승인.
    expect(codex.headless?.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--config',
      'approval_policy="never"',
    ])
    // 편집 모드만 workspace-write.
    expect(codex.edit?.args).toContain('workspace-write')
  })
})

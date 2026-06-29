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

  // #167: 스폰 claude implementer 가 자기 산출물을 self-verify(node --check 등) 하도록
  // read-only 검증 도구를 --allowedTools 로 자동 허용한다. acceptEdits 단독은 이런 Bash 를
  // "requires approval" 로 차단(실측 claude 2.1.195) → 헤드리스엔 승인 경로 없어 수동리뷰 폴백.
  const claudeAllowedTools = (): string => {
    const args = createCliRegistry().get('claude')!.edit!.args
    const i = args.indexOf('--allowedTools')
    expect(i).toBeGreaterThanOrEqual(0)
    return args[i + 1]
  }

  it('claude 편집은 read-only 검증 도구(node --check·tsc --noEmit)를 자동 허용한다 (#167)', () => {
    const claude = createCliRegistry().get('claude')!
    // 기존 편집 권한 모드 유지(전체 우회 아님).
    expect(claude.edit?.args).toContain('acceptEdits')
    const value = claudeAllowedTools()
    expect(value).toContain('Bash(node --check:*)') // JS 구문 파싱(무실행)
    expect(value).toContain('Bash(tsc --noEmit:*)') // TS 타입체크(무emit)
  })

  it('claude 검증 allowlist 는 read-only 한정 — 쓰기/임의실행 명령 미포함 (#167)', () => {
    // 허용 엔트리는 전부 read-only 검증 명령이어야 한다(쓰기·임의 코드실행·우회 금지).
    const READONLY_ONLY = new Set([
      'Bash(node --check:*)',
      'Bash(tsc --noEmit)',
      'Bash(tsc --noEmit:*)',
    ])
    for (const entry of claudeAllowedTools().split(',')) {
      expect(READONLY_ONLY.has(entry)).toBe(true)
    }
    // 전체 우회 플래그/모드는 채택하지 않는다.
    const args = createCliRegistry().get('claude')!.edit!.args
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('bypassPermissions')
  })

  it('gemini·codex 편집은 allowlist 플래그를 쓰지 않는다 — claude-only (#167 무회귀)', () => {
    const reg = createCliRegistry()
    for (const id of ['gemini', 'codex'] as const) {
      const args = reg.get(id)!.edit!.args
      expect(args).not.toContain('--allowedTools')
      expect(args).not.toContain('--allowed-tools')
    }
  })
})

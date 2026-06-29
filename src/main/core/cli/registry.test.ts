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

  // [#167] 편집 어댑터는 검증 도구(node --check 등)를 --allowedTools/--allowed-tools 로 자동허용하지
  // 않는다(의도적). `Bash(node --check:*)` 같은 prefix allow 규칙은 후행 인자를 임의 매칭하는데, node
  // preload 플래그(--require/--import/--experimental-loader)가 --check 에도 코드를 실행해(실측: claude
  // 가 `node --check --import "data:..."` 를 무프롬프트 자동승인·실행) acceptEdits 의 "쓰기만·실행 차단"
  // 경계를 RCE+네트워크로 깬다. prefix 규칙으로는 이 부정 제약을 표현 불가 → 구조적으로 안전화 못 함.
  // 이 테스트는 그 결정을 고정해 naive 한 재도입(보안 회귀)을 막는다.
  it('편집 어댑터는 검증 도구 자동허용(allowlist) 플래그·우회 모드를 두지 않는다 (#167 보안)', () => {
    const reg = createCliRegistry()
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const args = reg.get(id)!.edit!.args
      // 베어 플래그뿐 아니라 `--allowedTools=…` 같은 =value 형태 재도입도 막는다(CodeRabbit).
      for (const flag of ['--allowedTools', '--allowed-tools', '--dangerously-skip-permissions']) {
        expect(args.some((a) => a === flag || a.startsWith(`${flag}=`))).toBe(false)
      }
      // bypassPermissions: 베어 토큰·`--permission-mode=bypassPermissions`·`--permission-mode bypassPermissions` 전부 차단.
      expect(
        args.some(
          (a, i) =>
            a === 'bypassPermissions' ||
            a === '--permission-mode=bypassPermissions' ||
            (a === '--permission-mode' && args[i + 1] === 'bypassPermissions'),
        ),
      ).toBe(false)
    }
    // claude 편집 권한 모드는 종전 acceptEdits 유지(편집만 자동승인, 전체 우회 아님).
    expect(reg.get('claude')!.edit!.args).toEqual(['-p', '--permission-mode', 'acceptEdits'])
  })
})

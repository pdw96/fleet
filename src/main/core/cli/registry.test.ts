import { describe, expect, it } from 'vitest'
import { DEFAULT_CLI_ADAPTERS, containerCliAdapters, createCliRegistry } from './registry'
import { CLI_AUTH_INSTALL_META } from '../../../shared/cliAuthInstallMeta'
import { createCliSession } from '../session/cli-session'
import type { CommandRunner } from './detect'
import type { CliAdapter, LlmDescriptor } from '../../../shared/types'

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

describe('container posture variant (#214 C2 · T0 확정 args)', () => {
  const find = (adapters: readonly CliAdapter[], id: string) => adapters.find((a) => a.id === id)!
  const baseCodex = () => find(DEFAULT_CLI_ADAPTERS, 'codex')
  const varCodex = () => find(containerCliAdapters(), 'codex')

  // T0 실측 확정(CODEX_VERSION 0.142.5 컨테이너 · #214 코멘트 4900663228) — exact 전량 핀(toContain 금지).
  it('codex headless — danger-full-access + approval never + skip', () => {
    expect(varCodex().headless?.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '--config',
      'approval_policy="never"',
      '--skip-git-repo-check',
    ])
  })

  it('codex session.startArgs — 샌드박스·승인·skip 명시(CLI config 기본값 의존 제거)', () => {
    expect(varCodex().session?.startArgs).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '--config',
      'approval_policy="never"',
      '--skip-git-repo-check',
    ])
  })

  it('codex session.resumeArgs — resume 은 --sandbox 미수용(T0①) → --config sandbox_mode 라우트·{sessionId} 마지막', () => {
    expect(varCodex().session?.resumeArgs).toEqual([
      'exec',
      'resume',
      '--json',
      '--config',
      'sandbox_mode="danger-full-access"',
      '--config',
      'approval_policy="never"',
      '--skip-git-repo-check',
      '{sessionId}',
    ])
  })

  it('codex edit — -s danger-full-access + skip', () => {
    expect(varCodex().edit?.args).toEqual([
      'exec',
      '--json',
      '-C',
      '{workspace}',
      '-s',
      'danger-full-access',
      '--skip-git-repo-check',
    ])
  })

  it('codex 비-args 필드는 base 승계(parse·idSource·promptVia·streaming·auth·install·command·modelFlag)', () => {
    const base = baseCodex()
    const v = varCodex()
    expect(v.promptVia).toBe(base.promptVia)
    expect(v.command).toBe(base.command)
    expect(v.modelFlag).toBe(base.modelFlag)
    expect(v.headless?.parse).toBe(base.headless?.parse)
    expect(v.edit?.parse).toBe(base.edit?.parse)
    expect(v.session?.idSource).toBe(base.session?.idSource)
    expect(v.streaming).toEqual(base.streaming)
    expect(v.auth).toEqual(base.auth)
    expect(v.install).toEqual(base.install)
  })

  it.each(['claude', 'gemini'] as const)('%s 무조정 — base 어댑터 그대로(toEqual)', (id) => {
    expect(find(containerCliAdapters(), id)).toEqual(find(DEFAULT_CLI_ADAPTERS, id))
  })

  it('순수성 — base(DEFAULT_CLI_ADAPTERS) 불변·호출마다 새 배열·codex 는 새 객체', () => {
    const snapshot = JSON.parse(JSON.stringify(DEFAULT_CLI_ADAPTERS))
    const a = containerCliAdapters()
    const b = containerCliAdapters()
    expect(JSON.parse(JSON.stringify(DEFAULT_CLI_ADAPTERS))).toEqual(snapshot) // base 불변(비파괴 diff-spread)
    expect(a).not.toBe(b) // 호출마다 새 배열
    expect(a).toEqual(b) // 내용 동등
    expect(find(a, 'codex')).not.toBe(baseCodex()) // codex 는 파생 새 객체(base 미변형)
  })

  it('IPC 직렬화 가능 — 함수 필드 0(JSON 왕복 동등)', () => {
    const v = containerCliAdapters()
    expect(JSON.parse(JSON.stringify(v))).toEqual(v)
  })

  it('토큰 위치 — {sessionId} 정확 1회·resumeArgs 마지막 positional·{workspace} edit 1회', () => {
    const codex = varCodex()
    const resume = codex.session!.resumeArgs
    expect(resume.filter((a) => a === '{sessionId}')).toHaveLength(1)
    expect(resume.at(-1)).toBe('{sessionId}')
    expect(codex.edit!.args.filter((a) => a === '{workspace}')).toHaveLength(1)
  })

  // #167 스윕 확장 — container variant 도 우회/자동허용 플래그 없음 + #165 hang 회귀 방지(approval never 잔존).
  it('#167 스윕 + #165 잔존 — variant 우회 플래그 부재·approval_policy 잔존', () => {
    const reg = createCliRegistry(containerCliAdapters())
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      const args = reg.get(id)!.edit!.args
      for (const flag of ['--allowedTools', '--allowed-tools', '--dangerously-skip-permissions']) {
        expect(args.some((a) => a === flag || a.startsWith(`${flag}=`))).toBe(false)
      }
    }
    const codex = reg.get('codex')!
    const codexPaths = [
      codex.headless!.args,
      codex.session!.startArgs,
      codex.session!.resumeArgs,
      codex.edit!.args,
    ]
    for (const args of codexPaths) {
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(args).not.toContain('--yolo')
    }
    // #165 회귀 방지 — headless·session 은 승인 억제 잔존(서버 모드 hang 방지).
    expect(codex.headless!.args).toContain('approval_policy="never"')
    expect(codex.session!.startArgs).toContain('approval_policy="never"')
    expect(codex.session!.resumeArgs).toContain('approval_policy="never"')
  })

  // 유효-argv 회귀(Codex 1R/2R 필수) — 템플릿 핀만으론 extraArgs() 후행 결합을 못 잡는다. stateful codex +
  // model 로 fake runner 가 캡처한 실제 argv 가 T0⑥ 실측 수용 형태({sessionId} 뒤 --model 트레일)인지 단언.
  it('유효 argv — stateful codex + model: start/resume 실제 argv 가 T0⑥ 수용 형태', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      const stdout =
        calls.length === 1
          ? '{"type":"thread.started","thread_id":"tid-9"}\n{"type":"item.completed","item":{"type":"agent_message","text":"R1"}}'
          : '{"type":"item.completed","item":{"type":"agent_message","text":"R2"}}'
      return { code: 0, stdout, stderr: '' }
    }
    const desc: LlmDescriptor = {
      id: 'codex',
      kind: 'cli',
      displayName: 'Codex',
      ref: 'codex',
      model: 'gpt-5-codex',
    }
    const s = createCliSession(desc, varCodex(), runner, undefined, { stateful: true })
    expect(await s.send('q1')).toBe('R1') // start
    expect(await s.send('q2')).toBe('R2') // resume
    // codex promptVia=stdin → 프롬프트는 argv 부재. extraArgs(--model)는 템플릿 뒤에 트레일.
    expect(calls[0]).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '--config',
      'approval_policy="never"',
      '--skip-git-repo-check',
      '--model',
      'gpt-5-codex',
    ])
    // {sessionId}=tid-9(캡처) 뒤에 --model 트레일 = T0⑥ 실측 수용 형태(positional 뒤 옵션).
    expect(calls[1]).toEqual([
      'exec',
      'resume',
      '--json',
      '--config',
      'sandbox_mode="danger-full-access"',
      '--config',
      'approval_policy="never"',
      '--skip-git-repo-check',
      'tid-9',
      '--model',
      'gpt-5-codex',
    ])
  })
})

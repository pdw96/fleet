import { describe, it, expect } from 'vitest'
import { defaultRunner, detectAll, detectCli, parseVersion, type CommandRunner } from './detect'
import { createCliRegistry, DEFAULT_CLI_ADAPTERS } from './registry'
import type { CliAdapter } from '../../../shared/types'

const claude: CliAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],
}

describe('parseVersion', () => {
  it('extracts a semver from version output', () => {
    expect(parseVersion('claude 1.2.3')).toBe('1.2.3')
    expect(parseVersion('v2.1.154 (build abc)')).toBe('2.1.154')
    expect(parseVersion('1.0.0-beta.2')).toBe('1.0.0-beta.2')
  })

  it('returns undefined when there is no version', () => {
    expect(parseVersion('no version here')).toBeUndefined()
  })
})

describe('detectCli', () => {
  it('marks installed and parses version on exit 0', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: 'claude 1.2.3\n', stderr: '' })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(true)
    expect(r.version).toBe('1.2.3')
    expect(r.kind).toBe('cli')
  })

  it('marks not installed when command is missing (ENOENT)', async () => {
    const runner: CommandRunner = async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(false)
    expect(r.version).toBeUndefined()
    expect(r.error).toBe('ENOENT')
  })

  it('marks not installed on non-zero exit', async () => {
    const runner: CommandRunner = async () => ({ code: 127, stdout: '', stderr: 'not found' })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(false)
    expect(r.error).toContain('127')
  })

  it('reads version from stderr when stdout is empty', async () => {
    const runner: CommandRunner = async () => ({ code: 0, stdout: '', stderr: 'gemini 0.4.1' })
    const r = await detectCli(claude, runner)
    expect(r.installed).toBe(true)
    expect(r.version).toBe('0.4.1')
  })
})

describe('detectAll', () => {
  it('detects across multiple adapters', async () => {
    const runner: CommandRunner = async (cmd) =>
      cmd === 'claude'
        ? { code: 0, stdout: '1.0.0', stderr: '' }
        : { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }

    const results = await detectAll(DEFAULT_CLI_ADAPTERS, runner)
    expect(results).toHaveLength(3)
    expect(results.find((r) => r.id === 'claude')?.installed).toBe(true)
    expect(results.find((r) => r.id === 'codex')?.installed).toBe(false)
    expect(results.find((r) => r.id === 'gemini')?.installed).toBe(false)
  })
})

describe('defaultRunner (integration)', () => {
  // 회귀: 러너가 자식 stdin 을 닫지 않으면 stdin 을 읽는 CLI(claude -p 등)가 멈춘다.
  it('closes child stdin so stdin-reading commands do not hang', async () => {
    const script =
      "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>process.stdout.write('done:'+n))"
    const res = await defaultRunner('node', ['-e', script], 10_000)
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('done:0')
  }, 15_000)
})

describe('createCliRegistry', () => {
  it('seeds with the default adapters', () => {
    const reg = createCliRegistry()
    expect(reg.list().map((a) => a.id).sort()).toEqual(['claude', 'codex', 'gemini'])
  })

  it('allows registering a new CLI (extensibility)', () => {
    const reg = createCliRegistry()
    reg.register({ id: 'cursor', displayName: 'Cursor CLI', command: 'cursor-agent', versionArgs: ['--version'] })
    expect(reg.get('cursor')?.command).toBe('cursor-agent')
    expect(reg.list()).toHaveLength(4)
  })
})

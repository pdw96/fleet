import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    const res = await defaultRunner('node', ['-e', script], { timeoutMs: 10_000 })
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('done:0')
  }, 15_000)

  // 회귀: maxBuffer 초과 시 child 를 죽이고 명시적 에러를 반환해야 한다(조용한 truncation / 무한 매달림 방지).
  it('errors with ENOBUFS when output exceeds the max buffer', async () => {
    const script = "process.stdout.write('x'.repeat(11*1024*1024))"
    const res = await defaultRunner('node', ['-e', script], { timeoutMs: 10_000 })
    expect(res.spawnError).toBe('ENOBUFS')
  }, 15_000)

  it('runs the child in the given cwd', async () => {
    const res = await defaultRunner('node', ['-e', 'process.stdout.write(process.cwd())'], {
      timeoutMs: 10_000,
      cwd: tmpdir(),
    })
    expect(res.code).toBe(0)
    expect(res.stdout.length).toBeGreaterThan(0)
    expect(res.stdout).toContain(tmpdir().split(/[\\/]/).pop() as string)
  })

  it('kills the child when the abort signal fires', async () => {
    const ac = new AbortController()
    const p = defaultRunner('node', ['-e', 'setTimeout(()=>{}, 60000)'], {
      timeoutMs: 30_000,
      signal: ac.signal,
    })
    ac.abort()
    const res = await p
    expect(res.code).not.toBe(0)
  })
})

describe.skipIf(process.platform !== 'win32')('defaultRunner (Windows .cmd shim regression)', () => {
  // 회귀: npm 설치 CLI(gemini.cmd 등)는 .cmd 배치 셰임이다. execFile 은 bare 이름을
  // PATHEXT 로 해석 못 해 ENOENT, .cmd 명시 시엔 Node 20+ 가드로 EINVAL. cross-spawn 이 둘 다 해결.
  it('resolves and runs a bare command name backed only by a .cmd shim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-cli-'))
    const prevPath = process.env.PATH
    try {
      writeFileSync(join(dir, 'mycli.cmd'), '@echo off\r\necho mycli 7.8.9\r\n')
      process.env.PATH = `${dir};${prevPath ?? ''}`
      const res = await defaultRunner('mycli', ['--version'], { timeoutMs: 10_000 })
      expect(res.spawnError).toBeUndefined()
      expect(res.code).toBe(0)
      expect(parseVersion(res.stdout)).toBe('7.8.9')
    } finally {
      process.env.PATH = prevPath
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  // 보안 회귀: 임의 인자(헤드리스 {prompt})에 cmd.exe 메타문자가 있어도 명령 주입이 일어나지 않아야 한다.
  it('does not allow command injection via a malicious argument', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-inj-'))
    const marker = join(dir, 'pwned.txt')
    try {
      writeFileSync(join(dir, 'echoarg.cmd'), '@echo off\r\necho GOT %1\r\n')
      // 주입이 가능하면 체이닝된 'echo > marker' 가 실행되어 marker 파일이 생긴다.
      const payload = `x" & echo pwned> "${marker}" & echo "y`
      const res = await defaultRunner(join(dir, 'echoarg.cmd'), [payload], { timeoutMs: 10_000 })
      expect(res.spawnError).toBeUndefined()
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

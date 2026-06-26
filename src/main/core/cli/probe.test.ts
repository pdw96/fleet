import { describe, expect, it } from 'vitest'
import type { CliAdapter } from '../../../shared/types'
import type { CommandResult, CommandRunner, RunOpts } from './detect'
import { PROBE_PROMPT, PROBE_TIMEOUT_MS, probeCliAuth } from './probe'

const claude: CliAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],
  promptVia: 'stdin',
  headless: { args: ['-p'] },
  auth: { loginCommand: 'claude /login', docsUrl: 'https://docs.anthropic.com' },
}

// 호출 인자를 캡처하면서 지정 결과를 돌려주는 mock runner.
function mockRunner(result: CommandResult): {
  runner: CommandRunner
  calls: { command: string; args: string[]; opts: RunOpts; stdin?: string }[]
} {
  const calls: { command: string; args: string[]; opts: RunOpts; stdin?: string }[] = []
  const runner: CommandRunner = (command, args, opts) => {
    calls.push({ command, args, opts, stdin: opts.stdinInput })
    return Promise.resolve(result)
  }
  return { runner, calls }
}

const ok = (over: Partial<CommandResult> = {}): CommandResult => ({
  code: 0,
  stdout: 'ok',
  stderr: '',
  ...over,
})

describe('probeCliAuth', () => {
  it('exit 0 → ok', async () => {
    const { runner } = mockRunner(ok())
    expect(await probeCliAuth(claude, runner)).toEqual({ status: 'ok' })
  })

  it('exit≠0 + auth stderr → auth + hint', async () => {
    const { runner } = mockRunner(ok({ code: 1, stdout: '', stderr: 'Error: not logged in' }))
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('auth')
    expect(r.hint).toContain('claude /login')
  })

  it('exit≠0 + 비-auth stderr → error + detail', async () => {
    const { runner } = mockRunner(
      ok({ code: 2, stdout: '', stderr: 'syntax error near unexpected token' }),
    )
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('error')
    expect(r.detail).toContain('syntax error')
  })

  it('spawnError ETIMEDOUT → timeout', async () => {
    const { runner } = mockRunner({ code: null, stdout: '', stderr: '', spawnError: 'ETIMEDOUT' })
    expect(await probeCliAuth(claude, runner)).toEqual({ status: 'timeout' })
  })

  it('spawnError ABORTED → timeout', async () => {
    const { runner } = mockRunner({ code: null, stdout: '', stderr: '', spawnError: 'ABORTED' })
    expect(await probeCliAuth(claude, runner)).toEqual({ status: 'timeout' })
  })

  it('spawnError ENOBUFS → error (timeout 아님)', async () => {
    const { runner } = mockRunner({ code: null, stdout: '', stderr: 'x', spawnError: 'ENOBUFS' })
    expect((await probeCliAuth(claude, runner)).status).toBe('error')
  })

  it('argv=buildHeadlessArgs · stdin=PROBE_PROMPT(stdin 어댑터) · timeout 상수 전달', async () => {
    const { runner, calls } = mockRunner(ok())
    await probeCliAuth(claude, runner)
    expect(calls[0].command).toBe('claude')
    expect(calls[0].args).toEqual(['-p'])
    expect(calls[0].stdin).toBe(PROBE_PROMPT)
    expect(calls[0].opts.timeoutMs).toBe(PROBE_TIMEOUT_MS)
  })

  it("promptVia:'arg' 어댑터 → stdin 없음 · argv 에 PROBE_PROMPT 치환", async () => {
    const argAdapter: CliAdapter = {
      ...claude,
      promptVia: 'arg',
      headless: { args: ['run', '{prompt}'] },
    }
    const { runner, calls } = mockRunner(ok())
    await probeCliAuth(argAdapter, runner)
    expect(calls[0].stdin).toBeUndefined()
    expect(calls[0].args).toEqual(['run', PROBE_PROMPT])
  })

  it('headless 없는 어댑터 → buildHeadlessArgs fallback [PROBE_PROMPT]', async () => {
    const noHeadless: CliAdapter = { ...claude, promptVia: 'arg', headless: undefined }
    const { runner, calls } = mockRunner(ok())
    await probeCliAuth(noHeadless, runner)
    expect(calls[0].args).toEqual([PROBE_PROMPT])
  })

  it('detail: ANSI/제어시퀀스 제거 + 500자 truncation', async () => {
    const noisy = '\x1b[31mnot a hint\x1b[0m ' + 'x'.repeat(600)
    const { runner } = mockRunner(ok({ code: 1, stdout: '', stderr: noisy }))
    const r = await probeCliAuth(claude, runner)
    expect(r.detail).not.toContain('\x1b')
    expect((r.detail ?? '').length).toBeLessThanOrEqual(500)
  })

  it('detail: stderr 비면 stdout 폴백에도 sanitize/truncation 적용', async () => {
    const noisy = '\x1b[33m' + 'y'.repeat(600)
    const { runner } = mockRunner(ok({ code: 1, stdout: noisy, stderr: '' }))
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('error')
    expect(r.detail).toContain('y')
    expect(r.detail).not.toContain('\x1b')
    expect((r.detail ?? '').length).toBeLessThanOrEqual(500)
  })

  it('detail: stderr 가 ANSI/제어뿐이면 strip 후 stdout 으로 폴백', async () => {
    const { runner } = mockRunner(
      ok({ code: 1, stdout: 'real failure detail', stderr: '\x1b[2J\x1b[0m' }),
    )
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('error')
    expect(r.detail).toBe('real failure detail')
  })

  it('detail: stderr 가 OSC escape 뿐이어도 stdout 으로 폴백(non-CSI)', async () => {
    const { runner } = mockRunner(
      ok({ code: 1, stdout: 'real failure detail', stderr: '\x1b]8;;https://x\x07\x1b]8;;\x07' }),
    )
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('error')
    expect(r.detail).toBe('real failure detail')
  })

  it('stderr 가 제어뿐이고 stdout 에 auth 실패 → auth + hint(분류도 폴백)', async () => {
    const { runner } = mockRunner(
      ok({ code: 1, stdout: 'Error: not logged in', stderr: '\x1b[2K\x1b[1G' }),
    )
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('auth')
    expect(r.hint).toContain('claude /login')
  })

  it('detail: private CSI(\\x1b[>4;2m)·standalone ESC(\\x1bc) 제거 후 stdout 폴백', async () => {
    const { runner } = mockRunner(ok({ code: 1, stdout: 'real err', stderr: '\x1b[>4;2m\x1bc' }))
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('error')
    expect(r.detail).toBe('real err')
  })

  it('spawnError detail 도 sanitize/truncation 적용', async () => {
    const msg = '\x1b[31m' + 'z'.repeat(600)
    const { runner } = mockRunner({ code: null, stdout: '', stderr: '', spawnError: msg })
    const r = await probeCliAuth(claude, runner)
    expect(r.status).toBe('error')
    expect(r.detail).not.toContain('\x1b')
    expect((r.detail ?? '').length).toBeLessThanOrEqual(500)
  })

  it('어떤 결과에서도 throw 하지 않는다(never-throws)', async () => {
    const cases: CommandResult[] = [
      ok(),
      ok({ code: 1, stderr: 'not logged in' }),
      { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' },
    ]
    for (const res of cases) {
      const { runner } = mockRunner(res)
      await expect(probeCliAuth(claude, runner)).resolves.toBeDefined()
    }
  })

  it('runner reject 도 throw 없이 error 로 정규화한다', async () => {
    const runner: CommandRunner = () => Promise.reject(new Error('boom'))
    await expect(probeCliAuth(claude, runner)).resolves.toMatchObject({ status: 'error' })
  })
})

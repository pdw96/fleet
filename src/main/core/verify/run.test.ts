import { describe, expect, it } from 'vitest'
import {
  allPassed,
  defaultVerifyRunner,
  runAllVerifications,
  runVerification,
  summarizeFailure,
  type VerifyRunner,
} from './run'

describe('summarizeFailure', () => {
  it('extracts the first error-like line', () => {
    expect(summarizeFailure('ok\nTypeError: boom\nmore', '')).toContain('TypeError: boom')
  })
  it('falls back to the last non-empty line', () => {
    expect(summarizeFailure('a\nb\nc', '')).toBe('c')
  })
})

describe('runVerification', () => {
  it('passes on exit 0 with no analysis', async () => {
    const runner: VerifyRunner = async () => ({ code: 0, stdout: 'all good', stderr: '' })
    let t = 0
    const now = (): number => (t += 5)
    const r = await runVerification(
      { kind: 'test', command: 'npm', args: ['test'] },
      { runner, now },
    )
    expect(r.passed).toBe(true)
    expect(r.analysis).toBeUndefined()
    expect(r.command).toBe('npm test')
    expect(r.durationMs).toBe(5)
  })

  it('fails on non-zero exit with analysis', async () => {
    const runner: VerifyRunner = async () => ({ code: 1, stdout: '', stderr: 'Error: nope' })
    const r = await runVerification({ kind: 'lint', command: 'eslint', args: ['.'] }, { runner })
    expect(r.passed).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(r.analysis).toContain('Error: nope')
  })

  it('handles spawn errors (missing command)', async () => {
    const runner: VerifyRunner = async () => ({
      code: null,
      stdout: '',
      stderr: '',
      spawnError: 'ENOENT',
    })
    const r = await runVerification({ kind: 'smoke', command: 'missing', args: [] }, { runner })
    expect(r.passed).toBe(false)
    expect(r.analysis).toContain('ENOENT')
  })

  it('forwards the abort signal to the injected runner', async () => {
    let received: AbortSignal | undefined
    const controller = new AbortController()
    const runner: VerifyRunner = async (_cmd, _timeout, signal) => {
      received = signal
      return { code: 0, stdout: '', stderr: '' }
    }
    await runVerification(
      { kind: 'test', command: 'npm', args: ['test'] },
      { runner, signal: controller.signal },
    )
    expect(received).toBe(controller.signal)
  })
})

describe('defaultVerifyRunner', () => {
  it('defaultVerifyRunner reports timeout as spawnError, not exit code', async () => {
    const res = await defaultVerifyRunner(
      { kind: 'custom', command: 'node', args: ['-e', 'setTimeout(()=>{},5000)'] },
      200,
    )
    expect(res.spawnError).toBe('ETIMEDOUT')
  }, 10_000)

  it('reports an aborted run as spawnError ABORTED, not a normal failure', async () => {
    // 이미 abort 된 신호를 넘기면 자식이 즉시 죽고 ABORTED 로 보고돼야 한다(타임아웃 만료를 기다리지 않음).
    const res = await defaultVerifyRunner(
      { kind: 'custom', command: 'node', args: ['-e', 'setTimeout(()=>{},5000)'] },
      30_000,
      AbortSignal.abort(),
    )
    expect(res.spawnError).toBe('ABORTED')
    expect(res.code).toBeNull()
  }, 10_000)

  // win32 회귀(#158 형제 결함): npm 은 Windows 에서 npm.cmd(배치 셰임)라 raw execFile('npm') 은
  // ENOENT 로 실패한다(셰임 미해석). verify 는 워크스페이스(custom cwd)에서 npm 스크립트를 돌리므로
  // cross-spawn 기반 실행기(PATHEXT 셰임 해석 + cmd.exe 인자 이스케이프 + PATH-only cwd-셰도 차단)를
  // 거쳐야 한다. cwd 를 줘 win32 PATH-only 해석 경로를 실제로 태운다.
  it('runs npm (a Windows .cmd shim) in a workspace cwd without ENOENT', async () => {
    const res = await defaultVerifyRunner(
      { kind: 'test', command: 'npm', args: ['--version'], cwd: process.cwd() },
      30_000,
    )
    expect(res.spawnError).toBeUndefined()
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  }, 35_000)
})

describe('runAllVerifications / allPassed', () => {
  it('aggregates results and reports overall pass state', async () => {
    const runner: VerifyRunner = async (cmd) =>
      cmd.kind === 'lint'
        ? { code: 1, stdout: '', stderr: 'fail' }
        : { code: 0, stdout: '', stderr: '' }
    const results = await runAllVerifications(
      [
        { kind: 'typecheck', command: 'tsc', args: [] },
        { kind: 'lint', command: 'eslint', args: [] },
      ],
      { runner },
    )
    expect(results).toHaveLength(2)
    expect(allPassed(results)).toBe(false)
  })

  it('allPassed is false for an empty result set', () => {
    expect(allPassed([])).toBe(false)
  })
})

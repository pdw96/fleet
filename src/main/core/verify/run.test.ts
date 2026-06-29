import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  allPassed,
  defaultVerifyRunner,
  isNoOpScript,
  npmVerifyCommands,
  runAllVerifications,
  runVerification,
  summarizeFailure,
  type VerifyRunner,
} from './run'
import * as detect from '../cli/detect'

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

  it('cmd.noop 을 결과로 전파한다', async () => {
    const runner: VerifyRunner = async () => ({ code: 0, stdout: '', stderr: '' })
    const r = await runVerification(
      { kind: 'test', command: 'npm', args: ['test'], noop: true },
      { runner },
    )
    expect(r.noop).toBe(true)
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
    // Windows 전용 회귀 — npm.cmd 셰임 해석은 win32 PATHEXT 경로에서만 의미가 있다(POSIX 는
    // resolvePathOnly 를 안 타고 npm 도 일반 실행파일). 비-win32 에선 실 npm 의존만 늘고 무관 CI
    // 실패 위험이 있어 가드한다 — CI 의 `windows vitest` 잡이 이 회귀를 강제한다(CodeRabbit).
    if (process.platform !== 'win32') return
    const res = await defaultVerifyRunner(
      { kind: 'test', command: 'npm', args: ['--version'], cwd: process.cwd() },
      30_000,
    )
    expect(res.spawnError).toBeUndefined()
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  }, 35_000)

  // 이미 abort 된 신호로 호출되면 자식을 spawn 하지 않고 즉시 ABORTED 로 단락해야 한다(Codex P2).
  // defaultRunner 의 pre-abort 가드는 win32+cwd 경로에만 있어 POSIX 에선 위임 시 자식이 먼저
  // spawn 된다(이전 execFile 은 전 플랫폼에서 pre-aborted 면 자식 미시작). cancelRun 후 남은
  // lint/test 단계가 잠깐 npm 을 띄우지 않도록, 위임 전에 전 플랫폼에서 단락한다.
  it('short-circuits to ABORTED without delegating when the signal is already aborted', async () => {
    const spy = vi.spyOn(detect, 'defaultRunner')
    try {
      const res = await defaultVerifyRunner(
        { kind: 'test', command: 'npm', args: ['test'], cwd: process.cwd() },
        30_000,
        AbortSignal.abort(),
      )
      expect(res.spawnError).toBe('ABORTED')
      expect(res.code).toBeNull()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
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

describe('isNoOpScript', () => {
  it('자명한 no-op 만 true (보수적)', () => {
    for (const s of ['', '   ', 'exit 0', 'true', ':', 'exit 0;', ' exit 0 ;']) {
      expect(isNoOpScript(s)).toBe(true)
    }
    for (const s of ['echo ok', 'npm run test:unit', 'tsc', 'exit 1', 'exit 0;;', undefined]) {
      expect(isNoOpScript(s)).toBe(false)
    }
  })

  it('비-string 값은 크래시 없이 false (비정상 package.json 방어)', () => {
    for (const v of [null, 123, ['x'], {}, true]) {
      expect(isNoOpScript(v as unknown as string)).toBe(false)
    }
  })
})

describe('npmVerifyCommands', () => {
  it('package.json 스크립트가 no-op 이면 noop:true, 실제면 noop:false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-verify-noop-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { typecheck: 'exit 0', lint: 'exit 0', test: 'exit 0' } }),
      )
      expect(npmVerifyCommands(dir).every((c) => c.noop === true)).toBe(true)

      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest run' } }),
      )
      expect(npmVerifyCommands(dir).every((c) => c.noop === false)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('package.json/스크립트 누락 시 noop 미설정(undefined)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-verify-nopkg-'))
    try {
      expect(npmVerifyCommands(dir).every((c) => c.noop === undefined)).toBe(true)
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc' } }))
      const cmds = npmVerifyCommands(dir)
      expect(cmds.find((c) => c.kind === 'typecheck')?.noop).toBe(false)
      expect(cmds.find((c) => c.kind === 'lint')?.noop).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pre/post 라이프사이클 훅에 실제 검사가 있으면 main 이 exit 0 여도 noop 아님 (#168 Codex)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-verify-hook-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          scripts: {
            typecheck: 'exit 0',
            pretypecheck: 'tsc --noEmit', // npm run typecheck 가 이 실검사를 먼저 실행
            lint: 'exit 0',
            test: 'exit 0',
            posttest: 'true', // post 훅도 no-op → test 는 여전히 noop
          },
        }),
      )
      const cmds = npmVerifyCommands(dir)
      expect(cmds.find((c) => c.kind === 'typecheck')?.noop).toBe(false) // pre 훅 실검사
      expect(cmds.find((c) => c.kind === 'lint')?.noop).toBe(true) // 훅 없음·main no-op
      expect(cmds.find((c) => c.kind === 'test')?.noop).toBe(true) // main·post 둘 다 no-op
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('비-string 스크립트 값에도 크래시하지 않는다(noop=false) — 비정상 package.json 회귀', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-verify-badtype-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { typecheck: null, lint: 123, test: ['x'] } }),
      )
      expect(() => npmVerifyCommands(dir)).not.toThrow()
      expect(npmVerifyCommands(dir).every((c) => c.noop === false)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

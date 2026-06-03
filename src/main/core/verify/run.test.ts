import { describe, expect, it } from 'vitest'
import { allPassed, runAllVerifications, runVerification, summarizeFailure, type VerifyRunner } from './run'

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
    const r = await runVerification({ kind: 'test', command: 'npm', args: ['test'] }, { runner, now })
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
    const runner: VerifyRunner = async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' })
    const r = await runVerification({ kind: 'smoke', command: 'missing', args: [] }, { runner })
    expect(r.passed).toBe(false)
    expect(r.analysis).toContain('ENOENT')
  })
})

describe('runAllVerifications / allPassed', () => {
  it('aggregates results and reports overall pass state', async () => {
    const runner: VerifyRunner = async (cmd) =>
      cmd.kind === 'lint' ? { code: 1, stdout: '', stderr: 'fail' } : { code: 0, stdout: '', stderr: '' }
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

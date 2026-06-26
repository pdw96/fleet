import { describe, expect, it } from 'vitest'
import { PROBE_PROMPT } from './core/cli/probe'
import { e2eRunner } from './e2e'

describe('e2eRunner', () => {
  it('--version 은 설치됨으로 즉시 resolve', async () => {
    const r = await e2eRunner('claude', ['--version'], { timeoutMs: 1000 })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('fleet-e2e')
  })

  it('probe(stdin=PROBE_PROMPT)는 결정론적 성공으로 resolve (never-settle 고정 회피)', async () => {
    const r = await e2eRunner('claude', ['-p'], { timeoutMs: 1000, stdinInput: PROBE_PROMPT })
    expect(r).toEqual({ code: 0, stdout: 'ok', stderr: '' })
  })
})

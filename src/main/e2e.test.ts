import { describe, expect, it } from 'vitest'
import { PROBE_PROMPT } from './core/cli/probe'
import { e2eRunner, isE2EActive } from './e2e'

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

describe('isE2EActive — FLEET_E2E 엄격 핀', () => {
  it("정확히 '1' 일 때만 활성", () => {
    expect(isE2EActive({ FLEET_E2E: '1' })).toBe(true)
  })

  it.each(['', '0', 'false', 'TRUE', 'yes', '2', ' 1', '1 '])('느슨한 값은 비활성: %j', (v) => {
    expect(isE2EActive({ FLEET_E2E: v })).toBe(false)
  })

  it('FLEET_E2E 미설정(undefined)은 비활성', () => {
    expect(isE2EActive({})).toBe(false)
  })
})

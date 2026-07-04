import { describe, expect, it } from 'vitest'
import { PROBE_PROMPT } from './core/cli/probe'
import { buildPlannerPrompt } from './core/orchestrator/plan'
import { buildReviewPrompt } from './core/orchestrator/review'
import { e2eCompletingRunner, e2eRunner, isE2EActive, resolveE2eRunner } from './e2e'

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

// 완주 러너는 payload 를 stdout·stream 두 채널 모두에 싣는다(어댑터가 어느 쪽을 읽든 완주). 여기선
// stdout(완결 payload)만 파싱한다 — stream 채널의 실 소비는 T10 웹 스모크가 실 오케스트레이터로 검증.
async function reply(prompt: string): Promise<string> {
  const r = await e2eCompletingRunner('claude', ['-p'], { timeoutMs: 1000, stdinInput: prompt })
  return r.stdout
}

describe('e2eCompletingRunner(#197 B4 — 완주 스모크용 opt-in)', () => {
  it('--version/probe 는 기본 러너와 동형', async () => {
    await expect(
      e2eCompletingRunner('claude', ['--version'], { timeoutMs: 1000 }, undefined),
    ).resolves.toMatchObject({ code: 0 })
    await expect(
      e2eCompletingRunner('claude', [], { timeoutMs: 1000, stdinInput: PROBE_PROMPT }, undefined),
    ).resolves.toMatchObject({ code: 0, stdout: 'ok' })
  })

  it('플래너 프롬프트 → 단일 작업 계획 JSON(파싱 가능)', async () => {
    const out = await reply(buildPlannerPrompt('데모 목표'))
    const parsed = JSON.parse(out.match(/\{"tasks":[\s\S]*\}/)![0]) as { tasks: unknown[] }
    expect(parsed.tasks).toHaveLength(1)
  })

  it('리뷰 프롬프트 → approved:true JSON', async () => {
    const out = await reply(buildReviewPrompt('t', 'd', ''))
    expect(out).toContain('"approved": true')
  })

  it('그 외 프롬프트 → 고정 텍스트로 resolve(hang 없음)', async () => {
    const out = await reply('요약하라')
    expect(out).toContain('E2E 완주 러너 응답')
  })
})

describe('resolveE2eRunner', () => {
  it("기본은 hang 러너, FLEET_E2E_RUNNER='complete' 만 완주 러너", () => {
    expect(resolveE2eRunner({})).toBe(e2eRunner)
    expect(resolveE2eRunner({ FLEET_E2E_RUNNER: 'complete' })).toBe(e2eCompletingRunner)
    expect(resolveE2eRunner({ FLEET_E2E_RUNNER: 'yes' })).toBe(e2eRunner) // 엄격 핀 — 미지 값은 기본
  })
})

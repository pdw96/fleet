import { describe, expect, it } from 'vitest'
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, buildVerifyFixPrompt, parseReviewVerdict } from './review'
import type { VerificationResult } from '../../../shared/types'

describe('parseReviewVerdict', () => {
  it('APPROVE → approved', () => {
    expect(parseReviewVerdict('APPROVE').approved).toBe(true)
  })

  it('REVISE → not approved, keeps feedback', () => {
    const v = parseReviewVerdict('REVISE: 타입을 고쳐라\n그리고 테스트 추가')
    expect(v.approved).toBe(false)
    expect(v.feedback).toContain('타입을 고쳐라')
    expect(v.feedback).toContain('테스트 추가')
  })

  it('is case-insensitive and tolerant of whitespace', () => {
    expect(parseReviewVerdict('  approve  ').approved).toBe(true)
  })

  it('treats a markdown- or quote-wrapped APPROVE as approved', () => {
    expect(parseReviewVerdict('**APPROVE**').approved).toBe(true)
    expect(parseReviewVerdict('"APPROVE"').approved).toBe(true)
    expect(parseReviewVerdict('- APPROVE').approved).toBe(true)
  })

  it('treats the "APPROVED" wording as approved', () => {
    expect(parseReviewVerdict('APPROVED — 좋습니다').approved).toBe(true)
  })
})

describe('prompt builders', () => {
  it('implement prompt includes feedback only when provided', () => {
    expect(buildImplementPrompt('g', 't', 'd', '피드백반영')).toContain('피드백반영')
    expect(buildImplementPrompt('g', 't', 'd')).not.toContain('이전 검토')
  })

  it('buildImplementPrompt instructs editing the workspace directly (no file fences)', () => {
    const p = buildImplementPrompt('목표', '작업', '설명')
    expect(p).toContain('작업')
    expect(p).not.toContain('```file:')
    expect(p).toContain('워크스페이스')
  })

  it('buildReviewPrompt embeds the diff and asks APPROVE/REVISE', () => {
    const p = buildReviewPrompt('작업', '설명', 'diff --git a/x b/x')
    expect(p).toContain('diff --git')
    expect(p).toContain('APPROVE')
  })

  it('summary prompt lists task statuses', () => {
    const p = buildSummaryPrompt('목표', [
      { title: 'A', status: 'done' },
      { title: 'B', status: 'failed' },
    ])
    expect(p).toContain('[done] A')
    expect(p).toContain('[failed] B')
  })
})

describe('buildVerifyFixPrompt', () => {
  const fail = (over: Partial<VerificationResult> = {}): VerificationResult => ({
    kind: 'test',
    command: 'npm test',
    passed: false,
    exitCode: 1,
    stdout: '',
    stderr: 'boom',
    analysis: 'AssertionError: x !== y',
    durationMs: 1,
    ...over,
  })

  it('asks the agent to fix failures in the workspace', () => {
    const p = buildVerifyFixPrompt('목표', [
      { kind: 'test', command: 'npm test', passed: false, exitCode: 1, stdout: '', stderr: 'boom', analysis: 'boom', durationMs: 1 },
    ])
    expect(p).toContain('boom')
    expect(p).toContain('워크스페이스')
  })

  it('includes goal and failure analysis', () => {
    const prompt = buildVerifyFixPrompt('할 일 앱', [fail()])
    expect(prompt).toContain('할 일 앱')
    expect(prompt).toContain('AssertionError: x !== y')
  })

  it('falls back to stderr when analysis is absent', () => {
    const prompt = buildVerifyFixPrompt('g', [fail({ analysis: undefined, stderr: 'STDERR-LINE' })])
    expect(prompt).toContain('STDERR-LINE')
  })
})

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

  it('implement prompt asks for the file artifact format only when requested', () => {
    expect(buildImplementPrompt('g', 't', 'd', undefined, true)).toContain('file:')
    expect(buildImplementPrompt('g', 't', 'd')).not.toContain('file:')
  })

  it('review prompt embeds the output', () => {
    expect(buildReviewPrompt('작업', '설명', '산출물내용')).toContain('산출물내용')
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

  it('includes goal, failure analysis, and current artifacts', () => {
    const artifacts = new Map<string, string>([['src/a.ts', 'export const x = 1']])
    const prompt = buildVerifyFixPrompt('할 일 앱', [fail()], artifacts)
    expect(prompt).toContain('할 일 앱')
    expect(prompt).toContain('AssertionError: x !== y')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('export const x = 1')
    expect(prompt).toContain('```file:')
  })

  it('falls back to stderr when analysis is absent', () => {
    const prompt = buildVerifyFixPrompt('g', [fail({ analysis: undefined, stderr: 'STDERR-LINE' })], new Map())
    expect(prompt).toContain('STDERR-LINE')
    expect(prompt).toContain('(기록된 파일 없음)')
  })

  it('truncates oversized artifact content', () => {
    const big = 'A'.repeat(20_000)
    const prompt = buildVerifyFixPrompt('g', [fail()], new Map([['big.txt', big]]))
    expect(prompt).toContain('…(절단)')
    expect(prompt.length).toBeLessThan(big.length)
  })
})

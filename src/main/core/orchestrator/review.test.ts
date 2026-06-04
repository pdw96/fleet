import { describe, expect, it } from 'vitest'
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, parseReviewVerdict } from './review'

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

import { describe, expect, it } from 'vitest'
import {
  buildImplementPrompt,
  buildReviewPrompt,
  buildSummaryPrompt,
  buildVerifyFixPrompt,
  parseReviewVerdict,
  REVIEW_SCHEMA,
} from './review'
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

  it('구조화 출력 JSON {approved,feedback} 를 파싱한다', () => {
    const v = parseReviewVerdict('{"approved":false,"feedback":"타입을 고쳐라"}')
    expect(v.approved).toBe(false)
    expect(v.feedback).toBe('타입을 고쳐라')
  })

  it('approved:true JSON 을 승인으로 본다', () => {
    expect(parseReviewVerdict('{"approved":true,"feedback":""}').approved).toBe(true)
  })

  it('코드펜스로 감싼 JSON 도 파싱한다(CLI 폴백 견고화)', () => {
    const v = parseReviewVerdict('```json\n{"approved":true,"feedback":""}\n```')
    expect(v.approved).toBe(true)
  })

  it('parsed=true 는 인식된 verdict(JSON·APPROVE·REVISE), false 는 미인식(빈/거부 산문)을 구분한다 (#162)', () => {
    // 인식된 verdict
    expect(parseReviewVerdict('{"approved":false,"feedback":"x"}').parsed).toBe(true)
    expect(parseReviewVerdict('APPROVE').parsed).toBe(true)
    expect(parseReviewVerdict('REVISE: 고쳐').parsed).toBe(true)
    // 미인식(리뷰어가 유효한 verdict 를 내지 않음) → 거짓 approved:false 와 구분되어야 함
    expect(parseReviewVerdict('').parsed).toBe(false)
    expect(parseReviewVerdict('   ').parsed).toBe(false)
    expect(parseReviewVerdict('도와줄 수 없습니다').parsed).toBe(false)
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

  it('buildReviewPrompt embeds the diff and asks for approved/feedback JSON', () => {
    const p = buildReviewPrompt('작업', '설명', 'diff --git a/x b/x')
    expect(p).toContain('diff --git')
    expect(p).toContain('approved')
    expect(p).toContain('feedback')
  })

  it('buildReviewPrompt: 작업 달성 시 승인 · 개선 여지는 거부 사유가 아님을 명시한다', () => {
    const p = buildReviewPrompt('작업', '설명', 'diff --git a/x b/x')
    // 승인 기준: 작업을 실질적으로 달성하면 승인
    expect(p).toContain('달성')
    // 개선 여지(추가 테스트·검증·스타일)는 거부 사유가 아니라는 점을 명시
    expect(p).toMatch(/개선 여지[^\n]*거부|거부 사유가 아니/)
    // "비판적으로 검토" 라는 무조건 트집을 유발하는 framing 은 제거
    expect(p).not.toContain('비판적으로 검토')
  })

  it('summary prompt lists task statuses and changed files (artifacts in-prompt, no fs re-scan)', () => {
    const p = buildSummaryPrompt('목표', [
      { title: 'A', status: 'done', changedFiles: ['game.js', 'index.html'] },
      { title: 'B', status: 'failed' },
    ])
    expect(p).toContain('[done] A')
    expect(p).toContain('[failed] B')
    // 산출물(변경 파일)이 프롬프트에 직접 실린다 — 요약 에이전트가 fs 를 재탐색할 필요 없음(#164).
    expect(p).toContain('game.js')
    expect(p).toContain('index.html')
    expect(p).toMatch(/파일시스템을 직접 탐색하지 말/)
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
      {
        kind: 'test',
        command: 'npm test',
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: 'boom',
        analysis: 'boom',
        durationMs: 1,
      },
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

describe('REVIEW_SCHEMA', () => {
  it('approved(boolean)·feedback(string) 객체 스키마', () => {
    const props = REVIEW_SCHEMA.properties as Record<string, { type?: string }>
    expect(props.approved.type).toBe('boolean')
    expect(props.feedback.type).toBe('string')
    expect(REVIEW_SCHEMA.additionalProperties).toBe(false)
  })
})

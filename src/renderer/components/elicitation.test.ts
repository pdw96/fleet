import { describe, expect, it } from 'vitest'
import {
  composeGoal,
  hasAnyPresent,
  isPresent,
  EMPTY_FIELDS,
  type ElicitationFields,
} from './elicitation'

const fields = (over: Partial<ElicitationFields> = {}): ElicitationFields => ({
  ...EMPTY_FIELDS,
  ...over,
})

describe('isPresent / hasAnyPresent', () => {
  it('treats empty and whitespace-only as absent', () => {
    expect(isPresent('')).toBe(false)
    expect(isPresent('   ')).toBe(false)
    expect(isPresent('x')).toBe(true)
  })

  it('hasAnyPresent is false for empty fields and select 미지정', () => {
    expect(hasAnyPresent(EMPTY_FIELDS)).toBe(false)
    expect(hasAnyPresent(fields({ completeness: '' }))).toBe(false)
    expect(hasAnyPresent(fields({ audience: '   ' }))).toBe(false)
  })

  it('hasAnyPresent is true when any field is present', () => {
    expect(hasAnyPresent(fields({ audience: '개발자' }))).toBe(true)
    expect(hasAnyPresent(fields({ completeness: 'high' }))).toBe(true)
  })
})

describe('composeGoal', () => {
  it('returns base unchanged when all fields absent (무회귀 핵심)', () => {
    const base = '할 일 앱 만들기'
    expect(composeGoal(base, EMPTY_FIELDS)).toBe(base)
  })

  it('ignores whitespace-only text and select 미지정', () => {
    const base = '앱'
    expect(composeGoal(base, fields({ audience: '   ', completeness: '' }))).toBe(base)
  })

  it('appends a single text field as a labeled line', () => {
    expect(composeGoal('앱', fields({ audience: '초등학생' }))).toBe(
      '앱\n\n[추가 맥락]\n- 대상 사용자: 초등학생',
    )
  })

  it('maps the completeness select to its phrase', () => {
    expect(composeGoal('앱', fields({ completeness: 'high' }))).toBe(
      '앱\n\n[추가 맥락]\n- 완성도 수준: 높은 완성도 (폴리시·엣지케이스·견고함까지 투자)',
    )
  })

  it('keeps fixed field order in one block for multiple fields', () => {
    expect(
      composeGoal(
        '앱',
        fields({ constraints: '바닐라 JS', audience: '개발자', completeness: 'standard' }),
      ),
    ).toBe(
      '앱\n\n[추가 맥락]\n- 완성도 수준: 표준 (실사용 가능한 완성도)\n- 대상 사용자: 개발자\n- 제약·필수: 바닐라 JS',
    )
  })

  it('omits leading blank lines when base is empty', () => {
    expect(composeGoal('', fields({ audience: '개발자' }))).toBe(
      '[추가 맥락]\n- 대상 사용자: 개발자',
    )
  })

  it('normalizes only trailing whitespace on the join boundary (preserves base body)', () => {
    expect(composeGoal('앱  \n', fields({ audience: '개발자' }))).toBe(
      '앱\n\n[추가 맥락]\n- 대상 사용자: 개발자',
    )
  })

  it('is deterministic (same input → same output)', () => {
    const f = fields({ success: '로그인 동작' })
    expect(composeGoal('앱', f)).toBe(composeGoal('앱', f))
  })

  it('is NOT idempotent — re-applying same fields duplicates the block (contract)', () => {
    const f = fields({ audience: '개발자' })
    const once = composeGoal('앱', f)
    expect(composeGoal(once, f)).not.toBe(once)
  })
})

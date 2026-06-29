import { describe, expect, it } from 'vitest'
import { agentHue, cx, statusColor, vars } from './ui'

describe('cx', () => {
  it('joins truthy class names and drops falsy', () => {
    expect(cx('a', false, 'b', null, undefined, 'c')).toBe('a b c')
    expect(cx()).toBe('')
  })
})

describe('vars', () => {
  it('passes a CSS custom-property map through as a style object', () => {
    expect(vars({ '--hue': '#fff' })).toEqual({ '--hue': '#fff' })
  })
})

describe('statusColor', () => {
  it('maps terminal and in-progress statuses to distinct tokens', () => {
    expect(statusColor('done')).toBe('var(--ok)')
    expect(statusColor('failed')).toBe('var(--bad)')
    for (const s of ['running', 'review', 'executing', 'verifying']) {
      expect(statusColor(s)).toBe('var(--warn)')
    }
    expect(statusColor('partial')).toBe('var(--warn)') // #166: 부분 완료(진행 톤)
    expect(statusColor('pending')).toBe('var(--dim)')
    expect(statusColor('anything-else')).toBe('var(--dim)')
  })
})

describe('agentHue', () => {
  it('is deterministic for the same id and within the palette', () => {
    const palette = ['#ffc24b', '#4fe0c0', '#9d8bff', '#ff9e7a', '#7ec8ff', '#f7768e']
    expect(agentHue('claude')).toBe(agentHue('claude'))
    expect(palette).toContain(agentHue('codex'))
    expect(palette).toContain(agentHue(''))
  })
})

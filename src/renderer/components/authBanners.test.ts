import { describe, expect, it } from 'vitest'
import { SUBSCRIPTION_BANNERS, subscriptionSupported } from './authBanners'

describe('auth banners', () => {
  it('gemini=warning+API권장, codex=caution, anthropic=clean', () => {
    expect(SUBSCRIPTION_BANNERS.google?.level).toBe('warning')
    expect(SUBSCRIPTION_BANNERS.google?.recommendApi).toBe(true)
    expect(SUBSCRIPTION_BANNERS.openai?.level).toBe('caution')
    expect(SUBSCRIPTION_BANNERS.anthropic?.level).toBe('clean')
  })
  it('openai-compatible 은 구독 미지원', () => {
    expect(subscriptionSupported('openai-compatible')).toBe(false)
    expect(subscriptionSupported('anthropic')).toBe(true)
  })
  it('문구는 법률 단정어("위반"·"묵인")를 쓰지 않는다', () => {
    for (const b of Object.values(SUBSCRIPTION_BANNERS)) {
      if (!b) continue
      expect(b.message).not.toContain('위반')
      expect(b.message).not.toContain('묵인')
    }
  })
})

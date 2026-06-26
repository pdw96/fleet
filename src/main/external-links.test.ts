import { describe, expect, it } from 'vitest'
import { isAllowedDocsUrl, openVerifiedCliDocs } from './external-links'
import { CLI_AUTH_INSTALL_META, DOCS_HOST_ALLOWLIST } from '../shared/cliAuthInstallMeta'

describe('isAllowedDocsUrl — 적대 가드', () => {
  it('allowlist host의 https URL을 허용', () => {
    for (const host of DOCS_HOST_ALLOWLIST) {
      expect(isAllowedDocsUrl(`https://${host}/path`)).toBe(true)
    }
  })
  it('각 adapter의 실제 docsUrl을 허용 (meta↔가드 동기화 회귀)', () => {
    for (const id of ['claude', 'codex', 'gemini'] as const) {
      expect(isAllowedDocsUrl(CLI_AUTH_INSTALL_META[id].docsUrl)).toBe(true)
    }
  })
  it('https 외 스킴 거부', () => {
    expect(isAllowedDocsUrl('http://docs.anthropic.com')).toBe(false)
    expect(isAllowedDocsUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedDocsUrl('javascript:alert(1)')).toBe(false)
  })
  it('비-allowlist host 거부', () => {
    expect(isAllowedDocsUrl('https://evil.com')).toBe(false)
  })
  it('서브도메인 트릭 거부', () => {
    expect(isAllowedDocsUrl('https://docs.anthropic.com.evil.com/x')).toBe(false)
  })
  it('userinfo 트릭 거부 (hostname은 evil)', () => {
    expect(isAllowedDocsUrl('https://docs.anthropic.com@evil.com')).toBe(false)
  })
  it('allowlisted host + userinfo 거부 (심층방어)', () => {
    expect(isAllowedDocsUrl('https://user:pass@docs.anthropic.com')).toBe(false)
  })
  it('비정상 포트 거부', () => {
    expect(isAllowedDocsUrl('https://docs.anthropic.com:8443')).toBe(false)
  })
  it('non-allowlist punycode 거부', () => {
    expect(isAllowedDocsUrl('https://xn--80ak6aa92e.com')).toBe(false)
  })
  it('대문자 host 허용 (hostname lowercase 정규화)', () => {
    expect(isAllowedDocsUrl('https://DOCS.ANTHROPIC.COM/x')).toBe(true)
  })
  it('파싱 불가 입력 거부', () => {
    expect(isAllowedDocsUrl('not a url')).toBe(false)
    expect(isAllowedDocsUrl('')).toBe(false)
  })
})

describe('openVerifiedCliDocs — adapter 가드 + 위임', () => {
  function fakeShell() {
    const calls: string[] = []
    return { calls, openExternal: async (u: string) => void calls.push(u) }
  }
  it('유효 adapter → 도출한 docsUrl로 openExternal 호출', async () => {
    const shell = fakeShell()
    await openVerifiedCliDocs('claude', shell)
    expect(shell.calls).toEqual([CLI_AUTH_INSTALL_META.claude.docsUrl])
  })
  it('스푸핑 adapterId → 호출 없이 reject', async () => {
    const shell = fakeShell()
    await expect(openVerifiedCliDocs('__proto__' as never, shell)).rejects.toThrow()
    await expect(openVerifiedCliDocs('evil' as never, shell)).rejects.toThrow()
    expect(shell.calls).toEqual([])
  })
})

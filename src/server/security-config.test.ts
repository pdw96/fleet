import { describe, expect, it } from 'vitest'
import { resolveSecurityConfig } from './security-config'

const FULL = {
  FLEET_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
  FLEET_ACCESS_AUD: 'aud-tag-abc123',
  FLEET_PUBLIC_ORIGIN: 'https://fleet.example.com',
}

/** throw 메시지를 잡아 반환(없으면 undefined) — 부분설정 누락 env 명명 단언용. */
function captureThrow(fn: () => unknown): Error | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e as Error
  }
}

describe('resolveSecurityConfig — 모드 게이트(#197 B5 T3)', () => {
  it('3종 전부 부재 → loopback', () => {
    expect(resolveSecurityConfig({})).toEqual({ mode: 'loopback' })
  })

  it('3종 전부 공백/빈 문자열 → loopback(미설정 동치)', () => {
    expect(
      resolveSecurityConfig({
        FLEET_ACCESS_TEAM_DOMAIN: '   ',
        FLEET_ACCESS_AUD: '',
        FLEET_PUBLIC_ORIGIN: '\t',
      }),
    ).toEqual({ mode: 'loopback' })
  })

  it('3종 유효 → access(teamDomain origin·aud 불투명·publicOrigin 정규화)', () => {
    const cfg = resolveSecurityConfig(FULL)
    expect(cfg.mode).toBe('access')
    if (cfg.mode !== 'access') throw new Error('unreachable')
    expect(cfg.teamDomain.origin).toBe('https://team.cloudflareaccess.com')
    expect(cfg.aud).toBe('aud-tag-abc123')
    expect(cfg.publicOrigin).toBe('https://fleet.example.com')
  })

  // 부분 설정 = 8조합 중 전부/전무 2조합을 제외한 6조합. 각각 누락 env 를 명시적으로 throw.
  const partials: Array<{ label: string; env: Record<string, string>; missing: string[] }> = [
    {
      label: 'TEAM_DOMAIN only',
      env: { FLEET_ACCESS_TEAM_DOMAIN: FULL.FLEET_ACCESS_TEAM_DOMAIN },
      missing: ['FLEET_ACCESS_AUD', 'FLEET_PUBLIC_ORIGIN'],
    },
    {
      label: 'AUD only',
      env: { FLEET_ACCESS_AUD: FULL.FLEET_ACCESS_AUD },
      missing: ['FLEET_ACCESS_TEAM_DOMAIN', 'FLEET_PUBLIC_ORIGIN'],
    },
    {
      label: 'PUBLIC_ORIGIN only',
      env: { FLEET_PUBLIC_ORIGIN: FULL.FLEET_PUBLIC_ORIGIN },
      missing: ['FLEET_ACCESS_TEAM_DOMAIN', 'FLEET_ACCESS_AUD'],
    },
    {
      label: 'TEAM_DOMAIN + AUD',
      env: {
        FLEET_ACCESS_TEAM_DOMAIN: FULL.FLEET_ACCESS_TEAM_DOMAIN,
        FLEET_ACCESS_AUD: FULL.FLEET_ACCESS_AUD,
      },
      missing: ['FLEET_PUBLIC_ORIGIN'],
    },
    {
      label: 'TEAM_DOMAIN + PUBLIC_ORIGIN',
      env: {
        FLEET_ACCESS_TEAM_DOMAIN: FULL.FLEET_ACCESS_TEAM_DOMAIN,
        FLEET_PUBLIC_ORIGIN: FULL.FLEET_PUBLIC_ORIGIN,
      },
      missing: ['FLEET_ACCESS_AUD'],
    },
    {
      label: 'AUD + PUBLIC_ORIGIN',
      env: {
        FLEET_ACCESS_AUD: FULL.FLEET_ACCESS_AUD,
        FLEET_PUBLIC_ORIGIN: FULL.FLEET_PUBLIC_ORIGIN,
      },
      missing: ['FLEET_ACCESS_TEAM_DOMAIN'],
    },
  ]
  it.each(partials)('부분 설정($label) → throw(누락 env 명시)', ({ env, missing }) => {
    const err = captureThrow(() => resolveSecurityConfig(env))
    expect(err).toBeDefined()
    for (const m of missing) expect(err!.message).toContain(m)
    // 설정된 env 는 누락으로 명명되지 않는다(오검출 방지).
    const setKeys = Object.keys(env)
    for (const k of setKeys) expect(err!.message).not.toContain(k)
  })

  it('부분 설정 — 빈 문자열은 미설정 취급(AUD 공백 + 나머지 유효 → 부분설정 throw)', () => {
    const err = captureThrow(() => resolveSecurityConfig({ ...FULL, FLEET_ACCESS_AUD: '   ' }))
    expect(err).toBeDefined()
    expect(err!.message).toContain('FLEET_ACCESS_AUD')
  })

  describe('URL 검증 — https 강제·비파싱 거부', () => {
    it.each(['not a url', 'team.cloudflareaccess.com', 'ftp://team.example.com', '://bad'])(
      'TEAM_DOMAIN 비파싱/비https(%s) → throw',
      (bad) => {
        expect(() => resolveSecurityConfig({ ...FULL, FLEET_ACCESS_TEAM_DOMAIN: bad })).toThrow(
          /FLEET_ACCESS_TEAM_DOMAIN/,
        )
      },
    )
    it.each(['not a url', 'fleet.example.com', 'ws://fleet.example.com'])(
      'PUBLIC_ORIGIN 비파싱/비https(%s) → throw',
      (bad) => {
        expect(() => resolveSecurityConfig({ ...FULL, FLEET_PUBLIC_ORIGIN: bad })).toThrow(
          /FLEET_PUBLIC_ORIGIN/,
        )
      },
    )
    it('TEAM_DOMAIN http 스킴 → throw(평문 다운그레이드 배제)', () => {
      expect(() =>
        resolveSecurityConfig({ ...FULL, FLEET_ACCESS_TEAM_DOMAIN: 'http://team.example.com' }),
      ).toThrow(/https/i)
    })
    it('PUBLIC_ORIGIN http 스킴 → throw(평문 다운그레이드 배제)', () => {
      expect(() =>
        resolveSecurityConfig({ ...FULL, FLEET_PUBLIC_ORIGIN: 'http://fleet.example.com' }),
      ).toThrow(/https/i)
    })
  })

  describe('publicOrigin 정규화 경계값', () => {
    it('포트 포함 → origin 보존', () => {
      const cfg = resolveSecurityConfig({
        ...FULL,
        FLEET_PUBLIC_ORIGIN: 'https://fleet.example.com:8443/',
      })
      expect(cfg.mode === 'access' && cfg.publicOrigin).toBe('https://fleet.example.com:8443')
    })
    it('대문자 호스트 → 소문자 정규화', () => {
      const cfg = resolveSecurityConfig({
        ...FULL,
        FLEET_PUBLIC_ORIGIN: 'https://FLEET.Example.COM',
      })
      expect(cfg.mode === 'access' && cfg.publicOrigin).toBe('https://fleet.example.com')
    })
    it('trailing slash/path 제거 → origin 만', () => {
      const cfg = resolveSecurityConfig({
        ...FULL,
        FLEET_PUBLIC_ORIGIN: 'https://fleet.example.com/app/x?q=1',
      })
      expect(cfg.mode === 'access' && cfg.publicOrigin).toBe('https://fleet.example.com')
    })
    it('teamDomain path 무시 → origin 만 권위', () => {
      const cfg = resolveSecurityConfig({
        ...FULL,
        FLEET_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/some/path',
      })
      expect(cfg.mode === 'access' && cfg.teamDomain.origin).toBe(
        'https://team.cloudflareaccess.com',
      )
      expect(cfg.mode === 'access' && cfg.teamDomain.pathname).toBe('/')
    })
    it('aud 는 불투명 문자열(형식 비검증)', () => {
      const cfg = resolveSecurityConfig({ ...FULL, FLEET_ACCESS_AUD: 'weird.tag_with-mixed:chars' })
      expect(cfg.mode === 'access' && cfg.aud).toBe('weird.tag_with-mixed:chars')
    })
  })
})

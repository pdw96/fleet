import { errors as joseErrors, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAccessJwtVerifier, type AccessJwtVerifier } from './access-jwt'

const TEAM_DOMAIN = new URL('https://team.cloudflareaccess.com')
const ISSUER = TEAM_DOMAIN.origin
const AUD = 'aud-app-tag-xyz'
const KID = 'test-key-1'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// CryptoKey 는 node tsconfig lib 에 전역 타입으로 없어 generateKeyPair 반환 형태에서 파생한다.
type GeneratedPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

let privateKey: GeneratedPrivateKey
let otherPrivateKey: GeneratedPrivateKey
let hsSecret: Uint8Array
let verifier: AccessJwtVerifier

/** 기본 유효 클레임으로 서명하되 override 로 각 거부 시나리오를 구성한다(RS256·kid 매칭). */
async function sign(
  opts: {
    key?: GeneratedPrivateKey
    sub?: string | null
    iss?: string
    aud?: string
    exp?: string | number
    nbf?: number
  } = {},
): Promise<string> {
  let b = new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: KID })
  if (opts.sub !== null) b = b.setSubject(opts.sub ?? 'user-abc-123')
  b = b.setIssuer(opts.iss ?? ISSUER).setAudience(opts.aud ?? AUD)
  b = b.setExpirationTime(opts.exp ?? '2h')
  if (opts.nbf !== undefined) b = b.setNotBefore(opts.nbf)
  return b.sign(opts.key ?? privateKey)
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true })
  privateKey = kp.privateKey
  const publicJwk = await exportJWK(kp.publicKey)
  publicJwk.alg = 'RS256'
  publicJwk.kid = KID
  const { createLocalJWKSet } = await import('jose')
  const jwks = createLocalJWKSet({ keys: [publicJwk] })
  verifier = createAccessJwtVerifier({ teamDomain: TEAM_DOMAIN, aud: AUD, jwks })

  otherPrivateKey = (await generateKeyPair('RS256', { extractable: true })).privateKey
  hsSecret = new TextEncoder().encode('symmetric-secret-at-least-32-bytes-long-xx')
})

describe('createAccessJwtVerifier — Cloudflare Access JWT 서버 자체 검증(#197 B5 T4)', () => {
  it('유효 토큰 → { identity: sub }', async () => {
    await expect(verifier.verify(await sign({ sub: 'user-abc-123' }))).resolves.toEqual({
      identity: 'user-abc-123',
    })
  })

  const rejectCases: Array<{ label: string; token: () => Promise<string> | string }> = [
    { label: 'undefined', token: () => undefined as unknown as string },
    { label: '빈 문자열', token: () => '' },
    { label: '형식 불량', token: () => 'not.a.jwt' },
    { label: '만료', token: () => sign({ exp: nowSec() - 60 }) },
    { label: 'nbf 미래', token: () => sign({ nbf: nowSec() + 3600 }) },
    { label: 'aud 불일치', token: () => sign({ aud: 'wrong-aud-tag' }) },
    { label: 'iss 불일치', token: () => sign({ iss: 'https://evil.cloudflareaccess.com' }) },
    { label: '타 키 서명', token: () => sign({ key: otherPrivateKey }) },
    { label: 'sub 결손', token: () => sign({ sub: null }) },
    { label: 'sub 빈 문자열', token: () => sign({ sub: '   ' }) },
  ]
  it.each(rejectCases)('거부: $label → throw', async ({ token }) => {
    await expect(verifier.verify(await token())).rejects.toThrow()
  })

  it('alg 다운그레이드(HS256) → throw(algorithms:[RS256] 핀)', async () => {
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-abc-123')
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setExpirationTime('2h')
      .sign(hsSecret)
    await expect(verifier.verify(hs)).rejects.toThrow()
  })

  it('위조(만료) → AccessJwtError kind=invalid', async () => {
    await expect(verifier.verify(await sign({ exp: nowSec() - 60 }))).rejects.toMatchObject({
      kind: 'invalid',
    })
  })

  it('JWKS 조회 불능(주입 JWKSTimeout) → AccessJwtError kind=unavailable(fail-closed)', async () => {
    const v = createAccessJwtVerifier({
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      jwks: () => {
        throw new joseErrors.JWKSTimeout()
      },
    })
    // 잘 형성된 유효 토큰 → jwtVerify 가 getKey(JWKS) 단계까지 도달 → 주입된 타임아웃이 표면화.
    await expect(v.verify(await sign())).rejects.toMatchObject({ kind: 'unavailable' })
  })
})

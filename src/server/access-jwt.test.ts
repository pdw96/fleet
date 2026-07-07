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
    exp?: string | number | null
    nbf?: number
  } = {},
): Promise<string> {
  let b = new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: KID })
  if (opts.sub !== null) b = b.setSubject(opts.sub ?? 'user-abc-123')
  b = b.setIssuer(opts.iss ?? ISSUER).setAudience(opts.aud ?? AUD)
  // exp: null → exp 클레임 생략(T6 fail-closed 검증용). 그 외 기본 '2h'.
  if (opts.exp !== null) b = b.setExpirationTime(opts.exp ?? '2h')
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
    // #197-B6 T6: 반환에 expiresAtMs 가 추가돼 exact-equal 이 깨지므로 toMatchObject 로 완화(테스트 더블 핀).
    await expect(verifier.verify(await sign({ sub: 'user-abc-123' }))).resolves.toMatchObject({
      identity: 'user-abc-123',
    })
  })

  // #197-B6 T6 — 소켓 exp-시한 종료의 기반: verifier 가 expiresAtMs 를 반환하고, exp 부재/비유한수는
  // fail-closed(401). jose 는 exp 를 기본 미강제(context7 확인)라 requiredClaims:['exp']+수동 체크 이중방어.
  describe('exp fail-closed + expiresAtMs(#197-B6 T6)', () => {
    it('유효 미래 exp → { identity, expiresAtMs } (exp*1000)', async () => {
      const exp = nowSec() + 3600
      const res = await verifier.verify(await sign({ exp }))
      expect(res.identity).toBe('user-abc-123')
      expect(res.expiresAtMs).toBe(exp * 1000)
    })

    it('exp 부재 토큰 → AccessJwtError kind=invalid(requiredClaims + 수동 체크)', async () => {
      await expect(verifier.verify(await sign({ exp: null }))).rejects.toMatchObject({
        kind: 'invalid',
      })
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

  // Codex 4R P2 + 재리뷰: JWKS 조회 단계의 모든 실패(타입 무관)를 401(invalid)이 아닌 503(unavailable)으로.
  // jose 6.2.3 은 non-200/malformed JSON 을 base JOSEError(JWKSInvalid 아님)로 던진다(소스 실측 remote.js)
  // — 타입 allowlist 로는 놓친다. getKey 단계 래핑(단계 기반 태깅)이 근본 방어라 어떤 에러 타입이든 잡힌다.
  const unavailableInjections: Array<{ label: string; err: () => unknown }> = [
    {
      label: 'base JOSEError(non-200/malformed — 실제 jose 동작)',
      err: () => new joseErrors.JOSEError('Expected 200 OK'),
    },
    { label: 'JWKSInvalid', err: () => new joseErrors.JWKSInvalid() },
    { label: 'JWKSTimeout', err: () => new joseErrors.JWKSTimeout() },
    { label: 'generic Error(unknown)', err: () => new Error('unexpected jwks failure') },
    {
      label: 'undici fetch failed(cause.code ECONNREFUSED)',
      err: () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    },
    {
      label: 'cause.code ENOTFOUND',
      err: () => Object.assign(new TypeError('boom'), { cause: { code: 'ENOTFOUND' } }),
    },
  ]
  it.each(unavailableInjections)(
    'JWKS 장애 분류: $label → kind=unavailable(503)',
    async ({ err }) => {
      const v = createAccessJwtVerifier({
        teamDomain: TEAM_DOMAIN,
        aud: AUD,
        jwks: () => {
          throw err()
        },
      })
      await expect(v.verify(await sign())).rejects.toMatchObject({ kind: 'unavailable' })
    },
  )

  it('no-matching-key(ERR_JWKS_NO_MATCHING_KEY) → invalid(401·토큰 kid 무효, 가용성 아님)', async () => {
    const v = createAccessJwtVerifier({
      teamDomain: TEAM_DOMAIN,
      aud: AUD,
      jwks: () => {
        throw new joseErrors.JWKSNoMatchingKey()
      },
    })
    await expect(v.verify(await sign())).rejects.toMatchObject({ kind: 'invalid' })
  })
})

import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose'

/**
 * Cloudflare Access JWT 서버 자체 검증(#197 B5). 터널 앞단 Access(MFA)를 신뢰하지 않고 서버가 직접
 * 서명·issuer·audience·alg 를 검증한다(v3 §8 "터널 인증만 신뢰하지 않음"). JWKS 는 주입식이라 테스트는
 * createLocalJWKSet(위조 토큰 전수), 프로덕션은 createRemoteJWKSet(팀도메인 /cdn-cgi/access/certs)를 쓴다.
 *
 * fail-closed 이원 분류(완료 조건 401/503):
 *   · invalid    — 서명/클레임/만료/alg/형식 위반·no-matching-key → 401(토큰 무효, 클라 책임).
 *   · unavailable — JWKS 조회 불능(타임아웃·페치 실패·JWKS 형식 오류) → 503(서버측 가용성 · 절대 fail-open 아님).
 * 어느 쪽이든 거부한다 — 구분은 상태 코드/관측용일 뿐 접근은 항상 차단(가용성보다 안전).
 */
export type AccessJwtFailureKind = 'invalid' | 'unavailable'

export class AccessJwtError extends Error {
  readonly kind: AccessJwtFailureKind
  constructor(kind: AccessJwtFailureKind, message: string) {
    super(message)
    this.name = 'AccessJwtError'
    this.kind = kind
  }
}

export interface AccessIdentity {
  /** 검증된 사용자 식별자(JWT `sub`). nonce 바인딩 대조의 권위(#197 B5 T7). */
  identity: string
}

/** jwtVerify 의 key 파라미터 형태(주입 JWKS getKey 또는 키). local/remote JWKS 둘 다 만족. */
type JwtKeyInput = Parameters<typeof jwtVerify>[1]

export interface AccessJwtVerifierOptions {
  /** 팀 도메인(origin 만 권위 — issuer·JWKS base). */
  teamDomain: URL
  /** Cloudflare Access application audience tag. */
  aud: string
  /** 테스트 주입용 JWKS. 미주입 시 createRemoteJWKSet(팀도메인 인증서 endpoint) — 프로덕션. */
  jwks?: JwtKeyInput
}

export interface AccessJwtVerifier {
  /** 검증 성공 시 identity 반환. 실패는 AccessJwtError(kind) throw — 호출부가 401/503 변환. */
  verify(token: string): Promise<AccessIdentity>
}

/**
 * fail-closed 최종 매핑(#197 B5). getKey(JWKS 조회) 단계 실패는 verifier 의 래퍼가 이미
 * AccessJwtError('unavailable')로 태그하므로 여기서는 통과시키고, 나머지(서명·클레임·만료·alg·형식)는
 * invalid 로 본다. 어느 쪽이든 거부(fail-closed) — 구분은 상태 코드/관측용.
 */
function classify(err: unknown): AccessJwtError {
  if (err instanceof AccessJwtError) return err
  return new AccessJwtError('invalid', err instanceof Error ? err.message : String(err))
}

export function createAccessJwtVerifier(opts: AccessJwtVerifierOptions): AccessJwtVerifier {
  const issuer = opts.teamDomain.origin
  const rawJwks: JwtKeyInput =
    opts.jwks ?? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', opts.teamDomain))

  // JWKS 조회 단계 래퍼(단계 기반 태깅 · Codex 재리뷰 P2). jose 6.2.3 은 non-200/malformed JSON 을 base
  // JOSEError(JWKSInvalid 아님·소스 실측 remote.js)로, 타임아웃을 JWKSTimeout 로, 네트워크 실패를 원인
  // error 로 던진다 — 에러 타입 allowlist 로는 누락된다. 조회 단계의 실패는 전부 가용성 문제(unavailable=503)
  // 로 태그하고, no-matching-key(토큰 kid 가 JWKS 에 없음 = 토큰 무효)만 invalid(401)로 통과시킨다. 주입
  // JWKS(테스트)도 동일 래핑돼 이 경로가 검증된다. 서명·클레임(getKey 이후)은 jose 가 던지고 classify 가 처리.
  const jwks: JwtKeyInput = async (protectedHeader, token) => {
    try {
      return typeof rawJwks === 'function' ? await rawJwks(protectedHeader, token) : rawJwks
    } catch (err) {
      if (err instanceof AccessJwtError) throw err
      if (err instanceof joseErrors.JWKSNoMatchingKey) throw err // 토큰 kid 무효 → classify → invalid
      throw new AccessJwtError('unavailable', 'Access JWKS 조회 불능')
    }
  }

  return {
    async verify(token) {
      try {
        // algorithms:['RS256'] 핀 — jose 기본은 키가 지원하는 alg 전부 허용(alg confusion 여지). 명시 핀이
        // 실질 방어. issuer/audience 는 정확 일치 검증(만료·nbf 는 jose 기본 clock check).
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: opts.aud,
          algorithms: ['RS256'],
        })
        const sub = typeof payload.sub === 'string' ? payload.sub.trim() : ''
        if (!sub) throw new AccessJwtError('invalid', 'Access JWT: sub(identity) 없음')
        return { identity: sub }
      } catch (err) {
        // sub 결손으로 여기서 던진 AccessJwtError 도 classify 가 그대로 통과시킨다(instanceof 조기 반환).
        throw classify(err)
      }
    },
  }
}

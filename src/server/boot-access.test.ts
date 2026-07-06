import { mkdtempSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalJWKSet, errors as joseErrors, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootServer, type BootDeps, type RunningServer } from './boot'

/**
 * secured(access) 모드 통합 검증(#197 B5 T6·T7) — 실 JWKS/네트워크 없이 로컬 JWKS 를 BootDeps 로 주입해
 * nonce 발급 endpoint(HTTP)와 upgrade 파이프라인(WS)을 실기동으로 검증한다. access 하네스(keypair·토큰
 * 서명·원시 http)를 T6·T7 이 공유하므로 boot.test.ts 와 분리(계획 대비 하네스 재사용 정합 편차).
 */
const TEAM_DOMAIN = 'https://team.cloudflareaccess.com'
const ISSUER = new URL(TEAM_DOMAIN).origin
const AUD = 'aud-app-tag-xyz'
const PUBLIC_ORIGIN = 'https://fleet.example.com'
const KID = 'access-key-1'

type GeneratedPrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']
let privateKey: GeneratedPrivateKey
let jwks: BootDeps['accessJwks']

async function sign(
  opts: { sub?: string | null; iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> {
  let b = new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: KID })
  if (opts.sub !== null) b = b.setSubject(opts.sub ?? 'user-abc-123')
  return b
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.exp ?? '2h')
    .sign(privateKey)
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true })
  privateKey = kp.privateKey
  const pub = await exportJWK(kp.publicKey)
  pub.alg = 'RS256'
  pub.kid = KID
  jwks = createLocalJWKSet({ keys: [pub] })
})

async function bootAccess(
  opts: { env?: Record<string, string>; deps?: BootDeps } = {},
): Promise<RunningServer> {
  return bootServer(
    {
      FLEET_PORT: '0',
      FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b5-access-')),
      FLEET_E2E: '1',
      FLEET_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      FLEET_ACCESS_AUD: AUD,
      FLEET_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      ...opts.env,
    },
    { accessJwks: jwks, ...opts.deps },
  )
}

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}
function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('access 모드 nonce 발급 endpoint(#197 B5 T6)', () => {
  it('유효 Origin + JWT 헤더 → 200 + {nonce} + no-store', async () => {
    const server = await bootAccess()
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', {
        method: 'POST',
        headers: { origin: PUBLIC_ORIGIN, 'cf-access-jwt-assertion': await sign() },
      })
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      const body = JSON.parse(res.body) as { nonce: string }
      expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/)
    } finally {
      await server.close()
    }
  })

  it('401 실패 응답에도 no-store 단언(JWT 부재)', async () => {
    const server = await bootAccess()
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', {
        method: 'POST',
        headers: { origin: PUBLIC_ORIGIN },
      })
      expect(res.status).toBe(401)
      expect(res.headers['cache-control']).toBe('no-store')
    } finally {
      await server.close()
    }
  })

  it.each([
    { label: 'Origin 부재', origin: undefined },
    { label: 'scheme 차이(http)', origin: 'http://fleet.example.com' },
    { label: '포트 차이', origin: 'https://fleet.example.com:8443' },
    { label: '서브도메인 차이', origin: 'https://evil.fleet.example.com' },
    { label: 'Origin: null', origin: 'null' },
  ])('Origin exact 위반($label) → 403', async ({ origin }) => {
    const server = await bootAccess()
    try {
      const headers: Record<string, string> = { 'cf-access-jwt-assertion': await sign() }
      if (origin !== undefined) headers.origin = origin
      const res = await rawRequest(server.port, '/auth/ws-nonce', { method: 'POST', headers })
      expect(res.status).toBe(403)
    } finally {
      await server.close()
    }
  })

  it('JWT 부재(Origin 유효) → 401', async () => {
    const server = await bootAccess()
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', {
        method: 'POST',
        headers: { origin: PUBLIC_ORIGIN },
      })
      expect(res.status).toBe(401)
    } finally {
      await server.close()
    }
  })

  it('쿠키 폴백(CF_Authorization) → 200', async () => {
    const server = await bootAccess()
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', {
        method: 'POST',
        headers: { origin: PUBLIC_ORIGIN, cookie: `CF_Authorization=${await sign()}` },
      })
      expect(res.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('쿠키 파싱 경계 — 다중 쿠키 중 CF_Authorization 추출 → 200', async () => {
    const server = await bootAccess()
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', {
        method: 'POST',
        headers: {
          origin: PUBLIC_ORIGIN,
          cookie: `foo=bar; CF_Authorization=${await sign()}; baz=qux`,
        },
      })
      expect(res.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it.each(['GET', 'HEAD', 'OPTIONS'])('%s /auth/ws-nonce → 405(POST 외)', async (method) => {
    const server = await bootAccess()
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', {
        method,
        headers: { origin: PUBLIC_ORIGIN },
      })
      expect(res.status).toBe(405)
    } finally {
      await server.close()
    }
  })

  it('JWKS 조회 불능 → 503(fail-closed·JWT 형식 유효)', async () => {
    const server = await bootAccess({
      deps: {
        accessJwks: () => {
          throw new joseErrors.JWKSTimeout()
        },
      },
    })
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', {
        method: 'POST',
        headers: { origin: PUBLIC_ORIGIN, 'cf-access-jwt-assertion': await sign() },
      })
      expect(res.status).toBe(503)
      expect(res.headers['cache-control']).toBe('no-store')
    } finally {
      await server.close()
    }
  })

  it('거부 시 관측 로그 1줄(onSecurityReject) — 단계·사유 코드(토큰 미기록)', async () => {
    const rejects: Array<[string, string]> = []
    const server = await bootAccess({
      deps: { onSecurityReject: (s, r) => rejects.push([s, r]) },
    })
    try {
      await rawRequest(server.port, '/auth/ws-nonce', { method: 'POST', headers: {} }) // Origin 부재
      expect(rejects).toContainEqual(['nonce', 'origin'])
      await rawRequest(server.port, '/auth/ws-nonce', {
        method: 'POST',
        headers: { origin: PUBLIC_ORIGIN },
      }) // JWT 부재
      expect(rejects).toContainEqual(['nonce', 'jwt'])
    } finally {
      await server.close()
    }
  })

  it('loopback 무회귀 — POST /auth/ws-nonce → 405(access-only 배선)', async () => {
    const server = await bootServer({
      FLEET_PORT: '0',
      FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b5-loop-')),
      FLEET_E2E: '1',
    })
    try {
      const res = await rawRequest(server.port, '/auth/ws-nonce', { method: 'POST', headers: {} })
      expect(res.status).toBe(405)
    } finally {
      await server.close()
    }
  })
})

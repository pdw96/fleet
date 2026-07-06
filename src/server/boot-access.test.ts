import { mkdtempSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalJWKSet, errors as joseErrors, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { IpcApprover } from '../main/core/safety/approval-bridge'
import type { ApprovalRequest } from '../shared/types'
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

// ── WS 클라이언트 헬퍼(T7) ─────────────────────────────────────────────────────
interface WsConnectOpts {
  nonce?: string
  origin?: string
  token?: string
  cookie?: string
}
function makeWs(port: number, opts: WsConnectOpts): WebSocket {
  const q = opts.nonce !== undefined ? `?nonce=${encodeURIComponent(opts.nonce)}` : ''
  const headers: Record<string, string> = {}
  if (opts.token !== undefined) headers['cf-access-jwt-assertion'] = opts.token
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  const wsOpts: WebSocket.ClientOptions = { headers }
  if (opts.origin !== undefined) wsOpts.origin = opts.origin
  return new WebSocket(`ws://127.0.0.1:${port}/ws${q}`, wsOpts)
}
/** open→allowed(즉시 close), error/unexpected-response/타임아웃→rejected. */
function outcomeOf(ws: WebSocket): Promise<'allowed' | 'rejected'> {
  return new Promise((res) => {
    const timer = setTimeout(() => {
      ws.terminate()
      res('rejected')
    }, 4000)
    ws.once('open', () => {
      clearTimeout(timer)
      ws.close()
      res('allowed')
    })
    ws.once('error', () => {
      clearTimeout(timer)
      res('rejected')
    })
    ws.once('unexpected-response', () => {
      clearTimeout(timer)
      res('rejected')
    })
  })
}
const tryWsConnect = (port: number, opts: WsConnectOpts): Promise<'allowed' | 'rejected'> =>
  outcomeOf(makeWs(port, opts))
/** open 시 살아있는 소켓 반환(presence 테스트용 — close 하지 않음). */
function connectLive(port: number, opts: WsConnectOpts): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = makeWs(port, opts)
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('connect timeout'))
    }, 4000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    ws.once('unexpected-response', () => {
      clearTimeout(timer)
      reject(new Error('unexpected-response'))
    })
  })
}
async function getNonce(port: number, opts: WsConnectOpts = {}): Promise<string> {
  const headers: Record<string, string> = { origin: opts.origin ?? PUBLIC_ORIGIN }
  if (opts.token !== undefined) headers['cf-access-jwt-assertion'] = opts.token
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  const res = await rawRequest(port, '/auth/ws-nonce', { method: 'POST', headers })
  const body = JSON.parse(res.body) as { nonce?: string }
  if (!body.nonce) throw new Error(`nonce 발급 실패(status ${res.status})`)
  return body.nonce
}
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 타임아웃')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('access 모드 upgrade 파이프라인(#197 B5 T7 · 게이트 ⑤)', () => {
  it('정상: POST 발급 → ?nonce= 접속 → allowed + clientCount 1', async () => {
    const server = await bootAccess()
    try {
      const nonce = await getNonce(server.port, { token: await sign() })
      await expect(
        tryWsConnect(server.port, { nonce, origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('allowed')
    } finally {
      await server.close()
    }
  })

  it('nonce 없이 접속 → 거부', async () => {
    const server = await bootAccess()
    try {
      await expect(
        tryWsConnect(server.port, { origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('유효 JWT 쿠키 자동첨부여도 nonce 없으면 거부(CF_Authorization 우회 차단)', async () => {
    const server = await bootAccess()
    try {
      await expect(
        tryWsConnect(server.port, {
          origin: PUBLIC_ORIGIN,
          cookie: `CF_Authorization=${await sign()}`,
        }),
      ).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('타 identity nonce → 거부(바인딩 불일치)', async () => {
    const server = await bootAccess()
    try {
      const nonce = await getNonce(server.port, { token: await sign({ sub: 'alice' }) })
      await expect(
        tryWsConnect(server.port, {
          nonce,
          origin: PUBLIC_ORIGIN,
          token: await sign({ sub: 'bob' }),
        }),
      ).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('발급 origin 과 다른 Origin → 거부(Origin exact)', async () => {
    const server = await bootAccess()
    try {
      const nonce = await getNonce(server.port, { token: await sign() })
      await expect(
        tryWsConnect(server.port, {
          nonce,
          origin: 'https://evil.example.com',
          token: await sign(),
        }),
      ).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('재사용 → 거부(단일사용)', async () => {
    const server = await bootAccess()
    try {
      const nonce = await getNonce(server.port, { token: await sign() })
      await expect(
        tryWsConnect(server.port, { nonce, origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('allowed')
      await expect(
        tryWsConnect(server.port, { nonce, origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('실패 upgrade 의 nonce 재시도 → 거부(선소모 통합 핀 — take 가 JWT 앞)', async () => {
    const server = await bootAccess()
    try {
      const nonce = await getNonce(server.port, { token: await sign() })
      // 1차: 잘못된 JWT → 거부. 그러나 take 는 JWT 검증 앞이라 nonce 는 이미 소모됨.
      await expect(
        tryWsConnect(server.port, { nonce, origin: PUBLIC_ORIGIN, token: 'garbage.jwt.token' }),
      ).resolves.toBe('rejected')
      // 2차: 올바른 조건으로 같은 nonce 재시도 → 거부(이미 소모).
      await expect(
        tryWsConnect(server.port, { nonce, origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('빈 ?nonce= → 거부', async () => {
    const server = await bootAccess()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?nonce=`, {
        origin: PUBLIC_ORIGIN,
        headers: { 'cf-access-jwt-assertion': await sign() },
      })
      await expect(outcomeOf(ws)).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('중복 쿼리 ?nonce=valid&nonce=garbage → 첫값 채택 → allowed', async () => {
    const server = await bootAccess()
    try {
      const nonce = await getNonce(server.port, { token: await sign() })
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/ws?nonce=${encodeURIComponent(nonce)}&nonce=garbage`,
        { origin: PUBLIC_ORIGIN, headers: { 'cf-access-jwt-assertion': await sign() } },
      )
      await expect(outcomeOf(ws)).resolves.toBe('allowed')
    } finally {
      await server.close()
    }
  })
})

describe('access 모드 승인 presence fail-closed(#197 B5 T7 · 게이트 ④)', () => {
  const destructiveReq = (id: string): ApprovalRequest => ({
    id,
    kind: 'file-write',
    summary: 's',
    target: 't',
    risk: 'destructive',
    ts: 1,
  })

  it('① 미검증 접속만 있는 상태 + 승인 요청 → 즉시 false(검증 실패 socket presence 미포함)', async () => {
    let approver!: IpcApprover
    const server = await bootAccess({ deps: { onApprover: (a) => (approver = a) } })
    try {
      await expect(
        tryWsConnect(server.port, { origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('rejected') // nonce 부재 → attach 미도달
      expect(server.clientCount()).toBe(0)
      await expect(approver.approver(destructiveReq('x'))).resolves.toBe(false) // hasWindow false
      expect(approver.pendingCount()).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('② 인증 클라 1 · pending 중 disconnect → 타임아웃 없이 즉시 reject', async () => {
    let approver!: IpcApprover
    const server = await bootAccess({ deps: { onApprover: (a) => (approver = a) } })
    try {
      const ws = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign() }),
        origin: PUBLIC_ORIGIN,
        token: await sign(),
      })
      await waitFor(() => server.clientCount() === 1)
      const p = approver.approver(destructiveReq('x')) // hasWindow true → pending
      expect(approver.pendingCount()).toBe(1)
      ws.close() // 인증 클라 0 전이 → rejectAll
      await expect(p).resolves.toBe(false) // 60s 타임아웃 전 즉시 해소 = rejectAll
    } finally {
      await server.close()
    }
  })

  it('③ 인증 클라 2 중 1 이탈 → pending 유지(0 되는 순간에만)', async () => {
    let approver!: IpcApprover
    const server = await bootAccess({ deps: { onApprover: (a) => (approver = a) } })
    try {
      const ws1 = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign() }),
        origin: PUBLIC_ORIGIN,
        token: await sign(),
      })
      const ws2 = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign() }),
        origin: PUBLIC_ORIGIN,
        token: await sign(),
      })
      await waitFor(() => server.clientCount() === 2)
      const p = approver.approver(destructiveReq('x'))
      expect(approver.pendingCount()).toBe(1)
      ws1.close()
      await waitFor(() => server.clientCount() === 1) // ws1 close 서버측 처리 확인
      expect(approver.pendingCount()).toBe(1) // 유지(0 아님 → rejectAll 미발화)
      approver.resolve('x', true) // 정리
      await expect(p).resolves.toBe(true)
      ws2.close()
    } finally {
      await server.close()
    }
  })
})

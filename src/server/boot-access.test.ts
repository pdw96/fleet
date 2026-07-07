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

// ── T6: 소켓 exp-시한 종료 하네스(주입 clock ⟂ jose 실clock) ────────────────────
// jose 는 실 Date.now 로 exp 를 검증하므로 토큰 exp 는 실시간 미래로 서명한다. 소켓 종료 타이머만 주입
// clock 이 결정론으로 구동한다(setTimeout 실스케줄 없이 advanceTo 로 발화). 핸들 = 타이머 객체.
function fakeClock(startMs: number) {
  let current = startMs
  const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = []
  const clock = {
    now: () => current,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, at: current + ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimeout: (h: unknown) => {
      if (h && typeof h === 'object' && 'cleared' in h) (h as { cleared: boolean }).cleared = true
    },
  }
  const advanceTo = (ms: number): void => {
    current = ms
    for (;;) {
      const due = timers.find((t) => !t.cleared && t.at <= current)
      if (!due) break
      due.cleared = true
      due.fn() // 재무장(re-arm) 시 새 timer 가 push 되어 루프가 재수집
    }
  }
  return { clock, advanceTo, activeCount: () => timers.filter((t) => !t.cleared).length }
}

describe('access 모드 소켓 exp-시한 종료(#197-B6 T6)', () => {
  // 유효 미래 exp: 주입 clock now()=start 기준 delay=expiresAtMs-start(양수). jose 는 실 Date.now 로 통과.
  const futureExpSec = (start: number, aheadSec: number) => Math.floor(start / 1000) + aheadSec

  it('미래 exp → 만료 시각 도달 시 서버가 소켓을 닫는다', async () => {
    const start = Date.now()
    const fc = fakeClock(start)
    const server = await bootAccess({ deps: { clock: fc.clock } })
    try {
      const exp = futureExpSec(start, 100)
      const ws = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign({ exp }) }),
        origin: PUBLIC_ORIGIN,
        token: await sign({ exp }),
      })
      await waitFor(() => server.clientCount() === 1)
      fc.advanceTo(exp * 1000 + 1) // exp 초과 → 타이머 발화 → socket.close()
      await waitFor(() => server.clientCount() === 0)
      expect(server.clientCount()).toBe(0)
      ws.terminate()
    } finally {
      await server.close()
    }
  })

  it('attach 시점 이미 만료(exp<=now) → 소켓 미유지(presence 오염 없음)', async () => {
    // jose 통과를 위해 exp 는 실시간 아주 근접 미래(2s)로 서명하되, 주입 clock now() 를 그 exp 이후로
    // 세팅해 attach 시점 delay<=0 을 만든다(연결은 되나 attach 이전 close).
    const start = Date.now()
    const exp = Math.floor(start / 1000) + 2
    const fc = fakeClock(exp * 1000 + 5000) // now() 를 exp 이후로
    const server = await bootAccess({ deps: { clock: fc.clock } })
    try {
      await tryWsConnect(server.port, {
        nonce: await getNonce(server.port, { token: await sign({ exp }) }),
        origin: PUBLIC_ORIGIN,
        token: await sign({ exp }),
      })
      // attach 이전 close 라 presence 미증가. 잠깐 안정화 후 0 확인.
      await new Promise((r) => setTimeout(r, 50))
      expect(server.clientCount()).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('attach-시점-만료 early-close 소켓의 전송 오류가 서버를 죽이지 않는다(적대리뷰 CONFIRMED#1)', async () => {
    // early-close 경로도 connection 핸들러 최상단의 error 리스너를 받아야 한다 — 없으면 CLOSING 중 malformed
    // 프레임(receiverOnError)이 리스너 부재로 unhandledException → 프로세스 종료(self-DoS).
    const start = Date.now()
    const exp = Math.floor(start / 1000) + 2
    const fc = fakeClock(exp * 1000 + 5000) // attach 시점 이미 만료
    const server = await bootAccess({ deps: { clock: fc.clock } })
    try {
      const ws = makeWs(server.port, {
        nonce: await getNonce(server.port, { token: await sign({ exp }) }),
        origin: PUBLIC_ORIGIN,
        token: await sign({ exp }),
      })
      // open 즉시(서버 early-close 진행 중) unmasked 프레임을 흘려 서버측 파서 error 를 유도(RFC 6455 위반).
      ws.on('open', () => {
        try {
          const raw = (ws as unknown as { _socket?: { write(b: Buffer): void } })._socket
          raw?.write(Buffer.from([0x81, 0x01, 0x41]))
        } catch {
          /* 이미 닫힘 */
        }
      })
      await new Promise((r) => setTimeout(r, 200))
      // 서버 생존 증거 — 이후 정상 접속이 성공한다(early-close 소켓 error 로 죽었다면 이 프로세스 자체가 죽어 도달 불가).
      await expect(
        tryWsConnect(server.port, {
          nonce: await getNonce(server.port, { token: await sign() }),
          origin: PUBLIC_ORIGIN,
          token: await sign(),
        }),
      ).resolves.toBe('allowed')
      ws.terminate()
    } finally {
      await server.close()
    }
  }, 15_000)

  it('exp 전 소켓 close → 타이머 clear(재발화·이중 close 없음)', async () => {
    const start = Date.now()
    const fc = fakeClock(start)
    const server = await bootAccess({ deps: { clock: fc.clock } })
    try {
      const exp = futureExpSec(start, 100)
      const ws = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign({ exp }) }),
        origin: PUBLIC_ORIGIN,
        token: await sign({ exp }),
      })
      await waitFor(() => server.clientCount() === 1)
      ws.close() // exp 전 클라 종료 → handleSocketGone 이 타이머 clear
      await waitFor(() => server.clientCount() === 0)
      expect(fc.activeCount()).toBe(0) // 타이머 잔류 없음
      fc.advanceTo(exp * 1000 + 1) // 발화해도 재close 없음(clear 됨)
      expect(server.clientCount()).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('exp - now > TIMEOUT_MAX → 즉시 close 없이 clamp+re-arm(장수명 토큰)', async () => {
    const start = Date.now()
    const fc = fakeClock(start)
    const server = await bootAccess({ deps: { clock: fc.clock } })
    try {
      const exp = futureExpSec(start, 30 * 24 * 3600) // 30일(=delay>TIMEOUT_MAX 2147483647ms)
      const ws = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign({ exp }) }),
        origin: PUBLIC_ORIGIN,
        token: await sign({ exp }),
      })
      await waitFor(() => server.clientCount() === 1)
      fc.advanceTo(start + 2_147_483_647) // TIMEOUT_MAX 도달 → 첫 타이머 발화하나 remaining>0 → re-arm
      await new Promise((r) => setTimeout(r, 30))
      expect(server.clientCount()).toBe(1) // 즉시 close 아님(오버플로 버그면 여기서 0)
      fc.advanceTo(exp * 1000 + 1) // 실 exp 도달 → close
      await waitFor(() => server.clientCount() === 0)
      expect(server.clientCount()).toBe(0)
      ws.terminate()
    } finally {
      await server.close()
    }
  })

  it('서버 close 시 live 소켓 exp 타이머가 잔류하지 않는다', async () => {
    const start = Date.now()
    const fc = fakeClock(start)
    const server = await bootAccess({ deps: { clock: fc.clock } })
    const exp = futureExpSec(start, 100)
    const ws = await connectLive(server.port, {
      nonce: await getNonce(server.port, { token: await sign({ exp }) }),
      origin: PUBLIC_ORIGIN,
      token: await sign({ exp }),
    })
    await waitFor(() => server.clientCount() === 1)
    await server.close() // terminate → close 이벤트 → handleSocketGone → 타이머 clear
    await waitFor(() => fc.activeCount() === 0) // close 이벤트 전파는 비동기 — 잔류 없음까지 대기
    expect(fc.activeCount()).toBe(0)
    ws.terminate()
  })

  it('loopback 모드는 exp 타이머를 걸지 않는다(access 한정)', async () => {
    const start = Date.now()
    const fc = fakeClock(start)
    const server = await bootServer(
      {
        FLEET_PORT: '0',
        FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-t6-loop-')),
        FLEET_E2E: '1',
      },
      { clock: fc.clock },
    )
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
      await new Promise<void>((res, rej) => {
        ws.once('open', () => res())
        ws.once('error', rej)
      })
      await waitFor(() => server.clientCount() === 1)
      expect(fc.activeCount()).toBe(0) // exp 타이머 미설정
      ws.close()
    } finally {
      await server.close()
    }
  })
})

describe('access 모드 승인 hold(#216 C1 · C-6 supersede — presence-0 rejectAll 제거)', () => {
  // expiresAt 는 approver 가 읽는 clock 에서 파생(픽스처 시계 규율 #216 C1). 주입 fakeClock 은 start=실 Date.now
  // 로 시작하므로 Date.now()+delta 파생이 정합(delay≈delta). 만료 아닌 유지/승인 검증엔 넉넉한 미래값.
  const destructiveReq = (id: string, expiresAt = Date.now() + 60_000): ApprovalRequest => ({
    id,
    kind: 'file-write',
    summary: 's',
    target: 't',
    risk: 'destructive',
    ts: 1,
    expiresAt,
  })

  // #18 access presence-0 pending 유지(hold — 예전 rejectAll 대체)
  it('#18 인증 클라 1 · pending 중 disconnect(presence 0 전이) → rejectAll 미호출·pending 유지', async () => {
    let approver!: IpcApprover
    const server = await bootAccess({ deps: { onApprover: (a) => (approver = a) } })
    try {
      const ws = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign() }),
        origin: PUBLIC_ORIGIN,
        token: await sign(),
      })
      await waitFor(() => server.clientCount() === 1)
      const p = approver.approver(destructiveReq('x'))
      expect(approver.pendingCount()).toBe(1)
      ws.close() // 인증 클라 0 전이 — 예전엔 rejectAll, 이제 hold(유지)
      await waitFor(() => server.clientCount() === 0)
      await new Promise((r) => setTimeout(r, 50)) // 안정화
      expect(approver.pendingCount()).toBe(1) // hold: rejectAll 미발화·유지
      approver.resolve('x', true) // 정리(60s 만료 대기 없이)
      await expect(p).resolves.toEqual({ approved: true })
    } finally {
      await server.close()
    }
  })

  // #19 미검증 소켓 배제 — 미검증만 존재해도 승인은 held·미검증 소켓엔 노출/승인 불가(attach 미도달)
  it('#19 미검증 접속만 → 승인 hold(즉시거부 아님)·미검증 소켓은 attach 안 돼 broadcast/respond 도달 불가', async () => {
    let approver!: IpcApprover
    const server = await bootAccess({ deps: { onApprover: (a) => (approver = a) } })
    try {
      await expect(
        tryWsConnect(server.port, { origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('rejected') // nonce 부재 → attach 미도달(presence 미포함)
      expect(server.clientCount()).toBe(0)
      const p = approver.approver(destructiveReq('x'))
      // hold: presence=0(미검증만)이어도 자동거부/자동승인 없음 = held. 미검증 소켓은 attach 안 돼
      // wsHost.broadcast/dispatch 대상이 아니므로 이 카드를 보거나 승인할 수 없다(비인증 노출 0).
      expect(approver.pendingCount()).toBe(1)
      approver.resolve('x', false) // 정리
      await expect(p).resolves.toEqual({ approved: false })
    } finally {
      await server.close()
    }
  })

  // #20 JWT 만료 후 유지 + 재인증 승인(완료정의 "외출 중 폰 승인" 양성경로)
  it('#20 JWT exp 소켓 close(presence 0) 후에도 pending 유지·신규 인증 세션이 held 카드 정상 승인', async () => {
    const start = Date.now()
    const fc = fakeClock(start)
    let approver!: IpcApprover
    const server = await bootAccess({
      deps: { clock: fc.clock, onApprover: (a) => (approver = a) },
    })
    try {
      const exp = Math.floor(start / 1000) + 100
      await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign({ exp }) }),
        origin: PUBLIC_ORIGIN,
        token: await sign({ exp }),
      })
      await waitFor(() => server.clientCount() === 1)
      const p = approver.approver(destructiveReq('x', start + 300_000)) // 만료 넉넉히(외출)
      expect(approver.pendingCount()).toBe(1)
      fc.advanceTo(exp * 1000 + 1) // JWT exp 도달 → 소켓 close → presence 0
      await waitFor(() => server.clientCount() === 0)
      expect(approver.pendingCount()).toBe(1) // hold: 유지(rejectAll 없음)
      // 재접속(신규 인증 세션·귀가) → held 카드 승인
      const ws2 = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign() }),
        origin: PUBLIC_ORIGIN,
        token: await sign(),
      })
      await waitFor(() => server.clientCount() === 1)
      approver.resolve('x', true)
      await expect(p).resolves.toEqual({ approved: true })
      ws2.close()
    } finally {
      await server.close()
    }
  })

  // #23 만료→withdrawn 통합 — approver 타이머를 boot clock 으로 라우팅해 통합 만료 시 broadcast
  it('#23 통합 만료(주입 clock advanceTo) → fleet:approval:withdrawn 브로드캐스트 + resolve false', async () => {
    const start = Date.now()
    const fc = fakeClock(start)
    let approver!: IpcApprover
    const server = await bootAccess({
      deps: { clock: fc.clock, onApprover: (a) => (approver = a) },
    })
    try {
      const ws = await connectLive(server.port, {
        nonce: await getNonce(server.port, { token: await sign() }),
        origin: PUBLIC_ORIGIN,
        token: await sign(),
      })
      await waitFor(() => server.clientCount() === 1)
      const withdrawn: string[] = []
      ws.on('message', (raw: WebSocket.RawData) => {
        const s = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Buffer.from(raw).toString('utf8')
        if (s.includes('fleet:approval:withdrawn') && s.includes('appr-exp')) withdrawn.push(s)
      })
      const p = approver.approver(destructiveReq('appr-exp', start + 10_000))
      expect(approver.pendingCount()).toBe(1)
      fc.advanceTo(start + 10_001) // 만료 → approver 타이머 발화 → resolve false + onWithdraw broadcast
      await expect(p).resolves.toEqual({ approved: false })
      await waitFor(() => withdrawn.length === 1) // 인증 소켓이 withdrawn 프레임 수신
      expect(approver.pendingCount()).toBe(0)
      ws.close()
    } finally {
      await server.close()
    }
  })
})

describe('access 모드 bind 게이트 개방(#197 B5 T10)', () => {
  it('access + FLEET_HOST=0.0.0.0 → 부팅 성공 · host=0.0.0.0 · mode=access', async () => {
    const server = await bootAccess({ env: { FLEET_HOST: '0.0.0.0' } })
    try {
      expect(server.host).toBe('0.0.0.0')
      expect(server.mode).toBe('access')
    } finally {
      await server.close()
    }
  })

  it('access + 0.0.0.0 로 열어도 미인증 접속(nonce 부재)은 여전히 거부(열린 문을 upgrade 파이프라인이 지킴)', async () => {
    const server = await bootAccess({ env: { FLEET_HOST: '0.0.0.0' } })
    try {
      // 서버는 전 인터페이스에 bind 됐지만 접속 검증은 loopback 주소로 도달해도 동일하게 적용된다.
      await expect(
        tryWsConnect(server.port, { origin: PUBLIC_ORIGIN, token: await sign() }),
      ).resolves.toBe('rejected')
    } finally {
      await server.close()
    }
  })

  it('loopback 모드는 host=127.0.0.1·mode=loopback(기동 로그 파서 계약)', async () => {
    const server = await bootServer({
      FLEET_PORT: '0',
      FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b5-loop-')),
      FLEET_E2E: '1',
    })
    try {
      expect(server.host).toBe('127.0.0.1')
      expect(server.mode).toBe('loopback')
    } finally {
      await server.close()
    }
  })
})

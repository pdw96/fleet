import { chmodSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SocketExpiryClock } from './boot'
import WebSocket, { type RawData } from 'ws'
import {
  bootServer,
  buildServerChildEnv,
  resolveBindHost,
  resolveDrainTimeoutMs,
  resolvePort,
  resolveSandboxBoundary,
  type RunningServer,
} from './boot'
import type { SecurityConfig } from './security-config'
import type { IpcApprover } from '../main/core/safety/approval-bridge'
import type { ApprovalRequest, RunActivity } from '../shared/types'
import type { ServerFrame } from '../shared/transport/protocol'

/** ws `RawData`(Buffer|ArrayBuffer|Buffer[])를 텍스트 프레임 문자열로 정규화(no-base-to-string 회피). */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

describe('resolveBindHost — access 모드에서만 non-loopback 개방(#197 B5 T10)', () => {
  const LOOPBACK: SecurityConfig = { mode: 'loopback' }
  const ACCESS: SecurityConfig = {
    mode: 'access',
    teamDomain: new URL('https://team.cloudflareaccess.com'),
    aud: 'aud-tag',
    publicOrigin: 'https://fleet.example.com',
  }

  it.each([undefined, '', '127.0.0.1', '::1', 'localhost'])('loopback host(%s) 항상 허용', (v) => {
    expect(['127.0.0.1', '::1', 'localhost']).toContain(
      resolveBindHost({ FLEET_HOST: v }, LOOPBACK),
    )
    expect(['127.0.0.1', '::1', 'localhost']).toContain(resolveBindHost({ FLEET_HOST: v }, ACCESS))
  })

  it.each(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '192.168.0.10', 'fleet.example.com', '10.0.0.1'])(
    'loopback 모드 + non-loopback(%s) → throw(보안 미설정 시 loopback 고정)',
    (v) => {
      expect(() => resolveBindHost({ FLEET_HOST: v }, LOOPBACK)).toThrow(/loopback/i)
    },
  )

  it.each(['0.0.0.0', '::', '192.168.0.10', 'fleet.example.com'])(
    'access 모드 + non-loopback(%s) → 허용',
    (v) => {
      expect(resolveBindHost({ FLEET_HOST: v }, ACCESS)).toBe(v)
    },
  )

  it('access 모드 + FLEET_HOST 미설정 → 기본 127.0.0.1(개방은 명시 opt-in 이중 게이트)', () => {
    expect(resolveBindHost({}, ACCESS)).toBe('127.0.0.1')
  })
})

describe('resolvePort', () => {
  it('기본 8791 · FLEET_PORT 정수 파싱 · 0(임시 포트) 허용', () => {
    expect(resolvePort({})).toBe(8791)
    expect(resolvePort({ FLEET_PORT: '0' })).toBe(0)
  })
  it.each(['abc', '-1', '65536', '3.5'])('위반(%s) → throw', (v) => {
    expect(() => resolvePort({ FLEET_PORT: v })).toThrow()
  })
})

describe('FLEET_APPROVAL_TTL_MS fail-fast(#216 C1 §C-4 · #22)', () => {
  const baseEnv = (): NodeJS.ProcessEnv => ({
    FLEET_PORT: '0',
    FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-c1-ttl-')),
    FLEET_E2E: '1',
  })
  // 유한 양의 정수 아니거나 [5000,1800000] 밖 → boot throw(조용한 clamp 아님 · 부수효과 이전 fail-fast).
  it.each(['abc', 'NaN', '0', '-1', '4999', '1800001', '60000.5'])(
    '오설정/범위밖("%s") → boot throw',
    async (v) => {
      await expect(bootServer({ ...baseEnv(), FLEET_APPROVAL_TTL_MS: v })).rejects.toThrow(
        /FLEET_APPROVAL_TTL_MS/,
      )
    },
  )
  it.each(['5000', '600000', '1800000'])('정상값("%s") → boot 성공', async (v) => {
    const server = await bootServer({ ...baseEnv(), FLEET_APPROVAL_TTL_MS: v })
    await server.close()
  })
  it('미설정/빈값 → 기본(boot 성공)', async () => {
    const s1 = await bootServer(baseEnv())
    await s1.close()
    const s2 = await bootServer({ ...baseEnv(), FLEET_APPROVAL_TTL_MS: '  ' })
    await s2.close()
  })
})

describe('resolveDrainTimeoutMs — graceful drain 상한 fail-fast(#216 C3)', () => {
  // 미설정/빈/공백 = 기본 25000(현행 무회귀 — 드레인 도입 전엔 이 값이 무의미하나 계약상 기본).
  it.each([undefined, '', '   '])('미설정/빈/공백(%o) → 기본 25000', (v) => {
    expect(resolveDrainTimeoutMs({ FLEET_DRAIN_TIMEOUT_MS: v })).toBe(25_000)
  })
  it('키 자체 부재 → 25000', () => {
    expect(resolveDrainTimeoutMs({})).toBe(25_000)
  })
  // 유한 정수·[1000,120000] 경계 통과(trim 후).
  it.each(['1000', '25000', '120000', ' 30000 '])('정상값(%s) → 그대로(trim)', (v) => {
    expect(resolveDrainTimeoutMs({ FLEET_DRAIN_TIMEOUT_MS: v })).toBe(Number(v.trim()))
  })
  // 조용한 clamp 금지 — 비정수·범위밖은 loud-fail(부수효과 이전). MAX 120000 핀으로 "5분 vs 30s" 모순 차단.
  it.each(['abc', 'NaN', '0', '-1', '999', '120001', '25000.5'])(
    '오설정/범위밖(%s) → throw(env 이름·수신값 포함)',
    (v) => {
      expect(() => resolveDrainTimeoutMs({ FLEET_DRAIN_TIMEOUT_MS: v })).toThrow(
        /FLEET_DRAIN_TIMEOUT_MS/,
      )
      expect(() => resolveDrainTimeoutMs({ FLEET_DRAIN_TIMEOUT_MS: v })).toThrow(
        new RegExp(v.trim()),
      )
    },
  )
})

describe('resolveSandboxBoundary — 환경-인지 샌드박스 경계(#214 C1)', () => {
  // 미설정/빈/공백 = cli 기본 → 데스크톱·베어호스트 서버 무회귀(현행 CLI 내부 샌드박스 유지).
  it.each([undefined, '', '   '])('미설정/빈/공백(%o) → cli 기본', (v) => {
    expect(resolveSandboxBoundary({ FLEET_SANDBOX_BOUNDARY: v })).toBe('cli')
  })
  it('키 자체 부재 → cli', () => {
    expect(resolveSandboxBoundary({})).toBe('cli')
  })
  // trim 후 소문자 exact 만 유효값. 공백 감싼 값은 trim 통과.
  it.each(['cli', 'container', ' container ', ' cli '])('유효값(%o) → trim 후 정상', (v) => {
    expect(resolveSandboxBoundary({ FLEET_SANDBOX_BOUNDARY: v })).toBe(v.trim())
  })
  // 그 외 전부 loud-fail(조용한 강등 금지). 대문자·유사값 포함 — 소문자 exact 아님 → throw.
  // 메시지에 env 이름 + 수신값(진단) 포함.
  it.each(['CONTAINER', 'Container', 'CLI', 'docker', '1', 'true', 'both', 'container-mode'])(
    '미지값(%s) → throw(env 이름·수신값 포함)',
    (v) => {
      expect(() => resolveSandboxBoundary({ FLEET_SANDBOX_BOUNDARY: v })).toThrow(
        /FLEET_SANDBOX_BOUNDARY/,
      )
      expect(() => resolveSandboxBoundary({ FLEET_SANDBOX_BOUNDARY: v })).toThrow(
        new RegExp(v.trim()),
      )
    },
  )
})

describe('resolveSandboxBoundary fail-fast — 부수효과 이전 부팅 거부(#214 C1)', () => {
  it('미지값 → 부팅 거부 + dataDir 미생성(mkdirSync 이전 throw)', async () => {
    // 중첩 미존재 경로 — throw 가 mkdirSync 보다 앞서면 이 경로가 만들어지지 않는다.
    const dataDir = join(mkdtempSync(join(tmpdir(), 'fleet-214-')), 'sub', 'data')
    await expect(
      bootServer({ FLEET_SANDBOX_BOUNDARY: 'bogus', FLEET_DATA_DIR: dataDir, FLEET_PORT: '0' }),
    ).rejects.toThrow(/FLEET_SANDBOX_BOUNDARY/)
    expect(statSync(dataDir, { throwIfNoEntry: false })).toBeUndefined()
  })
})

describe('buildServerChildEnv — boot 자식 env 정책(#197-B6 T7)', () => {
  // boot 이 엔진에 주입하는 childEnv 팩토리. boot 은 엔진 runner/mcp spawn 을 미노출하므로 여기서 정책만
  // 고정하고(서버 시크릿 FLEET_* 를 자식 base·cliSession 에서 제거), 실 자식 미수신의 권위 증명은 T3 실
  // spawn·T10 컨테이너 스모크·라이브 5종에 위임한다(정직 프레이밍).
  const env = {
    FLEET_SECRET_KEY: 's',
    FLEET_ACCESS_AUD: 'a',
    FLEET_PUBLIC_ORIGIN: 'o',
    PATH: '/b',
    ANTHROPIC_API_KEY: 'k',
  }

  it('base()·cliSession() 이 서버 시크릿(FLEET_*)을 제거한다', () => {
    const ce = buildServerChildEnv(env)
    expect(ce.base().FLEET_SECRET_KEY).toBeUndefined()
    expect(ce.base().FLEET_ACCESS_AUD).toBeUndefined()
    expect(ce.cliSession().FLEET_SECRET_KEY).toBeUndefined()
    expect(ce.cliSession().FLEET_PUBLIC_ORIGIN).toBeUndefined()
  })

  it('base 는 provider 키 없이·cliSession 은 provider 키 포함·둘 다 PATH 통과', () => {
    const ce = buildServerChildEnv(env)
    expect(ce.base().PATH).toBe('/b')
    expect(ce.base().ANTHROPIC_API_KEY).toBeUndefined()
    expect(ce.cliSession().PATH).toBe('/b')
    expect(ce.cliSession().ANTHROPIC_API_KEY).toBe('k')
  })
})

describe('fleet-data 0700(#197-B6 T5)', () => {
  const bootWithData = (dataDir: string) =>
    bootServer({ FLEET_PORT: '0', FLEET_DATA_DIR: dataDir, FLEET_E2E: '1' })

  it.skipIf(process.platform === 'win32')(
    '신규 dataDir 을 0700 으로 생성한다(createJsonFileStore 이전 선생성)',
    async () => {
      // 중첩 미존재 경로 — recursive 생성 + 정확 0700 강제(기본 umask mode 아님) 검증.
      const dataDir = join(mkdtempSync(join(tmpdir(), 'fleet-t5-')), 'sub', 'data')
      const server = await bootWithData(dataDir)
      try {
        expect(statSync(dataDir).mode & 0o777).toBe(0o700)
      } finally {
        await server.close()
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    '기존 느슨한 권한 dataDir 을 0700 으로 보정한다(recursive mkdir 은 기존 mode 미변경)',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'fleet-t5-loose-'))
      chmodSync(dataDir, 0o755)
      const server = await bootWithData(dataDir)
      try {
        expect(statSync(dataDir).mode & 0o777).toBe(0o700)
      } finally {
        await server.close()
      }
    },
  )

  it('win32 에서도 부팅에 성공한다(chmod no-op — POSIX 조건 가드)', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'fleet-t5-win-')), 'data')
    const server = await bootWithData(dataDir)
    try {
      expect(server.port).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })
})

describe('bootServer 통합 — 실 ws 클라이언트(#197 B3)', () => {
  async function boot(): Promise<RunningServer> {
    return bootServer({
      FLEET_PORT: '0',
      FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b3-data-')),
      FLEET_E2E: '1', // 결정론 픽스처(세션 2·방 1) + 페이크 러너
    })
  }

  // 프레임 큐 — server 는 attach 시점(connection 이벤트)에 hello 를 동기 push 하므로, loopback 이라
  // 클라 소켓의 'message' 이벤트가 우리 쪽 `await connect()` 의 이어짐(then 마이크로태스크)보다 먼저
  // 실행될 수 있다. `connect()` 이후 `nextFrame()` 호출 시점에야 `once('message', …)` 를 붙이면 그 사이
  // 도착한 hello 프레임을 통째로 놓쳐 영구 대기(hang)한다(실측: win32 로컬 100% 재현 — 파일 병렬성과
  // 무관한 결정론적 레이스). socket 생성 즉시(= open 이전) 리스너를 걸어 도착 순서와 무관하게 큐잉한다.
  const queues = new WeakMap<
    WebSocket,
    { pending: ServerFrame[]; waiters: Array<(f: ServerFrame) => void> }
  >()
  function connect(port: number): Promise<WebSocket> {
    return new Promise((res, rej) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      const state = { pending: [] as ServerFrame[], waiters: [] as Array<(f: ServerFrame) => void> }
      queues.set(socket, state)
      socket.on('message', (d) => {
        const frame = JSON.parse(rawDataToString(d)) as ServerFrame
        const waiter = state.waiters.shift()
        if (waiter) waiter(frame)
        else state.pending.push(frame)
      })
      socket.once('open', () => res(socket))
      socket.once('error', rej)
    })
  }
  function nextFrame(socket: WebSocket): Promise<ServerFrame> {
    const state = queues.get(socket)
    if (!state) throw new Error('connect() 로 생성되지 않은 소켓')
    const queued = state.pending.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((res) => state.waiters.push(res))
  }

  it('non-loopback host 로는 부팅 자체가 거부된다', async () => {
    await expect(bootServer({ FLEET_HOST: '0.0.0.0', FLEET_PORT: '0' })).rejects.toThrow(
      /loopback/i,
    )
  })

  it('접속 첫 프레임=hello → app:info(runtime=web) → E2E 시드 세션 조회 → 미지 채널 에러', async () => {
    const server = await boot()
    const socket = await connect(server.port)
    try {
      const hello = await nextFrame(socket)
      expect(hello.t).toBe('hello')

      const resOf = async (id: number, ch: string, args: unknown[] = []) => {
        const p = nextFrame(socket)
        socket.send(JSON.stringify({ t: 'req', id, ch, args }))
        return p
      }
      const info = (await resOf(1, 'fleet:app:info')) as { ok: boolean; value: { runtime: string } }
      expect(info.ok).toBe(true)
      expect(info.value.runtime).toBe('web')

      const list = (await resOf(2, 'fleet:session:list')) as { value: { id: string }[] }
      expect(list.value.map((s) => s.id).sort()).toEqual(['cli:claude', 'cli:codex'])

      const unknown = (await resOf(3, 'fleet:update:check')) as { ok: boolean }
      expect(unknown.ok).toBe(false)
    } finally {
      socket.close()
      await server.close()
    }
  })

  it('FLEET_WORKSPACE_ROOT 미존재 경로 → 부팅 거부(fail-fast)', async () => {
    // workspaceRoot 검증은 store 생성 이후라 FLEET_DATA_DIR 누락 시 던지기 전에 레포 루트에
    // `fleet-data/` 를 실제로 만들어버린다(anti-footgun) — 임시 dataDir 로 격리한다.
    await expect(
      bootServer({
        FLEET_PORT: '0',
        FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b3-data-')),
        FLEET_WORKSPACE_ROOT: join(tmpdir(), 'no-such-dir-xyz'),
      }),
    ).rejects.toThrow()
  })

  describe('FLEET_STATIC_DIR 공백 폴백 — 정보노출 방지(#197 B3 · Codex P2)', () => {
    it('빈 문자열 → CWD 대신 renderer 폴백 → 레포 package.json 미서빙(404)', async () => {
      // `??` 는 ''(빈 문자열)에서 폴백하지 않는다 — env 템플레이팅으로 FLEET_STATIC_DIR='' 가 되면
      // staticDir 가 CWD(레포 루트)로 해소돼 소스/package.json 이 그대로 서빙된다(#197 B3 · Codex
      // P2). 이 테스트는 '/package.json' 200(레포 파일 노출) 대신 404(renderer 폴백엔 없음)를 요구해
      // 픽스 유무를 구분한다.
      const server = await bootServer({
        FLEET_PORT: '0',
        FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b3-data-')),
        FLEET_STATIC_DIR: '',
      })
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/package.json`)
        expect(res.status).toBe(404)
      } finally {
        await server.close()
      }
    })
  })

  describe('WS Origin 가드 — CSWSH 방어(#197 B3 · Codex P1)', () => {
    /**
     * node `ws` 클라의 `origin` 옵션이 실제 Origin 헤더를 세팅한다(결정론). 'open' → allowed,
     * 'error'/'unexpected-response' → rejected. 타임아웃은 안전측(rejected)으로 판정해 hang 을
     * "허용"으로 오판하지 않는다.
     */
    function tryConnect(port: number, origin?: string): Promise<'allowed' | 'rejected'> {
      return new Promise((res) => {
        const socket =
          origin === undefined
            ? new WebSocket(`ws://127.0.0.1:${port}`)
            : new WebSocket(`ws://127.0.0.1:${port}`, { origin })
        const timer = setTimeout(() => {
          socket.terminate()
          res('rejected')
        }, 2000)
        const settle = (outcome: 'allowed' | 'rejected'): void => {
          clearTimeout(timer)
          res(outcome)
        }
        socket.once('open', () => {
          socket.close()
          settle('allowed')
        })
        socket.once('error', () => settle('rejected'))
        socket.once('unexpected-response', () => settle('rejected'))
      })
    }

    it('cross-origin(https://evil.example) → 거부', async () => {
      const server = await boot()
      try {
        await expect(tryConnect(server.port, 'https://evil.example')).resolves.toBe('rejected')
      } finally {
        await server.close()
      }
    })

    it('no-origin(비브라우저 클라/ws 테스트 클라) → 허용', async () => {
      const server = await boot()
      try {
        await expect(tryConnect(server.port)).resolves.toBe('allowed')
      } finally {
        await server.close()
      }
    })

    it('loopback-origin(http://127.0.0.1:PORT) → 허용', async () => {
      const server = await boot()
      try {
        await expect(tryConnect(server.port, `http://127.0.0.1:${server.port}`)).resolves.toBe(
          'allowed',
        )
      } finally {
        await server.close()
      }
    })
  })

  describe('B5 loopback 특성화 핀 — 보안층 도입 전 하위호환 동결(#197 B5 T1)', () => {
    // 신규 구현 없음 — 현행 그대로 통과해야 하는 특성화 테스트. 이후 태스크(T6·T7·T10)가 이를 깨면
    // loopback 하위호환 위반이 즉시 RED 로 드러난다. boot() 헬퍼는 보안 env 를 설정하지 않으므로 loopback.

    it('보안 env 전부 부재 → nonce/JWT 없이 WS 접속·hello 수신(loopback 무회귀)', async () => {
      const server = await boot()
      const socket = await connect(server.port)
      try {
        const hello = await nextFrame(socket)
        expect(hello.t).toBe('hello') // nonce 쿼리·JWT 헤더 없이도 접속·hello 성공
      } finally {
        socket.close()
        await server.close()
      }
    })

    it('loopback: POST /auth/ws-nonce → nonce endpoint 부재(405 — 정적 핸들러 method guard)', async () => {
      // nonce 발급 endpoint 는 access 모드에서만 배선된다(T6). loopback 은 라우팅에 잡히지 않고 정적
      // 핸들러의 method guard 가 POST 를 405 로 자른다 — 이것이 loopback 의 최종 불변식이다. 계획 원문은
      // 404 를 적었으나 access-only 배선이라 loopback 에 nonce 경로 특수처리를 넣지 않는 것이 최소 diff·
      // 정합(정적 method guard 405). T6 는 access 배선만 추가하므로 이 405 는 그대로 유지된다.
      const server = await boot()
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/auth/ws-nonce`, { method: 'POST' })
        expect(res.status).toBe(405)
        expect(await res.text()).not.toContain('nonce') // 발급 응답 아님(경로 존재 비노출)
      } finally {
        await server.close()
      }
    })

    it('FLEET_ACCESS_* 빈 문자열만 존재 → loopback 유지(부분설정 오검출 없음)', async () => {
      // 빈 문자열 env = 미설정 동치(T3 resolveSecurityConfig `?.trim() ||` 관례의 boot 레벨 특성화):
      // 현행 boot 는 이 var 들을 읽지 않아 WS 접속이 정상(loopback). T3/T6 이후에도 loopback 이라 동일 GREEN.
      const server = await bootServer({
        FLEET_PORT: '0',
        FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b5-data-')),
        FLEET_E2E: '1',
        FLEET_ACCESS_TEAM_DOMAIN: '',
        FLEET_ACCESS_AUD: '',
        FLEET_PUBLIC_ORIGIN: '',
      })
      const socket = await connect(server.port)
      try {
        const hello = await nextFrame(socket)
        expect(hello.t).toBe('hello')
      } finally {
        socket.close()
        await server.close()
      }
    })

    // 적대 리뷰 확정(P3 · test-coverage 렌즈): loopback 은 presence-0 전이에서 rejectAll 을 발화하지
    // 않고 타임아웃 시맨틱을 유지한다(invariant #4 — boot.ts handleSocketGone 의 `mode === 'access'`
    // 가드). access ②③(boot-access.test.ts)의 정반대 대칭 핀이 없으면 그 가드 제거 회귀가 무신호로
    // 샌다(loopback 이 클라 이탈 시 승인을 조기 거부 = B3/B4 parity 파괴). 이 핀이 동결한다.
    it('loopback: 클라 전원 이탈 → 승인 pending 유지(rejectAll 미발화 — access 대칭)', async () => {
      // expiresAt 는 approver 가 읽는 clock(boot 기본 = 실 Date.now)에서 파생(픽스처 시계 규율 #216 C1)
      // — 소값이면 즉시 만료돼 pending 이 드레인됨(false-green 아닌 false-red). 만료 아닌 rejectAll/유지 검증이므로 미래값.
      const destructiveReq = (id: string): ApprovalRequest => ({
        id,
        kind: 'file-write',
        summary: 's',
        target: 't',
        risk: 'destructive',
        ts: 1,
        expiresAt: Date.now() + 60_000,
      })
      const waitFor = async (pred: () => boolean): Promise<void> => {
        const start = Date.now()
        while (!pred()) {
          if (Date.now() - start > 4000) throw new Error('waitFor 타임아웃')
          await new Promise((r) => setTimeout(r, 10))
        }
      }
      let approver!: IpcApprover
      const server = await bootServer(
        {
          FLEET_PORT: '0',
          FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-b5-data-')),
          FLEET_E2E: '1',
        },
        { onApprover: (a) => (approver = a) },
      )
      const socket = await connect(server.port)
      try {
        await nextFrame(socket) // hello 소비
        await waitFor(() => server.clientCount() === 1)
        const p = approver.approver(destructiveReq('x')) // hasWindow true → pending
        expect(approver.pendingCount()).toBe(1)
        socket.close()
        await waitFor(() => server.clientCount() === 0) // 클라 전원 이탈
        expect(approver.pendingCount()).toBe(1) // loopback → rejectAll 미발화·pending 생존
        approver.resolve('x', true) // 정리(타임아웃 대기 없이)
        await expect(p).resolves.toEqual({ approved: true })
      } finally {
        await server.close()
      }
    })
  })

  describe('close() drain rejectAll(#216 C1 · #21)', () => {
    const drainReq = (id: string): ApprovalRequest => ({
      id,
      kind: 'file-write',
      summary: 's',
      target: 't',
      risk: 'destructive',
      ts: 1,
      expiresAt: Date.now() + 300_000, // 만료 아닌 drain 검증 → 넉넉한 미래값
    })
    it('#21 close() → 대기 승인 전원 거부(hold·mode 무관)·in-flight 응답 멱등 no-op', async () => {
      let approver!: IpcApprover
      const server = await bootServer(
        {
          FLEET_PORT: '0',
          FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-c1-drain-')),
          FLEET_E2E: '1',
        },
        { onApprover: (a) => (approver = a) },
      )
      // hold 정책 — presence 0 이어도 보류(client 불요). close() 만이 drain rejectAll.
      const p1 = approver.approver(drainReq('a'))
      const p2 = approver.approver(drainReq('b'))
      expect(approver.pendingCount()).toBe(2)
      await server.close() // close() → ipcApprover.rejectAll()(C1 유지 — 종료 fail-closed 종단)
      await expect(p1).resolves.toEqual({ approved: false })
      await expect(p2).resolves.toEqual({ approved: false })
      approver.resolve('a', true) // in-flight 응답 — 이미 해소·멱등 no-op(throw 없음)
      expect(approver.pendingCount()).toBe(0)
    })
  })

  // ── #216 C3 graceful drain: shutdown 골격 ─────────────────────────────────
  // 주입 fakeClock(boot-access.test.ts 동형) — 드레인 cap/poll 타이머를 advanceTo 로 결정론 발화.
  function fakeClock(startMs: number) {
    let current = startMs
    const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = []
    const clock: SocketExpiryClock = {
      now: () => current,
      setTimeout: (fn, ms) => {
        const t = { fn, at: current + ms, cleared: false }
        timers.push(t)
        return t
      },
      clearTimeout: (h) => {
        if (h && typeof h === 'object' && 'cleared' in h) (h as { cleared: boolean }).cleared = true
      },
    }
    const advanceTo = (ms: number): void => {
      current = ms
      for (;;) {
        const due = timers.find((t) => !t.cleared && t.at <= current)
        if (!due) break
        due.cleared = true
        due.fn()
      }
    }
    return { clock, advanceTo }
  }

  describe('graceful drain shutdown(#216 C3 T3)', () => {
    const drainEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      FLEET_PORT: '0',
      FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-c3-')),
      FLEET_E2E: '1',
      ...extra,
    })

    it('RunningServer 에 shutdown·drainTimeoutMs 노출(기본 25000·env override)', async () => {
      const s1 = await bootServer(drainEnv())
      expect(typeof s1.shutdown).toBe('function')
      expect(s1.drainTimeoutMs).toBe(25_000)
      await s1.close()
      const s2 = await bootServer(drainEnv({ FLEET_DRAIN_TIMEOUT_MS: '30000' }))
      expect(s2.drainTimeoutMs).toBe(30_000)
      await s2.close()
    })

    it('shutdown() 무런 → 즉시 drained → close · 멱등(동일 promise·재호출 무해)', async () => {
      const s = await bootServer(drainEnv())
      const p1 = s.shutdown()
      const p2 = s.shutdown()
      expect(p1).toBe(p2) // memo-gate — 동일 promise 공유(중복 시그널)
      await p1
      expect(s.clientCount()).toBe(0)
      await s.close() // 이미 close(promise-memo) — no-op·throw 없음
      await s.shutdown() // 이미 shutdown — 동일 promise 재반환
    })

    it('무런 + pending 승인 → shutdown 이 close→rejectAll 로 승인 철회(드레인 종단 fail-closed)', async () => {
      let approver!: IpcApprover
      const s = await bootServer(drainEnv(), { onApprover: (a) => (approver = a) })
      const p = approver.approver({
        id: 'w',
        kind: 'file-write',
        summary: 's',
        target: 't',
        risk: 'destructive',
        ts: 1,
        expiresAt: Date.now() + 300_000,
      })
      expect(approver.pendingCount()).toBe(1)
      await s.shutdown() // 무런 → 즉시 drained → close() → rejectAll
      await expect(p).resolves.toEqual({ approved: false })
      expect(approver.pendingCount()).toBe(0)
    })

    it('hang 런 중 shutdown → 대기(정적 200·신규 런 거부) → cap 초과 force close → 대기 승인 철회', async () => {
      const START = 1_000
      const fc = fakeClock(START)
      let approver!: IpcApprover
      const s = await bootServer(drainEnv(), {
        clock: fc.clock,
        onApprover: (a) => (approver = a),
      })
      const socket = await connect(s.port)
      let idc = 1
      const pushes: Array<{ ch: string; event: unknown }> = []
      // 진행 런이 orchestrator:event push 프레임을 흘리므로, res 프레임(매칭 id)만 골라낸다. push 는 수집(T-통지 검증).
      const invoke = async (ch: string, args: unknown[] = []) => {
        const id = idc++
        socket.send(JSON.stringify({ t: 'req', id, ch, args }))
        for (;;) {
          const f = await nextFrame(socket)
          if (f.t === 'push') pushes.push({ ch: f.ch, event: f.event })
          else if (f.t === 'res' && f.id === id) return f
        }
      }
      try {
        await nextFrame(socket) // hello 소비
        // 활성 런 시드 — e2e hang 러너가 planTasks 에서 hang → activeRuns 비지 않음. 응답 미대기(id 고정 999).
        socket.send(
          JSON.stringify({ t: 'req', id: 999, ch: 'fleet:project:run', args: [{ goal: 'x' }] }),
        )
        // activeRuns 반영 대기(project.created 동기 방출이 dispatch 처리 후 반영).
        const startT = Date.now()
        for (;;) {
          const r = await invoke('fleet:project:activity')
          // 손으로 재선언한 구조 캐스트는 RunActivity 확장에 영원히 무신호라 실제 타입으로 결속한다(#251 PR0).
          const act = (r.ok ? r.value : undefined) as RunActivity | undefined
          if (act && act.activeProjectIds.length > 0) break
          if (Date.now() - startT > 4000) throw new Error('활성 런 대기 타임아웃')
          await new Promise((r) => setTimeout(r, 20))
        }
        // 대기 승인 1건(드레인 종단 rejectAll 대상). expiresAt 은 fakeClock now(START) 대비 큰 미래(cap 전진서 미만료).
        const appr = approver.approver({
          id: 'z',
          kind: 'file-write',
          summary: 's',
          target: 't',
          risk: 'destructive',
          ts: 1,
          expiresAt: 1_000_000,
        })
        expect(approver.pendingCount()).toBe(1)

        // shutdown — 진행 런이 있어 waitForRunDrain 대기(fakeClock 미전진 → 미해소).
        let done = false
        const sp = s.shutdown().then(() => {
          done = true
        })
        await Promise.resolve() // draining=true 반영 마이크로태스크

        // CD1: 드레인 대기 중 정적 라우트 200 유지(httpServer listen · healthcheck-green 불변식 §4-7).
        const health = await fetch(`http://127.0.0.1:${s.port}/`)
        expect(health.status).toBe(200)
        // 게이트: 드레인 중 신규 런 거부.
        const rejected = await invoke('fleet:project:run', [{ goal: 'y' }])
        expect(rejected.ok).toBe(false)
        if (!rejected.ok) expect(rejected.error.message).toMatch(/서버 종료 중/)
        expect(done).toBe(false) // cap 미도달 → 미해소
        // T-통지: shutdown 시작 시 fleet:server:draining push 방출(정적 payload · 위 invoke 들이 수집).
        const drain = pushes.find((p) => p.ch === 'fleet:server:draining')
        expect(drain).toBeDefined()
        expect(drain?.event).toEqual({ reason: 'shutdown' })

        // cap 초과 → 드레인 timeout → force close(dispose abort + rejectAll).
        fc.advanceTo(START + 25_000 + 1)
        await sp
        expect(done).toBe(true)
        await expect(appr).resolves.toEqual({ approved: false }) // 대기 승인 철회(cap철회)
      } finally {
        socket.close()
        await s.close()
      }
    })
  })

  describe('소켓 error 핸들러 — 프로세스 생존(#197 B3 · Codex P2)', () => {
    it('비정상(unmasked) 프레임 → 서버측 소켓 error 가 발생해도 서버는 생존, 이후 접속도 정상', async () => {
      const server = await boot()
      try {
        const bad = await connect(server.port)
        await nextFrame(bad) // hello 소비

        // client→server 프레임은 마스킹이 RFC 6455 필수 — unmasked 프레임을 raw 로 흘리면 서버측 ws
        // 파서가 'MASK must be set' error 를 emit 한다(결정론적 트리거). 리스너가 없으면 Node 가
        // 프로세스를 종료한다 — 이게 바로 Codex P2 가 지적한 크래시 경로.
        const rawSocket = (bad as unknown as { _socket: { write(data: Buffer): void } })._socket
        rawSocket.write(Buffer.from([0x81, 0x01, 0x41])) // FIN+text, len 1, 'A' — unmasked

        // 아래 새 접속이 hello 를 받는 데 도달한다는 것 자체가 프로세스 생존 증거다(unhandled error 로
        // 죽었다면 이 시점에 도달 불가 — 테스트 프로세스 자체가 죽는다).
        const next = await connect(server.port)
        const hello = await nextFrame(next)
        expect(hello.t).toBe('hello')
        next.close()

        // 부가 확인(최선노력) — 악성 소켓 자체는 서버에 의해 종료된다.
        await new Promise<void>((res) => {
          const t = setTimeout(res, 500)
          bad.once('close', () => {
            clearTimeout(t)
            res()
          })
        })
        expect(bad.readyState).not.toBe(WebSocket.OPEN)
      } finally {
        await server.close()
      }
    })
  })
})

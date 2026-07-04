import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { bootServer, resolveBindHost, resolvePort, type RunningServer } from './boot'
import type { ServerFrame } from '../shared/transport/protocol'

/** ws `RawData`(Buffer|ArrayBuffer|Buffer[])를 텍스트 프레임 문자열로 정규화(no-base-to-string 회피). */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

describe('resolveBindHost — B5 전 loopback 강제(#197 B3 완료 조건)', () => {
  it.each([undefined, '', '127.0.0.1', '::1', 'localhost'])('loopback(%s) 허용', (v) => {
    expect(['127.0.0.1', '::1', 'localhost']).toContain(resolveBindHost({ FLEET_HOST: v }))
  })
  it.each(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '192.168.0.10', 'fleet.example.com', '10.0.0.1'])(
    'non-loopback(%s) → throw — 어떤 env 로도 안 열림',
    (v) => {
      expect(() => resolveBindHost({ FLEET_HOST: v })).toThrow(/loopback/i)
    },
  )
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

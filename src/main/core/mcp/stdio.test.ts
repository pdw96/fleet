import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '../../../shared/types'
import { createDefaultSpawn, createStdioTransport } from './stdio'
import type { McpChild } from './types'

// #197-B6 T4 — MCP stdio 자식은 임의 사용자 구성 프로세스라 서버 시크릿(FLEET_*)·provider 키가 기본
// 전달되면 유출 경로가 된다. createDefaultSpawn(baseEnv) 는 base(런타임 최소·provider 키 없음)만 적용하고,
// provider 키가 필요한 서버는 spec.env(명시 escape hatch)로만 넣는다. 실 spawn(node 가 env JSON 출력)으로 검증.
describe('createDefaultSpawn env 격리(#197-B6 T4)', () => {
  const dumpSpec = (env?: Record<string, string>): McpServerSpec => ({
    name: 'envdump',
    command: 'node',
    args: ['-e', 'process.stdout.write(JSON.stringify(process.env));process.exit(0)'],
    env,
  })
  const winEssentials = (): NodeJS.ProcessEnv =>
    process.platform === 'win32'
      ? {
          SystemRoot: process.env.SystemRoot,
          PATHEXT: process.env.PATHEXT,
          ComSpec: process.env.ComSpec,
        }
      : {}

  const captureEnv = (spawnFn: ReturnType<typeof createDefaultSpawn>, spec: McpServerSpec) =>
    new Promise<Record<string, string>>((resolve, reject) => {
      const child = spawnFn(spec)
      let out = ''
      child.onStdout((c) => {
        out += c
      })
      child.onClose((err) => {
        if (err) reject(err)
        else resolve(JSON.parse(out || '{}') as Record<string, string>)
      })
    })

  it('base env 를 적용해 FLEET_SECRET_KEY·provider 키를 MCP 자식에서 제거한다', async () => {
    process.env.FLEET_SECRET_KEY = 'server-secret'
    process.env.ANTHROPIC_API_KEY = 'parent-key'
    try {
      const spawnFn = createDefaultSpawn(() => ({
        PATH: process.env.PATH,
        T4_MARK: 'base',
        ...winEssentials(),
      }))
      const env = await captureEnv(spawnFn, dumpSpec())
      expect(env.T4_MARK).toBe('base')
      expect(env.FLEET_SECRET_KEY).toBeUndefined()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      delete process.env.FLEET_SECRET_KEY
      delete process.env.ANTHROPIC_API_KEY
    }
  }, 15_000)

  it('spec.env 는 base 뒤에 병합돼 override/추가된다(provider 키 명시 escape hatch)', async () => {
    const spawnFn = createDefaultSpawn(() => ({
      PATH: process.env.PATH,
      T4_MARK: 'base',
      ...winEssentials(),
    }))
    const env = await captureEnv(
      spawnFn,
      dumpSpec({ MY_SERVER_TOKEN: 't', ANTHROPIC_API_KEY: 'explicit' }),
    )
    expect(env.MY_SERVER_TOKEN).toBe('t')
    expect(env.ANTHROPIC_API_KEY).toBe('explicit')
    expect(env.T4_MARK).toBe('base')
  }, 15_000)

  it('baseEnv 미주입이면 현행처럼 부모 env 를 전량 상속한다(데스크톱 MCP 무회귀)', async () => {
    process.env.T4_INHERIT = 'yes'
    try {
      const env = await captureEnv(createDefaultSpawn(), dumpSpec())
      expect(env.T4_INHERIT).toBe('yes')
    } finally {
      delete process.env.T4_INHERIT
    }
  }, 15_000)
})

/** 테스트용 fake child — 쓰기 캡처·stdout 청크 주입·종료 발사. */
function fakeChild() {
  let out: (chunk: string) => void = () => {}
  let close: (err?: Error) => void = () => {}
  const writes: string[] = []
  const child: McpChild = {
    write: (l) => writes.push(l),
    onStdout: (h) => {
      out = h
    },
    onClose: (h) => {
      close = h
    },
    kill: () => close(),
  }
  return { child, writes, emit: (c: string) => out(c), end: (e?: Error) => close(e) }
}

const spec = { name: 's', command: 'c' }

describe('createStdioTransport', () => {
  it('개행 구분 JSON 을 프레이밍하고 부분 청크를 버퍼링한다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    const msgs: Record<string, unknown>[] = []
    t.onMessage((m) => msgs.push(m))
    f.emit('{"jsonrpc":"2.0","id":1,') // 부분
    expect(msgs).toHaveLength(0)
    f.emit('"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{"a":1}}\n')
    expect(msgs).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: { a: 1 } },
    ])
  })

  it('send 는 개행을 붙여 직렬화한다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    t.send({ jsonrpc: '2.0', id: 1, method: 'x' })
    expect(f.writes).toEqual(['{"jsonrpc":"2.0","id":1,"method":"x"}\n'])
  })

  it('잘못된 JSON 라인은 건너뛰고 연결을 깨지 않는다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    const msgs: Record<string, unknown>[] = []
    t.onMessage((m) => msgs.push(m))
    f.emit('garbage\n{"id":1,"result":{}}\n')
    expect(msgs).toEqual([{ id: 1, result: {} }])
  })

  it('자식 종료를 onClose 로 전파한다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    let err: Error | undefined | 'none' = 'none'
    t.onClose((e) => {
      err = e
    })
    f.end(new Error('dead'))
    expect((err as unknown as Error)?.message).toBe('dead')
  })

  it('close() 가 onClose 를 통지한다(진행 중 요청을 즉시 종료하도록)', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    let notified = 0
    t.onClose(() => {
      notified += 1
    })
    t.close()
    expect(notified).toBe(1) // close() 가 closeHandler 를 정확히 1회 호출(타임아웃 매달림 방지)
  })
})

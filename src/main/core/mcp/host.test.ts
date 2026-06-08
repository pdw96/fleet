import { describe, expect, it, vi } from 'vitest'
import type { McpServerSpec } from '../../../shared/types'
import { createMcpHost } from './host'
import type { SpawnFn } from './types'

/**
 * JSON-RPC 응답을 스크립트하는 fake spawn. reply(spec, method, params) 가 result 를 돌려주거나 throw.
 * throw → error 응답(서버 실패 시뮬레이트). kill 카운터로 종료를 검증한다.
 */
function fakeSpawn(reply: (spec: McpServerSpec, method: string, params: unknown) => unknown) {
  const kills: string[] = []
  const spawns: string[] = []
  // 서버명 → 자식 종료 트리거(idle 크래시 시뮬레이트용).
  const closers = new Map<string, () => void>()
  const spawn: SpawnFn = (spec) => {
    spawns.push(spec.name)
    let out: (chunk: string) => void = () => {}
    let close: (err?: Error) => void = () => {}
    closers.set(spec.name, () => close())
    return {
      write: (line) => {
        const msg = JSON.parse(line) as { id?: number; method: string; params: unknown }
        if (msg.id == null) return // 알림
        let payload: Record<string, unknown>
        try {
          payload = { jsonrpc: '2.0', id: msg.id, result: reply(spec, msg.method, msg.params) }
        } catch (e) {
          payload = { jsonrpc: '2.0', id: msg.id, error: { code: -1, message: (e as Error).message } }
        }
        queueMicrotask(() => out(`${JSON.stringify(payload)}\n`))
      },
      onStdout: (h) => {
        out = h
      },
      onClose: (h) => {
        close = h
      },
      kill: () => {
        kills.push(spec.name)
        close()
      },
    }
  }
  return { spawn, kills, spawns, closers }
}

/** 항상 승인/거부하는 최소 ApprovalGate. */
const approveAll = { request: async () => 'approved' as const }
const rejectAll = { request: async () => 'rejected' as const }

const echoReply = (spec: McpServerSpec, method: string): unknown => {
  if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
  if (method === 'tools/list') return { tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }] }
  if (method === 'tools/call') return { content: [{ type: 'text', text: `hi from ${spec.name}` }] }
  return {}
}

describe('createMcpHost', () => {
  it('서버에 연결하고 도구를 FleetTool 로 노출한다', async () => {
    const { spawn } = fakeSpawn(echoReply)
    const host = createMcpHost({ spawn })
    const status = await host.setServers([{ name: 'srv', command: 'x' }])
    expect(status).toEqual([{ name: 'srv', connected: true, toolCount: 1, tools: ['mcp__srv__echo'] }])
    const tools = host.tools()
    expect(tools.map((t) => t.definition.name)).toEqual(['mcp__srv__echo'])
    expect(await tools[0].execute({}, {})).toBe('hi from srv')
  })

  it('한 서버가 실패해도 나머지를 격리해 연결한다', async () => {
    const { spawn } = fakeSpawn((spec, method) => {
      if (spec.name === 'bad' && method === 'initialize') throw new Error('boom')
      return echoReply(spec, method)
    })
    const audit = vi.fn()
    const host = createMcpHost({ spawn, onAudit: audit })
    const status = await host.setServers([
      { name: 'good', command: 'x' },
      { name: 'bad', command: 'y' },
    ])
    expect(status.find((s) => s.name === 'good')?.connected).toBe(true)
    const bad = status.find((s) => s.name === 'bad')
    expect(bad?.connected).toBe(false)
    expect(bad?.error).toContain('boom')
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__good__echo'])
    expect(audit).toHaveBeenCalledWith('mcp.server.failed', expect.objectContaining({ name: 'bad' }))
  })

  it('중복 서버 이름은 throw 한다', async () => {
    const { spawn } = fakeSpawn(echoReply)
    const host = createMcpHost({ spawn })
    await expect(
      host.setServers([
        { name: 'dup', command: 'x' },
        { name: 'dup', command: 'y' },
      ]),
    ).rejects.toThrow(/충돌|dup/)
  })

  it('re-setServers: 미변경 유지·제거 종료·변경 재연결', async () => {
    const inits: string[] = []
    const { spawn, kills } = fakeSpawn((spec, method) => {
      if (method === 'initialize') inits.push(spec.name)
      return echoReply(spec, method)
    })
    const host = createMcpHost({ spawn })
    await host.setServers([
      { name: 'a', command: 'x' },
      { name: 'b', command: 'y' },
    ])
    expect(inits).toEqual(['a', 'b'])
    await host.setServers([{ name: 'a', command: 'x' }]) // b 제거, a 미변경
    expect(kills).toContain('b')
    expect(inits).toEqual(['a', 'b']) // a 재연결 없음(initialize 추가 호출 없음)
    expect(host.status().map((s) => s.name)).toEqual(['a'])
  })

  it('dispose 는 모든 클라이언트를 종료한다', async () => {
    const { spawn, kills } = fakeSpawn(echoReply)
    const host = createMcpHost({ spawn })
    await host.setServers([{ name: 'srv', command: 'x' }])
    await host.dispose()
    expect(kills).toContain('srv')
    expect(host.tools()).toHaveLength(0)
    expect(host.status()).toHaveLength(0)
  })

  it('실패한 서버는 다음 setServers 에서 재연결을 시도한다', async () => {
    let healthy = false
    const { spawn } = fakeSpawn((spec, method) => {
      if (method === 'initialize' && !healthy) throw new Error('down')
      return echoReply(spec, method)
    })
    const host = createMcpHost({ spawn })
    let status = await host.setServers([{ name: 'srv', command: 'x' }])
    expect(status[0].connected).toBe(false)
    expect(host.tools()).toHaveLength(0)
    healthy = true
    status = await host.setServers([{ name: 'srv', command: 'x' }])
    expect(status[0].connected).toBe(true)
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__echo'])
  })

  it('gate 가 승인하면 spawn 하고 연결한다', async () => {
    const { spawn, spawns } = fakeSpawn(echoReply)
    const host = createMcpHost({ spawn, gate: approveAll })
    const status = await host.setServers([{ name: 'srv', command: 'x' }])
    expect(status[0].connected).toBe(true)
    expect(spawns).toEqual(['srv'])
  })

  it('gate 가 거부하면 spawn 하지 않고 거부 상태로 둔다', async () => {
    const { spawn, spawns } = fakeSpawn(echoReply)
    const audit = vi.fn()
    const host = createMcpHost({ spawn, gate: rejectAll, onAudit: audit })
    const status = await host.setServers([{ name: 'srv', command: 'x' }])
    expect(status[0]).toMatchObject({ name: 'srv', connected: false })
    expect(status[0].error).toMatch(/거부/)
    expect(spawns).toEqual([]) // spawn 안 됨 — 게이트 이전에 막힘
    expect(host.tools()).toHaveLength(0)
    expect(audit).toHaveBeenCalledWith('mcp.server.rejected', expect.objectContaining({ name: 'srv' }))
  })

  it('gate 에 shell·destructive·명령줄로 승인을 요청한다', async () => {
    const { spawn } = fakeSpawn(echoReply)
    const request = vi.fn(async () => 'approved' as const)
    const host = createMcpHost({ spawn, gate: { request } })
    await host.setServers([{ name: 'srv', command: 'node', args: ['s.js'] }])
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'shell', risk: 'destructive', target: 'node s.js' }),
    )
  })

  it('승인 target 에 cwd·env 키를 포함한다(env 값은 노출 안 함)', async () => {
    const { spawn } = fakeSpawn(echoReply)
    const request = vi.fn(async () => 'approved' as const)
    const host = createMcpHost({ spawn, gate: { request } })
    await host.setServers([{ name: 'srv', command: 'node', args: ['s.js'], cwd: '/tmp/work', env: { SECRET: 'xyz' } }])
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'node s.js (cwd: /tmp/work) (env: SECRET)' }),
    )
  })

  it('서버 간 이름 충돌은 한 서버만 노출하고 진 서버를 status·감사로 표면화한다', async () => {
    const { spawn } = fakeSpawn((_spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') return { tools: [{ name: 'x' }] }
      return {}
    })
    const audit = vi.fn()
    const host = createMcpHost({ spawn, onAudit: audit })
    // 두 서버명 모두 sanitize → 'foo_bar' → 도구 mcp__foo_bar__x 충돌. 먼저 등록(foo.bar)이 이긴다.
    const status = await host.setServers([
      { name: 'foo.bar', command: 'a' },
      { name: 'foo_bar', command: 'b' },
    ])
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__foo_bar__x'])
    expect(status.find((s) => s.name === 'foo.bar')?.toolCount).toBe(1)
    expect(status.find((s) => s.name === 'foo_bar')?.toolCount).toBe(0) // 진 서버는 status 에서도 0
    expect(audit).toHaveBeenCalledWith(
      'mcp.tool.skipped',
      expect.objectContaining({ reason: 'duplicate name (cross-server)' }),
    )
  })

  it('sanitize 후 충돌하는 도구는 하나만 노출하고 나머지는 skip 한다', async () => {
    const { spawn } = fakeSpawn((_spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') return { tools: [{ name: 'do.thing' }, { name: 'do_thing' }] } // 둘 다 mcp__srv__do_thing
      return {}
    })
    const audit = vi.fn()
    const host = createMcpHost({ spawn, onAudit: audit })
    const status = await host.setServers([{ name: 'srv', command: 'x' }])
    expect(status[0].toolCount).toBe(1)
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__do_thing'])
    expect(audit).toHaveBeenCalledWith('mcp.tool.skipped', expect.objectContaining({ reason: 'duplicate name' }))
  })

  it('연결된 서버가 종료되면 도구를 무효화하고 disconnected 로 표시한다', async () => {
    const { spawn, closers } = fakeSpawn(echoReply)
    const audit = vi.fn()
    const host = createMcpHost({ spawn, onAudit: audit })
    await host.setServers([{ name: 'srv', command: 'x' }])
    expect(host.tools()).toHaveLength(1)
    closers.get('srv')!() // 자식이 스스로 종료(idle 크래시) 시뮬레이트
    expect(host.tools()).toHaveLength(0)
    expect(host.status()[0]).toMatchObject({ name: 'srv', connected: false })
    expect(audit).toHaveBeenCalledWith(
      'mcp.server.disconnected',
      expect.objectContaining({ name: 'srv', reason: 'exit' }),
    )
  })

  it('겹치는 setServers 를 직렬화한다(중복 spawn 없음)', async () => {
    const { spawn, spawns } = fakeSpawn(echoReply)
    const host = createMcpHost({ spawn })
    const p1 = host.setServers([{ name: 'srv', command: 'x' }])
    const p2 = host.setServers([{ name: 'srv', command: 'x' }]) // 즉시 두 번째 호출(미변경)
    await Promise.all([p1, p2])
    expect(spawns).toEqual(['srv']) // 한 번만 spawn
    expect(host.status().map((s) => s.name)).toEqual(['srv'])
  })

  it('승인 대기 중 dispose 되면 그 후로 spawn 하지 않는다', async () => {
    const { spawn, spawns } = fakeSpawn(echoReply)
    let release!: (d: 'approved' | 'rejected') => void
    const gate = { request: () => new Promise<'approved' | 'rejected'>((res) => (release = res)) }
    const host = createMcpHost({ spawn, gate })
    const p = host.setServers([{ name: 'srv', command: 'x' }]) // gate 에서 멈춤
    await new Promise<void>((r) => setTimeout(r, 0)) // doSetServers 가 gate.request 까지 진행하도록 양보
    const d = host.dispose() // 승인 대기 중 dispose
    release('approved') // 승인이 늦게 도착
    await Promise.all([p, d])
    expect(spawns).toEqual([]) // dispose 후라 spawn 안 함(좀비 방지)
    expect(host.tools()).toHaveLength(0)
  })

  it('승자 서버가 종료되면 가려졌던 서버의 도구·status 가 복원된다', async () => {
    const { spawn, closers } = fakeSpawn((_spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') return { tools: [{ name: 'x' }] }
      return {}
    })
    const host = createMcpHost({ spawn })
    await host.setServers([
      { name: 'foo.bar', command: 'a' }, // 승자(먼저 등록)
      { name: 'foo_bar', command: 'b' }, // 패자(같은 mcp__foo_bar__x 로 가려짐)
    ])
    expect(host.status().find((s) => s.name === 'foo_bar')?.toolCount).toBe(0)
    closers.get('foo.bar')!() // 승자 종료
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__foo_bar__x']) // 패자 도구 노출
    expect(host.status().find((s) => s.name === 'foo_bar')?.toolCount).toBe(1) // status 복원
    expect(host.status().find((s) => s.name === 'foo.bar')?.connected).toBe(false)
  })
})

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
  // 서버명 → 서버 발신 메시지 주입(알림 등). 클로저가 최신 out 을 참조하므로 onStdout 이후 동작한다.
  const notifiers = new Map<string, (msg: Record<string, unknown>) => void>()
  const spawn: SpawnFn = (spec) => {
    spawns.push(spec.name)
    let out: (chunk: string) => void = () => {}
    let close: (err?: Error) => void = () => {}
    closers.set(spec.name, () => close())
    notifiers.set(spec.name, (msg) => out(`${JSON.stringify(msg)}\n`))
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
  return { spawn, kills, spawns, closers, notifiers }
}

/** 서버 발신 tools/list_changed 알림 메시지(id 없는 JSON-RPC 알림). */
const LIST_CHANGED = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }

/**
 * tools/list 응답을 테스트가 직접 풀어주는 spawn — 새로고침 직렬화(순서 보장) 검증용.
 * initialize 는 자동 응답하고, tools/list 는 큐에 쌓아 resolveList 로 가장 오래된 것부터 응답한다.
 * 이렇게 응답 시점을 제어해야 "1차 새로고침이 끝나기 전엔 2차가 tools/list 를 보내지 않는다"를 검증할 수 있다.
 */
function deferredSpawn() {
  const outs = new Map<string, (chunk: string) => void>()
  const notifiers = new Map<string, (msg: Record<string, unknown>) => void>()
  const pendingLists = new Map<string, number[]>() // 서버 → 응답 대기 중인 tools/list 요청 id 큐
  const spawn: SpawnFn = (spec) => {
    let out: (chunk: string) => void = () => {}
    return {
      write: (line) => {
        const msg = JSON.parse(line) as { id?: number; method: string }
        if (msg.id == null) return // 알림
        if (msg.method === 'initialize') {
          queueMicrotask(() =>
            out(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {} } })}\n`),
          )
        } else if (msg.method === 'tools/list') {
          pendingLists.set(spec.name, [...(pendingLists.get(spec.name) ?? []), msg.id!])
        }
      },
      onStdout: (h) => {
        out = h
        outs.set(spec.name, h)
        notifiers.set(spec.name, (msg) => h(`${JSON.stringify(msg)}\n`))
      },
      onClose: () => {},
      kill: () => {},
    }
  }
  /** 서버의 가장 오래된 tools/list 요청을 주어진 도구 이름들로 응답한다. */
  const resolveList = (server: string, toolNames: string[]): void => {
    const id = (pendingLists.get(server) ?? []).shift()
    if (id == null) throw new Error(`대기 중인 tools/list 가 없습니다: ${server}`)
    outs.get(server)!(`${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: toolNames.map((name) => ({ name })) } })}\n`)
  }
  const pendingListCount = (server: string): number => (pendingLists.get(server) ?? []).length
  return { spawn, notifiers, resolveList, pendingListCount }
}

/** 보류 중인 마이크로태스크를 모두 비운다(매크로태스크 경계). */
const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))

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

  it('dispose 는 진행 중 연결을 기다리기 전에 이미 연결된 자식을 먼저 닫는다', async () => {
    const { spawn, kills } = fakeSpawn(echoReply)
    let hold: ((d: 'approved') => void) | undefined
    // 'good' 은 즉시 승인, 'slow' 는 승인 보류로 setServers 를 멈춰 둔다.
    const gate = {
      request: (req: { target: string }) =>
        req.target.includes('slow')
          ? new Promise<'approved'>((res) => {
              hold = res
            })
          : Promise.resolve<'approved'>('approved'),
    }
    const host = createMcpHost({ spawn, gate })
    await host.setServers([{ name: 'good', command: 'good-cmd' }]) // good 연결
    const p = host.setServers([
      { name: 'good', command: 'good-cmd' },
      { name: 'slow', command: 'slow-cmd' },
    ]) // slow 가 gate 에서 멈춤
    await new Promise<void>((r) => setTimeout(r, 0))
    const d = host.dispose() // slow 미해결 상태에서 종료
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(kills).toContain('good') // queue(slow) 를 기다리지 않고 good 을 먼저 닫음
    hold?.('approved') // 정리: slow 승인 해제 → doSetServers 재개(disposed break) → queue resolve
    await Promise.all([p, d])
  })

  it('dispose 는 initialize 에서 멈춘(spawn 된) in-flight 자식도 닫고 즉시 반환한다', async () => {
    // 'slow' 는 initialize 응답을 보내지 않아 connect 가 멈춘다. entries 에 들어가기 전이라
    // in-flight 추적이 없으면 dispose 가 자식을 못 닫고 요청 타임아웃(30s)까지 매달린다.
    const kills: string[] = []
    const spawns: string[] = []
    const spawn: SpawnFn = (spec) => {
      spawns.push(spec.name)
      let out: (chunk: string) => void = () => {}
      let close: (err?: Error) => void = () => {}
      return {
        write: (line) => {
          const msg = JSON.parse(line) as { id?: number; method: string }
          if (msg.id == null) return
          if (spec.name === 'slow') return // 응답 없음 → initialize 가 매달림
          queueMicrotask(() => out(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: echoReply(spec, msg.method) })}\n`))
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
    const host = createMcpHost({ spawn })
    const p = host.setServers([{ name: 'slow', command: 'slow-cmd' }]) // initialize 에서 멈춤
    await new Promise<void>((r) => setTimeout(r, 0)) // connect 가 spawn→initialize 까지 진행하도록 양보
    expect(spawns).toEqual(['slow']) // spawn 은 됨(게이트 없음)
    await host.dispose() // 멈춘 in-flight 자식을 닫고 즉시 반환(30s 타임아웃 기다리지 않음)
    expect(kills).toContain('slow') // entries 에 없던 in-flight 자식도 종료
    await p // 정리: connect 가 close 로 reject → doSetServers catch → queue resolve
    expect(host.tools()).toHaveLength(0)
    expect(host.status()).toHaveLength(0)
  })

  it('서버가 tools/list_changed 를 보내면 도구 목록을 다시 가져와 노출을 갱신한다', async () => {
    let toolSet: { name: string }[] = [{ name: 'a' }]
    const { spawn, notifiers } = fakeSpawn((_spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') return { tools: toolSet }
      return {}
    })
    const audit = vi.fn()
    const host = createMcpHost({ spawn, onAudit: audit })
    await host.setServers([{ name: 'srv', command: 'x' }])
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__a'])
    // 서버가 런타임에 도구를 추가하고 변경 알림을 보낸다.
    toolSet = [{ name: 'a' }, { name: 'b' }]
    notifiers.get('srv')!(LIST_CHANGED)
    // 새로고침은 비동기(listTools 왕복)다 — 반영될 때까지 기다린다.
    await vi.waitFor(() => expect(host.tools()).toHaveLength(2))
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__a', 'mcp__srv__b'])
    expect(host.status()[0]).toMatchObject({ name: 'srv', connected: true, toolCount: 2 })
    expect(audit).toHaveBeenCalledWith('mcp.tools.changed', expect.objectContaining({ name: 'srv', toolCount: 2 }))
  })

  it('tools/list_changed 로 도구가 줄면 제거된 도구는 더 이상 노출하지 않는다', async () => {
    let toolSet: { name: string }[] = [{ name: 'a' }, { name: 'b' }]
    const { spawn, notifiers } = fakeSpawn((_spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') return { tools: toolSet }
      return {}
    })
    const host = createMcpHost({ spawn })
    await host.setServers([{ name: 'srv', command: 'x' }])
    expect(host.tools()).toHaveLength(2)
    toolSet = [{ name: 'a' }] // b 제거
    notifiers.get('srv')!(LIST_CHANGED)
    await vi.waitFor(() => expect(host.tools()).toHaveLength(1))
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__a'])
  })

  it('tools/list_changed 새로고침이 실패하면 기존 도구를 유지하고 감사한다', async () => {
    let failList = false
    const { spawn, notifiers } = fakeSpawn((_spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') {
        if (failList) throw new Error('list boom')
        return { tools: [{ name: 'a' }] }
      }
      return {}
    })
    const audit = vi.fn()
    const host = createMcpHost({ spawn, onAudit: audit })
    await host.setServers([{ name: 'srv', command: 'x' }])
    failList = true
    notifiers.get('srv')!(LIST_CHANGED)
    await vi.waitFor(() =>
      expect(audit).toHaveBeenCalledWith('mcp.tools.refresh_failed', expect.objectContaining({ name: 'srv' })),
    )
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__a']) // 기존 유지
    expect(audit).not.toHaveBeenCalledWith('mcp.tools.changed', expect.anything()) // 실패 경로는 changed 미방출
    expect(host.status()[0].toolCount).toBe(1) // 노출 수 불변
  })

  it('연속 tools/list_changed 를 직렬화한다 — 새로고침이 겹치지 않고 마지막 결과가 이긴다', async () => {
    const { spawn, notifiers, resolveList, pendingListCount } = deferredSpawn()
    const host = createMcpHost({ spawn })
    const setP = host.setServers([{ name: 'srv', command: 'x' }])
    await flush() // connect 가 initialize→tools/list 까지 진행하도록
    resolveList('srv', ['a']) // 초기 연결 tools/list 응답
    await setP
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__a'])

    // 알림 2개를 연달아 발사 — 2차는 1차 새로고침 뒤로 체이닝되어야 한다(직렬화).
    notifiers.get('srv')!(LIST_CHANGED)
    notifiers.get('srv')!(LIST_CHANGED)
    await flush()
    // 직렬화 증거: 1차 새로고침만 tools/list 를 보냈고 2차는 체인에서 대기 중이다(겹침 없음).
    expect(pendingListCount('srv')).toBe(1)

    resolveList('srv', ['a', 'b']) // 1차 새로고침 응답
    await flush()
    expect(pendingListCount('srv')).toBe(1) // 1차가 끝난 뒤에야 2차가 tools/list 를 보낸다

    resolveList('srv', ['a', 'b', 'c']) // 2차(마지막) 새로고침 응답 — 이게 최종 상태여야 한다
    await vi.waitFor(() => expect(host.tools()).toHaveLength(3))
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__srv__a', 'mcp__srv__b', 'mcp__srv__c'])
    expect(host.status()[0].toolCount).toBe(3)
  })

  it('tools/list_changed 가 서버 간 이름 충돌을 새로 만들면 진 서버 도구를 가린다', async () => {
    const tools: Record<string, { name: string }[]> = { 'foo.bar': [{ name: 'x' }], foo_bar: [{ name: 'y' }] }
    const { spawn, notifiers } = fakeSpawn((spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') return { tools: tools[spec.name] }
      if (method === 'tools/call') return { content: [{ type: 'text', text: `hi from ${spec.name}` }] }
      return {}
    })
    const audit = vi.fn()
    const host = createMcpHost({ spawn, onAudit: audit })
    // 두 서버명 모두 sanitize → 'foo_bar'. 먼저 등록(foo.bar)이 승자. 초기엔 도구가 겹치지 않는다.
    await host.setServers([
      { name: 'foo.bar', command: 'a' },
      { name: 'foo_bar', command: 'b' },
    ])
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__foo_bar__x', 'mcp__foo_bar__y'])
    expect(host.status().find((s) => s.name === 'foo_bar')?.toolCount).toBe(1)
    // 승자(foo.bar)가 'y' 를 추가 → 패자의 mcp__foo_bar__y 와 런타임 충돌. 승자가 가져간다.
    tools['foo.bar'] = [{ name: 'x' }, { name: 'y' }]
    notifiers.get('foo.bar')!(LIST_CHANGED)
    await vi.waitFor(() => expect(host.status().find((s) => s.name === 'foo_bar')?.toolCount).toBe(0))
    expect(host.tools().map((t) => t.definition.name)).toEqual(['mcp__foo_bar__x', 'mcp__foo_bar__y'])
    // 충돌한 y 는 승자(foo.bar)의 것이어야 한다 — 패자 도구는 가려진다.
    const y = host.tools().find((t) => t.definition.name === 'mcp__foo_bar__y')!
    expect(await y.execute({}, {})).toBe('hi from foo.bar')
    expect(audit).toHaveBeenCalledWith('mcp.tool.skipped', expect.objectContaining({ reason: 'duplicate name (cross-server)' }))
  })

  it('연결이 종료된 뒤 도착한 tools/list_changed 는 무시한다(죽은 서버 미새로고침)', async () => {
    let toolSet: { name: string }[] = [{ name: 'a' }]
    const { spawn, notifiers, closers } = fakeSpawn((_spec, method) => {
      if (method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: {} }
      if (method === 'tools/list') return { tools: toolSet }
      return {}
    })
    const host = createMcpHost({ spawn })
    await host.setServers([{ name: 'srv', command: 'x' }])
    closers.get('srv')!() // 자식 종료 → 도구 무효화
    expect(host.tools()).toHaveLength(0)
    toolSet = [{ name: 'a' }, { name: 'b' }]
    notifiers.get('srv')!(LIST_CHANGED) // 종료 후 늦게 도착
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(host.tools()).toHaveLength(0) // 죽은 서버는 새로고침하지 않는다
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

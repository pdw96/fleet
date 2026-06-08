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
  const spawn: SpawnFn = (spec) => {
    let out: (chunk: string) => void = () => {}
    let close: (err?: Error) => void = () => {}
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
  return { spawn, kills }
}

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
})

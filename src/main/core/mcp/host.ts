import type { McpServerSpec, McpServerStatus } from '../../../shared/types'
import type { FleetTool } from '../tools/types'
import { createMcpClient } from './client'
import { createStdioTransport, defaultSpawn } from './stdio'
import type { McpClient, McpHost, McpHostOptions } from './types'
import { wrapMcpTool } from './wrap'

interface Entry {
  spec: McpServerSpec
  /** 연결 성공 시에만 존재(실패 항목은 undefined). */
  client?: McpClient
  tools: FleetTool[]
  status: McpServerStatus
}

const NOOP_AUDIT = (): void => {}

/** 두 spec 이 같은 프로세스를 의미하는지(재연결 불필요 판단). */
function sameSpec(a: McpServerSpec, b: McpServerSpec): boolean {
  return (
    JSON.stringify([a.command, a.args ?? [], a.env ?? {}, a.cwd ?? '']) ===
    JSON.stringify([b.command, b.args ?? [], b.env ?? {}, b.cwd ?? ''])
  )
}

/** 다중 MCP 서버 연결을 관리하고 도구를 FleetTool 로 노출한다. setServers 에서 pre-warm 한다. */
export function createMcpHost(opts: McpHostOptions = {}): McpHost {
  const spawn = opts.spawn ?? defaultSpawn
  const audit = opts.onAudit ?? NOOP_AUDIT
  const entries = new Map<string, Entry>()

  /** 서버 1개에 연결(spawn→initialize→tools/list→도구 wrap). 실패 시 부분 연결을 정리하고 throw. */
  async function connect(spec: McpServerSpec): Promise<Entry> {
    const client = createMcpClient(createStdioTransport(spec, spawn), opts.clientOptions)
    try {
      await client.initialize()
      const infos = await client.listTools()
      const tools: FleetTool[] = []
      const names: string[] = []
      for (const info of infos) {
        const wrapped = wrapMcpTool(spec.name, info, client)
        if (wrapped) {
          tools.push(wrapped)
          names.push(wrapped.definition.name)
        } else {
          audit('mcp.tool.skipped', { server: spec.name, tool: info.name, reason: 'name too long' })
        }
      }
      return {
        spec,
        client,
        tools,
        status: { name: spec.name, connected: true, toolCount: tools.length, tools: names },
      }
    } catch (err) {
      client.close() // 부분 연결 정리
      throw err
    }
  }

  function statusList(): McpServerStatus[] {
    return [...entries.values()].map((e) => e.status)
  }

  return {
    async setServers(specs) {
      const seen = new Set<string>()
      for (const s of specs) {
        if (seen.has(s.name)) throw new Error(`MCP 서버 이름 충돌: '${s.name}'`)
        seen.add(s.name)
      }
      // 제거·변경·이전 실패 항목 정리(변경/실패는 재연결 대상).
      for (const [name, entry] of [...entries]) {
        const next = specs.find((s) => s.name === name)
        if (!next || !sameSpec(entry.spec, next) || !entry.status.connected) {
          entry.client?.close()
          entries.delete(name)
          if (!next) audit('mcp.server.disconnected', { name })
        }
      }
      // 추가·변경 서버 연결(미변경 연결은 유지).
      for (const spec of specs) {
        if (entries.has(spec.name)) continue
        try {
          const entry = await connect(spec)
          entries.set(spec.name, entry)
          audit('mcp.server.connected', { name: spec.name, toolCount: entry.tools.length })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          entries.set(spec.name, {
            spec,
            tools: [],
            status: { name: spec.name, connected: false, toolCount: 0, tools: [], error: message },
          })
          audit('mcp.server.failed', { name: spec.name, error: message })
        }
      }
      return statusList()
    },
    tools() {
      return [...entries.values()].flatMap((e) => e.tools)
    },
    status() {
      return statusList()
    },
    async dispose() {
      for (const [, e] of entries) e.client?.close()
      entries.clear()
    },
  }
}

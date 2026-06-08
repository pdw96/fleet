import type { McpServerSpec, McpServerStatus } from '../../../shared/types'
import type { FleetTool } from '../tools/types'
import { createMcpClient } from './client'
import { createStdioTransport, defaultSpawn } from './stdio'
import type { McpClient, McpHost, McpHostOptions } from './types'
import { wrapMcpTool } from './wrap'

interface Entry {
  spec: McpServerSpec
  /** 연결 성공 시에만 존재(실패·거부·종료 항목은 undefined). */
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

/**
 * 실행 명령줄 + 효과적 cwd/env(승인 표시·감사용). 사용자가 무엇이 실행되는지(다른 작업 디렉터리·
 * PATH/env 오버라이드 포함) 보고 승인하도록 cwd 와 env 키를 함께 노출한다. env 값은 비밀일 수
 * 있어 키만 보여준다.
 */
function commandLine(spec: McpServerSpec): string {
  let line = [spec.command, ...(spec.args ?? [])].join(' ')
  if (spec.cwd) line += ` (cwd: ${spec.cwd})`
  const envKeys = Object.keys(spec.env ?? {})
  if (envKeys.length > 0) line += ` (env: ${envKeys.join(', ')})`
  return line
}

/** 다중 MCP 서버 연결을 관리하고 도구를 FleetTool 로 노출한다. setServers 에서 pre-warm 한다. */
export function createMcpHost(opts: McpHostOptions = {}): McpHost {
  const spawn = opts.spawn ?? defaultSpawn
  const audit = opts.onAudit ?? NOOP_AUDIT
  const gate = opts.gate
  const entries = new Map<string, Entry>()
  // setServers 직렬화 큐 — 겹치는 호출이 entries 를 인터리브해 중복 spawn·stale 덮어쓰기를 내지 않게 한다.
  let queue: Promise<unknown> = Promise.resolve()
  // dispose 후 큐에 남은/진행 중 setServers 가 새 자식을 spawn 하지 않도록 막는 플래그.
  let disposed = false

  /**
   * 연결된 서버들의 노출 도구를 전역 유일로 재계산하고 status 를 갱신한다(서버 간 sanitize 충돌 표면화).
   * 먼저 등록된 서버가 이긴다. 진 도구는 레지스트리에 노출되지 않으므로 status 에서도 빼고 감사로
   * 표면화한다 — connected 인데 호출 불가한 도구를 silent 로 광고하지 않는다(#7). entry.tools 원본은
   * 보존하므로(승자 서버 제거/종료 시) 패자 도구가 다시 노출되며 status 도 함께 복원된다.
   */
  function recomputeExposure(): void {
    if (disposed) return
    const exposed = new Set<string>()
    for (const e of entries.values()) {
      if (!e.status.connected) continue
      const names: string[] = []
      for (const t of e.tools) {
        if (exposed.has(t.definition.name)) {
          audit('mcp.tool.skipped', { server: e.spec.name, tool: t.definition.name, reason: 'duplicate name (cross-server)' })
          continue
        }
        exposed.add(t.definition.name)
        names.push(t.definition.name)
      }
      e.status = { ...e.status, tools: names, toolCount: names.length }
    }
  }

  /** 서버 1개에 연결(spawn→initialize→tools/list→도구 wrap). 실패 시 부분 연결을 정리하고 throw. */
  async function connect(spec: McpServerSpec): Promise<Entry> {
    const client = createMcpClient(createStdioTransport(spec, spawn), opts.clientOptions)
    try {
      await client.initialize()
      const infos = await client.listTools()
      const tools: FleetTool[] = []
      const names: string[] = []
      const seen = new Set<string>()
      for (const info of infos) {
        const wrapped = wrapMcpTool(spec.name, info, client)
        if (!wrapped) {
          audit('mcp.tool.skipped', { server: spec.name, tool: info.name, reason: 'invalid name' })
          continue
        }
        // sanitize 후 같은 이름으로 붕괴하는 도구는 skip — 레지스트리 중복 throw(세션 전체 실패) 방지.
        if (seen.has(wrapped.definition.name)) {
          audit('mcp.tool.skipped', { server: spec.name, tool: info.name, reason: 'duplicate name' })
          continue
        }
        seen.add(wrapped.definition.name)
        tools.push(wrapped)
        names.push(wrapped.definition.name)
      }
      // entry 객체를 먼저 만들어 onClose 가 이를 직접 잡게 한다 — entries.set 이전에 자식이 죽는
      // startup 종료 레이스에서도, 저장될 바로 그 entry 가 disconnected 로 갱신된다(이벤트 유실 없음).
      // 재연결 후 옛 client 의 onClose 는 옛 entry 만 건드리므로 새 entry 를 오염시키지 않는다.
      const entry: Entry = {
        spec,
        client,
        tools,
        status: { name: spec.name, connected: true, toolCount: tools.length, tools: names },
      }
      // 연결 후 자식이 죽으면(idle 크래시·재설정 중 close) 죽은 도구를 계속 광고하지 않도록 무효화하고,
      // 서버 간 충돌로 가려졌던 다른 서버의 도구가 다시 노출되도록 status 를 재계산한다.
      client.onClose(() => {
        if (!entry.status.connected) return
        entry.tools = []
        entry.status = { name: spec.name, connected: false, toolCount: 0, tools: [], error: '서버 연결이 종료되었습니다.' }
        audit('mcp.server.disconnected', { name: spec.name, reason: 'exit' })
        recomputeExposure()
      })
      return entry
    } catch (err) {
      client.close() // 부분 연결 정리
      throw err
    }
  }

  function statusList(): McpServerStatus[] {
    return [...entries.values()].map((e) => e.status)
  }

  async function doSetServers(specs: McpServerSpec[]): Promise<McpServerStatus[]> {
    if (disposed) return statusList() // 종료된 호스트는 더 이상 연결하지 않는다
    const seen = new Set<string>()
    for (const s of specs) {
      if (seen.has(s.name)) throw new Error(`MCP 서버 이름 충돌: '${s.name}'`)
      seen.add(s.name)
    }
    // 제거·변경·이전 비연결(실패/거부/종료) 항목 정리(변경/비연결은 재연결 대상).
    for (const [name, entry] of [...entries]) {
      const next = specs.find((s) => s.name === name)
      if (!next || !sameSpec(entry.spec, next) || !entry.status.connected) {
        entry.client?.close()
        entries.delete(name)
        if (!next) audit('mcp.server.disconnected', { name })
      }
    }
    // 추가·변경 서버 연결(미변경 연결은 유지). 새 spawn 은 ApprovalGate(shell)를 통과해야 한다.
    for (const spec of specs) {
      if (entries.has(spec.name)) continue
      if (disposed) break // 승인/연결 대기 중 dispose 됐으면 더 이상 spawn 하지 않는다
      const cmd = commandLine(spec)
      // 안전 우선(AGENTS.md): 임의 로컬 프로세스 실행은 ApprovalGate 를 통과한다(destructive).
      if (gate) {
        const decision = await gate.request({
          kind: 'shell',
          summary: `MCP 서버 실행: ${spec.name}`,
          target: cmd,
          risk: 'destructive',
        })
        if (decision !== 'approved') {
          entries.set(spec.name, {
            spec,
            tools: [],
            status: { name: spec.name, connected: false, toolCount: 0, tools: [], error: '실행 승인이 거부되었습니다.' },
          })
          audit('mcp.server.rejected', { name: spec.name, command: cmd })
          continue
        }
      }
      if (disposed) break // 승인 대기 중 dispose 됐으면 spawn 하지 않는다
      try {
        const entry = await connect(spec)
        if (disposed) {
          entry.client?.close() // 연결 대기 중 dispose — 갓 spawn 한 자식을 정리하고 저장하지 않는다
          break
        }
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
    recomputeExposure() // 서버 간 이름 충돌 표면화(status 를 노출 기준으로 재계산)
    return statusList()
  }

  return {
    setServers(specs) {
      // 직렬화: 이전 setServers 가 끝난 뒤 실행한다(겹친 호출의 인터리브·중복 spawn 방지).
      const run = queue.then(() => doSetServers(specs))
      queue = run.catch(() => {}) // 다음 호출이 이전 실패/거부에 막히지 않게 큐는 항상 진행
      return run
    },
    tools() {
      // 서버 간 sanitize 충돌도 레지스트리에 닿기 전에 제거해 전역 유일을 보장한다(중복 throw 방지).
      const out: FleetTool[] = []
      const seen = new Set<string>()
      for (const e of entries.values()) {
        for (const t of e.tools) {
          if (seen.has(t.definition.name)) continue
          seen.add(t.definition.name)
          out.push(t)
        }
      }
      return out
    },
    status() {
      return statusList()
    },
    async dispose() {
      disposed = true
      // 진행 중/큐된 setServers 가 끝나길 기다린다 — 그래야 그 사이 spawn 된 자식까지 정리한다(좀비 방지).
      await queue.catch(() => {})
      for (const [, e] of entries) e.client?.close()
      entries.clear()
    },
  }
}

import type { FleetTool, ToolRegistry } from './types'

/** FleetTool 배열로 이름→도구 레지스트리를 만든다. 중복 이름은 충돌로 throw 한다. */
export function createToolRegistry(tools: FleetTool[]): ToolRegistry {
  const map = new Map<string, FleetTool>()
  for (const t of tools) {
    const name = t.definition.name
    if (map.has(name)) throw new Error(`도구 이름 충돌: '${name}' 이 중복 등록되었습니다.`)
    map.set(name, t)
  }
  return {
    list: () => [...map.values()].map((t) => t.definition),
    get: (name) => map.get(name),
    has: (name) => map.has(name),
  }
}

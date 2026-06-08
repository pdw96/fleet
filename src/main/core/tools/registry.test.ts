import { describe, expect, it } from 'vitest'
import { createToolRegistry } from './registry'
import type { FleetTool } from './types'

function tool(name: string): FleetTool {
  return {
    definition: { name, description: name, parameters: { type: 'object' } },
    classify: () => 'safe',
    async execute() {
      return name
    },
  }
}

describe('createToolRegistry', () => {
  it('lists definitions and resolves by name', () => {
    const reg = createToolRegistry([tool('a'), tool('b')])
    expect(reg.list().map((d) => d.name)).toEqual(['a', 'b'])
    expect(reg.get('a')?.definition.name).toBe('a')
    expect(reg.has('b')).toBe(true)
    expect(reg.get('zzz')).toBeUndefined()
    expect(reg.has('zzz')).toBe(false)
  })

  it('throws on duplicate tool name (silent override 금지)', () => {
    expect(() => createToolRegistry([tool('dup'), tool('dup')])).toThrow(/충돌|dup/)
  })
})

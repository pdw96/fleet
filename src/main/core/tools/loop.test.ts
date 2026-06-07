import { describe, expect, it, vi } from 'vitest'
import type { ApiProvider, ChatResult, ChatTurn, ToolResultBlock, ToolUseBlock } from '../providers/types'
import type { ApprovalGate } from '../safety/approval'
import { createToolRegistry } from './registry'
import { runToolLoop } from './loop'
import type { FleetTool } from './types'

const approveAll: ApprovalGate = { async request() { return 'approved' } }
const rejectAll: ApprovalGate = { async request() { return 'rejected' } }

const echoTool: FleetTool = {
  definition: { name: 'echo', description: 'e', parameters: { type: 'object' } },
  classify: () => 'safe',
  async execute(input) {
    return `echoed:${JSON.stringify(input)}`
  },
}

const toolUse = (id: string, name: string, input: unknown): ToolUseBlock => ({ type: 'tool_use', id, name, input })

/** 호출 순서대로 ChatResult 를 돌려주는 스크립트 provider(마지막 항목 고정). */
function scriptedProvider(script: ChatResult[]): { provider: ApiProvider; calls: ChatTurn[][] } {
  const calls: ChatTurn[][] = []
  let i = 0
  const provider: ApiProvider = {
    id: 'fake',
    provider: 'anthropic',
    model: 'm',
    async chat(messages) {
      calls.push(structuredClone(messages))
      return script[Math.min(i++, script.length - 1)]
    },
  }
  return { provider, calls }
}

const firstResult = (turns: ChatTurn[]): ToolResultBlock => (turns[2].content as ToolResultBlock[])[0]

describe('runToolLoop', () => {
  it('도구를 실행하고 tool_result 를 회신한 뒤 종료한다', async () => {
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', { a: 1 })], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    const audit = vi.fn()
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      onAudit: audit,
    })
    expect(out.text).toBe('완료')
    expect(calls[1].map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(firstResult(calls[1])).toMatchObject({
      type: 'tool_result',
      toolUseId: 't1',
      name: 'echo',
      content: 'echoed:{"a":1}',
    })
    expect(audit).toHaveBeenCalledWith('tool.executed', expect.objectContaining({ name: 'echo' }))
  })

  it('도구 호출이 없으면 첫 결과를 반환하고 turns 를 변경하지 않는다', async () => {
    const { provider } = scriptedProvider([{ text: '바로답', toolCalls: [], finishReason: 'stop' }])
    const turns: ChatTurn[] = [{ role: 'user', content: 'go' }]
    const out = await runToolLoop(provider, turns, {}, { registry: createToolRegistry([echoTool]), gate: approveAll })
    expect(out.text).toBe('바로답')
    expect(turns).toHaveLength(1)
  })

  it('최대 반복을 초과하면(여전히 tool_use) 에러를 던진다', async () => {
    const { provider } = scriptedProvider([{ text: '', toolCalls: [toolUse('t', 'echo', {})], finishReason: 'tool_use' }])
    await expect(
      runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
        registry: createToolRegistry([echoTool]),
        gate: approveAll,
        maxIterations: 3,
      }),
    ).rejects.toThrow(/최대 3회/)
  })

  it('도구 실행 오류는 isError tool_result 로 회신하고 루프는 계속된다', async () => {
    const boom: FleetTool = {
      definition: { name: 'boom', parameters: { type: 'object' } },
      classify: () => 'safe',
      async execute() {
        throw new Error('펑')
      },
    }
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'boom', {})], finishReason: 'tool_use' },
      { text: '수습', toolCalls: [], finishReason: 'stop' },
    ])
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([boom]),
      gate: approveAll,
    })
    expect(out.text).toBe('수습')
    expect(firstResult(calls[1])).toMatchObject({ isError: true, content: '펑' })
  })

  it('게이트가 거부하면 isError tool_result 로 회신한다', async () => {
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', {})], finishReason: 'tool_use' },
      { text: 'ok', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: rejectAll,
    })
    const r = firstResult(calls[1])
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/거부/)
  })

  it('미존재 도구는 게이트 없이 isError 로 회신한다', async () => {
    const gate = { request: vi.fn(async () => 'approved' as const) }
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'nope', {})], finishReason: 'tool_use' },
      { text: 'ok', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate,
    })
    expect(gate.request).not.toHaveBeenCalled()
    expect(firstResult(calls[1])).toMatchObject({ isError: true, name: 'nope' })
  })
})

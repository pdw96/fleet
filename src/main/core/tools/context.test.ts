import { describe, expect, it } from 'vitest'
import type { ChatTurn, ToolResultBlock } from '../providers/types'
import { approxTokens, DEFAULT_CONTEXT_POLICY, pruneToolResults, PRUNE_STUB } from './context'

const toolResult = (id: string, content: string): ToolResultBlock => ({ type: 'tool_result', toolUseId: id, content })

describe('approxTokens', () => {
  it('문자열·블록 content 의 대략 토큰(chars/4)을 합산한다', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'aaaaaaaa' }, // 8 chars
      { role: 'user', content: [toolResult('t1', 'bbbbbbbb')] }, // 8 chars
    ]
    expect(approxTokens(turns)).toBe(4) // ceil(16/4)
  })
})

describe('pruneToolResults', () => {
  const policy = { triggerInputTokens: 10, keepRecentToolUses: 1 }
  const big = 'x'.repeat(80) // 20 추정토큰

  it('추정 토큰이 임계 이하면 아무것도 바꾸지 않는다', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: [toolResult('t1', 'short')] }]
    pruneToolResults(turns, policy)
    expect((turns[0].content as ToolResultBlock[])[0].content).toBe('short')
  })

  it('임계 초과 시 오래된 tool_result 만 stub 치환하고 최근 keep 개는 보존한다', () => {
    const turns: ChatTurn[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'e', input: {} }] },
      { role: 'user', content: [toolResult('t1', big)] }, // 오래된 것 → 정리
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'e', input: {} }] },
      { role: 'user', content: [toolResult('t2', big)] }, // 최근(keep=1) → 보존
    ]
    pruneToolResults(turns, policy)
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB)
    expect((turns[3].content as ToolResultBlock[])[0].content).toBe(big)
  })

  it('text·thinking·tool_use 블록은 손대지 않고 블록 수·순서를 보존한다', () => {
    const turns: ChatTurn[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'S' } } },
          { type: 'tool_use', id: 't1', name: 'e', input: { a: 1 } },
        ],
      },
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    pruneToolResults(turns, policy)
    const a = turns[0].content as Array<{ type: string; providerMeta?: unknown }>
    expect(a.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    expect(a[0].providerMeta).toEqual({ anthropic: { signature: 'S' } })
  })

  it('isError 표식은 stub 치환 시 제거한다', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: big, isError: true }] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    pruneToolResults(turns, policy)
    expect((turns[0].content as ToolResultBlock[])[0].isError).toBeUndefined()
  })

  it('idempotent — 재호출해도 동일하다(이미 stub 은 건너뜀)', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    pruneToolResults(turns, policy)
    const after1 = JSON.stringify(turns)
    pruneToolResults(turns, policy)
    expect(JSON.stringify(turns)).toBe(after1)
  })

  it('DEFAULT_CONTEXT_POLICY 는 보수값(150k·keep 3)', () => {
    expect(DEFAULT_CONTEXT_POLICY).toEqual({ triggerInputTokens: 150_000, keepRecentToolUses: 3 })
  })
})

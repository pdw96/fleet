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

  /** 도구 라운드(assistant tool_use + user tool_result) 한 쌍을 turns 에 추가하는 헬퍼. */
  const pushRound = (turns: ChatTurn[], id: string, content = big): void => {
    turns.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'e', input: {} }] })
    turns.push({ role: 'user', content: [toolResult(id, content)] })
  }

  it('추정 토큰이 임계 이하면 아무것도 바꾸지 않는다', () => {
    const turns: ChatTurn[] = [{ role: 'user', content: [toolResult('t1', 'short')] }]
    pruneToolResults(turns, policy)
    expect((turns[0].content as ToolResultBlock[])[0].content).toBe('short')
  })

  it('임계 초과 시 이미 전송된 오래된 것만 정리하고 최근 keep + 미전송 최신 턴은 보존한다', () => {
    const turns: ChatTurn[] = []
    pushRound(turns, 't0') // 이미 전송된 오래된 것 → 정리(turns[1])
    pushRound(turns, 't1') // 이미 전송됨, keep=1 보존(turns[3])
    pushRound(turns, 't2') // 미전송 최신 tool_result 턴 → 보존(turns[5])
    pruneToolResults(turns, policy)
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB)
    expect((turns[3].content as ToolResultBlock[])[0].content).toBe(big)
    expect((turns[5].content as ToolResultBlock[])[0].content).toBe(big)
  })

  it('text·thinking·tool_use 블록은 손대지 않고 블록 수·순서를 보존한다', () => {
    const turns: ChatTurn[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'S' } } },
          { type: 'tool_use', id: 't0', name: 'e', input: { a: 1 } },
        ],
      },
      { role: 'user', content: [toolResult('t0', big)] }, // 정리 대상(오래된)
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] }, // 미전송 최신 → 보존
    ]
    pruneToolResults(turns, policy)
    const a = turns[0].content as Array<{ type: string; providerMeta?: unknown }>
    expect(a.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    expect(a[0].providerMeta).toEqual({ anthropic: { signature: 'S' } })
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // 정리는 발생
  })

  it('isError 표식은 stub 치환 시 제거한다', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: big, isError: true }] }, // 정리 대상
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] }, // 미전송 최신 → 보존
    ]
    pruneToolResults(turns, policy)
    expect((turns[0].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB)
    expect((turns[0].content as ToolResultBlock[])[0].isError).toBeUndefined()
  })

  it('idempotent — 재호출해도 동일하다(이미 stub 은 건너뜀)', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: [toolResult('t0', big)] },
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    pruneToolResults(turns, policy)
    const after1 = JSON.stringify(turns)
    pruneToolResults(turns, policy)
    expect(JSON.stringify(turns)).toBe(after1)
  })

  it('DEFAULT_CONTEXT_POLICY 는 보수값(100k·keep 3)', () => {
    expect(DEFAULT_CONTEXT_POLICY).toEqual({ triggerInputTokens: 100_000, keepRecentToolUses: 3 })
  })

  it('빈 turns 는 throw 없이 no-op 다', () => {
    const turns: ChatTurn[] = []
    expect(() => pruneToolResults(turns, policy)).not.toThrow()
    expect(turns).toEqual([])
  })

  it('전송된 결과가 keep 이하면 임계 초과라도 아무것도 정리하지 않는다', () => {
    // 결과 2개 중 마지막(미전송)은 제외 → 전송된 건 1개, keep=5 가 그것을 보존 → 정리 0.
    const turns: ChatTurn[] = [
      { role: 'user', content: [toolResult('t0', big)] },
      { role: 'user', content: [toolResult('t1', big)] },
    ]
    pruneToolResults(turns, { triggerInputTokens: 1, keepRecentToolUses: 5 })
    expect((turns[0].content as ToolResultBlock[])[0].content).toBe(big)
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(big)
  })

  it('keepRecentToolUses 0 이면 미전송 최신 턴을 제외한 전송된 결과를 모두 정리한다', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: [toolResult('t0', big)] }, // 정리
      { role: 'user', content: [toolResult('t1', big)] }, // 정리
      { role: 'user', content: [toolResult('t2', big)] }, // 미전송 최신 → 보존
    ]
    pruneToolResults(turns, { triggerInputTokens: 1, keepRecentToolUses: 0 })
    expect((turns[0].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB)
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB)
    expect((turns[2].content as ToolResultBlock[])[0].content).toBe(big)
  })

  it('string content turn 이 섞여도 안전하게 오래된 것만 정리한다', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'plain' },
      { role: 'user', content: [toolResult('t0', big)] }, // 정리
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: [toolResult('t1', big)] }, // keep=1 보존
      { role: 'user', content: [toolResult('t2', big)] }, // 미전송 최신 → 보존
    ]
    pruneToolResults(turns, policy)
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB)
    expect((turns[3].content as ToolResultBlock[])[0].content).toBe(big)
    expect((turns[4].content as ToolResultBlock[])[0].content).toBe(big)
  })

  it('임계 이하로 떨어지면 남은 prunable 은 더 정리하지 않는다(early-return)', () => {
    const huge = 'x'.repeat(400) // 100 추정토큰
    const turns: ChatTurn[] = [
      { role: 'user', content: [toolResult('t0', huge)] },
      { role: 'user', content: [toolResult('t1', huge)] },
      { role: 'user', content: [toolResult('t2', huge)] },
      { role: 'user', content: [toolResult('t3', huge)] }, // 미전송 최신 → 제외
    ]
    // 전송된 t0·t1·t2 중 keep=1 이 t2 보존 → prunable=[t0,t1]. t0 만 정리해도 임계 이하 → t1 보존(early-return).
    pruneToolResults(turns, { triggerInputTokens: 320, keepRecentToolUses: 1 })
    expect((turns[0].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // t0 정리
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(huge) // t1 early-return 보존
    expect((turns[2].content as ToolResultBlock[])[0].content).toBe(huge) // t2 keep 보존
    expect((turns[3].content as ToolResultBlock[])[0].content).toBe(huge) // t3 미전송 보존
  })

  // ── Codex 리뷰 반영 ──────────────────────────────────────────────────────────
  it('미전송 최신 tool_result 턴의 병렬 배치는 keep 초과여도 정리하지 않는다(Codex P2 — 명시 요청 출력 보존)', () => {
    const turns: ChatTurn[] = []
    for (const id of ['o0', 'o1', 'o2', 'o3', 'o4']) pushRound(turns, id) // 이미 전송된 5개
    // 직전 iter 의 미전송 병렬 배치: 한 어시스턴트 턴이 도구 3개 호출 → 한 user 턴에 결과 3개.
    const batch: ToolResultBlock[] = ['b0', 'b1', 'b2'].map((id) => toolResult(id, big))
    turns.push({ role: 'assistant', content: batch.map((b) => ({ type: 'tool_use', id: b.toolUseId, name: 'e', input: {} })) })
    turns.push({ role: 'user', content: batch })
    pruneToolResults(turns, { triggerInputTokens: 10, keepRecentToolUses: 3 })
    for (const r of batch) expect(r.content).toBe(big) // 미전송 배치 3개 전부 보존(keep=3 초과여도)
    expect((turns[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // 가장 오래된 것은 정리
  })

  it('정리는 공유된 history 블록을 변이하지 않는다(Codex P2 — copy-on-write, 미커밋 send 가 history 무손상)', () => {
    const sharedT0 = toolResult('t0', big)
    const history: ChatTurn[] = [
      { role: 'user', content: [sharedT0] },
      { role: 'user', content: [toolResult('t1', big)] },
      { role: 'user', content: [toolResult('t2', big)] },
    ]
    const working: ChatTurn[] = [...history, { role: 'user', content: 'go' }] // api-session 의 얕은 복사(블록 공유)
    pruneToolResults(working, policy)
    expect(sharedT0.content).toBe(big) // 공유 블록 원본 불변
    expect((history[0].content as ToolResultBlock[])[0].content).toBe(big) // history 턴 미변이
    expect((working[0].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // working 엔 stub 반영
    expect(working[0]).not.toBe(history[0]) // 턴이 클론됨
  })
})

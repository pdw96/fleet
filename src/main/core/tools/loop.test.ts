import { describe, expect, it, vi } from 'vitest'
import type { ToolStep } from '../../../shared/types'
import type { ApiCallOptions, ApiProvider, ChatResult, ChatTurn, ContentBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '../providers/types'
import type { ApprovalGate } from '../safety/approval'
import { createToolRegistry } from './registry'
import { runToolLoop } from './loop'
import type { FleetTool } from './types'
import { DEFAULT_CONTEXT_POLICY, PRUNE_STUB } from './context'

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

  it('finishReason 가 tool_use 라도 toolCalls 가 비면 종료한다', async () => {
    const { provider } = scriptedProvider([{ text: '빈툴', toolCalls: [], finishReason: 'tool_use' }])
    const turns: ChatTurn[] = [{ role: 'user', content: 'go' }]
    const out = await runToolLoop(provider, turns, {}, { registry: createToolRegistry([echoTool]), gate: approveAll })
    expect(out.text).toBe('빈툴')
    expect(turns).toHaveLength(1)
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

  it('finishReason 가 stop 이어도 toolCalls 가 있으면 실행한다(Gemini: functionCall + STOP)', async () => {
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [toolUse('lookup-0', 'echo', { q: 1 })], finishReason: 'stop' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(out.text).toBe('완료')
    expect(calls).toHaveLength(2) // 도구 실행 후 재호출
  })

  it('도구 단계를 running→ok 로 방출한다 (#10 SP3)', async () => {
    const steps: ToolStep[] = []
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', { path: 'a.txt' })], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], { onToolStep: (s) => steps.push({ ...s }) }, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(steps.map((s) => s.phase)).toEqual(['running', 'ok'])
    expect(steps[0]).toMatchObject({ id: 't1', name: 'echo', phase: 'running', risk: 'safe' })
    expect(steps[0].summary).toContain('a.txt')
    expect(steps[1]).toMatchObject({ id: 't1', name: 'echo', phase: 'ok' })
  })

  it('거부된 도구는 running 없이 error 단계만 방출한다 (#10 SP3)', async () => {
    const steps: ToolStep[] = []
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', {})], finishReason: 'tool_use' },
      { text: 'ok', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], { onToolStep: (s) => steps.push({ ...s }) }, {
      registry: createToolRegistry([echoTool]),
      gate: rejectAll,
    })
    expect(steps.map((s) => s.phase)).toEqual(['error'])
    expect(steps[0]).toMatchObject({ id: 't1', name: 'echo', phase: 'error' })
  })

  it('미존재 도구는 게이트 없이 error 단계를 방출한다 (#10 SP3)', async () => {
    const steps: ToolStep[] = []
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'nope', {})], finishReason: 'tool_use' },
      { text: 'ok', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], { onToolStep: (s) => steps.push({ ...s }) }, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(steps).toEqual([{ id: 't1', name: 'nope', phase: 'error', summary: expect.any(String) }])
  })

  it('도구 실행 throw 는 running→error 를 방출하고 오류 요지를 싣는다 (#10 SP3)', async () => {
    const boom: FleetTool = {
      definition: { name: 'boom', parameters: { type: 'object' } },
      classify: () => 'safe',
      async execute() {
        throw new Error('펑')
      },
    }
    const steps: ToolStep[] = []
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'boom', {})], finishReason: 'tool_use' },
      { text: 'x', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], { onToolStep: (s) => steps.push({ ...s }) }, {
      registry: createToolRegistry([boom]),
      gate: approveAll,
    })
    expect(steps.map((s) => s.phase)).toEqual(['running', 'error'])
    expect(steps[1].summary).toContain('펑')
  })

  it('빈 id 의 병렬 동일함수 호출은 루프 인덱스로 칩 stepId 를 구별한다 (#17-P2)', async () => {
    // Gemini 2.x 는 functionCall.id 가 없을 수 있다(빈 id). 같은 도구를 한 턴에 병렬 호출해도 라이브
    // 칩이 충돌하지 않도록 stepId 를 루프 인덱스로 구별한다. 단 회신 toolUseId 는 여전히 빈 id —
    // 합성 id 를 wire(functionResponse)로 보내지 않는다(2.x 거부 회피, #17-P2 설계).
    const steps: ToolStep[] = []
    const { provider, calls } = scriptedProvider([
      {
        text: '',
        toolCalls: [toolUse('', 'echo', { city: '서울' }), toolUse('', 'echo', { city: '부산' })],
        finishReason: 'stop',
      },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], { onToolStep: (s) => steps.push({ ...s }) }, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    // 순차 실행: call0 running→ok, call1 running→ok. 두 호출의 stepId 가 구별돼야 한다.
    expect(steps.map((s) => s.id)).toEqual(['echo-0', 'echo-0', 'echo-1', 'echo-1'])
    // wire 회신 id 는 빈 문자열 유지(합성 id 미전송).
    expect((calls[1][2].content as ToolResultBlock[]).map((r) => r.toolUseId)).toEqual(['', ''])
  })

  it('승인 요청에 도구 인자를 포함한다', async () => {
    const reqs: Array<{ summary: string; target: string }> = []
    const gate = { async request(r: { summary: string; target: string }) { reqs.push(r); return 'approved' as const } }
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', { path: 'a.txt' })], finishReason: 'tool_use' },
      { text: 'ok', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, { registry: createToolRegistry([echoTool]), gate })
    expect(reqs[0].summary).toContain('a.txt')
    expect(reqs[0].target).toContain('a.txt')
  })

  it('어시스턴트 재구성 시 ToolUseBlock.providerMeta 를 보존한다 (키스톤 seam 패스스루)', async () => {
    const meta = { google: { thoughtSignature: 'SIG' } }
    const call: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'echo', input: { a: 1 }, providerMeta: meta }
    const { provider, calls } = scriptedProvider([
      { text: '', toolCalls: [call], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    const assistant = calls[1][1] // [user, assistant, user]
    const block = (assistant.content as ContentBlock[]).find((b): b is ToolUseBlock => b.type === 'tool_use')!
    expect(block.providerMeta).toEqual(meta)
  })

  it('result.content 가 있으면 원본 순서(thinking→tool_use)로 어시스턴트 턴을 재구성한다 (키스톤 ordered)', async () => {
    const thinking: ThinkingBlock = { type: 'thinking', text: '사고', providerMeta: { anthropic: { signature: 'TS' } } }
    const call: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'echo', input: {} }
    const ordered: ContentBlock[] = [thinking, { type: 'text', text: '말' }, call]
    const { provider, calls } = scriptedProvider([
      { text: '말', toolCalls: [call], content: ordered, finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    const assistant = calls[1][1]
    expect((assistant.content as ContentBlock[]).map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect((assistant.content as ContentBlock[])[0]).toEqual(thinking) // 서명 보존
  })

  it('result.content 가 없으면 text+toolCalls 로 재구성한다(현행 동작 유지)', async () => {
    const call: ToolUseBlock = { type: 'tool_use', id: 't1', name: 'echo', input: {} }
    const { provider, calls } = scriptedProvider([
      { text: '말', toolCalls: [call], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    const assistant = calls[1][1]
    expect((assistant.content as ContentBlock[]).map((b) => b.type)).toEqual(['text', 'tool_use'])
  })

  // ── usage 누적 (usage-accounting) ────────────────────────────────────────────
  it('모든 iter 의 usage 를 합산해 반환한다 — 도구 왕복 비용 미집계 갭 해소', async () => {
    // 도구루프는 iter 마다 chat 을 호출하지만 기존엔 마지막 iter 의 usage 만 반환했다(이전 라운드
    // 비용 통째 누락). 모든 라운드의 input/output/cache 토큰을 합산해야 한다.
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', {})], finishReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 3 } },
    ])
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    // 두 라운드 합산. 어느 라운드에도 없는 cacheCreation 은 키 자체가 없어야 한다(전부 미설정→미설정).
    expect(out.usage).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 3 })
  })

  it('어느 iter 에도 usage 가 없으면 usage 는 undefined 다(무회귀)', async () => {
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', {})], finishReason: 'tool_use' },
      { text: '완료', toolCalls: [], finishReason: 'stop' },
    ])
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(out.usage).toBeUndefined()
  })

  it('도구 0(단발) 응답은 그 응답의 usage 를 그대로 반환한다', async () => {
    const { provider } = scriptedProvider([
      { text: '바로답', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2 } },
    ])
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(out.usage).toEqual({ inputTokens: 4, outputTokens: 2 })
  })

  it('일부 iter 에만 usage 가 있어도 있는 값만 누적한다', async () => {
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t1', 'echo', {})], finishReason: 'tool_use' }, // usage 없음
      { text: '완료', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 1 } },
    ])
    const out = await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(out.usage).toEqual({ inputTokens: 9, outputTokens: 1 })
  })

  it('최대 반복 초과로 throw 할 때도 누적 usage 를 에러에 실어 surface 한다 (가장 비싼 경로 미집계 방지)', async () => {
    // 도구 루프가 max 라운드를 소진하고도 여전히 도구 호출을 요청하면 throw 한다. 그때까지 소비한
    // 토큰(최대 max 라운드 = 가장 비싼 경로)을 버리면 안 된다 — 에러에 누적 usage 를 실어 호출자가
    // unwrap-throw 와 동일하게 집계할 수 있게 한다.
    const { provider } = scriptedProvider([
      { text: '', toolCalls: [toolUse('t', 'echo', {})], finishReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2 } },
    ])
    await expect(
      runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
        registry: createToolRegistry([echoTool]),
        gate: approveAll,
        maxIterations: 3,
      }),
    ).rejects.toMatchObject({ usage: { inputTokens: 15, outputTokens: 6 } }) // 3 라운드 합산
  })

  // ── context management 라우팅 ──────────────────────────────────────────────
  /** turns 와 chat opts 를 모두 캡처하고 nativeContextManagement 플래그를 설정 가능한 provider. */
  function capturingProvider(native: boolean, script: ChatResult[]): {
    provider: ApiProvider
    opts: ApiCallOptions[]
    turns: ChatTurn[][]
  } {
    const opts: ApiCallOptions[] = []
    const turns: ChatTurn[][] = []
    let i = 0
    const provider: ApiProvider = {
      id: 'fake',
      provider: 'anthropic',
      model: 'm',
      nativeContextManagement: native ? true : undefined,
      async chat(messages, o = {}) {
        turns.push(structuredClone(messages))
        opts.push(o)
        return script[Math.min(i++, script.length - 1)]
      },
    }
    return { provider, opts, turns }
  }

  it('native provider 에는 contextManagement 를 opts 로 싣고 turns 를 prune 하지 않는다', async () => {
    const big = 'x'.repeat(4000)
    // 결과 3개(t0 전송·t1 전송·t2 미전송 최신). client 경로라면 t0 가 stub 될 조건이다(keep=1·전송된 2개·임계초과).
    const start: ChatTurn[] = [
      { role: 'assistant', content: [toolUse('t0', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: big }] },
      { role: 'assistant', content: [toolUse('t1', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: big }] },
      { role: 'assistant', content: [toolUse('t2', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: big }] },
      { role: 'user', content: 'go' },
    ]
    const { provider, opts } = capturingProvider(true, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    await runToolLoop(provider, start, {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: { triggerInputTokens: 100, keepRecentToolUses: 1 },
    })
    expect(opts[0].contextManagement).toEqual({ triggerInputTokens: 100, keepRecentToolUses: 1 })
    // native 는 서버가 클리어하므로 client-side prune 을 하지 않는다 — t0 를 그대로 둔다(회귀 가드).
    expect((start[1].content as ToolResultBlock[])[0].content).toBe(big)
  })

  it('native 미지원 provider: contextManagement 미전달 + 임계 초과 시 전송된 오래된 tool_result stub', async () => {
    const big = 'x'.repeat(4000)
    const { provider, opts, turns } = capturingProvider(false, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    // 새 send 시작(마지막 턴='go' 프롬프트): 직전 tool_result 3개는 모두 이미 전송됨 → keep=1 이 최신 t2 만
    // 보존하고 t0·t1 은 정리. (마지막 턴이 tool_result 가 아니므로 fresh-배치 제외가 적용되지 않는다 — P2#A.)
    const start: ChatTurn[] = [
      { role: 'assistant', content: [toolUse('t0', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: big }] },
      { role: 'assistant', content: [toolUse('t1', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: big }] },
      { role: 'assistant', content: [toolUse('t2', 'echo', {})] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: big }] },
      { role: 'user', content: 'go' },
    ]
    await runToolLoop(provider, start, {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: { triggerInputTokens: 100, keepRecentToolUses: 1 },
    })
    expect(opts[0].contextManagement).toBeUndefined()
    const captured = turns[0]
    expect((captured[1].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // 오래된 t0 정리
    expect((captured[3].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // t1 도 전송됨 → 정리
    expect((captured[5].content as ToolResultBlock[])[0].content).toBe(big) // 최신 t2 keep 보존
  })

  it('contextPolicy: null 이면 native 위임도 client-side prune 도 하지 않는다', async () => {
    const big = 'x'.repeat(4000)
    const { provider: nativeP, opts: nativeOpts } = capturingProvider(true, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    await runToolLoop(nativeP, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: null,
    })
    expect(nativeOpts[0].contextManagement).toBeUndefined()

    const { provider: clientP, turns } = capturingProvider(false, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    const start: ChatTurn[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: big }] },
      { role: 'user', content: 'go' },
    ]
    await runToolLoop(clientP, start, {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: null,
    })
    expect((turns[0][0].content as ToolResultBlock[])[0].content).toBe(big) // prune 안 함
  })

  it('contextPolicy 미지정이면 DEFAULT_CONTEXT_POLICY 를 native opts 로 싣는다', async () => {
    const { provider, opts } = capturingProvider(true, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    await runToolLoop(provider, [{ role: 'user', content: 'go' }], {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
    })
    expect(opts[0].contextManagement).toEqual(DEFAULT_CONTEXT_POLICY)
  })

  it('native: 미전송 fresh 배치가 keep 초과면 keep 을 fresh+policy.keep 으로 올린다(Codex P2 — client 패리티)', async () => {
    // 직전 iter 가 병렬 도구 5개 결과를 한 user 턴(마지막 턴)에 push 한 상황. keep=2.
    const big = 'x'.repeat(4000)
    const ids = ['b0', 'b1', 'b2', 'b3', 'b4']
    const start: ChatTurn[] = [
      { role: 'assistant', content: ids.map((id) => toolUse(id, 'echo', {})) },
      { role: 'user', content: ids.map((id) => ({ type: 'tool_result', toolUseId: id, content: big }) as ToolResultBlock) },
    ]
    const { provider, opts } = capturingProvider(true, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    await runToolLoop(provider, start, {}, {
      registry: createToolRegistry([echoTool]),
      gate: approveAll,
      contextPolicy: { triggerInputTokens: 100, keepRecentToolUses: 2 },
    })
    // client 는 fresh 배치(5) + 직전 keep(2) 을 보존 → native 도 keep=fresh+keep=7 로 상향(패리티).
    expect(opts[0].contextManagement).toEqual({ triggerInputTokens: 100, keepRecentToolUses: 7 })
  })

  it('native 미지원: 큰 도구 정의도 prune 예산에 포함한다 — turns 만으론 임계 이하라도 prune(Codex P2)', async () => {
    const bigTool: FleetTool = {
      definition: { name: 'big', description: 'x'.repeat(8000), parameters: { type: 'object' } },
      classify: () => 'safe',
      async execute() {
        return 'ok'
      },
    }
    const mid = 'x'.repeat(400) // 각 ~100 추정토큰
    const start: ChatTurn[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't0', content: mid }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: mid }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: mid }] },
      { role: 'user', content: 'go' },
    ]
    const { provider, turns } = capturingProvider(false, [{ text: 'ok', toolCalls: [], finishReason: 'stop' }])
    // turns 만 추정 ~300 ≤ 600. bigTool 정의(~8000자 → ~2000 토큰)가 예산에 포함 → 600 초과 → prune 발화.
    await runToolLoop(provider, start, {}, {
      registry: createToolRegistry([bigTool]),
      gate: approveAll,
      contextPolicy: { triggerInputTokens: 600, keepRecentToolUses: 1 },
    })
    expect((turns[0][0].content as ToolResultBlock[])[0].content).toBe(PRUNE_STUB) // 도구 예산 포함으로 정리됨
  })
})

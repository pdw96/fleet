import { describe, expect, it, vi } from 'vitest'
import type { CliAdapter, LlmDescriptor } from '../../../shared/types'
import type { CommandRunner } from '../cli/detect'
import type { ApiCallOptions, ApiProvider, ChatTurn, TokenUsage } from '../providers/types'
import { createToolRegistry } from '../tools/registry'
import { createApiSession } from './api-session'
import { buildHeadlessArgs, createCliSession } from './cli-session'
import { createSessionManager } from './manager'
import type { LlmSession } from './types'

const apiDesc: LlmDescriptor = { id: 'gpt', kind: 'api', displayName: 'GPT', ref: 'cfg-1', model: 'gpt-4o' }
const cliDesc: LlmDescriptor = { id: 'claude', kind: 'cli', displayName: 'Claude', ref: 'claude', model: '' }
const claudeAdapter: CliAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  versionArgs: ['--version'],
  headless: { args: ['-p', '{prompt}'] },
}

function fakeProvider(): { provider: ApiProvider; seen: ChatTurn[][] } {
  const seen: ChatTurn[][] = []
  const provider: ApiProvider = {
    id: 'fake',
    provider: 'anthropic',
    model: 'm',
    async chat(messages) {
      seen.push(structuredClone(messages))
      const last = messages.at(-1)?.content ?? ''
      const text = typeof last === 'string' ? last : ''
      return { text: `echo:${text}`, toolCalls: [], finishReason: 'stop' }
    },
  }
  return { provider, seen }
}

describe('createApiSession', () => {
  it('accumulates multi-turn history (system + user/assistant)', async () => {
    const { provider, seen } = fakeProvider()
    const s = createApiSession(apiDesc, provider, { system: 'sys' })

    expect(await s.send('hi')).toBe('echo:hi')
    expect(await s.send('again')).toBe('echo:again')

    // 두 번째 호출 시 누적된 히스토리
    expect(seen[1].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(seen[1][0].content).toBe('sys')
    expect(seen[1][2].content).toBe('echo:hi')
  })

  it('invokes onChunk with the reply (비스트리밍: 최종 1회)', async () => {
    const { provider } = fakeProvider()
    const s = createApiSession(apiDesc, provider)
    let chunk = ''
    await s.send('x', { onChunk: (c) => (chunk = c) })
    expect(chunk).toBe('echo:x')
  })

  it('스트리밍 provider 는 onChunk 로 토큰 델타를 흘리고 끝에서 중복 방출하지 않는다(#6)', async () => {
    const provider: ApiProvider = {
      id: 's',
      provider: 'openai',
      model: 'm',
      async chat(_messages, callOpts) {
        callOpts?.onToken?.('가')
        callOpts?.onToken?.('나')
        return { text: '가나', toolCalls: [], finishReason: 'stop' }
      },
    }
    const s = createApiSession(apiDesc, provider)
    const chunks: string[] = []
    const reply = await s.send('x', { onChunk: (c) => chunks.push(c) })
    expect(chunks).toEqual(['가', '나']) // 델타만 — 최종 텍스트 중복 방출 없음
    expect(reply).toBe('가나')
  })

  it('차단된 응답(빈 텍스트 + content_filter)은 조용히 흡수하지 않고 에러로 표면화한다(#7)', async () => {
    const provider: ApiProvider = {
      id: 'blocked',
      provider: 'google',
      model: 'm',
      async chat() {
        return { text: '', toolCalls: [], finishReason: 'content_filter', rawFinishReason: 'SAFETY' }
      },
    }
    const s = createApiSession(apiDesc, provider)
    await expect(s.send('위험한 질문')).rejects.toThrow(/안전 필터|content_filter|SAFETY/)
  })

  it('잘린 응답(빈 텍스트 + length)은 조용히 흡수하지 않고 에러로 표면화한다(#7)', async () => {
    const provider: ApiProvider = {
      id: 'truncated',
      provider: 'anthropic',
      model: 'm',
      async chat() {
        return { text: '', toolCalls: [], finishReason: 'length', rawFinishReason: 'max_tokens' }
      },
    }
    const s = createApiSession(apiDesc, provider)
    await expect(s.send('아주 긴 답변 요청')).rejects.toThrow(/잘렸|truncat|length|max_tokens|토큰/)
  })

  it('부분 텍스트가 있는 length 응답은 그대로 반환한다(정상 긴 답변 보호)', async () => {
    const provider: ApiProvider = {
      id: 'partial',
      provider: 'anthropic',
      model: 'm',
      async chat() {
        return { text: '부분 답변', toolCalls: [], finishReason: 'length', rawFinishReason: 'max_tokens' }
      },
    }
    const s = createApiSession(apiDesc, provider)
    expect(await s.send('x')).toBe('부분 답변')
  })

  it('toolDeps 가 있으면 도구 루프로 처리해 최종 텍스트를 반환한다', async () => {
    let n = 0
    const provider: ApiProvider = {
      id: 'fake',
      provider: 'anthropic',
      model: 'm',
      async chat() {
        return n++ === 0
          ? { text: '', toolCalls: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }], finishReason: 'tool_use' }
          : { text: '최종', toolCalls: [], finishReason: 'stop' }
      },
    }
    const registry = createToolRegistry([
      { definition: { name: 'echo', parameters: { type: 'object' } }, classify: () => 'safe', async execute() { return 'r' } },
    ])
    const gate = { async request() { return 'approved' as const } }
    const s = createApiSession(apiDesc, provider, { toolDeps: () => ({ registry, gate }) })
    expect(await s.send('go')).toBe('최종')
  })

  it('send 의 onToolStep 이 도구 루프까지 전달돼 도구 단계를 흘린다 (#10 SP3)', async () => {
    let n = 0
    const provider: ApiProvider = {
      id: 'fake',
      provider: 'anthropic',
      model: 'm',
      async chat() {
        return n++ === 0
          ? { text: '', toolCalls: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }], finishReason: 'tool_use' }
          : { text: '최종', toolCalls: [], finishReason: 'stop' }
      },
    }
    const registry = createToolRegistry([
      { definition: { name: 'echo', parameters: { type: 'object' } }, classify: () => 'safe', async execute() { return 'r' } },
    ])
    const gate = { async request() { return 'approved' as const } }
    const s = createApiSession(apiDesc, provider, { toolDeps: () => ({ registry, gate }) })
    const steps: string[] = []
    await s.send('go', { onToolStep: (st) => steps.push(`${st.name}:${st.phase}`) })
    expect(steps).toEqual(['echo:running', 'echo:ok'])
  })

  it('fresh + toolDeps: 도구 루프가 누적 history 를 오염시키지 않는다', async () => {
    const seen: ChatTurn[][] = []
    let n = 0
    const provider: ApiProvider = {
      id: 'fake',
      provider: 'anthropic',
      model: 'm',
      async chat(messages) {
        seen.push(structuredClone(messages))
        return n++ === 0
          ? { text: '', toolCalls: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }], finishReason: 'tool_use' }
          : { text: 'ok', toolCalls: [], finishReason: 'stop' }
      },
    }
    const registry = createToolRegistry([
      { definition: { name: 'echo', parameters: { type: 'object' } }, classify: () => 'safe', async execute() { return 'r' } },
    ])
    const gate = { async request() { return 'approved' as const } }
    const s = createApiSession(apiDesc, provider, { toolDeps: () => ({ registry, gate }) })
    await s.send('독립질문', { fresh: true }) // 도구 왕복(2회 chat) — history 미오염이어야 함
    await s.send('다음') // 누적 경로: fresh 질문/도구 턴 없이 '다음'만 보여야 한다
    expect(seen.at(-1)!.map((m) => m.content)).toEqual(['다음'])
  })

  it('send 의 responseSchema 를 provider 로 전달한다(구조화 출력)', async () => {
    let seenOpts: ApiCallOptions | undefined
    const provider: ApiProvider = {
      id: 'fake', provider: 'anthropic', model: 'm',
      async chat(_messages, opts) {
        seenOpts = opts
        return { text: '{}', toolCalls: [], finishReason: 'stop' }
      },
    }
    const s = createApiSession(apiDesc, provider)
    const schema = { type: 'object', additionalProperties: false, properties: {} }
    await s.send('x', { responseSchema: { name: 'v', schema } })
    expect(seenOpts?.responseSchema).toEqual({ name: 'v', schema })
  })

  it('bypassTools 면 tool loop 를 건너뛰고 도구 없이 단발 chat 한다(분석 호출용)', async () => {
    let seenTools: unknown = 'UNSET'
    const provider: ApiProvider = {
      id: 'fake', provider: 'anthropic', model: 'm',
      async chat(_messages, opts) {
        seenTools = opts?.tools
        return { text: 'ok', toolCalls: [], finishReason: 'stop' }
      },
    }
    const registry = createToolRegistry([
      { definition: { name: 'echo', parameters: { type: 'object' } }, classify: () => 'safe', async execute() { return 'r' } },
    ])
    const gate = { async request() { return 'approved' as const } }
    const s = createApiSession(apiDesc, provider, { toolDeps: () => ({ registry, gate }) })
    expect(await s.send('go', { bypassTools: true })).toBe('ok')
    expect(seenTools).toBeUndefined() // 루프 우회 → tools 미부착
  })

  it('toolDeps 가 undefined 를 반환하면(워크스페이스 없음) 단발 chat 으로 동작한다(회귀)', async () => {
    const { provider } = fakeProvider()
    const s = createApiSession(apiDesc, provider, { toolDeps: () => undefined })
    expect(await s.send('hi')).toBe('echo:hi')
  })

  it('동시 비-fresh send 를 직렬화해 history 를 잃지 않는다', async () => {
    const { provider, seen } = fakeProvider()
    const s = createApiSession(apiDesc, provider)
    // 같은 세션에 두 send 동시 진입 — 직렬화 없으면 늦게 끝난 쪽이 상대 턴을 덮어쓴다.
    await Promise.all([s.send('A'), s.send('B')])
    await s.send('C') // 세 번째 호출이 보는 history 에 A·B 왕복이 모두 남아야 함
    expect(seen.at(-1)!.map((m) => m.content)).toEqual(['A', 'echo:A', 'B', 'echo:B', 'C'])
  })

  it('fresh: 누적 history 를 참조하지도 변경하지도 않는다(오케스트레이터 독립 호출)', async () => {
    const { provider, seen } = fakeProvider()
    const s = createApiSession(apiDesc, provider, { system: 'sys' })
    await s.send('hi') // history 누적
    await s.send('독립', { fresh: true }) // 독립: system + 이 prompt 만
    await s.send('next') // 독립은 history 에 안 남음

    expect(seen[1].map((m) => m.content)).toEqual(['sys', '독립'])
    expect(seen[2].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(seen[2].map((m) => m.content)).toEqual(['sys', 'hi', 'echo:hi', 'next'])
  })

  // ── usage sink (usage-accounting) ────────────────────────────────────────────
  const usageProvider = (usage: TokenUsage | undefined, finishReason: 'stop' | 'length' = 'stop'): ApiProvider => ({
    id: 'u', provider: 'anthropic', model: 'm',
    async chat() {
      return { text: finishReason === 'length' ? '' : 'ok', toolCalls: [], finishReason, rawFinishReason: 'x', usage }
    },
  })

  it('성공 send 의 응답 usage 를 onUsage sink 로 전달한다', async () => {
    const usages: TokenUsage[] = []
    const s = createApiSession(apiDesc, usageProvider({ inputTokens: 12, outputTokens: 8 }), { onUsage: (u) => usages.push(u) })
    expect(await s.send('hi')).toBe('ok')
    expect(usages).toEqual([{ inputTokens: 12, outputTokens: 8 }])
  })

  it('onUsage 는 fresh(독립) 경로에서도 발화한다', async () => {
    const usages: TokenUsage[] = []
    const s = createApiSession(apiDesc, usageProvider({ inputTokens: 3, outputTokens: 1 }), { onUsage: (u) => usages.push(u) })
    await s.send('독립', { fresh: true })
    expect(usages).toEqual([{ inputTokens: 3, outputTokens: 1 }])
  })

  it('onUsage 는 unwrap 이 throw 하는 빈 응답(토큰 한도)에도 발화한다 — 소비 토큰은 집계해야 한다', async () => {
    const usages: TokenUsage[] = []
    const s = createApiSession(apiDesc, usageProvider({ inputTokens: 50, outputTokens: 0 }, 'length'), { onUsage: (u) => usages.push(u) })
    await expect(s.send('x')).rejects.toThrow(/토큰|length|max_tokens|잘/)
    expect(usages).toEqual([{ inputTokens: 50, outputTokens: 0 }])
  })

  it('응답에 usage 가 없으면 onUsage 를 호출하지 않는다', async () => {
    const usages: TokenUsage[] = []
    const s = createApiSession(apiDesc, usageProvider(undefined), { onUsage: (u) => usages.push(u) })
    await s.send('hi')
    expect(usages).toEqual([])
  })

  it('onUsage 미지정이어도 정상 동작하고 string 을 반환한다(계약 무회귀)', async () => {
    const s = createApiSession(apiDesc, usageProvider({ inputTokens: 1, outputTokens: 1 }))
    expect(await s.send('hi')).toBe('ok')
  })

  it('토큰 데이터가 없는 usage 객체(필드 전부 undefined)는 onUsage 를 호출하지 않는다', async () => {
    // provider buffer 경로는 API 가 usage 를 안 줘도 빈 객체({inputTokens:undefined,…})를 만든다.
    // 존재 검사(if result.usage)만 하면 내용 없는 'usage' 이벤트가 매 send 마다 새므로, 실 데이터가
    // 하나라도 있을 때만 발화해야 한다('usage 없으면 미발화' 계약).
    const usages: TokenUsage[] = []
    const s = createApiSession(apiDesc, usageProvider({}), { onUsage: (u) => usages.push(u) })
    await s.send('hi')
    expect(usages).toEqual([])
  })

  it('onUsage 가 도구 루프 최대 반복 초과 throw 에서도 누적 usage 를 발화한다(가장 비싼 경로 집계)', async () => {
    const provider: ApiProvider = {
      id: 'u', provider: 'anthropic', model: 'm',
      async chat() {
        return { text: '', toolCalls: [{ type: 'tool_use', id: 't', name: 'echo', input: {} }], finishReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 2 } }
      },
    }
    const registry = createToolRegistry([
      { definition: { name: 'echo', parameters: { type: 'object' } }, classify: () => 'safe', async execute() { return 'r' } },
    ])
    const gate = { async request() { return 'approved' as const } }
    const usages: TokenUsage[] = []
    const s = createApiSession(apiDesc, provider, { toolDeps: () => ({ registry, gate, maxIterations: 2 }), onUsage: (u) => usages.push(u) })
    await expect(s.send('go')).rejects.toThrow(/최대/)
    expect(usages).toEqual([{ inputTokens: 10, outputTokens: 4 }]) // 2 라운드 합산
  })

  it('throw 하는 onUsage sink 은 성공 send 의 반환·history 커밋을 깨지 않는다(부수채널 격리)', async () => {
    // usage 를 채우고 본 메시지를 기록하는 provider.
    const seen: ChatTurn[][] = []
    const provider: ApiProvider = {
      id: 'u', provider: 'anthropic', model: 'm',
      async chat(messages) {
        seen.push(structuredClone(messages))
        const last = messages.at(-1)?.content ?? ''
        const text = typeof last === 'string' ? last : ''
        return { text: `echo:${text}`, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }
    const s = createApiSession(apiDesc, provider, { onUsage: () => { throw new Error('sink boom') } })
    expect(await s.send('A')).toBe('echo:A') // sink throw 가 성공 send 를 거부시키지 않음
    expect(await s.send('B')).toBe('echo:B')
    // 둘째 send 가 첫 교환을 history 로 본다 → 커밋이 깨지지 않았다.
    expect(seen[1].map((m) => m.content)).toEqual(['A', 'echo:A', 'B'])
  })
})

describe('buildHeadlessArgs', () => {
  it('substitutes {prompt}', () => {
    expect(buildHeadlessArgs(claudeAdapter, '질문')).toEqual(['-p', '질문'])
  })
  it('defaults to the bare prompt when no headless template', () => {
    expect(
      buildHeadlessArgs({ id: 'x', displayName: 'X', command: 'x', versionArgs: [] }, 'hello'),
    ).toEqual(['hello'])
  })
})

describe('createCliSession', () => {
  it('runs headless invocation and returns trimmed stdout', async () => {
    let captured: string[] = []
    const runner: CommandRunner = async (_cmd, args) => {
      captured = args
      return { code: 0, stdout: '응답입니다\n', stderr: '' }
    }
    const s = createCliSession(cliDesc, claudeAdapter, runner)
    expect(await s.send('질문')).toBe('응답입니다')
    expect(captured).toEqual(['-p', '질문'])
  })

  // 회귀(gemini 침묵 버그): promptVia='stdin' 어댑터는 프롬프트를 argv 가 아닌 자식 stdin 으로 보낸다.
  it("promptVia='stdin' 어댑터는 프롬프트를 argv 가 아닌 stdin 으로 보낸다", async () => {
    let captured: string[] = []
    let stdinSeen: string | undefined
    const runner: CommandRunner = async (_cmd, args, opts) => {
      captured = args
      stdinSeen = opts.stdinInput
      return { code: 0, stdout: '응답\n', stderr: '' }
    }
    const stdinAdapter: CliAdapter = {
      id: 'gemini', displayName: 'Gemini', command: 'gemini', versionArgs: ['--version'],
      promptVia: 'stdin',
      headless: { args: ['-p', ''] },
    }
    const s = createCliSession(cliDesc, stdinAdapter, runner)
    expect(await s.send('아주 긴 질문')).toBe('응답')
    expect(captured).toEqual(['-p', '']) // 프롬프트가 argv 에 없다(헤드리스 트리거만)
    expect(stdinSeen).toBe('아주 긴 질문') // 프롬프트는 stdin 으로
  })

  // 하위호환: promptVia 미지정(arg 모드)은 stdin 으로 프롬프트를 보내지 않는다(기존 동작 보존).
  it('promptVia 미지정(arg 모드)은 stdinInput 을 넘기지 않는다', async () => {
    let stdinSeen: string | undefined = 'SENTINEL'
    const runner: CommandRunner = async (_c, _args, opts) => {
      stdinSeen = opts.stdinInput
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const s = createCliSession(cliDesc, claudeAdapter, runner) // claudeAdapter: promptVia 미지정
    await s.send('질문')
    expect(stdinSeen).toBeUndefined()
  })

  // 회귀: promptVia='stdin' + stateful — 세션 인자엔 프롬프트가 없고 stdin 으로 전달된다(채팅 경로).
  it("promptVia='stdin' stateful 세션은 프롬프트를 stdin 으로, 세션 인자엔 두지 않는다", async () => {
    const calls: { args: string[]; stdin?: string }[] = []
    const runner: CommandRunner = async (_c, args, opts) => {
      calls.push({ args, stdin: opts.stdinInput })
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      id: 'gemini', displayName: 'Gemini', command: 'gemini', versionArgs: ['--version'],
      promptVia: 'stdin',
      headless: { args: ['-p', ''] },
      session: {
        startArgs: ['-p', '', '--session-id', '{sessionId}'],
        resumeArgs: ['-p', '', '--resume', '{sessionId}'],
        idSource: 'preassigned',
      },
    }
    const s = createCliSession(cliDesc, adapter, runner, undefined, { stateful: true })
    await s.send('첫 질문')
    await s.send('둘째 질문')
    const id = calls[0].args[3]
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0].args).toEqual(['-p', '', '--session-id', id]) // 프롬프트 토큰 없음
    expect(calls[0].stdin).toBe('첫 질문') // 프롬프트는 stdin
    expect(calls[1].args).toEqual(['-p', '', '--resume', id]) // 같은 id 로 재개
    expect(calls[1].stdin).toBe('둘째 질문')
  })

  it('throws on non-zero exit', async () => {
    const runner: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' })
    const s = createCliSession(cliDesc, claudeAdapter, runner)
    await expect(s.send('x')).rejects.toThrow('종료코드 1')
  })

  it('throws when the command is missing', async () => {
    const runner: CommandRunner = async () => ({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' })
    const s = createCliSession(cliDesc, claudeAdapter, runner)
    await expect(s.send('x')).rejects.toThrow('ENOENT')
  })

  it('throws when adapter has no headless support', async () => {
    const noHeadless: CliAdapter = { id: 'x', displayName: 'X', command: 'x', versionArgs: [] }
    const s = createCliSession(cliDesc, noHeadless, async () => ({ code: 0, stdout: '', stderr: '' }))
    await expect(s.send('x')).rejects.toThrow('헤드리스')
  })

  it("codex 어댑터(parse:'codex-jsonl')는 JSONL 에서 응답만 정제해 반환한다", async () => {
    const codexAdapter: CliAdapter = {
      id: 'codex',
      displayName: 'Codex CLI',
      command: 'codex',
      versionArgs: ['--version'],
      headless: { args: ['exec', '--json', '{prompt}'], parse: 'codex-jsonl' },
    }
    let captured: string[] = []
    const runner: CommandRunner = async (_cmd, args) => {
      captured = args
      return {
        code: 0,
        stdout: [
          'Reading additional input from stdin...',
          '{"type":"turn.started"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"정제된 응답"}}',
          '{"type":"turn.completed","usage":{"output_tokens":3}}',
        ].join('\n'),
        stderr: '',
      }
    }
    const codexDesc: LlmDescriptor = { id: 'codex', kind: 'cli', displayName: 'Codex', ref: 'codex', model: '' }
    const s = createCliSession(codexDesc, codexAdapter, runner)
    let chunk = ''
    expect(await s.send('질문', { onChunk: (c) => (chunk = c) })).toBe('정제된 응답')
    expect(chunk).toBe('정제된 응답')
    expect(captured).toEqual(['exec', '--json', '질문'])
  })

  it('stateful=false(기본)면 session 사양이 있어도 stateless 헤드리스로 동작한다', async () => {
    const calls: string[][] = []
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const withSession: CliAdapter = {
      ...claudeAdapter,
      session: {
        startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
        resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
        idSource: 'preassigned',
      },
    }
    const s = createCliSession(cliDesc, withSession, runner) // opts 미지정 → stateless
    expect(s.stateful).toBe(false)
    await s.send('q1')
    await s.send('q2')
    expect(calls[0]).toEqual(['-p', 'q1'])
    expect(calls[1]).toEqual(['-p', 'q2']) // 매번 헤드리스, 세션 인자 없음
  })

  it("preassigned 세션: 첫 호출 --session-id, 재개 --resume, 동일 UUID 재사용", async () => {
    const calls: string[][] = []
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      ...claudeAdapter,
      session: {
        startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
        resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
        idSource: 'preassigned',
      },
    }
    const s = createCliSession(cliDesc, adapter, runner, undefined, { stateful: true })
    expect(s.stateful).toBe(true)
    await s.send('첫 질문')
    await s.send('둘째 질문')

    expect(calls[0][0]).toBe('-p')
    expect(calls[0][1]).toBe('--session-id')
    const id = calls[0][2]
    expect(id).toMatch(/^[0-9a-f-]{36}$/) // 생성된 UUID
    expect(calls[0][3]).toBe('첫 질문')
    expect(calls[1]).toEqual(['-p', '--resume', id, '둘째 질문']) // 같은 id 로 재개
  })

  it("codex-thread 세션: 첫 응답의 thread_id 를 캡처해 resume 인자에 사용한다", async () => {
    const calls: string[][] = []
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      const stdout =
        calls.length === 1
          ? '{"type":"thread.started","thread_id":"abc-123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"R1"}}'
          : '{"type":"item.completed","item":{"type":"agent_message","text":"R2"}}'
      return { code: 0, stdout, stderr: '' }
    }
    const codexDesc: LlmDescriptor = { id: 'codex', kind: 'cli', displayName: 'Codex', ref: 'codex', model: '' }
    const adapter: CliAdapter = {
      id: 'codex',
      displayName: 'Codex CLI',
      command: 'codex',
      versionArgs: ['--version'],
      headless: { args: ['exec', '--json', '{prompt}'], parse: 'codex-jsonl' },
      session: {
        startArgs: ['exec', '--json', '{prompt}'],
        resumeArgs: ['exec', 'resume', '--json', '{sessionId}', '{prompt}'],
        idSource: 'codex-thread',
      },
    }
    const s = createCliSession(codexDesc, adapter, runner, undefined, { stateful: true })
    expect(await s.send('q1')).toBe('R1')
    expect(await s.send('q2')).toBe('R2')
    expect(calls[0]).toEqual(['exec', '--json', 'q1'])
    expect(calls[1]).toEqual(['exec', 'resume', '--json', 'abc-123', 'q2'])
  })

  it("preassigned: 첫 호출 실패는 세션을 오염시키지 않고 둘째 send 가 start 로 재시도한다", async () => {
    const calls: string[][] = []
    let n = 0
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      n++
      return n === 1 ? { code: 1, stdout: '', stderr: 'rate limit' } : { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      ...claudeAdapter,
      session: {
        startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
        resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
        idSource: 'preassigned',
      },
    }
    const s = createCliSession(cliDesc, adapter, runner, undefined, { stateful: true })
    await expect(s.send('q1')).rejects.toThrow('종료코드 1') // 첫 호출 실패
    expect(await s.send('q2')).toBe('ok') // 둘째는 정상

    expect(calls[0][1]).toBe('--session-id') // 첫 호출: start
    // 둘째 호출도 여전히 start(--session-id) — 유령 세션 --resume 시도가 아니어야 한다
    expect(calls[1][1]).toBe('--session-id')
  })

  it("프롬프트에 리터럴 {sessionId} 가 있어도 치환되지 않는다(토큰 충돌 방지)", async () => {
    const calls: string[][] = []
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      ...claudeAdapter,
      session: {
        startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
        resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
        idSource: 'preassigned',
      },
    }
    const s = createCliSession(cliDesc, adapter, runner, undefined, { stateful: true })
    await s.send('내 토큰은 {sessionId} 이다')
    const id = calls[0][2]
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0][3]).toBe('내 토큰은 {sessionId} 이다') // 프롬프트 내 리터럴 보존(=id 로 치환 안 됨)
  })

  it("fresh: stateful 세션이라도 헤드리스 1회로 실행하고 재개 상태를 건드리지 않는다", async () => {
    const calls: string[][] = []
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      ...claudeAdapter,
      session: {
        startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
        resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
        idSource: 'preassigned',
      },
    }
    const s = createCliSession(cliDesc, adapter, runner, undefined, { stateful: true })
    await s.send('독립', { fresh: true }) // 헤드리스 1회
    await s.send('첫 대화') // 재개 미시작 → 여전히 start
    await s.send('둘째 대화') // 이제 resume

    expect(calls[0]).toEqual(['-p', '독립']) // fresh = 헤드리스(세션 인자 없음)
    expect(calls[1][1]).toBe('--session-id') // fresh 가 세션을 시작시키지 않음 → 첫 stateful 은 start
    expect(calls[2][1]).toBe('--resume') // 둘째는 resume
  })

  it('runs in edit mode (cwd=workspace) when workspace is given and adapter has edit args', async () => {
    let seenCwd: string | undefined
    let seenArgs: string[] = []
    const runner: CommandRunner = async (_cmd, args, opts) => {
      seenCwd = opts.cwd
      seenArgs = args
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      id: 'x', displayName: 'X', command: 'x', versionArgs: ['--version'],
      headless: { args: ['-p', '{prompt}'] },
      edit: { args: ['agent', '-C', '{workspace}', '{prompt}'] },
    }
    const session = createCliSession({ id: 'x', kind: 'cli', displayName: 'X', ref: 'x', model: '' }, adapter, runner)
    const text = await session.send('do it', { workspace: '/ws' })
    expect(text).toBe('ok')
    expect(seenCwd).toBe('/ws')
    expect(seenArgs).toEqual(['agent', '-C', '/ws', 'do it'])
  })

  it('descriptor.model 이 있으면 modelFlag 로 --model 을 모든 실행에 덧붙인다(#8)', async () => {
    let seenArgs: string[] = []
    const runner: CommandRunner = async (_cmd, args) => {
      seenArgs = args
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      id: 'x', displayName: 'X', command: 'x', versionArgs: ['--version'], modelFlag: '--model',
      headless: { args: ['-p', '{prompt}'] },
    }
    const withModel = createCliSession(
      { id: 'x', kind: 'cli', displayName: 'X', ref: 'x', model: 'claude-opus-4-8' },
      adapter,
      runner,
    )
    await withModel.send('hi')
    expect(seenArgs).toEqual(['-p', 'hi', '--model', 'claude-opus-4-8'])

    // 빈 모델이면 플래그를 생략한다(CLI 기본 모델 사용 — 기존 동작 보존).
    const noModel = createCliSession({ id: 'x', kind: 'cli', displayName: 'X', ref: 'x', model: '' }, adapter, runner)
    await noModel.send('hi')
    expect(seenArgs).toEqual(['-p', 'hi'])

    // modelFlag 미지정 어댑터는 model 이 있어도 덧붙이지 않는다.
    const noFlag = createCliSession(
      { id: 'x', kind: 'cli', displayName: 'X', ref: 'x', model: 'm' },
      { ...adapter, modelFlag: undefined },
      runner,
    )
    await noFlag.send('hi')
    expect(seenArgs).toEqual(['-p', 'hi'])
  })

  it('mcpConfig 가 있으면 mcpConfigFlag(+strict)로 MCP 설정을 패스스루한다(#9)', async () => {
    let seenArgs: string[] = []
    const runner: CommandRunner = async (_cmd, args) => {
      seenArgs = args
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const claudeLike: CliAdapter = {
      id: 'claude', displayName: 'Claude', command: 'claude', versionArgs: ['--version'],
      mcpConfigFlag: '--mcp-config', mcpStrictArg: '--strict-mcp-config',
      headless: { args: ['-p', '{prompt}'] },
    }
    const cfg = '{"mcpServers":{"x":{"command":"npx"}}}'
    const s = createCliSession(
      { id: 'c', kind: 'cli', displayName: 'C', ref: 'claude', model: '', mcpConfig: cfg },
      claudeLike,
      runner,
    )
    await s.send('hi')
    expect(seenArgs).toEqual(['-p', 'hi', '--mcp-config', cfg, '--strict-mcp-config'])

    // 플래그 없는 어댑터(codex/gemini)는 mcpConfig 가 있어도 무시한다.
    const noFlag: CliAdapter = { ...claudeLike, mcpConfigFlag: undefined, mcpStrictArg: undefined }
    const s2 = createCliSession(
      { id: 'c', kind: 'cli', displayName: 'C', ref: 'codex', model: '', mcpConfig: cfg },
      noFlag,
      runner,
    )
    await s2.send('hi')
    expect(seenArgs).toEqual(['-p', 'hi'])
  })

  it('스트림 파서가 델타를 0개 뽑으면(exit-0, 원시출력 존재) 드리프트 경고를 낸다(#11)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // onStdout 으로 스키마에 안 맞는 줄을 흘림 → parseStreamLine 이 델타 0개 → full=''.
      const runner: CommandRunner = async (_c, _a, _o, onStdout) => {
        onStdout?.('{"type":"noise"}\n')
        return { code: 0, stdout: '{"type":"noise"}\n', stderr: '' }
      }
      const adapter: CliAdapter = {
        id: 'claude', displayName: 'Claude', command: 'claude', versionArgs: ['--version'],
        headless: { args: ['-p', '{prompt}'], parse: 'text' },
        streaming: { args: [], parse: 'claude-stream' },
      }
      const s = createCliSession({ id: 'c', kind: 'cli', displayName: 'C', ref: 'claude', model: '' }, adapter, runner)
      await s.send('hi', { onChunk: () => {} }) // onChunk → 스트리밍 경로 활성화
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0][0])).toMatch(/드리프트/)
    } finally {
      warn.mockRestore()
    }
  })

  it('스트림 델타가 정상 추출되면 드리프트 경고를 내지 않는다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const line = '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"안녕"}}}'
      const runner: CommandRunner = async (_c, _a, _o, onStdout) => {
        onStdout?.(line + '\n')
        return { code: 0, stdout: line + '\n', stderr: '' }
      }
      const adapter: CliAdapter = {
        id: 'claude', displayName: 'Claude', command: 'claude', versionArgs: ['--version'],
        headless: { args: ['-p', '{prompt}'], parse: 'text' },
        streaming: { args: [], parse: 'claude-stream' },
      }
      const s = createCliSession({ id: 'c', kind: 'cli', displayName: 'C', ref: 'claude', model: '' }, adapter, runner)
      expect(await s.send('hi', { onChunk: () => {} })).toBe('안녕')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("편집 모드는 adapter.edit.parse 로 stdout 을 정제한다(headless.parse 가 아니라)", async () => {
    // headless.parse='text' 면 JSONL 원문이 그대로 나오지만, edit.parse='codex-jsonl' 이면 agent_message 만 추출돼야 한다.
    const agentLine = '{"type":"item.completed","item":{"type":"agent_message","text":"편집 결과"}}'
    const runner: CommandRunner = async () => ({
      code: 0,
      stdout: ['{"type":"turn.started"}', agentLine, '{"type":"turn.completed"}'].join('\n'),
      stderr: '',
    })
    const adapter: CliAdapter = {
      id: 'codex',
      displayName: 'Codex CLI',
      command: 'codex',
      versionArgs: ['--version'],
      headless: { args: ['exec', '--json', '{prompt}'], parse: 'text' },
      edit: { args: ['agent', '-C', '{workspace}', '{prompt}'], parse: 'codex-jsonl' },
    }
    const codexDesc: LlmDescriptor = { id: 'codex', kind: 'cli', displayName: 'Codex', ref: 'codex', model: '' }
    const s = createCliSession(codexDesc, adapter, runner)
    // 편집 모드(workspace 지정) → edit.parse(codex-jsonl)로 정제 → agent_message 만
    expect(await s.send('do it', { workspace: '/ws' })).toBe('편집 결과')
  })

  it('편집 모드가 stateful 세션보다 우선한다(workspace 가 startArgs/resumeArgs 를 이긴다)', async () => {
    let seenCwd: string | undefined
    let seenArgs: string[] = []
    const runner: CommandRunner = async (_cmd, args, opts) => {
      seenCwd = opts.cwd
      seenArgs = args
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    const adapter: CliAdapter = {
      ...claudeAdapter,
      session: {
        startArgs: ['-p', '--session-id', '{sessionId}', '{prompt}'],
        resumeArgs: ['-p', '--resume', '{sessionId}', '{prompt}'],
        idSource: 'preassigned',
      },
      edit: { args: ['agent', '-C', '{workspace}', '{prompt}'] },
    }
    const s = createCliSession(cliDesc, adapter, runner, undefined, { stateful: true })
    expect(s.stateful).toBe(true)
    const text = await s.send('p', { workspace: '/ws' })
    expect(text).toBe('ok')
    expect(seenCwd).toBe('/ws')
    expect(seenArgs).toEqual(['agent', '-C', '/ws', 'p']) // edit 인자(stateful startArgs 가 아님)
  })

  it('runEditing 은 adapter.edit 가 없으면 거부한다(편집 모드 미지원)', async () => {
    const noEdit: CliAdapter = {
      ...claudeAdapter,
      headless: { args: ['-p', '{prompt}'] }, // headless 만, edit 없음
    }
    const s = createCliSession(cliDesc, noEdit, async () => ({ code: 0, stdout: 'ok', stderr: '' }))
    await expect(s.send('p', { workspace: '/ws' })).rejects.toThrow('편집 모드')
  })

  it("동일 세션 동시 send 를 직렬화한다(codex id 캡처 레이스 방지)", async () => {
    const calls: string[][] = []
    const runner: CommandRunner = async (_c, args) => {
      calls.push(args)
      const idx = calls.length
      // 첫 호출을 일부러 느리게 → 직렬화 없으면 둘째가 id 없이 먼저 진행됨
      await new Promise((r) => setTimeout(r, idx === 1 ? 15 : 0))
      const stdout =
        idx === 1
          ? '{"type":"thread.started","thread_id":"tid-1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"R1"}}'
          : '{"type":"item.completed","item":{"type":"agent_message","text":"R2"}}'
      return { code: 0, stdout, stderr: '' }
    }
    const codexDesc: LlmDescriptor = { id: 'codex', kind: 'cli', displayName: 'Codex', ref: 'codex', model: '' }
    const adapter: CliAdapter = {
      id: 'codex',
      displayName: 'Codex CLI',
      command: 'codex',
      versionArgs: ['--version'],
      headless: { args: ['exec', '--json', '{prompt}'], parse: 'codex-jsonl' },
      session: {
        startArgs: ['exec', '--json', '{prompt}'],
        resumeArgs: ['exec', 'resume', '--json', '{sessionId}', '{prompt}'],
        idSource: 'codex-thread',
      },
    }
    const s = createCliSession(codexDesc, adapter, runner, undefined, { stateful: true })
    const [r1, r2] = await Promise.all([s.send('q1'), s.send('q2')])
    expect(r1).toBe('R1')
    expect(r2).toBe('R2')
    expect(calls[0]).toEqual(['exec', '--json', 'q1']) // start
    expect(calls[1]).toEqual(['exec', 'resume', '--json', 'tid-1', 'q2']) // 캡처된 id 로 resume
  })
})

describe('createCliSession streaming', () => {
  const streamAdapter: CliAdapter = {
    ...claudeAdapter,
    streaming: { args: ['--output-format', 'stream-json'], parse: 'claude-stream' },
  }

  it('onChunk 으로 토큰 델타를 순차 방출하고 합쳐서 최종 텍스트를 반환한다', async () => {
    const lines = [
      '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"안녕"}}}',
      '{"type":"stream_event","event":{"delta":{"type":"text_delta","text":" 세계"}}}',
      '{"type":"result","result":"안녕 세계"}',
    ]
    let capturedArgs: string[] = []
    const runner: CommandRunner = async (_c, args, _t, onStdout) => {
      capturedArgs = args
      // 청크 경계를 일부러 라인 중간에서 쪼개 경계 처리를 검증
      onStdout?.(lines[0] + '\n' + lines[1].slice(0, 12))
      onStdout?.(lines[1].slice(12) + '\n' + lines[2] + '\n')
      return { code: 0, stdout: lines.join('\n'), stderr: '' }
    }
    const s = createCliSession(cliDesc, streamAdapter, runner)
    const chunks: string[] = []
    const out = await s.send('q', { onChunk: (c) => chunks.push(c) })

    expect(chunks).toEqual(['안녕', ' 세계']) // 델타만(result 무시), 순서 보존
    expect(out).toBe('안녕 세계') // 델타 합산 = 최종 텍스트
    expect(capturedArgs).toEqual(['-p', 'q', '--output-format', 'stream-json']) // 스트림 인자 덧붙음
  })

  it('streaming 어댑터라도 onChunk 가 없으면 버퍼링(스트림 인자 미부착)', async () => {
    let capturedArgs: string[] = []
    const runner: CommandRunner = async (_c, args) => {
      capturedArgs = args
      return { code: 0, stdout: '버퍼 응답\n', stderr: '' }
    }
    const s = createCliSession(cliDesc, streamAdapter, runner)
    expect(await s.send('q')).toBe('버퍼 응답')
    expect(capturedArgs).toEqual(['-p', 'q']) // 스트림 인자 없음
  })
})

describe('createSessionManager', () => {
  it('manages CLI and API sessions uniformly', async () => {
    const { provider } = fakeProvider()
    const apiSession = createApiSession(apiDesc, provider)
    const cliSession = createCliSession(cliDesc, claudeAdapter, async () => ({ code: 0, stdout: 'ok', stderr: '' }))

    const m = createSessionManager()
    m.add(apiSession)
    m.add(cliSession)

    expect(m.list()).toHaveLength(2)
    expect(m.has('gpt')).toBe(true)
    expect(m.descriptors().map((d) => d.kind).sort()).toEqual(['api', 'cli'])

    // 다형성: 종류와 무관하게 동일 인터페이스로 호출
    const sessions: LlmSession[] = m.list()
    for (const s of sessions) {
      expect(typeof (await s.send('ping'))).toBe('string')
    }

    await m.remove('gpt')
    expect(m.has('gpt')).toBe(false)
    expect(m.list()).toHaveLength(1)
  })
})

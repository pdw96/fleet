import { describe, expect, it } from 'vitest'
import type { CliAdapter, LlmDescriptor } from '../../../shared/types'
import type { CommandRunner } from '../cli/detect'
import type { ApiProvider, ChatTurn } from '../providers/types'
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

  it('invokes onChunk with the reply', async () => {
    const { provider } = fakeProvider()
    const s = createApiSession(apiDesc, provider)
    let chunk = ''
    await s.send('x', { onChunk: (c) => (chunk = c) })
    expect(chunk).toBe('echo:x')
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

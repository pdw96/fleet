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
      return `echo:${messages.at(-1)?.content ?? ''}`
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

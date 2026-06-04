import { describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../../shared/types'
import type { CommandRunner } from './cli/detect'
import { createFleetEngine } from './engine'
import { createSessionManager } from './session/manager'
import { createMemoryStore } from './store/memory'

function deterministic() {
  let n = 0
  return { idGen: () => `id-${++n}`, now: () => 1000 + n }
}

/** 프롬프트 내용에 따라 역할별 응답을 돌려주는 러너. */
const roleRunner: CommandRunner = async (_cmd, args) => {
  const prompt = args.join(' ')
  let out = '구현 결과물'
  if (prompt.includes('JSON')) out = '[{"title":"작업1","description":"d1"}]'
  else if (prompt.includes('검토')) out = 'APPROVE'
  else if (prompt.includes('누락')) out = '요약: 목표 충족, 누락 없음'
  return { code: 0, stdout: out, stderr: '' }
}

describe('FleetEngine', () => {
  it('registers a CLI session and lists it', () => {
    const engine = createFleetEngine({ runner: roleRunner })
    const d = engine.registerCliSession('claude')
    expect(d.id).toBe('cli:claude')
    expect(d.kind).toBe('cli')
    expect(engine.listSessions()).toHaveLength(1)
  })

  it('registers an API session from config', () => {
    const engine = createFleetEngine()
    const d = engine.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'Claude API',
      model: 'claude-sonnet-4',
      apiKey: 'k',
    })
    expect(d.id).toBe('api:a')
    expect(d.kind).toBe('api')
  })

  it('detects CLIs via the injected runner', async () => {
    const runner: CommandRunner = async (cmd) =>
      cmd === 'claude'
        ? { code: 0, stdout: '1.0.0', stderr: '' }
        : { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }
    const engine = createFleetEngine({ runner })
    const results = await engine.detectClis()
    expect(results.find((r) => r.id === 'claude')?.installed).toBe(true)
  })

  it('runs a full project flow through registered CLI sessions', async () => {
    const store = createMemoryStore(deterministic())
    const engine = createFleetEngine({ store, runner: roleRunner })
    engine.registerCliSession('claude')

    const result = await engine.runProjectFlow({ goal: '멀티 LLM 앱 만들기' })

    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].status).toBe('done')
    expect(result.summary).toContain('요약')
    expect(engine.listProjects()).toHaveLength(1)
    expect(engine.getProjectTasks(result.projectId)).toHaveLength(1)
  })

  it('throws when running a project with no sessions', async () => {
    const engine = createFleetEngine()
    await expect(engine.runProjectFlow({ goal: 'x' })).rejects.toThrow('세션이 없습니다')
  })

  it('setSessionCapabilities stores capabilities on the live descriptor', () => {
    const engine = createFleetEngine({ runner: roleRunner })
    engine.registerCliSession('claude')
    const d = engine.setSessionCapabilities('cli:claude', ['reviewer', 'planner'])
    expect(d.capabilities).toEqual(['reviewer', 'planner'])
    expect(engine.listSessions()[0].capabilities).toEqual(['reviewer', 'planner'])
  })

  it('setSessionCapabilities throws for an unknown session', () => {
    const engine = createFleetEngine()
    expect(() => engine.setSessionCapabilities('nope', ['reviewer'])).toThrow()
  })

  it('seeds differentiated default capabilities per CLI adapter at registration', () => {
    const engine = createFleetEngine({ runner: roleRunner })
    const claude = engine.registerCliSession('claude')
    const codex = engine.registerCliSession('codex')
    expect(claude.capabilities).toContain('reviewer')
    expect(codex.capabilities).toContain('implementer')
    expect(claude.capabilities).not.toEqual(codex.capabilities) // 차별화되어 capability-scored 가 의미를 가짐
  })

  it('seeds default capabilities per API provider at registration', () => {
    const engine = createFleetEngine()
    const d = engine.registerApiSession({ id: 'a', provider: 'google', displayName: 'g', model: 'm', apiKey: 'k' })
    expect(d.capabilities?.length).toBeGreaterThan(0)
  })

  it('capability-scored routes a role to the session that lists it and records assignedLlmId', async () => {
    const store = createMemoryStore(deterministic())
    const engine = createFleetEngine({ store, runner: roleRunner })
    engine.registerCliSession('claude') // cli:claude
    engine.registerCliSession('codex') // cli:codex
    // implementer 적합도를 claude 에 둔다 — round-robin 이면 implementer→codex 라 결과로 구분된다
    engine.setSessionCapabilities('cli:claude', ['implementer'])
    engine.setSessionCapabilities('cli:codex', ['reviewer'])

    const result = await engine.runProjectFlow({ goal: 'x', policy: 'capability-scored' })

    expect(result.tasks[0].assignedLlmId).toBe('cli:claude')
  })

  it('runs an AI-to-AI discussion across multiple sessions', async () => {
    let turn = 0
    const engine = createFleetEngine({
      runner: async () => {
        turn += 1
        return { code: 0, stdout: `발언${turn}`, stderr: '' }
      },
    })
    engine.registerCliSession('claude')
    engine.registerCliSession('codex')
    const room = engine.createRoom('토론방', ['cli:claude', 'cli:codex'])
    engine.postUserMessage(room.id, '주제: 아키텍처')

    const msgs = await engine.discussRoom(room.id, ['cli:claude', 'cli:codex'], 2)
    expect(msgs).toHaveLength(4) // 2 라운드 × 2 LLM
    expect(engine.roomHistory(room.id)).toHaveLength(5) // 사용자 주제 + 4 발언
  })

  it('stateful 로 등록한 CLI 세션은 채팅에서 세션 재개(--session-id→--resume)와 델타를 사용한다', async () => {
    const calls: string[][] = []
    const engine = createFleetEngine({
      runner: async (_cmd, args) => {
        calls.push(args)
        return { code: 0, stdout: '답변', stderr: '' }
      },
    })
    const d = engine.registerCliSession('claude', { stateful: true })
    expect(d.stateful).toBe(true)

    const room = engine.createRoom('방', ['cli:claude'])
    engine.postUserMessage(room.id, '첫 질문')
    await engine.askLlm(room.id, 'cli:claude') // 첫 턴 → --session-id <uuid>
    engine.postUserMessage(room.id, '둘째 질문')
    await engine.askLlm(room.id, 'cli:claude') // 둘째 턴 → --resume <같은 uuid>

    // 첫 호출: 새 세션 시작
    expect(calls[0][0]).toBe('-p')
    expect(calls[0][1]).toBe('--session-id')
    const sid = calls[0][2]
    expect(sid).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0][3]).toContain('첫 질문') // 첫 턴엔 전체 맥락

    // 둘째 호출: 같은 id 로 재개 + 델타(첫 질문 재전송 없음)
    expect(calls[1].slice(0, 3)).toEqual(['-p', '--resume', sid])
    expect(calls[1][3]).toContain('둘째 질문')
    expect(calls[1][3]).not.toContain('첫 질문')
  })

  it('supports a live chat room with a registered LLM', async () => {
    const engine = createFleetEngine({ runner: async () => ({ code: 0, stdout: 'LLM 답변', stderr: '' }) })
    engine.registerCliSession('claude')
    const room = engine.createRoom('테스트방', ['cli:claude'])
    engine.postUserMessage(room.id, '안녕')

    const msg = await engine.askLlm(room.id, 'cli:claude')
    expect(msg.content).toBe('LLM 답변')
    expect(engine.roomHistory(room.id)).toHaveLength(2)
    expect(engine.listRooms()).toHaveLength(1)
  })
})

/** claude-stream JSONL 델타를 onStdout 으로 흘리는 러너(스트리밍 코어 구동). */
const streamRunner: CommandRunner = async (_cmd, _args, _t, onStdout) => {
  onStdout?.('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"안"}}}\n')
  onStdout?.('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"녕"}}}\n')
  return { code: 0, stdout: '안녕', stderr: '' }
}

describe('FleetEngine 채팅 스트리밍(onChatStream)', () => {
  it('askLlm 은 start → delta* → end 를 동일 streamId 로 방출하고 end 에 영속 메시지를 싣는다', async () => {
    const events: ChatStreamEvent[] = []
    const engine = createFleetEngine({ runner: streamRunner, onChatStream: (e) => events.push(e) })
    engine.registerCliSession('claude')
    const room = engine.createRoom('방', ['cli:claude'])
    engine.postUserMessage(room.id, '안녕?')

    const msg = await engine.askLlm(room.id, 'cli:claude')

    expect(events[0].kind).toBe('start')
    const sid = events[0].streamId
    expect(events.every((e) => e.streamId === sid)).toBe(true) // 한 발언 = 한 streamId

    const deltas = events.flatMap((e) => (e.kind === 'delta' ? [e.delta] : []))
    expect(deltas).toEqual(['안', '녕']) // 토큰 델타 순서 보존

    const end = events.at(-1)
    expect(end?.kind).toBe('end')
    expect(end?.kind === 'end' && end.message.id).toBe(msg.id) // end 메시지 = 반환된 영속 메시지
    expect(msg.content).toBe('안녕')
  })

  it('실패 시 error 를 방출하고 거부를 전파한다(IPC reject 경로 보존)', async () => {
    const events: ChatStreamEvent[] = []
    const failRunner: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'boom' })
    const engine = createFleetEngine({ runner: failRunner, onChatStream: (e) => events.push(e) })
    engine.registerCliSession('claude')
    const room = engine.createRoom('방', ['cli:claude'])
    engine.postUserMessage(room.id, 'x')

    await expect(engine.askLlm(room.id, 'cli:claude')).rejects.toThrow('종료코드 1')

    expect(events[0].kind).toBe('start')
    const last = events.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.kind === 'error' && last.message).toContain('종료코드 1')
  })

  it('discuss 는 턴마다 고유 streamId 로 start/end 를 방출한다', async () => {
    const events: ChatStreamEvent[] = []
    const engine = createFleetEngine({ runner: streamRunner, onChatStream: (e) => events.push(e) })
    engine.registerCliSession('claude')
    engine.registerCliSession('codex')
    const room = engine.createRoom('방', ['cli:claude', 'cli:codex'])
    engine.postUserMessage(room.id, '주제')

    await engine.discussRoom(room.id, ['cli:claude', 'cli:codex'], 1)

    const starts = events.filter((e) => e.kind === 'start')
    expect(starts).toHaveLength(2) // 2 LLM × 1 라운드
    expect(new Set(starts.map((e) => e.streamId)).size).toBe(2) // 턴마다 고유 streamId
    expect(events.filter((e) => e.kind === 'end')).toHaveLength(2)
  })

  it('onChatStream 미지정이면 스트림 인자 없이 버퍼링으로 동작한다(기존 경로 보존)', async () => {
    let capturedArgs: string[] = []
    const runner: CommandRunner = async (_c, args) => {
      capturedArgs = args
      return { code: 0, stdout: '버퍼 응답', stderr: '' }
    }
    const engine = createFleetEngine({ runner }) // onChatStream 미지정
    engine.registerCliSession('claude')
    const room = engine.createRoom('방', ['cli:claude'])
    engine.postUserMessage(room.id, 'q')

    const msg = await engine.askLlm(room.id, 'cli:claude')
    expect(msg.content).toBe('버퍼 응답')
    expect(capturedArgs).not.toContain('stream-json') // 스트림 인자 미부착
  })

  it('비스트리밍 세션(onChunk 1회)은 delta 가 최종 텍스트 1회로 도착한다(start→delta×1→end)', async () => {
    const events: ChatStreamEvent[] = []
    const sessions = createSessionManager()
    sessions.add({
      id: 'fake',
      descriptor: { id: 'fake', kind: 'api', displayName: 'Fake', ref: 'fake', model: '' },
      async send(_prompt, opts) {
        opts?.onChunk?.('전체응답') // API 세션처럼 최종 텍스트를 1회만 흘림
        return '전체응답'
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ sessions, onChatStream: (e) => events.push(e) })
    const room = engine.createRoom('방', ['fake'])
    engine.postUserMessage(room.id, 'q')

    const msg = await engine.askLlm(room.id, 'fake')

    const deltas = events.flatMap((e) => (e.kind === 'delta' ? [e.delta] : []))
    expect(deltas).toEqual(['전체응답']) // 정확히 1회, 전체 텍스트
    expect(deltas[0]).toBe(msg.content) // delta = 영속 메시지 본문
    expect(events[0].kind).toBe('start')
    expect(events.at(-1)?.kind).toBe('end')
  })

  it('codex-jsonl 포맷도 streamedAsk → onChatStream delta 로 흐른다(이벤트 단위 단일 델타)', async () => {
    const events: ChatStreamEvent[] = []
    const codexLine = '{"type":"item.completed","item":{"type":"agent_message","text":"코덱스 응답"}}'
    const codexRunner: CommandRunner = async (_c, _a, _t, onStdout) => {
      onStdout?.(codexLine + '\n')
      return { code: 0, stdout: codexLine, stderr: '' }
    }
    const engine = createFleetEngine({ runner: codexRunner, onChatStream: (e) => events.push(e) })
    engine.registerCliSession('codex')
    const room = engine.createRoom('방', ['cli:codex'])
    engine.postUserMessage(room.id, 'q')

    const msg = await engine.askLlm(room.id, 'cli:codex')

    const deltas = events.flatMap((e) => (e.kind === 'delta' ? [e.delta] : []))
    expect(deltas).toEqual(['코덱스 응답']) // codex 는 토큰이 아닌 이벤트 단위 → 단일 델타
    expect(msg.content).toBe('코덱스 응답')
  })
})

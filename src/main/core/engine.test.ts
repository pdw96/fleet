import { describe, expect, it } from 'vitest'
import type { CommandRunner } from './cli/detect'
import { createFleetEngine } from './engine'
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

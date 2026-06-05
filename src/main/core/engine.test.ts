import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../../shared/types'
import type { CommandRunner } from './cli/detect'
import { createFleetEngine } from './engine'
import { createSessionManager } from './session/manager'
import { createMemoryStore } from './store/memory'
import type { GitRunner } from './workspace/git'

function deterministic() {
  let n = 0
  return { idGen: () => `id-${++n}`, now: () => 1000 + n }
}

/**
 * 인메모리 가짜 git 실행기 — 실제 git 을 건드리지 않고 워크스페이스 diff 모델을 시뮬레이트한다.
 * (실 git 을 쓰면 tmpdir 이 사용자 홈 저장소 하위라 부모 .git 을 오염시킬 위험이 있어 격리한다.)
 * collectDiff 의 name-only 는 cwd 디렉터리의 실제 파일 목록을 보고해, 편집 러너가 만든 파일이 변경으로 잡힌다.
 */
function fakeGit(): GitRunner {
  let head = 0
  return {
    async run(args, cwd) {
      const sub = args[0]
      if (sub === 'rev-parse' && args.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true', stderr: '' }
      if (sub === 'rev-parse') return { code: 0, stdout: `hash-${head}`, stderr: '' }
      if (sub === 'add') return { code: 0, stdout: '', stderr: '' }
      if (sub === 'diff' && args.includes('--name-only')) {
        const files = readdirSync(cwd).filter((f) => f !== '.git')
        return { code: 0, stdout: files.join('\n'), stderr: '' }
      }
      if (sub === 'diff') {
        const files = readdirSync(cwd).filter((f) => f !== '.git')
        return { code: 0, stdout: files.map((f) => `+++ b/${f}`).join('\n'), stderr: '' }
      }
      if (sub === 'commit') {
        head++
        return { code: 0, stdout: '', stderr: '' }
      }
      if (sub === 'reset' || sub === 'clean' || sub === 'init') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
}

/**
 * 프롬프트 내용에 따라 역할별 응답을 돌려주는 러너.
 * 편집 모드(opts.cwd 지정)에선 워크스페이스에 파일을 직접 만들어 실제 git diff 를 발생시킨다.
 */
const roleRunner: CommandRunner = async (_cmd, args, opts) => {
  const prompt = args.join(' ')
  if (prompt.includes('JSON')) return { code: 0, stdout: '[{"title":"작업1","description":"d1"}]', stderr: '' }
  if (prompt.includes('검토')) return { code: 0, stdout: 'APPROVE', stderr: '' }
  if (prompt.includes('누락')) return { code: 0, stdout: '요약: 목표 충족, 누락 없음', stderr: '' }
  if (opts.cwd) writeFileSync(join(opts.cwd, 'impl.txt'), '구현 결과물') // 직접 편집
  return { code: 0, stdout: '구현 결과물', stderr: '' }
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
    const dir = mkdtempSync(join(tmpdir(), 'fleet-flow-'))
    try {
      const store = createMemoryStore(deterministic())
      const engine = createFleetEngine({ store, runner: roleRunner, workspaceDir: dir, gitRunner: fakeGit() })
      engine.registerCliSession('claude')

      const result = await engine.runProjectFlow({ goal: '멀티 LLM 앱 만들기' })

      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0].status).toBe('done')
      expect(result.summary).toContain('요약')
      expect(engine.listProjects()).toHaveLength(1)
      expect(engine.getProjectTasks(result.projectId)).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when running a project with no sessions', async () => {
    const engine = createFleetEngine()
    await expect(engine.runProjectFlow({ goal: 'x' })).rejects.toThrow('세션이 없습니다')
  })

  it('throws when running a project without a selected workspace', async () => {
    // 세션은 있으나 워크스페이스 미선택 — 직접 편집 모델은 워크스페이스 필수라 거부해야 한다.
    const engine = createFleetEngine({ runner: roleRunner })
    engine.registerCliSession('claude')
    await expect(engine.runProjectFlow({ goal: 'g' })).rejects.toThrow('워크스페이스')
  })

  it('fails fast when NO CLI session exists at all (cannot direct-edit)', async () => {
    // CLI 없이 API 세션만 등록 + 워크스페이스 지정 → implementer 로 쓸 CLI 가 전혀 없다.
    // 계획 전에 명확한 설정 오류로 거부해야 한다(API 호출 한 번 낭비 방지).
    const dir = mkdtempSync(join(tmpdir(), 'fleet-noimpl-'))
    try {
      const engine = createFleetEngine({ workspaceDir: dir, gitRunner: fakeGit() })
      engine.registerApiSession({ id: 'a', provider: 'openai', displayName: 'GPT', model: 'm', apiKey: 'k' })
      await expect(engine.runProjectFlow({ goal: 'g' })).rejects.toThrow(/구현|CLI 세션/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reassigns the implementer to a CLI session (does not throw) when assignments put an API session there', async () => {
    // CLI 와 API 가 모두 있고, 명시적 배정이 implementer 를 API 에 둔 경우:
    // fail-fast 대신 CLI 세션으로 재배정해 실행을 계속해야 한다(blunt throw 가 아님).
    const dir = mkdtempSync(join(tmpdir(), 'fleet-reassign-'))
    try {
      const store = createMemoryStore(deterministic())
      const engine = createFleetEngine({ store, runner: roleRunner, workspaceDir: dir, gitRunner: fakeGit() })
      engine.registerCliSession('claude') // cli:claude — 유일한 CLI
      engine.registerApiSession({ id: 'a', provider: 'openai', displayName: 'GPT', model: 'm', apiKey: 'k' })

      // implementer 를 API 세션에 명시 배정 → 재배정 로직이 cli:claude 로 바꿔야 한다.
      const result = await engine.runProjectFlow({
        goal: 'g',
        assignments: [
          { role: 'planner', llmId: 'cli:claude' },
          { role: 'implementer', llmId: 'api:a' },
          { role: 'reviewer', llmId: 'cli:claude' },
          { role: 'summarizer', llmId: 'cli:claude' },
        ],
      })

      expect(result.tasks[0].status).toBe('done') // 재배정된 CLI 로 직접 편집 실행됨
      expect(result.tasks[0].assignedLlmId).toBe('cli:claude') // API 가 아니라 CLI 로 라우팅
      expect(store.listEvents().some((e) => e.type === 'assignment.implementer_reassigned')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cancelRun aborts an in-flight run: task ends not-done and run.cancelled is emitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-cancel-'))
    try {
      const store = createMemoryStore(deterministic())
      const sessions = createSessionManager()
      // 구현 호출(opts.workspace 지정)은 전달된 AbortSignal 에서 abort 될 때까지 대기하다 거부한다.
      // 그 외(plan JSON / 검토 / 요약) 호출은 즉시 응답해 작업 루프까지 도달하게 한다.
      sessions.add({
        id: 'cli:claude',
        descriptor: { id: 'cli:claude', kind: 'cli', displayName: 'Claude', ref: 'claude', model: '', capabilities: ['planner', 'implementer', 'reviewer', 'summarizer'] },
        async send(prompt, opts) {
          if (prompt.includes('JSON')) return '[{"title":"작업1","description":"d1"}]'
          if (prompt.includes('검토')) return 'APPROVE'
          if (prompt.includes('누락')) return '요약'
          if (opts?.workspace) {
            // 편집(구현) 호출: abort 까지 hang → cancelRun 이 신호를 보내면 reject.
            return await new Promise<string>((_resolve, reject) => {
              const signal = opts.signal
              if (signal?.aborted) return reject(new Error('aborted'))
              signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          }
          return '응답'
        },
        async dispose() {},
      })

      const events: { type: string; data?: Record<string, unknown> }[] = []
      const engine = createFleetEngine({
        store,
        sessions,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        onOrchestratorEvent: (e) => events.push(e),
      })

      // 실행을 await 하지 않고 띄운 뒤, project.created 에서 projectId 를 잡아 취소한다.
      const runPromise = engine.runProjectFlow({ goal: 'g' })
      const pid = await new Promise<string>((resolve) => {
        const timer = setInterval(() => {
          const created = events.find((e) => e.type === 'project.created')
          const id = created?.data?.['projectId']
          if (typeof id === 'string') {
            clearInterval(timer)
            resolve(id)
          }
        }, 5)
      })

      engine.cancelRun(pid)

      const result = await runPromise

      // abort 된 구현 호출 → 작업이 done 이 아니어야 한다(revert 후 failed).
      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0].status).not.toBe('done')
      // run.cancelled 가 콜백으로 방출되고 감사 로그(store)에도 남는다.
      expect(events.some((e) => e.type === 'run.cancelled')).toBe(true)
      expect(store.listEvents().some((e) => e.type === 'run.cancelled')).toBe(true)
      // 라이브 run.cancelled 는 영속 이벤트 id 를 data.eventId 로 함께 싣는다(렌더러 dedup 용).
      const liveCancel = events.find((e) => e.type === 'run.cancelled')
      const persistedCancel = store.listEvents().find((e) => e.type === 'run.cancelled')
      expect(liveCancel?.data?.['eventId']).toBeTruthy()
      expect(liveCancel?.data?.['eventId']).toBe(persistedCancel?.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cancelRun on an unknown projectId is a harmless no-op', () => {
    const engine = createFleetEngine({ runner: roleRunner })
    expect(() => engine.cancelRun('does-not-exist')).not.toThrow()
    // 미존재 id 는 어떤 이벤트도 남기지 않는다.
    expect(engine.listEvents().some((e) => e.type === 'run.cancelled')).toBe(false)
  })

  it('runs the implementer as a direct-edit agent in the workspace and verifies when workspaceDir is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-engine-'))
    try {
      // 편집 모드(opts.cwd 지정)에서 에이전트가 워크스페이스에 파일을 직접 만든다 → 실제 git diff 발생.
      const runner: CommandRunner = async (_cmd, args, opts) => {
        const prompt = args.join(' ')
        if (prompt.includes('JSON')) return { code: 0, stdout: '[{"title":"작업1","description":"d1"}]', stderr: '' }
        if (prompt.includes('검토')) return { code: 0, stdout: 'APPROVE', stderr: '' }
        if (prompt.includes('누락')) return { code: 0, stdout: '요약', stderr: '' }
        if (opts.cwd) writeFileSync(join(opts.cwd, 'out.txt'), 'hello') // 직접 편집
        return { code: 0, stdout: '구현 완료', stderr: '' }
      }
      const store = createMemoryStore(deterministic())
      const engine = createFleetEngine({
        store,
        runner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        verifyRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
      })
      engine.registerCliSession('claude')

      const result = await engine.runProjectFlow({ goal: 'g' })

      // 에이전트의 직접 편집이 워크스페이스에 반영되고 keep(커밋)된다
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hello')
      expect(result.tasks[0].status).toBe('done')
      expect(result.tasks[0].changedFiles).toContain('out.txt')
      // 검증이 실행되고 결과가 surface 된다
      expect((result.verifications ?? []).length).toBeGreaterThan(0)
      expect(result.verifications?.every((v) => v.passed)).toBe(true)
      expect(store.getProject(result.projectId)?.status).toBe('done')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('setSessionCapabilities stores capabilities on the live descriptor', () => {
    const engine = createFleetEngine({ runner: roleRunner })
    engine.registerCliSession('claude')
    const d = engine.setSessionCapabilities('cli:claude', ['reviewer', 'planner'])
    expect(d.capabilities).toEqual(['reviewer', 'planner'])
    expect(engine.listSessions()[0].capabilities).toEqual(['reviewer', 'planner'])
  })

  it('activates direct-edit execution after setWorkspace at runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-ws-'))
    try {
      const runner: CommandRunner = async (_c, args, opts) => {
        const p = args.join(' ')
        if (p.includes('JSON')) return { code: 0, stdout: '[{"title":"T","description":"d"}]', stderr: '' }
        if (p.includes('검토')) return { code: 0, stdout: 'APPROVE', stderr: '' }
        if (p.includes('누락')) return { code: 0, stdout: '요약', stderr: '' }
        if (opts.cwd) writeFileSync(join(opts.cwd, 'made.txt'), 'hi') // 직접 편집
        return { code: 0, stdout: '구현 완료', stderr: '' }
      }
      const engine = createFleetEngine({
        runner,
        gitRunner: fakeGit(),
        verifyRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
      })
      engine.registerCliSession('claude')
      expect(engine.getWorkspace()).toBeNull()
      engine.setWorkspace(dir)
      expect(engine.getWorkspace()).toBe(dir)
      await engine.runProjectFlow({ goal: 'g' })
      expect(readFileSync(join(dir, 'made.txt'), 'utf8')).toBe('hi')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discussRoom isolates a failing llm and continues with the others', async () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    sessions.add({
      id: 'bad',
      descriptor: { id: 'bad', kind: 'api', displayName: 'bad', ref: 'bad', model: '' },
      async send() {
        throw new Error('boom')
      },
      async dispose() {},
    })
    sessions.add({
      id: 'good',
      descriptor: { id: 'good', kind: 'api', displayName: 'good', ref: 'good', model: '' },
      async send() {
        return '안녕하세요'
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ store, sessions })
    const room = engine.createRoom('방', ['bad', 'good'])
    const msgs = await engine.discussRoom(room.id, ['bad', 'good'])
    expect(msgs.map((m) => m.content)).toContain('안녕하세요')
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
    const dir = mkdtempSync(join(tmpdir(), 'fleet-cap-'))
    try {
      const store = createMemoryStore(deterministic())
      const engine = createFleetEngine({ store, runner: roleRunner, workspaceDir: dir, gitRunner: fakeGit() })
      engine.registerCliSession('claude') // cli:claude
      engine.registerCliSession('codex') // cli:codex
      // implementer 적합도를 claude 에 둔다 — round-robin 이면 implementer→codex 라 결과로 구분된다
      engine.setSessionCapabilities('cli:claude', ['implementer'])
      engine.setSessionCapabilities('cli:codex', ['reviewer'])

      const result = await engine.runProjectFlow({ goal: 'x', policy: 'capability-scored' })

      expect(result.tasks[0].assignedLlmId).toBe('cli:claude')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

describe('FleetEngine — 프로젝트 영속 읽기', () => {
  it('lists a project events via the store (excluding task.progress)', () => {
    const store = createMemoryStore({ idGen: (() => { let n = 0; return () => `id-${++n}` })(), now: () => 1 })
    store.appendEvent({ type: 'project.created', message: '생성', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.progress', message: '토큰', data: { projectId: 'p1' } })
    const engine = createFleetEngine({ store })
    const events = engine.listProjectEvents('p1')
    expect(events.map((e) => e.type)).toEqual(['project.created'])
    expect(events[0].message).toBe('생성')
  })

  it('round-trips the last active project id', () => {
    const engine = createFleetEngine({ store: createMemoryStore() })
    expect(engine.getLastActiveProject()).toBeNull()
    engine.setLastActiveProject('p7')
    expect(engine.getLastActiveProject()).toBe('p7')
    engine.setLastActiveProject(null)
    expect(engine.getLastActiveProject()).toBeNull()
  })
})

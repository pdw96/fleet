import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamEvent } from '../../shared/types'
import type { CommandRunner } from './cli/detect'
import { createFleetEngine } from './engine'
import type { McpHost } from './mcp/types'
import type { HttpClient } from './providers/types'
import { createSessionManager } from './session/manager'
import type { FleetTool } from './tools/types'
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

/** 호출 순서대로 응답 본문을 돌려주는 mock HTTP(요청 본문 캡처). */
function scriptedHttp(bodies: string[]): { http: HttpClient; calls: string[] } {
  const calls: string[] = []
  let i = 0
  const http: HttpClient = async (_url, init) => {
    calls.push(init.body)
    return { ok: true, status: 200, text: async () => bodies[Math.min(i++, bodies.length - 1)] }
  }
  return { http, calls }
}

/**
 * 프롬프트 내용에 따라 역할별 응답을 돌려주는 러너.
 * 편집 모드(opts.cwd 지정)에선 워크스페이스에 파일을 직접 만들어 실제 git diff 를 발생시킨다.
 */
const roleRunner: CommandRunner = async (_cmd, args, opts) => {
  // 프롬프트는 stdin 으로 오므로(promptVia='stdin') argv 와 stdin 을 함께 보고 역할을 판별한다.
  // planner·reviewer 프롬프트가 둘 다 구조화 출력 JSON 을 요청하므로(둘 다 'JSON' 포함),
  // planner 는 고유어 '분해', reviewer 는 고유어 '검토' 로 판별한다.
  const prompt = [...args, opts.stdinInput ?? ''].join(' ')
  if (prompt.includes('분해')) return { code: 0, stdout: '[{"title":"작업1","description":"d1"}]', stderr: '' }
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
      model: 'claude-sonnet-4-6',
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
          if (prompt.includes('분해')) return '[{"title":"작업1","description":"d1"}]'
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
        const prompt = [...args, opts.stdinInput ?? ''].join(' ')
        // planner·reviewer 둘 다 구조화 출력 JSON 을 요청하므로 planner 는 '분해', reviewer 는 '검토' 로 판별한다.
        if (prompt.includes('분해')) return { code: 0, stdout: '[{"title":"작업1","description":"d1"}]', stderr: '' }
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
        const p = [...args, opts.stdinInput ?? ''].join(' ')
        if (p.includes('분해')) return { code: 0, stdout: '[{"title":"T","description":"d"}]', stderr: '' }
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
    // 프롬프트는 stdin 으로 가므로(promptVia='stdin') argv 와 stdin 을 함께 캡처한다.
    const calls: { args: string[]; stdin?: string }[] = []
    const engine = createFleetEngine({
      runner: async (_cmd, args, opts) => {
        calls.push({ args, stdin: opts.stdinInput })
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

    // 첫 호출: 새 세션 시작 (프롬프트는 argv 가 아닌 stdin)
    const sid = calls[0].args[2]
    expect(calls[0].args).toEqual(['-p', '--session-id', sid])
    expect(sid).toMatch(/^[0-9a-f-]{36}$/)
    expect(calls[0].stdin).toContain('첫 질문') // 첫 턴엔 전체 맥락

    // 둘째 호출: 같은 id 로 재개 + 델타(첫 질문 재전송 없음)
    expect(calls[1].args).toEqual(['-p', '--resume', sid])
    expect(calls[1].stdin).toContain('둘째 질문')
    expect(calls[1].stdin).not.toContain('첫 질문')
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

  it('registerApiSession 의 thinking 설정이 세션 기본값으로 실제 요청 body 에 반영된다 (#11-thinking 활성화)', async () => {
    const { http, calls } = scriptedHttp([
      JSON.stringify({ content: [{ type: 'text', text: '응답' }], stop_reason: 'end_turn' }),
    ])
    const engine = createFleetEngine({ http })
    engine.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'A',
      model: 'claude-opus-4-8',
      apiKey: 'k',
      thinking: { effort: 'xhigh' },
    })
    const room = engine.createRoom('r', ['api:a'])
    const msg = await engine.askLlm(room.id, 'api:a')

    expect(msg.content).toBe('응답')
    const body = JSON.parse(calls[0]) as { thinking?: unknown; output_config?: { effort?: string } }
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config?.effort).toBe('xhigh')
  })

  it('MCP 도구가 있으면 워크스페이스 없이도 API 세션이 도구 루프로 호출한다 (#10 SP2)', async () => {
    const pingTool: FleetTool = {
      definition: { name: 'mcp__demo__ping', parameters: { type: 'object' } },
      classify: () => 'safe',
      async execute() {
        return 'pong'
      },
    }
    const fakeMcpHost: McpHost = {
      async setServers() {
        return []
      },
      tools: () => [pingTool],
      status: () => [],
      async dispose() {},
    }
    const { http, calls } = scriptedHttp([
      JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__demo__ping', input: {} }],
        stop_reason: 'tool_use',
      }),
      JSON.stringify({ content: [{ type: 'text', text: '응답 완료' }], stop_reason: 'end_turn' }),
    ])
    const engine = createFleetEngine({ http, mcpHost: fakeMcpHost }) // 워크스페이스 미설정
    engine.registerApiSession({ id: 'a', provider: 'anthropic', displayName: 'A', model: 'claude-sonnet-4-6', apiKey: 'k' })
    const room = engine.createRoom('r', ['api:a'])
    const msg = await engine.askLlm(room.id, 'api:a')

    expect(msg.content).toBe('응답 완료')
    expect(calls).toHaveLength(2) // 도구 왕복 = chat 2회
    expect(calls[1]).toContain('pong') // 2번째 요청에 tool_result 포함
  })

  it('setMcpServers/getMcpStatus/dispose 가 mcpHost 에 위임한다 (#10 SP2)', async () => {
    const seen: string[] = []
    const fakeMcpHost: McpHost = {
      async setServers(specs) {
        seen.push('set')
        return [{ name: specs[0].name, connected: true, toolCount: 0, tools: [] }]
      },
      tools: () => [],
      status: () => [{ name: 'x', connected: true, toolCount: 0, tools: [] }],
      async dispose() {
        seen.push('dispose')
      },
    }
    const engine = createFleetEngine({ mcpHost: fakeMcpHost })
    const status = await engine.setMcpServers([{ name: 'x', command: 'c' }])
    expect(status[0].name).toBe('x')
    expect(engine.getMcpStatus()).toHaveLength(1)
    await engine.dispose()
    expect(seen).toEqual(['set', 'dispose'])
  })

  it('dispose 는 세션과 mcpHost 를 모두 정리한다 (#10 SP2)', async () => {
    const order: string[] = []
    const sessions = createSessionManager()
    const realDisposeAll = sessions.disposeAll.bind(sessions)
    sessions.disposeAll = async () => {
      order.push('sessions')
      await realDisposeAll()
    }
    const fakeMcpHost: McpHost = {
      async setServers() {
        return []
      },
      tools: () => [],
      status: () => [],
      async dispose() {
        order.push('mcp')
      },
    }
    const engine = createFleetEngine({ sessions, mcpHost: fakeMcpHost })
    await engine.dispose()
    expect(order).toEqual(['sessions', 'mcp'])
  })

  it('dispose 는 세션 정리가 실패해도 mcpHost 를 정리한다 (#10 SP2)', async () => {
    let mcpDisposed = false
    const sessions = createSessionManager()
    sessions.disposeAll = async () => {
      throw new Error('세션 정리 실패')
    }
    const fakeMcpHost: McpHost = {
      async setServers() {
        return []
      },
      tools: () => [],
      status: () => [],
      async dispose() {
        mcpDisposed = true
      },
    }
    const engine = createFleetEngine({ sessions, mcpHost: fakeMcpHost })
    await engine.dispose() // reject 를 전파하지 않아야 한다
    expect(mcpDisposed).toBe(true)
  })

  it('워크스페이스가 설정되면 API 세션이 도구 루프로 워크스페이스 파일을 읽는다 (#10 SP1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-engine-tools-'))
    try {
      writeFileSync(join(dir, 'note.txt'), '메모 내용')
      const { http, calls } = scriptedHttp([
        JSON.stringify({
          content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'note.txt' } }],
          stop_reason: 'tool_use',
        }),
        JSON.stringify({ content: [{ type: 'text', text: '확인 완료' }], stop_reason: 'end_turn' }),
      ])
      const engine = createFleetEngine({ http })
      engine.setWorkspace(dir)
      engine.registerApiSession({ id: 'a', provider: 'anthropic', displayName: 'A', model: 'claude-sonnet-4-6', apiKey: 'k' })
      const room = engine.createRoom('r', ['api:a'])
      engine.postUserMessage(room.id, 'note.txt 를 읽어줘')
      const msg = await engine.askLlm(room.id, 'api:a')

      expect(msg.content).toBe('확인 완료')
      expect(calls).toHaveLength(2) // 도구 왕복 = chat 2회
      expect(calls[1]).toContain('메모 내용') // 2번째 요청에 tool_result(파일 내용) 포함
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** claude-stream JSONL 델타를 onStdout 으로 흘리는 러너(스트리밍 코어 구동). */
const streamRunner: CommandRunner = async (_cmd, _args, _t, onStdout) => {
  onStdout?.('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"안"}}}\n')
  onStdout?.('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"녕"}}}\n')
  return { code: 0, stdout: '안녕', stderr: '' }
}

/** 스트림 스코프 이벤트(streamId 보유)만 통과시키는 가드 — 방 단위 busy/idle 봉투를 분리한다. */
const hasStreamId = (e: ChatStreamEvent): e is Extract<ChatStreamEvent, { streamId: string }> =>
  e.kind === 'start' || e.kind === 'delta' || e.kind === 'tool' || e.kind === 'end' || e.kind === 'error'

describe('FleetEngine 채팅 스트리밍(onChatStream)', () => {
  it('askLlm 은 start → delta* → end 를 동일 streamId 로 방출하고 end 에 영속 메시지를 싣는다', async () => {
    const events: ChatStreamEvent[] = []
    const engine = createFleetEngine({ runner: streamRunner, onChatStream: (e) => events.push(e) })
    engine.registerCliSession('claude')
    const room = engine.createRoom('방', ['cli:claude'])
    engine.postUserMessage(room.id, '안녕?')

    const msg = await engine.askLlm(room.id, 'cli:claude')

    // 방 단위 busy/idle 봉투를 제외한 스트림 이벤트만으로 발언 시퀀스를 검증한다.
    const streamEvents = events.filter(hasStreamId)
    expect(streamEvents[0].kind).toBe('start')
    const sid = streamEvents[0].streamId
    expect(streamEvents.every((e) => e.streamId === sid)).toBe(true) // 한 발언 = 한 streamId

    const deltas = streamEvents.flatMap((e) => (e.kind === 'delta' ? [e.delta] : []))
    expect(deltas).toEqual(['안', '녕']) // 토큰 델타 순서 보존
    const deltaSeqs = streamEvents.flatMap((e) => (e.kind === 'delta' ? [e.seq] : []))
    expect(deltaSeqs).toEqual([1, 2]) // streamId 별 1부터 증가(렌더러 멱등·레이스 정렬용)

    const end = streamEvents.at(-1)
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

    const streamEvents = events.filter(hasStreamId)
    expect(streamEvents[0].kind).toBe('start')
    const last = streamEvents.at(-1)
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

    const streamEvents = events.filter(hasStreamId)
    const deltas = streamEvents.flatMap((e) => (e.kind === 'delta' ? [e.delta] : []))
    expect(deltas).toEqual(['전체응답']) // 정확히 1회, 전체 텍스트
    expect(deltas[0]).toBe(msg.content) // delta = 영속 메시지 본문
    expect(streamEvents[0].kind).toBe('start')
    expect(streamEvents.at(-1)?.kind).toBe('end')
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

  it('도구 루프 발언이 kind:"tool" 단계 이벤트(running→ok)를 방출한다 (#10 SP3)', async () => {
    const pingTool: FleetTool = {
      definition: { name: 'mcp__demo__ping', parameters: { type: 'object' } },
      classify: () => 'safe',
      async execute() {
        return 'pong'
      },
    }
    const fakeMcpHost: McpHost = {
      async setServers() {
        return []
      },
      tools: () => [pingTool],
      status: () => [],
      async dispose() {},
    }
    const { http } = scriptedHttp([
      JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__demo__ping', input: {} }],
        stop_reason: 'tool_use',
      }),
      JSON.stringify({ content: [{ type: 'text', text: '끝' }], stop_reason: 'end_turn' }),
    ])
    const events: ChatStreamEvent[] = []
    const engine = createFleetEngine({ http, mcpHost: fakeMcpHost, onChatStream: (e) => events.push(e) })
    engine.registerApiSession({ id: 'a', provider: 'anthropic', displayName: 'A', model: 'claude-sonnet-4-6', apiKey: 'k' })
    const room = engine.createRoom('r', ['api:a'])
    await engine.askLlm(room.id, 'api:a')

    const toolEvents = events.filter((e): e is Extract<ChatStreamEvent, { kind: 'tool' }> => e.kind === 'tool')
    expect(toolEvents.map((e) => e.step.phase)).toEqual(['running', 'ok'])
    expect(toolEvents[0].step).toMatchObject({ id: 'tu1', name: 'mcp__demo__ping', phase: 'running' })
    // seq 는 텍스트 델타와 공유 카운터로 단조 증가한다.
    expect(toolEvents[1].seq).toBeGreaterThan(toolEvents[0].seq)
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

describe('FleetEngine 채팅 진행 상태(getChatActivity / busy·idle)', () => {
  it('초기 상태는 진행 중 방도 라이브 스트림도 없다', () => {
    const engine = createFleetEngine()
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })
  })

  it('in-flight 발언 동안 방을 busy 로, 누적 델타 텍스트를 스트림으로 노출하고 완료 후 비운다', async () => {
    const events: ChatStreamEvent[] = []
    const sessions = createSessionManager()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    sessions.add({
      id: 'a',
      descriptor: { id: 'a', kind: 'api', displayName: 'A', ref: 'a', model: '' },
      async send(_prompt, opts) {
        opts?.onChunk?.('부분텍스트') // 델타 1회 흘린 뒤 gate 가 풀릴 때까지 in-flight 유지
        await gate
        return '부분텍스트'
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ sessions, onChatStream: (e) => events.push(e) })
    const room = engine.createRoom('방', ['a'])

    const p = engine.askLlm(room.id, 'a') // await 하지 않고 in-flight 로 띄움
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'delta')).toBe(true))

    const mid = engine.getChatActivity()
    expect(mid.busyRooms).toEqual([room.id])
    expect(mid.streams).toHaveLength(1)
    expect(mid.streams[0]).toMatchObject({ roomId: room.id, llmId: 'a', text: '부분텍스트', seq: 1 })

    release()
    await p
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })
  })

  it('in-flight 도구 단계를 steps 로 노출하고 id 로 in-place 갱신한다 (#10 SP3)', async () => {
    const events: ChatStreamEvent[] = []
    const sessions = createSessionManager()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    sessions.add({
      id: 'a',
      descriptor: { id: 'a', kind: 'api', displayName: 'A', ref: 'a', model: '' },
      async send(_prompt, opts) {
        opts?.onToolStep?.({ id: 'tu1', name: 'read_file', phase: 'running', risk: 'safe' })
        opts?.onToolStep?.({ id: 'tu1', name: 'read_file', phase: 'ok' }) // 같은 id → in-place 갱신
        await gate
        return '응답'
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ sessions, onChatStream: (e) => events.push(e) })
    const room = engine.createRoom('방', ['a'])

    const p = engine.askLlm(room.id, 'a')
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'tool')).toBe(true))

    const mid = engine.getChatActivity()
    expect(mid.streams[0].steps).toEqual([{ id: 'tu1', name: 'read_file', phase: 'ok' }]) // 1개로 합쳐짐
    expect(mid.streams[0].seq).toBe(2) // running·ok 2 이벤트 공유 카운터

    release()
    await p
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })
  })

  it('방 단위 busy/idle 이벤트를 진행 경계에서 방출한다(start 전 busy, end 후 idle)', async () => {
    const events: ChatStreamEvent[] = []
    const engine = createFleetEngine({
      runner: async () => ({ code: 0, stdout: '응답', stderr: '' }),
      onChatStream: (e) => events.push(e),
    })
    engine.registerCliSession('claude')
    const room = engine.createRoom('방', ['cli:claude'])

    await engine.askLlm(room.id, 'cli:claude')

    expect(events[0].kind).toBe('busy') // 진행 시작 경계 — start 보다 먼저
    expect(events.at(-1)?.kind).toBe('idle') // 진행 종료 경계 — end 보다 나중
    const busy = events.find((e) => e.kind === 'busy')
    expect(busy?.kind === 'busy' && busy.roomId).toBe(room.id)
  })

  it('discuss 는 여러 턴 내내 단일 busy 구간을 유지한다(턴 사이 idle 깜빡임 없음)', async () => {
    const events: ChatStreamEvent[] = []
    const engine = createFleetEngine({
      runner: async () => ({ code: 0, stdout: '응답', stderr: '' }),
      onChatStream: (e) => events.push(e),
    })
    engine.registerCliSession('claude')
    engine.registerCliSession('codex')
    const room = engine.createRoom('방', ['cli:claude', 'cli:codex'])

    await engine.discussRoom(room.id, ['cli:claude', 'cli:codex'], 2)

    // 4 턴(2 LLM × 2 라운드)이어도 busy/idle 은 정확히 1회씩(전체 토론 경계).
    expect(events.filter((e) => e.kind === 'busy')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'idle')).toHaveLength(1)
    expect(events[0].kind).toBe('busy')
    expect(events.at(-1)?.kind).toBe('idle')
  })

  it('발언이 실패해도 idle 로 진행 상태를 정리한다(finally 경로)', async () => {
    const events: ChatStreamEvent[] = []
    const sessions = createSessionManager()
    sessions.add({
      id: 'bad',
      descriptor: { id: 'bad', kind: 'api', displayName: 'bad', ref: 'bad', model: '' },
      async send() {
        throw new Error('boom')
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ sessions, onChatStream: (e) => events.push(e) })
    const room = engine.createRoom('방', ['bad'])

    await expect(engine.askLlm(room.id, 'bad')).rejects.toThrow('boom')

    expect(events.at(-1)?.kind).toBe('idle')
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })
  })
})

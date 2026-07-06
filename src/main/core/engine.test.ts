import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRole, ChatStreamEvent, OrchestratorEvent } from '../../shared/types'
import { MAX_REPLAN_ROUNDS, MAX_CONCURRENCY } from '../../shared/types'
import type { CommandRunner } from './cli/detect'
import { createFleetEngine, clampConcurrency } from './engine'
import type { McpHost } from './mcp/types'
import type { HttpClient } from './providers/types'
import { createSessionManager } from './session/manager'
import type { FleetTool } from './tools/types'
import { createMemoryStore } from './store/memory'
import { createJsonFileStore } from './store/json-file'
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
      if (sub === 'rev-parse' && args.includes('--is-inside-work-tree'))
        return { code: 0, stdout: 'true', stderr: '' }
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
      if (sub === 'reset' || sub === 'clean' || sub === 'init')
        return { code: 0, stdout: '', stderr: '' }
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

/** 가역 fake SecretCrypto — base64 왕복 + v1: 프리픽스. 테스트에서 평문/암호문 대조용. */
function fakeCrypto(available = true): import('./secret/types').SecretCrypto {
  return {
    isAvailable: () => available,
    encrypt: (p) => 'v1:' + Buffer.from(p, 'utf8').toString('base64'),
    decrypt: (t) => {
      if (!t.startsWith('v1:')) throw new Error('bad token')
      return Buffer.from(t.slice(3), 'base64').toString('utf8')
    },
  }
}

/** Authorization 헤더를 캡처하고 유효한 openai 응답을 돌려주는 http(복원 키 왕복 검증용). */
function authCapturingHttp(): { http: HttpClient; authHeaders: string[] } {
  const authHeaders: string[] = []
  const http: HttpClient = async (_url, init) => {
    authHeaders.push(init.headers['authorization'] ?? '')
    return {
      ok: true,
      status: 200,
      text: async () => '{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}',
    }
  }
  return { http, authHeaders }
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
  if (prompt.includes('분해'))
    return { code: 0, stdout: '[{"title":"작업1","description":"d1"}]', stderr: '' }
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

  it('probeCli: 알려진 adapter 는 probeCliAuth 결과를 반환한다', async () => {
    const engine = createFleetEngine({
      runner: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    })
    expect(await engine.probeCli('claude')).toEqual({ status: 'ok' })
  })

  it('probeCli: unknown adapterId → throw 없이 {status:error}', async () => {
    const engine = createFleetEngine({
      runner: async () => ({ code: 0, stdout: '', stderr: '' }),
    })
    const r = await engine.probeCli('nope')
    expect(r.status).toBe('error')
  })

  it('probeCli: 동일 adapter 동시 호출은 dedupe(실 호출 1회) — 언마운트/재클릭 이중과금 방지', async () => {
    let calls = 0
    let resolveRun!: (r: { code: number; stdout: string; stderr: string }) => void
    const runner: CommandRunner = () => {
      calls++
      return new Promise((res) => {
        resolveRun = res
      })
    }
    const engine = createFleetEngine({ runner })
    const p1 = engine.probeCli('claude')
    const p2 = engine.probeCli('claude')
    resolveRun({ code: 0, stdout: 'ok', stderr: '' })
    expect(await p1).toEqual({ status: 'ok' })
    expect(await p2).toEqual({ status: 'ok' })
    expect(calls).toBe(1)
  })

  it('dispose: in-flight probe 의 signal 을 abort 한다(종료 시 orphan 방지)', async () => {
    let captured: AbortSignal | undefined
    const runner: CommandRunner = (_c, _a, opts) => {
      captured = opts.signal
      return new Promise(() => {}) // 종료 전까지 미정착
    }
    const engine = createFleetEngine({ runner })
    void engine.probeCli('claude')
    expect(captured?.aborted).toBe(false)
    await engine.dispose()
    expect(captured?.aborted).toBe(true)
  })

  // #197-B6 T3 — 엔진이 spawn 하는 자식별로 childEnv 카테고리를 배선한다: detect/probe=base·CLI 세션=cliSession.
  // 미주입이면 opts.env=undefined(데스크톱 무회귀). 카테고리 라우팅을 fake runner 로 검증(실 stripping 은
  // child-env.test.ts·verify/git 실 spawn 테스트가 담당).
  describe('childEnv 스레딩(#197-B6 T3)', () => {
    const capture = () => {
      const calls: { command: string; env: NodeJS.ProcessEnv | undefined }[] = []
      const runner: CommandRunner = async (command, _args, opts) => {
        calls.push({ command, env: opts.env })
        return { code: 0, stdout: 'ok', stderr: '' }
      }
      return { calls, runner }
    }
    const childEnv = {
      base: () => ({ CATEGORY: 'base' }),
      cliSession: () => ({ CATEGORY: 'cli' }),
    }

    it('미주입이면 자식 runner 의 opts.env 가 undefined 다(데스크톱 무회귀 특성화)', async () => {
      const { calls, runner } = capture()
      await createFleetEngine({ runner }).detectClis()
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((c) => c.env === undefined)).toBe(true)
    })

    it('detect 는 base 카테고리 env 를 받는다(provider 키 없음)', async () => {
      const { calls, runner } = capture()
      await createFleetEngine({ runner, childEnv }).detectClis()
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((c) => c.env?.CATEGORY === 'base')).toBe(true)
    })

    it('probe 는 base 카테고리 env 를 받는다', async () => {
      const { calls, runner } = capture()
      await createFleetEngine({ runner, childEnv }).probeCli('claude')
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((c) => c.env?.CATEGORY === 'base')).toBe(true)
    })

    it('CLI 세션 send 는 cliSession 카테고리 env(provider 키 포함)를 받는다', async () => {
      const { calls, runner } = capture()
      const engine = createFleetEngine({ runner, childEnv })
      engine.registerCliSession('claude')
      const room = engine.createRoom('방', ['cli:claude'])
      engine.postUserMessage(room.id, '안녕')
      await engine.askLlm(room.id, 'cli:claude')
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((c) => c.env?.CATEGORY === 'cli')).toBe(true)
    })

    // #197-B6 T4 — MCP stdio 자식은 base 카테고리(provider 키 없음)만 받아야 한다. 실 spawn 으로 자식이
    // 자기 env 를 파일에 덤프하게 해, 엔진이 childEnv.base 를 MCP spawn 에 배선했는지(잘못된 cliSession
    // 배선·미배선 모두 감지) 검증한다. spec.env(escape hatch)는 병합돼 도달.
    it('MCP 자식은 base 카테고리 env 를 받는다(provider 키·FLEET_* 미상속) — 실 spawn 통합', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fleet-mcpenv-'))
      const envFile = join(dir, 'env.json')
      const win =
        process.platform === 'win32'
          ? {
              SystemRoot: process.env.SystemRoot,
              PATHEXT: process.env.PATHEXT,
              ComSpec: process.env.ComSpec,
            }
          : {}
      const mcpChildEnv = {
        base: (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, T4_MARK: 'base', ...win }),
        cliSession: (): NodeJS.ProcessEnv => ({
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: 'should-not-reach-mcp',
          ...win,
        }),
      }
      process.env.FLEET_SECRET_KEY = 'server-secret'
      const engine = createFleetEngine({ childEnv: mcpChildEnv, approver: async () => true })
      try {
        await engine.setMcpServers([
          {
            name: 'envdump',
            command: 'node',
            args: [
              '-e',
              'require("fs").writeFileSync(process.env.T4_ENVFILE,JSON.stringify(process.env));process.exit(0)',
            ],
            env: { T4_ENVFILE: envFile },
          },
        ])
        const env = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>
        expect(env.T4_MARK).toBe('base') // base 카테고리 적용
        expect(env.T4_ENVFILE).toBe(envFile) // spec.env(escape hatch) 병합
        expect(env.FLEET_SECRET_KEY).toBeUndefined() // 서버 시크릿 미상속
        expect(env.ANTHROPIC_API_KEY).toBeUndefined() // base 이므로 provider 키 없음(cliSession 오배선 감지)
      } finally {
        delete process.env.FLEET_SECRET_KEY
        await engine.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20_000)
  })

  it('runs a full project flow through registered CLI sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-flow-'))
    try {
      const store = createMemoryStore(deterministic())
      const engine = createFleetEngine({
        store,
        runner: roleRunner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        // verify 는 mock — 실제 npm spawn 회피(이 테스트는 플로우 구조 검증; 실 verify 동작은 verify/run.test.ts 담당).
        verifyRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
      })
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
      engine.registerApiSession({
        id: 'a',
        provider: 'openai',
        displayName: 'GPT',
        model: 'm',
        apiKey: 'k',
      })
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
      const engine = createFleetEngine({
        store,
        runner: roleRunner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        // verify 는 mock — 실제 npm spawn 회피(이 테스트는 재배정 로직 검증; 실 verify 동작은 verify/run.test.ts 담당).
        verifyRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
      })
      engine.registerCliSession('claude') // cli:claude — 유일한 CLI
      engine.registerApiSession({
        id: 'a',
        provider: 'openai',
        displayName: 'GPT',
        model: 'm',
        apiKey: 'k',
      })

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
      expect(store.listEvents().some((e) => e.type === 'assignment.implementer_reassigned')).toBe(
        true,
      )
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
        descriptor: {
          id: 'cli:claude',
          kind: 'cli',
          displayName: 'Claude',
          ref: 'claude',
          model: '',
          capabilities: ['planner', 'implementer', 'reviewer', 'summarizer'],
        },
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

      const events: OrchestratorEvent[] = []
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
      // #197 B1: cancelRun 도 emit() 과 동형으로 영속 seq 를 라이브에 실어야 한다(재접속 커서 계약).
      expect(typeof liveCancel?.seq).toBe('number')
      expect(liveCancel?.seq).toBe(persistedCancel?.seq)
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

  // 구현(워크스페이스) 호출이 abort 까지 hang 하는 세션 — in-flight 실행 시뮬레이션용.
  function hangingImplSession(onAbort?: () => void) {
    return {
      id: 'cli:claude',
      descriptor: {
        id: 'cli:claude',
        kind: 'cli' as const,
        displayName: 'Claude',
        ref: 'claude',
        model: '',
        capabilities: ['planner', 'implementer', 'reviewer', 'summarizer'] as AgentRole[],
      },
      async send(prompt: string, opts?: { workspace?: string; signal?: AbortSignal }) {
        if (prompt.includes('분해')) return '[{"title":"작업1","description":"d1"}]'
        if (prompt.includes('검토')) return 'APPROVE'
        if (prompt.includes('누락')) return '요약'
        if (opts?.workspace) {
          return await new Promise<string>((_resolve, reject) => {
            const signal = opts.signal
            const fail = () => {
              onAbort?.()
              reject(new Error('aborted'))
            }
            if (signal?.aborted) return fail()
            signal?.addEventListener('abort', fail, { once: true })
          })
        }
        return '응답'
      },
      async dispose() {},
    }
  }

  const waitForCreated = (events: { type: string; data?: Record<string, unknown> }[]) =>
    new Promise<string>((resolve) => {
      const timer = setInterval(() => {
        const id = events.find((e) => e.type === 'project.created')?.data?.['projectId']
        if (typeof id === 'string') {
          clearInterval(timer)
          resolve(id)
        }
      }, 5)
    })

  it('dispose 는 진행 중 실행을 abort 한다(종료 중 run 이 워크스페이스를 계속 건드리지 않게)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-dispose-abort-'))
    try {
      const store = createMemoryStore(deterministic())
      const sessions = createSessionManager()
      let implAborted = false
      sessions.add(
        hangingImplSession(() => {
          implAborted = true
        }),
      )
      const events: { type: string; data?: Record<string, unknown> }[] = []
      const engine = createFleetEngine({
        store,
        sessions,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        onOrchestratorEvent: (e) => events.push(e),
      })

      const runPromise = engine.runProjectFlow({ goal: 'g' })
      await waitForCreated(events) // 구현 호출이 hang 상태가 되도록 진행을 기다린다

      await engine.dispose() // activeRuns 를 abort 해야 hang 중인 구현 호출이 풀린다
      // 미수정(dispose 가 abort 안 함) 시 abort 가 전파되지 않아 ~3s 만에 명시적 단언 실패(10s hang 회피).
      await vi.waitFor(() => expect(implAborted).toBe(true), { timeout: 3000, interval: 20 })
      const result = await runPromise // abort 가 전파됐으므로 곧 resolve

      expect(result.tasks[0].status).not.toBe('done')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('runProjectFlow 는 진행 중 실행이 있으면 두 번째 동시 실행을 거부한다(동시 편집 → 워크스페이스 파괴 방지)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-concurrent-'))
    try {
      const store = createMemoryStore(deterministic())
      const sessions = createSessionManager()
      sessions.add(hangingImplSession())
      const events: { type: string; data?: Record<string, unknown> }[] = []
      const engine = createFleetEngine({
        store,
        sessions,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        onOrchestratorEvent: (e) => events.push(e),
      })

      const first = engine.runProjectFlow({ goal: 'g1' })
      const pid = await waitForCreated(events) // 첫 실행이 activeRuns 에 등록될 때까지 대기

      // 두 번째 동시 실행은 즉시(동기 가드로) 거부되어야 한다. 미수정(가드 없음) 시 두 번째가 hang 하므로
      // 짧은 가드 타임아웃과 race 해 10s 대신 ~1.5s 만에 빠른 실패 신호를 낸다.
      const second = engine.runProjectFlow({ goal: 'g2' }).then(
        () => 'resolved-without-guard',
        (e: Error) => e,
      )
      const outcome = await Promise.race([
        second,
        new Promise<string>((r) => setTimeout(() => r('hung-without-guard'), 1500)),
      ])
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toMatch(/진행 중/)

      engine.cancelRun(pid) // 정리: 첫 실행 취소
      await first
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('getRunActivity 는 진행 중 실행이 없으면 빈 목록을 반환한다', () => {
    const store = createMemoryStore(deterministic())
    const sessions = createSessionManager()
    const engine = createFleetEngine({ store, sessions })
    expect(engine.getRunActivity()).toEqual({ activeProjectIds: [] })
  })

  it('getRunActivity 는 진행 중 실행의 projectId 를 스냅샷으로 반환하고 취소 후 비운다(재마운트 복원 권위 소스)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-run-activity-'))
    try {
      const store = createMemoryStore(deterministic())
      const sessions = createSessionManager()
      sessions.add(hangingImplSession())
      const events: { type: string; data?: Record<string, unknown> }[] = []
      const engine = createFleetEngine({
        store,
        sessions,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        onOrchestratorEvent: (e) => events.push(e),
      })

      const run = engine.runProjectFlow({ goal: 'g' })
      const pid = await waitForCreated(events) // project.created 에서 activeRuns 에 등록될 때까지 대기

      // 진행 중: 스냅샷에 in-flight projectId 가 잡혀야 재마운트한 렌더러가 취소 버튼·running 을 복원한다.
      expect(engine.getRunActivity()).toEqual({ activeProjectIds: [pid] })

      engine.cancelRun(pid) // 취소(abort) → revert 후 project.done 에서 activeRuns 제거
      await run
      // 종료 후엔 비어야 한다(스테일 "진행 중" 표시 방지).
      expect(engine.getRunActivity()).toEqual({ activeProjectIds: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('cancelRun 은 abort 만 하고 revert 완료(project.done)까지 실행을 활성으로 유지한다(취소 정리 중 두 번째 실행 차단)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-cancel-window-'))
    try {
      const store = createMemoryStore(deterministic())
      const sessions = createSessionManager()
      sessions.add(hangingImplSession())
      const events: { type: string; data?: Record<string, unknown> }[] = []
      const engine = createFleetEngine({
        store,
        sessions,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        onOrchestratorEvent: (e) => events.push(e),
      })

      const run = engine.runProjectFlow({ goal: 'g' })
      const pid = await waitForCreated(events)

      engine.cancelRun(pid) // abort — 즉시 제거하지 않는다(실행이 아직 revert 중)
      // 취소 정리 윈도우: 실행이 워크스페이스를 revert 하며 unwinding 중이므로 스냅샷·가드가 활성을 유지해야 한다.
      expect(engine.getRunActivity()).toEqual({ activeProjectIds: [pid] })
      // 두 번째 동시 실행은 정리 윈도우 중에도 거부된다(revert 와 경합 → 워크스페이스 파괴 방지).
      await expect(engine.runProjectFlow({ goal: 'g2' })).rejects.toThrow(/진행 중/)

      await run // revert 완료 → project.done → activeRuns 제거
      expect(engine.getRunActivity()).toEqual({ activeProjectIds: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('cancelRun 중복 호출은 무해한 no-op 이다(중복 run.cancelled 미방출)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-double-cancel-'))
    try {
      const store = createMemoryStore(deterministic())
      const sessions = createSessionManager()
      sessions.add(hangingImplSession())
      const events: { type: string; data?: Record<string, unknown> }[] = []
      const engine = createFleetEngine({
        store,
        sessions,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        onOrchestratorEvent: (e) => events.push(e),
      })

      const run = engine.runProjectFlow({ goal: 'g' })
      const pid = await waitForCreated(events)

      engine.cancelRun(pid)
      engine.cancelRun(pid) // 이미 abort 됨 → no-op(중복 취소 이벤트 방지)
      await run

      expect(events.filter((e) => e.type === 'run.cancelled')).toHaveLength(1)
      expect(engine.listEvents().filter((e) => e.type === 'run.cancelled')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('runs the implementer as a direct-edit agent in the workspace and verifies when workspaceDir is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-engine-'))
    try {
      // 편집 모드(opts.cwd 지정)에서 에이전트가 워크스페이스에 파일을 직접 만든다 → 실제 git diff 발생.
      const runner: CommandRunner = async (_cmd, args, opts) => {
        const prompt = [...args, opts.stdinInput ?? ''].join(' ')
        // planner·reviewer 둘 다 구조화 출력 JSON 을 요청하므로 planner 는 '분해', reviewer 는 '검토' 로 판별한다.
        if (prompt.includes('분해'))
          return { code: 0, stdout: '[{"title":"작업1","description":"d1"}]', stderr: '' }
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

  // Now ④(#12): maxReplanRounds 가 IPC→engine→runProject 로 배선됐는지 검증.
  // verifyRunner 가 항상 실패하면 verify-fix(기본 2회) 소진 후 보정 replan 단계에 도달한다.
  // maxReplanRounds 가 orchestrator 까지 전달돼야만 replan 이벤트가 방출된다(배선 증거).
  it('forwards maxReplanRounds so the orchestrator replans when verification keeps failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-replan-'))
    try {
      const store = createMemoryStore(deterministic())
      const events: OrchestratorEvent[] = []
      const engine = createFleetEngine({
        store,
        runner: roleRunner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        verifyRunner: async () => ({ code: 1, stdout: '', stderr: 'boom' }), // 항상 실패 → verify-fix 소진 후 replan
        onOrchestratorEvent: (e) => events.push(e),
      })
      engine.registerCliSession('claude')

      const result = await engine.runProjectFlow({ goal: 'g', maxReplanRounds: 1 })

      // 단순 이벤트 존재가 아니라 '보정 작업 추가' 분기(count>=1)가 실제로 발화됐는지 단언한다 —
      // maxReplanRounds 가 orchestrator 까지 배선돼 planCorrectiveTasks 가 호출됐다는 결정적 증거.
      expect(
        events.some(
          (e) =>
            e.type === 'replan' &&
            typeof e.data?.['count'] === 'number' &&
            (e.data['count'] as number) >= 1,
        ),
      ).toBe(true)
      // append-only: 초기 작업(1) + 보정 작업(>=1)으로 작업 수가 늘어난다.
      expect(engine.getProjectTasks(result.projectId).length).toBeGreaterThan(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not replan when maxReplanRounds is unset (production default 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-noreplan-'))
    try {
      const store = createMemoryStore(deterministic())
      const events: OrchestratorEvent[] = []
      const engine = createFleetEngine({
        store,
        runner: roleRunner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        verifyRunner: async () => ({ code: 1, stdout: '', stderr: 'boom' }), // 항상 실패
        onOrchestratorEvent: (e) => events.push(e),
      })
      engine.registerCliSession('claude')

      await engine.runProjectFlow({ goal: 'g' }) // maxReplanRounds 미지정 → 기본 0(비활성)

      expect(events.some((e) => e.type === 'replan')).toBe(false) // 보정 replan 미시도
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // codex P2: 렌더러는 main 기준 신뢰 경계 바깥 — devtools/커스텀 렌더러가 UI 셀렉트(0..MAX)를 우회해
  // 임의 큰 maxReplanRounds 로 runaway 사이클을 돌리지 못하도록 engine 경계에서 상한을 강제한다.
  it('clamps an over-range maxReplanRounds to MAX_REPLAN_ROUNDS at the engine boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-clamp-'))
    try {
      const store = createMemoryStore(deterministic())
      const events: OrchestratorEvent[] = []
      const engine = createFleetEngine({
        store,
        runner: roleRunner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        verifyRunner: async () => ({ code: 1, stdout: '', stderr: 'boom' }), // 항상 실패 → replan 이 상한까지 반복
        onOrchestratorEvent: (e) => events.push(e),
      })
      engine.registerCliSession('claude')

      // UI 최대(MAX)를 훌쩍 넘는 값을 직접 주입(렌더러 우회 시나리오).
      await engine.runProjectFlow({ goal: 'g', maxReplanRounds: MAX_REPLAN_ROUNDS + 2 })

      // 검증이 매번 실패하므로 replan 은 상한 라운드만큼만 돌아야 한다(라운드당 'replan' 1회 방출).
      expect(events.filter((e) => e.type === 'replan').length).toBe(MAX_REPLAN_ROUNDS)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // #197 B1: 영속 라이브 orchestrator 이벤트는 store 가 배정한 단조 seq 를 실어(재접속 커서용),
  // 영속본(FleetEvent.seq)과 일치하고 방출 순서로 단조·유일하다.
  it('stamps monotonic seq on persisted live orchestrator events matching FleetEvent.seq', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-seq-live-'))
    try {
      const store = createMemoryStore(deterministic())
      const events: OrchestratorEvent[] = []
      const engine = createFleetEngine({
        store,
        runner: roleRunner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        verifyRunner: async () => ({ code: 0, stdout: '', stderr: '' }), // 실 npm 검증 회피(테스트 속도)
        onOrchestratorEvent: (e) => events.push(e),
      })
      engine.registerCliSession('claude')

      await engine.runProjectFlow({ goal: 'g' })

      const persistedSeqById = new Map(store.listEvents().map((e) => [e.id, e.seq]))
      const livePersisted = events.filter((e) => e.type !== 'task.progress')
      expect(livePersisted.length).toBeGreaterThan(0)
      for (const e of livePersisted) {
        expect(typeof e.seq).toBe('number') // 영속 이벤트는 seq 보유
        // 라이브가 실은 seq 는 그 이벤트의 영속본(data.eventId 로 매칭) seq 와 일치
        expect(e.seq).toBe(persistedSeqById.get(e.data?.['eventId'] as string))
      }
      const seqs = livePersisted.map((e) => e.seq as number)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // 방출 순서 단조
      expect(new Set(seqs).size).toBe(seqs.length) // 유일
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // #197 B1: 비영속 task.progress(토큰 델타) 라이브 이벤트에는 seq 를 스탬프하지 않는다
  // (재접속 재생 불가 = 명시적 비범위 — RunActivity 스냅숏이 상태 권위).
  it('does not stamp seq on non-persisted task.progress live events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-seq-progress-'))
    try {
      const store = createMemoryStore(deterministic())
      const sessions = createSessionManager()
      sessions.add({
        id: 'cli:claude',
        descriptor: {
          id: 'cli:claude',
          kind: 'cli',
          displayName: 'Claude',
          ref: 'claude',
          model: '',
          capabilities: ['planner', 'implementer', 'reviewer', 'summarizer'],
        },
        async send(prompt, opts) {
          if (prompt.includes('분해')) return '[{"title":"작업1","description":"d1"}]'
          if (prompt.includes('검토')) return 'APPROVE'
          if (prompt.includes('누락')) return '요약'
          // 구현 호출: 델타 토큰을 흘려 task.progress 를 유발한 뒤 파일을 만들어 diff 를 발생시킨다.
          if (opts?.workspace) {
            opts.onChunk?.('토큰델타')
            writeFileSync(join(opts.workspace, 'impl.txt'), '구현 결과물')
          }
          return '구현 결과물'
        },
        async dispose() {},
      })
      const events: OrchestratorEvent[] = []
      const engine = createFleetEngine({
        store,
        sessions,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        verifyRunner: async () => ({ code: 0, stdout: '', stderr: '' }), // 실 npm 검증 회피(테스트 속도)
        onOrchestratorEvent: (e) => events.push(e),
      })

      await engine.runProjectFlow({ goal: 'g' })

      const progress = events.filter((e) => e.type === 'task.progress')
      expect(progress.length).toBeGreaterThan(0) // 델타가 실제로 흘렀다
      for (const e of progress) expect(e.seq).toBeUndefined() // 비영속 → 무스탬프
      // 대조군: 영속 이벤트는 seq 보유
      const persisted = events.filter((e) => e.type !== 'task.progress')
      expect(persisted.every((e) => typeof e.seq === 'number')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ④ maxConcurrency 가 IPC→engine→runProject 로 배선됐는지 검증.
  // engine 경계에서 정수화·[1,MAX_CONCURRENCY] clamp 후 orchestrator 에 전달.
  // 순수함수 clampConcurrency 로 단위 테스트한다(engine 통합 하네스 대신).
  describe('clampConcurrency', () => {
    it.each([
      ['over-range → MAX_CONCURRENCY', 7, MAX_CONCURRENCY],
      ['under-range → 1', 0, 1],
      ['정수 범위 → floor', 2.9, 2],
      ['미지정 → 1(기본)', undefined, 1],
      ['음수 → 1(하한)', -5, 1],
      ['정상 범위: 1', 1, 1],
      ['정상 범위: 2', 2, 2],
      ['정상 범위: 3', 3, 3],
      ['정상 범위: 4', 4, 4],
      ['NaN → 1', NaN, 1],
      ['Infinity → 1', Infinity, 1],
      ['-Infinity → 1', -Infinity, 1],
    ])('%s', (_desc: string, input: number | undefined, expected: number) => {
      expect(clampConcurrency(input)).toBe(expected)
    })
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
        if (p.includes('분해'))
          return { code: 0, stdout: '[{"title":"T","description":"d"}]', stderr: '' }
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
    const d = engine.registerApiSession({
      id: 'a',
      provider: 'google',
      displayName: 'g',
      model: 'm',
      apiKey: 'k',
    })
    expect(d.capabilities?.length).toBeGreaterThan(0)
  })

  it('openai-compatible 세션도 빈 capabilities 가 아니라 implementer 로 시드된다', () => {
    const engine = createFleetEngine()
    const d = engine.registerApiSession({
      id: 'oc',
      provider: 'openai-compatible',
      displayName: 'OC',
      model: 'x',
      apiKey: 'k',
      baseUrl: 'https://x/v1',
    })
    expect(d.capabilities).toEqual(['implementer'])
  })

  it('capability-scored routes a role to the session that lists it and records assignedLlmId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-cap-'))
    try {
      const store = createMemoryStore(deterministic())
      const engine = createFleetEngine({
        store,
        runner: roleRunner,
        workspaceDir: dir,
        gitRunner: fakeGit(),
        // verify 는 mock — 실제 npm spawn 회피(이 테스트는 capability-scored 배정 검증; 실 verify 동작은 verify/run.test.ts 담당).
        verifyRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
      })
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
    const engine = createFleetEngine({
      runner: async () => ({ code: 0, stdout: 'LLM 답변', stderr: '' }),
    })
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

  it('도구 루프 반복에서도 세션 thinking 기본값이 매 호출 유지된다 (#11-thinking 활성화)', async () => {
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
      JSON.stringify({ content: [{ type: 'text', text: '끝' }], stop_reason: 'end_turn' }),
    ])
    const engine = createFleetEngine({ http, mcpHost: fakeMcpHost })
    engine.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'A',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
      thinking: { effort: 'high' },
    })
    const room = engine.createRoom('r', ['api:a'])
    await engine.askLlm(room.id, 'api:a')

    expect(calls).toHaveLength(2) // 도구 왕복 = chat 2회 — 두 호출 모두 thinking 유지
    for (const c of calls) {
      const body = JSON.parse(c) as { thinking?: unknown; output_config?: { effort?: string } }
      expect(body.thinking).toEqual({ type: 'adaptive' }) // sonnet-4-6: display 생략(4.7 도입 필드)
      expect(body.output_config?.effort).toBe('high')
    }
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
    engine.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'A',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
    })
    const room = engine.createRoom('r', ['api:a'])
    const msg = await engine.askLlm(room.id, 'api:a')

    expect(msg.content).toBe('응답 완료')
    expect(calls).toHaveLength(2) // 도구 왕복 = chat 2회
    expect(calls[1]).toContain('pong') // 2번째 요청에 tool_result 포함
  })

  it("API 세션 send 가 토큰 사용량을 'usage' 이벤트로 기록한다 (usage-accounting)", async () => {
    const store = createMemoryStore(deterministic())
    const { http } = scriptedHttp([
      JSON.stringify({
        content: [{ type: 'text', text: '응답' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 4 },
      }),
    ])
    const engine = createFleetEngine({ store, http })
    engine.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'A',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
    })
    const room = engine.createRoom('r', ['api:a'])
    await engine.askLlm(room.id, 'api:a')

    const usageEvents = store.listEvents().filter((e) => e.type === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].data).toMatchObject({
      id: 'api:a',
      provider: 'anthropic',
      inputTokens: 11,
      outputTokens: 4,
    })
  })

  it("도구 루프 API 세션은 합산된 토큰 사용량을 'usage' 이벤트로 기록한다 (usage-accounting)", async () => {
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
    const store = createMemoryStore(deterministic())
    const { http } = scriptedHttp([
      JSON.stringify({
        content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__demo__ping', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 6 },
      }),
      JSON.stringify({
        content: [{ type: 'text', text: '끝' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 9 },
      }),
    ])
    const engine = createFleetEngine({ store, http, mcpHost: fakeMcpHost })
    engine.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'A',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
    })
    const room = engine.createRoom('r', ['api:a'])
    await engine.askLlm(room.id, 'api:a')

    const usageEvents = store.listEvents().filter((e) => e.type === 'usage')
    expect(usageEvents).toHaveLength(1) // send 1회 → 도구 왕복 2 chat 을 합산한 단일 usage 이벤트
    expect(usageEvents[0].data).toMatchObject({
      id: 'api:a',
      provider: 'anthropic',
      inputTokens: 40,
      outputTokens: 15,
    })
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
          content: [
            { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'note.txt' } },
          ],
          stop_reason: 'tool_use',
        }),
        JSON.stringify({ content: [{ type: 'text', text: '확인 완료' }], stop_reason: 'end_turn' }),
      ])
      const engine = createFleetEngine({ http })
      engine.setWorkspace(dir)
      engine.registerApiSession({
        id: 'a',
        provider: 'anthropic',
        displayName: 'A',
        model: 'claude-sonnet-4-6',
        apiKey: 'k',
      })
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
  e.kind === 'start' ||
  e.kind === 'delta' ||
  e.kind === 'tool' ||
  e.kind === 'end' ||
  e.kind === 'error'

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
    const codexLine =
      '{"type":"item.completed","item":{"type":"agent_message","text":"코덱스 응답"}}'
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
    const engine = createFleetEngine({
      http,
      mcpHost: fakeMcpHost,
      onChatStream: (e) => events.push(e),
    })
    engine.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'A',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
    })
    const room = engine.createRoom('r', ['api:a'])
    await engine.askLlm(room.id, 'api:a')

    const toolEvents = events.filter(
      (e): e is Extract<ChatStreamEvent, { kind: 'tool' }> => e.kind === 'tool',
    )
    expect(toolEvents.map((e) => e.step.phase)).toEqual(['running', 'ok'])
    expect(toolEvents[0].step).toMatchObject({
      id: 'tu1',
      name: 'mcp__demo__ping',
      phase: 'running',
    })
    // seq 는 텍스트 델타와 공유 카운터로 단조 증가한다.
    expect(toolEvents[1].seq).toBeGreaterThan(toolEvents[0].seq)
  })
})

describe('FleetEngine — 프로젝트 영속 읽기', () => {
  it('lists a project events via the store (excluding task.progress)', () => {
    const store = createMemoryStore({
      idGen: (() => {
        let n = 0
        return () => `id-${++n}`
      })(),
      now: () => 1,
    })
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
    expect(mid.streams[0]).toMatchObject({
      roomId: room.id,
      llmId: 'a',
      text: '부분텍스트',
      seq: 1,
    })

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

describe('FleetEngine 채팅 취소(cancelChat)', () => {
  // abort 까지 hang 하는 채팅 세션 — cancelChat 의 in-flight 발언 취소 시뮬레이션용(프로젝트 cancelRun 테스트와 동형).
  function hangingChatSession(id = 'a') {
    const state: { signal?: AbortSignal } = {}
    const session = {
      id,
      descriptor: { id, kind: 'api' as const, displayName: id.toUpperCase(), ref: id, model: '' },
      async send(_prompt: string, opts?: { signal?: AbortSignal }) {
        state.signal = opts?.signal
        return await new Promise<string>((_resolve, reject) => {
          const signal = opts?.signal
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
      async dispose() {},
    }
    return { session, state }
  }

  it('cancelChat 은 in-flight 발언을 abort 하고 chat.cancelled 를 남긴 뒤 busy 를 해제한다', async () => {
    const sessions = createSessionManager()
    const { session, state } = hangingChatSession('a')
    sessions.add(session)
    const engine = createFleetEngine({ sessions })
    const room = engine.createRoom('방', ['a'])

    const p = engine.askLlm(room.id, 'a') // await 하지 않고 in-flight 로 띄움
    await vi.waitFor(() => expect(state.signal).toBeDefined()) // signal 이 session.send 까지 도달
    expect(state.signal?.aborted).toBe(false) // 취소는 비행 중에 일어난다(사전 취소 아님)
    expect(engine.getChatActivity().busyRooms).toEqual([room.id])

    engine.cancelChat(room.id)

    await expect(p).rejects.toThrow() // abort 로 발언이 거부됨
    expect(state.signal?.aborted).toBe(true)
    // 감사 로그(store)에 chat.cancelled(roomId 포함)가 남는다 — run.cancelled 와 대칭.
    const cancelled = engine.listEvents().find((e) => e.type === 'chat.cancelled')
    expect(cancelled?.data?.['roomId']).toBe(room.id)
    // 종료 후 busy 해제(idle) — getChatActivity 가 비어야 한다.
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })
  })

  it('cancelChat 미존재 roomId 는 무해한 no-op 이다(chat.cancelled 미방출)', () => {
    const engine = createFleetEngine()
    expect(() => engine.cancelChat('does-not-exist')).not.toThrow()
    expect(engine.listEvents().some((e) => e.type === 'chat.cancelled')).toBe(false)
  })

  it('cancelChat 중복 호출은 chat.cancelled 를 한 번만 남긴다(이미 abort → no-op)', async () => {
    const sessions = createSessionManager()
    const { session, state } = hangingChatSession('a')
    sessions.add(session)
    const engine = createFleetEngine({ sessions })
    const room = engine.createRoom('방', ['a'])

    const p = engine.askLlm(room.id, 'a')
    await vi.waitFor(() => expect(state.signal).toBeDefined())

    engine.cancelChat(room.id)
    engine.cancelChat(room.id) // 이미 abort 됨 → no-op(중복 취소 이벤트 방지)

    await expect(p).rejects.toThrow()
    expect(engine.listEvents().filter((e) => e.type === 'chat.cancelled')).toHaveLength(1)
  })

  it('discussRoom 도중 cancelChat 은 현재 발언을 끊고 남은 턴을 건너뛴다', async () => {
    const sessions = createSessionManager()
    const { session, state } = hangingChatSession('a')
    sessions.add(session)
    // 둘째 세션은 즉시 응답 — 취소로 결코 도달하지 않아야 한다.
    let bCalls = 0
    sessions.add({
      id: 'b',
      descriptor: { id: 'b', kind: 'api', displayName: 'B', ref: 'b', model: '' },
      async send() {
        bCalls++
        return 'b응답'
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ sessions })
    const room = engine.createRoom('방', ['a', 'b'])

    const p = engine.discussRoom(room.id, ['a', 'b'], 1)
    await vi.waitFor(() => expect(state.signal).toBeDefined()) // 첫 발언(a) in-flight

    engine.cancelChat(room.id)

    const out = await p // discuss 는 a 의 거부를 격리하고 b 를 건너뛴 채 종료
    expect(bCalls).toBe(0) // 취소 후 둘째 발언은 시작되지 않음
    expect(out).toHaveLength(0) // a 거부(격리) + b 스킵 → 영속 메시지 없음
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })
  })

  it('dispose 는 진행 중 채팅 발언을 abort 한다(종료 중 in-flight chat 이 계속 돌지 않게)', async () => {
    // CLI 세션 dispose 는 자식을 죽이지 않으므로(no-op), 컨트롤러 abort 만이 in-flight 발언을
    // 끊는 유일한 수단이다 — cancelRun/dispose(activeRuns) 의 종료-시-abort 패턴과 동형이어야 한다.
    const sessions = createSessionManager()
    const { session, state } = hangingChatSession('a')
    sessions.add(session)
    const engine = createFleetEngine({ sessions })
    const room = engine.createRoom('방', ['a'])

    const p = engine.askLlm(room.id, 'a')
    await vi.waitFor(() => expect(state.signal).toBeDefined())
    expect(state.signal?.aborted).toBe(false)

    await engine.dispose() // activeChatRuns 를 abort 해야 hang 중인 발언이 풀린다

    expect(state.signal?.aborted).toBe(true)
    await expect(p).rejects.toThrow() // abort 전파 → 발언 거부
  })

  it('동일 방 동시 발언은 컨트롤러를 공유 — cancelChat 한 번이 둘 다 abort 하고 chat.cancelled 는 1회', async () => {
    const sessions = createSessionManager()
    const a = hangingChatSession('a')
    const b = hangingChatSession('b')
    sessions.add(a.session)
    sessions.add(b.session)
    const engine = createFleetEngine({ sessions })
    const room = engine.createRoom('방', ['a', 'b'])

    const pa = engine.askLlm(room.id, 'a')
    const pb = engine.askLlm(room.id, 'b') // 같은 방, 동시 in-flight (activeOps 2)
    await vi.waitFor(() => {
      expect(a.state.signal).toBeDefined()
      expect(b.state.signal).toBeDefined()
    })
    expect(a.state.signal).toBe(b.state.signal) // 단일 컨트롤러를 공유
    expect(engine.getChatActivity().busyRooms).toEqual([room.id])

    engine.cancelChat(room.id) // 한 번의 취소가 둘 다 끊어야 한다

    await expect(pa).rejects.toThrow()
    await expect(pb).rejects.toThrow()
    expect(engine.listEvents().filter((e) => e.type === 'chat.cancelled')).toHaveLength(1)
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] }) // 마지막 연산에서 정리
  })

  it('취소 후 idle 이 된 방에서 새 발언은 미abort 컨트롤러를 받는다(좀비 컨트롤러 재사용 방지)', async () => {
    const sessions = createSessionManager()
    const signals: (AbortSignal | undefined)[] = []
    sessions.add({
      id: 'a',
      descriptor: { id: 'a', kind: 'api', displayName: 'A', ref: 'a', model: '' },
      async send(_p, opts) {
        signals.push(opts?.signal)
        return await new Promise<string>((_res, reject) => {
          const s = opts?.signal
          if (s?.aborted) return reject(new Error('aborted'))
          s?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ sessions })
    const room = engine.createRoom('방', ['a'])

    const p1 = engine.askLlm(room.id, 'a')
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    engine.cancelChat(room.id)
    await expect(p1).rejects.toThrow() // 취소 거부 → exitOp 가 컨트롤러 제거(idle)
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })

    const p2 = engine.askLlm(room.id, 'a') // 새 발언
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    expect(signals[1]?.aborted).toBe(false) // 직전 abort 된 컨트롤러를 재사용하지 않음

    engine.cancelChat(room.id) // 정리
    await expect(p2).rejects.toThrow()
  })

  it('askLlm 은 호출자 제공 signal 을 방 취소 컨트롤러로 덮어쓰지 않고 합성한다(Codex P3)', async () => {
    // 코어 호출자가 AskOptions.signal(per-call 타임아웃·취소)을 넘기면 방 cancelChat 컨트롤러와 합성돼야
    // 한다 — 덮어쓰면 호출자 취소가 session.send 에 도달하지 못해 호출이 계속 돈다.
    const sessions = createSessionManager()
    let sawSignal: AbortSignal | undefined
    sessions.add({
      id: 'a',
      descriptor: { id: 'a', kind: 'api', displayName: 'A', ref: 'a', model: '' },
      async send(_p, opts) {
        sawSignal = opts?.signal
        return await new Promise<string>((_res, reject) => {
          const s = opts?.signal
          if (s?.aborted) return reject(new Error('aborted'))
          s?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      },
      async dispose() {},
    })
    const engine = createFleetEngine({ sessions })
    const room = engine.createRoom('방', ['a'])

    const callerAc = new AbortController()
    const p = engine.askLlm(room.id, 'a', { signal: callerAc.signal })
    await vi.waitFor(() => expect(sawSignal).toBeDefined())

    callerAc.abort() // cancelChat 이 아니라 '호출자' signal 을 취소
    await expect(p).rejects.toThrow() // 합성됐으므로 send 의 signal 도 abort → 거부(덮어썼다면 무반응)
    expect(sawSignal?.aborted).toBe(true)
  })

  it('완료(idle)된 방에 cancelChat 은 no-op 이다(컨트롤러가 제거돼 좀비 취소가 없다)', async () => {
    const engine = createFleetEngine({
      runner: async () => ({ code: 0, stdout: '응답', stderr: '' }),
    })
    engine.registerCliSession('claude')
    const room = engine.createRoom('방', ['cli:claude'])

    await engine.askLlm(room.id, 'cli:claude') // 완료 → idle, 컨트롤러 제거됨
    expect(engine.getChatActivity()).toEqual({ busyRooms: [], streams: [] })

    engine.cancelChat(room.id) // 한 번도 busy 가 아닌 'does-not-exist' 와 달리, busy→idle 을 거친 방

    expect(engine.listEvents().some((e) => e.type === 'chat.cancelled')).toBe(false)
  })
})

describe('FleetEngine — 세션 영속·복원 (재시작)', () => {
  it('CLI 세션을 동일 store 의 새 엔진에서 복원한다', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    e1.registerCliSession('claude')
    expect(e1.listSessions().map((s) => s.id)).toEqual(['cli:claude'])

    const e2 = createFleetEngine({ store, runner: roleRunner })
    expect(e2.listSessions().map((s) => s.id)).toEqual(['cli:claude'])
  })

  it('사용자 수정 capabilities 를 복원 시 보존한다(재시드 안 함)', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    const d = e1.registerCliSession('claude') // 기본 시드 capabilities = ['reviewer']
    e1.setSessionCapabilities(d.id, ['implementer', 'planner'])

    const e2 = createFleetEngine({ store, runner: roleRunner })
    expect(e2.listSessions()[0].capabilities).toEqual(['implementer', 'planner'])
  })

  it('제거한 세션은 복원하지 않는다', async () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    const d = e1.registerCliSession('claude')
    await e1.removeSession(d.id)

    const e2 = createFleetEngine({ store, runner: roleRunner })
    expect(e2.listSessions()).toHaveLength(0)
  })

  it('미지 어댑터 엔트리는 throw 없이 skip 하고 형제는 복원한다', () => {
    const store = createMemoryStore()
    store.putSession({ kind: 'cli', id: 'cli:ghost', adapterId: 'ghost' })
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })

    const engine = createFleetEngine({ store, runner: roleRunner })
    expect(engine.listSessions().map((s) => s.id)).toEqual(['cli:claude'])
  })

  it('복원은 session.registered 를 재방출하지 않는다(에코 0)', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    e1.registerCliSession('claude')
    createFleetEngine({ store, runner: roleRunner }) // 복원 — 추가 방출 없어야 함
    const registered = store.listEvents().filter((ev) => ev.type === 'session.registered')
    expect(registered).toHaveLength(1)
  })

  it('API 세션은 암호화 미주입 시 영속하지 않는다(경계 — Epic B 는 crypto 주입 필요)', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    e1.registerApiSession({
      id: 'a',
      provider: 'anthropic',
      displayName: 'Claude API',
      model: 'claude-sonnet-4-6',
      apiKey: 'k',
    })

    const e2 = createFleetEngine({ store, runner: roleRunner })
    expect(e2.listSessions()).toHaveLength(0)
  })

  it('암호화 가능 시 API 세션을 암호문으로 영속한다(평문 키 미기록)', () => {
    const store = createMemoryStore()
    const engine = createFleetEngine({ store, secretCrypto: fakeCrypto() })
    engine.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })

    const persisted = store.listSessions()
    expect(persisted).toHaveLength(1)
    const ps = persisted[0]
    expect(ps.id).toBe('api:openai-1')
    if (ps.kind !== 'api') throw new Error('api 세션이어야 한다')
    expect(ps.encryptedApiKey.startsWith('v1:')).toBe(true)
    expect(JSON.stringify(store.snapshot())).not.toContain('sk-secret')
    expect('apiKey' in ps.config).toBe(false)
  })

  it('암호화 미가용(crypto 미주입)이면 API 세션을 영속하지 않는다(graceful degrade)', () => {
    const store = createMemoryStore()
    const engine = createFleetEngine({ store }) // secretCrypto 미주입 → no-op(isAvailable=false)
    engine.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })
    expect(store.listSessions()).toHaveLength(0)
    expect(JSON.stringify(store.snapshot())).not.toContain('sk-secret')
  })

  it('apiKey 없는 API 세션은 영속하지 않는다(암호화 가능해도 키 부재)', () => {
    const store = createMemoryStore()
    const engine = createFleetEngine({ store, secretCrypto: fakeCrypto() })
    engine.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
    }) // apiKey 미지정
    expect(store.listSessions()).toHaveLength(0)
  })

  it('encrypt throw(키링 일시 잠금) 시 미영속으로 degrade 하되 라이브 세션·session.registered 는 유지한다', () => {
    const store = createMemoryStore()
    // isAvailable=true 이나 encrypt 가 throw — 키링 잠금/safeStorage 타이밍 모의.
    const flaky: import('./secret/types').SecretCrypto = {
      isAvailable: () => true,
      encrypt: () => {
        throw new Error('keyring locked')
      },
      decrypt: () => '',
    }
    const engine = createFleetEngine({ store, secretCrypto: flaky })
    const d = engine.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })

    expect(d.id).toBe('api:openai-1') // register 가 throw 하지 않고 라이브 descriptor 반환
    expect(engine.listSessions().map((s) => s.id)).toEqual(['api:openai-1']) // 라이브 세션 구성됨
    expect(store.listSessions()).toHaveLength(0) // 미영속(degrade)
    expect(store.listEvents().filter((e) => e.type === 'session.registered')).toHaveLength(1) // 이벤트 발행
    expect(JSON.stringify(store.snapshot())).not.toContain('sk-secret') // 평문 키 미기록
  })

  it('mcpConfig 는 런타임엔 적용되나 영속에서 제외된다(secret 평문 금지)', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    const d = e1.registerCliSession('claude', { mcpConfig: '/path/to/mcp.json' })
    expect(d.mcpConfig).toBe('/path/to/mcp.json') // 런타임 descriptor 에 적용

    const e2 = createFleetEngine({ store, runner: roleRunner })
    expect(e2.listSessions()[0].mcpConfig).toBeUndefined() // 영속 제외 → 복원 시 없음
  })

  it('손상 capabilities(비배열)는 버리고 재시드해 복원한다(렌더러 .includes 크래시 방지)', () => {
    const store = createMemoryStore()
    // 비배열 capabilities(객체) — 렌더러 SessionsPanel 이 .includes 호출 시 크래시할 손상 데이터.
    store.putSession({
      kind: 'cli',
      id: 'cli:claude',
      adapterId: 'claude',
      capabilities: {} as unknown as AgentRole[],
    })
    const engine = createFleetEngine({ store, runner: roleRunner })
    const caps = engine.listSessions()[0].capabilities
    expect(Array.isArray(caps)).toBe(true)
    expect(caps).toEqual(['reviewer']) // claude 시드 기본값으로 복원
  })

  it('비배열 sessions(손상 store 파일)로도 엔진 생성이 brick 되지 않는다(R3)', () => {
    // 최상위 sessions 가 배열 아님 — 유효 JSON 이라 json-file 얕은 머지를 통과(.corrupt 미발동).
    // 복원 루프에 가드가 없으면 for...of 가 TypeError 를 던져 createFleetEngine 전체가 throw(부팅 brick).
    const dir = mkdtempSync(join(tmpdir(), 'fleet-brick-'))
    try {
      writeFileSync(join(dir, 'fleet-store.json'), JSON.stringify({ sessions: 42 }), 'utf8')
      const store = createJsonFileStore(dir)
      expect(() => createFleetEngine({ store, runner: roleRunner })).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('API 세션을 동일 store+crypto 의 새 엔진에서 복원한다', () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    e1.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })

    const e2 = createFleetEngine({ store, secretCrypto: crypto })
    expect(e2.listSessions().map((s) => s.id)).toEqual(['api:openai-1'])
  })

  it('복원된 API 세션이 복호화된 키를 provider 호출에 사용한다(키 왕복)', async () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    e1.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })

    const { http, authHeaders } = authCapturingHttp()
    const e2 = createFleetEngine({ store, secretCrypto: crypto, http })
    const room = e2.createRoom('방', ['api:openai-1'])
    e2.postUserMessage(room.id, '안녕?')
    await e2.askLlm(room.id, 'api:openai-1')

    expect(authHeaders.some((h) => h === 'Bearer sk-secret')).toBe(true)
  })

  it('암호화 미가용이면 영속된 API 세션을 복원하지 않는다(좀비 방지)', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, secretCrypto: fakeCrypto() })
    e1.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })
    expect(store.listSessions()).toHaveLength(1)

    const e2 = createFleetEngine({ store, secretCrypto: fakeCrypto(false) })
    expect(e2.listSessions()).toHaveLength(0)
  })

  it('복호화 실패(키회전)는 throw 없이 skip 하고 형제 CLI 는 복원한다', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, secretCrypto: fakeCrypto(), runner: roleRunner })
    e1.registerCliSession('claude')
    e1.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })

    const rotated: import('./secret/types').SecretCrypto = {
      isAvailable: () => true,
      encrypt: (p) => 'v1:' + Buffer.from(p).toString('base64'),
      decrypt: () => {
        throw new Error('decrypt failed')
      },
    }
    const e2 = createFleetEngine({ store, secretCrypto: rotated, runner: roleRunner })
    expect(e2.listSessions().map((s) => s.id)).toEqual(['cli:claude'])
  })

  it('손상 api 엔트리(config 없음)는 skip 하고 형제는 복원한다', () => {
    const store = createMemoryStore()
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })
    store.putSession({ kind: 'api', id: 'api:broken' } as unknown as Parameters<
      typeof store.putSession
    >[0])

    const engine = createFleetEngine({ store, secretCrypto: fakeCrypto(), runner: roleRunner })
    expect(engine.listSessions().map((s) => s.id)).toEqual(['cli:claude'])
  })

  it('손상 api 엔트리(encryptedApiKey 비문자열)도 형태검증으로 skip 한다', () => {
    const store = createMemoryStore()
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })
    // config 는 있으나 encryptedApiKey 가 숫자 — 손상 JSON(타입 보장 없음) 모의.
    store.putSession({
      kind: 'api',
      id: 'api:openai-1',
      config: { id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5' },
      encryptedApiKey: 123,
    } as unknown as Parameters<typeof store.putSession>[0])

    const engine = createFleetEngine({ store, secretCrypto: fakeCrypto(), runner: roleRunner })
    expect(engine.listSessions().map((s) => s.id)).toEqual(['cli:claude'])
  })

  it('미지 kind 영속 엔트리는 전방호환으로 skip 하고 형제는 복원한다', () => {
    const store = createMemoryStore()
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })
    // 미래 버전이 쓴 미지 kind — 현재 엔진은 조용히 건너뛰고 형제 복원을 막지 않아야 한다.
    store.putSession({ kind: 'future', id: 'future:x' } as unknown as Parameters<
      typeof store.putSession
    >[0])

    const engine = createFleetEngine({ store, secretCrypto: fakeCrypto(), runner: roleRunner })
    expect(engine.listSessions().map((s) => s.id)).toEqual(['cli:claude'])
  })

  it('API 세션 복원은 session.registered 를 재방출하지 않는다(에코 0)', () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    e1.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })
    createFleetEngine({ store, secretCrypto: crypto })
    const registered = store.listEvents().filter((ev) => ev.type === 'session.registered')
    expect(registered).toHaveLength(1)
  })

  it('API 세션의 수정된 capabilities 를 복원 시 보존한다(암호문 불변)', () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    const d = e1.registerApiSession({
      id: 'openai-1',
      provider: 'openai',
      displayName: 'GPT',
      model: 'gpt-5.5',
      apiKey: 'sk-secret',
    })
    e1.setSessionCapabilities(d.id, ['planner', 'reviewer'])

    const ps = store.listSessions()[0]
    if (ps.kind !== 'api') throw new Error('api 세션이어야 한다')
    expect(ps.encryptedApiKey.startsWith('v1:')).toBe(true) // 암호문 불변(키 재암호화 없음)

    const e2 = createFleetEngine({ store, secretCrypto: crypto })
    expect(e2.listSessions()[0].capabilities).toEqual(['planner', 'reviewer'])
  })
})

describe('listProviderModels (#13 라이브 모델 조회)', () => {
  const cfg = {
    id: 'a',
    provider: 'anthropic' as const,
    displayName: 'Claude',
    model: 'claude-sonnet-4-6',
    apiKey: 'k',
  }

  it('provider.listModels 결과를 반환한다', async () => {
    const http: HttpClient = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Sonnet' }] }),
    })
    const engine = createFleetEngine({ http })
    expect(await engine.listProviderModels(cfg)).toEqual([
      { id: 'claude-sonnet-4-6', label: 'Sonnet' },
    ])
  })

  it('provider 가 throw 하면 그대로 전파한다(렌더러가 사유 표시·입력 폴백)', async () => {
    const http: HttpClient = async () => ({ ok: false, status: 401, text: async () => 'nope' })
    const engine = createFleetEngine({ http })
    await expect(engine.listProviderModels(cfg)).rejects.toThrow()
  })
})

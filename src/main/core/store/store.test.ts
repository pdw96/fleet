import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from './memory'
import { createJsonFileStore } from './json-file'
import type { StoreState } from './types'

/** 결정론적 id/clock 주입 헬퍼. */
function deterministic() {
  let n = 0
  return {
    idGen: () => `id-${++n}`,
    now: () => 1000 + n,
  }
}

describe('memory store — projects & tasks', () => {
  it('creates and lists projects with derived title', () => {
    const store = createMemoryStore(deterministic())
    const p = store.createProject({ goal: '멀티 LLM 데스크톱 앱을 만든다\n상세...' })
    expect(p.id).toBe('id-1')
    expect(p.title).toBe('멀티 LLM 데스크톱 앱을 만든다')
    expect(p.status).toBe('planning')
    expect(store.listProjects()).toHaveLength(1)
  })

  it('decomposes a project into tasks and lists by project', () => {
    const store = createMemoryStore(deterministic())
    const p = store.createProject({ goal: 'goal' })
    store.createTask({ projectId: p.id, title: '설계', description: '...', role: 'architect' })
    store.createTask({ projectId: p.id, title: '구현', description: '...', role: 'implementer' })
    store.createTask({ projectId: 'other', title: '무관', description: '...' })

    const tasks = store.listTasks(p.id)
    expect(tasks).toHaveLength(2)
    expect(tasks.map((t) => t.role)).toEqual(['architect', 'implementer'])
    expect(tasks.every((t) => t.status === 'pending')).toBe(true)
  })

  it('updates a task dependsOn (위상 스케줄용 의존성 해소)', () => {
    const store = createMemoryStore(deterministic())
    const p = store.createProject({ goal: 'goal' })
    const a = store.createTask({ projectId: p.id, title: 'A', description: '' })
    const b = store.createTask({ projectId: p.id, title: 'B', description: '' })
    expect(b.dependsOn).toEqual([])
    store.updateTask(b.id, { dependsOn: [a.id] })
    expect(store.getTask(b.id)?.dependsOn).toEqual([a.id])
  })

  it('updates a task status and assignment', () => {
    const store = createMemoryStore(deterministic())
    const p = store.createProject({ goal: 'g' })
    const t = store.createTask({ projectId: p.id, title: 'x', description: 'y' })
    const updated = store.updateTask(t.id, {
      status: 'done',
      assignedLlmId: 'claude',
      output: 'ok',
    })
    expect(updated?.status).toBe('done')
    expect(updated?.assignedLlmId).toBe('claude')
    expect(store.getTask(t.id)?.output).toBe('ok')
  })

  it('returns undefined when updating a missing task', () => {
    const store = createMemoryStore(deterministic())
    expect(store.updateTask('nope', { status: 'done' })).toBeUndefined()
  })
})

describe('memory store — chat & events', () => {
  it('stores and reloads conversation messages per room', () => {
    const store = createMemoryStore(deterministic())
    const room = store.createRoom({ title: '작업방', participants: ['claude', 'codex'] })
    store.appendMessage({ roomId: room.id, author: { type: 'user' }, content: '안녕' })
    store.appendMessage({
      roomId: room.id,
      author: { type: 'llm', llmId: 'claude' },
      role: 'planner',
      content: '계획',
    })

    const msgs = store.listMessages(room.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].author).toEqual({ type: 'llm', llmId: 'claude' })
    expect(msgs[1].role).toBe('planner')
  })

  it('records audit events', () => {
    const store = createMemoryStore(deterministic())
    store.appendEvent({ type: 'approval.requested', data: { target: 'rm -rf /' } })
    expect(store.listEvents()).toHaveLength(1)
    expect(store.listEvents()[0].type).toBe('approval.requested')
  })

  it('returned lists are copies (external mutation does not leak)', () => {
    const store = createMemoryStore(deterministic())
    store.createProject({ goal: 'g' })
    const list = store.listProjects()
    list[0].title = 'mutated'
    expect(store.listProjects()[0].title).not.toBe('mutated')
  })

  it('preserves message on appended events', () => {
    const store = createMemoryStore(deterministic())
    store.appendEvent({ type: 'task.done', message: '작업 완료', data: { projectId: 'p1' } })
    expect(store.listEvents()[0].message).toBe('작업 완료')
  })

  it('lists a project events in order and excludes task.progress', () => {
    const store = createMemoryStore(deterministic())
    store.appendEvent({ type: 'project.created', message: '생성', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.progress', message: '토큰', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.done', message: '완료', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.done', message: '다른 프로젝트', data: { projectId: 'p2' } })

    const events = store.listProjectEvents('p1')
    expect(events.map((e) => e.type)).toEqual(['project.created', 'task.done']) // progress 제외, p2 제외
    expect(events.map((e) => e.message)).toEqual(['생성', '완료'])
  })

  it('stores and exposes the last active project id', () => {
    const store = createMemoryStore(deterministic())
    expect(store.snapshot().lastActiveProjectId).toBeUndefined()
    store.setLastActiveProject('p9')
    expect(store.snapshot().lastActiveProjectId).toBe('p9')
    store.setLastActiveProject(null)
    expect(store.snapshot().lastActiveProjectId).toBeUndefined()
  })

  it('exposes the last active project id via a lightweight getter (no full snapshot)', () => {
    const store = createMemoryStore(deterministic())
    expect(store.getLastActiveProjectId()).toBeUndefined()
    store.setLastActiveProject('p9')
    expect(store.getLastActiveProjectId()).toBe('p9')
    store.setLastActiveProject(null)
    expect(store.getLastActiveProjectId()).toBeUndefined()
  })
})

describe('memory store — persistence hook', () => {
  it('calls persist after every mutation with a snapshot', () => {
    const persist = vi.fn<(s: StoreState) => void>()
    const store = createMemoryStore({ ...deterministic(), persist })
    store.createProject({ goal: 'g' })
    store.createTask({ projectId: 'id-1', title: 't', description: 'd' })
    expect(persist).toHaveBeenCalledTimes(2)
    const last = persist.mock.calls.at(-1)?.[0]
    expect(last?.projects).toHaveLength(1)
    expect(last?.tasks).toHaveLength(1)
  })
})

describe('json-file store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-store-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists to disk and reloads identical state in a new store', () => {
    const a = createJsonFileStore(dir, deterministic())
    const p = a.createProject({ goal: '영속 테스트' })
    a.createTask({ projectId: p.id, title: '작업', description: '설명' })

    // 새 인스턴스가 동일 디렉토리에서 로드
    const b = createJsonFileStore(dir)
    expect(b.listProjects()).toHaveLength(1)
    expect(b.listProjects()[0].goal).toBe('영속 테스트')
    expect(b.listTasks(p.id)).toHaveLength(1)
  })

  it('starts empty when no file exists', () => {
    const s = createJsonFileStore(dir)
    expect(s.listProjects()).toHaveLength(0)
    expect(s.snapshot()).toEqual({
      projects: [],
      tasks: [],
      rooms: [],
      messages: [],
      events: [],
      sessions: [],
    })
  })

  it('backs up a corrupted store file instead of silently discarding it', () => {
    writeFileSync(join(dir, 'fleet-store.json'), '{ 손상된 JSON', 'utf8')
    const s = createJsonFileStore(dir)
    expect(s.listProjects()).toHaveLength(0) // 깨진 파일 → 빈 상태로 복구
    expect(existsSync(join(dir, 'fleet-store.json.corrupt'))).toBe(true) // 원본은 백업되어 보존
  })

  it('persists atomically without leaving a temp file', () => {
    const s = createJsonFileStore(dir, deterministic())
    s.createProject({ goal: 'g' })
    expect(existsSync(join(dir, 'fleet-store.json'))).toBe(true)
    expect(existsSync(join(dir, 'fleet-store.json.tmp'))).toBe(false)
  })

  it('fills missing top-level keys when loading an older store file', () => {
    // lastActiveProjectId 없는 구버전 파일 + 신규 필드 부재
    writeFileSync(
      join(dir, 'fleet-store.json'),
      JSON.stringify({
        projects: [{ id: 'p1', goal: 'g', title: 'T', status: 'done', createdAt: 0, updatedAt: 0 }],
      }),
      'utf8',
    )
    const s = createJsonFileStore(dir)
    expect(s.listProjects()).toHaveLength(1)
    expect(s.snapshot().tasks).toEqual([]) // 결측 배열이 기본값으로 보강됨
    expect(s.snapshot().events).toEqual([])
  })

  it('persists sessions to disk and reloads them in a new store', () => {
    const a = createJsonFileStore(dir, deterministic())
    a.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude', capabilities: ['reviewer'] })

    const b = createJsonFileStore(dir)
    expect(b.listSessions()).toEqual([
      { kind: 'cli', id: 'cli:claude', adapterId: 'claude', capabilities: ['reviewer'] },
    ])
  })

  it('암호화된 api 세션을 디스크에 영속하고 새 store 에서 reload 한다(암호문 생존)', () => {
    const a = createJsonFileStore(dir, deterministic())
    const entry = {
      kind: 'api' as const,
      id: 'api:openai-1',
      config: { id: 'openai-1', provider: 'openai' as const, displayName: 'GPT', model: 'gpt-5.5' },
      encryptedApiKey: 'v1:ZW5j',
      capabilities: ['implementer' as const],
    }
    a.putSession(entry)

    const b = createJsonFileStore(dir)
    expect(b.listSessions()).toEqual([entry]) // 디스크 직렬화 왕복으로 암호문·config 생존
  })

  it('fills missing sessions key as [] for older store files', () => {
    writeFileSync(
      join(dir, 'fleet-store.json'),
      JSON.stringify({
        projects: [{ id: 'p1', goal: 'g', title: 'T', status: 'done', createdAt: 0, updatedAt: 0 }],
      }),
      'utf8',
    )
    const s = createJsonFileStore(dir)
    expect(s.snapshot().sessions).toEqual([])
  })

  it('비배열 sessions(손상 파일) 로드 후에도 CRUD 가 깨지지 않는다(정규화)', () => {
    // 유효 JSON 이라 .corrupt 백업 미발동 → state.sessions=42 가 그대로 들어오면 findIndex 가 throw.
    // 로드 시 정규화하면 putSession/listSessions 가 정상 동작해 UI 로 복구 가능.
    writeFileSync(join(dir, 'fleet-store.json'), JSON.stringify({ sessions: 42 }), 'utf8')
    const s = createJsonFileStore(dir)
    expect(() => s.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })).not.toThrow()
    expect(s.listSessions()).toEqual([{ kind: 'cli', id: 'cli:claude', adapterId: 'claude' }])
  })
})

describe('memory store — persisted sessions', () => {
  it('upserts, lists, and deletes persisted sessions', () => {
    const store = createMemoryStore(deterministic())
    store.putSession({
      kind: 'cli',
      id: 'cli:claude',
      adapterId: 'claude',
      capabilities: ['reviewer'],
    })
    store.putSession({ kind: 'cli', id: 'cli:codex', adapterId: 'codex' })
    expect(store.listSessions().map((s) => s.id)).toEqual(['cli:claude', 'cli:codex'])

    // 같은 id 는 교체(중복 push 아님)
    store.putSession({
      kind: 'cli',
      id: 'cli:claude',
      adapterId: 'claude',
      capabilities: ['planner'],
    })
    expect(store.listSessions()).toHaveLength(2)
    expect(store.listSessions().find((s) => s.id === 'cli:claude')?.capabilities).toEqual([
      'planner',
    ])

    store.deleteSession('cli:claude')
    expect(store.listSessions().map((s) => s.id)).toEqual(['cli:codex'])
  })

  it('includes sessions in the snapshot', () => {
    const store = createMemoryStore(deterministic())
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })
    expect(store.snapshot().sessions).toEqual([
      { kind: 'cli', id: 'cli:claude', adapterId: 'claude' },
    ])
  })

  it('patchSessionCapabilities 가 capabilities 만 in-place 갱신한다(키 보존)', () => {
    const store = createMemoryStore(deterministic())
    store.putSession({
      kind: 'api',
      id: 'api:openai-1',
      config: { id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5' },
      encryptedApiKey: 'v1:ZW5j',
      capabilities: ['implementer'],
    })
    store.patchSessionCapabilities('api:openai-1', ['planner', 'reviewer'])
    const s = store.listSessions().find((x) => x.id === 'api:openai-1')
    expect(s?.capabilities).toEqual(['planner', 'reviewer'])
    if (s?.kind !== 'api') throw new Error('api 세션이어야 한다')
    expect(s.encryptedApiKey).toBe('v1:ZW5j') // capabilities patch 가 암호문을 건드리지 않음
  })

  it('patchSessionCapabilities 는 미존재 id 에 no-op(throw 없음)', () => {
    const store = createMemoryStore(deterministic())
    expect(() => store.patchSessionCapabilities('api:ghost', ['planner'])).not.toThrow()
    expect(store.listSessions()).toHaveLength(0)
  })

  it('api 세션을 upsert·snapshot 왕복한다', () => {
    const store = createMemoryStore(deterministic())
    const entry = {
      kind: 'api' as const,
      id: 'api:openai-1',
      config: { id: 'openai-1', provider: 'openai' as const, displayName: 'GPT', model: 'gpt-5.5' },
      encryptedApiKey: 'v1:ZW5j',
      capabilities: ['implementer' as const],
    }
    store.putSession(entry)
    expect(store.snapshot().sessions).toEqual([entry])
  })
})

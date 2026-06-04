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
    const updated = store.updateTask(t.id, { status: 'done', assignedLlmId: 'claude', output: 'ok' })
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
    store.appendMessage({ roomId: room.id, author: { type: 'llm', llmId: 'claude' }, role: 'planner', content: '계획' })

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
    expect(s.snapshot()).toEqual({ projects: [], tasks: [], rooms: [], messages: [], events: [] })
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
})

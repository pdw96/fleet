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

describe('memory store — events rotation cap (#126)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('cap 초과 시 events 가 상한을 넘지 않고 가장 오래된 것부터 폐기한다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createMemoryStore({ ...deterministic(), eventCap: 3 })
    for (let i = 0; i < 5; i++) store.appendEvent({ type: `e${i}` })
    const events = store.listEvents()
    expect(events).toHaveLength(3)
    // 최근 3건(e2·e3·e4)만 보존, e0·e1 폐기
    expect(events.map((e) => e.type)).toEqual(['e2', 'e3', 'e4'])
  })

  it('폐기량을 droppedEventCount 에 누적한다(snapshot 노출)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createMemoryStore({ ...deterministic(), eventCap: 2 })
    for (let i = 0; i < 5; i++) store.appendEvent({ type: `e${i}` })
    // 5건 중 2건 유지 → 3건 폐기
    expect(store.snapshot().droppedEventCount).toBe(3)
  })

  it('첫 폐기 시에만 console.warn 1회(이후 폐기엔 미호출)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createMemoryStore({ ...deterministic(), eventCap: 2 })
    store.appendEvent({ type: 'e0' }) // 1건 — 미폐기
    store.appendEvent({ type: 'e1' }) // 2건 — 미폐기
    expect(warn).not.toHaveBeenCalled()
    store.appendEvent({ type: 'e2' }) // 3건째 → 첫 폐기 → 경고 1회
    store.appendEvent({ type: 'e3' }) // 추가 폐기 → 경고 미호출
    expect(warn).toHaveBeenCalledTimes(1)
    // 경고 메시지엔 cap·카운트만, 이벤트 내용 비노출
    const msg = warn.mock.calls[0]?.[0] as string
    expect(msg).toContain('2')
    expect(msg).not.toContain('e0')
  })

  it('cap 미만이면 폐기 0·droppedEventCount 미설정(기존 동작 무회귀)', () => {
    const store = createMemoryStore({ ...deterministic(), eventCap: 10 })
    store.appendEvent({ type: 'e0' })
    store.appendEvent({ type: 'e1' })
    expect(store.listEvents()).toHaveLength(2)
    expect(store.snapshot().droppedEventCount).toBeUndefined()
  })

  it('기본 cap 은 5000(미지정 시)', () => {
    const store = createMemoryStore(deterministic())
    for (let i = 0; i < 10; i++) store.appendEvent({ type: 'e' })
    expect(store.listEvents()).toHaveLength(10) // 5000 미만 → 전부 보존
    expect(store.snapshot().droppedEventCount).toBeUndefined()
  })

  it('로드 시 initial.events 가 cap 초과면 store 생성 시 정규화한다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const initial: StoreState = {
      projects: [],
      tasks: [],
      rooms: [],
      messages: [],
      events: [
        { id: 'a', type: 'old0', data: {}, ts: 1 },
        { id: 'b', type: 'old1', data: {}, ts: 2 },
        { id: 'c', type: 'keep0', data: {}, ts: 3 },
        { id: 'd', type: 'keep1', data: {}, ts: 4 },
      ],
      sessions: [],
    }
    const store = createMemoryStore({ ...deterministic(), eventCap: 2, initial })
    expect(store.listEvents().map((e) => e.type)).toEqual(['keep0', 'keep1'])
    expect(store.snapshot().droppedEventCount).toBe(2)
  })

  it('로드 정규화는 기존 droppedEventCount 에 누적한다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const initial: StoreState = {
      projects: [],
      tasks: [],
      rooms: [],
      messages: [],
      events: [
        { id: 'a', type: 'old', data: {}, ts: 1 },
        { id: 'b', type: 'keep', data: {}, ts: 2 },
      ],
      sessions: [],
      droppedEventCount: 7,
    }
    const store = createMemoryStore({ ...deterministic(), eventCap: 1, initial })
    expect(store.snapshot().droppedEventCount).toBe(8) // 7 + 1
  })

  it('cap 후에도 listProjectEvents 가 projectId 필터·task.progress 제외를 유지한다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createMemoryStore({ ...deterministic(), eventCap: 3 })
    store.appendEvent({ type: 'project.created', data: { projectId: 'p1' } }) // 폐기 대상
    store.appendEvent({ type: 'task.progress', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.done', data: { projectId: 'p1' } })
    store.appendEvent({ type: 'task.done', message: '최신', data: { projectId: 'p1' } })
    // cap=3 → 가장 오래된 project.created 폐기. 남은 3건 중 task.progress 제외 → task.done 2건
    const events = store.listProjectEvents('p1')
    expect(events.map((e) => e.type)).toEqual(['task.done', 'task.done'])
  })

  it('eventCap 0/음수는 안전 기본값(5000)으로 폴백한다(조용한 손실 방지)', () => {
    // cap<=0 이면 enforceEventCap 이 매 append 마다 전부 폐기 → 로그가 조용히 빈다. 유효치 아님 → 기본값.
    const store = createMemoryStore({ ...deterministic(), eventCap: 0 })
    for (let i = 0; i < 10; i++) store.appendEvent({ type: `e${i}` })
    expect(store.listEvents()).toHaveLength(10)
    expect(store.snapshot().droppedEventCount).toBeUndefined()
  })
})

describe('memory store — updater channel (#98)', () => {
  it('기본 채널은 stable (미설정 시 snapshot 엔 부재)', () => {
    const store = createMemoryStore(deterministic())
    expect(store.getUpdaterChannel()).toBe('stable')
    expect(store.snapshot().updaterChannel).toBeUndefined()
  })

  it('채널 설정 → 조회·snapshot 반영 + persist 훅 호출', () => {
    const persist = vi.fn<(s: StoreState) => void>()
    const store = createMemoryStore({ ...deterministic(), persist })
    store.setUpdaterChannel('beta')
    expect(store.getUpdaterChannel()).toBe('beta')
    expect(store.snapshot().updaterChannel).toBe('beta')
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls.at(-1)?.[0].updaterChannel).toBe('beta')
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

  it('updaterChannel 을 디스크 영속 후 새 인스턴스에서 동일 로드', () => {
    const a = createJsonFileStore(dir, deterministic())
    a.setUpdaterChannel('beta')
    const b = createJsonFileStore(dir)
    expect(b.getUpdaterChannel()).toBe('beta')
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

  it('eventCap 을 적용하고 droppedEventCount 를 디스크 왕복 후에도 보존한다(#126)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = createJsonFileStore(dir, { ...deterministic(), eventCap: 2 })
    for (let i = 0; i < 5; i++) a.appendEvent({ type: `e${i}` })
    expect(a.listEvents()).toHaveLength(2)
    expect(a.snapshot().droppedEventCount).toBe(3)

    // 새 인스턴스로 reload — 디스크에 cap·카운터가 영속됐는지
    const b = createJsonFileStore(dir, { eventCap: 2 })
    expect(b.listEvents()).toHaveLength(2)
    expect(b.snapshot().droppedEventCount).toBe(3)
    warn.mockRestore()
  })

  it('비배열 events(손상 파일) 로드 시 throw 없이 정규화한다(#126)', () => {
    // 유효 JSON 이지만 events 가 비배열(sessions 와 동일 손상 클래스). 로드 시 enforceEventCap 의
    // length/splice 가 throw 하면 UI 열기 전 부팅 크래시 → Array.isArray 정규화로 방어.
    writeFileSync(join(dir, 'fleet-store.json'), JSON.stringify({ events: 42 }), 'utf8')
    const s = createJsonFileStore(dir)
    expect(s.listEvents()).toEqual([])
    expect(() => s.appendEvent({ type: 'e' })).not.toThrow()
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

describe('memory store — 이벤트 커서 seq (#197 B1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('appendEvent 가 1부터 단조 증가하는 seq 를 삽입 순서대로 스탬프한다', () => {
    const store = createMemoryStore(deterministic())
    store.appendEvent({ type: 'e0' })
    store.appendEvent({ type: 'e1' })
    store.appendEvent({ type: 'e2' })
    expect(store.listEvents().map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('snapshot().eventSeq 가 마지막 배정 seq 를 노출한다', () => {
    const store = createMemoryStore(deterministic())
    for (let i = 0; i < 4; i++) store.appendEvent({ type: `e${i}` })
    expect(store.snapshot().eventSeq).toBe(4)
  })

  it('빈 store 는 eventSeq 를 기록하지 않는다(빈 상태 무회귀)', () => {
    const store = createMemoryStore(deterministic())
    expect(store.snapshot().eventSeq).toBeUndefined()
  })

  it('rotation 후 남은 events 의 seq 는 재번호되지 않고 eventSeq 는 후퇴하지 않는다', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createMemoryStore({ ...deterministic(), eventCap: 3 })
    for (let i = 0; i < 5; i++) store.appendEvent({ type: `e${i}` })
    // 최근 3건만 보존하되 seq 는 배정 당시 값(3,4,5) 유지 — 재번호 금지.
    expect(store.listEvents().map((e) => e.seq)).toEqual([3, 4, 5])
    expect(store.snapshot().eventSeq).toBe(5) // 카운터 비후퇴
  })

  it('다음 append 는 폐기 후에도 eventSeq+1 로 이어진다(seq 재사용 금지)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createMemoryStore({ ...deterministic(), eventCap: 2 })
    for (let i = 0; i < 3; i++) store.appendEvent({ type: `e${i}` }) // seq 1,2,3 → 남은 [2,3]
    const e3 = store.appendEvent({ type: 'e3' }) // seq 4
    expect(e3.seq).toBe(4)
    expect(store.listEvents().map((e) => e.seq)).toEqual([3, 4])
    expect(store.snapshot().eventSeq).toBe(4)
  })

  it('eventCursor(): 빈 store 는 {max:0, minRetained:1}', () => {
    const store = createMemoryStore(deterministic())
    expect(store.eventCursor()).toEqual({ maxEventSeq: 0, minRetainedEventSeq: 1 })
  })

  it('eventCursor(): 폐기 없이 N append → {max:N, minRetained:1}', () => {
    const store = createMemoryStore(deterministic())
    for (let i = 0; i < 4; i++) store.appendEvent({ type: `e${i}` })
    expect(store.eventCursor()).toEqual({ maxEventSeq: 4, minRetainedEventSeq: 1 })
  })

  it('eventCursor(): rotation 후 minRetained 가 최소 보존 seq 를 가리킨다(갭 감지 핵심)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createMemoryStore({ ...deterministic(), eventCap: 3 })
    for (let i = 0; i < 5; i++) store.appendEvent({ type: `e${i}` }) // 남은 seq [3,4,5]
    expect(store.eventCursor()).toEqual({ maxEventSeq: 5, minRetainedEventSeq: 3 })
  })

  it('구파일 백필: seq 미보유 events 에 배열 순서대로 1..N 백필 + eventSeq=N', () => {
    const initial: StoreState = {
      projects: [],
      tasks: [],
      rooms: [],
      messages: [],
      events: [
        { id: 'a', type: 'e0', data: {}, ts: 1 },
        { id: 'b', type: 'e1', data: {}, ts: 2 },
        { id: 'c', type: 'e2', data: {}, ts: 3 },
      ],
      sessions: [],
    }
    const store = createMemoryStore({ ...deterministic(), initial })
    expect(store.listEvents().map((e) => e.seq)).toEqual([1, 2, 3])
    expect(store.snapshot().eventSeq).toBe(3)
    // 백필 후 다음 append 는 과거 seq 재사용 없이 이어진다.
    expect(store.appendEvent({ type: 'e3' }).seq).toBe(4)
  })

  it('신규파일: seq 보유 events + eventSeq 는 백필하지 않고 카운터를 유지한다', () => {
    const initial: StoreState = {
      projects: [],
      tasks: [],
      rooms: [],
      messages: [],
      events: [
        { id: 'a', type: 'e0', data: {}, ts: 1, seq: 5 },
        { id: 'b', type: 'e1', data: {}, ts: 2, seq: 6 },
        { id: 'c', type: 'e2', data: {}, ts: 3, seq: 7 },
      ],
      sessions: [],
      eventSeq: 7,
    }
    const store = createMemoryStore({ ...deterministic(), initial })
    expect(store.listEvents().map((e) => e.seq)).toEqual([5, 6, 7]) // 불변
    expect(store.appendEvent({ type: 'e3' }).seq).toBe(8) // 카운터 이어감
  })

  it('구파일 백필 + rotation: 백필 후 앞에서 폐기, 남은 seq·minRetained·droppedEventCount 정합', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const initial: StoreState = {
      projects: [],
      tasks: [],
      rooms: [],
      messages: [],
      events: [
        { id: 'a', type: 'e0', data: {}, ts: 1 },
        { id: 'b', type: 'e1', data: {}, ts: 2 },
        { id: 'c', type: 'e2', data: {}, ts: 3 },
        { id: 'd', type: 'e3', data: {}, ts: 4 },
      ],
      sessions: [],
    }
    const store = createMemoryStore({ ...deterministic(), eventCap: 2, initial })
    // 백필 1,2,3,4 → cap 2 → 앞 [1,2] 폐기 → 남은 seq [3,4]
    expect(store.listEvents().map((e) => e.seq)).toEqual([3, 4])
    expect(store.eventCursor()).toEqual({ maxEventSeq: 4, minRetainedEventSeq: 3 })
    expect(store.snapshot().droppedEventCount).toBe(2)
  })

  it('json-file: seq·eventSeq 를 디스크 왕복 후에도 복원하고 다음 append 가 이어진다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-seq-'))
    try {
      const a = createJsonFileStore(dir, deterministic())
      a.appendEvent({ type: 'e0' })
      a.appendEvent({ type: 'e1' })
      a.appendEvent({ type: 'e2' })
      const b = createJsonFileStore(dir)
      expect(b.listEvents().map((e) => e.seq)).toEqual([1, 2, 3])
      expect(b.snapshot().eventSeq).toBe(3)
      expect(b.appendEvent({ type: 'e3' }).seq).toBe(4) // 왕복 후 카운터 이어감
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('손상 eventSeq(문자열·음수·비정수)를 로드 시 걸러내 seq 오염을 막는다', () => {
    // 유효 JSON 이지만 잘못된 타입 — sessions=42·events=42 와 동일 위협 클래스. `?? 0` 만으로는
    // 'x'+1='x1'·-4 로 seq 가 오염되므로 로드 정규화가 비음수 정수만 유효로 봐 제거해야 한다.
    for (const bad of ['x', -5, 1.5, Number.NaN] as unknown[]) {
      const store = createMemoryStore({
        ...deterministic(),
        initial: {
          projects: [],
          tasks: [],
          rooms: [],
          messages: [],
          events: [],
          sessions: [],
          eventSeq: bad as number,
        },
      })
      expect(store.snapshot().eventSeq).toBeUndefined() // 손상값 제거(빈 상태로 정규화)
      expect(store.appendEvent({ type: 'e' }).seq).toBe(1) // 1부터 정상 재개
    }
  })

  it('비객체 events 원소(null·primitive)를 로드 시 걸러내 backfill 크래시를 막는다', () => {
    // 유효 JSON·부분 손상(배열이지만 원소가 null/primitive). seq 백필의 e.seq 참조/대입이
    // strict 모드(ESM)서 throw → 부팅 크래시. events=42 와 동일 복구 가능 클래스로 걸러내야 한다.
    const store = createMemoryStore({
      ...deterministic(),
      initial: {
        projects: [],
        tasks: [],
        rooms: [],
        messages: [],
        events: [
          null,
          42,
          { id: 'a', type: 'e0', data: {}, ts: 1 },
          undefined,
        ] as unknown as StoreState['events'],
        sessions: [],
      },
    })
    expect(store.listEvents().map((e) => e.type)).toEqual(['e0']) // 손상 원소 제거, 유효분만
    expect(store.listEvents().map((e) => e.seq)).toEqual([1]) // 유효분에 seq 백필
    expect(store.appendEvent({ type: 'e1' }).seq).toBe(2) // 크래시 없이 이어감
  })

  it('per-event seq 0(1-based 위반)은 유효로 보지 않고 백필로 복구해 minRetained≥1 을 지킨다', () => {
    // seq:0 을 유효로 두면 eventCursor 가 minRetainedEventSeq:0 을 파생 → 갭 규칙상 모든 커서가
    // 연속으로 오판(missed-gap). 1-based 약속대로 백필해 복구해야 한다.
    const store = createMemoryStore({
      ...deterministic(),
      initial: {
        projects: [],
        tasks: [],
        rooms: [],
        messages: [],
        events: [
          { id: 'a', type: 'e0', data: {}, ts: 1, seq: 0 },
          { id: 'b', type: 'e1', data: {}, ts: 2, seq: 0 },
        ],
        sessions: [],
      },
    })
    expect(store.listEvents().map((e) => e.seq)).toEqual([1, 2]) // 0 → 1..N 백필 복구
    expect(store.eventCursor().minRetainedEventSeq).toBe(1) // 1-based 약속 유지(0 아님)
  })

  it('손상 eventSeq 가 있어도 기존 유효 events 의 seq 로 카운터를 복원한다', () => {
    const store = createMemoryStore({
      ...deterministic(),
      initial: {
        projects: [],
        tasks: [],
        rooms: [],
        messages: [],
        events: [
          { id: 'a', type: 'e0', data: {}, ts: 1, seq: 5 },
          { id: 'b', type: 'e1', data: {}, ts: 2, seq: 6 },
        ],
        sessions: [],
        eventSeq: 'x' as unknown as number, // 손상 카운터
      },
    })
    expect(store.snapshot().eventSeq).toBe(6) // 손상 카운터 대신 events 최대 seq 로 복원
    expect(store.appendEvent({ type: 'e2' }).seq).toBe(7) // 정상 이어감
  })
})

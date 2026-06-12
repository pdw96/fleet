# session-apikey-persist (CLI-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI 세션 디스크립터를 store 에 영속하고 엔진 기동 시 라이브로 복원해, 재시작 후 첫 오케스트레이션 실행이 차단되던 문제(`engine.ts:364` throw)를 없앤다.

**Architecture:** 두 진실원천을 분리한다 — `SessionManager`(런타임 라이브 세션)와 `Store.sessions`(직렬화 descriptor). 엔진이 등록/제거/capabilities 변경에서 단일 미러 헬퍼(`syncPersistedSession`)로 둘을 동기화하고, 기동 시 `buildCliSession`(silent 빌드)로 영속 CLI 세션을 재구성한다. secret 가능 필드(mcpConfig)와 API 키는 평문 store 에 쓰지 않는다(safeStorage 후속).

**Tech Stack:** TypeScript, Electron(메인 프로세스), vitest. 코어는 Electron 비의존 순수 TS.

**Spec:** `docs/superpowers/specs/2026-06-12-session-apikey-persist-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `src/main/core/store/types.ts` | `PersistedSession` 타입, `StoreState.sessions`, `Store` 세션 CRUD 시그니처 | Modify |
| `src/main/core/store/memory.ts` | `emptyState` + `putSession`/`deleteSession`/`listSessions` 구현 | Modify |
| `src/main/core/store/json-file.ts` | `EMPTY` 에 `sessions: []` | Modify |
| `src/main/core/store/store.test.ts` | 세션 CRUD·영속 왕복 테스트 + 기존 snapshot 단언 보정 | Modify |
| `src/main/core/engine.ts` | `buildCliSession` 추출, `syncPersistedSession`, register/remove/capabilities 배선, 기동 복원, API 미영속 주석 | Modify |
| `src/main/core/engine.test.ts` | 영속·복원 테스트 7건 | Modify |

> **네이밍 불변**: store 메서드는 `deleteSession`, 엔진 메서드는 `removeSession`(FleetEngine 계약). 동명 회피.
> **전방호환 불변**: `putSession` 은 upsert-by-id 만 — sessions 배열을 filter-rewrite 하지 않는다(구버전이 못 읽는 `kind` 엔트리 보존).

---

## Task 1: Store 세션 CRUD + 영속

**Files:**
- Modify: `src/main/core/store/types.ts`
- Modify: `src/main/core/store/memory.ts`
- Modify: `src/main/core/store/json-file.ts`
- Test: `src/main/core/store/store.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/store/store.test.ts` line 169 의 기존 단언을 `sessions: []` 포함으로 보정한다:

```ts
    expect(s.snapshot()).toEqual({ projects: [], tasks: [], rooms: [], messages: [], events: [], sessions: [] })
```

그리고 파일 끝(마지막 `})` 뒤)에 새 describe 블록을 추가한다:

```ts
describe('memory store — persisted sessions', () => {
  it('upserts, lists, and deletes persisted sessions', () => {
    const store = createMemoryStore(deterministic())
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude', capabilities: ['reviewer'] })
    store.putSession({ kind: 'cli', id: 'cli:codex', adapterId: 'codex' })
    expect(store.listSessions().map((s) => s.id)).toEqual(['cli:claude', 'cli:codex'])

    // 같은 id 는 교체(중복 push 아님)
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude', capabilities: ['planner'] })
    expect(store.listSessions()).toHaveLength(2)
    expect(store.listSessions().find((s) => s.id === 'cli:claude')?.capabilities).toEqual(['planner'])

    store.deleteSession('cli:claude')
    expect(store.listSessions().map((s) => s.id)).toEqual(['cli:codex'])
  })

  it('includes sessions in the snapshot', () => {
    const store = createMemoryStore(deterministic())
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })
    expect(store.snapshot().sessions).toEqual([{ kind: 'cli', id: 'cli:claude', adapterId: 'claude' }])
  })
})
```

`src/main/core/store/store.test.ts` 의 `describe('json-file store', …)` 블록 안(마지막 `it` 뒤)에 영속 왕복 테스트를 추가한다:

```ts
  it('persists sessions to disk and reloads them in a new store', () => {
    const a = createJsonFileStore(dir, deterministic())
    a.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude', capabilities: ['reviewer'] })

    const b = createJsonFileStore(dir)
    expect(b.listSessions()).toEqual([{ kind: 'cli', id: 'cli:claude', adapterId: 'claude', capabilities: ['reviewer'] }])
  })

  it('fills missing sessions key as [] for older store files', () => {
    writeFileSync(
      join(dir, 'fleet-store.json'),
      JSON.stringify({ projects: [{ id: 'p1', goal: 'g', title: 'T', status: 'done', createdAt: 0, updatedAt: 0 }] }),
      'utf8',
    )
    const s = createJsonFileStore(dir)
    expect(s.snapshot().sessions).toEqual([])
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- src/main/core/store/store.test.ts`
Expected: FAIL — `store.putSession is not a function` / `listSessions is not a function`, 그리고 snapshot 단언 mismatch.

- [ ] **Step 3: 타입 추가 — `src/main/core/store/types.ts`**

`StoreState` 인터페이스 바로 위에 타입을 추가한다(파일 상단 import 아래):

```ts
/**
 * 재시작 간 복원할 직렬화 세션. 이번 슬라이스는 CLI 만 — 구독 CLI 는 자체 인증을 가져
 * 저장할 비밀값이 없다. mcpConfig 는 의도적 제외(인라인 JSON 이 secret 운반 가능 → 평문 영속 금지).
 */
export type PersistedSession = {
  kind: 'cli'
  /** 디스크립터 id (= `cli:${adapterId}`). upsert/삭제 키. */
  id: string
  /** CliAdapter.id. 복원 시 cli/registry 조회 키. */
  adapterId: string
  /** 빈 문자열/미지정이면 CLI 기본 모델. */
  model?: string
  stateful?: boolean
  /** 사용자 수정 가능 → 복원 시 재시드하지 않고 이 값을 적용. */
  capabilities?: AgentRole[]
}
```

`StoreState` 에 `sessions` 필드를 추가한다(`events` 줄 다음, `lastActiveProjectId` 위):

```ts
  events: FleetEvent[]
  /** 재시작 복원용 영속 세션 디스크립터(CLI 만 — secret 가능 필드·API 키 제외). */
  sessions: PersistedSession[]
  /** 프로젝트 탭에서 마지막으로 본 프로젝트(렌더러 복원용). 미설정이면 부재. */
  lastActiveProjectId?: string
```

`Store` 인터페이스에 `// ── persistence ──` 섹션 바로 위로 세션 CRUD 를 추가한다:

```ts
  // ── persisted sessions (재시작 복원) ──
  /** CLI 세션 디스크립터 upsert(id 키). engine.removeSession 과 구분 위해 delete-. */
  putSession(session: PersistedSession): void
  deleteSession(id: string): void
  listSessions(): PersistedSession[]

  // ── persistence ──
  snapshot(): StoreState
```

- [ ] **Step 4: 구현 — `src/main/core/store/memory.ts`**

`emptyState()` 에 `sessions: []` 를 추가한다:

```ts
const emptyState = (): StoreState => ({
  projects: [],
  tasks: [],
  rooms: [],
  messages: [],
  events: [],
  sessions: [],
})
```

`// ── persistence ──` 섹션(즉 `snapshot()`) 바로 위에 세 메서드를 추가한다:

```ts
    // ── persisted sessions ──
    putSession(session) {
      // upsert-by-id 만 — 배열을 filter-rewrite 하지 않아 미지 kind 엔트리(전방호환)를 보존한다.
      const i = state.sessions.findIndex((s) => s.id === session.id)
      if (i >= 0) state.sessions[i] = session
      else state.sessions.push(session)
      save()
    },
    deleteSession(id) {
      const i = state.sessions.findIndex((s) => s.id === id)
      if (i >= 0) {
        state.sessions.splice(i, 1)
        save()
      }
    },
    listSessions() {
      return structuredClone(state.sessions)
    },
```

- [ ] **Step 5: 구현 — `src/main/core/store/json-file.ts`**

`EMPTY` 상수에 `sessions: []` 를 추가한다:

```ts
const EMPTY: StoreState = { projects: [], tasks: [], rooms: [], messages: [], events: [], sessions: [] }
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm test -- src/main/core/store/store.test.ts`
Expected: PASS (전체 store 스위트 녹색).

- [ ] **Step 7: 커밋**

```bash
git add src/main/core/store/types.ts src/main/core/store/memory.ts src/main/core/store/json-file.ts src/main/core/store/store.test.ts
git commit -m "feat(store): PersistedSession 영속 CRUD — putSession/deleteSession/listSessions (#27 Now②)"
```

---

## Task 2: 엔진 — 등록 영속 + 기동 복원

**Files:**
- Modify: `src/main/core/engine.ts`
- Test: `src/main/core/engine.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/main/core/engine.test.ts` 파일 끝(최상위 `describe('FleetEngine', …)` 닫힘 뒤, 파일 마지막)에 새 describe 블록을 추가한다:

```ts
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

  it('API 세션은 영속하지 않는다(경계)', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    e1.registerApiSession({ id: 'a', provider: 'anthropic', displayName: 'Claude API', model: 'claude-sonnet-4-6', apiKey: 'k' })

    const e2 = createFleetEngine({ store, runner: roleRunner })
    expect(e2.listSessions()).toHaveLength(0)
  })

  it('mcpConfig 는 런타임엔 적용되나 영속에서 제외된다(secret 평문 금지)', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, runner: roleRunner })
    const d = e1.registerCliSession('claude', { mcpConfig: '/path/to/mcp.json' })
    expect(d.mcpConfig).toBe('/path/to/mcp.json') // 런타임 descriptor 에 적용

    const e2 = createFleetEngine({ store, runner: roleRunner })
    expect(e2.listSessions()[0].mcpConfig).toBeUndefined() // 영속 제외 → 복원 시 없음
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- src/main/core/engine.test.ts`
Expected: FAIL — 복원 테스트에서 `e2.listSessions()` 가 비어 있음(`['cli:claude']` 기대), capabilities 미보존, mcpConfig 누락 미검증 등.

- [ ] **Step 3: `buildCliSession` + `syncPersistedSession` + 복원 루프 추가 — `src/main/core/engine.ts`**

`return {` 바로 위(`streamedAsk` 정의 다음)에 다음을 삽입한다:

```ts
  // 라이브 CLI 세션을 만들어 매니저에 추가한다(순수 — store/audit 부작용 없음). register·restore 공용.
  // 복원이 session.registered 재방출/store 재기록 없이 재구성하게 하는 silent 빌드 지점.
  const buildCliSession = (input: {
    adapterId: string
    model?: string
    stateful?: boolean
    mcpConfig?: string
    capabilities?: AgentRole[]
  }): LlmDescriptor => {
    const adapter = cliRegistry.get(input.adapterId)
    if (!adapter) throw new Error(`알 수 없는 CLI 어댑터: ${input.adapterId}`)
    const descriptor: LlmDescriptor = {
      id: `cli:${input.adapterId}`,
      kind: 'cli',
      displayName: adapter.displayName,
      ref: input.adapterId,
      // 모델 미지정(빈 값)이면 CLI 기본 모델. 지정 시 cli-session 이 --model 로 전달.
      model: input.model?.trim() || '',
      stateful: !!input.stateful,
      // MCP 설정(경로/인라인 JSON). adapter.mcpConfigFlag 가 있는 CLI(claude)에만 적용된다.
      mcpConfig: input.mcpConfig?.trim() || undefined,
      // capabilities 미지정(신규 등록)이면 시드, 지정(복원)이면 그 값을 적용.
      capabilities: input.capabilities ?? seedCapabilities(input.adapterId),
    }
    sessions.add(createCliSession(descriptor, adapter, runner, undefined, { stateful: input.stateful }))
    return descriptor
  }

  // 라이브 CLI descriptor → 영속 store 미러(단일 지점). mcpConfig 는 의도적 제외(secret 평문 금지).
  const syncPersistedSession = (descriptor: LlmDescriptor): void => {
    if (descriptor.kind !== 'cli') return // API 영속은 safeStorage 후속(Epic B)
    store.putSession({
      kind: 'cli',
      id: descriptor.id,
      adapterId: descriptor.ref,
      model: descriptor.model,
      stateful: descriptor.stateful,
      capabilities: descriptor.capabilities,
    })
  }

  // 재시작 복원: 영속 CLI 세션을 라이브로 재구성한다. registry 에 있는 adapter 만(등록≠탐지 — 탐지는 별개).
  // 복원은 store 를 재기록하지 않고(이미 있음) session.registered 도 재방출하지 않는다(에코·중복 audit 회피).
  // 손상/미지 엔트리가 엔진 생성을 막지 않도록 전체/엔트리별로 격리한다(앱 부팅 brick 방지).
  for (const ps of store.listSessions()) {
    try {
      if (ps.kind !== 'cli') continue // 미지 kind(전방호환) skip
      if (!cliRegistry.get(ps.adapterId)) {
        console.warn('[fleet] 세션 복원 skip — 미지 어댑터:', ps.id, ps.adapterId)
        continue
      }
      buildCliSession({ adapterId: ps.adapterId, model: ps.model, stateful: ps.stateful, capabilities: ps.capabilities })
    } catch (err) {
      console.error('[fleet] 세션 복원 실패:', ps?.id, err)
    }
  }
```

- [ ] **Step 4: `registerCliSession` 을 `buildCliSession` 기반으로 교체 — `src/main/core/engine.ts`**

기존 `registerCliSession(adapterId, sessionOpts) { … }`(약 `:269-289`) 전체를 다음으로 교체한다:

```ts
    registerCliSession(adapterId, sessionOpts) {
      // buildCliSession 이 미지 adapter 면 throw — 기존 계약 보존.
      const descriptor = buildCliSession({
        adapterId,
        model: sessionOpts?.model,
        stateful: sessionOpts?.stateful,
        mcpConfig: sessionOpts?.mcpConfig,
      })
      syncPersistedSession(descriptor) // 영속(재시작 복원용)
      store.appendEvent({ type: 'session.registered', data: { id: descriptor.id, kind: 'cli', stateful: !!sessionOpts?.stateful } })
      return descriptor
    },
```

- [ ] **Step 5: `setSessionCapabilities`·`removeSession` 영속 배선 + `registerApiSession` 주석 — `src/main/core/engine.ts`**

`setSessionCapabilities` 를 교체한다(`syncPersistedSession` 한 줄 추가):

```ts
    setSessionCapabilities(id, roles) {
      const descriptor = sessions.setCapabilities(id, roles)
      if (!descriptor) throw new Error(`알 수 없는 세션: ${id}`)
      syncPersistedSession(descriptor) // 수정된 capabilities 영속(cli 만 — 내부에서 분기)
      store.appendEvent({ type: 'session.capabilities', data: { id, roles: [...roles] } })
      return descriptor
    },
```

`removeSession` 을 교체한다(라이브 제거 후 영속 삭제):

```ts
    async removeSession(id) {
      await sessions.remove(id)
      store.deleteSession(id)
    },
```

`registerApiSession(config) {` 의 첫 줄(`const id = ...` 위)에 미영속 경계 주석을 추가한다:

```ts
    registerApiSession(config) {
      // 주의: API 세션은 영속하지 않는다 — apiKey 는 항상 secret 이라 평문 store 금지(safeStorage 후속, Epic B).
      const id = `api:${config.id}`
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm test -- src/main/core/engine.test.ts`
Expected: PASS (영속·복원 7건 + 기존 엔진 스위트 녹색).

- [ ] **Step 7: 커밋**

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(engine): CLI 세션 영속·기동 복원 — buildCliSession silent 빌드 + 단일 미러 (#27 Now②)"
```

---

## Task 3: 품질 게이트 전수 통과

**Files:** (없음 — 검증 전용)

- [ ] **Step 1: 타입체크**

Run: `npm run typecheck`
Expected: PASS — 에러 0. (`StoreState.sessions` required 추가로 인한 누락이 없는지 확인.)

- [ ] **Step 2: 린트**

Run: `npm run lint`
Expected: PASS — 경고 0.

- [ ] **Step 3: 전체 테스트**

Run: `npm test`
Expected: PASS — 전 스위트 녹색(신규 9건 포함).

- [ ] **Step 4: 빌드 smoke**

Run: `npm run build`
Expected: PASS — electron-vite build 성공.

- [ ] **Step 5: 게이트 실패 시에만 보정 커밋**

4종 모두 녹색이면 추가 커밋 없음(Task 1·2 커밋으로 충분). 보정이 필요하면:

```bash
git add -A
git commit -m "fix: session-cli-persist 품질 게이트 보정 (#27 Now②)"
```

---

## 검증 노트 (수동 — 선택)

코어 단위테스트가 전 계층을 덮으므로 E2E 는 필수 아님. 단 실제 기동 확인을 원하면:
1. `npm run dev` → CLI 세션 1개 등록 → 앱 종료 → 재기동 → [세션] 탭에 세션이 남아 있고 프로젝트 실행이 "세션 없음" throw 없이 시작되는지 확인.
2. E2E 격리(`--user-data-dir` 임시 디렉터리)는 기존대로 — 복원이 `seedE2eFixtures` 전에 돌지만 빈 임시 store 라 무영향.

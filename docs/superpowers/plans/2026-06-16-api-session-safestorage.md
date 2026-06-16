# API 세션 safeStorage 시크릿 영속 (Epic B) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 재시작마다 증발하던 API 세션(apiKey)을 OS 암호화(Electron safeStorage)로 영속·복원해 키 재입력 마찰을 없앤다.

**Architecture:** 코어 엔진의 Electron 비의존을 유지하기 위해 암복호화를 `SecretCrypto` 포트로 추상화하고 `main/index.ts` 가 동기 safeStorage 백엔드를 주입한다(`store`/`http`/`approver` 주입과 동일 패턴). `PersistedSession` 을 `cli|api` 판별 유니온으로 확장하고, 평문 store 에는 암호문(`v1:` 프리픽스 base64)만 기록한다. 기동 복원 루프에 api 분기를 추가해 복호화→라이브 재구성하며, 복호화/손상은 엔트리별 격리한다.

**Tech Stack:** TypeScript, Electron 33.4.11(동기 safeStorage), vitest(코어 헤드리스 테스트), 기존 store/engine/session 인프라.

**설계 문서:** `docs/superpowers/specs/2026-06-16-api-session-safestorage-design.md`

---

## 파일 구조

| 파일 | 역할 | 변경 |
|------|------|------|
| `src/main/core/secret/types.ts` | `SecretCrypto` 포트 인터페이스(코어, Electron 비의존) | **생성** |
| `src/main/secret-crypto.ts` | safeStorage 백엔드 어댑터(main, Electron 의존) | **생성** |
| `src/main/core/store/types.ts` | `PersistedSession` 유니온 + `patchSessionCapabilities` 시그니처 | 수정 |
| `src/main/core/store/memory.ts` | `patchSessionCapabilities` 구현 | 수정 |
| `src/main/core/engine.ts` | `secretCrypto` 옵션·no-op 기본값·`buildApiSession`·영속·복원·capabilities patch | 수정 |
| `src/main/index.ts` | `createSafeStorageCrypto()` 주입(1줄) | 수정 |
| `src/main/core/store/store.test.ts` | store 유니온·patch 테스트 | 수정 |
| `src/main/core/engine.test.ts` | 엔진 영속/복원/키왕복/격리 테스트 | 수정 |

---

## Task 1: Store — PersistedSession 유니온 + patchSessionCapabilities

**Files:**
- Modify: `src/main/core/store/types.ts`
- Modify: `src/main/core/store/memory.ts`
- Test: `src/main/core/store/store.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `store.test.ts` 의 `describe('memory store — persisted sessions', …)` 블록 안(기존 `includes sessions in the snapshot` it 뒤)에 추가:

```ts
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
    // 암호문·config 는 불변(키 재암호화 없이 capabilities 만 patch)
    expect(s && s.kind === 'api' && s.encryptedApiKey).toBe('v1:ZW5j')
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/store/store.test.ts -t patchSessionCapabilities`
Expected: FAIL — `store.patchSessionCapabilities is not a function` (+ TS: `kind:'api'` 가 `PersistedSession` 에 없음).

- [ ] **Step 3: 타입 유니온 확장** — `src/main/core/store/types.ts` 의 import 에 `ApiProviderConfig` 추가하고, 기존 `PersistedSession` 타입(현 15-26줄)을 유니온으로 교체:

```ts
import type {
  AgentRole,
  ApiProviderConfig,
  ChatAuthor,
  ChatMessage,
  ChatRoom,
  FleetEvent,
  Project,
  Task,
} from '../../../shared/types'

/** 재시작 간 복원할 직렬화 세션. cli|api 판별 유니온. */
export type PersistedSession = PersistedCliSession | PersistedApiSession

/**
 * CLI 세션(#52). 구독 CLI 는 자체 인증을 가져 저장할 비밀값이 없다.
 * mcpConfig 는 의도적 제외(인라인 JSON 이 secret 운반 가능 → 평문 영속 금지).
 */
export type PersistedCliSession = {
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

/**
 * API 세션(Epic B). apiKey 는 평문 미기록 — safeStorage 암호문(base64+버전프리픽스)만.
 * config 는 ApiProviderConfig 에서 apiKey 만 뺀 나머지(provider/model/displayName/baseUrl/thinking 등 비밀 아님).
 */
export type PersistedApiSession = {
  kind: 'api'
  /** 디스크립터 id (= `api:${config.id}`). upsert/삭제 키. */
  id: string
  /** apiKey 제외 — 복원 시 decrypt 한 키와 합쳐 라이브 재구성. */
  config: Omit<ApiProviderConfig, 'apiKey'>
  /** safeStorage 암호화된 apiKey 토큰. 복호화 실패/미지 포맷이면 복원 skip. */
  encryptedApiKey: string
  /** 사용자 수정 가능 → 복원 시 재시드하지 않고 이 값을 적용. */
  capabilities?: AgentRole[]
}
```

- [ ] **Step 4: Store 인터페이스에 patch 시그니처 추가** — `src/main/core/store/types.ts` 의 `// ── persisted sessions (재시작 복원) ──` 블록, `listSessions(): PersistedSession[]` 줄 뒤에 추가:

```ts
  /** 영속 세션의 capabilities 만 in-place 갱신(부재 시 no-op). 키 재암호화 없이 capabilities 만 바꾸는 경로. */
  patchSessionCapabilities(id: string, capabilities: AgentRole[]): void
```

- [ ] **Step 5: memory.ts 에 구현 추가** — `src/main/core/store/memory.ts` 의 `deleteSession(id) { … }` 뒤, `listSessions()` 앞에 추가:

```ts
    patchSessionCapabilities(id, capabilities) {
      const s = state.sessions.find((x) => x.id === id)
      if (s) {
        s.capabilities = [...capabilities]
        save()
      }
    },
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx vitest run src/main/core/store/store.test.ts`
Expected: PASS (신규 3 + 기존 전부).

- [ ] **Step 7: 커밋**

```bash
git add src/main/core/store/types.ts src/main/core/store/memory.ts src/main/core/store/store.test.ts
git commit -m "feat(store): PersistedSession cli|api 유니온 + patchSessionCapabilities (Epic B #27)"
```

---

## Task 2: SecretCrypto 포트 인터페이스 (코어)

**Files:**
- Create: `src/main/core/secret/types.ts`

- [ ] **Step 1: 인터페이스 파일 생성** (순수 타입 — 단위 테스트 없음, 후속 태스크 테스트가 fake 구현으로 검증)

```ts
// src/main/core/secret/types.ts
/**
 * 시크릿 암복호화 포트. 코어는 safeStorage(electron)를 직접 import 하지 않고(AGENTS.md: 코어 Electron 비의존)
 * main 이 백엔드를 주입한다(store/http/approver 주입과 동일 패턴). Electron 33 은 동기 safeStorage 만
 * 제공하므로 동기 계약이다(async 변형은 후속 Electron·후속 PR — 버전 프리픽스로 마이그레이션 호환).
 */
export interface SecretCrypto {
  /** OS 암호화 가용 여부(win=DPAPI 상시·mac=Keychain·linux=keyring+ready). false 면 시크릿 미영속. */
  isAvailable(): boolean
  /** 평문 → 버전 프리픽스 붙은 암호문 토큰. 불가 시 throw. */
  encrypt(plain: string): string
  /** 암호문 토큰 → 평문. 미지 포맷·복호화 실패(키회전/손상) 시 throw. */
  decrypt(token: string): string
}
```

- [ ] **Step 2: 타입체크 확인**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: PASS (신규 파일이 컴파일됨, 미사용이라 영향 없음).

- [ ] **Step 3: 커밋**

```bash
git add src/main/core/secret/types.ts
git commit -m "feat(secret): SecretCrypto 주입 포트 인터페이스 (코어 Electron 비의존, Epic B #27)"
```

---

## Task 3: 엔진 — secretCrypto 옵션·no-op 기본값·buildApiSession 추출 (안전 리팩터)

**Files:**
- Modify: `src/main/core/engine.ts`

이 태스크는 동작 무변경 리팩터다(영속/복원 없음). 기존 테스트 스위트가 회귀 가드다.

- [ ] **Step 1: import 추가** — `engine.ts` 상단 import 블록에 추가:

```ts
import type { SecretCrypto } from './secret/types'
```

- [ ] **Step 2: no-op 기본 crypto 상수 추가** — `engine.ts` 의 `seedCapabilities` 정의 뒤(상수 영역)에 추가:

```ts
// SecretCrypto 미주입(테스트·헤드리스·CLI) 기본값 — 암호화 미가용 → API 세션 미영속(현행 동작 보존).
// isAvailable()===false 가드 뒤에서만 encrypt/decrypt 가 호출되므로 throw 는 정상 경로에 도달하지 않는다.
const NOOP_CRYPTO: SecretCrypto = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('시크릿 암호화 미가용(SecretCrypto 미주입)')
  },
  decrypt: () => {
    throw new Error('시크릿 복호화 미가용(SecretCrypto 미주입)')
  },
}
```

- [ ] **Step 3: FleetEngineOptions 에 secretCrypto 추가** — `engine.ts` 의 `FleetEngineOptions` 인터페이스, `mcpHost?` 필드 뒤에 추가:

```ts
  /** 시크릿(apiKey) 암복호화 백엔드. 미주입 시 API 세션 미영속(현행 동작). main 이 safeStorage 어댑터 주입. */
  secretCrypto?: SecretCrypto
```

- [ ] **Step 4: createFleetEngine 본문에서 secretCrypto 결선** — `engine.ts` 의 `const runner = opts.runner ?? defaultRunner` 줄 뒤에 추가:

```ts
  const secretCrypto = opts.secretCrypto ?? NOOP_CRYPTO
```

- [ ] **Step 5: buildApiSession 추출** — `engine.ts` 의 `syncPersistedSession` 정의 뒤(복원 루프 앞)에 추가. (registerApiSession 의 createApiSession 클로저를 그대로 옮긴 것.)

```ts
  // 라이브 API 세션을 만들어 매니저에 추가한다(순수 — store/audit 부작용 없음). register·restore 공용.
  // capabilities 미지정(신규 등록)이면 provider 시드, 지정(복원)이면 그 값을 적용한다(buildCliSession 대칭).
  const buildApiSession = (config: ApiProviderConfig, capabilities?: AgentRole[]): LlmDescriptor => {
    const id = `api:${config.id}`
    const descriptor: LlmDescriptor = {
      id,
      kind: 'api',
      displayName: config.displayName,
      ref: config.id,
      model: config.model,
      capabilities: capabilities ?? seedCapabilities(config.provider),
    }
    sessions.add(
      createApiSession(descriptor, createApiProvider(config, http), {
        // 토큰 사용량을 'usage' 감사 이벤트로 기록한다(usage-accounting). 도구루프는 합산값.
        onUsage: (usage) => appendAudit('usage', { id, provider: config.provider, ...usage }),
        // 워크스페이스 도구 + MCP 도구를 병합 노출한다. 둘 다 없으면 단발 chat(완전 하위호환).
        toolDeps: () => {
          const wsTools = workspaceDir ? createWorkspaceReadTools(workspaceDir) : []
          const mcpTools = mcpHost.tools()
          if (wsTools.length === 0 && mcpTools.length === 0) return undefined
          return {
            registry: createToolRegistry([...wsTools, ...mcpTools]),
            gate,
            onAudit: appendAudit,
            maxIterations: 8,
          }
        },
      }),
    )
    return descriptor
  }
```

- [ ] **Step 6: registerApiSession 을 buildApiSession 사용으로 축약** — `engine.ts` 의 기존 `registerApiSession(config) { … }` 전체(현 353-386줄)를 교체:

```ts
    registerApiSession(config) {
      const descriptor = buildApiSession(config)
      // 영속은 Task 4 에서 추가(현재는 register 만 — 동작 무변경).
      store.appendEvent({ type: 'session.registered', data: { id: descriptor.id, kind: 'api', provider: config.provider } })
      return descriptor
    },
```

- [ ] **Step 7: 기존 테스트 회귀 없음 확인**

Run: `npx vitest run src/main/core/engine.test.ts`
Expected: PASS (전부 — 동작 무변경 리팩터).

- [ ] **Step 8: 커밋**

```bash
git add src/main/core/engine.ts
git commit -m "refactor(engine): buildApiSession 추출 + secretCrypto 주입 결선(no-op 기본) (Epic B #27)"
```

---

## Task 4: 엔진 — API 세션 암호화 영속 (register 시)

**Files:**
- Modify: `src/main/core/engine.ts`
- Test: `src/main/core/engine.test.ts`

- [ ] **Step 1: fake crypto 헬퍼 추가** — `engine.test.ts` 의 `scriptedHttp` 헬퍼 뒤에 추가(가역·`v1:` 프리픽스 모사):

```ts
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
```

- [ ] **Step 2: 실패 테스트 작성** — `describe('FleetEngine — 세션 영속·복원 (재시작)', …)` 블록 안에 추가:

```ts
  it('암호화 가능 시 API 세션을 암호문으로 영속한다(평문 키 미기록)', () => {
    const store = createMemoryStore()
    const engine = createFleetEngine({ store, secretCrypto: fakeCrypto() })
    engine.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })

    const persisted = store.listSessions()
    expect(persisted).toHaveLength(1)
    const ps = persisted[0]
    expect(ps.kind).toBe('api')
    expect(ps.id).toBe('api:openai-1')
    // 암호문만 — 평문 키는 store 어디에도 없어야 한다.
    expect(ps.kind === 'api' && ps.encryptedApiKey.startsWith('v1:')).toBe(true)
    expect(JSON.stringify(store.snapshot())).not.toContain('sk-secret')
    // config 에서 apiKey 는 빠진다.
    expect(ps.kind === 'api' && 'apiKey' in ps.config).toBe(false)
  })

  it('암호화 미가용(crypto 미주입)이면 API 세션을 영속하지 않는다(graceful degrade)', () => {
    const store = createMemoryStore()
    const engine = createFleetEngine({ store }) // secretCrypto 미주입 → no-op(isAvailable=false)
    engine.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })
    expect(store.listSessions()).toHaveLength(0)
    expect(JSON.stringify(store.snapshot())).not.toContain('sk-secret')
  })
```

- [ ] **Step 3: 기존 경계 테스트 명칭/주석 갱신** — `engine.test.ts` 의 기존 `it('API 세션은 영속하지 않는다(경계)', …)`(현 1326줄) 제목을 아래로 교체(본문 어서션은 그대로 — crypto 미주입이라 여전히 미영속):

```ts
  it('API 세션은 암호화 미주입 시 영속하지 않는다(경계 — Epic B 는 crypto 주입 필요)', () => {
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t "암호화 가능 시 API"`
Expected: FAIL — `persisted` 가 빈 배열(아직 영속 미구현).

- [ ] **Step 5: registerApiSession 에 조건부 영속 추가** — Task 3 Step 6 의 `registerApiSession` 본문을 교체:

```ts
    registerApiSession(config) {
      const descriptor = buildApiSession(config)
      // 영속(조건부): 키가 있고 OS 암호화가 가능할 때만 암호문으로 기록한다 — 평문 키는 store 에 절대 안 남긴다.
      // 미가용(키링 부재 등)이면 미영속 = 현행 동작(재시작 시 재입력). 좀비(키 없는) 세션은 만들지 않는다.
      // 구조분해 후 분해된 apiKey 바인딩을 직접 검사한다(config.apiKey 좁히기는 별 바인딩 apiKey 에 전파 안 됨).
      const { apiKey, ...rest } = config
      if (apiKey && secretCrypto.isAvailable()) {
        store.putSession({
          kind: 'api',
          id: descriptor.id,
          config: rest,
          encryptedApiKey: secretCrypto.encrypt(apiKey),
          capabilities: descriptor.capabilities,
        })
      }
      store.appendEvent({ type: 'session.registered', data: { id: descriptor.id, kind: 'api', provider: config.provider } })
      return descriptor
    },
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t "영속"`
Expected: PASS (신규 2 + 기존 경계 + #52 영속 전부).

- [ ] **Step 7: 커밋**

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(engine): API 세션 apiKey 암호화 영속(register) — 평문 키 미기록 (Epic B #27)"
```

---

## Task 5: 엔진 — 기동 복원(decrypt) + 엔트리별 격리

**Files:**
- Modify: `src/main/core/engine.ts`
- Test: `src/main/core/engine.test.ts`

- [ ] **Step 1: 헤더 캡처 http 헬퍼 추가** — `engine.test.ts` 의 `fakeCrypto` 헬퍼 뒤에 추가:

```ts
/** Authorization 헤더를 캡처하고 유효한 openai 응답을 돌려주는 http(복원 키 왕복 검증용). */
function authCapturingHttp(): { http: HttpClient; authHeaders: string[] } {
  const authHeaders: string[] = []
  const http: HttpClient = async (_url, init) => {
    authHeaders.push(init.headers['authorization'] ?? '')
    return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}]}' }
  }
  return { http, authHeaders }
}
```

- [ ] **Step 2: 실패 테스트 작성** — `describe('FleetEngine — 세션 영속·복원 (재시작)', …)` 블록 안에 추가:

```ts
  it('API 세션을 동일 store+crypto 의 새 엔진에서 복원한다', () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    e1.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })

    const e2 = createFleetEngine({ store, secretCrypto: crypto })
    expect(e2.listSessions().map((s) => s.id)).toEqual(['api:openai-1'])
  })

  it('복원된 API 세션이 복호화된 키를 provider 호출에 사용한다(키 왕복)', async () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    e1.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })

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
    e1.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })
    expect(store.listSessions()).toHaveLength(1) // 영속됨

    const e2 = createFleetEngine({ store, secretCrypto: fakeCrypto(false) }) // 복원 시 암호화 미가용
    expect(e2.listSessions()).toHaveLength(0)
  })

  it('복호화 실패(키회전)는 throw 없이 skip 하고 형제 CLI 는 복원한다', () => {
    const store = createMemoryStore()
    const e1 = createFleetEngine({ store, secretCrypto: fakeCrypto(), runner: roleRunner })
    e1.registerCliSession('claude')
    e1.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })

    // 복원 crypto 가 모든 토큰 복호화에 실패하도록(키회전/OS변경 모의).
    const rotated: import('./secret/types').SecretCrypto = {
      isAvailable: () => true,
      encrypt: (p) => 'v1:' + Buffer.from(p).toString('base64'),
      decrypt: () => {
        throw new Error('decrypt failed')
      },
    }
    const e2 = createFleetEngine({ store, secretCrypto: rotated, runner: roleRunner })
    expect(e2.listSessions().map((s) => s.id)).toEqual(['cli:claude']) // api skip, cli 복원
  })

  it('손상 api 엔트리(config 없음)는 skip 하고 형제는 복원한다', () => {
    const store = createMemoryStore()
    store.putSession({ kind: 'cli', id: 'cli:claude', adapterId: 'claude' })
    // config·encryptedApiKey 누락 손상 엔트리(런타임 형태검증 대상).
    store.putSession({ kind: 'api', id: 'api:broken' } as unknown as Parameters<typeof store.putSession>[0])

    const engine = createFleetEngine({ store, secretCrypto: fakeCrypto(), runner: roleRunner })
    expect(engine.listSessions().map((s) => s.id)).toEqual(['cli:claude'])
  })

  it('API 세션 복원은 session.registered 를 재방출하지 않는다(에코 0)', () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    e1.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })
    createFleetEngine({ store, secretCrypto: crypto }) // 복원 — 추가 방출 없어야 함
    const registered = store.listEvents().filter((ev) => ev.type === 'session.registered')
    expect(registered).toHaveLength(1)
  })
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t "API 세션을 동일 store"`
Expected: FAIL — `e2.listSessions()` 가 빈 배열(복원 미구현).

- [ ] **Step 4: 복원 루프에 api 분기 추가** — `engine.ts` 의 기존 복원 `for` 루프(현 310-328줄)를 교체:

```ts
  const persisted = store.listSessions()
  for (const ps of Array.isArray(persisted) ? persisted : []) {
    try {
      if (ps.kind === 'cli') {
        if (!cliRegistry.get(ps.adapterId)) {
          console.warn('[fleet] 세션 복원 skip — 미지 어댑터:', ps.id, ps.adapterId)
          continue
        }
        buildCliSession({
          adapterId: ps.adapterId,
          model: ps.model,
          stateful: ps.stateful,
          // 손상 capabilities(비배열)는 버리고 재시드 — 렌더러 SessionsPanel 의 .includes 크래시 방지.
          capabilities: Array.isArray(ps.capabilities) ? ps.capabilities : undefined,
        })
      } else if (ps.kind === 'api') {
        // 암호화 미가용이면 복원 불가(평문 키 없음) → skip. 좀비(키 없는) 세션을 만들지 않는다.
        if (!secretCrypto.isAvailable()) {
          console.warn('[fleet] API 세션 복원 skip — 암호화 미가용:', ps.id)
          continue
        }
        // 런타임 형태 검증 — store JSON 은 타입 보장이 없다(손상 엔트리 방어).
        if (typeof ps.id !== 'string' || !ps.config || typeof ps.config.provider !== 'string' || typeof ps.encryptedApiKey !== 'string') {
          console.warn('[fleet] API 세션 복원 skip — 손상 엔트리:', (ps as { id?: unknown }).id)
          continue
        }
        let apiKey: string
        try {
          apiKey = secretCrypto.decrypt(ps.encryptedApiKey)
        } catch (e) {
          console.warn('[fleet] API 세션 복원 skip — 복호화 실패(키회전/손상):', ps.id, e)
          continue
        }
        buildApiSession({ ...ps.config, apiKey }, Array.isArray(ps.capabilities) ? ps.capabilities : undefined)
      }
      // else: 미지 kind(전방호환) → skip
    } catch (err) {
      console.error('[fleet] 세션 복원 실패:', (ps as { id?: unknown })?.id, err)
    }
  }
```

> 주: 위 루프는 기존 cli 분기 로직(미지 어댑터 skip·손상 capabilities 재시드)을 그대로 보존하고 api 분기만 더한다. 기존 복원 루프 위의 주석(R9 한계·격리 설명)은 유지한다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run src/main/core/engine.test.ts`
Expected: PASS (신규 복원 6 + 기존 전부).

- [ ] **Step 6: 커밋**

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(engine): API 세션 기동 복원(decrypt) + 복호화/손상 엔트리별 격리 (Epic B #27)"
```

---

## Task 6: 엔진 — API capabilities 영속(patch)

**Files:**
- Modify: `src/main/core/engine.ts`
- Test: `src/main/core/engine.test.ts`

- [ ] **Step 1: 실패 테스트 작성** — `describe('FleetEngine — 세션 영속·복원 (재시작)', …)` 블록 안에 추가:

```ts
  it('API 세션의 수정된 capabilities 를 복원 시 보존한다(암호문 불변)', () => {
    const store = createMemoryStore()
    const crypto = fakeCrypto()
    const e1 = createFleetEngine({ store, secretCrypto: crypto })
    const d = e1.registerApiSession({ id: 'openai-1', provider: 'openai', displayName: 'GPT', model: 'gpt-5.5', apiKey: 'sk-secret' })
    e1.setSessionCapabilities(d.id, ['planner', 'reviewer'])

    // 암호문은 그대로(키 재암호화 없이 capabilities 만 patch).
    const ps = store.listSessions()[0]
    expect(ps.kind === 'api' && ps.encryptedApiKey.startsWith('v1:')).toBe(true)

    const e2 = createFleetEngine({ store, secretCrypto: crypto })
    expect(e2.listSessions()[0].capabilities).toEqual(['planner', 'reviewer'])
  })
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run src/main/core/engine.test.ts -t "API 세션의 수정된 capabilities"`
Expected: FAIL — 복원된 capabilities 가 patch 미반영으로 시드값(`['implementer']`)이라 불일치.

- [ ] **Step 3: setSessionCapabilities 를 patch 기반으로 통일** — `engine.ts` 의 기존 `setSessionCapabilities(id, roles) { … }`(현 392-398줄)를 교체:

```ts
    setSessionCapabilities(id, roles) {
      const descriptor = sessions.setCapabilities(id, roles)
      if (!descriptor) throw new Error(`알 수 없는 세션: ${id}`)
      // 영속 미러: 키 재암호화 없이 capabilities 만 in-place patch(cli·api 통일). 미영속 세션엔 no-op.
      store.patchSessionCapabilities(id, [...roles])
      store.appendEvent({ type: 'session.capabilities', data: { id, roles: [...roles] } })
      return descriptor
    },
```

> 주: 기존 cli 경로가 쓰던 `syncPersistedSession(descriptor)` 호출을 patch 로 대체한다. cli 세션은 register 시 이미 영속되므로 patch 가 항상 적중 → #52 의 `사용자 수정 capabilities 를 복원 시 보존한다` 테스트는 그대로 green. `syncPersistedSession` 헬퍼는 `registerCliSession` 에서 계속 사용하므로 삭제하지 않는다.

- [ ] **Step 4: 테스트 통과 확인 (cli 회귀 포함)**

Run: `npx vitest run src/main/core/engine.test.ts -t capabilities`
Expected: PASS (신규 api + 기존 cli `setSessionCapabilities`·`사용자 수정 capabilities` 전부).

- [ ] **Step 5: 커밋**

```bash
git add src/main/core/engine.ts src/main/core/engine.test.ts
git commit -m "feat(engine): setSessionCapabilities 를 patchSessionCapabilities 로 통일(api 영속 보존) (Epic B #27)"
```

---

## Task 7: safeStorage 어댑터 (main, Electron 의존)

**Files:**
- Create: `src/main/secret-crypto.ts`

vitest 커버리지 밖(Electron 런타임 의존) — typecheck/build 로 검증.

- [ ] **Step 1: 어댑터 생성**

```ts
// src/main/secret-crypto.ts
import { safeStorage } from 'electron'
import type { SecretCrypto } from './core/secret/types'

// 암호문 포맷 버전 — 향후 async safeStorage(Electron 41/42)나 다른 backend 이전 시 마이그레이션 식별자.
const V1 = 'v1:'

/**
 * Electron safeStorage 기반 SecretCrypto(동기). Electron 33 은 동기 API 만 제공한다.
 * (encryptStringAsync 등 async 변형은 최신 Electron 전용 — 33→42 업그레이드 후속.)
 * 코어가 electron 을 import 하지 않도록 어댑터를 main 에 둔다(engine 에 주입).
 */
export function createSafeStorageCrypto(): SecretCrypto {
  return {
    isAvailable() {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false
        // Linux 키링 부재 시 basic_text(평문 폴백)는 실보호가 0 → 미사용 취급(secure-by-default).
        // mac(Keychain)/win(DPAPI)은 항상 실암호화.
        return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
      } catch {
        return false
      }
    },
    encrypt(plain) {
      return V1 + safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(token) {
      if (!token.startsWith(V1)) throw new Error('알 수 없는 암호문 포맷')
      return safeStorage.decryptString(Buffer.from(token.slice(V1.length), 'base64'))
    },
  }
}
```

- [ ] **Step 2: 타입체크 확인**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add src/main/secret-crypto.ts
git commit -m "feat(secret): safeStorage 동기 어댑터(v1: 프리픽스·basic_text 차단) (Epic B #27)"
```

---

## Task 8: main 배선 — 엔진에 crypto 주입

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: import 추가** — `index.ts` 의 `import { installPermissionGuards } from './permission-guards'` 줄 뒤에 추가:

```ts
import { createSafeStorageCrypto } from './secret-crypto'
```

- [ ] **Step 2: createFleetEngine 호출에 secretCrypto 주입** — `index.ts` 의 `buildEngine()` 안 `createFleetEngine({ … })` 호출에서 `runner: e2e ? e2eRunner : undefined,` 줄 뒤에 추가:

```ts
    // 시크릿(apiKey) 영속용 OS 암호화 백엔드 주입. buildEngine 은 app.whenReady 이후 호출되므로
    // (Linux 키링 등) safeStorage 가용성 판정이 정상 동작한다. 코어는 이 포트만 알고 electron 비의존.
    secretCrypto: createSafeStorageCrypto(),
```

- [ ] **Step 3: 타입체크 + 빌드 smoke 확인**

Run: `npm run typecheck && npm run build`
Expected: PASS (빌드 = 기동 가능성 smoke).

- [ ] **Step 4: 커밋**

```bash
git add src/main/index.ts
git commit -m "feat(main): 엔진에 safeStorage SecretCrypto 주입 — API 세션 영속 활성화 (Epic B #27)"
```

---

## Task 9: 전체 품질 게이트 + 최종 점검

**Files:** (수정 없음 — 게이트 실행. 위반 시 해당 태스크로 돌아가 수정)

- [ ] **Step 1: 4종 게이트 실행**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: 전부 PASS — lint 경고 0, 테스트 신규 ~12건 포함 전건 green.

- [ ] **Step 2: 평문 키 누출 최종 스캔** (수동 확인) — 영속/이벤트 경로에 평문 키가 새지 않는지 코드 재확인:
  - `registerApiSession` 이벤트 data 에 `apiKey` 없음(`{id,kind,provider}` 만).
  - `PersistedApiSession.config` 가 `Omit<…,'apiKey'>` 라 직렬화에 키 부재.
  - 신규 테스트 `JSON.stringify(store.snapshot())).not.toContain('sk-secret')` 가 회귀 잠금.

- [ ] **Step 3: 위반 없으면 종료. 있으면 수정 후 해당 태스크 재실행.**

---

## Self-Review (작성자 점검 완료)

**1. 스펙 커버리지:** §1 SecretCrypto 포트→Task2/7, §1 주입→Task3/8, §2 데이터 모델→Task1, §3 store patch→Task1, §4 buildApiSession/register/restore/capabilities→Task3/4/5/6, §4 런타임 형태검증→Task5, §5 IPC 무변경→(변경 없음, 확인됨), §6 보안(평문키0·basic_text·키회전)→Task4/5/7/9, §7 테스트 전 항목→Task1/4/5/6. 갭 없음.

**2. Placeholder 스캔:** TBD/TODO/"적절히"/"유사" 없음 — 모든 코드 스텝에 실제 코드 포함.

**3. 타입 일관성:** `SecretCrypto{isAvailable/encrypt/decrypt}` (Task2 정의 ↔ Task3 no-op ↔ Task4 fake ↔ Task7 어댑터) 일치. `PersistedApiSession{kind,id,config,encryptedApiKey,capabilities}` (Task1 정의 ↔ Task4 putSession ↔ Task5 복원) 일치. `buildApiSession(config, capabilities?)` (Task3 정의 ↔ Task5 호출) 일치. `patchSessionCapabilities(id, capabilities)` (Task1 ↔ Task6) 일치. `createApiProvider(config, http)`·`createApiSession(descriptor, provider, opts)` 시그니처 기존 코드와 일치.

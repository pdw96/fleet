# api-session-safestorage (Epic B) — 설계

- **이슈**: #27 백로그 🟡 Next#1 `safeStorage 시크릿 영속 (Epic B)`
- **날짜**: 2026-06-16
- **선행**: #52 `session-apikey-persist` CLI-first 슬라이스(`docs/.../2026-06-12-session-apikey-persist-design.md`). 이 문서는 그 Epic B(API 세션·apiKey)다.
- **범위**: API 세션 디스크립터 + **암호화된 apiKey** 를 영속하고 기동 시 라이브 복원해, 재시작 후 API 세션 증발(키 재입력 마찰)을 없앤다.

## 검증 기록 (추측 금지 — context7 + 설치 타입 + Codex 교차검증)

- **context7**(`/electron/electron`, main 문서): `safeStorage` 는 async API(`encryptStringAsync`/`decryptStringAsync`/`isAsyncEncryptionAvailable`)를 권장하며 동기 API 는 "미래 버전에서 폐기될 수 있음"(아직 폐기 아님).
- **설치 타입**(`node_modules/electron/electron.d.ts:10735` `interface SafeStorage`): Electron **33.4.11** 은 **동기 API만** 보유 — `encryptString`/`decryptString`/`isEncryptionAvailable`/`getSelectedStorageBackend`/`setUsePlainTextEncryption`. **async 변형은 33에 없음**(최신 Electron 전용).
- **결론**: 이슈가 적은 "`encryptStringAsync` 로 설계갱신 선행"은 최신 Electron 전제 → **설치 33 에선 동기 API 사용**. async 전환은 Electron 33→42 업그레이드(이슈 #27 Later 티어)에 종속 → 본 슬라이스 밖.
- **Codex `codex exec` 리뷰**(gpt-5.5, read-only): `package.json`·`electron.d.ts` 독립 확인 후 "진행해도 됩니다". must-fix 3(전부 본 설계 반영)·should-fix(런타임 형태검증 추가)·nice(버전 프리픽스 암호문) 수용.

## 문제

`registerApiSession`(`engine.ts:353`)은 라이브 `ApiSession` 만 만들고 **영속하지 않는다**(주석에 "safeStorage 후속, Epic B" 명시). repo-wide `safeStorage` grep 0건. 따라서 앱 재시작마다 API 세션이 전소하고, 사용자는 provider 키를 매번 재입력해야 한다. PR #63(OpenAI-호환 provider)으로 API 세션 가치가 커져 마찰이 확대됐다.

CLI 세션은 #52 로 영속·복원되나(`PersistedSession{kind:'cli'}`), API 는 `apiKey` 가 **항상 secret** 이라 평문 store(`fleet-store.json`)에 쓸 수 없어 미뤄졌다. 본 슬라이스가 OS 암호화(safeStorage)로 그 공백을 메운다.

## 목표 / 비목표

- **목표**: API 세션 디스크립터(비밀 제외 필드) + **암호화된 apiKey** 를 영속하고, 엔진 기동 시 복호화해 라이브 `ApiSession` 으로 복원한다. CLI 미러 패턴(#52)의 API 판.
- **비목표(이번 슬라이스 아님)**:
  - **async safeStorage** — Electron 33 미보유. Electron 41/42 업그레이드(Later) 후 별도.
  - 복원 skip 사유의 **사용자 가시화 UI**(stale-session 표시) — warn 만, 후속.
  - 클라우드 백엔드/크로스-디바이스 동기화(Epic C) — secret 수탁 liability·별도 설계 사이클.
  - CLI `mcpConfig` 영속 — #52 와 동일하게 평문 영속 제외 유지(본 슬라이스 무관).

## 설계 원칙

> **평문 store(`fleet-store.json`)는 비밀이 아닌 descriptor·config 필드만 보관한다.
> 유일한 secret 인 `apiKey` 는 OS 암호화(safeStorage)를 거친 암호문(base64)으로만 기록한다 —
> 평문 apiKey 는 store·audit·로그 어디에도 남기지 않는다.**

- **코어 Electron 비의존 유지**(AGENTS.md): 코어는 `electron` 을 import 하지 않는다. 암복호화는 `SecretCrypto` 포트로 추상화하고 `main/index.ts` 가 safeStorage 백엔드를 주입한다(`store`/`http`/`approver` 주입과 동일 패턴).
- **동기 계약 유지**: Electron 33 동기 safeStorage 사용 → `registerApiSession` 동기 유지 → IPC/preload 시그니처 무변경(재시작 함정 회피). 동기 store·동기 기동 복원 아키텍처와 정합.
- **두 진실원천 분리**(#52 와 동일): `SessionManager`(런타임 라이브 세션) ↔ `Store.sessions`(재시작 간 영속). 등록 생명주기에서 동기화.
- **graceful degradation**: 암호화 불가(키링 부재·basic_text)면 API 미영속 = 현행 동작(키 재입력). 좀비(키 없는) 세션은 만들지 않는다.

## 컴포넌트

### 1. SecretCrypto 포트 (코어) + safeStorage 어댑터 (main)

```ts
// src/main/core/secret/types.ts (코어 — Electron 비의존)
/**
 * 시크릿 암복호화 포트. 코어는 safeStorage(electron)를 직접 import 하지 않고 main 이 주입한다.
 * Electron 33 은 동기 safeStorage 만 제공 → 동기 계약. (async 변형은 후속 Electron·후속 PR.)
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

```ts
// src/main/secret-crypto.ts (main — Electron 의존, 비-vitest)
import { safeStorage } from 'electron'
import type { SecretCrypto } from './core/secret/types'

const V1 = 'v1:' // 암호문 포맷 버전 — 향후 async/다른 backend 이전 시 마이그레이션 식별자.

export function createSafeStorageCrypto(): SecretCrypto {
  return {
    isAvailable() {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false
        // Linux 키링 부재 시 basic_text(평문 폴백)는 실보호 0 → 미사용 취급(secure-by-default).
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

- `createFleetEngine` 옵션에 `secretCrypto?: SecretCrypto` 추가. **기본값 = no-op**(`isAvailable()===false`, encrypt/decrypt throw) → 미주입(테스트·헤드리스·CLI)이면 API 미영속 = **현행 동작 보존**. `isAvailable()` 가드 뒤라 throw 는 정상 경로에서 안 남.
- `main/index.ts` `buildEngine()` 가 `createSafeStorageCrypto()` 를 주입(1줄). `buildEngine` 은 `app.whenReady().then` 안에서 호출(`index.ts:166`)되므로 복원 시점에 app ready → Linux 동기 가용성 정상.
- **버전 프리픽스**: 암호문 포맷 식별자(`v1:`)를 어댑터 내부에 캡슐화. 엔진/store 는 토큰을 불투명 문자열로 다룬다.

### 2. 데이터 모델 — `src/main/core/store/types.ts` (main 전용, IPC 미통과)

`PersistedSession` 을 판별 유니온으로 확장(기존 cli 보존):

```ts
export type PersistedSession = PersistedCliSession | PersistedApiSession

/** 기존(#52) — 이름만 분리, 구조 불변. */
export type PersistedCliSession = {
  kind: 'cli'
  id: string
  adapterId: string
  model?: string
  stateful?: boolean
  capabilities?: AgentRole[]
}

/**
 * 재시작 복원할 API 세션. apiKey 는 평문 미기록 — safeStorage 암호문(base64+버전프리픽스)만.
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

`ApiProviderConfig` 는 `shared/types.ts` 에서 import(렌더러 공유 타입 — 이미 `store/types.ts` 가 `AgentRole` 등을 거기서 import). `PersistedSession` 은 렌더러로 안 건너가므로(렌더러는 `LlmDescriptor` 만) `store/types.ts` 유지. `StoreState.sessions: PersistedSession[]` 타입은 자동으로 유니온 수용(필드 변경 없음).

### 3. Store 인터페이스 + 구현 — `store/types.ts`, `store/memory.ts`

기존 `putSession`/`deleteSession`/`listSessions` 는 유니온을 그대로 수용(upsert-by-id 불변). **신규 1개**:

```ts
/** 영속 세션의 capabilities 만 in-place 갱신(부재 시 no-op). API 키를 다시 안 받고 capabilities 만 바꾸는 경로. */
patchSessionCapabilities(id: string, capabilities: AgentRole[]): void
```

- `memory.ts`: `state.sessions.find(s => s.id===id)` 후 `s.capabilities = [...capabilities]` + `save()`. 못 찾으면 no-op(미영속 API 세션 = 암호화 불가 등록분 → 조용히 무시).
- json-file 무변경(snapshot/persist 전체-clone 경로 그대로). 구버전 파일은 기존 `{...EMPTY, ...parsed}` 머지로 `sessions:[]` 자동 보강.

> **왜 patch 인가**: API capabilities 변경 시 호출자에 apiKey 가 없다(라이브 descriptor 에도 키 미노출). 기존 암호문을 보존한 채 capabilities 만 갱신해야 하므로 전체 putSession(키 필요) 대신 in-place patch. CLI 도 동일 메서드로 통일(register 때 이미 영속됨 → 항상 적중).

### 4. 엔진 — `src/main/core/engine.ts`

- **`buildApiSession(config, capabilities?)` 추출**(순수 — store/audit 부작용 0): descriptor 생성 + `createApiProvider(config, http)` + `createApiSession(...)`(현 `registerApiSession` 의 `onUsage`/`toolDeps` 클로저 이동) + `sessions.add`. register·restore 공용. `buildCliSession` 대칭. capabilities 미지정=시드, 지정(복원)=그 값 적용.
- `registerApiSession(config)`:
  - `descriptor = buildApiSession(config)`
  - **영속(조건부)**: `config.apiKey && secretCrypto.isAvailable()` 면 `const { apiKey, ...rest } = config` → `store.putSession({ kind:'api', id: descriptor.id, config: rest, encryptedApiKey: secretCrypto.encrypt(apiKey), capabilities: descriptor.capabilities })`. 아니면 **영속 skip**(평문 키 미기록 — 현행 동작).
  - `store.appendEvent({ type:'session.registered', data:{ id, kind:'api', provider: config.provider } })`(키 미포함 — 기존 그대로).
  - **동기 유지** — 반환 `LlmDescriptor`(IPC 시그니처 무변경).
- `setSessionCapabilities(id, roles)`: `sessions.setCapabilities` → `store.patchSessionCapabilities(id, [...roles])`(양 kind 통일·키 불요) → event. (기존 cli-전용 `syncPersistedSession` 호출을 patch 로 대체 — 동일 결과·api 포함.)
- `registerCliSession`/`removeSession`/`syncPersistedSession`(cli register 전용) **불변**.
- **기동 복원 루프 확장**(기존 `engine.ts:310` cli 루프에 api 분기 추가):

```ts
for (const ps of Array.isArray(persisted) ? persisted : []) {
  try {
    if (ps.kind === 'cli') {
      if (!cliRegistry.get(ps.adapterId)) { console.warn('…미지 어댑터', ps.id); continue }
      buildCliSession({ adapterId: ps.adapterId, model: ps.model, stateful: ps.stateful,
        capabilities: Array.isArray(ps.capabilities) ? ps.capabilities : undefined })
    } else if (ps.kind === 'api') {
      if (!secretCrypto.isAvailable()) { console.warn('[fleet] API 세션 복원 skip — 암호화 미가용:', ps.id); continue }
      // 런타임 형태 검증 — store JSON 은 타입 보장 없음(손상 엔트리 방어, Codex should-fix).
      if (typeof ps.id !== 'string' || !ps.config || typeof ps.config.provider !== 'string' || typeof ps.encryptedApiKey !== 'string') {
        console.warn('[fleet] API 세션 복원 skip — 손상 엔트리:', (ps as { id?: unknown }).id); continue
      }
      let apiKey: string
      try { apiKey = secretCrypto.decrypt(ps.encryptedApiKey) }
      catch (e) { console.warn('[fleet] API 세션 복원 skip — 복호화 실패(키회전/손상):', ps.id, e); continue }
      buildApiSession({ ...ps.config, apiKey }, Array.isArray(ps.capabilities) ? ps.capabilities : undefined)
    }
    // else: 미지 kind(전방호환) → skip
  } catch (err) {
    console.error('[fleet] 세션 복원 실패:', (ps as { id?: unknown })?.id, err)
  }
}
```

- **복원은 `session.registered` 재방출·store 재기록 안 함**(buildApiSession 은 순수 — 에코 0·중복 audit 0, cli 와 동일 규칙).

### 5. IPC / preload — **무변경**

신규 IPC 표면 없음. `registerApiSession` 동기 유지 → 기존 `fleet:session:registerApi` 핸들러·preload 그대로. 복원분은 기존 `fleet:session:list` 가 자동 표면화. **preload 재시작 함정 회피.**

## 데이터 흐름

1. API 등록(`registerApiSession`) → 라이브 add + (암호화 가능 시) `Store.sessions` 암호문 upsert + json-file 동기 기록 + `session.registered` 이벤트.
2. capabilities 변경 → 라이브 in-place + `Store.patchSessionCapabilities`(키 보존, 암호문 불변).
3. 제거(`removeSession`) → 라이브 delete + `Store.deleteSession`.
4. 종료(`dispose`→`disposeAll`) → 라이브 map 만 clear(**store 미접촉** — 영속 보존).
5. 재기동 → json-file 로드 → 엔진 복원 루프가 decrypt → `buildApiSession` 라이브 재구성 → `listSessions` 표면화 → 재시작 후 API 세션 사용 가능(키 재입력 불요).

## 에러 처리 / 보안

- **평문 키 0**: apiKey 평문은 store·`session.registered` 이벤트·로그 어디에도 미기록. 스냅샷 JSON 에 평문 키 부재를 테스트로 잠근다.
- **암호화 불가/basic_text** → API 미영속(graceful degrade). 좀비(키 없는·런타임 실패할) 세션은 만들지 않는다.
- **복호화 실패·미지 포맷·손상 엔트리** → 해당 세션만 skip+warn, 형제(cli/api) 복원·부팅 brick 없음. 기존 `Array.isArray(sessions)` 전체 가드 + 엔트리별 try/catch + **api 런타임 형태 검증** 3중.
- **baseUrl**(openai-compatible 사설 엔드포인트 가능)은 자격증명이 아니라 평문 유지(문서화된 의도).
- **버전 프리픽스**: 복호화 시 `v1:` 미스매치는 throw → skip(미지 포맷 안전 처리).

## 테스트 (TDD, vitest 코어 — Electron 비의존, 가역 fake crypto 주입)

가역 fake: `encrypt = p => 'v1:'+base64(p)`, `decrypt = t => base64decode(t.slice(3))`(미지 프리픽스 throw), `isAvailable = ()=>true`.

엔진 영속/복원:
- API register(암호화 가능) → store 에 `encryptedApiKey`(평문 아님) 영속 → **동일 store+crypto 로 엔진 재생성 → 복원**(`listSessions` 포함).
- **복원 세션이 복호화된 키 사용**: fake http 가 Authorization 헤더 캡처 → 복원 후 호출 경로에서 원래 apiKey 도달 검증(키 왕복 증명).
- 암호화 불가(`isAvailable()===false`) → **미영속** → 재생성 → 미복원. 스냅샷에 키·엔트리 부재.
- 복호화 throw(키회전 모의) → skip + 형제 cli 복원 + **throw 없음**.
- 손상 api 엔트리(config 없음/encryptedApiKey 비문자열) → skip + 형제 복원.
- capabilities 변경 → `patchSessionCapabilities` 로 영속 → 재생성 → 보존(암호문 불변·재시드 안 됨).
- `removeSession`(api) → 재생성 → 소멸.
- 복원이 `session.registered` 재방출 안 함(에코 0 — 이벤트 카운트).
- **평문 키 부재 불변**: `JSON.stringify(store.snapshot())` 에 원본 apiKey 문자열 미포함.
- 미지 kind 영속 → skip(전방호환, 기존).

store/memory:
- `patchSessionCapabilities` in-place 갱신 + 부재 시 no-op.
- `putSession`(kind:'api') upsert + `listSessions` 왕복.
- json-file 왕복: 암호문 영속 세션 reload 생존 + 구버전 파일 → `sessions:[]`.

## 품질 게이트

`npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build` 4종 + CI(ubuntu+windows). 머지 전 Codex 봇 자동 리뷰 대기·반영(merge-requires-confirmation 규율).

## 리스크 대장

| ID | 리스크 | 처리 |
|----|--------|------|
| R1 | apiKey 평문 store/로그 노출 | **해소** — safeStorage 암호문만, 스냅샷 평문키 부재 테스트 |
| R2 | 암호화 불가 환경(Linux 무키링/basic_text)서 미영속 마찰 | 수용 — graceful degrade(현행 동작), basic_text 차단으로 거짓-암호화 방지 |
| R3 | 손상/비배열 sessions 가 엔진 생성 brick | **완화** — `Array.isArray` 전체 가드(#52 기존) + 엔트리별 try/catch + api 런타임 형태검증 |
| R4 | 복호화 실패(키회전·OS 변경·손상) | **완화** — 해당 세션 skip+warn, 형제 복원, 부팅 정상 |
| R5 | async safeStorage 미사용(폐기 경고) | 수용 — Electron 33 미보유. 버전 프리픽스로 41/42 업그레이드 후 마이그레이션 용이(후속) |
| R6 | 미지 암호문 포맷(다운그레이드/타 backend) | **완화** — `v1:` 프리픽스 미스매치 throw → skip |
| R7 | capabilities patch 가 미영속 api 세션에 no-op(드리프트) | 수용 — 미영속 세션은 재시작 소멸이므로 patch 무의미(일관) |
| R8 | 복원된 API 세션이 런타임에 키 무효(만료·회전) | 수용 — 호출 시 provider 가 401 표면화(#7 정합), 본 슬라이스 밖 |

## 후속(이번 슬라이스 밖)

- **async safeStorage 전환**: Electron 33→42 업그레이드(이슈 #27 Later) 후 `SecretCrypto` 를 Promise 반환형으로, 어댑터를 `encryptStringAsync`/`decryptStringAsync` 로 교체. 버전 프리픽스로 기존 암호문 호환.
- **복원 skip 사유 가시화**: stale/미복원 세션을 렌더러에 표시(현재 warn 만).
- **Epic C**: 클라우드 백엔드(동기화·팀) — secret 수탁 liability·아키텍처 계약 재검토.

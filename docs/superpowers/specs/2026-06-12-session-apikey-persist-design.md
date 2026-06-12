# session-apikey-persist (CLI-first 슬라이스) — 설계

- **이슈**: #27 백로그 🔴 Now② `session-apikey-persist`
- **날짜**: 2026-06-12
- **범위**: 이번 슬라이스 = **CLI 세션 영속·복원만**. API 세션(apiKey)·secret 가능 필드는 safeStorage 후속(Epic B).

## 문제

세션은 `createSessionManager()` 의 `new Map()`(메모리)에만 존재한다. `StoreState` 에 `sessions`
필드가 없어 **앱 재시작 시 등록 세션이 전소**한다. 그 결과 `engine.ts:364` 의
`if (llmIds.length === 0) throw …('등록된 LLM 세션이 없습니다')` 가 발동해 **재시작 후 첫
오케스트레이션 실행이 항상 차단**된다(사용자가 세션을 다시 등록해야 함).

## 목표 / 비목표

- **목표**: CLI 세션 디스크립터를 영속하고 엔진 기동 시 라이브로 복원해, 재시작 후 첫 실행 차단을 없앤다.
- **비목표(이번 슬라이스 아님)**:
  - API 세션(apiKey) 영속 — 키는 *항상* secret → safeStorage 필요(Epic B).
  - mcpConfig 영속 — 인라인 JSON 이 secret 을 품을 수 있어 평문 store 에 쓰지 않는다.
  - 클라우드 백엔드/크로스-디바이스 동기화(Epic C) — 별도 설계 사이클.

## 설계 원칙

> **평문 store(`fleet-store.json`)는 비밀이 아닌 descriptor 필드만 보관한다.
> secret 가능 필드(지금 mcpConfig, 곧 apiKey)는 safeStorage 를 거치거나 영속하지 않는다.**

CLI 디스크립터에서 secret 가능 필드는 mcpConfig 하나뿐이며(나머지는 모델명·불리언·역할),
그것을 영속에서 빼면 CLI 영속은 완전히 탈-secret 이 된다. 핵심 가치(재시작 차단 해소)는
mcpConfig 없이도 100% 달성된다(MCP 는 claude 전용·선택적 고급 옵션).

두 진실원천을 명확히 분리한다:
- **`SessionManager`(런타임)**: 라이브 `LlmSession` 객체. 한 세션 수명 동안의 진실원천.
- **`Store.sessions`(영속)**: 직렬화 `PersistedSession[]`. 재시작 간 진실원천.

엔진이 등록 생명주기에서 둘을 **단일 헬퍼(`syncPersistedSession`)** 로 동기화한다.

## 컴포넌트

### 1. 데이터 모델 — `src/main/core/store/types.ts` (main 전용, IPC 미통과)

```ts
/**
 * 재시작 간 복원할 직렬화 세션. 이번 슬라이스는 CLI 만 — 구독 CLI 는 자체 인증을 가져
 * 저장할 비밀값이 없다. mcpConfig 는 의도적으로 제외(인라인 JSON 이 secret 운반 가능 → 평문 영속 금지).
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

`StoreState` 에 `sessions: PersistedSession[]` 추가(required, 기본 `[]` — projects/tasks 와 동일
패턴). json-file 은 `{ ...EMPTY, ...parsed }` 머지라 구버전 파일은 자동으로 `sessions: []`.

`PersistedSession` 은 렌더러로 건너가지 않으므로(렌더러는 `LlmDescriptor` 만 받음) `shared/types.ts`
가 아닌 `store/types.ts` 에 둔다(AGENTS.md: shared 는 cross-boundary 타입만).

### 2. Store 인터페이스 + 구현 — `store/types.ts`, `store/memory.ts`, `store/json-file.ts`

```ts
// Store 인터페이스 추가
putSession(session: PersistedSession): void   // id 로 upsert + save()
deleteSession(id: string): void               // + save()  (engine.removeSession 과 구분 위해 delete-)
listSessions(): PersistedSession[]
```

> **네이밍 주의**: store 메서드는 `deleteSession`, 엔진 메서드는 `removeSession`(FleetEngine 계약,
> 불변). 서로 다른 인터페이스지만 동명이면 교차-세션 작업 시 혼동 → store 쪽을 `delete-` 로 구분한다.

- `memory.ts`: `emptyState()` 에 `sessions: []`. 세 메서드를 `state.sessions` 위에 구현(`save()` 호출).
  `putSession` 은 id 일치 시 교체, 없으면 push(**filter-rewrite 금지 — upsert-by-id 만**, 전방호환 불변).
- `json-file.ts`: `EMPTY` 에 `sessions: []`. snapshot/persist 는 기존 전체-clone 경로 그대로.

### 3. 엔진 — `src/main/core/engine.ts`

- **`buildCliSession(input)` 추출**(순수 런타임 빌드): registry 조회 → descriptor 생성 → `sessions.add()`.
  **store/audit 부작용 0**. 미지 adapter 면 throw. register·restore 공용(= `sessionmanager-add-silent`
  의존성의 실체). 시그니처:
  ```ts
  function buildCliSession(input: {
    adapterId: string
    model?: string
    stateful?: boolean
    mcpConfig?: string      // register 경로만 전달 — 런타임 descriptor 에 적용. restore 는 미전달(영속 제외).
    capabilities?: AgentRole[]
  }): LlmDescriptor
  ```
  mcpConfig 는 **런타임 descriptor 에는 그대로 적용**(메모리 사용은 안전) — 영속에서만 뺀다. 즉
  register 직후엔 MCP 가 동작하고, 재시작 복원 후엔 mcpConfig 가 빠진 채 살아난다(문서화된 의도).
- **`syncPersistedSession(descriptor)` 헬퍼**(단일 미러 지점, R4 완화): 라이브 CLI descriptor →
  `PersistedSession`(mcpConfig 제외) → `store.putSession`. `kind==='cli'` 일 때만.
- `registerCliSession` = `buildCliSession(...)` + `syncPersistedSession(descriptor)` + `appendEvent('session.registered')`.
- `setSessionCapabilities` = `sessions.setCapabilities(...)` + 반환 descriptor 가 cli 면 `syncPersistedSession`
  (수정된 capabilities 영속 → 재시작 보존).
- `removeSession`(엔진) = `sessions.remove(id)` + `store.deleteSession(id)`.
- `registerApiSession` **불변**(store 미기록) + 코드 주석: "API 영속은 safeStorage 후속(Epic B)".
- **기동 복원**(엔진 셋업 말미, deps 준비 후·`return` 전):

```ts
// 재시작 복원: 영속 CLI 세션을 라이브로 재구성. registry 에 있는 adapter 만(탐지=별개 — 등록≠탐지).
// 복원은 store 를 재기록하지 않고(이미 있음) session.registered 도 재방출하지 않는다(에코·중복 audit 없음).
// 손상 엔트리가 엔진 생성을 막지 않도록 전체/엔트리별로 격리한다(앱 부팅 brick 방지, R3).
for (const ps of store.listSessions()) {
  try {
    if (ps.kind !== 'cli') continue                    // 미지 kind(전방호환) skip
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

### 4. IPC / preload

**무변경.** 신규 IPC 표면 없음 — 렌더러 기존 `fleet:session:list` 가 복원된 세션을 자동 표면화한다.
preload 재시작 함정(AGENTS.md) 회피.

## 데이터 흐름

1. 등록(`registerCliSession`) → 라이브 add + `Store.sessions` upsert + json-file 동기 기록.
2. capabilities 변경 → 라이브 in-place + `Store.sessions` upsert.
3. 제거 → 라이브 delete + `Store.sessions` 삭제.
4. 종료(`dispose`→`disposeAll`) → 라이브 map 만 clear(**store 미접촉** — 영속 보존).
5. 재기동 → json-file 로드(`sessions` 포함) → 엔진 복원 루프가 라이브 재구성 → `listSessions` 이 표면화 →
   `engine.ts:364` throw 더 이상 발동 안 함.

## 에러 처리

- 복원 루프 전체/엔트리별 try/catch → 손상·미지 엔트리가 부팅을 막지 못함.
- 미지 adapter → console.warn 후 skip(영속 store 스팸 회피, R7). 내구 가시화(stale-session UI)는 미래 작업.
- buildCliSession throw(미지 adapter)는 복원 가드(`registry.get`) 뒤라 정상 경로에선 안 남.

## 테스트 (TDD, vitest 코어 — Electron 비의존)

엔진 영속:
- register CLI → 동일 store 로 엔진 재생성 → 복원됨(`listSessions` 포함).
- capabilities 수정 → 재생성 → 보존(재시드 안 됨).
- `removeSession` → 재생성 → 소멸.
- 미지 adapter 영속 → skip(미복원), 형제는 복원, **throw 없음**.
- 복원이 `session.registered` 재방출 안 함(에코 0 — 이벤트 카운트 검증).
- API register → 재생성 → **미복원**(경계 문서화).
- **mcpConfig 비밀-누락 불변**: mcpConfig 로 register → 라이브 descriptor 는 mcpConfig 보유(런타임) →
  재생성 → 복원 descriptor 는 mcpConfig **미보유**(평문 영속 제외 검증).

store/json-file:
- `putSession`/`deleteSession`/`listSessions` + snapshot 에 sessions 포함.
- json-file 왕복: 영속 세션이 reload 생존.
- 구버전 파일(sessions 없음) → `[]`.

## 품질 게이트

`npm run typecheck` · `npm run lint`(경고 0) · `npm test` · `npm run build` 4종 + CI(ubuntu+windows).

## 리스크 대장

| ID | 리스크 | 처리 |
|----|--------|------|
| R1 | mcpConfig 인라인 JSON 평문 영속(secret 노출) | **해소** — mcpConfig 미영속 |
| R2 | 반쪽 복원 → 역할 배정 침묵 드리프트; API-only 사용자 #364 잔존 | 본질적 한계 — Epic B 까지 잔존(문서화) |
| R3 | 복원 실패가 엔진 생성 brick | **완화** — 전체/엔트리별 try/catch |
| R4 | 이중 진실원천 동기화 드리프트(미래) | **완화** — `syncPersistedSession` 단일 미러 |
| R5 | 바이너리 미설치 세션 침묵 부활 → 런타임 실패 | 수용 — 기존 register 의미(등록≠탐지)와 일치 |
| R6 | 앱 업그레이드 시 seed 변경분 미반영(capabilities 고착) | 수용 — minor, user-set 보존이 의도 |
| R7 | restore.skipped 매 기동 누적 | **완화** — console.warn(transient), 미영속 |
| R8 | 구버전이 신 store 의 `kind:'api'` 읽기 | 안전 — `continue` skip; **upsert-by-id 불변 유지**(배열 filter-rewrite 금지) |

## 후속(이번 슬라이스 밖)

- **Epic B**: API 세션 영속 — apiKey/인라인 mcpConfig 를 safeStorage 로 암호화하거나 BYO-참조.
- **Epic C**: 클라우드 백엔드(동기화·팀) — secret 수탁 liability·오프라인·아키텍처 계약 재검토 필요.

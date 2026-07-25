# C1 스펙 — 승인 보류(hold-with-expiry)·스냅숏 편입·재하이드레이션 (#216 Phase C · Part of #193)

체크포인트 1(설계) 채택안을 **구현 가능한 계약**으로 확정한다. 설계 리뷰의 Codex P1×2(P1-1 취소
그래프, P1-2 tombstone/dedupe)를 계약의 1급 항목으로 편입한다. 이 문서는 **무엇(계약·불변식·테스트)**
을 정의하고, **어떻게(태스크 순서)** 는 체크포인트 3(계획, fleet-plan-panel)에 위임한다.

> **적대 검증 반영**: 본 스펙은 로컬 fleet-refuter 4렌즈(보안 fail-closed·race/취소·타입/parity·테스트
> 완전성)로 사전 검증했다. 설계 코어는 P1 kill 0 로 생존했고, 확정 하드닝 갭(불변식 미명시·replace/upsert
> 모순·withdrawn 페이로드 형태·§2 표 누락·리스너 정리 전경로·픽스처 시계 규율·approver 타이머 clock 주입)을
> §1.8 불변식·§2·§3 에 편입했다.

## 0. 현행 계약 (코드 실측 — 근거 라인)

| 지점 | 현행 동작 | 근거 |
|---|---|---|
| `createIpcApprover({send, hasWindow, timeoutMs?})` | `approver(req)`: `!hasWindow()`→즉시 `false`. 아니면 `setTimeout(timeoutMs=60s)` 무장 후 `pending.set(id,{resolve,timer})` + `send(req)` | `src/main/core/safety/approval-bridge.ts:37-81` |
| `resolve(id, approved)` | 멱등 — 미존재 id no-op·clearTimeout·delete·resolve | `approval-bridge.ts:59-65` |
| `rejectAll()` | 맵 clear 먼저 → outstanding 전원 `resolve(false)` (재진입 안전) | `approval-bridge.ts:67-75` |
| `createApprovalGate({autoApprove,approver,idGen,now,onEvent})` | `request(partial)`: `req={...partial,id,ts}` → `approval.requested` emit → auto/approver/거부 → `approval.decided` emit. **signal 인자 없음** | `src/main/core/safety/approval.ts:27-55` |
| `ApprovalRequest` | `{id,kind,summary,target,risk,ts}` — **expiresAt 없음** | `src/shared/types.ts:328-336` |
| `APPROVAL_TIMEOUT_MS` | `60_000` (메인 권위 + 렌더러 카운트다운 공용 상수) | `types.ts:341` |
| 서버 승인 조립 | `send: broadcast('fleet:approval:request')`·`hasWindow: clientCount()>0`·**timeoutMs 미지정=60s** | `src/server/boot.ts:286-291` |
| 서버 presence-0 (access) | `handleSocketGone`: `mode==='access' && clientCount()===0` → `ipcApprover.rejectAll()` | `boot.ts:418-427` |
| 서버 종료 | `close()`: `ipcApprover.rejectAll()` → 소켓 terminate → httpServer.close → engine.dispose | `boot.ts:528-535` |
| 서버 clock 주입 | boot 은 `clock.setTimeout/clearTimeout/now`(소켓 exp 타이머) 를 주입받아 fakeClock 테스트 | `boot.ts:405,420,438` · `boot-access.test.ts:459-483` |
| tool-loop 승인 대기 | `await deps.gate.request({...})` — **signal 미전달**. tool.execute 만 `{signal: opts.signal}` 수신. 이터레이션 간 abort 체크 없음 | `src/main/core/tools/loop.ts:150,174-202` |
| tool-loop provider.chat | `chatOpts={...opts}` 스프레드로 `opts.signal` 전달(abort 존중) | `loop.ts:115,131` · `providers/types.ts:149` |
| 취소 그래프 | `activeRuns: Map<pid,AbortController>`·`cancelRun`→`c.abort()`(project.done 까지 유지)·`activeChatRuns`/`cancelChat` 동형 | `src/main/core/engine.ts:246,715-758,841-847` |
| 렌더러 승인 UI | 순수 FIFO 큐(`onApprovalRequest`로 append·positional slice). **스냅숏/하이드레이션 전무**·카운트다운=공유상수 setInterval | `src/renderer/components/ApprovalModal.tsx:20-141` |
| 재하이드레이션 패턴(B4) | `useHydration().nonce`(재접속 hello마다 +1) → 패널 effect `[nonce]` 재실행. **replace 안전의 근거 = `endedRunsRef`+`liveStartedRunsRef` 두 가드** | `hydration.tsx:12-69` · `ProjectPanel.tsx:71,75,212-215` |
| 채널 매니페스트 | `CHANNELS as const satisfies` — invoke/push × both/desktop. 추가 시 `fixtures.ts`(`CHANNEL_FIXTURES satisfies`)·`serialization.test`·`handlers.test` 3중 게이트 | `channels.ts:30-95` · `transport/fixtures.ts:98` · `transport/serialization.test.ts:13-15` |
| 데스크톱 승인 | main `createIpcApprover({send: webContents.send, hasWindow})`·수동 `broadcastApprovalRequest`·`registerIpc` 개별 `ipcMain.handle`(HandlerTable 아님) | `src/main/index.ts:42-62,78-184` |

**충돌 요지**: presence=0 즉시거부(`approval-bridge.ts:43`) + access presence-0 `rejectAll`(`boot.ts:424`)
= B5 fail-closed. "외출 중(접속 클라 0) 폰 승인" 완료정의와 정면 충돌. 해소 = **시한부 보류**.

## 1. 계약 (C1 확정)

### C-1. presence 정책 옵션 (approver)

```ts
export interface IpcApproverOptions {
  send: (req: ApprovalRequest) => void
  hasWindow: () => boolean
  /** presence=0 처리 정책. 기본 'reject-immediate'(데스크톱 무회귀). 서버는 'hold'. */
  presencePolicy?: 'reject-immediate' | 'hold'
  /** pending 이탈(응답/만료/철회/rejectAll) 시 id 통지 — 서버가 tombstone 브로드캐스트(best-effort). */
  onWithdraw?: (id: string) => void
  /** 주입 clock — 만료 타이머·delay 계산·list 필터의 단일 시계. 기본 전역 setTimeout/clearTimeout/Date.now.
   *  서버는 boot 의 clock 을 주입해 통합 만료를 결정론화(§C-2·§3 보너스). */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  /** 동시 pending 상한(초과 시 fail-closed 즉시 거부 + 감사). 기본 APPROVAL_MAX_PENDING. */
  maxPending?: number
}
```

`approver(req, opts?)` 동작:
- **reject-immediate**(현행): `!hasWindow()` → 즉시 `false`(무회귀).
- **hold**: `hasWindow()` 무관 항상 enqueue. presence=0 이어도 거부하지 않는다.
- 공통: `maxPending` 도달(`pending.size >= max`) 시 즉시 `false` + `onEvent`(감사) — §C-4.
- 공통: enqueue = `pending.set(id,{req,resolve,timer,cleanup})` → 타이머 무장(§C-2) → signal 배선(§C-5) → **`send(req)` 는 best-effort try/catch**(브로드캐스트 실패해도 pending 유지 = 스냅숏이 다음 접속에 재제시·타이머가 만료 종착). send 실패로 promise 가 reject 되거나 좀비 pending 이 남지 않는다(불변식 §1.8-③).
- 공통 종착: 만료 타이머 발화 → 해소(§1.8-① 순서). **자동 승인 경로 없음**(불변).

### C-2. `expiresAt` 서버 권위 (gate 스탬프 · 주입 clock 단일 출처)

`ApprovalRequest` 에 **required** additive:

```ts
export interface ApprovalRequest {
  id: string
  kind: 'file-write' | 'file-delete' | 'shell' | 'apply-diff' | 'tool-call'
  summary: string
  target: string
  risk: RiskLevel
  ts: number
  /** 서버 권위 자동거부 시각(ms epoch) = ts + ttlMs. 렌더러 카운트다운·approver 만료 타이머의 단일 출처. */
  expiresAt: number
}
```

**출처 단일화**: gate 가 스탬프, approver 가 그 값으로 타이머 무장(카운트다운=실제 만료 불일치 원천 차단).
- `GateOptions.ttlMs?: number`(기본 `APPROVAL_TIMEOUT_MS`=60s). gate: `expiresAt = now() + ttlMs`(gate 의 주입 `now`).
- approver: `timeoutMs` **제거** → `setTimer(fn, Math.max(0, req.expiresAt - now()))`(주입 clock·§C-1). 만료 delay 와 list 필터가 **같은 주입 clock** 을 읽어, 테스트가 `expiresAt` 를 그 clock 에서 파생해야 함(픽스처 시계 규율·§3 규율항).
- 모든 생성 지점(gate)·픽스처가 expiresAt 을 채운다(required → 누락=컴파일 에러). auto-approve 요청도 채우되(harmless) 브로드캐스트/무장 안 됨(gate 가 위험도 분기 전 req 조립 `approval.ts:34`).
- **기존 테스트 마이그레이션**: `approval-bridge.test.ts:46,105` 의 `timeoutMs:1000` → `expiresAt` 주입식으로 재작성(excess-property 컴파일 에러 해소). §3 테스트 1 "무변" 은 이 두 케이스 제외.

TTL 배선: `FLEET_APPROVAL_TTL_MS`(env) → boot 파싱(§C-4) → `createFleetEngine({approvalTtlMs})` → `createApprovalGate({ttlMs})`(engine.ts:229 무충돌·approver 는 engine 밖 선생성이라 TTL 불요·`req.expiresAt`만 읽음). 데스크톱 미지정 → 60s 기본.

### C-3. 스냅숏 + tombstone (P1-2)

**pending 에 req 저장** — `Pending={resolve,timer}` → `{req, resolve, timer, cleanup}`. `list()` 신설.

**approver 반환 = `ApprovalOutcome`(옵션 1 · Codex 체크포인트 P1 반영)**: pending-cap 등 거부 사유를 감사에 남기려면 approver 가 `boolean` 이 아니라 사유를 실은 결과를 반환하고, **감사는 gate 가 단일 책임**으로 `approval.decided` 에 실어야 한다(approver 가 자체 이벤트를 방출하면 두 emitter 로 drift — `onEvent` 를 approver 에 붙이는 대안 폐기). abort/timeout/reject 는 **예외가 아니라 `{approved:false}` 로 해소**(§C-5·§1.8-① — 예외 기반 rejection 은 비계약):

```ts
/** approver 결정 + (거부 시) 감사 사유. gate 가 approval.decided 에 실어 단일 책임 유지. */
export type ApprovalOutcome = { approved: boolean; reason?: string }

export interface IpcApprover {
  approver: (req: ApprovalRequest, opts?: { signal?: AbortSignal }) => Promise<ApprovalOutcome>
  /** 렌더러 회신 상관(멱등). 내부 pending promise 를 {approved} 로 해소. */
  resolve: (id: string, approved: boolean) => void
  rejectAll: () => void
  pendingCount: () => number
  /** 미만료 대기 승인 스냅숏(권위). expiresAt<=now 제외(순수 필터·비파괴). 타이머가 유일 제거 권위. */
  list: () => ApprovalRequest[]
}
```

gate(`approval.ts`): `GateOptions.approver?: (req, opts?) => Promise<ApprovalOutcome>` 로 확장. `request` 는 `const o = await opts.approver(req, {signal}); decision = o.approved ? 'approved' : 'rejected'` 로 읽고, `approval.decided` 에 `o.reason` 이 있으면 실어 방출(reason 배관이 gate 단일 책임). 무approver·auto-approve 경로는 reason 없음.

**FleetBridge** additive 2 (withdrawn 페이로드 = **bare string id**):
```ts
listPendingApprovals(): Promise<ApprovalRequest[]>
onApprovalWithdrawn(callback: (id: string) => void): () => void
```

**채널 2**(`channels.ts` CHANNELS):
- `'fleet:approval:pending': { kind: 'invoke', scope: 'both' }` → `listPendingApprovals`
- `'fleet:approval:withdrawn': { kind: 'push', scope: 'both' }` → `onApprovalWithdrawn`. **wire=bare string**(`broadcast('fleet:approval:withdrawn', id)` · `onApprovalRequest` 규약 동형이므로 콜백이 payload 직수신 → `{id}` 객체 금지·형태 통일).

**tombstone 시맨틱**(모든 pending 이탈 = `onWithdraw(id)` 브로드캐스트):
- `resolve(id)`·만료·abort·`rejectAll` — **전부** onWithdraw(id) 발화(§1.8-①·② 순서). 서버 boot 이 `wsHost.broadcast('fleet:approval:withdrawn', id)`.
- 렌더러: `onApprovalWithdrawn(id)` → 큐에서 id 제거 + tombstone Set 기록. id=randomUUID 무재사용 → 영속 tombstone 안전(`endedRunsRef` 동형 `ProjectPanel.tsx:71`).
- 서버 `resolve`(응답)는 이미 해소/철회/만료 id 계속 no-op(멱등 불변).

**스냅숏 병합 = upsert(비파괴), NOT 파괴적 replace**(적대검증 반영): B4 run 하이드레이션의 파괴적 replace 는
`endedRunsRef`+`liveStartedRunsRef` **두** 가드로만 안전한데, 승인은 drop 가드를 이식하는 대신 **upsert 로 확정**한다:
- 스냅숏 도착 → id 기준 **추가/갱신만**(스냅숏에 없는 라이브 카드를 **드롭하지 않음** — 하이드레이션 창 중 생성된 라이브 승인의 렌더러측 유령 hang 회피).
- 제거는 **tombstone(withdrawn) 단독** 권위. `expiresAt<=now` 는 표시에서 숨김(제거는 withdrawn).
- tombstone 재확인은 스냅숏 **apply 시점**(async resolve 후)에 — capture 시점 tombstone Set 으로 늦게 도착한 stale 스냅숏의 이미-철회 id 부활 차단(`ProjectPanel.test.tsx:730` 인터리브 선례 동형).

### C-4. TTL fail-fast · pending 상한

`FLEET_APPROVAL_TTL_MS` 파싱(boot):
- 미설정 → 서버 기본 `600_000`(10분).
- 설정: 유한 양의 정수 아니거나(`NaN`/음수/`0`/비수치) 범위 `[5_000, 1_800_000]`(5초~30분) 밖 → **boot fail-fast(throw)**. 조용한 정규화(clamp) 대신 오설정을 시끄럽게(운영자 무성 놀람 방지 — B3 fail-closed 정신). env 설정자=배포자=운영자라 crash 는 공격 벡터 아님.
- 데스크톱: env 무관(60s 고정·reject-immediate).

pending 상한 `APPROVAL_MAX_PENDING`(상수 기본 `64`): approver enqueue 시 `pending.size >= max` → 즉시 **`{approved:false, reason:'pending-cap'}`** 해소(§C-3 ApprovalOutcome). gate 가 그 reason 을 `approval.decided` 감사에 실는다(approver 자체 방출 아님 — 단일 책임). 경계=`>=`(정확히 max 보유·max+1 거부). 공격자 다량 tool-call 로부터 메모리·UI 카드 무한 적재 차단.

### C-5. 취소 그래프 배선 (P1-1)

**핵심 결함**: `loop.ts:174` `await gate.request(...)` 가 signal 무연결 → `cancelRun`/`cancelChat` abort 시 승인 대기가 TTL(10분)까지 hang. reject-immediate(60s)선 무해했으나 hold 도입 순간 유령 카드/장기 hang.

**해소 = signal 을 gate.request → approver 로 관통**(별도 run-id 상관표 불필요 — signal 자체가 상관):
- `ApprovalGate.request(partial, callOpts?: { signal?: AbortSignal }): Promise<ApprovalDecision>`.
- gate: `opts.approver(req, { signal: callOpts?.signal })`.
- approver: enqueue 시 signal 배선(불변식 §1.8-②):
  - **진입 시 이미 aborted** → enqueue/send 없이 즉시 `{approved:false}` 해소(이미-aborted signal 은 이후 `addEventListener('abort')` 미발화 — 선체크와 등록은 **반드시 같은 동기 블록**).
  - enqueue 후 abort → 아직 pending 이면 해소(§1.8-① 순서: delete→resolve `{approved:false}`→onWithdraw). **abort/timeout/reject 는 예외가 아니라 `{approved:false}` 로 해소**(Codex 체크포인트 P2 — approver promise 를 throw/reject 하면 gate.request 가 reject 돼 tool-loop 의 "승인 거부됨" tool_result 경로가 아니라 상위 오류 경로로 번짐. 예외 기반 rejection 은 **비계약**). 리스너는 **모든 해소 경로**(정상 resolve/만료/rejectAll/abort)에서 `cleanup()`(removeEventListener)로 정리 — 미정리 시 장수 run signal 에 리스너 누적(Node fetch `MaxListenersExceededWarning` 선례).
- `loop.ts:174`: `deps.gate.request({...}, { signal: opts.signal })`.
- **방어심층**: `loop.ts` 이터레이션 상단에 `if (opts.signal?.aborted) break`(1줄) — provider.chat 이 abort 를 삼키는 어댑터에서도 취소 후 max(8) 왕복 churn 방지(현행은 provider.chat signal 존중에 전적 의존).

효과: run 의 `controller.signal`(engine.ts:715·736)이 곧 승인 대기 해소 신호 = **동일 cancellation graph**. `cancelRun`→abort→approver 즉시 false→withdrawn→카드 즉시 소멸. run 언와인딩(revert·project.done)은 기존 abort 처리가 관장(승인 await 가 TTL 까지 run 을 붙들지 않음이 C1 계약). `cancelChat` 은 chat 경로가 tool-loop 에 자기 signal 을 넘기면 동일 관통으로 커버(경로 유무=계획서 실측·§5).

### C-6. B5 게이트 ④ supersede (D4)

hold 정책에서 boot 의 access presence-0 `rejectAll` 제거(`boot.ts:424-426`). 인증 클라 0 전이에도 보류 유지.
- **인가 경계 불변**: 응답은 인증 소켓만(Access JWT+nonce+Origin, B5 층 무변경). 라이브 request 브로드캐스트·`listPendingApprovals` 모두 attach(게이팅 통과) 소켓만 도달 — 비인증 표면 노출 0(적대검증 확정: `ws-host.ts:75-95` broadcast/dispatch = attach 소켓 한정).
- **fail-closed 종착 불변**: 무응답 = TTL 만료 거부. 자동 승인 없음.
- `rejectAll` 호출 지점만 presence-0 전이 → **종료 경로(close, C3 drain)** 로 이동. `close()`(boot.ts:530) rejectAll 은 C1 에서도 유지(C3 전까지 fail-closed 종단). loopback 은 현행도 presence-0 rejectAll 안 함 → hold 로 자연 수렴.

### C-7. 렌더러 재제시 (D3)

`ApprovalModal` 을 **id-keyed + 하이드레이션 인지**로 리팩터(positional slice 폐기):
- `useHydration().nonce` effect dep + 최초 마운트 → `listPendingApprovals()` → 큐 **upsert**(§C-3·비파괴). tombstone·`expiresAt<=now` 제외.
- 라이브 `onApprovalRequest` upsert(id). `onApprovalWithdrawn(id)` → id 제거+tombstone.
- 카운트다운 = `Math.max(0, Math.ceil((current.expiresAt - Date.now())/1000))`(서버 권위·공유상수 APPROVAL_TIMEOUT_MS 잔존 제거). setInterval 로 라이브 만료 시 카드 자동 소멸(`expiresAt<=Date.now()` → 미표시). 시계 skew/백그라운드 스로틀은 fail-closed(서버 만료 권위·멱등 no-op)·UX 열화만.
- 데스크톱: bridge=null → nonce 영구 0 → 마운트 1회 스냅숏(대개 빈 목록·무회귀). preload 가 `listPendingApprovals`/`onApprovalWithdrawn`(on+removeListener) 구현(parity).

### 1.8 불변식 (구현 전 확정 — 적대검증 반영)

- **① 해소 순서**: 모든 해소 경로(resolve/만료/abort/rejectAll)는 **맵에서 delete/clear 먼저 → resolve(bool) → onWithdraw(id)**. 재진입(동기 then·재진입 onWithdraw)에도 id당 resolve·onWithdraw 정확히 1회(기존 `rejectAll` 주석 `approval-bridge.ts:68` 승격).
- **② aborted 선체크 + addEventListener 동일 동기 블록**: 이미-aborted signal 은 리스너 미발화 → 둘 사이 await 금지(MEMORY B5 `AbortSignal.timeout` 함정 동종).
- **③ send best-effort**: `send(req)` throw 가 promise reject·좀비 pending 을 만들지 않음(try/catch·pending 유지).
- **④ onWithdraw best-effort**: onWithdraw throw 가 resolve(false) 선행을 스킵하거나 만료 타이머 콜백을 크래시(self-DoS)시키지 않음(try/catch).
- **⑤ 중복 id enqueue 금지 의존**: tombstone 영속·pending 키가 id=UUID 무재사용에 의존 — 중복 id enqueue 시 첫 pending 미고아(둘째 거부 또는 명시 정책)로 핀.
- **⑥ list() 순수 필터**: `expiresAt>now` 필터·비파괴. 제거는 타이머(권위) 단독 — 주입 clock 규율로 "만료했으나 타이머 미발화·resolvable" 창은 프로덕션서 공집합.

## 2. parity 표면 (additive 동시 갱신 — 누락=CI fail)

| 파일 | 변경 |
|---|---|
| `src/shared/types.ts` | `ApprovalRequest.expiresAt` required · `FleetBridge`: `listPendingApprovals`·`onApprovalWithdrawn(id:string)` |
| `src/shared/transport/channels.ts` | `fleet:approval:pending`(invoke/both)·`fleet:approval:withdrawn`(push/both) |
| `src/shared/transport/fixtures.ts` | `CHANNEL_FIXTURES['fleet:approval:pending']`(`satisfies Record<BothInvokeChannel,…>` 3중 게이트 — **적대검증 확정 누락**) |
| `src/main/core/safety/approval.ts` | `GateOptions.ttlMs`·`request(partial, {signal?})`·expiresAt 스탬프·signal 전달·**`GateOptions.approver` 반환 `Promise<ApprovalOutcome>`·gate 가 `o.reason` 을 `approval.decided` 에 실음(Codex P1)** |
| `src/main/core/safety/approval-bridge.ts` | `presencePolicy`·`onWithdraw`·주입 clock(`now`/`setTimer`/`clearTimer`)·`maxPending`·`list()`·req 저장·signal 배선·타이머=expiresAt·**approver 반환 `ApprovalOutcome`(cap→`reason:'pending-cap'`·해소는 예외 아닌 `{approved:false}`)**·불변식 §1.8 |
| `src/main/core/engine.ts` | `approvalTtlMs`→`createApprovalGate({ttlMs})` |
| `src/main/core/tools/loop.ts` | `gate.request({...}, {signal: opts.signal})` + 이터레이션 abort 체크 |
| `src/server/boot.ts` | `presencePolicy:'hold'`·`onWithdraw` 브로드캐스트(bare string)·clock 주입·TTL 파싱 fail-fast·presence-0 rejectAll 제거 |
| `src/server/handlers.ts` | `ChannelMethodMap['fleet:approval:pending']`·핸들러 `()=>approver.list()` |
| `src/renderer/bridge/ws-bridge.ts` | `listPendingApprovals: invoke`·`onApprovalWithdrawn: subscribe` |
| `src/preload/index.ts` + `src/main/index.ts` | preload 바인딩 2(`on`+`removeListener`) · main `broadcastApprovalWithdrawn`·`onWithdraw`·clock·`registerIpc` pending 핸들러 |
| `src/renderer/components/ApprovalModal.tsx` | id-keyed·하이드레이션·tombstone·expiresAt 카운트다운 |
| parity/직렬화 테스트 | `bridge-parity`·`ipc-parity`·`ws-bridge-binding`·`handlers.test`·`channels.test`·**`serialization.test`** |

## 3. 코어 계약 테스트 (완료 조건)

**픽스처 시계 규율(전역 전제)**: `expiresAt` 는 approver 가 읽는 **동일 주입 clock**(`now`/`vi.setSystemTime`)에서 파생. real `Date.now`+소값 expiresAt 혼용 금지(delay=0 즉시발화 false-green 차단). hold 생존은 **동기 pendingCount 금지** — clock 양방향(TTL-1 pending / TTL false)으로 단언.

**approver(approval-bridge.test):**
1. reject-immediate 회귀 0 — presence=0 → 즉시 false(기존 테스트 무변, timeoutMs 케이스 제외).
2. hold 생존 양방향 — presence=0·`advance(TTL-1)`→pendingCount===1 **AND** `advance(1)`→resolve false.
3. list()+expiresAt — pending req 반환·`expiresAt<=now` 순수 필터 제외·pendingCount 와 정합.
4. TTL 만료 3연쇄 — 만료 → ①resolve false ②list 제거 ③late resolve no-op + onWithdraw 1회.
5. 다중 pending 멱등 — 개별 resolve 멱등·list 정합.
6. maxPending 경계 — 정확히 max hold·(max+1) 즉시 `{approved:false, reason:'pending-cap'}`·**gate 가 그 reason 을 `approval.decided` 감사에 실음**(approver 자체 방출 아님)·resolve 1건 후 용량 회복.
7. onWithdraw 전(全)경로 — resolve/만료/abort/rejectAll 각 onWithdraw(id) 1회.
7b. **onWithdraw throw 격리(불변식 ④)** — onWithdraw 가 throw 해도 `{approved:false}` 해소 선행 보존·만료 타이머 콜백 self-DoS 크래시 없음(§3 원목록 누락 — Codex/패널 확정 편입).
8. **send throw** — send 예외 → pending 미적재/유지·promise reject 없음·좀비 없음(불변식 ③).
9. **rejectAll 재진입 onWithdraw** — 재진입 onWithdraw 주입해도 id당 resolve·onWithdraw 1회(불변식 ①).
10. **중복 id enqueue** — 첫 pending 미고아(둘째 거부 또는 명시 정책·불변식 ⑤).

**signal/취소(approval-bridge.test + loop.test):**
11. abort 즉시 해소 — 보류 중 abort → 즉시 false(TTL 무관)·onWithdraw(id)·리스너 정리.
12. 진입 시 aborted — 이미 aborted → enqueue/send 없이 즉시 false(불변식 ②).
13. **리스너 정리 전경로** — 정상 resolve/만료/rejectAll 각각 후 리스너 잔존 0(removeEventListener). 정상 resolve 후 abort → 재해소·재withdraw 0.
14. **통합 관통(P1-1 핵심)** — 실 `createApprovalGate`+실 `createIpcApprover('hold')`+`controller.signal` → `gate.request(partial,{signal})` 로 pending → `controller.abort()` → **approver promise 가 `{approved:false}` 로 해소(throw/reject 아님)·gate.request 가 `'rejected'` 결정 반환**(Codex 체크포인트 P2 — 예외 기반 rejection 은 비계약. tool-loop 은 결정≠approved 시 "승인 거부됨" tool_result 로 안전 처리) **AND** onWithdraw(id) 1회 **AND** 리스너 정리. (mock-arg 확인 금지 — 3-seam 관통 end-to-end.)
15. 이터레이션 abort — cancel-during-approval 후 provider.chat 왕복 ≤1(방어심층 break).

**gate(approval.test):**
16. expiresAt 스탬프 — `ttlMs` 로 `expiresAt=ts+ttlMs`·기본 60s.
17. signal 전달 — `request(partial,{signal})` → approver 에 동일 signal 도달.

**서버(boot-access.test + boot.test):**
18. access presence-0 pending 유지 — hold·인증 클라 0 전이 → rejectAll 미호출·pending 유지.
19. 미검증 소켓 배제 — 미검증만 존재해도 pending 승인/노출 불가.
20. JWT 만료 후 유지 + 재인증 승인 — exp close 후 pending 유지·**신규 인증 세션이 held 카드 정상 승인**(양성경로).
21. drain rejectAll — `close()` → pending 전원 거부(mode 무관)·in-flight 응답 멱등 no-op.
22. TTL fail-fast — malformed/범위밖 env → boot throw. 정상값 반영.
23. 만료→withdrawn 통합 — **approver 타이머를 boot clock 으로 라우팅**해 통합 만료→`fleet:approval:withdrawn` 브로드캐스트 검증(주입 onWithdraw 유닛 커버 병행).

**렌더러(ApprovalModal.test — mockFleet 에 pending/withdrawn 추가·HydrationProvider 래핑):**
24. 후접속 snapshot 카드 — 마운트/nonce +1(실 HydrationProvider) → listPendingApprovals → 카드 재제시.
25. live+snapshot upsert dedupe — 같은 id 라이브+스냅숏 → 단일 카드·스냅숏 없는 라이브 카드 **보존**(비파괴).
26. tombstone 인터리브 — listPendingApprovals 지연 resolve 중 withdrawn(id) → 늦은 스냅숏의 동일 id 카드 미부활(apply 시점 tombstone 재확인).
27. 카운트다운 라이브 만료 — 서버 권위 expiresAt 기반·fake timer advance→카드 자동 소멸·공유상수 회귀 가드.

**parity/직렬화:**
28. 신규 채널 2·FleetBridge 메서드 2 가 fixtures·serialization·preload·ws-bridge·핸들러·매니페스트 정합(누락=컴파일/테스트 fail).

## 4. 비목표 (명시)

- **재시작 생존 없음** — pending=프로세스 메모리. 재시작 시 run 자체 사망 → 승인 영속 무의미. drain(C3)이 rejectAll.
- **승인 위임/다중 사용자 없음** — v3 단일 사용자 전제(위반 시 broadcast/list 가 타 사용자 pending 노출·C-6 이 창을 TTL 만큼 연장 → 재평가).
- **Web Push 없음** — C4 선택. v1 = "페이지 열면 스냅숏 카드" + 충분 TTL. 운영문서(C5)에 "능동 확인 필요" 명시.
- **graceful drain 아님** — C3. C1 은 hold 도입 + close() rejectAll 종단만.
- **모바일 카드 UX 아님** — C2. C1 은 id-keyed·하이드레이션·tombstone 코어 계약만(단일 FIFO 표시 유지 가능).
- **TUI 문(웹터미널) 무관** — 문 ②(오케스트레이션) 한정.

## 5. 계획(체크포인트 3) 실측 위임 항목

- **D6 상류 검증**: hold 보류 = tool-loop await 장기화 = LLM 턴 수 분 중단. ① API 세션이 10분 보류 견디는가 ② provider별 idle 타임아웃 — 안 견디면 provider별 TTL 캡 ③ 스트림 계약(seq 단조·재접속 커서)·CLI 자식 수명 충돌.
- **cancelChat 경로**: chat ask/discuss 가 gate 경유하는지 실측(경유=signal 관통 자동 커버).
- **approver 타이머 clock 라우팅 결정**(§3-23·규율항): 채택 시 통합 만료 검증 + fake-timer 규율 동시 해소 — 계획 착수 전 우선 확정.
- **태스크 순서(TDD RED→GREEN)**: types→approval(gate)→approval-bridge(불변식)→engine/loop→boot(+env·clock)→handlers/channels/fixtures→preload/main→ws-bridge→ApprovalModal→parity. 중형 → fleet-plan-panel(판사 패널) 각도 3(리스크/MVP/계약).

## 6. 검증 요청 포인트 (체크포인트 2 리뷰 대상)

1. **C-2 expiresAt 출처 단일화 + approver 주입 clock**(gate 스탬프·approver 타이머/list 동일 clock) 이 gate/approver 시계 분리 skew·통합 결정론을 옳게 닫는가. 대안(approver 가 TTL 소유·역스탬프) 대비.
2. **C-5 signal 관통 + 불변식 ②**(진입-aborted·enqueue-후-abort·리스너 전경로 정리)가 별도 run-id 상관표보다 안전·충분한가. 통합 관통 테스트(§3-14)로 3-seam false-green 을 닫는가.
3. **C-3 upsert 확정**(파괴적 replace 폐기·tombstone 단독 제거·apply 시점 tombstone 재확인)이 스냅숏↔라이브↔withdrawn 3중 엇갈림의 drop-card hang·stale 승인가능 카드를 닫는가. withdrawn=bare string 통일의 잔여 리스크.
4. **C-4 fail-fast vs clamp**·**maxPending `>=` 경계·상수 vs env**·**불변식 ③④(send/onWithdraw best-effort)** 의 타당성.
5. **C-6 supersede** 가 B5 fail-closed 를 실질 약화시키는 잔여 공격 경로(보류 중 비인증 노출·presence 오염 무한연장·rejectAll 이동 race — 적대검증서 3각도 반증 실패였으나 재확인).
6. **범위·테스트 적정성** — §3(1-28)에 빠진 케이스. C2(모바일 UX)로 미룬 것 중 C1 계약 필수분.

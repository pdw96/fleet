# C3 Graceful Drain — 구현 계획 (Part of #216)

- **스펙(권위)**: `docs/superpowers/specs/2026-07-08-issue216-C3-graceful-drain-design.md` (Codex "착수 가능" 통과본)
- **브랜치**: `feat/216-c3-graceful-drain` · **날짜**: 2026-07-09
- **수립**: fleet-plan-panel(planner×3 → judge×2 → 메인 루프 합성)

## 판사 패널 결과 · 합성 판정 (강등 규칙: 승자 불일치)

| 렌즈 | A(리스크) | B(MVP) | C(계약) |
|---|:---:|:---:|:---:|
| 판사 A(공백 그룹) | 21 | **23 ✅** | 18 |
| 판사 B(Codex 강점) | 22 | 21 | **22 ✅** |

**메인 루프 판정 = B(MVP) 골격 채택.** 근거: (1) B의 `installShutdownHandlers` 순수 seam이 Codex 핀
Q5(index.ts teardown/멱등 결정론)를 유일하게 커버 — A는 C5 이월, C는 "구현 재량" punt. (2) broadcast를
코어에서 분리(3계약이 채널 없이 성립)해 위험한 5면 parity churn을 마지막 한 태스크로 격리하고 코어를 먼저
verify-GREEN(판사 A 결정타 평가). C의 강점(계약 조기강제·C1 hold 화해)은 B 골격 안에서 leaf 계약 엄밀 정의로
이식했다.

**이식(→ B 골격):**
- **A**: close() `closePromise ??=` **promise-memo**(closed-flag보다 동시 close에 강함 — 판사 B 지적) ·
  `waitForRunDrain` 엣지(cap==poll 동시 래치 1회·좀비 재스케줄 0) · resolveDrainTimeoutMs exact 케이스 ·
  명명된 회귀 매트릭스 · MAX 120s 근거(5분↔30s 10배 모순 제거).
- **C**: leaf 계약 엄밀 정의(타입/parity 컴파일 강제) · **C1 C-6 hold 계약 화해 명시**(drain rejectAll ≠ 소켓
  이탈 rejectAll) · `boot-drain.test.ts` 별 파일(ripple 격리) · GHCR 상속 canary.

**Codex 계획리뷰(2026-07-08T17:19Z) = "진행 가능"** — P1 보완 1건 반영: T4 `installShutdownHandlers` 는
`Promise<RunningServer>` 를 받아 boot-pending/reject 중 SIGTERM 안전 계약 보존(핸들러 즉시 설치·boot 완료 대기·
boot-pending fallback 은 2차 시그널/SIGKILL 위임). 나머지(순서·promise-memo·CD1-3·broadcast 분리) 전부 승인.

**공통 결함 3건(3초안 모두 놓침) 보강:**
- **CD1**: §4.7 healthcheck-green-during-drain 무핀 → T3에 "드레인 대기 중 정적 라우트 200 유지" 통합 단언.
- **CD2**: 비옵셔널 `onServerDraining`이 **모든** FleetBridge 더블을 tsc 파손 → T5에 blast radius 전수 열거.
- **CD3**: `RunningServer.drainTimeoutMs` == 내부 cap 동일성 → 단일 const 파생 + T3 단언(리팩터가 한쪽만
  바꿔 백스톱<cap → 드레인 도중 exit(1) 무신호 방지).
- **이월 가정 명시(C5)**: prod unref 타이머가 httpServer listen 중 실발화 · force-close의 withdrawn 프레임이
  곧 terminate될 소켓에 큐잉(outcome 단언이 load-bearing이라 비치명) — 라이브 검증으로 이월.

## 규율 (전 태스크 공통)

- TDD RED→GREEN. 각 태스크가 **중간 verify-GREEN 유지**(비옵셔널 타입 배선은 도입 태스크에서 임시 상수로
  tsc GREEN 보전 · parity는 5면 원자 착지로 RED 회피).
- verify 게이트에 `| tail -1` 금지(exit code 가림). **brain 재생성은 전 src 변경 후 최종(T9)** · src 먼저
  커밋 → brain 재생성 → brain 별도 커밋(lint-staged prettier 재포맷 stale 회피).
- 스펙 밖 새 계약 발명 금지. 엔진 미변경(ADR-0003 코어 표면 최소화) — 드레인은 boot/handlers/index/main/
  renderer/deploy에만 국한.

---

## Layer A — 서버측 드레인 코어 (완료정의 3계약 · 채널 무변경)

### T0 — `resolveDrainTimeoutMs` fail-fast 파싱 + 상수

**목표**: `FLEET_DRAIN_TIMEOUT_MS` 파싱(미설정→기본, 비정수·범위밖→throw·조용한 clamp 금지). 상수 확정.

**대상**: `src/server/boot.ts`(`resolveApprovalTtlMs` 231-251 형제) · 테스트 `src/server/boot.test.ts`.

**RED**: `resolveDrainTimeoutMs` — throw `['abc','0','999','120001','25000.5','-1']` 각 `.toThrow(/FLEET_DRAIN_TIMEOUT_MS/)` ·
미설정/`''`/공백 → `25000` · 경계 `'1000'`→1000·`'120000'`→120000.

**GREEN**: 상수 `DEFAULT_DRAIN_TIMEOUT_MS=25_000`·`DRAIN_TIMEOUT_MIN_MS=1_000`·`DRAIN_TIMEOUT_MAX_MS=120_000`·
`DRAIN_POLL_MS=250`. `?.trim()`→미설정 기본, `Number.isInteger`+`[MIN,MAX]` 아니면 throw. bootServer fail-fast
구간(292 approvalTtlMs 옆·**부수효과 이전**)에서 `const drainTimeoutMs = resolveDrainTimeoutMs(env)`.

**검증**: `npx vitest run src/server/boot.test.ts`. **ripple**: 신규 순수 함수(독립). T3가 drainTimeoutMs 소비.

### T1 — `waitForRunDrain` 순수 export 함수

**목표**: 진행 런(activeRuns) 빌 때까지 주입 clock 상한 폴링. 순수 추출이 정답(e2e hang 러너 signal 미honor →
bootServer 통합으론 결정론 불가 · 스펙 §5).

**대상**: `src/server/boot.ts`(export) · **신규 테스트 `src/server/boot-drain.test.ts`**(WS/electron 무의존·자기완결
fakeClock — boot-access 미변경으로 ripple 격리 · C 이식).

**RED**(순수 단위·fakeClock):
- 초기 무런(`getActivity()={activeProjectIds:[]}`) → 즉시 `'drained'`, **타이머 무장 0**(`activeCount()===0`).
- non-empty→empty 플립 + `advanceTo(poll)` → `'drained'` + **형제 cap 타이머 clear**.
- cap 먼저(계속 non-empty) → `advanceTo(cap+1)` → `'timeout'` + **형제 poll 타이머 clear**.
- `pollMs<=0`(0·-1) → **throw**(재귀 폭주 방지).
- **엣지(A 이식)**: `cap==poll` 동시 발화 → 단일 settled 래치 1회 resolve · 발화 후 `advanceTo` 추가 전진해도
  재-resolve·**좀비 재스케줄 0**(`activeCount()===0`).

**GREEN**:
```ts
export function waitForRunDrain(
  getActivity: () => RunActivity, clock: SocketExpiryClock, capMs: number, pollMs: number,
): Promise<'drained' | 'timeout'>
```
`pollMs<=0` throw. 초기 empty → 즉시 resolve. 아니면 단일 `let settled=false` 래치로 poll(재귀 `clock.setTimeout`)·
cap(`clock.setTimeout`) 경쟁, 먼저 발화한 쪽이 resolve + 형제 `clock.clearTimeout`. `import type { RunActivity }`.

**검증**: `npx vitest run src/server/boot-drain.test.ts`(WS 아님 → `--no-file-parallelism` 무관). **ripple**: T3 소비.

### T2 — 신규 런 거부 게이트 `isDraining`(비옵셔널·fail-closed)

**목표**: `HandlerDeps.isDraining: () => boolean`(**비옵셔널**) + `fleet:project:run` 게이트. 배선 누락/undefined/
예외도 런 거부(fail-closed 구조적 강제 · C 논증 이식).

**대상**: `src/server/handlers.ts`(HandlerDeps 63·run 98) · 테스트 `src/server/handlers.test.ts`.

**RED**: `createHandlers({…, isDraining: () => true})['fleet:project:run'](req)` → `.toThrow(/서버 종료 중/)` +
`engine.runProjectFlow` **미호출**(spy 0·throw가 호출 이전). `isDraining: () => false` → 위임. 타입 핀: 생략 시
`createHandlers` 컴파일 에러(비옵셔널 강제).

**GREEN**: HandlerDeps에 `isDraining: () => boolean`(비옵셔널) · 구조분해 추가 · 핸들러
`if (isDraining()) throw new Error('서버 종료 중 — 새 실행을 받지 않습니다'); return engine.runProjectFlow(req)`.
**옵셔널 체이닝 금지**. throw=`never`→`satisfies HandlerTable` drift 0. 채팅 미게이트.

**ripple(전수 · createHandlers 호출부 2곳뿐)**: handlers.ts 3지점 · **boot.ts:373 호출부에 `isDraining: () => draining`
추가 + `let draining = false` 선언(373 이전)** — 아직 아무도 true로 안 만듦(shutdown은 T3) → tsc·기존 테스트 GREEN
유지 · handlers.test.ts:29 `build()` 더블에 `isDraining: opts.isDraining ?? (() => false)`.

**검증**: `npx vitest run src/server/handlers.test.ts src/main/bridge-parity.test.ts`(satisfies 무손상).

### T3 — boot `shutdown()` 골격(broadcast 제외) + `RunningServer` 확장 + close **promise-memo**

**목표**: shutdown 시퀀스 `memo-gate→draining=true→waitForRunDrain→close`(**broadcast 없음** — T5에서 삽입).
RunningServer에 `drainTimeoutMs`·`shutdown()` 확장. close promise-memo 멱등. 이 태스크가 3계약을 통합 검증.

**대상**: `src/server/boot.ts`(RunningServer 263-272 · return 561-574 · 클로저) · 테스트 `boot.test.ts`·`boot-access.test.ts`.

**RED**:
- **T-상한(통합)**: bootServer(주입 clock)+hang 런 admission 통과 → `const p = s.shutdown()`(pending) →
  `fakeClock.advanceTo(start + s.drainTimeoutMs + 1)` 동기 발화 → force close(dispose 동기 `activeRuns.clear()`,
  hang promise 미await) → `await expect(p).resolves.toBeUndefined()`. 선례 `boot-access.test.ts:782-786`.
- **T-멱등**: `s.shutdown() === s.shutdown()`(동일 promise) · broadcast는 T5(여기선 close 1회=dispose spy 1회) ·
  `close()` 2회 무해(promise-memo).
- **T-cap철회(Codex 핀 Q1)**: T-상한 확장 — cap 초과 force close 시 `close().rejectAll()`이 pending 승인 전원
  `{approved:false}` 해소(`onApprover` 주입 pendingCount 0). **C1 C-6 화해 명시**: 이 rejectAll은 **종료 drain**
  경로이지 소켓 이탈 경로가 아니다(이탈은 `clients.delete`만 · hold 유지) — 드레인 종단 fail-closed는 정당.
- **CD3 핀**: `s.drainTimeoutMs`가 waitForRunDrain에 전달되는 cap과 **동일 const 파생**(advance 계산에 `s.drainTimeoutMs`
  사용이 곧 등식 단언) — 백스톱<cap 리팩터 회귀 방지.
- **CD1 핀**: shutdown() 발동 후 waitForRunDrain 대기 중(force close 이전) 정적 라우트가 **200 유지**(httpServer listen)
  — 실 HTTP GET `/` 또는 정적 핸들러 200 단언(§4.7 healthcheck-green 불변식).

**GREEN**:
- RunningServer에 `drainTimeoutMs: number`·`shutdown(): Promise<void>`(JSDoc=스펙 §3.1).
- 클로저: `let shutdownPromise: Promise<void> | null = null` · `let closePromise: Promise<void> | null = null`.
- **close promise-memo(A 이식)**: `close: () => (closePromise ??= (async () => { ipcApprover.rejectAll(); for (const c of
  wss.clients) c.terminate(); wss.close(); await new Promise<void>(r=>httpServer.close(()=>r())); await engine.dispose() })())`.
- **shutdown memo-gate**: `shutdown: () => (shutdownPromise ??= (async () => { draining = true; /* ②broadcast는 T5 */
  await waitForRunDrain(() => engine.getRunActivity(), clock, drainTimeoutMs, DRAIN_POLL_MS); await close() })())`.
  `??=`가 ⓪memo-gate=첫 평가. async IIFE 첫 await 전 `draining=true` 동기(게이트 동기성).
- return에 `drainTimeoutMs, shutdown, close` 노출.

**ripple**: RunningServer 소비처(index.ts·boot 계열 테스트 다수)는 `close()`/`port`/`mode`/`clientCount` 만 사용 →
신규 필드 미참조·무회귀. 신규 테스트만 shutdown/drainTimeoutMs 소비.

**검증**: `npx vitest run src/server/boot.test.ts src/server/boot-access.test.ts` · `npm run verify`(부분) · e2e 무회귀.

---

## Layer B — 종료 경로 실배선

### T4 — `installShutdownHandlers` 순수 추출(B seam) + `index.ts` 배선

**목표**: 실 SIGTERM→shutdown()→exit 배선. index.ts 부수효과 엔트리라 시그널 로직을 **주입식 순수 함수로 추출**
(레포 관례 명문: "검증 로직은 boot.ts에·index는 부수효과만" · index.ts 헤더 주석) → teardown실패/멱등을 결정론 단위화.

**대상**: **신규 `src/server/shutdown-handlers.ts`**(순수 `installShutdownHandlers`) · `src/server/index.ts`(1회 호출) ·
**신규 테스트 `src/server/shutdown-handlers.test.ts`**.

**입력은 반드시 `Promise<RunningServer>`(Codex 계획리뷰 P1)** — 현행 index.ts 는 boot Promise 를 즉시 잡고
시그널 핸들러도 즉시 등록해 "`running` 은 시그널 도달 시점에 pending 이거나 reject 일 수 있다"는 안전 계약을
주석으로 명시한다(index.ts:6-9). resolved `RunningServer` 만 받으면 boot-pending 중 SIGTERM 을 놓치는 회귀 →
seam 은 반드시 Promise 를 받아 핸들러를 즉시 설치한다.

**RED**(페이크 주입 · resolved/rejected/**pending** running):
- 정상: SIGTERM → `s.shutdown()` 호출 · resolve → `exit(0)` · `setBackstop(_, s.drainTimeoutMs + 3000)` 무장.
- **T-teardown실패(Codex 핀 Q5)**: `shutdown()` reject(close/dispose throw) → `exit(1)`(백스톱 잔여 없이 정리).
- **2차 시그널**: 이미 shuttingDown 중 재-SIGTERM/SIGINT → `exit(1)` 즉시(shutdown 재호출 없음).
- **boot reject 중 signal**: `running` reject → `exit(1)`(unhandled rejection 없이 · `.then(_, onRej)` 경로).
- **boot-pending 중 signal(Codex P1 신규)**: `running` 미resolve 상태서 signal → 핸들러 즉시 설치·shutdown 은 boot
  완료까지 대기(핸들 미유실). 이후 `running` resolve → shutdown 진행 / 2차 signal → `exit(1)` 즉시(로컬 fallback).
- 백스톱 사이징 핀: `setBackstop` 지연 인자 === `s.drainTimeoutMs + 3000`.

**GREEN**:
```ts
export function installShutdownHandlers(running: Promise<RunningServer>, deps: {
  onSignal: (sig: NodeJS.Signals, h: () => void) => void; exit: (code: number) => void
  setBackstop: (fn: () => void, ms: number) => void
}): void
// 1차 signal: shuttingDown=true; running.then(
//   (s) => { setBackstop(() => exit(1), s.drainTimeoutMs + 3000); return s.shutdown().then(() => exit(0)) },
//   () => exit(1),                       // boot reject
// ).catch(() => exit(1))                 // shutdown/teardown reject
// 2차 signal: if (shuttingDown) exit(1)
```
`index.ts`는 실 `process.on`/`process.exit`/`setTimeout(fn,ms).unref()`로 1회 호출(부수효과만). 기동 로그 포맷
(index.ts:14 `fleet-server: http://…` regex 계약 `e2e/web-server.ts:35`) **무변경**.

**boot-pending fallback 백스톱 정책(Codex P1)**: 백스톱은 `running` resolve **후** `.then` 안에서만 무장한다
(drainTimeoutMs 는 boot resolve 전엔 미상). boot 이 hang 하면 index.ts 동기 백스톱은 없고 — 종착은 **2차 시그널
(로컬/베어호스트 Ctrl-C)** 또는 **컨테이너 SIGKILL@stop_grace_period**. 이 계층 위임을 T8 ADR-0011 에 명문화한다
(boot 은 통상 서브초라 실무 위험 낮음).

**경계**: 1차/2차 시그널 · SIGINT/SIGTERM · shutdown resolve/reject · boot pending/reject · 백스톱 정확값(28s<30s grace).
**컨테이너 궁극 backstop = SIGKILL@stop_grace_period**(docker stop=SIGTERM 1회 · 2차 SIGTERM 아님).

**검증**: `npx vitest run src/server/shutdown-handlers.test.ts` · `npm run verify`.
**스펙 이슈 해소**: 이 추출은 §6 "index.ts SIGTERM 재작성" 범위 내 + §5 T-teardown실패 요구의 seam(§6 내부모순
최소 해소) — 레포 관례 정합(발명 아님). Codex 체크포인트에 명시.

---

## Layer C — 통지 (5면 원자 + 렌더러)

### T5 — draining push 채널 5면 원자 + boot broadcast 삽입

**목표**: `fleet:server:draining`을 5면(channels/types/preload/ws-bridge/main) + boot broadcast **동시** 착지 →
parity 2겹 자동 GREEN. broadcast를 여기서 shutdown()에 삽입(디커플 → parity churn 격리).

**대상(6점 원자)**: `channels.ts`·`shared/types.ts`·`preload/index.ts`·`ws-bridge.ts`·`main/index.ts` + `boot.ts` shutdown.

**RED**:
- **T-parity(자동)**: bridge-parity(49·59)·ipc-parity(67·71) — 5면 중 하나 빠지면 RED.
- **T-통지 wire(실 WS)**: `boot-access.test.ts:759-790` 형 — 인증/attach 소켓이 `fleet:server:draining` 수신,
  `frame.event === { reason: 'shutdown' }` **정확 일치**(추가 필드 0 · 정적 페이로드 불변식).

**GREEN(6점)**:
1. `channels.ts`(97 뒤): `'fleet:server:draining': { kind:'push', scope:'both' }`.
2. `shared/types.ts`(onApprovalWithdrawn 635 뒤): `onServerDraining(cb: (e: { reason: string }) => void): () => void`.
3. `preload/index.ts`(onApprovalRequest 76-83 동형·**객체 페이로드**): `ipcRenderer.on` + **removeListener**.
4. `ws-bridge.ts`(384 뒤): `onServerDraining: (cb) => subscribe('fleet:server:draining', cb)`.
5. `main/index.ts`(broadcast* 형제 + will-quit): `broadcastServerDraining()` 함수 + will-quit `e.preventDefault()`
   직후·`dispose()` 이전 1회 호출(parity-필수·데스크톱 inert — ConnectionBanner web 전용·bridge=null 미구독).
6. `boot.ts` shutdown() `draining=true` 뒤: `wsHost?.broadcast('fleet:server:draining', { reason: 'shutdown' })`.
정적 페이로드(세션/토큰/nonce 금지). web-bridge 미변경(`bridge.fleet` pass-through).

**ripple(CD2 blast radius 전수 열거)**: 비옵셔널 `onServerDraining`을 FleetBridge에 추가하면 **FleetBridge로 타입된
모든 테스트 더블**이 tsc RED. 전수: `App.test.tsx`(mockFleet)·`hydration.test.tsx`(fakeBridge)·`ApprovalModal.test.tsx`
— **onServerDraining 추가 필수**(T6 hydration만 실구독·나머지는 no-op 스텁). `ws-bridge-binding.test.ts` BINDINGS는
invoke-only → push 무영향. `channels.test.ts`는 both-push 하드목록 없음 → 무회귀.

**검증**: `npx vitest run src/main/bridge-parity.test.ts src/main/ipc-parity.test.ts src/server/boot.test.ts` + tsc(더블 파손 0).

### T6 — 렌더러 배너 + 리셋 (`hydration.tsx`)

**목표**: `draining` 상태 + `onServerDraining` 구독 + **재접속 hello 리셋** + `ConnectionBanner` 배너. 리셋 없으면
재배포 후 건강한 새 연결에 "서버 종료 중" 영구 표시(C3 목표 정면 훼손 · §3.6 F4).

**대상**: `src/renderer/bridge/hydration.tsx`(12-108) · 테스트 `hydration.test.tsx`.

**RED**:
- draining push → `ConnectionBanner` "서버 종료 중 — 곧 재접속됩니다." 표시.
- 우선순위: `reconnecting`/`closed`(소켓 이탈) > `draining`(연결 유지) > `showRecovered`.
- **리셋 핀**: draining=true 후 재접속 hello(nonce+1, 57-58) → `draining=false`(배너 사라짐).
- 데스크톱(bridge=null) → 미구독·배너 null.

**GREEN**: `HydrationState.draining`(기본 false·HydrationContext 기본값 갱신) · effect에
`bridge.fleet.onServerDraining(() => setState(s => ({...s, draining:true})))` + cleanup · onEventCursor 재접속 분기
(57-58)에 `draining: false` 병합 · ConnectionBanner에 `if(draining) return <div className="update-banner"
role="status">서버 종료 중 — 곧 재접속됩니다.</div>`(reconnecting/closed 뒤·showRecovered 앞·`.update-banner` 재사용·신규 CSS 0).

**ripple**: hydration 테스트 더블 `onServerDraining: vi.fn(() => () => {})`(T5 blast radius의 hydration 부분).

**검증**: `npx vitest run src/renderer/bridge/hydration.test.tsx` · e2e web smoke 무회귀.

---

## Layer D — 배포·문서

### T7 — compose `stop_grace_period` + env 페어링 + smoke canary(+GHCR 상속)

**목표**: grace 조율 배포측 방어. `stop_grace_period` 추가(10초 절단 방지·필수)·drain env·smoke canary.

**대상**: `deploy/docker-compose.yml`·`deploy/.env.example`·`deploy/smoke.sh`. `docker-compose.ghcr.yml` 무변경(상속).

**RED**(smoke.sh §12 canary): `grep -q 'stop_grace_period'`(FLEET_BLOCK 부재 시 FAIL) + **§12b GHCR 병합 config
상속 단언**(A/C 이식 — build:!reset이 grace 안 지움).

**GREEN**: fleet 서비스에 `stop_grace_period: ${FLEET_STOP_GRACE:-30s}` · env `FLEET_DRAIN_TIMEOUT_MS:
${FLEET_DRAIN_TIMEOUT_MS:-25000}`(FLEET_APPROVAL_TTL_MS 형제 주석) · `.env.example`에 두 항목 + **"STOP_GRACE ≥
DRAIN_TIMEOUT/1000 + 3" 페어링 주석**(기본 30 ≥ 28 ✓).

**검증**: `bash deploy/smoke.sh`(docker 필요 · §12/§12b canary). 조율은 코드 강제 불가 → env+주석+canary+ADR 방어.

### T8 — ADR-0011 (graceful drain 경계)

**목표**: drainTimeout↔stop_grace_period 교차 운영 결정(코드 강제 불가)을 git-tracked ADR로 정착(ADR-0010 선례).

**대상**: `docs/adr/0011-graceful-drain-경계.md`(신규 · 시드 명명 관례).

**GREEN**: `FLEET_DRAIN_TIMEOUT_MS + 3s ≤ stop_grace_period` 페어링 · **MAX=120s 근거(5분↔30s 10배 모순 제거·A
이식)** · 백스톱 계층(index `drainTimeoutMs+3000`[boot resolve 후만]·2차 시그널·컨테이너 SIGKILL@grace) ·
**boot-pending 중 signal 은 index 동기 백스톱 없이 2차 시그널/SIGKILL 에 위임(Codex 계획리뷰 P1)** · scope 모델
한계('server-only-emit' 부재→main inert). 운영 런북(README 노브 표)은 C5 위임.

**검증**: `npm run verify`(skills:lint·brain:check).

---

## Layer E — 마감

### T9 — brain 재생성 + 전 게이트 + e2e (명명 회귀 매트릭스)

**절차(순서 엄수)**: src 전 변경(주석 포함) 착지 → `npm run brain` 최종 1회 → `npm run verify` 7게이트 →
`npm run test:e2e`(electron 무회귀). src 먼저 커밋 → brain 재생성 → brain 별도 커밋(중간 재생성 stale 회피).

**명명 회귀 매트릭스(A 이식 — 종단 확인)**:
- **close/dispose 무회귀**: close promise-memo idempotent 보존 · dispose 미변경(ADR-0003).
- **C1 승인 무회귀**: drain cap 초과 force close rejectAll → 전원 `{approved:false}`+withdrawn(T3 T-cap철회 핀) ·
  소켓 이탈 hold 유지(C-6).
- **B5 보안 무회귀**: draining broadcast는 attach(인증) 소켓만·safeSend 격리·정적 페이로드(T5 T-통지 핀).
- **데스크톱 무회귀**: main send inert · will-quit dispose 경로 무변경 · ipc/bridge-parity GREEN.
- **healthcheck green(CD1)**: 드레인 대기 중 정적 라우트 200(T3 핀).

**이월 가정(C5 라이브)**: prod unref 타이머 실발화 · withdrawn 프레임 racy 수신 · `docker stop` SIGTERM 수신·
drain 로그·drain>grace 시 SIGKILL 절단 실측.

**검증**: `npm run verify` · `npm run test:e2e` · `bash deploy/smoke.sh`. win flake → `--no-file-parallelism`.

---

## 리스크 · 롤백

- **전체 안전판**: shutdown은 close 위 **순수 추가층**. index.ts에서 `s.shutdown()`→`s.close()`로 되돌리면 현행
  종료(close+3초 백스톱)로 즉시 원복(C1/C2·엔진·전송 무영향). 드레인 미도입 = 현행 동작이 항상 하한선.
- **T1 타이머 경쟁**: 순수함수·격리 롤백. settled 래치 회귀 → 형제 clear 핀 가드.
- **T5 5면 원자**: 단일 커밋 원자 착지. 롤백=channels.ts 1줄 revert → parity 즉시 GREEN.
- **T2 fail-closed**: 비옵셔널 → 배선 누락=tsc RED(런타임 fail-open 불가).
- **T3/T4 hang**: dispose hang 시 shutdown 미resolve → index 백스톱(28s)/컨테이너 SIGKILL(30s) 종착.
- **T7 grace 조율**: drain>grace 최악=현행과 동일 절단(신규 손상 아님). canary가 stop_grace_period 삭제 회귀 차단.

## 태스크 요약

| # | Layer | 목표 | 신규 파일 |
|---|---|---|---|
| T0 | A | resolveDrainTimeoutMs fail-fast | — |
| T1 | A | waitForRunDrain 순수 export | boot-drain.test.ts |
| T2 | A | isDraining 비옵셔널 게이트 | — |
| T3 | A | shutdown 골격+RunningServer+close promise-memo | — |
| T4 | B | installShutdownHandlers seam + index 배선 | shutdown-handlers.ts(.test) |
| T5 | C | draining 5면 push + boot broadcast | — |
| T6 | C | 렌더러 배너+리셋 | — |
| T7 | D | compose+env+smoke canary | — |
| T8 | D | ADR-0011 | 0011-*.md |
| T9 | E | brain+verify+e2e+회귀매트릭스 | — |

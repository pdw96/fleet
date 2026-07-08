# C3 — Graceful Drain 설계 (Part of #216 · #193 Phase C)

- **이슈**: #216 (Phase C — 승인 + 안정화) C3 슬라이스
- **날짜**: 2026-07-08 (로컬 fleet-refuter 5렌즈 사전검증 반영 · 2026-07-09)
- **선행**: C1(승인 hold·PR#219 `08e12ae`)·C2(모바일 승인 UX·PR#220 `988c508`) 머지 완료
- **PR 계약**: 본문 `Part of #216`(마지막 PR 아님 — C4/C5 잔여). 체크포인트(스펙→계획)는 #216 코멘트 + @codex review.

> **사전검증 요약(로컬 5렌즈)**: 설계 생존(설계를 죽이는 P1=0). 반영 필수: ①main 방출(ipc-parity `subscribe==send`
> 강제 — "main 미변경"은 거짓) ②DRAIN_MAX↔stop_grace_period 조율 자기모순 해소 ③`waitForRunDrain` 순수 추출
> (T-대기 결정론) ④draining 배너 리셋 경로 ⑤smoke stop_grace_period canary. + fail-closed·멱등 memo-gate·타이머
> settled 래치 등 P3 하드닝. 보안 회귀 0(5가설 전부 기각).

## 0. 배경 — 현행 실측 (완료정의가 원천 불가능한 이유)

#216 착수 실측 갭 ④: `src/server/index.ts` 는 SIGTERM 시 `close()` + 3초 백스톱 강제종료뿐. 진행 중
런·대기 중 승인의 종료 처리가 없어 **컨테이너 재배포 시 소리 없이 죽는다**.

실측 사실(코드 라인):

- **`src/server/index.ts:20-32`** — `for (SIGINT|SIGTERM) → running.then(s=>s.close()).then(exit0, exit1)` +
  `setTimeout(exit1, 3000).unref()`. 드레인 단계 전무.
- **`src/server/boot.ts:566-573`** `close()` — 이미 **강제 teardown**:
  `ipcApprover.rejectAll() → wss.clients 전원 terminate() → wss.close() → httpServer.close() → engine.dispose()`.
  즉 "force" 경로는 존재한다. C3 는 그 **앞에** 드레인을 끼운다.
- **`src/main/core/engine.ts:257,648-754,783-788,889-903`** — 진행 런 권위:
  `activeRuns: Map<projectId, AbortController>` (project.created 동기 방출[orchestrator.ts:141, 첫 await 이전]에서
  등록·project.done/finally 해제). `runProjectFlow` 는 이미 `activeRuns.size>0` 순차 admission 가드 보유(0~1건).
  `getRunActivity()` 는 **동기** 반환 `{activeProjectIds}`(783-787). `dispose()` 는 **abort 방식**(892-893 동기
  `activeRuns.clear()`) — 진행 런을 즉시 abort(드레인 아님).
- **`src/server/boot.ts:281-575`** `bootServer(env, deps)` — `deps.clock`(SocketExpiryClock: now/setTimeout/
  clearTimeout) 주입식이라 타이머 결정론 검증 가능(C1 이 승인 만료 타이머를 이 clock 으로 통합). **단 세션/엔진
  주입 seam 은 없다**(항상 `createFleetEngine`+e2e 러너) — 테스트 설계에 영향(§5).
- **`deploy/docker-compose.yml` fleet 서비스** — `stop_grace_period` **미설정** → **Docker 기본 10초** 후 SIGKILL.
  `init: true`(tini PID1)가 SIGTERM 을 단일 직속 자식(node CMD)에 forward → node `process.on(SIGTERM)` 정상 수신.
  `docker stop` 은 SIGTERM **1회**만 보내고 grace 만료 시 SIGKILL(SIGTERM 재전송 아님). 실 오케스트레이션 런은
  **분 단위**. `restart: unless-stopped` 는 프로세스 exit 시에만 발동(정지 컨테이너 재기동 안 함).
- **통지 배선 — parity 계약 2겹(둘 다 정확 일치 강제):**
  - `src/main/bridge-parity.test.ts:49,59` — `pushChannels()`(**scope 무필터=전 push**) == preload `ipcRenderer.on`,
    `pushChannels('both')` == ws-bridge `subscribe`.
  - `src/main/ipc-parity.test.ts:67-73` — preload `ipcRenderer.on` == **main `webContents.send`**(subscribe==send) ·
    preload `on` == preload `removeListener`(unsubscribe==subscribe).
  - ⇒ push 채널 추가 = **5면**: `channels.ts` · `FleetBridge` 타입 · preload(`on`+`removeListener`) ·
    ws-bridge(`subscribe`) · **`main/index.ts`(`webContents.send`)**. web-bridge 는 `bridge.fleet` 전량 pass-through
    (web-bridge.ts:108)라 미변경(정확).
- **`src/renderer/bridge/hydration.tsx:12-17,37-66,72-108`** — `HydrationProvider` effect(bridge push 구독·nonce)·
  `ConnectionBanner`(재접속 배너·`connection` 상태 구동·데스크톱 `connection===null`→null). 드레인 push 는
  **소켓 열린 채** 도달하므로 별도 `draining` 상태 추가로 재사용한다. **리셋 경로 필수**(§3.6).

## 1. 목표 / 비목표

**목표**: SIGTERM 시 **신규 런 거부 → 클라 통지 → 진행 런 완료 대기(상한) → pending 승인 rejectAll → 종료**
의 정연한 드레인. 재배포/컨테이너 종료가 진행 런의 꼬리(verify/commit)를 착지시킬 유예를 주고, 소리 없는
죽음을 없앤다.

**비목표(명시)**:
- 진행 런의 **완주 보장 아님** — 실 런은 분 단위라 상한 내 완주는 드물다. 상한 초과 = force abort(오케스트레이터가
  현재 작업 revert). 드레인은 "거의 끝난 런의 착지 + 정연한 순서 보장"이다. **상한을 grace 밖으로 올려도 완주가
  보장되진 않는다**(§3.3 조율).
- **채팅/probe 드레인 대기 아님** — #216 "진행 런"은 프로젝트 런(activeRuns). 채팅의 destructive 도구는 teardown
  `rejectAll` 이 차단하고, 채팅은 워크스페이스 권위 편집자가 아니다. chat/probe 는 기존대로 teardown에서 abort.
- **Web Push(C4)·운영 런북·라이브 실측(C5) 아님** — 별도 슬라이스.
- **late-connecting 클라의 draining hello 편입 아님** — 드레인 중 새 접속은 런 거부 에러로 신호받는다.

## 2. 아키텍처 — 종료 시퀀스

```
shutdown():
  ┌ if (shutdownPromise) return shutdownPromise   ← ⓪ memo-게이트(멱등 · draining/broadcast 이전 첫 문장)
  │ draining = true                                ← ① 신규 런 거부(동기 set)
  │ broadcast(fleet:server:draining,{reason})      ← ② 클라 통지(best-effort)
  │ await waitForRunDrain(getActivity, clock, cap)  ← ③ 진행 런 대기(상한 = 순수 함수)
  └ await close()                                   ← ④ 기존 하드 teardown(idempotent)
```

- `close()` 는 **idempotent 하드 teardown 으로 보존**(현행 566-573 + 이중호출 가드). shutdown 의 마지막 단계이자
  테스트/폴백 재사용.
- `shutdown()` 의 내부 cap(③)은 **드레인 대기 단계만 상한**한다. teardown(④ close→dispose)이 hang 하면(SIGTERM
  무시 CLI 자식·MCP stdio dispose) shutdown 은 resolve 하지 않으며, 궁극 상한은 index.ts 백스톱(§3.7)+컨테이너
  SIGKILL 이다. dispose 자체엔 타임아웃을 두지 않는다(ADR-0003 코어 무변경).
- 드레인은 **서버 수명주기 관심사** → boot/handlers/index/main 에 국한. **엔진 미변경**(코어 표면 최소화 · ADR-0003).

## 3. 계약 (인터페이스)

### 3.1 `RunningServer` 확장 (`boot.ts`)

```ts
export interface RunningServer {
  port: number; host: string; mode: SecurityConfig['mode']; clientCount(): number
  /** 해소된 드레인 상한(ms) — index.ts 백스톱 사이징용(shutdown 내부 cap 과 동일값). */
  drainTimeoutMs: number
  /**
   * graceful drain 종료(#216 C3): memo-게이트 → draining on → fleet:server:draining broadcast →
   * waitForRunDrain(상한) → close(). 내부 cap 은 드레인 대기만 상한하며 teardown hang 은 index.ts 백스톱/
   * 컨테이너 SIGKILL 이 종착. idempotent(2회 호출 = 동일 promise·broadcast/close 1회).
   */
  shutdown(): Promise<void>
  /** 하드 teardown(idempotent) — rejectAll → terminate → close WS/HTTP → dispose. 이중호출 가드. */
  close(): Promise<void>
}
```

### 3.2 신규 런 거부 게이트 (`boot.ts` + `handlers.ts`) — **fail-closed 불변식**

- boot 클로저: `let draining = false`. `shutdown()` 이 동기로 `draining = true`.
- `createHandlers` `HandlerDeps` 에 **`isDraining: () => boolean`(비옵셔널 필수)** 추가. `fleet:project:run`:

```ts
'fleet:project:run': (req) => {
  if (isDraining()) throw new Error('서버 종료 중 — 새 실행을 받지 않습니다')
  return engine.runProjectFlow(req)
}
```

- **fail-closed 방향 못박기**: `isDraining` 은 비옵셔널(옵셔널 체이닝 `isDraining?.()` **금지**) — 배선 누락/
  undefined/예외도 throw→런 거부로 귀결(dispatch catch→err frame, 런 미시작). throw 는 `runProjectFlow` 호출
  **이전** 전파. 타입-레벨 강제(비옵셔널)로 boot 배선을 컴파일러가 요구.
- 동기 체크라 레이스 0(JS 단일 스레드·`isDraining` 체크와 `runProjectFlow` 호출 사이 await 금지): admission
  통과 런(activeRuns 반영)은 대기 대상, 이후 도착 런은 거부. **채팅 미게이트.**
- `HandlerTable` 은 `BothInvokeChannel`(invoke)만 매핑 — push 무관·`satisfies` drift 없음. run 게이트 throw 는
  `never`·반환형 불변.

### 3.3 `FLEET_DRAIN_TIMEOUT_MS` 파싱 + **grace 조율** (`boot.ts`)

```ts
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000        // 25초(기본 stop_grace_period 30s 안쪽·teardown 3s 여유)
const DRAIN_TIMEOUT_MIN_MS = 1_000             // 1초(사실상 no-grace)
const DRAIN_TIMEOUT_MAX_MS = 120_000           // 2분 — grace 를 함께 올릴 때만 유효(무한정 아님)
function resolveDrainTimeoutMs(env): number     // 미설정→기본. 비정수·범위밖→throw(부수효과 이전·조용한 clamp 금지)
```

- **조율 계약(load-bearing)**: 드레인은 컨테이너 `stop_grace_period` 안쪽에서만 honor 된다. `docker stop` 은
  grace 만료 시 SIGKILL 로 드레인을 절단하므로, **`FLEET_DRAIN_TIMEOUT_MS + 3s ≤ stop_grace_period` 를 운영자가
  유지**해야 한다(§3.8 env 페어링·§7 ADR-0011). MAX 를 120s 로 낮춰 "5분" 광고와 30s 하드천장의 10배 모순을
  제거한다. 서버는 grace 를 읽을 수 없어 코드 강제는 불가 — 페어링 env + 문서 + ADR 로 조율(초과 시 최악은
  현행과 동일한 절단이지 신규 손상 아님).

### 3.4 진행 런 대기 — **순수 export 함수** (`boot.ts`)

```ts
/** 진행 런(activeRuns) 이 빌 때까지 상한 폴링. 순수(주입 clock)라 fake getActivity 로 단위 검증. */
export function waitForRunDrain(
  getActivity: () => RunActivity,
  clock: SocketExpiryClock,
  capMs: number,
  pollMs: number,          // > 0 강제(0/음수 = 재귀 폭주) — 호출부 상수 DRAIN_POLL_MS≈250
): Promise<'drained' | 'timeout'>
```

- 초기 무런이면 즉시 `'drained'`. 아니면 **단일 `settled` 래치**로 감싸 poll(재귀 `clock.setTimeout(poll,pollMs)`)과
  cap(`clock.setTimeout(…,capMs)`)을 경쟁시키고, **먼저 발화한 쪽이 resolve 와 동시에 형제 타이머를
  `clock.clearTimeout`**(재-resolve·좀비 재스케줄 금지).
- boot `shutdown` 은 `waitForRunDrain(() => engine.getRunActivity(), clock, drainTimeoutMs, DRAIN_POLL_MS)`. boot
  클로저 상수 `engine`(boot.ts:338) 참조 유효(close 가 이미 `engine.dispose()` 호출). `getRunActivity` 동기.
- 프로덕션 `defaultClock.setTimeout` 은 unref 이나 드레인 중 httpServer listen(이벤트 루프 유지)이라 발화. 반환
  `'drained'|'timeout'` 어느 쪽이든 이후 `close()` 진행(timeout=force, dispose 가 abort → 오케스트레이터 revert).

### 3.5 클라 통지 push 채널 (**5면** · parity 2겹)

- `channels.ts`: `'fleet:server:draining': { kind:'push', scope:'both' }`. 페이로드 = **정적 `{ reason: 'shutdown' }`**.
  **불변식: 세션/식별자/토큰/nonce 등 동적·민감 필드 금지**(정적 enum 만 — "확장 여지"가 유출 문이 되지 않게).
- `FleetBridge` 타입(`shared/types.ts`): `onServerDraining(cb: (e: { reason: string }) => void): () => void`.
- `preload/index.ts`: `ipcRenderer.on('fleet:server:draining', …)` **+ `removeListener`**(onApprovalRequest 동형 —
  객체 페이로드·해제 함수 반환). ipc-parity 가 on/removeListener 둘 다 강제.
- ws-bridge.ts: `onServerDraining: (cb) => subscribe('fleet:server:draining', cb)`.
- **`main/index.ts`(parity 필수·F1)**: ipc-parity `subscribe==send` 가 preload `on` ⇒ main `webContents.send` 를
  강제. `will-quit` teardown 직전 `for (w of BrowserWindow.getAllWindows()) w.webContents.send('fleet:server:
  draining', {reason:'shutdown'})` 1회. **데스크톱 방출은 parity-필수이나 실질 inert**(ConnectionBanner 는
  web 전용·HydrationProvider bridge=null 로 데스크톱 미구독) — 무해·불변식 보존.
- boot: `shutdown()` 이 `wsHost?.broadcast('fleet:server:draining', { reason: 'shutdown' })`. broadcast 는
  attach(인증 통과) 소켓에만 도달(ws-host clients Set)·safeSend 격리(best-effort).

### 3.6 렌더러 최소 배너 + **리셋 경로** (`hydration.tsx`)

- `HydrationState` 에 `draining: boolean`(기본 false). effect 가 `bridge.fleet.onServerDraining(() =>
  setState(s => ({...s, draining: true})))` 구독.
- **리셋(F4·필수)**: 재접속 성공 hello(nonce 증가 지점, hydration.tsx:57-58)에서 `draining=false` 로 리셋 —
  drain 은 단일 종료 세대 신호이고 **신서버 재접속은 종료 상태를 계승하지 않는다**. 미리셋 시 재배포(=C3 주
  대상) 후 건강한 새 연결 위에 "서버 종료 중" 배너가 영구 표시돼 C3 목표를 정면 훼손(ws-bridge 백오프 재접속은
  React state 를 안 지움).
- `ConnectionBanner` 우선순위: `reconnecting`/`closed`(소켓 이미 이탈) > `draining`(연결 유지 중) > `showRecovered`.
  draining 배너 = "서버 종료 중 — 곧 재접속됩니다." (`.update-banner` 재사용·신규 CSS 0).

### 3.7 `index.ts` SIGTERM 핸들러

```ts
let shuttingDown = false
for (const signal of ['SIGINT','SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) { process.exit(1); return }   // 2차 시그널 = 즉시 강제(로컬/베어호스트 Ctrl-C 연타 한정)
    shuttingDown = true
    void running.then(
      (s) => {
        setTimeout(() => process.exit(1), s.drainTimeoutMs + 3000).unref()  // 백스톱=상한+teardown 여유
        return s.shutdown().then(() => process.exit(0))
      },
      () => process.exit(1),   // boot 실패(running reject) — 상단 .catch 가 이미 로깅
    ).catch(() => process.exit(1))
  })
}
```

- **백스톱 계층 명시**: 로컬/베어호스트 = index.ts `drainTimeoutMs+3000` 백스톱 + 2차 시그널 즉시 종료. **컨테이너
  궁극 backstop = Docker SIGKILL@stop_grace_period**(2차 SIGTERM 아님 — `docker stop` 은 SIGTERM 1회). SIGTERM-
  during-boot(드묾·서브초)도 컨테이너 SIGKILL 이 종착.

### 3.8 배포 (`docker-compose.yml`·`docker-compose.ghcr.yml`·`.env.example`·`smoke.sh`)

- fleet 서비스: **`stop_grace_period: ${FLEET_STOP_GRACE:-30s}`** 추가(현재 미설정→10초 SIGKILL 이 드레인 무력화
  방지 — **필수**·env 페어링으로 drain 과 함께 상향 가능). `environment` 에 `FLEET_DRAIN_TIMEOUT_MS:
  ${FLEET_DRAIN_TIMEOUT_MS:-25000}`(FLEET_APPROVAL_TTL_MS 형제 주석 — "진행 런 착지 유예·grace 안쪽 유지").
- `docker-compose.ghcr.yml` 은 `build`/`image` 만 덮으므로 `stop_grace_period` 를 **상속**(pull-deploy.sh 병합) —
  드리프트 없음(canary 로 상속도 단언).
- `.env.example`: `FLEET_DRAIN_TIMEOUT_MS`·`FLEET_STOP_GRACE` 항목 + "STOP_GRACE ≥ DRAIN_TIMEOUT/1000 + 3" 주석.
- **`deploy/smoke.sh` §12 compose 불변식 canary(Q5·필수)**: `grep -q 'stop_grace_period'` 로 load-bearing 속성을
  가드(누군가 지우면 10초 기본이 조용히 드레인을 깨는 것 차단). ghcr 병합 config 상속도 동일 단언.
- 운영 런북(README 노브 표·"재배포 중 pending 승인은 드레인 상한 내에만 응답 가능") 갱신은 **C5** 로 위임.

## 4. 불변식 / 엣지

1. **게이트 동기성·fail-closed** — `draining=true` set 과 run 핸들러 동기 체크 사이 갭 0. `isDraining` 비옵셔널·
   undefined/예외도 런 거부(fail-closed).
2. **shutdown idempotent** — memo-게이트(⓪)가 draining/broadcast 이전 첫 문장. 2회 호출 = 동일 promise·broadcast/
   close 1회.
3. **close idempotent** — `httpServer.close()`/`wss.close()` 이중 호출 가드. rejectAll 은 이미 멱등.
4. **timeout=force 안전** — 상한 초과 시 close→dispose 가 런 abort→오케스트레이터 revert. rejectAll 이 pending
   승인 전원 `{approved:false}` 해소(C1). teardown hang 은 index.ts 백스톱/SIGKILL 종착.
5. **broadcast best-effort·인증 한정** — `wsHost.broadcast` 는 attach(인증 통과·B5) 소켓만·safeSend 격리. 페이로드
   정적(민감값 0). 소켓 이탈 rejectAll 이중경로 없음(C1 C-6 supersede — 이탈은 `clients.delete` 만).
6. **타이머 누수 0** — `waitForRunDrain` 단일 settled 래치·형제 타이머 상호 clear·pollMs>0. 주입 clock 결정론.
7. **드레인 중 healthcheck green** — 드레인 대기 동안 httpServer 는 계속 listen → `curl /` 정적 200 유지 →
   healthcheck 는 unhealthy 마킹 안 함(close 진입 후에야 실패). plain compose 는 healthcheck 가 restart/kill 미유발.

## 5. 테스트 — **단위/통합 분할** (완료정의 3계약 + 보강)

핵심 계약(완료정의): **신규 런 거부 · 진행 런 대기 · 상한 초과 강제 종료.** 하네스 실측상 셋의 검증 레벨이 다르다:

- **T-대기(순수 단위)** — `waitForRunDrain(fake getActivity, fakeClock, cap, poll)`: getActivity 를 non-empty→empty
  로 플립 + clock 전진 → `'drained'` 후 resolve, 형제 타이머 정리. *bootServer 통합으로는 결정론 불가*(e2e hang
  러너가 signal 미honor[cli-session started=true→abort no-op]라 런 해제로 activeRuns 를 못 비운다 → 순수 추출이
  정답).
- **T-상한(통합)** — bootServer(주입 clock)+hang 런 → `shutdown()`(pending) → `fakeClock.advanceTo(cap+1)` 동기
  발화 → force close(dispose 동기 `activeRuns.clear()`, hang 런 promise 미await) → `await shutdown` resolve.
  선례 `boot-access.test.ts:782-786`(advance→resolve 동기 패턴).
- **T-거부(단위·handlers)** — `createHandlers({…, isDraining: () => true})` → `fleet:project:run` 핸들러 throw
  (WS 왕복·소켓 타이밍 레이스 회피 — 게이트가 HandlerDeps 라 직접 주입이 정답).
- **T-통지(통합·실 WS)** — 실 WS 클라가 `fleet:server:draining` 프레임 파싱(BootDeps 에 wsHost 주입구 없음 —
  실 소켓 관측). `boot-access.test.ts:759-781` 형. WS 통합은 spawn 아니라 `--no-file-parallelism` 무관.
- **T-파싱** — `resolveDrainTimeoutMs` fail-fast: `['abc','0','999','120001','25000.5']` throw · 미설정 25000 ·
  경계 1000/120000 통과.
- **T-멱등** — 중복 SIGTERM/SIGINT 에도 `shutdown()` broadcast 1회·close 1회·**동일 shutdown promise 공유**
  (Codex 핀). `close()` 2회 무해.
- **T-cap철회(통합·Codex 핀 Q1)** — T-상한 확장: drain cap 초과 force close 시 `close().rejectAll()` 이 pending
  승인 전원 철회(`fleet:approval:withdrawn`/outcome `{approved:false}`) 확인 — 드레인 내 미완주 런의 대기 승인이
  종단에서 fail-closed 철회됨을 핀.
- **T-teardown실패(index.ts·Codex 핀 Q5)** — `waitForRunDrain` 정상 종료해도 `close()`/`dispose()` 가 reject 하면
  index.ts 가 `exit(1)` 로 정리하고 백스톱 잔여가 없음(shutdown().then(exit0, exit1) 경로).
- **T-parity(자동)** — bridge-parity·ipc-parity GREEN(channels/preload[on+removeListener]/ws-bridge/main[send] 정합).
- **T-렌더러** — `ConnectionBanner` draining 배너·우선순위(reconnecting 우선)·**재접속 hello 후 draining 리셋**.
  기존 hydration 테스트 더블에 `onServerDraining` 추가(런타임 갭 방지).

`npm run verify` 7게이트 GREEN · e2e 무회귀.

## 6. 변경 파일 (touch points)

- `src/server/boot.ts` — `resolveDrainTimeoutMs`·`draining`·`waitForRunDrain`(export)·`shutdown`·`drainTimeoutMs`·
  `close` 이중가드·`isDraining` 주입·broadcast.
- `src/server/handlers.ts` — `HandlerDeps.isDraining`(비옵셔널)·run 게이트.
- `src/server/index.ts` — SIGTERM 핸들러 재작성.
- `src/shared/transport/channels.ts` — `fleet:server:draining` 선언.
- `src/shared/types.ts` — `FleetBridge.onServerDraining`.
- `src/preload/index.ts` — `onServerDraining`(on+removeListener).
- **`src/main/index.ts`** — will-quit `webContents.send('fleet:server:draining')`(ipc-parity 필수).
- `src/renderer/bridge/ws-bridge.ts` — `onServerDraining` subscribe.
- `src/renderer/bridge/hydration.tsx` — `draining` 상태·리셋·`ConnectionBanner` 배너.
- `deploy/docker-compose.yml`·`deploy/.env.example`·**`deploy/smoke.sh`** — stop_grace_period·env 페어링·canary.
- 테스트: `boot.test.ts`·`handlers.test.ts`·hydration 렌더러·bridge/ipc-parity(자동).

## 7. 결정 기록 (ADR-0011 — **필수**)

드레인 상한과 컨테이너 `stop_grace_period` 의 조율은 **deploy ↔ server 교차 운영 결정**이고, 코드가 강제할 수
없어(서버가 grace 미인지) 문서·페어링 env·ADR 이 유일 방어다. **ADR-0011(graceful drain 경계 · drainTimeout↔
stop_grace_period 계약 · 백스톱 계층)을 작성**한다(ADR-0010 샌드박스 경계 선례). draining push 채널 scope 모델
한계('server-only-emit' 범주 부재 → main inert 방출)도 여기 기록.

## 8. 비범위 / 후속

- C4 Web Push(VAPID·service worker) — 별도 결정. **draining 을 인증 이전 채널로 실으면 §4-5 위협모델 변화 →
  C4 스펙서 별도 refute.**
- C5 운영 런북 + 라이브 실측(터널 폰 승인→PC 런 완주 · `docker stop` 후 SIGTERM 수신·drain 로그·drain>grace 시
  SIGKILL 절단 실측) = 완료정의 그 자체.
- late-connecting 클라 draining hello 편입 · 채팅 드레인 게이팅 · scope 모델 'server-only-emit' 범주 — 필요 체감 시 후속.

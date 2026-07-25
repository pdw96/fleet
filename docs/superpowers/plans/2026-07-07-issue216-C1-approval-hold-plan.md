# C1 구현 계획 — 승인 보류(hold-with-expiry)·스냅숏·재하이드레이션 (#216 Phase C · Part of #193)

스펙: `docs/superpowers/specs/2026-07-07-issue216-C1-approval-hold-design.md`(Codex "진행 가능" clean).
판사 패널(fleet-planner×3 → fleet-plan-judge×2 → 메인 루프 합성)로 작성.

## 패널 판정 요약 (draft≠judge)

**초안 3(각도 뚜렷·붕괴 아님)**: A=리스크 우선(D6 T0·통합관통 조기·rejectAll 제거를 취소관통 뒤 안전순서) · B=MVP 우선(boot-access #20 마일스톤 최단 수직) · C=계약 우선(위상 타입그래프·렌더러 잎 후행).

| 축 | 공백 그룹 판사 | Codex 강점 판사 |
|---|---|---|
| 점수 | A **22** · B 21 · C 19 | C 22 · B 21 · A 19 (원점수) |
| 승자 | **A** (안전 순서 유일 격상) | **B** (심각도: C는 orchestrator P1 잔존·B는 onEvent P2만) |

**승자 불일치 → 메인 루프 판정**: **A(리스크 우선) 골격을 척추**로 채택. 근거 — C1 은 보안 fail-closed 회귀가 최대 리스크이고, "presence-0 rejectAll 제거(보안 컨트롤 삭제) 前 취소 관통 GREEN" 안전 순서를 **A만 보안 불변식으로 격상**했다(두 판사 공통 인정). C는 원점수 최고이나 **계약 우선을 표방하고도 signal 계약 ripple(orchestrator 2호출부)을 놓쳐** 두 판사 모두 P1 감점 — 각도의 맹점. B의 강점(명명 마일스톤·parity 원자성·cancelChat 확정)은 이식으로 흡수.

**이식(패자→척추 A)**: [B] boot-access #20 을 명명된 조기 서버 마일스톤화 · parity 원자 shell · web-bridge.ts:108 위임(parity 제외) · cancelChat 자동커버 확정. [C] **onEvent 모순 해소** · engine TTL seam 테스트 · 타입파생 배치표(HandlerTable vs 수동 ipcMain.handle) · **중앙 흡수로 태스크 경계 tsc-GREEN**(A의 "ripple=RED 신호"보다 엄격한 규율 채택·단 required 유지=fail-closed).

## 스펙 수정 (패널 확정 — 착수 전 스펙에 반영/이슈 보고)

패널이 코드로 확정한 스펙 공백 4건. **계획이 이를 흡수**하며, 체크포인트 3 리뷰(Codex)에서 재확인한다.

1. **gate.request 호출부 = 4곳**(스펙 §2/§C-5 는 `loop.ts:174` 1곳만): `loop.ts:174`(tool-call) · `orchestrator.ts:353`(apply-diff) · `orchestrator.ts:923`(verify-fix) · `mcp/host.ts:241`(MCP spawn). **hold 도입 시 orchestrator 2곳(apply-diff=run 중 가장 흔한 destructive 승인)이 `cancelRun` abort 를 못 받아 60s→TTL(10분) hang = rejectAll 이 막던 hang 재발.** → T3 에 orchestrator 2호출부 signal 배선 + apply-diff abort 통합 테스트. §2 parity 표에 `orchestrator/orchestrator.ts` 추가.
2. **mcp/host.ts:241 dispose-during-await hang**(공백 그룹 판사 발견·**Codex 체크포인트 3-R P1 상향**): `disposed` 가드가 await **前(237)·後(263)만** 체크·대기 중 없음. `dispose()` 는 `disposed=true` 후 `await queue.catch(()=>{})` 로 진행 중 setServers queue 종료를 대기 → held approval 이 TTL(10분)까지 안 풀리면 dispose 도 그만큼 매달림(기존 "승인 대기 중 dispose" 테스트가 수동 release 로만 종료됨이 이 위험을 노출). → **dispose AbortController 관통을 필수 계약으로 고정**(TTL backstop 문서화 폐기): `createMcpHost` 내부 dispose용 `AbortController` · `dispose()` 시작 시 abort · `gate.request(..., {signal: disposeSignal})` · dispose 중 held approval 즉시 `rejected` 해소 · **테스트는 release 없이 `await host.dispose()` 가 즉시 종료를 핀**. SIGTERM/Electron 3초 백스톱은 강제종료 안전망이지 정상 drain 계약 아님. T3.
3. **불변식 ④(onWithdraw best-effort) 핀 테스트 §3 부재**: §3-7=발화 횟수·#8=③·#9=① — throw 격리 없음. → 신규 테스트(onWithdraw throw → resolve(false) 선행 보존·만료 타이머 self-DoS 없음)를 T2 에 추가.
4. **onEvent/audit 내부 모순**(계약 우선 판사 적발·양 판사 확정·**Codex 체크포인트 3 P1 독립 재확인**): §C-4/§3-6 은 maxPending 시 `reason:'pending-cap'` 감사를 요구하나 `approval.ts:51` gate emit=`{id,decision,risk}`(reason 미수신)·approver 는 boolean 만 반환 → 방출 불가. → **Codex 권고 옵션 1 채택**(내 초기안 `onEvent` 콜백보다 drift 적음): approver 반환을 **`ApprovalOutcome={approved:boolean; reason?:string}`** 로 확장, `GateOptions.approver: (req,opts?)=>Promise<ApprovalOutcome>`, **gate 가 유일 emitter — `o.reason` 을 자신의 `approval.decided` 한 번에 실음(approver 는 이벤트 자체 방출 없음 → 동일 id 에 `approval.decided` 중복 0**·Codex 체크포인트 3-R P1a 재확인). `IpcApproverOptions.onEvent` 대안 폐기. T1 gate 계약·T2 approver 반환.
5. **§3-14 "promise rejected" 문구 계약 충돌**(Codex 체크포인트 3 P2): abort 는 approver promise 를 **throw/reject 가 아니라 `{approved:false}` 로 해소**하고 gate.request 가 `'rejected'` 결정 반환(예외 기반 rejection 은 비계약 — 예외로 흘리면 gate.request 가 reject 돼 tool-loop 의 "승인 거부됨" tool_result 경로가 아닌 상위 오류 경로로 번짐). §3-14·§C-5 문구 수정 완료. T2/T3 RED 는 "resolves `{approved:false}`" 로 단언.

**추가 확정(패널)**: cancelChat 은 `loop.ts:174` signal 배선 하나로 **자동 커버**(실측 관통: `cancelChat`→`activeChatRuns.abort()` engine.ts:844 → `anySignal` engine.ts:810 → `room.ts:121 session.send({signal})` → `api-session.ts:158 callOpts.signal` → `api-session.ts:139 runToolLoop` → `loop.ts:174`). 별도 태스크 불요·회귀 테스트만 T3.

## 안전 순서 불변식 (척추 A — 이 계획의 서명)

**T3(취소 그래프 관통 GREEN) 반드시 T5(presence-0 rejectAll 제거) 이전.** presence-0 rejectAll 은 보안 컨트롤 삭제 — hold 하 fail-closed 종착은 **TTL 만료 + 취소 abort 두 경로뿐**. 취소 관통 GREEN 전 rejectAll 제거 시 취소된 run 의 held 승인이 abort 를 못 받아 TTL(10분) hang(= rejectAll 이 막던 바로 그 hang). 이는 단순 의존이 아니라 **변경 자체의 보안 불변식**. T5 는 `#19`(미검증 배제)·`#21`(drain rejectAll) characterization 핀을 먼저 GREEN 확인 → `#18`(presence-0 pending 유지)을 RED 로 rejectAll 제거를 구동(브래킷).

## 태스크 분해 (T0..T8 · TDD RED→GREEN · 스펙 §3 번호 매핑)

### T0 — D6 상류 스파이크 + clock 결정 + seq/cursor 동적 핀 (read-only + 결정)
- **산출(결정)**: ① 10분 기본 TTL 이 상류 LLM 세션/스트림/CLI 자식 안 깸을 코드 트레이스로 확정(부분 실측: gate.request 는 provider.chat 호출 **사이** await → hold 중 열린 HTTP/CLI 자식 없음). 못 견디면 provider별 TTL 캡 → C-4 범위 조정. ② **approver 타이머 clock 라우팅 = 채택**(T2 구현·T5 boot 주입). ③ mcp/host dispose 처리 방식 결정(스펙 수정 #2).
- **동적 핀(공백 그룹 판사 공통결함 #2)**: 정적 트레이스만으로 닫지 말 것 — **다분 hold + 재접속이 FleetEvent.seq 단조·eventCursor 갭감지(B1)를 보존**하는지 통합 테스트 1건(10분 실대기 아님·fake clock 으로 만료 직전 hold 중 재접속). T5 boot 통합에 편입.
- 의존 없음. **fail-closed**: 판정 불확실 시 provider 캡(느슨한 TTL 금지).

### T1 — 코어 타입·gate 중앙 흡수 (tsc GREEN 경계 · 계약 동결)
- **파일**: `shared/types.ts`(`ApprovalRequest.expiresAt: number` required · `FleetBridge` +2: `listPendingApprovals():Promise<ApprovalRequest[]>`·`onApprovalWithdrawn(cb:(id:string)=>void):()=>void` · `APPROVAL_MAX_PENDING=64` 상수 · **`ApprovalOutcome={approved:boolean; reason?:string}`**) · `safety/approval.ts`(`GateOptions.ttlMs?`(기본 `APPROVAL_TIMEOUT_MS`)·**`GateOptions.approver` 반환 `Promise<ApprovalOutcome>`·`request` 가 `o.approved` 로 결정·`o.reason` 을 기존 `GateOptions.onEvent(approval.decided)` 에 실음**(스펙수정 #4·Codex P1)·`request(partial, callOpts?:{signal?})` 인자 `Omit<ApprovalRequest,'id'|'ts'|'expiresAt'>` 확장·`expiresAt=now()+ttlMs` 스탬프·`approver(req,{signal})` 타입 확장) · `transport/channels.ts`(`fleet:approval:pending` invoke/both·`fleet:approval:withdrawn` push/both) · `transport/fixtures.ts`(`fleet:approval:pending` 픽스처).
- **중앙 흡수(이식 C)**: expiresAt required 폭포를 **gate 스탬프 + Omit 확장 + full-req 리터럴 4곳 기계 스윕**(`approval.ts:34`·`approval-bridge.test:5`·`ApprovalModal.test:26,77`·`boot-access.test:658`)으로 **경계 whole-project tsc GREEN**. gate.request 호출부(4곳)는 partial→무변.
- **test double 마이그레이션(Codex 3-R P2)**: `ApprovalGate.request` 시그니처가 `(partial,{signal?})`·approver 반환이 `ApprovalOutcome` 로 바뀌면 **테스트 더블도 깸** — `loop.test.ts` 의 `ApprovalGate` 더블·`mcp/host.test.ts` 의 `request` 만 가진 객체들·approver 반환 boolean 더블을 tsc-GREEN 경계 스윕에 포함(false-red churn 축소). T1(gate 계약)·T3(호출부) 각 경계에서 해당 더블 동반 수정.
- **RED**(§3): #16(expiresAt 스탬프)·#17(signal 전달)·#1(reject-immediate 회귀 0)·#28(부분: 채널/픽스처 정합·serialization). **fail-closed**: required=누락 컴파일 차단(A 통찰 유지).

### T2 — approver keystone + 불변식 §1.8 + ApprovalOutcome + signal 유닛 (최대 churn)
- **파일**: `safety/approval-bridge.ts`(+test). `IpcApproverOptions`: `presencePolicy?:'reject-immediate'|'hold'`(기본 reject-immediate)·`onWithdraw?`·`now?`/`setTimer?`/`clearTimer?`·`maxPending?`(**onEvent 대안 폐기 — reason 은 approver 반환으로 gate 에 전달**). `timeoutMs` 제거. `Pending={req,resolve,timer,cleanup}`. **approver 반환 `ApprovalOutcome`**(정상/거부 전경로가 `{approved:bool, reason?}` 로 해소·**예외 아님**·스펙수정 #5). `list()=expiresAt>now` 순수 필터. `approver(req,{signal?})`: hold 분기·`pending.size>=max`→`{approved:false, reason:'pending-cap'}`·진입 aborted 선체크+addEventListener **동일 동기 블록**(②)·enqueue `setTimer(fn,max(0,expiresAt-now()))`→signal 배선→`try{send}catch`(③)·해소 전경로 `delete→resolve({approved})→onWithdraw try/catch`(①④)·`cleanup`=removeEventListener 전경로.
- **RED**(§3): #1·#2(hold 양방향·동기 count 금지)·#3·#4·#5·#6(maxPending `>=` 경계+**gate 가 reason 감사**)·#7·**#7b 신규(onWithdraw throw 격리·④·스펙수정 #3)**·#8·#9·#10·#11·#12·#13. **fail-closed**: send/onWithdraw throw→pending 유지·TTL 종착·자동 승인 0·**abort/timeout=`{approved:false}` 해소(reject 아님)**.
- 의존 T1.

### T3 — 취소 그래프 통합 관통 + 형제 4호출부 스윕 + engine TTL (② 조기 소각)
- **파일**: `tools/loop.ts`(:174 `{signal:opts.signal}` + 이터레이션 상단 `if(opts.signal?.aborted) break`) · `orchestrator/orchestrator.ts`(:353·:923 signal 배선·스펙수정 #1) · `mcp/host.ts`(**dispose용 AbortController 신설·`dispose()` 시작 시 abort·`:241 gate.request({signal: disposeSignal})`·스펙수정 #2 필수 계약**) · `core/engine.ts`(`approvalTtlMs`→`createApprovalGate({ttlMs})`) · loop.test·orchestrator.test·engine.test·**mcp/host.test(더블 마이그레이션·아래 dispose 즉시종료 핀)**.
- **RED**(§3+이식): **#14 통합 관통**(실 gate+실 approver('hold')+`controller.signal`→pending→abort→**approver `{approved:false}` 해소(throw 아님)·gate `'rejected'` 반환**(스펙수정 #5) AND onWithdraw 1회 AND 리스너 정리·**mock-arg 금지 3-seam**) · #15(이터레이션 abort) · **orchestrator apply-diff abort 통합**(이식 A·신규) · **engine TTL seam**(이식 C·`approvalTtlMs` 주입→gate expiresAt·미주입 60s) · **cancelChat 자동커버 회귀**(이식 B) · **mcp dispose-during-held-spawn**(스펙수정 #2·release 없이 `await host.dispose()` 즉시 종료 + held approval `rejected` 핀).
- 의존 T2. **fail-closed**: abort→즉시 false(TTL 무관). **이것이 T5 rejectAll 제거의 선행 안전 게이트.**

### T4 — transport 핸들러·ws-bridge (3중 게이트 · 타입파생 배치표 이식 C)
- **파일**: `server/handlers.ts`(`ChannelMethodMap['fleet:approval:pending']:'listPendingApprovals'` + `AssertExact` 자동강제 + `HandlerTable` `()=>approver.list()`) · `renderer/bridge/ws-bridge.ts`(`listPendingApprovals:invoke`·`onApprovalWithdrawn:subscribe` bare-string 콜백) · ws-bridge-binding·handlers·serialization·channels 테스트.
- **타입파생 배치표(이식 C)**: 서버 handler=타입파생 `HandlerTable`(drift=tsc) / 데스크톱=수동 `ipcMain.handle`(T6·소스텍스트 파리티만). invoke 3중 게이트=fixtures satisfies·serialization keys·AssertExact.
- **RED**(§3): #28(invoke 부분·핸들러 위임·binding). 의존 T1·T2(list).

### T5 — 서버 보안 일괄 (#18~23) — **T3 이후에만 (안전 순서 불변식)**
- **파일**: `server/boot.ts`(+test). **clock 정의(현 348)를 `createIpcApprover`(286) 위로 이동**(이식 B/C·주입 전제) · `createIpcApprover({...,presencePolicy:'hold',onWithdraw:(id)=>wsHost?.broadcast('fleet:approval:withdrawn',id),now:clock.now,setTimer:clock.setTimeout,clearTimer:clock.clearTimeout,maxPending:APPROVAL_MAX_PENDING})`(**pending-cap 감사는 approver 반환 reason→engine 이 이미 gate 에 넘긴 `onEvent` 경로로 방출·approver 에 onEvent 미전달**) · `handleSocketGone` presence-0 `rejectAll` **제거**(424-426) · `close()` rejectAll **유지**(530) · `FLEET_APPROVAL_TTL_MS` 파싱 fail-fast(미설정→600000·유한 양정수 아니거나 `[5000,1800000]` 밖→**throw**) · `createFleetEngine({approvalTtlMs})`.
- **공통결함 #4 격리**: approver 타이머를 boot 기존 clock(소켓 exp 전용)에 라우팅하면 기존 fake-clock 테스트가 approver 타이머까지 부수 발화 가능 → 테스트에서 approver 타이머 존재를 명시 계상(회귀 해저드 flag).
- **RED 브래킷**(§3): #19·#21 GREEN 선행 → #18·#20·#22·#23. **완료정의 조기 서버 마일스톤(이식 B) = #20**(JWT 만료 후 held → 신규 인증 세션 정상 승인 = 서버 레벨 end-to-end 증명). #23=만료→withdrawn 통합(clock 라우팅). T0 seq/cursor 동적 핀 편입.
- 의존 **T3(안전 순서)**·T4·T2. **fail-closed**: TTL 오설정→boot throw·무응답→TTL 거부·presence-0(access)→hold(응답=인증 소켓만·B5 무변경·비인증 노출 0)·close→rejectAll.

### T6 — 데스크톱 parity (무회귀 · 수동 ipcMain.handle 비대칭)
- **파일**: `preload/index.ts`(`listPendingApprovals:invoke`·`onApprovalWithdrawn:on+removeListener` 2 바인딩) · `main/index.ts`(`broadcastApprovalWithdrawn`·`createIpcApprover({onWithdraw})`·`registerIpc` 수동 `ipcMain.handle('fleet:approval:pending',()=>ipcApprover.list())`).
- **web-bridge.ts 제외(이식 B)**: `bridge.fleet` 위임(line 108)이라 FleetBridge 미재구현 → 무변경.
- **RED**: ipc-parity·bridge-parity·main 승인 무회귀. 데스크톱 presencePolicy 미지정=reject-immediate·60s(무회귀). 의존 T1·T4.

### T7 — 렌더러 재제시 (C-7)
- **파일**: `renderer/components/ApprovalModal.tsx`(positional slice 폐기→id-keyed·`useHydration().nonce` effect+마운트→`listPendingApprovals()` **upsert**(비파괴·스냅숏 없는 라이브 보존)·`onApprovalWithdrawn(id)`→제거+tombstone Set·apply 시점 tombstone 재확인·카운트다운=`max(0,ceil((expiresAt-Date.now())/1000))`·`APPROVAL_TIMEOUT_MS` 소비 제거·setInterval `expiresAt<=now`→미표시)(+test mockFleet pending/withdrawn·HydrationProvider 래핑).
- **RED**(§3): #24·#25(upsert dedupe·라이브 보존)·#26(tombstone 인터리브·apply 시점 재확인)·#27(카운트다운 라이브 만료·공유상수 회귀 가드). 의존 T4·T5. 데스크톱 bridge=null→nonce 영구 0(무회귀).

### T8 — verify·brain·부팅 스모크·라이브 터널
- `npm run verify`(태스크마다 로컬·T8 최종) · `npm run test:e2e`(electron 9/9·T6/T7 후) · **라이브 터널**(Access 로그인→위험 작업 승인→인증 클라 0 전이 중 pending 생존→재접속→스냅숏 카드 재제시→승인→만료→withdrawn 소멸 = 완료정의 종단) · `npm run brain`(모든 src 변경 후 최종·별도 커밋).

## 불변식 §1.8 집행 매핑

| 불변식 | 태스크 | 핀 테스트 |
|---|---|---|
| ① 해소 순서(delete→resolve→onWithdraw·1회) | T2 | #4·#7·#9 |
| ② aborted 선체크+addEventListener 동기블록 | T2·T3 | #11·#12·**#14(통합)** |
| ③ send best-effort | T2 | #8 |
| ④ onWithdraw best-effort | T2 | **#7b(신규)** |
| ⑤ 중복 id 미고아 | T2 | #10 |
| ⑥ list() 순수 필터 | T2 | #3·#6 |
| (boot) presence-0 hold·drain fail-closed | T5 | #18·#21 |
| (boot) 인가 경계(인증 소켓만) | T5 | #19·#20 |

**출처 단일화(C-2)**: expiresAt 스탬프=gate(T1)·타이머 delay=approver(T2)·카운트다운=렌더러(T7)·통합만료=boot clock(T5 #23). 네 지점 동일 주입 clock.

## 검증 게이트 · PR 경계

- **단일 PR** `feat/216-c1-approval-hold` · prefix `feat(#216-C1):` · 9 TDD 커밋(T0~T8·각 tsc+GREEN). 근거: expiresAt/FleetBridge 원자 컴파일 경계가 분할 거부 · C-6(rejectAll 제거)은 T7(렌더러 재제시) 없이 랜딩 시 카드 불가시=이전보다 나쁜 UX → 함께 출하.
- **brain 규율**(MEMORY): src 먼저 커밋 → brain 재생성(최종 1회) → brain 별도 커밋(중간 재생성→CI brain:check fail 회피·lint-staged prettier 재포맷 순서 주의).
- **하드닝(maxPending·TTL fail-fast)은 T2/T5 코어에 포함**(미룰 뿐 미출하 아님 — 무-cap flood 노출 차단).
- PR open 후 **Codex+CodeRabbit 2봇** 인라인 스레드 resolve(unresolved=0 머지통과)·fix 푸시마다 재리뷰·`@codex review` 순수 한 줄.
- 태스크별 커밋 체크포인트 + 태스크별 적대 셀프리뷰(fleet-pr-review·opus/sonnet)로 리뷰 입도 확보(B3/B5 선례).

## 공통 결함 보강 (양 판사 합의 — 합성 반영)

1. **orchestrator/mcp hold-hang** → T3 편입(스펙수정 #1·#2).
2. **D6 × B1 seq/cursor 동적 미증명** → T0 설계·T5 통합 핀(정적 트레이스만으로 안 닫음).
3. **maxPending 감사 reason 배관** → approver 반환 `ApprovalOutcome.reason`→gate `approval.decided`(스펙수정 #4·Codex P1 옵션 1·T1/T2).
4. **boot clock 공유 커플링 테스트 해저드** → T5 격리 flag.

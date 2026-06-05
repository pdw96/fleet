# 오케스트레이터 후속: 승인 모달 + verify 자동 수정-루프 — 설계

- 날짜: 2026-06-05
- 브랜치: `fix/orchestrator-robustness` (PR #5 후속)
- 범위: PR #5 본문의 "후속(의도적 미구현)" 2건을 **둘 다** 이 브랜치에서 구현

## 배경

PR #5는 감사 발견을 4개 Phase로 교정하면서 안전 계층(`ApprovalGate`)과 verify 단계를
배선했으나, 두 연결고리를 의도적으로 미구현으로 남겼다.

1. **승인 모달** — `createApprovalGate`는 `approver` 콜백을 받지만
   `main/index.ts`의 `buildEngine()`이 주입하지 않는다(`engine.ts:64`의 슬롯이 빔).
   따라서 destructive 작업(파일 삭제·민감 파일 쓰기)은 항상 거부된다.
2. **verify 자동 수정-루프** — `orchestrator.ts`의 verify 섹션은 `opts.verify()`를
   1회만 실행하고 실패 시 곧장 프로젝트를 `failed` 처리한다(재시도 없음).

## 확정된 결정

| 항목 | 결정 |
|---|---|
| 범위 | 두 기능 모두 이 브랜치에서 구현 |
| 수정-루프 맥락 | 실패 분석 + 직전 산출물(아티팩트)을 implementer에 전달해 교정본 재생성 |
| 최대 수정 라운드 | 기본 2 |
| 승인 무응답/창없음 | 타임아웃 후 자동 거부(안전 기본값) |
| 승인 메커니즘 | 인앱 React 모달 + IPC 왕복. 상관/타임아웃 로직은 순수 모듈로 분리 |

---

## 기능 1 — 승인 모달 (destructive 작업 IPC 왕복)

### 아키텍처

코어=Electron 비의존 순수 TS 원칙을 지키기 위해, 상관(correlation)·타임아웃·창없음
처리는 **순수 모듈**에 두고 `main/index.ts`는 electron 배선만 담당한다.

```
오케스트레이터(메인) → ApprovalGate.request(destructive)
  → approver(req)  [순수 ipcApprover]
     → send(req)  → ipcMain → webContents.send('fleet:approval:request', req)  → 렌더러 ApprovalModal
                                                                                   ↓ 사용자 승인/거부
     ← resolve(id, ok) ← ipcMain.handle('fleet:approval:respond', id, ok)  ← respondApproval(id, ok)
  → Promise<boolean>
```

오케스트레이션은 메인에서 `runProject`로 실행 중이고, 렌더러의 `runProject` invoke는
여전히 await 상태다. 렌더러는 `ipcRenderer.on`으로 승인 요청 이벤트를 **동시에** 수신·응답할
수 있어 교착이 없다.

### 컴포넌트 / 인터페이스

**`src/main/core/safety/approval-bridge.ts` (신규, 순수)**

```ts
export interface IpcApproverOptions {
  send: (req: ApprovalRequest) => void          // 렌더러로 요청 방출
  hasWindow: () => boolean                       // 응답 가능한 창 존재 여부
  timeoutMs?: number                             // 기본 60_000
  now?: () => number
  onTimeout?: (id: string) => void               // (선택) 감사/정리 훅
}
export interface IpcApprover {
  approver: (req: ApprovalRequest) => Promise<boolean>
  resolve: (id: string, approved: boolean) => void   // 미존재 id 무시(idempotent)
  pendingCount: () => number
}
export function createIpcApprover(opts: IpcApproverOptions): IpcApprover
```

동작:
- `approver(req)`: `hasWindow()` 거짓이면 즉시 `false`. 아니면 `send(req)` 후
  `pending`(`Map<id, {resolve, timer}>`)에 등록하고 `timeoutMs` 후 `false`로 자동 해소.
- `resolve(id, ok)`: 매칭 pending의 타이머 해제 후 resolve. 미존재/이미 해소 시 무시.

**`src/main/index.ts` (배선)**
- `broadcastApprovalRequest(req)` = 모든 창에 `fleet:approval:request` send.
- `buildEngine()`에서 `ipcApprover = createIpcApprover({ send: broadcastApprovalRequest, hasWindow: () => BrowserWindow.getAllWindows().length > 0 })` 생성, `createFleetEngine({ ..., approver: ipcApprover.approver })`.
- `registerIpc`에 `ipcMain.handle('fleet:approval:respond', (_e, id: string, approved: boolean) => ipcApprover.resolve(id, approved))`.

**`src/preload/index.ts` + `FleetBridge`(shared/types.ts)**
```ts
onApprovalRequest(callback: (req: ApprovalRequest) => void): () => void   // 'fleet:approval:request' 구독
respondApproval(id: string, approved: boolean): Promise<void>            // 'fleet:approval:respond' invoke
```

**`src/renderer/components/ApprovalModal.tsx` (신규) + `App.tsx` 마운트**
- `onApprovalRequest` 구독 → 요청 큐(`ApprovalRequest[]`). 한 번에 하나(맨 앞)를 모달로 표시.
- 표시 내용: `summary`, `target`, `risk` 배지. 카운트다운(시각 표시; 권위 있는 타임아웃은 메인 측).
- [승인]/[거부] → `respondApproval(id, ok)` → 큐에서 제거 → 다음 요청 표시.
- 기존 "Obsidian Command Deck" 토큰/클래스 재사용(오버레이 + `.panel`).

### 에러 처리 / 안전
- 무응답(타임아웃)·창없음 → 거부. 이미 결정된(또는 미존재) id 응답은 무시.
- 메인 타임아웃이 권위. 사용자가 타임아웃 뒤 클릭해도 idempotent `resolve`로 무해.
- 모든 요청/결정은 기존 `gate.onEvent`(`approval.requested`/`approval.decided`)로 감사 로그에 남음(변경 없음).

### 현실적 트리거
현재 오케스트레이터는 파일 **쓰기**만 한다(삭제 경로 없음). 게이트 기본 `autoApprove:['safe','caution']`
이므로 일반 쓰기는 자동 승인되고, **민감 파일 쓰기**(`.env`/`.pem`/`.key`/`.ssh` 등 → destructive)에서
모달이 뜬다. verify 수정-루프의 교정 기록도 동일 게이트를 통과하므로 두 기능이 자연 연동된다.

---

## 기능 2 — verify 자동 수정-루프

### 아키텍처
`runProject`의 verify 섹션(현 `orchestrator.ts:246-268`)을 루프로 확장한다.

```
verify() 실행
  통과 → done
  실패 → (라운드 잔여 && implementer 존재 && fileWriter 존재) 동안 반복:
           buildVerifyFixPrompt(goal, 실패목록, 아티팩트원장)
             → implementer.send(prompt, {fresh:true})
             → 교정 아티팩트 게이트 경유 기록(writeArtifacts)
             → verify() 재실행
           통과 → done(루프 탈출)
  소진 후에도 실패 → failed
```

### 컴포넌트 / 인터페이스

**`RunOptions` 확장(orchestrator.ts)**
```ts
maxVerifyFixRounds?: number   // 기본 2. 0=비활성. floor 후 (finite && >=0) 아니면 2
```

**아티팩트 원장**
- `writeArtifacts`가 성공 기록한 `{path, content}`를 run 범위 `Map<string,string>`에 누적.
- 수정-루프와 교정 재기록도 같은 원장을 갱신한다(최신 내용 유지).

**`buildVerifyFixPrompt(goal, failures, artifacts)` (review.ts, 신규)**
- 입력: `goal`, 실패한 `VerificationResult[]`(kind·command·analysis·stderr 트림), 원장(`path→content`).
- 출력 프롬프트: 실패 요약 + 현재 파일 내용(총량 상한 캡 **약 12,000자**, 초과 시 파일 단위로
  절단하고 `…(절단)` 표기) → 교정본을 ` ```file:상대경로 ``` ` 형식으로 출력 요청.
  `buildImplementPrompt`의 파일 형식 안내 재사용. stderr도 파일당/실패당 트림(예: 2,000자).

**이벤트**: `OrchestratorEventType`에 `'verify.fixing'` 추가. 라운드별 `verify.fixing` 방출
(`data: { projectId, round }`), 이후 기존 `verify.passed`/`verify.failed`로 수렴.

### 데이터 흐름 / 경계
- 수정 LLM = `resolveLlmForRole(assignments, 'implementer', 'implementer')`(없으면 루프 생략).
- `opts.verify`·`opts.fileWriter`는 엔진에서 워크스페이스 설정 시 함께 주입되므로
  (verify 있음 ⇒ fileWriter 있음) 둘 다 존재한다고 가정 가능(없으면 루프 생략).
- 최종 `verifyFailed` 판정·프로젝트 상태(done/failed)는 루프 종료 후 1회 계산(기존 로직 유지).
- summary는 1차 계산 유지(verify 수정은 재요약하지 않음 — YAGNI).

### 에러 처리
- 수정 라운드 중 `implementer.send` 실패 → 해당 라운드 중단, 직전 verify 결과로 수렴(작업 단위 격리 패턴 일관).
- verify 재실행 자체가 throw → 기존처럼 `verifications=[]` + `verify.failed`.

---

## 공유 타입 변경 (shared/types.ts)
- `FleetBridge`에 `onApprovalRequest`, `respondApproval` 추가.
- `OrchestratorEventType` 유니온에 `'verify.fixing'` 추가.
- (`ApprovalRequest`/`RiskLevel`/`ApprovalDecision`은 기존 정의 재사용 — 변경 없음.)

## 테스트 계획
- **`approval-bridge.test.ts`**(신규): 승인 해소 / 거부 해소 / 타임아웃 자동거부 / `hasWindow=false` 즉시거부 / 미존재 id `resolve` 무시(idempotent) / `pendingCount` 추이. 가짜 `send`·주입 `now`·fake timers.
- **`orchestrator.test.ts`**(확장): verify 1차 실패 → 수정 라운드에서 implementer 재호출·교정 아티팩트 재기록 → 2차 통과 시 `done`; 라운드 소진 시 `failed`; `maxVerifyFixRounds:0`이면 수정 시도 없음. verify·fileWriter·sessions 스텁.
- **`ApprovalModal.test.tsx`**(신규, RTL+jsdom): 요청 이벤트 수신 시 summary/target/risk 렌더, [승인]/[거부] 클릭 시 `respondApproval(id, true/false)` 호출, 다중 요청 순차 표시.

## 검증 게이트
`npm run typecheck` / `npm run lint` / `npm test`(기존 180 + 신규) / `npm run build` 전부 그린.

## 비범위 (YAGNI)
- "이번 세션 동안 기억"/일괄 승인 옵션.
- `maxVerifyFixRounds`의 UI 노출(오케스트레이터 옵션 기본값으로만; 추후).
- 네이티브 `dialog.showMessageBox` 폴백.
- 파일 삭제(remove) 트리거 경로 신설(현 오케스트레이터는 쓰기만 함).

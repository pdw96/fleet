# Fleet — 멀티 LLM 오케스트레이션 데스크톱 앱 · 아키텍처 설계

> 차세대 harness engineering 기반 데스크톱 앱. 여러 LLM(구독제 CLI/TUI + API)이 하나의
> 작업방에서 협업하여 사용자의 프로젝트를 높은 정확도로 완수한다.

---

## 1. 설계 원칙

1. **코어 엔진은 Electron 비의존 순수 TypeScript.** `src/main/core/*`는 Node 표준 라이브러리와
   소수의 순수 패키지만 사용한다. → GUI 없이 `vitest`로 전 계층을 헤드리스 검증 가능 ("테스트 가능한 MVP").
2. **전송(transport) 추상화.** TUI(PTY) 세션과 API 세션을 동일한 `LlmSession` 인터페이스 뒤로 통일한다.
   오케스트레이터는 세션이 CLI인지 API인지 알 필요가 없다.
3. **확장은 레지스트리로.** 새 CLI(`CliAdapter`), 새 API provider(`ApiProvider`), 새 역할/워크플로/검증
   전략(`Role`, `VerifyStrategy`)을 플러그인처럼 등록만 하면 된다. 코어 분기문 수정 불필요.
4. **안전 우선.** destructive 명령·파일 쓰기는 `ApprovalGate`를 통과해야 실행된다. 모든 행위는
   추적 가능한 이벤트 로그(`EventLog`)를 남긴다.
5. **단일 진실 원천 타입.** `src/shared/types.ts`의 타입을 main·preload·renderer가 공유한다.

---

## 2. 계층 구조 (요구사항 7 매핑)

```
┌─────────────────────────────────────────────────────────────────┐
│ Renderer (React + Vite)  — 요구사항 1,3,8                         │
│   목표 입력 · 세션/등록 · API 설정 · 멀티LLM 채팅방 · 작업보드 · 검증결과 │
└───────────────▲───────────────────────────────────────────────────┘
                │ contextBridge IPC (preload, contextIsolation:true)
┌───────────────┴───────────────────────────────────────────────────┐
│ Electron Main (Node)                                               │
│   ipc/  — 채널 핸들러 (core ↔ renderer 배선)                        │
│   ┌───────────────────────────────────────────────────────────┐   │
│   │ core/ (순수 TS, Electron 비의존)                            │   │
│   │   cli/        CLI 감지 + PTY 세션      ← 요구사항 2A         │   │
│   │   providers/  API LLM provider         ← 요구사항 2B         │   │
│   │   session/    통합 LlmSession 추상화    ← 요구사항 2,4        │   │
│   │   orchestrator/ 목표분해·역할·재검토루프 ← 요구사항 4,5       │   │
│   │   chat/       메시지 버스(라이브 채팅)   ← 요구사항 3          │   │
│   │   store/      상태 + 대화 로그 영속화     ← 요구사항 6,7        │   │
│   │   verify/     test/lint/typecheck/smoke ← 요구사항 5          │   │
│   │   fileops/    파일작업 + 승인 게이트      ← 요구사항 6          │   │
│   └───────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 3. 핵심 도메인 모델 (`src/shared/types.ts`)

- `LlmConnectionKind = 'cli' | 'api'`
- `LlmDescriptor` — 등록된 LLM (id, kind, 표시이름, 모델, 설정).
- `LlmSession` — 살아있는 세션 핸들. `send(text)`, `onChunk`, `interrupt()`, `dispose()`.
- `ChatRoom` / `ChatMessage` — 작업방과 메시지(author=llmId|'user'|'system', role, content, ts).
- `AgentRole` — `'planner' | 'architect' | 'implementer' | 'reviewer' | 'tester' | 'critic' | 'summarizer'`.
- `RoleAssignment` — 역할 ↔ llmId 배정.
- `Project` / `Task` — 사용자 목표와 분해된 작업(상태: pending→running→review→done|failed).
- `VerificationResult` — 검증 종류·통과여부·출력·분석.
- `ApprovalRequest` — 승인 게이트 요청(명령/경로/위험도).
- `FleetEvent` — 추적 로그 단위(감사용).

---

## 4. 전송/세션 추상화 (요구사항 2)

```
LlmSession (인터페이스)
 ├─ CliSession      ← CliAdapter + PtyTransport
 │    PtyTransport 구현:
 │      NodePtyTransport  (node-pty, 실제 TUI; 네이티브 빌드 필요)
 │      PipeTransport     (child_process 파이프; 빌드 불요 폴백)
 │      MockTransport     (테스트)
 └─ ApiSession      ← ApiProvider (Anthropic | OpenAI | Google)
```

- `CliAdapter`: `name`, `detectCommand`(예: `claude --version`), `spawnArgs`, 출력 파서. 레지스트리에 등록.
- `ApiProvider`: `name`, `chat(messages, opts)` → 스트림. 키·모델·temperature·max_tokens 설정 보유.
- **둘 다 `LlmSession`을 만족** → 오케스트레이터/채팅방은 동일하게 다룬다.

PTY 폴백 전략: `NodePtyTransport` 설치 실패(네이티브 툴체인 부재) 시 `PipeTransport`로 자동 강등.
코어는 import 시점에 node-pty를 강제 로드하지 않는다(지연 로드).

---

## 5. 오케스트레이션 엔진 (요구사항 4,5)

```
goal ──▶ Planner(LLM) ──▶ TaskGraph(작업 분해)
                              │
        각 Task ──▶ 역할 배정(자동: 적합도 점수 | 수동: 사용자 지정)
                              │
        Implementer(LLM) ──▶ 산출물 ──▶ Reviewer(LLM) 교차 리뷰
                              │                  │
                              └── 충돌/실패 ──▶ 재검토 루프(최대 N회)
                              │
        Verify 계층(test/lint/typecheck/smoke) ──▶ 통과까지 수정 루프
                              │
        Summarizer ──▶ 최종 산출물 vs 원래 요구사항 누락 점검
```

- 역할↔LLM 배정은 정책(`AssignmentPolicy`)으로 분리: `manual`, `round-robin`, `capability-scored`.
- 재검토 루프는 결정론적 제어(최대 반복·종료 조건)로 무한루프 방지. 단위 테스트 대상.

---

## 6. 저장소 (요구사항 6,7)

- MVP: **JSON 파일 기반 저장소**(`store/`)로 시작 — 외부 네이티브 의존 없이 테스트 용이.
  (확장: better-sqlite3로 교체 가능하도록 `Store` 인터페이스 뒤로 캡슐화.)
- 저장 대상: 프로젝트/작업 상태, 대화 로그(저장·재로딩), 이벤트 로그(감사).
- 위치: Electron `app.getPath('userData')/fleet/`. 테스트에서는 임시 디렉토리 주입.

---

## 7. 안전 (요구사항 6)

- `ApprovalGate`: 파일 쓰기·삭제·shell 실행 전 `ApprovalRequest` 발행. 정책에 따라 자동승인(안전)/
  사용자승인(위험) 분기. 기본은 destructive 작업 차단.
- `DESTRUCTIVE` 패턴(rm -rf, del /s, 강제 push, 포맷 등) 거부 리스트. 모든 게이트 통과/거부는 이벤트 로그 기록.

---

## 8. IPC 계약

- 채널은 `fleet:<domain>:<action>` 네이밍. preload가 `window.fleet` 아래로 타입세이프 노출.
- 이벤트(스트림 청크·상태변경)는 main→renderer push(`webContents.send`). 명령은 renderer→main invoke.

---

## 9. UI 토큰 스트리밍 (채팅 라이브 렌더링)

CLI 토큰 스트리밍 코어(`CliSession.execute`가 `SendOptions.onChunk`로 토큰/이벤트 델타를 라인 단위
파싱해 실시간 방출)를 채팅 UI까지 연결해, 응답을 토큰 단위로 라이브 렌더링한다.

```
engine.askLlm / discussRoom
  └─ streamedAsk(streamId 발급) ─ controller.askLlm({onToken}) ─ session.send({onChunk})
                                                                     └─ 토큰별 onChunk(delta)
  └─ onChatStream 싱크로 방출 ─ start → delta* → end | error
       └─ broadcast('fleet:chat:stream', webContents.send) ─ preload 구독 ─ ChatPanel 라이브 말풍선
```

- **이벤트 계약** `ChatStreamEvent`(`src/shared/types.ts`): `start | delta | end | error` 합타입.
  최종 `ChatMessage.id`는 store 영속 시점에야 정해지므로, in-flight 응답은 메인이 발급한 `streamId`로
  식별한다(발언 1회 = 1 streamId). 모든 변형에 `roomId`를 실어 렌더러가 비활성 방 이벤트를 거른다.
- **방출은 엔진이 소유.** `streamedAsk`(`engine.ts`)가 `askLlm`·`discussRoom`을 감싸 이벤트를 방출 →
  단일 질문과 AI 토론이 균일하게 흐른다. `onChatStream` 싱크 미주입 시 그대로 위임(스트리밍 비활성).
- **전송은 §8 패턴 재사용.** `onOrchestratorEvent`와 동형의 broadcast(`fleet:chat:stream`) + preload
  구독(해제 함수 반환). `AskOptions.onToken` → `session.send({onChunk})`로 코어 콜백에 연결.
- **graceful degradation.** 비스트리밍 세션(API/스트리밍 미지원 CLI)은 `onChunk`가 최종 텍스트로 1회만
  호출 → delta 1개로 도착(한 번에 표시). 스트리밍 활성 여부와 무관하게 동작 보존.
- **렌더러 동시성 안전**(`ChatPanel.tsx`): 라이브 말풍선을 `streamId` 평면 보관(각 말풍선이 roomId 보유)하고
  렌더 시 활성 방으로 필터 → 방 전환에도 백그라운드 스트림 유지. 구독은 마운트 1회. `end`는 말풍선을 제거하고
  영속 메시지를 활성 방에 한해 낙관적 추가(토론 중간 발언 즉시 표시). 비동기 응답 도착 시점의 방 불일치
  덮어쓰기는 `activeRoomRef`(최신 활성 방) 도착-방 가드로 차단한다.

---

## 10. UI 디자인 시스템 (Obsidian Command Deck)

renderer 의 시각 정체성은 "멀티 LLM 을 지휘하는 정밀 계측기"다. 제너릭 다크 UI 를 벗어나
의도적이고 distinctive 한 한 가지 미감에 충실하게 실행한다.

- **색 — 이원 신호 체계.** 흑요석 베이스(#0a0b0d)에 두 액센트만: 시그널 앰버(#ffc24b) = 사용자
  액션·포커스·활성, 라이브 민트(#4fe0c0) = 실시간 상태(스트리밍·라이브 세션). 채팅 참여자는 id
  해시로 고유 색(`agentHue`)을 받아 멀티 LLM 발언을 시각적으로 분간한다.
- **타이포 — 세리프 × 모노.** 디스플레이 세리프 Fraunces(워드마크·패널 타이틀) × 워크호스 모노
  IBM Plex Mono(데이터·식별자·토큰·UI). 폰트는 `src/renderer/fonts/` 에 라틴 서브셋 woff2 로 로컬
  번들 → index.html 의 엄격한 CSP(`default-src 'self'`)를 유지하면서 오프라인에서도 동작한다(vite 가
  'self' 해시 자산으로 처리). 한글은 시스템 폰트로 폴백한다.
- **분위기.** 헤어라인 보더 + 도트그리드 + 코너 글로우 + 비네팅(전부 CSS 그라디언트 — data: URI
  없이 CSP 안전). 패널은 eyebrow 코드네임(01 — CLI…) + Fraunces 타이틀의 에디토리얼 헤더.
- **스트리밍 히어로.** 라이브 말풍선은 민트 시그널 바 스윕 + 발광 캐럿 + 글로우로 '전송 중'을
  표상하고(§9 토큰 스트리밍의 렌더 표면), 완료 시 영속 메시지로 승격된다.
- **구현.** `styles.css` 가 디자인 토큰(CSS 변수)·컴포넌트 클래스·키프레임을 소유하고 컴포넌트는
  className 으로만 표현한다. `ui.ts` 는 className 으로 어려운 동적 색상(`statusColor`·`agentHue`)만 둔다.
- **접근성·모션.** 의미 텍스트는 WCAG AA 대비(faint ~4.9:1), 모든 인터랙티브 요소에 `:focus-visible`
  링, 비활성 1차 버튼은 고스트로 강등(색 신호 의미 보존). 진입 스태거·스트리밍 펄스는
  `prefers-reduced-motion` 에서 정지한다.

---

## 11. MVP 범위 (요구사항 8) → 완수 정의

1. 빌드·기동되는 Electron 데스크톱 앱 (smoke 통과)
2. claude/codex/gemini CLI 설치 감지
3. API 모델 설정 화면 + provider 연결
4. 여러 LLM 세션 등록
5. 멀티 LLM 라이브 채팅방 (메시지 교환·로그 저장)
6. Planner/Reviewer 역할 기반 간단 오케스트레이션
7. 대화 로그 저장·재로딩
8. 프로젝트 목표 입력 + 작업 분해
9. 전체 `test`/`typecheck`/`lint` 통과, 코어 엔진 헤드리스 검증

---

## 12. 품질 게이트

- `npm run typecheck` (tsc --noEmit, main+renderer+shared)
- `npm run lint` (eslint)
- `npm test` (vitest, 코어 엔진 단위/통합)
- `npm run build` (electron-vite build) — 산출물 생성 = 기동 가능성 smoke

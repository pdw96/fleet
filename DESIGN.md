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

## 9. MVP 범위 (요구사항 8) → 완수 정의

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

## 10. 품질 게이트

- `npm run typecheck` (tsc --noEmit, main+renderer+shared)
- `npm run lint` (eslint)
- `npm test` (vitest, 코어 엔진 단위/통합)
- `npm run build` (electron-vite build) — 산출물 생성 = 기동 가능성 smoke

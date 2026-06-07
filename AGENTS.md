# AGENTS.md — Fleet 에이전트 작업 가이드

멀티 LLM 오케스트레이션 데스크톱 앱(Electron + React + TypeScript). 구독형 CLI(claude/codex/
gemini)와 API provider(anthropic/openai/google)를 통합 `LlmSession` 뒤로 묶어 역할 기반으로
협업시킨다. 설계 전반은 [`README.md`](./README.md) · [`DESIGN.md`](./DESIGN.md) 참조.

이 파일은 코딩 에이전트(Claude Code / Codex / Gemini CLI 등) 공통 가이드다.
`CLAUDE.md`·`GEMINI.md` 는 이 파일을 가리키는 얇은 포인터다.

## 품질 게이트 (변경 후 반드시 통과)

```bash
npm run typecheck   # tsc --noEmit (main + renderer + shared)
npm run lint        # eslint (경고도 0 으로 유지)
npm test            # vitest — 코어 엔진 단위/통합 (헤드리스)
npm run build       # electron-vite build = 기동 가능성 smoke
```

CI(`.github/workflows/ci.yml`)가 PR/`master` push 에서 위 4개를 강제한다.
`npm run test:e2e`(playwright)는 느려 CI 게이트에 없다 — 로컬에서 필요 시 수동 실행.

## 아키텍처 규칙 (어기지 말 것)

- **코어 엔진은 Electron 비의존 순수 TS.** `src/main/core/*` 는 Node 표준 + 소수 순수 패키지만
  쓴다 → GUI 없이 vitest 로 전 계층 검증 가능. 코어에서 `electron` 을 import 하지 말 것.
- **단일 진실 원천 타입.** main·preload·renderer 가 공유하는 타입은 전부 `src/shared/types.ts`.
  여기에만 선언하고 import 한다. 런타임/DOM/Node 의존 코드를 넣지 말 것.
- **확장은 레지스트리로.** 새 CLI 는 `cli/registry.ts`, 새 API provider 는 `providers/registry.ts`
  에 등록만 한다(코어 분기문 수정 금지).
  - `CliAdapter` 는 IPC 로 직렬화되므로 **함수 필드 금지** — 데이터 필드만 둔다.
- **안전 우선.** 파일 쓰기/삭제/shell 은 `ApprovalGate` 를 통과해야 한다(`core/safety/`). 기본은
  destructive 차단.
- **provider 계약.** `ApiProvider.chat()` 는 구조화된 `ChatResult`(text·toolCalls·finishReason·
  usage)를 반환한다. `LlmSession.send()` 는 하위호환을 위해 여전히 `string` 을 반환한다.

## 함정 (CI/타입으로 안 잡히는 것)

- **preload/IPC 변경 후 `npm run dev` 재시작 필수.** electron-vite 는 preload 를 핫리로드하지
  않는다. 재시작 안 하면 `window.fleet` 의 새 메서드가 `undefined` → 클릭 시 검은 화면.
  (`src/preload/index.ts` · `src/shared/types.ts` 의 `FleetBridge` 동시 변경 시 특히 주의.)
- **E2E 활성화는 `FLEET_E2E === '1'` 일 때만.** (`src/main/index.ts:38`) `0`/`false`/빈 값은
  프로덕션 경로. 이 가드를 느슨하게 바꾸면 페이크 러너(영구 in-flight)·E2E 픽스처가 프로덕션
  런치로 샌다.

## 컨벤션

- 주석/식별자 설명은 한국어. 기존 코드의 주석 밀도·네이밍·관용구를 따른다.
- 새 기능/버그픽스는 TDD: 코어 변경엔 `*.test.ts`(vitest) 동반.
- 커밋은 특성 브랜치에 작게. push/merge/배포 전에는 사용자 확인.

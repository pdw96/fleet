# AGENTS.md — Fleet 에이전트 작업 가이드

멀티 LLM 오케스트레이션 데스크톱 앱(Electron + React + TypeScript). 구독형 CLI(claude/codex/
gemini)와 API provider(anthropic/openai/google)를 통합 `LlmSession` 뒤로 묶어 역할 기반으로
협업시킨다. 설계 전반은 [`README.md`](./README.md) · [`DESIGN.md`](./DESIGN.md) 참조.

이 파일은 코딩 에이전트(Claude Code / Codex / Gemini CLI 등) 공통 가이드다.
`CLAUDE.md`·`GEMINI.md` 는 이 파일을 가리키는 얇은 포인터다.

## 코드베이스 빠른 파악 — `brain.md` 먼저 읽기

`src/` 를 통째로 뒤지기 전에 [`brain.md`](./brain.md)(자동 생성)를 **먼저 읽어라.** 54개 파일의 역할·의존(→)·
피의존(←)·IPC 배선·허브/진입점/게이트를 한 장에 압축한 구조 지도다(≈6K 토큰). 전체 `src/` 탐색(≈90K 토큰)을
대체해 토큰을 아낀다. 코드 변경 후 `npm run brain` 으로 갱신(`src/` 에서 자동 추출 — drift 시 재생성). 사람용
시각 그래프는 `fleet-brain.html`(`npm run brain` 산출, gitignore). 설명 문구는 `scripts/brain/descriptions.json` 에서 수정.

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
- **리뷰 피드백 교차검증.** PR 리뷰 코멘트(Codex 봇 등)를 반영할 때, 라이브러리·API·SDK·CLI·모델
  관련 지적은 에이전트 학습 컷오프 지식에만 의존하지 말고 **context7 MCP 로 현행 문서를 받아
  교차검증**한 뒤 수용/반박한다(컷오프 이후 변경 가능 — 착수 전 model-capability 검증 규율의 연장).

## 백로그 착수 절차 (이슈 #27 기반)

"이슈 #27 확인하고 작업 진행" 류 지시를 받으면 아래 루프를 따른다. 백로그는 4중으로 조직돼 있다:
**#27**(메타 트래커 — 랭킹·근거·refute 이력) · **sub-issue 계층**(#27 의 자식 이슈) · **라벨**
(`area:*`/`tier:*`/`type:*`) · **Projects 보드**(«Fleet 백로그» = `https://github.com/users/pdw96/projects/1`,
project number `1`, owner `pdw96`).

1. **선정** — `gh issue view 27 --repo pdw96/fleet` 로 본문 «🎯 착수 sub-issues» 트래커를 확인하고
   `tier:next` 최상위를 집는다(나열 순서 = 권장 착수순; 후보가 비었거나 모호하면 사용자에게 확인).
   `gh issue list --repo pdw96/fleet --label tier:next` 로도 필터 가능.
2. **브랜치** — master 직접 작업 금지. `feat/<slug>` 특성 브랜치 생성.
3. **사이클** — 비자명하면 브레인스토밍 → 스펙(`docs/superpowers/specs/`) → 계획. TDD(RED→GREEN).
   품질 게이트 4종 green(위 「품질 게이트」 참조; preload 변경 시 dev 재시작). 적대 리뷰.
4. **PR** — 본문에 `Closes #<N>` 를 넣는다(머지 시 이슈 자동 닫힘 → #27 sub-issue 진행률 자동 갱신).
   PR open 후 **Codex 봇 자동리뷰를 기다려** 반영(위 「리뷰 피드백 교차검증」) → 사용자 확인 후 squash 머지.
5. **머지 후 동기화** — (a) 이슈 닫힘·#27 진행률 = `Closes #N` 으로 자동. (b) **보드 Status → Done**:
   보드 내장 워크플로("Item closed → Done")가 켜져 있으면 자동, 아니면 `gh project item-edit` 로 수동
   (필요한 id 는 `gh project item-list 1 --owner pdw96 --format json` 로 수확 — `--project-id`=`PVT_…`
   project node, `--id`=`PVTI_…` item node, `--field-id`+`--single-select-option-id`/`--number`).
   (c) **#27 본문**: 🎯 트래커 체크 + ✅완료/changelog 이동(수동 — 분석 기록).

**새 이슈 생성 시**: `area:{provider,orchestrator,mcp,renderer,electron,devx}` + `tier:{next,later}`
(+ 필요 시 `type:{spike,meta,security}`) 라벨 부여 + #27 sub-issue 편입(`gh api … /sub_issues`,
`sub_issue_id`=대상 이슈의 **DB id**) + 보드 추가(`gh project item-add 1 --owner pdw96 --url …`). 기능
이슈는 `enhancement` 유지. 차기 작업 공급원 = #27 말미 🔬 컷오프 갭 / Hermes 후보 또는 재랭킹.

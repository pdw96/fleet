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

CI(`.github/workflows/ci.yml`)가 PR/`master` push 에서 위 4개를 강제한다. 또한 **master ruleset
(`master protection`)이 `typecheck · lint · test · build`·`windows vitest (win32 보안 회귀)` 잡을
required status check 로 걸어, 통과 전 머지를 플랫폼 차원에서 차단한다(관례 → 강제).**
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
- **Windows 툴링 경로/인코딩.** Bash 도구는 Git Bash(MSYS) — `/tmp` 가
  `C:\Users\…\AppData\Local\Temp` 로 매핑되지만 **네이티브 Python/도구는 `/tmp` 를 `C:\tmp`
  (드라이브 루트)로 해석한다.** Git Bash 로 만든 파일을 네이티브 도구(예: 시스템 `python`)에
  넘길 땐 `/tmp` 대신 **절대 Windows 경로나 stdin 파이프**를 써라. 네이티브 Python 의 한글/
  이모지 입출력은 기본 cp949 라 깨짐 → `PYTHONUTF8=1`.
- **engine-strict floor 정직성.** `.npmrc` 의 `engine-strict=true` 때문에 선언한
  `engines.node`(현 `>=22.22.1 <23 || >=24`)가 의존성 트리의 *실제* 바닥과 어긋나면 `npm ci` 가
  EBADENGINE 로 하드 실패한다(transitive 까지 강제). 현 바닥 결정자: `eslint-visitor-keys`
  (`^22.13.0 || >=24` → **Node 23 제외**) · `lint-staged@17`(`>=22.22.1`). dev-tool 이 floor 를
  올리면 **최신 메이저를 다운그레이드해 회피하지 말고 floor 를 정직하게 상향**하라(핀된
  `.nvmrc`/CI 엔 무영향). lockfile 루트 `engines` 드리프트는 `npm install --package-lock-only` 로 동기화.

## 컨벤션

- 주석/식별자 설명은 한국어. 기존 코드의 주석 밀도·네이밍·관용구를 따른다.
- 새 기능/버그픽스는 TDD: 코어 변경엔 `*.test.ts`(vitest) 동반.
- 커밋은 특성 브랜치에 작게. push/merge/배포 전에는 사용자 확인.
- **리뷰 피드백 교차검증.** PR 리뷰 코멘트(Codex 봇 등)를 반영할 때, 라이브러리·API·SDK·CLI·모델
  관련 지적은 에이전트 학습 컷오프 지식에만 의존하지 말고 **context7 MCP 로 현행 문서를 받아
  교차검증**한 뒤 수용/반박한다(컷오프 이후 변경 가능 — 착수 전 model-capability 검증 규율의 연장).

## Codex 리뷰 운영 기준

Codex 봇은 Fleet 에서 **스타일 리뷰어가 아니라 P0/P1 고위험 회귀를 잡는 senior reviewer** 로
운용한다. CI 4게이트(`typecheck·lint·test·build`)와 본 가이드가 이미 막는 영역(포맷·자명한 타입)은
Codex 의 몫이 아니다 — **CI·타입이 못 잡는** 아키텍처/계약/안전 회귀에 집중시킨다.

- **운영 모드.** Codex GitHub integration 의 *Code review + Automatic reviews* 를 기본으로 켜
  PR open/ready 시 `@codex review` 없이 자동 리뷰를 받는다. 수동 `@codex review` 코멘트는
  **자동 리뷰 지연·무응답 시 fallback** 으로만 유지(cadence·👍 clean 감지는 아래 「백로그 착수 절차」
  4단계 「Codex 봇 운영」 참조).
- **required check 화(현재 미도입).** Automatic reviews 자체는 머지 게이트가 아니다. Codex 를 머지
  차단 **required status check** 로 강제하려면 Automatic reviews 가 아니라 별도 GitHub Actions
  워크플로에 `openai/codex-action@v1` job 을 만들고, `master protection` ruleset 에 그 **job 표시명**
  (잡 id 아님 — skip 시 영구 pending 함정)을 required check 로 등록한다. 실측 후 결정(#98).
- **CodeRabbit 병행은 실측 후.** CodeRabbit 류 풍부한 코멘트·incremental review·required gate 는
  중복 코멘트·리뷰 피로 위험이 있어 지금은 도입하지 않는다. contributor 증가·minor/refactor 수요가
  커지면 false-positive 율·실제 수정 반영률을 측정해 보조 리뷰어로 실험한다(#98).

**Fleet 특화 P1 신호** — Codex 가 우선 잡아야 할 고위험 회귀(CI 가 통과시켜도 P1 로 본다). 각 항목은
위 「아키텍처 규칙」·「함정」의 계약을 런타임/타입이 못 잡는 지점에서 보강한다:

- **코어 Electron/DOM 의존성 유입** — `src/main/core/*` 에 `electron`/DOM import(순수 TS 계약 위반).
- **`ApprovalGate` 우회** — 파일 쓰기/삭제/shell 이 게이트를 거치지 않는 경로(`core/safety/`).
- **IPC / `FleetBridge` drift** — `preload/index.ts` ↔ `shared/types.ts` 의 브리지·타입 불일치.
- **provider / session 계약 위반** — `ApiProvider.chat()` 의 `ChatResult` 구조·`LlmSession` 하위호환 깨짐.
- **`FLEET_E2E` 가드 완화** — E2E 픽스처·페이크 러너가 프로덕션 경로로 새는 변경.
- **engine / lockfile drift** — `engines.node` floor ↔ 의존성 실제 바닥 불일치(EBADENGINE)·lockfile 루트 드리프트.
- **release / update 안전장치 약화** — 서명·attestation·`latest.yml` sha512 무결성·updater 채널 가드 후퇴.

## 백로그 착수 절차 (이슈 #27 기반)

"이슈 #27 확인하고 작업 진행" 류 지시를 받으면 아래 루프를 따른다. 백로그는 4중으로 조직돼 있다:
**#27**(메타 트래커 — 랭킹·근거·refute 이력) · **sub-issue 계층**(#27 의 자식 이슈) · **라벨**
(`area:*`/`tier:*`/`type:*`) · **Projects 보드**(«Fleet 백로그» = `https://github.com/users/pdw96/projects/1`,
project number `1`, owner `pdw96`).

1. **선정** — `gh issue view 27 --repo pdw96/fleet` 로 본문 «🎯 착수 sub-issues» 트래커를 확인하고
   `tier:next` 최상위를 집는다(나열 순서 = 권장 착수순; 후보가 비었거나 모호하면 사용자에게 확인).
   `gh issue list --repo pdw96/fleet --label tier:next` 로도 필터 가능.
2. **브랜치** — 기본 브랜치(현재 `master`) 직접 작업 금지(**ruleset 이 직접 push·force-push·삭제를
   플랫폼 차단**; 비상시 repo admin bypass). `feat/<slug>` 특성 브랜치 생성.
3. **사이클** — 비자명하면 브레인스토밍 → 스펙(`docs/superpowers/specs/`) → 계획. TDD(RED→GREEN).
   품질 게이트 4종 green(위 「품질 게이트」 참조; preload 변경 시 dev 재시작). 적대 리뷰.
4. **PR** — 본문에 `Closes #<N>` 를 넣는다(머지 시 이슈 자동 닫힘 → #27 sub-issue 진행률 자동 갱신).
   PR open 후 **Codex 봇 자동리뷰를 기다려** 반영(위 「리뷰 피드백 교차검증」) → 사용자 확인 후 squash 머지.
   **ruleset 이 required check 통과 + 미해결 리뷰 스레드 resolve 를 머지 전 강제** — Codex 인라인 지적은
   반영/반박 후 스레드를 resolve(`gh api graphql … resolveReviewThread`) 해야 머지 가능.
   - **Codex 봇 운영**: 자동리뷰가 항상 즉발은 아니다(보통 7~20분; 무응답 시 `@codex review`
     코멘트로 명시 트리거, 인지하면 트리거 코멘트에 👀 리액션). **이슈가 없을 때 clean 승인은
     인라인/리뷰 없이 👍 리액션-only 가 흔하다** → `gh api repos/pdw96/fleet/issues/<pr>/reactions`
     도 확인하라(comments/reviews 만 보면 놓친다). 봇 로그인 = `chatgpt-codex-connector[bot]`
     (필터 `test("codex")`). ~4라운드 넘으면 레이트리밋 가능.
5. **머지 후 동기화** — (a) 이슈 닫힘·#27 진행률 = `Closes #N` 으로 자동. (b) **보드 Status → Done**:
   보드 내장 워크플로(Item closed→Done · Auto-add(`tier:` 라벨) · Item added→Todo · Reopened→In Progress)가
   켜져 있어 자동. 예외 보정이 필요할 때만 `gh project item-edit`
   (id 출처 = `gh project {view,field-list,item-list} 1 --owner pdw96 --format json`; `item-list` 기본 limit 30 → 큰 보드는 `--limit` 상향).
   (c) **#27 본문**: 🎯 트래커 체크 + ✅완료/changelog 이동(수동 — 분석 기록).

**새 이슈 생성 시**: `area:{provider,orchestrator,mcp,renderer,electron,devx}` + `tier:{next,later}`
(+ 필요 시 `type:{spike,meta,security}`) 라벨 부여 + #27 sub-issue 편입(`gh issue edit <N> --parent 27`,
또는 생성 시 `gh issue create … --parent 27`; gh ≥2.94 네이티브 플래그 — 구식 `gh api … /sub_issues`+DB id 불요).
**멀티-PR 트랙 의존성**(블로킹 관계 — 부모/자식 계층과 별개): 한 이슈가 다른 이슈의 선행이면
네이티브 dependency 로 인코딩한다 — `gh issue edit <N> --add-blocked-by <M>`(N 이 M 에 막힘)·
`--add-blocking <M>`(N 이 M 을 막음); 해제 `--remove-blocked-by`/`--remove-blocking`, 확인
`gh api repos/pdw96/fleet/issues/<N>/dependencies/{blocked_by,blocking}`. gh ≥2.95 네이티브
플래그(add→read→remove 라운드트립 실측 정상). GitHub 퍼블릭 프리뷰·동일 레포 한정 →
prose 「<M> 선행」 주석 대신 플랫폼 관계로 인코딩(트랙 진행 시 막힌 이슈가 보드/이슈에서 가시화).
보드 추가는 **Auto-add 워크플로가 `tier:` 라벨 매칭 시 자동**(수동 fallback: `gh project item-add 1 --owner pdw96 --url …`). 기능
이슈는 `enhancement` 유지. 차기 작업 공급원 = #27 말미 🔬 컷오프 갭 / Hermes 후보 또는 재랭킹.

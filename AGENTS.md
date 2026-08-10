# AGENTS.md — Fleet 에이전트 작업 가이드

멀티 LLM 오케스트레이션 데스크톱 앱(Electron + React + TypeScript). 구독형 CLI(claude/codex/
gemini)와 API provider(anthropic/openai/google)를 통합 `LlmSession` 뒤로 묶어 역할 기반으로
협업시킨다. 설계 전반은 [`README.md`](./README.md) · [`DESIGN.md`](./DESIGN.md) 참조.

이 파일은 코딩 에이전트(Claude Code / Codex / Gemini CLI 등) 공통 가이드다.
`CLAUDE.md`·`GEMINI.md` 는 이 파일을 가리키는 얇은 포인터다.

## 코드베이스 빠른 파악 — `brain.md` 먼저 읽기

`src/` 를 통째로 뒤지기 전에 [`brain.md`](./brain.md)(자동 생성)를 **먼저 읽어라.** 각 파일의 역할·의존(→)·
피의존(←)·IPC 배선·허브/진입점/게이트를 한 장에 압축한 구조 지도다(파일 수·배선 수는 brain.md 헤더가 권위 —
하드코딩 통계 금지). 전체 `src/` 탐색을 대체해 토큰을 아낀다. 코드 변경 후 `npm run brain` 으로 갱신(`src/` 에서
자동 추출 — drift 시 재생성). **CI(`npm run brain:check`)가 신선도를 강제**하므로 코어 변경 시 재생성·커밋 필수.
사람용 시각 그래프는 `fleet-brain.html`(`npm run brain` 산출, gitignore). 설명 문구는 `scripts/brain/descriptions.json` 에서 수정.

## 품질 게이트 (변경 후 반드시 통과)

```bash
npm run verify   # 집계 게이트 — 아래 전부를 cheapest-first 로 순차 실행. 로컬 == CI.
#   skills:lint     경로·시크릿·액션 SHA 핀·release 안전장치 스캔(무인자 자립)
#   brain:check     brain.md 가 src/ 와 동기인지(신선도)
#   format:check    prettier --check
#   typecheck       tsc --noEmit (main + renderer + shared)
#   lint            eslint (경고도 0 으로 유지)
#   test:coverage   vitest --coverage — 코어 단위/통합 + src/main/core/** 커버리지 floor(헤드리스)
#   build           electron-vite build && build:server = 데스크톱·서버 양 표면 기동 가능성 smoke
```

CI(`.github/workflows/ci.yml`)가 PR/`master` push 에서 **이 `npm run verify` 단일 명령을 강제**한다
(개별 게이트를 따로 나열하지 않아 로컬↔CI drift 가 원천 차단된다 — #175). 또한 **master ruleset
(`master protection`)이 `typecheck · lint · test · build`·`windows vitest (win32 보안 회귀)` 잡을
required status check 로 걸어, 통과 전 머지를 플랫폼 차원에서 차단한다(관례 → 강제).** 잡 표시명은
required check 이름이라 유지되며, 잡 내부 실행은 `npm run verify` 로 단일화돼 있다.
`npm run test:e2e`(playwright)는 느리고 실 디스플레이가 필요해 **PR 게이트에는 없다** — 별도
`e2e.yml` 이 수동 `workflow_dispatch` + **nightly cron(18:23 UTC = 03:23 KST)**으로 돌린다(그날 머지분
회귀를 밤새 검증). 로컬에서도 필요 시 수동 실행.

**커버리지 floor**: `test:coverage` 가 `src/main/core/**` 전역 4메트릭 floor(회귀 backstop)를 강제한다.
커버리지가 유의하게 오르면 `vitest.config.ts` 의 `coverage.thresholds` 를 수동 상향(ratchet) — `autoUpdate`
는 config 자가변경 churn 회피 위해 미사용. **Node24 smoke**: 출하 런타임(현 `electron@43` = Node 24)
회귀는 advisory `test-node24` 잡(ubuntu·node24·`npm test`)이 잡는다(required 아님 — required check
이름 보존). ⚠ 여기서 고정해야 하는 건 Electron 메이저가 아니라 **번들 Node 메이저**다 — Electron 을
올릴 때 Node 메이저가 함께 넘어가면 이 잡의 `node-version` 도 같이 올려야 한다.

## 아키텍처 규칙 (어기지 말 것)

- **코어 엔진은 Electron 비의존 순수 TS.** `src/main/core/*` 는 Node 표준 + 소수 순수 패키지만
  쓴다 → GUI 없이 vitest 로 전 계층 검증 가능. 코어에서 `electron` 을 import 하지 말 것.
- **단일 진실 원천 타입.** main·preload·renderer 가 공유하는 타입은 전부 `src/shared/types.ts`.
  여기에만 선언하고 import 한다. 런타임/DOM/Node 의존 코드를 넣지 말 것.
- **확장은 레지스트리로.** 새 CLI 는 `cli/registry.ts`, 새 API provider 는 `providers/registry.ts`
  에 등록만 한다(코어 분기문 수정 금지).
  - `CliAdapter` 는 IPC 로 직렬화되므로 **함수 필드 금지** — 데이터 필드만 둔다.
- **안전 우선.** **에이전트가 유발하는** 파일 쓰기/삭제/shell 은 `ApprovalGate` 를 통과해야 한다
  (`core/safety/`). 기본은 destructive 차단. 게이트의 소비자는 LLM 변이·툴 실행·프로세스 spawn 경로
  (`engine.ts`·`orchestrator/orchestrator.ts`·`mcp/host.ts`·`tools/loop.ts`)다.
  - **예외 = 엔진 인프라 쓰기**(엔진 자신의 상태·메타데이터). 현재 **여덟 모듈**이다 —
    `store/json-file.ts`·`workspace/ignored-baseline.ts`·`workspace/git.ts`·`workbench/coord-area.ts`·
    `workbench/active-instance.ts`·`workbench/durable-fs.ts`·`workbench/authority.ts`·
    `workbench/journal.ts`. 소비 지점이 **부팅·태스크 준비·CAS 임계 구역**이라 승인자가 존재하지 않는다
    (§W-3 L-5 와도 방향이 충돌한다). 예외를 새로 만들 때는 **파일 머리 영역**(첫 top-level `export`
    이전)의 블록 주석에 「`ApprovalGate` 를 거치지 않는 이유」 `##` **절로 근거를 명시**하고,
    destructive 조작은 게이트가 아니라 **대상 고정·소유 확인·create-only 경합**으로 막는다.
    (이 구분을 문면에 두지 않아 리뷰에서 반복 지적된 항목 — ADR-0013.)
    이 열거는 산문이 아니라 **계약**이다. 강제는 **eslint 가 구조로, 테스트가 대조로** 나눠 한다:
    - **`eslint.config.mjs` 의 `CORE_FS_ALLOWLIST`** 밖에서는 `src/main/core/**`(빌드가 컴파일·번들하는
      확장자 전부 — `.ts`·`.tsx`·`.mts`·`.cts`·`.js`·`.jsx`·`.mjs`·`.cjs`)가 fs 를
      **어떤 형태로도 얻을 수 없다** — 정적 import·동적 import·비-리터럴 동적 import·`require`·
      `createRequire`·`process.getBuiltinModule`. 즉 fs 를 만지려면 반드시 이름을 올려야 하고, 그
      편집이 리뷰 지점이다.
    - allowlist 는 **읽기 전용 / 변이** 두 티어로 나눠 적고, **읽기 전용 티어는 라벨이 아니라 집행**
      이다 — fs 변형 메서드 호출·구조분해·computed 접근·**별칭 import**(`{ writeFileSync as w }`)를
      전부 막는다. 변형이 필요해지면 변이 티어로 옮기고 이 문단·근거 절을 함께 고쳐야 한다.
    - **재-export 는 allowlist 안에서도 금지**한다. 소스 있는 형태(`export … from 'node:fs'`)는 코어
      전역에서, 소스 **없는** 형태(`export { x }`)와 기본 내보내기는 allowlist 티어에서 **형태 자체로**
      막는다 — 「내보내는 이름이 변형 API 인가」로 판정하면 `export { readFileSync }` 가 통과해 소비자가
      fs 지정자 없이 임의 경로를 읽고 대조 스캔에도 안 잡힌다. 자기 API 는 선언 인라인 `export` 로
      내보낸다(현재 코어 전역 사용 0). 의도적 seam 은 `durable-fs` 처럼 **지정자로 추적 가능한
      모듈**로 만들고 테스트의 seam 판정에 등재한다.
    - **`scripts/approval-gate-exceptions.test.ts`** 가 대조한다: ①allowlist == 실제 fs 소비자(목록
      staleness 차단) ②**변이 티어 ∪ 하위프로세스 변이 티어 ∪ `DurableFs` 소비자 == 위 열거**
      ③열거 == 근거 절 보유 모듈(양방향) ④근거 절이 소비자 모듈을 삼키지 않는 형태인지
      ⑤eslint 게이트 블록의 존재.

    왜 「변이 API 이름을 탐지」하지 않는가 — 그 접근은 Codex 리뷰 5라운드 내내 새 회피 형태를 계속
    냈다(promise 형·`{ promises as fs }`·`fs.promises.x`·bare 지정자·동적 import·FileHandle·
    re-export 체인·네임스페이스 구조분해). 동적 언어에서 그 꼬리는 끝나지 않는다. **import 경계는
    유한하므로 거기서 막는다**(#282).
    ⚠ 이 계약은 fs API 경유 변이만 다룬다 — **자식 프로세스를 통한 변이**(git 하위 명령의 워크트리
    생성·삭제 등)는 import 경계 밖이고, spawn 은 위 「게이트의 소비자」 절이 다루는 별개 계약이다.
    그래서 `workspace/git.ts` 는 **fs 로는 읽기 전용 티어**에 두고(변이 티어에 두면 읽기 전용 집행을
    못 받아, 훗날 직접 `writeFileSync` 가 들어와도 lint·대조가 **무신호**다) 「게이트 없는 변이」라는
    지위는 `CORE_SUBPROCESS_MUTATING` 이 따로 들고 있는다 — 위 ②의 세 번째 항이 그것이다.
    ⚠ 열거에 있다는 건 **「게이트 밖」이라는 사실의 기록이지 「안전하다」는 보증이 아니다.** 규칙을
    완전히 충족하지 못하는 예외가 생기면 근거 절에 **미충족을 명시**해 리뷰 가능하게 두고 추적
    이슈를 단다(선례: `workspace/git.ts` 의 `index.lock` 강제 삭제는 소유 확인이 불가능해 PR#282
    에서 **삭제 자체를 제거**했다 — 소유 기반 자동 회수 복원은 #285).
- **provider 계약.** `ApiProvider.chat()` 는 구조화된 `ChatResult`(text·toolCalls·finishReason·
  usage)를 반환한다. `LlmSession.send()` 는 하위호환을 위해 여전히 `string` 을 반환한다.

## 함정 (CI/타입으로 안 잡히는 것)

- **preload/IPC 변경 후 `npm run dev` 재시작 필수.** electron-vite 는 preload 를 핫리로드하지
  않는다. 재시작 안 하면 `window.fleet` 의 새 메서드가 `undefined` → 클릭 시 검은 화면.
  (`src/preload/index.ts` · `src/shared/types.ts` 의 `FleetBridge` 동시 변경 시 특히 주의.)
- **E2E 활성화는 `FLEET_E2E === '1'` 일 때만.** (`isE2EActive` — `src/main/e2e.ts`, 단위 테스트로 핀)
  `0`/`false`/빈 값은 프로덕션 경로. 이 가드를 느슨하게 바꾸면 페이크 러너(영구 in-flight)·E2E
  픽스처가 프로덕션 런치로 샌다.
- **Windows 툴링 경로/인코딩.** Bash 도구는 Git Bash(MSYS) — `/tmp` 가
  `C:\Users\…\AppData\Local\Temp` 로 매핑되지만 **네이티브 Python/도구는 `/tmp` 를 `C:\tmp`
  (드라이브 루트)로 해석한다.** Git Bash 로 만든 파일을 네이티브 도구(예: 시스템 `python`)에
  넘길 땐 `/tmp` 대신 **절대 Windows 경로나 stdin 파이프**를 써라. 네이티브 Python 의 한글/
  이모지 입출력은 기본 cp949 라 깨짐 → `PYTHONUTF8=1`.
- **engine-strict floor 정직성.** `.npmrc` 의 `engine-strict=true` 때문에 선언한 `engines.node` 가
  의존성 트리의 *실제* 바닥과 어긋나면 `npm ci` 가 EBADENGINE 로 하드 실패한다(transitive 까지 강제).
  **이 정합은 이제 `verify` 가 강제한다** — `scripts/engines-floor.test.ts` 가 락파일의 전
  `engines.node` 선언을 구간으로 접어 **실제 범위 교집합**을 계산하고, 선언과의 차집합을 양방향으로
  낸다: **과대선언**(선언은 허용하는데 트리가 거부 = EBADENGINE 예정) · **과소선언**(트리는 허용하는데
  선언이 배제) · **락파일 루트 미러 드리프트**. 판정은 점 표본이 아니라 구간 대수라 구간 내부·상단에서
  새로 거부하는 패키지도 잡는다. 결정 근거·감수 비용 = ADR-0016.
  - **결정자·차순위 패키지 열거는 이 문서에 적지 않는다.** 의존성 범프마다 바뀌는 값이라 산문에 두면
    반드시 낡고, 실제로 하루 안에 두 번 낡았다(#280 이 동기화한 지 20분 만에 #279 가 무효화 → #281).
    지금 값이 필요하면 **`node scripts/engines-floor.mjs`** 를 돌려라 — 교집합·결정자·판정을 그 자리에서
    낸다. (결정자는 leave-one-out 정의라 **서로 다른 두 선언이 같은 경계를 강제하면 둘 다 안 잡힌다** —
    목록이 비어도 「제약이 없다」가 아니라 「단독 책임자가 없다」는 뜻이다.)
  - 반면 **스코프 규칙 둘은 안정적이라 여기 남긴다**: **`--omit=dev` 로도 dev 의존의 engines 는 회피되지
    않는다**(Arborist 가 ideal tree 에서 engines 를 먼저 검사하고 omit 은 그 뒤 디스크 반영 단계라, dev
    전용 패키지의 불만족도 그대로 EBADENGINE 이다 — 실측). 반면 **optional 은 검사에서 빠진다**
    (불만족이어도 설치 성공). 그래서 교집합 대상에서 optional 만 제외하고 dev 는 포함한다.
  - floor 가 올라가면 **최신 메이저를 다운그레이드해 회피하지 말고 정직하게 상향**하라(핀된 `.nvmrc`/CI
    엔 무영향). 게이트 실패 메시지가 붙여넣을 범위를 그대로 주며, 반영 후 락파일 루트 미러는
    `npm install --package-lock-only` 로 동기화한다(권위는 `package.json`, 락은 미러일 뿐이다).
  - 의도적으로 교집합보다 **좁게** 선언하려면 게이트가 과소선언으로 막는다 — 계약 자체를 고쳐야 하며
    조용히 어긋난 채 두지 말 것(ADR-0016 이 그 긴장을 기록한다).

## 컨벤션

- 주석/식별자 설명은 한국어. 기존 코드의 주석 밀도·네이밍·관용구를 따른다.
- 새 기능/버그픽스는 TDD: 코어 변경엔 `*.test.ts`(vitest) 동반.
- 커밋은 특성 브랜치에 작게. push/merge/배포 전에는 사용자 확인.
- **리뷰 피드백 교차검증.** PR 리뷰 코멘트(Codex 봇 등)를 반영할 때, 라이브러리·API·SDK·CLI·모델
  관련 지적은 에이전트 학습 컷오프 지식에만 의존하지 말고 **context7 MCP 로 현행 문서를 받아
  교차검증**한 뒤 수용/반박한다(컷오프 이후 변경 가능 — 착수 전 model-capability 검증 규율의 연장).

## Codex 리뷰 운영 기준

Codex 봇은 Fleet 에서 **스타일 리뷰어가 아니라 P0/P1 고위험 회귀를 잡는 senior reviewer** 로
운용한다. CI 집계 게이트(`npm run verify` — typecheck·lint·test·build·format·skills:lint·brain)와 본
가이드가 이미 막는 영역(포맷·자명한 타입)은 Codex 의 몫이 아니다 — **CI·타입이 못 잡는** 아키텍처/계약/안전 회귀에 집중시킨다.

- **운영 모드.** Codex GitHub integration 의 *Code review + Automatic reviews* 를 기본으로 켜
  PR open/ready 시 `@codex review` 없이 자동 리뷰를 받는다. 수동 `@codex review` 코멘트는
  **자동 리뷰 지연·무응답 시 fallback** 으로만 유지(cadence·👍 clean 감지는 아래 「백로그 착수 절차」
  4단계 「Codex 봇 운영」 참조).
- **required check 화(현재 미도입·보류).** Automatic reviews 자체는 머지 게이트가 아니다. Codex 를 머지
  차단 **required status check** 로 강제하려면 Automatic reviews 가 아니라 별도 GitHub Actions
  워크플로에 `openai/codex-action@v1` job 을 만들고, `master protection` ruleset 에 그 **job 표시명**
  (잡 id 아님 — skip 시 영구 pending 함정)을 required check 로 등록한다. **단 공식 `openai/codex-action@v1`
  경로는 OpenAI/provider API 키 기반**이며 GitHub integration(ChatGPT) 인증을 직접 받지 못한다(액션
  issue #92 = 그 기능 요청). ChatGPT 인증으로 CI 를 돌리는 **공식 경로 자체는 있으나 제약적**이다 —
  `CODEX_ACCESS_TOKEN`+`codex exec` 는 **Business/Enterprise 전용**, ChatGPT-managed `auth.json` 유지는
  **trusted private runner 한정 advanced**(직렬화 필수·GitHub-hosted 러너 부적합)이며 OpenAI 가
  *"automation 인증은 API 키가 정답"*이라 명시한다. 또 클라우드 리뷰 봇은 commit status/check run 을 안
  낸다(코멘트+👍만). 즉 솔로 Plus-플랜+hosted 러너엔 깔끔한 구독-only 게이트 경로가 없어, 자체 `codex exec`
  job(API 키 권장) 또는 서드파티 wrapper 뿐이다. ROI·중복·비결정성 리스크로 **현재 보류**(2026-06-23
  Codex↔Claude 1차출처 토론 합의 · #98). 협업자 합류/1.0 근처 재검토.
- **CodeRabbit 보조 리뷰(advisory·비-required).** `coderabbitai[bot]` 가 활성이다 — PR 당 Codex +
  CodeRabbit 2봇 리뷰. **required 게이트 아님**(Codex=P0/P1 senior, CodeRabbit=스타일·incremental 보조).
  인라인 스레드 resolve 는 ruleset(미해결 스레드 0)이 강제하나 CodeRabbit 자체는 머지를 차단하지 않는다.
  **fix 푸시마다 재리뷰로 새 스레드가 추가될 수 있어 매 푸시 후 unresolved 재확인.** 채택 근거 = ADR-0006(#98).
- **자가(로컬) 적대 리뷰 계층화(토큰 효율).** 자가리뷰(fleet-pr-review 스킬)는 봇과 렌즈가 겹치지
  않게 계층화한다 — 양봇이 리뷰할 일반 PR 은 **봇 공백 렌즈**(프레임 전복·성능 정량·커버리지·동적
  검증 — Codex 502건 실측 분류의 공백 축)만 기본 가동하고, 위 P1 신호(계약·보안) 접점 또는 Codex
  미가용 대체 시에만 풀 렌즈로 확장한다. **축소 적용의 전제 = 머지 전 Codex 리뷰 완료(리뷰 또는
  👍 clean) 확인** — Codex 는 required check 가 아니므로(ADR-0001), 무응답 fallback 으로 머지하려면
  P1 신호 렌즈를 포함한 풀 렌즈 자가리뷰가 선행되어야 한다. find 규모는 diff 크기·위험도에 연동
  (소형은 렌즈 3~4로 충분 — C3/C5 선례), **refute(verify) 규율은 축소 금지**(오탐 제거 실효 실증).
  서브에이전트 fan-out 은 기계적 단계(스윕·수집·나열)를 하위 effort/모델로 디스패치하고 판정 단계
  (refute·judge·합성)만 세션 티어를 유지한다. 근거 실측 = 자가리뷰 19~22 에이전트가 확정 0~5건
  (P3 위주)이던 반면 렌즈 3~4 구성이 동등 수확. 채택 근거·대안 기각 = ADR-0014.

**Fleet 특화 P1 신호** — Codex 가 우선 잡아야 할 고위험 회귀(CI 가 통과시켜도 P1 로 본다). 각 항목은
위 「아키텍처 규칙」·「함정」의 계약을 런타임/타입이 못 잡는 지점에서 보강한다:

- **코어 Electron/DOM 의존성 유입** — `src/main/core/*` 에 `electron`/DOM import(순수 TS 계약 위반).
- **`ApprovalGate` 우회** — **에이전트가 유발하는** 파일 쓰기/삭제/shell 이 게이트를 거치지 않는 경로
  (`core/safety/`). 엔진 인프라 쓰기는 명시 예외다(위 「아키텍처 규칙」의 예외 절 — 근거를 모듈 상단에
  적지 않은 새 예외는 여전히 P1).
- **IPC / `FleetBridge` drift** — `preload/index.ts` ↔ `shared/types.ts` 의 브리지·타입 불일치.
- **provider / session 계약 위반** — `ApiProvider.chat()` 의 `ChatResult` 구조·`LlmSession` 하위호환 깨짐.
- **`FLEET_E2E` 가드 완화** — E2E 픽스처·페이크 러너가 프로덕션 경로로 새는 변경.
- **engine / lockfile 게이트 후퇴** — `engines.node` floor ↔ 의존성 실제 바닥 정합은 `verify`
  (`scripts/engines-floor.test.ts`)가 이미 강제한다(ADR-0016). 따라서 P1 은 드리프트 자체가 아니라
  **그 게이트를 무르게 만드는 변경**이다 — 제약 스코프에서 dev 를 빼거나, 판정을 한 방향만 보게
  바꾸거나, 파싱 실패를 throw 대신 무시로 돌리는 것.
- **release / update 안전장치 약화** — 서명·attestation·`latest.yml` sha512 무결성·updater 채널 가드 후퇴.

## 백로그 착수 절차 (이슈 #27 기반)

"이슈 #27 확인하고 작업 진행" 류 지시를 받으면 아래 루프를 따른다. 백로그는 4중으로 조직돼 있다:
**#27**(메타 트래커 — 랭킹·근거·refute 이력) · **sub-issue 계층**(#27 의 자식 이슈) · **라벨**
(`area:*`/`tier:*`/`type:*`) · **Projects 보드**(«Fleet 백로그» = `https://github.com/users/pdw96/projects/1`,
project number `1`, owner `pdw96`).

> 이 절차·재랭킹·갭감사·리뷰는 `.claude/skills/`(fleet-backlog-induction·fleet-backlog-rerank·
> fleet-cutoff-gap-audit·fleet-pr-review·fleet-plan-panel)에 재사용 스킬로도 정착돼 있다(이슈 #135). 산문은 이 절이 권위, 스킬은 실행 래퍼.

1. **선정** — `gh issue view 27 --repo pdw96/fleet` 로 본문 «🎯 착수 sub-issues» 트래커를 확인하고
   `tier:next` 최상위를 집는다(나열 순서 = 권장 착수순; 후보가 비었거나 모호하면 사용자에게 확인).
   `gh issue list --repo pdw96/fleet --label tier:next` 로도 필터 가능.
2. **브랜치** — 기본 브랜치(현재 `master`) 직접 작업 금지(**ruleset 이 직접 push·force-push·삭제를
   플랫폼 차단**; 비상시 repo admin bypass). `feat/<slug>` 특성 브랜치 생성.
3. **사이클** — 비자명하면 브레인스토밍 → 스펙(`docs/superpowers/specs/`) → 계획(중형+ 계획은
   fleet-plan-panel 판사 패널). TDD(RED→GREEN).
   `npm run verify` green(위 「품질 게이트」 참조; preload 변경 시 dev 재시작). 적대 리뷰.
4. **PR** — 본문에 `Closes #<N>` 를 넣는다(머지 시 이슈 자동 닫힘 → #27 sub-issue 진행률 자동 갱신).
   단 **`type:meta`/멀티-phase 트래커는 비최종 phase PR 에 `Part of #<N>` 를 써 메타의 조기 종료를 막고**
   (#135 가 PR #136 의 `Closes #135` 로 Phase 1 만에 `COMPLETED` 종료된 선례 — 트랙 #140), **최종 phase
   PR 만 `Closes #<N>`** 로 닫는다.
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

### 결정 기록 (ADR)

지속·교차 운영 결정(설계 선택·정책·refute — **대안이 있던 갈림길**)은 `docs/adr/` 에서 **ADR 작성/갱신**
한다(`docs/adr/TEMPLATE.md` 복사·`README.md` 인덱스 1줄 추가). 루틴 재랭킹 verdict 과 자명한(대안 없던)
결정은 제외 — 전자는 #27, 후자는 ADR 감이 아니다. 이 절이 ADR 트리거의 단일 권위(스킬은 참조만).
부기 시크릿/경로 스캔은 `skills:lint` 강제, 구조 정합은 사람 눈(ADR-0004 가 자동화 보류 기록 — 트랙 #140).

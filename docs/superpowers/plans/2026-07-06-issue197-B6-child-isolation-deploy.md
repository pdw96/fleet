# B6 구현 계획 — 자식 env 격리 + 컨테이너 배포 (#197 Phase B 최종 · #212)

> **수립 방식**: fleet-plan-panel 판사 패널 — fleet-planner ×3(리스크/MVP/계약 각도) 독립 초안 →
> fleet-plan-judge ×2(공백 그룹/Codex 강점 그룹 렌즈) 채점 → 메인 루프 합성.
> **승자**: `risk-first`(두 판사 만장일치 — 공백 그룹 79 / Codex 강점 그룹 89, 각 그룹 최고점).
> 승자 골격에 계약우선·MVP우선 초안의 검증된 아이디어를 이식하고, 두 판사가 공통 지목한 결함 4종을 보강했다.

## 판사 채점 요약

| 각도 | 공백 그룹(judge B) | Codex 강점 그룹(judge A) | 판정 |
|---|---|---|---|
| **risk-first** | **79** | **89** | ✅ 승자(양 그룹 최고) — 보안 퍼징 최강·형제 누출 실경로 포착·enterprise env 구체 명명·exp fail-closed 4종 이중방어 |
| contract-first | 72 | 88 | 준우승 — 계약 고정 표·race 위생(requiredClaims·unref·clock 분리) 최정교·고유발견 2건(probe 비대칭·requiredClaims). 단 형제 누출 Grep-스윕 false-negative |
| mvp-first | 73 | 86 | ripple 표·boot 3태스크 직렬 커밋·T7 정직 프레이밍이 강점. enterprise env 구체성·계약 강제 장치는 약함 |

**승자 근거**: B6 은 본질이 시크릿 격리(보안 경계)다. 이 축에서 risk-first 가 형제 누출(verify/git)을 유일하게 실경로로
포착했고 — 이는 Codex 강점(ripple 완전성)이 잡을 잠재 P1 인데 스펙의 4주입점 스코프가 놓친 것 — enterprise/proxy 변수를
구체 명명+출처까지 제시했다. contract-first 의 계약/race 골격은 대거 이식한다.

## 이식 목록 (비승자 → 승자 골격)

- **[contract-first→T6]** `jwtVerify` 옵션에 `requiredClaims: ['exp']` 추가 — context7(`/panva/jose`) 교차검증: jose 는
  issuer/audience/subject 설정에도 exp 를 기본 강제 안 함. 수동 `typeof`/`Number.isFinite` 체크에 더해 requiredClaims 로
  exp 부재를 jose 단계에서 `JWTClaimValidationFailed`→classify→401 로 먼저 차단(관용적·이중방어).
- **[contract-first→T6]** default clock `setTimeout` 에 `t.unref?.()` + `SocketExpiryClock` 인터페이스가 `{ clear() }` 핸들 반환
  (raw 핸들보다 깨끗·이벤트루프 잔류 방지).
- **[contract-first→고유]** probe 비대칭 결정 반영: `probe.ts:38` PROBE_PROMPT='Reply with: ok'(실 모델 왕복)이라
  base-only env 에서 **API-키 인증 CLI 는 probe 만 auth 실패**·실세션(base+provider)은 성공. 구독-OAuth(cli-auth 볼륨)
  주 경로는 무영향. → 스펙 결정으로 명시(§검증요청)·README 오탐 문서화.
- **[mvp-first→T6]** `delay <= 0`(attach 시점 만료) 체크를 `wsHost.attach`(boot.ts:315) **호출 이전** 배치 —
  presence/rejectAll 오염 회피. jose 실clock ⟂ boot 주입 clock 분리로 attach-만료 테스트 결정론화.
- **[mvp-first→순서]** boot.ts 3태스크(T5→T6→T7) 직렬 커밋 강제 — 같은 파일 머지충돌·brain 재생성 순서 보호.
- **[mvp/contract→T7]** T7 testability 정직 프레이밍 — boot 은 엔진 runner 미노출이므로 `buildServerChildEnv` 단위핀 +
  typecheck 강제 import 로 정책 고정, 권위 증명은 T3 실spawn·T10 스모크·라이브 5종에 위임.
- **[contract/mvp→T6]** exp 비유한수 테스트 현실화 — 'exp 부재→401'(typeof 체크)이 권위 케이스. NaN/Infinity 는 실 서명
  JWT 로 구성 불가(JSON 에 미표현)라 **부재 케이스로 대표**(구성 불가 RED 과다명세 제거).
- **[contract-first→구조]** win32 `Path`/`PATH` 대소문자 allowlist 경계 + `LCD_FAKE`/`LC_SECRET` 음성 테스트(LC_ 접두 오매칭 방지).
- **[mvp/contract→T3]** runner 사용처 카테고리 매핑 표(위치·현행·변경·카테고리) — 산문 ripple 을 감사 가능한 표로.

## 공통 결함 보강 (두 판사 공통 지목 — 합성에서 해소)

1. **✅ allowlist 실 내용물 확정(load-bearing 픽스처)** — 3초안 모두 런타임/라이브에 미룸. **본 계획이 context7 로 CLI 3종
   실 env 를 권위 확정**(§allowlist). enterprise/proxy/OAuth-토큰 변수를 named 후보로 편입.
2. **✅ verify/git 형제 — 서버 시크릿 env 격리 완결** — 3초안 모두 열어둠(risk/mvp=flag·contract=미탐지). 실측 확정:
   `verify/run.ts:45`·`git.ts:64` 가 프로덕션 서버모드에서 `FLEET_SECRET_KEY`·`FLEET_ACCESS_*` 상속. **T3 를 "엔진이 spawn
   하는 전 자식"으로 확장**해 base env(FLEET_* 제거) 적용 → 서버 시크릿 env 미전달 완결. **단 cli-auth 자격파일 exfil 은
   env 로 안 닫힘**(Codex 계획-R P1 — 같은 uid·`HOME` 공유이므로 파일 격리 = Phase C · §스코프 결정).
3. **✅ exp 타이머 생애주기 위생** — unref + '서버 close 시 live 소켓 exp 타이머 미잔류' 테스트 추가(T6).
4. **✅ exp setTimeout max-delay 오버플로** — Cloudflare Access 세션은 Node `TIMEOUT_MAX`(2147483647ms≈24.8일)를
   넘을 수 있고, 초과 시 setTimeout 즉시 발화 → 접속 직후 close → 재접속 루프. **clamp + re-arm** 으로 해소(T6).
   (동일-exp 다수 소켓 동시발화=thundering herd 와 lazy-체크 하이브리드는 **Phase C** 잔여로 문서화.)

---

## 머리말 — 각도·전제·의존 순서

**각도(리스크 우선)**: 보안 경계·fail-closed·회귀 위험을 최우선 정렬. 각 태스크는 (a) 위협을 고정하는
**가드/특성화 테스트(RED)** 를 먼저 쓰고 (b) 최소 GREEN. 태스크당 GREEN 커밋 1개. TDD RED→GREEN.

**핵심 리스크 순위**:
1. 신종 시크릿 누출(denylist-아님 위반) — allowlist 원칙 코드 강제 실패 시 미래 `FLEET_*`/임의 시크릿이 샌다.
2. 데스크톱 무회귀 파손 — `childEnv` 미주입 경로가 현행 상속을 잃으면 데스크톱 CLI 가 조용히 깨진다(특성화 핀이 감지).
3. verifier exp fail-open — 부재/비유한수/attach시점만료/이중close/오버플로 우회.
4. **형제 경로 서버-시크릿 상속(verify·git)** — 실측 확정된 FLEET_* env 상속(스펙 4주입점 밖 — 본 계획이 서버 env 시크릿 격리).
5. 컨테이너 시크릿·특권 검증 신뢰성 — 스모크가 실제로 위반을 감지하는가(false-GREEN 금지).

**전제(실측)**:
- 코어 순수성: `src/main/core/**` 는 `electron`/`src/server/**` import 금지(AGENTS.md). → **allowlist 필터는
  `src/server/child-env.ts`(server 층), 엔진은 구조적 인라인 타입 객체만 주입**(server 모듈 import 없음). 스펙 이슈 A 해소.
- `defaultRunner`(`detect.ts:58`)의 spawn(`detect.ts:111`) `env` 옵션 부재 = `process.env` 전량 상속.
  `defaultSpawn`(`stdio.ts:10-13`) `env: { ...process.env, ...spec.env }`.
- **형제 누출 실측 2건**: `verify/run.ts:37-45` `defaultVerifyRunner`→`defaultRunner(…{timeoutMs,cwd,signal})`(상속) ·
  `workspace/git.ts:62-64` `defaultGitRunner`→`defaultRunner('git',…{timeoutMs,cwd,signal})`(상속). 엔진 주입점
  `FleetEngineOptions.verifyRunner?`(engine.ts:100)·`gitRunner?`(:102) — boot 미주입 → 프로덕션 서버모드에서 상속.
- 순수성 게이트: `src/server/**`·`src/shared/transport/**`(B3 확립, `scripts/eslint-config-purity.test.ts` 핀).
- 커밋 prefix `feat(#197-B6):` · 브랜치 `feat/197-b6-child-isolation-deploy`(생성됨) · brain 재생성 = 전 src 변경 후 T12 1회.
- 컨테이너 주 인증 = **cli-auth 볼륨**(구독 OAuth 자격파일 = `~/.claude`·`~/.codex`·`~/.gemini`, env 아님) → base 의
  `HOME` allowlist 로 커버. provider env 는 API-키·enterprise 모드용 보조 경로.

**의존 순서**:
```
T1(RunOpts.env 특성화 핀) ─┐
T2(child-env.ts allowlist) ─┼─→ T3(엔진 childEnv + 전 자식 스레딩[CLI·detect/probe·verify·git] + 실spawn통합)
                            └─→ T4(MCP stdio base 교체)      [T3↔T4 형제, 둘 다 T1·T2 의존]
T5(fleet-data 0700) → T6(소켓 exp 종료) → T7(boot 통합 배선)  [boot.ts 직렬 커밋 — 머지충돌·brain 순서 보호]
T8(fleet Dockerfile) → T9(compose fleet+ingress) → T10(smoke+브라우저 스모크)
T11(단일 인스턴스 문서·ADR)   [T9 이후]
T12(brain 재생성·verify·e2e 무회귀)  [최종 1회]
```
병렬 착수 가능: {T1, T2, T5}. T3·T4 는 T1·T2 후. T6 는 T5 후(같은 boot.ts). T7 은 T3·T4·T6 후.

---

## Allowlist — context7 권위 확정 (T2 load-bearing 픽스처)

> denylist·와일드카드 **금지**. 여기에 named 키를 추가하는 것만이 자식 env 확장 경로다(신종 시크릿 기본 차단).
> `FLEET_*` 는 allowlist 부재로 **자동 전면 배제**. `NODE_OPTIONS` **의도적 배제**(preload RCE 벡터 #167 — 명시 핀).

**RUNTIME_BASE_ALLOWLIST** (전 자식 공통 = detect/probe·MCP stdio·verify·git·CLI 세션의 기반):
- 코어: `PATH` · `HOME` · `USER` · `LOGNAME` · `SHELL`
- 임시: `TMPDIR` · `TEMP` · `TMP`
- 로케일: `LANG` · `LANGUAGE` · `LC_*`(접두 매칭) · `TERM` · `TZ` · `COLORTERM`
- XDG(gemini/codex config 위치): `XDG_CONFIG_HOME` · `XDG_CACHE_HOME` · `XDG_DATA_HOME` · `XDG_STATE_HOME`
- 프록시(대/소문자 변형): `HTTP_PROXY`/`http_proxy` · `HTTPS_PROXY`/`https_proxy` · `NO_PROXY`/`no_proxy` · `ALL_PROXY`/`all_proxy`
- win32 이식: `USERPROFILE` · `APPDATA` · `LOCALAPPDATA` · `SystemRoot` · `SystemDrive` · `windir` · `ComSpec` ·
  `PATHEXT` · `NUMBER_OF_PROCESSORS` · `PROCESSOR_ARCHITECTURE`

**CLI_SESSION_PROVIDER_ALLOWLIST** (CLI 세션 실행 전용 = base + 아래. detect/probe·MCP·verify·git 엔 **미부여**):
- Anthropic(context7 `/websites/code_claude`): `ANTHROPIC_API_KEY` · `ANTHROPIC_AUTH_TOKEN`(게이트웨이) ·
  `ANTHROPIC_BASE_URL`(게이트웨이/프록시 base) · `CLAUDE_CODE_OAUTH_TOKEN`(비대화형 구독)
- OpenAI/Codex: `OPENAI_API_KEY` · `OPENAI_BASE_URL`
- Google/Gemini(context7 `/google-gemini/gemini-cli`): `GEMINI_API_KEY` · `GOOGLE_API_KEY`(Vertex) ·
  `GOOGLE_APPLICATION_CREDENTIALS`(서비스계정 JSON 경로) · `GOOGLE_CLOUD_PROJECT` · `GOOGLE_CLOUD_LOCATION` ·
  `GOOGLE_GENAI_USE_VERTEXAI`

> 근거: [Claude Code env vars](https://code.claude.com/docs/en/env-vars)·[LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect) ·
> [Gemini CLI authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx).
> 이 목록은 provider **자격/구성** env 이며 **서버 시크릿이 아니다**(사용자가 CLI 에 주려는 값) — CLI 세션 경로에만 전달하고
> MCP(임의 사용자 프로세스)·detect/probe·verify/git 엔 부여하지 않는 것이 격리의 요체.

---

## T1 — `RunOpts.env` 추가 + defaultRunner 전달 (특성화 핀: 미지정=상속)

**리스크**: 오배선 시 데스크톱·전 테스트가 상속을 잃어 CLI 가 조용히 깨진다. **상속 불변식을 가장 먼저 핀.**

**(a) RED** — `src/main/core/cli/detect.test.ts` `describe('defaultRunner env 전달(#197-B6 T1)')`:
- **핀①(미지정=상속)**: 실행 전 `process.env.FLEET_T1_MARKER='inherited'` → `defaultRunner(process.execPath, ['-e',
  'process.stdout.write(process.env.FLEET_T1_MARKER ?? "MISSING")'], { timeoutMs: 5000 })` → stdout==='inherited'.
- **핀②(지정=완전 대체)**: `{ timeoutMs, env: { PATH: process.env.PATH, FLEET_T1_MARKER: 'override' } }` → stdout==='override';
  부모에만 있는 var 는 자식에서 'MISSING'(병합 아님 = 완전 대체 의미론 핀).
- win32/POSIX 공통(실 `process.execPath`).

**(b) GREEN** — `src/main/core/cli/detect.ts`:
- `RunOpts`(`:17`) 에 `env?: NodeJS.ProcessEnv`(JSDoc: "미지정=현행 process.env 상속. 서버 격리 시 childEnv 주입").
- spawn(`:111`)을 `spawn(resolved, args, { windowsHide: true, cwd, ...(opts.env ? { env: opts.env } : {}) })` —
  **조건부 스프레드**(`env: undefined` 직접 전달 금지 · cross-spawn quirk 배제 · 미지정 경로 옵션 객체 이전과 정확 동일).

**(c) 회귀/특성화 핀**: `env` optional → 전 호출부 무변경 컴파일. 미지정 경로 spawn 옵션 이전과 동일.

**(d) 함정**: `NodeJS.ProcessEnv` 완전 대체(부분 병합 아님). `timeoutMs` 필수라 테스트마다 지정.
**ripple**: RunOpts 변경 → `defaultRunner` 만 실 소비 → 테스트 더블(주입 CommandRunner)은 opts 읽기만 → 무회귀.

---

## T2 — `src/server/child-env.ts` 2단 allowlist (denylist-아님 코드 강제)

**리스크(최상위)**: 신종 시크릿 기본 차단을 여기서 강제. allowlist 이므로 "명시 추가 안 하면 차단". 테스트로 못박음.

**(a) RED** — `src/server/child-env.test.ts` `describe('자식 env 2단 allowlist(#197-B6 T2)')`, 주입 source 로 순수 검증:
- **base 시크릿 배제**: source 에 `FLEET_SECRET_KEY`·`FLEET_ACCESS_AUD`·`FLEET_ACCESS_TEAM_DOMAIN`·`FLEET_PUBLIC_ORIGIN`·
  `FLEET_HOST`·`FLEET_PORT`·`FLEET_DATA_DIR`·`FLEET_WORKSPACE_ROOT`·`FLEET_STATIC_DIR`·`FLEET_E2E`·`PATH`·`HOME` →
  `runtimeBaseEnv(source)` 에 `FLEET_*` **전부 부재**·`PATH`/`HOME` 존재.
- **denylist-아님 핀(신종 시크릿)**: `SOME_SECRET`·`AWS_SECRET_ACCESS_KEY`·`GITHUB_TOKEN` → base·CLI 결과 **전부 부재**.
- **base 에 provider 키 부재**: `ANTHROPIC_API_KEY`·`OPENAI_API_KEY`·`GEMINI_API_KEY`·`GOOGLE_API_KEY` →
  `runtimeBaseEnv` 결과 **4종 부재**(MCP·detect/probe·verify/git 로 안 감).
- **CLI 세션 = base + provider 전체**: `cliSessionEnv(source)` 에 §allowlist 의 provider 12키(`ANTHROPIC_AUTH_TOKEN`·
  `ANTHROPIC_BASE_URL`·`CLAUDE_CODE_OAUTH_TOKEN`·`OPENAI_BASE_URL`·`GOOGLE_APPLICATION_CREDENTIALS`·`GOOGLE_CLOUD_PROJECT`·
  `GOOGLE_CLOUD_LOCATION`·`GOOGLE_GENAI_USE_VERTEXAI` 포함) **전부 존재** + base 전부 + `FLEET_*`·신종 시크릿 여전히 부재.
- **proxy·XDG·win32 이식 base 통과**: `HTTP_PROXY`/`http_proxy`·`NO_PROXY`·`XDG_CONFIG_HOME`·`TMPDIR`/`TEMP`/`TMP`·
  `LANG`/`LC_ALL`/`LC_CTYPE`·`TERM`·`TZ`·`SHELL`·`USER`·win32 `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`SystemRoot`/
  `ComSpec`/`PATHEXT` → base 통과.
- **NODE_OPTIONS 의도적 배제 핀**: `NODE_OPTIONS:'--require /evil'` → base·CLI **부재**(#167 회귀 가드).
- **LC_ 접두 음성 테스트**: `LC_ALL`·`LC_CTYPE` 통과하되 `LCD_FAKE`(가짜)·`LC_SECRET`(가상)의 오매칭 여부를 명시 —
  접두 매칭은 `LC_` **정확 접두**(`LC_` 로 시작 + 다음 문자 존재)만. `LCD_*` 는 배제(정확 접두 아님).
- **undefined 값 미주입**: allowlist 키라도 source 값이 `undefined` 면 결과 제외.
- **win32 대소문자**: source `Path`(win 표기) → allowlist `PATH` 매칭(대소문자 무시 비교)·결과 키는 원형 보존.

**(b) GREEN** — `src/server/child-env.ts`(신규):
```ts
export const RUNTIME_BASE_ALLOWLIST: readonly string[]         // §allowlist base(정확 키) + LC_ 접두 규칙
export const CLI_SESSION_PROVIDER_ALLOWLIST: readonly string[] // §allowlist provider 12키
export interface ChildEnv { base(): NodeJS.ProcessEnv; cliSession(): NodeJS.ProcessEnv }
export function runtimeBaseEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv  // base pick
export function cliSessionEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv   // base + provider pick
export function createChildEnv(source?: NodeJS.ProcessEnv): ChildEnv           // 기본 process.env
```
- 구현 = **pick(allowlist)**: 정확 키(대소문자 무시 매칭) + `LC_` 정확 접두. `undefined` 값 스킵.
- **주석 강제**: "여기에 named 키 추가만이 자식 env 확장 경로(denylist·와일드카드 금지). provider 키는 CLI 세션 전용."

**(c) 회귀 핀**: 신규 파일 · 순수(Node stdlib) → `src/server/**` 순수성 게이트 통과.

**(d) 함정**: `LC_` 접두는 정확 접두(`LCD_` 오매칭 방지 테스트)·win32 대소문자 비교·빈 문자열 값은 통과(상속 의미)·undefined 제외.
**ripple**: 신규 모듈 → 소비 = T3(엔진 주입)·T4(MCP base)·T7(boot 주입). 이 태스크는 순수 함수 + 테스트만.

---

## T3 — 엔진 `childEnv` 주입점 + **전 자식** 스레딩 (CLI·detect/probe·verify·git · 실 spawn 통합)

> **스코프 확장(패널 발견)**: 스펙 4주입점(CLI 세션·detect/probe·MCP)에 더해 **verify/git 형제 러너**를 포함한다.
> 실측상 프로덕션 서버모드에서 이 둘도 `FLEET_SECRET_KEY` 를 상속하는 실 exfil 벡터이므로, 격리를 완결한다(§스코프 결정).

**리스크**: 카테고리 오배선(detect/probe·verify/git 에 provider 키 부여 = 유출 확대 / CLI 세션에서 누락 = 기능 파손).
**경로별 정확 매핑을 실 spawn 으로 검증.**

**runner 사용처 카테고리 매핑**(감사 표):

| 경로 | 위치 | 현행 | 변경 | 카테고리 |
|---|---|---|---|---|
| CLI 세션 send | `engine.ts:359,669` `createCliSession(…, runner)` | 상속 | `cliRunner`(base+provider) | **cliSession** |
| detect | `engine.ts:479` `detectAll(list, runner)` | 상속 | `baseRunner`(base) | **base** |
| probe | `engine.ts:489` `probeCliAuth(adapter, runner, …)` | 상속 | `baseRunner`(base) | **base**(§probe 비대칭 주의) |
| verify | `engine.ts:217` `runner: opts.verifyRunner`→`defaultVerifyRunner` | 상속 | base-env verify runner | **base** |
| git | `engine.ts:211` `createWorkspace(dir, opts.gitRunner)`→`defaultGitRunner` | 상속 | base-env git runner | **base** |

**(a) RED** — `src/main/core/engine.test.ts` `describe('엔진 childEnv 스레딩(#197-B6 T3)')`:
- **미주입 무회귀 특성화 핀**: `childEnv` 미주입 → 주입 fake runner 의 `opts.env`==='undefined'(detect·probe·cli-session 전 경로).
  데스크톱=현행 상속 확정.
- **detect/probe=base**: `childEnv` 주입(fake source 에 `FLEET_SECRET_KEY`·`ANTHROPIC_API_KEY`·`PATH`) → detect/probe fake
  runner `opts.env` 에 `PATH` 존재·`FLEET_SECRET_KEY` 부재·`ANTHROPIC_API_KEY` 부재.
- **CLI 세션=base+provider**: 등록 CLI 세션 send fake runner `opts.env` 에 `PATH`·`ANTHROPIC_API_KEY` 존재·`FLEET_SECRET_KEY` 부재.
- **verify=base**: `runVerify` 경로 fake runner(또는 실 spawn) env 에 `PATH` 존재·`FLEET_SECRET_KEY` 부재·`ANTHROPIC_API_KEY` 부재.
- **git=base**: workspace git 경로 fake runner env 에 `FLEET_SECRET_KEY` 부재.
- **실 spawn 통합 핀**: `childEnv` 주입 + 실 `defaultRunner` 위임 — 자식이 `process.env` JSON 출력하는 CLI 어댑터 stub 을
  detect → 실제 자식 env 에 `FLEET_SECRET_KEY` **부재**·`PATH` 존재(end-to-end 상속 차단 확인).

**(b) GREEN**:
- `src/main/core/engine.ts`:
  - `FleetEngineOptions`(`:86`) 에 `childEnv?: { base(): NodeJS.ProcessEnv; cliSession(): NodeJS.ProcessEnv }`
    (**구조적 인라인 타입 — `src/server/child-env.ts` import 금지**·코어 순수성). `createChildEnv(env)` 반환이 구조적 호환.
  - wrapped runner 2종(주입 `runner` 위에):
    ```ts
    const cliRunner  = childEnv ? (c,a,o,s)=>runner(c,a,{...o, env:o.env ?? childEnv.cliSession()}, s) : runner
    const baseRunner = childEnv ? (c,a,o,s)=>runner(c,a,{...o, env:o.env ?? childEnv.base()},        s) : runner
    ```
  - 배선: `detectAll(list, baseRunner)`·`probeCliAuth(adapter, baseRunner, …)`·`createCliSession(…, cliRunner)`(일반+edit `:669`).
  - verify/git = 팩토리 base-env 변형(childEnv 주입 & 미override 시):
    `runner: opts.verifyRunner ?? (childEnv ? createVerifyRunner(childEnv.base) : undefined)` ·
    `createWorkspace(dir, opts.gitRunner ?? (childEnv ? createGitRunner(childEnv.base) : undefined))`.
- `src/main/core/verify/run.ts`: `export function createVerifyRunner(baseEnv?: () => NodeJS.ProcessEnv): VerifyRunner` —
  `defaultRunner(cmd.command, cmd.args, { timeoutMs, cwd: cmd.cwd, signal, env: baseEnv?.() })`. 하위호환
  `export const defaultVerifyRunner = createVerifyRunner()`(env 미지정=현행 상속).
- `src/main/core/workspace/git.ts`: `export function createGitRunner(baseEnv?: () => NodeJS.ProcessEnv): GitRunner` —
  내부 `defaultRunner('git', args, { timeoutMs, cwd, signal, env: baseEnv?.() })`. 하위호환 `defaultGitRunner = createGitRunner()`.

**(c) 회귀 핀**: `childEnv` 미주입 시 `cliRunner===baseRunner===runner`·verify/git=기존 default(상속) → 전 기존 테스트 무회귀.
`opts.env ?? …`·`baseEnv?.()` 로 미주입 경로 이전과 동일. `defaultVerifyRunner`/`defaultGitRunner` 상수 시그니처 불변.

**(d) 함정**:
- **wrapped runner 가 `onStdout`(4번째 인자) 전파 필수** — 누락 시 CLI 세션 스트리밍 파손. 스트리밍 경로 테스트 포함.
- **edit 세션**(`makeEditSession` `:669`)도 CLI 세션 = provider 키 필요(`cliRunner` 적용 확인 — 누락 시 편집 CLI 시크릿 유출).
- **probe 비대칭(§검증요청)**: probe=실 모델 왕복이라 base-only 에서 API-키 CLI 는 probe auth 실패·실세션 성공. 구독-OAuth
  주 경로 무영향. 결정: probe=base 유지 + README 오탐 명시(라이브가 조기 표면화).
- 매 호출 새 객체(source 스냅샷) — 작은 pick 이라 성능 무영향(공백 그룹 계량 확인).

**ripple**: `FleetEngineOptions` 변경 → 소비 boot.ts(T7 주입)·main/index.ts(미주입·무변경) → 테스트 더블 신규 케이스만.
`verify/run.ts`·`git.ts` 팩토리화 → 기존 `defaultVerifyRunner`/`defaultGitRunner` 소비처(verify.test·workspace.test) 무회귀.

---

## T4 — MCP stdio base 교체 (base 만·`spec.env` override 보존)

**리스크**: MCP 자식 = 임의 사용자 구성 프로세스. provider 키 기본 전달 시 유출 보존 → base 만, provider 키는 `spec.env`(명시 escape hatch)만.

**(a) RED** — `src/main/core/mcp/stdio.test.ts` `describe('MCP stdio base env 격리(#197-B6 T4)')`:
- **base 교체**: `createDefaultSpawn(() => ({ PATH:'/b', FLEET_SECRET_KEY:'s', ANTHROPIC_API_KEY:'k' }))` 의 SpawnFn 이 실
  spawn 하는 자식(`process.env` JSON stub) env 에 `PATH` 존재·`FLEET_SECRET_KEY` 부재·`ANTHROPIC_API_KEY` **부재**.
- **`spec.env` override 보존**: `spec.env = { MY_SERVER_TOKEN:'t', ANTHROPIC_API_KEY:'explicit' }` → 자식 env 에
  `MY_SERVER_TOKEN` 존재·`ANTHROPIC_API_KEY==='explicit'`(escape hatch 만 provider 키 전달).
- **미주입 무회귀 핀**: `createDefaultSpawn()`(base 미주입) = 현행 `defaultSpawn` 과 동일(부모 process.env 전량 상속).

**(b) GREEN** — `src/main/core/mcp/stdio.ts`:
- `export function createDefaultSpawn(baseEnv?: () => NodeJS.ProcessEnv): SpawnFn` — 내부
  `env: { ...(baseEnv ? baseEnv() : process.env), ...spec.env }`(**`spec.env` 스프레드 뒤 = override 보존**).
- 하위호환 `export const defaultSpawn: SpawnFn = createDefaultSpawn()`.
- 엔진 배선(`engine.ts:205` `createMcpHost`): `spawn: childEnv ? createDefaultSpawn(childEnv.base) : undefined`
  (미주입 시 undefined → host 가 `defaultSpawn` 사용 = 무회귀).

**(c) 회귀 핀**: `defaultSpawn` 상수 불변 → `host.ts:41` `opts.spawn ?? defaultSpawn`·host.test 무변경. `spec.env` override 순서 특성화.

**(d) 함정**: provider 키 필요 MCP 는 `spec.env` 명시가 유일 경로(승인 게이트가 `commandLine`/`env:` 노출로 가시화 — `host.ts:35`). `spec.env` 빈/undefined → base 만.
**ripple**: 팩토리화 → 소비 host.ts(기본값 무변경)·engine.ts(주입) → host.test fake SpawnFn 무영향.

---

## T5 — `fleet-data` 0700 (createJsonFileStore 이전 선생성·chmod 보정)

**리스크**: 서버 데이터 디렉터리 권한 완화 = 동일 호스트 타 사용자의 세션/이벤트/암호문 접근. **디렉터리 생성보다 먼저 잠금.**

**(a) RED** — `src/server/boot.test.ts` `describe('fleet-data 0700(#197-B6 T5)')`, POSIX 한정(`it.skipIf(process.platform==='win32')`, CI linux):
- **신규 생성 0700**: 미존재 `FLEET_DATA_DIR` 로 boot → `statSync(dataDir).mode & 0o777 === 0o700`.
- **기존 dir chmod 보정**: 사전 `mkdirSync(dir,{mode:0o755})` → boot 후 `& 0o777 === 0o700`(recursive mkdir 이 기존 mode 미변경 → chmod 필요 핀).
- **순서 핀**: store 파일 생성돼도 dataDir 0700 유지(선생성이 `createJsonFileStore`(boot.ts:219) 이전).
- **win32 no-op**: win32 boot 가 chmod 로 throw 안 함(별도 `it` — win32 부팅 성공 단언).

**(b) GREEN** — `src/server/boot.ts`:
- import `mkdirSync, chmodSync`(`node:fs`, 기존 `statSync` 와 병합).
- `boot.ts:218-219` 사이(**`createJsonFileStore` 이전**):
  ```ts
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700)  // recursive mkdir 은 기존 dir mode 미적용 → 보정
  ```

**(c) 회귀 핀**: loopback·access 모드 공통. win32 chmod 스킵 → win32 vitest 보안 잡 무회귀. `FLEET_DATA_DIR` 미설정=`resolve('fleet-data')` 불변.

**(d) 함정**: umask 간섭 → `chmodSync` 로 정확 0700 강제(안전장치). `..` 상대경로는 `resolve` 로 절대화 승계. symlink dataDir=비범위(문서화). workspace 검증(`boot.ts:215`)은 mkdir 이전 fail-fast.
**ripple**: boot 단일 파일 — 소비처 없음.

---

## T6 — 소켓 exp-시한 종료 (verifier `expiresAtMs` fail-closed + 타이머 clear·unref·clamp)

**리스크(fail-closed 집중)**: B5 이관. exp 우회 5경로 차단 — **부재·비유한수·attach시점만료·이중close·오버플로**.

**(a) RED**:
- `src/server/access-jwt.test.ts` `describe('exp fail-closed(#197-B6 T6)')`:
  - **유효 미래 exp**: `sign({ exp: nowSec()+3600 })` → `{ identity, expiresAtMs }`·`expiresAtMs===(nowSec()+3600)*1000`.
  - **exp 부재 → 401**: exp 없는 토큰 → `rejects.toMatchObject({ kind:'invalid' })`(requiredClaims + 수동 체크 이중).
  - **만료 토큰 → 401(현행)**: `exp: nowSec()-60` → `invalid`(기존 동작 핀).
  - **기존 테스트 ripple**: `access-jwt.test.ts:55` 의 `.resolves.toEqual({ identity:'user-abc-123' })` →
    `.toMatchObject({ identity:'user-abc-123' })`(반환에 `expiresAtMs` 추가로 exact-equal 파손 — 테스트 더블 핀).
  - **비유한수 주의**: 실 서명 JWT 로 NaN/Infinity 구성 불가(JSON 미표현) → '부재' 케이스로 대표. 방어 코드는 유지하되 RED 는 '부재'로.
- `src/server/boot.test.ts` `describe('소켓 exp 종료(#197-B6 T6)')`, 주입 clock:
  - **미래 exp → 만료 시 close**: access 실 ws 클라 attach(future exp) → `clientCount()===1` → clock 을 exp 초과 진행 +
    콜백 발화 → 소켓 close·`clientCount()===0`.
  - **attach 시점 만료 → 미유지**: verify 통과했으나 `expiresAtMs <= now`(정확히 `===now` 도 미유지) → **attach 이전** close·
    `clientCount()===0`(presence 오염 없음).
  - **close 후 타이머 미발화(이중close)**: exp 전 소켓 close → `handleSocketGone` 이 clear → clock 진행해도 재발화·재close 없음.
  - **오버플로 clamp+re-arm**: `expiresAtMs - now > TIMEOUT_MAX`(예: now+30일) → 타이머가 즉시 close 하지 **않고** re-arm.
    clock 을 `TIMEOUT_MAX` 만큼 진행 → 소켓 여전히 open(재무장 확인). 이후 exp 초과 진행 → close.
  - **서버 close 시 타이머 미잔류**: live 소켓(future exp) 있는 상태로 `host.close()` → exp 타이머 clear(이벤트루프 잔류 없음 —
    주입 clock 의 clearTimeout 관측 or unref 로 프로세스 미붙듦).
  - **loopback 무영향**: loopback 소켓은 exp 타이머 미설정(clock.setTimeout 미호출).

**(b) GREEN**:
- `src/server/access-jwt.ts`:
  - `AccessIdentity`(`:24`) 에 `expiresAtMs: number` 추가.
  - `jwtVerify` 옵션에 `requiredClaims: ['exp']`(jose 단계 exp 부재 차단 · context7 확인) + verify 반환부에서
    `if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw new AccessJwtError('invalid', 'exp 없음/비유한')`
    (belt+suspenders) → `return { identity: sub, expiresAtMs: payload.exp * 1000 }`.
- `src/server/boot.ts`:
  - `BootDeps` 에 `clock?: SocketExpiryClock`(`{ now(): number; setTimeout(fn, ms): Handle; clearTimeout(h): void }`,
    기본 = `Date.now` + `globalThis.setTimeout`(반환에 `t.unref?.()`) + `clearTimeout`). 주입 vitest.
  - `acceptUpgrade`(`:349`) 에 `expiresAtMs?: number` 파라미터 → `wss.emit('connection', ws, req, expiresAtMs)`.
  - `handleUpgrade` access 분기(`:371-373`): `const { identity, expiresAtMs } = await accessVerifier!.verify(...)` → 바인딩
    대조 후 `acceptUpgrade(req, socket, head, expiresAtMs)`. loopback 분기는 expiresAtMs 미전달.
  - `wss.on('connection', (socket, _req, expiresAtMs?) => {...})`(`:314`): access & `expiresAtMs!==undefined` 시 —
    **attach 이전** `if (expiresAtMs - clock.now() <= 0) { socket.close(); return }`. 이후 clamp+re-arm 타이머:
    ```ts
    let expTimer
    const arm = () => {
      const remaining = expiresAtMs - clock.now()
      if (remaining <= 0) { socket.close(); return }
      expTimer = clock.setTimeout(() => arm(), Math.min(remaining, TIMEOUT_MAX))  // TIMEOUT_MAX=2147483647
    }
    arm()
    ```
    `handleSocketGone`(`:322`) 첫 줄에 `if (expTimer) clock.clearTimeout(expTimer)`.

**(c) 회귀 핀**: `handleNonceRequest`(`boot.ts:117`)의 `const { identity } = await verify(...)` 무변경(expiresAtMs 무시).
loopback 미진입. 주입 clock 미지정=실 타이머(unref 로 프로세스 미붙듦).

**(d) 함정**:
- jose `clockTolerance` 기본 0 → verify 시점 만료면 jose 가 이미 401. attach-재검사는 verify↔connection race window(수 ms) 방어.
- `<=` 경계(=== now 도 미유지).
- `handleSocketGone` = close·error 공통 경로(`boot.ts:329-335`) → 어느 종료든 clear 보장(이중close 방지).
- **오버플로**: `Math.min(remaining, TIMEOUT_MAX)` + re-arm 재귀 → 30일+ 토큰도 정확히 exp 에 close(즉시발화 버그 제거).
- **잔여(검증요청)**: 관리자 revoke 는 토큰 만료 전 미반영(다음 handshake 차단). thundering herd(동일 exp 다수 소켓)·lazy 하이브리드=**Phase C**. README/주석 명시.

**ripple**: `AccessIdentity`/`verify` 반환 변경 → `access-jwt.ts:24,43`·`boot.ts:117`(무시)·`boot.ts:373`(캡처)·
`access-jwt.test.ts:55`(toEqual→toMatchObject)·boot.test fake verifier(expiresAtMs 반환 추가)·clock 주입.

---

## T7 — 서버 boot 배선 (childEnv 주입·전 조각 통합)

**리스크**: 전 조각을 실 boot 연결. childEnv 미주입 시 컨테이너 CLI 세션이 secret 상속(누출) — **주입 누락이 최종 유출.**

**(a) RED** — `src/server/boot.test.ts` `describe('boot childEnv 통합(#197-B6 T7)')`:
- **정책 고정(단위)**: boot 이 `createFleetEngine` 에 `childEnv` 를 전달함을 typecheck 강제 import + `createChildEnv(env)` 반환이
  `{ base, cliSession }` 만족을 단언(`buildServerChildEnv` 순수 헬퍼로 추출 → 직접 단위핀).
- **통합(정직 프레이밍)**: boot 은 엔진 runner/mcp spawn 미노출 → '실 자식 시크릿 미수신'의 **권위 증명은 T3 실spawn·T10
  컨테이너 스모크·라이브 5종에 위임**(주석 명시). boot 레벨은 배선 존재(childEnv 전달) + createChildEnv 정책만 핀.

**(b) GREEN** — `src/server/boot.ts`:
- import `createChildEnv` from `./child-env`.
- `createFleetEngine({...})`(`:238`) 에 `childEnv: createChildEnv(env)` 추가(source = boot 인자 `env` — 테스트 주입 가능).

**(c) 회귀 핀**: 데스크톱 `main/index.ts:buildEngine`(`:54`)은 childEnv 미주입 유지 → 현행 상속(무회귀). boot 다른 조립 무변경.

**(d) 함정**: `createChildEnv(env)` 는 allowlist pick → boot 이 secret env 받아도 자식엔 안 감. engine 생성 시점 주입.
**ripple**: boot→engine 옵션 1줄 + `buildServerChildEnv` 헬퍼. main/index.ts 대칭 미적용(의도 — 데스크톱 무회귀).

---

## T8 — `deploy/fleet/Dockerfile` (멀티스테이지·비특권·시크릿 미포함)

**리스크**: 이미지 시크릿 baking·root 실행 = 침해 시 피해 확대. **비특권 UID + 시크릿 env-only.**

**(a) RED/검증**: Dockerfile 실질 검증 = T10 스모크 컨테이너 불변식(빌드→whoami=node→시크릿 env 부재). 선택적 config-핀(`USER node`·버전핀 ARG 텍스트 grep).

**(b) GREEN** — `deploy/fleet/Dockerfile`(신규, `# syntax=docker/dockerfile:1`):
- **builder**(`node:24-bookworm-slim`): 레포 COPY → `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` → `npm run build`
  (→ `out/renderer` + `out/server/index.mjs`).
- **runtime**(`node:24-bookworm-slim`): CLI 3종 **버전핀 ARG**(webterminal 패턴 재사용 — `CLAUDE_VERSION`/`CODEX_VERSION`/
  `GEMINI_VERSION` · `npm install -g` + `--version` 검증) → builder 에서 `out/`·`package.json` COPY + `npm ci --omit=dev`
  (ws·jose·cross-spawn·which 등) → `mkdir -p /workspace && chown node:node` → `USER node` → `CMD ["node","out/server/index.mjs"]`.
- **시크릿 미포함**: `.dockerignore` 에 `deploy/.env`·`**/*.pem`·`**/.env` 등. `FLEET_SECRET_KEY`·`FLEET_ACCESS_*`=런타임 env 만.

**(c) 회귀 핀**: webterminal 이미지·ttyd 서비스 무변경(별 서비스). `out/server`=데스크톱 asar 제외(B3 electron-builder.yml 승계).

**(d) 함정**: `--omit=dev` 가 electron-updater(prod dep) 미제외(무해·용량만·최적화=후속). `FLEET_STATIC_DIR` 기본=`out/server` 기준 `../renderer` → `out/renderer` sibling 배치 필수. 버전핀=`.env.example`/compose 와 동기(webterminal 과 공유 ARG 권장).
**ripple**: 신규 파일 → compose(T9)·스모크(T10) 소비.

---

## T9 — compose `fleet` 서비스 + cloudflared ingress README

**리스크**: `fleet-data` 다중 노출·ports 공개 = 데이터 유출·인증 우회 도달. **fleet-data 여기만·ports 없음·access env 완비.**

**(a) RED/검증**: T10 스모크의 compose 불변식(fleet-data 마운트 위치·ports 부재·docker.sock 부재)이 RED.

**(b) GREEN** — `deploy/docker-compose.yml` 에 `fleet` 서비스 추가:
- `build: { context: .., dockerfile: deploy/fleet/Dockerfile, args: {CLAUDE/CODEX/GEMINI_VERSION} }` · `init: true` · `restart: unless-stopped`.
- volumes: **`fleet-data`(이 서비스만)** · `cli-auth:/home/node`(**공유** — #195 실측) · `workspace` bind(공유).
- **`ports:` 없음**(도달=cloudflared 내부망뿐).
- environment: `FLEET_HOST=0.0.0.0`(access 완비 시에만 부팅 통과 — `resolveBindHost` `boot.ts:159`)·`FLEET_PORT`·
  `FLEET_SECRET_KEY`·`FLEET_ACCESS_TEAM_DOMAIN`·`FLEET_ACCESS_AUD`·`FLEET_PUBLIC_ORIGIN`(전부 `.env` 참조).
- `healthcheck`: `curl -fsS http://127.0.0.1:${FLEET_PORT}/`(정적 200 · loopback 도달).
- 최상위 `volumes:` 에 `fleet-data:` 추가. cloudflared `depends_on` 에 `fleet` 병기.
- **ingress README**: 대시보드 Public Hostname `fleet.<domain>` → `http://fleet:${FLEET_PORT}`. `.env.example` 에 `FLEET_*` access 키·`FLEET_PORT` 추가.

**(c) 회귀 핀**: ttyd·cloudflared 정의 무변경. compose 주석("Phase B 에서 fleet 서비스 추가·fleet-data 여기만") 이행·갱신.

**(d) 함정**: cli-auth RW 공유 잔여(검증요청) — 문①/문② refresh 로테이션 경합(#195 미관측·README 명시·신호 시 RO 분리).
`FLEET_HOST=0.0.0.0`+access 미완비=부팅 거부(fail-fast·조용한 loopback 강등 아님 — 이중 게이트). `FLEET_PORT` 기본 8791(healthcheck/ingress 정합).
**ripple**: compose·.env.example·README·cloudflared depends_on 동시.

---

## T10 — smoke 확장 + 컨테이너 브라우저 스모크

**리스크**: 스모크가 위반을 **실제로 감지**해야 신뢰 가능(false-GREEN 금지).

**(a) 검증(스모크=실측 게이트)** — `deploy/smoke.sh` 확장(webterminal 구조 재사용):
- **fleet 이미지 빌드**: `compose build fleet`.
- **비특권**: `docker run --entrypoint sh $IMG -lc 'id -u'`===`1000`(root 면 FAIL).
- **fleet-data 0700**: 기동 후 `docker exec … stat -c '%a' <dataDir>`===`700`.
- **시크릿 이미지 미포함**: `docker run --entrypoint sh $IMG -lc 'env'` 에 `FLEET_SECRET_KEY`/`FLEET_ACCESS_` 부재 +
  이미지 레이어 `.env` 미포함(`ls -a`).
- **ports 미공개**: `docker inspect` NetworkSettings.Ports 빈 값.
- **docker.sock 미마운트**: fleet Mounts 에 `docker.sock` 부재.
- **fleet-data=fleet 서비스만**: ttyd Mounts 에 `fleet-data` 부재(대칭).
- **in-container 정적 200**: loopback 모드(access env 미설정+FLEET_HOST unset→127.0.0.1) →
  `docker exec … curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/`===`200`.
- **컨테이너 브라우저 스모크(#193 게이트 ③)**: `network_mode: host` 오버라이드 compose + loopback + `FLEET_E2E=1` +
  호스트 playwright(B4 웹스모크·`e2eVerifyRunner` 결정론 재사용) → 목표 입력→런 완주(`.proj-status=done` 단언).
  host 네트워킹 불가 시 스킵(**명시 로그** — 사일런트 캡 금지) + 라이브 5종 대체(검증요청 ②).

**(b) GREEN**: `smoke.sh` fleet 섹션 함수 + host-override compose(`docker-compose.hostnet.yml`). B4 playwright 스펙 재사용.

**(c) 회귀 핀**: webterminal 스모크 섹션 무변경(append). `set -euo pipefail`·trap cleanup 승계.

**(d) 함정**: 보안 게이트 우회 env 신설 금지(`FLEET_E2E=1`=기존·`network_mode:host`=compose override). `| tail -1` 로 exit code 가리지 말 것(false-green — 메모리 교훈). fleet-data 0700=컨테이너 내부(linux). curl 200=loopback(인증 우회 아님).
**ripple**: `smoke.sh`·host-override compose·playwright 스펙(재사용).

---

## T11 — 단일 인스턴스 전제 문서화 + ADR

**리스크(문서)**: fleet-data 를 데스크톱 userData 와 공유 시 JSON store 동시 쓰기 손상. 문서 방지(코드 가드=Phase C).

**(a) RED**: 문서 태스크 — `skills:lint`(경로·시크릿 스캔) 통과가 게이트.

**(b) GREEN** — `deploy/README.md` 추가 절: fleet-data=서버 전용(데스크톱 userData 공유 금지)·workspace root 하나=인스턴스 하나·
"런 중 workspace 변경 거부=UI 가드일 뿐(진짜 격리=Phase C per-run worktree)"·cli-auth RW 공유 잔여(refresh 경합)·소켓 exp 종료
vs 주기 재검증 잔여(관리자 revoke)·라이브 완료 체크리스트(터널→폰 5종).
**「워크스페이스 명령 격리 경계」 절 명시(Codex 계획-R P1)**: B6 의 자식 env allowlist 는 **서버 시크릿(FLEET_*)** 이
verify/git·CLI·MCP 자식에 안 새게 한다. 그러나 verify 스크립트·git 훅은 컨테이너 사용자(uid node)와 **같은 파일시스템 뷰**로
실행되므로 `HOME`(cli-auth 마운트 `/home/node`) 하위 자격파일을 **절대경로/`getpwuid` 로 읽을 수 있다** — env 로 안 닫힌다.
Phase B 위협모델(단일 사용자·단일 인스턴스)에선 워크스페이스와 cli-auth 가 **동일 주체**라 자기 자격 읽기는 신규 exfil 이 아니나,
**완전 격리(별도 uid / RO cli-auth 마운트 / per-run worktree)는 Phase C** 임을 명시(과장 방지 — "서버 env 시크릿 격리"로 범위 한정).
**ADR**: 지속·교차 결정 = `docs/adr/` 갱신(AGENTS.md ADR 트리거 — 대안 있던 갈림길). 후보:
① 자식 env allowlist 격리(denylist 대안 기각)·② 소켓 exp-시한 종료(주기 JWKS 재검증 대안)·③ cli-auth RW 공유(RO 분리 대안).
템플릿 복사 + README 인덱스 1줄.

**(c) 회귀 핀**: 기존 README webterminal 절 무변경.
**(d) 함정**: "UI 가드일 뿐" 명시(per-run worktree=Phase C 비범위 준수).
**ripple**: README·ADR.

---

## T12 — brain 재생성 + verify + e2e 무회귀 (최종 1회)

**리스크**: brain stale = CI `brain:check` fail. **전 src 변경 후 최종 1회**(중간 재생성 금지 — 메모리 교훈).

**(a) 검증**: `npm run verify`(skills:lint·brain:check·format:check·typecheck·lint·test:coverage·build) GREEN.

**(b) GREEN**:
- `npm run brain`(변경 반영 — `detect.ts`·`engine.ts`·`stdio.ts`·`verify/run.ts`·`git.ts`·`access-jwt.ts`·`boot.ts`·`child-env.ts`).
- **커밋 순서(메모리 교훈)**: src 먼저 커밋 → brain 재생성 → brain 별도 커밋(lint-staged prettier 재포맷 stale 회피).
- 데스크톱 e2e(`npm run test:e2e`) 로컬 수동 — childEnv 미주입 무회귀(CLI 세션 상속 유지).

**(c) 회귀 핀**: 데스크톱 electron e2e GREEN(완료조건 "childEnv 미주입=상속+electron e2e GREEN").
**(d) 함정**: brain 재생성 전 lint-staged 재포맷 시 stale → CI fail. src→brain→brain커밋 순서 엄수. `| tail -1` 금지.
**ripple**: brain.md·전 변경 파일 최종.

---

## 완료 조건 ↔ 태스크 매핑

| 완료 조건(스펙) | 태스크 |
|---|---|
| 서버 시크릿 env(`FLEET_*`) 자식 미전달 (**verify/git 형제 포함** — cli-auth 파일 exfil 은 Phase C) | T2·T3·T7 |
| 세션 provider 키 — CLI 세션 경로에만 | T2·T3 |
| MCP stdio=base 만·provider 키 부재·`spec.env` override 보존 | T4 |
| verifier exp 부재/비유한수 fail-closed·attach시점만료 미유지·close후 타이머 clear | T6 |
| 데스크톱 무회귀(childEnv 미주입=상속)+electron e2e | T1·T3·T4·T7·T12 |
| fleet-data 0700 | T5 |
| 소켓 수명 중 JWT 만료 종료·클라 재접속 복구 | T6 |
| 컨테이너 비특권 UID(whoami=node) | T8·T10 |
| compose fleet 서비스 — fleet-data 여기만·ports 미공개 | T9·T10 |
| 브라우저 스모크(목표 입력→런 완주·컨테이너) | T10 |
| 라이브 5종(터널·세션·런·승인 fail-closed·재접속) | 사용자 라이브(T9 배포 후) |
| `npm run verify` GREEN·CI green | T12 |

## 비범위 준수
- per-run worktree·Web Push·graceful drain = **Phase C**(T11 문서만).
- spawn-level setuid = **기각**(컨테이너 `USER node` 대체 · T8).
- 다중 인스턴스·다중 사용자·`src/server/**` 커버리지 floor 편입 = 비범위(승계).
- cli-auth RO 분리·thundering herd/lazy exp 하이브리드 = 신호 시/Phase C 후속(문서만).
- **워크스페이스 명령(verify/git) 파일시스템 격리** — cli-auth 자격파일 read 차단(별도 uid/RO 마운트/per-run worktree) = **Phase C**
  (B6 은 서버 env 시크릿 격리까지 · Codex 계획-R P1).

---

## 스코프 결정 — verify/git 형제 서버-시크릿 env 격리 (+ cli-auth 파일 exfil 은 Phase C)

스펙은 자식 env 스코프를 "CLI 세션·detect/probe·MCP stdio"(4주입점)로 명시했다. 그러나 판사 패널이 **두 렌즈 그룹 독립으로**
`verify/run.ts:45`·`git.ts:64` 형제 누출을 지목했고, 메인 루프가 실측 확인했다: 프로덕션 서버모드(boot)에서 이 둘은
`verifyRunner`/`gitRunner` 미주입 → default 러너가 `FLEET_SECRET_KEY`·`FLEET_ACCESS_*` 를 상속한다. verify 러너는 **런 완료 후
워크스페이스 npm 스크립트를 자동 실행**하고 git 러너는 **`.git/hooks` 를 실행**하므로, 워크스페이스 코드가 **서버 시크릿 env** 를
보게 되는 실 도달 경로다. 완료 조건 "서버 시크릿 env 자식 미전달"이 CLI 경로만 충족하면 **부분 격리**다.

**결정**: T3 를 "엔진이 spawn 하는 전 자식"으로 확장해 verify/git 에 base env(FLEET_* 제거·provider 키 불요)를 적용한다
(팩토리 패턴 — T4 와 동형). 근거: (1) **서버 시크릿(FLEET_*) env 격리 완결**, (2) 소규모 변경(팩토리 2 + 엔진 배선 + 테스트),
(3) B4 교훈 "lifecycle fix 는 형제 경로 함께 스윕".

**Codex 계획-R P1 반영 — env-only 격리의 한계 명시(과장 방지)**: base env 는 `HOME`/XDG 를 포함하고 `cli-auth` 볼륨이
`/home/node` 에 마운트되므로, verify/git 자식이 FLEET_* 를 못 봐도 **cli-auth 자격파일은 여전히 읽을 수 있다**(같은 컨테이너
uid·공유 볼륨). Codex 가 제안한 "isolated temp HOME(3번째 env 카테고리)"는 **불완전+파손 위험으로 기각**: verify/git 자식은
uid node 로 실행돼 `os.homedir()` 가 `$HOME` 없이도 `getpwuid`→`/home/node` 폴백 → **절대경로 `/home/node/.claude/...` 직접
읽기가 여전히 가능**(temp HOME 은 `~` 편의 접근만 차단). 또 HOME 제거는 git(`~/.gitconfig`)·npm(`~/.npmrc`·캐시)을 깨뜨린다.
근본 해결 = **파일시스템 격리(별도 uid / RO cli-auth 마운트 / per-run worktree) = Phase C**. 따라서 B6 의 주장 범위를 **"서버
env 시크릿(FLEET_*) 격리"로 한정**하고, cli-auth 파일 exfil 잔여를 README(T11)·완료조건에 명시한다. Phase B 위협모델(단일
사용자·단일 인스턴스)에선 워크스페이스와 cli-auth 가 동일 주체라 자기 자격 읽기는 신규 exfil 이 아님을 함께 기록.

## 패널 렌즈 실효 (Codex 체크포인트 대조용 — 비중복 지적)

- **[공백 그룹]** 프레임 전복: 스펙의 "4주입점" 스코프 프레임 자체가 완료 조건을 미달로 만든다(verify/git). Codex 는 스펙
  스코프를 전제로 리뷰하므로 이 프레임 미달을 구조적으로 안 잡을 수 있음 → 본 계획이 서버 env 시크릿 격리로 선제 대응 + 체크포인트 제기.
- **[공백 그룹]** exp 타이머 max-delay 오버플로(TIMEOUT_MAX) — 3초안 공통 누락, 본 계획 clamp+re-arm 보강.
- **[Codex 강점]** contract-first 의 Grep-스윕 false-negative(engine 심볼 한정 → verify/git 별개 주입점 놓침) — ripple 완전성
  교훈. 본 계획은 러너 사용처 카테고리 표로 전수.
- **[Codex 강점]** jose 는 exp 를 기본 미강제(context7 확인) → `requiredClaims:['exp']` + 수동 체크 이중방어.
- **[양 그룹]** probe 비대칭(실 모델 왕복 → base-only 오탐) — 결정: probe=base 유지 + README 오탐 명시.

## 검증 요청 포인트 (Codex 체크포인트)
1. **verify/git 스코프 확장** — ✅ Codex 계획-R P1 반영: base env 로 **서버 env 시크릿(FLEET_*) 격리 완결**, cli-auth 파일
   exfil 은 Phase C 로 정확히 범위 한정(과장 제거). 3번째 env 카테고리는 불완전+파손 위험으로 기각(§스코프 결정).
2. **allowlist 충분성** — context7 확정 목록(§allowlist)이 CLI 3종 실 요구를 덮는가. `NODE_OPTIONS` 배제·`XDG_*` 포함 타당성.
3. **소켓 exp clamp+re-arm** — 오버플로 해소가 정확한가. thundering herd/lazy 하이브리드 Phase C 유예 수용?
4. **probe=base 유지** — API-키 CLI probe 오탐을 README 문서화로 수용 vs probe=cli-session 승격?

---

## 리스크·롤백
- **T1 상속 파손**(최고): 특성화 핀①②가 감지 → 조건부 스프레드 1줄 revert.
- **T3 카테고리 오배선**(provider 키 유출): 실 spawn 통합 핀 감지 → childEnv 미주입(옵션 제거).
- **T6 exp fail-open/오버플로**: access-jwt + boot RED 가 우회 감지 → `acceptUpgrade` expiresAtMs 제거(B5 handshake-only 복귀).
- **T5 win32 chmod throw**: POSIX 가드 + win32 부팅 성공 핀 → chmod 제거(mkdir 만).
- **T8-T10 배포**: 스모크=실측 게이트(위반 시 exit 1) → compose fleet 미기동(webterminal Phase A 유지).
- **전역**: childEnv·exp·0700 전부 **미주입 시 현행 동작** 설계 → 데스크톱 무영향(server-only 격리).

# 세션 등록 인증 picker — 설계

- 날짜: 2026-06-25
- 트랙: 세션 등록 UX (provider parity / DX)
- 상태: 설계 승인 → 구현 계획 대기
- 연계: #27(백로그)·Gemini CLI ToS 위험 이슈(별도 sub-issue)·메모리 `model-capability-gap-verification`

## 1. 동기 / 배경

사용자가 opencode·antigravity처럼 **"AI 등록 시 OAuth로 인증할지 API 키로 등록할지" 고르는 경험**을 원한다. 출발 동기는 **CLI 사전 설치 의존을 줄이는 것**.

조사(2026-06-25)로 확정된 제약:

- **Fleet 자체 OAuth는 불가/금지다.** Anthropic은 3rd-party 도구의 구독 OAuth를 **2026-02 ToS로 금지하고 2026-04-04 서버단 차단**(opencode도 법적 요청으로 Claude OAuth 제거). Google(Gemini)도 **2026-02 금지·03-25 탐지 시행**(실 계정 정지 보고). OpenAI(Codex)만 회색(개인용 묵인, ToS 프로그래밍적 사용 조항과 긴장, 메인테이너 ToS 확답 회피).
- **유일한 ToS-안전 구독 경로 = 공식 CLI에 인증 위임.** 공식 바이너리가 자기 자격저장소에 토큰을 보관·사용하므로 Fleet은 자격증명을 만지지 않는다. 이는 Fleet의 **현행 CLI 세션 설계가 이미 채택한 모델**이다.
- 결론: Fleet이 가진 두 경로(**CLI 세션 = 구독**, **API 세션 = 키**)가 곧 opencode/antigravity의 두 선택지다. 본 작업은 **새 인증 메커니즘을 만드는 게 아니라**, 이 두 경로를 단일 가이드 흐름으로 통합하고 구독 분기의 설치/로그인 마찰을 *안내*로 완화한다.

## 2. 핵심 결정 (brainstorm)

| # | 결정 | 근거 |
|---|---|---|
| D1 | 스코프 = **picker + 가이드 설치/로그인**(번들 아님) | 설치 마찰 완화 vs 구현 비용 균형. CLI 번들/자동설치(방안 ③)는 별건·후속 |
| D2 | 프로바이더별 **위험 배너** | 세 CLI ToS 상태 상이(Anthropic 정당·Codex 회색·Gemini 위험). 안전-제일 = *고지*로 충족, 선택권 유지 |
| D3 | 로그인 구동 = **외부 터미널 + 재감지** | 신규 dep 0·비-TTY hang 없음·lean 3-dep 풋프린트 유지·ToS 안전. PTY(node-pty)는 ABI dep이라 회피 |
| D4 | UX 구조 = **가이드 통합 picker(provider-first)** | 사용자 명시 레퍼런스(opencode/antigravity)에 충실 |

## 3. 스코프

**In**

- SessionsPanel의 분리된 CLI/API 섹션 → 단일 `AddAiWizard` 가이드 흐름(provider-first)
- 인증 방식 선택(구독 / API 키), 프로바이더 지원분만 노출
- 구독 분기: CLI 감지 → 미설치 시 설치 *안내*(명령 + docs 링크 + 재확인) / 설치됨 시 로그인 *안내*(`claude login` 복사·터미널 열기 + 재감지)
- 프로바이더별 위험 배너

**Out (비목표)**

- Fleet 자체 OAuth (ToS 금지·서버 차단)
- CLI 번들/자동설치 (방안 ③ — 별건·후속)
- 로그인 성공의 완벽한 사전 검증 (§7 — 첫 사용 시 lazy 검증 유지)
- provider API 호출 로직·과금·모델 매핑 변경

## 4. UX 흐름

```
[+ AI 추가]
 └─ ① 프로바이더: Claude / Codex(OpenAI) / Gemini(Google) / OpenAI-호환
       └─ ② 인증 방식 (해당 프로바이더 지원분만 노출)
            ├─ 구독 (CLI 위임)
            │    ├─ [프로바이더별 위험 배너]  (§5)
            │    └─ CLI 감지(detectClis):
            │         · 미설치  → 설치 안내(install.hint 복사 + install.docsUrl 표시) · "재확인"(재감지=설치만 확인)
            │         · 설치됨  → 로그인 안내(auth.loginCommand **복사 전용** + auth.docsUrl 표시) · 터미널 자동실행 안 함(Codex P1: command-injection·ApprovalGate 우회 회피)
            │                     · "검증 없이 등록"(authStatus:unverified 명시) → registerCliSession(adapterId, {stateful?, model?, mcpConfig?})
            └─ API 키
                 └─ 키 입력 + 모델(라이브 조회 폴백 자유입력) + (anthropic) cacheTtl/effort
                     → registerApiSession(ApiProviderConfig)
```

기존 폼 상태/핸들러(`detect`·`registerCli`·`registerApi`·`listModels`·effort·cacheTtl)는 단계 안에서 그대로 재사용한다.

## 5. 프로바이더 × 인증 매트릭스 + 위험 배너

| 프로바이더 | 구독(CLI) | API 키 | 구독 배너 level / 문구 |
|---|---|---|---|
| Claude | ✅ `claude login` | ✅ | clean (정보성) — "공식 Claude Code CLI 인증을 그대로 사용. Fleet은 Claude 자격증명을 저장/읽지 않음" |
| Codex (OpenAI) | ⚠️ `codex login` | ✅ | caution — "Codex CLI 기존 로그인 사용. Fleet은 자격증명을 읽지 않음. 조직/상업/공유 환경은 OpenAI 약관·계정 정책 확인. 정책/플랜별 허용 범위가 달라질 수 있음 — API 키가 더 명시적" |
| Gemini (Google) | ⚠️ 위험 | ✅ | warning — "Gemini CLI의 Google 계정/OAuth 사용은 Google 정책·Gemini CLI 약관 적용. **제3자 소프트웨어의 OAuth 기반 자동화/우회 통합은 제한·탐지 대상이 될 수 있음**(2026-02 정책·03-25 탐지). 계정 리스크 회피 위해 **API 키 권장**. Fleet은 Google 자격증명을 저장/읽지 않음" + sub-issue 링크 |
| OpenAI-호환 | — (구독 분기 없음) | ✅ (+ baseUrl 필수) | — |

배너 데이터 = 프로바이더 → `{ level: 'clean'|'caution'|'warning', message, recommendApi: boolean, docsUrl? }` 정적 맵. 사용자는 배너 표시 중에도 강행 가능(선택권 유지).

> **문구 원칙(Codex P1 반영):** "비공식 묵인"·"확정 위반" 같은 *법률 단정*을 피하고, ① Fleet이 공식 CLI에 위임하며 자격증명을 만지지 않음 ② 사용자/조직 책임으로 정책·약관 확인 — 두 축을 분리해 *정책 리스크 안내*로 표현한다. 특히 Gemini는 "Fleet이 공식 CLI 호출하는 것"까지 확정 위반으로 단정하지 않는다(banned 패턴 = OAuth 토큰을 비공식 클라이언트로 재사용; 위임 호출은 회색).
>
> 표의 login 명령(`claude login`/`codex login`)은 **예시이며 §6대로 구현 단계에서 각 CLI 현행 동작으로 확정**한다(예: Claude Code는 `claude /login` 대화형·`claude setup-token` 헤드리스 등 변형 존재).

## 6. 아키텍처 (대부분 재사용 — 신규 런타임 dep 0)

- **렌더러(주 변경):** `SessionsPanel`의 등록 폼을 `AddAiWizard` 다단계 컴포넌트로 재구성. 단계 상태(선택 프로바이더·방식)만 신규, 나머지 핸들러·상태 재사용. 세션 목록·MCP·업데이터 UI는 불변.
- **어댑터 정적 데이터(신규 · IPC 직렬화 가능 · 함수 아님):** `CliAdapter`에 추가
  - `auth?: { loginCommand: string; docsUrl: string }` (claude=`claude login`, codex=`codex login`)
  - `install?: { hint: string; docsUrl: string }`
  - ⚠️ 정확한 login/install 명령은 구현 단계에서 각 CLI 현행 동작 재검증(claude/codex/gemini 버전별 상이 가능).
- **위험 배너 맵(신규):** 렌더러 상수(또는 `src/shared`) — provider → 배너 데이터.
- **재사용:** `detectClis`(`fleet:cli:detect`)·`registerCliSession`·`registerApiSession`·`secretCrypto`(API 키 OS 암호화)·`listModels`. **신규 IPC 채널 불요(v1)** — 아래 외부 링크 보안 계약을 지키기 위해.

### 6a. 외부 링크 보안 계약 (Codex P1)

Fleet은 renderer가 직접 내부 기능에 접근하지 못하게 preload→main→engine 으로 막고, window/nav 가드로 외부 이동을 차단한다. wizard의 설치/로그인 **문서 링크는 이 가드의 예외**이므로 다음을 강제한다:

- **v1 = copy-only.** `install.docsUrl`/`auth.docsUrl`·`loginCommand`는 **표시·복사만**(클릭 외부열기 없음) → 신규 IPC·외부열기 공격면 0.
- **클릭형 외부열기는 가드된 후속**: 도입 시 renderer 직접 열기 금지 → main의 좁은 IPC 경유 + **`https:` only** + **hostname allowlist**(정적):
  - Claude: `docs.anthropic.com`·`support.anthropic.com`·`claude.ai`
  - Codex/OpenAI: `developers.openai.com`·`help.openai.com`·`openai.com`
  - Gemini: `ai.google.dev`·`cloud.google.com`·`google-gemini.github.io`
  - (확정 도메인은 구현 시 재검증) · redirect 최종 URL까지 검증하거나 정적 상수만 허용.
- **`docsUrl`은 정적 registry 데이터만** — 사용자 입력·원격/AI 출력 비주입.
- UI는 **링크 텍스트와 실제 URL을 함께 표시**.
- **복사용 명령은 표시·복사 전용** — Fleet이 shell 로 실행하지 않는다(터미널 자동실행 비목표, D3).
- **PATH shadowing 고지:** `claude`/`codex`/`gemini` 바이너리가 악성 shadow일 수 있음. v1은 version/name 감지만, 후속으로 resolved path 표시 고려.

## 7. "로그인됨" 검증 갭 — 정직한 처리

`CliDetectionResult`는 `installed`/`version`만 보고하고 **로그인 상태 필드가 없다.** 따라서 재감지로는 *설치*만 확인 가능, *로그인 성공*은 싸게 확인 불가.

- **v1 = 낙관적 검증:** 설치 확인 → 로그인 안내(copy-only) → 세션 등록 → **인증은 첫 실제 사용 시 lazy 검증**(현행 CLI 세션 동작과 동일 — 추가 위험 0).
- **후속(비-v1) 여지:** "연결 테스트" 버튼 = 짧은 타임아웃 probe(`claude -p "ok"` 류). 비-TTY hang·비용 고려해 v1 제외.

### 7a. 인증 상태 계약 (Codex P1 — 블로커 해소)

재감지가 *설치*만 확인하므로 "등록됨 = 로그인됨"으로 **오인되면 안 된다**(설치됨·미로그인 / 만료 / 플랜권한 없음 / 첫 호출 interactive-prompt 실패 / auth-storage 손상 등이 전부 "등록됨"으로 뭉개질 위험). 따라서:

- **v1 정직성 = presentational 배지**: CLI 세션 카드는 `kind==='cli'` 기반으로 **상시** "로그인 상태 미검증 · 첫 메시지에서 인증 확인" 배지를 표시한다. **별도 저장 필드(`authStatus`)를 두지 않는다** — descriptor/store 확장 없이 표시 전용(Codex 계획리뷰 P1: 명명-구현 일치). 향후 실제 검증 상태를 저장하려면 그때 descriptor 확장.
- 등록 버튼 문구 = **"검증 없이 등록"**(또는 "첫 사용 시 확인") — "등록"만으로 로그인 완료 암시 금지.
- **"재감지" 버튼은 *설치* 재확인 의미로 라벨링**(로그인 확인 아님).
- **첫 사용 auth 실패 전용 라우팅 = 후속(§10)** — v1 정직성은 위 배지 + "검증 없이 등록" 문구가 담당한다(사용자 사전 고지). 실패 시 provider login recovery hint(일반 CLI 실패 대신 auth 안내)는 chat/run 에러 경로를 건드리는 별도 서브시스템이라 **picker v1 범위 밖**(Codex 권장은 최소 hint 포함이었으나, run 에러 경로 분리·solo pre-1.0 스코프 규율로 후속 결정). 기존 CLI 실행 계층의 timeout/kill-tree 보호는 유지.
- (선택, 비-v1) "연결 테스트" secondary action: 짧은 timeout·비용 고지·실패해도 등록 비차단. 테스트 없으면 "미검증"을 UI에서 숨기지 않는다.

## 8. 에러 / 엣지

- 구독 선택했는데 CLI 미설치 → 설치 안내 화면(블로킹 아님; "재확인"으로 재감지 루프).
- 위험 배너 표시 중 강행 → 허용(고지로 안전-제일 충족).
- API 키 빈 값/무효 → 기존 `registerApi` 에러 경로 재사용(렌더러 `error` 상태). API 키는 `secretCrypto` 암호화 저장 원칙 유지.
- OpenAI-호환에서 baseUrl 누락 → 기존 검증 재사용.
- 마법사 중도 이탈/취소 → 단계 상태 리셋, 기존 세션 목록·등록 무영향.
- **첫 사용 auth 실패/interactive-hang** → §7a auth 전용 오류 라우팅 + 기존 timeout/kill-tree 보호 유지.
- **외부 링크/PATH shadowing** → §6a 보안 계약(https-only·host allowlist·copy-only·정적 docsUrl).

## 9. 테스트

- **렌더러(vitest + 기존 패턴):** 마법사 단계 전이 · 프로바이더별 인증 방식 노출(예: openai-compatible은 구독 미노출) · 위험 배너 level 표시 · 구독 분기 미설치/설치됨 상태 분기.
- **어댑터 데이터(단위):** `auth`/`install` 필드 존재 · IPC 직렬화 안전(함수 비포함) 단언.
- **회귀:** `registerCliSession`/`registerApiSession` 계약 불변 · 기존 세션 등록 동작 보존.
- **e2e(선택):** 마법사 경유 API 세션 1건 등록 스모크(FLEET_E2E).

## 10. 미해결 / 후속

- CLI 번들/자동설치(방안 ③) — 설치 의존 *완전* 제거가 필요해지면 별도 스펙.
- "연결 테스트" probe(§7) — UX 요구가 생기면.
- Gemini CLI → Antigravity CLI 일몰 추적(별도 sub-issue) — 신규 어댑터 후보 모니터링.
- Codex/OpenAI ToS 회색 상태 변동 모니터링(Anthropic/Google 전철 가능성).

## 11. Codex 설계 리뷰 반영 (2026-06-25, #143)

Codex 클라우드 독립 리뷰(구현 없음·설계만, 판정 **"Request changes on spec only"**)의 P1 4건 전량 반영:

1. **인증 상태 계약**(§7a) — `authStatus:'unverified'`·"검증 없이 등록"·"미검증" 배지·"재감지=설치 확인"·첫 사용 auth 실패 전용 라우팅.
2. **외부 링크 보안**(§6a) — v1 copy-only·클릭 외부열기는 main IPC+https-only+host allowlist 가드 후속·정적 docsUrl·PATH shadowing 고지.
3. **배너 문구 정밀화**(§5) — 법률 단정 제거, 정책 리스크 안내로. Gemini "확정 위반" → "제한·탐지 대상 가능".
4. **D3 copy-only**(§2·§4) — 터미널 자동실행 비목표(command-injection·ApprovalGate 우회 회피).

방향(PTY 회피·신규 dep 0·CLI 위임·provider-first)은 solo pre-1.0 기준 타당 확인.

## 참고

- OAuth/ToS 조사 출처: The Register(Anthropic 차단)·GIGAZINE·gemini-cli Discussion #22970·openai/codex Discussion #8338·daveswift.com.
- 현행 코드: `src/main/core/cli/registry.ts`(어댑터)·`src/renderer/components/SessionsPanel.tsx`(등록 UI)·`src/main/core/secret/types.ts`(SecretCrypto)·`src/preload/index.ts`(IPC).

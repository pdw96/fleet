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
            │         · 미설치  → 설치 안내(install.hint + install.docsUrl) · "재확인"(재감지)
            │         · 설치됨  → 로그인 안내(auth.loginCommand 복사 + 터미널 열기 + auth.docsUrl)
            │                     · "로그인을 마쳤습니다 → 등록" → registerCliSession(adapterId, {stateful?, model?, mcpConfig?})
            └─ API 키
                 └─ 키 입력 + 모델(라이브 조회 폴백 자유입력) + (anthropic) cacheTtl/effort
                     → registerApiSession(ApiProviderConfig)
```

기존 폼 상태/핸들러(`detect`·`registerCli`·`registerApi`·`listModels`·effort·cacheTtl)는 단계 안에서 그대로 재사용한다.

## 5. 프로바이더 × 인증 매트릭스 + 위험 배너

| 프로바이더 | 구독(CLI) | API 키 | 구독 배너 level / 문구 |
|---|---|---|---|
| Claude | ✅ `claude login` | ✅ | clean (배너 없음 또는 정보성) |
| Codex (OpenAI) | ⚠️ `codex login` | ✅ | caution — "비공식 묵인 경로 — 개인 단일 구독 사용 한정. 계정 풀링·상업 배포는 OpenAI ToS상 불명확" |
| Gemini (Google) | ⚠️ 위험 | ✅ | warning — "third-party 도구의 Gemini CLI OAuth = Google ToS 위반·계정 패널티 위험(2026-02 금지·03-25 탐지). **API 키 사용 권장**" + sub-issue 링크 |
| OpenAI-호환 | — (구독 분기 없음) | ✅ (+ baseUrl 필수) | — |

배너 데이터 = 프로바이더 → `{ level: 'clean'|'caution'|'warning', message, recommendApi: boolean, docsUrl? }` 정적 맵. 사용자는 배너 표시 중에도 강행 가능(선택권 유지).

> 표의 login 명령(`claude login`/`codex login`)은 **예시이며 §6대로 구현 단계에서 각 CLI 현행 동작으로 확정**한다(예: Claude Code는 `claude /login` 대화형·`claude setup-token` 헤드리스 등 변형 존재).

## 6. 아키텍처 (대부분 재사용 — 신규 런타임 dep 0)

- **렌더러(주 변경):** `SessionsPanel`의 등록 폼을 `AddAiWizard` 다단계 컴포넌트로 재구성. 단계 상태(선택 프로바이더·방식)만 신규, 나머지 핸들러·상태 재사용. 세션 목록·MCP·업데이터 UI는 불변.
- **어댑터 정적 데이터(신규 · IPC 직렬화 가능 · 함수 아님):** `CliAdapter`에 추가
  - `auth?: { loginCommand: string; docsUrl: string }` (claude=`claude login`, codex=`codex login`)
  - `install?: { hint: string; docsUrl: string }`
  - ⚠️ 정확한 login/install 명령은 구현 단계에서 각 CLI 현행 동작 재검증(claude/codex/gemini 버전별 상이 가능).
- **위험 배너 맵(신규):** 렌더러 상수(또는 `src/shared`) — provider → 배너 데이터.
- **재사용:** `detectClis`(`fleet:cli:detect`)·`registerCliSession`·`registerApiSession`·`secretCrypto`(API 키 OS 암호화)·`listModels`. 신규 IPC 채널 불요(v1).

## 7. "로그인됨" 검증 갭 — 정직한 처리

`CliDetectionResult`는 `installed`/`version`만 보고하고 **로그인 상태 필드가 없다.** 따라서 재감지로는 *설치*만 확인 가능, *로그인 성공*은 싸게 확인 불가.

- **v1 = 낙관적 검증:** 설치 확인 → "로그인 안 했다면 `claude login` 하세요" 안내 → 세션 등록 → **인증은 첫 실제 사용 시 lazy 검증**(현행 CLI 세션 동작과 동일 — 추가 위험 0).
- **후속(비-v1) 여지:** "연결 테스트" 버튼 = 짧은 타임아웃 probe(`claude -p "ok"` 류). 비-TTY hang·비용 고려해 v1 제외.

## 8. 에러 / 엣지

- 구독 선택했는데 CLI 미설치 → 설치 안내 화면(블로킹 아님; "재확인"으로 재감지 루프).
- 위험 배너 표시 중 강행 → 허용(고지로 안전-제일 충족).
- API 키 빈 값/무효 → 기존 `registerApi` 에러 경로 재사용(렌더러 `error` 상태).
- OpenAI-호환에서 baseUrl 누락 → 기존 검증 재사용.
- 마법사 중도 이탈/취소 → 단계 상태 리셋, 기존 세션 목록·등록 무영향.

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

## 참고

- OAuth/ToS 조사 출처: The Register(Anthropic 차단)·GIGAZINE·gemini-cli Discussion #22970·openai/codex Discussion #8338·daveswift.com.
- 현행 코드: `src/main/core/cli/registry.ts`(어댑터)·`src/renderer/components/SessionsPanel.tsx`(등록 UI)·`src/main/core/secret/types.ts`(SecretCrypto)·`src/preload/index.ts`(IPC).

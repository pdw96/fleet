# #221 웹모드 렌더러 전체 모바일 반응형 — 구현 계획 (판사 패널 합성판)

- **스펙(권위)**: `docs/superpowers/specs/2026-07-13-issue221-mobile-responsive-design.md` (r3 · Codex 체크포인트 clean)
- **날짜**: 2026-07-13

## 판사 패널 판정 요약 (fleet-planner ×3 → fleet-plan-judge ×2)

| 판사(렌즈 그룹) | A(리스크) | B(MVP) | C(계약) | 승자 |
| --- | --- | --- | --- | --- |
| 공백 그룹(동적 검증 실효·커버리지·과설계) | 48 | 40 | **50** | C |
| Codex 강점 그룹(계약 drift·경계값·ripple·기존 테스트) | 51 | 41 | **56** | C |

**판정: 승자 일치 = 초안 C(계약 우선) 골격 채택.** 근거 — C만이 표본 검증에서 전부 참으로 확인된
실존 결함 4건을 적발(기존 C2 `flex-wrap` 핀 공허 · `.update-banner` fixed→scrollWidth 단언 blind ·
`.rooms` 비-버튼 자식 처리 공백 · approval-hold 절대 기하 단언 파손 리스크). 이식(A: RED 정직성
메타규칙·`test.fail()` 규율·`:606` 스윕·1280 기준선·`.summary` 정정 기록 / B: 미감 시작값 표·의도적
위반 mutation 검증·라이브 체크리스트 3항목)과 판사 공통 결함 보강 3건(프로젝트 시드 확장·배너 e2e
기계화·스크롤 성능 항목) 및 C 자체 수정 1건(R10 핀 완화 — 스펙 §6-3 충돌 해소)을 반영했다.
초안 B의 "기존 web e2e가 데스크톱 무회귀 겸임" 가정은 두 판사 모두 반증(approval-hold/handoff가
390×844 폰 뷰포트) — 본 계획은 명시적 데스크톱 가드(R1)를 채택한다.

- 검증 명령 약칭: `VERIFY` = `npm run verify`(7게이트) · `E2E-WEB` = `npm run build && npx playwright test --project=web` · `E2E-ALL` = `npm run test:e2e`.
- 브랜치: PR1 = 현 `feat/issue221-mobile-responsive` 승계 · PR2 = 별도 브랜치. PR1 본문 `Part of #221` · PR2 본문 `Closes #221`.
- **표기 정정(스펙 대비·이식 A)**: 스펙 §2/§6의 `pre.summary`는 실물 셀렉터 `.summary`(styles.css:935 — JSX `<pre className="summary">`)를 가리킨다. 구현·핀은 `.summary`를 대상으로 한다(`pre.summary` 신설 금지 — 특이도 상승으로 캐스케이드 변경). PR2 마감 시 이슈 코멘트로 기록.

## 공통 규율 (전 태스크)

- diff 규율 = 스펙 §6: "diff ⊆ {640px 블록} ∪ {열거 예외}". 각 예외는 PR 본문에 데스크톱 no-op 근거 기재.
- **RED 정직성 메타규칙(이식 A)**: 구현 0줄 상태에서 RED여야 할 단언이 PASS면 그 단언을 blind로
  판정하고 조사·교체한다(예: scrollWidth 단언이 스크롤 컨테이너를 잘못 잡은 경우).
- **RED 커밋 규율(이식 A)**: RED 상태로 커밋되는 e2e 케이스는 `test.fail()` 마킹(실패=정상 기계 선언
  · GREEN 전환 시 자동 경보) — GREEN 화 태스크에서 해제.
- **사후 단언 mutation 규율(이식 B)**: 스타일 완료 후 작성돼 즉시 GREEN인 단언은 의도적 위반 삽입으로
  RED 1회 확인 후 원복(핀 실효성 증명). **위반 스캐폴딩은 커밋 금지 — 로컬 확인 후 완전 원복**(Codex 계획 1R 노트).
- **미감 수치 시작값(이식 B)** — 핀 금지·라이브 실측 조정 대상: topbar gap 12px·topbar padding 10px
  14px·main padding 14px·body 14px·캡션(chip/field-label/eyebrow) 11px·자간 0.08~0.12em급.
  계약 수치(핀 대상)는 640px 브레이크포인트·44px·16px·dvh 병기·additive safe-area뿐.
- brain: src 커밋 → `npm run brain` 재생성 → 별도 커밋(모든 src 변경 후 최종 — lint-staged stale 함정).
  푸시 전 `npm run format:check`.
- 640px 신규 규칙은 기존 C2 블록(:1094)과 **별도 블록**으로 신설(C2 블록 내부 무수정 — 예외:
  `.modal-actions` safe-area 1줄). 통합 리팩터링 금지.

## 1. 계약 목록

### A. 스펙 명시 계약 → 게이트

| ID | 계약 | 게이트 | PR |
|---|---|---|---|
| **G1** | 폰(390×844) 가로 스크롤 0 — `.main` 기준 | e2e: 탭별 `.main.scrollWidth <= .main.clientWidth` — PR1=세션 탭만, 채팅/프로젝트는 `test.fail()`+사유 주석, PR2 활성화 | 1→2 |
| **G2** | topbar/footer 오버플로 0 | e2e: `documentElement.scrollWidth <= innerWidth`(3탭·PR1부터) | 1 |
| **G3** | 내비 3탭 폰 폭 수용 | e2e: `.nav-btn` ×3 boundingBox 뷰포트 사각형 안 — **360×740 컨텍스트 포함**(스펙 "360px 수용" 문면) | 1 |
| **G4** | 터치 타깃 ≥44px | e2e: PR1=`.nav-btn`·위저드 버튼·`.btn` height≥44 / PR2=`.room-btn`·`.ask-btn`·`button.chip`. 아이콘성(채팅 `+`)은 width≥44도 | 1→2 |
| **G5** | 폼 필드 computed 16px(iOS 줌) | e2e: `getComputedStyle` — input·select·textarea 표본(새 방 이름·composer·goal textarea) | 1·2 |
| **G6** | dvh 병기·safe-area additive | vitest CSS-핀(신설 `src/renderer/styles.responsive.test.ts`): ① vh 선행·dvh 후행 순서 regex(`.app`·`.chat`) ② `env(safe-area-inset` 전 출현이 `max(`/`calc(` 내부 + 출현 ≥4 하한(vacuous 방지) ③ 대상 4셀렉터(`.topbar`·`.footer`·`.update-banner`·`.modal-actions`) 각각에 존재 ④ `padding: env(` 단독 치환 부재 네거티브 단언 | 1 |
| **G7** | viewport meta 확장 | vitest: `viewport-fit=cover`·`interactive-widget=resizes-content` 존재 + **CSP meta 불변**(형제 계약) | 1 |
| **G8** | `.summary` 긴 토큰(전 뷰포트 결함 수정) | vitest 핀: `.summary`에 `overflow-wrap: break-word` + e2e(PR2): 완주 러너(`FLEET_E2E_RUNNER:'complete'`) 요약 표시 후 G1 커버(요약이 짧으면 evaluate로 긴 무공백 문자열 주입 — 주석 의무) | 1핀·2e2e |
| **G9** | `.chat`·`.project-layout` 폰 1열 | vitest 핀(640px 블록 내 `1fr`) + e2e G1 활성화 | 2 |
| **G10** | `.rooms` 칩 스트립 하드 계약(채팅) | e2e: UI 경로(`새 방 이름` fill + `+` 버튼(.btn.btn-sm — '만들기' 아님) 반복)로 방 3개+ 생성·개수 ≥4 선단언 → `.chat .rooms` `scrollWidth > clientWidth` → 실 스크롤 후 마지막 `.room-btn` boundingBox 뷰포트내 → 클릭 → `data-active` 전이 | 2 |
| **G10b** | `.rooms` 칩 스트립 하드 계약(프로젝트 — 판사 공통 결함 보강 · **Codex 계획 1R 반영: 생성 메커니즘 확정**) | **UI 경로 + `complete` 러너**: mobile e2e 전용 서버를 `FLEET_E2E_RUNNER: 'complete'`(web-orchestration:70 선례)로 기동 → goal 입력+실행을 3회+ 반복(결정론 완주·hang 러너 in-flight 오염 없음) → 프로젝트 탭 `.rooms`에 G10 동형 단언. **근거**: `FleetEngine`엔 공개 `createProject`가 없고(`listProjects`/`runProjectFlow`만), `seedE2eFixtures(engine)`는 store 미접근 — 시드 확장은 엔진 표면 확대 또는 boot 배선 파급이라 기각. 스펙 파일별 독립 서버(startFleetWebServer)라 기존 e2e 무영향·`src/main/e2e.ts` 무변경. 런 3회 러닝타임이 과중하면(§6 리스크 표) 2건+지연 계약으로 완화하고 기록 | 2 |
| **G11** | `.grid-2` 폰 1열(elicitation:395·manual:534) | vitest 핀 + e2e: goal 입력 가능(manual 경로) — elicitation은 런 중 발화라 핀+라이브 | 2 |
| **G12** | 채팅 composer 뷰포트내 앵커 | e2e: 방 선택 후 composer boundingBox 뷰포트 사각형 안 | 2 |
| **G13** | verify·기존 e2e 전량 무회귀 | `VERIFY` + `E2E-ALL` — 각 PR 머지 전 | 1·2 |

### B. 암묵 파급 → 계약 승격

| ID | 파급(실측) | 계약화 |
|---|---|---|
| **R1** | 데스크톱 무회귀가 사람 리뷰 위임 — 기존 web e2e 중 approval-hold/handoff는 **390×844 폰 뷰포트**(데스크톱 겸임 가정 반증·판사 양측 확인) | e2e 데스크톱 가드: **641×900**(경계 최소 초과)에서 `.topbar` computed gap 28px·body 13px(PR1)·`.chat`/`.project-layout` `232px` 칼럼(PR2) + **1280×800 대표 해상도 1컨텍스트**(이식 A) |
| **R2** | 기존 C2 `flex-wrap: *wrap` 핀(ApprovalModal.test.tsx:678)은 css 전문 매치라 `.tool-steps`:838·`.chiprow`:873에 이미 매치 = **기공허** | PR1에서 640px 블록 substring 추출 헬퍼로 스코프 강화(`.modal-actions` 규칙 한정). 강화분은 즉시 GREEN → mutation 규율 1회 적용(이식 B) |
| **R3** | approval-hold e2e의 절대 기하 단언(:97-101 `x≤1`·`width≥388`·`840≤bottom≤846`) — `.modal-actions` safe-area가 기하를 바꾸면 파손 | safe-area는 `max(기존값, env(...))`만(에뮬 env()=0 → 기하 불변) + 예외 구현 직후 approval-hold/handoff 표적 재실행 |
| **R4** | `.rooms` 형제 2곳(ChatPanel:355·ProjectPanel:356) + ChatPanel `.rooms` 자식에 **비-버튼**(eyebrow·방 생성 `.row`) 포함 | 스트립 CSS에 비-버튼 자식 처리 명시(`flex: 0 0 auto`·input min-width — CSS-only) · 양 패널 e2e(G10·G10b) |
| **R5** | `.update-banner`(ConnectionBanner 공유)는 `position: fixed` → G2 단언이 구조적으로 blind | vitest 핀(폭 캡 존재) + **e2e 기계화(판사 공통 결함 보강)**: web-orchestration:46-63 단절 하니스 재사용 — 배너 표시 중 `boundingBox.width ≤ 390` 단언(과중하면 핀+라이브 강등·기록) |
| **R6** | 인라인 고정폭 **5곳**: ProjectPanel:444(220)·:456(160)·ChatPanel:458(64)·SessionsPanel:257(minWidth 116)·**ProjectPanel:606(minWidth 62 — 이식 A·무해 판정 기록)** | 640px 블록 `.row{flex-wrap:wrap}` + `max-width:100%`(인라인 width를 이기는 별개 속성) |
| **R7** | `.wizard` 래퍼로 SessionsPanel 줄수 변경 → brain.md stale | `VERIFY`의 brain:check + 공통 규율 순서 |
| **R8** | 래퍼가 기존 테스트 파손? | 실측: AddAiWizard/SessionsPanel test는 role/label 쿼리만 — **무수정 green 유지가 무회귀 신호**(수정 필요 발생 = §5 위반 신호) |
| **R9** | approval-handoff(390×844)가 PR1 셸 변경 영향권 | `E2E-WEB` 전량 게이트(신규 단언 불요) |
| **R10** | reduced-motion — 기존 전역 블록이 신규 애니 자동 커버 | vitest 핀: **640px 블록 밖** `@media (prefers-reduced-motion` 출현 = 기존 2곳(:991·:1149) 고정(판사 양측 지적 반영 — 블록 안 중첩은 스펙 §6-3 허용이라 자유) |

## 2. PR1 태스크 — 전역 레이어 + 앱 셸 + 위저드 (`Part of #221`)

> 순서: T1·T2(게이트 수립·RED) → T3(예외 구현) → T4(640px 셸) → T5(위저드) → T6(봉인).
> 판정기 선행 근거(초안 A): 구현이 들어간 뒤에는 "RED 미발화가 구현 덕인지 단언 blind인지" 구분 불가.

### T1 — vitest 계약 하네스 신설 + 기존 핀 강화 (RED)
- **파일**: `src/renderer/styles.responsive.test.ts`(신설 — ApprovalModal.test.tsx:670 `readFileSync` 패턴·index.html도 로드) · `src/renderer/components/ApprovalModal.test.tsx`(R2 스코프 강화만·완화 금지).
- **블록 추출 헬퍼 강건성(Codex 계획 1R 노트)**: `@media (max-width: 640px)` 블록이 T4 이후 **2개**(C2 승인 블록 + 신설 셸 블록)가 되므로, naive first-match 추출은 승인 블록만 검사하는 blind가 된다 — 블록 식별을 내부 마커 셀렉터(예: C2=`.modal-overlay`·셸=`.topbar`) 또는 전 블록 수집 후 합집합 검사로 설계.
- **RED**: G6·G7·G8핀·R5핀·R6핀·R10 전부 FAIL 확인. R2 강화분은 즉시 GREEN → mutation 1회.
- **검증**: `npx vitest run src/renderer/styles.responsive.test.ts src/renderer/components/ApprovalModal.test.tsx`

### T2 — e2e 하네스 신설 `e2e/mobile-responsive.web.e2e.ts` (RED)
- **구성**: `startFleetWebServer` 재사용·`emulateMedia({reducedMotion:'reduce'})`·측정 전 `document.fonts.ready` 대기. ① 390×844: 3탭 G2 + 세션 탭 G1(채팅/프로젝트 `test.fail()`+사유 주석) + G3 + G4(PR1 표적) + G5 ② 360×740: G3 재단언 ③ 641×900 + 1280×800: R1 데스크톱 가드(즉시 GREEN — 현행 값 핀).
- **RED**: topbar 오버플로·`.nav-btn` ≈30px(:216 패딩 7px)로 실발화 확인. **PASS인 단언은 메타규칙 발동**(blind 조사·교체).
- **검증**: `npm run build && npx playwright test e2e/mobile-responsive.web.e2e.ts --project=web`

### T3 — §6 열거 예외 구현 (T1 부분 GREEN)
- **파일**: `index.html`(:5 meta 확장) · `styles.css`(`.app`:159·`.chat`:631 dvh 병기 / safe-area additive: `.topbar`·`.footer`·`.update-banner`·`.modal-actions`(C2 블록 내 1줄) / `.summary`:935 overflow-wrap).
- **GREEN**: T1 예외 핀 + **직후 `npx playwright test e2e/approval-hold.web.e2e.ts e2e/approval-handoff.web.e2e.ts --project=web`**(R3 기하 불변 즉시 확인).
- **커밋**: 예외 전용 단일 커밋(롤백 단위 — 초안 A 근거: 전 뷰포트 diff는 revert 대상이 명확해야).

### T4 — ≤640px 셸 블록 신설 (T2 GREEN 본체)
- **파일**: `styles.css` — C2 블록과 별도 신규 640px 블록: `.topbar`(gap·padding 축소·`.brand .tag` 숨김·`.live` 축소) / `.nav-btn` 44px / `.main`·`.footer` padding 축소 / 타이포 스케일(시작값 표) / 터치 타깃 전역(`.btn`·`.btn-sm`·`.room-btn`·`.ask-btn`·`button.chip`·`.field` min-height 44 + 아이콘성 min-width 44) / 폼 16px / `.row{flex-wrap:wrap}`+`max-width:100%`(R6) / `.update-banner` 폭 캡(R5).
- **GREEN**: T2 전 단언(641/1280 가드 포함). 데스크톱 body 13px 불변은 R1이 핀.
- **검증**: T2 명령 + `npx vitest run src/renderer/styles.responsive.test.ts`

### T5 — `.wizard` 래퍼 + 위저드 모바일 스타일 (G4 위저드 GREEN)
- **파일**: `SessionsPanel.tsx:153` → `<div className="wizard">…</div>`(유일 마크업 변경) · `styles.css` 640px 블록(`.wizard` 하위 bare input/button/label 폭 100%·44px·간격) · `SessionsPanel.test.tsx`(래퍼 존재 단언 — RED 먼저).
- **검증**: `npx vitest run src/renderer/components/`(R8 — AddAiWizard/SessionsPanel test 무수정 green) + T2 e2e 재실행(`test.fail()` 세션 탭 위저드 표적 해제).

### T6 — 무회귀 봉인·brain·PR 본문
- `E2E-ALL` → `VERIFY` → brain 재생성·별도 커밋 → PR 본문: §6 예외별 no-op 근거 표 + 실측 브라우저/OS 버전.
- **잔여**: 라이브 폰 실측(§5 체크리스트 PR1) → 자체 적대 리뷰(§6 diff 렌즈) → PR open → Codex 대기
  (**폴링: `.reviews`+`.comments`+reactions 3채널·login `chatgpt-codex-connector[bot]`·since=트리거 created_at**) → 스레드 resolve → 사용자 확인 → squash.

## 3. PR2 태스크 — 패널 3 + 폼 (`Closes #221`)

### T1 — e2e 계약 확장 (RED)
- ① PR1 `test.fail()` 해제(채팅·프로젝트 `.main` — RED 실발화 확인: `.chat` 232px 강제) ② G10 하드 계약 ③ **G10b: `complete` 러너 서버에서 UI 경로로 프로젝트 3회+ 생성·완주 후 스트립 단언**(Codex 계획 1R — `src/main/e2e.ts` 무변경·엔진 API 무확대·`isE2EActive` 가드 불변. G8 e2e와 같은 `complete` 서버 인스턴스를 공유해 러닝타임 절약) ④ G11 ⑤ G12 ⑥ G8 e2e(완주 러너 — G10b와 서버 공유) ⑦ R1 확장(641·1280에서 `.chat`/`.project-layout` 232px) ⑧ R5 e2e(단절 하니스 배너 폭).
- **검증**: `npm run build && npx playwright test e2e/mobile-responsive.web.e2e.ts --project=web` → 신규 RED 확인.

### T2 — vitest 핀 확장 (RED)
- `styles.responsive.test.ts`: 640px 블록 내 `.chat`/`.project-layout` `1fr`·`.rooms` `overflow-x: auto`·`.grid-2` 1열.

### T3 — 채팅/프로젝트 스택 + `.rooms` 스트립 (GREEN 코어)
- `styles.css` 640px 블록: `.chat`·`.project-layout` → `1fr`·`.chat` height dvh 재계산(160px 상수는
  타이포 상향 후 실측 재결정 — C 충돌 5·`min-height:460px` 상호작용 포함) / `.rooms` →
  `display:flex; overflow-x:auto` + **비-버튼 자식 처리**(R4: eyebrow·생성 `.row`에 `flex:0 0 auto`·
  input min-width) / `.room-btn` `flex:0 0 auto`·max-width 캡·기존 ellipsis 유지.
- **ripple**: `.project-layout .room-btn`(styles.css:708 justify+`.proj-status`)이 스트립에서도 유지 —
  web-orchestration:86 `.proj-status` 단언 무회귀(`E2E-WEB` 전량).

### T4 — 프로젝트 폼·로그·세션 패널·CLI/MCP 폼 (GREEN 잔여)
- `.grid-2` 1열 / `.log`·`.summary` 오버플로 정돈 / `.line-item` 랩(SessionsPanel:166 인라인 flexWrap
  기존재 — CSS 승격만·JSX 무변) / 03/04 섹션 `.field`·textarea 폭 100%·라벨 줄바꿈.

### T5 — 봉인·brain·이슈 마감
- `E2E-ALL` → `VERIFY` → brain(PR2는 src 변경 0 예상 — `brain:check`로 확인만) → PR 본문(no-op
  근거·브라우저/OS 버전) → 이슈에 `.summary` 표기·그래프 뷰 stale 정정 코멘트 → 라이브 실측(§5 PR2)
  → 자체 적대 리뷰 → PR open(`Closes #221`) → Codex → 사용자 확인 → squash.

## 4. 계약 충돌/해소 (승계 + 판정 반영)

1. C2 블록 vs 신설 블록 — 의도적 분리·통합 금지(R2·R3 게이트가 감시).
2. R10 — 640px 블록 밖 출현 고정으로 완화(§6-3 허용 존중 — 판사 양측 지적).
3. G2 vs fixed 배너 — R5 핀+e2e로 봉합.
4. G4 규칙 선행(PR1) vs 단언 후행(PR2) — 블록 내부라 무해·명시 규율.
5. 타이포 상향 × `.chat` 160px 매직넘버 — PR2 T3 실측 재결정.

## 5. 라이브 폰 실측 체크리스트 (기계 검증 불가 잔여 계약)

**PR1**(실 CF Access 터널·브라우저/OS 버전 PR 본문 기록):
- [ ] 3탭 가로 스크롤 없음·탭 전환(오탭 없음)
- [ ] 주소창 표시/숨김 전환 시 footer 안정(dvh 실효 — 이식 B)
- [ ] 재접속 배너(백그라운드 탭 복귀) 폰 폭 안 표시(R5 잔여)
- [ ] 노치/홈바 기기 safe-area 겹침 없음 + **C2 승인 바텀시트 무회귀**(viewport-fit=cover 효과 — destructive 승인 1회 유발 확인)
- [ ] 위저드 세션 등록 완주·입력 포커스 시 iOS 자동 줌 미발생
- [ ] 빈 상태(세션 0) 셸 확인(이식 B — e2e 미커버)
- [ ] **스크롤 버벅임 체감 확인**(판사 A 공백 발견: `background-attachment: fixed`(:116)+fixed 비네팅(:123) — jank 시 640px 블록에서 `background-attachment: scroll` 강등 커밋)

**PR2**(= 이슈 완료 정의):
- [ ] 세션 개시·프로젝트 런 모니터·설정 가로 스크롤 없이 조작
- [ ] **키보드 연 상태 채팅 입력 — 필수·생략 불가**(iOS 실기기) + **Android Chrome에서 `interactive-widget` 실효 확인**(판사 보강 — 키보드가 layout viewport를 줄여 composer 가시)
- [ ] 칩 스트립 실손가락 스크롤·마지막 룸 도달(모멘텀 체감)
- [ ] elicitation 폼(런 중 발화) 1열 표시
- [ ] `.summary` 긴 토큰 줄바꿈 실확인
- [ ] 데스크톱 와이드 병행 시각 스팟체크(이식 B)

## 6. 리스크·롤백

| 리스크 | 방어 | 롤백 |
|---|---|---|
| 데스크톱 회귀 | R1 기계 가드(641·1280)+§6 diff 규율+기존 e2e 전량 | 640px 블록 삭제=즉시 원상(로직 diff는 래퍼 1줄) |
| C2 표면 파손 | R2 강화·R3 표적 재실행·C2 블록 무수정 | `.modal-actions` 1줄 revert |
| e2e flake | fonts.ready+reducedMotion 전 테스트 공통 | — |
| G10b 런 3회 러닝타임 과중 | `complete` 러너는 결정론 즉시 완주 + G8과 서버 공유 — 과중 시 2건+지연 계약 완화·기록 | mobile e2e 케이스만 조정(제품 코드 무영향) |
| 라이브서 레이아웃 버그(C2 선례) | 각 PR 라이브 관문·미감 수치 미핀(조정 diff 최소) | 값 조정 커밋(테스트 불변) |
| brain stale | R7 규율 | 재생성 재커밋 |
| e2e 러닝타임 증가(판사 인지 항목) | 컨텍스트 4종(390/360/641/1280)·완주 러너 — 현 web 4파일 규모라 수용, PR2 T5에서 실측 시간 기록 | — |

## 7. 실행 인계

superpowers:subagent-driven-development 로 태스크 단위 실행(태스크별 적대 리뷰는 자체
fleet-finder/refuter — 스펙 §8). 체크포인트: 본 계획을 이슈 #221 코멘트로 게재 + `@codex review`
(순수 한 줄) → clean 후 PR1 T1 착수.

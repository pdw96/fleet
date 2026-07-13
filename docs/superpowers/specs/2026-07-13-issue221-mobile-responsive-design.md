# #221 웹모드 렌더러 전체 모바일 반응형 — 설계 스펙

- **이슈**: #221 (tier:next · area:renderer · enhancement)
- **날짜**: 2026-07-13 (r3 — r2: 로컬 fleet-refuter 4렌즈 P1×1·P2×8 반영 / r3: Codex 체크포인트 1R 3건 반영 — 위저드 PR1 이동·`.rooms` e2e 하드 계약·키보드 실측 필수화)
- **선행**: #216 C2(승인 카드 바텀시트 — PR #220)가 유일한 폰 분기. 본 작업은 그 패턴을 앱 전체로 확장.
- **전략 결정(사용자 승인)**: CSS-only 미디어쿼리 · 2-PR 분할 · 채팅 탭 포함.

## 1. 배경 / 문제

Phase B(#197) 웹모드는 데스크톱 렌더러를 반응형 없이 재사용했다. `src/renderer/styles.css`(1,177줄)의
폭 기반 미디어쿼리는 C2 승인 모달 `@media (max-width: 640px)` 하나뿐. 폰 브라우저(실 CF Access 터널)에서
topbar·패널·폼이 데스크톱 비율로 렌더돼 가로 스크롤·작은 텍스트·좁은 터치 타깃으로 실사용이 어렵다.
v3(#193) 목표 "어디서든 브라우저로"는 승인 카드만이 아니라 앱 전체가 폰에서 쓸 만해야 성립한다.

## 2. 현황 실측 (2026-07-13 코드 기준)

- **앱은 이미 탭 기반** — `App.tsx`(118줄): topbar(브랜드+세그먼트 내비 3탭+라이브 카운터) → main(탭별 패널 1개) → footer. 앱 수준 사이드바 없음 → 햄버거/바텀탭 등 모바일 내비 신설 불필요(이슈 본문의 해당 항목은 과대 스코프).
- **스크롤 아키텍처(검증 설계의 전제)**: `body { overflow: hidden }`(styles.css:119) + `.main { overflow: auto }`(:277) — 패널 계층의 가로 오버플로는 전부 `.main`이 트랩하고 **문서 루트 scrollWidth에 도달하지 않는다**. 가로 스크롤 단언은 `.main`(및 내부 스크롤박스) 기준이어야 한다(§8).
- **폰에서 깨지는 근본 원인 목록**:
  - `.app { height: 100vh }` — 모바일 주소창 수축 미대응(dvh 필요). 단 문서 스크롤이 없는 셸이라 주소창이 접히지 않아 dvh≈svh로 안정적.
  - `.topbar { gap: 28px; padding: 16px 26px }` + `.brand .tag`(자간 0.26em 캡션) — ≤400px 오버플로.
  - `.chat { grid-template-columns: 232px 1fr; height: calc(100vh - 160px) }` — 사이드바 강제 + vh.
  - `.project-layout { grid-template-columns: 232px 1fr }` — 동일.
  - `.grid-2 { grid-template-columns: 1fr 1fr }` — 폼 2열 강제(사용처는 ProjectPanel의 elicitation·manual 역할 배정 — 전역 규칙으로 처리).
  - `.main { padding: 26px }` · `.wrap { max-width: 1180px }` — 폰에서 여백 과다.
  - **타이포**: body 13px·`.chip`/`.field-label` 10px(자간 0.18~0.26em) — 이슈가 명시한 "텍스트가 작고" 표면.
  - 터치 타깃: `.nav-btn`(7px 패딩)·`.btn-sm`·`.room-btn`·`.ask-btn`(채팅 주 조작 ≈30px)·`button.chip`(capability 토글 ≈20px) 등 44px 미달.
  - **긴 무공백 토큰**: `pre.summary`(:935)는 `pre-wrap`만 있고 `overflow-wrap` 없음 — LLM 요약의 긴 경로/URL이 04—SUMMARY 패널을 뚫고 `.main` 가로 스크롤 직행(§3 직접 위반 표면).
  - **인라인 고정폭**: `.row`(flex-wrap 없음) 안 인라인 `width:220/160`(ProjectPanel)·`width:64`(ChatPanel)·`minWidth:116`(SessionsPanel) — 인라인 style은 미디어쿼리 셀렉터로 못 이기지만, `flex-wrap: wrap` + `max-width: 100%`(width와 별개 속성이라 인라인 width를 이긴다)로 우회 가능.
  - **ConnectionBanner(웹 전용)**: `.update-banner` 클래스 재사용(App.tsx:113·styles.css:1155 — fixed·bottom 48px·max-width 없음·safe-area 없음). 폰 백그라운드 탭 전환마다 WS 재접속 배너가 뜨는 최빈 표면인데 폭 제약이 없다.
  - `AddAiWizard.tsx`(491줄): 스텝별 early-return으로 bare `<div>` 루트가 **4개**(:148·:166·:183·:399) — 스타일 훅 부재.
- **viewport meta는 이미 존재**(`width=device-width, initial-scale=1.0`) — `viewport-fit=cover`·`interactive-widget` 미포함.
- **이슈 본문 정정**: "채널/그래프 뷰(`force-graph` 터치·크기 대응)"는 stale — `force-graph`는
  `scripts/brain/build.mjs`(dev 시각화 `fleet-brain.html`, gitignore) 전용이며 앱 renderer에서 미사용
  (레포 전수 grep: package.json + scripts/ 뿐, src/ 0건). 스코프 제외(이슈 코멘트로 정정 기록).
- **e2e 기반 존재**: playwright `web` 프로젝트(`playwright.config.ts` testDir `./e2e` · testMatch `*.web.e2e.ts`) + `e2e/web-server.ts`(FLEET_E2E=1 시드: CLI 세션 2·룸 1·워크스페이스). 컨텍스트/페이지 단위 뷰포트·reduced-motion 에뮬 선례가 이미 있다(approval-handoff·approval-hold).

## 3. 목표

폰 브라우저(≤640px)에서 세션 개시 · 프로젝트 런 모니터 · 채팅 · 설정(위저드·CLI/MCP 폼)이
**가로 스크롤 없이 읽히고 조작 가능**. **>640px 뷰포트**(Electron 데스크톱·와이드 웹)는 무회귀
(좁힌 데스크톱 창이 640px 이하로 내려가면 폰 레이아웃을 받는 것은 C2가 이미 출하한 동작 — 회귀 아님).

## 4. 비목표 / 알려진 한계

- 데스크톱(>640px) UX 변경(무회귀가 계약 — §6 원칙으로 구조 보장).
- 네이티브 앱/PWA/Web Push(#226 별도).
- 승인 카드(#216 C2 완료 — 기존 640px 블록 재사용·중복 구현 금지). 단 **C2 폰 무회귀도 계약에 포함**: `viewport-fit=cover` 도입이 바텀시트를 홈 인디케이터와 겹치게 하므로 `.modal-actions`(sticky bottom)에 safe-area 패딩을 함께 추가한다(§7 PR1).
- 그래프 뷰(§2 정정 — 앱 표면 아님).
- `UpdateBanner`(Electron 전용 표면 — App.tsx:112 `runtime === 'electron'` 게이팅 실물 확인, 웹 미노출).
- 모바일 내비 신설(햄버거/바텀탭) — 기존 3탭 세그먼트가 폰 폭에 수용됨(§2).
- **폰 랜드스케이프(가로)**: 논리 폭 852~932px > 640 → 데스크톱 레이아웃 수신 + 16px 폼 규칙 이탈로 iOS 자동 줌 재발 가능. 세로 사용이 지배적 시나리오(외출 중 승인·모니터)라 수용 — 알려진 한계로 명시.
- **iOS 소프트 키보드 CSS-only 한계**: iOS Safari는 키보드가 visual viewport만 축소(layout viewport·dvh 불변)하고 `interactive-widget`을 미구현 — 채팅 입력창은 브라우저의 focus 자동 스크롤에 의존한다(§5 CSS-only 전략과 VisualViewport JS 해법이 충돌 — 채택 안 함). 재평가 트리거: WebKit이 `interactive-widget` 출하 시.

## 5. 전략 결정 (스파이크 해소)

**CSS-only 미디어쿼리** (사용자 승인 · C2 선례 유지):

- 단일 컴포넌트 · JS 분기 0 · 모바일 전용 뷰 없음.
- 근거: 앱이 이미 탭 기반이라 레이아웃 재구성이 "사이드바→스택·2열→1열" 수준(§2)이고,
  C2가 같은 접근(미디어쿼리 단독)으로 폰 바텀시트를 성립시킨 실증이 있다.
- 마크업 변경은 **스타일 훅 래퍼 1곳만** 허용: `SessionsPanel.tsx:153`의 `<AddAiWizard />` 마운트를
  `.wizard` 래퍼 div로 감싼다(위저드 루트가 4개라 각 루트에 붙이는 것보다 1곳 변경이 §5 원칙에 부합.
  AddAiWizard.test.tsx는 getByRole/label 쿼리만 사용·스냅샷 0건이라 무회귀). 로직/구조 변경 금지.

## 6. 설계 원칙 (무회귀의 구조적 보장)

1. **모든 폰 분기는 `@media (max-width: 640px)` 블록 안에만.** 미디어쿼리 밖 데스크톱 CSS diff는
   아래 **열거 예외**만 허용하고, 각 예외는 "데스크톱에서 no-op"임을 diff에서 확인한다:
   - `100vh → 100vh; 100dvh` 폴백 병기(`.app`·`.chat` — 데스크톱은 dvh≡vh).
   - viewport meta 확장(`viewport-fit=cover`·`interactive-widget=resizes-content` — 데스크톱 크로뮴은 meta viewport 미반영).
   - safe-area 패딩 — 반드시 **additive 패턴**(`max(기존값, env(safe-area-inset-*))` 또는
     `calc(기존값 + env(...))`)으로만. `padding: env(...)` 치환 금지(env 미지원/inset 0 환경에서
     기존 패딩이 붕괴한다). 대상: `.topbar`·`.footer`·`.update-banner`(ConnectionBanner 공유)·
     `.modal-actions`(C2 바텀시트 홈바 겹침 방지).
   - `pre.summary`에 `overflow-wrap: break-word` 추가(전 뷰포트 공통의 결함 수정 — 데스크톱에서도
     현재 긴 토큰이 패널을 뚫는 버그이므로 무회귀 예외가 아니라 수정).

   > 원칙의 정확한 명제: "diff ⊆ {640px 블록} ∪ {위 열거 예외}" — 블록 내부는 >640px에 완전 비활성
   > (기계 판별), 예외는 리뷰에서 사람이 no-op 여부를 판별한다.
2. **브레이크포인트는 640px 단일**(C2와 동일) — `pointer: coarse` 등 이원 기준 금지(테스트 결정론·
   e2e 뷰포트 에뮬과 1:1 대응).
3. **C2 패턴 재사용**: 가로 칩 스트립(`overflow-x: auto` — `.modal-chips` 선례·iOS 13+ 모멘텀 기본이라
   추가 속성 불요), dvh. **reduced-motion은 기존 전역 블록(styles.css:991)이 신규 애니도 자동 커버** —
   새 reduced-motion 블록을 미디어쿼리 밖에 추가하지 않는다(필요 시 640px 블록 안 중첩만).
4. 주석·네이밍은 기존 styles.css 한국어 관용구를 따른다.

## 7. PR 분할 및 각 PR 범위

### PR 1 — 전역 레이어 + 앱 셸 (`Part of #221`)

- **뷰포트 기반**: `.app`·`.chat`의 `100vh` → dvh 폴백 병기. `index.html` viewport에
  `viewport-fit=cover`·`interactive-widget=resizes-content`(Android 키보드 대응·iOS는 무시라 무해) 추가.
  safe-area additive 패딩: `.topbar`·`.footer`·`.update-banner`·`.modal-actions`(§6 예외 목록).
- **`pre.summary` overflow-wrap 수정**(§6 예외 — 전 뷰포트 결함).
- **≤640px 블록(신설, 셸+전역)**:
  - `.topbar`: gap 28→12px급·padding 축소, `.brand .tag` 숨김, `.live` 축소(카운터 유지·라벨 축약).
  - `.nav-btn`: 터치 타깃 min-height 44px·패딩 조정(3탭이 360px 폭에 수용되는지 e2e 단언).
  - `.main` padding 26→12~14px, `.footer` padding 축소.
  - **타이포 스케일**(이슈 계약): body 13→14px급 상향, `.chip`/`.field-label`/`.eyebrow` 10→11px급·
    과대 자간 축소 — 세부 값은 라이브 실측 조정(§10).
  - 전역 터치 타깃: `.btn`·`.btn-sm`·`.room-btn`·`.ask-btn`·`button.chip`·`.field` min-height 44px
    **+ 아이콘성 타깃은 min-width 44px**(HIG 양방향 — 텍스트 버튼은 패딩으로 폭 충족).
  - `.field`·`input`·`select`·`textarea` font-size 16px(iOS 자동 줌 방지 — computed 기준).
  - `.row { flex-wrap: wrap }` + 인라인 고정폭 필드에 `max-width: 100%`(인라인 width를 이기는 별개 속성).
  - `.update-banner` 폭 제약(`max-width: calc(100vw - 24px)` 급) — ConnectionBanner 공유 표면.
- **AddAiWizard 최소 모바일 스타일(PR2→PR1 이동 — Codex 1R)**: `.wizard` 래퍼(§5) + ≤640px에서
  `.wizard` 하위 bare input/button/label 폭 100%·터치 타깃 44px·간격 정돈. 근거: 세션 탭의 첫
  인터랙티브 표면이 위저드라, 이를 PR2로 미루면 PR1의 "세션 탭 가로 스크롤 0·터치 타깃" e2e
  게이트가 위저드 제외 시 false-green·포함 시 즉시 fail — 게이트 정직성을 위해 PR1에 포함.
- **e2e 하네스(신설)**: `e2e/mobile-responsive.web.e2e.ts`(playwright testDir=`./e2e` — `tests/e2e/` 아님)
  — 뷰포트 390×844·reduced-motion 에뮬·측정 전 `document.fonts.ready` 대기(폰트 스왑 폭 변동 흡수).
  단언: ① 3탭 각각 **`.main.scrollWidth <= .main.clientWidth`**(패널 오버플로는 `.main`이 트랩하므로
  documentElement 단언은 blind — §2 스크롤 아키텍처) + `documentElement.scrollWidth <= innerWidth`
  (topbar/footer 커버) ② topbar 내비 3버튼 전부 **뷰포트내 앵커**(C2 교훈: boundingBox가 뷰포트
  사각형 안 — y+h 단언은 오프스크린 통과) ③ 주요 터치 타깃 높이 ≥44px.
  단, PR1 시점에 `.chat`·`.project-layout`은 미수정이라 ①의 `.main` 단언은 **세션 탭만** 강제하고
  채팅/프로젝트 탭은 PR2에서 활성화(테스트에 skip 사유 주석 — false-green 방지).
- **완료 정의**: verify green + 기존 e2e 무회귀 + 신설 e2e green + **라이브 폰 실측**(셸 수준:
  가로 스크롤 없음·탭 전환 가능·재접속 배너 정상).

### PR 2 — 패널 3개 + 폼 (`Closes #221`)

- **채팅/프로젝트 공통 패턴**: ≤640px에서 `.chat`·`.project-layout` → `grid-template-columns: 1fr`.
  `.rooms`(룸/프로젝트 목록) → 가로 칩 스트립(`display:flex; overflow-x:auto` — C2 `.modal-chips` 선례).
  `.chat` height → dvh 기반 재계산(키보드 한계는 §4 명시 — Android는 `interactive-widget`으로 대응).
- **프로젝트 패널**: `.grid-2` → 1열(사용처 = ProjectPanel elicitation·manual 역할 배정 — 전역 규칙로 처리).
  진행 로그(`.log`)·요약(`pre.summary`)의 가로 오버플로 정돈.
- **세션 패널**: `.line-item` 랩 정돈(칩·배지·삭제 버튼 겹침 방지). 위저드는 PR1에서 완료(§7 PR1).
- **CLI/MCP 설정 폼**(SessionsPanel 03/04 섹션): `.field`·textarea 폭 100%·라벨 줄바꿈.
- **e2e 확장**: PR1의 `.main` 단언을 채팅/프로젝트 탭에 활성화 + 패널별 단언 — 프로젝트 폼 입력
  가능·채팅 입력창 뷰포트내 앵커. **칩 스트립 하드 계약(Codex 1R)**: UI 경로로 방 3개+ 추가 생성 후
  `.rooms.scrollWidth > .rooms.clientWidth` 단언(오버플로 실존 — 시드 룸 1개의 vacuous 방지) →
  스트립을 스크롤해 **마지막 룸 버튼이 도달·클릭 가능**함을 단언(담김만이 아니라 조작성 증명).
- **완료 정의**: verify green + e2e 전량 green + **라이브 폰 실측 = 이슈 완료정의**(실 CF Access
  터널에서 세션 개시·프로젝트 런 모니터·설정이 가로 스크롤 없이 조작 가능 + **키보드 연 상태에서
  채팅 입력 — 필수·생략 불가**(로컬 Playwright Chromium은 iOS 키보드 동작 미커버) — C2에서 로컬
  e2e가 못 잡은 실레이아웃 버그 선례로 필수 관문. **실측한 모바일 브라우저/OS 버전을 PR 본문에
  기록**(Codex 1R)).

## 8. 검증 계약 (공통)

- `npm run verify` 7게이트 green(로컬=CI). renderer CSS/tsx만 변경 시에도 brain 재생성 여부 확인
  (tsx 의존 변화 없음 예상 — brain은 src 의존 그래프 기준).
- 기존 e2e(electron + web) 무회귀.
- 데스크톱 무회귀 리뷰 규율: diff에서 §6 원칙 위반(640px 블록·열거 예외 밖 변경) 여부를 자체 적대
  리뷰 렌즈로 명시 점검. 열거 예외는 각각 "데스크톱 no-op" 근거를 PR 본문에 기재.
- 적대 리뷰: 각 PR 전 자체 fleet-finder/fleet-refuter, PR 후 Codex 자동 리뷰 대기·반영(스레드 resolve).

## 9. 리스크 / 완화

| 리스크 | 완화 |
| --- | --- |
| 데스크톱 회귀(공용 셀렉터 오염) | §6 원칙 1 — diff ⊆ 640px 블록 ∪ 열거 예외(각 예외 no-op 근거 기재) |
| e2e 가로 스크롤 단언 false-green | `.main` 스크롤박스 기준 단언(§2 아키텍처 반영) + PR1은 미수정 탭 skip 명시 |
| 로컬 e2e가 실기기 레이아웃 못 잡음 (C2 실증) | 라이브 폰 실측을 각 PR 완료 관문으로 명시 |
| 소프트 키보드가 채팅 입력창 가림 | Android: `interactive-widget=resizes-content` · iOS: CSS-only 한계 명시(§4)·라이브 실측 항목화 |
| `viewport-fit=cover`가 C2 바텀시트 홈바 겹침 | `.modal-actions` safe-area additive 패딩(§6 예외) |
| safe-area 치환 구현으로 데스크톱 패딩 붕괴 | additive 패턴(`max()`/`calc()`) 문면 구속(§6) |
| dvh 미지원 구형 브라우저 | vh 선언 병기 폴백(§6 예외 1) |
| 칩 스트립 전환으로 룸 목록 조작성 저하 | e2e 스크롤 동작 단언(룸 3개+ 시드) + 라이브 실측 |
| iOS 입력 자동 줌으로 레이아웃 점프 | 폼 필드 computed 16px 고정(세로 한정 — 랜드스케이프는 §4 한계) |
| 폰트 스왑 타이밍 flake | 측정 전 `document.fonts.ready` 대기 |

## 10. 미해결 질문

없음 — 전략·PR 분할·채팅 포함은 사용자 결정 완료(§0). 세부 픽셀 값(패딩·gap·타이포 스케일)은 구현 중
라이브 실측으로 조정(스펙은 원칙과 상한/하한만 구속).

---

## 부록 — 로컬 refuter 사전검증 요약 (2026-07-13 · 4렌즈)

| 렌즈 | verdict | 반영 |
| --- | --- | --- |
| 데스크톱 무회귀 실효성 | 생존(P1 0) | safe-area additive 문면 구속·위저드 루트 4개→래퍼 1곳·>640px 정밀화·reduced-motion 규율 |
| e2e 검증 격차 | 골격 생존·단언① P1 | `.main` 스크롤박스 단언 교체·경로 `e2e/` 정정·fonts.ready·룸 다수 시드 |
| 모바일 웹 기술 정합 | 생존(조건부) | 키보드×dvh 한계 명시+`interactive-widget`·C2 바텀시트 safe-area·min-width 44·랜드스케이프 한계 |
| 스코프·계약 공백 | 생존(조건부) | 스크롤 아키텍처 §2 등재·`pre.summary` word-break·타이포 스케일 포함·ConnectionBanner 등재·`.ask-btn`/`button.chip`·`.grid-2` 귀속 정정 |
| **Codex 체크포인트 1R** | 차단 없음·정정 3 | 위저드 모바일 스타일 PR2→PR1(세션 탭 게이트 정직성)·`.rooms` 스트립 하드 계약(scrollWidth>clientWidth+마지막 칩 클릭)·키보드 실측 필수화+브라우저 버전 기록 |

# #221 웹모드 렌더러 전체 모바일 반응형 — 설계 스펙

- **이슈**: #221 (tier:next · area:renderer · enhancement)
- **날짜**: 2026-07-13
- **선행**: #216 C2(승인 카드 바텀시트 — PR #220)가 유일한 폰 분기. 본 작업은 그 패턴을 앱 전체로 확장.
- **전략 결정(사용자 승인)**: CSS-only 미디어쿼리 · 2-PR 분할 · 채팅 탭 포함.

## 1. 배경 / 문제

Phase B(#197) 웹모드는 데스크톱 렌더러를 반응형 없이 재사용했다. `src/renderer/styles.css`(1,177줄)의
폭 기반 미디어쿼리는 C2 승인 모달 `@media (max-width: 640px)` 하나뿐. 폰 브라우저(실 CF Access 터널)에서
topbar·패널·폼이 데스크톱 비율로 렌더돼 가로 스크롤·좁은 터치 타깃으로 실사용이 어렵다.
v3(#193) 목표 "어디서든 브라우저로"는 승인 카드만이 아니라 앱 전체가 폰에서 쓸 만해야 성립한다.

## 2. 현황 실측 (2026-07-13 코드 기준)

- **앱은 이미 탭 기반** — `App.tsx`(118줄): topbar(브랜드+세그먼트 내비 3탭+라이브 카운터) → main(탭별 패널 1개) → footer. 앱 수준 사이드바 없음 → 햄버거/바텀탭 등 모바일 내비 신설 불필요(이슈 본문의 해당 항목은 과대 스코프).
- **폰에서 깨지는 근본 원인 목록**:
  - `.app { height: 100vh }` — 모바일 주소창 수축 미대응(dvh 필요).
  - `.topbar { gap: 28px; padding: 16px 26px }` + `.brand .tag`(자간 0.26em 캡션) — ≤400px 오버플로.
  - `.chat { grid-template-columns: 232px 1fr; height: calc(100vh - 160px) }` — 사이드바 강제 + vh.
  - `.project-layout { grid-template-columns: 232px 1fr }` — 동일.
  - `.grid-2 { grid-template-columns: 1fr 1fr }` — 폼 2열 강제.
  - `.main { padding: 26px }` · `.wrap { max-width: 1180px }` — 폰에서 여백 과다.
  - 터치 타깃: `.nav-btn`(7px 패딩)·`.btn-sm`·`.room-btn` 등 44px 미달.
  - `AddAiWizard.tsx`(491줄): 루트 bare `<div>`·input/button 대부분 클래스 없음 — 스타일 훅 부재.
- **viewport meta는 이미 존재**(`width=device-width, initial-scale=1.0`) — `viewport-fit=cover` 미포함.
- **이슈 본문 정정**: "채널/그래프 뷰(`force-graph` 터치·크기 대응)"는 stale — `force-graph`는
  `scripts/brain/build.mjs`(dev 시각화 `fleet-brain.html`, gitignore) 전용이며 앱 renderer에서 미사용.
  스코프 제외(이슈 코멘트로 정정 기록).
- **e2e 기반 존재**: playwright `web` 프로젝트(`*.web.e2e.ts`) + `tests/e2e/web-server.ts` — 모바일
  뷰포트 스펙을 얹을 자리가 이미 있다.

## 3. 목표

폰 브라우저(≤640px)에서 세션 개시 · 프로젝트 런 모니터 · 채팅 · 설정(위저드·CLI/MCP 폼)이
**가로 스크롤 없이 읽히고 조작 가능**. 데스크톱(Electron·와이드 웹)은 픽셀 단위 무회귀.

## 4. 비목표

- 데스크톱 UX 변경(무회귀가 계약 — §6 원칙으로 구조 보장).
- 네이티브 앱/PWA/Web Push(#226 별도).
- 승인 카드(#216 C2 완료 — 기존 640px 블록 재사용·중복 구현 금지).
- 그래프 뷰(§2 정정 — 앱 표면 아님).
- `UpdateBanner`(Electron 전용 표면 — 웹 미노출, App.tsx 게이팅 확인됨).
- 모바일 내비 신설(햄버거/바텀탭) — 기존 3탭 세그먼트가 폰 폭에 수용됨(§2).

## 5. 전략 결정 (스파이크 해소)

**CSS-only 미디어쿼리** (사용자 승인 · C2 선례 유지):

- 단일 컴포넌트 · JS 분기 0 · 모바일 전용 뷰 없음.
- 근거: 앱이 이미 탭 기반이라 레이아웃 재구성이 "사이드바→스택·2열→1열" 수준(§2)이고,
  C2가 같은 접근(미디어쿼리 단독)으로 폰 바텀시트를 성립시킨 실증이 있다.
- 마크업 변경은 **스타일 훅 클래스 추가만** 허용(예: 위저드 루트 `.wizard`) — 로직/구조 변경 금지.

## 6. 설계 원칙 (무회귀의 구조적 보장)

1. **모든 폰 분기는 `@media (max-width: 640px)` 블록 안에만.** 미디어쿼리 밖 데스크톱 CSS diff는
   원칙적으로 0 — 예외는 `100vh→100dvh` 폴백 병기(`height: 100vh; height: 100dvh;` — 구형은 vh,
   지원 브라우저는 dvh; 데스크톱 시맨틱 동일)와 viewport meta·safe-area뿐이며, 예외는 스펙/PR 본문에
   명시적으로 열거한다.
2. **브레이크포인트는 640px 단일**(C2와 동일) — `pointer: coarse` 등 이원 기준 금지(테스트 결정론·
   e2e 뷰포트 에뮬과 1:1 대응).
3. **C2 패턴 재사용**: 가로 칩 스트립(`overflow-x: auto` — `.modal-chips` 선례), dvh, reduced-motion.
4. 주석·네이밍은 기존 styles.css 한국어 관용구를 따른다.

## 7. PR 분할 및 각 PR 범위

### PR 1 — 전역 레이어 + 앱 셸 (`Part of #221`)

- **뷰포트 기반**: `.app`·`.chat` 등 `100vh` 사용처 → dvh 폴백 병기. `index.html` viewport에
  `viewport-fit=cover` 추가, `.topbar`/`.footer`에 `env(safe-area-inset-*)` 패딩(노치/홈바).
- **≤640px 블록(신설, 셸)**:
  - `.topbar`: gap 28→12px급·padding 축소, `.brand .tag` 숨김, `.live` 축소(카운터 유지·라벨 축약).
  - `.nav-btn`: 터치 타깃 min-height 44px·패딩 조정(3탭이 360px 폭에 수용되는지 실측 단언).
  - `.main` padding 26→12~14px, `.footer` padding 축소.
  - 전역 터치 타깃: `.btn`·`.btn-sm`·`.room-btn`·`.field` min-height 44px.
  - `.field`·`input`·`select`·`textarea` font-size 16px(iOS 자동 줌 방지).
- **e2e 하네스(신설)**: `tests/e2e/mobile-responsive.web.e2e.ts` — 뷰포트 390×844·reduced-motion 에뮬.
  단언: ① 3탭 각각 `document.documentElement.scrollWidth <= window.innerWidth`(가로 스크롤 0)
  ② topbar 내비 3버튼 전부 **뷰포트내 앵커**(C2 교훈: `y+h≥X` 단언은 오프스크린 통과 — boundingBox가
  뷰포트 사각형 안에 있는지) ③ 주요 터치 타깃 높이 ≥44px.
- **완료 정의**: verify green + 기존 e2e 무회귀 + 신설 e2e green + **라이브 폰 실측**(셸 수준:
  가로 스크롤 없음·탭 전환 가능).

### PR 2 — 패널 3개 + 폼 (`Closes #221`)

- **채팅/프로젝트 공통 패턴**: ≤640px에서 `.chat`·`.project-layout` → `grid-template-columns: 1fr`.
  `.rooms`(룸/프로젝트 목록) → 가로 칩 스트립(`display:flex; overflow-x:auto` — C2 `.modal-chips` 선례).
  `.chat` height → dvh 기반 재계산(입력창이 항상 뷰포트 안).
- **세션 패널**: `.grid-2` → 1열. `.line-item` 랩 정돈(칩·배지·삭제 버튼 겹침 방지).
- **AddAiWizard**: 루트 `<div>`에 `.wizard` 클래스 추가(**유일한 tsx 마크업 변경** — 기존 테스트 무회귀
  확인). ≤640px에서 `.wizard input·button·label` width 100%·터치 타깃·간격 정돈.
- **CLI/MCP 설정 폼**(SessionsPanel 03/04 섹션): `.field`·textarea 폭 100%·라벨 줄바꿈.
- **e2e 확장**: 동일 스펙 파일에 패널별 단언 — 칩 스트립 가로 스크롤 동작·프로젝트 폼 입력 가능·
  채팅 입력창 뷰포트내 앵커.
- **완료 정의**: verify green + e2e 전량 green + **라이브 폰 실측 = 이슈 완료정의**(실 CF Access
  터널에서 세션 개시·프로젝트 런 모니터·설정이 가로 스크롤 없이 조작 가능 — C2에서 로컬 e2e가
  못 잡은 실레이아웃 버그 선례로 필수 관문).

## 8. 검증 계약 (공통)

- `npm run verify` 7게이트 green(로컬=CI). renderer CSS/tsx만 변경 시에도 brain 재생성 여부 확인
  (tsx 의존 변화 없음 예상 — brain은 src 의존 그래프 기준).
- 기존 e2e(electron 9 + web) 무회귀.
- 데스크톱 무회귀 리뷰 규율: diff에서 §6 원칙 위반(미디어쿼리 밖 변경) 여부를 자체 적대 리뷰
  렌즈로 명시 점검.
- 적대 리뷰: 각 PR 전 자체 fleet-finder/fleet-refuter, PR 후 Codex 자동 리뷰 대기·반영(스레드 resolve).

## 9. 리스크 / 완화

| 리스크 | 완화 |
| --- | --- |
| 데스크톱 회귀(공용 셀렉터 오염) | §6 원칙 1(미디어쿼리 밖 diff 0 + 예외 열거) — 리뷰에서 기계적으로 판별 가능 |
| 로컬 e2e가 실기기 레이아웃 못 잡음 (C2 실증) | 라이브 폰 실측을 각 PR 완료 관문으로 명시 |
| dvh 미지원 구형 브라우저 | vh 선언 병기 폴백(§6 예외 1) |
| 칩 스트립 전환으로 룸 목록 조작성 저하 | e2e 스크롤 동작 단언 + 라이브 실측에서 확인 |
| iOS 입력 자동 줌으로 레이아웃 점프 | 폼 필드 16px 고정 |

## 10. 미해결 질문

없음 — 전략·PR 분할·채팅 포함은 사용자 결정 완료(§0). 세부 픽셀 값(패딩·gap)은 구현 중 라이브
실측으로 조정(스펙은 원칙과 상한/하한만 구속).

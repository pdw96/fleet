---
adr: 5
title: picker 문서 외부열기는 main 매개 정적 URL handoff 로만 허용한다
status: Accepted
date: 2026-06-26
related: "#145, #143, spec:2026-06-26-picker-docs-external-open-design, memory:subscription-oauth-3rdparty-blocked"
---

## 맥락
Fleet 은 단일 창 SPA 다 — `window-guards`(installNavigationGuards)가 renderer 의 새 창·`will-navigate`/
`will-redirect`/`will-frame-navigate` 를 전면 차단한다(외부로 이동하는 정상 경로가 의도적으로 없음).
세션 등록 picker 는 CLI 구독 분기에서 설치/로그인 **문서 URL** 을 안내하는데, v1(#143/#144)은 이를
copy-only(텍스트 표시 + clipboard)로만 노출했다. #145 항목4 가 "버튼 한 번으로 문서 열기" 를 요구한다.
외부열기를 도입하면 "전면차단 모델인데 왜 docs 는 열리나" 라는 보안 감사 질문이 필연적으로 생긴다.

## 결정
picker docs 외부열기는 renderer navigation 이 아니라 **main 매개 정적 URL handoff** 로만 허용한다.
renderer 는 `adapterId`(식별자)만 IPC(`fleet:external:openDocs`)로 보내고, main 이 정적 맵에서 `docsUrl`
을 도출·재검증(https · userinfo 금지 · port 금지 · exact hostname allowlist)한 뒤 `shell.openExternal`
로 OS 기본 브라우저에 위임한다. window-guards 는 불변 — 이 경로는 그 가드를 우회/완화하지 않고, renderer
가 외부로 못 간다는 모델을 유지한 채 main 이 검증된 정적 URL 만 브라우저에 넘기는 **별도 통제 경로**다.

## 고려한 대안 / 기각 사유
- **copy-only 유지**: 사용자가 URL 을 손으로 복사·붙여야 하는 마찰. → 기각(#145 가 클릭 열기 요구).
- **URL 전달형 IPC**(renderer 가 URL 문자열을 main 에 전달): 검증이 완벽하면 안전하나 renderer(=LLM 출력·
  DOM 조작이 닿는 낮은 신뢰 경계)가 URL 을 결정하는 구조가 남아, allowlist 검증 버그 시 임의-URL 입력면이
  생긴다. → 기각(식별자 전달이 주입면 0).

## 결과 (Consequences)
보안 불변식(이 경로가 지키는 것):
1. renderer 는 URL 을 전달하지 않는다(식별자만).
2. `loginCommand`/`installHint` 명령어는 계속 copy-only(외부열기·shell 실행 대상 아님).
3. `window.open`/navigation guard 는 그대로 — renderer 직접 외부이동 금지 불변.
4. https + userinfo/port 금지 + exact hostname allowlist + 정적 docsUrl(사용자/원격/AI 입력 비주입).

한계: handoff 이후 브라우저가 따라가는 redirect 는 Fleet 앱 네비가 아니므로 보증 범위 밖 — Fleet 은
핸드오프하는 최초 URL 이 컴파일타임 정적 allowlist docs URL 임만 보증한다.

**재검토 트리거**: 외부열기 대상이 docsUrl 을 넘어 확장되거나(예: loginCommand 클릭), allowlist 가
사용자/원격 입력으로 채워져야 할 수요가 생기면 — 그때 redirect 추적·동적 검증을 재설계한다.

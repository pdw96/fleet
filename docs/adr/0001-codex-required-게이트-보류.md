---
adr: 1
title: Codex 를 required CI 머지 게이트로 만들지 않는다
status: Accepted
date: 2026-06-23
related: "#98, memory:codex-ci-gate-auth"
---

## 맥락
Codex 리뷰를 GitHub required status check(머지 차단 게이트)로 만들 수 있는지 조사했다.
2026-06-23 다출처 검증 + Codex 봇과 #98 코멘트 토론으로 합의(Codex: "Claude 쪽 정정이 맞다").

## 결정
Codex 를 required CI 게이트로 만들지 **않는다**(보류). 솔로 pre-1.0 + 이미 봇 리뷰(Codex·CodeRabbit)
+ 사람 체크포인트 + ruleset `required_review_thread_resolution` 이 있어 ROI 가 낮고, 중복·flaky·플랜
한도·서드파티 리스크가 크다. 협업자 합류 또는 1.0 근처에서 재검토.

## 고려한 대안 / 기각 사유
- **공식 `openai/codex-action@v1`**: provider/API 키 필수 — 솔로 ChatGPT 구독-only 공식 경로 없음
  (`openai/codex-action` issue #92 = 미해결 기능 요청)·토큰당 과금. → 기각.
- **클라우드 코드리뷰 봇(`chatgpt-codex-connector`)을 게이트로**: commit status / check run 을 발행하지
  않고 리뷰 코멘트만 → required check 로 쓸 수 없음. → 기각.
- **`CODEX_ACCESS_TOKEN` + `codex exec`**: Business/Enterprise 워크스페이스 전용. → 기각(솔로 Plus).
- **ChatGPT-managed `auth.json` on CI**: trusted private runner 한정 advanced 경로·GitHub-hosted 러너
  부적합. OpenAI 도 "automation 인증은 API 키가 정답"이라 명시. → 기각.
- **서드파티 `JoeyTeng/codex-review-gate-action`**: GitHub 미인증. → 기각.

## 결과 (Consequences)
현 required check = `typecheck·lint·test·build` + `windows vitest`(ruleset id 17940177)만 유지.
Codex·CodeRabbit 는 비차단 어드바이저리 리뷰어로 운용(머지 전 대기·반영, 스레드 resolve).
**재검토 트리거**: 협업자 합류 또는 1.0 근처.

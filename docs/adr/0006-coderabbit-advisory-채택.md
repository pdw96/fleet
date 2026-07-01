---
adr: 6
title: CodeRabbit 을 advisory 보조 리뷰어로 채택한다(비-required 게이트)
status: Accepted
date: 2026-07-01
related: "#176, #98, AGENTS.md:Codex 리뷰 운영 기준"
---

## 맥락
AGENTS.md 는 "CodeRabbit 병행은 실측 후 — 지금은 도입하지 않는다"고 기록했으나, 레포에 `coderabbitai[bot]`
(Pro Plus·CHILL)가 이미 활성화돼 PR 당 Codex + CodeRabbit 2봇 리뷰가 돈다. 문서-현실 drift(#176 finding 5).

## 결정
CodeRabbit 을 **advisory 보조 리뷰어**로 채택한다 — Codex(P0/P1 senior)와 병행하되 **required status check
아님**. 인라인 스레드 resolve 는 ruleset(미해결 스레드 0)이 강제하나, CodeRabbit 자체가 머지를 차단하지
않는다. fix 푸시마다 재리뷰로 새 스레드가 추가될 수 있어 매 푸시 후 unresolved 재확인.

## 고려한 대안 / 기각 사유
- **미도입 유지**: 현실과 불일치(이미 활성) → 기각.
- **required 게이트화**: 클라우드 리뷰 봇은 commit status 미발행·비결정성·중복 코멘트 피로 → 기각(#98 Codex
  required 보류와 동일 논리).

## 결과 (Consequences)
2봇 교차 리뷰로 커버리지↑. 비용 = 중복 코멘트·스레드 관리 부담. 재검토 트리거 = false-positive 율 과다 or
required 승격 수요(1.0 근처).

---
name: fleet-backlog-induction
description: Fleet 백로그 착수 절차 래퍼 — 선정→브랜치→사이클(brainstorm→spec→plan→TDD→게이트)→PR(Closes #N)→Codex 대기→머지 후 동기화. "이슈 27 확인하고 작업 진행" 류 지시 시 사용.
---

# Fleet 백로그 착수 절차

AGENTS.md 「백로그 착수 절차」의 실행가능 래퍼. **사람-게이트(브레인스토밍 승인·Codex 리뷰 대기)가
끼는 선형 절차**라 fan-out 가속 `.js`가 없다(L2-only).

## 언제

"#27 확인하고 작업 진행", "백로그 다음 항목 착수" 류 지시.

## 행동 (절차)

1. **선정** — `gh issue view 27` 의 sub-issue 트래커에서 `tier:next` 최상위(모호하면 사용자 확인).
2. **브랜치** — master 직접 금지(ruleset). `feat/<slug>` 생성.
3. **사이클** — 비자명하면 brainstorm → spec(`docs/superpowers/specs/`) → plan(`docs/superpowers/plans/`).
   TDD(RED→GREEN). `npm run verify` green. 적대 리뷰(fleet-pr-review 스킬 — find=`fleet-finder`·
   verify=`fleet-refuter` 에이전트). **설계 선택이 지속·교차 결정이면 ADR 작성/갱신**
   (AGENTS.md 「백로그 착수 절차」 §결정 기록 참조).
4. **PR** — 본문 `Closes #<N>`. Codex 봇 자동리뷰 대기·반영(스레드 resolve). 사용자 확인 후 squash.
5. **머지 후** — 이슈 닫힘·#27 진행률 자동. 보드 Done(자동). #27 본문 트래커 보정(수동).

## 주의

- 라벨 규약: `area:*`+`tier:*`(+`type:*`). 새 이슈는 `--parent 27`.
- 자세한 gh 명령·보드 id 출처는 AGENTS.md 참조(여기 중복 금지).

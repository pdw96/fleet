---
name: fleet-plan-panel
description: 판사 패널 계획 수립 — 승인된 스펙을 fleet-planner×3(리스크/MVP/계약 각도) 독립 초안 → fleet-plan-judge×2(공백/Codex 강점 렌즈 그룹) 채점 → 메인 루프 합성으로 전개. "판사 패널 계획", "패널로 계획 수립" 시 사용. 소형 작업은 패널 생략(적응형).
---

# Fleet 판사 패널 계획 수립

단일 패스 계획의 품질을 다중 초안 + 독립 채점으로 보전하는 파이프라인
(스펙: `docs/superpowers/specs/2026-07-06-plan-panel-design.md`).
fleet-pr-review 의 find≠verify 에 대응하는 계획판 규율 = **draft≠judge**.

## 언제

승인된 스펙이 있고 구현 계획이 필요할 때. fleet-backlog-induction 3단계(사이클)의 plan 작성을
이 스킬로 위임한다. **스펙이 없으면 중단** — brainstorm→spec 부터.

## 행동

1. **규모 판정** — 소형(대상 ≤2파일 · 신규 계약 0 · 단일 PR)이면 패널 생략, 메인 루프가 직접
   계획하고 생략 사실을 고지한다. 그 외는 패널 진행.
2. **draft** — `fleet-planner` ×3 병렬 디스패치(각도: 리스크 우선/MVP 우선/계약 우선).
   스펙 전문 + 대상 이슈 컨텍스트를 프롬프트에 싣는다.
3. **judge** — `fleet-plan-judge` ×2 병렬(judge A=공백 그룹, judge B=Codex 강점 그룹).
   초안 전문을 프롬프트에 싣는다. draft 인스턴스와 분리(draft≠judge).
4. **합성(메인 루프)** — 승자 골격 + 이식 목록 + 공통 결함 보강 →
   `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. 판사 점수 요약·판정 근거를 계획 머리말에
   기록하고 사용자 확인을 받는다.
5. **(선택) 외부 LLM 검토** — 사용자가 원하면 타 모델 검토용 전달 요약을 출력하고 대기,
   피드백 반영 후 다음 단계로.
6. **(조건부) Codex 체크포인트** — 대상 이슈가 있으면 계획을 이슈 코멘트로 게재 후
   `@codex review` 순수 한 줄(산문을 붙이면 파서가 놓침). 이슈가 없으면 생성/생략을 사용자에게
   질문. 리뷰 반영 → 통과까지 반복.
7. **실행 인계** — superpowers:subagent-driven-development 또는 superpowers:executing-plans.

## 강등 규칙 (조용한 강등 금지 — 전부 사용자 고지)

- planner 실패로 초안 <2 → 단일 초안 + judge 채점으로 강등.
- judge 전멸 → 메인 루프가 8렌즈 직접 채점(자기채점임을 명시).
- 판사 간 승자 불일치 → 렌즈별 점수 공개, 메인 루프 판정 + 근거를 계획 머리말에 기록.
- 레이트리밋 → planner 순차 재디스패치. 완료분 결과 재사용, 전체 재시작 금지.
- 각도 붕괴(초안 사실상 동일) → judge 생략, 단일 초안 취급.

## 주의

- 에이전트 `model: inherit` — 메인 세션 모델이 곧 패널 모델. 중요 계획은 상위 모델 세션에서
  호출하면 자동 상속된다.
- 합성 시 판사 지적을 공백 그룹/Codex 강점 그룹으로 구분해 기록 — 이후 Codex 체크포인트 결과와
  대조해 렌즈 실효(비중복 지적 ≥1건)를 측정한다.

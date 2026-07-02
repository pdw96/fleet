---
name: fleet-pr-review
description: Fleet 다차원 적대 PR 리뷰 — 차원별 find → 독립 verify(refute) → 합성. Codex 봇 한도 소진 시 대체·PR 전 자가리뷰용(로컬). "PR 적대 리뷰", "스펙/변경 독립 검증" 시 사용.
---

# Fleet 적대 PR 리뷰 (로컬)

변경·스펙을 여러 렌즈로 적대 검증한다. **Codex 봇과 역할이 겹치므로 클라우드 Action으로 만들지 않는다** —
용도는 Codex 한도 소진 시 대체 / PR 전 자가리뷰.

## 언제

"PR/스펙 적대 리뷰", "독립 검증", Codex 미가용 시 리뷰 대체.

## 행동 (CLI 비종속)

1. **렌즈 분할** — Fleet 특화 P1 신호(AGENTS.md 「Codex 리뷰 운영 기준」: 코어 Electron 유입·
   ApprovalGate 우회·IPC/FleetBridge drift·provider 계약·FLEET_E2E 가드·engine/lockfile·release 안전장치)
   + 보안·정합성·범위 렌즈.
2. **find** — 렌즈별 **독립 서브에이전트 디스패치**로 결함 탐지(구조화 출력: severity·위치·문제·제안).
   Claude Code 로컬 = `fleet-finder` 에이전트(`.claude/agents/`).
3. **verify(refute)** — 각 발견을 별도 서브에이전트가 refute 시도(불확실하면 거짓양성으로 기각).
   Claude Code 로컬 = `fleet-refuter` 에이전트 — find≠verify 가 에이전트 타입 수준에서 분리된다.
4. **합성** — 확정 발견만 severity별로. 거짓양성은 사유와 함께 기록.

## 주의

- find와 verify는 **다른 에이전트**로(자기검증 편향 방지).
- 리뷰 지적의 라이브러리/모델 관련은 context7로 교차검증 후 수용/반박.

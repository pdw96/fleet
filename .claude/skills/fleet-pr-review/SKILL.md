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

1. **규모·렌즈 판정** — 용도별 계층(권위: AGENTS.md 「Codex 리뷰 운영 기준」 자가리뷰 계층화 절):
   - **PR 전 자가리뷰(봇 리뷰 예정 = 기본)** → **봇 공백 렌즈만**: 프레임 전복(스펙/갭 전제 자체
     재검)·성능 정량·테스트 커버리지·동적 검증. Codex 강점(계약 drift·보안 퍼징·race)은 봇에 위임.
   - **Codex 미가용 대체** → 풀 렌즈(아래 2의 P1 신호 + 보안·정합성·범위).
   - **규모 연동** — diff 소형(P1 신호 비접점)이면 find 렌즈 3~4로 충분. P1 신호(계약·보안·게이트)
     접점이면 해당 렌즈만 추가. 렌즈를 넓히기 전에 렌즈당 기대 수확을 따진다.
2. **렌즈 분할** — Fleet 특화 P1 신호(AGENTS.md 「Codex 리뷰 운영 기준」: 코어 Electron 유입·
   ApprovalGate 우회·IPC/FleetBridge drift·provider 계약·FLEET_E2E 가드·engine/lockfile·release 안전장치)
   + 보안·정합성·범위 렌즈. 1의 판정으로 선별한 부분집합만 가동.
3. **find** — 렌즈별 **독립 서브에이전트 디스패치**로 결함 탐지(구조화 출력: severity·위치·문제·제안).
   Claude Code 로컬 = `fleet-finder` 에이전트(`.claude/agents/`). 기계적 렌즈(주석/핀/나열 스윕)는
   하위 effort/모델로 디스패치한다.
4. **verify(refute)** — 각 발견을 별도 서브에이전트가 refute 시도(불확실하면 거짓양성으로 기각).
   Claude Code 로컬 = `fleet-refuter` 에이전트 — find≠verify 가 에이전트 타입 수준에서 분리된다.
   **이 단계는 규모 판정과 무관하게 축소 금지**(세션 티어 유지).
5. **합성** — 확정 발견만 severity별로. 거짓양성은 사유와 함께 기록.

## 주의

- find와 verify는 **다른 에이전트**로(자기검증 편향 방지).
- 리뷰 지적의 라이브러리/모델 관련은 context7로 교차검증 후 수용/반박.
- 렌즈 축소는 find 폭에만 적용 — refute 규율·P1 신호 접점 렌즈는 지키는 게 계층화의 전제다.

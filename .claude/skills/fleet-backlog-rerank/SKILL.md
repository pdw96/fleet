---
name: fleet-backlog-rerank
description: Fleet 백로그 재랭킹 — #27 차기공급원+신규 입력을 적대 검증으로 재평가해 next/later/drop 티어링. "이슈 27 재랭킹/큐레이션" 류 요청 시 사용.
---

# Fleet 백로그 재랭킹

`#27`(메타 백로그)의 후보를 재평가해 티어를 갱신한다. 권위·절차는 AGENTS.md
「백로그 착수 절차」, 후보 출처는 #27 본문 «🔬 차기 공급원».

## 언제

"#27 재랭킹", "백로그 큐레이션", "차기 작업 재평가" 류 요청.

## 행동 (CLI 비종속)

1. **수집** — `gh issue view 27 --repo pdw96/fleet` 본문 후보 + 신규 입력 이슈(라벨 `tier:*`)를 모은다.
2. **fan-out 검증** — 후보마다 **독립 서브에이전트를 디스패치**해 적대적으로 refute 한다
   (현행 코드/문서 재검증 — 상당수 refuted 전력). 병렬 가용 시 N개 동시, 불가 시 동일 에이전트 N회 독립 패스.
   Claude Code 로컬 실행 시 디스패치 타입은 `fleet-refuter`(`.claude/agents/` — verdict 스키마·ROI 렌즈 내장).
3. **티어링** — refute 생존분을 `tier:next`/`tier:later`/`drop` 으로 분류. 솔로 pre-1.0 ROI 렌즈 적용.
4. **산출** — 재랭킹 표(후보·verdict·근거)를 코멘트로. 즉시등재분은 sub-issue 로 등재.
5. **결정 기록** — 티어 정책 변경·refute 확정 등 지속·교차 결정이면 **ADR 작성/갱신**
   (AGENTS.md 「백로그 착수 절차」 §결정 기록 참조 — 루틴 verdict 은 #27, 중복 금지).

## 주의

- 컷오프 이후 변경 가능 — 라이브러리/모델/SDK 관련은 context7로 현행 교차검증.
- 결과는 #27 코멘트에 남긴다.
- **티어 배분(토큰 효율)** — refute 판정은 세션 티어 유지, 기계적 단계(후보 수집·표 정리)는 하위
  effort/모델로 디스패치(AGENTS.md 「Codex 리뷰 운영 기준」 계층화 절).

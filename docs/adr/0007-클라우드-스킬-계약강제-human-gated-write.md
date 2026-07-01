---
adr: 7
title: 클라우드 자동화 스킬은 계약을 기계 강제하고 write 작업은 human-gated 로 둔다
status: Accepted
date: 2026-07-01
related: "#176, spec:2026-07-01-issue176-cloud-harness-alignment-design, memory:codex-cloud-phantom-commits"
---

## 맥락
클라우드 워크플로(cutoff-gap-audit·backlog-rerank)가 참조 스킬 계약을 구조적으로 미충족했다(context7
미배선→환각·Task 미허용→self-review·계약 미검증). "로컬+클라우드" 광고와 실제 배선의 drift(#176).

## 결정
방향 **A(클라우드 진짜 능력화)**: (1) context7 remote-http MCP·`Task`·`--max-turns`·`timeout`·`concurrency`를
배선하고, (2) 스킬 frontmatter `cloud-tools` 계약을 `skills-lint`(scanCloudContract)로 **기계 강제**한다. 단
**sub-issue 등재·ADR commit·push 는 클라우드에 부여하지 않고 human-gated 유지**(클라우드는 근거+refute 된
추천 표만 게시).

**exfil 격리(적대리뷰 P1)**: context7 는 비신뢰 서드파티 문서를 모델 컨텍스트로 주입하므로, 에이전트에
공개 이슈 쓰기 egress(`gh issue comment`)를 주면 "치명적 삼요소"(비신뢰 수집 + 시크릿 접근 + 공개 exfil)가
성립한다. 따라서 **에이전트는 gh 읽기(view/list)만 보유**하고 리포트를 워크스페이스 파일(`cloud-report.md`)에
Write 한다. **결정적 후속 스텝**이 그 파일에서 실제 시크릿 값을 스캔해 발견 시 게시를 차단하고, 없으면
`gh issue comment 135 --body-file` 로 게시한다. `scanCloudContract` 는 이 격리(egress read-only·gh-egress
규칙)를 기계 강제한다. MCP config 경로는 `${{ runner.temp }}`(GitHub 렌더타임 확장)로 — claude_args 는
shell-quote 로 파싱돼 `$RUNNER_TEMP` 셸 변수가 소거되므로 리터럴 경로여야 로드된다.

## 고려한 대안 / 기각 사유
- **로컬 전용화(fleet-pr-review 선례)**: 클라우드 cadence 이점 포기 → 기각(사용자 방향 A 선택).
- **완전 자동등재(create/Write/push)**: `persist-credentials:false`(#175) 플립·임의 이슈생성 → 공급망/자격증명
  blast-radius↑ → 기각(되돌리기 어려운 write 는 induction L2 human-gate 유지).
- **cron cadence**: 구독 OAuth(Claude Max) 쿼터 무인 소진 위험 → 기각(dispatch 전용 + 캡, e2e.yml 선례).

## 결과 (Consequences)
클라우드 산출물이 그라운딩(context7)·독립검증(Task)으로 신뢰가능. 계약 lint 로 배선 drift 회귀 차단(관례→강제).
비용 = `CONTEXT7_API_KEY` 시크릿 운영·구독 쿼터. 실 클라우드 동작은 dispatch 로 검증(fail-fast 로 무근거 실행
차단). 재검토 트리거 = cron cadence 수요 or 완전 자동화 ROI 전환.

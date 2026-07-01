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

**exfil 격리(적대리뷰 + PR#181 봇리뷰)**: context7 는 비신뢰 서드파티 문서를 모델 컨텍스트로 주입하므로,
에이전트가 공개 이슈 쓰기 능력을 가지면 "치명적 삼요소"(비신뢰 수집 + 시크릿 접근 + 공개 exfil)가 성립한다.
`--allowedTools` 에서 `gh issue comment` 를 빼는 것만으로는 불충분 — claude-code-action 은 **내장 GitHub 쓰기
툴을 항상 제공**(allowedTools 로 제거 불가)한다. 따라서 **credential 계층에서 차단**: 워크플로를 2-잡으로 나눠
(a) 에이전트 잡은 `issues: read`(쓰기 토큰 미보유 → 내장 툴도 게시 불가)로 리포트를 `cloud-report.md` 에 Write,
**artifact 업로드 전에 실제 시크릿 값을 스캔**(artifact 도 공개 다운로드 채널이므로 게시 전이 아니라 업로드
전에 차단), (b) `issues: write` 는 **오직 별도 post 잡**이 보유해 artifact 를 받아 재스캔(defense-in-depth) 후
`--repo` 명시로 게시. `scanCloudContract` 는 이 격리를 기계 강제한다 — gh-egress(에이전트 gh 읽기전용)·
`agent-write-token`(claude-code-action 잡 `issues: write` 금지)·MCP 키 미평문(`${CONTEXT7_API_KEY}` env 확장)·
MCP 경로 `${{ runner.temp }}` 리터럴(shell-quote 소거 회피).

## 고려한 대안 / 기각 사유
- **로컬 전용화(fleet-pr-review 선례)**: 클라우드 cadence 이점 포기 → 기각(사용자 방향 A 선택).
- **완전 자동등재(create/Write/push)**: `persist-credentials:false`(#175) 플립·임의 이슈생성 → 공급망/자격증명
  blast-radius↑ → 기각(되돌리기 어려운 write 는 induction L2 human-gate 유지).
- **cron cadence**: 구독 OAuth(Claude Max) 쿼터 무인 소진 위험 → 기각(dispatch 전용 + 캡, e2e.yml 선례).

## 결과 (Consequences)
클라우드 산출물이 그라운딩(context7)·독립검증(Task)으로 신뢰가능. 계약 lint 로 배선 drift 회귀 차단(관례→강제).
비용 = `CONTEXT7_API_KEY` 시크릿 운영·구독 쿼터. 실 클라우드 동작은 dispatch 로 검증(fail-fast 로 무근거 실행
차단). 재검토 트리거 = cron cadence 수요 or 완전 자동화 ROI 전환.

> **exfil 하드닝의 위협모델 범위(정정)**: 위 exfil 격리(2-잡 credential 분리·artifact/게시 전 시크릿 스캔·
> gh-egress)는 PR#181 봇리뷰가 **레포 PUBLIC** 을 전제로 P1 을 매긴 것이다. **실제 레포는 PRIVATE(solo,
> 협업자 1)** — 공개 exfil 싱크(외부 열람자)가 없어 라이브 위협은 사실상 부재하다. 따라서 이 하드닝은
> **defense-in-depth + future-proof**(레포 public 전환 대비)로 유지하며, private 상태에선 과할 수 있음을 명시한다.
> 반면 그라운딩(`$RUNNER_TEMP`→`${{ runner.temp }}`)·stale-report·repo-context 수정은 보안 무관 **정합성
> 버그**라 위협모델과 독립적으로 유효.
>
> **알려진 잔여(private 라 수용)**: 에이전트 스텝이 `CONTEXT7_API_KEY`(MCP 확장용) env 를 갖고 Bash(`gh issue
> view/list`)도 쓰므로, 비신뢰 주입이 `--jq`/`--template`+셸 확장으로 시크릿의 **조각/인코딩**을 리포트에 실을
> 수 있다 — 게시전 스캔은 **완전 일치 값**만 grep 하므로 조각/인코딩은 통과(PR#181 Codex R5). literal-scan 은
> 근본적으로 조각 exfil 을 못 막는다. **public 전환 시 폐쇄 필수**: 에이전트에서 Bash/시크릿 제거(예: #27 데이터를
> 결정적 프리페치 스텝으로 주입, 또는 Claude 를 Bash·시크릿 env 없이 실행).
>
> 재검토 트리거 = 레포 public 전환(하드닝 필수화·잔여 폐쇄) or private 유지 확정 시 lean 화 검토.

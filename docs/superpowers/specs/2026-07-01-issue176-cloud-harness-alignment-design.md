# #176 `.claude/` 클라우드 자동화 하네스 정합 (설계)

- **이슈**: #176 (area:devx, tier:later) — 클라우드 자동화 하네스가 참조 스킬 계약을 구조적으로 미충족
- **날짜**: 2026-07-01
- **상태**: 설계 승인 ✅ (사용자) · Codex 체크포인트 리뷰 ✅ 2개 포크 추천안 일치 — [#176 comment-4850734500 스레드](https://github.com/pdw96/fleet/issues/176#issuecomment-4850734500)
- **브랜치**: `feat/176-cloud-harness-alignment`
- **방향**: **A) 클라우드 진짜 능력화** (로컬화/차등 대신) — 사용자 선택

## 1. 배경 / 문제

두 클라우드 워크플로(`.github/workflows/cutoff-gap-audit.yml`·`backlog-rerank.yml`)는 `anthropics/claude-code-action`으로 Fleet 스킬(`fleet-cutoff-gap-audit`·`fleet-backlog-rerank`)을 클라우드 실행한다. `.claude/README.md`는 두 스킬을 "로컬 + 클라우드"로 광고한다. 그러나 워크플로 배선이 스킬 계약을 **구조적으로 충족하지 못한다**:

1. **context7 미배선 → 환각** (severity medium): audit 스킬 핵심(step2)=context7 현행 문서 대조·"절대 추측 금지". 워크플로엔 `mcp_config` 없음·allowedTools=`Read,Bash(gh issue …)` → context7/WebFetch/WebSearch 전무. 클라우드 런이 학습데이터로 "현행 문서"를 지어내 ungrounded 주장 게시(스킬이 금지한 환각).
2. **skill↔workflow 권한계약 미검증** (low): 워크플로 allowedTools가 참조 스킬 요구를 충족하는지 게이트 없음(`skills-lint`는 frontmatter/secret/SHA핀만).
3. **adversarial find≠verify가 클라우드서 self-review로 붕괴** (low): 스킬은 독립 서브에이전트 refute 요구인데 `Task` 미허용 → 동일 에이전트 self-refute(편향). 클라우드 변종이 로컬보다 저신뢰인데 표시 없음.
4. **cadence·blast-radius 캡 부재** (low): `workflow_dispatch` 전용·`timeout-minutes`/`concurrency` 없음(heavy 에이전트 Claude Max 쿼터 소진 이력)·`Bash(gh issue comment:*)` verb-only glob(임의 이슈 코멘트 가능).
5. **문서 drift** (low~medium): AGENTS.md `CodeRabbit 미도입`=사실불일치(현재 활성)·`.claude/README.md` `workflows/` 섹션은 디렉터리 부재(doc-vs-reality).

## 2. Grounding (실측, 2026-07-01)

- **시크릿**: `CONTEXT7_API_KEY` 사용자 추가 완료(2026-07-01T06:13). `CLAUDE_CODE_OAUTH_TOKEN` 기존.
- **claude-code-action MCP 배선**(context7 현행 문서 대조): `claude_args`의 `--mcp-config`(파일 또는 인라인 JSON) + `--allowedTools mcp__server__tool` + `--max-turns N`(비용 캡). MCP 서버는 stdio(command/args/env) 또는 remote http.
- **context7 CI MCP**: remote http `{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"…"}}` — npx 미실행(공급망 표면 최소, #137 posture 정합). 또는 stdio `npx -y @upstash/context7-mcp`. → **remote http 채택**(unpinned npx 실행 회피).
- **스킬 계약**:
  - `fleet-cutoff-gap-audit`: context7(`resolve`/`query`) + `Task`(fan-out 독립 대조·refute) + `Read`(코드 대조) + `gh issue comment`. 등재는 "#27 후보로"(soft).
  - `fleet-backlog-rerank`: `gh issue view 27`+`list`(수집) + `Task`(refute; *스킬 자체 폴백* "불가 시 동일 에이전트 N회 독립 패스") + context7(교차검증) + `gh issue comment`. 조건부 create(sub-issue)·Write(ADR) — 11~13차 연속 0건.
- **두 워크플로 코멘트 타깃 = #135**(`.claude/` 자산 메타 트래커). `gh issue view`/`list`는 read-only.
- **skills-lint 게이트**: ci.yml이 `.github/workflows/*.yml`에 `npm run skills:lint` 강제. 신규 계약 lint는 자동 게이팅. 순수함수 + `.test.ts` 패턴(scanText/scanWorkflowPins/scanReleaseSafety/validateFrontmatter).
- **Codex 체크포인트 리뷰**: 2개 포크(등재/ADR 범위·cadence) 모두 내 추천안과 일치. 단 Codex 주장 커밋 `938ff4d`·PR은 **sandbox 유령**(git cat-file 부재·PR 없음·브랜치 없음, 실측). → 검증된 설계를 직접 랜딩.

## 3. 포크 결정 (Codex 논의 반영)

- **포크 A · 등재/ADR 범위** → **클라우드=추천 표만, 등재/ADR은 human-gated**. 클라우드는 근거+refute된 추천 표를 #135에 게시. sub-issue create·ADR commit·push는 로컬 human-gate(induction L2 선례·되돌리기 어려운 write·`persist-credentials:false` 강제 #175 유지). create/Write/push 미부여 → blast-radius 최소.
- **포크 B · cadence** → **cron 없음, dispatch 전용 + 캡**. `workflow_dispatch` 유지 + `timeout-minutes`+`concurrency`+#135 핀. 구독 OAuth(Claude Max) 쿼터 무인 소진 방지(실측 이력). e2e.yml 선례("안정화 후 cron").

## 4. 설계

### 4.1 워크플로 배선 (findings 1·3·4) — 두 `.yml` 공통

각 워크플로에 다음을 추가:

**(a) context7 시크릿 fail-fast 가드** (finding 1 — "no grounding → no run"):
```yaml
- name: Verify context7 secret present
  env:
    CONTEXT7_API_KEY: ${{ secrets.CONTEXT7_API_KEY }}
  run: |
    if [ -z "$CONTEXT7_API_KEY" ]; then
      echo "::error::CONTEXT7_API_KEY 시크릿 필요 — context7 현행 문서 그라운딩 없이는 환각 위험(no grounding → no run)"
      exit 1
    fi
```

**(b) mcp-config 파일 생성 스텝**(시크릿 인라인 비노출 — claude_args 로그 노출 회피):
```yaml
- name: Create context7 MCP config
  env:
    CONTEXT7_API_KEY: ${{ secrets.CONTEXT7_API_KEY }}
  run: |
    cat > "$RUNNER_TEMP/mcp-config.json" << EOF
    {"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"$CONTEXT7_API_KEY"}}}}
    EOF
```

**(c) claude_args 확장**:
```yaml
claude_args: |
  --mcp-config "$RUNNER_TEMP/mcp-config.json"
  --allowedTools "<스킬 cloud-tools 전체>"
  --max-turns 40
```
allowedTools = 해당 스킬 frontmatter `cloud-tools` 전량(context7 2종 + `Task` + `Read` + `gh` read verbs + `Bash(gh issue comment 135:*)` 핀).

**(d) job-레벨 캡** (finding 4):
```yaml
concurrency:
  group: <workflow>-${{ github.ref }}
  cancel-in-progress: false
jobs:
  <job>:
    runs-on: ubuntu-latest
    timeout-minutes: 30
```

> `--max-turns 40`·`timeout-minutes 30`은 초기 보수값(fan-out heavy). 실 dispatch 관측 후 조정.

### 4.2 스킬 `cloud-tools` 계약 선언 (finding 2)

두 SKILL.md frontmatter에 `cloud-tools:` YAML 리스트 추가 = 클라우드 실행 시 필요 툴의 기계판독 계약. 예(audit):
```yaml
---
name: fleet-cutoff-gap-audit
description: …
cloud-tools:
  - Read
  - Task
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
  - Bash(gh issue view:*)
  - Bash(gh issue comment 135:*)
---
```
rerank는 추가로 `Bash(gh issue list:*)`. **create/Write/push는 미포함**(human-gated — 포크 A). `cloud-tools` 부재 스킬 = 로컬 전용(계약 검사 대상 아님).

### 4.3 skills-lint 계약 강제 (finding 2 — TDD 핵심)

`scripts/skills-lint.mjs`에 순수함수 2개 추가(기존 zero-dep 패턴):

**`parseCloudTools(skillMarkdown) → string[] | null`**
frontmatter의 `cloud-tools:` 리스트를 수동 파싱(YAML dep 회피 — validateFrontmatter 선례). 항목 없으면 `null`(로컬 전용).

**`scanCloudContract(workflowText, contracts) → {rule, msg}[]`**
`contracts` = `{ [skillName]: string[] }`(cloud-tools 맵). 워크플로가 `anthropics/claude-code-action`을 쓰고 텍스트에 cloud-capable 스킬명을 참조하면, 그 스킬 계약 위반을 반환:

1. **allowedTools superset** — `--allowedTools` 파싱(따옴표·멀티라인 claude_args 내성; 콤마 분해) ⊇ 스킬 `cloud-tools`. 누락 툴마다 위반.
2. **context7 배선** — cloud-tools에 `mcp__context7__*` 있으면 워크플로에 `--mcp-config` + `context7`(서버명) + `secrets.CONTEXT7_API_KEY` 존재.
3. **secret fail-fast** — `-z "$CONTEXT7_API_KEY"` 가드 존재(무근거 실행 차단).
4. **Task → max-turns** — cloud-tools에 `Task` 있으면 `--max-turns` 존재(비용 캡).
5. **timeout-minutes** 존재.
6. **concurrency** 존재.
7. **코멘트 핀** — unpinned `Bash(gh issue comment:*)` 부재(핀된 `gh issue comment <N>:*`만 허용).

**CLI 배선**: `lintFile`은 단일파일 per-file 검사라 크로스파일 계약엔 부적합 → CLI 블록에서 `.claude/skills/*/SKILL.md`를 읽어 `contracts` 맵 구성 후, 각 `.github/workflows/*.yml`에 `scanCloudContract` 적용(무인자 실행·명시인자 실행 모두). 순수함수는 텍스트+맵 주입으로 단위테스트.

### 4.4 문서 정합 + ADR (finding 5)

- **AGENTS.md** 「Codex 리뷰 운영 기준」 CodeRabbit 절: "미도입" → "advisory 보조 리뷰어로 활성(비-required)". 현실 반영.
- **`.claude/README.md`**: `workflows/` 섹션을 "예약 위치 — 현재 추적 `.js` 가속본 0"으로 명확화(디렉터리 부재 = doc-vs-reality 제거). 스킬 표의 audit/rerank "로컬+클라우드"는 이제 참(배선 완료).
- **ADR-0006** — CodeRabbit advisory 채택(비-required gate) 결정 기록.
- **ADR-0007** — 클라우드 자동화 스킬 계약 강제 + human-gated write 결정(방향 A·포크 A·contract lint).

## 5. 파일

| 파일 | 변경 |
|---|---|
| `.github/workflows/cutoff-gap-audit.yml` | context7 배선·fail-fast·Task·max-turns·timeout·concurrency·핀 |
| `.github/workflows/backlog-rerank.yml` | 동상 (+ `gh issue list`) |
| `.claude/skills/fleet-cutoff-gap-audit/SKILL.md` | `cloud-tools` frontmatter |
| `.claude/skills/fleet-backlog-rerank/SKILL.md` | `cloud-tools` frontmatter |
| `scripts/skills-lint.mjs` | `parseCloudTools`·`scanCloudContract` + CLI 배선 |
| `scripts/skills-lint.test.ts` | 두 함수 TDD(RED→GREEN) |
| `.claude/README.md` | workflows/ 예약-표기 정정 |
| `AGENTS.md` | CodeRabbit 상태 갱신 |
| `docs/adr/0006-coderabbit-advisory-채택.md` | 신규 |
| `docs/adr/0007-클라우드-스킬-계약강제-human-gated-write.md` | 신규 |

## 6. 테스트 전략

- **TDD 핵심**: `parseCloudTools`·`scanCloudContract` 순수함수 RED→GREEN. 위반/통과 케이스(누락 툴·context7 미배선·max-turns 누락·unpinned 코멘트·timeout/concurrency 부재·로컬전용 스킬 skip·비-Claude 워크플로 skip). 실제 두 `.yml`+두 SKILL.md가 통과함을 단언(부재/드리프트 시 loud RED — release.yml 선례).
- **집계 게이트**: `npm run verify` green(skills:lint·typecheck·lint·test·build·format·brain).
- **실 클라우드 동작**(context7 응답·서브에이전트 스폰)은 이 PR 범위 밖 → 머지 후 사용자 `workflow_dispatch`로 검증(시크릿·쿼터 필요).

## 7. 범위 밖 (YAGNI)

- 클라우드 완전 자동등재(create sub-issue·ADR commit·push) — human-gated 유지(포크 A).
- cron cadence — dispatch 전용(포크 B).
- 실 클라우드 E2E — 머지 후 dispatch.
- `.claude/workflows/` `.js` 가속본 신규 생성 — 예약 위치만 정정(YAGNI).

## 8. 리스크 / 완화

- **lint false-RED**(멀티라인 claude_args·따옴표 파싱): 실제 두 워크플로로 통과 단언 + CRLF 정규화(기존 선례).
- **과설계**(ADR-0003 ROI 경계): 7개 assertion은 각각 finding 1/2/3/4에 1:1 매핑 — 산문 강제를 기계 강제로(관례→강제, #173/#174/#175 궤적). 로컬전용 스킬·비-Claude 워크플로는 skip(오탐 0).
- **실 클라우드 비활성**: 시크릿은 추가됐으나 실 dispatch 미검증 — fail-fast로 무근거 실행은 원천 차단(환각 불가).

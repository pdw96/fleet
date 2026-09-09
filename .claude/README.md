# `.claude/` — Fleet 운영 자산 (Claude 전용)

이 디렉터리는 Fleet 를 운영하는 **재사용 워크플로 자산**이다. 메타 추적 = 이슈 #135.

## skills/ (포터블 실행 단위 — 로컬 `Skill` 툴)

| 스킬 | 용도 | 실행 |
|---|---|---|
| `fleet-backlog-rerank` | 백로그 재랭킹(적대 검증) | 로컬만 |
| `fleet-cutoff-gap-audit` | context7↔코드 갭 감사 | 로컬만 |
| `fleet-pr-review` | 다차원 적대 PR 리뷰 | 로컬만(Codex 봇 중복) |
| `fleet-backlog-induction` | 백로그 착수 절차 래퍼 | 로컬만(L2-only) |
| `fleet-plan-panel` | 판사 패널 계획 수립 | 로컬만 |
| `fleet-advisor` | 1.0 완성도·운영 ROI 진단(deep/check) | 로컬만 |
| `fleet-release` | 출하 절차(주기 점검→개시→감시→산출물 확인) | 로컬만 |

> 클라우드(claude-code-action) 실행은 폐기됐다(ADR-0012) — 두 스킬은 로컬 `Skill` 툴로만 돈다.

## agents/ (Claude Code 커스텀 서브에이전트 — 스킬이 디스패치하는 역할 정의)

| 에이전트 | 역할 | 규율(정의에 내장) |
|---|---|---|
| `fleet-refuter` | 후보/주장/발견 반증(verify) | 기본 기각 · brain.md 먼저·코드가 권위 · file:line 의무 · verdict 스키마 · ADR-0003 ROI 렌즈 · 생태계 성숙≠내부 수요 · 재평가 트리거 명시 |
| `fleet-finder` | 렌즈 기반 탐지(find) | 렌즈는 호출 시 지정 · 구조화 출력 · 근거 없는 발견 금지 · **자기 발견 확정 금지**(find≠verify) |
| `fleet-planner` | 독립 구현 계획 초안(draft) | 각도는 호출 시 지정(리스크/MVP/계약) · 초안은 확정 아님(draft≠judge) |
| `fleet-plan-judge` | 초안 루브릭 채점(judge) | 렌즈 그룹 지정 · draft 작성 인스턴스와 분리 디스패치 |
| `fleet-sweeper` | 기계적 수집·나열(sweep) | **판정 금지**(해석은 finder/refuter 몫) · 표본 아닌 전수 · 잘라낸 범위 명시 · `model: haiku` 고정 |

스킬 산문("독립 서브에이전트 디스패치")의 실행 타입을 고정해, 세션마다 규율 프롬프트를
재작성하던 비효율을 없앤다(14차 재랭킹에서 동일 템플릿 7회 수기 작성 실측). 산문 권위는
여전히 AGENTS.md·각 SKILL.md — 에이전트는 실행 래퍼다.

**⚠ context7 툴명은 두 표기를 모두 적는다** — `mcp__context7__*` **와** `mcp__Context7__*`.
`tools:` 는 정확한 문자열 매칭 allowlist 이고, MCP 툴명은 `mcp__<서버명>__<툴명>` 으로 조립되는데
**서버명은 레포가 아니라 세션 환경이 정한다**: 이 레포엔 `.mcp.json` 이 없어서 로컬은
`settings.local.json`(비추적)의 키를, 원격(Claude Code on the web)은 claude.ai 커넥터 이름
`Context7`(대문자 C)를 쓴다. 한쪽만 적으면 **다른 쪽 환경에서 네 에이전트가 조용히 context7 을
잃는다** — 그러면 `fleet-cutoff-gap-audit`(스킬 정의 자체가 「context7 현행 문서와 코드를 fan-out
대조」)의 전제가 사라지고, 그 사실은 아무 신호 없이 지나간다. 해결 안 되는 이름은 그냥 매칭되지
않을 뿐이라 **양쪽 등재의 비용은 0** 이다. 이 정합을 강제하는 기계는 없다(`skills:lint` 는
차단패턴 스캔만 한다) — 새 에이전트를 추가할 때 사람이 함께 지킬 것.

## hooks/ + settings.json (기계 게이트 — 프롬프트 규율의 구조화)

### SessionStart (`hooks/session-start.mjs`)

세 가지를 한다: ⓪ **규율 안내를 세션 컨텍스트에 주입**(로컬·원격 공통), ① 원격 세션 `npm install`
(verify 실행 가능 상태), ② 원격 세션 `gh` 설치(머지 게이트의 부트스트랩 데드락 해소). ①② 의 근거는
훅 본문 주석이 권위다.

⓪ 이 필요한 이유: **`AGENTS.md` 는 자동 주입되지 않는다.** Claude Code 는 `CLAUDE.md`, Gemini CLI 는
`GEMINI.md` 만 읽고 그 둘은 「AGENTS.md 를 먼저 읽어라」는 얇은 포인터다(파일명 규약으로 네이티브
로드하는 것은 Codex CLI 뿐). 포인터를 따라가지 않은 세션은 규율을 잃은 채 작업하고 **그 유실은 아무
신호도 남기지 않는다.** SessionStart 의 stdout 이 세션 컨텍스트로 주입된다는 성질을 그 구멍에 쓴다.

⚠ **안내는 강제가 아니다** — 강제는 `npm run verify`·master ruleset·아래 머지 게이트가 한다. 또
**규율 본문을 훅에 복사하지 않는다**(포인터만): 복사하면 `AGENTS.md` 와 이중 권위가 되어 드리프트하고,
매 세션 로드 비용이 된다(ADR-0002 교훈). 주입 내용·바이트 상한은 `scripts/session-start-hook.test.ts`
가 고정한다.

**호스트별 짝 — 이 훅은 Claude Code 에서만 발동한다**(등록자가 `.claude/settings.json` 이다). 같은
포인터 구멍을 가진 Gemini CLI 는 자기 훅이 필요해 `.gemini/`(레포 루트, `.claude/*` 와 같은 allowlist
패턴으로 추적)에 짝을 둔다 — 주입 경로가 stdout **원문**이 아니라 `hookSpecificOutput.additionalContext`
**JSON** 이라 봉투가 갈리기 때문이다(원문을 뱉으면 Gemini 쪽에서 파싱 실패로 조용히 사라진다).
**문구는 `scripts/agent-guidance.mjs` 단일 출처를 공유**하고, 두 호스트가 같은 바이트를 내는지를
같은 테스트가 핀한다. Codex CLI 는 `AGENTS.md` 를 파일명 규약으로 네이티브 로드하므로 훅이 없다
(Codex PR#334 P1).

### PreToolUse (`hooks/require-codex-review.mjs`)

`settings.json` 의 `PreToolUse` hook(`hooks/require-codex-review.mjs`)이 머지를 게이트한다.
설계 = **canonical allowlist**(우회 형태 열거는 수렴하지 않는다 — 「이름이 아니라 형태」 교훈):
머지 능력 신호(raw `merge`+`gh`/`github`/`graphql`)가 보이는 Bash 명령은 정확히 한 형태
`gh pr merge <번호> [-R owner/repo] [플래그] --match-head-commit <SHA>`(단일 세그먼트)만
통과 후보이고, 그 외(REST·GraphQL·서브셸·인터프리터·복합 명령·머지 문구 인용)는 전부
fail-closed 차단한다(인용 오탐은 `--body-file` 로 우회). 인가 = **현재 head 결속 Codex 신호**
= head 를 리뷰한 공식 리뷰(commit_id 일치) **또는 head 를 본문으로 지목한 Codex 무결 리뷰
코멘트**이며, 그 게시가 base tip 전진 이후여야 한다(base 전진은 head 불변이어도 diff 를 바꾼다).
무결 코멘트 경로는 51R 추가 — **지적 0건 라운드는 공식 리뷰가 아예 발행되지 않고**
`Codex Review: Didn't find any major issues` + `**Reviewed commit:** <축약 SHA>` 코멘트로만
오므로, 공식 리뷰만 보면 리뷰가 깨끗할수록 머지가 막혔다(PR#288 자기 자신에서 실측). 인정 조건은
첫머리 앵커 + 무결 문구 + 본문의 모든 결속 SHA 가 현재 head 접두(7~40 hex)일 것 — 전부
fail-closed 방향이라 봇 문구가 바뀌면 막히는 쪽으로 넘어진다. **단 base 리타깃(`base_ref_changed`)이 한 번이라도
있었으면 공식 리뷰 경로를 통째로 건너뛰고 audited 폴백 마커만 인정한다**(41R P1: 시각으로는
리뷰를 새 base diff 에 인과 결속할 수 없다 — 리타깃 PR 은 폴백 경로 필수). **👍 리액션 경로는
폐기했다**(44R P1: 리액션은 commit 결속이 없어 head/base 전진을 인과 결속할 수 없다). 검증 후
`--match-head-commit` 을 검증 head 와 대조해 서버가 TOCTOU 를 거부하게 한다(차단 메시지가
복사 가능한 정확한 명령 제공). GitHub MCP merge_pull_request 는 구조화 입력이라 파싱 없이
동일 검증. Codex 무응답/base 전진 폴백 = 풀 렌즈 자가리뷰 완료 근거를 담은 OWNER 코멘트의
head-결속 마커 `[codex-gate-fallback] head=<현재 head SHA>`(해당 PR·감사 가능·head 변경 시
자동 실효·마커 작성이 base tip 전진 이후여야 유효). 판정 계약은
`scripts/require-codex-review.test.ts` 가 고정한다. 수동 점검은 hook 입력 JSON 을 파일로 만들어
`node .claude/hooks/require-codex-review.mjs < input.json`(명령 문자열에 머지 문구를 직접 쓰면
세션 라이브 hook 이 그 명령부터 차단한다 — 실측).

## workflows/ (예약 — Claude 로컬 가속 `.js`)

`Workflow` DSL 가속본을 둘 **예약 위치**다. **현재 추적 `.js` 가속본 0**(디렉터리 미생성). 신규 시
`.gitignore` negation(`!.claude/workflows/`) allowlist 로 편입되며, **Claude 전용·비포터블**·스킬(정의) 없이 `.js`만 존재 금지.

## 보안

추적 자산은 `npm run skills:lint`(경로·시크릿 스캔)를 통과해야 한다 — lint-staged·CI 강제. 개인 절대경로·키 금지.

## 제외(비추적)

`settings.local.json`(개인설정)·`worktrees/`(서브에이전트 격리)·`scheduled_tasks`·`routines` 등 런타임/로컬
자산은 레포 `.gitignore` 의 `.claude/*` allowlist 로 **기계적으로 제외**된다(산문 관례가 아니라 강제 — #175).
추적 자산은 `README.md`·`agents/`·`skills/`·`workflows/`·`hooks/*.mjs`·`settings.json` 뿐(allowlist negation). 새 추적 자산은 `.gitignore` negation 추가로 편입.

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

> 클라우드(claude-code-action) 실행은 폐기됐다(ADR-0012) — 두 스킬은 로컬 `Skill` 툴로만 돈다.

## agents/ (Claude Code 커스텀 서브에이전트 — 스킬이 디스패치하는 역할 정의)

| 에이전트 | 역할 | 규율(정의에 내장) |
|---|---|---|
| `fleet-refuter` | 후보/주장/발견 반증(verify) | 기본 기각 · brain.md 먼저·코드가 권위 · file:line 의무 · verdict 스키마 · ADR-0003 ROI 렌즈 · 생태계 성숙≠내부 수요 · 재평가 트리거 명시 |
| `fleet-finder` | 렌즈 기반 탐지(find) | 렌즈는 호출 시 지정 · 구조화 출력 · 근거 없는 발견 금지 · **자기 발견 확정 금지**(find≠verify) |

스킬 산문("독립 서브에이전트 디스패치")의 실행 타입을 고정해, 세션마다 규율 프롬프트를
재작성하던 비효율을 없앤다(14차 재랭킹에서 동일 템플릿 7회 수기 작성 실측). 산문 권위는
여전히 AGENTS.md·각 SKILL.md — 에이전트는 실행 래퍼다.

## hooks/ + settings.json (기계 게이트 — 프롬프트 규율의 구조화)

`settings.json` 의 `PreToolUse` hook(`hooks/require-codex-review.mjs`)이 머지를 게이트한다.
설계 = **canonical allowlist**(우회 형태 열거는 수렴하지 않는다 — 「이름이 아니라 형태」 교훈):
머지 능력 신호(raw `merge`+`gh`/`github`/`graphql`)가 보이는 Bash 명령은 정확히 한 형태
`gh pr merge <번호> [-R owner/repo] [플래그] --match-head-commit <SHA>`(단일 세그먼트)만
통과 후보이고, 그 외(REST·GraphQL·서브셸·인터프리터·복합 명령·머지 문구 인용)는 전부
fail-closed 차단한다(인용 오탐은 `--body-file` 로 우회). 인가 = **현재 head 결속 Codex 신호**
= head 를 리뷰한 공식 리뷰(commit_id 일치)만 인정하며, 그 제출이 base 리타깃·base tip 전진
이후여야 한다(base 전진은 head 불변이어도 diff 를 바꾼다). **👍 리액션 경로는 폐기했다**
(44R P1: 리액션은 commit 결속이 없어 head/base 전진을 인과 결속할 수 없다). 검증 후
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
추적 자산은 `README.md`·`agents/`·`skills/`·`workflows/` 뿐(allowlist negation). 새 추적 자산은 `.gitignore` negation 추가로 편입.

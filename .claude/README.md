# `.claude/` — Fleet 운영 자산 (Claude 전용)

이 디렉터리는 Fleet 를 운영하는 **재사용 워크플로 자산**이다. 메타 추적 = 이슈 #135.

## skills/ (포터블 실행 단위 — 로컬 `Skill` 툴 OR 클라우드 Action)

| 스킬 | 용도 | 실행 |
|---|---|---|
| `fleet-backlog-rerank` | 백로그 재랭킹(적대 검증) | 로컬 + 클라우드 |
| `fleet-cutoff-gap-audit` | context7↔코드 갭 감사 | 로컬 + 클라우드 |
| `fleet-pr-review` | 다차원 적대 PR 리뷰 | 로컬만(Codex 봇 중복) |
| `fleet-backlog-induction` | 백로그 착수 절차 래퍼 | 로컬만(L2-only) |

## workflows/ (예약 — Claude 로컬 가속 `.js`)

`Workflow` DSL 가속본을 둘 **예약 위치**다. **현재 추적 `.js` 가속본 0**(디렉터리 미생성). 신규 시
`.gitignore` negation(`!.claude/workflows/`) allowlist 로 편입되며, **Claude 전용·비포터블**·스킬(정의) 없이 `.js`만 존재 금지.

## 보안

추적 자산은 `npm run skills:lint`(경로·시크릿 스캔)를 통과해야 한다 — lint-staged·CI 강제. 개인 절대경로·키 금지.

## 제외(비추적)

`settings.local.json`(개인설정)·`worktrees/`(서브에이전트 격리)·`scheduled_tasks`·`routines` 등 런타임/로컬
자산은 레포 `.gitignore` 의 `.claude/*` allowlist 로 **기계적으로 제외**된다(산문 관례가 아니라 강제 — #175).
추적 자산은 `README.md`·`skills/`·`workflows/` 뿐(allowlist negation). 새 추적 자산은 `.gitignore` negation 추가로 편입.

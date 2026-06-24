# 워크플로 GitHub 동기화 — Phase 1 설계 (Claude 전용 스킬 + 타겟 클라우드 Action)

> 상태: 설계(브레인스토밍 산출). 작성 2026-06-24. **적대 리뷰 1회 + 범위 단순화(Claude 전용) 반영**(§13).
> 트랙: **신규 메타 이슈**(워크플로 동기화) — #27(코드 백로그)·#98(GitHub 플랫폼 위생)과 별개.
> 후속: 이 스펙 승인 → `writing-plans` 로 Phase 1 구현 계획.

## 0. 범위 결정 요약 (왜 이 형태인가)

이 레포의 실제 역할 분담: **Claude = 주동작 실행자**(재랭킹·갭감사·구현·오케스트레이션) /
**Codex = PR 리뷰어**(GitHub 봇, 이미 동작 — 우리 스킬 불필요, AGENTS.md 만 읽음) / **Gemini = 범위 밖**.
→ 오케스트레이션 워크플로를 *실행*하는 CLI 는 Claude 하나뿐이므로 **멀티-CLI 포터빌리티 기계장치
(`.codex/.gemini/.agents` 미러·sync 스크립트·크로스-CLI 디스패치·trust 게이트)는 전부 불필요**. 설계가
Claude 전용으로 단순화된다(=경량화 자동 선택).

실행 표면 = **로컬 스킬 + 타겟 클라우드 Action**: 스킬은 모두 로컬 실행 가능하고, 그 중 재랭킹·갭감사만
`claude-code-action` 으로 GitHub Actions 에서도 실행(결과를 GitHub 에 착지).

## 1. 배경 & 문제

Fleet 를 진행하는 **운영 워크플로**(재랭킹·컷오프 갭감사·PR 리뷰·백로그 착수)가 레포 밖이라
휘발·비가시·비재현이다:

- **AGENTS.md** — 프로세스가 *산문 관례*로만. 레포에 있음 ✅ (Claude·Codex 봇 공통으로 읽음)
- **멀티에이전트 Workflow 스크립트** — 세션 디렉터리에 **약 72개 `.js`** 흩어짐. 이름 재호출 불가, 레포 밖.
- **메모리·결정 근거** — 전역 `~/.claude/.../memory/`. 레포 밖.

결과: 다른 머신/세션에서 동일 프로세스 재현 불가, 무거운 오케스트레이션이 로컬 세션·구독 쿼터를 점유,
"왜 이렇게 결정했나"가 휘발성에만 남음.

**검증된 제약 (실측):** 커밋된 `.claude/{skills,workflows}` = 0개. git 경계 = `settings.local.json`
(전역 `~/.config/git/ignore`)·`.claude/worktrees/`(레포 `.git/info/exclude`)만 제외. `.claude/` 자체는 추적 가능.

## 2. 목표 & 비목표

**목표 (Phase 1):**

1. **재현성·이식성 (Claude)** — 클론하는 어떤 머신/세션이든 동일 운영 프로세스를 얻는다.
2. **클라우드 실행 (repo = 컴퓨트)** — 재랭킹·갭감사를 GitHub Actions 에서 트리거로 실행, 결과를
   GitHub(메타이슈)에 착지 → 로컬 세션 점유 해제·비동기·기록 가시화.
3. **프로세스 지식 보존·도그푸드** — 운영 프로세스를 재사용 자산으로 정착, Fleet 자체 운영에 적용.

**비목표:** 멀티-CLI(Codex/Gemini) 스킬 실행(범위 밖 — §0) · ADR/결정 로그(Phase 2) · 광범위
GitHub 자동화(#98 Skip 존중 — 본 스펙의 클라우드 Action 은 재랭킹·갭감사 **2개로 한정**) · 메모리 레포 이관.

## 3. 전체 이니셔티브 맥락

| Phase | 내용 | 상태 |
|---|---|---|
| **1** | Claude 스킬을 레포로 + 재랭킹·갭감사 **타겟 클라우드 Action** | **이 스펙** |
| 2 (C) | GitHub 결정·감사 로그 (ADR + 이슈/PR 연결) | 후속 |
| 3 (B) | 추가 자동화 (ROI 게이트 통과분만) | 후속 |

> Phase 1 은 자산 포착(A) + **좁은 클라우드 실행 슬라이스**(재랭킹·갭감사 2개)를 포함한다. 이는 #98 이
> 경계한 "광범위 자동화"가 아니라, 고가치·저빈도(수동 dispatch 위주) 2개로 한정한 의도적 슬라이스다.

## 4. 핵심 사실 (실측 근거)

**로컬 실행:** Claude Code 의 `Skill` 툴이 레포 `.claude/skills/` 를 네이티브 발견. 무거운 fan-out 은
`Workflow`/`Task` 툴로 가속(`.claude/workflows/*.js`).

**클라우드 실행 (context7 실측, `anthropics/claude-code-action`, 2026-06-24):**

- `anthropics/claude-code-action@v1` 로 GitHub Actions 에서 Claude Code 실행.
- **인증 2경로**: `anthropic_api_key`(API 키·토큰당 과금) **또는** `claude_code_oauth_token`(**구독 OAuth
  토큰** — `claude setup-token` 발급). 둘 다 GitHub Secret 으로만(워크플로 yaml 에 하드코딩 금지).
- **트리거**: `workflow_dispatch`(수동)·`schedule`(cron)·`pull_request`·@claude 멘션.
- **자동 모드**: `prompt` 입력 시 멘션 없이 즉시 실행. `--allowedTools` 로 gh CLI 등 허용 → 결과를
  이슈/PR 코멘트로 게시. (공식 예제: "주간 유지보수 → 이슈 생성", "PR 보안 리뷰".)
- ⚠️ Actions 에는 `Workflow` JS DSL 이 없다 — Action 은 **스킬/프롬프트**를 주고 Claude 가 Task/
  서브에이전트로 오케스트레이션한다. **즉 `.claude/skills/` 스킬이 로컬·클라우드 공유 실행 단위다.**

## 5. 아키텍처

```
AGENTS.md  (프로세스 권위 · 산문)  ──참조──┐   Claude + Codex 봇(리뷰 맥락) 공통
                                          ▼
.claude/skills/  (재사용 Claude 스킬)            ← 로컬 Skill 툴 OR 클라우드 Action 의 실행 단위
   fleet-backlog-rerank      ─┐
   fleet-cutoff-gap-audit    ─┤
   fleet-pr-review (로컬)     │
   fleet-backlog-induction   │
        │                     │
.claude/workflows/*.js        │  (선택) 로컬 Claude Workflow 가속
        │                     │
        ▼ (재랭킹·갭감사만)    │
.github/workflows/            │
   backlog-rerank.yml  ───────┘  claude-code-action · workflow_dispatch(+선택 cron)
   cutoff-gap-audit.yml          → 결과를 메타이슈 코멘트로

[변경 없음]  Codex 봇 = PR 리뷰어 (Claude/Action 이 연 PR 포함)
```

- **스킬 = 단일 실행 단위.** 로컬(Skill 툴)·클라우드(claude-code-action) 양쪽에서 같은 스킬을 실행.
- **L3 `.js` 가속**은 로컬 Claude 전용(Actions 엔 DSL 없음). 불변식: 스킬(정의) 없이 `.js` 만 존재 금지.
- **PR 리뷰는 로컬 스킬**(`fleet-pr-review`) — Codex 봇과 중복이라 클라우드 Action 으로 안 만든다.
  용도: Codex 한도 소진 시 대체·PR 전 자가리뷰(이번 스펙 적대 리뷰가 그 실증).

## 6. 레포 레이아웃 & 추적 정책

```
.claude/
  skills/
    fleet-backlog-rerank/SKILL.md
    fleet-cutoff-gap-audit/SKILL.md
    fleet-pr-review/SKILL.md
    fleet-backlog-induction/SKILL.md
  workflows/                       # 선택 L3 가속 (.js, 수확본)
    backlog-rerank.js
    cutoff-gap-audit.js
  README.md                        # .claude/ 인덱스
.github/workflows/
  backlog-rerank.yml               # claude-code-action, workflow_dispatch
  cutoff-gap-audit.yml             # claude-code-action, workflow_dispatch
AGENTS.md                          # 「백로그 착수 절차」 등이 .claude/skills/ 를 가리키게 배선
```

- **추적**: `.claude/skills/**`·`.claude/workflows/**`·`.claude/README.md`·`.github/workflows/*.yml`.
- **제외(기존 유지)**: `settings.local.json`(전역)·`.claude/worktrees/`(레포 exclude).
- 미러 디렉터리·sync 스크립트 **없음**(Claude 전용이라 불필요).
- `.claude/settings.json`(공유)은 **이번 Phase 범위 밖**(필요 시 §8 분리룰 적용해 별도 도입).

## 7. 시작 스킬 세트 (4개)

각 스킬 = `SKILL.md`(name·description frontmatter) + AGENTS.md 해당 절 **참조(중복 금지)**.

| 스킬 | 내용 | 실행 표면 | L3 `.js` |
|---|---|---|---|
| `fleet-backlog-rerank` | 후보 수집 → 적대 refute → 티어링(next/later/drop) | 로컬 + **클라우드** | `backlog-rerank.js` |
| `fleet-cutoff-gap-audit` | context7 현행문서 ↔ 코드 fan-out → net-new/정정 | 로컬 + **클라우드** | `cutoff-gap-audit.js` |
| `fleet-pr-review` | 다차원 적대 PR 리뷰(find→verify→합성), Fleet P1 신호 렌즈 | **로컬만** (Codex 중복) | (계획서 판단) |
| `fleet-backlog-induction` | 백로그 착수 절차 래퍼(선정→…→머지) | 로컬만 | **없음**(의도) |

- `fleet-backlog-induction` L3 없음 = 의도: 사람-게이트가 끼는 *선형 절차*라 fan-out `.js` 가속 부적합.
- 수확 원칙: 약 72개 세션 `.js` 중 대응 최신·최선본만 승격. 수확 시 §8 정규화로 stale CONTEXT·개인경로 strip.

## 8. 비밀 · 보안 경계 (강제 게이트)

수확원 세션 `.js` 약 72개 중 **42개가 개인 절대경로**(`C:\Users\qkreh\…`·AppData Temp·세션경로)를
박고 있다(실측, 30개가 수확 타깃). 따라서 "여부 grep"이 아니라 **차단 게이트**로 운용한다.

- **커밋 금지**: `settings.local.json`·전역 `.credentials.json`·API 키·`worktrees/`·실행 저널.
- **수확 정규화(의무)**: 절대경로 → `process.cwd()`/`__dirname`/상대/환경변수 치환(`const CWD/REPO/
  repoRoot`·AppData Temp scratchpad·`tool-results` 덤프 경로 inline 금지). **issue_read/pull_request_read
  원문 덤프를 `.js`/`.md`/skill 본문에 inline 금지** — 요약·코드참조만.
- **차단 패턴 셋**: `C:\\Users\\`·`/c/Users/`·`AppData[\\/]Local[\\/]Temp`·`projects[\\/]C--Users`·
  사용자명(`qkreh`)·키 접두(`ghp_`·`sk-`·AWS 등).
- **실행 지점**: `npm run skills:lint`(경로·시크릿 스캔, **fail-on-match**) + `lint-staged` 의
  `.claude/**/*.{js,md}`·`.github/workflows/*.yml` glob + CI step. 수동 grep 만으론 완화 불인정.
- **HIT 시**: 수확 중단 / 해당 파일 제외(정규화 통과 시에만 재시도).
- **GitHub Actions 시크릿**: `CLAUDE_CODE_OAUTH_TOKEN`(또는 `ANTHROPIC_API_KEY`)은 **repo Secret 으로만**,
  워크플로 yaml 에 평문 금지. Action 의 `--allowedTools` 는 **최소 권한**(필요한 gh 서브커맨드만).
- **push protection(#98)** 은 자격증명 패턴만 차단 — 경로·사설 산문은 위 사전 스캔이 책임.

## 9. GitHub 추적 — 신규 메타 이슈

#27/#98 과 별개 **신규 메타 이슈**(`area:devx`·`type:meta`). 본문 = Phase 1/2/3 분해 + Phase 1 스펙 링크.
체크포인트 리뷰(설계·스펙·계획을 이슈 코멘트 + `@codex review`; Codex 한도 소진 시 멀티에이전트 적대
리뷰로 대체 — 이번 실증)를 이 이슈에서 운용. **클라우드 Action 의 재랭킹·갭감사 결과도 이 이슈에 착지.**

## 10. 검증 / 측정가능 완료 기준

1. **(자산)** 4개 `SKILL.md` 가 `.claude/skills/` 에 frontmatter 규약 통과로 존재.
2. **(로컬 실행)** 최소 1개 스킬을 로컬 `Skill` 툴로 호출해 동작 확인.
3. **(클라우드)** `backlog-rerank.yml` 또는 `cutoff-gap-audit.yml` 을 `workflow_dispatch` 로 1회 실행 →
   green + 메타이슈에 결과 코멘트 착지(첫 dispatch 실검). 인증 secret 동작 확인.
4. **(무결성)** L3 `.js` 정적 점검(meta 리터럴·금지 API `Date.now`/`Math.random`) 0 위반.
5. **(보안)** §8 경로·시크릿 스캔 0 위반(fail-on-match).
6. **(게이트)** 품질 4종(typecheck/lint/test/build) green.

⚠️ **eslint 사각**: #134 가 `.claude/**` 통째 ignore + lint-staged `--no-warn-ignored` → 신설 추적
`.claude/{skills,workflows}` 가 lint/CI 에서 조용히 스킵. → §8 전용 스캔(`skills:lint`)을 lint-staged·CI 에
배선(eslint 자체는 Workflow DSL 글로벌 때문에 ignore 유지 합리적). eslint 주석 "gitignore됨" 전제 갱신.

## 11. 위험 & 완화

| 위험 | 완화 |
|---|---|
| 클라우드 Action 비용/쿼터 (재랭킹 1.4M 토큰 전력) | **수동 `workflow_dispatch` 위주**(공격적 cron 금지). OAuth 토큰=구독 쿼터(로컬 점유 해제), API 키=토큰당 과금. 비용/한도 합의 후 도입. |
| 구독 OAuth 토큰의 CI 사용 약관·한도 | §12 — 도입 전 ToS/한도 실측. 불가 시 API 키 폴백(소액). |
| 수확 `.js`·skill·yaml 에 개인경로·키·사설 산문·secret 유입 | §8 강제 게이트(정규화·차단 패턴·fail-on-match·HIT 시 중단). Actions 시크릿은 repo Secret 으로만. |
| 신설 자산이 eslint/pre-commit 사각(#134) | §10 — `skills:lint` 를 lint-staged·CI 배선. eslint 주석 갱신. |
| 스코프 크립(자동화로 번짐 — #98 경계) | 클라우드 Action 을 재랭킹·갭감사 **2개로 한정**. PR 리뷰는 Codex 봇/로컬. Phase 게이트. |
| 스케줄 노이즈(재랭킹 0건 반복 — #27: 13차는 트리거 기반) | 기본 dispatch-only. cron 도입 시 "신규 입력 있을 때만" 가드. |
| 롤백 | Phase 1 자산(skills/·workflows/·yml·README·gitignore·eslint 주석)을 **단일 PR** 로 랜딩 → 한 묶음 revert. |

## 12. 오픈 결정 (구현 계획서에서 확정)

- **클라우드 인증**: `claude_code_oauth_token`(구독, 기본) vs `anthropic_api_key`(소액 과금·디커플) —
  도입 전 구독 OAuth 의 CI 약관/한도 실측.
- **트리거**: `workflow_dispatch` only(기본) vs `+ schedule`(신규 입력 가드 동반 시).
- `fleet-pr-review` 의 L3 `.js` 수확 여부(로컬 전용이라 가속 가치 판단).
- L3 수확 대상 세션 스크립트 식별(메모리: cutoff-gap `wf_96534c26-abe`·hermes `wf_ef1cec60-66f` 등) + §8 정규화.

## 13. 변경 이력 (2026-06-24)

1. **적대 리뷰 1회**(Codex 한도 소진 대체, run `wf_403dec5f-337`): 28건 중 15건 확정 반영(보안 강제
   게이트 승격·완료기준·사실 정정 등).
2. **범위 단순화**: 사용자 결정으로 **Claude 전용 + 타겟 클라우드 Action** 으로 축소. 멀티-CLI 포터빌리티
   기계장치(포터블 SKILL.md 추상층·`.codex/.gemini/.agents` 미러·sync 스크립트·크로스-CLI 디스패치·trust
   게이트·표기 규약·degradation 폴백) **전부 제거** → 적대 리뷰 멀티-CLI 발견 ~6건 무효화. 남은 보안·일관성
   발견은 본문에 반영 유지. 신규: 클라우드 실행층(claude-code-action) 추가.

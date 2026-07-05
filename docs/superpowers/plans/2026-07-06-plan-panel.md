# 판사 패널 계획 수립 파이프라인 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 스펙을 독립 초안×3 → 독립 채점×2 → 합성으로 전개하는 판사 패널 계획 파이프라인(에이전트 2종 + 스킬 1종) 구축.

**Architecture:** L2-only 절차 스킬 + Agent 병렬 디스패치. `fleet-planner`(각도별 초안, 읽기 전용) → `fleet-plan-judge`(렌즈 그룹별 채점, 읽기 전용) → 메인 루프 합성. 스펙: `docs/superpowers/specs/2026-07-06-plan-panel-design.md`.

**Tech Stack:** Claude Code 커스텀 에이전트(`.claude/agents/*.md` frontmatter) · 스킬(`.claude/skills/*/SKILL.md`) · 게이트 = `npm run skills:lint` + `npm run format:check`.

## Global Constraints

- 전 산출물은 skills:lint 차단 패턴 금지: Windows 사용자 절대경로 · `AppData\Local\Temp` · 세션 디렉터리 경로 · 사용자명 리터럴 · 토큰/키 문자열 (`scripts/skills-lint.mjs` BANNED_PATTERNS).
- SKILL.md frontmatter에 `name:`·`description:` 필수 (skills:lint validateFrontmatter).
- 에이전트 frontmatter 형식은 기존 `fleet-finder.md`/`fleet-refuter.md`와 동일: `name`/`description`/`tools`(쉼표 나열)/`model: inherit`.
- planner/judge는 읽기 전용 — `tools:`에 Write/Edit/Bash 미포함 (도구 수준 강제, fleet-refuter 선례).
- 문서는 한국어, 기존 스킬 문체(간결 절차형) 준수.
- master 직접 커밋 금지(ruleset) — 전 작업은 `feat/plan-panel` 브랜치에서.
- 렌즈 그룹 명칭 통일: **공백 그룹** / **Codex 강점 그룹** (스킬↔에이전트 문서 간 표기 일치).

---

### Task 1: 브랜치 생성 + 스펙 문서 커밋

**Files:**

- Commit: `docs/superpowers/specs/2026-07-06-plan-panel-design.md` (이미 작성됨)

**Interfaces:**

- Produces: `feat/plan-panel` 브랜치 — 이후 모든 태스크의 작업 브랜치.

- [ ] **Step 1: 브랜치 생성**

```bash
git checkout -b feat/plan-panel
```

- [ ] **Step 2: 스펙 커밋**

```bash
git add docs/superpowers/specs/2026-07-06-plan-panel-design.md
git commit -m "docs: 판사 패널 계획 파이프라인 설계 스펙"
```

---

### Task 2: fleet-planner 에이전트

**Files:**

- Create: `.claude/agents/fleet-planner.md`

**Interfaces:**

- Consumes: 없음 (독립 문서).
- Produces: 에이전트 타입 `fleet-planner` — Task 4의 SKILL.md가 디스패치 대상으로 참조. 디스패치 계약: 프롬프트에 각도(`리스크 우선`/`MVP 우선`/`계약 우선`) 하나 + 스펙 전문 적재. 출력 = 계획 초안 전문(한국어).

- [ ] **Step 1: 파일 작성 (아래 전문 그대로)**

````markdown
---
name: fleet-planner
description: 승인된 스펙으로부터 독립 구현 계획 초안을 작성하는 전담 에이전트 — fleet-plan-panel 스킬의 draft 단계에 사용. 디스패치 시 각도(리스크 우선/MVP 우선/계약 우선) 하나를 프롬프트로 지정한다. 초안은 확정이 아니라 fleet-plan-judge 가 채점할 후보다(draft≠judge).
tools: Read, Glob, Grep, WebSearch, WebFetch, mcp__context7__resolve-library-id, mcp__context7__query-docs
model: inherit
---

# Fleet 계획 초안 planner

너는 Fleet 레포(멀티 LLM 오케스트레이션 Electron 앱, 솔로 개발자 pre-1.0)의 계획 초안 전담
에이전트다. 호출자가 넘긴 **승인된 스펙**을, 호출자가 지정한 **각도 하나로만** 구현 계획으로
전개한다. 각도:

- **리스크 우선** — 위협·회귀 가능성이 큰 지점부터 태스크 배치. 롤백 경로·가드 테스트 먼저.
- **MVP 우선** — 가치가 가장 빨리 검증되는 최소 슬라이스 먼저. 후속은 별도 태스크로 미룸.
- **계약 우선** — 인터페이스·타입·프로토콜을 먼저 고정하고 구현을 그 뒤에. 계약 테스트 선행.

## 절차

1. `brain.md` 를 먼저 읽어 구조를 파악한다(전체 `src/` 탐색 대체). 스펙이 언급하는 모듈만
   좁혀 읽는다.
2. 스펙의 요구를 태스크로 분해한다 — 태스크마다: 대상 파일(실측 경로) · TDD 사이클(RED→GREEN) ·
   검증 명령. 기존 `docs/superpowers/plans/` 양식을 따른다.
3. 라이브러리·SDK·CLI 관련 결정은 학습 지식이 아니라 context7/웹으로 현행 확인한다.

## Codex 선반영 체크리스트 (초안에 반드시 반영 — 체크포인트 리뷰 라운드 절약)

Codex 리뷰 502건 전수조사에서 나온 반복 지적 유형을 초안 단계에서 선제 반영한다:

- **ripple 전수** — 타입·계약 변경 시 전파 지점(인터페이스→래퍼→호출부→테스트 더블)을 태스크에
  전수 나열.
- **fail-closed** — 에러·분류불가 경로의 방향(throw/skip)을 태스크마다 명시. 보안 경로는
  fail-closed.
- **테스트 고정(pin)** — 합의사항·정책마다 그것을 고정하는 테스트를 지정. 구현 재량으로
  회귀해도 무신호가 되지 않게.
- **경계값 열거** — 빈 값·0·`..` 경로·rotation 류 경계 케이스를 태스크별로 열거.
- **형제 경로 스윕** — 수정 대상과 같은 패턴을 공유하는 형제 경로를 Grep 으로 실측해 스윕
  목록화.

## 규율

- **draft≠judge** — 자기 초안을 스스로 확정하거나 타 초안과 비교하지 않는다. 출력은
  fleet-plan-judge 가 채점할 후보다.
- 근거 없는 파일 경로·라인 인용 금지 — 인용은 Read/Grep 으로 실측한 것만.
- 읽기 전용 — Write/Edit/Bash 를 보유하지 않는다(도구 수준 강제). 계획 파일 작성은
  호출자(메인 루프)가 합성 후 수행한다.
- 워킹트리 밖 컨텍스트(이슈 본문·과거 결정)는 호출자가 프롬프트에 싣고, 공개 GitHub 리소스는
  WebFetch(`api.github.com`)로 조회한다.

## 출력 (최종 텍스트가 그대로 수확된다 — 결과만, 한국어)

계획 초안 전문: 머리말(각도·전제) → 태스크 목록(파일·TDD 사이클·검증 명령·경계값·ripple 목록) →
리스크·롤백 경로. 스펙과 모순되는 지점을 발견하면 말미에 «스펙 이슈» 로 별도 보고한다.
````

- [ ] **Step 2: lint 통과 확인**

```bash
node scripts/skills-lint.mjs .claude/agents/fleet-planner.md
```

Expected: `✓ skills:lint 통과 (1 파일)`

- [ ] **Step 3: 커밋**

```bash
git add .claude/agents/fleet-planner.md
git commit -m "feat: fleet-planner 에이전트 — 각도별 계획 초안 전담(draft≠judge)"
```

---

### Task 3: fleet-plan-judge 에이전트

**Files:**

- Create: `.claude/agents/fleet-plan-judge.md`

**Interfaces:**

- Consumes: fleet-planner 초안 전문(호출자가 프롬프트에 적재).
- Produces: 에이전트 타입 `fleet-plan-judge` — Task 4의 SKILL.md가 디스패치 대상으로 참조. 디스패치 계약: 프롬프트에 렌즈 그룹(`공백 그룹`/`Codex 강점 그룹`) 하나 + 초안 N개 전문 적재. 출력 = 점수표·승자·이식 목록·공통 결함.

- [ ] **Step 1: 파일 작성 (아래 전문 그대로)**

````markdown
---
name: fleet-plan-judge
description: 복수 계획 초안을 루브릭으로 독립 채점하고 승자와 이식 아이디어를 추출하는 전담 에이전트 — fleet-plan-panel 스킬의 judge 단계에 사용. 디스패치 시 렌즈 그룹(공백 그룹/Codex 강점 그룹)을 지정한다. draft 를 작성한 인스턴스와 반드시 분리 디스패치(draft≠judge).
tools: Read, Glob, Grep, mcp__context7__resolve-library-id, mcp__context7__query-docs
model: inherit
---

# Fleet 계획 판사

너는 Fleet 레포(멀티 LLM 오케스트레이션 Electron 앱, 솔로 개발자 pre-1.0)의 계획 채점 전담
에이전트다. 호출자가 넘긴 **계획 초안 N개**를 지정된 **렌즈 그룹**으로 독립 채점한다. 임무는
기각이 아니라 **비교 판별**이다 — 승자를 고르고, 패자에서 이식할 아이디어를 건진다
(fleet-refuter 와 자세가 다르다).

## 렌즈 그룹 (디스패치 시 하나 지정)

**공백 그룹** — Codex 체크포인트 리뷰가 구조적으로 안 잡는 축(리뷰 502건 전수조사 실측):

1. **대안 도전** — 이 계획의 프레임 자체가 최선인가? 더 싼 구조·기존 코드 재사용으로 같은
   목표를 달성할 수 없는가?
2. **솔로 pre-1.0 ROI** — ADR-0003 렌즈. 태스크별 비용 대비 실수요. 과설계·미래 가정 태스크 적발.
3. **검증가능성** — 태스크마다 검증 명령이 실행 가능한가? 라이브 스모크 계획이 있는가? 가짜
   green(구현을 검증 못 하는 테스트) 여지는?
4. **입도·순서** — 태스크가 독립 리뷰 가능한 크기인가? 의존 순서가 실제 빌드 순서와 맞는가?

**Codex 강점 그룹** — 체크포인트 리뷰와 이중 방어(Codex 한도 소진·부재 대비):

5. **계약 ripple 완전성** — 타입·계약 변경의 전파 지점 나열이 전수인가(Grep 으로 누락 실측).
6. **보안 fail-closed** — 에러·분류불가 경로 방향 명시 여부. 보안 경로 fail-open 여지.
7. **엣지·경계값** — 경계 케이스 열거의 빈틈(빈 값·0·`..` 경로·rotation 류).
8. **테스트 고정** — 합의→테스트 매핑 누락. 정책이 구현 재량으로 회귀 가능한 지점.

## 절차

1. `brain.md` 로 구조를 파악한 뒤, 초안들이 인용하는 파일·계약을 **실물로 대조**한다(초안의
   경로 인용이 실재하는지 Grep). 라이브러리 관련 주장은 context7 로 교차검증.
2. 렌즈별로 초안마다 1~5점 + 근거(초안 내 위치 인용). **근거 없는 점수 금지.**
3. 초안 간 실질 차이가 없으면(같은 태스크 분해·같은 순서) **각도 붕괴**로 보고한다 — 억지
   승자 선정 금지.

## 규율

- draft 를 작성한 인스턴스와 반드시 분리 디스패치된다(draft≠judge, 자기채점 편향 방지).
- 읽기 전용 — Write/Edit/Bash 를 보유하지 않는다(도구 수준 강제).
- 워킹트리 밖 컨텍스트는 호출자가 프롬프트에 싣는다.

## 출력 (최종 텍스트가 그대로 수확된다 — 결과만, 한국어)

- 초안별 렌즈 점수표(렌즈×초안, 1~5) + 렌즈별 근거 1~3줄.
- **승자**: 어느 초안, 왜(2~4줄).
- **이식 목록**: 패자 초안에서 승자에 이식할 아이디어(항목별 출처 초안 표기).
- **공통 결함**: 모든 초안이 놓친 것(있으면 — 합성 시 메인 루프가 보강).
````

- [ ] **Step 2: lint 통과 확인**

```bash
node scripts/skills-lint.mjs .claude/agents/fleet-plan-judge.md
```

Expected: `✓ skills:lint 통과 (1 파일)`

- [ ] **Step 3: 커밋**

```bash
git add .claude/agents/fleet-plan-judge.md
git commit -m "feat: fleet-plan-judge 에이전트 — 8렌즈 2그룹 계획 채점(이중 방어형)"
```

---

### Task 4: fleet-plan-panel 스킬

**Files:**

- Create: `.claude/skills/fleet-plan-panel/SKILL.md`

**Interfaces:**

- Consumes: Task 2의 `fleet-planner`, Task 3의 `fleet-plan-judge` (에이전트 타입명으로 참조).
- Produces: 스킬 `fleet-plan-panel` — Task 5에서 fleet-backlog-induction이 참조.

- [ ] **Step 1: 파일 작성 (아래 전문 그대로)**

````markdown
---
name: fleet-plan-panel
description: 판사 패널 계획 수립 — 승인된 스펙을 fleet-planner×3(리스크/MVP/계약 각도) 독립 초안 → fleet-plan-judge×2(공백/Codex 강점 렌즈 그룹) 채점 → 메인 루프 합성으로 전개. "판사 패널 계획", "패널로 계획 수립" 시 사용. 소형 작업은 패널 생략(적응형).
---

# Fleet 판사 패널 계획 수립

단일 패스 계획의 품질을 다중 초안 + 독립 채점으로 보전하는 파이프라인
(스펙: `docs/superpowers/specs/2026-07-06-plan-panel-design.md`).
fleet-pr-review 의 find≠verify 에 대응하는 계획판 규율 = **draft≠judge**.

## 언제

승인된 스펙이 있고 구현 계획이 필요할 때. fleet-backlog-induction 3단계(사이클)의 plan 작성을
이 스킬로 위임한다. **스펙이 없으면 중단** — brainstorm→spec 부터.

## 행동

1. **규모 판정** — 소형(대상 ≤2파일 · 신규 계약 0 · 단일 PR)이면 패널 생략, 메인 루프가 직접
   계획하고 생략 사실을 고지한다. 그 외는 패널 진행.
2. **draft** — `fleet-planner` ×3 병렬 디스패치(각도: 리스크 우선/MVP 우선/계약 우선).
   스펙 전문 + 대상 이슈 컨텍스트를 프롬프트에 싣는다.
3. **judge** — `fleet-plan-judge` ×2 병렬(judge A=공백 그룹, judge B=Codex 강점 그룹).
   초안 전문을 프롬프트에 싣는다. draft 인스턴스와 분리(draft≠judge).
4. **합성(메인 루프)** — 승자 골격 + 이식 목록 + 공통 결함 보강 →
   `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. 판사 점수 요약·판정 근거를 계획 머리말에
   기록하고 사용자 확인을 받는다.
5. **(선택) 외부 LLM 검토** — 사용자가 원하면 타 모델 검토용 전달 요약을 출력하고 대기,
   피드백 반영 후 다음 단계로.
6. **(조건부) Codex 체크포인트** — 대상 이슈가 있으면 계획을 이슈 코멘트로 게재 후
   `@codex review` 순수 한 줄(산문을 붙이면 파서가 놓침). 이슈가 없으면 생성/생략을 사용자에게
   질문. 리뷰 반영 → 통과까지 반복.
7. **실행 인계** — superpowers:subagent-driven-development 또는 superpowers:executing-plans.

## 강등 규칙 (조용한 강등 금지 — 전부 사용자 고지)

- planner 실패로 초안 <2 → 단일 초안 + judge 채점으로 강등.
- judge 전멸 → 메인 루프가 8렌즈 직접 채점(자기채점임을 명시).
- 판사 간 승자 불일치 → 렌즈별 점수 공개, 메인 루프 판정 + 근거를 계획 머리말에 기록.
- 레이트리밋 → planner 순차 재디스패치. 완료분 결과 재사용, 전체 재시작 금지.
- 각도 붕괴(초안 사실상 동일) → judge 생략, 단일 초안 취급.

## 주의

- 에이전트 `model: inherit` — 메인 세션 모델이 곧 패널 모델. 중요 계획은 상위 모델 세션에서
  호출하면 자동 상속된다.
- 합성 시 판사 지적을 공백 그룹/Codex 강점 그룹으로 구분해 기록 — 이후 Codex 체크포인트 결과와
  대조해 렌즈 실효(비중복 지적 ≥1건)를 측정한다.
````

- [ ] **Step 2: lint 통과 확인 (frontmatter 검증 포함)**

```bash
node scripts/skills-lint.mjs .claude/skills/fleet-plan-panel/SKILL.md
```

Expected: `✓ skills:lint 통과 (1 파일)`

- [ ] **Step 3: 커밋**

```bash
git add .claude/skills/fleet-plan-panel/SKILL.md
git commit -m "feat: fleet-plan-panel 스킬 — 판사 패널 계획 수립 절차(L2-only)"
```

---

### Task 5: fleet-backlog-induction 참조 추가

**Files:**

- Modify: `.claude/skills/fleet-backlog-induction/SKILL.md:19-20` (행동 3 「사이클」)

**Interfaces:**

- Consumes: Task 4의 스킬명 `fleet-plan-panel`.

- [ ] **Step 1: 사이클 단계에 패널 참조 추가**

기존:

```markdown
3. **사이클** — 비자명하면 brainstorm → spec(`docs/superpowers/specs/`) → plan(`docs/superpowers/plans/`).
```

수정:

```markdown
3. **사이클** — 비자명하면 brainstorm → spec(`docs/superpowers/specs/`) → plan(`docs/superpowers/plans/`
   — 중형+는 fleet-plan-panel 스킬(판사 패널)로 작성).
```

- [ ] **Step 2: lint 통과 확인**

```bash
node scripts/skills-lint.mjs .claude/skills/fleet-backlog-induction/SKILL.md
```

Expected: `✓ skills:lint 통과 (1 파일)`

- [ ] **Step 3: 커밋**

```bash
git add .claude/skills/fleet-backlog-induction/SKILL.md
git commit -m "docs: backlog-induction plan 단계에 fleet-plan-panel 위임 참조"
```

---

### Task 6: 전체 게이트 + 계획 문서 커밋 + PR

**Files:**

- Commit: `docs/superpowers/plans/2026-07-06-plan-panel.md` (본 문서)

- [ ] **Step 1: prettier 정합 (신규 md가 포맷 규칙에 맞는지 — CI format:check 게이트 선제)**

```bash
npx prettier --write .claude/agents/fleet-planner.md .claude/agents/fleet-plan-judge.md .claude/skills/fleet-plan-panel/SKILL.md .claude/skills/fleet-backlog-induction/SKILL.md docs/superpowers/specs/2026-07-06-plan-panel-design.md docs/superpowers/plans/2026-07-06-plan-panel.md
npm run format:check
```

Expected: format:check 통과. prettier가 파일을 고쳤으면 해당 변경을 이전 커밋에 맞게 `git add` 후 추가 커밋(`style: prettier 정합`).

- [ ] **Step 2: skills:lint 전체 실행 (크로스파일 계약 포함)**

```bash
npm run skills:lint
```

Expected: `✓ skills:lint 통과 (N 파일)` — 신규 3파일 포함.

- [ ] **Step 3: 계획 문서 커밋 + 푸시**

```bash
git add docs/superpowers/plans/2026-07-06-plan-panel.md
git commit -m "docs: 판사 패널 파이프라인 구현 계획"
git push -u origin feat/plan-panel
```

- [ ] **Step 4: PR 생성 (사용자 확인 후)**

```bash
gh pr create --title "feat: 판사 패널 계획 수립 파이프라인(fleet-planner/judge + plan-panel 스킬)" --body "## 개요
승인된 스펙을 독립 초안×3 → 독립 채점×2 → 합성으로 전개하는 판사 패널 계획 파이프라인.

- .claude/agents/fleet-planner.md — 각도별 초안 전담(읽기 전용, draft≠judge)
- .claude/agents/fleet-plan-judge.md — 8렌즈 2그룹 채점(이중 방어형)
- .claude/skills/fleet-plan-panel/SKILL.md — L2-only 절차(적응형 규모·강등 규칙·조건부 Codex 체크포인트)
- 설계 근거: Codex 리뷰 502건 전수조사(스펙 §1)

스펙: docs/superpowers/specs/2026-07-06-plan-panel-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

주의: 현재 Codex 주간 한도 소진 상태 — PR 자동리뷰가 오지 않을 수 있음. 한도 복구 후 `@codex review` 재트리거 또는 fleet-pr-review 스킬(자가 적대리뷰)로 대체 후 사용자 확인을 받아 squash 머지.

---

### Task 7: 드라이런 검증 (머지 후, 별도 세션 가능)

**Files:** 없음 (운영 검증)

- [ ] **Step 1: 다음 백로그 아이템(또는 tier:later 후보 1건)에 fleet-plan-panel 적용해 완주**
- [ ] **Step 2: 성공 기준 측정** — ① judge 지적 중 Codex 체크포인트 비중복 ≥1건(공백 렌즈 실효) ② Codex 체크포인트 P1 0건(선반영 체크리스트 효과) ③ 각도 분화 여부(각도 붕괴 발생 시 planner 각도 문구 조정).
- [ ] **Step 3: 미달 항목이 있으면 렌즈·체크리스트 문구를 조정하는 후속 커밋**

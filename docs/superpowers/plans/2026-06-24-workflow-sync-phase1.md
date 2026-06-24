# 워크플로 동기화 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이 레포의 운영 프로세스(재랭킹·갭감사·PR 리뷰·백로그 착수)를 재사용 Claude 스킬로 레포에 정착시키고, 재랭킹·갭감사를 GitHub Actions(claude-code-action)에서 타겟 실행한다.

**Architecture:** Claude 전용 3요소 — (1) `.claude/skills/` 4개 SKILL.md(로컬 실행 단위), (2) 선택적 `.claude/workflows/*.js` 로컬 가속, (3) `.github/workflows/*.yml`(claude-code-action으로 재랭킹·갭감사 클라우드 실행, 결과→메타이슈 #135). 보안은 `skills:lint` 강제 게이트(경로·시크릿 스캔 + SKILL.md frontmatter 검증)가 lint-staged·CI에서 fail-on-match로 담당.

**Tech Stack:** Node 24(ESM `.mjs`) · vitest · GitHub Actions · `anthropics/claude-code-action@v1` · gh CLI.

## Global Constraints

- **Claude 전용** — `.codex/skills`·`.gemini/skills`·`.agents/skills` 미러·sync 스크립트 **만들지 않는다**. Codex 봇(PR 리뷰)·Gemini는 범위 밖.
- **차단 패턴 셋(§8)** — 어떤 추적 자산(SKILL.md·`.js`·`.yml`)에도 금지: `C:\Users\`·`/c/Users/`·`AppData[\/]Local[\/]Temp`·`projects[\/]C--Users`·사용자명 `qkreh`·키 접두 `ghp_`·`sk-`·`AKIA…`. 위반 = `skills:lint` exit 1.
- **주석·식별자 설명은 한국어**. 기존 코드 관용구 따름.
- **스킬 본문 = 행동 기술**, AGENTS.md 해당 절 **참조(중복 금지)**. Claude 전용 명사(`Workflow`/`Task`) 강요 금지 — "서브에이전트 N개 디스패치 → 독립 검증 → 합성" 같은 행동으로.
- **Actions** = `claude-code-action@v1` · 인증 `claude_code_oauth_token`(repo Secret `CLAUDE_CODE_OAUTH_TOKEN`, 구독 OAuth) · `workflow_dispatch`(cron 없음) · `--allowedTools` 최소권한 · 결과→이슈 #135.
- **단일 PR 랜딩** — 본 Phase 전체를 `feat/workflow-sync-phase1` 한 브랜치/PR로(롤백 단위). 스펙 커밋 `56a2208` 이미 포함.
- **eslint** — `.claude/**` 전역 ignore는 **유지**(Workflow DSL 글로벌 때문). 보안 게이트는 eslint가 아니라 `skills:lint`.

**스펙:** `docs/superpowers/specs/2026-06-24-workflow-sync-phase1-design.md` · **추적 이슈:** #135

---

## File Structure

| 파일 | 책임 |
|---|---|
| `scripts/skills-lint.mjs` (생성) | 경로·시크릿 스캔 + SKILL.md frontmatter 검증. 순수 함수 + CLI. |
| `scripts/skills-lint.test.ts` (생성) | scanText·validateFrontmatter 단위 테스트. |
| `package.json` (수정) | `skills:lint` 스크립트 + lint-staged glob. |
| `.github/workflows/ci.yml` (수정) | `skills:lint` CI step. |
| `eslint.config.mjs` (수정) | `.claude/**` ignore 주석 갱신(일부 추적 전환). |
| `.claude/skills/fleet-backlog-rerank/SKILL.md` (생성) | 재랭킹 스킬(로컬+클라우드). |
| `.claude/skills/fleet-cutoff-gap-audit/SKILL.md` (생성) | 갭감사 스킬(로컬+클라우드). |
| `.claude/skills/fleet-pr-review/SKILL.md` (생성) | PR 적대 리뷰 스킬(로컬만). |
| `.claude/skills/fleet-backlog-induction/SKILL.md` (생성) | 백로그 착수 절차 래퍼(로컬, L2-only). |
| `.claude/README.md` (생성) | `.claude/` 자산 인덱스. |
| `.github/workflows/backlog-rerank.yml` (생성) | 재랭킹 클라우드 Action. |
| `.github/workflows/cutoff-gap-audit.yml` (생성) | 갭감사 클라우드 Action. |
| `AGENTS.md` (수정) | 「백로그 착수 절차」가 `.claude/skills/`를 가리키게 배선. |
| `.claude/workflows/backlog-rerank.js` (생성, 선택) | 재랭킹 로컬 가속(수확·정규화). |
| `.claude/workflows/cutoff-gap-audit.js` (생성, 선택) | 갭감사 로컬 가속(수확·정규화). |

---

## Task 1: `skills:lint` 스캐너 핵심 (순수 함수, TDD)

**Files:**
- Create: `scripts/skills-lint.mjs`
- Test: `scripts/skills-lint.test.ts`

**Interfaces:**
- Produces: `scanText(text: string): { line: number, pattern: string }[]` (차단 패턴 매치 목록, 없으면 `[]`) · `validateFrontmatter(text: string): { ok: boolean, errors: string[] }` (SKILL.md frontmatter에 `name`·`description` 존재 검증).

- [ ] **Step 1: 실패 테스트 작성**

```ts
// scripts/skills-lint.test.ts
import { describe, it, expect } from 'vitest'
import { scanText, validateFrontmatter } from './skills-lint.mjs'

describe('scanText — 차단 패턴', () => {
  it('Windows 절대경로를 잡는다', () => {
    const hits = scanText('const CWD = "C:\\\\Users\\\\qkreh\\\\fleet"')
    expect(hits.length).toBeGreaterThan(0)
  })
  it('Git Bash 경로·세션 디렉터리를 잡는다', () => {
    expect(scanText('/c/Users/qkreh/.claude').length).toBeGreaterThan(0)
    expect(scanText('projects/C--Users-qkreh-fleet/abc').length).toBeGreaterThan(0)
  })
  it('AppData Temp·사용자명·키 접두를 잡는다', () => {
    expect(scanText('AppData/Local/Temp/claude').length).toBeGreaterThan(0)
    expect(scanText('hello qkreh world').length).toBeGreaterThan(0)
    expect(scanText('token=ghp_' + 'a'.repeat(36)).length).toBeGreaterThan(0)
  })
  it('깨끗한 내용은 통과(빈 배열)', () => {
    expect(scanText('const repo = process.cwd(); // 상대경로만')).toEqual([])
  })
  it('매치에 라인 번호를 단다', () => {
    const hits = scanText('line1\nC:\\\\Users\\\\x\nline3')
    expect(hits[0].line).toBe(2)
  })
})

describe('validateFrontmatter — SKILL.md', () => {
  it('name·description 있으면 ok', () => {
    const md = '---\nname: fleet-x\ndescription: 한 줄 설명\n---\n본문'
    expect(validateFrontmatter(md).ok).toBe(true)
  })
  it('frontmatter 없으면 실패', () => {
    expect(validateFrontmatter('# 제목\n본문').ok).toBe(false)
  })
  it('description 누락 시 실패+사유', () => {
    const r = validateFrontmatter('---\nname: fleet-x\n---\n본문')
    expect(r.ok).toBe(false)
    expect(r.errors.join()).toMatch(/description/)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx vitest run scripts/skills-lint.test.ts`
Expected: FAIL — `Failed to resolve import "./skills-lint.mjs"` (파일 없음).

- [ ] **Step 3: 최소 구현 작성**

```js
// scripts/skills-lint.mjs
// .claude/skills·.claude/workflows·.github/workflows 추적 자산의 경로·시크릿 누출과
// SKILL.md frontmatter 규약을 검사하는 강제 게이트(스펙 §8). fail-on-match.

/** 차단 패턴 셋 — 개인 절대경로·세션경로·사용자명·자격증명 (스펙 §8) */
export const BANNED_PATTERNS = [
  { re: /C:\\Users\\/i, name: 'Windows 사용자 절대경로' },
  { re: /\/c\/Users\//i, name: 'Git Bash 사용자 절대경로' },
  { re: /AppData[\\/]Local[\\/]Temp/i, name: 'AppData Temp 경로' },
  { re: /projects[\\/]C--Users/i, name: '세션 디렉터리 경로' },
  { re: /\bqkreh\b/, name: '사용자명 리터럴' },
  { re: /\bghp_[A-Za-z0-9]{20,}\b/, name: 'GitHub 토큰' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, name: 'API 키(sk-)' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS 액세스 키' },
]

/** 텍스트를 줄 단위로 스캔해 차단 패턴 매치를 반환 */
export function scanText(text) {
  const hits = []
  const lines = text.split('\n')
  lines.forEach((content, i) => {
    for (const { re, name } of BANNED_PATTERNS) {
      if (re.test(content)) hits.push({ line: i + 1, pattern: name })
    }
  })
  return hits
}

/** SKILL.md frontmatter에 name·description이 있는지 검증 */
export function validateFrontmatter(text) {
  const errors = []
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return { ok: false, errors: ['frontmatter(--- 블록) 없음'] }
  const fm = m[1]
  if (!/^name:\s*\S+/m.test(fm)) errors.push('name 누락')
  if (!/^description:\s*\S+/m.test(fm)) errors.push('description 누락')
  return { ok: errors.length === 0, errors }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run scripts/skills-lint.test.ts`
Expected: PASS (전 케이스).

- [ ] **Step 5: 커밋**

```bash
git add scripts/skills-lint.mjs scripts/skills-lint.test.ts
git commit -m "feat(workflow-sync): #135 skills:lint 스캐너 핵심(scanText·validateFrontmatter) + 테스트"
```

---

## Task 2: `skills:lint` CLI + lint-staged + CI 배선

**Files:**
- Modify: `scripts/skills-lint.mjs` (CLI main 추가)
- Modify: `package.json` (scripts·lint-staged)
- Modify: `.github/workflows/ci.yml` (step 추가)
- Modify: `eslint.config.mjs` (주석 갱신)

**Interfaces:**
- Consumes: `scanText`·`validateFrontmatter` (Task 1).
- Produces: `npm run skills:lint` — 인자 파일들(또는 기본 글롭)을 검사, 위반 시 stderr 출력 + exit 1.

- [ ] **Step 1: CLI main 추가 (skills-lint.mjs 끝에 append)**

```js
// --- CLI ---
import { readFileSync, existsSync } from 'node:fs'
import { argv, exit } from 'node:process'

/** 단일 파일 검사 → 위반 메시지 배열 */
export function lintFile(path) {
  const msgs = []
  const text = readFileSync(path, 'utf8')
  for (const h of scanText(text)) msgs.push(`${path}:${h.line} 차단패턴[${h.pattern}]`)
  if (path.endsWith('SKILL.md')) {
    const r = validateFrontmatter(text)
    if (!r.ok) for (const e of r.errors) msgs.push(`${path} frontmatter: ${e}`)
  }
  return msgs
}

// 이 파일이 직접 실행될 때만 CLI 동작 (import 시엔 동작 안 함)
if (import.meta.url === `file://${argv[1]}` || argv[1]?.endsWith('skills-lint.mjs')) {
  const files = argv.slice(2).filter(existsSync)
  const all = files.flatMap(lintFile)
  if (all.length) {
    console.error('✗ skills:lint 위반:\n' + all.map((m) => '  ' + m).join('\n'))
    exit(1)
  }
  console.log(`✓ skills:lint 통과 (${files.length} 파일)`)
}
```

- [ ] **Step 2: package.json 에 스크립트·lint-staged 추가**

`scripts` 에 추가:
```json
"skills:lint": "node scripts/skills-lint.mjs"
```
`lint-staged` 에 추가(기존 객체에 키 추가):
```json
".claude/skills/**/*.md": ["node scripts/skills-lint.mjs"],
".claude/workflows/**/*.js": ["node scripts/skills-lint.mjs"],
".github/workflows/*.yml": ["node scripts/skills-lint.mjs"]
```

- [ ] **Step 3: 수동 검증 — 위반 파일이 차단되는지**

Run:
```bash
mkdir -p .claude/skills/__probe && printf -- '---\nname: x\ndescription: y\n---\nconst C="C:\\\\Users\\\\qkreh"\n' > .claude/skills/__probe/SKILL.md
node scripts/skills-lint.mjs .claude/skills/__probe/SKILL.md; echo "exit=$?"
rm -rf .claude/skills/__probe
```
Expected: `✗ skills:lint 위반 … 차단패턴[Windows 사용자 절대경로] … 사용자명 리터럴` · `exit=1`.

- [ ] **Step 4: CI 에 step 추가 (`.github/workflows/ci.yml`)**

기존 quality job 의 `npm run lint` step **다음**에 추가(들여쓰기 맞춤):
```yaml
      - name: skills:lint (경로·시크릿 게이트)
        run: node scripts/skills-lint.mjs .claude/skills/**/*.md .claude/workflows/**/*.js .github/workflows/*.yml
        shell: bash
```

- [ ] **Step 5: eslint.config.mjs 주석 갱신**

`.claude/**` 를 ignores 에 넣은 줄의 주석을, "gitignore 됨" 전제 대신 현행으로 수정:
```js
// .claude/** 는 eslint 대상에서 제외(워크플로 worktree·Workflow DSL 글로벌 때문).
// 단 .claude/skills·workflows 일부는 git 추적되며 보안/규약은 `npm run skills:lint`(lint-staged·CI)가 담당.
```

- [ ] **Step 6: 게이트 전체 통과 확인 + 커밋**

Run: `npm run typecheck && npm run lint && npx vitest run scripts/skills-lint.test.ts`
Expected: 전부 PASS.
```bash
git add scripts/skills-lint.mjs package.json .github/workflows/ci.yml eslint.config.mjs
git commit -m "feat(workflow-sync): #135 skills:lint CLI + lint-staged·CI 배선 + eslint 주석 갱신"
```

---

## Task 3: L2 스킬 4개 (SKILL.md)

**Files:**
- Create: `.claude/skills/fleet-backlog-rerank/SKILL.md`
- Create: `.claude/skills/fleet-cutoff-gap-audit/SKILL.md`
- Create: `.claude/skills/fleet-pr-review/SKILL.md`
- Create: `.claude/skills/fleet-backlog-induction/SKILL.md`

**Interfaces:**
- Consumes: `skills:lint`(Task 2) — frontmatter·경로 검증.
- Produces: Claude `Skill` 툴이 발견하는 4개 스킬. 각 본문은 AGENTS.md 절을 참조하고 행동으로 기술.

- [ ] **Step 1: `fleet-backlog-rerank/SKILL.md` 작성**

```markdown
---
name: fleet-backlog-rerank
description: Fleet 백로그 재랭킹 — #27 차기공급원+신규 입력을 적대 검증으로 재평가해 next/later/drop 티어링. "이슈 27 재랭킹/큐레이션" 류 요청 시 사용.
---

# Fleet 백로그 재랭킹

#27(메타 백로그)의 후보를 재평가해 티어를 갱신한다. 권위·절차는 AGENTS.md
「백로그 착수 절차」, 후보 출처는 #27 본문 «🔬 차기 공급원».

## 언제

"#27 재랭킹", "백로그 큐레이션", "차기 작업 재평가" 류 요청.

## 행동 (CLI 비종속)

1. **수집** — `gh issue view 27 --repo pdw96/fleet` 본문 후보 + 신규 입력 이슈(라벨 `tier:*`)를 모은다.
2. **fan-out 검증** — 후보마다 **독립 서브에이전트를 디스패치**해 적대적으로 refute 한다
   (현행 코드/문서 재검증 — 상당수 refuted 전력). 병렬 가용 시 N개 동시, 불가 시 동일 에이전트 N회 독립 패스.
3. **티어링** — refute 생존분을 `tier:next`/`tier:later`/`drop` 으로 분류. 솔로 pre-1.0 ROI 렌즈 적용.
4. **산출** — 재랭킹 표(후보·verdict·근거)를 코멘트로. 즉시등재분은 sub-issue 로 등재.

## 주의

- 컷오프 이후 변경 가능 — 라이브러리/모델/SDK 관련은 context7로 현행 교차검증.
- 결과는 #27 코멘트 또는 추적 이슈(#135 클라우드 실행 시)에 남긴다.
```

- [ ] **Step 2: `fleet-cutoff-gap-audit/SKILL.md` 작성**

```markdown
---
name: fleet-cutoff-gap-audit
description: Fleet 컷오프 갭 감사 — context7 현행 문서와 Fleet 코드를 fan-out 대조해 net-new 기능·정정 후보를 찾는다. "컷오프 갭 분석", "현행 문서 대비 누락 점검" 시 사용.
---

# Fleet 컷오프 갭 감사

provider/SDK/CLI의 **현행 문서(context7)** 와 Fleet 코드를 대조해 미반영 기능·정정 대상을 수확한다.

## 언제

"컷오프 갭 분석", "context7 대비 Fleet 누락", "provider 현행 기능 점검" 류 요청.

## 행동 (CLI 비종속)

1. **영역 분할** — anthropic·openai·google·mcp 등 영역별로 나눈다.
2. **fan-out 대조** — 영역마다 **독립 서브에이전트 디스패치**: context7로 현행 문서를 받아
   Fleet 코드(`src/main/core/providers/*` 등)와 대조, net-new/정정 후보 추출.
3. **적대 검증** — 후보를 refute(이미 출하됨? 클라 SHOULD≠MUST? stale 전제?).
4. **산출** — net-new + 정정 표를 근거와 함께. 등재 가치 있으면 #27 후보로.

## 주의

- 모델 페이지 endpoints 표는 보일러플레이트 — prose가 권위.
- 절대 추측 금지: 갭 주장은 context7 현행 문서로 뒷받침.
```

- [ ] **Step 3: `fleet-pr-review/SKILL.md` 작성**

```markdown
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

1. **렌즈 분할** — Fleet 특화 P1 신호(AGENTS.md 「Codex 리뷰 운영 기준」: 코어 Electron 유입·
   ApprovalGate 우회·IPC/FleetBridge drift·provider 계약·FLEET_E2E 가드·engine/lockfile·release 안전장치)
   + 보안·정합성·범위 렌즈.
2. **find** — 렌즈별 **독립 서브에이전트 디스패치**로 결함 탐지(구조화 출력: severity·위치·문제·제안).
3. **verify(refute)** — 각 발견을 별도 서브에이전트가 refute 시도(불확실하면 거짓양성으로 기각).
4. **합성** — 확정 발견만 severity별로. 거짓양성은 사유와 함께 기록.

## 주의

- find와 verify는 **다른 에이전트**로(자기검증 편향 방지).
- 리뷰 지적의 라이브러리/모델 관련은 context7로 교차검증 후 수용/반박.
```

- [ ] **Step 4: `fleet-backlog-induction/SKILL.md` 작성**

```markdown
---
name: fleet-backlog-induction
description: Fleet 백로그 착수 절차 래퍼 — 선정→브랜치→사이클(brainstorm→spec→plan→TDD→게이트)→PR(Closes #N)→Codex 대기→머지 후 동기화. "이슈 27 확인하고 작업 진행" 류 지시 시 사용.
---

# Fleet 백로그 착수 절차

AGENTS.md 「백로그 착수 절차」의 실행가능 래퍼. **사람-게이트(브레인스토밍 승인·Codex 리뷰 대기)가
끼는 선형 절차**라 fan-out 가속 `.js`가 없다(L2-only).

## 언제

"#27 확인하고 작업 진행", "백로그 다음 항목 착수" 류 지시.

## 행동 (절차)

1. **선정** — `gh issue view 27` 의 sub-issue 트래커에서 `tier:next` 최상위(모호하면 사용자 확인).
2. **브랜치** — master 직접 금지(ruleset). `feat/<slug>` 생성.
3. **사이클** — 비자명하면 brainstorm → spec(`docs/superpowers/specs/`) → plan(`docs/superpowers/plans/`).
   TDD(RED→GREEN). 품질 게이트 4종 green. 적대 리뷰.
4. **PR** — 본문 `Closes #<N>`. Codex 봇 자동리뷰 대기·반영(스레드 resolve). 사용자 확인 후 squash.
5. **머지 후** — 이슈 닫힘·#27 진행률 자동. 보드 Done(자동). #27 본문 트래커 보정(수동).

## 주의

- 라벨 규약: `area:*`+`tier:*`(+`type:*`). 새 이슈는 `--parent 27`.
- 자세한 gh 명령·보드 id 출처는 AGENTS.md 참조(여기 중복 금지).
```

- [ ] **Step 5: skills:lint 통과 확인**

Run: `node scripts/skills-lint.mjs .claude/skills/**/*.md`
Expected: `✓ skills:lint 통과 (4 파일)` (frontmatter·경로 위반 0).

- [ ] **Step 6: 커밋**

```bash
git add .claude/skills/
git commit -m "feat(workflow-sync): #135 L2 스킬 4개(rerank·gap-audit·pr-review[로컬]·induction)"
```

---

## Task 4: `.claude/README.md` 인덱스 + AGENTS.md 배선

**Files:**
- Create: `.claude/README.md`
- Modify: `AGENTS.md` (「백로그 착수 절차」 도입부)

**Interfaces:**
- Consumes: Task 3 스킬 4개.

- [ ] **Step 1: `.claude/README.md` 작성**

```markdown
# `.claude/` — Fleet 운영 자산 (Claude 전용)

이 디렉터리는 Fleet 를 운영하는 **재사용 워크플로 자산**이다. 메타 추적 = 이슈 #135.

## skills/ (포터블 실행 단위 — 로컬 `Skill` 툴 OR 클라우드 Action)

| 스킬 | 용도 | 실행 |
|---|---|---|
| `fleet-backlog-rerank` | 백로그 재랭킹(적대 검증) | 로컬 + 클라우드 |
| `fleet-cutoff-gap-audit` | context7↔코드 갭 감사 | 로컬 + 클라우드 |
| `fleet-pr-review` | 다차원 적대 PR 리뷰 | 로컬만(Codex 봇 중복) |
| `fleet-backlog-induction` | 백로그 착수 절차 래퍼 | 로컬만(L2-only) |

## workflows/ (선택 · Claude 로컬 가속 `.js`)

`Workflow` DSL 가속본. **Claude 전용·비포터블**. 스킬(정의) 없이 `.js`만 존재 금지.

## 보안

추적 자산은 `npm run skills:lint`(경로·시크릿 스캔)를 통과해야 한다 — lint-staged·CI 강제. 개인 절대경로·키 금지.

## 제외(비추적)

`settings.local.json`(비밀)·`worktrees/`(런타임)·실행 저널.
```

- [ ] **Step 2: AGENTS.md 「백로그 착수 절차」 도입부에 스킬 포인터 추가**

`## 백로그 착수 절차 (이슈 #27 기반)` 섹션 첫 문단 끝에 다음 한 줄 추가:
```markdown
> 이 절차·재랭킹·갭감사·리뷰는 `.claude/skills/`(fleet-backlog-induction·fleet-backlog-rerank·
> fleet-cutoff-gap-audit·fleet-pr-review)에 재사용 스킬로도 정착돼 있다(이슈 #135). 산문은 이 절이 권위, 스킬은 실행 래퍼.
```

- [ ] **Step 3: skills:lint + 게이트 확인 + 커밋**

Run: `node scripts/skills-lint.mjs .claude/skills/**/*.md && npm run lint`
Expected: PASS.
```bash
git add .claude/README.md AGENTS.md
git commit -m "docs(workflow-sync): #135 .claude/README 인덱스 + AGENTS.md 스킬 배선"
```

---

## Task 5: 클라우드 Action 2개 (claude-code-action)

**Files:**
- Create: `.github/workflows/backlog-rerank.yml`
- Create: `.github/workflows/cutoff-gap-audit.yml`

**Interfaces:**
- Consumes: Task 3 스킬(rerank·gap-audit) · repo Secret `CLAUDE_CODE_OAUTH_TOKEN`.

- [ ] **Step 1: `backlog-rerank.yml` 작성**

```yaml
name: Backlog Rerank
on:
  workflow_dispatch:
    inputs:
      note:
        description: "재랭킹 트리거 사유(신규 입력 등)"
        required: false
permissions:
  contents: read
  issues: write
jobs:
  rerank:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: |
            fleet-backlog-rerank 스킬의 절차를 따라 #27 백로그를 재랭킹하라.
            트리거 사유: ${{ github.event.inputs.note }}
            결과 표(후보·verdict·근거)를 이슈 #135 에 코멘트로 게시하라.
          claude_args: |
            --allowedTools "Read,Bash(gh issue view:*),Bash(gh issue comment:*),Bash(gh issue list:*)"
```

- [ ] **Step 2: `cutoff-gap-audit.yml` 작성**

```yaml
name: Cutoff Gap Audit
on:
  workflow_dispatch:
    inputs:
      area:
        description: "감사 영역(anthropic/openai/google/mcp/all)"
        required: false
        default: "all"
permissions:
  contents: read
  issues: write
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 1 }
      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          prompt: |
            fleet-cutoff-gap-audit 스킬의 절차를 따라 영역 "${{ github.event.inputs.area }}" 의
            컷오프 갭을 감사하라. net-new + 정정 표를 이슈 #135 에 코멘트로 게시하라.
          claude_args: |
            --allowedTools "Read,Bash(gh issue comment:*),Bash(gh issue view:*)"
```

- [ ] **Step 3: skills:lint(경로 스캔) 통과 확인**

Run: `node scripts/skills-lint.mjs .github/workflows/backlog-rerank.yml .github/workflows/cutoff-gap-audit.yml`
Expected: `✓ skills:lint 통과 (2 파일)`.

- [ ] **Step 4: Secret 설정 (사용자 1회 수동 — 문서화)**

구독 OAuth 토큰 발급·등록 (사용자가 로컬에서):
```bash
claude setup-token          # 구독 OAuth 토큰 발급
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo pdw96/fleet   # 발급 토큰 입력
```
> ⚠️ 토큰을 yaml·커밋에 넣지 말 것. repo Secret 으로만. (스펙 §8)

- [ ] **Step 5: 커밋**

```bash
git add .github/workflows/backlog-rerank.yml .github/workflows/cutoff-gap-audit.yml
git commit -m "feat(workflow-sync): #135 재랭킹·갭감사 클라우드 Action(claude-code-action, dispatch)"
```

- [ ] **Step 6: dispatch 스모크 (Secret 설정 후 · 완료 기준 §10.3)**

Run:
```bash
gh workflow run "Cutoff Gap Audit" --repo pdw96/fleet -f area=mcp
gh run list --repo pdw96/fleet --workflow="Cutoff Gap Audit" --limit 1
```
Expected: run 생성 → 완주(green) → #135 에 갭감사 결과 코멘트 착지. (실패 시 §11 위험표 — 인증/권한 점검.)

---

## Task 6 (선택): L3 `.js` 로컬 가속 수확

> **선택·이연 가능.** 클라우드 Action·로컬 Skill 툴은 `.js` 없이 동작한다. 가속이 필요할 때만.
> 스펙 §12 오픈 결정 — `fleet-pr-review` 의 `.js` 수확 여부 포함.

**Files:**
- Create: `.claude/workflows/backlog-rerank.js`
- Create: `.claude/workflows/cutoff-gap-audit.js`

- [ ] **Step 1: 후보 세션 스크립트 식별**

Run (가장 최근본 우선):
```bash
ls -t ~/.claude/projects/C--Users-qkreh-fleet/*/workflows/*.js | head -20
```
메모리 참조 시드: cutoff-gap `wf_96534c26-abe`, hermes `wf_ef1cec60-66f`. 재랭킹·갭감사 meta(`name`)로 식별.

- [ ] **Step 2: 정규화 복사 (스펙 §8)**

각 스크립트를 `.claude/workflows/<name>.js` 로 복사하되 **정규화**: 절대경로(`const CWD/REPO/repoRoot`·
AppData Temp·tool-results 덤프)를 `process.cwd()`/상대경로/인자로 치환, point-in-time CONTEXT(stale 버전·후보 데이터) 제거.

- [ ] **Step 3: skills:lint + 정적 점검**

Run: `node scripts/skills-lint.mjs .claude/workflows/*.js`
Expected: `✓ 통과`. 추가 확인: `meta` 리터럴 규약 준수 · `Date.now`/`Math.random` 미사용.
```bash
grep -nE "Date\.now|Math\.random" .claude/workflows/*.js || echo "금지 API 없음 OK"
```

- [ ] **Step 4: 커밋**

```bash
git add .claude/workflows/
git commit -m "feat(workflow-sync): #135 L3 로컬 가속 .js 수확(rerank·gap-audit, 정규화)"
```

---

## Self-Review

**1. Spec coverage:**
- §5 L2 스킬 4개 → Task 3 ✅ · L3 `.js` → Task 6(선택) ✅ · 클라우드 Action 2개 → Task 5 ✅
- §8 보안 강제 게이트 → Task 1·2(skills:lint·lint-staged·CI) ✅ · Actions secret → Task 5.4 ✅
- §6 레이아웃·README → Task 4 ✅ · AGENTS.md 배선 → Task 4 ✅
- §10 완료기준: 자산존재(T3)·로컬실행(T3.5)·클라우드 dispatch(T5.6)·무결성(T6.3)·보안(T1·2)·게이트(T2.6)·eslint 사각(T2.5) ✅
- §11 단일 PR 롤백 = 전 태스크 동일 브랜치 ✅
- 비목표(멀티-CLI 미러·sync) = 미포함 ✅

**2. Placeholder scan:** TBD/TODO 없음. 모든 코드 step에 실제 코드. (Task 6의 수확 내용은 외부 세션 파일 의존이라 "절차+정규화 규칙"으로 명시 — 선택 태스크.)

**3. Type consistency:** `scanText`·`validateFrontmatter`·`lintFile` 시그니처가 Task 1 정의 ↔ Task 2 사용 일치. 스킬명(`fleet-backlog-rerank` 등)이 Task 3·4·5·README 전반 일치.

---

## Execution Handoff

(아래 핸드오프 안내는 plan 작성 직후 사용자에게 제시)

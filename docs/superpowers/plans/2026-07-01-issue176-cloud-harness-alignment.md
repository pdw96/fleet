# #176 클라우드 하네스 정합 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 두 클라우드 워크플로(cutoff-gap-audit·backlog-rerank)가 참조 스킬 계약을 실제 충족하도록 배선하고, 그 정합을 skills-lint 기계 게이트로 강제한다.

**Architecture:** 스킬 SKILL.md에 `cloud-tools` 계약 선언 → 워크플로에 context7 MCP·fail-fast·Task·캡·핀 배선 → skills-lint 순수함수(`parseCloudTools`·`scanCloudContract`)가 워크플로↔스킬 계약을 CI에서 강제. 실 클라우드 동작은 머지 후 dispatch 검증.

**Tech Stack:** Node ESM(zero-dep) `scripts/skills-lint.mjs` + vitest · GitHub Actions YAML · `anthropics/claude-code-action` + context7 remote-http MCP.

## Global Constraints

- Node 24(런타임)·`.nvmrc` 22(dev/CI). skills-lint은 `fs.globSync` 사용(Node 22+).
- **zero-dep**: skills-lint에 신규 npm dep 금지(수동 파싱 — validateFrontmatter 선례).
- **CRLF 정규화**: 모든 스캐너는 `\r\n`→`\n`.
- 개인 절대경로·사용자명·시크릿 리터럴 금지(skills-lint BANNED_PATTERNS 자가적용).
- 커밋 메시지 말미: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- 매 태스크 커밋은 green 유지(순수함수 먼저, CLI 활성화는 실 파일 배선 후).
- 액션 `uses:`는 40자 SHA 핀 유지(#137) — 기존 핀 불변.

---

### Task 1: `parseCloudTools` 순수함수 (스킬 cloud-tools 파싱)

**Files:**
- Modify: `scripts/skills-lint.mjs`
- Test: `scripts/skills-lint.test.ts`

**Interfaces:**
- Produces: `parseCloudTools(skillMarkdown: string) => string[] | null` — frontmatter `cloud-tools:` 블록리스트를 반환, 없으면 `null`(로컬 전용).

- [ ] **Step 1: 실패 테스트 작성** (`scripts/skills-lint.test.ts` describe 추가)

```ts
import { parseCloudTools } from './skills-lint.mjs'

describe('parseCloudTools — 스킬 cloud-tools 계약(#176)', () => {
  it('cloud-tools 블록리스트를 배열로 파싱한다', () => {
    const md = [
      '---', 'name: fleet-x', 'description: d',
      'cloud-tools:',
      '  - Read',
      '  - Task',
      '  - mcp__context7__query-docs',
      '  - Bash(gh issue comment 135:*)',
      '---', '본문',
    ].join('\n')
    expect(parseCloudTools(md)).toEqual([
      'Read', 'Task', 'mcp__context7__query-docs', 'Bash(gh issue comment 135:*)',
    ])
  })
  it('cloud-tools 없으면 null(로컬 전용)', () => {
    expect(parseCloudTools('---\nname: x\ndescription: d\n---\n본문')).toBeNull()
  })
  it('CRLF frontmatter도 파싱한다', () => {
    const md = '---\r\nname: x\r\ndescription: d\r\ncloud-tools:\r\n  - Read\r\n---\r\n본문'
    expect(parseCloudTools(md)).toEqual(['Read'])
  })
  it('따옴표로 감싼 항목의 따옴표를 제거한다', () => {
    const md = '---\nname: x\ndescription: d\ncloud-tools:\n  - "Bash(gh issue view:*)"\n---\n'
    expect(parseCloudTools(md)).toEqual(['Bash(gh issue view:*)'])
  })
  it('frontmatter 없으면 null', () => {
    expect(parseCloudTools('# 제목\n본문')).toBeNull()
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run scripts/skills-lint.test.ts -t parseCloudTools`
Expected: FAIL — `parseCloudTools is not a function`.

- [ ] **Step 3: 구현** (`scripts/skills-lint.mjs`, `validateFrontmatter` 근처에 추가)

```js
/**
 * SKILL.md frontmatter의 `cloud-tools:` 블록리스트(클라우드 실행 시 필요 툴 계약, #176)를 파싱.
 * 항목 없으면 null(= 로컬 전용, 계약 검사 비대상). YAML dep 회피 — 수동 파싱(validateFrontmatter 선례).
 * @returns {string[] | null}
 */
export function parseCloudTools(skillMarkdown) {
  const m = skillMarkdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return null
  const lines = m[1].split(/\r?\n/)
  const idx = lines.findIndex((l) => /^cloud-tools:[ \t]*$/.test(l))
  if (idx === -1) return null
  const tools = []
  for (let i = idx + 1; i < lines.length; i++) {
    const lm = lines[i].match(/^[ \t]+-[ \t]+(.+?)[ \t]*$/)
    if (!lm) break
    tools.push(lm[1].replace(/^['"]|['"]$/g, ''))
  }
  return tools.length ? tools : null
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run scripts/skills-lint.test.ts -t parseCloudTools`
Expected: PASS (5 tests).

- [ ] **Step 5: 커밋**

```bash
git add scripts/skills-lint.mjs scripts/skills-lint.test.ts
git commit -m "$(printf 'feat(#176): skills-lint parseCloudTools — 스킬 cloud-tools 계약 파싱\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: `scanCloudContract` 순수함수 (워크플로↔스킬 계약 검사)

**Files:**
- Modify: `scripts/skills-lint.mjs`
- Test: `scripts/skills-lint.test.ts`

**Interfaces:**
- Consumes: `parseCloudTools` (Task 1).
- Produces: `scanCloudContract(workflowText: string, contracts: {[skill:string]:string[]}) => {rule:string, msg:string}[]` — 빈 배열 = 계약 충족.
- Internal: `extractFlagValue(text, flag)` — claude_args의 `--flag` 값(따옴표/단일토큰) 추출.

- [ ] **Step 1: 실패 테스트 작성** (describe 추가)

```ts
import { scanCloudContract } from './skills-lint.mjs'

describe('scanCloudContract — 워크플로↔스킬 계약(#176)', () => {
  const CONTRACTS = {
    'fleet-x': ['Read', 'Task', 'mcp__context7__query-docs', 'Bash(gh issue comment 135:*)'],
  }
  // 계약 충족 워크플로(모든 assertion 통과)
  const good = [
    'name: X',
    'on: { workflow_dispatch: {} }',
    'concurrency:',
    '  group: x-${{ github.ref }}',
    'jobs:',
    '  run:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '    steps:',
    '      - env:',
    '          CONTEXT7_API_KEY: ${{ secrets.CONTEXT7_API_KEY }}',
    '        run: |',
    '          if [ -z "$CONTEXT7_API_KEY" ]; then exit 1; fi',
    '      - uses: anthropics/claude-code-action@abc',
    '        with:',
    '          prompt: fleet-x 스킬 절차를 따르라',
    '          claude_args: |',
    '            --mcp-config "$RUNNER_TEMP/mcp-config.json"',
    '            --allowedTools "Read,Task,mcp__context7__query-docs,Bash(gh issue comment 135:*)"',
    '            --max-turns 40',
    // mcp-config에 context7 서버(생성 스텝 가정 — 텍스트 존재로 충분)
    '          # context7 server',
  ].join('\n')

  it('계약 충족 워크플로는 위반 0', () => {
    expect(scanCloudContract(good, CONTRACTS)).toEqual([])
  })
  it('claude-code-action 미사용 워크플로는 skip(빈 배열)', () => {
    expect(scanCloudContract('name: CI\njobs: { a: { steps: [] } }', CONTRACTS)).toEqual([])
  })
  it('cloud-capable 스킬 미참조 워크플로는 skip', () => {
    const t = good.replace('fleet-x 스킬 절차를 따르라', '일반 작업')
    expect(scanCloudContract(t, CONTRACTS)).toEqual([])
  })
  it('allowedTools가 cloud-tools 부분집합이 아니면 누락 툴마다 위반', () => {
    const t = good.replace(',Bash(gh issue comment 135:*)', '')
    const hits = scanCloudContract(t, CONTRACTS)
    expect(hits.some((h) => h.rule === 'allowedTools')).toBe(true)
  })
  it('context7 필요한데 --mcp-config 없으면 위반', () => {
    const t = good.replace('--mcp-config "$RUNNER_TEMP/mcp-config.json"', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'mcp-config')).toBe(true)
  })
  it('CONTEXT7_API_KEY 미참조면 위반', () => {
    const t = good.replace(/CONTEXT7_API_KEY/g, 'OTHER_KEY')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'secret')).toBe(true)
  })
  it('fail-fast(-z) 가드 없으면 위반', () => {
    const t = good.replace('if [ -z "$CONTEXT7_API_KEY" ]; then exit 1; fi', 'echo ok')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'fail-fast')).toBe(true)
  })
  it('Task 허용인데 --max-turns 없으면 위반', () => {
    const t = good.replace('\n            --max-turns 40', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'max-turns')).toBe(true)
  })
  it('timeout-minutes 없으면 위반', () => {
    const t = good.replace('    timeout-minutes: 30\n', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'timeout')).toBe(true)
  })
  it('concurrency 없으면 위반', () => {
    const t = good.replace('concurrency:\n  group: x-${{ github.ref }}\n', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'concurrency')).toBe(true)
  })
  it('unpinned Bash(gh issue comment:*) 있으면 핀 위반', () => {
    const t = good.replace(
      '--allowedTools "Read,Task,mcp__context7__query-docs,Bash(gh issue comment 135:*)"',
      '--allowedTools "Read,Task,mcp__context7__query-docs,Bash(gh issue comment 135:*),Bash(gh issue comment:*)"',
    )
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'comment-pin')).toBe(true)
  })
  it('CRLF 정규화', () => {
    expect(scanCloudContract(good.replace(/\n/g, '\r\n'), CONTRACTS)).toEqual([])
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run scripts/skills-lint.test.ts -t scanCloudContract`
Expected: FAIL — `scanCloudContract is not a function`.

- [ ] **Step 3: 구현** (`scripts/skills-lint.mjs`, `parseCloudTools` 아래)

```js
/** claude_args의 `--<flag>` 값(따옴표 문자열 또는 단일 토큰) 추출. 없으면 null. */
function extractFlagValue(text, flag) {
  const m = text.match(new RegExp('--' + flag + '\\s+("([^"]*)"|\'([^\']*)\'|(\\S+))'))
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null
}

/**
 * 클라우드 워크플로(anthropics/claude-code-action)가 참조하는 cloud-capable 스킬의 계약을 강제(#176).
 * contracts = { [skillName]: cloudTools[] }. 워크플로가 스킬을 참조하지 않거나 claude-code-action
 * 미사용이면 skip(빈 배열). CRLF 정규화. 강제 항목: allowedTools superset · context7 배선(mcp-config·
 * 서버·시크릿·fail-fast) · Task→max-turns · timeout-minutes · concurrency · 코멘트 타깃 핀.
 * @returns {{rule:string, msg:string}[]} 빈 배열 = 계약 충족
 */
export function scanCloudContract(workflowText, contracts) {
  const hits = []
  const text = workflowText.replace(/\r\n/g, '\n')
  if (!/anthropics\/claude-code-action/.test(text)) return hits
  const referenced = Object.keys(contracts).filter((name) => text.includes(name))
  if (referenced.length === 0) return hits
  const allowedRaw = extractFlagValue(text, 'allowedTools')
  const allowedSet = allowedRaw ? allowedRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  let needsContext7 = false
  let hasTask = false
  for (const name of referenced) {
    for (const tool of contracts[name]) {
      if (!allowedSet.includes(tool))
        hits.push({ rule: 'allowedTools', msg: `${name} cloud-tools '${tool}' 미허용(--allowedTools 누락)` })
      if (tool.startsWith('mcp__context7__')) needsContext7 = true
      if (tool === 'Task') hasTask = true
    }
  }
  if (needsContext7) {
    if (!/--mcp-config/.test(text)) hits.push({ rule: 'mcp-config', msg: 'context7 필요하나 --mcp-config 없음' })
    if (!/context7/.test(text)) hits.push({ rule: 'mcp-server', msg: 'mcp-config에 context7 서버 참조 없음' })
    if (!/secrets\.CONTEXT7_API_KEY/.test(text)) hits.push({ rule: 'secret', msg: 'CONTEXT7_API_KEY 시크릿 미참조' })
    if (!/-z\s+"\$CONTEXT7_API_KEY"/.test(text)) hits.push({ rule: 'fail-fast', msg: 'CONTEXT7_API_KEY fail-fast(-z) 가드 없음 — no grounding→no run' })
  }
  if (hasTask && !/--max-turns\b/.test(text))
    hits.push({ rule: 'max-turns', msg: 'Task 허용 시 --max-turns 비용 캡 필요' })
  if (!/^\s*timeout-minutes:/m.test(text)) hits.push({ rule: 'timeout', msg: 'timeout-minutes 없음' })
  if (!/^concurrency:/m.test(text)) hits.push({ rule: 'concurrency', msg: 'concurrency 없음' })
  if (/Bash\(gh issue comment:\*\)/.test(text))
    hits.push({ rule: 'comment-pin', msg: 'unpinned Bash(gh issue comment:*) — 특정 이슈 번호로 핀 필요' })
  return hits
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run scripts/skills-lint.test.ts -t scanCloudContract`
Expected: PASS (12 tests).

- [ ] **Step 5: 커밋**

```bash
git add scripts/skills-lint.mjs scripts/skills-lint.test.ts
git commit -m "$(printf 'feat(#176): skills-lint scanCloudContract — 워크플로↔스킬 계약 강제\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: 스킬 SKILL.md에 `cloud-tools` 계약 선언

**Files:**
- Modify: `.claude/skills/fleet-cutoff-gap-audit/SKILL.md`
- Modify: `.claude/skills/fleet-backlog-rerank/SKILL.md`

**Interfaces:**
- Produces: 두 스킬 frontmatter의 `cloud-tools` 리스트(Task 5 CLI가 소비).

- [ ] **Step 1: cutoff-gap-audit frontmatter 수정** — `description:` 줄 아래, 닫는 `---` 위에 추가:

```yaml
cloud-tools:
  - Read
  - Task
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
  - Bash(gh issue view:*)
  - Bash(gh issue comment 135:*)
```

- [ ] **Step 2: backlog-rerank frontmatter 수정** — 동상 + `Bash(gh issue list:*)`:

```yaml
cloud-tools:
  - Read
  - Task
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
  - Bash(gh issue view:*)
  - Bash(gh issue list:*)
  - Bash(gh issue comment 135:*)
```

- [ ] **Step 3: frontmatter 유효성 확인**

Run: `node scripts/skills-lint.mjs .claude/skills/fleet-cutoff-gap-audit/SKILL.md .claude/skills/fleet-backlog-rerank/SKILL.md`
Expected: `✓ skills:lint 통과 (2 파일)` (validateFrontmatter 통과 — cloud-tools는 추가 필드, 무해).

- [ ] **Step 4: 커밋**

```bash
git add .claude/skills/fleet-cutoff-gap-audit/SKILL.md .claude/skills/fleet-backlog-rerank/SKILL.md
git commit -m "$(printf 'feat(#176): 스킬 cloud-tools 계약 선언 — audit·rerank\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: 두 워크플로 context7 배선 + 캡 + 핀

**Files:**
- Modify: `.github/workflows/cutoff-gap-audit.yml`
- Modify: `.github/workflows/backlog-rerank.yml`

**Interfaces:**
- Consumes: 두 SKILL.md `cloud-tools`(허용툴 원천), `CONTEXT7_API_KEY` 시크릿.

- [ ] **Step 1: cutoff-gap-audit.yml 재작성** (전체 — 기존 SHA 핀 checkout·action 불변):

```yaml
name: Cutoff Gap Audit
on:
  workflow_dispatch:
    inputs:
      area:
        description: '감사 영역(anthropic/openai/google/mcp/all)'
        required: false
        default: 'all'
permissions:
  contents: read
  issues: write
concurrency:
  group: cutoff-gap-audit-${{ github.ref }}
  cancel-in-progress: false
jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
        with:
          fetch-depth: 1
          persist-credentials: false
      - name: Verify context7 secret present
        env:
          CONTEXT7_API_KEY: ${{ secrets.CONTEXT7_API_KEY }}
        run: |
          if [ -z "$CONTEXT7_API_KEY" ]; then
            echo "::error::CONTEXT7_API_KEY 시크릿 필요 — context7 현행 문서 그라운딩 없이는 환각 위험(no grounding → no run)"
            exit 1
          fi
      - name: Create context7 MCP config
        env:
          CONTEXT7_API_KEY: ${{ secrets.CONTEXT7_API_KEY }}
        run: |
          cat > "$RUNNER_TEMP/mcp-config.json" << EOF
          {"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"$CONTEXT7_API_KEY"}}}}
          EOF
      - uses: anthropics/claude-code-action@a92e7c70a4da9793dc164451d829089dc057a464 # v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # GitHub App(OIDC) 대신 워크플로 GITHUB_TOKEN 사용 — id-token 권한·App 설치 불요
          github_token: ${{ secrets.GITHUB_TOKEN }}
          prompt: |
            fleet-cutoff-gap-audit 스킬의 절차를 따라 영역 "${{ github.event.inputs.area }}" 의
            컷오프 갭을 감사하라. context7로 현행 문서를 대조하고 독립 서브에이전트로 적대 검증하라.
            net-new + 정정 표를 이슈 #135 에 코멘트로 게시하라. sub-issue 등재·ADR 은 사람 게이트(추천만).
          claude_args: |
            --mcp-config "$RUNNER_TEMP/mcp-config.json"
            --allowedTools "Read,Task,mcp__context7__resolve-library-id,mcp__context7__query-docs,Bash(gh issue view:*),Bash(gh issue comment 135:*)"
            --max-turns 40
```

- [ ] **Step 2: backlog-rerank.yml 재작성** (동상 + `gh issue list` 허용):

```yaml
name: Backlog Rerank
on:
  workflow_dispatch:
    inputs:
      note:
        description: '재랭킹 트리거 사유(신규 입력 등)'
        required: false
permissions:
  contents: read
  issues: write
concurrency:
  group: backlog-rerank-${{ github.ref }}
  cancel-in-progress: false
jobs:
  rerank:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
        with:
          fetch-depth: 1
          persist-credentials: false
      - name: Verify context7 secret present
        env:
          CONTEXT7_API_KEY: ${{ secrets.CONTEXT7_API_KEY }}
        run: |
          if [ -z "$CONTEXT7_API_KEY" ]; then
            echo "::error::CONTEXT7_API_KEY 시크릿 필요 — context7 현행 문서 그라운딩 없이는 환각 위험(no grounding → no run)"
            exit 1
          fi
      - name: Create context7 MCP config
        env:
          CONTEXT7_API_KEY: ${{ secrets.CONTEXT7_API_KEY }}
        run: |
          cat > "$RUNNER_TEMP/mcp-config.json" << EOF
          {"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"$CONTEXT7_API_KEY"}}}}
          EOF
      - uses: anthropics/claude-code-action@a92e7c70a4da9793dc164451d829089dc057a464 # v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # GitHub App(OIDC) 대신 워크플로 GITHUB_TOKEN 사용 — id-token 권한·App 설치 불요
          github_token: ${{ secrets.GITHUB_TOKEN }}
          prompt: |
            fleet-backlog-rerank 스킬의 절차를 따라 #27 백로그를 재랭킹하라.
            트리거 사유: ${{ github.event.inputs.note }}
            context7로 현행 교차검증하고 독립 서브에이전트로 적대 refute 하라.
            결과 표(후보·verdict·근거)를 이슈 #135 에 코멘트로 게시하라. sub-issue 등재·ADR 은 사람 게이트(추천만).
          claude_args: |
            --mcp-config "$RUNNER_TEMP/mcp-config.json"
            --allowedTools "Read,Task,mcp__context7__resolve-library-id,mcp__context7__query-docs,Bash(gh issue view:*),Bash(gh issue list:*),Bash(gh issue comment 135:*)"
            --max-turns 40
```

- [ ] **Step 3: SHA 핀·시크릿 스캔 확인**

Run: `node scripts/skills-lint.mjs .github/workflows/cutoff-gap-audit.yml .github/workflows/backlog-rerank.yml`
Expected: `✓ skills:lint 통과 (2 파일)` (scanWorkflowPins 통과 — action SHA 핀 불변; 이 시점엔 CLI에 계약검사 미배선).

- [ ] **Step 4: 커밋**

```bash
git add .github/workflows/cutoff-gap-audit.yml .github/workflows/backlog-rerank.yml
git commit -m "$(printf 'feat(#176): 클라우드 워크플로 context7 배선·fail-fast·Task·캡·핀\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: skills-lint CLI 계약검사 활성화 + 실파일 회귀락

**Files:**
- Modify: `scripts/skills-lint.mjs` (CLI 블록)
- Test: `scripts/skills-lint.test.ts` (실파일 통과 단언)

**Interfaces:**
- Consumes: `parseCloudTools`·`scanCloudContract`(Task 1·2), 실 SKILL.md·워크플로(Task 3·4).

- [ ] **Step 1: 실파일 회귀락 테스트 작성** (`skills-lint.test.ts`)

```ts
import { readFileSync } from 'node:fs'

describe('실 클라우드 워크플로 계약 통과(#176 회귀락)', () => {
  const contracts = {
    'fleet-cutoff-gap-audit': parseCloudTools(
      readFileSync('.claude/skills/fleet-cutoff-gap-audit/SKILL.md', 'utf8'),
    ),
    'fleet-backlog-rerank': parseCloudTools(
      readFileSync('.claude/skills/fleet-backlog-rerank/SKILL.md', 'utf8'),
    ),
  }
  it('두 스킬 cloud-tools가 선언돼 있다(부재 시 loud RED)', () => {
    expect(contracts['fleet-cutoff-gap-audit']).toBeTruthy()
    expect(contracts['fleet-backlog-rerank']).toBeTruthy()
  })
  it('cutoff-gap-audit.yml 이 계약을 충족한다', () => {
    const wf = readFileSync('.github/workflows/cutoff-gap-audit.yml', 'utf8')
    expect(scanCloudContract(wf, contracts)).toEqual([])
  })
  it('backlog-rerank.yml 이 계약을 충족한다', () => {
    const wf = readFileSync('.github/workflows/backlog-rerank.yml', 'utf8')
    expect(scanCloudContract(wf, contracts)).toEqual([])
  })
})
```

- [ ] **Step 2: 테스트 실행(통과 예상 — Task 3·4로 실파일 이미 준수)**

Run: `npx vitest run scripts/skills-lint.test.ts -t 회귀락`
Expected: PASS (3 tests). 실패 시 Task 3/4 배선 불일치 — 그 워크플로를 계약대로 수정.

- [ ] **Step 3: CLI 블록에 계약검사 배선** (`scripts/skills-lint.mjs` 하단 CLI, `const all = files.flatMap(lintFile)` 다음, `if (all.length)` 앞)

```js
  // 크로스파일: 클라우드 워크플로 ↔ 스킬 계약(#176). staged 여부 무관하게 항상 전수 검사
  // (스킬 변경이 미staged 워크플로 계약을 깰 수 있으므로).
  const contracts = {}
  for (const sf of globSync('.claude/skills/*/SKILL.md').filter(existsSync)) {
    const md = readFileSync(sf, 'utf8')
    const ct = parseCloudTools(md)
    const nm = md.match(/^name:[ \t]*(\S+)/m)
    if (ct && nm) contracts[nm[1]] = ct
  }
  for (const wf of globSync('.github/workflows/*.yml').filter(existsSync)) {
    for (const h of scanCloudContract(readFileSync(wf, 'utf8'), contracts))
      all.push(`${wf} 클라우드계약[${h.rule}]: ${h.msg}`)
  }
```

- [ ] **Step 4: 무인자 skills:lint 통과 확인**

Run: `npm run skills:lint`
Expected: `✓ skills:lint 통과 (N 파일)` — 실 워크플로가 계약 충족. (일부러 audit.yml에서 `--max-turns` 한 줄 지워 RED 확인 후 되돌리기 권장 — 게이트 실효 검증.)

- [ ] **Step 5: 커밋**

```bash
git add scripts/skills-lint.mjs scripts/skills-lint.test.ts
git commit -m "$(printf 'feat(#176): skills:lint 계약검사 활성화 + 실파일 회귀락\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: 문서 정합 + ADR (finding 5)

**Files:**
- Modify: `AGENTS.md` (CodeRabbit 절)
- Modify: `.claude/README.md` (workflows/ 섹션)
- Create: `docs/adr/0006-coderabbit-advisory-채택.md`
- Create: `docs/adr/0007-클라우드-스킬-계약강제-human-gated-write.md`

- [ ] **Step 1: AGENTS.md CodeRabbit 절 수정** — 현재(라인 103-105) "**CodeRabbit 병행은 실측 후.** … 지금은 도입하지 않는다 …" 문단을 활성 사실로 교체:

```markdown
- **CodeRabbit 보조 리뷰(advisory·비-required).** CodeRabbit 봇이 활성이다 — PR 당 Codex + CodeRabbit
  2봇 리뷰. **required 게이트 아님**(인라인 스레드 resolve 필요·fix 푸시마다 재리뷰로 새 스레드 추가 가능
  → 매 푸시 후 unresolved 재확인). Codex=P0/P1 senior, CodeRabbit=스타일·incremental 보조. 채택 근거 = ADR-0006.
```

- [ ] **Step 2: `.claude/README.md` workflows/ 섹션 수정** — 현재 `## workflows/` 문단을 예약-표기로 정정:

```markdown
## workflows/ (예약 — Claude 로컬 가속 `.js`)

`Workflow` DSL 가속본을 둘 **예약 위치**다. **현재 추적 `.js` 가속본 0**(디렉터리 미생성). 신규 시
`.gitignore` negation(`!.claude/workflows/`) allowlist 로 편입되며, 스킬(정의) 없이 `.js`만 존재 금지.
```

- [ ] **Step 3: ADR-0006 작성** (`docs/adr/0006-coderabbit-advisory-채택.md`)

```markdown
---
adr: 6
title: CodeRabbit 을 advisory 보조 리뷰어로 채택한다(비-required 게이트)
status: Accepted
date: 2026-07-01
related: "#176, #98, AGENTS.md:Codex 리뷰 운영 기준"
---

## 맥락
AGENTS.md 는 "CodeRabbit 병행은 실측 후 — 지금은 도입하지 않는다"고 기록했으나, 레포에 `coderabbitai[bot]`
(Pro Plus·CHILL)가 이미 활성화돼 PR 당 Codex + CodeRabbit 2봇 리뷰가 돈다. 문서-현실 drift(#176 finding 5).

## 결정
CodeRabbit 을 **advisory 보조 리뷰어**로 채택한다 — Codex(P0/P1 senior)와 병행하되 **required status check
아님**. 인라인 스레드 resolve 는 ruleset(미해결 스레드 0) 강제 대상이나, CodeRabbit 자체가 머지를 차단하지
않는다. fix 푸시마다 재리뷰로 새 스레드가 추가될 수 있어 매 푸시 후 unresolved 재확인.

## 고려한 대안 / 기각 사유
- **미도입 유지**: 현실과 불일치(이미 활성) → 기각.
- **required 게이트화**: 클라우드 리뷰 봇은 commit status 미발행·비결정성·중복 코멘트 피로 → 기각(#98 Codex required 보류와 동일 논리).

## 결과 (Consequences)
2봇 교차 리뷰로 커버리지↑. 비용 = 중복 코멘트·스레드 관리 부담. 재검토 트리거 = false-positive 율 과다 or
required 승격 수요(1.0 근처).
```

- [ ] **Step 4: ADR-0007 작성** (`docs/adr/0007-클라우드-스킬-계약강제-human-gated-write.md`)

```markdown
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
방향 **A(클라우드 진짜 능력화)**: (1) context7 remote-http MCP·`Task`·`--max-turns`·`timeout`·`concurrency`·
코멘트 핀을 배선하고, (2) 스킬 frontmatter `cloud-tools` 계약을 `skills-lint`(scanCloudContract)로 **기계 강제**
한다. 단 **sub-issue 등재·ADR commit·push 는 클라우드에 부여하지 않고 human-gated 유지**(클라우드는 근거+
refute된 추천 표만 #135 게시).

## 고려한 대안 / 기각 사유
- **로컬 전용화(fleet-pr-review 선례)**: 클라우드 cadence 이점 포기 → 기각(사용자 방향 A 선택).
- **완전 자동등재(create/Write/push)**: `persist-credentials:false`(#175) 플립·임의 이슈생성 → 공급망/자격증명
  blast-radius↑ → 기각(되돌리기 어려운 write 는 induction L2 human-gate 유지).

## 결과 (Consequences)
클라우드 산출물이 그라운딩(context7)·독립검증(Task)으로 신뢰가능. 계약 lint 로 배선 drift 회귀 차단(관례→강제).
비용 = `CONTEXT7_API_KEY` 시크릿 운영·구독 쿼터. 실 클라우드 동작은 dispatch 로 검증(fail-fast 로 무근거 실행
차단). 재검토 트리거 = cron cadence 수요 or 완전 자동화 ROI 전환.
```

- [ ] **Step 5: 문서 게이트 확인**

Run: `node scripts/skills-lint.mjs docs/adr/0006-coderabbit-advisory-채택.md docs/adr/0007-클라우드-스킬-계약강제-human-gated-write.md .claude/README.md AGENTS.md`
Expected: `✓ skills:lint 통과 (4 파일)` (개인경로/사용자명 없음).

- [ ] **Step 6: 커밋**

```bash
git add AGENTS.md .claude/README.md docs/adr/0006-coderabbit-advisory-채택.md docs/adr/0007-클라우드-스킬-계약강제-human-gated-write.md
git commit -m "$(printf 'docs(#176): CodeRabbit 상태 갱신·workflows 정정 + ADR-0006/0007\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 7: 전체 게이트 검증

- [ ] **Step 1: 전체 verify**

Run: `npm run verify`
Expected: skills:lint·brain:check·format:check·typecheck·lint·test·build 전부 PASS.

- [ ] **Step 2: 실패 시 수정 후 재실행.** format 위반이면 `npm run format` 후 `git add` + amend/신규 커밋.

- [ ] **Step 3: 최종 상태 확인**

Run: `git log --oneline origin/master..HEAD`
Expected: Task 1-6 커밋 + 스펙/계획 커밋.

## Self-Review (계획↔스펙 대조)

- **finding 1(context7 환각)** → Task 4(배선·fail-fast) + Task 2 assertion(mcp-config·secret·fail-fast). ✅
- **finding 2(계약 미검증)** → Task 1·2·5(parseCloudTools·scanCloudContract·CLI). ✅
- **finding 3(self-review)** → Task 4(`Task`+max-turns) + Task 2 assertion. ✅
- **finding 4(캡)** → Task 4(timeout·concurrency·핀) + Task 2 assertion. ✅
- **finding 5(doc drift)** → Task 6(AGENTS.md·README·ADR-0006/0007). ✅
- **Placeholder scan**: 전 스텝 실코드/명령/기대출력 포함. TBD 없음.
- **Type consistency**: `parseCloudTools`/`scanCloudContract`/`extractFlagValue` 시그니처가 Task 1·2·5에서 일관. `contracts` 형태 `{[skill]:string[]}` 일관.
- **범위**: 단일 PR 적정(스펙 §7 범위 밖 항목 제외).

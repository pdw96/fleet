// scripts/skills-lint.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  scanText,
  validateFrontmatter,
  scanWorkflowPins,
  scanReleaseSafety,
  DEFAULT_GLOBS,
  parseCloudTools,
  scanCloudContract,
} from './skills-lint.mjs'

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
    expect(scanText('token sk-' + 'x'.repeat(25)).length).toBeGreaterThan(0)
    expect(scanText('AKIA' + 'A'.repeat(16)).length).toBeGreaterThan(0)
  })
  it('깨끗한 내용은 통과(빈 배열)', () => {
    expect(scanText('const repo = process.cwd(); // 상대경로만')).toEqual([])
  })
  it('forward-slash Windows 경로를 잡는다', () => {
    expect(scanText('path C:/Users/someone/bar').length).toBeGreaterThan(0)
  })
  it('매치에 라인 번호를 단다', () => {
    const hits = scanText('line1\nC:\\\\Users\\\\x\nline3')
    expect(hits[0].line).toBe(2)
  })
})

describe('scanWorkflowPins — GitHub Actions SHA 핀 강제', () => {
  const SHA = '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0' // 40-hex

  it('미핀 태그(@v7)를 잡는다', () => {
    const hits = scanWorkflowPins('      - uses: actions/checkout@v7')
    expect(hits.length).toBe(1)
    expect(hits[0].ref).toBe('actions/checkout@v7')
  })

  it('40자 커밋 SHA 핀은 통과(주석 유무 무관)', () => {
    expect(scanWorkflowPins(`      - uses: actions/checkout@${SHA} # v7`)).toEqual([])
    expect(scanWorkflowPins(`      - uses: actions/checkout@${SHA}`)).toEqual([])
  })

  it('브랜치 ref(@main)도 미핀으로 잡는다', () => {
    expect(scanWorkflowPins('      - uses: actions/x@main').length).toBe(1)
  })

  it('짧은 SHA(7자)는 미핀으로 잡는다', () => {
    expect(scanWorkflowPins('      - uses: actions/x@9c091bb').length).toBe(1)
  })

  it('ref 없는 참조(@생략)도 미핀으로 잡는다', () => {
    expect(scanWorkflowPins('      - uses: actions/checkout').length).toBe(1)
  })

  it('로컬 액션(./ ../)은 핀 불요 → 통과', () => {
    expect(scanWorkflowPins('      - uses: ./.github/actions/foo')).toEqual([])
    expect(scanWorkflowPins('      - uses: ../shared/action')).toEqual([])
  })

  it('잡-레벨 uses:(reusable workflow 호출 형태)도 검사한다', () => {
    expect(scanWorkflowPins('    uses: org/repo/.github/workflows/x.yml@v1').length).toBe(1)
    expect(scanWorkflowPins(`    uses: org/repo/.github/workflows/x.yml@${SHA}`)).toEqual([])
  })

  it('uses: 가 아닌 줄·주석 줄은 무시한다', () => {
    expect(scanWorkflowPins('      run: echo "uses: actions/x@v1"')).toEqual([])
    expect(scanWorkflowPins('      # uses: actions/x@v1 (예시)')).toEqual([])
    expect(scanWorkflowPins('name: CI\non: push')).toEqual([])
  })

  it('따옴표로 감싼 값도 해석한다', () => {
    expect(scanWorkflowPins(`      - uses: "actions/checkout@${SHA}"`)).toEqual([])
    expect(scanWorkflowPins('      - uses: "actions/checkout@v7"').length).toBe(1)
  })

  it('여러 위반에 각 라인 번호를 단다', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@v7',
      '      - uses: actions/setup-node@v6',
    ].join('\n')
    const hits = scanWorkflowPins(text)
    expect(hits.length).toBe(2)
    expect(hits[0].line).toBe(4)
    expect(hits[1].line).toBe(5)
  })

  it('CRLF 줄바꿈도 정규화해 검사한다(후행 \\r 로 매치를 놓치지 않음)', () => {
    expect(scanWorkflowPins('    steps:\r\n      - uses: actions/checkout@v7\r\n').length).toBe(1)
    expect(scanWorkflowPins(`      - uses: actions/checkout@${SHA} # v7\r\n`)).toEqual([])
  })

  it('플로우-스타일 스텝(uses 가 첫 키)도 검사한다', () => {
    expect(scanWorkflowPins('      - {uses: actions/checkout@v7}').length).toBe(1)
    expect(scanWorkflowPins('      - { uses: actions/checkout@v7 }').length).toBe(1)
    expect(scanWorkflowPins('      - {uses: actions/checkout@v7, name: co}').length).toBe(1)
    expect(scanWorkflowPins(`      - {uses: actions/checkout@${SHA}}`)).toEqual([])
    expect(scanWorkflowPins(`      - { uses: actions/checkout@${SHA}, name: co }`)).toEqual([])
  })

  it('run 본문 속 {uses:} 문자열은 여전히 무시한다(오탐 방지)', () => {
    expect(scanWorkflowPins('      run: echo "- {uses: actions/x@v1}"')).toEqual([])
  })
})

describe('scanReleaseSafety — release.yml 안전장치 약화 회귀 센서(#175)', () => {
  const SHA = '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0'
  const ATTEST = '0f67c3f4856b2e3261c31976d6725780e5e4c373'
  const good = [
    'jobs:',
    '  prepare:',
    '    steps:',
    `      - uses: actions/checkout@${SHA} # v7`,
    '        with:',
    '          persist-credentials: false',
    '  build:',
    '    steps:',
    `      - uses: actions/checkout@${SHA} # v7`,
    '        with:',
    '          persist-credentials: false',
    '      - name: Generate build provenance attestation',
    `        uses: actions/attest-build-provenance@${ATTEST} # v4`,
    '        with:',
    '          subject-path: dist/*.exe',
  ].join('\n')

  it('attestation(SHA핀) + 모든 checkout 의 persist-credentials:false 면 통과(빈 배열)', () => {
    expect(scanReleaseSafety(good)).toEqual([])
  })

  it('attestation 스텝 삭제를 적발한다', () => {
    const text = good
      .split('\n')
      .filter((l) => !l.includes('attest-build-provenance'))
      .join('\n')
    const hits = scanReleaseSafety(text)
    expect(hits.some((h) => h.rule === 'attestation')).toBe(true)
  })

  it('attestation 이 태그(@v4)로 un-pin 되면 적발한다(SHA 핀 필요)', () => {
    const text = good.replace(`attest-build-provenance@${ATTEST}`, 'attest-build-provenance@v4')
    expect(scanReleaseSafety(text).some((h) => h.rule === 'attestation')).toBe(true)
  })

  it('한 checkout 스텝의 persist-credentials:false 가 없으면 적발한다', () => {
    // build 잡 checkout 의 persist-credentials 줄만 제거
    const lines = good.split('\n')
    const idx = lines.lastIndexOf('          persist-credentials: false')
    lines.splice(idx, 1)
    const hits = scanReleaseSafety(lines.join('\n'))
    expect(hits.some((h) => h.rule === 'persist-credentials')).toBe(true)
  })

  it('다른 스텝(non-checkout)의 stray persist-credentials:false 는 count 되지 않는다(블록워크 — 단순 count false-GREEN 차단)', () => {
    const text = [
      'jobs:',
      '  build:',
      '    steps:',
      `      - uses: actions/checkout@${SHA}`,
      '        with:',
      '          fetch-depth: 0',
      `      - uses: actions/setup-node@${SHA}`,
      '        with:',
      '          persist-credentials: false', // checkout 이 아니라 setup-node 에 있음
      '      - name: attest',
      `        uses: actions/attest-build-provenance@${ATTEST}`,
    ].join('\n')
    // 단순 count(pc:false 1 ≥ checkout 1)면 통과하지만, checkout 스텝 자체엔 없으므로 적발돼야 한다
    expect(scanReleaseSafety(text).some((h) => h.rule === 'persist-credentials')).toBe(true)
  })

  it('주석 처리된 persist-credentials 는 인정하지 않는다', () => {
    const text = good.replace(
      '          persist-credentials: false\n  build:',
      '          # persist-credentials: false\n  build:',
    )
    expect(scanReleaseSafety(text).some((h) => h.rule === 'persist-credentials')).toBe(true)
  })

  it('CRLF 줄바꿈도 정규화해 검사한다', () => {
    expect(scanReleaseSafety(good.replace(/\n/g, '\r\n'))).toEqual([])
  })

  it('name-first checkout(uses 가 - 줄에 없음)의 persist-credentials 누락도 적발한다(false-GREEN 차단)', () => {
    const text = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: Checkout',
      `        uses: actions/checkout@${SHA}`,
      '      - name: attest',
      `        uses: actions/attest-build-provenance@${ATTEST}`,
    ].join('\n')
    expect(scanReleaseSafety(text).some((h) => h.rule === 'persist-credentials')).toBe(true)
  })

  it('name-first checkout 에 persist-credentials:false 있으면 통과', () => {
    const text = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: Checkout',
      `        uses: actions/checkout@${SHA}`,
      '        with:',
      '          persist-credentials: false',
      '      - name: attest',
      `        uses: actions/attest-build-provenance@${ATTEST}`,
    ].join('\n')
    expect(scanReleaseSafety(text)).toEqual([])
  })

  it('persist-credentials: false 뒤 인라인 주석은 통과(false-RED 방지)', () => {
    const text = good.replace(
      '          persist-credentials: false\n  build:',
      '          persist-credentials: false # 자격증명 미보존\n  build:',
    )
    expect(scanReleaseSafety(text)).toEqual([])
  })

  it("따옴표 스칼라 persist-credentials: 'false' 도 통과", () => {
    const text = good.replace(
      '          persist-credentials: false\n  build:',
      "          persist-credentials: 'false'\n  build:",
    )
    expect(scanReleaseSafety(text)).toEqual([])
  })

  it('따옴표로 감싼 checkout uses 도 checkout 으로 분류한다(quoted-uses false-GREEN 차단 — Codex PR리뷰)', () => {
    const text = [
      'jobs:',
      '  build:',
      '    steps:',
      `      - uses: "actions/checkout@${SHA}"`,
      '      - name: attest',
      `        uses: actions/attest-build-provenance@${ATTEST}`,
    ].join('\n')
    expect(scanReleaseSafety(text).some((h) => h.rule === 'persist-credentials')).toBe(true)
  })

  it('persist-credentials 가 with: 아래가 아니면(예: env:) 인정하지 않는다(GitHub 은 with 만 입력 — Codex PR리뷰)', () => {
    const text = [
      'jobs:',
      '  build:',
      '    steps:',
      `      - uses: actions/checkout@${SHA}`,
      '        env:',
      '          persist-credentials: false',
      '      - name: attest',
      `        uses: actions/attest-build-provenance@${ATTEST}`,
    ].join('\n')
    expect(scanReleaseSafety(text).some((h) => h.rule === 'persist-credentials')).toBe(true)
  })

  it('실제 .github/workflows/release.yml 은 통과한다(부재/리네임 시 readFileSync 가 loud RED)', () => {
    const text = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(scanReleaseSafety(text)).toEqual([])
  })
})

describe('DEFAULT_GLOBS — skills:lint 무인자 기본 글롭셋(#175)', () => {
  it('추적 자산 + src 를 포함하고 브레이스 패턴을 쓰지 않는다(fs.globSync 호환)', () => {
    expect(DEFAULT_GLOBS).toContain('src/**/*.ts')
    expect(DEFAULT_GLOBS).toContain('src/**/*.tsx')
    expect(DEFAULT_GLOBS).toContain('.github/workflows/*.yml')
    expect(DEFAULT_GLOBS).toContain('docs/adr/**/*.md')
    // 브레이스 확장은 fs.globSync 에서 비신뢰 → 개별 패턴이어야 한다
    expect(DEFAULT_GLOBS.every((g) => !g.includes('{'))).toBe(true)
  })
})

describe('validateFrontmatter — SKILL.md', () => {
  it('name·description 있으면 ok', () => {
    const md = '---\nname: fleet-x\ndescription: 한 줄 설명\n---\n본문'
    expect(validateFrontmatter(md).ok).toBe(true)
  })
  it('CRLF(\\r\\n) frontmatter도 인식한다', () => {
    const md = '---\r\nname: x\r\ndescription: y\r\n---\r\n본문'
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
  it('name 값이 없으면(빈 name) 실패', () => {
    expect(validateFrontmatter('---\nname:\ndescription: y\n---\n본문').ok).toBe(false)
  })
  it('종료 --- 뒤에 extra가 있으면 실패', () => {
    expect(validateFrontmatter('---\nname: x\ndescription: y\n---extra\n본문').ok).toBe(false)
  })
})

describe('parseCloudTools — 스킬 cloud-tools 계약(#176)', () => {
  it('cloud-tools 블록리스트를 배열로 파싱한다', () => {
    const md = [
      '---',
      'name: fleet-x',
      'description: d',
      'cloud-tools:',
      '  - Read',
      '  - Task',
      '  - mcp__context7__query-docs',
      '  - Bash(gh issue comment 135:*)',
      '---',
      '본문',
    ].join('\n')
    expect(parseCloudTools(md)).toEqual([
      'Read',
      'Task',
      'mcp__context7__query-docs',
      'Bash(gh issue comment 135:*)',
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
  it('리스트 중간 빈 줄이 있어도 뒤 항목을 잘라먹지 않는다(false-GREEN 방지)', () => {
    const md = '---\nname: x\ndescription: d\ncloud-tools:\n  - Read\n  - Task\n\n  - Write\n---\n'
    expect(parseCloudTools(md)).toEqual(['Read', 'Task', 'Write'])
  })
  it('인라인 주석(공백+#)을 제거한다(false-RED 방지)', () => {
    const md = '---\nname: x\ndescription: d\ncloud-tools:\n  - Read # 필수\n  - Task\n---\n'
    expect(parseCloudTools(md)).toEqual(['Read', 'Task'])
  })
  it('전체 주석 줄은 건너뛴다', () => {
    const md = '---\nname: x\ndescription: d\ncloud-tools:\n  - Read\n  # 코멘트\n  - Task\n---\n'
    expect(parseCloudTools(md)).toEqual(['Read', 'Task'])
  })
  it('리스트가 아닌 키가 나오면 종료(다음 키 흡수 안 함)', () => {
    const md = '---\nname: x\ndescription: d\ncloud-tools:\n  - Read\nother: v\n---\n'
    expect(parseCloudTools(md)).toEqual(['Read'])
  })
})

describe('scanCloudContract — 워크플로↔스킬 계약(#176)', () => {
  const CONTRACTS = {
    'fleet-x': [
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Task',
      'Agent',
      'mcp__context7__query-docs',
      'Bash(gh issue view:*)',
    ],
  }
  const ALLOWED =
    '--allowedTools "Read,Glob,Grep,Write,Task,Agent,mcp__context7__query-docs,Bash(gh issue view:*)"'
  // 계약 충족 워크플로(모든 assertion 통과). 에이전트는 gh issue comment(쓰기 egress) 미보유 —
  // 결정적 후속 스텝(run:)이 시크릿 스캔 후 #135 에 게시(exfil 삼요소 차단).
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
    '      - run: |',
    '          cat > "${{ runner.temp }}/mcp-config.json" << EOF',
    '          {"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp"}}}',
    '          EOF',
    '      - uses: anthropics/claude-code-action@abc',
    '        with:',
    '          prompt: fleet-x 스킬 절차를 따르라. 결과를 cloud-report.md 에 Write.',
    '          claude_args: |',
    '            --mcp-config "${{ runner.temp }}/mcp-config.json"',
    '            ' + ALLOWED,
    '            --max-turns 40',
    '      - name: scan and post',
    '        run: gh issue comment 135 --body-file cloud-report.md',
  ].join('\n')

  it('계약 충족 워크플로는 위반 0', () => {
    expect(scanCloudContract(good, CONTRACTS)).toEqual([])
  })
  it('claude-code-action 미사용 워크플로는 skip(빈 배열)', () => {
    expect(scanCloudContract('name: CI\njobs: { a: { steps: [] } }', CONTRACTS)).toEqual([])
  })
  it('cloud-capable 스킬 미참조 워크플로는 skip', () => {
    const t = good.replace(
      'fleet-x 스킬 절차를 따르라. 결과를 cloud-report.md 에 Write.',
      '일반 작업',
    )
    expect(scanCloudContract(t, CONTRACTS)).toEqual([])
  })
  it('allowedTools가 cloud-tools 부분집합이 아니면 누락 툴마다 위반', () => {
    const t = good.replace('Write,Task', 'Task')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'allowedTools')).toBe(true)
  })
  it('context7 필요한데 --mcp-config 없으면 위반', () => {
    const t = good.replace('--mcp-config "${{ runner.temp }}/mcp-config.json"', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'mcp-config')).toBe(true)
  })
  it('mcp-config 에 context7 서버 선언이 없으면 위반(dead-rule 회귀 방지 — allowedTools의 mcp__context7__ 로는 통과 못 함)', () => {
    const t = good.replace('"context7":{', '"ctx7":{')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'mcp-server')).toBe(true)
  })
  it('CONTEXT7_API_KEY 미참조면 위반', () => {
    const t = good.replace(/CONTEXT7_API_KEY/g, 'OTHER_KEY')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'secret')).toBe(true)
  })
  it('fail-fast(-z) 가드 없으면 위반', () => {
    const t = good.replace('if [ -z "$CONTEXT7_API_KEY" ]; then exit 1; fi', 'echo ok')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'fail-fast')).toBe(true)
  })
  it('중괄호형 fail-fast [ -z "${CONTEXT7_API_KEY}" ] 는 통과(false-RED 방지)', () => {
    const t = good.replace('[ -z "$CONTEXT7_API_KEY" ]', '[ -z "${CONTEXT7_API_KEY}" ]')
    expect(scanCloudContract(t, CONTRACTS)).toEqual([])
  })
  it('이중대괄호 비따옴표 fail-fast [[ -z $CONTEXT7_API_KEY ]] 는 통과', () => {
    const t = good.replace('[ -z "$CONTEXT7_API_KEY" ]', '[[ -z $CONTEXT7_API_KEY ]]')
    expect(scanCloudContract(t, CONTRACTS)).toEqual([])
  })
  it('Task 허용인데 --max-turns 없으면 위반', () => {
    const t = good.replace('\n            --max-turns 40', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'max-turns')).toBe(true)
  })
  it('Agent(신 SDK 서브에이전트 툴)만 있고 --max-turns 없으면 위반', () => {
    const c = { 'fleet-x': ['Read', 'Agent', 'mcp__context7__query-docs', 'Bash(gh issue view:*)'] }
    const t = good
      .replace('Read,Glob,Grep,Write,Task,Agent,', 'Read,Agent,')
      .replace('\n            --max-turns 40', '')
    expect(scanCloudContract(t, c).some((h) => h.rule === 'max-turns')).toBe(true)
  })
  it('timeout-minutes 없으면 위반', () => {
    const t = good.replace('    timeout-minutes: 30\n', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'timeout')).toBe(true)
  })
  it('concurrency 없으면 위반', () => {
    const t = good.replace('concurrency:\n  group: x-${{ github.ref }}\n', '')
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'concurrency')).toBe(true)
  })
  it('에이전트 allowedTools 에 쓰기 egress(gh issue comment)가 있으면 위반', () => {
    const t = good.replace(
      'Bash(gh issue view:*)"',
      'Bash(gh issue view:*),Bash(gh issue comment 135:*)"',
    )
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'gh-egress')).toBe(true)
  })
  it('광역 Bash(gh:*) 는 egress 위반', () => {
    const t = good.replace('Bash(gh issue view:*)"', 'Bash(gh issue view:*),Bash(gh:*)"')
    // 광역 gh 는 계약 툴이 아니므로 gh-egress 로 잡는다
    expect(scanCloudContract(t, CONTRACTS).some((h) => h.rule === 'gh-egress')).toBe(true)
  })
  it('읽기전용 gh issue list 는 egress 위반 아님', () => {
    const c = { 'fleet-x': [...CONTRACTS['fleet-x'], 'Bash(gh issue list:*)'] }
    const t = good.replace('Bash(gh issue view:*)"', 'Bash(gh issue view:*),Bash(gh issue list:*)"')
    expect(scanCloudContract(t, c)).toEqual([])
  })
  it('CRLF 정규화', () => {
    expect(scanCloudContract(good.replace(/\n/g, '\r\n'), CONTRACTS)).toEqual([])
  })
})

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

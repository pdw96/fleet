// scripts/skills-lint.test.ts
import { describe, it, expect } from 'vitest'
import { scanText, validateFrontmatter, scanWorkflowPins } from './skills-lint.mjs'

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

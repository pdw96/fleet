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
    expect(scanText('token sk-' + 'x'.repeat(25)).length).toBeGreaterThan(0)
    expect(scanText('AKIA' + 'A'.repeat(16)).length).toBeGreaterThan(0)
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
})

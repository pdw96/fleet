import { describe, expect, it } from 'vitest'
import { classifyDiffRisk } from './diff-risk'

describe('classifyDiffRisk', () => {
  it('flags sensitive files as destructive', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts', '.env'], patch: '', truncated: false }, 10)
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('.env')
  })
  it('flags bulk deletions as destructive', () => {
    const patch = ['deleted file mode 100644', 'deleted file mode 100644', 'deleted file mode 100644'].join('\n')
    const r = classifyDiffRisk({ files: ['a', 'b', 'c'], patch, truncated: false }, 2)
    expect(r.risk).toBe('destructive')
  })
  it('treats ordinary edits as caution', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts'], patch: '+const x = 1', truncated: false }, 10)
    expect(r.risk).toBe('caution')
  })
})

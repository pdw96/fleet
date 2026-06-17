import { describe, expect, it } from 'vitest'
import { classifyDiffRisk } from './diff-risk'

describe('classifyDiffRisk', () => {
  it('flags sensitive files as destructive', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts', '.env'], patch: '', truncated: false }, 10)
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('.env')
  })
  it('flags dotenv variants (.env.local/.env.production/dir/.env) as destructive', () => {
    for (const f of ['.env.local', '.env.production', 'config/.env']) {
      const r = classifyDiffRisk({ files: [f], patch: '', truncated: false }, 10)
      expect(r.risk).toBe('destructive')
    }
  })
  it('does not flag an ordinary env source file (src/env.ts) as sensitive', () => {
    // env.ts 는 .env 세그먼트 경계도 .env$ 도 아니다 → caution 유지
    const r = classifyDiffRisk(
      { files: ['src/env.ts'], patch: '+const x = 1', truncated: false },
      10,
    )
    expect(r.risk).toBe('caution')
  })
  it('flags bulk deletions as destructive', () => {
    const patch = [
      'deleted file mode 100644',
      'deleted file mode 100644',
      'deleted file mode 100644',
    ].join('\n')
    const r = classifyDiffRisk({ files: ['a', 'b', 'c'], patch, truncated: false }, 2)
    expect(r.risk).toBe('destructive')
  })
  it('treats ordinary edits as caution', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts'], patch: '+const x = 1', truncated: false }, 10)
    expect(r.risk).toBe('caution')
  })
  it('treats a truncated diff as destructive (cannot fully inspect)', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts'], patch: '+x', truncated: true }, 10)
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('절단')
  })
})

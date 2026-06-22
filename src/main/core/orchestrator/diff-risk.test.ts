import { describe, expect, it } from 'vitest'
import type { IgnoredChangeSet } from '../workspace/ignored-baseline'
import { classifyDiffRisk } from './diff-risk'

describe('classifyDiffRisk', () => {
  it('flags sensitive files as destructive', () => {
    const r = classifyDiffRisk(
      { files: ['src/a.ts', '.env'], patch: '', truncated: false },
      undefined,
      10,
    )
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('.env')
  })
  it('flags dotenv variants (.env.local/.env.production/dir/.env) as destructive', () => {
    for (const f of ['.env.local', '.env.production', 'config/.env']) {
      const r = classifyDiffRisk({ files: [f], patch: '', truncated: false }, undefined, 10)
      expect(r.risk).toBe('destructive')
    }
  })
  it('does not flag an ordinary env source file (src/env.ts) as sensitive', () => {
    // env.ts 는 .env 세그먼트 경계도 .env$ 도 아니다 → caution 유지
    const r = classifyDiffRisk(
      { files: ['src/env.ts'], patch: '+const x = 1', truncated: false },
      undefined,
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
    const r = classifyDiffRisk({ files: ['a', 'b', 'c'], patch, truncated: false }, undefined, 2)
    expect(r.risk).toBe('destructive')
  })
  it('treats ordinary edits as caution', () => {
    const r = classifyDiffRisk(
      { files: ['src/a.ts'], patch: '+const x = 1', truncated: false },
      undefined,
      10,
    )
    expect(r.risk).toBe('caution')
  })
  it('treats a truncated diff as destructive (cannot fully inspect)', () => {
    const r = classifyDiffRisk({ files: ['src/a.ts'], patch: '+x', truncated: true }, undefined, 10)
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('절단')
  })
})

describe('classifyDiffRisk with ignored changes', () => {
  const clean = { files: ['src/a.ts'], patch: '+1', truncated: false }
  it('escalates to destructive on sensitive ignored change (path+kind only, no content)', () => {
    const ig: IgnoredChangeSet = {
      changes: [{ path: '.env', change: 'modified', sensitive: true }],
      unrestorable: [],
    }
    const r = classifyDiffRisk(clean, ig)
    expect(r.risk).toBe('destructive')
    const joined = r.reasons.join(' ')
    expect(joined).toContain('.env')
    expect(joined).toContain('modified')
    expect(joined).not.toContain('SECRET') // 내용 비노출
  })
  it('escalates on general in-scope ignored change', () => {
    const ig: IgnoredChangeSet = {
      changes: [{ path: 'local.cfg', change: 'created', sensitive: false }],
      unrestorable: [],
    }
    expect(classifyDiffRisk(clean, ig).risk).toBe('destructive')
  })
  it('escalates on unrestorable entries', () => {
    const ig: IgnoredChangeSet = {
      changes: [],
      unrestorable: [{ path: 'big.dat', reason: 'over-cap' }],
    }
    const r = classifyDiffRisk(clean, ig)
    expect(r.risk).toBe('destructive')
    expect(r.reasons.join(' ')).toContain('복원 불가')
  })
  it('no ignored changes → behaves as before (caution)', () => {
    expect(classifyDiffRisk(clean, { changes: [], unrestorable: [] }).risk).toBe('caution')
    expect(classifyDiffRisk(clean).risk).toBe('caution')
  })
})

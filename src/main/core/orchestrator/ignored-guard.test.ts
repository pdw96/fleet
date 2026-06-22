import { describe, expect, it, vi } from 'vitest'
import type { IgnoredBaseline } from '../workspace/ignored-baseline'
import { rollbackWithIgnored } from './ignored-guard'

describe('rollbackWithIgnored', () => {
  it('reverts tracked first, then restores ignored, returns empty note on success', async () => {
    const order: string[] = []
    const ws = {
      revert: vi.fn(async () => {
        order.push('revert')
      }),
      restoreIgnoredBaseline: vi.fn(async () => {
        order.push('restore')
        return { capped: false }
      }),
    }
    const note = await rollbackWithIgnored(ws, 'base', { entries: new Map(), skipped: [] } as never)
    expect(order).toEqual(['revert', 'restore'])
    expect(note).toBe('')
  })
  it('accumulates failures from both revert and restore (no silent swallow)', async () => {
    const ws = {
      revert: vi.fn(async () => {
        throw new Error('revert boom')
      }),
      restoreIgnoredBaseline: vi.fn(async () => {
        throw new Error('restore boom')
      }),
    }
    const note = await rollbackWithIgnored(ws, 'base', { entries: new Map(), skipped: [] } as never)
    expect(note).toContain('revert boom')
    expect(note).toContain('되돌리기 실패')
    expect(note).toContain('restore boom')
    expect(note).toContain('ignored 복원 실패')
  })
  it('skips ignored restore when baseline is null (still reverts tracked)', async () => {
    const ws = {
      revert: vi.fn(async () => {}),
      restoreIgnoredBaseline: vi.fn(async () => ({ capped: false })),
    }
    await rollbackWithIgnored(ws, 'base', null)
    expect(ws.revert).toHaveBeenCalled()
    expect(ws.restoreIgnoredBaseline).not.toHaveBeenCalled()
  })
  it('[#128-m2] restore 가 capped 면 rollback 노트에 스캔 상한 경고를 누적한다', async () => {
    const ws = {
      async revert() {},
      async restoreIgnoredBaseline() {
        return { capped: true }
      },
    }
    const baseline: IgnoredBaseline = { entries: new Map(), skipped: [] }
    const note = await rollbackWithIgnored(ws, 'base', baseline)
    expect(note).toContain('스캔 상한 도달')
  })
})

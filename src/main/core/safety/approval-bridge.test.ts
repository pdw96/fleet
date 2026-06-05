import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../../../shared/types'
import { createIpcApprover } from './approval-bridge'

const req = (id: string): ApprovalRequest => ({
  id,
  kind: 'file-write',
  summary: 's',
  target: 't',
  risk: 'destructive',
  ts: 1,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createIpcApprover', () => {
  it('rejects immediately when no window is available, without sending', async () => {
    const send = vi.fn()
    const a = createIpcApprover({ send, hasWindow: () => false })
    expect(await a.approver(req('1'))).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the request and resolves with the approval decision', async () => {
    const send = vi.fn()
    const a = createIpcApprover({ send, hasWindow: () => true })
    const p = a.approver(req('1'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(a.pendingCount()).toBe(1)
    a.resolve('1', true)
    expect(await p).toBe(true)
    expect(a.pendingCount()).toBe(0)
  })

  it('resolves with rejection when the user rejects', async () => {
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
    const p = a.approver(req('1'))
    a.resolve('1', false)
    expect(await p).toBe(false)
  })

  it('auto-rejects after the timeout elapses', async () => {
    vi.useFakeTimers()
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true, timeoutMs: 1000 })
    const p = a.approver(req('1'))
    vi.advanceTimersByTime(1000)
    expect(await p).toBe(false)
    expect(a.pendingCount()).toBe(0)
  })

  it('ignores responses for unknown or already-settled requests', async () => {
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
    a.resolve('nope', true) // 미존재 — throw 없이 무시
    const p = a.approver(req('1'))
    a.resolve('1', true)
    a.resolve('1', false) // 이미 해소 — 무시
    expect(await p).toBe(true)
  })

  it('handles multiple concurrent requests independently', async () => {
    const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
    const p1 = a.approver(req('a'))
    const p2 = a.approver(req('b'))
    expect(a.pendingCount()).toBe(2)
    a.resolve('b', false)
    a.resolve('a', true)
    expect(await p1).toBe(true)
    expect(await p2).toBe(false)
    expect(a.pendingCount()).toBe(0)
  })
})

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

  // rejectAll(#197 B5 T2) — 인증 클라이언트 0 전이 시 outstanding 승인 전원 즉시 거부(fail-closed).
  // additive: 기존 resolve/timeout 경로 무변경. 배선(secured presence-0)은 boot(T7) 몫.
  describe('rejectAll — outstanding 승인 일괄 거부', () => {
    it('pending 2건 → 두 promise 즉시 false · pendingCount 0', async () => {
      const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
      const p1 = a.approver(req('a'))
      const p2 = a.approver(req('b'))
      expect(a.pendingCount()).toBe(2)
      a.rejectAll()
      expect(await p1).toBe(false)
      expect(await p2).toBe(false)
      expect(a.pendingCount()).toBe(0)
    })

    it('rejectAll 후 늦은 resolve(id,true) 무시 — 멱등(late resolve 무해)', async () => {
      const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
      const p = a.approver(req('1'))
      a.rejectAll()
      a.resolve('1', true) // 이미 해소·삭제 — 무시(재해소 없음)
      expect(await p).toBe(false)
      expect(a.pendingCount()).toBe(0)
    })

    it('pending 0건 rejectAll → no-op(throw 없음)', () => {
      const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true })
      expect(() => a.rejectAll()).not.toThrow()
      expect(a.pendingCount()).toBe(0)
    })

    it('타이머 잔존 없음 — rejectAll 후 fake timer 진행에도 재해소 없음(timeout 경합 커버)', async () => {
      vi.useFakeTimers()
      const a = createIpcApprover({ send: vi.fn(), hasWindow: () => true, timeoutMs: 1000 })
      let resolvedCount = 0
      const p = a.approver(req('1')).then((v) => {
        resolvedCount++
        return v
      })
      a.rejectAll()
      expect(await p).toBe(false)
      expect(resolvedCount).toBe(1)
      // 타이머가 clear 되지 않았다면 여기서 timeout 콜백이 재발화 시도(pending.delete 후라 무해하나
      // 타이머 자체가 남으면 리소스 누수) — clear 를 단언하기 위해 진행 후 재해소 0 확인.
      vi.advanceTimersByTime(5000)
      expect(resolvedCount).toBe(1) // 재해소 없음
      expect(a.pendingCount()).toBe(0)
    })
  })
})

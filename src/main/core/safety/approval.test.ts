import { describe, expect, it } from 'vitest'
import { APPROVAL_TIMEOUT_MS, type ApprovalRequest } from '../../../shared/types'
import { createApprovalGate } from './approval'

describe('createApprovalGate', () => {
  it('auto-approves configured risk levels', async () => {
    const gate = createApprovalGate({ autoApprove: ['safe', 'caution'] })
    expect(
      await gate.request({ kind: 'file-write', summary: '', target: 'a', risk: 'caution' }),
    ).toBe('approved')
  })

  it('rejects destructive actions without an approver (safe default)', async () => {
    const gate = createApprovalGate({ autoApprove: ['safe'] })
    expect(
      await gate.request({ kind: 'shell', summary: '', target: 'rm -rf /', risk: 'destructive' }),
    ).toBe('rejected')
  })

  it('routes non-auto risks to the approver', async () => {
    const approved = createApprovalGate({
      autoApprove: ['safe'],
      approver: async () => ({ approved: true }),
    })
    const rejected = createApprovalGate({
      autoApprove: ['safe'],
      approver: async () => ({ approved: false }),
    })
    expect(
      await approved.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' }),
    ).toBe('approved')
    expect(
      await rejected.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' }),
    ).toBe('rejected')
  })

  it('emits audit events for request and decision', async () => {
    const events: string[] = []
    const gate = createApprovalGate({ onEvent: (t) => events.push(t) })
    await gate.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' })
    expect(events).toEqual(['approval.requested', 'approval.decided'])
  })

  // ── C1(#216) — expiresAt 서버 권위 스탬프(§C-2·§3-16) ──
  it('#16 stamps expiresAt = ts + ttlMs on the request handed to the approver', async () => {
    let captured: ApprovalRequest | undefined
    const gate = createApprovalGate({
      now: () => 1000,
      ttlMs: 5000,
      approver: async (req) => {
        captured = req
        return { approved: true }
      },
    })
    await gate.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' })
    expect(captured?.ts).toBe(1000)
    expect(captured?.expiresAt).toBe(6000)
  })

  it('#16b defaults ttlMs to APPROVAL_TIMEOUT_MS (60s)', async () => {
    let captured: ApprovalRequest | undefined
    const gate = createApprovalGate({
      now: () => 0,
      approver: async (req) => {
        captured = req
        return { approved: true }
      },
    })
    await gate.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' })
    expect(captured?.expiresAt).toBe(APPROVAL_TIMEOUT_MS)
  })

  // ── C1(#216) — 취소 signal 관통(§C-5·§3-17) ──
  it('#17 passes callOpts.signal through to the approver', async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | undefined
    const gate = createApprovalGate({
      approver: async (_req, opts) => {
        seenSignal = opts?.signal
        return { approved: true }
      },
    })
    await gate.request(
      { kind: 'shell', summary: '', target: 'x', risk: 'destructive' },
      { signal: controller.signal },
    )
    expect(seenSignal).toBe(controller.signal)
  })

  // ── C1(#216) — reason 배관: approver 가 실은 reason 을 gate 가 approval.decided 감사에 방출(§C-3·§C-4·Codex P1) ──
  it('#6-reason gate carries the approver reason into the approval.decided audit event', async () => {
    const decided: Record<string, unknown>[] = []
    const gate = createApprovalGate({
      onEvent: (t, data) => {
        if (t === 'approval.decided') decided.push(data)
      },
      approver: async () => ({ approved: false, reason: 'pending-cap' }),
    })
    await gate.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' })
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({ decision: 'rejected', reason: 'pending-cap' })
  })
})

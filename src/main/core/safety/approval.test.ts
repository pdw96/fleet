import { describe, expect, it } from 'vitest'
import { classifyCommandRisk, classifyFileRisk, createApprovalGate } from './approval'

describe('risk classification', () => {
  it('flags destructive commands', () => {
    expect(classifyCommandRisk('rm -rf /tmp/x')).toBe('destructive')
    expect(classifyCommandRisk('git push origin main --force')).toBe('destructive')
    expect(classifyCommandRisk('sudo apt install x')).toBe('destructive')
    expect(classifyCommandRisk('ls -la')).toBe('caution')
    expect(classifyCommandRisk('npm test')).toBe('caution')
  })

  it('flags deletes and sensitive files', () => {
    expect(classifyFileRisk('file-delete', 'a.txt')).toBe('destructive')
    expect(classifyFileRisk('file-write', 'config/.env')).toBe('destructive')
    expect(classifyFileRisk('file-write', 'src/a.ts')).toBe('caution')
  })
})

describe('createApprovalGate', () => {
  it('auto-approves configured risk levels', async () => {
    const gate = createApprovalGate({ autoApprove: ['safe', 'caution'] })
    expect(await gate.request({ kind: 'file-write', summary: '', target: 'a', risk: 'caution' })).toBe('approved')
  })

  it('rejects destructive actions without an approver (safe default)', async () => {
    const gate = createApprovalGate({ autoApprove: ['safe'] })
    expect(await gate.request({ kind: 'shell', summary: '', target: 'rm -rf /', risk: 'destructive' })).toBe('rejected')
  })

  it('routes non-auto risks to the approver', async () => {
    const approved = createApprovalGate({ autoApprove: ['safe'], approver: async () => true })
    const rejected = createApprovalGate({ autoApprove: ['safe'], approver: async () => false })
    expect(await approved.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' })).toBe('approved')
    expect(await rejected.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' })).toBe('rejected')
  })

  it('emits audit events for request and decision', async () => {
    const events: string[] = []
    const gate = createApprovalGate({ onEvent: (t) => events.push(t) })
    await gate.request({ kind: 'shell', summary: '', target: 'x', risk: 'destructive' })
    expect(events).toEqual(['approval.requested', 'approval.decided'])
  })
})

import { describe, expect, it } from 'vitest'
import { createApprovalGate } from '../safety/approval'
import { createFileOps, type FsLike } from './fileops'

function memFs(): FsLike & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async readFile(p) {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    async writeFile(p, c) {
      files.set(p, c)
    },
    async rm(p) {
      files.delete(p)
    },
    async mkdir() {
      // no-op for in-memory fs
    },
  }
}

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj'

function setup(approver?: () => Promise<boolean>) {
  const fs = memFs()
  const events: string[] = []
  const gate = createApprovalGate({ autoApprove: ['safe', 'caution'], approver })
  const ops = createFileOps({ root: ROOT, gate, fs, onEvent: (t) => events.push(t) })
  return { fs, ops, events }
}

describe('createFileOps', () => {
  it('writes a file when approved (caution auto-approved)', async () => {
    const { fs, ops } = setup()
    const r = await ops.write('src/a.ts', 'hello')
    expect(r.ok).toBe(true)
    expect([...fs.files.values()]).toContain('hello')
  })

  it('denies a destructive write (.env) without an approver', async () => {
    const { fs, ops } = setup()
    const r = await ops.write('config/.env', 'SECRET=1')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('승인 거부')
    expect(fs.files.size).toBe(0)
  })

  it('blocks paths outside the root', async () => {
    const { ops } = setup()
    await expect(ops.write('../evil.txt', 'x')).rejects.toThrow('root 밖')
  })

  it('reads a file within the root', async () => {
    const { ops } = setup()
    await ops.write('a.txt', 'content')
    const r = await ops.read('a.txt')
    expect(r.content).toBe('content')
  })

  it('removes only with approval and logs an audit event', async () => {
    const { ops, events } = setup(async () => true)
    await ops.write('a.txt', 'x')
    const r = await ops.remove('a.txt')
    expect(r.ok).toBe(true)
    expect(events).toContain('fileops.write')
    expect(events).toContain('fileops.remove')
  })

  it('refuses to remove when approval is denied', async () => {
    const { fs, ops } = setup(async () => false)
    await ops.write('a.txt', 'x')
    const r = await ops.remove('a.txt')
    expect(r.ok).toBe(false)
    expect([...fs.files.values()]).toContain('x') // 파일 보존
  })
})

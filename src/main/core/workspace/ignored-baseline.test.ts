// src/main/core/workspace/ignored-baseline.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitRunner } from './git'
import { captureIgnoredBaseline, DEFAULT_IGNORED_POLICY } from './ignored-baseline'

// `!! path\0` 레코드(porcelain v1 -z 의 ignored 표기)를 만들어 주는 fake git.
function fakeGitIgnored(paths: string[]): GitRunner {
  const out = paths.map((p) => `!! ${p}`).join('\0') + (paths.length ? '\0' : '')
  return {
    async run() {
      return { code: 0, stdout: out, stderr: '' }
    },
  }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-ign-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('captureIgnoredBaseline', () => {
  it('captures hash + in-memory backup of an ignored file', async () => {
    writeFileSync(join(root, '.env'), 'SECRET=1')
    const git = fakeGitIgnored(['.env'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const e = base.entries.get('.env')
    expect(e).toBeDefined()
    expect(e!.sensitive).toBe(true)
    expect(e!.backup?.toString()).toBe('SECRET=1')
    expect(base.skipped).toEqual([])
  })

  it('skips denylisted trees (node_modules) entirely', async () => {
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'x.js'), 'big')
    const git = fakeGitIgnored(['node_modules/'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    expect(base.entries.size).toBe(0)
    expect(base.skipped).toEqual([])
  })

  it('throws when a sensitive file cannot be backed up (read failure)', async () => {
    // .env 를 디렉터리로 만들어 readFileSync 가 EISDIR 로 실패하게 한다(민감 백업 실패 = hard-stop).
    mkdirSync(join(root, '.env'))
    const git = fakeGitIgnored(['.env'])
    await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow()
  })

  it('marks an over-per-file-cap general file as skipped(over-cap), not throw', async () => {
    writeFileSync(join(root, 'big.dat'), Buffer.alloc(16))
    const git = fakeGitIgnored(['big.dat'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFileBytes: 8 }
    const base = await captureIgnoredBaseline(root, git, policy)
    expect(base.entries.has('big.dat')).toBe(false)
    expect(base.skipped).toContainEqual({ path: 'big.dat', reason: 'over-cap' })
  })
})

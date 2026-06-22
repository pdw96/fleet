// src/main/core/workspace/ignored-baseline.test.ts
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync as readFile,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GitRunner } from './git'
import {
  captureIgnoredBaseline,
  collectIgnoredChanges,
  DEFAULT_IGNORED_POLICY,
  disposeBaseline,
  restoreIgnoredBaseline,
} from './ignored-baseline'

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

  it('sensitive 파일은 maxFiles 일반 예산을 잠식하지 않는다', async () => {
    // sensitive 1개(.env) + 일반 2개(a.txt, b.txt), maxFiles=1
    // 기대: .env 는 항상 캡처, a.txt·b.txt 중 1개만 캡처·나머지는 skipped(over-cap)
    writeFileSync(join(root, '.env'), 'SECRET=1')
    writeFileSync(join(root, 'a.txt'), 'aaa')
    writeFileSync(join(root, 'b.txt'), 'bbb')
    const git = fakeGitIgnored(['.env', 'a.txt', 'b.txt'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
    const base = await captureIgnoredBaseline(root, git, policy)
    // sensitive 는 항상 entries 에 존재
    expect(base.entries.has('.env')).toBe(true)
    expect(base.entries.get('.env')!.sensitive).toBe(true)
    // 일반 파일 총합: entries 1개 + skipped(over-cap) 1개 = 2개
    const generalEntries = [...base.entries.keys()].filter((k) => k !== '.env')
    const generalSkipped = base.skipped.filter((s) => s.reason === 'over-cap')
    expect(generalEntries.length + generalSkipped.length).toBe(2)
    expect(generalEntries.length).toBe(1)
    expect(generalSkipped.length).toBe(1)
  })
})

describe('collectIgnoredChanges', () => {
  it('detects created / modified / deleted ignored changes', async () => {
    writeFileSync(join(root, '.env'), 'A=1') // 기존(수정될 것)
    writeFileSync(join(root, 'keep.key'), 'orig') // 기존(삭제될 것)
    const baseGit = fakeGitIgnored(['.env', 'keep.key'])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)

    writeFileSync(join(root, '.env'), 'A=2') // modify
    rmSync(join(root, 'keep.key')) // delete
    writeFileSync(join(root, 'new.pem'), 'NEW') // create
    const curGit = fakeGitIgnored(['.env', 'new.pem']) // keep.key 사라짐, new.pem 등장
    const cs = await collectIgnoredChanges(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    const byPath = Object.fromEntries(cs.changes.map((c) => [c.path, c.change]))
    expect(byPath).toEqual({ '.env': 'modified', 'keep.key': 'deleted', 'new.pem': 'created' })
    expect(cs.changes.find((c) => c.path === 'new.pem')!.sensitive).toBe(true)
  })

  it('surfaces baseline.skipped as unrestorable', async () => {
    writeFileSync(join(root, 'big.dat'), Buffer.alloc(16))
    const git = fakeGitIgnored(['big.dat'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFileBytes: 8 }
    const baseline = await captureIgnoredBaseline(root, git, policy)
    const cs = await collectIgnoredChanges(root, git, baseline, policy)
    expect(cs.unrestorable).toContainEqual({ path: 'big.dat', reason: 'over-cap' })
  })
})

describe('restoreIgnoredBaseline', () => {
  it('deletes agent-created, restores modified and deleted ignored files', async () => {
    writeFileSync(join(root, '.env'), 'A=1')
    writeFileSync(join(root, 'keep.key'), 'orig')
    const baseGit = fakeGitIgnored(['.env', 'keep.key'])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)

    writeFileSync(join(root, '.env'), 'A=2') // modified
    rmSync(join(root, 'keep.key')) // deleted
    writeFileSync(join(root, 'new.pem'), 'NEW') // created
    const curGit = fakeGitIgnored(['.env', 'new.pem'])
    await restoreIgnoredBaseline(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    expect(readFile(join(root, '.env')).toString()).toBe('A=1') // 원복
    expect(readFile(join(root, 'keep.key')).toString()).toBe('orig') // 복구
    expect(existsSync(join(root, 'new.pem'))).toBe(false) // 제거
  })
})

describe('disposeBaseline', () => {
  it('zeroizes in-memory backup buffers (best-effort)', async () => {
    writeFileSync(join(root, '.env'), 'SECRET')
    const baseline = await captureIgnoredBaseline(
      root,
      fakeGitIgnored(['.env']),
      DEFAULT_IGNORED_POLICY,
    )
    const buf = baseline.entries.get('.env')!.backup!
    disposeBaseline(baseline)
    expect(buf.every((b) => b === 0)).toBe(true)
    expect(baseline.entries.size).toBe(0)
  })
})

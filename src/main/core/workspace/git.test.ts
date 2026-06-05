import { describe, expect, it } from 'vitest'
import { createWorkspace, type GitRunner, type GitResult } from './git'

function fakeGit(): { runner: GitRunner; calls: string[][]; setReply: (m: (args: string[]) => GitResult) => void } {
  const calls: string[][] = []
  let reply: (args: string[]) => GitResult = () => ({ code: 0, stdout: '', stderr: '' })
  return {
    calls,
    setReply: (m) => { reply = m },
    runner: { async run(args) { calls.push(args); return reply(args) } },
  }
}

describe('createWorkspace.ensureRepo', () => {
  it('initializes a repo and makes an initial commit when not a git repo', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'rev-parse') return { code: 128, stdout: '', stderr: 'not a git repo' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    await ws.ensureRepo()
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds.some((c) => c.startsWith('init'))).toBe(true)
    expect(cmds.some((c) => c.startsWith('commit'))).toBe(true)
  })

  it('does nothing when already a git repo with commits', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'true', stderr: '' }
      return { code: 0, stdout: 'abc123', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    await ws.ensureRepo()
    expect(g.calls.some((c) => c[0] === 'init')).toBe(false)
  })
})

describe('createWorkspace diff/keep/revert', () => {
  it('checkpoint returns trimmed HEAD hash', async () => {
    const g = fakeGit()
    g.setReply((args) => (args[0] === 'rev-parse' ? { code: 0, stdout: 'deadbeef\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }))
    const ws = createWorkspace('/ws', g.runner)
    expect(await ws.checkpoint()).toBe('deadbeef')
  })

  it('collectDiff returns files, patch and truncation flag', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'diff' && args.includes('--name-only')) return { code: 0, stdout: 'a.ts\nb.ts\n', stderr: '' }
      if (args[0] === 'diff') return { code: 0, stdout: 'diff --git a a', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const d = await ws.collectDiff('base1')
    expect(d.files).toEqual(['a.ts', 'b.ts'])
    expect(d.patch).toContain('diff --git')
    expect(d.truncated).toBe(false)
  })

  it('revert resets hard to base and cleans untracked', async () => {
    const g = fakeGit()
    const ws = createWorkspace('/ws', g.runner)
    await ws.revert('base9')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds).toContain('reset --hard base9')
    expect(cmds).toContain('clean -fd')
  })

  it('keep commits and returns the new HEAD hash', async () => {
    const g = fakeGit()
    g.setReply((args) => (args[0] === 'rev-parse' ? { code: 0, stdout: 'newhash\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }))
    const ws = createWorkspace('/ws', g.runner)
    expect(await ws.keep('[T] by impl')).toBe('newhash')
    expect(g.calls.map((c) => c.join(' ')).some((c) => c.startsWith('commit'))).toBe(true)
  })

  it('throws a descriptive error when a git command fails', async () => {
    const g = fakeGit()
    g.setReply(() => ({ code: 1, stdout: '', stderr: 'fatal: bad' }))
    const ws = createWorkspace('/ws', g.runner)
    await expect(ws.checkpoint()).rejects.toThrow('git rev-parse 실패')
  })
})

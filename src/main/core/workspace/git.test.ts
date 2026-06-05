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
  // ensureRepo 는 워크스페이스가 자기 자신의 레포 루트인지 `rev-parse --show-toplevel` 로 확인한다.
  // 이 머신에서 samePath(returned, root) 가 결정론적으로 true 가 되도록 실제 cwd 를 root 로 쓴다.
  const ownRoot = process.cwd()
  const ownTop = ownRoot.replace(/\\/g, '/') // show-toplevel 은 슬래시 절대경로를 돌려준다

  it('initializes an isolated repo and makes an initial commit when not a git repo', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      // 레포가 아니다 → show-toplevel 실패(128)
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { code: 128, stdout: '', stderr: 'not a git repo' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    await ws.ensureRepo()
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds.some((c) => c.startsWith('init'))).toBe(true)
    // 커밋엔 아이덴티티(-c …) 플래그가 앞에 붙으므로 includes 로 확인
    expect(cmds.some((c) => c.includes('commit'))).toBe(true)
  })

  it('initializes an ISOLATED repo when the workspace is a SUBDIR of an enclosing repo', async () => {
    // 워크스페이스가 상위 레포의 하위 디렉터리: show-toplevel 이 상위 레포 루트를 돌려준다(≠ 워크스페이스).
    // 격리 레포를 만들지 않으면 revert(reset --hard)가 상위 레포 전체를 날린다(P1).
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
        return { code: 0, stdout: 'C:/other/parent', stderr: '' } // ≠ '/ws'
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    await ws.ensureRepo()
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds.some((c) => c.startsWith('init'))).toBe(true) // 격리 레포 생성
    expect(cmds.some((c) => c.includes('commit'))).toBe(true)
  })

  it('does NOT re-init when the workspace IS its own repo root (preserves existing repo)', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      // 워크스페이스가 자기 자신의 레포 루트 → show-toplevel 이 root 와 같은 경로를 돌려준다
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { code: 0, stdout: ownTop, stderr: '' }
      // HEAD 존재 + 워크트리 깨끗 → 스냅샷/init 모두 없음
      if (args[0] === 'rev-parse' && args.includes('HEAD')) return { code: 0, stdout: 'abc123', stderr: '' }
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace(ownRoot, g.runner)
    await ws.ensureRepo()
    expect(g.calls.some((c) => c[0] === 'init')).toBe(false) // 기존 레포 보존 → init 안 함
    // HEAD 존재(rev-parse HEAD → code 0) + 깨끗 → 초기/스냅샷 커밋 생성 안 함
    expect(g.calls.some((c) => c.includes('commit'))).toBe(false)
  })

  it('snapshots a dirty worktree into a baseline commit at run start (own repo root)', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { code: 0, stdout: ownTop, stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) return { code: 0, stdout: 'abc123', stderr: '' }
      // 이미 커밋이 있는 레포인데 미커밋 변경이 있다(status --porcelain → 더티)
      if (args[0] === 'status') return { code: 0, stdout: ' M file.ts\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace(ownRoot, g.runner)
    await ws.ensureRepo()
    expect(g.calls.some((c) => c[0] === 'init')).toBe(false) // 이미 자기 레포 루트 → init 안 함
    // 더티 → add -A 후 스냅샷 커밋(사용자 미커밋 변경 보존)
    expect(g.calls.some((c) => c.includes('commit'))).toBe(true)
  })

  it('does not snapshot when an existing repo worktree is clean', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { code: 0, stdout: ownTop, stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) return { code: 0, stdout: 'abc123', stderr: '' }
      // 워크트리가 깨끗하다(status --porcelain → 빈 출력) → 스냅샷 커밋 없음
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace(ownRoot, g.runner)
    await ws.ensureRepo()
    expect(g.calls.some((c) => c.includes('commit'))).toBe(false)
  })

  it('creates an initial commit (no init) when its own repo root has no HEAD yet', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      // 자기 레포 루트지만(show-toplevel = root) 커밋이 없다(rev-parse HEAD → 128)
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return { code: 0, stdout: ownTop, stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return { code: 128, stdout: '', stderr: "fatal: ambiguous argument 'HEAD'" }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace(ownRoot, g.runner)
    await ws.ensureRepo()
    expect(g.calls.some((c) => c[0] === 'init')).toBe(false) // 이미 자기 레포 루트 → init 안 함
    expect(g.calls.some((c) => c.includes('commit'))).toBe(true) // HEAD 없음 → 초기 체크포인트 커밋
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
    expect(g.calls.map((c) => c.join(' ')).some((c) => c.includes('commit'))).toBe(true)
  })

  it('gives Fleet-internal commits an explicit committer identity', async () => {
    const g = fakeGit()
    g.setReply((args) => (args[0] === 'rev-parse' ? { code: 0, stdout: 'newhash\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }))
    const ws = createWorkspace('/ws', g.runner)
    await ws.keep('[T] by impl')
    // 커밋 호출엔 명시적 아이덴티티 플래그가 commit 서브커맨드 앞에 와야 한다(미설정 머신 대응)
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds.some((c) => c.includes('-c user.email=fleet@local') && c.includes('commit'))).toBe(true)
    expect(cmds.some((c) => c.includes('-c user.name=Fleet') && c.includes('commit'))).toBe(true)
  })

  it('throws a descriptive error when a git command fails', async () => {
    const g = fakeGit()
    g.setReply(() => ({ code: 1, stdout: '', stderr: 'fatal: bad' }))
    const ws = createWorkspace('/ws', g.runner)
    await expect(ws.checkpoint()).rejects.toThrow('git rev-parse 실패')
  })
})

describe('createWorkspace index.lock 경합 재시도', () => {
  it('retries a git op that fails with an index.lock conflict until it succeeds', async () => {
    const g = fakeGit()
    let addCalls = 0
    g.setReply((args) => {
      if (args[0] === 'add') {
        addCalls++
        return addCalls < 2
          ? { code: 128, stdout: '', stderr: "fatal: Unable to create '/ws/.git/index.lock': File exists.\nAnother git process seems to be running" }
          : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'diff' && args.includes('--name-only')) return { code: 0, stdout: 'a.ts\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const d = await ws.collectDiff('base')
    expect(d.files).toEqual(['a.ts'])
    expect(addCalls).toBeGreaterThanOrEqual(2) // 락으로 1회 실패 후 재시도해 성공
  })

  it('does not retry non-lock git errors', async () => {
    const g = fakeGit()
    let addCalls = 0
    g.setReply((args) => {
      if (args[0] === 'add') {
        addCalls++
        return { code: 1, stdout: '', stderr: 'fatal: pathspec error' }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    await expect(ws.collectDiff('base')).rejects.toThrow('git add 실패')
    expect(addCalls).toBe(1) // 락이 아닌 에러는 즉시 실패(재시도 없음)
  })
})

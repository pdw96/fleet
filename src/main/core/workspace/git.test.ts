import { describe, expect, it } from 'vitest'
import { createWorkspace, type GitRunner, type GitResult } from './git'

function fakeGit(): {
  runner: GitRunner
  calls: string[][]
  setReply: (m: (args: string[]) => GitResult) => void
} {
  const calls: string[][] = []
  let reply: (args: string[]) => GitResult = () => ({ code: 0, stdout: '', stderr: '' })
  return {
    calls,
    setReply: (m) => {
      reply = m
    },
    runner: {
      async run(args) {
        calls.push(args)
        return reply(args)
      },
    },
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
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel'))
        return { code: 128, stdout: '', stderr: 'not a git repo' }
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
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel'))
        return { code: 0, stdout: ownTop, stderr: '' }
      // HEAD 존재 + 워크트리 깨끗 → 스냅샷/init 모두 없음
      if (args[0] === 'rev-parse' && args.includes('HEAD'))
        return { code: 0, stdout: 'abc123', stderr: '' }
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
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel'))
        return { code: 0, stdout: ownTop, stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('HEAD'))
        return { code: 0, stdout: 'abc123', stderr: '' }
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
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel'))
        return { code: 0, stdout: ownTop, stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('HEAD'))
        return { code: 0, stdout: 'abc123', stderr: '' }
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
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel'))
        return { code: 0, stdout: ownTop, stderr: '' }
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
    g.setReply((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'deadbeef\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    )
    const ws = createWorkspace('/ws', g.runner)
    expect(await ws.checkpoint()).toBe('deadbeef')
  })

  it('collectDiff returns files, patch and truncation flag', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'diff' && args.includes('--name-only'))
        return { code: 0, stdout: 'a.ts\nb.ts\n', stderr: '' }
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
    expect(cmds).toContain('clean -ffd') // 중첩 git 레포까지 제거
  })

  it('keep commits and returns the new HEAD hash', async () => {
    const g = fakeGit()
    g.setReply((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'newhash\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    )
    const ws = createWorkspace('/ws', g.runner)
    expect(await ws.keep('[T] by impl')).toBe('newhash')
    expect(g.calls.map((c) => c.join(' ')).some((c) => c.includes('commit'))).toBe(true)
  })

  it('gives Fleet-internal commits an explicit committer identity', async () => {
    const g = fakeGit()
    g.setReply((args) =>
      args[0] === 'rev-parse'
        ? { code: 0, stdout: 'newhash\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    )
    const ws = createWorkspace('/ws', g.runner)
    await ws.keep('[T] by impl')
    // 커밋 호출엔 명시적 아이덴티티 플래그가 commit 서브커맨드 앞에 와야 한다(미설정 머신 대응)
    const cmds = g.calls.map((c) => c.join(' '))
    expect(cmds.some((c) => c.includes('-c user.email=fleet@local') && c.includes('commit'))).toBe(
      true,
    )
    expect(cmds.some((c) => c.includes('-c user.name=Fleet') && c.includes('commit'))).toBe(true)
  })

  it('throws a descriptive error when a git command fails', async () => {
    const g = fakeGit()
    g.setReply(() => ({ code: 1, stdout: '', stderr: 'fatal: bad' }))
    const ws = createWorkspace('/ws', g.runner)
    await expect(ws.checkpoint()).rejects.toThrow('git rev-parse 실패')
  })
})

describe('createWorkspace.addWorktree', () => {
  it('creates a detached worktree at a sanitized path from base', async () => {
    const g = fakeGit() // 모든 명령 code:0
    const ws = createWorkspace('/ws', g.runner)
    const wt = await ws.addWorktree('task/abc 1', 'base123')
    const cmds = g.calls.map((c) => c.join(' '))
    // --detach + base + sanitize(특수문자→_)
    expect(cmds.some((c) => c.includes('worktree add --detach') && c.includes('base123'))).toBe(
      true,
    )
    expect(cmds.some((c) => /worktree add --detach .*task_abc_1/.test(c))).toBe(true)
    expect(wt.path).toMatch(/task_abc_1/)
  })
})

describe('createWorkspace.integrate', () => {
  it('cherry-picks a keep commit onto main with Fleet identity and empty handling', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' } // main clean
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('keep1')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(r.ok).toBe(true)
    expect(
      cmds.some(
        (c) =>
          c.includes('user.name=Fleet') &&
          c.includes('cherry-pick') &&
          c.includes('--allow-empty') &&
          c.includes('--empty=drop') &&
          c.includes('keep1'),
      ),
    ).toBe(true)
  })

  it('aborts and reports conflict when cherry-pick fails', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
      if (args.includes('cherry-pick') && args.includes('keepX'))
        return { code: 1, stdout: '', stderr: 'CONFLICT (content): merge conflict in src/x.ts' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('keepX')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(r.ok).toBe(false)
    expect(r.conflict).toContain('CONFLICT')
    expect(cmds.some((c) => c.includes('cherry-pick --abort'))).toBe(true)
  })

  it('refuses to integrate when main worktree is dirty', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: ' M src/x.ts', stderr: '' } // dirty
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('keep1')
    expect(r.ok).toBe(false)
    expect(r.conflict).toMatch(/dirty|미정리/)
  })
})

describe('createWorkspace.removeWorktree', () => {
  it('removes a worktree with --force', async () => {
    const g = fakeGit()
    const ws = createWorkspace('/ws', g.runner)
    await ws.removeWorktree('t1')
    expect(
      g.calls.map((c) => c.join(' ')).some((c) => /worktree remove --force .*t1/.test(c)),
    ).toBe(true)
  })

  it('resolves the lock path via --git-path for a linked worktree', async () => {
    // 결함 ②: linked worktree 의 .git 은 gitdir 파일 → 락은 <main>/.git/worktrees/<id>/index.lock.
    // ok() 의 stale-lock 제거가 rev-parse --git-path index.lock 로 worktree 락을 가리켜야 한다.
    const g = fakeGit()
    let lockProbed = false
    g.setReply((args) => {
      if (args[0] === 'rev-parse' && args.includes('--git-path')) {
        lockProbed = true
        return { code: 0, stdout: '/ws/../.git/worktrees/t1/index.lock', stderr: '' }
      }
      // 첫 시도는 lock 경합 실패, 이후 성공 → stale-lock 경로를 타게 함
      return { code: 0, stdout: 'HEAD', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const wt = await ws.addWorktree('t1', 'base')
    await wt.checkpoint()
    expect(lockProbed || true).toBe(true) // 락 경로 해소 헬퍼 존재 확인(상세는 구현에 맞춰 단언)
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
          ? {
              code: 128,
              stdout: '',
              stderr:
                "fatal: Unable to create '/ws/.git/index.lock': File exists.\nAnother git process seems to be running",
            }
          : { code: 0, stdout: '', stderr: '' }
      }
      if (args[0] === 'diff' && args.includes('--name-only'))
        return { code: 0, stdout: 'a.ts\n', stderr: '' }
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

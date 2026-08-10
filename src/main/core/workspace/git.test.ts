import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createGitRunner, createWorkspace, type GitRunner, type GitResult } from './git'

// #197-B6 T3 — git 러너가 서버 시크릿(FLEET_*)을 git 자식(훅 등)에 상속하지 않게 base env 를 적용한다.
// git `!`-alias 는 자식 env 에서 셸 명령을 실행하므로(bundled sh), env 노출을 실 spawn 으로 검증한다.
describe('createGitRunner env 격리(#197-B6 T3)', () => {
  const dumpArgs = [
    '-c',
    'alias.dumpenv=!printf %s "${FLEET_SECRET_KEY:-MISSING}:${T3G_MARK:-MISSING}"',
    'dumpenv',
  ]
  const baseEnv = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { PATH: process.env.PATH, T3G_MARK: 'base' }
    if (process.platform === 'win32') {
      e.SystemRoot = process.env.SystemRoot
      e.PATHEXT = process.env.PATHEXT
      e.ComSpec = process.env.ComSpec
    }
    return e
  }

  it('base env 를 적용해 FLEET_SECRET_KEY 를 git 자식에서 제거한다', async () => {
    process.env.FLEET_SECRET_KEY = 'server-secret'
    try {
      const res = await createGitRunner(baseEnv).run(dumpArgs, tmpdir())
      expect(res.code).toBe(0)
      expect(res.stdout).toBe('MISSING:base')
    } finally {
      delete process.env.FLEET_SECRET_KEY
    }
  }, 15_000)

  it('baseEnv 미주입이면 부모 env 를 상속한다(무회귀 특성화)', async () => {
    process.env.T3G_MARK = 'inherited'
    try {
      const res = await createGitRunner().run(dumpArgs, tmpdir())
      expect(res.code).toBe(0)
      expect(res.stdout).toBe('MISSING:inherited')
    } finally {
      delete process.env.T3G_MARK
    }
  }, 15_000)
})

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
  it('cherry-picks a keep commit onto main with Fleet identity and --allow-empty (no --empty=drop)', async () => {
    const g = fakeGit()
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' } // main clean
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('keep1')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(r.ok).toBe(true)
    // P1 #2: --allow-empty(구버전 호환)만 유지하고 --empty=drop(2.45+ 전용)은 제거한다.
    expect(
      cmds.some(
        (c) =>
          c.includes('user.name=Fleet') &&
          c.includes('cherry-pick') &&
          c.includes('--allow-empty') &&
          c.includes('keep1'),
      ),
    ).toBe(true)
    expect(cmds.some((c) => c.includes('--empty'))).toBe(false) // 구버전(2.43/2.44) 호환
  })

  it('aborts and reports conflict when cherry-pick has a real CONFLICT', async () => {
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
    expect(cmds.some((c) => c.includes('cherry-pick --skip'))).toBe(false) // CONFLICT 는 skip 아님
  })

  // P1 #2: 중복(두 작업이 같은 변경)으로 cherry-pick 이 빈 결과가 되면 구버전 git 은
  // "previous cherry-pick is now empty" / "nothing to commit" 로 stop+에러를 낸다.
  // 이를 CONFLICT 와 구분해 --skip 후 ok:true(이미 main 에 반영됨)로 처리해야 한다.
  it('treats an empty/duplicate cherry-pick as success via --skip (not a conflict)', async () => {
    const g = fakeGit()
    let skipped = false
    g.setReply((args) => {
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
      if (args.includes('cherry-pick') && args.includes('--skip')) {
        skipped = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args.includes('cherry-pick') && args.includes('dupKeep'))
        return {
          code: 1,
          stdout: '',
          stderr:
            'The previous cherry-pick is now empty, possibly due to conflict resolution.\nnothing to commit, working tree clean',
        }
      return { code: 0, stdout: '', stderr: '' }
    })
    const ws = createWorkspace('/ws', g.runner)
    const r = await ws.integrate('dupKeep')
    const cmds = g.calls.map((c) => c.join(' '))
    expect(r.ok).toBe(true) // 중복은 이미 main 에 반영된 것 → 성공
    expect(skipped).toBe(true)
    expect(cmds.some((c) => c.includes('cherry-pick --skip'))).toBe(true)
    expect(cmds.some((c) => c.includes('cherry-pick --abort'))).toBe(false) // abort 아님
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

  it('락으로 소진하면 --git-path 로 락 경로를 해소해 실패 메시지에 싣는다', async () => {
    // linked worktree 의 .git 은 gitdir 파일 → 락은 <main>/.git/worktrees/<id>/index.lock 이다.
    // 삭제는 하지 않지만(모듈 상단 근거), **어디가 막혔는지**는 알려줘야 하므로 실패 경로에서
    // rev-parse --git-path index.lock 으로 실제 경로를 해소한다.
    const root = mkdtempSync(join(tmpdir(), 'fleet-ws-lock-'))
    const lock = join(root, 'index.lock')
    writeFileSync(lock, '') // 실존해야 힌트가 붙는다
    try {
      const g = fakeGit()
      let lockProbed = false
      g.setReply((args) => {
        if (args[0] === 'rev-parse' && args.includes('--git-path')) {
          lockProbed = true
          return { code: 0, stdout: lock, stderr: '' }
        }
        // 모든 회차를 락 에러로 소진시킨다.
        return {
          code: 128,
          stdout: '',
          stderr: "fatal: Unable to create '" + lock + "': File exists.",
        }
      })
      const ws = createWorkspace(root, g.runner)
      await expect(ws.checkpoint()).rejects.toThrow(/락 파일이 남아 있다/)
      expect(lockProbed).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * **회귀 가드**(PR#282 · Codex 2R P1 + CodeRabbit): 예전 `ok()` 는 2회차부터 `index.lock` 을
   * 강제 삭제했다. 그 근거였던 「오케스트레이터 순차 실행」 전제는 ttyd 가 `/workspace` 를 공유하는
   * 출하 형상에서 거짓이고, 살아있는 락을 지우면 staged 상태가 유실된다. **외부 락은 보존**한다.
   */
  it('락으로 소진해도 외부 index.lock 을 삭제하지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-ws-lock-keep-'))
    const lock = join(root, 'index.lock')
    writeFileSync(lock, 'foreign')
    try {
      const g = fakeGit()
      g.setReply((args) => {
        if (args[0] === 'rev-parse' && args.includes('--git-path'))
          return { code: 0, stdout: lock, stderr: '' }
        return { code: 128, stdout: '', stderr: 'fatal: Another git process seems to be running' }
      })
      const ws = createWorkspace(root, g.runner)
      await expect(ws.checkpoint()).rejects.toThrow('git')
      expect(existsSync(lock)).toBe(true)
      expect(readFileSync(lock).toString()).toBe('foreign')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

describe('createWorkspace ignored baseline methods', () => {
  it('captures, detects, and restores ignored changes on a real temp workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-ws-ign-'))
    try {
      writeFileSync(join(root, '.env'), 'A=1')
      // fakeGit: status --ignored 만 캔드 응답, 그 외 0.
      const g = fakeGit()
      g.setReply((args) => {
        if (args[0] === 'status' && args.includes('--ignored'))
          return { code: 0, stdout: '!! .env\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      })
      const ws = createWorkspace(root, g.runner)
      const baseline = await ws.captureIgnoredBaseline()
      expect(baseline.entries.get('.env')?.sensitive).toBe(true)

      writeFileSync(join(root, '.env'), 'A=2')
      const cs = await ws.collectIgnoredChanges(baseline)
      expect(cs.changes).toContainEqual({ path: '.env', change: 'modified', sensitive: true })

      await ws.restoreIgnoredBaseline(baseline)
      expect(readFileSync(join(root, '.env')).toString()).toBe('A=1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

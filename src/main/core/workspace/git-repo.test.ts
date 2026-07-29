import { execFile, execFileSync, type ExecFileException } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { createGitRepo, type GitResult, type GitRunner } from './git'

/**
 * T2 — `GitRepo` 도입 2메서드(#251 PR1 · 스펙 §W-6 · 계약 테스트 §3-T5·§3-T6).
 *
 * 코디네이션 영역(§W-2)은 `<canonical common gitdir>/fleet/` 이다. 그 «canonical common gitdir» 를
 * **어떤 git 형태에서도 같은 값으로** 해소하는 것이 이 표면의 유일한 책임이다 — 형태마다 다른 값이 나오면
 * 같은 레포를 보는 두 인스턴스가 **서로 다른 영역**을 쓰게 되어 배타·권위 계층 전체가 무의미해진다.
 *
 * ⚠ `ok()` **미사용**(계획 G-1 · §3-T58): `ok()` 는 index.lock 을 강제 삭제하는 레거시 헬퍼이고 그 안전
 * 근거("오케스트레이터는 순차 실행")가 bench 병렬에서 성립하지 않는다. 신규 연산은 `run` 직접 호출만 쓴다.
 */

/**
 * 실 git 스폰 다수 — vitest 기본 `testTimeout` 은 **5,000ms** 이고 이 레포엔 `testTimeout` 설정이 없다.
 * 유휴 실측(최대 단일 연산 `submodule add` 812ms)은 넉넉하지만, 전체 스위트 병렬 실행(win32)에서는
 * 프로세스 스폰 경합으로 5s 를 넘겨 실제로 RED 가 났다(실측). 파일 단위로 상한을 올려 그 flake 를 닫는다.
 */
vi.setConfig({ testTimeout: 30_000 })

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** 실 git 픽스처: 커밋 1개짜리 레포를 만든다(identity 미설정 머신에서도 동작하도록 -c 주입). */
/** `commit` 은 `worktree add HEAD` 를 쓰는 픽스처에만 필요하다 — 불필요한 스폰을 만들지 않는다. */
const initRepo = (dir: string, commit = true): string => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '.')
  if (!commit) return dir
  git(
    dir,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  )
  return dir
}

/**
 * 실 git 을 직접 실행하는 테스트 러너.
 *
 * `defaultGitRunner` → `defaultRunner` 는 **win32 + custom cwd** 에서 매 호출마다 PATH-only 해석을 하고
 * 그 상한이 `RESOLVE_TIMEOUT_MS = 2000`(캐시 없음 · `cli/detect.ts:234`)이다 — #158 의 cwd-셰도 하드닝
 * 경로다. 전체 스위트 병렬 실행(win32)에서 이 해석 상한(**10s** · `cli/detect.ts:261`)이 초과되면 `{code: null, stderr: ''}` 로 떨어져
 * **여기 테스트들이 산발적으로 RED** 가 된다(실측 재현). 이 파일의 대상은 git 인자 구성·출력 파싱이지
 * 그 하드닝이 아니므로 러너를 주입해 우회한다. **미주입(=defaultGitRunner) 경로는 전용 테스트 1건이 지킨다.**
 */
const execRunner: GitRunner = {
  run: (args: string[], cwd: string): Promise<GitResult> =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
        (err: ExecFileException | null, stdout: string, stderr: string) => {
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
        },
      )
    }),
}

const mkTmp = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'fleet-251-repo-')))

describe('T2/§3-T5 — 코디네이션 영역 정준화: 5형태에서 동일 영역(실 git)', () => {
  // 형태별 픽스처는 **읽기 전용**이라 describe 당 1회만 만든다 — 실 git 스폰을 줄이는 것이 목적이다
  // (전체 스위트 병렬 부하가 올라가면 기존 테스트까지 산발 RED 로 밀린다 — master 대조 실측).
  let base = ''
  let main = ''
  let linked = ''
  beforeAll(() => {
    base = mkTmp()
    main = initRepo(join(base, 'main'))
    linked = join(base, 'linked')
    git(main, 'worktree', 'add', '-q', '--detach', linked, 'HEAD')
  })

  it('메인 worktree · linked worktree 가 같은 common gitdir 로 수렴한다', async () => {
    const fromMain = await createGitRepo(main, execRunner).commonGitDir()
    const fromLinked = await createGitRepo(linked, execRunner).commonGitDir()

    expect(fromMain.status).toBe('ok')
    expect(fromLinked.status).toBe('ok')
    // linked worktree 는 자기 admin 디렉터리(<main>/.git/worktrees/linked)를 갖지만 **common** 은 메인의 .git 이다.
    // 여기서 갈리면 bench 마다 다른 영역이 생겨 배타가 무너진다.
    expect(fromLinked).toEqual(fromMain)
    expect(fromMain.status === 'ok' && fromMain.path).toBe(join(main, '.git'))
  })

  it('bare 레포는 자기 디렉터리가 common gitdir 이다', async () => {
    const bare = join(base, 'bare.git')
    git(base, 'init', '-q', '--bare', 'bare.git')

    const r = await createGitRepo(bare, execRunner).commonGitDir()
    expect(r.status).toBe('ok')
    expect(r.status === 'ok' && r.path).toBe(bare)
    expect(r.status === 'ok' && r.bare).toBe(true)
  })

  it('separate-git-dir 레포는 워크트리가 아니라 실제 gitdir 을 가리킨다', async () => {
    const work = join(base, 'work')
    const gitDir = join(base, 'sep-gitdir')
    git(base, 'init', '-q', `--separate-git-dir=${gitDir}`, 'work')
    git(
      work,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    )

    const r = await createGitRepo(work, execRunner).commonGitDir()
    expect(r.status).toBe('ok')
    // 워크트리 안의 `.git` 은 **파일**(gitdir 포인터)이다 — 그 파일 경로를 영역 루트로 쓰면 mkdir 이 실패한다.
    expect(r.status === 'ok' && r.path).toBe(gitDir)
  })

  it('서브모듈은 상위 레포의 modules/<name> 을 가리킨다(상위와 영역이 분리된다)', async () => {
    const sub = initRepo(join(base, 'subsrc'))
    const super_ = initRepo(join(base, 'super'), false)
    git(
      super_,
      '-c',
      'protocol.file.allow=always',
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'submodule',
      'add',
      '-q',
      sub,
      'sub',
    )

    const inSub = await createGitRepo(join(super_, 'sub'), execRunner).commonGitDir()
    const inSuper = await createGitRepo(super_, execRunner).commonGitDir()
    expect(inSub.status).toBe('ok')
    expect(inSub.status === 'ok' && inSub.path).toBe(join(super_, '.git', 'modules', 'sub'))
    // 앵커: 서브모듈과 상위가 **다른** 영역을 갖는다(같아지면 서로의 bench 를 침범한다).
    expect(inSub).not.toEqual(inSuper)
  })

  it('git 레포가 아니면 fail-closed(경로를 지어내지 않는다)', async () => {
    const r = await createGitRepo(base, execRunner).commonGitDir() // base 자체는 레포가 아니다
    expect(r.status).toBe('failed')
    expect(r.status === 'failed' && r.stderr).toMatch(/not a git repository|repository/i)
  })
})

describe('T2/§3-T6 — `--path-format=absolute` 부재 시 상대 `.git` 오판 회귀 가드', () => {
  /** 상대 경로를 돌려주는 구형 git(<2.31) 을 흉내 내는 러너. 실행 인자도 함께 포착한다. */
  const relativeRunner = (
    out: string,
    seen: string[][] = [],
  ): GitRunner & { seen: string[][] } => ({
    seen,
    run: (args: string[]): Promise<GitResult> => {
      seen.push(args)
      return Promise.resolve({ code: 0, stdout: `${out}\n`, stderr: '' })
    },
  })

  it('상대 출력(`.git`)은 **레포 root** 기준으로 해소된다 — process.cwd() 가 아니다', async () => {
    // 이 테스트의 존재 이유: vitest 의 process.cwd() 는 Fleet 레포 루트다. 구현이 `resolve(stdout)` 이나
    // `resolve(process.cwd(), stdout)` 이면 **Fleet 자신의 .git** 을 영역으로 잡는다 — 정상 상태를 broken
    // 으로 오판하는 정도가 아니라, 남의 레포에 코디네이션 영역을 만든다.
    const root = join(mkTmp(), 'some-repo')
    const r = await createGitRepo(root, relativeRunner('.git\nfalse')).commonGitDir()

    expect(r.status).toBe('ok')
    expect(r.status === 'ok' && r.path).toBe(join(root, '.git'))
    expect(r.status === 'ok' && isAbsolute(r.path)).toBe(true)
    expect(r.status === 'ok' && r.path).not.toBe(resolve(process.cwd(), '.git'))
  })

  it('bare 의 상대 출력(`.`)도 root 로 해소된다', async () => {
    const root = mkTmp()
    const r = await createGitRepo(root, relativeRunner('.\ntrue')).commonGitDir()
    expect(r.status === 'ok' && r.path).toBe(root)
  })

  it('명령에 `--path-format=absolute` 를 실제로 싣는다(구형 git 의존 제거)', async () => {
    const runner = relativeRunner('.git\nfalse')
    await createGitRepo(mkTmp(), runner).commonGitDir()
    expect(runner.seen[0]).toContain('--path-format=absolute')
    expect(runner.seen[0]).toContain('--git-common-dir')
  })

  /**
   * **git <2.31 은 미지 옵션을 stdout 으로 에코하고 exit 0 한다**(실측: `git rev-parse
   * --totally-unknown-flag` → stdout `--totally-unknown-flag`, exit 0). 따라서 `--path-format=absolute`
   * 를 모르는 git 에서는 첫 줄이 **옵션 문자열**이 되어, 그대로 해소하면 코디네이션 영역을
   * `<root>/--path-format=absolute/fleet` 같은 **엉뚱한 경로**에 만든다.
   *
   * 폴백하지 않고 **fail-closed** 한다(스펙의 「폴백 경로 부재」 원칙) — 구버전 git 은 이 기능을 못 쓴다는
   * 것이 계약이고, 조용히 다른 경로에서 도는 것보다 안 도는 편이 안전하다.
   */
  it('미지 옵션 에코(git <2.31)를 경로로 오인하지 않는다 — fail-closed', async () => {
    const r = await createGitRepo(
      mkTmp(),
      relativeRunner('--path-format=absolute\n.git\nfalse'),
    ).commonGitDir()
    expect(r.status).toBe('failed')
    expect(r.status === 'failed' && r.stderr).toMatch(/2\.31|예상 형식/)
  })

  it('두 번째 줄이 true/false 가 아니면 출력 형식 위반으로 거부한다', async () => {
    const r = await createGitRepo(mkTmp(), relativeRunner('.git')).commonGitDir()
    expect(r.status).toBe('failed')
  })

  it('빈 출력은 성공으로 취급하지 않는다(빈 문자열 → root 로 해소되는 조용한 오답 차단)', async () => {
    const r = await createGitRepo(mkTmp(), relativeRunner('')).commonGitDir()
    expect(r.status).toBe('failed')
  })
})

describe('T2 — listWorktrees(실 git · porcelain 파싱)', () => {
  let base = ''
  let main = ''
  let linked = ''
  beforeAll(() => {
    base = mkTmp()
    main = initRepo(join(base, 'main'))
    linked = join(base, 'wt-detached')
    git(main, 'worktree', 'add', '-q', '--detach', linked, 'HEAD')
  })

  it('메인 + linked 를 모두 열거하고 detached/branch 를 구분한다', async () => {
    const r = await createGitRepo(main, execRunner).listWorktrees()
    expect(r.status).toBe('ok')
    const list = r.status === 'ok' ? r.worktrees : []
    expect(list).toHaveLength(2)
    expect(list[0]?.path).toBe(main)
    expect(list[0]?.branch).toMatch(/^refs\/heads\//)
    expect(list[0]?.detached).toBe(false)
    expect(list[1]?.path).toBe(linked)
    expect(list[1]?.detached).toBe(true)
    expect(list[1]?.branch).toBeUndefined()
  })

  it('경로에 공백이 있어도 잘리지 않는다(porcelain 은 첫 공백 이후 전부가 값)', async () => {
    const spaced = join(base, 'work tree with spaces')
    git(main, 'worktree', 'add', '-q', '--detach', spaced, 'HEAD')

    const r = await createGitRepo(main, execRunner).listWorktrees()
    const paths = r.status === 'ok' ? r.worktrees.map((w) => w.path) : []
    expect(paths).toContain(spaced)
  })

  it('prunable(디렉터리 소실) worktree 를 표시한다 — 자동 삭제는 하지 않는다', async () => {
    const gone = join(base, 'gone')
    git(main, 'worktree', 'add', '-q', '--detach', gone, 'HEAD')
    // 디렉터리만 없애면 admin 레코드는 남아 prunable 로 보고된다.
    execFileSync(
      process.platform === 'win32' ? 'cmd' : 'rm',
      process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', gone] : ['-rf', gone],
    )

    const r = await createGitRepo(main, execRunner).listWorktrees()
    const entry = r.status === 'ok' ? r.worktrees.find((w) => w.path === gone) : undefined
    expect(entry?.prunable).toBe(true)
  })

  it('레포가 아니면 fail-closed(빈 배열로 위장하지 않는다)', async () => {
    const r = await createGitRepo(base, execRunner).listWorktrees() // base 자체는 레포가 아니다
    expect(r.status).toBe('failed')
  })

  /**
   * **특성화(characterization)** — 착수 전 감사에서 실 git 으로 재현한 비자명 동작을 고정한다.
   * `worktree list --porcelain` 의 **메인 엔트리 경로**는 separate-git-dir·서브모듈 형태에서
   * **워크트리가 아니라 gitdir** 이다. 이 사실을 모른 채 메인 엔트리 경로를 「레포 작업 디렉터리」로
   * 쓰면 bench 격리·경로 유도가 조용히 엉뚱한 곳을 가리킨다.
   *
   * PR1 에는 이 값의 소비자가 없어 **교정하지 않고 고정만** 한다(교정하려면 형태별 추가 git 호출이
   * 필요하고, 그 비용은 소비자가 생기는 PR 에서 판단한다). 소비자가 생기면 이 테스트가 계약을 알려준다.
   */
  it('메인 엔트리 경로는 separate-git-dir 에서 gitdir 을 가리킨다(신뢰 금지 · 특성화)', async () => {
    const work = join(base, 'wt-sep-work')
    const gitDir = join(base, 'wt-sep-gitdir')
    git(base, 'init', '-q', `--separate-git-dir=${gitDir}`, 'wt-sep-work')
    git(
      work,
      '-c',
      'user.email=a@b',
      '-c',
      'user.name=a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i',
    )

    const r = await createGitRepo(work, execRunner).listWorktrees()
    const first = r.status === 'ok' ? r.worktrees[0] : undefined
    expect(first?.path).toBe(gitDir) // ← 워크트리(work)가 아니다
    expect(first?.path).not.toBe(work)
  })

  it('bare 엔트리에는 HEAD·branch 행이 아예 없다(파서가 undefined 로 답한다 · 특성화)', async () => {
    git(base, 'init', '-q', '--bare', 'bare.git')
    const r = await createGitRepo(join(base, 'bare.git'), execRunner).listWorktrees()
    const first = r.status === 'ok' ? r.worktrees[0] : undefined
    expect(first?.bare).toBe(true)
    expect(first?.head).toBeUndefined()
    expect(first?.branch).toBeUndefined()
    expect(first?.detached).toBe(false)
  })

  it('bare 레포도 자기 자신을 bare 항목으로 보고한다', async () => {
    const base = mkTmp()
    git(base, 'init', '-q', '--bare', 'bare.git')
    const r = await createGitRepo(join(base, 'bare.git'), execRunner).listWorktrees()
    expect(r.status).toBe('ok')
    expect(r.status === 'ok' && r.worktrees[0]?.bare).toBe(true)
  })
})

describe('T2 — 무회귀: 기존 git.ts 표면 불변(계획 §5-1)', () => {
  it('`GitRepo` 도입이 기존 export 를 바꾸지 않는다 — 신규는 **추가만**(계획 §5-1)', async () => {
    const mod = await import('./git')
    const keys = Object.keys(mod).sort()
    // 기존 3(값 기준 — 타입 5 는 런타임에 없다)이 **그대로 살아 있어야** 한다.
    for (const legacy of ['createGitRunner', 'createWorkspace', 'defaultGitRunner']) {
      expect(keys).toContain(legacy)
    }
    // 전체 집합도 exact 로 고정한다 — 신규 추가는 **이 목록을 함께 고치는 변경**이어야 한다
    // (PR3 이 `REF_LOCK_BACKOFF_MS` 를 더할 때 실제로 이 행이 RED 로 잡았다).
    expect(keys).toEqual(
      [
        'REF_LOCK_BACKOFF_MS',
        'createGitRepo',
        'createGitRunner',
        'createWorkspace',
        'defaultGitRunner',
      ].sort(),
    )
  })

  it('createGitRepo 는 러너 미주입 시 defaultGitRunner 를 쓴다(주입 seam 무회귀)', async () => {
    const base = mkTmp()
    const main = initRepo(join(base, 'main'), false)
    writeFileSync(join(main, 'x.txt'), 'x')
    const r = await createGitRepo(main).commonGitDir()
    expect(r.status).toBe('ok')
  })
})

import { execFile, execFileSync, type ExecFileException } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createGitRepo, type GitRepo, type GitResult, type GitRunner } from '../workspace/git'
import type { CoordinationArea } from './coord-area'
import {
  AREA_DIR_NAME,
  AREA_RECORD_FILE,
  AREA_SCHEMA_VERSION,
  endpointDigest,
  openCoordinationArea,
  SUPPORTED_LOCK_BACKENDS,
} from './coord-area'
import { newUlid } from './ulid'

/**
 * T2 — 코디네이션 영역(#251 PR1 · 스펙 §W-2 · 계약 테스트 §3-T5·T54·T56).
 *
 * 영역은 `<canonical common gitdir>/fleet/` 이다. 같은 레포를 보는 모든 인스턴스가 **같은 디렉터리**로
 * 수렴해야 배타·권위 계층이 의미를 갖는다.
 *
 * ⚠ **축소 후 영역 트리**(2026-07-23 서버 단일 표면 · 스펙 §W-3 이 §W-2 트리 문안에 우선):
 *   `area.json` · `active-instance.json`(T5) · `authority/`·`activity/`·`journal/`·`tmp/`(PR2+).
 *   **`locks/`·`owner/` 는 만들지 않는다** — 락 endpoint 는 커널 네임스페이스에 있고(§W-3), 락마다
 *   디스크 레코드를 쓰면 L-6 의 「디스크 I/O 0」과 §3-T10 의 「락 소유 권위 레코드 부재」가 함께 깨진다.
 */

/** 실 git 스폰 다수 — 병렬 스위트에서 기본 5,000ms 를 넘겨 RED 가 났다(실측). git-repo.test.ts 와 동형. */
vi.setConfig({ testTimeout: 30_000 })

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/**
 * 실 git 을 직접 실행하는 테스트 러너.
 *
 * `defaultGitRunner` → `defaultRunner` 는 **win32 + custom cwd** 에서 매 호출마다 PATH-only 해석을 하고
 * 그 상한이 `RESOLVE_TIMEOUT_MS = 2000`(캐시 없음 · `cli/detect.ts:234`)이다 — #158 의 cwd-셰도 하드닝
 * 경로다. 전체 스위트 병렬 실행(win32)에서 이 2초 해석이 초과되면 `{code: null, stderr: ''}` 로 떨어져
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

const mkTmp = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'fleet-251-area-')))

/** `commit` 은 `worktree add HEAD` 를 쓰는 픽스처에만 필요하다 — 불필요한 스폰을 만들지 않는다. */
const initRepo = (dir: string, commit = true): string => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '.')
  if (!commit) return dir
  git(dir, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i')
  return dir
}

/** 열림을 단언하며 좁힌다 — 실패 시 `''` 를 역참조해 `ENOENT: scandir ''` 로 번지는 대신 사유를 보여준다. */
const expectOpen = (r: Awaited<ReturnType<typeof openCoordinationArea>>): CoordinationArea => {
  if (r.status !== 'open') throw new Error(`영역이 열리지 않음: ${r.reason} — ${r.detail}`)
  return r.area
}

/**
 * git 을 스폰하지 않는 레포 더블 — **영역 로직은 파일시스템 계약**이라 대부분의 행에 실 git 이 필요 없다.
 * 실 git 은 「5형태 수렴」(§3-T5)과 「git 위생 후 생존」(§3-T54)에만 남긴다. 이 절제는 취향이 아니라
 * 실측 대응이다: 실 git 스폰을 무제한 늘리면 전체 스위트 병렬 부하가 올라가 **기존 테스트**
 * (`cli/detect.test.ts` 의 2초 PATH 해석 경로)까지 산발 RED 로 밀어낸다(master 대조 실측: master 전량
 * GREEN ↔ 초기 이 브랜치에서 1건 RED).
 */
const fakeRepo = (gitDir: string, bare = false): GitRepo => ({
  commonGitDir: () => Promise.resolve({ status: 'ok' as const, path: gitDir, bare }),
  listWorktrees: () => Promise.resolve({ status: 'ok' as const, worktrees: [] }),
})

/** 실 레포 없이 「common gitdir 자리」만 만든다(영역의 부모 디렉터리). */
const fakeGitDir = (): string => {
  const d = join(mkTmp(), '.git')
  mkdirSync(d, { recursive: true })
  return d
}

/** 실행 표면이 Linux 라고 가정하지 않기 위한 주입값 — 어느 OS 에서도 양 분기를 검사할 수 있게 한다. */
const linuxLike = { supportedBackends: SUPPORTED_LOCK_BACKENDS, instanceId: newUlid() }

/**
 * 실 git 은 **영역 층 고유 성질**에만 쓴다. 형태별(bare·separate-git-dir·서브모듈) 수렴은
 * `workspace/git-repo.test.ts` 가 `commonGitDir()` 로 5형태 전수 검증하고, 영역 루트는 그 값의
 * 순수 파생(`join(commonGitDir, 'fleet')`)이라 여기서 형태를 반복하면 실 git 스폰만 늘어난다
 * (실측: 스위트 병렬 부하가 오르면 타이밍 민감한 기존 렌더러 테스트까지 산발 RED).
 */
describe('T2/§3-T5 — 같은 레포의 두 worktree 가 같은 영역으로 수렴(실 git)', () => {
  it('메인 worktree 와 linked worktree 가 같은 영역 루트를 연다', async () => {
    const base = mkTmp()
    const main = initRepo(join(base, 'main'))
    const linked = join(base, 'linked')
    git(main, 'worktree', 'add', '-q', '--detach', linked, 'HEAD')

    const a = await openCoordinationArea({ repo: createGitRepo(main, execRunner), ...linuxLike })
    const b = await openCoordinationArea({ repo: createGitRepo(linked), ...linuxLike })

    expect(a.status).toBe('open')
    expect(b.status).toBe('open')
    expect(expectOpen(a).root).toBe(join(main, '.git', AREA_DIR_NAME))
    expect(expectOpen(b).root).toBe(expectOpen(a).root)
  })

  it('git 레포가 아니면 열지 않는다(경로를 지어내지 않는다)', async () => {
    const r = await openCoordinationArea({ repo: createGitRepo(mkTmp(), execRunner), ...linuxLike })
    expect(r.status).toBe('disabled')
    expect(r.status === 'disabled' && r.reason).toBe('not-a-repo')
  })
})

describe('T2 — 정준화: git 원문이 아니라 realpath 정준값으로 유도한다', () => {
  it('win32 슬래시/역슬래시 혼용이 영역 경로에 새지 않는다(경로 구분자 정규화)', async () => {
    const base = mkTmp()
    const main = initRepo(join(base, 'main'), false)
    const r = await openCoordinationArea({ repo: createGitRepo(main, execRunner), ...linuxLike })
    // git stdout 은 win32 에서 `C:/…` 슬래시 경로를 준다. 영역 경로가 그 원문을 그대로 물고 있으면
    // realpath 기반 값(`C:\…`)과 문자열 대조가 어긋나 이후 신원 검증이 항상 실패한다.
    expect(expectOpen(r).root).toBe(join(main, '.git', AREA_DIR_NAME))
    expect(expectOpen(r).commonGitDir).toBe(realpathSync.native(join(main, '.git')))
  })

  // 이식 가능한 반증: 정준화(realpath)를 빼면 이 행이 GREEN 이 된다. 위 symlink 행은 POSIX 전용이라
  // win32 로컬 verify 에서 skip 되므로, 정준화 제거가 **어느 OS 에서도** 붉어지도록 이 행을 함께 둔다.
  // (실제로 이 행이 없을 때 「realpath → dir.path」 변이가 전 게이트 무신호였다 — 실측.)
  it('git 이 말한 common gitdir 이 실재하지 않으면 io-failure — 없는 경로에 영역을 만들지 않는다', async () => {
    const ghost = join(mkTmp(), 'no-such-dir', '.git')
    const r = await openCoordinationArea({
      repo: {
        commonGitDir: () => Promise.resolve({ status: 'ok' as const, path: ghost, bare: false }),
        listWorktrees: () => Promise.resolve({ status: 'ok' as const, worktrees: [] }),
      },
      ...linuxLike,
    })
    expect(r.status).toBe('disabled')
    expect(r.status === 'disabled' && r.reason).toBe('io-failure')
    expect(statSync(join(ghost, AREA_DIR_NAME), { throwIfNoEntry: false })).toBeUndefined()
  })

  it.runIf(process.platform !== 'win32')(
    'symlink 경유로 열어도 영역은 **실제 경로** 아래에 하나만 생긴다(POSIX)',
    async () => {
      const base = mkTmp()
      const main = initRepo(join(base, 'main'), false)
      const alias = join(base, 'alias')
      symlinkSync(main, alias, 'dir')

      const direct = await openCoordinationArea({
        repo: createGitRepo(main, execRunner),
        ...linuxLike,
      })
      const viaLink = await openCoordinationArea({
        repo: createGitRepo(alias, execRunner),
        ...linuxLike,
      })

      // 반증력: realpath 정준화를 빼면 `<alias>/.git/fleet` 과 `<main>/.git/fleet` 이 **서로 다른 문자열**이
      // 되어 같은 레포에 두 영역이 생긴 것처럼 보인다 — 배타 계층 전체가 무의미해지는 경로다.
      expect(expectOpen(viaLink).root).toBe(expectOpen(direct).root)
      expect(expectOpen(viaLink).root.startsWith(main)).toBe(true)
    },
  )

  it('같은 레포의 두 번째 열기는 기존 영역·기록을 재사용한다(재생성 없음)', async () => {
    const gitDir = fakeGitDir()
    const first = await openCoordinationArea({ repo: fakeRepo(gitDir), ...linuxLike })
    const recordPath = join(expectOpen(first).root, AREA_RECORD_FILE)
    const before = readFileSync(recordPath, 'utf8')

    const second = await openCoordinationArea({
      repo: fakeRepo(gitDir),
      supportedBackends: SUPPORTED_LOCK_BACKENDS,
      instanceId: newUlid(), // 다른 인스턴스가 열어도
    })
    expect(second.status).toBe('open')
    expect(readFileSync(recordPath, 'utf8')).toBe(before) // 기록은 생성자 신원 그대로
  })
})

describe('T2 — 영역 트리(축소 반영): 만드는 것과 만들지 않는 것', () => {
  it('영역 루트와 area.json 만 만든다 — locks/·owner/ 는 만들지 않는다', async () => {
    const r = await openCoordinationArea({ repo: fakeRepo(fakeGitDir()), ...linuxLike })
    const root = expectOpen(r).root
    // 반증력: 축소 전 모델(락마다 `locks/<key>.json` 기록)을 되살린 구현이면 이 단언이 RED 다.
    expect(readdirSync(root).sort()).toEqual([AREA_RECORD_FILE])
  })

  it('area.json 은 스키마 버전·백엔드·생성 신원을 담는다', async () => {
    const instanceId = newUlid()
    const r = await openCoordinationArea({
      repo: fakeRepo(fakeGitDir()),
      supportedBackends: SUPPORTED_LOCK_BACKENDS,
      instanceId,
    })
    const root = expectOpen(r).root
    const rec = JSON.parse(readFileSync(join(root, AREA_RECORD_FILE), 'utf8')) as Record<
      string,
      unknown
    >
    expect(rec).toMatchObject({
      schemaVersion: AREA_SCHEMA_VERSION,
      lockBackend: 'uds-abstract',
      createdBy: instanceId,
    })
    expect(typeof rec.createdAt).toBe('number')
  })

  it.runIf(process.platform !== 'win32')(
    '영역 루트는 0700 이고 소유자가 자신이다(POSIX)',
    async () => {
      const r = await openCoordinationArea({ repo: fakeRepo(fakeGitDir()), ...linuxLike })
      const st = statSync(expectOpen(r).root)
      expect(st.mode & 0o777).toBe(0o700)
      expect(st.uid).toBe(process.getuid?.())
    },
  )
})

describe('T2/§3-T56 — 전방호환 fail-closed(L-4): 미지 백엔드·미지 스키마는 어떤 획득도 시도하지 않는다', () => {
  const seedArea = (gitDir: string, record: Record<string, unknown>): string => {
    const root = join(gitDir, AREA_DIR_NAME)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileSync(join(root, AREA_RECORD_FILE), JSON.stringify(record))
    return root
  }

  it('미지 lockBackend = disabled(unsupported-backend) — 레코드를 덮어쓰지 않는다', async () => {
    const gitDir = fakeGitDir()
    const root = seedArea(gitDir, {
      schemaVersion: AREA_SCHEMA_VERSION,
      lockBackend: 'npipe',
      createdAt: 1,
      createdBy: newUlid(),
    })
    const before = readFileSync(join(root, AREA_RECORD_FILE), 'utf8')

    const r = await openCoordinationArea({ repo: fakeRepo(gitDir), ...linuxLike })
    expect(r.status).toBe('disabled')
    expect(r.status === 'disabled' && r.reason).toBe('unsupported-backend')
    // 구 버전이 신 버전의 영역을 재초기화하면 두 인스턴스가 서로 다른 백엔드로 갈라진다.
    expect(readFileSync(join(root, AREA_RECORD_FILE), 'utf8')).toBe(before)
  })

  it('지원 범위 초과 schemaVersion = disabled(incompatible-version) — 삭제·마이그레이션 금지', async () => {
    const gitDir = fakeGitDir()
    const root = seedArea(gitDir, {
      schemaVersion: AREA_SCHEMA_VERSION + 1,
      lockBackend: 'uds-abstract',
      createdAt: 1,
      createdBy: newUlid(),
    })
    const r = await openCoordinationArea({ repo: fakeRepo(gitDir), ...linuxLike })
    expect(r.status === 'disabled' && r.reason).toBe('incompatible-version')
    expect(readdirSync(root)).toContain(AREA_RECORD_FILE)
  })

  it('손상된 area.json = disabled(reconciliation-required) — 자동 삭제 금지', async () => {
    const gitDir = fakeGitDir()
    const root = seedArea(gitDir, {})
    writeFileSync(join(root, AREA_RECORD_FILE), '{ not json')
    const r = await openCoordinationArea({ repo: fakeRepo(gitDir), ...linuxLike })
    expect(r.status === 'disabled' && r.reason).toBe('reconciliation-required')
    expect(readFileSync(join(root, AREA_RECORD_FILE), 'utf8')).toBe('{ not json')
  })

  it('이 플랫폼이 기록된 백엔드를 지원하지 않으면 fail-closed(win32 데스크톱 = 비활성)', async () => {
    const r = await openCoordinationArea({
      repo: fakeRepo(fakeGitDir()),
      supportedBackends: [], // 추상 소켓 미지원 플랫폼(win32·macOS)
      instanceId: newUlid(),
    })
    expect(r.status === 'disabled' && r.reason).toBe('platform-unsupported')
  })
})

/**
 * PR1 착수 전 배포 실측(컨테이너 재현)이 낳은 계약 — 계획 §2 는 「PR1 선행 실측 0」이라 했으나 실측상
 * **두 실패 모드가 PR1 에서 이미 도달 가능**하다:
 *   ① `git config --system safe.directory` 는 **정확 경로 일치**라 `/workspace` 등재가 하위 레포
 *      `/workspace/proj-a` 를 커버하지 않는다 → `fatal: detected dubious ownership` (실측 재현)
 *   ② git 이 성공해도 `.git` 소유자가 다르면 `mkdir .git/fleet` 이 **EACCES** 다 — 즉
 *      「git 성공 ⇒ 영역 생성 가능」은 **거짓**이다(실측 재현: safe.directory 정확 일치인데도 실패)
 * 둘 다 조용한 폴백 없이 사유를 구분해 보고한다(운영자가 고칠 대상이 서로 다르다 — 전자는
 * `safe.directory` 커버리지, 후자는 볼륨 소유권).
 */
describe('T2 — 배포 실패 모드 분기(실측 근거 · 조용한 폴백 금지)', () => {
  const failingRepo = (stderr: string) => ({
    commonGitDir: () => Promise.resolve({ status: 'failed' as const, stderr, code: 128 }),
    listWorktrees: () => Promise.resolve({ status: 'failed' as const, stderr, code: 128 }),
  })

  it('dubious ownership 은 not-a-repo 와 구분해 보고한다(고칠 대상이 다르다)', async () => {
    const r = await openCoordinationArea({
      repo: failingRepo("fatal: detected dubious ownership in repository at '/workspace/proj-a'"),
      ...linuxLike,
    })
    expect(r.status === 'disabled' && r.reason).toBe('repo-unsafe-ownership')
    // 운영자가 실행할 명령을 찾을 수 있도록 원문을 싣는다.
    expect(r.status === 'disabled' && r.detail).toMatch(/dubious ownership/)
  })

  it('그 외 git 실패는 not-a-repo', async () => {
    const r = await openCoordinationArea({
      repo: failingRepo('fatal: not a git repository (or any of the parent directories): .git'),
      ...linuxLike,
    })
    expect(r.status === 'disabled' && r.reason).toBe('not-a-repo')
  })

  it.runIf(process.platform !== 'win32')(
    '영역 디렉터리 생성이 EACCES 면 io-failure — 성공으로 위장하지 않는다(POSIX)',
    async () => {
      const base = mkTmp()
      const main = initRepo(join(base, 'main'), false)
      const gitDir = realpathSync.native(join(main, '.git'))
      const mode = statSync(gitDir).mode
      chmodSync(gitDir, 0o500) // 읽기·탐색만 — 하위 생성 불가
      try {
        const r = await openCoordinationArea({
          repo: createGitRepo(main, execRunner),
          ...linuxLike,
        })
        expect(r.status === 'disabled' && r.reason).toBe('io-failure')
      } finally {
        chmodSync(gitDir, mode)
      }
    },
  )
})

describe('T2 — 링크 경유 영역 거부(경로 검사 · path-guard 관용구 승계)', () => {
  it.runIf(process.platform !== 'win32')('영역 루트가 symlink 면 열지 않는다(POSIX)', async () => {
    const base = mkTmp()
    const main = initRepo(join(base, 'main'), false)
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(realpathSync.native(join(main, '.git')), AREA_DIR_NAME), 'dir')

    const r = await openCoordinationArea({ repo: createGitRepo(main, execRunner), ...linuxLike })
    expect(r.status === 'disabled' && r.reason).toBe('unsafe-path')
  })

  it('영역 루트 자리에 일반 파일이 있으면 열지 않는다', async () => {
    const gitDir = fakeGitDir()
    writeFileSync(join(gitDir, AREA_DIR_NAME), 'x')
    const r = await openCoordinationArea({ repo: fakeRepo(gitDir), ...linuxLike })
    expect(r.status === 'disabled' && r.reason).toBe('unsafe-path')
  })
})

describe('T2/§3-T54 — git 위생 명령 후 영역 전량 생존(실 git)', () => {
  it('gc·repack·prune·reflog expire·clean -xffd·worktree prune·fsck 후에도 영역이 남는다', async () => {
    const main = initRepo(join(mkTmp(), 'main'))
    const r = await openCoordinationArea({ repo: createGitRepo(main, execRunner), ...linuxLike })
    const root = expectOpen(r).root
    const canary = join(root, 'canary.json')
    writeFileSync(canary, '{"k":1}')

    git(main, 'gc', '--prune=now', '--quiet') // --aggressive 는 압축 깊이일 뿐 생존 신호를 더하지 않는다
    git(main, 'repack', '-ad', '--quiet')
    git(main, 'prune')
    git(main, 'reflog', 'expire', '--expire=now', '--all')
    git(main, 'clean', '-xffd')
    git(main, 'worktree', 'prune')
    git(main, 'fsck', '--no-progress')

    expect(readFileSync(canary, 'utf8')).toBe('{"k":1}')
    expect(readdirSync(root).sort()).toEqual([AREA_RECORD_FILE, 'canary.json'].sort())
    // 영역은 git 이 추적하지 않는다(status 를 더럽히면 사용자 diff·keep 에 섞인다).
    expect(git(main, 'status', '--porcelain')).toBe('')
  }, 60_000)
})

describe('T2 — endpointDigest: 락 이름공간 스코프 분리(§W-3 이름 유도)', () => {
  it('서로 다른 레포는 서로 다른 digest 를 갖는다(추상 소켓은 net ns 전역이라 유일한 스코프 수단)', () => {
    const a = endpointDigest('/repo/a/.git')
    const b = endpointDigest('/repo/b/.git')
    expect(a).not.toBe(b)
  })

  it('같은 정준 경로는 항상 같은 digest(재시작·컨테이너 교체 후 동일 이름)', () => {
    expect(endpointDigest('/workspace/.git')).toBe(endpointDigest('/workspace/.git'))
  })

  it('digest 는 소켓 이름 문법 안전 집합(hex)이고 고정 길이다', () => {
    expect(endpointDigest('/workspace/.git')).toMatch(/^[0-9a-f]{32}$/)
  })
})

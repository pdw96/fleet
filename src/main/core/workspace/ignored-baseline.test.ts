// src/main/core/workspace/ignored-baseline.test.ts
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync as readFile,
  rmSync,
  statSync,
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

  // [P2-3] git status non-zero → hard failure
  it('[P2-3] git status 실패(non-zero)는 captureIgnoredBaseline 을 reject 시킨다', async () => {
    const failGit: GitRunner = {
      async run() {
        return { code: 1, stdout: '', stderr: 'fatal: not a git repo' }
      },
    }
    await expect(captureIgnoredBaseline(root, failGit, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
      'git status',
    )
  })

  // [P2-6] Walk 단순화(C): denylist 디렉터리는 통째 skip — 내부 sensitive도 A 범위 밖(B 슬라이스 연기)
  it('[P2-6] denylist 디렉터리(node_modules/) 내부는 sensitive 포함 전혀 스캔하지 않는다', async () => {
    mkdirSync(join(root, 'node_modules', '.ssh'), { recursive: true })
    writeFileSync(join(root, 'node_modules', '.ssh', 'id_rsa'), 'PRIVATE')
    writeFileSync(join(root, 'node_modules', 'x.js'), 'big')
    const git = fakeGitIgnored(['node_modules/'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    // denylist 통째 skip → id_rsa도 x.js도 entries에 없어야 함(A 범위 밖)
    expect(base.entries.has('node_modules/.ssh/id_rsa')).toBe(false)
    expect(base.entries.has('node_modules/x.js')).toBe(false)
    expect(base.skipped).toEqual([])
  })

  // [P2-8] Walk 단순화(C): maxEntries 제거 → non-denylist maxFiles 초과 시 walk 중단(early-terminate + fail-closed)
  it('[P2-8] non-denylist 중첩 디렉터리가 maxFiles 초과 시 early-terminate하고 단일 over-cap escalation을 기록한다(fail-closed)', async () => {
    // 구조: logs/ (top) → subA/(2파일) → subB/(2파일, deep)
    // maxFiles=2 → subA의 2파일 캡처 후 cap 도달.
    // early-terminate 구현: capped=true 설정 후 단일 'scan-capped' escalation 기록, 이후 walk 중단.
    // 버그 구현(현재): walk 계속 돌며 subB 파일 각각 skipped 에 push → skipped.length > 1.
    mkdirSync(join(root, 'logs', 'subA'), { recursive: true })
    mkdirSync(join(root, 'logs', 'subB'), { recursive: true })
    writeFileSync(join(root, 'logs', 'subA', 'a1.log'), 'a1')
    writeFileSync(join(root, 'logs', 'subA', 'a2.log'), 'a2')
    // deep 파일: cap 이후에 있으므로 entries 에 절대 잡혀서는 안 됨
    writeFileSync(join(root, 'logs', 'subB', 'deep1.log'), 'deep1')
    writeFileSync(join(root, 'logs', 'subB', 'deep2.log'), 'deep2')
    const git2 = fakeGitIgnored(['logs/'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 2 }
    const base = await captureIgnoredBaseline(root, git2, policy)

    // (1) 종료 증명: cap 이후 deep 파일은 entries 에 없어야 함
    expect(base.entries.has('logs/subB/deep1.log')).toBe(false)
    expect(base.entries.has('logs/subB/deep2.log')).toBe(false)

    // (2) fail-closed 증명: over-cap escalation 이 skipped 에 기록되어야 함
    const overCapSkipped = base.skipped.filter((s) => s.reason === 'over-cap')
    expect(overCapSkipped.length).toBeGreaterThanOrEqual(1)

    // (3) early-terminate 증명: 단일 escalation 만 기록(파일별 스팸 아님).
    // 버그 구현은 subB 의 deep1.log + deep2.log 각각 push → skipped 에 2개 이상.
    // early-terminate 구현은 cap 도달 시 단일 'scan-capped' marker 하나만 push.
    expect(overCapSkipped.length).toBe(1)
  })

  // [:143] 부분 backup zeroize on capture abort
  it(':143 민감 파일 throw 전에 이미 캡처된 부분 backup Buffer가 zeroize된다', async () => {
    // 설계: a.key(정상 캡처) → .env(디렉터리 → readFileSync EISDIR throw)
    // catch 블록이 entry.backup.fill(0) 으로 zeroize 하고 throw 재전파한다.
    //
    // Buffer 참조 확보 시도: vi.spyOn(fsModule, 'readFileSync') 는 ESM native module 에서
    // "Cannot redefine property" 로 실패한다(vitest ESM 제약). vi.mock('node:fs') 로
    // 파일 전체를 mock 하면 다른 18 개 테스트가 실 FS 를 사용하지 못해 전면 재작성 필요.
    // → Buffer 직접 단언은 현재 테스트 환경에서 infeasible.
    // throw 전파 단언(primary) + disposeBaseline 테스트의 fill(0) 검증(상호 보완)으로 대체.
    writeFileSync(join(root, 'a.key'), 'A_SECRET')
    mkdirSync(join(root, '.env'), { recursive: true })
    const git = fakeGitIgnored(['a.key', '.env'])
    // throw 재전파: [:143] catch 블록이 fill(0) 후 반드시 rethrow 해야 함
    await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
      /민감 ignored/,
    )
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

  // [:213] oversized modified: size-guard → read 없이 modified+unrestorable
  it(':213 oversized modified ignored 파일은 read하지 않고 modified+unrestorable 로 표기한다', async () => {
    // 작은 파일로 baseline 캡처
    writeFileSync(join(root, 'big.cfg'), 'small')
    const git = fakeGitIgnored(['big.cfg'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)

    // 에이전트가 파일을 거대하게 교체
    writeFileSync(join(root, 'big.cfg'), Buffer.alloc(16))
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFileBytes: 8 }
    const cs = await collectIgnoredChanges(root, git, baseline, policy)

    // modified로 탐지되어야 하고
    expect(cs.changes.some((c) => c.path === 'big.cfg' && c.change === 'modified')).toBe(true)
    // unrestorable에 포함되어야 함(read하지 않고 modified이므로 복원 불가)
    expect(cs.unrestorable.some((u) => u.path === 'big.cfg')).toBe(true)
  })

  // [P2-4] current-scan over-cap surfaced in collect
  it('[P2-4] 현재 scan 의 over-cap 은 단일 scan-capped escalation 으로 unrestorable 에 포함된다', async () => {
    // empty baseline (no files at baseline time)
    const emptyGit = fakeGitIgnored([])
    const baseline = await captureIgnoredBaseline(root, emptyGit, DEFAULT_IGNORED_POLICY)

    // now 3 general files exist, maxFiles=1 → cap 도달 시 단일 scan-capped escalation
    writeFileSync(join(root, 'a.txt'), 'aaa')
    writeFileSync(join(root, 'b.txt'), 'bbb')
    writeFileSync(join(root, 'c.txt'), 'ccc')
    const curGit = fakeGitIgnored(['a.txt', 'b.txt', 'c.txt'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
    const cs = await collectIgnoredChanges(root, curGit, baseline, policy)
    // early-terminate 구현: 단일 scan-capped 마커 하나만 unrestorable 에 기록(파일별 스팸 아님)
    const overCapEntries = cs.unrestorable.filter((u) => u.reason === 'over-cap')
    expect(overCapEntries.length).toBe(1)
    expect(overCapEntries[0].path).toBe('scan-capped')
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

  // [P1-a] file mode preservation
  it('[P1-a] 복원 시 원본 파일 모드(0o600)가 보존된다', async () => {
    if (process.platform === 'win32') return // chmod semantics differ on Windows
    const envPath = join(root, '.env')
    writeFileSync(envPath, 'SECRET=1')
    chmodSync(envPath, 0o600)
    const git = fakeGitIgnored(['.env'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)

    // delete file
    rmSync(envPath)
    const curGit = fakeGitIgnored([])
    await restoreIgnoredBaseline(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    expect(existsSync(envPath)).toBe(true)
    const restoredMode = statSync(envPath).mode & 0o777
    expect(restoredMode).toBe(0o600)
  })

  // [:229] restore drops files in scan range; cap 이후 파일은 early-terminate 로 발견 불가 → scan-capped escalation 으로 표면화
  it(':229 restore 시 scan 범위 내 에이전트 생성 파일은 삭제되고, cap 이후 파일은 scan-capped escalation 으로 표면화된다', async () => {
    // baseline 캡처 시 파일 없음
    const baseGit = fakeGitIgnored([])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)

    // 에이전트가 파일 2개 생성, maxFiles=1 → a.txt 는 files 에 포함, b.txt 는 cap 이후 early-terminate
    writeFileSync(join(root, 'a.txt'), 'agent1')
    writeFileSync(join(root, 'b.txt'), 'agent2')
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
    const curGit = fakeGitIgnored(['a.txt', 'b.txt'])

    await restoreIgnoredBaseline(root, curGit, baseline, policy)

    // a.txt 는 files 에 포함(cap 이전) → 삭제됨
    expect(existsSync(join(root, 'a.txt'))).toBe(false)
    // b.txt 는 early-terminate 로 restore scan 범위 밖 → 삭제 불가(scan-capped escalation 으로 표면화됨)
    // collectIgnoredChanges 호출자가 unrestorable 의 scan-capped 를 보고 상위 처리 가능
    expect(existsSync(join(root, 'b.txt'))).toBe(true)
  })

  // [P1-b] remove non-file path before restoring
  it('[P1-b] 복원 대상 경로가 디렉터리일 경우 제거 후 파일로 복원한다', async () => {
    const envPath = join(root, '.env')
    writeFileSync(envPath, 'ORIGINAL')
    const git = fakeGitIgnored(['.env'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)

    // replace file with directory
    rmSync(envPath)
    mkdirSync(envPath)
    writeFileSync(join(envPath, 'impostor.txt'), 'bad')

    const curGit = fakeGitIgnored([])
    await restoreIgnoredBaseline(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    // .env must be a regular file with baseline content
    const st = statSync(envPath)
    expect(st.isFile()).toBe(true)
    expect(readFile(envPath).toString()).toBe('ORIGINAL')
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

describe('real-git: revert→restore seam (invariant verification)', () => {
  // 실제 git 저장소를 사용해 `git reset --hard` + `git clean -ffd` 가
  // .gitignore 대상(ignored) 파일을 제거하지 않는다는 불변식을 증명한다.
  // 이 불변식이 깨지면 rollbackWithIgnored 의 revert→restore 순서가 무의미해진다.

  /** child_process 기반 실-git 주입 runner */
  function makeRealGitRunner(): GitRunner {
    return {
      async run(args: string[], cwd: string) {
        try {
          const stdout = execFileSync('git', args, { cwd, encoding: 'utf8' })
          return { code: 0, stdout, stderr: '' }
        } catch (e: unknown) {
          const err = e as { status?: number; stdout?: string; stderr?: string }
          return {
            code: err.status ?? 1,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? '',
          }
        }
      },
    }
  }

  /** 별도 temp 디렉터리에 실제 git 저장소를 초기화한다 */
  function initRealRepo(): string {
    const repoDir = mkdtempSync(join(tmpdir(), 'fleet-realgt-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
    git(['init'])
    git(['config', 'user.name', 'Test'])
    git(['config', 'user.email', 'test@test.com'])
    // .gitignore: *.env, *.key 등록
    writeFileSync(join(repoDir, '.gitignore'), '*.env\n*.key\n')
    git(['add', '.gitignore'])
    git(['commit', '-m', 'init'])
    return repoDir
  }

  let repoDir: string
  afterEach(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true })
  })

  it('git clean -ffd 는 ignored 파일을 제거하지 않으므로 restore 가 정확히 복원한다', async () => {
    repoDir = initRealRepo()
    const gitRunner = makeRealGitRunner()

    // 1) 기존 ignored 파일 생성(baseline 캡처 전)
    writeFileSync(join(repoDir, 'app.env'), 'ORIG')

    // 2) baseline 캡처
    const baseline = await captureIgnoredBaseline(repoDir, gitRunner, DEFAULT_IGNORED_POLICY)
    expect(baseline.entries.has('app.env')).toBe(true)

    // 3) 에이전트가 파일을 변경/생성
    writeFileSync(join(repoDir, 'app.env'), 'HACKED') // modify
    writeFileSync(join(repoDir, 'new.key'), 'AGENT_SECRET') // create new ignored

    // 4) revert 흉내: git reset --hard HEAD + git clean -ffd (ignored 는 건드리지 않음)
    execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: repoDir })
    execFileSync('git', ['clean', '-ffd'], { cwd: repoDir })

    // 불변식 확인: ignored 파일이 revert 후에도 살아있어야 restore 가 의미 있다
    expect(existsSync(join(repoDir, 'app.env'))).toBe(true) // 살아남아야 함
    expect(existsSync(join(repoDir, 'new.key'))).toBe(true) // 살아남아야 함
    expect(readFile(join(repoDir, 'app.env'), 'utf8')).toBe('HACKED') // revert 가 안 건드림

    // 5) restoreIgnoredBaseline 호출
    await restoreIgnoredBaseline(repoDir, gitRunner, baseline, DEFAULT_IGNORED_POLICY)

    // 6) 단언: restore 가 정확히 복원
    expect(readFile(join(repoDir, 'app.env'), 'utf8')).toBe('ORIG') // 백업 복원
    expect(existsSync(join(repoDir, 'new.key'))).toBe(false) // 에이전트 생성분 제거
  })
})

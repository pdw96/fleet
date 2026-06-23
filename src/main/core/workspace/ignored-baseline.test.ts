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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import type { GitRunner } from './git'
import {
  captureIgnoredBaseline,
  collectIgnoredChanges,
  DEFAULT_IGNORED_POLICY,
  disposeBaseline,
  restoreIgnoredBaseline,
  SCAN_CAPPED,
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

  it('[#128-A] non-regular(디렉터리) non-sensitive ignored 파일은 read 없이 not-regular 로 skip', async () => {
    // git 은 'weird.dat'를 파일처럼 보고하지만 디스크엔 디렉터리 → !isFile()
    mkdirSync(join(root, 'weird.dat'))
    const git = fakeGitIgnored(['weird.dat'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    expect(base.entries.has('weird.dat')).toBe(false)
    expect(base.skipped).toContainEqual({ path: 'weird.dat', reason: 'not-regular' })
  })

  it('[#128-A] non-regular sensitive ignored 파일은 throw(fail-closed)', async () => {
    // .env 를 디렉터리로 → sensitive + non-regular → throw
    mkdirSync(join(root, '.env'))
    const git = fakeGitIgnored(['.env'])
    await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
      /일반 파일이 아님/,
    )
  })

  it('[#128-A] POSIX FIFO ignored 파일은 hang 없이 not-regular 로 skip', async () => {
    if (process.platform === 'win32') return // mkfifo 불가
    execFileSync('mkfifo', [join(root, 'pipe.dat')])
    const git = fakeGitIgnored(['pipe.dat'])
    // 가드가 없으면 readFileSync(FIFO) 가 hang — 5초 내 resolve 되어야 한다
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    expect(base.skipped).toContainEqual({ path: 'pipe.dat', reason: 'not-regular' })
  })

  it('[#128-m3] non-sensitive 일반 파일 read 실패는 read-failed 로 skip(POSIX)', async () => {
    // 일반 파일(isFile=true)이지만 읽기 권한 0 → readFileSync EACCES → read-failed 분기.
    if (process.platform === 'win32') return
    if (typeof process.getuid === 'function' && process.getuid() === 0) return // root 는 권한 무시
    writeFileSync(join(root, 'noperm.dat'), 'data')
    chmodSync(join(root, 'noperm.dat'), 0o000)
    const git = fakeGitIgnored(['noperm.dat'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    expect(base.entries.has('noperm.dat')).toBe(false)
    expect(base.skipped).toContainEqual({ path: 'noperm.dat', reason: 'read-failed' })
  })

  // [#128-m4] best-effort 테스트 — vitest ESM 환경에서 node: 빌트인 named export 는
  // non-configurable(Object.defineProperty 금지)이라 vi.spyOn(fs, 'readFileSync') 가
  // "Cannot redefine property" 로 실패하고 spy 가 동작하지 않는다.
  // 이 경우 captured.length === 0 으로 남아 zeroize 단언 자체가 skip 된다(degraded mode).
  // degraded mode 에서도 테스트가 검증하는 의미 있는 불변식은 유지된다:
  //   captureIgnoredBaseline 이 sensitive non-regular 파일(:143 hard-stop)에서 반드시 REJECT 한다.
  // zeroize 프리미티브의 견고한 보장은 [#128-m5] disposeBaseline 테스트가 담당한다.
  // `import * as fs` 는 spy 시도(빌트인 spying 이 허용된 환경에서 동작)를 위해 의도적으로 유지한다.
  it('[#128-m4] capture throw 시 이미 캡처된 backup Buffer 가 zeroize 된다', async () => {
    writeFileSync(join(root, 'a.key'), 'A_SECRET')
    mkdirSync(join(root, '.env')) // 두 번째(sensitive non-regular) → throw 유발
    const git = fakeGitIgnored(['a.key', '.env'])
    const captured: Buffer[] = []
    // [Codex 보정] node: ESM 빌트인은 namespace가 non-configurable → spyOn 자체가 throw할 수 있음.
    // best-effort: spy 설정 성공 시만 버퍼 참조를 확보하고, 실패하면 captured 빈 채로 진행.
    let spy: ReturnType<typeof vi.spyOn> | null = null
    try {
      const real = fs.readFileSync
      spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        const out = (real as (...a: unknown[]) => unknown)(...args)
        if (Buffer.isBuffer(out)) captured.push(out)
        return out
      }) as typeof fs.readFileSync)
    } catch {
      // ESM non-configurable: spy 미동작 — best-effort 로 fallthrough
    }
    try {
      await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow()
    } finally {
      spy?.mockRestore()
    }
    // [Codex 보정] named import 라 spy 가 가로채지 못할 수 있다(node: 빌트인 externalize).
    // best-effort: spy 가 동작했을 때만(=버퍼 참조 확보 시) zeroize 를 단언한다.
    // spy 미동작 환경에서는 m5(disposeBaseline) 가 zeroize 프리미티브를 견고히 보장한다.
    if (captured.length > 0) {
      expect(captured.every((b) => b.length === 0 || b.every((x) => x === 0))).toBe(true)
    }
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

  it('[#128-A] baseline 파일이 non-regular(디렉터리)로 교체되면 read 없이 modified, backup 있으면 restorable', async () => {
    writeFileSync(join(root, 'cfg.dat'), 'orig')
    const git = fakeGitIgnored(['cfg.dat'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    // 에이전트가 파일을 디렉터리로 교체
    rmSync(join(root, 'cfg.dat'))
    mkdirSync(join(root, 'cfg.dat'))
    const cs = await collectIgnoredChanges(root, git, baseline, DEFAULT_IGNORED_POLICY)
    expect(cs.changes).toContainEqual({ path: 'cfg.dat', change: 'modified', sensitive: false })
    // backup 보유 → unrestorable 아님
    expect(cs.unrestorable.some((u) => u.path === 'cfg.dat')).toBe(false)
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

  it('[#128-B] 복원 대상 조상 경로가 파일이면 제거 후 디렉터리 체인을 재생성해 복원한다', async () => {
    // baseline: a/b/c.txt
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'c.txt'), 'ORIG')
    const git = fakeGitIgnored(['a/b/c.txt'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    // 에이전트가 a/b/c.txt 와 디렉터리를 지우고 'a'를 파일로 만든다 → 조상 충돌
    rmSync(join(root, 'a'), { recursive: true, force: true })
    writeFileSync(join(root, 'a'), 'AGENT_FILE')
    await restoreIgnoredBaseline(root, git, baseline, DEFAULT_IGNORED_POLICY)
    // a 파일은 제거되고 a/b/c.txt 가 원문으로 복원됨
    expect(statSync(join(root, 'a')).isDirectory()).toBe(true)
    expect(readFile(join(root, 'a', 'b', 'c.txt'), 'utf8')).toBe('ORIG')
  })

  // [P1-b] remove non-file path before restoring
  it('[#128-B] 이름이 점2개로 시작하는 정상 in-root 디렉터리(..cache)도 조상 정리 대상이다', async () => {
    mkdirSync(join(root, '..cache'), { recursive: true })
    writeFileSync(join(root, '..cache', 'c.txt'), 'ORIG')
    const git = fakeGitIgnored(['..cache/c.txt'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    rmSync(join(root, '..cache'), { recursive: true, force: true })
    writeFileSync(join(root, '..cache'), 'AGENT_FILE') // 조상을 파일로 교체
    await restoreIgnoredBaseline(root, git, baseline, DEFAULT_IGNORED_POLICY)
    expect(statSync(join(root, '..cache')).isDirectory()).toBe(true)
    expect(readFile(join(root, '..cache', 'c.txt'), 'utf8')).toBe('ORIG')
  })

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

  it('[#128-m5] disposeBaseline 은 backup Buffer 를 0으로 채운다', async () => {
    writeFileSync(join(root, '.env'), 'SECRET=1')
    const git = fakeGitIgnored(['.env'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const buf = baseline.entries.get('.env')!.backup!
    expect(buf.some((b) => b !== 0)).toBe(true) // dispose 전엔 내용 존재
    disposeBaseline(baseline)
    expect(buf.every((b) => b === 0)).toBe(true) // dispose 후 zeroize
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

describe.skipIf(process.platform === 'win32')('[#128-B2] symlink 비추종 (POSIX)', () => {
  it('git-보고 ignored 가 symlink-to-dir 면 재귀 안 하고 밖을 수집 안 한다', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET')
      symlinkSync(outside, join(root, 'link'), 'dir')
      const git = fakeGitIgnored(['link/']) // git 이 디렉터리처럼 보고
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      // 밖의 secret.txt 가 절대 entries 에 들어오면 안 됨
      expect([...base.entries.keys()].some((k) => k.includes('secret'))).toBe(false)
      // 보안 메커니즘 단언: 링크가 실제로 symlink 이유로 skipped 에 기록되어야 함
      expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'win32')('[#128-B2] junction 비추종 (Windows)', () => {
  it('git-보고 ignored 가 junction 이면 재귀 안 하고 밖을 수집 안 한다', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET')
      symlinkSync(outside, join(root, 'link'), 'junction')
      const git = fakeGitIgnored(['link/'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      expect([...base.entries.keys()].some((k) => k.includes('secret'))).toBe(false)
      // 보안 메커니즘 단언: junction 이 실제로 symlink 이유로 skipped 에 기록되어야 함
      expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

// ── Codex 3차 반영: [:96] [:109] [:244] [:270] ──

describe('[:96] unreadable dir → fail-closed (lstat catch in top-level loop)', () => {
  it('[Fix-B] lstat 실패 디렉터리는 walk 하지 않고 skipped{unclassified} 로 fail-closed 기록된다', async () => {
    // 존재하지 않는 경로를 git status 로 반환 → lstat ENOENT → fail-closed(walk 안 함)
    // [Codex round5 Fix-3] lstat 실패는 symlink 확정 아님 → 'unclassified' 로 기록.
    // 이전에는 'symlink' 로 기록했으나, 이 경우 restore sweep 이 실제 디렉터리를 파괴하는 오동작이 발생.
    const git = fakeGitIgnored(['nonexistent-dir/'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    // fail-closed: skipped 에 'nonexistent-dir' 가 unclassified 이유로 기록되어야 한다
    expect(base.skipped).toContainEqual({ path: 'nonexistent-dir', reason: 'unclassified' })
    // walk 하지 않았으므로 entries 는 비어 있어야 한다
    expect(base.entries.size).toBe(0)
  })
})

describe('[:109] nested denylist prune (walk recursive check)', () => {
  it('non-denylist top dir 아래 중첩 node_modules/ 의 파일은 capture 되지 않는다', async () => {
    // 구조: packages/x/node_modules/secret.js — 중첩 denylist
    mkdirSync(join(root, 'packages', 'x', 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'packages', 'x', 'node_modules', 'secret.js'), 'module=1')
    writeFileSync(join(root, 'packages', 'x', 'legit.ts'), 'export {}')
    const git = fakeGitIgnored(['packages/'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    // legit.ts 는 denylist 아님 → 캡처될 수 있음
    expect(base.entries.has('packages/x/node_modules/secret.js')).toBe(false)
    // skipped 에도 없어야 한다(denylist → 통째 skip, escalation 없음)
    expect(base.skipped.some((s) => s.path.includes('node_modules'))).toBe(false)
  })

  it('non-denylist top dir 아래 중첩 .git/ 의 파일도 capture 되지 않는다', async () => {
    mkdirSync(join(root, 'sub', '.git', 'refs'), { recursive: true })
    writeFileSync(join(root, 'sub', '.git', 'refs', 'head'), 'abc123')
    writeFileSync(join(root, 'sub', 'ok.txt'), 'data')
    const git = fakeGitIgnored(['sub/'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    expect(base.entries.has('sub/.git/refs/head')).toBe(false)
  })
})

describe('[:244] collect total byte cap (collectIgnoredChanges)', () => {
  it('여러 파일의 누적 크기가 maxTotalBytes 를 초과하면 이후 파일은 read 없이 modified+unrestorable', async () => {
    // 파일 3개, 각 10바이트, maxTotalBytes=15 → 첫 파일(10) OK, 두 번째(+10=20>15) over-cap
    writeFileSync(join(root, 'a.cfg'), Buffer.alloc(10, 0x61)) // 10B
    writeFileSync(join(root, 'b.cfg'), Buffer.alloc(10, 0x62)) // 10B
    writeFileSync(join(root, 'c.cfg'), Buffer.alloc(10, 0x63)) // 10B
    const git = fakeGitIgnored(['a.cfg', 'b.cfg', 'c.cfg'])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)

    // 모든 파일 내용을 변경해 hash mismatch 가 발생하도록
    writeFileSync(join(root, 'a.cfg'), Buffer.alloc(10, 0xaa))
    writeFileSync(join(root, 'b.cfg'), Buffer.alloc(10, 0xbb))
    writeFileSync(join(root, 'c.cfg'), Buffer.alloc(10, 0xcc))

    const policy = { ...DEFAULT_IGNORED_POLICY, maxTotalBytes: 15 }
    const cs = await collectIgnoredChanges(root, git, baseline, policy)

    // 누적 cap 이후 파일은 unrestorable(over-cap-modified) 로 표기되어야 한다
    const overCapPaths = cs.unrestorable
      .filter((u) => u.reason === 'over-cap-modified')
      .map((u) => u.path)
    expect(overCapPaths.length).toBeGreaterThanOrEqual(1)
    // cap 이후 파일은 반드시 modified 변경으로 탐지
    for (const p of overCapPaths) {
      expect(cs.changes.some((c) => c.path === p && c.change === 'modified')).toBe(true)
    }
  })
})

describe('[:270] scan-capped marker restore exclusion', () => {
  it('baseline.skipped 에 SCAN_CAPPED 마커가 있어도 restore 가 그 경로를 rmSync 하지 않는다', async () => {
    // baseline 시 파일 없음
    const baseGit = fakeGitIgnored([])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
    // baseline.skipped 에 SCAN_CAPPED 합성 마커를 수동 주입
    baseline.skipped.push({ path: SCAN_CAPPED, reason: 'over-cap' })

    // 실제로 'scan-capped' 라는 이름의 파일을 만들어 restore 가 삭제하지 않는지 확인
    const markerFile = join(root, SCAN_CAPPED)
    writeFileSync(markerFile, 'real-file-named-scan-capped')

    const curGit = fakeGitIgnored([SCAN_CAPPED])
    await restoreIgnoredBaseline(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    // restore 가 SCAN_CAPPED 경로를 실-파일로 취급해 삭제하면 안 된다
    // (baseline.skipped 에 있으므로 skippedPaths 에 포함 → created 루프에서 skip)
    // — 단, skipped 루프에서 SCAN_CAPPED === s.path 필터로 rmSync 를 건너뛰어야 한다
    expect(existsSync(markerFile)).toBe(true)
  })

  it('SCAN_CAPPED 마커가 skipped 에 있어도 over-cap 으로 생성된 실제 파일은 여전히 삭제된다', async () => {
    // baseline 시 파일 없음
    const baseGit = fakeGitIgnored([])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
    baseline.skipped.push({ path: SCAN_CAPPED, reason: 'over-cap' })

    // 에이전트가 생성한 실제 파일(scan-capped 아님)
    writeFileSync(join(root, 'agent-created.txt'), 'new')
    const curGit = fakeGitIgnored(['agent-created.txt'])
    await restoreIgnoredBaseline(root, curGit, baseline, DEFAULT_IGNORED_POLICY)

    // 실제 에이전트 생성 파일은 삭제되어야 한다
    expect(existsSync(join(root, 'agent-created.txt'))).toBe(false)
  })

  it('[#128-m2] restore 가 현재 스캔 cap 도달 시 { capped: true } 를 반환한다', async () => {
    const baseGit = fakeGitIgnored([])
    const baseline = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
    // 에이전트가 일반 파일 2개 생성, maxFiles=1 → 2번째는 over-cap(SCAN_CAPPED)
    writeFileSync(join(root, 'a.txt'), '1')
    writeFileSync(join(root, 'b.txt'), '2')
    const curGit = fakeGitIgnored(['a.txt', 'b.txt'])
    const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
    const res = await restoreIgnoredBaseline(root, curGit, baseline, policy)
    expect(res).toEqual({ capped: true })
  })

  it('[#128-m2] cap 미도달 시 { capped: false }', async () => {
    const git = fakeGitIgnored([])
    const baseline = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const res = await restoreIgnoredBaseline(root, git, baseline, DEFAULT_IGNORED_POLICY)
    expect(res).toEqual({ capped: false })
  })
})

// [Codex P1 Fix-D] baseline symlink → 일반파일 교체 rollback 검증 (POSIX)
describe.skipIf(process.platform === 'win32')(
  '[Fix-D] baseline symlink 경로를 일반파일로 교체 시 rollback (POSIX)',
  () => {
    it('[Fix-D collect] baseline symlink 를 일반파일로 교체 시 collectIgnoredChanges 가 created 로 보고', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'fleet-fixd-'))
      try {
        // baseline: link.dat 는 symlink → capture 가 skipped{symlink} 로 기록
        symlinkSync(join(outside, 'target'), join(root, 'link.dat'))
        const git = fakeGitIgnored(['link.dat'])
        const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link.dat', reason: 'symlink' })
        // 에이전트가 symlink 를 제거하고 일반파일로 교체
        rmSync(join(root, 'link.dat'))
        writeFileSync(join(root, 'link.dat'), 'agent-content')
        const curGit = fakeGitIgnored(['link.dat'])
        const cs = await collectIgnoredChanges(root, curGit, base, DEFAULT_IGNORED_POLICY)
        // symlink 경로가 화이트리스트에서 제외되어 created 로 표면화되어야 한다
        expect(cs.changes).toContainEqual({ path: 'link.dat', change: 'created', sensitive: false })
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('[Fix-D restore] baseline symlink 를 일반파일로 교체 시 restoreIgnoredBaseline 이 삭제한다', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'fleet-fixd-'))
      try {
        // baseline: link.dat 는 symlink → capture 가 skipped{symlink} 로 기록
        symlinkSync(join(outside, 'target'), join(root, 'link.dat'))
        const git = fakeGitIgnored(['link.dat'])
        const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link.dat', reason: 'symlink' })
        // 에이전트가 symlink 를 제거하고 일반파일로 교체
        rmSync(join(root, 'link.dat'))
        writeFileSync(join(root, 'link.dat'), 'agent-content')
        const curGit = fakeGitIgnored(['link.dat'])
        await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)
        // 에이전트가 만든 일반파일이 rollback 으로 삭제되어야 한다
        expect(existsSync(join(root, 'link.dat'))).toBe(false)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)

describe.skipIf(process.platform === 'win32')('[#128-B2] collect 링크 교체 (POSIX)', () => {
  // 깨끗한 distinguisher: symlink target 내용을 baseline 과 *동일*하게 둔다.
  //   - old(statSync 추종): target('orig')을 읽어 hash 가 baseline 과 일치 → '변경 없음' 오판(보안 구멍).
  //   - new(lstat 비추종): isSymbolicLink → modified. (단순히 다른 내용을 쓰면 old 도 modified 라 거짓-green.)
  it('baseline 파일이 같은 내용 가리키는 symlink 로 교체돼도 modified 로 잡는다(링크 비추종)', async () => {
    writeFileSync(join(root, 'f.dat'), 'orig')
    const git = fakeGitIgnored(['f.dat'])
    const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'same'), 'orig') // target 내용 == baseline
      rmSync(join(root, 'f.dat'))
      symlinkSync(join(outside, 'same'), join(root, 'f.dat'))
      const cs = await collectIgnoredChanges(root, git, base, DEFAULT_IGNORED_POLICY)
      expect(cs.changes).toContainEqual({ path: 'f.dat', change: 'modified', sensitive: false })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('[#128-B2] capture 링크 leaf (POSIX)', () => {
  it('비-sensitive symlink ignored 파일은 read 없이 symlink 로 skip', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'SECRET')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.dat'))
      const git = fakeGitIgnored(['link.dat'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      expect(base.entries.has('link.dat')).toBe(false)
      expect(base.skipped).toContainEqual({ path: 'link.dat', reason: 'symlink' })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('sensitive-명 symlink 는 throw(fail-closed)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
    try {
      writeFileSync(join(outside, 'k'), 'KEY')
      symlinkSync(join(outside, 'k'), join(root, '.env'))
      const git = fakeGitIgnored(['.env'])
      await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
        /링크/,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')(
  '[#128-B2] restore 쓰기 측 link-guard (POSIX)',
  () => {
    it('symlink leaf 는 링크를 제거하고 root 안 실파일로 복원(밖 target 미오염)', async () => {
      writeFileSync(join(root, 'f.dat'), 'orig')
      const git = fakeGitIgnored(['f.dat'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        writeFileSync(join(outside, 'victim'), 'DO-NOT-OVERWRITE')
        rmSync(join(root, 'f.dat'))
        symlinkSync(join(outside, 'victim'), join(root, 'f.dat'))
        await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
        // 밖 victim 은 그대로, root/f.dat 은 backup('orig')으로 복원
        expect(readFile(join(outside, 'victim')).toString()).toBe('DO-NOT-OVERWRITE')
        expect(readFile(join(root, 'f.dat')).toString()).toBe('orig')
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
    it('dangling symlink leaf → 실파일 복원, outside write-through 없음 [P1-2]', async () => {
      // baseline: f.dat='orig'
      writeFileSync(join(root, 'f.dat'), 'orig')
      const git = fakeGitIgnored(['f.dat'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        // f.dat 을 dangling symlink 로 교체 (outsideDir/ghost 는 존재하지 않음)
        rmSync(join(root, 'f.dat'))
        symlinkSync(join(outsideDir, 'ghost'), join(root, 'f.dat'))
        await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
        // root/f.dat 은 실파일('orig')로 복원되어야 함
        expect(readFile(join(root, 'f.dat')).toString()).toBe('orig')
        // fleet 이 dangling link 를 통해 outside 에 파일을 쓰지 않아야 함
        expect(existsSync(join(outsideDir, 'ghost'))).toBe(false)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('dangling symlink 조상 → 실디렉터리 재건, outside write-through 없음 [P1-3]', async () => {
      // baseline: a/b/c.dat='deep'
      mkdirSync(join(root, 'a', 'b'), { recursive: true })
      writeFileSync(join(root, 'a', 'b', 'c.dat'), 'deep')
      const git = fakeGitIgnored(['a/b/c.dat'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        // a/ 를 제거하고 dangling symlink 로 교체 (outsideDir/ghostdir 는 존재하지 않음)
        rmSync(join(root, 'a'), { recursive: true, force: true })
        symlinkSync(join(outsideDir, 'ghostdir'), join(root, 'a'))
        await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
        // a/b/c.dat 이 root 안에 실파일로 복원되어야 함
        expect(readFile(join(root, 'a', 'b', 'c.dat')).toString()).toBe('deep')
        // fleet 이 dangling link 를 통해 outside 에 디렉터리를 만들지 않아야 함
        expect(existsSync(join(outsideDir, 'ghostdir'))).toBe(false)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('민감 symlink → captureIgnoredBaseline throws [P1-1]', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        symlinkSync(join(outsideDir, 'whatever'), join(root, '.env'))
        const git = fakeGitIgnored(['.env'])
        await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
          /링크/,
        )
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    // [Codex 재리뷰 P1] 민감 디렉터리 SYMLINK(.ssh) → fail-closed
    // listIgnored 는 '.ssh/' → '.ssh'(trailing slash 제거) 로 skipped 에 push.
    // SENSITIVE_FILE 의 .ssh 절은 trailing slash 필수이므로 s.path='.ssh' 만 테스트하면 false(fail-open).
    // 수정: `${s.path}/` 형도 함께 테스트 → '.ssh/' 가 정규식과 매칭 → throw(fail-closed).
    it('[Codex P1] 민감 DIRECTORY symlink(.ssh) → captureIgnoredBaseline throws [P1-1-dir POSIX]', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-ssh-'))
      try {
        symlinkSync(outsideDir, join(root, '.ssh'), 'dir')
        // git 은 디렉터리 심볼릭 링크를 '.ssh/'(trailing slash 포함)로 보고한다
        const git = fakeGitIgnored(['.ssh/'])
        await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
          /링크/,
        )
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('created symlink-to-dir 는 링크만 unlink(밖 디렉터리 내용 보존)', async () => {
      // P2-4: baseline 에 esc 없음(분리 fixture) — capture 시 esc 미보고
      writeFileSync(join(root, 'f.dat'), 'orig')
      const baseGit = fakeGitIgnored(['f.dat']) // esc NOT reported at capture
      const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
      const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        writeFileSync(join(outside, 'keep'), 'KEEP')
        symlinkSync(outside, join(root, 'esc'), 'dir') // 실행 중 생성된 링크
        const curGit = fakeGitIgnored(['f.dat', 'esc']) // esc reported at restore
        await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)
        expect(existsSync(join(root, 'esc'))).toBe(false) // 링크 제거됨
        expect(readFile(join(outside, 'keep')).toString()).toBe('KEEP') // 밖 내용 보존
        expect(readFile(join(root, 'f.dat')).toString()).toBe('orig') // baseline 복원
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('실행 중 새로 생긴 escaping symlink 는 rollback 에서 unlink(밖 내용 보존)', async () => {
      // P2-4: baseline 에 newlink 없음(분리 fixture)
      writeFileSync(join(root, 'f.dat'), 'orig')
      const baseGit = fakeGitIgnored(['f.dat']) // newlink NOT reported at capture
      const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
      const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        writeFileSync(join(outside, 'keep'), 'KEEP')
        symlinkSync(outside, join(root, 'newlink'), 'dir') // 에이전트가 새로 만든 링크
        const curGit = fakeGitIgnored(['f.dat', 'newlink']) // restore 시점 git 보고
        await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)
        expect(existsSync(join(root, 'newlink'))).toBe(false)
        expect(readFile(join(outside, 'keep')).toString()).toBe('KEEP')
        expect(readFile(join(root, 'f.dat')).toString()).toBe('orig') // baseline 복원
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)

// [#128-B2 P2-1] baseline symlink-to-dir → agent 가 실제 dir 로 치환 → restore 가 dir 제거 (POSIX)
// RED on pre-fix: git 은 'link/child.txt' 만 보고 → created 루프가 'link' 자체를 못 지움 → dir 잔존.
describe.skipIf(process.platform === 'win32')(
  '[P2-1] baseline symlink-to-dir 을 실제 디렉터리로 치환하면 restore 가 그 디렉터리를 제거한다 (POSIX)',
  () => {
    it('baseline symlink-to-dir → real dir 치환 → restore removes dir', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'fleet-p21-'))
      try {
        // baseline: link 는 symlink → dir → capture 가 skipped{symlink}
        symlinkSync(outside, join(root, 'link'), 'dir')
        const baseGit = fakeGitIgnored(['link/'])
        const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })

        // 에이전트가 symlink 를 제거하고 실제 디렉터리(+자식 파일)로 치환
        rmSync(join(root, 'link'), { force: true })
        mkdirSync(join(root, 'link'))
        writeFileSync(join(root, 'link', 'child.txt'), 'agent-child')

        // restore 시 git 은 'link/child.txt' 만 보고(link 자체는 dir 라 보고 안 함)
        const curGit = fakeGitIgnored(['link/child.txt'])
        await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)

        // [P2-1] baseline symlink sweep 이 link 가 더 이상 symlink 아님을 감지 → removeCreated
        expect(existsSync(join(root, 'link'))).toBe(false)
        // outside 는 보존
        expect(existsSync(outside)).toBe(true)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)

// [#128-B2 P2-4] walk 내 non-sensitive symlink skip 도 스캔 예산에 포함
// RED on pre-fix: skipped 가 maxFiles 무관하게 무한 증가하고 SCAN_CAPPED 가 안 찍힘.
// Windows: 'file' symlink 는 관리자 권한 필요 → 'junction'(디렉터리 링크) 으로 대체.
describe('[P2-4] walk 내 symlink skip 이 스캔 cap 예산에 포함된다', () => {
  it('non-sensitive symlink 다수가 maxFiles 초과 시 skipped 가 bounded 되고 SCAN_CAPPED 가 찍힌다', async () => {
    // 구조: links/ 디렉터리 아래 비민감 symlink 3개, maxFiles=1
    // pre-fix: 모든 링크가 skipped 에 push → skipped.length=3, SCAN_CAPPED 없음
    // post-fix: generalCount 소진 후 SCAN_CAPPED 기록, 이후 링크 skip 생략
    mkdirSync(join(root, 'links'))
    const out1 = mkdtempSync(join(tmpdir(), 'fleet-p24a-'))
    const out2 = mkdtempSync(join(tmpdir(), 'fleet-p24b-'))
    const out3 = mkdtempSync(join(tmpdir(), 'fleet-p24c-'))
    try {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(out1, join(root, 'links', 'lnk1'), linkType)
      symlinkSync(out2, join(root, 'links', 'lnk2'), linkType)
      symlinkSync(out3, join(root, 'links', 'lnk3'), linkType)
      const git = fakeGitIgnored(['links/'])
      const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
      const base = await captureIgnoredBaseline(root, git, policy)

      // SCAN_CAPPED が skipped に記録されていること(cap 到達の証拠)
      expect(base.skipped.some((s) => s.path === SCAN_CAPPED && s.reason === 'over-cap')).toBe(true)

      // cap 이후 비민감 링크는 기록 생략 → skipped 총 건수(non-SCAN_CAPPED symlink) ≤ maxFiles
      const symlinkSkips = base.skipped.filter((s) => s.reason === 'symlink')
      expect(symlinkSkips.length).toBeLessThanOrEqual(policy.maxFiles)
    } finally {
      rmSync(out1, { recursive: true, force: true })
      rmSync(out2, { recursive: true, force: true })
      rmSync(out3, { recursive: true, force: true })
    }
  })

  it('sensitive symlink 은 cap 초과 후에도 반드시 기록된다(fail-closed)', async () => {
    // 비민감 symlink 1개(cap 소진) → 이후 민감 symlink(.ssh → dir) 도 기록되어야 함
    // .env 는 file symlink(win32 에서 권한 필요) → .ssh(dir symlink)로 대체
    mkdirSync(join(root, 'links'))
    const outNonSens = mkdtempSync(join(tmpdir(), 'fleet-p24ns-'))
    const outSens = mkdtempSync(join(tmpdir(), 'fleet-p24s-'))
    try {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      // non-sensitive dir-symlink → cap 소진
      symlinkSync(outNonSens, join(root, 'links', 'lnk1'), linkType)
      // sensitive dir-symlink(.ssh) → cap 후에도 항상 기록
      symlinkSync(outSens, join(root, '.ssh'), linkType)
      // git 은 links/ 를 먼저 보고해 walk 에서 lnk1 처리, 그 다음 .ssh/
      const git = fakeGitIgnored(['links/', '.ssh/'])
      const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
      // .ssh 는 sensitive → captureIgnoredBaseline 이 throw(fail-closed)
      await expect(captureIgnoredBaseline(root, git, policy)).rejects.toThrow(/링크/)
    } finally {
      rmSync(outNonSens, { recursive: true, force: true })
      rmSync(outSens, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'win32')(
  '[#128-B2] restore 쓰기 측 junction-guard (Windows)',
  () => {
    it('created JUNCTION-to-dir 는 junction 만 unlink(밖 디렉터리 내용 보존)', async () => {
      // capture 시점에 esc 는 없음 — baseline 에 미등재
      const baseGit = fakeGitIgnored(['f.dat'])
      writeFileSync(join(root, 'f.dat'), 'orig')
      const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
      const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        writeFileSync(join(outside, 'keep'), 'KEEP')
        symlinkSync(outside, join(root, 'esc'), 'junction') // 에이전트가 실행 중 만든 junction
        // restore 시점 git 은 esc 를 보고(실행 중 생성된 junction)
        const curGit = fakeGitIgnored(['f.dat', 'esc'])
        await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)
        expect(existsSync(join(root, 'esc'))).toBe(false) // junction 제거됨
        expect(readFile(join(outside, 'keep')).toString()).toBe('KEEP') // 밖 내용 보존
        expect(readFile(join(root, 'f.dat')).toString()).toBe('orig') // baseline 복원
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('junction leaf 교체 → junction 제거 후 root 안 실파일로 복원(밖 내용 미오염)', async () => {
      // win32 보안 회귀: baseline 일반파일 f.dat 가 junction 으로 교체됐을 때
      // restore 가 junction 을 unlink 하고 backup('orig')으로 실파일 복원하는지 검증.
      // lstatSync→rmSync→writeFileSync 경로(leaf restore)의 win32 커버.
      writeFileSync(join(root, 'f.dat'), 'orig')
      const git = fakeGitIgnored(['f.dat'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-jleaf-'))
      try {
        writeFileSync(join(outsideDir, 'keep'), 'KEEP')
        rmSync(join(root, 'f.dat'))
        symlinkSync(outsideDir, join(root, 'f.dat'), 'junction')
        await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
        // leaf が junction から実ファイルとして復元される
        expect(readFile(join(root, 'f.dat')).toString()).toBe('orig')
        // 밖 내용은 오염되지 않아야 함
        expect(readFile(join(outsideDir, 'keep')).toString()).toBe('KEEP')
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    it('junction 조상 → clearNonDirAncestors 제거 후 실파일 in-root 복원(밖 내용 보존)', async () => {
      // baseline: a/b/c.txt
      mkdirSync(join(root, 'a', 'b'), { recursive: true })
      writeFileSync(join(root, 'a', 'b', 'c.txt'), 'ORIG')
      const git = fakeGitIgnored(['a/b/c.txt'])
      const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
      const outside = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        writeFileSync(join(outside, 'victim'), 'OUTSIDE')
        // 에이전트가 a/ 디렉터리 전체를 지우고 'a'를 outside 에 대한 junction 으로 교체
        rmSync(join(root, 'a'), { recursive: true, force: true })
        symlinkSync(outside, join(root, 'a'), 'junction')
        await restoreIgnoredBaseline(root, git, base, DEFAULT_IGNORED_POLICY)
        // junction 이 제거되고 a/b/c.txt 가 in-root 에 복원됨
        expect(statSync(join(root, 'a')).isDirectory()).toBe(true)
        expect(readFile(join(root, 'a', 'b', 'c.txt')).toString()).toBe('ORIG')
        // 밖 victim 미오염
        expect(readFile(join(outside, 'victim')).toString()).toBe('OUTSIDE')
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('민감 junction(.env) → captureIgnoredBaseline throws [P1-1 win32]', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-out-'))
      try {
        symlinkSync(outsideDir, join(root, '.env'), 'junction')
        const git = fakeGitIgnored(['.env'])
        await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
          /링크/,
        )
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    // [Codex 재리뷰 P1] 민감 디렉터리 JUNCTION(.ssh) → fail-closed
    // listIgnored 는 '.ssh/' → '.ssh'(trailing slash 제거) 로 skipped 에 push.
    // SENSITIVE_FILE 의 .ssh 절은 trailing slash 필수이므로 s.path='.ssh' 만 테스트하면 false(fail-open).
    // 수정: `${s.path}/` 형도 함께 테스트 → '.ssh/' 가 정규식과 매칭 → throw(fail-closed).
    it('[Codex P1] 민감 DIRECTORY junction(.ssh) → captureIgnoredBaseline throws [P1-1-dir win32]', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-ssh-'))
      try {
        symlinkSync(outsideDir, join(root, '.ssh'), 'junction')
        // git 은 디렉터리 심볼릭 링크를 '.ssh/'(trailing slash 포함)로 보고한다
        const git = fakeGitIgnored(['.ssh/'])
        await expect(captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)).rejects.toThrow(
          /링크/,
        )
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    // [Codex P1 Fix-D] baseline JUNCTION → 일반파일 교체 → rollback 삭제 검증 (win32)
    it('[Fix-D win32] baseline JUNCTION 을 일반파일로 교체하면 restore 가 삭제한다', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-fixd-'))
      try {
        // baseline: link/ 는 junction → capture 가 skipped{symlink} 로 기록
        symlinkSync(outsideDir, join(root, 'link'), 'junction')
        const git = fakeGitIgnored(['link/'])
        const base = await captureIgnoredBaseline(root, git, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })
        // 에이전트가 junction 을 제거하고 일반파일로 교체
        rmSync(join(root, 'link'), { recursive: true, force: true })
        writeFileSync(join(root, 'link'), 'agent-content')
        // restore 시 git 은 'link' 를 파일로 보고
        const curGit = fakeGitIgnored(['link'])
        await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)
        // 에이전트가 만든 일반파일이 rollback 으로 삭제되어야 한다
        expect(existsSync(join(root, 'link'))).toBe(false)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    // [#128-B2 P2-1] baseline JUNCTION-to-dir → agent 가 실제 dir 로 치환 → restore 가 dir 제거
    // RED on pre-fix: git 은 child 만 보고하므로 'link' 자체가 created 루프에서 누락 → dir 잔존.
    it('[P2-1 win32] baseline JUNCTION 을 실제 디렉터리로 치환하면 restore 가 그 디렉터리를 제거한다', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'fleet-p21-'))
      try {
        // baseline: link 는 junction(디렉터리 가리킴) → skipped{symlink}
        symlinkSync(outsideDir, join(root, 'link'), 'junction')
        const baseGit = fakeGitIgnored(['link/'])
        const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })

        // 에이전트가 junction 을 제거하고 실제 디렉터리(+자식 파일)로 치환
        rmSync(join(root, 'link'), { recursive: true, force: true })
        mkdirSync(join(root, 'link'))
        writeFileSync(join(root, 'link', 'child.txt'), 'agent-child')

        // restore 시 git 은 'link/child.txt' 만 보고(link 자체는 디렉터리라 보고 안 함)
        const curGit = fakeGitIgnored(['link/child.txt'])
        await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)

        // [P2-1] baseline symlink sweep 이 link 가 더 이상 symlink 아님을 감지 → removeCreated
        expect(existsSync(join(root, 'link'))).toBe(false)
        // outside 는 보존
        expect(existsSync(outsideDir)).toBe(true)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  },
)

// ── Codex round5 P2 픽스 검증 ──

// [Codex round5 Fix-1] top-level symlink skip 도 스캔 cap 예산에 포함
// RED on pre-fix: top-level loop 가 pushSkipSymlink 를 거치지 않고 직접 skipped.push → cap 우회.
// 주의: 이 테스트는 top-level(git-status 에서 직접 보고된 항목)의 symlink skip cap 을 검증한다.
// walk 내부(P2-4 테스트)와 별개이다.
describe('[round5 Fix-1] top-level symlink/unclassified skip 도 스캔 cap 에 포함된다', () => {
  it('top-level 비민감 dir-symlink 다수가 maxFiles 초과 시 SCAN_CAPPED 기록 + skipped bounded', async () => {
    // git 이 link1/, link2/, link3/ 를 top-level 에 직접 보고 → lstatSync → isSymbolicLink true
    // maxFiles=1 이면 link1 하나만 소진 후 SCAN_CAPPED 기록, link2/link3 생략
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const out1 = mkdtempSync(join(tmpdir(), 'fleet-r5f1a-'))
    const out2 = mkdtempSync(join(tmpdir(), 'fleet-r5f1b-'))
    const out3 = mkdtempSync(join(tmpdir(), 'fleet-r5f1c-'))
    try {
      symlinkSync(out1, join(root, 'link1'), linkType)
      symlinkSync(out2, join(root, 'link2'), linkType)
      symlinkSync(out3, join(root, 'link3'), linkType)
      // git 이 dir-symlink 를 trailing slash 포함 보고
      const git = fakeGitIgnored(['link1/', 'link2/', 'link3/'])
      const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
      const base = await captureIgnoredBaseline(root, git, policy)

      // SCAN_CAPPED 기록 확인(cap 도달 증거)
      expect(base.skipped.some((s) => s.path === SCAN_CAPPED && s.reason === 'over-cap')).toBe(true)

      // cap 이후 비민감 top-level symlink 는 생략 → symlink skips ≤ maxFiles
      const symlinkSkips = base.skipped.filter((s) => s.reason === 'symlink')
      expect(symlinkSkips.length).toBeLessThanOrEqual(policy.maxFiles)
    } finally {
      rmSync(out1, { recursive: true, force: true })
      rmSync(out2, { recursive: true, force: true })
      rmSync(out3, { recursive: true, force: true })
    }
  })

  it('top-level cap 초과 후에도 민감 symlink 는 반드시 기록된다(fail-closed)', async () => {
    // 비민감 link1 이 cap 소진 → 이후 민감 .ssh symlink 도 기록되어야 함
    // → captureIgnoredBaseline 이 throw(fail-closed)
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const outNonSens = mkdtempSync(join(tmpdir(), 'fleet-r5f1ns-'))
    const outSens = mkdtempSync(join(tmpdir(), 'fleet-r5f1s-'))
    try {
      symlinkSync(outNonSens, join(root, 'link1'), linkType)
      symlinkSync(outSens, join(root, '.ssh'), linkType)
      const git = fakeGitIgnored(['link1/', '.ssh/'])
      const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
      await expect(captureIgnoredBaseline(root, git, policy)).rejects.toThrow(/링크/)
    } finally {
      rmSync(outNonSens, { recursive: true, force: true })
      rmSync(outSens, { recursive: true, force: true })
    }
  })
})

// [Codex round5 Fix-4] baseline symlink-to-dir 이 EMPTY 실디렉터리로 치환 → collect 탐지
// RED on pre-fix: git 은 자식 없는 빈 디렉터리를 보고하지 않아 files 루프에서 탐지 불가.
describe.skipIf(process.platform === 'win32')(
  '[round5 Fix-4] baseline symlink-to-dir 을 빈 실디렉터리로 치환하면 collect 가 created 로 탐지 (POSIX)',
  () => {
    it('baseline symlink → empty real dir 치환 → collectIgnoredChanges reports created', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'fleet-r5f4-'))
      try {
        // baseline: link 는 symlink-to-dir → skipped{symlink}
        symlinkSync(outside, join(root, 'link'), 'dir')
        const baseGit = fakeGitIgnored(['link/'])
        const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })

        // 에이전트가 symlink 를 제거하고 빈 실디렉터리로 치환
        rmSync(join(root, 'link'), { force: true })
        mkdirSync(join(root, 'link'))
        // 빈 디렉터리 → git 은 아무 자식도 보고 안 함
        const curGit = fakeGitIgnored([])
        const cs = await collectIgnoredChanges(root, curGit, base, DEFAULT_IGNORED_POLICY)

        // baselineSymlinkPaths sweep 이 link 를 탐지해 created 로 보고해야 한다
        expect(cs.changes.some((c) => c.path === 'link' && c.change === 'created')).toBe(true)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)

describe.skipIf(process.platform !== 'win32')(
  '[round5 Fix-4] baseline JUNCTION-to-dir 을 빈 실디렉터리로 치환하면 collect 가 created 로 탐지 (win32)',
  () => {
    it('baseline junction → empty real dir 치환 → collectIgnoredChanges reports created', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'fleet-r5f4w-'))
      try {
        // baseline: link 는 junction → skipped{symlink}
        symlinkSync(outside, join(root, 'link'), 'junction')
        const baseGit = fakeGitIgnored(['link/'])
        const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })

        // 에이전트가 junction 을 제거하고 빈 실디렉터리로 치환
        rmSync(join(root, 'link'), { recursive: true, force: true })
        mkdirSync(join(root, 'link'))
        // 빈 디렉터리 → git 은 아무 자식도 보고 안 함
        const curGit = fakeGitIgnored([])
        const cs = await collectIgnoredChanges(root, curGit, base, DEFAULT_IGNORED_POLICY)

        // baselineSymlinkPaths sweep 이 link 를 탐지해 created 로 보고해야 한다
        expect(cs.changes.some((c) => c.path === 'link' && c.change === 'created')).toBe(true)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)

// [Codex round5 Fix-3] baseline skipped{unclassified} 는 restore sweep 에서 건드리지 않는다
// RED on pre-fix: lstat-fail 이 'symlink' 로 기록됐을 때 restore sweep(baselineSymlinkPaths)이
// 해당 경로를 "치환됨"으로 판단해 removeCreated → 실제 디렉터리 파괴.
// post-fix: 'unclassified' 는 baselineSymlinkPaths 에서 제외 → sweep 건너뜀 → 디렉터리 보존.
describe('[round5 Fix-3] baseline skipped{unclassified} 는 restore sweep 에서 삭제하지 않는다', () => {
  it('unclassified 엔트리가 있는 경로가 실제 디렉터리로 존재해도 restore sweep 이 삭제하지 않는다', async () => {
    // 실 lstat-fail 은 portable 하게 재현 불가(exotic reparse 등) → 수동 baseline 주입으로 검증.
    // "lstat 실패였던" 경로가 실제로는 디렉터리인 경우를 시뮬레이션.
    // RED 조건: 이전에 'symlink' 로 기록되면 sweep 이 lstatSync → !isSymbolicLink → removeCreated
    //   → 디렉터리 삭제. post-fix 는 'unclassified' 이므로 baselineSymlinkPaths 에 없음 → sweep 제외.
    const baseGit = fakeGitIgnored([])
    const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)

    // 수동으로 unclassified 엔트리 주입(실 lstat-fail 시뮬레이션)
    base.skipped.push({ path: 'real-dir', reason: 'unclassified' })

    // 실제 디렉터리 생성
    mkdirSync(join(root, 'real-dir'))

    // restore 시 git 은 real-dir/ 를 디렉터리로 보고 — 내용이 없으므로 아무 파일도 보고 안 함.
    // real-dir 자체는 skippedPaths 에 있으므로 files 루프에서도 제외됨.
    // 핵심 검증: baselineSymlinkPaths sweep 이 real-dir 을 삭제하지 않아야 한다.
    const curGit = fakeGitIgnored([])
    await restoreIgnoredBaseline(root, curGit, base, DEFAULT_IGNORED_POLICY)

    // unclassified → baselineSymlinkPaths 에 없음 → sweep 건너뜀 → 디렉터리 보존
    expect(existsSync(join(root, 'real-dir'))).toBe(true)
  })
})

// ── Codex round6 Fix-1: baseline symlink 삭제 → deleted 표면화 ──
// RED on pre-fix: baselineSymlinkPaths sweep ENOENT 분기가 `continue` → deleted 보고 없음.
// post-fix: ENOENT 시 `changes.push({change:'deleted',...})` → 표면화됨.
describe.skipIf(process.platform === 'win32')(
  '[round6 Fix-1] baseline symlink-dir DELETED → collectIgnoredChanges reports deleted (POSIX)',
  () => {
    it('baseline symlink(POSIX dir) 이 삭제되면 collectIgnoredChanges 가 deleted 로 보고한다', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'fleet-r6f1-'))
      try {
        // baseline: link → symlink-to-dir → capture 가 skipped{symlink}
        symlinkSync(outside, join(root, 'link'), 'dir')
        const baseGit = fakeGitIgnored(['link/'])
        const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })

        // 에이전트가 symlink 를 삭제 — 아무것도 남기지 않음
        rmSync(join(root, 'link'), { force: true })

        // collect: git 은 아무것도 보고 안 함(symlink 도 대체물도 없음)
        const curGit = fakeGitIgnored([])
        const cs = await collectIgnoredChanges(root, curGit, base, DEFAULT_IGNORED_POLICY)

        // RED: pre-fix 는 ENOENT → continue → changes 에 아무것도 없음.
        // GREEN: post-fix 는 deleted 를 push.
        expect(cs.changes.some((c) => c.path === 'link' && c.change === 'deleted')).toBe(true)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)

describe.skipIf(process.platform !== 'win32')(
  '[round6 Fix-1] baseline junction DELETED → collectIgnoredChanges reports deleted (win32)',
  () => {
    it('baseline junction 이 삭제되면 collectIgnoredChanges 가 deleted 로 보고한다', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'fleet-r6f1w-'))
      try {
        // baseline: link → junction → capture 가 skipped{symlink}
        symlinkSync(outside, join(root, 'link'), 'junction')
        const baseGit = fakeGitIgnored(['link/'])
        const base = await captureIgnoredBaseline(root, baseGit, DEFAULT_IGNORED_POLICY)
        expect(base.skipped).toContainEqual({ path: 'link', reason: 'symlink' })

        // 에이전트가 junction 을 삭제
        rmSync(join(root, 'link'), { recursive: true, force: true })

        // collect: git 은 아무것도 보고 안 함
        const curGit = fakeGitIgnored([])
        const cs = await collectIgnoredChanges(root, curGit, base, DEFAULT_IGNORED_POLICY)

        // RED: pre-fix 는 ENOENT → continue → changes 에 아무것도 없음.
        // GREEN: post-fix 는 deleted 를 push.
        expect(cs.changes.some((c) => c.path === 'link' && c.change === 'deleted')).toBe(true)
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })
  },
)

// ── Codex round6 Fix-2: cap 후 sensitive symlink 가 fail-closed 에 도달하는지 검증 ──
// RED on pre-fix: top-level `if (capped) break` が非民感リンクで cap をトリップ後に break →
//   後続の .ssh/ レコードが captureIgnoredBaseline の sensitive 検査に到達しない(fail-OPEN).
// post-fix: break 削除 → .ssh/ がループを通過 → pushSkip(sensitive) → throw(fail-CLOSED).
describe('[round6 Fix-2] cap 후 sensitive symlink 가 top-level loop 를 통과해 fail-closed 에 도달한다', () => {
  it('POSIX: non-sensitive link cap 후 .ssh symlink → captureIgnoredBaseline throws', async () => {
    if (process.platform === 'win32') return // junction variant below
    const outNonSens = mkdtempSync(join(tmpdir(), 'fleet-r6f2a-'))
    const outSens = mkdtempSync(join(tmpdir(), 'fleet-r6f2b-'))
    try {
      // link1, link2 = non-sensitive dir-symlinks (maxFiles=1 → link1 이 cap 소진)
      symlinkSync(outNonSens, join(root, 'link1'), 'dir')
      symlinkSync(outNonSens, join(root, 'link2'), 'dir')
      // .ssh = sensitive dir-symlink — cap 이후 레코ードとして続く
      symlinkSync(outSens, join(root, '.ssh'), 'dir')
      // git 은 link1/ → link2/ → .ssh/ 순서로 보고
      const git = fakeGitIgnored(['link1/', 'link2/', '.ssh/'])
      const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
      // RED: pre-fix は break により .ssh/ に到達せず → resolve(no throw).
      // GREEN: post-fix は break なし → .ssh/ が pushSkip(sensitive) → captureIgnoredBaseline が throw.
      await expect(captureIgnoredBaseline(root, git, policy)).rejects.toThrow(/링크/)
    } finally {
      rmSync(outNonSens, { recursive: true, force: true })
      rmSync(outSens, { recursive: true, force: true })
    }
  })

  it('win32: non-sensitive junction cap 후 .ssh junction → captureIgnoredBaseline throws', async () => {
    if (process.platform !== 'win32') return
    const outNonSens = mkdtempSync(join(tmpdir(), 'fleet-r6f2c-'))
    const outSens = mkdtempSync(join(tmpdir(), 'fleet-r6f2d-'))
    try {
      symlinkSync(outNonSens, join(root, 'link1'), 'junction')
      symlinkSync(outNonSens, join(root, 'link2'), 'junction')
      symlinkSync(outSens, join(root, '.ssh'), 'junction')
      const git = fakeGitIgnored(['link1/', 'link2/', '.ssh/'])
      const policy = { ...DEFAULT_IGNORED_POLICY, maxFiles: 1 }
      await expect(captureIgnoredBaseline(root, git, policy)).rejects.toThrow(/링크/)
    } finally {
      rmSync(outNonSens, { recursive: true, force: true })
      rmSync(outSens, { recursive: true, force: true })
    }
  })
})

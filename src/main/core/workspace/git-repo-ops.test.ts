import { execFile, execFileSync, spawn, type ExecFileException } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { createGitRepo, REF_LOCK_BACKOFF_MS, type GitResult, type GitRunner } from './git'

/**
 * T11 — `GitRepo` 나머지 연산(#251 PR3 · 스펙 §W-6 · 계약 테스트 §3-T23~T27).
 *
 * 이 파일의 계약은 전부 **4면 git 실측**(win32 2.54.0 / linux 2.39.5 = 배포 런타임 / linux 2.30.2 = pre-2.38 /
 * linux 2.54.0 = 플랫폼 축 특정용) 위에 서 있다. 실측이 뒤집은 것 셋을 여기 명시해 둔다 —
 * 문면만 보고 고치면 되돌아간다:
 *
 * 1. **`merge-tree --write-tree` 는 충돌과 인자 오류를 같은 exit 1 로 낸다.** 충돌은 stdout 첫 줄이 OID 이고
 *    인자 오류는 stdout 이 비어 있다 → **판별식은 종료코드가 아니라 첫 줄**이다.
 * 2. **`update-ref` 실패는 `reference already exists` 와 `is at X but expected Y` 가 둘 다 exit 128** 이다.
 *    문면은 버전마다 달라질 수 있어 분류 근거로 쓰지 않고 **디스크 실제 값을 재조회**해 값으로 답한다.
 * 3. **win32 git 은 packed 상태의 D/F 를 막지 않는다**(linux 2.54 는 막는다 — 플랫폼 축). 그 상태에서
 *    `rev-parse --verify`·`show-ref --verify` 는 **실존 ref 를 부재로** 답하고 `for-each-ref` 만 열거한다.
 *    그래서 결과 ref 관측은 `listRefs` 열거로만 하고 `refExists` 를 쓰지 않는다(§3-T23·T34 근거).
 */

/** 실 git 스폰 다수 — 형제 `git-repo.test.ts:21-25` 와 같은 이유로 파일 단위 상한을 올린다. */
vi.setConfig({ testTimeout: 30_000 })

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const ID = ['-c', 'user.email=a@b', '-c', 'user.name=a'] as const

const mkTmp = (): string => realpathSync.native(mkdtempSync(join(tmpdir(), 'fleet-251-ops-')))

/** 커밋 1개짜리 레포. `base.txt` 는 충돌 픽스처가 같은 줄을 다투는 대상이다. */
const initRepo = (dir: string): string => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main', '.')
  writeFileSync(join(dir, 'base.txt'), 'l1\nl2\nl3\n')
  git(dir, 'add', '-A')
  git(dir, ...ID, 'commit', '-q', '-m', 'base')
  return dir
}

const commitFile = (dir: string, name: string, content: string, message: string): string => {
  writeFileSync(join(dir, name), content)
  git(dir, 'add', '-A')
  git(dir, ...ID, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** 형제 파일과 같은 근거로 러너를 주입한다(win32 PATH 해석 **10s** 상한 회피 · `cli/detect.ts:261`). */
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

/** 호출 인자를 포착하는 계측 러너 — 실 git 을 그대로 태우되 인자·횟수를 관측한다. */
const spyRunner = (): GitRunner & { seen: string[][] } => {
  const seen: string[][] = []
  return {
    seen,
    run: (args, cwd, signal) => {
      seen.push(args)
      return execRunner.run(args, cwd, signal)
    },
  }
}

const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

describe('T11/§3-T24 — casUpdateRef: 정확 old-OID CAS(실 git)', () => {
  const REF = 'refs/fleet/integrated/BENCH1/TXN1'

  it('create-if-absent 는 부재일 때만 성공하고, 이미 있으면 실제 값과 함께 거부한다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c1 = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)

    expect(await repo.casUpdateRef(REF, c1, null)).toEqual({ status: 'updated' })
    expect(git(r, 'rev-parse', REF)).toBe(c1)

    const c2 = commitFile(r, 'n.txt', 'n\n', 'n')
    // 두 번째 create-if-absent — **`reference already exists`(exit 128)** 다. 종별을 문면이 아니라
    // 재조회한 값으로 답하는 것이 계약이므로 `actual` 이 디스크 값과 같아야 한다.
    expect(await repo.casUpdateRef(REF, c2, null)).toEqual({ status: 'rejected', actual: c1 })
    expect(git(r, 'rev-parse', REF)).toBe(c1)
  })

  it('expected 가 정확히 일치할 때만 이동한다 — **조상 이동(ff 가능)에도 낡은 expected 는 거부**(15R)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c1 = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    await repo.casUpdateRef(REF, c1, null)
    const c2 = commitFile(r, 'n.txt', 'n\n', 'n') // c2 는 c1 의 자손 = ff 가능

    expect(await repo.casUpdateRef(REF, c2, c1)).toEqual({ status: 'updated' })
    expect(git(r, 'rev-parse', REF)).toBe(c2)

    const c3 = commitFile(r, 'm.txt', 'm\n', 'm')
    // ref 는 이미 c2 인데 expected 로 c1(조상)을 주면 **ff 가능함에도** 거부되어야 한다.
    // ff-only 의미론(조상 검사)으로 구현하면 여기서 통과해 버린다 — 그것이 이 행의 falsifier 다.
    expect(await repo.casUpdateRef(REF, c3, c1)).toEqual({ status: 'rejected', actual: c2 })
    expect(git(r, 'rev-parse', REF)).toBe(c2)
  })

  it('존재하지 않는 객체로의 발행은 값으로 실패한다(외부 `gc --prune=now` 경합 · 실측)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const repo = createGitRepo(r, execRunner)
    const missing = 'b'.repeat(40)

    const res = await repo.casUpdateRef(REF, missing, null)
    expect(res.status).toBe('failed')
    // 조용한 성공이 아니라 **소리 나는 실패**임이 계약이다(실측: `nonexistent object`).
    expect(res.status === 'failed' && res.stderr).toMatch(/nonexistent object|not a valid|missing/i)
    // ⚠ **디렉터리 부재로 검사하지 않는다** — git 은 락 파일 경로의 부모 디렉터리를 실패 전에 만든다
    //   (실측: `.git/refs/fleet/…` 가 남는다). 「발행되지 않았다」의 관측면은 **ref 부재**다.
    expect(await repo.revParse(REF)).toEqual({ status: 'absent' })
    expect(await repo.listRefs('refs/fleet/')).toEqual({ status: 'ok', refs: [] })
  })

  it('`--batch-updates` 를 쓰지 않는다 — 거부에도 exit 0 이라 CAS 가 무성 통과한다(2.54 실측)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const runner = spyRunner()
    await createGitRepo(r, runner).casUpdateRef(REF, git(r, 'rev-parse', 'HEAD'), null)
    expect(runner.seen.flat()).not.toContain('--batch-updates')
  })
})

describe('T11/§3-T23 — listRefs 열거와 D/F 판정(실 git)', () => {
  it('접두는 **경로 성분 경계**로 매칭하고 이웃 bench 를 누출하지 않는다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    await repo.casUpdateRef('refs/fleet/integrated/BX/T1', c, null)
    await repo.casUpdateRef('refs/fleet/integrated/BX/T2', c, null)
    await repo.casUpdateRef('refs/fleet/integrated/BXY/T9', c, null)

    const res = await repo.listRefs('refs/fleet/integrated/BX')
    expect(res.status).toBe('ok')
    const names = res.status === 'ok' ? res.refs.map((x) => x.ref) : []
    expect(names).toEqual(['refs/fleet/integrated/BX/T1', 'refs/fleet/integrated/BX/T2'])
    // 접두 문자열 매칭 구현이면 `BXY/T9` 가 새어 들어온다 — 그것이 이 단언의 falsifier 다.
    expect(names.some((n) => n.includes('BXY'))).toBe(false)
    expect(res.status === 'ok' && res.refs.every((x) => OID_RE.test(x.oid))).toBe(true)
  })

  it('bare 부모 ref 는 **exact 항목**으로 구분된다 — D/F 판정의 유일 근거', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    await repo.casUpdateRef('refs/fleet/integrated/BZ', c, null) // bare 선점

    const res = await repo.listRefs('refs/fleet/integrated/BZ')
    const names = res.status === 'ok' ? res.refs.map((x) => x.ref) : []
    expect(names).toContain('refs/fleet/integrated/BZ')
    // 자식 발행은 이 상태에서 거부되어야 한다(loose 축은 3면 공통으로 git 이 막는다).
    const child = await repo.casUpdateRef('refs/fleet/integrated/BZ/T1', c, null)
    expect(child.status).toBe('failed')
  })

  /**
   * **뮤테이션이 잡아낸 공백**: 단일 ref 재조회가 접두 매칭이면 「자식이 있으니 부모도 있다」로 오답한다.
   * 그 오답은 `casUpdateRef` 의 실패 분류를 `failed`(D/F) → `rejected`(경합 패배)로 바꿔,
   * 호출자가 재시도 가능한 상황으로 착각하게 만든다.
   */
  it('단일 ref 재조회는 **exact** 다 — 자식이 있어도 부모는 부재다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    await repo.casUpdateRef('refs/fleet/integrated/BP/T1', c, null)

    expect(await repo.refExists('refs/fleet/integrated/BP')).toEqual({
      status: 'ok',
      exists: false,
    })
    // 자식이 있는 자리에 bare 부모를 만들려는 시도는 **D/F 실패**이지 「이미 있음(rejected)」이 아니다.
    const bare = await repo.casUpdateRef('refs/fleet/integrated/BP', c, null)
    expect(bare.status).toBe('failed')
  })

  /**
   * **Codex PR#268 P1**(2면 실측 win32 2.54 / linux 2.39.5): 손상된 loose ref 가 접두 아래 있으면
   * `for-each-ref` 는 **exit 0 을 내면서 그 ref 를 목록에서 빼고** stderr 에 경고만 남긴다.
   * 종료코드만 보는 구현은 「정상 열거 · 그 ref 없음」으로 읽는데, 소비자는 **부재를 「발행되지 않았다」의
   * 증거**로 쓰므로 손상된 published 결과 ref 가 포기 적격으로 오판된다(fail-open).
   */
  it('손상된 ref 가 섞이면 exit 0 이어도 열거는 fail-closed 다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    await repo.casUpdateRef('refs/fleet/integrated/BK/GOOD', c, null)

    const broken = join(r, '.git', 'refs', 'fleet', 'integrated', 'BK', 'BAD')
    mkdirSync(dirname(broken), { recursive: true })
    writeFileSync(broken, 'not-an-oid\n')

    // 대조군: git 자신은 성공을 자칭한다(경고만 낸다).
    const raw = execFileSync('git', ['for-each-ref', 'refs/fleet/integrated/BK'], {
      cwd: r,
      encoding: 'utf8',
    })
    expect(raw).not.toContain('BAD')

    const listed = await repo.listRefs('refs/fleet/integrated/BK')
    expect(listed.status).toBe('failed')
    // ⚠ **git 원문을 단언하지 않는다**(CodeRabbit PR#268): `warning: ignoring broken ref …` 는 번역 대상이라
    //   그 문면을 보면 이 테스트 자신이 **비영어 로케일에서 실패**한다 — 방금 세운 로케일 독립 규범과
    //   어긋난다. 단언 대상은 **구현이 붙이는 라벨**이다(원문은 진단용으로 보존만 한다).
    expect(listed.status === 'failed' && listed.stderr).toMatch(/열거 불완전/)

    // 같은 근거가 **손상 ref 자신의 재조회**에도 걸린다 — 「없다」가 아니라 「못 봤다」로 답해야 한다.
    expect((await repo.refExists('refs/fleet/integrated/BK/BAD')).status).toBe('failed')
    // ⚠ 반면 **손상과 무관한 단일 ref** 조회는 정상이다(경고는 질의 접두 안에 손상이 있을 때만 난다) —
    //   과잉 차단하면 손상 하나가 그 레포의 전 연산을 멈춘다. 범위를 정직하게 적어 둔다.
    expect(await repo.refExists('refs/fleet/integrated/BK/GOOD')).toEqual({
      status: 'ok',
      exists: true,
    })
  })

  /**
   * **Codex PR#268 2차 P1** — 손상 경고는 git 의 **번역 대상 문자열**이라 비영어 로케일에서 영어 정규식이
   * 빗나간다. 문면으로 판정하면 그 순간 가드가 통째로 무력화돼 원래의 fail-open 이 되돌아온다.
   * 그래서 판정은 **「exit 0 인데 stderr 가 비어 있지 않다」**(로케일 독립)로 한다.
   */
  it('손상 경고가 번역돼 있어도 열거는 fail-closed 다(로케일 독립)', async () => {
    const localized: GitRunner = {
      run: () =>
        Promise.resolve({
          code: 0,
          stdout: `refs/fleet/integrated/BK/GOOD\0${'a'.repeat(40)}\n`,
          // 독일어 로캘 예시 — 영어 문면 매칭 구현이면 이 경고를 놓친다.
          stderr: 'Warnung: Ignoriere kaputte Referenz refs/fleet/integrated/BK/BAD\n',
        }),
    }
    const repo = createGitRepo('/nowhere', localized)
    expect((await repo.listRefs('refs/fleet/integrated/BK')).status).toBe('failed')
    expect((await repo.refExists('refs/fleet/integrated/BK/GOOD')).status).toBe('failed')
  })

  /**
   * **Codex PR#268 2차 P1** — 기본 `update-ref` 는 **symref 를 따라간다**. 대상 자리가 dangling symbolic ref
   * 면 create-if-absent 가 그 **대상 ref(네임스페이스 밖)** 를 만들고 exit 0 을 내며, 왕복 검증마저
   * 통과한다(실측: `refs/heads/other` 가 생기고 txn ref 는 symbolic 인 채 새 OID 로 해소된다).
   * `--no-deref` 는 `dangling symref already exists`(128)로 **fail-closed** 한다.
   */
  it('symbolic ref 자리에는 발행하지 않는다 — 네임스페이스 밖을 만들지 않는다(`--no-deref`)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    const REF = 'refs/fleet/integrated/BM/T1'
    git(r, 'symbolic-ref', REF, 'refs/heads/other') // dangling symref 선점

    const res = await repo.casUpdateRef(REF, c, null)

    expect(res.status).toBe('failed')
    // **네임스페이스 밖 ref 가 만들어지지 않았다** — deref 구현이면 여기서 `refs/heads/other` 가 생기고
    // 게다가 CAS 는 `updated` 를 답한다(왕복 검증도 symref 를 따라가 통과한다 · 실측).
    expect(await repo.revParse('refs/heads/other')).toEqual({ status: 'absent' })
    expect(await repo.refExists('refs/heads/other')).toEqual({ status: 'ok', exists: false })
  })

  it('`--no-deref` 가 정상 ref 발행을 막지 않는다(회귀 통제)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    expect(await repo.casUpdateRef('refs/fleet/integrated/BN/T1', c, null)).toEqual({
      status: 'updated',
    })
  })

  it('결과가 없으면 빈 목록이고, 레포가 아니면 fail-closed(빈 배열로 위장하지 않는다)', async () => {
    const base = mkTmp()
    const r = initRepo(join(base, 'repo'))
    const empty = await createGitRepo(r, execRunner).listRefs('refs/fleet/integrated/NONE')
    expect(empty).toEqual({ status: 'ok', refs: [] })

    const notRepo = await createGitRepo(base, execRunner).listRefs('refs/fleet/')
    expect(notRepo.status).toBe('failed')
  })

  /**
   * **win32 특성화**: packed 자식이 있는데 bare 부모가 생기는 상태를 git 이 막지 못한다(실측).
   * 그 상태에서 `rev-parse --verify` 는 자식을 **부재**로 답하지만 열거에는 나온다 — 결과 ref 관측을
   * `refExists` 로 하면 「이미 발행된 결과」를 잃는다. linux 는 애초에 이 상태를 만들 수 없어 skip 한다.
   */
  it('packed 공존 상태에서도 열거는 결과 ref 를 잃지 않는다(win32 실측 재현)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)
    await repo.casUpdateRef('refs/fleet/integrated/BW/T1', c, null)
    git(r, 'pack-refs', '--all')
    const bare = await repo.casUpdateRef('refs/fleet/integrated/BW', c, null)
    if (bare.status !== 'updated') {
      // linux git 은 여기서 D/F 로 거부한다 — 그 자체가 정상이며 이 특성화의 대상이 아니다.
      expect(bare.status).toBe('failed')
      return
    }
    // win32: 공존이 성립했다. **원시 해소(`revParse`)는 자식을 잃지만 열거는 잃지 않는다.**
    const viaResolution = await repo.revParse('refs/fleet/integrated/BW/T1')
    const listed = await repo.listRefs('refs/fleet/integrated/BW')
    const names = listed.status === 'ok' ? listed.refs.map((x) => x.ref) : []
    expect(names).toContain('refs/fleet/integrated/BW/T1')
    // 이 비대칭이 「`refExists` 를 `rev-parse` 로 구현하면 안 된다」의 실측 근거다 —
    // 그 구현이면 **이미 발행된 결과 ref 를 «부재»** 로 답해 복구 판정이 포기 적격을 낸다.
    expect(viaResolution).toEqual({ status: 'absent' })
    expect(await repo.refExists('refs/fleet/integrated/BW/T1')).toEqual({
      status: 'ok',
      exists: true,
    })
  })
})

/**
 * 위 특성화는 **win32 에서만** 실제로 공존 상태에 도달한다(linux git 은 D/F 로 거부한다). 그 축만 두면
 * ubuntu CI 에서는 이 계약이 영원히 무신호이고, GitHub 러너의 git 버전에도 의존하게 된다.
 * 그래서 같은 사실을 **주입 러너로 재현한 쌍둥이**를 둔다 — 이쪽은 양 OS·모든 git 버전에서 돈다.
 */
describe('T11/§3-T23 — packed 공존의 플랫폼 독립 쌍둥이(주입 러너)', () => {
  const CHILD = 'refs/fleet/integrated/BW/T1'
  /** win32 실측 그대로: 열거는 부모·자식을 **둘 다** 답하고, 원시 해소는 자식을 **부재**로 답한다. */
  const coexistenceRunner = (): GitRunner & { seen: string[][] } => {
    const seen: string[][] = []
    const oid = 'a'.repeat(40)
    return {
      seen,
      run: (args) => {
        seen.push(args)
        if (args[0] === 'for-each-ref') {
          return Promise.resolve({
            code: 0,
            stdout: `refs/fleet/integrated/BW\0${oid}\n${CHILD}\0${oid}\n`,
            stderr: '',
          })
        }
        if (args[0] === 'rev-parse') return Promise.resolve({ code: 1, stdout: '', stderr: '' })
        return Promise.resolve({ code: 0, stdout: '', stderr: '' })
      },
    }
  }

  it('열거는 결과 ref 를 답하고 원시 해소는 부재를 답한다 — `refExists` 는 열거를 따른다', async () => {
    const repo = createGitRepo('/nowhere', coexistenceRunner())
    expect(await repo.refExists(CHILD)).toEqual({ status: 'ok', exists: true })
    expect(await repo.revParse(CHILD)).toEqual({ status: 'absent' })
  })

  it('`refExists` 는 `rev-parse` 를 **호출하지 않는다**(구현 경로 falsifier)', async () => {
    const runner = coexistenceRunner()
    await createGitRepo('/nowhere', runner).refExists(CHILD)
    expect(runner.seen.map((a) => a[0])).toEqual(['for-each-ref'])
  })

  /**
   * **뮤테이션이 잡아낸 공백**: git 이 성공을 자칭했는데 디스크가 그 값을 답하지 못하는 상태가 실재한다
   * (win32 packed D/F — 발행한 ref 가 열거에서 사라지거나 다른 값으로 보인다). 왕복 검증이 없으면
   * 호출자는 「발행됨」을 믿고 저널을 `published` 로 전이시켜 **소비 불가능한 결과를 확정**한다.
   */
  it('발행 성공을 자칭해도 열거가 확인하지 못하면 실패다(왕복 검증)', async () => {
    const liar: GitRunner = {
      run: (args) =>
        args[0] === 'for-each-ref'
          ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) // 디스크는 그 ref 를 모른다
          : Promise.resolve({ code: 0, stdout: '', stderr: '' }), // update-ref 는 성공을 자칭
    }
    const res = await createGitRepo('/nowhere', liar).casUpdateRef(CHILD, 'a'.repeat(40), null)
    expect(res.status).toBe('failed')
    expect(res.status === 'failed' && res.stderr).toMatch(/왕복 검증/)
  })

  it('exact 일치만 존재로 센다 — 접두가 같은 이웃은 존재 근거가 아니다', async () => {
    const repo = createGitRepo('/nowhere', coexistenceRunner())
    // 러너는 `…/BW` 와 `…/BW/T1` 만 답한다. `…/BW/T2` 는 접두는 같지만 없는 ref 다.
    expect(await repo.refExists('refs/fleet/integrated/BW/T2')).toEqual({
      status: 'ok',
      exists: false,
    })
  })
})

describe('T11/§3-T25 — mergeTree: 충돌을 값으로 보고하고 git 상태를 바꾸지 않는다(실 git)', () => {
  let base = ''
  let clean: { repo: string; a: string; b: string }
  let conflict: { repo: string; a: string; b: string }

  beforeAll(() => {
    base = mkTmp()
    const r1 = initRepo(join(base, 'clean'))
    git(r1, 'checkout', '-q', '-b', 'bench')
    const b1 = commitFile(r1, 'b.txt', 'B\n', 'B')
    git(r1, 'checkout', '-q', 'main')
    const a1 = commitFile(r1, 'a.txt', 'A\n', 'A')
    clean = { repo: r1, a: a1, b: b1 }

    const r2 = initRepo(join(base, 'conflict'))
    git(r2, 'checkout', '-q', '-b', 'bench')
    const b2 = commitFile(r2, 'base.txt', 'l1\nBBB\nl3\n', 'B')
    git(r2, 'checkout', '-q', 'main')
    const a2 = commitFile(r2, 'base.txt', 'l1\nAAA\nl3\n', 'A')
    conflict = { repo: r2, a: a2, b: b2 }
  })

  it('충돌 없는 머지는 tree OID 를 답한다', async () => {
    const res = await createGitRepo(clean.repo, execRunner).mergeTree(clean.a, clean.b)
    expect(res.status).toBe('clean')
    expect(res.status === 'clean' && OID_RE.test(res.tree)).toBe(true)
  })

  it('충돌은 **값**이다 — tree + 충돌 파일 목록 · ref 변이 0 · sequencer 무생성', async () => {
    const before = {
      refs: git(conflict.repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
      head: git(conflict.repo, 'rev-parse', 'HEAD'),
      status: git(conflict.repo, 'status', '--porcelain'),
      gitdir: readdirSync(join(conflict.repo, '.git')).sort().join(','),
    }

    const res = await createGitRepo(conflict.repo, execRunner).mergeTree(conflict.a, conflict.b)
    expect(res.status).toBe('conflict')
    expect(res.status === 'conflict' && res.conflicts).toEqual(['base.txt'])
    expect(res.status === 'conflict' && OID_RE.test(res.tree)).toBe(true)

    // 「ref 변이 0 · working tree 무접촉 · sequencer 무생성」이 정확한 진술이다(오브젝트 DB 에는 쓴다).
    expect(git(conflict.repo, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(
      before.refs,
    )
    expect(git(conflict.repo, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(git(conflict.repo, 'status', '--porcelain')).toBe(before.status)
    expect(readdirSync(join(conflict.repo, '.git')).sort().join(',')).toBe(before.gitdir)
    for (const leftover of ['sequencer', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'AUTO_MERGE']) {
      expect(existsSync(join(conflict.repo, '.git', leftover))).toBe(false)
    }
  })

  /**
   * **F1 음성 통제** — 인자 오류도 **exit 1** 이다(실측 3면 공통). 종료코드로 충돌을 판정하는 구현은
   * 여기서 「충돌」을 답해 RED 가 된다. 이 행이 없으면 그 구현이 위 두 행을 그대로 통과한다.
   */
  it('인자 오류·없는 rev·무관 히스토리는 충돌이 아니라 실패다', async () => {
    const repo = createGitRepo(clean.repo, execRunner)
    const treeArg = git(clean.repo, 'rev-parse', 'main^{tree}')

    expect((await repo.mergeTree(treeArg, clean.b)).status).toBe('failed')
    expect((await repo.mergeTree('main', 'refs/heads/nope')).status).toBe('failed')

    const orphan = initRepo(join(base, 'orphan'))
    git(orphan, 'checkout', '-q', '--orphan', 'other')
    commitFile(orphan, 'o.txt', 'o\n', 'orphan')
    const unrelated = await createGitRepo(orphan, execRunner).mergeTree('main', 'other')
    expect(unrelated.status).toBe('failed')
  })

  /**
   * **Codex PR#268 2차 P1** — 러너는 취소·타임아웃·10MB 출력 상한에서 **부분 stdout 을 보존한 채
   * `code: null`** 을 돌려준다(`cli/detect.ts`). 「0 이 아니면 충돌」로 접으면 **중단된 연산이 「충돌로 끝난
   * 통합」으로 기록**된다 — 큰 충돌·취소가 정확히 그 경로다.
   */
  it('충돌은 **exit 1 뿐**이다 — 취소·상한 초과(`code: null`)는 실패로 남는다', async () => {
    const tree = 'a'.repeat(40)
    const truncated: GitRunner = {
      run: () => Promise.resolve({ code: null, stdout: `${tree}\nfile.txt\n`, stderr: '' }),
    }
    const weird: GitRunner = {
      run: () => Promise.resolve({ code: 137, stdout: `${tree}\nfile.txt\n`, stderr: '' }),
    }
    expect((await createGitRepo('/nowhere', truncated).mergeTree('a', 'b')).status).toBe('failed')
    expect((await createGitRepo('/nowhere', weird).mergeTree('a', 'b')).status).toBe('failed')
    // 대조군: 정상 충돌(exit 1)은 그대로 충돌이다.
    const real: GitRunner = {
      run: () => Promise.resolve({ code: 1, stdout: `${tree}\nfile.txt\n`, stderr: '' }),
    }
    const ok = await createGitRepo('/nowhere', real).mergeTree('a', 'b')
    expect(ok.status).toBe('conflict')
    expect(ok.status === 'conflict' && ok.conflicts).toEqual(['file.txt'])
  })

  it('`--merge-base` 를 쓰지 않는다 — 배포 런타임 git 2.39.5 에 없는 옵션이다(실측)', async () => {
    const runner = spyRunner()
    await createGitRepo(clean.repo, runner).mergeTree(clean.a, clean.b)
    expect(runner.seen.flat().some((a) => a.startsWith('--merge-base'))).toBe(false)
  })
})

describe('T11/§3-T27 — commitTree: 2-parent 결과가 소비자 ff-only 를 성립시킨다(실 git)', () => {
  it('결과 커밋은 bench **전체 스냅숏**이고 `merge --ff-only` 가 성립한다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    git(r, 'checkout', '-q', '-b', 'bench')
    const r1 = commitFile(r, 'r1.txt', 'r1\n', 'R1')
    const r2 = commitFile(r, 'r2.txt', 'r2\n', 'R2')
    git(r, 'checkout', '-q', 'main')
    const target = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)

    const merged = await repo.mergeTree(target, r2)
    expect(merged.status).toBe('clean')
    const tree = merged.status === 'clean' ? merged.tree : ''
    const commit = await repo.commitTree(tree, [target, r2], 'fleet: integration')
    expect(commit.status).toBe('ok')
    const resultOid = commit.status === 'ok' ? commit.oid : ''

    expect(await repo.casUpdateRef('refs/fleet/integrated/B/T1', resultOid, null)).toEqual({
      status: 'updated',
    })
    // 소비자 관점(우리가 하는 일이 아니다 — 소비자 명령이 성립함을 증명한다).
    git(r, 'merge', '--ff-only', 'refs/fleet/integrated/B/T1')
    expect(git(r, 'rev-parse', 'HEAD')).toBe(resultOid)

    // **증분이 아니라 전체 스냅숏**: R1 을 건너뛰고 R2 만 적용해도 무손실이어야 하므로 두 파일이 다 있다.
    expect(existsSync(join(r, 'r1.txt'))).toBe(true)
    expect(existsSync(join(r, 'r2.txt'))).toBe(true)
    // ff-only 성공만으로는 증분 구현도 통과한다 — 트리 동일성까지 고정한다.
    expect(git(r, 'rev-parse', 'HEAD^{tree}')).toBe(
      git(r, 'rev-parse', `${r1}^{tree}`) === tree ? tree : tree,
    )
    expect(git(r, 'cat-file', '-p', resultOid)).toContain(`parent ${target}`)
    expect(git(r, 'cat-file', '-p', resultOid)).toContain(`parent ${r2}`)
  })
})

describe('T11/§3-T28 근거 — isAncestor 는 3값이다(오류를 «비조상» 으로 접지 않는다)', () => {
  it('조상·비조상·자기 자신·해소 불가를 구분한다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c1 = git(r, 'rev-parse', 'HEAD')
    const c2 = commitFile(r, 'q.txt', 'q\n', 'q')
    const repo = createGitRepo(r, execRunner)

    expect(await repo.isAncestor(c1, c2)).toEqual({ status: 'yes' })
    expect(await repo.isAncestor(c2, c1)).toEqual({ status: 'no' })
    expect(await repo.isAncestor(c1, c1)).toEqual({ status: 'yes' })
    // 없는 OID 는 exit 128 이다(실측). `false` 로 접으면 「완결 안 됨」으로 조용히 오분류된다.
    expect((await repo.isAncestor('0'.repeat(40), c1)).status).toBe('failed')
  })
})

describe('T11/§3-T26 — 능력 프로브: 폴백 경로가 없다', () => {
  it('실 git(≥2.38)에서는 지원으로 판정한다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    expect(await createGitRepo(r, execRunner).probeMergeTree()).toEqual({ supported: true })
  })

  /**
   * **CodeRabbit PR#268** — 프로브는 `HEAD` 를 인자로 쓰므로 **커밋이 없는 레포**에서는 git 이 ≥2.38 이어도
   * exit 128 이 난다. 그것을 「미지원」으로 접으면 폴백 없는 계약상 통합이 **영구 비활성**되는데 원인이
   * 값에 남지 않아 진단할 수 없다. 결과(비활성)는 같아도 **이유는 다른 사실**이므로 구분해 답한다.
   */
  it('커밋 없는 레포(unborn HEAD)는 «미지원» 이 아니라 «판정 불가» 다', async () => {
    const dir = join(mkTmp(), 'empty')
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main', '.')

    const res = await createGitRepo(dir, execRunner).probeMergeTree()
    expect(res.supported).toBe(false)
    expect(res.supported === false && res.reason).toBe('indeterminate')
    // 진단 가능해야 한다 — 원인 문면이 값에 실린다.
    expect(res.supported === false && res.stderr.length).toBeGreaterThan(0)
  })

  /**
   * pre-2.38 은 `--write-tree` 를 **rev 로 해석**해 `fatal: unknown rev --write-tree`(exit 128)를 낸다
   * (2.30.2 실측). CI 러너의 git 버전에 의존하지 않도록 **주입 러너로 그 응답을 재현**한다 —
   * 실 git 만으로 조작화하면 신버전 CI 에서 이 행이 영원히 무신호다.
   */
  it('pre-2.38 응답에서는 미지원으로 판정하고 통합 경로를 호출하지 않는다', async () => {
    const seen: string[][] = []
    const oldGit: GitRunner = {
      run: (args) => {
        seen.push(args)
        if (args[0] === 'merge-tree')
          return Promise.resolve({
            code: 128,
            stdout: '',
            stderr: 'fatal: unknown rev --write-tree\n',
          })
        return Promise.resolve({ code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' })
      },
    }
    const repo = createGitRepo('/nowhere', oldGit)
    const res = await repo.probeMergeTree()
    expect(res.supported).toBe(false)
    // pre-2.38 은 **버전에 대한 증거**다 — `indeterminate` 와 구분된다.
    expect(res.supported === false && res.reason).toBe('unsupported')
    // 폴백(squash 등) 두 번째 구현 경로가 없다는 것이 계약이다.
    expect(seen.some((a) => a.includes('merge') && !a.includes('merge-tree'))).toBe(false)
  })

  it('exit 0 이어도 첫 줄이 OID 가 아니면 미지원이다(구형 git 의 옵션 에코 방어)', async () => {
    const echoGit: GitRunner = {
      run: () => Promise.resolve({ code: 0, stdout: '--write-tree\n', stderr: '' }),
    }
    const echoed = await createGitRepo('/nowhere', echoGit).probeMergeTree()
    expect(echoed.supported).toBe(false)
    expect(echoed.supported === false && echoed.reason).toBe('unsupported')
  })
})

describe('T11 — worktree 3메서드(실 git · §W-9 종료코드 실측)', () => {
  it('named worktree 를 만들고, 브랜치 중복·디렉터리 선점을 구분해 값으로 답한다', async () => {
    const base = mkTmp()
    const r = initRepo(join(base, 'repo'))
    const repo = createGitRepo(r, execRunner)

    expect(await repo.addNamedWorktree(join(base, 'wt-ok'), 'fleet/ok', 'HEAD')).toEqual({
      status: 'ok',
    })
    expect(git(r, 'rev-parse', '--verify', 'refs/heads/fleet/ok')).toBeTruthy()

    // 브랜치 중복 = exit 255 · 디렉터리 미생성 · 잔재 없음(실측).
    const dup = await repo.addNamedWorktree(join(base, 'wt-dup'), 'fleet/ok', 'HEAD')
    expect(dup.status).toBe('failed')
    expect(existsSync(join(base, 'wt-dup'))).toBe(false)

    // 디렉터리 선점(비어있지 않음) = exit 128 · **브랜치는 남는다**(고아 · §W-9).
    const taken = join(base, 'wt-taken')
    mkdirSync(taken, { recursive: true })
    writeFileSync(join(taken, 'squatter.txt'), 'x')
    const occupied = await repo.addNamedWorktree(taken, 'fleet/orphan', 'HEAD')
    expect(occupied.status).toBe('failed')
    expect(git(r, 'rev-parse', '--verify', 'refs/heads/fleet/orphan')).toBeTruthy()
  })

  it('detached worktree 추가·제거가 값으로 답한다', async () => {
    const base = mkTmp()
    const r = initRepo(join(base, 'repo'))
    const repo = createGitRepo(r, execRunner)
    const dir = join(base, 'wt-detached')

    expect(await repo.addDetachedWorktreeAt(dir, 'HEAD')).toEqual({ status: 'ok' })
    expect(existsSync(join(dir, 'base.txt'))).toBe(true)

    // 더러운 worktree 는 `force=false` 면 거부된다(실측 128) — 강제 여부가 호출자 결정임을 고정한다.
    writeFileSync(join(dir, 'dirty.txt'), 'd')
    expect((await repo.removeWorktreeAt(dir, false)).status).toBe('failed')
    expect(await repo.removeWorktreeAt(dir, true)).toEqual({ status: 'ok' })
    expect(existsSync(dir)).toBe(false)
  })
})

describe('T12/§3-T58 — R-5: 신규 연산은 남의 락을 지우지 않는다(실 git)', () => {
  /**
   * **실측이 정한 조작화**(원안 「index.lock 으로 실패시킨다」는 성립하지 않는다 — 3면 전부 exit 0):
   * 대상 ref 의 `.lock` 을 선점하면 `update-ref` 가 exit 128 + 레거시 `LOCK_RE` 와 매칭되는 stderr 를 낸다.
   * 그 실패를 `ok()` 로 감싸면 2회차부터 **무관한 `index.lock`** 을 지운다(오조준) — 그것이 R-5 가 막는 것이다.
   */
  it('ref `.lock` 경합에서 무관한 index.lock 을 보존하고 유계 재시도 후 값으로 실패한다', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const REF = 'refs/fleet/integrated/BL/T1'
    const refLock = `${join(r, '.git', ...REF.split('/'))}.lock`
    mkdirSync(dirname(refLock), { recursive: true })
    writeFileSync(refLock, `${c}\n`)
    const foreignIndexLock = join(r, '.git', 'index.lock')
    writeFileSync(foreignIndexLock, '')

    const runner = spyRunner()
    const res = await createGitRepo(r, runner).casUpdateRef(REF, c, null)

    expect(res.status).toBe('failed')
    // ⓐ 오조준 삭제 0 — `ok()` 위임 구현이면 이 파일이 사라진다.
    expect(existsSync(foreignIndexLock)).toBe(true)
    // ⓑ 경합 파일 자체도 건드리지 않는다.
    expect(existsSync(refLock)).toBe(true)
    // ⓒ 유계 재시도 — 1회로 끝내지도, 무한히 돌지도 않는다.
    const updateRefCalls = runner.seen.filter((a) => a[0] === 'update-ref').length
    expect(updateRefCalls).toBeGreaterThan(1)
    expect(updateRefCalls).toBeLessThanOrEqual(4)
  })

  /**
   * **백오프 스케줄을 고정한다**(PR2c 정정 107 의 직접 승계). 이 행이 없으면 「대기 0ms」·「순서 역전」·
   * 「고정값」 구현이 위 행을 전부 GREEN 으로 통과하고, 재시도의 존재 이유(상대가 락을 놓기를 기다리는
   * 시간 창)가 미검증 출하된다.
   */
  it('재시도 대기가 `REF_LOCK_BACKOFF_MS` 와 정확히 일치한다(주입 sleep 관측)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const c = git(r, 'rev-parse', 'HEAD')
    const REF = 'refs/fleet/integrated/BS/T1'
    const refLock = `${join(r, '.git', ...REF.split('/'))}.lock`
    mkdirSync(dirname(refLock), { recursive: true })
    writeFileSync(refLock, `${c}\n`)

    const waited: number[] = []
    const repo = createGitRepo(r, execRunner, {
      sleep: (ms) => {
        waited.push(ms)
        return Promise.resolve()
      },
    })
    expect((await repo.casUpdateRef(REF, c, null)).status).toBe('failed')
    // ⚠ **리터럴로 고정한다.** 상수와만 대조하면 「상수를 `[]` 로」 뮤턴트가 양쪽을 함께 바꿔 통과한다
    //   (PR2c 가 백오프에서 겪은 것과 같은 함정 — 관측면이 검증 대상과 같은 출처면 안 된다).
    expect(waited).toEqual([10, 20, 40])
    expect([...REF_LOCK_BACKOFF_MS]).toEqual([10, 20, 40])
  })

  it('락 경합이 아닌 실패는 재시도하지 않는다(재시도 범위 falsifier)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const waited: number[] = []
    const runner = spyRunner()
    const repo = createGitRepo(r, runner, {
      sleep: (ms) => {
        waited.push(ms)
        return Promise.resolve()
      },
    })
    // 존재하지 않는 객체 = 영구 실패다. 「모든 실패를 재시도」 구현이면 여기서 대기가 기록된다.
    expect(
      (await repo.casUpdateRef('refs/fleet/integrated/BQ/T1', 'c'.repeat(40), null)).status,
    ).toBe('failed')
    expect(waited).toEqual([])
    expect(runner.seen.filter((a) => a[0] === 'update-ref')).toHaveLength(1)
  })

  it('신규 표면은 `ok()`(락 강제 삭제 헬퍼)를 쓰지 않는다 — G-1 구조 핀', async () => {
    const body = createGitRepo.toString()
    // 자기검사 앵커: **두 술어 모두** 실제로 매칭되는지 먼저 확인한다(패턴이 오타로 죽으면 핀도 조용히
    // 죽는다 — 자가 적대 리뷰 SR-C6 이 두 번째 술어에 앵커가 없던 것을 적발했다).
    expect(/\bok\(/.test("const x = ok(['status'])")).toBe(true)
    expect(/rmSync|unlinkSync|existsSync/.test('rmSync(lock); existsSync(p)')).toBe(true)
    expect(/\bok\(/.test(body)).toBe(false)
    // `rmSync`·`unlink` 계열이 신규 표면에 유입되면 「삭제 없는 백오프」가 무너진다.
    expect(/rmSync|unlinkSync|existsSync/.test(body)).toBe(false)
  })

  /**
   * **자가 적대 리뷰 SR-C4** — 재시도 래퍼가 worktree 3메서드에도 배선돼 있는데 그 배선을 검증하는 행이
   * 없었다(그 3곳을 `run` 으로 되돌리는 뮤턴트가 전 스위트를 GREEN 으로 통과한다). 실측 F4 가 확인한
   * 「`worktree add -b` 는 ref `.lock` 경합에서 실패하고 그 stderr 가 락 문면을 낸다」를 그대로 쓴다.
   */
  it('worktree 변이도 같은 재시도를 탄다 — ref `.lock` 경합에서 유계 백오프 후 값 실패', async () => {
    const base = mkTmp()
    const r = initRepo(join(base, 'repo'))
    const refLock = join(r, '.git', 'refs', 'heads', 'fleet', 'z.lock')
    mkdirSync(dirname(refLock), { recursive: true })
    writeFileSync(refLock, `${git(r, 'rev-parse', 'HEAD')}\n`)
    const foreignIndexLock = join(r, '.git', 'index.lock')
    writeFileSync(foreignIndexLock, '')

    const waited: number[] = []
    const repo = createGitRepo(r, execRunner, {
      sleep: (ms) => {
        waited.push(ms)
        return Promise.resolve()
      },
    })
    const res = await repo.addNamedWorktree(join(base, 'wt'), 'fleet/z', 'HEAD')

    expect(res.status).toBe('failed')
    expect(waited).toEqual([10, 20, 40])
    expect(existsSync(foreignIndexLock)).toBe(true) // 오조준 삭제 0
    expect(existsSync(refLock)).toBe(true)
    // **재시도 멱등성의 근거**(CodeRabbit PR#268): ref 락 경합은 **산출물이 만들어지기 전에** 실패한다 —
    // 워크트리 디렉터리도 브랜치도 남지 않으므로 재시도가 「이미 존재」로 자기잠금되지 않는다(실측).
    expect(existsSync(join(base, 'wt'))).toBe(false)
    expect((await createGitRepo(r, execRunner).revParse('refs/heads/fleet/z')).status).toBe(
      'absent',
    )
  })

  /**
   * **CodeRabbit PR#268** — 스펙 §W-6 은 「`signal` 을 전 신규 연산에 관통」을 요구하는데 배선이 없었다.
   * 러너에 실제로 전달되는지 + **재시도 도중 취소가 즉시 반영되는지** 두 축을 고정한다.
   */
  it('`signal` 이 러너로 관통하고 재시도 루프가 취소를 존중한다', async () => {
    const seenSignals: (AbortSignal | undefined)[] = []
    const controller = new AbortController()
    const waited: number[] = []
    const contended: GitRunner = {
      run: (_args, _cwd, signal) => {
        seenSignals.push(signal)
        return Promise.resolve({
          code: 128,
          stdout: '',
          stderr:
            "fatal: cannot lock ref 'refs/x': Unable to create '/x.lock': File exists.\n\nAnother git process seems to be running\n",
        })
      },
    }
    const repo = createGitRepo('/nowhere', contended, {
      signal: controller.signal,
      sleep: (ms) => {
        waited.push(ms)
        controller.abort() // 첫 백오프 뒤 취소된다
        return Promise.resolve()
      },
    })
    const res = await repo.casUpdateRef('refs/fleet/integrated/B/T1', 'a'.repeat(40), null)

    expect(res.status).toBe('failed')
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true)
    // 취소 후에는 더 자지 않는다 — 3회 예정이던 백오프가 1회에서 멈춘다.
    expect(waited).toEqual([10])
  })

  /**
   * **자가 적대 리뷰 SR-F1** — git 은 lockfile 실패를 `Unable to create '<path>.lock': <strerror>` 라는
   * 같은 관용 포맷으로 내며 `Permission denied` 같은 **영구 실패**도 그 형태다. 경합만 재시도해야 한다.
   */
  it('영구 I/O 실패(Permission denied)는 재시도하지 않는다', async () => {
    const waited: number[] = []
    let calls = 0
    const permanent: GitRunner = {
      run: () => {
        calls++
        return Promise.resolve({
          code: 128,
          stdout: '',
          stderr:
            "fatal: cannot lock ref 'refs/fleet/integrated/B/T1': Unable to create '/x/.git/refs/fleet/integrated/B/T1.lock': Permission denied\n",
        })
      },
    }
    const repo = createGitRepo('/nowhere', permanent, {
      sleep: (ms) => {
        waited.push(ms)
        return Promise.resolve()
      },
    })
    expect(
      (await repo.casUpdateRef('refs/fleet/integrated/B/T1', 'a'.repeat(40), null)).status,
    ).toBe('failed')
    expect(waited).toEqual([])
    expect(calls).toBe(2) // update-ref 1회 + 실패 후 값 재조회 1회 — 재시도는 0
  })
})

/**
 * **자가 적대 리뷰 SR-C1·C2·C3·C5** — 어떤 테스트로도 실행되지 않던 성공·실패 분기들.
 * 「도달하지 않는 분기」는 뮤턴트가 살아 있는 자리이므로 도달시켜 고정한다.
 */
describe('T11 — 미도달 분기 고정(실패 채널 전수)', () => {
  it('revParse 는 성공·부재·실패 3값을 모두 답한다', async () => {
    const base = mkTmp()
    const r = initRepo(join(base, 'repo'))
    const head = git(r, 'rev-parse', 'HEAD')
    const repo = createGitRepo(r, execRunner)

    expect(await repo.revParse('HEAD')).toEqual({ status: 'ok', oid: head })
    expect(await repo.revParse('refs/heads/nope')).toEqual({ status: 'absent' })
    // 레포가 아니면 **부재가 아니라 실패**다 — 뭉개면 「없는 ref」와 「못 본 레포」가 구분되지 않는다.
    expect((await createGitRepo(base, execRunner).revParse('HEAD')).status).toBe('failed')
  })

  it('commitTree·addDetachedWorktreeAt·refExists 의 실패 채널이 값으로 온다', async () => {
    const base = mkTmp()
    const r = initRepo(join(base, 'repo'))
    const repo = createGitRepo(r, execRunner)

    expect((await repo.commitTree('f'.repeat(40), [], 'x')).status).toBe('failed')

    const taken = join(base, 'taken')
    mkdirSync(taken, { recursive: true })
    writeFileSync(join(taken, 'x'), 'x')
    expect((await repo.addDetachedWorktreeAt(taken, 'HEAD')).status).toBe('failed')

    expect((await createGitRepo(base, execRunner).refExists('refs/fleet/x')).status).toBe('failed')
  })

  /**
   * **자가 적대 리뷰 SR-D2** — 왕복 검증의 두 실패는 **다른 사실**이다: ⓐ열거에 없다(유령 성공)
   * ⓑ다른 값이다(제3자가 그 ref 를 썼다). 한 문면으로 뭉개면 운영자가 원인을 가릴 수 없고,
   * 「내 쓰기가 실패했다」는 ⓑ에서 **정확하지 않은 서술**이다(git 층에서는 성공했다).
   */
  it('왕복 검증 실패는 유령 성공과 제3자 개입을 구분해 보고한다', async () => {
    const mine = 'a'.repeat(40)
    const theirs = 'b'.repeat(40)
    const phantom: GitRunner = {
      run: (args) =>
        Promise.resolve({ code: 0, stdout: args[0] === 'for-each-ref' ? '' : '', stderr: '' }),
    }
    const hijacked: GitRunner = {
      run: (args) =>
        Promise.resolve({
          code: 0,
          stdout: args[0] === 'for-each-ref' ? `refs/fleet/integrated/B/T1\0${theirs}\n` : '',
          stderr: '',
        }),
    }
    const a = await createGitRepo('/nowhere', phantom).casUpdateRef(
      'refs/fleet/integrated/B/T1',
      mine,
      null,
    )
    const b = await createGitRepo('/nowhere', hijacked).casUpdateRef(
      'refs/fleet/integrated/B/T1',
      mine,
      null,
    )
    expect(a.status).toBe('failed')
    expect(a.status === 'failed' && a.stderr).toMatch(/유령 성공/)
    expect(b.status).toBe('failed')
    expect(b.status === 'failed' && b.stderr).toMatch(/제3자 개입/)
    expect(b.status === 'failed' && b.stderr).toContain(theirs)
  })

  /**
   * **자가 적대 리뷰 SR-D3** — 신규 11메서드가 전부 주입 러너로만 검증돼, **미주입 경로**
   * (`defaultGitRunner` → `defaultRunner` 의 win32 PATH 해석·cwd 섀도 가드)를 한 번도 타지 않았다.
   * 형제 파일은 `commonGitDir` 에만 그 행을 갖는다.
   */
  it('러너 미주입 시에도 신규 연산이 동작한다(defaultGitRunner 경로)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const repo = createGitRepo(r) // ← 주입 없음
    const head = git(r, 'rev-parse', 'HEAD')

    expect(await repo.revParse('HEAD')).toEqual({ status: 'ok', oid: head })
    expect(await repo.casUpdateRef('refs/fleet/integrated/BD/T1', head, null)).toEqual({
      status: 'updated',
    })
    const listed = await repo.listRefs('refs/fleet/integrated/BD')
    expect(listed.status === 'ok' && listed.refs.map((x) => x.ref)).toEqual([
      'refs/fleet/integrated/BD/T1',
    ])
  })

  it('재조회 자체가 실패하면 CAS 도 실패다(거짓 `rejected` 를 만들지 않는다)', async () => {
    const broken: GitRunner = {
      run: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    }
    const res = await createGitRepo('/nowhere', broken).casUpdateRef(
      'refs/fleet/integrated/B/T1',
      'a'.repeat(40),
      null,
    )
    expect(res.status).toBe('failed')
  })

  /**
   * **실증 라운드 이식**(#251 PR3a · 스크래치패드 e2e 는 CI 에서 돌지 않으므로 회귀 가드가 아니다).
   *
   * 잔재의 출처를 **우리가 만든 파일이 아니라 죽은 프로세스**로 만든다: `reference-transaction` 훅(git ≥2.28)은
   * **락을 쥔 prepared 상태**에서 호출되므로, 거기서 잠든 git 을 SIGKILL 하면 진짜 크래시 잔재가 남는다.
   *
   * ⚠ 이 행이 고정하는 것은 「우리가 안전하다」가 아니라 **운영상 한계**다: 스테일 ref 락은 **아무도
   * 치우지 않으므로**(R-5 가 삭제를 금지했고 git 도 스스로 치우지 않는다) 그 txn ref 는 **사람이 지울
   * 때까지 영구 고착**된다. fail-closed 라 손상은 없지만 자동 회복도 없다 — 회수/관측은 PR3b 소관이다.
   */
  it('실 프로세스 급사가 남긴 ref 락 잔재 — fail-closed · 영구 고착 · 제거 시 회복(실증 이식)', async () => {
    const r = initRepo(join(mkTmp(), 'repo'))
    const head = git(r, 'rev-parse', 'HEAD')
    const REF = 'refs/fleet/integrated/BC/T1'
    const lockPath = `${join(r, '.git', ...REF.split('/'))}.lock`

    // ⚠ **락 파일 존재를 신호로 쓰지 않는다**: 락은 정상 트랜잭션 도중에도 잠깐 존재하므로, 그것만 보고
    //   SIGKILL 하면 「이미 끝난 트랜잭션을 죽이는」 판이 섞여 **flake** 가 된다(초판이 2/4 로 흔들렸다).
    //   훅이 **prepared 진입을 스스로 증언**하도록 마커를 쓰게 하고, 그 마커를 사건 순서의 기준으로 삼는다.
    const marker = join(r, '.git', 'prepared.marker')
    const hook = join(r, '.git', 'hooks', 'reference-transaction')
    mkdirSync(dirname(hook), { recursive: true })
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ "$1" = "prepared" ]; then : > '${marker.replace(/\\/g, '/')}'; sleep 60; fi\n`,
    )
    chmodSync(hook, 0o755)

    const child = spawn('git', ['update-ref', REF, head, ''], { cwd: r, stdio: 'ignore' })
    let prepared = false
    for (let i = 0; i < 200; i++) {
      if (existsSync(marker) && existsSync(lockPath)) {
        prepared = true
        break
      }
      await new Promise((res) => setTimeout(res, 25))
    }
    child.kill('SIGKILL')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')

    if (!prepared) {
      // 훅이 돌지 않는 환경(POSIX 셸 부재 등)에서는 이 시나리오 자체를 만들 수 없다. **조용히 통과시키지
      // 않는다** — 왜 못 만들었는지를 단언으로 남긴다(마커 부재 = 훅 미실행).
      expect(existsSync(marker)).toBe(false)
      return
    }
    await new Promise((res) => setTimeout(res, 200))
    expect(existsSync(lockPath)).toBe(true) // 죽은 프로세스가 남긴 잔재
    expect(git(r, 'for-each-ref', '--format=%(refname)', 'refs/fleet/')).toBe('') // 발행되지 않았다

    const waited: number[] = []
    const repo = createGitRepo(r, execRunner, {
      sleep: (ms) => {
        waited.push(ms)
        return Promise.resolve()
      },
    })
    expect((await repo.casUpdateRef(REF, head, null)).status).toBe('failed')
    expect(waited).toEqual([10, 20, 40])
    expect(existsSync(lockPath)).toBe(true) // 남의 잔재를 지우지 않는다
    // **영구 고착**: 재시도로 풀리지 않는다(이 사실이 계약이고, 자동 회수는 PR3b 다).
    expect((await repo.casUpdateRef(REF, head, null)).status).toBe('failed')
    // 잔재와 무관하게 열거는 계속 답한다(`.lock` 은 ref 가 아니다).
    expect(await repo.listRefs('refs/fleet/integrated/BC')).toEqual({ status: 'ok', refs: [] })

    // 음성 통제 — 잔재를 치우면 즉시 발행된다(고착 원인이 락 잔재임의 증명).
    rmSync(lockPath, { force: true })
    expect(await repo.casUpdateRef(REF, head, null)).toEqual({ status: 'updated' })
  })

  it('레거시 `createWorkspace` 경로는 무변경이다 — R-5 는 신규 연산 한정(회귀 핀)', async () => {
    const mod = await import('./git')
    const src = mod.createWorkspace.toString()
    // 레거시 헬퍼가 그대로 남아 있음을 고정한다(전환하면 revert 단위가 오염되고, 실측상 이득이 0이다:
    // `worktree add --detach`/`remove --force` 는 5종 락 선점 전부에서 성공해 `ok()` 의 삭제가 도달 불가다).
    expect(src.includes('ok(')).toBe(true)
  })
})

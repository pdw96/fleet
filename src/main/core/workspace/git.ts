import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultRunner } from '../cli/detect'
import {
  captureIgnoredBaseline as captureIgnored,
  collectIgnoredChanges as collectIgnored,
  restoreIgnoredBaseline as restoreIgnored,
  DEFAULT_IGNORED_POLICY,
  type IgnoredBaseline,
  type IgnoredChangeSet,
} from './ignored-baseline'

/**
 * 두 경로가 같은 위치를 가리키는지 비교한다.
 * Windows 대소문자 무시 + 구분자(\\ vs /)·끝 슬래시 차이를 정규화한다.
 * (`git rev-parse --show-toplevel` 은 슬래시(/) 절대경로를 돌려준다.)
 */
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string =>
    resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}
export interface GitRunner {
  run(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult>
}
export interface DiffResult {
  files: string[]
  patch: string
  truncated: boolean
}

/** 편집 에이전트(codex 등)의 자체 git 작업이 남긴 index.lock 경합 패턴. */
const LOCK_RE = /index\.lock|Another git process/i
const LOCK_RETRIES = 4
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type TaskWorktree = Workspace & { path: string }

export interface Workspace {
  ensureRepo(): Promise<void>
  checkpoint(): Promise<string>
  collectDiff(base: string): Promise<DiffResult>
  keep(message: string): Promise<string>
  revert(base: string): Promise<void>
  addWorktree(taskId: string, base: string): Promise<TaskWorktree>
  integrate(keepCommit: string): Promise<{ ok: boolean; conflict?: string }>
  removeWorktree(taskId: string): Promise<void>
  captureIgnoredBaseline(): Promise<IgnoredBaseline>
  collectIgnoredChanges(baseline: IgnoredBaseline): Promise<IgnoredChangeSet>
  restoreIgnoredBaseline(baseline: IgnoredBaseline): Promise<{ capped: boolean }>
}

const GIT_TIMEOUT_MS = 120_000
const DIFF_CAP = 60_000

/**
 * git 러너 팩토리(#197-B6 T3). `baseEnv` 를 주면 git 자식(훅 등)에 그 env 를 적용해 서버 시크릿(FLEET_*)이
 * 상속되지 않게 한다. **미주입이면 현행처럼 부모 env 상속**(무회귀). 서버 모드에서 engine 이 childEnv.base 주입.
 */
export function createGitRunner(baseEnv?: () => NodeJS.ProcessEnv): GitRunner {
  return {
    run: (args, cwd, signal) =>
      defaultRunner('git', args, { timeoutMs: GIT_TIMEOUT_MS, cwd, signal, env: baseEnv?.() }).then(
        (r) => ({ code: r.code, stdout: r.stdout, stderr: r.stderr }),
      ),
  }
}

/** 기본 git 러너 — env 미지정(현행 상속). 서버 격리는 createGitRunner(baseEnv) 로 주입. */
export const defaultGitRunner: GitRunner = createGitRunner()

/**
 * 레포 스코프 git 표면(#251 · 스펙 §W-6). `Workspace`(워크트리 스코프 · 체크포인트/diff/통합)와 달리
 * **레포 전체에 하나뿐인 사실**(공통 gitdir · worktree 목록)을 답한다.
 *
 * 신규 표면인 이유(§0.1 C12): `Workspace` 는 worktree 경로를 **내부 유도**하고 디렉터리 인자를 받지
 * 않아 named-branch worktree 를 재사용할 수 없다. 기존 export 는 **무변경**이고 여기에 추가만 한다.
 *
 * ⚠ `ok()` 를 쓰지 않는다(R-5 · §3-T58). `ok()` 의 index.lock 강제 삭제는 "오케스트레이터는 순차 실행"
 * 이라는 전제 위에 있는데, bench 병렬에서는 그 전제가 깨진다 — 남의 라이브 락을 지우게 된다.
 */
export type GitRepoDirResult =
  | { status: 'ok'; path: string; bare: boolean }
  | { status: 'failed'; stderr: string; code: number | null }

export interface WorktreeEntry {
  path: string
  head?: string
  /** 정준 ref(`refs/heads/…`). detached 면 부재. */
  branch?: string
  detached: boolean
  bare: boolean
  locked: boolean
  /** admin 레코드는 있는데 디렉터리가 없음 — **표시만** 하고 자동 정리하지 않는다. */
  prunable: boolean
}

export type GitWorktreeListResult =
  | { status: 'ok'; worktrees: WorktreeEntry[] }
  | { status: 'failed'; stderr: string; code: number | null }

export interface GitRepo {
  /** `<canonical common gitdir>` — 코디네이션 영역(§W-2)의 부모. 5형태에서 동일 값으로 수렴한다. */
  commonGitDir(): Promise<GitRepoDirResult>
  listWorktrees(): Promise<GitWorktreeListResult>
}

/** porcelain 은 `키 값` 한 줄 + 빈 줄 구분. 값에 공백이 있을 수 있어 **첫 공백 하나로만** 자른다. */
const parseWorktreePorcelain = (stdout: string): WorktreeEntry[] => {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | undefined
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      if (cur) out.push(cur)
      cur = undefined
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const value = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'worktree') {
      cur = { path: resolve(value), detached: false, bare: false, locked: false, prunable: false }
      continue
    }
    if (!cur) continue
    if (key === 'HEAD') cur.head = value
    else if (key === 'branch') cur.branch = value
    else if (key === 'detached') cur.detached = true
    else if (key === 'bare') cur.bare = true
    else if (key === 'locked') cur.locked = true
    else if (key === 'prunable') cur.prunable = true
  }
  if (cur) out.push(cur)
  return out
}

export function createGitRepo(root: string, git: GitRunner = defaultGitRunner): GitRepo {
  const run = (args: string[]): Promise<GitResult> => git.run(args, root)
  const failed = (r: GitResult): { status: 'failed'; stderr: string; code: number | null } => ({
    status: 'failed',
    stderr: r.stderr.trim() || `git 실패(code ${r.code})`,
    code: r.code,
  })
  return {
    async commonGitDir() {
      // `--path-format=absolute`(git ≥2.31)가 핵심이다 — 없으면 메인 worktree 가 상대 `.git` 을,
      // bare 가 `.` 을 돌려준다. 그럼에도 출력이 상대일 수 있는 구형 git 을 위해 **root 기준**으로
      // 해소한다(process.cwd() 기준으로 해소하면 **남의 레포**에 영역을 만든다 — §3-T6).
      // `rev-parse` 는 다중 질의를 **한 번에** 답한다(출력 = 질의 순서대로 한 줄씩) — 프로세스 스폰을
      // 절반으로 줄인다. win32 에서 매 spawn 은 PATH 해석(2s 캡·캐시 없음 · `cli/detect.ts:234`)을
      // 동반하므로 이 절약은 부하 상황의 신뢰도에 직접 기여한다.
      const r = await run([
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
        '--is-bare-repository',
      ])
      const [dirLine, bareLine] = r.stdout.split(/\r?\n/)
      const raw = dirLine?.trim() ?? ''
      const bare = bareLine?.trim() ?? ''
      if (r.code !== 0 || raw === '') return failed(r)
      // ⚠ **git <2.31 은 미지 옵션을 stdout 으로 에코하고 exit 0 한다**(실측: `git rev-parse
      // --totally-unknown-flag` → stdout `--totally-unknown-flag`, exit 0). 그 git 에서는 첫 줄이
      // `--path-format=absolute` 가 되어, 그대로 해소하면 코디네이션 영역을 `<root>/--path-format=absolute`
      // 같은 **엉뚱한 경로**에 만든다. 출력 형식을 검증해 **fail-closed** 한다 — 폴백 경로는 두지 않는다
      // (구버전에서 조용히 다른 좌표계로 도는 것보다 기능이 꺼지는 편이 안전하다).
      if (raw.startsWith('-') || (bare !== 'true' && bare !== 'false')) {
        return {
          status: 'failed',
          stderr: `git rev-parse 출력이 예상 형식이 아님(git ≥2.31 필요): ${JSON.stringify(r.stdout.slice(0, 120))}`,
          code: r.code,
        }
      }
      return { status: 'ok', path: resolve(root, raw), bare: bare === 'true' }
    },
    async listWorktrees() {
      const r = await run(['worktree', 'list', '--porcelain'])
      if (r.code !== 0) return failed(r)
      return { status: 'ok', worktrees: parseWorktreePorcelain(r.stdout) }
    },
  }
}

// taskId 의 특수문자를 _로 치환해 디렉터리명으로 사용 가능하게 만든다.
const sanitize = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '_')
// worktree 디렉터리: 메인 레포 밖(임시)에 두어 collectDiff(add -A)·clean 대상에 안 잡히게 한다.
const worktreeDir = (root: string, id: string): string =>
  join(root, '..', `.fleet-wt-${sanitize(id)}`)

export function createWorkspace(root: string, git: GitRunner = defaultGitRunner): Workspace {
  const run = (args: string[]) => git.run(args, root)
  // 반드시 성공해야 하는 git 명령. index.lock 경합(편집 에이전트의 자체 git)에는
  // 백오프 재시도하고, 끈질긴 스테일 락은 제거한다 — 오케스트레이터는 순차 실행이라
  // 이 시점에 동시 git 프로세스가 없음이 보장된다(락 제거가 안전).
  // 락 파일 경로를 git 에 묻는다(linked worktree 는 <main>/.git/worktrees/<id>/index.lock).
  // 실패하면 기존 추정 경로로 폴백한다(일반 레포 루트 호환).
  const lockPath = async (): Promise<string> => {
    const r = await run(['rev-parse', '--git-path', 'index.lock'])
    return r.code === 0 && r.stdout.trim()
      ? resolve(root, r.stdout.trim())
      : join(root, '.git', 'index.lock')
  }

  const ok = async (args: string[]): Promise<GitResult> => {
    let last: GitResult | undefined
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      const r = await run(args)
      if (r.code === 0) return r
      last = r
      if (!LOCK_RE.test(r.stderr)) break // 락 외 에러는 재시도하지 않는다
      await wait(150 * (attempt + 1))
      const lock = await lockPath()
      if (attempt >= 1 && existsSync(lock)) {
        try {
          rmSync(lock)
        } catch {
          /* 다음 시도에서 재확인 */
        }
      }
    }
    throw new Error(`git ${args[0]} 실패(code ${last?.code ?? null}): ${last?.stderr.trim() ?? ''}`)
  }

  // Fleet 내부 체크포인트 커밋엔 명시적 아이덴티티를 준다(user.name/email 미설정 머신에서도 동작).
  const commit = (message: string): Promise<GitResult> =>
    ok([
      '-c',
      'user.name=Fleet',
      '-c',
      'user.email=fleet@local',
      'commit',
      '--allow-empty',
      '-m',
      message,
    ])

  return {
    async ensureRepo() {
      const top = await run(['rev-parse', '--show-toplevel'])
      if (!(top.code === 0 && samePath(top.stdout.trim(), root))) {
        // 레포가 아니거나, 상위 레포의 하위 디렉터리다 → 워크스페이스에 격리된 레포를 만든다
        // (상위 레포에 reset --hard/clean 이 영향을 주지 않도록).
        await ok(['init'])
        await ok(['add', '-A'])
        await commit('fleet: 초기 체크포인트')
        return
      }
      // 워크스페이스 자체가 레포 루트: HEAD 보장 + 사용자 미커밋 변경 스냅샷.
      // 커밋이 없을 수 있다(git init 후 미커밋). HEAD 없으면 초기 체크포인트 생성.
      const head = await run(['rev-parse', 'HEAD'])
      if (head.code !== 0) {
        await ok(['add', '-A'])
        await commit('fleet: 초기 체크포인트')
        return
      }
      // 이미 커밋이 있는 레포: 사용자의 미커밋 변경이 있으면 baseline 으로 스냅샷한다.
      // (이후 revert 가 사용자 작업을 지우지 않고, 작업 diff 도 에이전트 변경만 담게 한다.)
      const dirty = await run(['status', '--porcelain'])
      if (dirty.code === 0 && dirty.stdout.trim() !== '') {
        await ok(['add', '-A'])
        await commit('fleet: 시작 시점 스냅샷(사용자 미커밋 변경 보존)')
      }
    },
    async checkpoint() {
      const r = await ok(['rev-parse', 'HEAD'])
      return r.stdout.trim()
    },
    async collectDiff(base) {
      // 알려진 한계: `add -A` 는 .gitignore 된 경로를 스테이징하지 않는다 — gitignore 된 파일(예: 무시된 .env)에
      // 대한 에이전트 편집은 이 diff(및 위험 게이트)에 잡히지 않고 revert 의 `clean -ffd` 로도 지워지지 않는다(spec §알려진 한계).
      await ok(['add', '-A'])
      const names = await ok(['diff', '--cached', '--name-only', base])
      const files = names.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      const patchRes = await ok(['diff', '--cached', base])
      const truncated = patchRes.stdout.length > DIFF_CAP
      const patch = truncated
        ? `${patchRes.stdout.slice(0, DIFF_CAP)}\n…(diff 절단)`
        : patchRes.stdout
      return { files, patch, truncated }
    },
    async keep(message) {
      await ok(['add', '-A'])
      await commit(message)
      const r = await ok(['rev-parse', 'HEAD'])
      return r.stdout.trim()
    },
    async revert(base) {
      await ok(['reset', '--hard', base])
      // -ffd: 중첩 git 저장소도 제거한다(git 은 nested repo 제거에 -ff 를 요구).
      await ok(['clean', '-ffd'])
    },
    async addWorktree(taskId, base) {
      const wtPath = worktreeDir(root, taskId)
      await ok(['worktree', 'add', '--detach', wtPath, base])
      // worktree 전용 워크스페이스: 자체 .git(gitdir 파일)·자체 index 를 가지므로 createWorkspace 를 그 root 로 만든다.
      // ensureRepo 는 호출하지 않는다(이미 메인 레포의 linked worktree).
      const inner = createWorkspace(wtPath, git)
      return Object.assign(inner, { path: wtPath })
    },
    async integrate(keepCommit) {
      // 메인이 dirty 면 cherry-pick 이 실패하므로 사전 차단(메인은 보통 checkpoint HEAD 라 clean).
      const dirty = await run(['status', '--porcelain'])
      if (dirty.code === 0 && dirty.stdout.trim() !== '')
        return { ok: false, conflict: '메인 워크스페이스가 정리되지 않음(dirty) — 통합 보류' }
      // identity 명시(미설정 머신) + 빈 keep 커밋 허용(--allow-empty, 오래된 호환 옵션).
      // (P1 #2) --empty=drop 은 git 2.45+ 전용이라 구버전(2.43/2.44)에서 `error: unknown option` 으로
      //   모든 통합이 깨진다. Fleet 은 시스템 git 을 핀하지 않으므로 --empty=drop 을 쓰지 않는다.
      // ok() 의 index.lock 강제 제거는 외부 사용자 git 과 경합 위험이라 통합 경로에선 쓰지 않는다.
      const r = await run([
        '-c',
        'user.name=Fleet',
        '-c',
        'user.email=fleet@local',
        'cherry-pick',
        '--allow-empty',
        keepCommit,
      ])
      if (r.code === 0) return { ok: true }
      // (P1 #2) 빈/중복 cherry-pick 을 실제 CONFLICT 와 구분한다.
      // 두 작업이 같은 변경을 만들면 구버전 git 은 stop+에러("previous cherry-pick is now empty" /
      // "nothing to commit")를 낸다 — 변경은 이미 main 에 반영됐으므로 --skip 으로 진행 상태를 정리하고 성공 처리한다.
      // 실제 머지 충돌만 abort→실패로 보고한다.
      // 주의: empty 메시지엔 "possibly due to conflict resolution" 보일러플레이트가 들어가므로
      //   대소문자 무시 'conflict' 로 충돌을 판별하면 빈 케이스를 오분류한다.
      //   git 의 실제 충돌 마커는 대문자 `CONFLICT (...)` / `Merge conflict in` 형식이라 이걸로만 판별한다.
      const EMPTY_RE = /now empty|nothing to commit|empty commit/i
      const REAL_CONFLICT_RE = /CONFLICT \(|Merge conflict in/
      if (EMPTY_RE.test(r.stderr) && !REAL_CONFLICT_RE.test(r.stderr)) {
        await run(['cherry-pick', '--skip']) // 빈/중복 → 진행 상태 정리(이미 main 에 반영됨)
        return { ok: true }
      }
      await run(['cherry-pick', '--abort']) // 실제 충돌 → main HEAD 를 직전 상태로 복구
      return { ok: false, conflict: r.stderr.trim() || `cherry-pick 실패(code ${r.code})` }
    },
    async removeWorktree(taskId) {
      await ok(['worktree', 'remove', '--force', worktreeDir(root, taskId)])
    },
    async captureIgnoredBaseline() {
      return captureIgnored(root, git, DEFAULT_IGNORED_POLICY)
    },
    async collectIgnoredChanges(baseline) {
      return collectIgnored(root, git, baseline, DEFAULT_IGNORED_POLICY)
    },
    async restoreIgnoredBaseline(baseline) {
      return restoreIgnored(root, git, baseline, DEFAULT_IGNORED_POLICY)
    },
  }
}

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultRunner } from '../cli/detect'

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
}

const GIT_TIMEOUT_MS = 120_000
const DIFF_CAP = 60_000

export const defaultGitRunner: GitRunner = {
  run: (args, cwd, signal) =>
    defaultRunner('git', args, { timeoutMs: GIT_TIMEOUT_MS, cwd, signal }).then((r) => ({
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
    })),
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
  }
}

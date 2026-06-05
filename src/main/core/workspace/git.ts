import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultRunner } from '../cli/detect'

/**
 * 두 경로가 같은 위치를 가리키는지 비교한다.
 * Windows 대소문자 무시 + 구분자(\\ vs /)·끝 슬래시 차이를 정규화한다.
 * (`git rev-parse --show-toplevel` 은 슬래시(/) 절대경로를 돌려준다.)
 */
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export interface GitResult { code: number | null; stdout: string; stderr: string }
export interface GitRunner {
  run(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult>
}
export interface DiffResult { files: string[]; patch: string; truncated: boolean }

/** 편집 에이전트(codex 등)의 자체 git 작업이 남긴 index.lock 경합 패턴. */
const LOCK_RE = /index\.lock|Another git process/i
const LOCK_RETRIES = 4
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface Workspace {
  ensureRepo(): Promise<void>
  checkpoint(): Promise<string>
  collectDiff(base: string): Promise<DiffResult>
  keep(message: string): Promise<string>
  revert(base: string): Promise<void>
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

export function createWorkspace(root: string, git: GitRunner = defaultGitRunner): Workspace {
  const run = (args: string[]) => git.run(args, root)
  // 반드시 성공해야 하는 git 명령. index.lock 경합(편집 에이전트의 자체 git)에는
  // 백오프 재시도하고, 끈질긴 스테일 락은 제거한다 — 오케스트레이터는 순차 실행이라
  // 이 시점에 동시 git 프로세스가 없음이 보장된다(락 제거가 안전).
  const ok = async (args: string[]): Promise<GitResult> => {
    let last: GitResult | undefined
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      const r = await run(args)
      if (r.code === 0) return r
      last = r
      if (!LOCK_RE.test(r.stderr)) break // 락 외 에러는 재시도하지 않는다
      await wait(150 * (attempt + 1))
      const lock = join(root, '.git', 'index.lock')
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
    ok(['-c', 'user.name=Fleet', '-c', 'user.email=fleet@local', 'commit', '--allow-empty', '-m', message])

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
      // 대한 에이전트 편집은 이 diff(및 위험 게이트)에 잡히지 않고 revert 의 `clean -fd` 로도 지워지지 않는다(spec §알려진 한계).
      await ok(['add', '-A'])
      const names = await ok(['diff', '--cached', '--name-only', base])
      const files = names.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const patchRes = await ok(['diff', '--cached', base])
      const truncated = patchRes.stdout.length > DIFF_CAP
      const patch = truncated ? `${patchRes.stdout.slice(0, DIFF_CAP)}\n…(diff 절단)` : patchRes.stdout
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
      await ok(['clean', '-fd'])
    },
  }
}

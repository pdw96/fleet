import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { defaultRunner } from '../cli/detect'

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

  return {
    async ensureRepo() {
      const inside = await run(['rev-parse', '--is-inside-work-tree'])
      if (inside.code !== 0) {
        await ok(['init'])
        await ok(['add', '-A'])
        await ok(['commit', '--allow-empty', '-m', 'fleet: 초기 체크포인트'])
        return
      }
      // 이미 레포지만 커밋이 없을 수 있다(git init 후 미커밋). HEAD 없으면 초기 체크포인트 생성.
      const head = await run(['rev-parse', 'HEAD'])
      if (head.code !== 0) {
        await ok(['add', '-A'])
        await ok(['commit', '--allow-empty', '-m', 'fleet: 초기 체크포인트'])
      }
    },
    async checkpoint() {
      const r = await ok(['rev-parse', 'HEAD'])
      return r.stdout.trim()
    },
    async collectDiff(base) {
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
      await ok(['commit', '--allow-empty', '-m', message])
      const r = await ok(['rev-parse', 'HEAD'])
      return r.stdout.trim()
    },
    async revert(base) {
      await ok(['reset', '--hard', base])
      await ok(['clean', '-fd'])
    },
  }
}

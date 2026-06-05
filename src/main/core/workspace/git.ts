import { defaultRunner } from '../cli/detect'

export interface GitResult { code: number | null; stdout: string; stderr: string }
export interface GitRunner {
  run(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult>
}
export interface DiffResult { files: string[]; patch: string; truncated: boolean }

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
  const ok = async (args: string[]): Promise<GitResult> => {
    const r = await run(args)
    if (r.code !== 0) throw new Error(`git ${args[0]} 실패(code ${r.code}): ${r.stderr.trim()}`)
    return r
  }

  return {
    async ensureRepo() {
      const inside = await run(['rev-parse', '--is-inside-work-tree'])
      if (inside.code !== 0) {
        await ok(['init'])
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

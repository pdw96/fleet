// src/main/core/workspace/ignored-baseline.ts
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SENSITIVE_FILE } from '../safety/approval'
import type { GitRunner } from './git'

export interface ScanPolicy {
  sensitiveRe: RegExp
  denylistRe: RegExp
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
  maxEntries: number
}

export const DEFAULT_IGNORED_POLICY: ScanPolicy = {
  sensitiveRe: SENSITIVE_FILE,
  denylistRe:
    /(^|\/)(node_modules|\.git|dist|out|build|\.next|coverage|\.cache|target|\.turbo)(\/|$)|(^|\/)\.fleet-wt-/,
  maxFiles: 1000,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxEntries: 50_000,
}

export interface IgnoredEntry {
  path: string
  size: number
  mtimeMs: number
  hash: string
  sensitive: boolean
  backup: Buffer | null
  mode: number
}
export interface IgnoredBaseline {
  entries: Map<string, IgnoredEntry>
  skipped: { path: string; reason: 'over-cap' | 'read-failed' }[]
}

// git status --ignored 로 in-scope ignored 파일을 열거한다.
// 디렉터리(`!! dir/`)는 denylist 를 walk INTO 하여 민감 파일을 찾는다; sensitive 는 항상 포함, 그 외는 denylist·maxFiles 적용.
async function listIgnored(
  root: string,
  git: GitRunner,
  policy: ScanPolicy,
): Promise<{ files: string[]; skipped: { path: string; reason: 'over-cap' }[] }> {
  const r = await git.run(['status', '--ignored', '--porcelain=v1', '-z'], root)
  // [P2-3] git status 실패는 hard-fail
  if (r.code !== 0) throw new Error('git status --ignored 실패: ' + r.stderr.trim())
  const records = r.stdout.split('\0').filter(Boolean)
  const ignored = records.filter((rec) => rec.startsWith('!! ')).map((rec) => rec.slice(3))
  const files: string[] = []
  const skipped: { path: string; reason: 'over-cap' }[] = []
  let generalCount = 0
  let examined = 0
  const maxEntries = policy.maxEntries
  // [P2-6+P2-8] pushFile: sensitive → always push; non-sensitive AND denylisted → skip; non-sensitive AND not-denylisted → generalCount cap
  const pushFile = (rel: string): void => {
    const key = rel.replace(/\\/g, '/')
    if (!policy.sensitiveRe.test(key) && policy.denylistRe.test(key)) return
    if (!policy.sensitiveRe.test(key)) {
      if (generalCount >= policy.maxFiles) {
        skipped.push({ path: key, reason: 'over-cap' })
        return
      }
      generalCount++
    }
    files.push(key)
  }
  let capped = false
  const walk = (relDir: string): void => {
    if (capped) return
    let names: string[]
    try {
      names = readdirSync(resolve(root, relDir))
    } catch {
      return
    }
    for (const name of names) {
      if (capped) return
      examined++
      if (examined > maxEntries) {
        capped = true
        skipped.push({ path: relDir, reason: 'over-cap' })
        return
      }
      const rel = `${relDir}/${name}`
      let st
      try {
        st = statSync(resolve(root, rel))
      } catch {
        if (policy.sensitiveRe.test(rel)) pushFile(rel)
        continue
      }
      if (st.isDirectory()) walk(rel)
      else pushFile(rel)
    }
  }
  for (const e of ignored) {
    const rel = e.replace(/\\/g, '/')
    if (rel.endsWith('/')) {
      const dir = rel.replace(/\/+$/, '')
      // [P2-6] DO NOT skip denylisted dirs — walk them to find sensitive files inside
      walk(dir)
    } else {
      pushFile(rel)
    }
  }
  return { files, skipped }
}

export async function captureIgnoredBaseline(
  root: string,
  git: GitRunner,
  policy: ScanPolicy,
): Promise<IgnoredBaseline> {
  const { files, skipped: enumSkipped } = await listIgnored(root, git, policy)
  const entries = new Map<string, IgnoredEntry>()
  const skipped: { path: string; reason: 'over-cap' | 'read-failed' }[] = [...enumSkipped]
  let totalBytes = 0
  for (const path of files) {
    const sensitive = policy.sensitiveRe.test(path)
    const abs = resolve(root, path)
    let st
    try {
      st = statSync(abs)
    } catch (err) {
      if (sensitive) throw new Error(`민감 ignored 파일 stat 실패: ${path}`, { cause: err })
      skipped.push({ path, reason: 'read-failed' })
      continue
    }
    if (st.size > policy.maxFileBytes || totalBytes + st.size > policy.maxTotalBytes) {
      if (sensitive) throw new Error(`민감 ignored 파일이 백업 상한 초과: ${path}`)
      skipped.push({ path, reason: 'over-cap' })
      continue
    }
    let buf: Buffer
    try {
      buf = readFileSync(abs)
    } catch (err) {
      if (sensitive) throw new Error(`민감 ignored 파일 백업 실패: ${path}`, { cause: err })
      skipped.push({ path, reason: 'read-failed' })
      continue
    }
    totalBytes += st.size
    entries.set(path, {
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash: createHash('sha256').update(buf).digest('hex'),
      sensitive,
      backup: buf,
      // [P1-a] capture file mode for restoration
      mode: st.mode,
    })
  }
  return { entries, skipped }
}

export interface IgnoredChange {
  path: string
  change: 'created' | 'modified' | 'deleted'
  sensitive: boolean
}
export interface IgnoredChangeSet {
  changes: IgnoredChange[]
  unrestorable: { path: string; reason: string }[]
}

export async function collectIgnoredChanges(
  root: string,
  git: GitRunner,
  baseline: IgnoredBaseline,
  policy: ScanPolicy,
): Promise<IgnoredChangeSet> {
  // [P2-4] capture current-scan skipped too
  const { files, skipped: currentSkipped } = await listIgnored(root, git, policy)
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  const changes: IgnoredChange[] = []
  // [P2-4] merge baseline.skipped + currentSkipped, deduplicate by path
  const seenUnrestorable = new Set(baseline.skipped.map((s) => s.path))
  const unrestorable: { path: string; reason: string }[] = [...baseline.skipped]
  for (const s of currentSkipped) {
    if (!seenUnrestorable.has(s.path)) {
      seenUnrestorable.add(s.path)
      unrestorable.push(s)
    }
  }

  // created: 현재 in-scope ignored 인데 baseline 에도 skipped 에도 없음.
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    changes.push({ path, change: 'created', sensitive: policy.sensitiveRe.test(path) })
  }
  // modified / deleted: baseline 엔트리 기준.
  for (const [path, entry] of baseline.entries) {
    const abs = resolve(root, path)
    if (!existsSync(abs)) {
      changes.push({ path, change: 'deleted', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    const buf = readFileSync(abs)
    const hash = createHash('sha256').update(buf).digest('hex')
    if (hash !== entry.hash) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
    }
  }
  return { changes, unrestorable }
}

export async function restoreIgnoredBaseline(
  root: string,
  git: GitRunner,
  baseline: IgnoredBaseline,
  policy: ScanPolicy,
): Promise<void> {
  const { files } = await listIgnored(root, git, policy)
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  // 1) created(현재 in-scope, baseline·skipped 둘 다 없음) → 삭제.
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    rmSync(resolve(root, path), { recursive: true, force: true })
  }
  // 2) backup 보유 엔트리 → 백업에서 복원(modified·deleted 모두 포함).
  for (const [path, entry] of baseline.entries) {
    if (entry.backup === null) continue // unrestorable — 복원 불가
    const abs = resolve(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    // [P1-b] if existing path is not a regular file (e.g. directory), remove it first
    if (existsSync(abs)) {
      const st = statSync(abs)
      if (!st.isFile()) {
        rmSync(abs, { recursive: true, force: true })
      }
    }
    writeFileSync(abs, entry.backup)
    // [P1-a] restore original file mode
    chmodSync(abs, entry.mode)
  }
}

export function disposeBaseline(baseline: IgnoredBaseline): void {
  for (const entry of baseline.entries.values()) {
    if (entry.backup) entry.backup.fill(0) // best-effort zeroize (JS GC/복사본 → 완전삭제 보장 아님)
  }
  baseline.entries.clear()
  baseline.skipped.length = 0
}

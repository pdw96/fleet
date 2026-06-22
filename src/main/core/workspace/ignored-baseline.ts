// src/main/core/workspace/ignored-baseline.ts
import { createHash } from 'node:crypto'
import {
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
}

export const DEFAULT_IGNORED_POLICY: ScanPolicy = {
  sensitiveRe: SENSITIVE_FILE,
  denylistRe:
    /(^|\/)(node_modules|\.git|dist|out|build|\.next|coverage|\.cache|target|\.turbo)(\/|$)|(^|\/)\.fleet-wt-/,
  maxFiles: 1000,
  maxTotalBytes: 32 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
}

export interface IgnoredEntry {
  path: string
  size: number
  mtimeMs: number
  hash: string
  sensitive: boolean
  backup: Buffer | null
}
export interface IgnoredBaseline {
  entries: Map<string, IgnoredEntry>
  skipped: { path: string; reason: 'over-cap' | 'read-failed' }[]
}

// git status --ignored 로 in-scope ignored 파일을 열거한다.
// 디렉터리(`!! dir/`)는 denylist 우선 검사 후 fs 재귀; sensitive 는 항상 포함, 그 외는 denylist·maxFiles 적용.
async function listIgnored(
  root: string,
  git: GitRunner,
  policy: ScanPolicy,
): Promise<{ files: string[]; skipped: { path: string; reason: 'over-cap' }[] }> {
  const r = await git.run(['status', '--ignored', '--porcelain=v1', '-z'], root)
  const records = r.code === 0 ? r.stdout.split('\0').filter(Boolean) : []
  const ignored = records.filter((rec) => rec.startsWith('!! ')).map((rec) => rec.slice(3))
  const files: string[] = []
  const skipped: { path: string; reason: 'over-cap' }[] = []
  let generalCount = 0
  const inScope = (rel: string): boolean =>
    policy.sensitiveRe.test(rel) || !policy.denylistRe.test(rel)
  const pushFile = (rel: string): void => {
    const key = rel.replace(/\\/g, '/')
    if (!inScope(key)) return
    if (!policy.sensitiveRe.test(key)) {
      if (generalCount >= policy.maxFiles) {
        skipped.push({ path: key, reason: 'over-cap' })
        return
      }
      generalCount++
    }
    files.push(key)
  }
  const walk = (relDir: string): void => {
    let names: string[]
    try {
      names = readdirSync(resolve(root, relDir))
    } catch {
      return
    }
    for (const name of names) {
      const rel = `${relDir}/${name}`
      if (!inScope(rel)) continue
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
      if (policy.denylistRe.test(`${dir}/`)) continue
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
  const { files } = await listIgnored(root, git, policy)
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  const changes: IgnoredChange[] = []
  const unrestorable: { path: string; reason: string }[] = [...baseline.skipped]

  // created: 현재 in-scope ignored 인데 baseline 에도 skipped 에도 없음.
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    changes.push({ path, change: 'created', sensitive: policy.sensitiveRe.test(path) })
  }
  // modified / deleted: baseline 엔트리 기준.
  for (const [path, entry] of baseline.entries) {
    const abs = resolve(root, path)
    // deleted 판정은 fs 존재 여부만으로 한다(!existsSync 단독).
    // restore が関心을 갖는 것은 파일의 내용/존재이지 git의 ignored 목록 포함 여부가 아니다.
    // `|| !current.has(path)` 를 추가하면 디스크에 실재하지만 더 이상 ignored 가 아닌 파일을
    // spurious 'deleted' 로 오보고하게 되므로 의도적으로 제외한다.
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
    rmSync(resolve(root, path), { force: true })
  }
  // 2) backup 보유 엔트리 → 백업에서 복원(modified·deleted 모두 포함).
  for (const [path, entry] of baseline.entries) {
    if (entry.backup === null) continue // unrestorable — 복원 불가
    const abs = resolve(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, entry.backup)
  }
}

export function disposeBaseline(baseline: IgnoredBaseline): void {
  for (const entry of baseline.entries.values()) {
    if (entry.backup) entry.backup.fill(0) // best-effort zeroize (JS GC/복사본 → 완전삭제 보장 아님)
  }
  baseline.entries.clear()
  baseline.skipped.length = 0
}

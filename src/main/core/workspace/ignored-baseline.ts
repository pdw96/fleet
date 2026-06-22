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
  mode: number
}
export interface IgnoredBaseline {
  entries: Map<string, IgnoredEntry>
  skipped: { path: string; reason: 'over-cap' | 'read-failed' }[]
}

// git status --ignored 로 in-scope ignored 파일을 열거한다.
// 디렉터리(`!! dir/`)는 denylist 여부를 먼저 확인한다:
//   - denylist 디렉터리 내부는 스캔하지 않음 — 그 안의 sensitive 파일(예: node_modules/.ssh) 커버는
//     B 슬라이스(강한 격리/evasion)로 연기(#123 후속).
//   - non-denylist 디렉터리는 walk. generalCount 가 maxFiles 에 도달하면:
//     (1) capped=true 로 설정, (2) 단일 'scan-capped' over-cap escalation 기록,
//     (3) walk 즉시 return — 이후 서브디렉터리 탐색 없음(unbounded traversal 방지).
//     cap 이전에 push 된 sensitive 파일은 그대로 보존.
//     cap 이후 sensitive 파일 누락은 over-cap escalation 으로 표면화(fail-closed).
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
  // capped: generalCount >= maxFiles に達した後は true。walk は冒頭で確認し即 return する。
  let capped = false
  // pushFile: sensitive → always push; non-sensitive AND denylisted → skip; non-sensitive AND not-denylisted → generalCount cap
  // cap 도달 시 capped=true + 단일 escalation 기록 후 return(호출자가 capped 확인).
  const pushFile = (rel: string): void => {
    const key = rel.replace(/\\/g, '/')
    if (!policy.sensitiveRe.test(key) && policy.denylistRe.test(key)) return
    if (!policy.sensitiveRe.test(key)) {
      if (generalCount >= policy.maxFiles) {
        if (!capped) {
          capped = true
          skipped.push({ path: 'scan-capped', reason: 'over-cap' })
        }
        return
      }
      generalCount++
    }
    files.push(key)
  }
  const walk = (relDir: string): void => {
    // early-terminate: cap 도달 후 서브디렉터리 탐색을 중단(unbounded traversal 방지)
    if (capped) return
    let names: string[]
    try {
      names = readdirSync(resolve(root, relDir))
    } catch {
      return
    }
    for (const name of names) {
      if (capped) return
      const rel = `${relDir}/${name}`
      let st
      try {
        st = statSync(resolve(root, rel))
      } catch {
        if (policy.sensitiveRe.test(rel)) pushFile(rel)
        continue
      }
      if (st.isDirectory()) {
        walk(rel)
      } else {
        pushFile(rel)
      }
    }
  }
  for (const e of ignored) {
    if (capped) break
    const rel = e.replace(/\\/g, '/')
    if (rel.endsWith('/')) {
      const dir = rel.replace(/\/+$/, '')
      // denylist 디렉터리 내부는 스캔하지 않음 — 그 안의 sensitive 파일(예: node_modules/.ssh) 커버는
      // B 슬라이스(강한 격리/evasion)로 연기(#123 후속).
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
  try {
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
  } catch (err) {
    // [:143] 부분 캡처 중 throw: 이미 쌓인 backup Buffer 를 zeroize(비밀 위생)
    for (const entry of entries.values()) {
      if (entry.backup) entry.backup.fill(0)
    }
    throw err
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
    // [:213] size-guard: 현재 파일이 maxFileBytes 초과 시 read/hash 없이 modified+unrestorable
    let currentSize: number
    try {
      currentSize = statSync(abs).size
    } catch {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      unrestorable.push({ path, reason: 'stat-failed' })
      continue
    }
    if (currentSize > policy.maxFileBytes) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      unrestorable.push({ path, reason: 'over-cap-modified' })
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
  const { files, skipped } = await listIgnored(root, git, policy)
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  // 1) created(현재 in-scope, baseline·skipped 둘 다 없음) → 삭제.
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    rmSync(resolve(root, path), { recursive: true, force: true })
  }
  // [:229] over-cap skipped 중 baseline 에 없는 것도 삭제(에이전트가 cap 초과로 만든 파일 rollback).
  for (const s of skipped) {
    if (baseline.entries.has(s.path) || skippedPaths.has(s.path)) continue
    rmSync(resolve(root, s.path), { recursive: true, force: true })
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

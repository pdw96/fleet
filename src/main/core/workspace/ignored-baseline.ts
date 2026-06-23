// src/main/core/workspace/ignored-baseline.ts
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SENSITIVE_FILE } from '../safety/approval'
import type { GitRunner } from './git'
import { isLinkSync } from './path-guard'

/** [:270] walk의 unreadable-dir 및 listIgnored의 over-cap 합성 마커 경로 상수.
 * restore/rmSync 등 실-경로로 취급하는 곳에서는 반드시 이 값을 걸러내야 한다. */
export const SCAN_CAPPED = 'scan-capped'

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
  skipped: { path: string; reason: 'over-cap' | 'read-failed' | 'not-regular' | 'symlink' }[]
}

// git status --ignored 로 in-scope ignored 파일을 열거한다.
// 디렉터리(`!! dir/`)는 denylist 여부를 먼저 확인한다:
//   - denylist 디렉터리 내부는 스캔하지 않음 — 그 안의 sensitive 파일(예: node_modules/.ssh) 커버는
//     [#128-C] B1 확정 비목표 — evasion(숨긴 위치 쓰기) 방어는 경로검사가 아닌 B2 프로세스 격리로 이관(#128 잔여).
//   - non-denylist 디렉터리는 walk. generalCount 가 maxFiles 에 도달하면:
//     (1) capped=true 로 설정, (2) 단일 'scan-capped' over-cap escalation 기록,
//     (3) walk 즉시 return — 이후 서브디렉터리 탐색 없음(unbounded traversal 방지).
//     cap 이전에 push 된 sensitive 파일은 그대로 보존.
//     cap 이후 sensitive 파일 누락은 over-cap escalation 으로 표면화(fail-closed).
async function listIgnored(
  root: string,
  git: GitRunner,
  policy: ScanPolicy,
): Promise<{ files: string[]; skipped: { path: string; reason: 'over-cap' | 'symlink' }[] }> {
  const r = await git.run(['status', '--ignored', '--porcelain=v1', '-z'], root)
  // [P2-3] git status 실패는 hard-fail
  if (r.code !== 0) throw new Error('git status --ignored 실패: ' + r.stderr.trim())
  const records = r.stdout.split('\0').filter(Boolean)
  const ignored = records.filter((rec) => rec.startsWith('!! ')).map((rec) => rec.slice(3))
  const files: string[] = []
  const skipped: { path: string; reason: 'over-cap' | 'symlink' }[] = []
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
          skipped.push({ path: SCAN_CAPPED, reason: 'over-cap' })
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
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(resolve(root, relDir), { withFileTypes: true })
    } catch {
      // [:96] unreadable dir → fail-closed: 조용히 skip하지 않고 over-cap escalation 기록.
      // permission error 등으로 내부를 읽지 못하면 sensitive 파일이 숨을 수 있으므로
      // scan-capped 마커와 동일한 over-cap 이유를 붙여 skipped 에 push(fail-closed).
      if (!capped) {
        capped = true
        skipped.push({ path: SCAN_CAPPED, reason: 'over-cap' })
      }
      return
    }
    for (const ent of entries) {
      if (capped) return
      const rel = `${relDir}/${ent.name}`
      if (ent.isSymbolicLink()) {
        // [#128-B2] symlink/junction 은 따라가지 않는다 — 밖을 가리켜 읽거나 재귀하지 않음.
        skipped.push({ path: rel.replace(/\\/g, '/'), reason: 'symlink' })
        continue
      }
      if (ent.isDirectory()) {
        // [:109] 중첩 denylist 디렉터리는 top-level 과 동일하게 skip(내부 탐색 금지).
        // 예: packages/x/node_modules/ — denylist 확인 없이 walk 하면 cap 낭비.
        // [#128-C] 내부 sensitive 커버는 B1 확정 비목표 — evasion 방어는 B2 프로세스 격리로 이관(#128 잔여).
        const relSlash = `${rel}/`
        if (policy.denylistRe.test(rel) || policy.denylistRe.test(relSlash)) continue
        walk(rel)
        continue
      }
      // [#128-B2] 파일 + 비정형(FIFO/socket/device) → pushFile. capture/collect 의 lstat 가
      // regular 면 백업, 아니면 'not-regular' 로 표면화한다(B1 동작 보존 — silent drop 금지).
      pushFile(rel)
    }
  }
  for (const e of ignored) {
    if (capped) break
    const rel = e.replace(/\\/g, '/')
    if (rel.endsWith('/')) {
      const dir = rel.replace(/\/+$/, '')
      // [#128-C] denylist 디렉터리 내부는 스캔하지 않음(비용 경계). 내부 sensitive 커버는 B1 확정 비목표 —
      // evasion(숨긴 위치 쓰기) 방어는 경로검사가 아닌 B2 프로세스 격리로 이관(#128 잔여).
      if (policy.denylistRe.test(`${dir}/`)) continue
      // [#128-B2] git 이 디렉터리로 보고해도 실제 junction/symlink 면 재귀 금지.
      // 'suspicious'/'missing' 은 이 분기에 걸리지 않아 pushFile/missing 경로로 떨어지며,
      // capture 의 lstat 이 non-regular 로 표면화한다(Task 4 동작 — 여기선 의도적 미처리).
      if (isLinkSync(resolve(root, dir)) === 'link') {
        skipped.push({ path: dir, reason: 'symlink' })
        continue
      }
      walk(dir)
    } else {
      // [#128-B2] 파일로 보고된 엔트리가 실제 링크면 수집 안 함(capture 의 lstat 가 이중 방어).
      if (isLinkSync(resolve(root, rel)) === 'link') {
        skipped.push({ path: rel, reason: 'symlink' })
        continue
      }
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
  const skipped: {
    path: string
    reason: 'over-cap' | 'read-failed' | 'not-regular' | 'symlink'
  }[] = [...enumSkipped]
  let totalBytes = 0
  try {
    for (const path of files) {
      const sensitive = policy.sensitiveRe.test(path)
      const abs = resolve(root, path)
      let st
      try {
        st = lstatSync(abs) // [#128-B2] 링크 비추종 — 링크면 isFile()=false 로 아래 분기 적중
      } catch (err) {
        if (sensitive) throw new Error(`민감 ignored 파일 stat 실패: ${path}`, { cause: err })
        skipped.push({ path, reason: 'read-failed' })
        continue
      }
      // [#128-B2] symlink/junction → read 금지(밖 target 유출 차단). sensitive 면 fail-closed.
      if (st.isSymbolicLink()) {
        if (sensitive) throw new Error(`민감 ignored 파일이 링크임(백업 불가): ${path}`)
        skipped.push({ path, reason: 'symlink' })
        continue
      }
      // [#128-A] non-regular(FIFO/socket/device/dir)면 readFileSync 가 hang/오류 → read 전 차단.
      if (!st.isFile()) {
        if (sensitive) throw new Error(`민감 ignored 파일이 일반 파일이 아님(백업 불가): ${path}`)
        skipped.push({ path, reason: 'not-regular' })
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
  // [:244] 현재 파일 해싱 시 누적 바이트 추적 — maxTotalBytes 초과 시 read 없이 modified+unrestorable
  let collectTotalBytes = 0
  for (const [path, entry] of baseline.entries) {
    const abs = resolve(root, path)
    if (!existsSync(abs)) {
      changes.push({ path, change: 'deleted', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    // [:213] size-guard + [#128-A] non-regular 가드: read 전 stat 으로 종류·크기 확인
    let st
    try {
      st = statSync(abs)
    } catch {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      unrestorable.push({ path, reason: 'stat-failed' })
      continue
    }
    if (!st.isFile()) {
      // baseline 일반 파일이 non-regular 로 교체됨 = modified. read 없이(hang 방지).
      // backup 있으면 restore 가 비-일반 leaf 제거 후 복원 → unrestorable 아님.
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    const currentSize = st.size
    if (currentSize > policy.maxFileBytes) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      unrestorable.push({ path, reason: 'over-cap-modified' })
      continue
    }
    // [:244] 누적 cap 초과 → read 없이 modified+unrestorable(over-cap)
    if (collectTotalBytes + currentSize > policy.maxTotalBytes) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      unrestorable.push({ path, reason: 'over-cap-modified' })
      continue
    }
    collectTotalBytes += currentSize
    const buf = readFileSync(abs)
    const hash = createHash('sha256').update(buf).digest('hex')
    if (hash !== entry.hash) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
    }
  }
  return { changes, unrestorable }
}

// [#128-B] 복원 시 mkdirSync(dirname) 이 ENOTDIR 로 깨지지 않도록, root→dirname 사이 조상 중
// "존재하지만 디렉터리 아님"(에이전트가 만든 파일 등)을 제거한다. 제거 후 하위 조상은 부재하므로
// mkdirSync(recursive) 가 체인을 재생성한다. resolve(root, …) 기준이라 root 밖은 건드리지 않는다.
function clearNonDirAncestors(root: string, abs: string): void {
  const relDir = relative(root, dirname(abs))
  // dirname===root('') → no-op. 진짜 부모 traversal 만 root 밖으로 본다: '..' 단독, '..'+구분자 시작,
  // 또는 절대경로(Windows 타 드라이브). '..cache' 처럼 점2개로 시작하는 정상 in-root 디렉터리명은 제외 안 함.
  if (
    !relDir ||
    relDir === '..' ||
    relDir.startsWith(`..${sep}`) ||
    relDir.startsWith('../') ||
    isAbsolute(relDir)
  )
    return
  let cur = root
  for (const part of relDir.split(/[\\/]/).filter(Boolean)) {
    cur = resolve(cur, part)
    if (existsSync(cur) && !statSync(cur).isDirectory()) {
      rmSync(cur, { recursive: true, force: true })
      return
    }
  }
}

export async function restoreIgnoredBaseline(
  root: string,
  git: GitRunner,
  baseline: IgnoredBaseline,
  policy: ScanPolicy,
): Promise<{ capped: boolean }> {
  const { files, skipped } = await listIgnored(root, git, policy)
  // [#128-m2] 현재 restore 호출의 스캔이 cap 에 도달했는지(에이전트가 cap 뒤 숨긴 파일이
  // 이번 삭제 패스에서 누락될 수 있음 → rollback 불완전 가능성 표면화).
  const capped = skipped.some((s) => s.path === SCAN_CAPPED && s.reason === 'over-cap')
  const skippedPaths = new Set(baseline.skipped.map((s) => s.path))
  // 1) created(현재 in-scope, baseline·skipped 둘 다 없음) → 삭제.
  for (const path of files) {
    if (baseline.entries.has(path) || skippedPaths.has(path)) continue
    rmSync(resolve(root, path), { recursive: true, force: true })
  }
  // [:229] over-cap skipped 중 baseline 에 없는 것도 삭제(에이전트가 cap 초과로 만든 파일 rollback).
  // [:270] SCAN_CAPPED 합성 마커는 실-경로가 아니므로 rmSync 대상에서 제외한다.
  for (const s of skipped) {
    if (s.path === SCAN_CAPPED) continue
    if (baseline.entries.has(s.path) || skippedPaths.has(s.path)) continue
    rmSync(resolve(root, s.path), { recursive: true, force: true })
  }
  // 2) backup 보유 엔트리 → 백업에서 복원(modified·deleted 모두 포함).
  for (const [path, entry] of baseline.entries) {
    if (entry.backup === null) continue // unrestorable — 복원 불가
    const abs = resolve(root, path)
    clearNonDirAncestors(root, abs) // [#128-B] 조상-파일 충돌 정리
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
  return { capped }
}

export function disposeBaseline(baseline: IgnoredBaseline): void {
  for (const entry of baseline.entries.values()) {
    if (entry.backup && entry.backup.length > 0) entry.backup.fill(0) // .length > 0: 방어적 가드 — 빈 Buffer 의 fill(0) 은 no-op 이지만 의도를 명시한다. best-effort zeroize (JS GC/복사본 → 완전삭제 보장 아님)
  }
  baseline.entries.clear()
  baseline.skipped.length = 0
}

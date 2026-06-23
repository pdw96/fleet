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
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SENSITIVE_FILE } from '../safety/approval'
import type { GitRunner } from './git'

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
  skipped: {
    path: string
    // [Codex round5 Fix-3] 'unclassified': lstat 자체가 실패해 symlink 여부를 확정할 수 없는 경우.
    // 'symlink': lstatSync().isSymbolicLink() === true 로 확정된 경우에만 사용.
    // 이 구분이 없으면 restore sweep 이 lstat-fail 경로(실제 디렉터리일 수 있음)를 삭제해
    // 실제 디렉터리를 파괴하는 파괴적 오동작이 발생한다.
    reason: 'over-cap' | 'read-failed' | 'not-regular' | 'symlink' | 'unclassified'
  }[]
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
): Promise<{
  files: string[]
  skipped: { path: string; reason: 'over-cap' | 'symlink' | 'unclassified' }[]
}> {
  const r = await git.run(['status', '--ignored', '--porcelain=v1', '-z'], root)
  // [P2-3] git status 실패는 hard-fail
  if (r.code !== 0) throw new Error('git status --ignored 실패: ' + r.stderr.trim())
  const records = r.stdout.split('\0').filter(Boolean)
  const ignored = records.filter((rec) => rec.startsWith('!! ')).map((rec) => rec.slice(3))
  const files: string[] = []
  const skipped: { path: string; reason: 'over-cap' | 'symlink' | 'unclassified' }[] = []
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
  // [#128-B2 P2-4 + Codex round5 Fix-1] 링크/분류불가 skip 도 스캔 예산에 포함.
  // walk 내부 AND top-level 루프 양쪽에서 모든 symlink/unclassified skip 을 이 helper 로 경유시켜
  // top-level 에서 cap 을 우회하는 문제를 차단한다.
  // 단 민감 경로는 항상 기록(fail-closed — capture 의 sensitive 검사가 s.path 를 본다).
  const pushSkip = (rel: string, reason: 'symlink' | 'unclassified'): void => {
    const key = rel.replace(/\\/g, '/')
    const sensitive = policy.sensitiveRe.test(key) || policy.sensitiveRe.test(`${key}/`)
    if (!sensitive) {
      if (generalCount >= policy.maxFiles) {
        if (!capped) {
          capped = true
          skipped.push({ path: SCAN_CAPPED, reason: 'over-cap' })
        }
        return // 비민감 링크/미분류는 cap 초과 시 생략(SCAN_CAPPED 가 불완전 신호)
      }
      generalCount++
    }
    skipped.push({ path: key, reason })
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
      // [#128-B2 P2-2] DT_UNKNOWN(network/FUSE) — dirent 종류 미상 → lstat 로 확정.
      if (!ent.isSymbolicLink() && !ent.isDirectory() && !ent.isFile()) {
        let est
        try {
          est = lstatSync(resolve(root, rel))
        } catch {
          // [Codex round5 Fix-3] lstat 실패 = 분류 불가(exotic reparse 등) → 'unclassified' 로 기록.
          // 'symlink' 가 아니므로 restore sweep 의 baselineSymlinkPaths 에 포함되지 않아
          // 실제 디렉터리가 있는 경우 파괴적 삭제를 방지한다(fail-closed skip).
          pushSkip(rel, 'unclassified')
          continue
        }
        if (est.isSymbolicLink()) {
          pushSkip(rel, 'symlink')
          continue
        }
        if (est.isDirectory()) {
          const relSlash = `${rel}/`
          if (policy.denylistRe.test(rel) || policy.denylistRe.test(relSlash)) continue
          walk(rel)
          continue
        }
        // 그 외(file/비정형) → pushFile(capture 의 lstat 가 regular/not-regular 처리)
        pushFile(rel)
        continue
      }
      if (ent.isSymbolicLink()) {
        // [#128-B2] symlink/junction 은 따라가지 않는다 — 밖을 가리켜 읽거나 재귀하지 않음.
        pushSkip(rel, 'symlink')
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
  // [Codex round6 Fix-2] top-level `if (capped) break` 제거.
  // git 보고 레코드 리스트는 유한하므로 break 단락이 불필요한데, 오히려 위험하다:
  // 비민감 링크가 cap 을 트립한 뒤 SENSITIVE 레코드(.ssh/ 등)가 이어지면, break 하면
  // 그 sensitive skip 이 captureIgnoredBaseline 의 fail-closed 검사에 도달하지 못한다(fail-OPEN).
  // walk 내부의 `if (capped) return` 가드는 그대로 유지 — unbounded traversal 방지 위해 필수.
  // cap 후 dir 레코드가 와도 walk(dir) 는 시작에서 즉시 return(bounded)이라 여분 작업이 없다.
  for (const e of ignored) {
    const rel = e.replace(/\\/g, '/')
    if (rel.endsWith('/')) {
      const dir = rel.replace(/\/+$/, '')
      // [#128-C] denylist 디렉터리 내부는 스캔하지 않음(비용 경계). 내부 sensitive 커버는 B1 확정 비목표 —
      // evasion(숨긴 위치 쓰기) 방어는 경로검사가 아닌 B2 프로세스 격리로 이관(#128 잔여).
      if (policy.denylistRe.test(`${dir}/`)) continue
      // [#128-B2] git 이 디렉터리로 보고해도 실제 junction/symlink 면 재귀 금지.
      let dirSt
      try {
        dirSt = lstatSync(resolve(root, dir))
      } catch {
        // [Codex P1 Fix-B + round5 Fix-3] lstat 분류 실패(exotic reparse 등) → walk 하면 readdirSync 가 target 을 열거해 밖 탈출.
        // fail-closed: skip(표면화), walk 안 함. (ENOENT 면 어차피 수집할 것 없음.)
        // [Codex round5 Fix-1] top-level lstat-fail 도 pushSkip 경유해 cap 카운트에 포함.
        // [Codex round5 Fix-3] lstat 실패는 symlink 확정 아님 → 'unclassified' 로 기록.
        pushSkip(dir, 'unclassified')
        continue
      }
      if (dirSt.isSymbolicLink()) {
        // [Codex round5 Fix-1] top-level confirmed-symlink 도 pushSkip 경유해 cap 카운트에 포함.
        pushSkip(dir, 'symlink')
        continue
      }
      walk(dir)
    } else {
      // [#128-B2] 파일로 보고된 엔트리가 실제 링크면 수집 안 함(capture 의 lstat 가 이중 방어).
      let fileSt
      try {
        fileSt = lstatSync(resolve(root, rel))
      } catch {
        pushFile(rel)
        continue
      }
      if (fileSt.isSymbolicLink()) {
        // [Codex round5 Fix-1] top-level file-symlink 도 pushSkip 경유해 cap 카운트에 포함.
        pushSkip(rel, 'symlink')
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
  // [#128-B2 P1] listIgnored 가 링크를 skipped{symlink} 로 우회시키므로 민감-명 링크가 아래
  // sensitive→throw 분기에 도달하지 못한다. 여기서 fail-closed(민감 경로 백업 불가 → hard-stop).
  // [Codex 재리뷰 P1] listIgnored top-level 루프: `dir = rel.replace(/\/+$/, '')` 로
  // 디렉터리 심볼릭 링크의 trailing slash 가 제거됨(예: '.ssh/' → '.ssh').
  // SENSITIVE_FILE 의 .ssh 절은 `(^|[/\\])\.ssh[/\\]` — trailing slash 필수.
  // 따라서 s.path='.ssh' 는 test false → fail-open 위험.
  // 두 형태 모두 검사: s.path(파일형) AND `${s.path}/`(디렉터리형, slash 복원)로
  // 슬래시가 제거된 디렉터리 심볼릭 링크도 확실히 차단한다.
  // [Codex round5 Fix-3] reason 필터 없음 — symlink AND unclassified 경로 모두 검사.
  // 분류 불가(unclassified) 경로도 민감하면 fail-closed(안전상 처리 불가).
  for (const s of enumSkipped) {
    if (s.path === SCAN_CAPPED) continue // 합성 over-cap 마커는 실경로 아님
    // listIgnored 가 분류 못 한(링크/분류불가) 경로는 capture 가 안전 백업 불가 → 민감하면 fail-closed.
    // listIgnored top-level 이 디렉터리 링크의 trailing slash 를 떼므로(.ssh/ → .ssh) 두 형태 모두 검사.
    if (policy.sensitiveRe.test(s.path) || policy.sensitiveRe.test(`${s.path}/`)) {
      throw new Error(`민감 ignored 경로를 안전하게 백업할 수 없음(링크/분류불가): ${s.path}`)
    }
  }
  const entries = new Map<string, IgnoredEntry>()
  const skipped: {
    path: string
    reason: 'over-cap' | 'read-failed' | 'not-regular' | 'symlink' | 'unclassified'
  }[] = [...enumSkipped]
  let totalBytes = 0
  try {
    for (const path of files) {
      const sensitive = policy.sensitiveRe.test(path)
      const abs = resolve(root, path)
      let st
      try {
        st = lstatSync(abs) // [#128-B2] 링크 비추종 — symlink 은 아래 isSymbolicLink() 분기에서 먼저 차단
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
  // [Codex round5 Fix-3] baselineSymlinkPaths = reason==='symlink' 만 — 'unclassified' 제외.
  // 'unclassified' 는 lstat-fail 로 실제 타입 불명. restore sweep 에서 확정 non-symlink 인지
  // 알 수 없으므로 삭제 대상에서 제외해야 한다(파괴적 오동작 방지).
  // [Codex round6 Fix-3 — DOCUMENT] 'unclassified' 를 created-whitelist 에서 제외하지 않는 이유:
  //   lstat 실패 경로는 "빈 디렉터리였는지, pre-existing 파일이었는지" 판정 불가.
  //   agent 가 그 자리에 파일을 만들었을 때 강제 삭제하면 pre-existing 데이터를 파괴할 수 있다
  //   (round5 파괴적 버그 = sweep 이 실 디렉터리를 삭제 와 동일 클래스 리스크).
  //   따라서 'unclassified' 는 'read-failed'/'over-cap' 와 같이 보수적 whitelist(강제 rollback 안 함)로 두고,
  //   unrestorable 로 표면화한다(collect 측).
  const baselineSymlinkPaths = new Set(
    baseline.skipped.filter((s) => s.reason === 'symlink').map((s) => s.path),
  )
  const changes: IgnoredChange[] = []
  const changedPaths = new Set<string>()
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
  // [Codex P1 Fix-D] baseline symlink 경로는 화이트리스트에서 제외 — agent 가 symlink 를 일반파일로
  // 교체한 경우 created 로 표면화되어야 한다(over-cap/read-failed 는 계속 whitelist).
  for (const path of files) {
    if (baseline.entries.has(path) || (skippedPaths.has(path) && !baselineSymlinkPaths.has(path)))
      continue
    changes.push({ path, change: 'created', sensitive: policy.sensitiveRe.test(path) })
    changedPaths.add(path)
  }
  // modified / deleted: baseline 엔트리 기준.
  // [:244] 현재 파일 해싱 시 누적 바이트 추적 — maxTotalBytes 초과 시 read 없이 modified+unrestorable
  let collectTotalBytes = 0
  for (const [path, entry] of baseline.entries) {
    const abs = resolve(root, path)
    if (!existsSync(abs)) {
      changes.push({ path, change: 'deleted', sensitive: entry.sensitive })
      changedPaths.add(path)
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    // [:213] size-guard + [#128-A] non-regular 가드 + [#128-B2] 링크 비추종: read 전 lstat 으로 종류·크기 확인
    let st
    try {
      st = lstatSync(abs) // [#128-B2] 링크 비추종
    } catch {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      changedPaths.add(path)
      unrestorable.push({ path, reason: 'stat-failed' })
      continue
    }
    if (st.isSymbolicLink()) {
      // [#128-B2] baseline 일반파일이 링크로 교체됨 = modified. read 안 함(밖 유출 차단).
      // backup 있으면 restore 가 링크 제거 후 복원 → unrestorable 아님.
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      changedPaths.add(path)
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    if (!st.isFile()) {
      // baseline 일반 파일이 non-regular 로 교체됨 = modified. read 없이(hang 방지).
      // backup 있으면 restore 가 비-일반 leaf 제거 후 복원 → unrestorable 아님.
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      changedPaths.add(path)
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
      continue
    }
    const currentSize = st.size
    if (currentSize > policy.maxFileBytes) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      changedPaths.add(path)
      unrestorable.push({ path, reason: 'over-cap-modified' })
      continue
    }
    // [:244] 누적 cap 초과 → read 없이 modified+unrestorable(over-cap)
    if (collectTotalBytes + currentSize > policy.maxTotalBytes) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      changedPaths.add(path)
      unrestorable.push({ path, reason: 'over-cap-modified' })
      continue
    }
    collectTotalBytes += currentSize
    const buf = readFileSync(abs)
    const hash = createHash('sha256').update(buf).digest('hex')
    if (hash !== entry.hash) {
      changes.push({ path, change: 'modified', sensitive: entry.sensitive })
      changedPaths.add(path)
      if (entry.backup === null) unrestorable.push({ path, reason: 'no-backup' })
    }
  }
  // [Codex round5 Fix-4] baseline symlink-to-dir 이 EMPTY 실디렉터리로 치환된 경우
  // git 은 자식 파일이 없으면 dir 자체만 보고하지 않아 위 files 루프에서 탐지 불가.
  // baselineSymlinkPaths 를 직접 순회해 추가 감지한다.
  // 주의: symlink→symlink 치환은 target 을 읽지 않고는 구분 불가(no-follow/leak-zero 불변식)
  //   → advisory 비목표. 그런 경우 rollback 이 agent 교체 symlink 를 남길 수 있음.
  for (const path of baselineSymlinkPaths) {
    if (changedPaths.has(path)) continue // 이미 위 루프에서 탐지됨
    const abs = resolve(root, path)
    let st
    try {
      st = lstatSync(abs)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // [Codex round6 Fix-1] baseline symlink 이 삭제됨 → deleted 변경으로 표면화.
        // 이전 코드는 `continue` 했는데, baseline.entries 에 없는 symlink 경로는
        // 위 entries 루프가 처리하지 않으므로 deleted 가 영원히 보고되지 않는다(누락 버그).
        // restore 는 symlink 를 재생성할 수 없으므로(backup 없음) restore 변경은 없음.
        // de-dup: changedPaths 에 없는 경우만 push.
        if (!changedPaths.has(path))
          changes.push({
            path,
            change: 'deleted',
            sensitive: policy.sensitiveRe.test(path) || policy.sensitiveRe.test(`${path}/`),
          })
        continue
      }
      // lstat 실패 → stat 불가(unrestorable)
      unrestorable.push({ path, reason: 'stat-failed' })
      continue
    }
    if (st.isSymbolicLink()) continue // 여전히 symlink → baseline 상태 유지, 변경 없음
    // 더 이상 symlink 가 아님 = 에이전트가 실디렉터리(또는 파일)로 치환 → created 로 표면화
    changes.push({
      path,
      change: 'created',
      sensitive: policy.sensitiveRe.test(path) || policy.sensitiveRe.test(`${path}/`),
    })
    changedPaths.add(path)
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
    let ls
    try {
      ls = lstatSync(cur) // [#128-B2 P1] existsSync 는 symlink 추종→dangling 조상 놓침. lstat 직접.
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // 진짜 부재 → 다음 조상
      throw e // [Codex P1] 분류 불가 조상(exotic reparse 등) → fail-closed. continue 하면 mkdir/write 가 밖으로 통과.
    }
    if (!ls.isDirectory() || ls.isSymbolicLink()) {
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
  // [Codex round5 Fix-3] baselineSymlinkPaths = reason==='symlink' 만 — 'unclassified' 제외.
  // restore sweep 은 "symlink 였는데 지금 non-symlink = 치환됨"을 판정한다.
  // 'unclassified' 는 baseline 시점 타입 불명이므로 sweep 대상에서 제외해야 한다.
  // 'unclassified' 경로를 sweep 에 포함하면 실제 디렉터리를 파괴하는 오동작이 발생한다.
  // [Codex round6 Fix-3 — DOCUMENT] 'unclassified' 를 whitelist 에서 빼서 강제 rollback 하지 않는 이유:
  //   lstat-fail 경로는 baseline 시점 타입(symlink/dir/file)을 확정할 수 없다.
  //   강제 삭제하면 pre-existing 파일/디렉터리를 파괴할 위험(round5 파괴적 버그와 동일 클래스).
  //   'read-failed'/'over-cap' 와 같이 보수적 whitelist 로 두고 unrestorable 로 표면화한다.
  //   확정된 symlink('symlink' reason)만 sweep 대상 — 안전히 삭제 가능하다고 증명된 유일한 케이스.
  const baselineSymlinkPaths = new Set(
    baseline.skipped.filter((s) => s.reason === 'symlink').map((s) => s.path),
  )
  // [#128-B2] 링크-aware created 삭제 헬퍼.
  // lexical containment(realpath 아님 — 탈출 링크도 unlink 해야 하므로 realpath 추종 금지).
  const removeCreated = (rel: string): void => {
    const abs = resolve(root, rel)
    // git-상대 경로는 보통 root 아래지만, 이상한 절대/상위 경로 방어.
    const r = relative(root, abs)
    if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return
    // 링크면 recursive 금지 — 링크 자체만 unlink(밖 내용 보존). lstatSync(비추종).
    let st
    try {
      st = lstatSync(abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return // 이미 없음 — 삭제할 것 없음
      throw e // [#128-B2 P2-3] 분류 불가 created 경로 → fail-closed(restore 가 success 로 잔존 은폐 방지)
    }
    rmSync(abs, st.isSymbolicLink() ? { force: true } : { recursive: true, force: true })
  }
  // 1) created(현재 in-scope, baseline·skipped 둘 다 없음) → 삭제.
  // [Codex P1 Fix-D] baseline symlink 경로는 화이트리스트에서 제외 — agent 가 symlink 를 일반파일로
  // 교체한 경우 created 로 표면화되어 rollback 삭제 대상이 되어야 한다.
  for (const path of files) {
    if (baseline.entries.has(path) || (skippedPaths.has(path) && !baselineSymlinkPaths.has(path)))
      continue
    removeCreated(path)
  }
  // [:229] over-cap skipped 중 baseline 에 없는 것도 삭제(에이전트가 cap 초과로 만든 파일 rollback).
  // [:270] SCAN_CAPPED 합성 마커는 실-경로가 아니므로 rmSync 대상에서 제외한다.
  for (const s of skipped) {
    if (s.path === SCAN_CAPPED) continue
    if (baseline.entries.has(s.path) || skippedPaths.has(s.path)) continue
    removeCreated(s.path)
  }
  // [#128-B2 P2-1] baseline symlink 이 디렉터리를 가리켰고 agent 가 실제 dir/file 로 치환하면
  // git 은 child 만 보고하므로 위 created 루프가 'link' 자체를 못 지운다.
  // 치환된(=더 이상 symlink 아닌) 것만 제거. 여전히 symlink 면 baseline 상태=그대로 둠.
  // [Codex round5 Fix-3] baselineSymlinkPaths 에는 'symlink' reason 만 포함(위 선언 참조).
  // 'unclassified' 는 baseline 시점 타입 불명 → sweep 제외(실 디렉터리 파괴 방지).
  // [Codex round5 Fix-2] Advisory 비목표: symlink→symlink 치환은 target 을 읽지 않고는
  // 구분 불가(no-follow/leak-zero 불변식 충돌). 그런 경우 rollback 이 agent 교체 symlink 를
  // 남길 수 있음. 강한 격리는 OS/CLI 샌드박스(향후 B-tier) 로 이관.
  for (const p of baselineSymlinkPaths) {
    const abs = resolve(root, p)
    let st
    try {
      st = lstatSync(abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
    if (!st.isSymbolicLink()) removeCreated(p) // 여전히 symlink 면 baseline 상태=그대로 둠
  }
  // 2) backup 보유 엔트리 → 백업에서 복원(modified·deleted 모두 포함).
  for (const [path, entry] of baseline.entries) {
    if (entry.backup === null) continue // unrestorable — 복원 불가
    const abs = resolve(root, path)
    clearNonDirAncestors(root, abs) // [#128-B] 조상-파일 충돌 정리
    mkdirSync(dirname(abs), { recursive: true })
    let leafSt: import('node:fs').Stats | undefined
    try {
      leafSt = lstatSync(abs) // [#128-B2 P1] existsSync 는 symlink 추종→dangling link 를 놓침. lstat 직접.
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e // 진짜 부재만 무시, 그 외 fail-closed
    }
    if (leafSt && !leafSt.isFile()) {
      rmSync(abs, { recursive: true, force: true }) // 디렉터리/(dangling 포함)링크 leaf 제거 후 실파일 복원
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

// "경로검사 ≠ 격리"(advisory). 이 모듈은 *Fleet 자체 FS 연산*이 symlink/junction 을 따라가
// 워크스페이스 밖을 읽거나 쓰는 것을 줄이는 advisory guard다. 스폰된 CLI 의 직접 쓰기는 막지 못하며,
// lstat→open/write 사이 TOCTOU 창이 남는다(순수 Node 는 openat2/O_NOFOLLOW 크로스플랫폼 부재 —
// Windows 엔 O_NOFOLLOW 자체 없음). 강한 격리는 OS/CLI 샌드박스 층(#128 향후·문서 참조).
//
// namespace import — spy 가로채기가 환경에서 허용될 때 vi.spyOn(fs,'lstatSync')가 동작하도록
// 한다(ESM named-import 바인딩은 스파이가 가로채지 못함 — B1 m4 교훈).
// Windows ESM 환경에서는 Node 빌트인 프로퍼티가 non-configurable이라 spy가 "Cannot redefine
// property"로 실패한다 — 따라서 EINVAL spy 테스트는 best-effort 이다.
// 'suspicious' 분기의 실 커버리지는 POSIX 환경에서 FIFO를 생성하는 테스트가 담당한다.
// ⚠ **named import 로 고정**(#282 · Codex 9R): 네임스페이스 바인딩은 `export { fs }` 한 줄로
// 전체 fs 능력을 재-export 할 수 있어 경계 밖 소비자가 생긴다. 코어는 named 만 쓴다.
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** 경로의 종류를 lstat(링크 비추종)으로 판정한다.
 * 'link'  = POSIX symlink 또는 Windows junction(둘 다 lstat.isSymbolicLink()=true, 실증).
 * 'suspicious' = FIFO/socket/device 등 비정형, 또는 lstat 가 EINVAL/UNKNOWN throw
 *   (OneDrive/AppExecLink 등 exotic reparse) — 안전상 따라가지 않음(fail-closed).
 * 'missing' = ENOENT. */
export type LinkKind = 'regular' | 'dir' | 'link' | 'suspicious' | 'missing'

export function isLinkSync(abs: string): LinkKind {
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return 'link'
    if (st.isDirectory()) return 'dir'
    if (st.isFile()) return 'regular'
    return 'suspicious'
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    return 'suspicious'
  }
}

// win32 비교는 case-insensitive(NTFS) — 양변 case-fold.
const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** root realpath 기준으로 p 를 정준 절대경로로 해소하고 root 내부인지 검사한다.
 * lexical 비교는 symlink 비해소라 무력 → realpath 필수. 미존재 leaf 는
 * "최근접 존재 조상 realpath + 미존재 tail 재부착"으로 symlink 조상 탈출도 잡는다.
 * realpath 실패(exotic reparse/UNC) 또는 root 밖 → throw(fail-closed). */
export function resolveWithin(root: string, p: string): string {
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch (err) {
    throw new Error(`워크스페이스 realpath 해소 불가(운영 에러): ${root}`, { cause: err })
  }
  const abs = resolve(realRoot, p)
  // 최근접 존재 조상까지 올라가 그 조상의 realpath 를 구하고 미존재 tail 을 재부착한다.
  let existingAbs = abs
  const tail: string[] = []
  while (!existsSync(existingAbs)) {
    tail.unshift(basename(existingAbs))
    const parent = dirname(existingAbs)
    if (parent === existingAbs) break
    existingAbs = parent
  }
  let realCandidate: string
  try {
    const realExisting = realpathSync.native(existingAbs)
    realCandidate = tail.length ? resolve(realExisting, ...tail) : realExisting
  } catch (err) {
    throw new Error(`경로 realpath 해소 실패(안전상 거부): ${p}`, { cause: err })
  }
  const rel = relative(fold(realRoot), fold(realCandidate))
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  if (!inside) throw new Error(`경로가 워크스페이스 밖입니다: ${p}`)
  return realCandidate
}

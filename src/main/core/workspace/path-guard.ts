// namespace import — 테스트가 vi.spyOn(fs,'lstatSync')로 가로챌 수 있게 한다(ESM named-import
// 바인딩은 스파이가 가로채지 못함 — B1 m4 교훈).
import * as fs from 'node:fs'

/** 경로의 종류를 lstat(링크 비추종)으로 판정한다.
 * 'link'  = POSIX symlink 또는 Windows junction(둘 다 lstat.isSymbolicLink()=true, 실증).
 * 'suspicious' = FIFO/socket/device 등 비정형, 또는 lstat 가 EINVAL/UNKNOWN throw
 *   (OneDrive/AppExecLink 등 exotic reparse) — 안전상 따라가지 않음(fail-closed).
 * 'missing' = ENOENT. */
export type LinkKind = 'regular' | 'dir' | 'link' | 'suspicious' | 'missing'

export function isLinkSync(abs: string): LinkKind {
  try {
    const st = fs.lstatSync(abs)
    if (st.isSymbolicLink()) return 'link'
    if (st.isDirectory()) return 'dir'
    if (st.isFile()) return 'regular'
    return 'suspicious'
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing'
    return 'suspicious'
  }
}

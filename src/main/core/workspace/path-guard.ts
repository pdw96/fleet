// namespace import — spy 가로채기가 환경에서 허용될 때 vi.spyOn(fs,'lstatSync')가 동작하도록
// 한다(ESM named-import 바인딩은 스파이가 가로채지 못함 — B1 m4 교훈).
// Windows ESM 환경에서는 Node 빌트인 프로퍼티가 non-configurable이라 spy가 "Cannot redefine
// property"로 실패한다 — 따라서 EINVAL spy 테스트는 best-effort 이다.
// 'suspicious' 분기의 실 커버리지는 POSIX 환경에서 FIFO를 생성하는 테스트가 담당한다.
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

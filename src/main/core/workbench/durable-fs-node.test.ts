import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createNodeDurableFs } from './durable-fs'

/**
 * #251 PR2a T7 — 실 `DurableFs` 어댑터를 **실 파일시스템**에 대고 검증한다(§3-T59).
 *
 * 판정 규칙은 `durable-fs.test.ts` 가 페이크로 양 OS 에서 돌린다. 이 파일이 따로 있는 이유는 **페이크
 * 전용 조작화가 실물 성질을 증명하지 않기 때문**이다(PR1b 확립) — 여기서만 잡히는 것은 「Node/libuv 가
 * 실제로 무엇을 던지는가」다. 플랫폼 비대칭 행은 `describe.skipIf` 로 분리한다(조기 `return` 형 게이트는
 * skip 이 아니라 PASSED 로 집계되므로 금지 · 계획 정정 ㉚ⓐ).
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-durable-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('statKind — 읽기 전에 종류를 본다(정정 59)', () => {
  it('일반 파일은 regular 이고 바이트 크기를 준다', () => {
    const p = join(dir, 'rec.json')
    writeFileSync(p, '{"a":1}')
    expect(createNodeDurableFs().statKind(p)).toEqual({ kind: 'regular', size: 7 })
  })

  it('없는 경로는 missing 이다(throw 하지 않는다)', () => {
    expect(createNodeDurableFs().statKind(join(dir, 'nope'))).toEqual({ kind: 'missing', size: 0 })
  })

  /**
   * 디렉터리를 `other` 로 답해야 `readFileUtf8` 이 EISDIR 로 터지기 전에 호출자가 fail-closed 할 수 있다.
   * 형제 모듈이 같은 규율을 쓴다(coord-area.ts:181-186).
   */
  it('디렉터리는 other 다', () => {
    const p = join(dir, 'sub')
    mkdirSync(p)
    expect(createNodeDurableFs().statKind(p).kind).toBe('other')
  })

  /**
   * **「없음」과 「못 봄」은 다른 사실이다.** ENOENT 외의 실패를 `missing` 으로 뭉개면 호출자가 부재를
   * 근거로 create-only 쓰기를 시도해 잘못된 분기를 탄다(권위 레코드가 있는데 없다고 판단하는 경로).
   *
   * 조작화에 NUL 경로를 쓰는 이유: 이 레포가 실측한 대안들은 **플랫폼별로 갈린다**(`<파일>/sub` 는
   * win32 ENOENT / linux ENOTDIR · 0000 부모는 POSIX 전용). NUL 은 양 OS 에서 동일하게 「ENOENT 가
   * 아닌 실패」를 만드는 유일한 형태다 — 검증 대상은 errno 값이 아니라 **전파한다는 사실**이다.
   */
  it('ENOENT 가 아닌 실패는 삼키지 않고 전파한다', () => {
    expect(() => createNodeDurableFs().statKind(join(dir, 'a\0b'))).toThrow()
  })
})

describe('확인-응답 쓰기 왕복 — tmp 에 쓰고 rename 으로 교체한다(§3-T59)', () => {
  it('tmp→rename 후 대상이 새 내용이고 tmp 는 사라진다', () => {
    const fs = createNodeDurableFs()
    const target = join(dir, 'rec.json')
    const tmp = `${target}.owner.tmp`
    writeFileSync(target, '{"old":true}')

    const fd = fs.openExclusive(tmp, 0o600)
    fs.writeAll(fd, '{"new":true}')
    fs.fsync(fd)
    fs.close(fd)
    fs.rename(tmp, target)

    expect(fs.readFileUtf8(target)).toBe('{"new":true}')
    expect(fs.statKind(tmp).kind).toBe('missing')
  })

  it('openExclusive 는 create-only 다 — 기존 이름은 EEXIST', () => {
    const fs = createNodeDurableFs()
    const p = join(dir, 'taken')
    writeFileSync(p, 'x')
    expect(() => fs.openExclusive(p, 0o600)).toThrow(
      expect.objectContaining({ code: 'EEXIST' }) as Error,
    )
  })

  /**
   * 멀티바이트 왕복 — `writeAll` 이 바이트가 아니라 **문자** 오프셋으로 재개하면 한글 경계가 잘린다
   * (정정 66). 8KiB 한글은 단일 `writeSync` 로 다 나가므로 이 행이 루프 버그를 **잡지는 못한다** —
   * 그 조작화는 페이크 주입(`durable-fs.test.ts`)이 맡고, 여기서는 실 FS 왕복의 무손실만 고정한다.
   */
  it('한글 다바이트 내용이 손실 없이 왕복한다', () => {
    const fs = createNodeDurableFs()
    const p = join(dir, 'ko.json')
    const data = `{"t":"${'가나다라'.repeat(512)}"}`
    const fd = fs.openExclusive(p, 0o600)
    fs.writeAll(fd, data)
    fs.close(fd)
    expect(fs.readFileUtf8(p)).toBe(data)
    expect(fs.statKind(p).size).toBe(Buffer.byteLength(data, 'utf8'))
  })

  it('mkdirRecursive 는 중간 경로까지 만든다', () => {
    const fs = createNodeDurableFs()
    const deep = join(dir, 'a', 'b', 'authority')
    fs.mkdirRecursive(deep, 0o700)
    expect(fs.statKind(deep).kind).toBe('other')
  })

  it('unlinkIfExists 는 없는 경로에서 조용하고 있는 경로는 지운다', () => {
    const fs = createNodeDurableFs()
    const p = join(dir, 'gone.tmp')
    expect(() => fs.unlinkIfExists(p)).not.toThrow()
    writeFileSync(p, 'x')
    fs.unlinkIfExists(p)
    expect(fs.statKind(p).kind).toBe('missing')
  })

  /**
   * 관용은 **부재에만** 적용된다. 다른 실패(권한·비정형)를 삼키면 tmp 회수가 실패했는데도 성공으로
   * 보고돼, 다음 CAS 가 `openExclusive` 에서 EEXIST 로 막히는 원인을 잃는다(`statKind` 와 같은 규율).
   */
  it('unlinkIfExists 는 ENOENT 가 아닌 실패는 전파한다', () => {
    expect(() => createNodeDurableFs().unlinkIfExists(join(dir, 'a\0b'))).toThrow()
  })
})

/**
 * **POSIX 전용 행.** `openDir` 은 §W-5 가 「POSIX 전용」으로 규정한 프리미티브이고, Linux 에서
 * `openSync(dir,'r+')` 는 EISDIR 이라 `'r'` 이 유일한 형태다(3면 실측).
 */
describe.skipIf(process.platform === 'win32')('POSIX — 디렉터리 fsync 와 0700', () => {
  it('openDir 로 연 fd 에 fsync 가 성공한다(file+dir 등급의 실물 근거)', () => {
    const fs = createNodeDurableFs()
    const fd = fs.openDir(dir)
    try {
      expect(() => fs.fsync(fd)).not.toThrow()
    } finally {
      fs.close(fd)
    }
  })

  it('mkdirRecursive 의 mode 가 실제 권한이 된다', () => {
    const fs = createNodeDurableFs()
    const p = join(dir, 'authority')
    fs.mkdirRecursive(p, 0o700)
    expect(statSync(p).mode & 0o777).toBe(0o700)
  })

  it('openExclusive 의 mode 가 실제 권한이 된다', () => {
    const fs = createNodeDurableFs()
    const p = join(dir, 'rec.json')
    fs.close(fs.openExclusive(p, 0o600))
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })
})

/**
 * **win32 전용 행.** 스펙 §0.1 C3 이 `'file-only'` 강등의 근거로 든 EPERM 을 **정확한 조건에서** 고정한다
 * (계획 정정 61): 원인은 「디렉터리」가 아니라 **`'r'` fd 에 `GENERIC_WRITE` 가 없다**는 것이고, 같은
 * 이유로 **일반 파일**의 `'r'` fd 도 EPERM 이다. 이 대조 행이 없으면 「디렉터리라서 EPERM」이라는
 * 틀린 인과가 코드 주석·리뷰에 계속 살아남는다.
 */
describe.skipIf(process.platform !== 'win32')('win32 — fsync 는 쓰기 권한을 요구한다', () => {
  it('openDir(=r) 로 연 디렉터리 fd 의 fsync 는 EPERM 이다', () => {
    const fs = createNodeDurableFs()
    const fd = fs.openDir(dir)
    try {
      expect(() => fs.fsync(fd)).toThrow(expect.objectContaining({ code: 'EPERM' }) as Error)
    } finally {
      fs.close(fd)
    }
  })

  it('일반 파일도 읽기 전용 fd 면 같은 EPERM 이다(원인은 디렉터리가 아니다)', () => {
    const fs = createNodeDurableFs()
    const p = join(dir, 'plain.json')
    writeFileSync(p, 'x')
    const fd = openSync(p, 'r')
    try {
      expect(() => fs.fsync(fd)).toThrow(expect.objectContaining({ code: 'EPERM' }) as Error)
    } finally {
      closeSync(fd)
    }
  })
})

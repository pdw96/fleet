import { describe, expect, it } from 'vitest'

import { type DurableFs, probeDurability, writeAllBytes } from './durable-fs'

/**
 * #251 PR2a T7 — 내구 등급 판정(§W-5 · 계획 정정 60·61).
 *
 * 이 파일은 **양 OS 에서 돈다**. 실 파일시스템 어댑터의 플랫폼 성질은 `durable-fs-node.test.ts`
 * (게이트 분리)가 맡고, 여기서 검증하는 것은 **주입 seam 위의 판정 규칙**뿐이다(계획 §3.1 대응 ⓐ).
 */

/** 호출을 기록하는 최소 스텁 — 이 파일의 판정 규칙만 겨냥한다(전체 페이크는 `__testing__/`). */
const stubFs = (over: Partial<DurableFs> = {}): { fs: DurableFs; calls: string[] } => {
  const calls: string[] = []
  const rec =
    <T>(name: string, fn: () => T) =>
    (): T => {
      calls.push(name)
      return fn()
    }
  const fs: DurableFs = {
    readFileUtf8: () => '',
    statKind: () => ({ kind: 'missing', size: 0 }),
    mkdirRecursive: () => undefined,
    openExclusive: () => 1,
    writeAll: () => undefined,
    fsync: rec('fsync', () => undefined),
    close: rec('close', () => undefined),
    rename: () => undefined,
    openDir: rec('openDir', () => 2),
    unlinkIfExists: () => undefined,
    ...over,
  }
  return { fs, calls }
}

/**
 * `write` 를 한 번에 `chunk` 바이트까지만 받아들이는 페이크 — **실 파일시스템으로는 부분 쓰기를
 * 결정론적으로 만들 수 없으므로**(3면 실측: 8MiB 단일 호출도 전량 기록) 이 seam 이 정정 66 의 유일한
 * 조작화다. 받은 조각을 순서대로 이어 붙여 최종 바이트열을 관측한다.
 */
const chunkedWriter = (
  chunk: number,
): { write: (b: Buffer, o: number, l: number) => number; out: () => Buffer } => {
  const parts: Buffer[] = []
  return {
    write: (buf, off, len) => {
      const n = Math.min(chunk, len)
      parts.push(Buffer.from(buf.subarray(off, off + n)))
      return n
    },
    out: () => Buffer.concat(parts),
  }
}

describe('writeAllBytes — 부분 쓰기 재개는 바이트 오프셋이다(정정 66)', () => {
  it('write 가 한 번에 조금씩만 받아도 전량이 순서대로 기록된다', () => {
    const w = chunkedWriter(3)
    writeAllBytes(w.write, '{"a":12345}')
    expect(w.out().toString('utf8')).toBe('{"a":12345}')
  })

  /**
   * **문자 오프셋으로 재개하는 구현이 여기서만 RED 다.** 한글은 1자 = 3바이트라 `chunk=4` 면 매 조각이
   * 글자 경계를 가로지른다 — 반환된 바이트 수를 문자 인덱스로 오해하면 결과가 짧아지거나 깨진다.
   */
  it('한글 경계를 가로지르는 조각으로도 손실 없이 이어붙는다', () => {
    const data = `{"t":"${'가나다'.repeat(40)}"}`
    const w = chunkedWriter(4)
    writeAllBytes(w.write, data)
    expect(w.out().toString('utf8')).toBe(data)
    expect(w.out().length).toBe(Buffer.byteLength(data, 'utf8'))
  })

  it('빈 문자열이면 write 를 부르지 않는다', () => {
    let calls = 0
    writeAllBytes((_b, _o, l) => {
      calls++
      return l
    }, '')
    expect(calls).toBe(0)
  })
})

describe('probeDurability — 등급은 프로브가 유일 권위이되 승격은 금지한다', () => {
  it('POSIX 에서 디렉터리 fsync 가 성공하면 file+dir 이다', () => {
    const { fs, calls } = stubFs()
    expect(probeDurability(fs, '/area', 'linux')).toBe('file+dir')
    expect(calls).toContain('openDir')
  })

  it('POSIX 에서 디렉터리 fsync 가 실패하면 file-only 로 강등한다', () => {
    const { fs } = stubFs({
      fsync: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      },
    })
    expect(probeDurability(fs, '/area', 'linux')).toBe('file-only')
  })

  /**
   * **조용한 승격 금지**(정정 60 — U4 「조용한 강등 금지」의 쌍대). win32 에서 `openSync(dir,'r+')` 는
   * 실제로 fsync 까지 성공하지만(3면 실측), `FlushFileBuffers` 의 **디렉터리 핸들 의미론은 문서화되어
   * 있지 않다**(MS 문서는 파일·볼륨만 규정 · 정정 61). 따라서 win32 는 상한을 `'file-only'` 로 고정한다.
   *
   * 조작화가 「반환값 == 'file-only'」 단독이면 **프로브를 돌려놓고 결과를 버리는 구현**과
   * **애초에 시도하지 않는 구현**을 구분하지 못한다. 「`openDir` 호출 0」을 함께 단언해야
   * 「성공하는 프로브를 돌린 뒤 승격시키는」 미래 변경이 실제로 RED 가 된다.
   */
  it('win32 에서는 프로브를 시도하지 않고 file-only 로 상한 고정한다', () => {
    const { fs, calls } = stubFs()
    expect(probeDurability(fs, 'C:\\area', 'win32')).toBe('file-only')
    expect(calls).toEqual([])
  })
})

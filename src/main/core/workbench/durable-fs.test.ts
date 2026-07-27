import { describe, expect, it } from 'vitest'

import { type DurableFs, probeDurability, writeAllBytes } from './durable-fs'

/**
 * #251 PR2a T7 — 내구 등급 판정(§W-5 · 계획 정정 60·61).
 *
 * 이 파일은 **양 OS 에서 돈다**. 실 파일시스템 어댑터의 플랫폼 성질은 `durable-fs-node.test.ts`
 * (게이트 분리)가 맡고, 여기서 검증하는 것은 **주입 seam 위의 판정 규칙**뿐이다(계획 §3.1 대응 ⓐ).
 */

/**
 * **10 프리미티브 전부**를 기록하는 스텁. 일부만 기록하면 「호출 0」류 단언이 «기록되는 메서드를 부르지
 * 않았다»만 증언해, 부작용 있는 다른 프리미티브를 부르는 구현이 통과한다(자체 적대 리뷰 R2-8).
 * 인자도 함께 남긴다 — fd 스레딩(열린 fd 를 그대로 fsync·close 하는가)이 그것 없이는 미핀이다(R2-2).
 */
const stubFs = (
  over: Partial<DurableFs> = {},
): { fs: DurableFs; calls: string[]; log: { op: string; args: unknown[] }[] } => {
  const log: { op: string; args: unknown[] }[] = []
  const rec =
    <A extends unknown[], T>(op: string, fn: (...a: A) => T) =>
    (...args: A): T => {
      log.push({ op, args })
      return fn(...args)
    }
  const base: DurableFs = {
    readFileUtf8: rec('readFileUtf8', () => ''),
    statKind: rec('statKind', () => ({ kind: 'missing', size: 0 })),
    mkdirRecursive: rec('mkdirRecursive', () => undefined),
    openExclusive: rec('openExclusive', () => 1),
    writeAll: rec('writeAll', () => undefined),
    fsync: rec('fsync', () => undefined),
    close: rec('close', () => undefined),
    rename: rec('rename', () => undefined),
    openDir: rec('openDir', () => 2),
    unlinkIfExists: rec('unlinkIfExists', () => undefined),
  }
  // 오버라이드도 기록을 통과시킨다 — 아니면 실패 주입 케이스만 계측에서 빠진다.
  const fs = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(over)) {
    fs[k] = rec(k, v as (...a: unknown[]) => unknown)
  }
  return {
    fs: fs as unknown as DurableFs,
    get calls() {
      return log.map((e) => e.op)
    },
    log,
  }
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

  /**
   * **진행 보장.** `writeSync` 의 반환은 「기록된 바이트 수」일 뿐 전진을 보장하지 않는다. 가드가 없으면
   * 이 입력에서 루프가 영원히 돌고, 그때 CAS 는 **리스와 in-process 뮤텍스를 쥔 채** 고착된다 —
   * 실패가 RED 가 아니라 **hang** 으로 나타나므로 어떤 게이트도 신호를 내지 못한다.
   * 짧은 timeout 을 명시하는 이유가 그것이다(전역 20s 를 기다리면 회귀 진단이 느려진다).
   */
  it('전진하지 않는 write(0 반환)는 hang 이 아니라 실패다', () => {
    expect(() => writeAllBytes(() => 0, 'abc')).toThrow(/전진하지 않았다/)
  }, 3000)

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
  /**
   * 순서와 **fd 스레딩**을 함께 고정한다. 「openDir 을 불렀다」만 보면 열린 fd 를 버리고 다른 값을
   * fsync 하는 구현(또는 close 를 빠뜨려 fd 를 새는 구현)이 통과한다 — 후자는 D-9 가 금지하는
   * 장기 핸들을 매 부팅 1개씩 만든다.
   */
  it('POSIX 에서 열린 디렉터리 fd 를 fsync 하고 닫는다', () => {
    const { fs, log } = stubFs()
    expect(probeDurability(fs, '/area', 'linux')).toBe('file+dir')
    expect(log.map((e) => e.op)).toEqual(['openDir', 'fsync', 'close'])
    expect(log[0]?.args).toEqual(['/area'])
    // openDir 이 돌려준 fd(스텁은 2)가 그대로 두 후속 호출에 실린다.
    expect(log[1]?.args).toEqual([2])
    expect(log[2]?.args).toEqual([2])
  })

  it('fsync 가 실패해도 fd 를 닫는다(누수 금지)', () => {
    const { fs, log } = stubFs({
      fsync: () => {
        throw new Error('boom')
      },
    })
    expect(probeDurability(fs, '/area', 'linux')).toBe('file-only')
    expect(log.map((e) => e.op)).toEqual(['openDir', 'fsync', 'close'])
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

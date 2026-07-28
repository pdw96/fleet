import type { DurableFs, PathKind } from '../durable-fs'

/**
 * `DurableFs` 페이크 (#251 PR2b · 테스트 전용 · **실행되지 않고 import 만 된다**).
 *
 * PR2a 는 이것을 **취소**했다 — 소비자가 판정 규칙 테스트 하나뿐이라 「파일 하나에서만 import 되는
 * `__testing__` 모듈」이 될 참이었고 로컬 `stubFs` 20행으로 충분했다(ADR-0003 ROI). PR2b 에서 신설하는
 * 근거는 그때 예고한 조건이 실제로 도착했기 때문이다 — 단계 시퀀스(§3-T15)·실패 주입(§3-T16)·
 * 인터리브 타임라인(§3-T17d)을 **두 파일 이상이 공유**한다.
 *
 * ⚠ **캐스트 0 이 이 파일의 계약이다.** `__testing__` 아래 소스는 `.test.ts` 가 아니므로 eslint 브랜드 위조
 * 차단 블록(`eslint.config.mjs` workbench 블록 · `ignores` 가 테스트 파일만 제외)의 **프로덕션 스코프**이고
 * `@typescript-eslint/no-unsafe-type-assertion` 이 그대로 걸린다. PR2a 의 `stubFs` 가 쓰던
 * `as Record<string, unknown>`·`as unknown as DurableFs` 관용구를 여기로 **옮길 수 없다** — 그래서 오버라이드를
 * 스프레드 병합이 아니라 **주입 훅**으로 표현한다(계획 정정 91).
 *
 * ⚠ **실물보다 느슨하면 안 된다**(형제 `lock-backend-fake.ts` 가 확립한 규율). 실 어댑터가 던지는 자리를
 * 페이크가 조용히 통과시키면 PR2b 의 잘못된 구현이 이 페이크 위에서 GREEN 을 받는다. 그래서 실측으로
 * 확인된 세 성질을 그대로 재현한다: ⓐ`openExclusive` 는 **종류를 불문하고** 기존 이름에 EEXIST
 * (durable-fs.ts:72) ⓑ`readFileUtf8` 는 부재 시 ENOENT ⓒ`close` 된 fd 재사용은 EBADF(3면 실측).
 */

/** 내구 쓰기 프리미티브 전량 — 타임라인·호출 카운트의 키다. */
export type FakeOp =
  | 'readFileUtf8'
  | 'statKind'
  | 'mkdirRecursive'
  | 'openExclusive'
  | 'writeAll'
  | 'fsync'
  | 'close'
  | 'rename'
  | 'openDir'
  | 'unlinkIfExists'

export interface FakeCall {
  readonly op: FakeOp
  readonly args: readonly unknown[]
}

/** 페이크가 모델링하는 엔트리. `'other'` 는 FIFO·symlink·디렉터리 등 「정규 파일이 아님」 전부다. */
type Entry = { readonly kind: 'regular'; content: string } | { readonly kind: 'other' }

export interface FakeDurableFs extends DurableFs {
  /** 호출된 프리미티브 순서 — §3-T15 단계 시퀀스·§3-T17d 인터리브 판정의 관측면. */
  readonly steps: FakeOp[]
  /** 인자까지 남긴 전체 로그 — fd 스레딩(연 fd 를 그대로 fsync·close 하는가) 단언용. */
  readonly calls: FakeCall[]
  /** `op` 호출 횟수(§3-T14 읽기 카운터). */
  countOf(op: FakeOp): number
  /**
   * `op` 의 **`skip` 회를 통과시킨 뒤** 이어지는 `times` 회를 `err` 로 실패시킨다(§3-T16 단계별 주입).
   *
   * `skip` 이 필요한 이유는 내구 순서가 같은 프리미티브를 **두 번** 부르기 때문이다 — `fsync` 는
   * 파일(`fsync-file`)과 디렉터리(`fsync-dir`), `close` 는 `close-tmp` 와 `close-dir` 다. skip 없이는
   * 「디렉터리 차례만 실패」를 만들 수 없어 post-commit 분류(계획 정정 77)를 조작화할 수 없다.
   */
  failNext(op: FakeOp, err: Error, times?: number, skip?: number): void
  /** 디스크 상태 직접 조작 — 「외부(다른 프로세스·ttyd 셸)가 교체했다」를 만든다. */
  setFile(path: string, content: string): void
  setOther(path: string): void
  remove(path: string): void
  readRaw(path: string): string | undefined
  /** 현재 열린 fd 수 — 실패 경로의 **fd 누수** 단언용(0 이어야 한다). */
  openFdCount(): number
  /** 존재하는 경로 전량(정렬) — rename 후 tmp 부재·잔재 누적 단언용. */
  paths(): string[]
}

export interface FakeOptions {
  /** 초기 디스크 내용. */
  readonly initial?: Readonly<Record<string, string>>
  /**
   * 특정 프리미티브 **직전**에 끼워 넣을 훅. 인터리브(§3-T17d)·TOCTOU(외부가 statKind 와
   * readFileUtf8 사이에 파일을 바꾼다) 재현용. 스프레드 오버라이드를 대체한다(캐스트 0).
   */
  readonly before?: (op: FakeOp, args: readonly unknown[]) => void
}

export function createFakeDurableFs(opts: FakeOptions = {}): FakeDurableFs {
  const entries = new Map<string, Entry>()
  for (const [p, c] of Object.entries(opts.initial ?? {})) {
    entries.set(p, { kind: 'regular', content: c })
  }

  const steps: FakeOp[] = []
  const calls: FakeCall[] = []
  const pending = new Map<FakeOp, { err: Error; times: number; skip: number }>()
  /** fd → 대상 경로. `close` 로 지운다 — 남아 있으면 누수다. */
  const openFds = new Map<number, string>()
  let nextFd = 3 // 0·1·2 는 표준 스트림 — 실물과 같은 형태로 둔다.

  const errno = (code: string, message: string): Error => {
    const err: Error & { code?: string } = new Error(message)
    err.code = code
    return err
  }

  /** 모든 프리미티브의 공통 진입 — 계측·훅·실패 주입을 한 자리에 모은다. */
  const enter = (op: FakeOp, args: readonly unknown[]): void => {
    opts.before?.(op, args)
    steps.push(op)
    calls.push({ op, args })
    const f = pending.get(op)
    if (f !== undefined) {
      if (f.skip > 0) {
        pending.set(op, { ...f, skip: f.skip - 1 })
        return
      }
      if (f.times <= 1) pending.delete(op)
      else pending.set(op, { ...f, times: f.times - 1 })
      throw f.err
    }
  }

  const fdTarget = (fd: number): string => {
    const path = openFds.get(fd)
    // 실물과 같은 실패다(3면 실측: 닫힌 fd 는 EBADF) — 페이크가 조용히 통과시키면 fd 스레딩
    // 결함(다른 fd 를 fsync·close 하는 구현)이 이 위에서 GREEN 을 받는다.
    if (path === undefined) throw errno('EBADF', `닫혔거나 존재하지 않는 fd: ${fd}`)
    return path
  }

  return {
    steps,
    calls,
    countOf: (op) => calls.filter((c) => c.op === op).length,
    failNext: (op, err, times = 1, skip = 0) => void pending.set(op, { err, times, skip }),
    setFile: (path, content) => void entries.set(path, { kind: 'regular', content }),
    setOther: (path) => void entries.set(path, { kind: 'other' }),
    remove: (path) => void entries.delete(path),
    readRaw: (path) => {
      const e = entries.get(path)
      return e?.kind === 'regular' ? e.content : undefined
    },
    openFdCount: () => openFds.size,
    paths: () => [...entries.keys()].sort(),

    readFileUtf8(path) {
      enter('readFileUtf8', [path])
      const e = entries.get(path)
      if (e === undefined) throw errno('ENOENT', `없는 경로: ${path}`)
      // `'other'` 를 읽으려는 시도 자체가 결함이다 — 실물에서 FIFO 면 **무기한 블록**이라
      // 테스트가 hang 으로 나타난다. 페이크는 그것을 시끄러운 실패로 바꿔 원인을 보이게 한다.
      if (e.kind !== 'regular') throw errno('EINVAL', `정규 파일이 아닌 경로를 읽었다: ${path}`)
      return e.content
    },

    statKind(path): PathKind {
      enter('statKind', [path])
      const e = entries.get(path)
      if (e === undefined) return { kind: 'missing', size: 0 }
      if (e.kind !== 'regular') return { kind: 'other', size: 0 }
      return { kind: 'regular', size: Buffer.byteLength(e.content, 'utf8') }
    },

    mkdirRecursive(path, mode) {
      enter('mkdirRecursive', [path, mode])
    },

    openExclusive(path, mode) {
      enter('openExclusive', [path, mode])
      // create-only. **종류 불문**으로 기존 이름은 EEXIST(durable-fs.ts:72 실측) — 이 성질이
      // 계획 정정 78 의 「같은 리스의 다음 CAS 가 자기 tmp 로 자기잠금」을 재현하는 유일한 수단이다.
      if (entries.has(path)) throw errno('EEXIST', `이미 존재: ${path}`)
      entries.set(path, { kind: 'regular', content: '' })
      const fd = nextFd++
      openFds.set(fd, path)
      return fd
    },

    writeAll(fd, data) {
      enter('writeAll', [fd, data])
      const path = fdTarget(fd)
      const e = entries.get(path)
      if (e?.kind === 'regular') e.content += data
    },

    fsync(fd) {
      enter('fsync', [fd])
      fdTarget(fd)
    },

    close(fd) {
      enter('close', [fd])
      fdTarget(fd)
      openFds.delete(fd)
    },

    rename(from, to) {
      enter('rename', [from, to])
      const e = entries.get(from)
      if (e === undefined) throw errno('ENOENT', `없는 원본: ${from}`)
      entries.set(to, e)
      entries.delete(from)
    },

    openDir(path) {
      enter('openDir', [path])
      const fd = nextFd++
      openFds.set(fd, path)
      return fd
    },

    unlinkIfExists(path) {
      enter('unlinkIfExists', [path])
      entries.delete(path)
    },
  }
}

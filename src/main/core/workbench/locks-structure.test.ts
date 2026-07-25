import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as lockBackendUds from './lock-backend-uds'
import * as lockOrder from './lock-order'
import * as locks from './locks'

/**
 * #251 PR1b — 락 층의 **구조 단언**.
 *
 * 왜 행동 테스트로 부족한가: 이 슬라이스의 계약 중 셋은 「무엇을 **하지 않는가**」다 —
 *   ① L-6 판정에 **디스크 I/O 0**(계획 정정 ⑱: `DurableFs` 카운터 층이 PR2 소유라 셀 대상이 없고,
 *      유일 대안 `vi.spyOn(node:fs)` 는 §1-5 금지 ∧ win32 에서 조용히 무동작 = 정의상 false-GREEN)
 *   ② `server.address()` 를 보유·생존 판정 근거로 **쓰지 않음**(정정 ⑮: 그것은 입력 문자열의 에코다)
 *   ③ `release()` 가 `'close'` 이벤트를 **기다리지 않음**(정정 ㉞: 커넥션이 있으면 영구 미발화)
 * 셋 다 「그 코드가 존재하지 않음」이므로 소스 구조가 유일한 관측면이다.
 *
 * 방어 2종을 형제 선례(`boot-workbench.test.ts`·`ipc-parity`)에서 승계한다: ⓐ`stripComments`(없으면 주석
 * 한 줄로 false-GREEN/false-RED) ⓑ**앵커**(스캔 대상·매칭이 실재함을 먼저 단언 — 없으면 이름만 바뀌어도
 * 「0건」이 vacuous 통과).
 */

/** 블록/라인 주석 제거(`://` URL 보존 — `boot-workbench.test.ts:79-82` 동형). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** 이 PR 이 신설한 프로덕션 소스 전량. */
const LOCK_SOURCES = ['locks.ts', 'lock-order.ts', 'lock-backend-uds.ts'] as const
const source = (file: string): string => stripComments(readFileSync(join(HERE, file), 'utf8'))

describe('스캔 앵커 — 대상이 실재한다(아래 「0건」 단언이 vacuous 가 아님)', () => {
  it.each(LOCK_SOURCES)('%s 는 실재하고 비어 있지 않다', (file) => {
    expect(source(file).length).toBeGreaterThan(500)
  })

  it('스캔이 import 문을 실제로 본다(uds 어댑터의 node:net)', () => {
    expect(source('lock-backend-uds.ts')).toMatch(/from 'node:net'/)
  })
})

/**
 * ① L-6 「디스크 I/O 0」의 **구조층**. 모듈이 fs 를 아예 import 하지 않으면 판정 경로가 디스크를
 * 건드리는 것이 **구조적으로 불가능**하다 — 카운터보다 강한 단언이다(행동층은 `locks.test.ts` 의
 * 「revalidate 는 백엔드 조회만」 + 양성 통제가 담당).
 */
describe('T4 구조층 — 락 모듈은 파일시스템을 알지 못한다', () => {
  it.each(LOCK_SOURCES)('%s 는 node:fs 를 import 하지 않는다', (file) => {
    const src = source(file)
    expect(src).not.toMatch(/from 'node:fs(\/promises)?'/)
    expect(src).not.toMatch(/require\('node:fs/)
  })

  it.each(LOCK_SOURCES)('%s 는 파일 경로 조립도 하지 않는다(node:path 부재)', (file) => {
    expect(source(file)).not.toMatch(/from 'node:path'/)
  })
})

/** ② `address()` 는 `listen()` 인자의 에코이며 `close()` 후에도 남는다 — 판정 근거 금지. */
describe('T3 구조층 — server.address() 를 판정에 쓰지 않는다', () => {
  it.each(LOCK_SOURCES)('%s 에 .address( 호출이 0건', (file) => {
    expect(source(file)).not.toMatch(/\.address\(/)
  })

  it('앵커: 보유 판정은 `server.listening` 으로 한다(대체 근거가 실재)', () => {
    expect(source('lock-backend-uds.ts')).toMatch(/server\.listening/)
  })
})

/** ③ `release()` 가 `'close'` 를 기다리면, 누군가 connect 해 둔 동안 종료가 영구 지연된다. */
describe('T3 구조층 — 해제는 close 이벤트를 기다리지 않는다', () => {
  it('앵커: 어댑터가 server.close() 를 호출한다', () => {
    expect(source('lock-backend-uds.ts')).toMatch(/server\.close\(/)
  })

  it("어댑터에 'close' 이벤트 구독·대기가 0건", () => {
    expect(source('lock-backend-uds.ts')).not.toMatch(/['"]close['"]/)
  })
})

/**
 * 브랜드 위조 우회 4종(`as unknown as`·`as never`·`Parameters<`·`keyof`)은 tsc·현행 eslint 를 전부
 * 통과한다(실측 · 정정 ㉑) — 「미export 면 위조 불가」는 거짓이다. 기계 강제는 eslint 옵트인 룰이 하고,
 * 여기서는 **인가된 forge 지점의 개수를 정확히 고정**한다(「호출 부위 수 == 매칭 수」 관용구의 응용):
 * 브랜드 캐스트가 3개가 되는 순간 RED 다.
 */
describe('T6 구조층 — 브랜드 캐스트는 인가된 2곳뿐', () => {
  const productionSrc = LOCK_SOURCES.map(source).join('\n')

  /**
   * ⚠ 금지 목록은 **우회 vehicle** 만 담는다. 감사가 재현한 우회 4종 중 `keyof` 는 단독으로는 vehicle 이
   * 아니다(`keyof Parameters<typeof f>[0]` 처럼 **`Parameters<` 와 결합**해야 브랜드 타입을 재획득한다).
   * `keyof` 를 통째로 금지하면 `keyof typeof LOCK_LEVEL` 같은 정상 파생까지 막아 구현이 가드를 우회하는
   * 방향으로 수렴하므로, vehicle 인 `Parameters<` 를 막는다.
   */
  it.each([
    ['as unknown as', /as unknown as/],
    ['as never', /as never\b/],
    ['Parameters<', /Parameters</],
  ])('우회 패턴 %s 가 프로덕션 락 소스에 0건', (_label, pattern) => {
    expect(productionSrc).not.toMatch(pattern)
  })

  it('브랜드 민팅 캐스트는 정확히 2곳(BenchLeaseToken · Held) — 3번째가 생기면 RED', () => {
    const casts = productionSrc.match(/\bas (?:BenchLeaseToken|Held<L>)/g) ?? []
    expect(casts.sort()).toEqual(['as BenchLeaseToken', 'as Held<L>'])
  })
})

/**
 * export 집합 exact 동치 — §0 표의 「git 표면 export 는 **정확히 8개**」 선례.
 * raw 프리미티브(백엔드 `bind` 래퍼 등)가 실수로 공개 표면에 올라오면 서열 합성을 우회할 수 있으므로,
 * 「무엇이 공개인가」를 값 export 집합으로 고정한다(타입 전용 export 는 런타임에 나타나지 않는다).
 */
describe('T6 구조층 — 공개 표면 exact 동치', () => {
  it('locks.ts 값 export 9개', () => {
    expect(Object.keys(locks).sort()).toEqual([
      'ABSTRACT_NAME_MAX_BYTES',
      'ENDPOINT_PREFIX',
      'REPO_LOCK_KEY',
      'SLOT_INDEX_MAX',
      'availableLockBackends',
      'createLockScope',
      'endpointFor',
      'nameBudget',
      'withLeaseGuard',
    ])
  })

  it('lock-order.ts 값 export 3개 — 서열 합성만 공개한다', () => {
    expect(Object.keys(lockOrder).sort()).toEqual([
      'LOCK_LEVEL',
      'LockOrderViolationError',
      'createOrderedLocks',
    ])
  })

  it('lock-backend-uds.ts 값 export 1개 — 어댑터 팩토리뿐', () => {
    expect(Object.keys(lockBackendUds)).toEqual(['createAbstractSocketBackend'])
  })
})

/**
 * 주입 seam 방향 — 코어(`locks.ts`)는 실 어댑터를 **모른다**. 반대 방향이면 플랫폼 독립성이 깨져
 * win32 에서 코어를 import 하는 것만으로 Linux 전용 모듈이 로드된다.
 */
describe('주입 seam 방향 — 코어는 실 어댑터에 의존하지 않는다', () => {
  it('locks.ts 는 lock-backend-uds 를 import 하지 않는다', () => {
    expect(source('locks.ts')).not.toMatch(/lock-backend-uds/)
  })

  it('앵커: 반대 방향은 실재한다(어댑터가 코어 계약을 import)', () => {
    expect(source('lock-backend-uds.ts')).toMatch(/from '\.\/locks'/)
  })
})

/**
 * 페이크는 **프로덕션 소스에 절대 새지 않는다.** 새면 출하 번들에 테스트 더블이 들어가고, 더 나쁘게는
 * 실 백엔드 대신 페이크가 배선될 수 있다(락이 프로세스 경계를 넘지 못하는 조용한 fail-open).
 */
describe('__testing__ 페이크 격리', () => {
  const srcRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const productionFiles: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== '__testing__') walk(p)
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) productionFiles.push(p)
    }
  }
  walk(srcRoot)

  it('앵커: 스캔 대상 프로덕션 파일이 충분히 많다', () => {
    expect(productionFiles.length).toBeGreaterThan(50)
  })

  it('어떤 프로덕션 소스도 __testing__ 을 참조하지 않는다', () => {
    const hits = productionFiles.filter((f) =>
      stripComments(readFileSync(f, 'utf8')).includes('__testing__'),
    )
    expect(hits.map((f) => f.slice(srcRoot.length))).toEqual([])
  })

  it('앵커: 테스트는 실제로 페이크를 쓴다(위 0건이 「아무도 안 쓴다」가 아님)', () => {
    const users = readdirSync(HERE).filter(
      (f) => /\.test\.ts$/.test(f) && readFileSync(join(HERE, f), 'utf8').includes('__testing__'),
    )
    expect(users.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * 플랫폼 게이트 형태 — `it` 본문의 조기 `return` 은 skip 이 아니라 **PASSED 로 집계**되므로(레포 7건
 * 선례) 요약에서 「Linux 행이 실제로 건너뛰어졌다」를 확인할 수 없다. 이 슬라이스는 `describe.skipIf`
 * 만 쓴다.
 */
describe('플랫폼 게이트는 skipIf 만 쓴다(조기 return 금지)', () => {
  const testFiles = readdirSync(HERE).filter((f) => /\.test\.ts$/.test(f))

  it('앵커: 워크벤치 테스트 파일이 실재하고 skipIf 를 쓴다', () => {
    expect(testFiles.length).toBeGreaterThan(3)
    const withSkipIf = testFiles.filter((f) =>
      readFileSync(join(HERE, f), 'utf8').includes('describe.skipIf'),
    )
    expect(withSkipIf.length).toBeGreaterThan(0)
  })

  it.each([
    'locks.test.ts',
    'lock-order.test.ts',
    'lock-backend-uds.test.ts',
    'locks-structure.test.ts',
  ])('%s 에 process.platform 조기 return 형 게이트가 0건', (file) => {
    expect(stripComments(readFileSync(join(HERE, file), 'utf8'))).not.toMatch(
      /if\s*\(\s*process\.platform[^)]*\)\s*return/,
    )
  })
})

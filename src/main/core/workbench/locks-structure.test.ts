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
  // ⚠ `node:` 접두만 보면 **bare specifier**(`from 'fs'`)가 그대로 통과한다(CodeRabbit) — 두 표기는
  // 런타임에서 동일하다. 정적 import·`require`·동적 `import()` 3형태 × 두 표기를 한 술어로 덮는다.
  // (동적 import 누락은 이 레포가 #173·#174 에서 두 번 물린 계열이다.)
  const fsLike = (mod: string): RegExp =>
    new RegExp(
      String.raw`(?:from\s*|require\(\s*|import\(\s*)['"](?:node:)?${mod}(?:/promises)?['"]`,
    )

  it.each(LOCK_SOURCES)('%s 는 fs 를 어떤 표기로도 import 하지 않는다', (file) => {
    expect(source(file)).not.toMatch(fsLike('fs'))
  })

  it.each(LOCK_SOURCES)('%s 는 파일 경로 조립도 하지 않는다(path 부재)', (file) => {
    expect(source(file)).not.toMatch(fsLike('path'))
  })

  it('앵커: 이 술어가 실제 import 를 잡는다(형태별 자기검사)', () => {
    for (const sample of [
      "import { x } from 'fs'",
      "import { x } from 'node:fs'",
      "const x = require('fs')",
      "await import('node:fs/promises')",
    ]) {
      expect(sample).toMatch(fsLike('fs'))
    }
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

  /**
   * ⚠ 매칭은 **대상 타입 기준**이어야 한다. 처음 작성한 핀은 철자 `Held<L>` 만 세어서
   * `as Held<3>`(구체 레벨을 코드가 스스로 만들어내는 3번째 forge)와 앵글브래킷 단언 `<Held<0>>expr` 을
   * 아예 매칭하지 못했다 — 즉 「3번째가 생기면 RED」가 거짓이었다(자체 적대 리뷰 실측).
   */
  it('브랜드 민팅 캐스트는 정확히 2곳 — 임의 레벨(as Held<3>)·앵글브래킷 형까지 포함해 센다', () => {
    const casts = productionSrc.match(/\bas\s+(?:BenchLeaseToken|Held\s*<[^>]*>)/g) ?? []
    expect(casts.map((c) => c.replace(/\s+/g, ' '))).toEqual(['as BenchLeaseToken', 'as Held<L>'])
  })

  /**
   * ⚠ 술어는 **제네릭 타입 인자와 구분**돼야 한다 — 원안은 `new WeakSet<BenchLeaseToken>()` 같은
   * 정당한 제네릭을 캐스트로 오탐했다(Codex PR#264 P1 반영 중 실측). 앵글브래킷 단언은 표현식 **앞**에
   * 오므로 여는 `<` 앞에 식별자·`)`·`]` 가 오면 그것은 타입 인자다.
   */
  const ANGLE_ASSERT =
    /(?<![A-Za-z0-9_$)\]])<\s*(?:BenchLeaseToken|Held\s*<[^>]*>)\s*>\s*[{(A-Za-z]/

  it('앵글브래킷 형 타입 단언(<Held<0>>expr)이 프로덕션 락 소스에 0건', () => {
    expect(productionSrc).not.toMatch(ANGLE_ASSERT)
  })

  it('앵커: 술어가 단언은 잡고 제네릭 타입 인자는 통과시킨다', () => {
    expect('const x = <Held<0>>expr').toMatch(ANGLE_ASSERT)
    expect('return <BenchLeaseToken>obj').toMatch(ANGLE_ASSERT)
    expect('const s = new WeakSet<BenchLeaseToken>()').not.toMatch(ANGLE_ASSERT)
    expect('function f(): Map<BenchLeaseToken, number> { return m }').not.toMatch(ANGLE_ASSERT)
  })
})

/**
 * **L-1 재유입 가드**(§3-T60 재작성 · 계획 정정 ㉕). 생존 판정의 유일 근거는 `listen` 결과이며,
 * 연령·mtime·pid·`connect` 를 **어떤 경로에서도** 읽지 않는다. 어댑터가 이미 `node:net` 을 쥐고 있어
 * `connect` 프로브 재유입은 한 줄이면 가능하고, §0.1 C2 는 (축소 전 문안이라) 아직 ECONNREFUSED 를
 * 요구하므로 — 문면만으로는 재유입을 막지 못한다.
 */
describe('L-1 구조층 — 커널 배타성 외의 생존 신호가 재유입되지 않는다', () => {
  const productionSrc = LOCK_SOURCES.map(source).join('\n')

  it.each([
    ['connect 프로브', /\bconnect\s*\(/],
    ['ECONNREFUSED 판정', /ECONNREFUSED/],
    ['pid 조회', /\bprocess\.pid\b/],
    ['mtime·연령', /\bmtimeMs?\b|\bbirthtime/],
    ['시각 기반 판정', /\bDate\.now\s*\(/],
  ])('%s 가 프로덕션 락 소스에 0건', (_label, pattern) => {
    expect(productionSrc).not.toMatch(pattern)
  })

  it('앵커: 유일한 생존 근거(listen 결과·listening)가 실재한다', () => {
    expect(productionSrc).toMatch(/server\.listen\(/)
    expect(productionSrc).toMatch(/server\.listening/)
  })
})

/**
 * **raw 획득 경로 봉쇄**(계획 정정 ㉓ⓑ). `locks.ts` 의 `tryAcquire`/`tryAcquireBenchLease` 는 서열
 * 가드를 거치지 않는다 — 서열은 `lock-order.ts` 의 합성만이 집행한다. export 집합 핀은 이 구멍을 닫지
 * 못한다(`createLockScope` 자체는 인가된 export 이고 위반은 그 반환 객체의 **메서드 호출**이다).
 * 따라서 「누가 raw 경로를 부르는가」를 직접 고정한다.
 */
describe('T6 구조층 — raw 획득 경로 호출자는 서열 합성뿐', () => {
  const srcRoot = fileURLToPath(new URL('../../..', import.meta.url))
  /**
   * ⚠ **`g` 플래그 정규식을 파일별 `test()` 에 재사용하면 안 된다**(Codex·CodeRabbit 동시 지적):
   * `test()` 는 원본의 `lastIndex` 를 전진시켜 유지하므로, 다음 파일의 매치가 그 오프셋보다 앞에 있으면
   * **조용히 건너뛴다** → 우회가 실재해도 GREEN. 카운트용(전역)과 판정용(비전역)을 분리한다.
   * (같은 함정을 PR1a `ulid.ts` 가 `ULID_RE` 주석으로 이미 기록해 뒀다 — 형제 관용구를 놓쳤다.)
   */
  const RAW_CALL_ALL = /\.tryAcquire(?:BenchLease)?\s*\(/g
  const RAW_CALL = /\.tryAcquire(?:BenchLease)?\s*\(/

  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  walk(srcRoot)

  it('앵커: 인가된 호출부(lock-order.ts)에서 실제로 매칭된다(0건 매칭이면 아래가 vacuous)', () => {
    expect([...source('lock-order.ts').matchAll(RAW_CALL_ALL)]).toHaveLength(3)
  })

  it('프로덕션 소스 중 raw 획득을 부르는 파일은 lock-order.ts 뿐이다', () => {
    const callers = files
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => RAW_CALL.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(srcRoot.length).replace(/\\/g, '/'))
    expect(callers).toEqual(['main/core/workbench/lock-order.ts'])
  })
})

/**
 * `endpointFor` 가 예산 판정을 **실제로 거치는지**. 예산 초과는 현행 성분에서 도달 불가라
 * 행동 테스트로는 그 배선을 잡을 수 없다 — 호출 한 줄을 지워도 전 게이트가 무신호다(PR0 정정 ⑦ 계열).
 */
describe('예산 preflight 배선 — endpointFor 가 nameBudget 을 거친다', () => {
  it('locks.ts 의 endpointFor 본문이 nameBudget 을 호출한다', () => {
    const body = source('locks.ts').split('export function endpointFor')[1] ?? ''
    expect(body.slice(0, 400)).toMatch(/nameBudget\s*\(/)
  })
})

/**
 * 소스 위생 — **원시 NUL 바이트 금지**. git 은 NUL 이 있는 파일을 **바이너리로 분류**하므로 PR diff 가
 * 「Binary file not shown」이 되고 `grep`/ripgrep 도 라인을 내지 않는다. 이 레포의 리뷰(Codex·CodeRabbit)는
 * diff 를 읽는 봇에 의존하므로, 테스트 파일 하나가 통째로 리뷰 사각으로 사라진다(실측: 이 PR 이 실제로
 * 그 상태로 커밋됐다가 발각됐다). 제어문자는 이스케이프(`\u0000`)로 쓴다.
 */
describe('소스 위생 — 원시 NUL 바이트 0건(리뷰 diff 가 바이너리로 접히지 않는다)', () => {
  const srcRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) files.push(p)
    }
  }
  walk(srcRoot)

  it('앵커: 스캔 대상이 충분히 많다', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('src 전체 .ts/.tsx 에 0x00 바이트가 없다', () => {
    const offenders = files
      .filter((f) => readFileSync(f).includes(0))
      .map((f) => f.slice(srcRoot.length))
    expect(offenders).toEqual([])
  })
})

/**
 * export 집합 exact 동치 — §0 표의 「git 표면 export 는 **정확히 8개**」 선례.
 * raw 프리미티브(백엔드 `bind` 래퍼 등)가 실수로 공개 표면에 올라오면 서열 합성을 우회할 수 있으므로,
 * 「무엇이 공개인가」를 값 export 집합으로 고정한다(타입 전용 export 는 런타임에 나타나지 않는다).
 */
describe('T6 구조층 — 공개 표면 exact 동치', () => {
  // #251 PR1c: `INSTANCE_LOCK_KEY` 1개 증가(9→10). 인스턴스 배타는 **락이 아니지만** 이름 유도를
  // `endpointFor` 와 공유한다 — 예산 preflight 를 우회하는 두 번째 이름 조립 경로를 만들지 않기 위해서다.
  it('locks.ts 값 export 11개', () => {
    expect(Object.keys(locks).sort()).toEqual([
      'ABSTRACT_NAME_MAX_BYTES',
      'ENDPOINT_PREFIX',
      'INSTANCE_LOCK_KEY',
      'REPO_LOCK_KEY',
      'SLOT_INDEX_MAX',
      'availableLockBackends',
      'createLockScope',
      'endpointFor',
      'isMintedLease',
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

  /**
   * ⚠ 하드코딩 목록이 아니라 **디렉터리 전수**여야 한다(새 테스트 파일이 목록에 없으면 무신호).
   * 그리고 술어는 `process.platform` 직접 참조뿐 아니라 이 파일들이 실제로 쓰는 **alias**
   * (`const IS_LINUX = process.platform === 'linux'`)까지 덮어야 한다 — 처음 작성한 스캔은
   * `if (!IS_LINUX) return` 형을 그대로 통과시켰다(자체 적대 리뷰 실측).
   */
  it.each(testFiles)('%s 에 조기 return 형 플랫폼 게이트가 0건', (file) => {
    const src = stripComments(readFileSync(join(HERE, file), 'utf8'))
    // 플랫폼 판정에 쓰이는 식별자 전부(직접 참조 + 이 파일에서 선언된 alias)를 술어로 삼는다.
    const aliases = [...src.matchAll(/const\s+(\w+)\s*=\s*process\.platform\b/g)].map((m) => m[1])
    const terms = ['process\\.platform', ...aliases]
    for (const term of terms) {
      // ⚠ `)\s*return` 만 보면 `if (!IS_LINUX) {\n  return\n}` 형(실무에서 더 흔하다)을 놓친다(CodeRabbit).
      expect(src).not.toMatch(new RegExp(`if\\s*\\([^)]*${term}[^)]*\\)\\s*\\{?\\s*return`))
    }
  })

  it('앵커: 이 슬라이스가 실제로 플랫폼 alias 를 쓴다(위 스캔이 alias 축을 헛돌지 않음)', () => {
    const udsSrc = readFileSync(join(HERE, 'lock-backend-uds.test.ts'), 'utf8')
    expect(udsSrc).toMatch(/const\s+IS_LINUX\s*=\s*process\.platform/)
  })
})

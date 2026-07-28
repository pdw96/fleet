import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { StoreState } from '../store/types'

/**
 * #251 PR2a·PR2b — 계약 사슬의 **구조층**(§3-T62 D-9 분 · 계획 정정 75·76·90·91).
 *
 * 행동 테스트가 못 잡는 세 가지를 여기서 고정한다: ⓐ「하지 않음」(장기 핸들·직접 fs·플랫폼 재판정)
 * ⓑ「크기」 ⓒ「인가된 예외의 **개수**」. 전부 회귀 가드이므로 처음부터 GREEN 이다 — 그래서 **각 술어에
 * 자기검사 앵커를 붙인다**. 앵커가 없으면 오타 하나로 술어가 아무것도 매칭하지 않게 되어도 영원히
 * GREEN 이다(레포가 #137·#173 에서 물린 계열).
 *
 * ⚠ **목록을 하드코딩하지 않는다**(계획 정정 91). PR2a 판은 대상 파일을 `it.each(['authority.ts', …])` 로
 * 열거했는데, 그러면 **새 프로덕션 파일이 어떤 가드에도 걸리지 않은 채** 착지하고 핀은 GREEN 을 유지한다
 * (#137·#173 무신호 계열). 형제 `locks-structure.test.ts` 는 이미 `readdirSync` 전수 + 「목록이 아니라
 * 디렉터리」 규율을 명문화했으므로 그 비대칭을 여기서 없앤다. `__testing__` 도 **프로덕션으로 집계**한다 —
 * `.test.ts` 가 아니라서 eslint 브랜드 위조 차단 블록의 대상이기도 하다.
 */

const HERE = import.meta.dirname
const source = (file: string): string => readFileSync(join(HERE, file), 'utf8')

/** 블록·라인 주석 제거 — 주석 속 문자열이 위반으로 오탐되지 않게(형제 구조 테스트와 같은 술어). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 워크벤치 **프로덕션 전량**(테스트 제외 · `__testing__` 포함). 새 파일은 자동으로 편입된다. */
const PRODUCTION: readonly string[] = [
  ...readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort(),
  ...readdirSync(join(HERE, '__testing__'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join('__testing__', f))
    .sort(),
]

describe('전수 스캔의 전제 — 대상이 실재한다', () => {
  /**
   * **완전성 앵커.** 스캔이 0건을 훑으면 아래 모든 「위반 없음」 단언이 vacuous 다. 하한만 두는 이유는
   * 상한을 두면 정당한 파일 추가가 무관한 RED 를 내기 때문이다(문지기는 아래 개별 술어들이다).
   */
  it('프로덕션 파일을 실제로 수집한다', () => {
    expect(PRODUCTION.length).toBeGreaterThanOrEqual(12)
    expect(PRODUCTION).toContain('authority.ts')
    expect(PRODUCTION).toContain('durable-fs.ts')
    expect(PRODUCTION).toContain(join('__testing__', 'durable-fs-fake.ts'))
    // 테스트 파일이 섞이면 술어들이 테스트의 관용구를 위반으로 오탐한다.
    expect(PRODUCTION.filter((f) => f.endsWith('.test.ts'))).toEqual([])
  })
})

/**
 * **D-9 리더 규율**(§W-4 「리더 규율(불변식 D-9)」). 권위·저널 파일은 `readFileSync` 즉시-close 만 허용한다.
 * 장기 핸들·`createReadStream`·watch 는 그 자체가 **타 표면의 쓰기를 EPERM 으로 무한 차단하는 DoS 표면**이다 —
 * win32 는 대상에 열린 핸들이 하나라도 있으면 rename 이 EPERM 이고(3면 실측), 그 rename 이 곧 CAS 커밋이다.
 */
describe('D-9 리더 규율 — 워크벤치 프로덕션에 장기 핸들이 없다', () => {
  const LONG_HANDLE = /\b(?:createReadStream|createWriteStream|watchFile|watch)\s*\(/

  it.each(PRODUCTION)('%s 에 장기 핸들 생성이 없다', (file) => {
    expect(stripComments(source(file))).not.toMatch(LONG_HANDLE)
  })

  it('앵커: 술어가 실제 위반 형태를 잡는다', () => {
    for (const sample of [
      'const s = createReadStream(p)',
      'fs.watch(dir, cb)',
      'watchFile(p, cb)',
      'createWriteStream(p)',
    ]) {
      expect(sample).toMatch(LONG_HANDLE)
    }
    // 음성 통제 — 허용된 관용구는 잡히지 않는다.
    expect('readFileSync(path, "utf8")').not.toMatch(LONG_HANDLE)
  })
})

/**
 * **IO 전량 주입**(§W-5 「IO 전량 주입이 계약」). 권위 층이 `node:fs` 를 직접 import 하면 실패 주입이
 * `vi.spyOn(node:fs)` 로 밀려나는데, 그것은 win32 ESM 에서 조용히 skip 되어(실측 선례
 * `ignored-baseline.test.ts:142-149`) 단계별 실패 테스트 전체가 **false-GREEN** 이 된다.
 */
describe('fs 를 직접 아는 파일은 인가된 집합뿐이다', () => {
  const fsLike = /(?:from\s*|require\(\s*|import\(\s*)['"](?:node:)?fs(?:\/promises)?['"]/

  /**
   * **집합 exact 핀**이 하드코딩 목록보다 강한 이유: 「authority.ts 가 fs 를 안 쓴다」만 단언하면 장차
   * 신설되는 권위 관련 파일이 fs 를 직접 써도 **무신호**다. 여기서는 「fs 를 아는 파일이 정확히 이 넷」을
   * 고정하므로 어느 방향의 변화든 RED 다.
   */
  it('fs importer 집합이 정확히 인가된 넷이다', () => {
    const importers = PRODUCTION.filter((f) => fsLike.test(source(f)))
    expect(importers.sort()).toEqual([
      'active-instance.ts',
      'coord-area.ts',
      'durable-fs.ts',
      'instance-marker-proc.ts',
    ])
  })

  it('authority.ts 는 그 집합에 없다(권위 층은 전량 주입)', () => {
    expect(source('authority.ts')).not.toMatch(fsLike)
  })

  it('앵커: 술어가 실제 import 를 잡는다(형태별 자기검사)', () => {
    for (const sample of [
      "import { readFileSync } from 'fs'",
      "import x from 'node:fs'",
      "const x = require('fs')",
      "await import('node:fs/promises')",
    ]) {
      expect(sample).toMatch(fsLike)
    }
    // 대조: 실 어댑터는 fs 를 써야 하므로 같은 술어가 그 파일에서는 **매칭돼야** 한다(술어 생존 확인).
    expect(source('durable-fs.ts')).toMatch(fsLike)
  })

  /**
   * **주입 seam 방향 핀**(형제 `locks-structure.test.ts` 동형 · 자체 적대 리뷰 R1-2). 위 fs 술어는
   * `'./durable-fs'` 를 매칭하지 않으므로, 편의를 위해 `import { createNodeDurableFs } from './durable-fs'`
   * 로 기본값 주입을 만들면 **전 게이트가 GREEN 인 채로** 「IO 전량 주입」이 깨진다.
   */
  it('authority.ts 는 실 어댑터를 값으로 import 하지 않는다(타입만 허용)', () => {
    const src = stripComments(source('authority.ts'))
    expect(src).not.toMatch(/import\s+\{[^}]*createNodeDurableFs/)
    // ⚠ **의미 단위**로 본다(계획 정정 99): PR2a 판은 `import type { DurabilityLevel } from …` 을 문면
    // exact 로 박아 두어서, PR2b 가 같은 문장에 `DurableFs` 를 합치는 **정당한 변경**이 RED 였다.
    // 아래 자기검사가 남아 있으므로 이 완화는 방어 축소가 아니다.
    expect(src).toMatch(/import type \{[^}]*\bDurableFs\b[^}]*\} from '\.\/durable-fs'/)
    expect(src).toMatch(/import type \{[^}]*\bDurabilityLevel\b[^}]*\} from '\.\/durable-fs'/)
  })

  it('앵커: 방향 술어가 값 import 를 잡고 타입 import 는 통과시킨다', () => {
    const valueImport = "import { createNodeDurableFs } from './durable-fs'"
    const typeImport = "import type { DurableFs } from './durable-fs'"
    expect(valueImport).toMatch(/import\s+\{[^}]*createNodeDurableFs/)
    expect(typeImport).not.toMatch(/import\s+\{[^}]*createNodeDurableFs/)
  })
})

/**
 * **store 는 영역도 플랫폼도 재유도하지 않는다**(계획 정정 76·해당 감사 4렌즈 수렴).
 *
 * ⓐ`<area>` 유도는 `coord-area.ts` 단일 지점이고 그 산출물은 `realpathSync.native` 로 정준화돼 있다.
 * 여기서 다시 만들면 「정준 root ≠ store root」가 성립해 **배타와 쓰기가 다른 경로**를 가리킨다.
 * ⓑ내구 등급은 **프로브가 유일 권위**다(§W-5). store 가 `process.platform` 을 보면 판정자가 둘이 되어
 * 「갖지 않은 내구성을 레코드가 주장」하거나 「매 CAS 가 `commit-uncertain`」이 된다.
 */
describe('authority.ts 는 영역·플랫폼을 재유도하지 않는다(정정 76)', () => {
  const src = (): string => stripComments(source('authority.ts'))

  it('코디네이션 영역 이름을 스스로 만들지 않는다', () => {
    expect(src()).not.toMatch(/AREA_DIR_NAME/)
    expect(src()).not.toMatch(/['"]fleet['"]/)
    expect(src()).not.toMatch(/from\s*['"]\.\/coord-area['"]/)
  })

  it('플랫폼을 스스로 판정하지 않는다', () => {
    expect(src()).not.toMatch(/process\.platform/)
    expect(src()).not.toMatch(/['"]win32['"]/)
  })

  it('앵커: 두 술어가 실제 위반 형태를 잡는다', () => {
    expect("join(gitDir, 'fleet', 'authority')").toMatch(/['"]fleet['"]/)
    expect("import { AREA_DIR_NAME } from './coord-area'").toMatch(/AREA_DIR_NAME/)
    expect("import { x } from './coord-area'").toMatch(/from\s*['"]\.\/coord-area['"]/)
    // ⚠ 샘플을 `if (…) return` 형으로 쓰지 않는다 — 형제 `locks-structure.test.ts` 의 「조기 return 형
    // 플랫폼 게이트」 전수 스캔이 **문자열 리터럴 안까지** 훑어서(주석만 벗긴다) 이 앵커 자체를
    // 위반으로 오탐한다(실측: 그 형태로 쓰자 즉시 RED). 술어를 검증하는 목적은 삼항으로도 동일하다.
    expect("const lvl = process.platform === 'win32' ? 'file-only' : 'file+dir'").toMatch(
      /process\.platform/,
    )
    expect("const w = 'win32'").toMatch(/['"]win32['"]/)
    // 음성 통제 — 정상 코드는 잡히지 않는다.
    expect('const p = join(opts.authorityDir, `${id}.json`)').not.toMatch(/['"]fleet['"]/)
  })
})

/**
 * 브랜드 심볼은 **미export** 여야 한다(§W-4 「브랜드 심볼 미export · 민팅은 라이브 핸들에서만」).
 * export 되면 다른 모듈이 정상 문법으로 토큰을 조립할 수 있어 「CAS 성공 시에만 존재」가 무너진다 —
 * eslint `no-unsafe-type-assertion` 은 캐스트를 잡지 **캐스트 없는 조립**을 잡지 못한다.
 */
describe('브랜드 심볼 — 미export 가 계약이다', () => {
  /** 목록이 아니라 **소스에서 추출**한다 — 새 브랜드가 생겨도 자동으로 대상이 된다. */
  const declaredBrands = (file: string): string[] =>
    [...stripComments(source(file)).matchAll(/declare const (\w+): unique symbol/g)].map(
      (m) => m[1] ?? '',
    )

  it('authority.ts 가 선언한 브랜드를 실제로 찾는다(추출 앵커)', () => {
    expect(declaredBrands('authority.ts').sort()).toEqual(['AUTHORITY_COMMIT', 'FRESH_READ'])
  })

  it.each(PRODUCTION)('%s 의 브랜드 선언이 하나도 export 되지 않는다', (file) => {
    const src = stripComments(source(file))
    for (const name of declaredBrands(file)) {
      expect(src).not.toMatch(new RegExp(String.raw`export\s+declare\s+const\s+${name}\b`))
      expect(src).not.toMatch(new RegExp(String.raw`export\s*\{[^}]*\b${name}\b`))
    }
  })
})

/**
 * **인가된 forge 개수 핀**(계획 정정 90 · 형제 `locks-structure.test.ts:104-130` 동형).
 *
 * 브랜드는 `declare const` 라 **런타임 값이 없으므로** 토큰은 캐스트로만 만들어진다. 그 캐스트가 곧
 * 「CAS 성공 시에만 존재」·「같은 임계 구역에서 방금 읽었다」의 물리적 독점 지점이므로 **개수가 계약**이다.
 *
 * ⚠ 형제 핀은 `LOCK_SOURCES` 3파일에만 걸려 있어서 authority 의 새 forge 2곳이 **무핀**이었다. 그리고
 * 「브랜드 심볼이 미export 라 다른 파일은 캐스트조차 못 한다」는 **거짓**이다 — 브랜드 프로퍼티가 없는
 * 객체도 대상 타입에 assignable 이라 `expr as AuthorityCommit` 이 다른 파일에서 그대로 컴파일된다.
 * 그래서 이 핀은 **디렉터리 전수**여야 한다.
 */
describe('브랜드 캐스트는 인가된 지점뿐이다(정정 90)', () => {
  const productionSrc = PRODUCTION.map((f) => stripComments(source(f))).join('\n')

  it.each([
    ['as unknown as', /as unknown as/],
    ['as never', /as never\b/],
    ['Parameters<', /Parameters</],
  ])('우회 vehicle %s 가 워크벤치 프로덕션에 0건', (_label, pattern) => {
    expect(productionSrc).not.toMatch(pattern)
  })

  /**
   * 매칭은 **대상 타입 기준**이다 — 철자만 세면 `as Held<3>` 형(코드가 구체 레벨을 스스로 만드는 forge)과
   * 앵글브래킷 단언 `<X>expr` 을 놓친다(형제가 자체 적대 리뷰에서 실측한 함정).
   */
  const BRANDED = /\bas\s+(?:FreshReadToken|AuthorityCommit|BenchLeaseToken|Held\s*<[^>]*>)/g

  /**
   * 워크벤치 **전체**의 인가된 forge 는 넷이다 — 리스(`locks.ts`) · 서열 레벨(`lock-order.ts`) ·
   * 읽기 토큰과 커밋 토큰(`authority.ts`). 형제 `locks-structure.test.ts` 의 같은 핀은 `LOCK_SOURCES`
   * 3파일만 세므로 앞의 둘만 덮는다 — 이 핀이 그것을 **포함하면서** 디렉터리 전수로 확장한 판이다
   * (둘 다 남겨 둔다: 형제 핀은 「락 소스 안에서 2곳」이라는 더 좁고 강한 성질을 계속 증언한다).
   */
  it('브랜드 민팅 캐스트가 정확히 인가된 4곳이다(디렉터리 전수)', () => {
    const casts = (productionSrc.match(BRANDED) ?? []).map((c) => c.replace(/\s+/g, ' '))
    expect(casts.sort()).toEqual([
      'as AuthorityCommit',
      'as BenchLeaseToken',
      'as FreshReadToken',
      'as Held<L>',
    ])
  })

  /**
   * 앵글브래킷 형 단언은 표현식 **앞**에 오므로, 여는 `<` 앞에 식별자·`)`·`]` 가 오면 그것은 타입 인자다
   * (형제가 `new WeakSet<BenchLeaseToken>()` 오탐으로 물린 자리 — 그 보정을 그대로 승계한다).
   */
  const ANGLE_ASSERT =
    /(?<![A-Za-z0-9_$)\]])<\s*(?:FreshReadToken|AuthorityCommit|BenchLeaseToken)\s*>\s*[{(A-Za-z]/

  it('앵글브래킷 형 타입 단언이 워크벤치 프로덕션에 0건', () => {
    expect(productionSrc).not.toMatch(ANGLE_ASSERT)
  })

  it('앵커: 술어가 단언은 잡고 제네릭 타입 인자는 통과시킨다', () => {
    expect('const x = <AuthorityCommit>expr').toMatch(ANGLE_ASSERT)
    expect('return <FreshReadToken>obj').toMatch(ANGLE_ASSERT)
    expect('const s = new WeakSet<FreshReadToken>()').not.toMatch(ANGLE_ASSERT)
    expect('function f(): Map<AuthorityCommit, number> { return m }').not.toMatch(ANGLE_ASSERT)
    // 개수 술어 자기검사 — 3번째 forge 가 생기면 실제로 잡힌다.
    expect('const t = raw as FreshReadToken').toMatch(BRANDED)
  })
})

/**
 * **§3-T53 — 권위 상태가 기존 store 로 새지 않는다**(계획 정정 84).
 *
 * ⚠ **런타임 키 열거로 조작화하면 false-GREEN 이다.** `StoreState` 는 필수 6 + **옵셔널 4** 인데
 * `emptyState()` 는 6키만 반환하므로(`store/types.ts` 가 「emptyState 엔 미포함」을 명시), `Object.keys`
 * 기반 단언은 **옵셔널 키 추가를 영원히 놓친다** — 그리고 권위 누출의 전형이 정확히 옵셔널 필드 추가다.
 * 레포 전수 grep 상 `keyof StoreState` 기반 핀은 이 파일 이전에 **0건**이었다.
 *
 * §W-4 T21 이 「기존 로컬 레코드 없음」 전제의 근거로 이 행을 인용하므로, 이것이 무신호면 계약 6항
 * 논증 전체가 무신호 위에 선다.
 */
describe('§3-T53 StoreState 키 집합 불변 — 타입 수준 exact 핀', () => {
  /** 양방향 포함 = 정확 동치. 어느 쪽이 늘어도 `true` 대입이 tsc RED 다. */
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

  const STORE_STATE_KEYS = [
    'projects',
    'tasks',
    'rooms',
    'messages',
    'events',
    'sessions',
    'lastActiveProjectId',
    'updaterChannel',
    'droppedEventCount',
    'eventSeq',
  ] as const

  /**
   * **이 줄이 판정자다** — vitest 가 아니라 `npm run typecheck` 가 집행한다. bench/권위 키가
   * `StoreState` 에 추가되는 순간 `Exact<…>` 가 `false` 로 무너져 `true` 대입이 컴파일되지 않는다.
   */
  const keysAreExact: Exact<keyof StoreState, (typeof STORE_STATE_KEYS)[number]> = true

  it('키 집합이 정확히 10개이고 권위 키가 섞여 있지 않다', () => {
    expect(keysAreExact).toBe(true)
    expect(STORE_STATE_KEYS).toHaveLength(10)
    for (const k of STORE_STATE_KEYS) {
      expect(k).not.toMatch(/bench|authority|workbench/i)
    }
  })

  /**
   * 앵커: 「런타임 열거였다면 무엇을 놓쳤는가」를 명시한다 — `emptyState()` 는 옵셔널 4개를 내지 않으므로
   * 그것에 기댄 단언은 옵셔널 키 추가에 **무반응**이다. 이 행이 위 타입 핀의 존재 이유를 고정한다.
   */
  it('앵커: 선언 키가 필수 6개를 넘어 옵셔널까지 덮는다', () => {
    const requiredOnly = ['projects', 'tasks', 'rooms', 'messages', 'events', 'sessions']
    expect(STORE_STATE_KEYS.length).toBeGreaterThan(requiredOnly.length)
    for (const k of ['lastActiveProjectId', 'updaterChannel', 'droppedEventCount', 'eventSeq']) {
      expect(STORE_STATE_KEYS).toContain(k)
    }
  })
})

/**
 * **실 어댑터는 얇아야 한다**(계획 정정 75). 이 파일의 플랫폼 전용 행은 반대편 OS 의 **분모에만** 들어가므로
 * (POSIX `openDir` ↔ win32 rename 재시도), 규칙이 여기로 새면 커버리지 손실이 양방향으로 커진다.
 */
describe('durable-fs.ts — 실 어댑터 두께 상한', () => {
  // **구속력 있는 수치는 코드행 하나뿐**이다. 물리행 상한은 실측 직후 곧바로 역효과를 냈다 —
  // 「부분 쓰기 근거가 API 계약이지 관측이 아니다」라는 **정직성 주석을 추가하자 상한을 넘었다**(203/200).
  // 이 레포는 근거를 주석으로 남기는 것이 규율이므로, 물리행을 조이면 그 규율에 **주석을 줄이라는 압력**을
  // 거는 셈이고 그것은 이 가드가 지키려던 것(규칙이 어댑터로 새지 않음)과 무관하다.
  it('전체 물리행이 안전망(280) 이내다', () => {
    expect(source('durable-fs.ts').split('\n').length).toBeLessThanOrEqual(280)
  })

  it('주석을 뺀 코드 행이 상한(110) 이내다 — 규칙이 어댑터로 새지 않았다', () => {
    const code = stripComments(source('durable-fs.ts'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
    expect(code.length).toBeLessThanOrEqual(110)
  })
})

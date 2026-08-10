// scripts/engines-floor.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  analyzeEngines,
  blockersFor,
  determinants,
  explain,
  formatIntervals,
  intersect,
  intersectAll,
  parseRange,
  subtract,
  toRangeString,
  treeConstraints,
} from './engines-floor.mjs'

/**
 * `engines.node` 범위 교집합 게이트(#283).
 *
 * **왜 verify 층인가**: `engine-strict=true` 라 선언과 트리가 어긋나면 `npm ci` 가 EBADENGINE 로
 * 하드 실패하는데, 그 정합을 지키던 수단이 손으로 돌리는 점 표본이었고 두 번 연속 낡았다
 * (#279·#280·#281). 실측된 결론은 「사람이 돌리는 절차로는 정확도가 안 나온다」였다.
 *
 * **왜 합성 입력 단위 테스트가 핵심인가**: 실제 레포는 지금 **정합**이라, 라이브 단언만 두면 첫
 * 구현이 무조건 GREEN 이고 반증력이 0 인지 알 길이 없다(뮤테이션 자기검사 규율). 그래서 과대선언·
 * 과소선언·미러 드리프트·optional 오포함을 **합성 락파일로 각각 재현**해 RED 를 실측한다.
 */

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

/** 최소 락파일 — `packages` 맵만 있으면 된다. */
const lockOf = (
  root: string | null,
  entries: Record<string, { engines?: string; optional?: boolean; dev?: boolean }>,
) => ({
  packages: {
    '': root === null ? {} : { engines: { node: root } },
    ...Object.fromEntries(
      Object.entries(entries).map(([path, e]) => [
        path,
        {
          ...(e.engines === undefined ? {} : { engines: { node: e.engines } }),
          ...(e.optional === undefined ? {} : { optional: e.optional }),
          ...(e.dev === undefined ? {} : { dev: e.dev }),
        },
      ]),
    ),
  },
})

const pkgOf = (range: string) => ({ engines: { node: range } })

describe('parseRange — 구간 변환', () => {
  it('캐럿·부분 상한을 릴리스 구간으로 접는다', () => {
    expect(formatIntervals(parseRange('^22.22.2'))).toBe('[22.22.2, 23.0.0)')
    expect(formatIntervals(parseRange('>=22.22.2 <23'))).toBe('[22.22.2, 23.0.0)')
  })

  it('`<23` 과 `<23.0.0` 이 같은 구간이다(semver 의 합성 `-0` 을 벗긴다)', () => {
    expect(formatIntervals(parseRange('>=22.0.0 <23'))).toBe(
      formatIntervals(parseRange('>=22.0.0 <23.0.0')),
    )
  })

  /**
   * **회귀 가드**: semver 의 comparator 는 `1.2.3`·`=1.2.3` 을 `operator: ''` 로 낸다 — `*`(ANY)와
   * 같은 연산자 문자열이다. 이 둘을 구분하지 않고 「빈 연산자 = 무제약」으로 넘기면 **고정 버전
   * 선언이 통째로 사라져** 교집합이 조용히 넓어진다(구현 중 실측한 함정).
   */
  it('고정 버전은 무제약이 아니라 점 구간이다', () => {
    expect(formatIntervals(parseRange('20.11.0'))).toBe('[20.11.0, 20.11.0]')
    expect(formatIntervals(parseRange('=20.11.0'))).toBe('[20.11.0, 20.11.0]')
    expect(formatIntervals(parseRange('*'))).toBe('(-∞, +∞)')
  })

  it('OR 절을 disjoint 구간 리스트로 정렬·병합한다', () => {
    expect(formatIntervals(parseRange('18 || 20 || >=22'))).toBe(
      '[18.0.0, 19.0.0) ∪ [20.0.0, 21.0.0) ∪ [22.0.0, +∞)',
    )
    // 맞닿는 구간은 하나로 접힌다.
    expect(formatIntervals(parseRange('>=1.0.0 <2.0.0 || >=2.0.0'))).toBe('[1.0.0, +∞)')
  })

  it('AND 절이 모순이면 그 절이 사라진다', () => {
    expect(formatIntervals(parseRange('>=20.0.0 <18.0.0 || >=22.0.0'))).toBe('[22.0.0, +∞)')
  })

  it('잘못된 범위·prerelease 경계는 조용히 근사하지 않고 throw 한다(fail-closed)', () => {
    expect(() => parseRange('not a range')).toThrow()
    expect(() => parseRange('>=22.0.0-beta.1')).toThrow(/prerelease/)
  })
})

describe('intersect · subtract — 구간 대수', () => {
  it('교집합이 양쪽 경계를 좁힌다', () => {
    const a = parseRange('>=20.0.0')
    const b = parseRange('^22.0.0 || >=24.0.0')
    expect(formatIntervals(intersect(a, b))).toBe('[22.0.0, 23.0.0) ∪ [24.0.0, +∞)')
  })

  it('차집합이 경계 포함성을 뒤집어 낸다', () => {
    expect(formatIntervals(subtract(parseRange('>=20.0.0'), parseRange('>=22.0.0')))).toBe(
      '[20.0.0, 22.0.0)',
    )
    expect(formatIntervals(subtract(parseRange('>=22.0.0'), parseRange('>=20.0.0')))).toBe('∅')
  })

  it('구멍이 있는 집합의 차집합', () => {
    const declared = parseRange('>=22.0.0')
    const tree = parseRange('^22.0.0 || >=24.0.0')
    expect(formatIntervals(subtract(declared, tree))).toBe('[23.0.0, 24.0.0)')
  })

  it('toRangeString 이 다시 파싱해도 같은 집합이다(왕복)', () => {
    for (const src of ['^22.22.2 || ^24.15.0 || >=26.0.0', '>=18.0.0', '20.11.0', '*']) {
      const ivs = parseRange(src)
      expect(formatIntervals(parseRange(toRangeString(ivs)))).toBe(formatIntervals(ivs))
    }
  })
})

describe('treeConstraints — 락파일 스코프 규칙', () => {
  it('루트 항목은 제약이 아니다(넣으면 자기확인이 된다)', () => {
    const { declarationCount, constraints } = treeConstraints(
      lockOf('>=99.0.0', { 'node_modules/a': { engines: '>=18.0.0' } }),
    )
    expect(declarationCount).toBe(1)
    expect(constraints).toHaveLength(1)
    expect(constraints[0].range).toBe('>=18.0.0')
  })

  it('optional 은 제외한다(npm 이 engines 로 설치를 막지 않는다 — #281 최소 재현)', () => {
    const { declarationCount } = treeConstraints(
      lockOf(null, {
        'node_modules/a': { engines: '>=18.0.0' },
        'node_modules/b': { engines: '>=99.0.0', optional: true },
      }),
    )
    expect(declarationCount).toBe(1)
  })

  it('dev 는 제외하지 않는다(`npm ci --omit=dev` 도 EBADENGINE 로 죽는다)', () => {
    const { constraints } = treeConstraints(
      lockOf(null, { 'node_modules/d': { engines: '>=24.0.0', dev: true } }),
    )
    expect(formatIntervals(intersectAll(constraints))).toBe('[24.0.0, +∞)')
  })

  it('같은 범위 문자열은 한 제약으로 묶고 패키지명을 모은다', () => {
    const { declarationCount, constraints } = treeConstraints(
      lockOf(null, {
        'node_modules/which': { engines: '^22.0.0' },
        'node_modules/jsdom': { engines: '^22.0.0' },
        'node_modules/x/node_modules/which': { engines: '^22.0.0' },
      }),
    )
    expect(declarationCount).toBe(3)
    expect(constraints).toHaveLength(1)
    expect(constraints[0].packages).toEqual(['jsdom', 'which'])
  })

  it('engines.node 가 없는 항목은 무시한다', () => {
    expect(treeConstraints(lockOf(null, { 'node_modules/a': {} })).declarationCount).toBe(0)
  })
})

describe('analyzeEngines — 판정(합성 입력으로 반증력을 실측)', () => {
  const tree = {
    'node_modules/which': { engines: '^22.22.2 || ^24.15.0' },
    'node_modules/lint-staged': { engines: '>=22.22.1', dev: true },
  }

  it('정합이면 ok(과대·과소 0 · 미러 동기)', () => {
    const declared = '>=22.22.2 <23 || >=24.15.0 <25'
    const a = analyzeEngines({ pkg: pkgOf(declared), lock: lockOf(declared, tree) })
    expect(a.overDeclared).toEqual([])
    expect(a.underDeclared).toEqual([])
    expect(a.mirrorDrift).toBe(false)
    expect(a.ok).toBe(true)
  })

  it('과대선언 — 트리가 거부하는 구간을 구체적으로 짚는다(EBADENGINE 예정)', () => {
    const declared = '>=22.22.2'
    const a = analyzeEngines({ pkg: pkgOf(declared), lock: lockOf(declared, tree) })
    expect(a.ok).toBe(false)
    expect(formatIntervals(a.overDeclared)).toBe('[23.0.0, 24.15.0) ∪ [25.0.0, +∞)')
    expect(a.underDeclared).toEqual([])
    expect(explain(a)).toContain('과대선언')
    // 진단이 「누가 막는가」까지 낸다.
    expect(explain(a)).toContain('which')
  })

  it('과소선언 — 트리는 허용하는데 선언이 배제하는 구간', () => {
    const declared = '>=24.15.0 <25'
    const a = analyzeEngines({ pkg: pkgOf(declared), lock: lockOf(declared, tree) })
    expect(a.ok).toBe(false)
    expect(formatIntervals(a.underDeclared)).toBe('[22.22.2, 23.0.0)')
    expect(a.overDeclared).toEqual([])
    expect(explain(a)).toContain('과소선언')
  })

  it('락파일 루트 미러 드리프트는 그 자체로 결함이다', () => {
    const declared = '>=22.22.2 <23 || >=24.15.0 <25'
    const a = analyzeEngines({ pkg: pkgOf(declared), lock: lockOf('>=22.0.0', tree) })
    expect(a.mirrorDrift).toBe(true)
    expect(a.ok).toBe(false)
    expect(explain(a)).toContain('--package-lock-only')
  })

  it('제안 범위를 그대로 선언하면 정합이 된다(고치는 법이 실제로 통한다)', () => {
    const bad = '>=22.22.2'
    const a = analyzeEngines({ pkg: pkgOf(bad), lock: lockOf(bad, tree) })
    const fixed = a.intersectionRange
    const b = analyzeEngines({ pkg: pkgOf(fixed), lock: lockOf(fixed, tree) })
    expect(b.ok).toBe(true)
  })

  it('engines.node 선언 자체가 없으면 조용히 통과시키지 않는다', () => {
    expect(() => analyzeEngines({ pkg: {}, lock: lockOf(null, tree) })).toThrow(/engines\.node/)
  })
})

describe('determinants — 「빼면 바닥이 움직이는」 선언만', () => {
  it('더 느슨한 선언은 결정자가 아니다', () => {
    const { constraints } = treeConstraints(
      lockOf(null, {
        'node_modules/a': { engines: '>=22.0.0' },
        'node_modules/b': { engines: '>=21.0.0' }, // a 에 흡수돼 비구속
        'node_modules/c': { engines: '>=20.0.0' },
      }),
    )
    expect(determinants(constraints).flatMap((d) => d.packages)).toEqual(['a'])
  })

  /**
   * **leave-one-out 정의의 한계를 특성화한다**(은폐하지 않기 위한 테스트). 서로 다른 두 범위
   * 문자열이 같은 경계를 강제하면 어느 하나를 빼도 교집합이 그대로라 **둘 다 안 잡힌다** —
   * 목록이 비어도 「제약이 없다」가 아니라 「단독 책임자가 없다」는 뜻이다. 이 레포의 Node 23
   * 배제가 실제로 이 형태다(eslint 계열 다수가 함께 배제).
   */
  it('서로 다른 문자열이 같은 경계를 강제하면 목록이 빈다(중복 배제)', () => {
    const { constraints } = treeConstraints(
      lockOf(null, {
        'node_modules/a': { engines: '>=22.0.0' },
        'node_modules/b': { engines: '>=22.0.0 || >=24.0.0' }, // 정규화하면 a 와 동일 경계
      }),
    )
    expect(constraints).toHaveLength(2) // 문자열은 서로 다르다
    expect(formatIntervals(intersectAll(constraints))).toBe('[22.0.0, +∞)') // 경계는 실재한다
    expect(determinants(constraints)).toEqual([]) // 그런데 단독 결정자는 없다
  })

  it('두 패키지가 같은 범위를 선언하면 함께 결정자다(공동 결정 — #279 의 형태)', () => {
    const { constraints } = treeConstraints(
      lockOf(null, {
        'node_modules/which': { engines: '^22.22.2' },
        'node_modules/jsdom': { engines: '^22.22.2', dev: true },
        'node_modules/other': { engines: '>=18.0.0' },
      }),
    )
    const d = determinants(constraints)
    expect(d).toHaveLength(1)
    expect(d[0].packages).toEqual(['jsdom', 'which'])
  })

  it('blockersFor 가 특정 버전을 막는 제약을 짚는다', () => {
    const { constraints } = treeConstraints(
      lockOf(null, {
        'node_modules/hi': { engines: '>=24.0.0' },
        'node_modules/lo': { engines: '>=18.0.0' },
      }),
    )
    expect(
      blockersFor('22.0.0', constraints).flatMap((c: { packages: string[] }) => c.packages),
    ).toEqual(['hi'])
    expect(blockersFor('24.0.0', constraints)).toEqual([])
  })
})

/**
 * 라이브 불변식. 위 합성 테스트가 반증력을 증명하므로 여기서 GREEN 인 것은 「구현이 무르다」가
 * 아니라 「레포가 실제로 정합」이라는 뜻이다.
 */
describe('실제 레포 — engines.node 선언 == 트리 교집합', () => {
  const analysis = analyzeEngines({
    pkg: read('package.json'),
    lock: read('package-lock.json'),
  })

  it('앵커: 락파일에서 실제로 다수의 제약을 읽었다(0 이면 이하 단언이 항진명제)', () => {
    expect(analysis.declarationCount).toBeGreaterThan(100)
    expect(analysis.constraints.length).toBeGreaterThan(10)
  })

  it('과대선언 0 — `npm ci` 가 EBADENGINE 로 죽지 않는다', () => {
    expect(formatIntervals(analysis.overDeclared)).toBe('∅')
  })

  it('과소선언 0 — 근거 없이 배제하는 Node 구간이 없다', () => {
    expect(formatIntervals(analysis.underDeclared)).toBe('∅')
  })

  it('락파일 루트 engines 미러가 package.json 과 동일하다', () => {
    expect(analysis.mirrorRange).toBe(analysis.declaredRange)
  })

  it('종합 판정 ok', () => {
    expect(analysis.ok, explain(analysis)).toBe(true)
  })
})

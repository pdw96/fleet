// scripts/engines-floor.mjs
//
// engines.node **범위 교집합** 게이트 (#283).
//
// `.npmrc` 의 `engine-strict=true` 때문에 선언한 `engines.node` 가 의존성 트리의 실제 바닥과
// 어긋나면 `npm ci` 가 EBADENGINE 로 하드 실패한다(transitive 까지 강제). 그런데 그 정합을
// 지키는 수단이 지금까지 **손으로 돌리는 점 표본**이었고, 두 번 연속 낡았다(#279·#280·#281).
//
// 점 표본이 부족한 이유는 구조적이다 — 탐침 목록이 수동이라 구간 내부·상단에서 새로 거부하는
// 패키지를 못 잡고, 「그 지점에서 차단하는 패키지」는 결정자 후보일 뿐 확정이 아니다(`>=24.14.1`
// 을 요구하는 패키지는 탐침 24.14.0 에서 차단되지만 실제 하한은 24.15.0 경계를 정하지 않는다).
//
// 그래서 표본이 아니라 **구간 대수**로 푼다. semver `Range.set` 의 각 conjunction 은 정확히 하나의
// 구간으로 접히므로, 모든 선언을 「정렬된 disjoint 구간 리스트」로 바꿔 순차 교집합하면 트리가
// 실제로 허용하는 집합이 **정확히** 나온다. 선언과의 차집합을 양방향으로 내면 과대선언(EBADENGINE
// 예정)과 과소선언(근거 없는 배제)이 각각 구체적인 구간으로 떨어진다.
//
// ## 정직한 한계
//
// 모델의 정의역은 **정식 릴리스 버전**이다. semver 는 `<23` 을 `<23.0.0-0` 으로 정규화하는데,
// 이 `-0` 은 「23.0.0 의 어떤 prerelease 도 포함하지 않는다」는 표식이라 릴리스 공간에서는
// `<23.0.0` 과 같다 — 그래서 벗겨서 정규화한다. 그 외의 prerelease 경계(`>=1.2.3-beta` 등)는
// 릴리스 공간으로 접을 수 없으므로 **조용히 근사하지 않고 throw** 한다(fail-closed).
//
// CLI: `node scripts/engines-floor.mjs` — 교집합·결정자·판정을 출력하고 불일치면 exit 1.

import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import semver from 'semver'

const { Comparator, Range, compare } = semver

/** 구간 경계. `v === null` 이면 무한대. */
const NEG_INF = Object.freeze({ v: null, incl: false })
const POS_INF = Object.freeze({ v: null, incl: false })

/** 하한 비교 — 더 「높은(좁은)」 하한이 크다. 같은 버전이면 exclusive(`>`) 가 더 높다. */
const cmpLow = (a, b) => {
  if (a.v === null) return b.v === null ? 0 : -1
  if (b.v === null) return 1
  const c = compare(a.v, b.v)
  if (c !== 0) return c
  return a.incl === b.incl ? 0 : a.incl ? -1 : 1
}

/** 상한 비교 — 더 「낮은(좁은)」 상한이 작다. 같은 버전이면 exclusive(`<`) 가 더 낮다. */
const cmpHigh = (a, b) => {
  if (a.v === null) return b.v === null ? 0 : 1
  if (b.v === null) return -1
  const c = compare(a.v, b.v)
  if (c !== 0) return c
  return a.incl === b.incl ? 0 : a.incl ? 1 : -1
}

/** 빈 구간(하한 > 상한, 또는 같은 버전인데 어느 쪽이 열려 있음)인가. */
const isEmpty = (iv) => {
  if (iv.lo.v === null || iv.hi.v === null) return false
  const c = compare(iv.lo.v, iv.hi.v)
  if (c > 0) return true
  return c === 0 && !(iv.lo.incl && iv.hi.incl)
}

/**
 * 경계 버전을 **릴리스 튜플**로 정규화한다. semver 가 상한에 붙이는 합성 `-0` 만 벗기고,
 * 실질 prerelease 경계는 근사하지 않고 거부한다(위 「정직한 한계」).
 */
const boundVersion = (sv, source) => {
  const release = `${sv.major}.${sv.minor}.${sv.patch}`
  if (sv.prerelease.length === 0) return release
  if (sv.prerelease.length === 1 && sv.prerelease[0] === 0) return release
  throw new Error(
    `engines 범위에 prerelease 경계가 있어 릴리스 공간으로 접을 수 없다: ${source} (${sv.version})`,
  )
}

/** comparator 집합(AND) 하나를 구간 하나로 접는다. 빈 구간이면 null. */
const conjunctionToInterval = (comparators, source) => {
  let lo = NEG_INF
  let hi = POS_INF
  for (const c of comparators) {
    // `*` 는 무제약. **`operator: ''` 인데 ANY 가 아니면 exact 등호**다(`1.2.3`·`=1.2.3`) —
    // 이걸 무제약으로 흘리면 고정 버전 선언이 통째로 사라진다(실측 확인).
    if (c.semver === Comparator.ANY) continue
    const v = boundVersion(c.semver, source)
    const raise = (bound) => {
      if (cmpLow(bound, lo) > 0) lo = bound
    }
    const lower = (bound) => {
      if (cmpHigh(bound, hi) < 0) hi = bound
    }
    switch (c.operator) {
      case '>':
        raise({ v, incl: false })
        break
      case '>=':
        raise({ v, incl: true })
        break
      case '<':
        lower({ v, incl: false })
        break
      case '<=':
        lower({ v, incl: true })
        break
      case '':
      case '=':
        raise({ v, incl: true })
        lower({ v, incl: true })
        break
      default:
        throw new Error(`알 수 없는 semver operator ${JSON.stringify(c.operator)}: ${source}`)
    }
  }
  const iv = { lo, hi }
  return isEmpty(iv) ? null : iv
}

/** 정렬 + 겹치거나 맞닿는 구간 병합 → disjoint 오름차순 리스트. */
const normalize = (list) => {
  const sorted = [...list].sort((a, b) => cmpLow(a.lo, b.lo) || cmpHigh(a.hi, b.hi))
  const out = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (!last) {
      out.push({ lo: iv.lo, hi: iv.hi })
      continue
    }
    // 맞닿음 판정: last 의 상한과 iv 의 하한이 겹치거나(<), 같은 버전인데 한쪽이라도 닫혀 있으면 이어붙인다.
    const touching =
      last.hi.v === null ||
      iv.lo.v === null ||
      compare(iv.lo.v, last.hi.v) < 0 ||
      (compare(iv.lo.v, last.hi.v) === 0 && (iv.lo.incl || last.hi.incl))
    if (touching) {
      if (cmpHigh(iv.hi, last.hi) > 0) last.hi = iv.hi
    } else out.push({ lo: iv.lo, hi: iv.hi })
  }
  return out
}

/** semver 범위 문자열 → 정규화된 구간 리스트. 파싱 실패는 throw(fail-closed). */
export const parseRange = (str) => {
  const range = new Range(str) // 잘못된 범위면 semver 가 TypeError
  const raw = []
  for (const conj of range.set) {
    const iv = conjunctionToInterval(conj, str)
    if (iv) raw.push(iv)
  }
  return normalize(raw)
}

/** 두 구간 리스트의 교집합. */
export const intersect = (a, b) => {
  const out = []
  for (const x of a) {
    for (const y of b) {
      const iv = {
        lo: cmpLow(x.lo, y.lo) >= 0 ? x.lo : y.lo,
        hi: cmpHigh(x.hi, y.hi) <= 0 ? x.hi : y.hi,
      }
      if (!isEmpty(iv)) out.push(iv)
    }
  }
  return normalize(out)
}

/** 여집합 — 차집합을 교집합으로 환원하기 위한 보조. */
const complement = (ivs) => {
  if (ivs.length === 0) return [{ lo: NEG_INF, hi: POS_INF }]
  const out = []
  let cursor = NEG_INF
  for (const iv of ivs) {
    if (iv.lo.v !== null) {
      const piece = { lo: cursor, hi: { v: iv.lo.v, incl: !iv.lo.incl } }
      if (!isEmpty(piece)) out.push(piece)
    }
    cursor = iv.hi.v === null ? null : { v: iv.hi.v, incl: !iv.hi.incl }
    if (cursor === null) return normalize(out)
  }
  const tail = { lo: cursor, hi: POS_INF }
  if (!isEmpty(tail)) out.push(tail)
  return normalize(out)
}

/** a ∖ b. */
export const subtract = (a, b) => intersect(a, complement(b))

/** 사람이 읽는 표기 — `[22.22.2, 23.0.0) ∪ [26.0.0, +∞)`. */
export const formatIntervals = (ivs) => {
  if (ivs.length === 0) return '∅'
  return ivs
    .map((iv) => {
      const lo = iv.lo.v === null ? '(-∞' : `${iv.lo.incl ? '[' : '('}${iv.lo.v}`
      const hi = iv.hi.v === null ? '+∞)' : `${iv.hi.v}${iv.hi.incl ? ']' : ')'}`
      return `${lo}, ${hi}`
    })
    .join(' ∪ ')
}

/** `package.json` 에 그대로 붙여넣을 수 있는 semver 범위 문자열. */
export const toRangeString = (ivs) => {
  if (ivs.length === 0) return '<0.0.0' // 공집합 — 만족 가능한 Node 가 없다
  return ivs
    .map((iv) => {
      if (iv.lo.v === null && iv.hi.v === null) return '*'
      if (iv.lo.v !== null && iv.lo.v === iv.hi.v && iv.lo.incl && iv.hi.incl) return `=${iv.lo.v}`
      const parts = []
      if (iv.lo.v !== null) parts.push(`${iv.lo.incl ? '>=' : '>'}${iv.lo.v}`)
      if (iv.hi.v !== null) parts.push(`${iv.hi.incl ? '<=' : '<'}${iv.hi.v}`)
      return parts.join(' ')
    })
    .join(' || ')
}

/**
 * 락파일에서 **트리 제약**을 모은다(같은 범위 문자열은 하나로 묶는다).
 *
 * 두 가지 제외가 계약이다:
 * - **루트 항목(`packages['']`)** — 비교의 「대상」이라 제약 집합에 넣으면 자기확인이 된다.
 * - **`optional: true`** — npm 은 optional 의 engines 불만족으로 설치를 막지 않는다(#281 최소 재현).
 *   반대로 **dev 는 제외하지 않는다** — `npm ci --omit=dev` 도 EBADENGINE 로 죽는다(Arborist 가
 *   ideal tree 에서 engines 를 먼저 검사하고 omit 은 그 뒤 디스크 반영 단계다).
 */
export const treeConstraints = (lock) => {
  const byRange = new Map()
  let declarationCount = 0
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue // 루트
    const range = entry?.engines?.node
    if (typeof range !== 'string' || range.length === 0) continue
    if (entry.optional === true) continue
    declarationCount += 1
    const name = path.split('node_modules/').pop() ?? path
    const bucket = byRange.get(range)
    if (bucket) bucket.add(name)
    else byRange.set(range, new Set([name]))
  }
  return {
    declarationCount,
    constraints: [...byRange].map(([range, names]) => ({ range, packages: [...names].sort() })),
  }
}

/** 전 제약의 교집합. */
export const intersectAll = (constraints) => {
  let acc = [{ lo: NEG_INF, hi: POS_INF }]
  for (const c of constraints) acc = intersect(acc, parseRange(c.range))
  return acc
}

/**
 * **결정자** — 그 선언 하나를 빼면 교집합이 달라지는 제약(leave-one-out).
 *
 * ⚠ **이 정의의 한계를 은폐하지 않는다**: 서로 다른 두 범위 문자열이 *같은* 경계를 강제하면
 * 어느 하나를 빼도 교집합이 그대로라 **둘 다 결정자로 잡히지 않는다**. 그래서 목록이 비어도
 * 「바닥을 정하는 패키지가 없다」는 뜻이 아니라 「단독 책임자가 없다(중복 배제)」는 뜻이다.
 * 실제로 이 레포의 Node 23 배제가 그 형태다 — eslint 계열 20여 개가 함께 배제하므로 그 경계의
 * 단독 결정자는 존재하지 않는다.
 *
 * 이 값은 **진단·문서용**이다. 게이트의 합격 판정은 `analyzeEngines` 의 차집합이 하며, 결정자
 * 목록은 판정에 들어가지 않는다 — 의존성 범프마다 바뀌는 값을 계약으로 굳히면 그게 바로 #279~#281
 * 에서 문단을 두 번 낡게 만든 그 실패다.
 */
export const determinants = (constraints) => {
  const target = formatIntervals(intersectAll(constraints))
  const out = []
  for (const c of constraints) {
    const without = formatIntervals(intersectAll(constraints.filter((o) => o !== c)))
    if (without !== target) out.push({ ...c, withoutThis: without })
  }
  return out
}

/** 어떤 Node 버전을 실제로 막는 제약들(진단용). */
export const blockersFor = (version, constraints) =>
  constraints.filter((c) => !semver.satisfies(version, c.range))

/** 권위(package.json) ↔ 트리 ↔ 락파일 미러 3자 정합 판정. */
export const analyzeEngines = ({ pkg, lock }) => {
  const declaredRange = pkg?.engines?.node
  if (typeof declaredRange !== 'string' || declaredRange.length === 0) {
    throw new Error('package.json 에 engines.node 선언이 없다 — 이 게이트의 전제다')
  }
  const mirrorRange = lock?.packages?.['']?.engines?.node ?? null
  const { declarationCount, constraints } = treeConstraints(lock)
  const declared = parseRange(declaredRange)
  const intersection = intersectAll(constraints)
  const overDeclared = subtract(declared, intersection)
  const underDeclared = subtract(intersection, declared)
  return {
    declaredRange,
    mirrorRange,
    mirrorDrift: mirrorRange !== declaredRange,
    declarationCount,
    constraints,
    declared,
    intersection,
    intersectionRange: toRangeString(intersection),
    overDeclared,
    underDeclared,
    ok: overDeclared.length === 0 && underDeclared.length === 0 && mirrorRange === declaredRange,
  }
}

/** 실패 메시지 — 무엇이 왜 어긋났고 어떻게 고치는지까지. */
export const explain = (a) => {
  const lines = []
  lines.push(`선언(package.json): ${a.declaredRange}`)
  lines.push(`  = ${formatIntervals(a.declared)}`)
  lines.push(`트리 교집합(${a.declarationCount} 선언 · ${a.constraints.length} distinct):`)
  lines.push(`  = ${formatIntervals(a.intersection)}`)
  if (a.mirrorDrift) {
    lines.push('')
    lines.push(`⚠ 락파일 루트 미러 드리프트: ${String(a.mirrorRange)} ≠ ${a.declaredRange}`)
    lines.push('  고치는 법: npm install --package-lock-only')
  }
  if (a.overDeclared.length > 0) {
    lines.push('')
    lines.push(`⚠ 과대선언 — 선언은 허용하지만 트리가 거부한다: ${formatIntervals(a.overDeclared)}`)
    for (const iv of a.overDeclared) {
      if (iv.lo.v === null) continue
      const names = blockersFor(iv.lo.v, a.constraints).flatMap((c) => c.packages)
      lines.push(`  ${iv.lo.v} 를 막는 패키지: ${names.slice(0, 8).join(', ')}`)
    }
    lines.push('  이 상태로 `npm ci` 하면 EBADENGINE 로 하드 실패한다.')
  }
  if (a.underDeclared.length > 0) {
    lines.push('')
    lines.push(
      `⚠ 과소선언 — 트리는 허용하는데 선언이 배제한다: ${formatIntervals(a.underDeclared)}`,
    )
  }
  if (!a.ok) {
    lines.push('')
    lines.push(
      `고치는 법: package.json 의 engines.node 를 아래로 맞춘 뒤 락파일 미러를 동기화한다.`,
    )
    lines.push(`  "node": "${a.intersectionRange}"`)
    lines.push(`  npm install --package-lock-only`)
    lines.push(
      '  ⚠ 의도적으로 더 좁게 선언하려면(예: 미검증 non-LTS 배제) 이 계약 자체를 고쳐야 한다 —',
    )
    lines.push('    조용히 어긋난 채 두지 말 것(ADR-0016).')
  }
  return lines.join('\n')
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** CLI — 보고 + 판정. */
const main = () => {
  const analysis = analyzeEngines({
    pkg: readJson('package.json'),
    lock: readJson('package-lock.json'),
  })
  console.log(explain(analysis))
  console.log('')
  const found = determinants(analysis.constraints)
  console.log('결정자(빼면 바닥이 움직이는 선언):')
  if (found.length === 0) {
    console.log('  (없음 — 모든 경계가 중복 배제 상태다. 단독 책임자가 없다는 뜻이지')
    console.log('   「제약이 없다」는 뜻이 아니다.)')
  }
  for (const d of found) {
    console.log(`  ${d.range}`)
    console.log(`    ← ${d.packages.join(', ')}`)
    console.log(`    없으면 → ${d.withoutThis}`)
  }
  if (!analysis.ok) exit(1)
  console.log('')
  console.log('✓ engines.node 선언 == 트리 교집합 (과대·과소 0 · 락파일 미러 동기)')
}

if (argv[1] && pathToFileURL(argv[1]).href === import.meta.url) main()
export const __cliPath = fileURLToPath(import.meta.url)

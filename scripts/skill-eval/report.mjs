// scripts/skill-eval/report.mjs
// route-eval.mjs 의 jsonl 을 집계해 혼동 행렬·실패 쿼리를 낸다.
//
// invalid 표본(CLI 가 못 뜸·인증 만료·레이트리밋 등 인프라 실패)은 **모든 통계에서 제외**한다.
// 그걸 섞어 세면 인프라 실패가 negative 정답이자 positive 미스로 둔갑해 그럴듯하지만
// 오염된 결과가 나온다. 대신 건수를 눈에 띄게 보고한다.
//
// 사용: node scripts/skill-eval/report.mjs /tmp/iter1.jsonl [queries.json]

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const [, , recPath, queryPath = join(HERE, 'queries.json')] = process.argv
if (!recPath) {
  console.error('사용: node scripts/skill-eval/report.mjs <결과.jsonl> [queries.json]')
  process.exit(2)
}

const all = (await readFile(recPath, 'utf8'))
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

// 완결성 검증을 통계보다 **먼저** 한다. route-eval 이 중간에 죽으면 살아남은 앞부분 행만으로도
// 그럴듯한 100% 가 나오는데, 그 안에는 스킬 하나가 통째로, 뒤쪽 negative 가 전부 빠져 있을 수
// 있다. 부분 결과를 점수로 내느니 거부한다.
const manifest = await readFile(`${recPath}.manifest.json`, 'utf8')
  .then(JSON.parse)
  .catch(() => null)

const counts = new Map()
for (const r of all) counts.set(r.id, (counts.get(r.id) ?? 0) + 1)

if (manifest) {
  const problems = []
  if (!manifest.completedAt) problems.push('run 이 완료 표시 없이 끝났다(중단·크래시)')
  if (all.length !== manifest.expected) {
    problems.push(`행 수 ${all.length} ≠ 계획 ${manifest.expected}`)
  }
  const missing = manifest.queries.filter((id) => (counts.get(id) ?? 0) !== manifest.runs)
  if (missing.length) {
    problems.push(
      `런 수가 ${manifest.runs} 가 아닌 쿼리 ${missing.length}개: ${missing.slice(0, 8).join(', ')}`,
    )
  }
  if (problems.length) {
    console.error('불완전한 결과 파일 — 점수를 내지 않는다:')
    for (const p of problems) console.error(`  · ${p}`)
    console.error('\nroute-eval.mjs 를 다시 완주시켜라.')
    process.exit(1)
  }
} else {
  const seen = [...new Set(counts.values())]
  console.log('⚠ 매니페스트 없음 — 완결성을 검증할 수 없다(구 버전 결과 파일).')
  if (seen.length > 1) {
    console.error(`쿼리별 런 수가 제각각이다(${seen.join('/')}) — 중단된 파일로 보인다. 중단한다.`)
    process.exit(1)
  }
  console.log()
}

const bad = all.filter((r) => r.invalid)
const recs = all.filter((r) => !r.invalid)
const queries = new Map(JSON.parse(await readFile(queryPath, 'utf8')).map((q) => [q.id, q.query]))

if (bad.length) {
  console.log(`⚠ invalid 표본 ${bad.length}/${all.length} — 아래 통계에서 제외됨\n`)
  const reasons = new Map()
  for (const r of bad)
    reasons.set(r.error ?? '(사유 없음)', (reasons.get(r.error ?? '(사유 없음)') ?? 0) + 1)
  for (const [why, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`   ${n}건  ${why.slice(0, 160)}`)
  }
  console.log()
}
if (!recs.length) {
  console.log('유효 표본이 없다 — 측정이 성립하지 않는다.')
  process.exit(1)
}

const byQuery = new Map()
for (const r of recs) {
  if (!byQuery.has(r.id)) byQuery.set(r.id, [])
  byQuery.get(r.id).push(r)
}

const skills = [...new Set(recs.map((r) => r.expected))].sort((a, b) =>
  a === 'none' ? 1 : b === 'none' ? -1 : a.localeCompare(b),
)

console.log('## 스킬별 집계\n')
for (const s of skills) {
  const rs = recs.filter((r) => r.expected === s)
  const hit = rs.filter((r) => r.fired === s).length
  const label = s === 'none' ? '  ← 정답은 미발동' : ''
  const pct = ((hit / rs.length) * 100).toFixed(0)
  console.log(
    `  ${s.padEnd(26)} ${String(hit).padStart(3)}/${String(rs.length).padEnd(3)} ${pct.padStart(4)}%${label}`,
  )
}

console.log('\n## 혼동 행렬 (기대 → 실제 발동)\n')
for (const s of skills) {
  const counts = new Map()
  for (const r of recs.filter((x) => x.expected === s)) {
    counts.set(r.fired, (counts.get(r.fired) ?? 0) + 1)
  }
  const row = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  console.log(`  ${s.padEnd(26)} -> ${row}`)
}

console.log('\n## 실패한 쿼리\n')
let anyFail = false
for (const [id, rs] of [...byQuery.entries()].sort()) {
  const exp = rs[0].expected
  const hit = rs.filter((r) => r.fired === exp).length
  if (hit === rs.length) continue
  anyFail = true
  const got = {}
  for (const r of rs) got[r.fired] = (got[r.fired] ?? 0) + 1
  const to = rs.filter((r) => r.timed_out).length
  console.log(`  [${hit}/${rs.length}] ${id} (expected ${exp})`)
  console.log(`      쿼리: ${queries.get(id) ?? '(원문 없음)'}`)
  console.log(`      실제: ${JSON.stringify(got)}${to ? `  (timeout ${to}건)` : ''}`)
}
if (!anyFail) console.log('  없음')

// 예산 포화는 해석을 바꾼다 — 예산에 걸려 끊긴 표본이 많으면 「미발동」이 아니라
// 「끝까지 못 봤다」일 수 있다. 눈에 보이게 낸다.
const saturated = recs.filter((r) => r.fired === 'none' && !r.timed_out && (r.tool_calls ?? 0) > 0)
const calls = recs.map((r) => r.tool_calls ?? 0).sort((a, b) => a - b)
const p90 = calls[Math.min(calls.length - 1, Math.floor(calls.length * 0.9))]
console.log(`\n## 도구 호출 건수 — 중앙값 ${calls[Math.floor(calls.length / 2)]} · p90 ${p90}`)
console.log(`   미발동 표본 중 호출이 발생한 건: ${saturated.length}`)

const fp = recs.filter((r) => r.expected === 'none' && r.fired !== 'none')
const wrong = recs.filter(
  (r) => r.expected !== 'none' && r.fired !== 'none' && r.fired !== r.expected,
)
console.log(`\n## 오발동(negative 가 스킬을 켬): ${fp.length}건`)
console.log(`## 잘못된 스킬로 라우팅: ${wrong.length}건`)

const pos = recs.filter((r) => r.expected !== 'none')
const neg = recs.filter((r) => r.expected === 'none')
const hitAll = recs.filter((r) => r.fired === r.expected).length
const posHit = pos.filter((r) => r.fired === r.expected).length
const negHit = neg.filter((r) => r.fired === 'none').length
console.log(`\n## 전체 ${hitAll}/${recs.length} = ${((hitAll / recs.length) * 100).toFixed(0)}%`)
if (pos.length) {
  console.log(`   positive ${posHit}/${pos.length} = ${((posHit / pos.length) * 100).toFixed(0)}%`)
}
if (neg.length) {
  console.log(`   negative ${negHit}/${neg.length} = ${((negHit / neg.length) * 100).toFixed(0)}%`)
}

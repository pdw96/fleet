// scripts/skill-eval/report.mjs
// route-eval.mjs 의 jsonl 을 집계해 혼동 행렬·실패 쿼리를 낸다.
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

const recs = (await readFile(recPath, 'utf8'))
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))
const queries = new Map(JSON.parse(await readFile(queryPath, 'utf8')).map((q) => [q.id, q.query]))

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
console.log(`   positive ${posHit}/${pos.length} = ${((posHit / pos.length) * 100).toFixed(0)}%`)
console.log(`   negative ${negHit}/${neg.length} = ${((negHit / neg.length) * 100).toFixed(0)}%`)

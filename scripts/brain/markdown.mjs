// Fleet 설계도 → 에이전트용 압축 markdown 다이제스트(brain.md).
//
// 목적: 코딩 에이전트가 src/ 전체를 매번 탐색하지 않고 이 한 장만 읽어 구조·역할·배선을
// 파악 → 토큰 절약. 사람용 그래프(fleet-brain.html)와 같은 데이터(extract+descriptions)에서 나온다.

// main/core/ 접두어와 확장자를 떼어 짧고 모호하지 않은 id 로(예: session/manager).
const shortId = (id) => id.replace(/^main\/core\//, '').replace(/\.tsx?$/, '')

function depList(ids) {
  if (!ids.length) return '—'
  const s = [...new Set(ids.map(shortId))].sort()
  return s.length > 10 ? s.slice(0, 10).join(', ') + `, +${s.length - 10}` : s.join(', ')
}

const LAYER_ORDER = ['renderer', 'preload', 'main', 'core', 'shared']
const LAYER_LABEL = {
  renderer: '화면 renderer', preload: '다리 preload', main: '본체 main',
  core: '두뇌 core', shared: '공용 사전 shared', runtime: '바깥 세계 runtime',
}

export function toMarkdown(graph) {
  const { meta, nodes, links, overlayNodes, overlayLinks } = graph
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const out = new Map([...byId.keys()].map((id) => [id, []]))
  const inc = new Map([...byId.keys()].map((id) => [id, []]))
  for (const l of links) {
    if (l.kind !== 'import') continue
    if (out.has(l.source)) out.get(l.source).push(l.target)
    if (inc.has(l.target)) inc.get(l.target).push(l.source)
  }

  // 도메인(group) → {layer, files[]}
  const groups = new Map()
  for (const n of nodes) {
    if (!groups.has(n.group)) groups.set(n.group, { layer: n.layer, files: [] })
    groups.get(n.group).files.push(n)
  }
  for (const g of groups.values()) g.files.sort((a, b) => b.degree - a.degree)

  const L = []
  L.push('# Fleet — 코드베이스 브레인 (자동 생성)')
  L.push('')
  L.push('> `npm run brain` 로 `src/` 에서 자동 추출한 구조 지도다. **코드를 탐색하기 전에 이 파일을 먼저 읽어** 토큰을 아껴라.')
  L.push(`> ${meta.fileCount} files · ${meta.linkCount} import wires · ${meta.channels} IPC channels · 생성 ${(meta.generatedAt || '').slice(0, 16)} UTC`)
  L.push('> 표기: `파일 — 역할 · →의존 · ←피의존`. id 는 `main/core/` 생략(예: `session/manager`).')
  L.push('')

  // 레이어 개요
  L.push('## 레이어 (위 → 아래로 흐름)')
  for (const k of [...LAYER_ORDER, 'runtime']) {
    const ly = (meta.layers || {})[k]
    if (ly) L.push(`- **${LAYER_LABEL[k] || k}** — ${ly.desc}`)
  }
  L.push('')

  // 한눈에: 허브/진입점/레지스트리/게이트
  const hubs = nodes.filter((n) => n.hub).sort((a, b) => b.degree - a.degree)
  const flag = (pred) => nodes.filter(pred).map((n) => shortId(n.id)).sort()
  L.push('## 한눈에')
  L.push(`- **허브**(많이 연결): ${hubs.map((n) => `${shortId(n.id)}(${n.degree})`).join(' · ')}`)
  L.push(`- **진입점**: ${flag((n) => n.entry).join(' · ')}`)
  L.push(`- **레지스트리**(확장점, 분기 대신 등록): ${flag((n) => n.registry).join(' · ')}`)
  L.push(`- **승인 게이트**(위험작업 차단): ${flag((n) => n.gate).join(' · ')}`)
  L.push('')

  // 런타임 배선(import 로 안 보이는 연결)
  L.push('## 런타임 배선 (import 로는 안 보이는 연결)')
  const ipcToPreload = overlayLinks.filter((l) => l.kind === 'ipc' && l.target === 'preload/index.ts').map((l) => shortId(l.source))
  const pm = overlayLinks.find((l) => l.kind === 'ipc' && l.source === 'preload/index.ts')
  if (ipcToPreload.length) {
    L.push(`- ${ipcToPreload.join(', ')} →(window.fleet)→ preload/index.ts${pm ? ` → main/index.ts (${pm.label}) → engine` : ''}`)
  }
  const extLabel = (id) => (overlayNodes.find((n) => n.id === id) || {}).label || id
  for (const l of overlayLinks.filter((l) => l.kind === 'runtime')) {
    L.push(`- ${shortId(l.source)} → ${extLabel(l.target)}`)
  }
  L.push('')

  // 모듈별 상세
  L.push('## 모듈별 (파일 — 역할 · →의존 · ←피의존)')
  const orderedGroups = [...groups.entries()].sort((a, b) => {
    const la = LAYER_ORDER.indexOf(a[1].layer), lb = LAYER_ORDER.indexOf(b[1].layer)
    if (la !== lb) return la - lb
    const da = a[1].files.reduce((s, n) => s + n.degree, 0)
    const db = b[1].files.reduce((s, n) => s + n.degree, 0)
    return db - da
  })
  for (const [group, g] of orderedGroups) {
    const md = (meta.modules || {})[group]
    L.push('')
    L.push(`### ${group} · ${g.layer}${md ? ` — ${md}` : ''}`)
    for (const n of g.files) {
      const role = n.role ? ` — ${n.role}` : ''
      const detail = n.detail ? ` _${n.detail}_` : ''
      const o = depList(out.get(n.id) || [])
      const i = depList(inc.get(n.id) || [])
      L.push(`- **${shortId(n.id)}**${role}${detail}`)
      L.push(`  - →의존: ${o} · ←피의존: ${i} · ${n.loc}줄`)
    }
  }
  L.push('')
  L.push('---')
  L.push('_이 파일은 자동 생성물이다. 코드 변경 후 `npm run brain` 으로 갱신. 설명은 `scripts/brain/descriptions.json` 에서 손볼 수 있다._')
  L.push('')
  return L.join('\n')
}

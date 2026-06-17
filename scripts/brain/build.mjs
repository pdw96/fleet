// Fleet 설계도 빌더.
//
// extract.mjs 가 뽑은 그래프를 viewer 템플릿에 주입해 단일 self-contained HTML 을 만든다:
//   - force-graph UMD dist 를 인라인(<script>)  → 오프라인·CDN 0
//   - 그래프 JSON 을 __GRAPH_DATA__ 토큰에 주입
// 결과: 어디서든 브라우저로 더블클릭해 여는 fleet-brain.html (앱 본체 src/ 불변).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildGraph, ROOT } from './extract.mjs'
import { toMarkdown } from './markdown.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, 'template.html')
const LIB = path.join(ROOT, 'node_modules', 'force-graph', 'dist', 'force-graph.min.js')
const OUT = path.join(ROOT, 'fleet-brain.html')
const OUT_MD = path.join(ROOT, 'brain.md')

export function build() {
  if (!fs.existsSync(LIB)) {
    throw new Error('force-graph 가 없습니다. `npm install` 로 devDependencies 를 설치하세요: ' + LIB)
  }
  const template = fs.readFileSync(TEMPLATE, 'utf8')
  const lib = fs.readFileSync(LIB, 'utf8')
  const graph = buildGraph()
  // </script> 조기종료 방지 + 함수형 replacer 로 $ 치환 시퀀스 해석 방지.
  const dataJson = JSON.stringify(graph).replace(/</g, '\\u003c')

  const html = template
    .replace('<!--__FORCE_GRAPH_LIB__-->', () => '<script>' + lib + '</script>')
    .replace('__GRAPH_DATA__', () => dataJson)

  fs.writeFileSync(OUT, html)

  // 에이전트용 압축 markdown 다이제스트(brain.md) — 토큰 절약용. 커밋되어 체크아웃만으로 읽힌다.
  const md = toMarkdown(graph)
  fs.writeFileSync(OUT_MD, md)

  return { out: OUT, outMd: OUT_MD, mdBytes: Buffer.byteLength(md), ...graph.meta }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = build()
  const kb = (fs.statSync(r.out).size / 1024).toFixed(0)
  console.log(`✓ fleet-brain.html (${kb} KB) — ${r.fileCount} files · ${r.linkCount} wires · ${r.channels} channels`)
  console.log(`  → ${r.out}`)
  console.log(`✓ brain.md (${(r.mdBytes / 1024).toFixed(1)} KB) — 에이전트용 다이제스트`)
  console.log(`  → ${r.outMd}`)
  console.log(`  브라우저로 열기: file:///${r.out.split(path.sep).join('/')}`)
}

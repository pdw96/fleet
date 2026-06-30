// scripts/brain/check.mjs
// brain.md 신선도 게이트(#175). 커밋된 brain.md 가 현재 src/ 와 일치하는지 검사한다.
//
// 제안된 `npm run brain && git diff --exit-code` 는 extract.mjs 가 매 실행 `new Date()` 로
// 심는 분단위 생성 타임스탬프 때문에 영구 false-RED 가 난다. 대신 여기서 buildGraph()+
// toMarkdown() 으로 인메모리 재생성한 뒤, 타임스탬프만 정규화하고(파일수/배선수는 유지)
// 커밋본과 비교한다 → git 트리를 건드리지 않고(인메모리), 분단위 잡음 없이 실제 drift 만 적발.
// 결정성은 markdown.mjs 의 알파벳 tie-breaker 가 보장(win32↔ubuntu readdir 순서차 흡수).

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildGraph, ROOT } from './extract.mjs'
import { toMarkdown } from './markdown.mjs'

const OUT_MD = path.join(ROOT, 'brain.md')

/** 생성 타임스탬프만 정규화(파일수/배선수는 유지 → 67↔68 같은 stale 은 적발). CRLF→LF. */
export function normalizeDigest(md) {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/생성 \d{4}-\d{2}-\d{2}T\d{2}:\d{2} UTC/g, '생성 <TS> UTC')
}

/** 인메모리 재생성 vs 커밋된 brain.md(타임스탬프 정규화 후). @returns {{ok, expected, committed}} */
export function checkBrain() {
  const expected = normalizeDigest(toMarkdown(buildGraph()))
  const committed = normalizeDigest(readFileSync(OUT_MD, 'utf8'))
  return { ok: expected === committed, expected, committed }
}

/** 첫 불일치 라인을 찾아 사람이 읽을 진단 문자열로. */
function firstDiff(expected, committed) {
  const e = expected.split('\n')
  const c = committed.split('\n')
  const n = Math.max(e.length, c.length)
  for (let i = 0; i < n; i++) {
    if (e[i] !== c[i]) {
      return [
        `  첫 불일치 L${i + 1}:`,
        `    커밋: ${c[i] ?? '(없음)'}`,
        `    기대: ${e[i] ?? '(없음)'}`,
      ].join('\n')
    }
  }
  return '  (라인 차이 없음 — 길이만 상이?)'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, expected, committed } = checkBrain()
  if (!ok) {
    console.error(
      '✗ brain.md 가 src/ 와 동기화되지 않았습니다. `npm run brain` 으로 갱신 후 커밋하세요.\n' +
        firstDiff(expected, committed),
    )
    process.exit(1)
  }
  console.log('✓ brain.md 신선도 OK (src/ 와 동기)')
}

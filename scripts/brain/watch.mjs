// Fleet 설계도 워치 모드 — src/ 저장 시 fleet-brain.html 을 자동 재생성.
//
// 코드를 고치고 저장하면 설계도가 곧바로 갱신된다(브라우저 새로고침만 하면 반영).
// 외부 의존 0(Node 내장 fs.watch). recursive 워치는 Windows/macOS 에서 동작.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from './build.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', '..', 'src')

function regen(reason) {
  try {
    const r = build()
    const t = new Date().toISOString().slice(11, 19)
    console.log(`[${t}] ✓ 재생성 — ${r.fileCount} files · ${r.linkCount} wires (${reason})`)
  } catch (err) {
    console.error('✗ 빌드 실패:', err.message)
  }
}

regen('초기 빌드')
console.log(`👁  watching src/ … (Ctrl+C 종료)`)

let timer = null
let pending = '변경'
function schedule(file) {
  pending = file || '변경'
  clearTimeout(timer)
  timer = setTimeout(() => regen(pending), 180) // 디바운스: 연속 저장 묶기
}

try {
  fs.watch(SRC, { recursive: true }, (_event, filename) => {
    if (filename && /\.tsx?$/.test(filename) && !/\.test\.tsx?$/.test(filename)) {
      schedule(filename.split(path.sep).pop())
    }
  })
} catch (err) {
  console.error(
    'fs.watch(recursive) 실패 — 이 플랫폼은 recursive 워치를 지원하지 않을 수 있습니다:',
    err.message,
  )
  process.exit(1)
}

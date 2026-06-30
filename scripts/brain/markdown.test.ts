// scripts/brain/markdown.test.ts
// brain.md 다이제스트의 정렬 결정성(#175): degree 동률 시 id/group 알파벳 tie-breaker 로
// win32(dev)↔ubuntu(CI) 의 readdir 순서차에 따른 비결정 출력(=brain:check false-RED)을 막는다.
import { describe, it, expect } from 'vitest'
import { toMarkdown } from './markdown.mjs'

const baseMeta = {
  fileCount: 0,
  linkCount: 0,
  channels: 0,
  generatedAt: '2026-01-01T00:00:00.000Z',
  layers: {},
  modules: {},
}
const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  group: 'g',
  layer: 'core',
  degree: 1,
  loc: 10,
  ...over,
})
const graph = (nodes: ReturnType<typeof node>[]) => ({
  meta: { ...baseMeta, fileCount: nodes.length },
  nodes,
  links: [],
  overlayNodes: [],
  overlayLinks: [],
})

describe('toMarkdown — 정렬 결정성(tie-breaker)', () => {
  it('같은 그룹 내 degree 동률이면 id 알파벳 순으로 출력한다', () => {
    // 삽입 순서는 일부러 역순(zzz 먼저) — tie-breaker 없으면 안정정렬이 그대로 유지돼 실패
    const md = toMarkdown(graph([node('main/core/zzz'), node('main/core/aaa')]))
    expect(md.indexOf('**aaa**')).toBeLessThan(md.indexOf('**zzz**'))
  })

  it('레이어·degree합 동률 그룹이면 그룹명 알파벳 순으로 출력한다', () => {
    const md = toMarkdown(
      graph([node('main/core/x', { group: 'zeta' }), node('main/core/y', { group: 'alpha' })]),
    )
    expect(md.indexOf('### alpha')).toBeLessThan(md.indexOf('### zeta'))
  })

  it('허브 degree 동률이면 id 알파벳 순으로 출력한다', () => {
    const md = toMarkdown(
      graph([
        node('main/core/zzz', { degree: 5, hub: true }),
        node('main/core/aaa', { degree: 5, hub: true }),
      ]),
    )
    const hubLine = md.split('\n').find((l) => l.includes('허브')) ?? ''
    expect(hubLine.indexOf('aaa')).toBeLessThan(hubLine.indexOf('zzz'))
  })
})

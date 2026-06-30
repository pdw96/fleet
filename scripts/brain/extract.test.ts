// scripts/brain/extract.test.ts
// 추출 결정성 불변식(#175). brain:check 가 win32(dev)↔ubuntu(CI) 에서 flaky 하지 않으려면
// buildGraph 의 출력 순서가 readdir 순서(OS 의존)에 좌우되면 안 된다 → id 알파벳 정렬로 고정.
// 주의: win32 NTFS 는 readdir 를 정렬해 돌려주므로 이 버그는 로컬에서 불가시(이 테스트가 로컬에선
// 정렬 없이도 통과할 수 있음) — 실제 강제자는 ubuntu CI 의 brain:check. 이 테스트는 그 불변식을 못박는다.
import { describe, it, expect } from 'vitest'
import { buildGraph } from './extract.mjs'

describe('buildGraph — 추출 결정성', () => {
  it('nodes 를 id 알파벳 정렬로 방출한다(OS-독립)', () => {
    const ids = buildGraph().nodes.map((n) => n.id)
    expect(ids).toEqual([...ids].sort())
  })
})

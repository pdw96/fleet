// scripts/brain/extract.test.ts
// 추출 결정성 불변식(#175). brain:check 가 win32(dev)↔ubuntu(CI) 에서 flaky 하지 않으려면
// buildGraph 의 출력 순서가 readdir 순서(OS 의존)에 좌우되면 안 된다 → id 알파벳 정렬로 고정.
// 주의: win32 NTFS 는 readdir 를 정렬해 돌려주므로 이 버그는 로컬에서 불가시(이 테스트가 로컬에선
// 정렬 없이도 통과할 수 있음) — 실제 강제자는 ubuntu CI 의 brain:check. 이 테스트는 그 불변식을 못박는다.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { buildGraph } from './extract.mjs'
import { toMarkdown } from './markdown.mjs'
import { normalizeDigest } from './check.mjs'

describe('buildGraph — 추출 결정성', () => {
  it('nodes 를 id 알파벳 정렬로 방출한다(OS-독립)', () => {
    const ids = buildGraph().nodes.map((n) => n.id)
    expect(ids).toEqual([...ids].sort())
  })

  it('readdir 순서가 뒤집혀도 brain.md 출력은 동일하다(전체 결정성 — ids 정렬·hub 선정·오버레이 포함)', () => {
    // win32 NTFS↔리눅스 ext4 의 readdir 순서차를 시뮬레이트(역순)해도 출력이 byte-identical 이어야
    // brain:check 가 CI 에서 flaky 하지 않다. ids.sort()(132-135)뿐 아니라 hub slice(253-256) 등
    // 모든 순서 의존 지점을 한 번에 못박는다(CodeRabbit PR리뷰 — hub 경계 회귀 커버). 타임스탬프만 정규화.
    const normal = normalizeDigest(toMarkdown(buildGraph()))
    const realReaddir = fs.readdirSync
    const spy = vi
      .spyOn(fs, 'readdirSync')
      .mockImplementation((dir: fs.PathLike, opts?: unknown) => {
        // @ts-expect-error — 원본 시그니처 위임 후 순서만 뒤집는다.
        return [...realReaddir(dir, opts)].reverse()
      })
    try {
      const reversed = normalizeDigest(toMarkdown(buildGraph()))
      expect(reversed).toBe(normal)
    } finally {
      spy.mockRestore()
    }
  })
})

// scripts/brain/check.test.ts
// brain.md 신선도 게이트의 정규화 로직(#175): 생성 타임스탬프만 무력화하고 파일수/배선수는
// 유지해, 분단위 타임스탬프(extract.mjs new Date())로 인한 영구 false-RED 없이 67↔68 같은
// 실제 drift 는 그대로 적발한다. CRLF 정규화로 win32↔CI 줄바꿈차도 흡수.
import { describe, it, expect } from 'vitest'
import { normalizeDigest } from './check.mjs'

describe('normalizeDigest — brain 신선도 비교 정규화', () => {
  const head = (files: number, ts: string) =>
    `> ${files} files · 172 import wires · 43 IPC channels · 생성 ${ts} UTC`

  it('생성 타임스탬프가 달라도 동일하게 정규화한다(false-RED 방지)', () => {
    expect(normalizeDigest(head(67, '2026-06-29T11:26'))).toBe(
      normalizeDigest(head(67, '2026-06-30T08:31')),
    )
  })

  it('파일수가 다르면 정규화 후에도 다르다(67↔68 stale 적발 유지)', () => {
    expect(normalizeDigest(head(67, '2026-06-30T08:31'))).not.toBe(
      normalizeDigest(head(68, '2026-06-30T08:31')),
    )
  })

  it('CRLF 를 LF 로 정규화한다(win32↔CI)', () => {
    expect(normalizeDigest('a\r\nb\r\n')).toBe('a\nb\n')
  })
})

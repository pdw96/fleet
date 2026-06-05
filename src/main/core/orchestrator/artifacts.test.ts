import { describe, expect, it } from 'vitest'
import { parseArtifacts } from './artifacts'

describe('parseArtifacts', () => {
  it('extracts a file-tagged fenced block', () => {
    const text = ['설명입니다.', '```file:src/foo.ts', 'export const x = 1', '```', '끝.'].join('\n')
    const arts = parseArtifacts(text)
    expect(arts).toHaveLength(1)
    expect(arts[0].path).toBe('src/foo.ts')
    expect(arts[0].content).toBe('export const x = 1')
  })

  it('supports a language hint before the file: tag', () => {
    const text = ['```ts file:src/bar.ts', 'const y = 2', '```'].join('\n')
    const arts = parseArtifacts(text)
    expect(arts[0].path).toBe('src/bar.ts')
    expect(arts[0].content).toBe('const y = 2')
  })

  it('ignores fenced blocks without a file: tag', () => {
    const text = ['```ts', 'const z = 3', '```'].join('\n')
    expect(parseArtifacts(text)).toHaveLength(0)
  })

  it('extracts multiple artifacts and preserves multi-line content', () => {
    const text = [
      '```file:a.txt',
      'line1',
      'line2',
      '```',
      'between',
      '```file:b.txt',
      'only',
      '```',
    ].join('\n')
    const arts = parseArtifacts(text)
    expect(arts.map((a) => a.path)).toEqual(['a.txt', 'b.txt'])
    expect(arts[0].content).toBe('line1\nline2')
    expect(arts[1].content).toBe('only')
  })

  it('returns nothing for plain prose', () => {
    expect(parseArtifacts('그냥 텍스트 응답입니다.')).toHaveLength(0)
  })
})

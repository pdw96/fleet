import { describe, expect, it } from 'vitest'
import config from '../eslint.config.mjs'

// #173: 코어 순수성 게이트(src/main/core electron/DOM-free)가 조용히 삭제되거나
// 'error'→'warn' 으로 약화되면 lint 는 여전히 green(현 위반 0·eslint --max-warnings 미사용)
// 이라 무신호다. isE2EActive 가 단위테스트로 핀되듯, 게이트 자체도 회귀로부터 핀한다.
// zero-dep: ESLint 프로그래매틱 실행 없이 flat config 객체 형태만 단언한다.

type Rule = [string, ...Record<string, unknown>[]]
const blocks = config as Array<{ files?: string[]; rules?: Record<string, Rule> }>
const coreBlock = blocks.find((c) => c.files?.includes('src/main/core/**/*.ts'))

describe('코어 순수성 ESLint 게이트 회귀 가드 (#173)', () => {
  it('src/main/core/** 스코프 블록이 존재한다', () => {
    expect(coreBlock).toBeDefined()
  })

  it("no-restricted-imports 가 electron·electron/* 를 'error' 로 차단", () => {
    const rule = coreBlock?.rules?.['no-restricted-imports']
    expect(rule?.[0]).toBe('error')
    const opts = rule?.[1] as { paths?: { name: string }[]; patterns?: { group: string[] }[] }
    expect(opts?.paths?.some((p) => p.name === 'electron')).toBe(true)
    expect(opts?.patterns?.some((p) => p.group?.includes('electron/*'))).toBe(true)
  })

  it("no-restricted-syntax 가 동적 import(electron) 를 'error' 로 차단", () => {
    const rule = coreBlock?.rules?.['no-restricted-syntax']
    expect(rule?.[0]).toBe('error')
    const selectors = (rule?.slice(1) as { selector?: string }[] | undefined)
      ?.map((s) => s.selector ?? '')
      .join('  ')
    expect(selectors).toContain('ImportExpression')
    expect(selectors).toContain('electron')
  })

  it("no-restricted-globals 가 window·document 를 'error' 로 차단하고 globalThis 멤버 우회를 검사", () => {
    const rule = coreBlock?.rules?.['no-restricted-globals']
    expect(rule?.[0]).toBe('error')
    const opts = rule?.[1] as {
      globals?: ({ name: string } | string)[]
      checkGlobalObject?: boolean
    }
    const names = (opts?.globals ?? []).map((g) => (typeof g === 'string' ? g : g.name))
    expect(names).toContain('window')
    expect(names).toContain('document')
    expect(opts?.checkGlobalObject).toBe(true)
  })
})

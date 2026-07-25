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

  it("no-restricted-syntax 가 동적 import(electron)·import(electron/*) 를 'error' 로 차단", () => {
    const rule = coreBlock?.rules?.['no-restricted-syntax']
    expect(rule?.[0]).toBe('error')
    const selectors = (rule?.slice(1) as { selector?: string }[] | undefined)
      ?.map((s) => s.selector ?? '')
      .join('  ')
    // bare electron 과 electron/* 하위경로 두 selector 를 각각 핀 — 둘 중 하나만 남아도 통과하던 약점 보완.
    expect(selectors).toContain("ImportExpression[source.value='electron']")
    expect(selectors).toMatch(/ImportExpression\[source\.value=\/\^electron/)
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

  it('게이트 스코프가 src/server·src/shared/transport 를 포함한다(#197 B3 확장)', () => {
    expect(coreBlock?.files).toContain('src/server/**/*.ts')
    expect(coreBlock?.files).toContain('src/shared/transport/**/*.ts')
  })
})

// #174: 도구 실행 모듈 read-only 구조 가드. ApprovalGate 는 tool.classify() 자가신고만 신뢰하므로
// (loop.ts:171) classify:'safe' 인 신규 도구가 raw fs 변형/spawn 하면 무프롬프트로 워크스페이스를
// 바꾼다. 가드가 조용히 삭제/약화되면 lint 는 여전히 green(위반 0)이라 무신호 → 게이트 자체를 핀.
const toolsBlock = blocks.find((c) => c.files?.includes('src/main/core/tools/**/*.ts'))

describe('도구 read-only 구조 가드 ESLint 게이트 (#174)', () => {
  it('tools 블록 존재 + files/ignores 스코프', () => {
    expect(toolsBlock).toBeDefined()
    expect(toolsBlock?.files).toContain('src/main/core/tools/**/*.ts')
    expect((toolsBlock as { ignores?: string[] })?.ignores).toContain(
      'src/main/core/tools/**/*.test.ts',
    )
  })

  it('no-restricted-imports 가 child_process 와 fs 변형 importNames 를 금지', () => {
    const rule = toolsBlock?.rules?.['no-restricted-imports']
    expect(rule?.[0]).toBe('error')
    const opts = rule?.[1] as { paths?: { name: string; importNames?: string[] }[] }
    const names = (opts.paths ?? []).map((p) => p.name)
    expect(names).toContain('child_process')
    expect(names).toContain('node:child_process')
    const fsProm = opts.paths?.find((p) => p.name === 'node:fs/promises')
    expect(fsProm?.importNames).toContain('writeFile')
    expect(fsProm?.importNames).toContain('rm')
  })

  it('no-restricted-syntax 가 fs 변형 메서드 selector 를 보유(write·delete·open 경로)', () => {
    const rule = toolsBlock?.rules?.['no-restricted-syntax']
    expect(rule?.[0]).toBe('error')
    const selectors = (rule?.slice(1) as { selector?: string }[])
      .map((s) => s.selector ?? '')
      .join('  ')
    const dot = selectors.match(/MemberExpression\[property\.name=\/[^/]*\//)?.[0] ?? ''
    // write·delete·open(write-mode)·메타데이터(fchmod/lutimes) 경로를 각각 핀 — 하나만 남아도 통과하던 약점 보완.
    expect(dot).toContain('writeFile')
    expect(dot).toContain('rm')
    expect(dot).toContain('open')
    expect(dot).toContain('fchmod')
    expect(dot).toContain('lutimes')
  })

  it('no-restricted-syntax 가 child_process 동적 import 도 차단(정적 import 우회 봉쇄)', () => {
    const rule = toolsBlock?.rules?.['no-restricted-syntax']
    const selectors = (rule?.slice(1) as { selector?: string }[])
      .map((s) => s.selector ?? '')
      .join('  ')
    expect(selectors).toContain("ImportExpression[source.value='child_process']")
    expect(selectors).toContain("ImportExpression[source.value='node:child_process']")
  })

  it('no-restricted-syntax 가 fs 동적 import·computed fs 변형 접근도 차단(잔여 우회 봉쇄)', () => {
    const rule = toolsBlock?.rules?.['no-restricted-syntax']
    const selectors = (rule?.slice(1) as { selector?: string }[])
      .map((s) => s.selector ?? '')
      .join('  ')
    // const { writeFile } = await import('node:fs/promises') 구조분해 우회 봉쇄
    expect(selectors).toContain("ImportExpression[source.value='node:fs/promises']")
    expect(selectors).toContain("ImportExpression[source.value='node:fs']")
    // fs['writeFile'](...) computed 접근 우회 봉쇄
    expect(selectors).toMatch(/MemberExpression\[computed=true\]\[property\.value=.*writeFile/)
    // const { writeFile } = fs; writeFile(...) 구조분해 bare 호출 우회 봉쇄
    expect(selectors).toMatch(/CallExpression\[callee\.name=.*writeFile/)
    // const { writeFile: wf } = fs 별칭 구조분해 우회 봉쇄(식별자 키)
    expect(selectors).toMatch(/ObjectPattern > Property\[key\.name=\/[^/]*writeFile/)
    // const { 'writeFile': wf } = fs 리터럴 키 구조분해 우회 봉쇄
    expect(selectors).toMatch(/ObjectPattern > Property\[key\.value=\/[^/]*writeFile/)
    // fs[`writeFile`] 정적 템플릿 computed 우회 봉쇄(blanket)
    expect(selectors).toContain("MemberExpression[computed=true][property.type='TemplateLiteral']")
    // createRequire 로더 차단(import·호출·멤버)
    expect(selectors).toContain("CallExpression[callee.name='createRequire']")
    // 난독화 로더/구문 blanket: 비-리터럴 동적 import·CJS require·computed 구조분해 키
    expect(selectors).toContain("ImportExpression[source.type!='Literal']")
    expect(selectors).toContain("CallExpression[callee.name='require']")
    expect(selectors).toContain('ObjectPattern > Property[computed=true]')
    // node:module 전체 import 금지(네임스페이스 별칭 우회 봉쇄 — importNames 아님)
    const imp2 = toolsBlock?.rules?.['no-restricted-imports']?.[1] as {
      paths?: { name: string; importNames?: string[] }[]
    }
    const mod = imp2.paths?.find((p) => p.name === 'node:module')
    expect(mod).toBeDefined()
    expect(mod?.importNames).toBeUndefined()
    // node:module 동적 import 도 차단(createRequire 동적 로더 경로 봉쇄)
    expect(selectors).toContain("ImportExpression[source.value='node:module']")
  })

  it('프로세스 spawn 호출(dot/computed/bare/구조분해)과 cross-spawn import(정적+동적)를 차단(Codex P2)', () => {
    const syn = (toolsBlock?.rules?.['no-restricted-syntax']?.slice(1) as { selector?: string }[])
      .map((s) => s.selector ?? '')
      .join('  ')
    // child_process/cross-spawn 을 어떻게 로드하든 실제 호출 지점을 잡는다.
    expect(syn).toMatch(/MemberExpression\[property\.name=\/[^/]*spawn/)
    expect(syn).toMatch(/CallExpression\[callee\.name=\/[^/]*spawn/)
    expect(syn).toMatch(/ObjectPattern > Property\[key\.name=\/[^/]*spawn/)
    // exec(member cp.exec) + fork 포함 확인
    expect(syn).toContain('fork')
    expect(syn).toContain('exec')
    // cross-spawn 정적 + 동적 import 금지(레포 의존 우회 봉쇄)
    const imp = toolsBlock?.rules?.['no-restricted-imports']?.[1] as {
      paths?: { name: string }[]
    }
    expect(imp.paths?.some((p) => p.name === 'cross-spawn')).toBe(true)
    expect(syn).toContain("ImportExpression[source.value='cross-spawn']")
  })

  it('tools 블록이 electron 정적·동적 import 보호를 재선언(override 함정 방지)', () => {
    const imp = toolsBlock?.rules?.['no-restricted-imports']?.[1] as {
      paths?: { name: string }[]
      patterns?: { group: string[] }[]
    }
    expect(imp.paths?.some((p) => p.name === 'electron')).toBe(true)
    expect(imp.patterns?.some((p) => p.group?.includes('electron/*'))).toBe(true)
    const syn = toolsBlock?.rules?.['no-restricted-syntax']
    const sel = (syn?.slice(1) as { selector?: string }[]).map((s) => s.selector ?? '').join('  ')
    expect(sel).toContain("ImportExpression[source.value='electron']")
  })
})

/**
 * #251 PR1b — 브랜드 위조 차단 룰 핀.
 *
 * `no-unsafe-type-assertion` 은 어떤 프리셋에도 없는 **순수 옵트인**이라, 블록이 조용히 사라져도 lint 는
 * green 이다(현 위반 0). 그런데 이 룰이 `BenchLeaseToken`·`Held<L>` 위조 우회 4종(`as unknown as`·
 * `as never`·`Parameters<>`·`keyof`)을 잡는 **유일한 기계 수단**이므로 블록 자체를 핀한다.
 *
 * ⚠ 이 블록은 기존 코어 블록의 룰 키(no-restricted-imports/globals/syntax)를 **재선언하지 않는다** —
 * flat config 는 같은 키에 대해서만 교체가 일어나므로 #174 의 「후행 블록이 앞 보호를 유실시킨다」 함정에
 * 해당하지 않는다(다른 키 = 순수 추가).
 */
describe('브랜드 위조 차단 ESLint 게이트 (#251 PR1b)', () => {
  const brandBlock = blocks.find((c) => c.files?.includes('src/main/core/workbench/locks.ts'))

  it('locks.ts·lock-order.ts 스코프 블록이 존재한다', () => {
    expect(brandBlock?.files).toEqual([
      'src/main/core/workbench/locks.ts',
      'src/main/core/workbench/lock-order.ts',
    ])
  })

  it("no-unsafe-type-assertion 이 'error' 로 켜져 있다", () => {
    expect(brandBlock?.rules?.['@typescript-eslint/no-unsafe-type-assertion']).toBe('error')
  })

  it('코어 보호 룰 키를 재선언하지 않는다(#174 교체 함정 비해당)', () => {
    const keys = Object.keys(brandBlock?.rules ?? {})
    expect(keys).toEqual(['@typescript-eslint/no-unsafe-type-assertion'])
  })
})

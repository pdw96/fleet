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
const toolsBlock = blocks.find((c) => c.files?.includes('src/main/core/tools/**/*.{ts,tsx}'))

describe('도구 read-only 구조 가드 ESLint 게이트 (#174)', () => {
  it('tools 블록 존재 + files/ignores 스코프', () => {
    expect(toolsBlock).toBeDefined()
    expect(toolsBlock?.files).toContain('src/main/core/tools/**/*.{ts,tsx}')
    expect((toolsBlock as { ignores?: string[] })?.ignores).toContain(
      'src/main/core/tools/**/*.test.{ts,tsx}',
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
    // ⚠ **첫 매치를 집으면 안 된다**(#282): 공통 가드(`CORE_GUARD_SYNTAX`)가 앞에 스프레드되면서
    // 로더용 `MemberExpression[property.name=/^(createRequire|…)/]` 이 먼저 나온다. fs 변형 셀렉터를
    // **내용으로** 특정한다.
    const dot =
      (selectors.match(/MemberExpression\[property\.name=\/[^/]*\//g) ?? []).find((m) =>
        m.includes('writeFile'),
      ) ?? ''
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
  // ⚠ **룰 키로 선택한다**(#251 PR2b): 소진 강제 블록이 전수 glob 으로 승격돼(FRAME-09) 같은 `files` 를
  // 쓰는 블록이 둘이 됐다 — `files` 로만 찾으면 둘 중 먼저 온 것을 잡아 두 핀이 서로를 오검한다.
  const brandBlock = blocks.find(
    (c) =>
      c.files?.includes('src/main/core/workbench/**/*.ts') === true &&
      c.rules?.['@typescript-eslint/no-unsafe-type-assertion'] !== undefined,
  ) as { files?: string[]; ignores?: string[]; rules?: Record<string, unknown> } | undefined

  // 스코프가 **민팅 파일이 아니라 워크벤치 프로덕션 전체**여야 한다(Codex PR#259 P1): 민팅만 덮으면
  // 크레덴셜 **소비자**(장차 `authority.ts`)가 `as unknown as BenchLeaseToken` 으로 위조 토큰을 만들 수 있다.
  it('워크벤치 프로덕션 전체를 덮는다(소비자 포함 · 테스트만 제외)', () => {
    expect(brandBlock?.files).toEqual(['src/main/core/workbench/**/*.ts'])
    expect(brandBlock?.ignores).toEqual(['src/main/core/workbench/**/*.test.ts'])
  })

  it("no-unsafe-type-assertion 이 'error' 로 켜져 있다", () => {
    expect(brandBlock?.rules?.['@typescript-eslint/no-unsafe-type-assertion']).toBe('error')
  })

  it('코어 보호 룰 키를 재선언하지 않는다(#174 교체 함정 비해당)', () => {
    const keys = Object.keys(brandBlock?.rules ?? {})
    expect(keys).toEqual(['@typescript-eslint/no-unsafe-type-assertion'])
  })
})

/**
 * #251 PR2a T6b — 실패 종별 소진 강제 게이트(§3-T16c · 계획 정정 63).
 *
 * §W-4 는 「모든 `CasResult` 소비는 `switch (r.kind)` + `default: assertNever(r)`」를 계약으로 못 박는다.
 * `noFallthroughCasesInSwitch`(tsconfig.base.json:9)는 **fall-through 만** 잡고 exhaustiveness 는 보지
 * 않으므로, 새 실패 종별이 추가돼도 미처리 호출부는 **조용히 통과**한다 — `assertNever` 호출이 있어야
 * 비로소 tsc 가 `never` 대입 실패로 RED 를 낸다.
 *
 * 「부재를 금지」는 `no-restricted-syntax` 로 표현 불가하다는 통념이 있으나 **`:not(:has(…))` 로 된다**
 * (레포 설치본 ESLint 10.7.0 실측: default 절이 없는 switch·default 는 있으나 `assertNever` 를 부르지
 * 않는 switch **둘 다** error · 정상형은 통과).
 *
 * ⚠ **스코프가 신규 파일 한정인 이유**: 워크벤치 전체에 걸면 랜딩된 `locks.ts` 의 switch 2곳이 즉시
 * RED 다(둘 다 반환 타입으로 exhaustive 를 보장하며 `default:` 가 없다). 무관한 파일을 끌고 오는 수정은
 * PR 경계를 흐린다.
 * ⚠ **현 시점 대상 파일에는 switch 가 0건**이다 — 이 가드는 `CasResult` 소비자가 생기는 PR2b 부터
 * 실효하는 **선행 트립와이어**이며, 그 사실을 은폐하지 않는다.
 */
describe('실패 종별 소진 강제 ESLint 게이트 (#251 PR2a)', () => {
  const exhaustBlock = blocks.find(
    (c) =>
      c.files?.includes('src/main/core/workbench/**/*.ts') === true &&
      c.rules?.['no-restricted-syntax'] !== undefined,
  ) as { files?: string[]; ignores?: string[]; rules?: Record<string, unknown> } | undefined

  const syntax = exhaustBlock?.rules?.['no-restricted-syntax'] as
    [string, ...{ selector: string; message: string }[]] | undefined

  /**
   * ⚠ **PR2b 에서 전수 glob 으로 승격**(자체 적대 리뷰 FRAME-09). 파일 2개 exact 로 두면 신규 워크벤치
   * 파일이 `CasResult` 를 소비해도 소진 강제가 **무신호로 미적용**이다 — 구조 가드 4종은 전수로 올렸는데
   * 정작 「새 실패 종별을 잡는」 이 게이트만 목록에 남아 있었다. 랜딩된 두 파일은 `ignores` 로 제외한다
   * (둘 다 반환 타입으로 exhaustive 를 보장하며 `default:` 가 없어 즉시 RED).
   */
  it('워크벤치 프로덕션 전수를 덮고 랜딩 2파일만 제외한다', () => {
    expect(exhaustBlock?.files).toEqual(['src/main/core/workbench/**/*.ts'])
    expect(exhaustBlock?.ignores).toEqual([
      'src/main/core/workbench/**/*.test.ts',
      'src/main/core/workbench/locks.ts',
      'src/main/core/workbench/lock-order.ts',
    ])
  })

  it('assertNever 부재를 잡는 selector 가 error 로 존재한다', () => {
    expect(syntax?.[0]).toBe('error')
    const selectors = (syntax?.slice(1) ?? []) as { selector: string }[]
    expect(
      selectors.some(
        (s) =>
          s.selector.includes('SwitchStatement') &&
          s.selector.includes(':not(') &&
          s.selector.includes('assertNever'),
      ),
    ).toBe(true)
  })

  /**
   * **#174 재발 방지.** flat config 는 같은 룰 키를 뒤 블록이 **교체**한다(공식 문서: later objects
   * overriding previous objects). 코어 블록(`src/main/core/**`)이 `no-restricted-syntax` 로
   * `ELECTRON_DYNAMIC_IMPORT_SYNTAX` 를 걸고 있으므로, 이 블록이 같은 키를 선언하는 순간 **그 두 파일에서
   * electron 동적 import 보호가 유실된다**. `tools` 블록(eslint.config.mjs:361-363)이 쓰는 「공유 const
   * 재선언」 관용구를 그대로 답습해야 하고, 그 재선언을 여기서 핀한다.
   */
  it('코어의 electron 동적 import 보호를 재선언해 유실을 막는다(#174)', () => {
    // 두 selector 를 **각각** exact 로 핀한다 — 「ImportExpression 이 있다」와 「electron 이 있다」를
    // 독립 `some` 으로 보면 **둘 중 하나만 남아도** 두 조건이 서로 다른 selector 로 충족돼 통과한다.
    // 그것은 #173 이 이미 보완한 약점이라 재유입하지 않는다(위 :32-34 와 같은 형태).
    const selectors = ((syntax?.slice(1) ?? []) as { selector: string }[]).map((s) => s.selector)
    expect(selectors).toContain("ImportExpression[source.value='electron']")
    expect(selectors).toContain('ImportExpression[source.value=/^electron\\//]')
  })
})

/**
 * #282 — **fs 경계 가드가 후속 블록에 교체당하지 않는지** 전수로 핀한다.
 *
 * flat config 는 같은 rule-key 를 병합이 아니라 **교체**한다. 이 레포는 그 함정을 알고 electron 가드를
 * 블록마다 재선언해 왔는데, #282 가 추가한 fs 경계 가드는 그 규율을 따르지 않아 **workbench 블록이
 * 통째로 무력화**하고 있었다(Codex 7R 적발 — lint 는 green 이라 무신호). 개별 블록을 하나씩 핀하면
 * **다음에 추가되는 블록이 같은 방식으로 또 뚫는다**. 그래서 「코어를 스코프로 `no-restricted-syntax`
 * 를 선언하는 **모든** 블록은 공통 묶음을 포함한다」를 불변식으로 세운다.
 */
describe('fs 경계 가드 override 방지 (#282)', () => {
  const CORE_SCOPED = /^src\/(main\/core|server|shared\/transport)\//
  const coreSyntaxBlocks = blocks.filter(
    (c) =>
      c.files?.some((f) => CORE_SCOPED.test(f)) === true &&
      c.rules?.['no-restricted-syntax'] !== undefined,
  )

  it('앵커: 코어 스코프에서 no-restricted-syntax 를 쓰는 블록이 복수다', () => {
    expect(coreSyntaxBlocks.length).toBeGreaterThanOrEqual(4)
  })

  /** 공통 묶음의 대표 셀렉터 — 하나라도 빠지면 그 블록에서 해당 방어가 사라진 것이다. */
  const REQUIRED = [
    "ImportExpression[source.value='electron']",
    "ImportExpression[source.type!='Literal']",
    "ExportNamedDeclaration[source.value='node:fs']",
  ]

  it('모든 코어 스코프 블록이 공통 가드(electron·로더·fs 재-export)를 포함한다', () => {
    for (const block of coreSyntaxBlocks) {
      const entries = (block.rules?.['no-restricted-syntax'] ?? []).slice(1) as {
        selector?: string
      }[]
      const selectors = entries.map((e) => e.selector)
      for (const required of REQUIRED) {
        expect(
          selectors,
          `블록 files=${JSON.stringify(block.files)} 에 "${required}" 가 없다 — CORE_GUARD_SYNTAX 를 스프레드하라(flat config 는 rule-key 를 교체한다)`,
        ).toContain(required)
      }
    }
  })

  it('로더 가드가 별칭·구조분해 형태까지 덮는다(7R)', () => {
    const boundary = coreSyntaxBlocks.flatMap(
      (c) => (c.rules?.['no-restricted-syntax'] ?? []).slice(1) as { selector?: string }[],
    )
    const selectors = boundary.map((e) => e.selector ?? '')
    expect(
      selectors.some((s) => s.startsWith('ImportSpecifier[imported.name=/^(createRequire')),
    ).toBe(true)
    expect(
      selectors.some((s) => s.startsWith('ObjectPattern > Property[key.name=/^(createRequire')),
    ).toBe(true)
    // import-then-export 형태(source 없는 재-export)
    expect(selectors.some((s) => s.startsWith('ExportSpecifier[local.name='))).toBe(true)
  })
})

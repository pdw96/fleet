// scripts/approval-gate-exceptions.test.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **`ApprovalGate` 예외 계약**(AGENTS.md 「아키텍처 규칙 · 안전 우선」).
 *
 * AGENTS.md 는 게이트를 거치지 않는 「엔진 인프라 쓰기」 모듈을 **닫힌 열거**로 적는다. 이건 보안
 * 불변식 목록이라, 열거가 실제와 어긋나면 **새 예외를 P1 으로 잡을 근거 자체가 사라진다** — 리뷰어가
 * 「목록에 없으니 새 예외」라고 말할 수 없게 된다. 실제로 #251 이 세 모듈을 추가하는 동안 열거는 넷에
 * 멈춰 있었다. 그래서 산문이 아니라 기계로 강제한다(#137·#140 의 「명문화는 집행이 아니다」).
 *
 * ## 왜 「변이 API 탐지」가 아니라 「import 경계 allowlist」인가
 *
 * 초안은 변이 API 이름을 정규식으로 분류해 후보를 유도했다. 그 접근은 **Codex 리뷰 5라운드 내내 새
 * 회피 형태를 계속 냈다** — promise 형 · `{ promises as fs }` · `fs.promises.x` · bare 지정자 ·
 * 동적 import · FileHandle 경유 · re-export 체인 · 네임스페이스 구조분해. 동적 언어에서 그 꼬리는
 * 끝나지 않는다(레포 교훈: 「패치가 번갈아 뚫리면 프리미티브를 의심하라」).
 *
 * **import 경계는 유한하다.** fs 가 코어에 들어오는 문은 import 하나뿐이므로, `eslint.config.mjs` 의
 * `CORE_FS_ALLOWLIST` 밖에서 fs import(정적·동적·re-export)를 **금지**하면 위 형태가 한 번에 전부
 * 무의미해진다(#282 · 세 형태 프로브로 실측 차단 확인). 그래서 이 파일은 **탐지기가 아니라 대조기**다:
 *
 * 1. **allowlist == 실제 fs 소비자** — 목록이 낡거나 과대해지지 않게 파일시스템과 대조한다.
 * 2. **변이 티어 ∪ `DurableFs` 소비자 == AGENTS.md 열거** — 문서 갱신 없이 예외를 늘릴 수도,
 *    근거 없는 예외를 문서만으로 정당화할 수도 없다.
 * 3. **근거 절의 형태** — 파일 머리 영역(첫 top-level `export` 이전)의 블록 주석 `##` 헤딩이어야
 *    한다. 헐거우면 게이트를 *통과하는* 소비자 넷이 전부 매치돼 열거가 무의미해지고, 위치를 안 보면
 *    함수 JSDoc 한 줄로 예외를 사후 정당화할 수 있다(CodeRabbit PR#282).
 * 4. **게이트 존재 자체** — eslint 블록이 사라지면 1~3 이 전부 무신호가 되므로 블록을 핀한다.
 *
 * **남는 한계는 숨기지 않는다**: 이 계약은 fs API 경유 변이만 다룬다. `workspace/git.ts` 처럼 **git
 * 하위 프로세스를 통한 변이**는 import 경계 밖이다(spawn 은 AGENTS.md 「게이트의 소비자」 절이 다루는
 * 별개 계약). 그래서 이 층은 「모든 우회를 잡는다」가 아니라 **「fs 를 만지려면 반드시 이름을 올려야
 * 한다」**로 읽어야 한다.
 */

const CORE = join('src', 'main', 'core')
const AGENTS = 'AGENTS.md'
const ESLINT = 'eslint.config.mjs'

/** 근거 절 헤딩 — 블록 주석 안의 `## ` 절 형태여야 한다. */
const RATIONALE_HEADING = /^\s*\*\s*##\s*`ApprovalGate`\s*를 거치지 않는 이유/m

const read = (rel: string): string => readFileSync(rel, 'utf8')

/**
 * 주석 제거 — 스캔이 **주석 속 산문**을 코드로 오인하지 않게 한다. 이 레포의 소스는 계약을 길게
 * 설명하므로 `node:fs` 같은 문자열이 설명문에 흔히 등장한다(초안 스캔이 실제로 `authority.ts`·
 * `journal.ts` 를 fs 소비자로 오분류했다 — 둘은 주입 `DurableFs` 로만 쓴다).
 * 선례 = `deploy-workbench-pin.test.ts` · `boot-workbench.test.ts`.
 */
export const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * fs 모듈을 어떤 형태로든 들여오는가 — `import … from` · `export … from` · `import()`.
 * **분류하지 않는다**(읽기/쓰기 구분은 eslint allowlist 의 티어가 한다). `node:` 접두는 관례일 뿐이라
 * bare 지정자도 함께 본다.
 */
export const importsFs = (src: string): boolean =>
  /(?:from|import)\s*\(?\s*'(?:node:)?fs(?:\/promises)?'/.test(stripComments(src))

/**
 * 내구 쓰기 seam 소비 — `DurableFs` 를 받는(또는 실 어댑터를 만드는) 모듈은 fs 를 직접 import 하지
 * 않고도 변이한다. **식별자가 아니라 모듈 지정자로 판정한다**(Codex PR#282 4R): `\bDurableFs\b` 는
 * `createNodeDurableFs` 같은 팩토리 이름 안의 부분 문자열을 못 잡는다. type-only import 도 포함 —
 * `journal`·`authority` 가 정확히 그 형태이면서 실제로 변이한다.
 */
export const usesDurableFs = (src: string): boolean =>
  /from\s+'[^']*\/durable-fs'/.test(stripComments(src))

/** 파일 머리 영역 = 첫 top-level `export` 이전. 그 뒤의 함수 JSDoc 은 「모듈 상단」이 아니다. */
export const moduleHeader = (src: string): string => {
  const m = /^export\b/m.exec(src)
  return m ? src.slice(0, m.index) : src
}

export const hasRationaleSection = (src: string): boolean =>
  RATIONALE_HEADING.test(moduleHeader(src))

/** `eslint.config.mjs` 의 배열 리터럴 상수에서 경로 문자열을 뽑는다. */
export const eslintPathConst = (config: string, name: string): string[] => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(config)
  if (!m) return []
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
}

/** 코어 프로덕션 소스 전량(테스트·테스트 더블 제외). */
const coreSources = (): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== '__testing__') walk(p)
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
      // ⚠ `.tsx` 도 센다(Codex PR#282 6R): 빌드는 컴파일하는데 스캔·lint 만 `.ts` 로 좁으면
      // 프로덕션 헬퍼를 `.tsx` 로 두는 것만으로 경계 밖이 된다.
    }
  }
  walk(CORE)
  return out
}

/** 코어 기준 posix 상대경로(`workbench/journal.ts`). */
const asModuleId = (p: string): string => relative(CORE, p).split(sep).join('/')
/** eslint allowlist 표기(`src/main/core/…`) → 코어 상대 id. */
const asModuleIdFromRepo = (p: string): string => p.replace(/^src\/main\/core\//, '')

/**
 * AGENTS.md 의 「예외 = 엔진 인프라 쓰기」 불릿만 도려낸다. 파일 전체 regex 로 `.ts` 를 긁으면
 * 「함정」·「P1 신호」 절이 인용하는 무관한 경로까지 열거로 오인한다(형제 관용구 =
 * `deploy-workbench-pin.test.ts` 의 서비스 블록 스코프).
 */
const exceptionBullet = (): string => {
  const lines = read(AGENTS).split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*- \*\*예외 = 엔진 인프라 쓰기\*\*/.test(l))
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^- /.test(l) || /^#/.test(l))
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n')
}

/** 불릿 안의 백틱 토큰 중 **코어 모듈 경로 형태**만. `.test.ts` 는 테스트 파일이라 제외. */
const enumeratedModules = (): string[] => {
  const toks = [...exceptionBullet().matchAll(/`([^`]+)`/g)].map((m) => m[1])
  return toks.filter(
    (t) => /^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.tsx?$/.test(t) && !/\.test\.tsx?$/.test(t),
  )
}

const eslintConfig = read(ESLINT)
const readonlyTier = eslintPathConst(eslintConfig, 'CORE_FS_READONLY').map(asModuleIdFromRepo)
const mutatingTier = eslintPathConst(eslintConfig, 'CORE_FS_MUTATING').map(asModuleIdFromRepo)
const allowlist = [...readonlyTier, ...mutatingTier].sort()

const sources = coreSources()
const fsConsumers = sources
  .filter((p) => importsFs(read(p)))
  .map(asModuleId)
  .sort()
const seamConsumers = sources
  .filter((p) => usesDurableFs(read(p)))
  .map(asModuleId)
  .sort()
const withRationale = sources
  .filter((p) => hasRationaleSection(read(p)))
  .map(asModuleId)
  .sort()
const declared = [...new Set(enumeratedModules())].sort()

describe('ApprovalGate 예외 — 앵커(이하 단언이 vacuous 가 아님을 먼저 고정)', () => {
  it('코어 소스 스캔이 실제로 파일을 훑는다', () => {
    expect(sources.length).toBeGreaterThan(50)
  })

  it('AGENTS.md 의 예외 불릿을 실제로 도려낸다', () => {
    const bullet = exceptionBullet()
    expect(bullet).toContain('예외 = 엔진 인프라 쓰기')
    expect(bullet.length).toBeGreaterThan(150)
  })

  it('네 집합이 모두 비어 있지 않다(비면 이하 단언이 항진명제)', () => {
    for (const [name, set] of [
      ['allowlist', allowlist],
      ['fsConsumers', fsConsumers],
      ['declared', declared],
      ['withRationale', withRationale],
    ] as const) {
      expect(set.length, `${name} 이 비었다`).toBeGreaterThanOrEqual(4)
    }
  })
})

/**
 * **구조 층** — eslint 가 fs 의 문을 닫고 있는가, 그리고 그 allowlist 가 현실과 같은가.
 * 이 층이 없으면 아래 대조는 「문서끼리 대조」로 되돌아가 근거 절을 *안 쓴* 우회를 못 잡는다.
 */
describe('ApprovalGate 예외 — fs import 경계 게이트(#282)', () => {
  it('eslint 가 allowlist 밖 코어의 fs import 를 정적·동적 양쪽으로 막는다', () => {
    expect(eslintConfig).toContain(
      'const CORE_FS_ALLOWLIST = [...CORE_FS_READONLY, ...CORE_FS_MUTATING]',
    )
    expect(eslintConfig).toContain('CORE_FS_DYNAMIC_IMPORT_SYNTAX')
    // 게이트 블록이 allowlist 를 ignores 로 쓰고, 금지 패턴에 fs 모듈군을 건다.
    expect(eslintConfig).toMatch(/ignores: \[\s*\.\.\.CORE_FS_ALLOWLIST/)
    expect(eslintConfig).toMatch(/group: TOOLS_FS_MODULES/)
    // 6R: 대체 로더·raw 재-export·읽기 전용 티어 집행이 모두 걸려 있어야 한다.
    expect(eslintConfig).toContain('CORE_LOADER_GUARD_SYNTAX')
    expect(eslintConfig).toContain('CORE_FS_REEXPORT_SYNTAX')
    expect(eslintConfig).toContain('CORE_FS_READONLY_SYNTAX')
    expect(eslintConfig).toContain('getBuiltinModule')
    // 확장자 사각 차단 — 경계 블록이 .tsx 도 덮는다.
    expect(eslintConfig).toMatch(/files: \['src\/main\/core\/\*\*\/\*\.\{ts,tsx\}'\]/)
  })

  it('allowlist == 실제 fs 소비자(목록이 낡지도, 과대하지도 않다)', () => {
    expect(allowlist).toEqual(fsConsumers)
  })

  it('두 티어가 서로 겹치지 않는다', () => {
    expect(readonlyTier.filter((m) => mutatingTier.includes(m))).toEqual([])
  })
})

describe('ApprovalGate 예외 — 열거 == 변이 티어 ∪ seam 소비자', () => {
  it('두 집합이 정확히 일치한다', () => {
    expect([...new Set([...mutatingTier, ...seamConsumers])].sort()).toEqual(declared)
  })

  it('열거 == 근거 절 보유 모듈(양방향 잠금)', () => {
    expect(withRationale).toEqual(declared)
  })

  it('열거된 경로가 전부 실존한다(문서 오타를 잡는다)', () => {
    const ids = new Set(sources.map(asModuleId))
    expect(declared.filter((d) => !ids.has(d))).toEqual([])
  })

  it('근거 절은 모듈당 정확히 1회다(중복 절은 편집 사고 신호)', () => {
    const global = /^\s*\*\s*##\s*`ApprovalGate`\s*를 거치지 않는 이유/gm
    for (const p of sources.filter((p) => hasRationaleSection(read(p)))) {
      expect(read(p).match(global) ?? [], `${asModuleId(p)} 의 근거 절 개수`).toHaveLength(1)
    }
  })
})

/**
 * 마커의 판별력. 게이트를 *통과하는* 소비자는 `ApprovalGate` 를 빈번히 언급하므로, 헐거운 마커였다면
 * 열거가 소비자까지 삼켜 아무것도 강제하지 못한다.
 */
describe('ApprovalGate 예외 — 마커 판별력(소비자 오염 0)', () => {
  const CONSUMERS = [
    'engine.ts',
    'orchestrator/orchestrator.ts',
    'mcp/host.ts',
    'tools/loop.ts',
  ] as const

  it('소비자 넷이 실존하고, 그중 어느 것도 예외로 잡히지 않는다', () => {
    const ids = new Set(sources.map(asModuleId))
    for (const c of CONSUMERS) {
      expect(ids.has(c), `${c} 가 실존해야 한다(경로 drift 면 이 단언이 vacuous)`).toBe(true)
      expect(withRationale).not.toContain(c)
    }
  })

  it('AGENTS.md 도 같은 소비자 넷을 적는다(산문↔소스 교차 단언)', () => {
    const md = read(AGENTS)
    for (const c of CONSUMERS) expect(md).toContain(`\`${c}\``)
  })
})

/** 순수 술어 층 — 실제 트리가 정합이면 반증력을 알 수 없으므로 합성 소스로 실패 모드를 재현한다. */
describe('스캔 술어 — 합성 소스로 반증력 실측', () => {
  it('fs import 를 형태와 무관하게 잡는다(정적·bare·re-export·동적·별칭)', () => {
    expect(importsFs(`import { readFileSync } from 'node:fs'`)).toBe(true)
    expect(importsFs(`import { writeFile } from 'fs/promises'`)).toBe(true)
    expect(importsFs(`export { writeFile } from 'node:fs/promises'`)).toBe(true)
    expect(importsFs(`const fs = await import('node:fs')`)).toBe(true)
    expect(importsFs(`import { promises as fs } from 'node:fs'`)).toBe(true)
    expect(importsFs(`import { join } from 'node:path'`)).toBe(false)
  })

  it('주석 속 산문·주석 처리된 import 는 fs 소비가 아니다', () => {
    expect(
      importsFs(`/** rename 을 조율한다(주입 DurableFs 가 실행). */\nexport const x = 1`),
    ).toBe(false)
    expect(importsFs(`// import { rmSync } from 'node:fs'`)).toBe(false)
  })

  it('DurableFs seam 은 모듈 지정자로 판정한다(팩토리 import·type-only 포함)', () => {
    expect(usesDurableFs(`import { createNodeDurableFs } from './durable-fs'`)).toBe(true)
    expect(usesDurableFs(`import type { DurableFs } from '../workbench/durable-fs'`)).toBe(true)
    expect(usesDurableFs(`/** DurableFs 얘기만 하는 주석 */\nexport const x = 1`)).toBe(false)
  })

  it('근거 절은 파일 머리 영역에서만 인정한다(함수 JSDoc 사후 정당화 차단)', () => {
    const header = `import x from 'y'\n/**\n * ## \`ApprovalGate\` 를 거치지 않는 이유 (…)\n */\nexport const a = 1`
    const late = `export const a = 1\n/**\n * ## \`ApprovalGate\` 를 거치지 않는 이유 (…)\n */\nexport const b = 2`
    expect(hasRationaleSection(header)).toBe(true)
    expect(hasRationaleSection(late)).toBe(false)
  })

  it('블록 주석이 아닌 언급은 근거 절이 아니다', () => {
    expect(
      hasRationaleSection('// ## `ApprovalGate` 를 거치지 않는 이유\nexport const a = 1'),
    ).toBe(false)
    expect(hasRationaleSection('const s = "`ApprovalGate` 를 거치지 않는 이유"')).toBe(false)
  })

  it('eslint 배열 상수 파서가 경로를 뽑는다', () => {
    expect(eslintPathConst(`const FOO = ['a/b.ts', 'c/d.ts']`, 'FOO')).toEqual(['a/b.ts', 'c/d.ts'])
    expect(eslintPathConst(`const FOO = []`, 'BAR')).toEqual([])
  })
})

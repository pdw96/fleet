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
 * ## 계약 3층 — 왜 문서끼리 대조하는 것만으로는 부족한가
 *
 * 1. **파생 후보 ⊆ 열거** — 코어 프로덕션 모듈 중 **실제로 파일시스템을 변이하는 것**(node:fs 변이 API
 *    직접 import, 또는 내구 쓰기 seam `DurableFs` 소비)을 소스에서 **독립적으로 유도**해, 전부 열거에
 *    들어 있는지 본다. 이 층이 없으면 근거 절을 *안 쓴* 신규 우회는 스캔에도 문서에도 안 잡혀
 *    **양쪽이 사이좋게 통과**한다(Codex PR#282 P1). 실제로 이 층을 넣자마자 미선언 변이자
 *    `workspace/git.ts`(`rmSync(index.lock)`)가 드러났다.
 * 2. **열거 == 근거 절 보유 모듈** — 문서 갱신 없이 예외를 늘릴 수도, 근거 없는 예외를 문서만으로
 *    정당화할 수도 없게 하는 양방향 잠금.
 * 3. **마커 판별력** — 근거 절은 **파일 머리 영역**(첫 top-level `export` 이전)의 블록 주석 `##` 헤딩
 *    이어야 한다. 「어딘가에 ApprovalGate 를 언급한다」로 두면 게이트를 *통과하는* 소비자 넷이 전부
 *    매치돼 열거가 무의미해지고, 파일 아무 데나 허용하면 함수 JSDoc 한 줄로 예외를 사후 정당화할 수
 *    있다(CodeRabbit PR#282).
 *
 * **한계는 숨기지 않는다**: 1층은 *직접* fs 변이와 `DurableFs` 소비만 유도한다. git 하위 프로세스처럼
 * **자식 프로세스를 통한 변이**는 이 스캔 밖이다(spawn 은 별개 계약 — AGENTS.md 의 게이트 소비자 절이
 * 다룬다). 그래서 1층은 「모든 우회를 잡는다」가 아니라 「가장 흔한 형태의 신규 우회가 조용히 들어오지
 * 못한다」로 읽어야 한다.
 */

const CORE = join('src', 'main', 'core')
const AGENTS = 'AGENTS.md'

/** 근거 절 헤딩 — 블록 주석 안의 `## ` 절 형태여야 한다. */
const RATIONALE_HEADING = /^\s*\*\s*##\s*`ApprovalGate`\s*를 거치지 않는 이유/m

/** 직접 호출 시 파일시스템을 변이하는 node:fs API. 읽기 전용 API 는 일부러 뺀다. */
export const FS_MUTATION_APIS = [
  'appendFileSync',
  'chmodSync',
  'chownSync',
  'copyFileSync',
  'cpSync',
  'createWriteStream',
  'ftruncateSync',
  'linkSync',
  'mkdirSync',
  'mkdtempSync',
  'openSync',
  'renameSync',
  'rmSync',
  'rmdirSync',
  'symlinkSync',
  'truncateSync',
  'unlinkSync',
  'utimesSync',
  'writeFileSync',
  'writeSync',
] as const

/**
 * 주석 제거 — 스캔이 **주석 속 산문**을 코드로 오인하지 않게 한다. 이 레포의 소스는 계약을 길게
 * 설명하므로 `renameSync` 같은 이름이 설명문에 흔히 등장하고, 실제로 주석을 안 벗긴 1차 스캔이
 * `authority.ts`·`journal.ts` 를 직접 변이자로 오분류했다(둘은 주입 `DurableFs` 로만 쓴다).
 * 선례 = `deploy-workbench-pin.test.ts` · `boot-workbench.test.ts`.
 */
export const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** `import { … } from 'node:fs'` 의 named 바인딩 중 변이 API. */
export const fsMutationBindings = (src: string): string[] => {
  const found = new Set<string>()
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g
  for (const m of stripComments(src).matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim()
      if ((FS_MUTATION_APIS as readonly string[]).includes(name)) found.add(name)
    }
  }
  return [...found].sort()
}

/** 내구 쓰기 seam 소비 — `DurableFs` 를 받는 모듈은 fs 를 직접 import 하지 않고도 변이한다. */
export const usesDurableFs = (src: string): boolean => /\bDurableFs\b/.test(stripComments(src))

/** 파일 머리 영역 = 첫 top-level `export` 이전. 그 뒤의 함수 JSDoc 은 「모듈 상단」이 아니다. */
export const moduleHeader = (src: string): string => {
  const m = /^export\b/m.exec(src)
  return m ? src.slice(0, m.index) : src
}

export const hasRationaleSection = (src: string): boolean =>
  RATIONALE_HEADING.test(moduleHeader(src))

const read = (rel: string): string => readFileSync(rel, 'utf8')

/** 코어 프로덕션 소스 전량(테스트·테스트 더블 제외). */
const coreSources = (): string[] => {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== '__testing__') walk(p)
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
    }
  }
  walk(CORE)
  return out
}

/** 코어 기준 posix 상대경로(`workbench/journal.ts`). */
const asModuleId = (p: string): string => relative(CORE, p).split(sep).join('/')

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
  // 다음 최상위 불릿(들여쓰기 0) 또는 헤딩까지.
  const end = rest.findIndex((l) => /^- /.test(l) || /^#/.test(l))
  return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n')
}

/** 불릿 안의 백틱 토큰 중 **코어 모듈 경로 형태**만. `.test.ts` 는 테스트 파일이라 제외. */
const enumeratedModules = (): string[] => {
  const toks = [...exceptionBullet().matchAll(/`([^`]+)`/g)].map((m) => m[1])
  return toks.filter((t) => /^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.ts$/.test(t) && !t.endsWith('.test.ts'))
}

const sources = coreSources()
const withRationale = sources
  .filter((p) => hasRationaleSection(read(p)))
  .map(asModuleId)
  .sort()
const declared = [...new Set(enumeratedModules())].sort()
const mutators = sources
  .filter((p) => {
    const src = read(p)
    return fsMutationBindings(src).length > 0 || usesDurableFs(src)
  })
  .map(asModuleId)
  .sort()

describe('ApprovalGate 예외 — 앵커(이하 단언이 vacuous 가 아님을 먼저 고정)', () => {
  it('코어 소스 스캔이 실제로 파일을 훑는다', () => {
    expect(sources.length).toBeGreaterThan(50)
  })

  it('AGENTS.md 의 예외 불릿을 실제로 도려낸다', () => {
    const bullet = exceptionBullet()
    expect(bullet).toContain('예외 = 엔진 인프라 쓰기')
    expect(bullet.length).toBeGreaterThan(150)
  })

  it('세 집합이 모두 비어 있지 않다(비면 이하 단언이 항진명제)', () => {
    expect(withRationale.length).toBeGreaterThanOrEqual(4)
    expect(declared.length).toBeGreaterThanOrEqual(4)
    expect(mutators.length).toBeGreaterThanOrEqual(4)
  })
})

/**
 * **1층** — 문서를 보지 않고 소스에서 독립 유도한 「실제 변이자」가 전부 열거 안에 있는가.
 * 근거 절을 안 쓴 신규 우회는 2층(문서↔문서)으로는 절대 안 잡힌다.
 */
describe('ApprovalGate 예외 — 파생 후보 ⊆ 열거(미선언 우회 탐지)', () => {
  it('fs 를 변이하는 코어 모듈 중 열거에 없는 것이 없다', () => {
    expect(mutators.filter((m) => !declared.includes(m))).toEqual([])
  })

  it('변이 판정 근거를 실제로 잡아낸다(스캔이 무신호가 아님)', () => {
    const evidence = sources
      .map((p) => ({ id: asModuleId(p), apis: fsMutationBindings(read(p)) }))
      .filter((e) => e.apis.length > 0)
    expect(evidence.length).toBeGreaterThanOrEqual(4)
    expect(evidence.map((e) => e.id)).toContain('store/json-file.ts')
    // 주입 seam 경유 변이도 후보에 든다(fs 직접 import 가 없어도).
    expect(mutators).toContain('workbench/journal.ts')
  })
})

describe('ApprovalGate 예외 — 열거 == 근거 절 보유 모듈', () => {
  it('두 집합이 정확히 일치한다', () => {
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
 * **3층** — 마커의 판별력. 게이트를 *통과하는* 소비자는 `ApprovalGate` 를 빈번히 언급하므로,
 * 헐거운 마커였다면 열거가 소비자까지 삼켜 아무것도 강제하지 못한다.
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

/**
 * 순수 함수 층 — 실제 트리는 지금 정합이라 위 단언들만으로는 **반증력이 있는지** 알 수 없다.
 * 합성 소스로 각 실패 모드를 직접 재현한다(뮤테이션 자기검사 규율).
 */
describe('스캔 술어 — 합성 소스로 반증력 실측', () => {
  it('fs 변이 import 를 잡고, 읽기 전용 import 는 안 잡는다', () => {
    expect(fsMutationBindings(`import { rmSync, readFileSync } from 'node:fs'`)).toEqual(['rmSync'])
    expect(fsMutationBindings(`import { readFileSync, statSync } from 'node:fs'`)).toEqual([])
    expect(fsMutationBindings(`import { writeFile } from 'node:fs/promises'`)).toEqual([])
    expect(fsMutationBindings(`import { writeFileSync as w } from 'node:fs'`)).toEqual([
      'writeFileSync',
    ])
  })

  it('주석 속 산문은 변이자로 오인하지 않는다(1차 스캔이 실제로 낸 오분류)', () => {
    const src = `/**\n * rename·unlinkSync 를 조율한다(주입 DurableFs 가 실행).\n */\nimport { readFileSync } from 'node:fs'`
    expect(fsMutationBindings(src)).toEqual([])
  })

  it('주석 처리된 import 도 변이자가 아니다', () => {
    expect(fsMutationBindings(`// import { rmSync } from 'node:fs'`)).toEqual([])
  })

  it('DurableFs 소비를 잡는다(fs 직접 import 없이 변이하는 경로)', () => {
    expect(usesDurableFs(`import type { DurableFs } from './durable-fs'`)).toBe(true)
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
})

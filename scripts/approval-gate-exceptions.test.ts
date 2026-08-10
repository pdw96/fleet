// scripts/approval-gate-exceptions.test.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **`ApprovalGate` 예외 열거 ↔ 소스 일치**(AGENTS.md 「아키텍처 규칙 · 안전 우선」).
 *
 * AGENTS.md 는 게이트를 거치지 않는 「엔진 인프라 쓰기」 모듈을 **닫힌 열거**로 적는다. 그런데 이건
 * 보안 불변식 목록이라, 열거가 실제와 어긋나면 **새 예외를 P1 으로 잡을 근거 자체가 사라진다**
 * — 리뷰어가 「목록에 없으니 새 예외」라고 말할 수 없게 된다. 실제로 #251 이 세 모듈
 * (`authority`·`durable-fs`·`journal`)을 추가하는 동안 열거는 넷에 멈춰 있었다.
 *
 * 그래서 산문을 고치는 데서 멈추지 않고 **기계로 강제**한다(#137·#140 이 얻은 「명문화는 집행이
 * 아니다」의 이 문단판). 계약은 양방향이다:
 *   ① 근거 절을 가진 모듈이 AGENTS.md 열거에 없으면 RED — 문서 갱신 없이 예외를 늘릴 수 없다.
 *   ② AGENTS.md 가 적은 모듈에 근거 절이 없으면 RED — 근거 없는 예외를 문서만으로 정당화할 수 없다.
 *
 * 근거의 **형태**까지 고정하는 이유: 「어딘가에 ApprovalGate 를 언급한다」로 두면 소비자 모듈
 * (`engine.ts`·`mcp/host.ts` 등 게이트를 *통과하는* 쪽)이 전부 매치돼 열거가 무의미해진다. 마커는
 * 모듈 독블록의 `##` 절 헤딩이라는 **구조적 형태**여야 한다.
 */

const CORE = join('src', 'main', 'core')
const AGENTS = 'AGENTS.md'

/** 근거 절 헤딩 — 모듈 독블록(`/** … *\/`) 안의 `## ` 절이어야 한다. */
const RATIONALE_HEADING = /^\s*\*\s*##\s*`ApprovalGate`\s*를 거치지 않는 이유/m

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
const scanned = sources
  .filter((p) => RATIONALE_HEADING.test(read(p)))
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

  it('양쪽 집합이 비어 있지 않다(둘 다 0 이면 일치 단언이 항진명제)', () => {
    expect(scanned.length).toBeGreaterThanOrEqual(4)
    expect(declared.length).toBeGreaterThanOrEqual(4)
  })
})

describe('ApprovalGate 예외 — 열거 == 근거 절 보유 모듈(AGENTS.md 「안전 우선」)', () => {
  it('두 집합이 정확히 일치한다', () => {
    expect(scanned).toEqual(declared)
  })

  it('열거된 경로가 전부 실존한다(문서 오타를 잡는다)', () => {
    const ids = new Set(sources.map(asModuleId))
    expect(declared.filter((d) => !ids.has(d))).toEqual([])
  })

  it('근거 절은 모듈당 정확히 1회다(중복 절은 편집 사고 신호)', () => {
    const global = /^\s*\*\s*##\s*`ApprovalGate`\s*를 거치지 않는 이유/gm
    for (const p of sources.filter((p) => RATIONALE_HEADING.test(read(p)))) {
      expect(read(p).match(global) ?? [], `${asModuleId(p)} 의 근거 절 개수`).toHaveLength(1)
    }
  })
})

/**
 * **마커가 소비자 모듈을 잡지 않는다**는 것이 이 계약의 판별력 전제다. 게이트를 *통과하는* 쪽
 * (AGENTS.md 가 소비자로 지목한 넷)은 `ApprovalGate` 를 빈번히 언급하므로, 헐거운 마커였다면
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
      expect(scanned).not.toContain(c)
    }
  })

  it('AGENTS.md 도 같은 소비자 넷을 적는다(산문↔소스 교차 단언)', () => {
    const md = read(AGENTS)
    for (const c of CONSUMERS) expect(md).toContain(`\`${c}\``)
  })
})

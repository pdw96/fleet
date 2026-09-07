import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { scanCheckoutPersistCredentials } from './skills-lint.mjs'

// `.github/workflows/audit.yml` 의 안전장치를 정적 텍스트로 핀한다.
//
// 이 잡의 가치는 전부 **두 레그의 비대칭**에 있다 — 출하 트리는 fail-hard, dev/build 트리는
// advisory. 어느 쪽이든 조용히 뒤집히면 잡은 계속 green 인데 신호는 사라진다:
//   · 출하 레그가 advisory 가 되면 → 진짜 출하 사고(#243 js-yaml 류)가 무신호로 지나간다.
//   · 출하 레그에서 `--omit=dev` 가 빠지면 → dev 소음으로 상시 red → 방치 → 잡 제거로 귀결.
//   · advisory 레그가 fail-hard 가 되면 → 같은 소음 경로로 같은 결말.
// 어느 회귀도 **런 로그를 열어야만** 보이므로 코드보다 먼저(RED) 텍스트로 못박는다.
// deploy-cd-pin.test.ts·release-pipeline-gates.test.ts 동형. scripts/ 라 PR 마다 상시 실행되고
// (스케줄 잡 자체는 주 1회) coverage floor 에 무영향.

const yml = readFileSync(new URL('../.github/workflows/audit.yml', import.meta.url), 'utf8')

/**
 * `run:` 본문에 needle 을 포함하는 스텝 블록 하나를 반환한다. 스텝 경계는 YAML 리스트 아이템(`- `)
 * 과 들여쓰기로 자른다(scanCheckoutPersistCredentials 와 같은 규칙) — 블록 단위로 봐야
 * `continue-on-error` 가 **어느 스텝에 붙었는지**를 단언할 수 있다. 전문 grep 은 그걸 못 가른다.
 */
const stepContaining = (needle: string): string[] => {
  const lines = yml.split(/\r?\n/)
  const indentOf = (l: string) => /^\s*/.exec(l)![0].length
  const blocks: string[][] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)-\s/.exec(lines[i])
    if (!m) continue
    const base = m[1].length
    let end = i + 1
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > base)) end++
    blocks.push(lines.slice(i, end))
    i = end - 1
  }
  const hit = blocks.filter((b) => b.some((l) => l.includes(needle)))
  expect(hit, `run 본문에 '${needle}' 을 가진 스텝이 정확히 1개여야 한다`).toHaveLength(1)
  return hit[0]
}

describe('audit.yml — 개시 경로', () => {
  it('schedule + workflow_dispatch 양쪽으로 개시된다', () => {
    // dispatch 만 남으면 아무도 안 눌러 영구 미실행이 된다(= 잡이 없는 것과 같다).
    expect(yml).toMatch(/^on:$/m)
    expect(yml).toMatch(/^ {2}workflow_dispatch:$/m)
    expect(yml).toMatch(/^ {2}schedule:$/m)
    expect(yml).toMatch(/^ {4}- cron: '\d+ \d+ \* \* \d+'$/m)
  })

  it('cron 이 정시가 아니다(스케줄 지연·드롭 회피 — e2e.yml 과 같은 규율)', () => {
    const cron = /- cron: '(\d+) \d+ \* \* \d+'/.exec(yml)
    expect(cron).not.toBeNull()
    expect(Number(cron![1])).toBeGreaterThan(0)
  })
})

describe('audit.yml — 두 레그의 비대칭', () => {
  it('출하 레그는 --omit=dev 로 트리를 좁힌다(dev 소음으로 상시 red 가 되면 잡이 방치된다)', () => {
    const step = stepContaining('npm audit --omit=dev').join('\n')
    expect(step).toMatch(/npm audit --omit=dev --audit-level=high/)
  })

  it('출하 레그는 fail-hard 다 — continue-on-error 가 붙으면 안 된다', () => {
    // 이 한 줄이 이 워크플로 전체의 존재 이유다. 붙는 순간 잡은 영구 green 이 된다.
    const step = stepContaining('npm audit --omit=dev').join('\n')
    expect(step).not.toMatch(/continue-on-error/)
  })

  it('전체 트리 레그는 advisory 다 — continue-on-error 로 잡을 red 로 만들지 않는다', () => {
    const step = stepContaining('npm audit --audit-level=high 2>&1').join('\n')
    expect(step).toMatch(/continue-on-error: true/)
  })

  it('전체 트리 레그는 결과를 런 요약에 남긴다(green 이어도 열린 권고가 보이게)', () => {
    const step = stepContaining('npm audit --audit-level=high 2>&1').join('\n')
    expect(step).toMatch(/GITHUB_STEP_SUMMARY/)
    // pipefail 없이 tee 로 파이프하면 npm 의 종료코드가 삼켜져 advisory 신호 자체가 사라진다.
    expect(step).toMatch(/set -o pipefail/)
  })

  it('두 레그의 임계가 둘 다 명시돼 있다(--audit-level 누락 = 기본 low → 소음 폭증)', () => {
    const levels = yml.match(/--audit-level=\w+/g) ?? []
    expect(levels).toEqual(['--audit-level=high', '--audit-level=high'])
  })
})

describe('audit.yml — 최소권한·자격증명', () => {
  it('permissions 는 contents: read 뿐이다', () => {
    expect(yml).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(yml).not.toMatch(/\bwrite\b/)
  })

  it('checkout 이 자격증명을 잔류시키지 않는다', () => {
    expect(scanCheckoutPersistCredentials(yml)).toEqual([])
  })
})

describe('audit.yml — verify 침범 금지', () => {
  it('audit 이 npm run verify 체인에 들어가 있지 않다', () => {
    // audit 은 네트워크·시각 의존이라 verify 에 넣으면 「로컬 == CI」 불변식(AGENTS.md)이 깨지고,
    // 새 advisory 하나가 무관한 PR 전체를 red 로 만든다. 이 경계가 무너지면 여기서 RED.
    const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8') as string
    const verify = /"verify":\s*"([^"]+)"/.exec(pkg)
    expect(verify, 'package.json 에 verify 스크립트가 있어야 한다').not.toBeNull()
    expect(verify![1]).not.toMatch(/audit/)
  })
})

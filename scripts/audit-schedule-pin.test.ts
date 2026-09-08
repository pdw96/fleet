import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { scanCheckoutPersistCredentials, stepBlocks } from './skills-lint.mjs'

// `.github/workflows/audit.yml` 의 계약을 정적 텍스트로 핀한다.
//
// 이 잡은 **게이트가 아니라 advisory 센서**다. 그래서 지켜야 할 계약이 보통의 CI 잡과 반대다:
//   · 어떤 레그도 잡을 red 로 만들면 안 된다 — red 가 되는 순간(레지스트리 5xx·패치 없는 high)
//     방치되고, 방치된 잡은 제거된다.
//   · 그런데 **신호는 남아야 한다** — 그래서 `::warning::` 애노테이션과 런 요약이 계약의 일부다.
//     `|| true` 로 상태를 삼키면 잡은 여전히 green 인데 경고만 사라진다(무신호).
//   · 두 레그가 **둘 다** 돌아야 한다 — ①이 「실패」로 표시돼도 ②는 `!cancelled()` 로 살아남는다.
//
// 어느 회귀도 **런 로그를 열어야만** 보이므로 코드보다 먼저(RED) 못박는다.
// deploy-cd-pin.test.ts·release-pipeline-gates.test.ts 동형. scripts/ 라 PR 마다 상시 실행되고
// (스케줄 잡 자체는 주 1회) coverage floor 에 무영향.

const yml = readFileSync(new URL('../.github/workflows/audit.yml', import.meta.url), 'utf8')

/** 주석 전용 줄을 뺀 실행 줄만. 주석에 남은 옛 명령이 단언을 만족시키는 것을 막는다(#245 앵커 규율). */
const codeLines = (lines: string[]) => lines.filter((l) => !/^\s*#/.test(l))

/**
 * needle 을 **실행 줄에** 가진 스텝 블록 하나. 블록 분할은 `skills-lint.mjs` 의 공유 구현을 쓴다 —
 * 복제하면 「무엇이 안전인가」가 두 벌로 갈라진다(그 구현이 얕은 주석에서 블록을 끊던 결함도
 * 거기서 한 번에 고쳤다). 블록 단위여야 `continue-on-error` 가 **어느 스텝 것인지** 단언할 수 있다.
 */
const stepContaining = (needle: string): string[] => {
  const hit = stepBlocks(yml).filter((b: { lines: string[] }) =>
    codeLines(b.lines).some((l) => l.includes(needle)),
  )
  expect(hit, `실행 줄에 '${needle}' 을 가진 스텝이 정확히 1개여야 한다`).toHaveLength(1)
  return hit[0].lines
}

const RUNTIME = 'npm audit --omit=dev'
const FULL = 'npm audit --audit-level=high >'

describe('audit.yml — 개시 경로', () => {
  it('schedule + workflow_dispatch 양쪽으로 개시된다', () => {
    // dispatch 만 남으면 아무도 안 눌러 영구 미실행이 된다(= 잡이 없는 것과 같다).
    expect(yml).toMatch(/^ {2}workflow_dispatch:$/m)
    expect(yml).toMatch(/^ {2}schedule:$/m)
  })

  it('cron 이 월요일이고 정시가 아니다', () => {
    // 분 오프셋 = 스케줄 지연·드롭 회피(e2e.yml 과 같은 규율). 요일 = dependabot 주간 실행 뒤.
    const cron = /^ {4}- cron: '(\d+) (\d+) \* \* (\d+)'$/m.exec(yml)
    expect(cron, 'cron 이 5필드 리터럴이어야 한다').not.toBeNull()
    expect(Number(cron![1]), '분이 정시(0)면 혼잡 구간이다').toBeGreaterThan(0)
    expect(cron![3], '월요일(1) 고정 — dependabot 주간 실행 뒤에 놓는다는 근거에 종속').toBe('1')
  })

  it('진행 중인 런을 취소하지 않는다 — 취소는 red 가 아니라 무신호다', () => {
    // schedule 과 dispatch 는 둘 다 refs/heads/master 라 같은 그룹에 들어간다. 주 1회 센서에
    // cancel-in-progress: true 는 이득 없이 그 주의 신호를 통째로 날린다.
    expect(yml).toMatch(/^ {2}cancel-in-progress: false$/m)
  })
})

describe('audit.yml — 게이트가 아님(잡을 red 로 만들지 않는다)', () => {
  it('두 audit 레그가 모두 continue-on-error 다', () => {
    for (const needle of [RUNTIME, FULL]) {
      expect(stepContaining(needle).join('\n'), `${needle} 레그`).toMatch(
        /^\s*continue-on-error: true$/m,
      )
    }
  })

  it('continue-on-error 는 정확히 2개이고 둘 다 audit 스텝 소속이다', () => {
    // 잡 레벨 `continue-on-error`(들여쓰기 4)는 어느 스텝 블록에도 안 들어가므로 스텝 단언만으론
    // 못 잡는다. 전역 개수 + 소속을 함께 핀해야 「잡 전체를 관용으로 덮는」 회귀가 드러난다.
    const all = yml.match(/continue-on-error/g) ?? []
    expect(all).toHaveLength(2)
    const owned = [RUNTIME, FULL].filter((n) =>
      codeLines(stepContaining(n)).some((l) => l.includes('continue-on-error')),
    )
    expect(owned).toHaveLength(2)
  })
})

describe('audit.yml — 신호는 남는다', () => {
  it('두 레그 모두 -e 조기종료를 우회해 상태를 포획한다', () => {
    // 러너는 `shell: bash` 를 `bash --noprofile --norc -eo pipefail {0}` 로 부른다. -e 가 켜져 있어
    // 비0 명령에서 스크립트가 즉시 죽으므로, 뒤의 요약·경고가 죽은 코드가 된다. `|| status=$?` 는
    // || 문맥이라 -e 가 적용되지 않는다 — 이 형태가 아니면 실패 경로 전체가 사라진다.
    for (const needle of [RUNTIME, FULL]) {
      const step = stepContaining(needle).join('\n')
      expect(step, `${needle} 레그`).toMatch(/\|\| status=\$\?$/m)
      expect(step, `${needle} 레그`).toMatch(/^\s*shell: bash$/m)
    }
  })

  it('두 레그 모두 ::warning:: 애노테이션을 낸다', () => {
    // 잡이 green 이므로 실패 메일이 오지 않는다. 초록 런에서도 눈에 띄는 유일한 장치가 이 애노테이션이다.
    for (const needle of [RUNTIME, FULL]) {
      expect(stepContaining(needle).join('\n'), `${needle} 레그`).toMatch(/echo "::warning title=/)
    }
  })

  it('두 레그 모두 런 요약에 결과를 쓰고 1MiB 상한을 넘지 않게 자른다', () => {
    for (const needle of [RUNTIME, FULL]) {
      const step = stepContaining(needle).join('\n')
      expect(step, `${needle} 레그`).toMatch(/GITHUB_STEP_SUMMARY/)
      expect(step, `${needle} 레그`).toMatch(/head -c \d+/)
    }
  })

  it('상태를 삼키는 형태가 없다 — || true · exit 0 · set +e', () => {
    // 상태가 곧 경고 트리거다. 삼키면 잡은 여전히 green 인데 경고만 사라져 완전 무신호가 된다.
    for (const needle of [RUNTIME, FULL]) {
      const step = codeLines(stepContaining(needle)).join('\n')
      expect(step, `${needle} 레그`).not.toMatch(/\|\|\s*true\b/)
      expect(step, `${needle} 레그`).not.toMatch(/^\s*exit 0\s*$/m)
      expect(step, `${needle} 레그`).not.toMatch(/set \+e/)
    }
  })
})

describe('audit.yml — 두 레그가 모두 실행된다', () => {
  it('전체 트리 레그는 !cancelled() 로 살아남는다', () => {
    // 기본 상태검사는 success() 라, ① 이 「실패」로 표시되면 ②가 통째로 skip 된다 —
    // 정작 볼 게 많은 런에서 요약이 비는 역설.
    expect(stepContaining(FULL).join('\n')).toMatch(/^\s*if: \$\{\{ !cancelled\(\) \}\}$/m)
  })

  it('런타임 레그에는 조건부 skip 이 없다', () => {
    // `if:` 로 skip 되면 잡은 green 이고 신호는 사라진다(continue-on-error 밴만으론 못 막는 축).
    expect(codeLines(stepContaining(RUNTIME)).join('\n')).not.toMatch(/^\s*if:/m)
  })

  it('두 레그의 스코프가 서로 다르다 — 런타임 트리 1개 · 전체 트리 1개', () => {
    const omit = yml.match(/npm audit --omit=dev/g) ?? []
    expect(omit, 'run 과 주석을 합쳐도 --omit=dev 감사는 1회여야 한다').toHaveLength(1)
    const levels = yml.match(/--audit-level=high/g) ?? []
    expect(levels, '두 레그 모두 임계 명시(누락 시 기본 low → 경고 폭증)').toHaveLength(2)
  })
})

describe('audit.yml — 설치·권한', () => {
  it('설치 단계에서 중복 audit 을 끈다', () => {
    // npm ci 는 기본이 audit 이라 레지스트리 왕복이 하나 더 늘고, 설치 실패와 audit 실패가
    // 같은 red 로 뭉개진다. 아래 두 레그가 같은 일을 제대로 한다.
    expect(yml).toMatch(/^\s*run: npm ci --no-audit$/m)
  })

  it('permissions 는 contents: read 하나뿐이고 잡 레벨 재선언이 없다', () => {
    // 전파일 /write/ 스캔은 주석의 단어에도 걸리는 오탐이라 쓰지 않는다(deploy-cd-pin 의 결론).
    // top-level 블록만 잘라 allowlist 로 본다.
    const block = /^permissions:\n((?: {2}\S.*\n)+)/m.exec(yml)
    expect(block, 'top-level permissions 블록이 있어야 한다').not.toBeNull()
    expect(block![1].trimEnd().split('\n')).toEqual(['  contents: read'])
    expect(yml.match(/^permissions:$/gm) ?? [], '잡 레벨 permissions 재선언 금지').toHaveLength(1)
  })

  it('checkout 이 자격증명을 잔류시키지 않는다', () => {
    expect(scanCheckoutPersistCredentials(yml)).toEqual([])
  })
})

describe('audit.yml — verify 침범 금지', () => {
  it('audit 이 npm run verify 체인에 들어가 있지 않다', () => {
    // audit 은 네트워크·시각 의존이라 verify 에 넣으면 「로컬 == CI」 불변식(AGENTS.md)이 깨지고,
    // 새 advisory 하나가 무관한 PR 전체를 red 로 만든다. 이 경계가 무너지면 여기서 RED.
    const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const verify = /"verify":\s*"([^"]+)"/.exec(pkg)
    expect(verify, 'package.json 에 verify 스크립트가 있어야 한다').not.toBeNull()
    expect(verify![1]).not.toMatch(/audit/)
  })
})

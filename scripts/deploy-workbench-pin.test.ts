import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * #251 PR1c — 인스턴스 배타의 **배포 계약**과 킬스위치 배선 핀.
 *
 * **왜 verify 층인가**: `deploy/smoke.sh` 는 PR 게이트에서 한 번도 실행되지 않는다(유일 실행처 =
 * 머지 후 `.github/workflows/deploy.yml`). `e2e/web-server.ts` 도 vitest include 밖이다. 그래서 이 두
 * 파일의 계약은 **여기서만** PR 시점에 지켜진다(선례: `deploy-sandbox-boundary-pin.test.ts`).
 *
 * **왜 값 라인 exact 가 아니라 서비스 블록 스코프인가**(계획 정정 ㊼ · 실측): 파일 전체 평문 regex 는
 * 키가 `ttyd:` 블록으로 오배치돼도 GREEN 인데, 그 구성에서 `--scale fleet=2` 는 **EXIT 0** 으로 통과한다
 * = 계약이 실제로 소멸한 상태를 핀이 통과시킨다. 부분문자열 `fleet-server` 는 `image:` 값 때문에
 * **변경 전부터** 매치되므로 더 나쁘다(무신호).
 */

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

/** 최상위 서비스 블록 추출 — `smoke.sh:178` 의 awk 앵커와 같은 규칙(2-space 서비스 헤더). */
const serviceBlock = (yml: string, service: string): string => {
  const lines = yml.split(/\r?\n/)
  const start = lines.findIndex((l) => l === `  ${service}:`)
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^ {2}\S/.test(l) || /^\S/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

describe('배포 계약 — container_name 은 fleet 서비스에만, 리터럴로 고정(#251 §W-2-b)', () => {
  const compose = read('deploy/docker-compose.yml')

  it('canary: 서비스 블록 추출이 실제로 내용을 낸다(빈 블록이면 이하 단언이 vacuous)', () => {
    expect(serviceBlock(compose, 'fleet').length).toBeGreaterThan(200)
    expect(serviceBlock(compose, 'ttyd').length).toBeGreaterThan(200)
  })

  it('fleet 서비스 블록 안에 container_name 값이 exact 로 있다', () => {
    expect(serviceBlock(compose, 'fleet')).toMatch(/^ {4}container_name: fleet-server$/m)
  })

  it('ttyd 블록에는 없다(오배치하면 scale 거부가 사라진다 — 실측)', () => {
    expect(serviceBlock(compose, 'ttyd')).not.toMatch(/container_name/)
  })

  it('파일 전체에서 container_name 은 정확히 1개다', () => {
    expect(compose.match(/^ *container_name:/gm) ?? []).toHaveLength(1)
  })

  /**
   * 프로덕션 pull 경로는 **override 병합**이다. override 가 `container_name: !reset null` 을 넣으면
   * 병합 config 에서 키가 사라지고 `--scale fleet=2` 가 다시 통과하는데(실측), base 텍스트 핀만으로는
   * GREEN 이 유지된다. 그래서 override 쪽은 **0건**을 단언한다.
   */
  it('GHCR override 는 container_name·FLEET_WORKBENCH 를 건드리지 않는다(0건)', () => {
    const ghcr = read('deploy/docker-compose.ghcr.yml')
    expect(ghcr).not.toMatch(/container_name/)
    expect(ghcr).not.toMatch(/FLEET_WORKBENCH/)
  })
})

describe('배포 계약 — smoke.sh 가 그 키를 실제로 검사한다', () => {
  const smoke = read('deploy/smoke.sh')

  it('base 블록·override 블록 양쪽에 검사가 있다', () => {
    expect(smoke).toMatch(/FLEET_BLOCK.*container_name: fleet-server/)
    expect(smoke).toMatch(/GHCR_FLEET.*container_name: fleet-server/)
  })

  it('ttyd 음성 단언도 있다(키 오배치 탐지)', () => {
    expect(smoke).toMatch(/TTYD_BLOCK.*container_name/)
  })

  /**
   * **패턴 오타는 「검사 블록 존재」 단언으로는 무신호다.** smoke 가 grep 하는 리터럴을 뽑아내
   * compose 원문에 실제로 매치되는지 교차 확인한다(계획 정정 ㊽).
   */
  it('smoke 의 grep 패턴이 compose 텍스트에 실제로 매치된다(교차 단언)', () => {
    const patterns = [...smoke.matchAll(/grep -q '(container_name[^']*)'/g)].map((m) => m[1])
    expect(patterns.length).toBeGreaterThanOrEqual(2)
    const compose = read('deploy/docker-compose.yml')
    for (const p of patterns) {
      if (p === 'container_name') continue // ttyd 음성 단언용(값 없는 키 패턴)
      expect(compose).toContain(p)
    }
  })

  /** 행동 검증(§3-T8e)이 3층(거부·양성 통제·음성 통제)으로 실재하는지. 하나라도 빠지면 vacuous 다. */
  it('--scale 거부 행동 검사가 3층으로 있다', () => {
    expect(smoke).toMatch(/--scale fleet=2/)
    expect(smoke).toMatch(/--scale fleet=1/)
    expect(smoke).toMatch(/container_name: !reset null/)
    // `--profile tunnel` 없이 돌리면 fleet 이 비활성이라 무조건 exit 1 = vacuous GREEN.
    expect(smoke).toMatch(/COMPOSE=\(docker compose[^)]*--profile tunnel\)/)
  })

  /**
   * 세 검사가 **같은 구성**을 본다는 것이 3층 판정의 전제다 — 음성 통제만 compose 명령줄을 손으로
   * 재작성하면 그 전제가 텍스트 중복으로만 유지된다(자체 적대 리뷰 R5-6).
   */
  /** 주석·로그 문면에도 같은 문자열이 등장하므로 **실제 실행 라인**만 센다. */
  const dryRunLines = (): string[] =>
    smoke.split(/\r?\n/).filter((l) => l.includes('up --dry-run') && !l.trimStart().startsWith('#'))

  it('세 검사가 모두 같은 COMPOSE 배열을 재사용한다', () => {
    expect(dryRunLines()).toHaveLength(3)
    for (const l of dryRunLines()) expect(l).toContain('COMPOSE[@]')
  })

  /**
   * `up --dry-run` 을 프로파일 전체에 걸면 smoke 가 빌드도 pull 도 하지 않는 `cloudflared` 이미지의
   * 레지스트리 해석에 의존해, 그 실패가 scale 검증보다 먼저 나서 거짓 PASS 가 된다(R5-1).
   * 그리고 exit≠0 단독 판정은 무관한 실패도 「거부」로 읽으므로 거부 **메시지**를 함께 요구해야 한다.
   */
  it('행동 검사는 fleet 서비스로 스코프되고 거부 사유 문자열까지 본다', () => {
    for (const l of dryRunLines()) expect(l).toMatch(/--scale fleet=[12] fleet\b/)
    expect(smoke).toContain('Remove the custom name to scale')
  })
})

describe('킬스위치 배선 — FLEET_WORKBENCH(#251)', () => {
  it('compose fleet 서비스가 기본 0 으로 명시 전달한다', () => {
    expect(serviceBlock(read('deploy/docker-compose.yml'), 'fleet')).toMatch(
      /^ {6}FLEET_WORKBENCH: \$\{FLEET_WORKBENCH:-0\}$/m,
    )
  })

  it('.env.example 의 운영자 기본값 라인이 0 으로 핀된다(값 드리프트도 RED)', () => {
    expect(read('deploy/.env.example')).toMatch(/^FLEET_WORKBENCH=0\s*$/m)
  })

  it('README 가 이 값을 문서화한다', () => {
    expect(read('deploy/README.md')).toMatch(/FLEET_WORKBENCH/)
  })

  /** 프로덕션 경로는 override 병합이다 — base 만 검사하면 병합 config 에서 사라져도 무신호다(R5-5). */
  it('smoke 가 override 병합 config 에서도 킬스위치를 확인한다', () => {
    expect(read('deploy/smoke.sh')).toMatch(/GHCR_FLEET.*FLEET_WORKBENCH:/)
  })
})

/**
 * e2e 스폰 env 는 `...process.env` 로 호스트 셸을 상속한다 — 개발자·CI 에 `FLEET_WORKBENCH=1` 이
 * export 돼 있으면 「미설정 무회귀」 스위트가 실제로는 활성 상태를 검증한다. 그 명시 오버라이드가
 * **삭제·재정렬돼도 e2e 는 PR 게이트에서 돌지 않아** 전 게이트 무신호이므로 여기서 핀한다.
 */
describe('e2e 스폰 env 오버라이드 — 개수·위치(#251 이월 ⑫)', () => {
  // ⚠ **주석을 먼저 제거한다**(형제 관용구 `boot-workbench.test.ts:79-82`). 이 파일의 계약 주석 자체가
  // `...process.env` 를 인용하므로, 원문으로 세면 스프레드가 2가 아니라 4로 잡혀 단언이 무의미해진다.
  const src = read('e2e/web-server.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('명시 오버라이드 수가 process.env 스프레드 수와 같다(호출 부위 수 == 매칭 수)', () => {
    const spreads = src.match(/\.\.\.process\.env/g) ?? []
    const overrides = src.match(/^\s*FLEET_WORKBENCH: '0',$/gm) ?? []
    expect(spreads).toHaveLength(2)
    expect(overrides).toHaveLength(spreads.length)
  })

  it('오버라이드가 ...extraEnv 보다 앞에 온다(뒤면 테스트가 켤 수 없다)', () => {
    for (const block of src.split('env: {').slice(1)) {
      const own = block.indexOf("FLEET_WORKBENCH: '0'")
      const spread = block.indexOf('...extraEnv')
      expect(own).toBeGreaterThanOrEqual(0)
      expect(spread).toBeGreaterThan(own)
    }
  })

  /**
   * 키 문자열은 `src/server/boot.ts` 의 상수와 같아야 한다. e2e 는 `src/` 를 import 하지 않으므로
   * (Playwright 하니스에 서버 전 그래프가 적재된다) **텍스트 교차 단언**으로 오타를 닫는다.
   */
  it('키 문자열이 boot.ts 의 상수값과 일치한다', () => {
    const declared = /export const FLEET_WORKBENCH_ENV = '([^']+)'/.exec(read('src/server/boot.ts'))
    expect(declared?.[1]).toBeDefined()
    expect(src).toContain(`${declared?.[1]}: '0',`)
  })
})

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { bootServer, FLEET_WORKBENCH_ENV, resolveWorkbenchEnabled } from './boot'

/**
 * Workbench 킬스위치(#251 PR0 · 스펙 §W-1 「킬스위치 명시」).
 *
 * 롤백이 코드 revert 가 아니라 **런타임 스위치 1개**여야 하므로, 어떤 Workbench 코드보다 먼저 착지한다.
 * PR0 시점의 소비자는 부팅 검증·경고뿐이다(기능 자체가 아직 없음 — PR1+ 가 소비).
 *
 * **관용구 선택 근거(레포에 5종이 공존한다)**:
 *   ① 운영자 env · 열거형 · 미지값 throw     — `resolveSandboxBoundary`(boot.ts)
 *   ② 운영자 env · 수치 · 범위 밖 throw       — `resolveDrainTimeoutMs`·`resolveApprovalTtlMs`
 *   ③ 테스트/모드 env · strict '1' · 조용한 비활성 — `isE2EActive`(main/e2e.ts)
 *   ④ 테스트/모드 env · 열거형 · 미지값 **fail-safe 기본** — `resolveE2eRunner`(main/e2e.ts)
 *   ⑤ 시크릿 · 파싱 실패 → 기능 강등 + 부팅 warn — `createEnvKeyCrypto`
 * `FLEET_WORKBENCH` 는 **운영자 env**(배포자가 compose/.env 로 켠다)이므로 ①을 따른다. ③/④ 를 따르면
 * `FLEET_WORKBENCH=true` 오타가 조용히 비활성으로 떨어져 «켰는데 안 켜짐» 을 운영자가 못 본다.
 *
 * ⚠ `NodeJS.ProcessEnv` 는 인덱스 시그니처(`[k: string]: string | undefined`)라 **키 오타가 컴파일된다**
 * — `{ FLEET_WORKBECH: '1' }` 도 통과해 «미설정=false» 단언이 vacuous GREEN 이 된다. 그래서 env 이름을
 * `FLEET_WORKBENCH_ENV` 로 export 하고 이 테스트가 그 상수만 쓴다(리터럴 재입력 금지).
 */
describe('resolveWorkbenchEnabled — 킬스위치 파싱(운영자 env · fail-fast)', () => {
  it('env 이름 상수는 실제 키와 일치한다(오타 무신호 차단의 앵커)', () => {
    expect(FLEET_WORKBENCH_ENV).toBe('FLEET_WORKBENCH')
  })

  it.each([undefined, '', '   '])('미설정/공백(%p) = 비활성 — 기본 롤백 상태', (v) => {
    expect(resolveWorkbenchEnabled({ [FLEET_WORKBENCH_ENV]: v })).toBe(false)
  })

  it('키 자체가 없어도 비활성', () => {
    expect(resolveWorkbenchEnabled({})).toBe(false)
  })

  it("'1' = 활성(유일한 활성 값)", () => {
    expect(resolveWorkbenchEnabled({ [FLEET_WORKBENCH_ENV]: '1' })).toBe(true)
    expect(resolveWorkbenchEnabled({ [FLEET_WORKBENCH_ENV]: ' 1 ' })).toBe(true)
  })

  it("'0' = 명시 비활성(오설정이 아니라 명시 off 이므로 throw 하지 않는다)", () => {
    expect(resolveWorkbenchEnabled({ [FLEET_WORKBENCH_ENV]: '0' })).toBe(false)
  })

  // 반증력: ③/④ 관용구(조용한 fail-safe)로 구현하면 이 케이스 전부가 RED 다.
  it.each(['true', 'yes', 'on', 'ON', 'enabled', 'True', '2', '-1', 'workbench'])(
    '미지값(%s) = 부팅 거부 — 조용한 비활성 강등 금지',
    (v) => {
      expect(() => resolveWorkbenchEnabled({ [FLEET_WORKBENCH_ENV]: v })).toThrow(/FLEET_WORKBENCH/)
    },
  )

  it('throw 메시지에 수신 원문을 싣는다(운영자가 오타를 즉시 본다)', () => {
    expect(() => resolveWorkbenchEnabled({ [FLEET_WORKBENCH_ENV]: 'true' })).toThrow(/true/)
  })
})

/**
 * **호출부 커버리지** — 순수 함수 단위 테스트만 두면 `bootServer` 의 호출 한 줄을 삭제해도 전 게이트가
 * 무신호다(자체 적대 리뷰 실측: 삭제 후 vitest·typecheck·eslint 전부 GREEN). 형제 선례
 * `resolveSandboxBoundary fail-fast`(boot.test.ts)는 이 통합 단언을 갖고 있으므로 동형으로 이식한다.
 */
describe('킬스위치 fail-fast — 부수효과 이전 부팅 거부(호출부 커버리지)', () => {
  it('미지값 → 부팅 거부 + dataDir 미생성(mkdirSync 이전 throw)', async () => {
    // 중첩 미존재 경로 — throw 가 mkdirSync 보다 앞서면 이 경로가 만들어지지 않는다.
    const dataDir = join(mkdtempSync(join(tmpdir(), 'fleet-251-')), 'sub', 'data')
    await expect(
      bootServer({ [FLEET_WORKBENCH_ENV]: 'true', FLEET_DATA_DIR: dataDir, FLEET_PORT: '0' }),
    ).rejects.toThrow(/FLEET_WORKBENCH/)
    expect(statSync(dataDir, { throwIfNoEntry: false })).toBeUndefined()
  })
})

/** 블록/라인 주석 제거 — 주석에 박힌 예시가 라이브 배선으로 오인되는 것 방지(`://` URL 보존 · ipc-parity 선례). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 디렉터리 아래 `.ts`/`.tsx` 를 재귀 수집(테스트 파일 제외 — 계약은 프로덕션 코드에 대한 것). */
function sourceFiles(rel: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
    }
  }
  walk(join(SRC_ROOT, rel))
  return out
}

/**
 * T8f — **서버 전용 범위 일관성**(스펙 §3-T8f · Codex 승인 조건 ⑥).
 * Workbench 는 서버(컨테이너) 표면 전용이다(2026-07-23 범위 축소 · 데스크톱은 #255).
 * 데스크톱 Electron 이 `FLEET_WORKBENCH=1` 만으로 우회 활성화되지 않음을 **구조**로 단언한다.
 *
 * 단일 파일(`main/index.ts`)만 보면 간접 모듈이 킬스위치를 읽어도 통과하므로 **데스크톱이 도달하는 전
 * 소스 트리**를 스캔한다. `src/main/core/**` 도 포함하는 것이 핵심이다 — 코어는 서버와 **공유**되므로
 * 거기서 env 를 읽으면 데스크톱까지 함께 켜진다(레포 규율: 코어는 env 를 읽지 않고 해소된 값만 주입받는다).
 *
 * 텍스트 스캔인 이유: `src/main/index.ts` 는 top-level `app.whenReady()` 와 미모킹 `electron` import
 * 때문에 테스트에서 import 할 수 없다(레포 전체 `vi.mock('electron')` 0건 · index.test.ts 부재).
 * 형제 선례 = `ipc-parity.test.ts`·`bridge-parity.test.ts` 도 같은 이유로 소스를 텍스트로 읽는다.
 */
describe('T8f — Workbench 는 서버 표면 전용(데스크톱 우회 활성화 부재)', () => {
  const desktopFiles = [
    ...sourceFiles('main'),
    ...sourceFiles('preload'),
    ...sourceFiles('renderer'),
  ]
  const bootSrc = stripComments(readFileSync(join(SRC_ROOT, 'server/boot.ts'), 'utf8'))

  it('스캔 대상이 실재한다(파일 0개면 아래 단언이 vacuous)', () => {
    expect(desktopFiles.length).toBeGreaterThan(20)
  })

  it.each([FLEET_WORKBENCH_ENV, 'resolveWorkbenchEnabled'])(
    '데스크톱이 도달하는 전 소스(main·preload·renderer · 코어 포함)에 %s 참조가 0건',
    (needle) => {
      const hits = desktopFiles.filter((f) =>
        stripComments(readFileSync(f, 'utf8')).includes(needle),
      )
      expect(hits.map((f) => f.slice(SRC_ROOT.length))).toEqual([])
    },
  )

  // 앵커: 스캔 대상 문자열이 서버 쪽엔 **실재**함을 먼저 확인한다. 없으면 위 단언은 「이름을 바꿨을
  // 뿐인데 GREEN」인 vacuous 통과가 된다(bridge-parity 의 0건 매칭 함정 · #197 B2).
  it.each([FLEET_WORKBENCH_ENV, 'resolveWorkbenchEnabled'])(
    '서버 boot 에는 %s 가 실재한다(스캔 앵커)',
    (needle) => {
      expect(bootSrc).toContain(needle)
    },
  )
})

/**
 * R-2 대칭 — `workspace:set` 의 「런 진행 중 거부」 판정이 **IPC·WS 양면에서 같은 술어**를 쓴다.
 *
 * 이 배선은 어느 층에서도 타입 신호가 없다(실측): `set-workspace.ts` 의 `isRunActive(): boolean` 은
 * boolean 이라 `RunActivity` 와 결속이 없고, 그 유일한 단위 테스트(`set-workspace.test.ts`)는
 * `isRunActive: () => false` 상수 더블이라 판정식이 무엇이든 GREEN 이다. 한쪽 면만 고치면 데스크톱과
 * 웹의 잠금 의미가 조용히 갈린다(무회귀 체크리스트 7).
 *
 * **주석 제거 + 「호출 부위 수 == 매칭 수」 가드**가 둘 다 필요하다(ipc-parity 선례):
 * 전자가 없으면 주석 한 줄로 false-GREEN/false-RED 가 나고, 후자가 없으면 **3번째 호출부**가 다른
 * 술어로 추가돼도 무신호다(둘 다 자체 적대 리뷰에서 실제 변이로 재현됐다).
 */
describe('R-2 대칭 — workspace:set 레거시 판정은 양면 모두 hasLegacyRun', () => {
  const SURFACES = [
    ['main/index.ts(IPC)', 'main/index.ts'],
    ['server/handlers.ts(WS)', 'server/handlers.ts'],
  ] as const
  const read = (rel: string): string => stripComments(readFileSync(join(SRC_ROOT, rel), 'utf8'))

  const CALLSITE = /isRunActive:/g
  const CORRECT = /isRunActive:\s*\(\)\s*=>\s*hasLegacyRun\(/g

  it.each(SURFACES)('%s 의 isRunActive 호출부가 **전부** hasLegacyRun 이다', (_label, rel) => {
    const src = read(rel)
    const callsites = [...src.matchAll(CALLSITE)].length
    expect(callsites).toBeGreaterThan(0) // 앵커 — 0건이면 아래 동치는 vacuous
    expect([...src.matchAll(CORRECT)].length).toBe(callsites)
  })

  it.each(SURFACES)(
    '%s 에 구 판정식(activeProjectIds.length > 0)이 남아 있지 않다',
    (_label, rel) => {
      expect(read(rel)).not.toMatch(/activeProjectIds\.length\s*>\s*0/)
    },
  )
})

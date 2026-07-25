import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { FLEET_WORKBENCH_ENV, resolveWorkbenchEnabled } from './boot'

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
 * T8f — **서버 전용 범위 일관성**(스펙 §3-T8f · Codex 승인 조건 ⑥).
 * Workbench 는 서버(컨테이너) 표면 전용이다(2026-07-23 범위 축소 · 데스크톱은 #255).
 * 데스크톱 Electron 이 `FLEET_WORKBENCH=1` 만으로 우회 활성화되지 않음을 **구조**로 단언한다.
 *
 * 텍스트 스캔인 이유: `src/main/index.ts` 는 top-level `app.whenReady()` 와 미모킹 `electron` import
 * 때문에 테스트에서 import 할 수 없다(레포 전체 `vi.mock('electron')` 0건 · index.test.ts 부재).
 * 형제 선례 = `ipc-parity.test.ts`·`bridge-parity.test.ts` 도 같은 이유로 소스를 텍스트로 읽는다.
 */
describe('T8f — Workbench 는 서버 표면 전용(데스크톱 우회 활성화 부재)', () => {
  const mainSrc = readFileSync(new URL('../main/index.ts', import.meta.url), 'utf8')
  const bootSrc = readFileSync(new URL('./boot.ts', import.meta.url), 'utf8')

  it('데스크톱 진입점은 FLEET_WORKBENCH 를 읽지 않는다', () => {
    expect(mainSrc).not.toContain(FLEET_WORKBENCH_ENV)
  })

  // 앵커 단언: 스캔 대상 문자열이 서버 쪽엔 **실재**함을 먼저 확인한다. 없으면 위 not.toContain 은
  // 「이름을 바꿨을 뿐인데 GREEN」인 vacuous 통과가 된다(bridge-parity 의 0건 매칭 함정 · #197 B2).
  it('서버 진입점은 FLEET_WORKBENCH 를 읽는다(스캔 앵커)', () => {
    expect(bootSrc).toContain(FLEET_WORKBENCH_ENV)
  })

  it('킬스위치 해소는 서버 boot 에만 존재한다(데스크톱은 resolveWorkbenchEnabled 미호출)', () => {
    expect(mainSrc).not.toContain('resolveWorkbenchEnabled')
    expect(bootSrc).toContain('resolveWorkbenchEnabled')
  })
})

/**
 * R-2 대칭 — `workspace:set` 의 「런 진행 중 거부」 판정이 **IPC·WS 양면에서 같은 술어**를 쓴다.
 *
 * 이 배선은 어느 층에서도 타입 신호가 없다(실측): `set-workspace.ts` 의 `isRunActive(): boolean` 은
 * boolean 이라 `RunActivity` 와 결속이 없고, 그 유일한 단위 테스트(`set-workspace.test.ts:13`)는
 * `isRunActive: () => false` 상수 더블이라 판정식이 무엇이든 GREEN 이다. 한쪽 면만 고치면 데스크톱과
 * 웹의 잠금 의미가 조용히 갈린다(무회귀 체크리스트 7).
 */
describe('R-2 대칭 — workspace:set 레거시 판정은 양면 모두 hasLegacyRun', () => {
  const mainSrc = readFileSync(new URL('../main/index.ts', import.meta.url), 'utf8')
  const handlersSrc = readFileSync(new URL('./handlers.ts', import.meta.url), 'utf8')

  it.each([
    ['main/index.ts(IPC)', () => mainSrc],
    ['handlers.ts(WS)', () => handlersSrc],
  ])('%s 는 hasLegacyRun 으로 판정한다', (_label, get) => {
    expect(get()).toMatch(/isRunActive:\s*\(\)\s*=>\s*hasLegacyRun\(/)
  })

  it.each([
    ['main/index.ts(IPC)', () => mainSrc],
    ['handlers.ts(WS)', () => handlersSrc],
  ])('%s 에 구 판정식(activeProjectIds.length > 0)이 남아 있지 않다', (_label, get) => {
    expect(get()).not.toMatch(/activeProjectIds\.length\s*>\s*0/)
  })
})

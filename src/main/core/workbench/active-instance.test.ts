import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACTIVE_INSTANCE_FILE,
  claimActiveInstance,
  decideReclaim,
  type ClaimOptions,
  type InstanceClaim,
} from './active-instance'
import type { InstanceMarkerSource } from './instance-marker'
import { endpointFor, type LockBackend } from './locks'
import { newUlid } from './ulid'
import { createFakeLockBackend, type FakeNamespace } from './__testing__/lock-backend-fake'

/**
 * #251 PR1c T5 — 인스턴스 배타(§W-2-b · §3-T8b·T8c).
 *
 * **획득 순서가 계약이다**(계획 정정 ㊳): 커널 endpoint `bind` 가 **먼저**고, 성공했을 때만 파일을 만진다.
 * 뒤집으면 승자가 bind 하기 전 창에서 패자 probe 가 성공해 같은 컨테이너 안에서 이중 인스턴스가 성립한다.
 * 그 순서 덕분에 스펙의 4분기가 다음으로 재사상된다:
 *   ⓐ bind = in-use            → `instance-active`(파일 미접촉 · 마커를 읽지도 않는다)
 *   ⓑ bind 성공 + 마커 일치     → 회수(**커널 증명** — 같은 PID ns 의 소유자가 죽었음을 커널이 보장)
 *   ⓒ bind 성공 + 마커 불일치   → 회수(**배포 전제 의존** — 단일 컨테이너 계약이 근거 · 증거 등급을 값으로 구분)
 *   ⓓ 해제                     → `ReleaseOutcome`
 *   ⓔ 비정규·판독불가·손상      → `reconciliation-required`(**자동 삭제 금지**)
 *
 * 백엔드·마커는 전부 주입 seam 이라 이 파일은 **양 OS 에서 전량 실행**된다(§3.1 대응 ⓐ).
 */

const IS_POSIX = process.platform !== 'win32'
/**
 * 쓰기 거부를 `chmod` 로 **주입할 수 있는가**. root(uid 0)는 mode 비트를 우회하므로 `0o500` 을 걸어도
 * 쓰기가 성공해 「실패 주입」 자체가 성립하지 않는다 — 컨테이너·CI 이미지가 root 로 도는 경우가 흔해
 * 그대로 두면 **레포와 무관한 RED** 가 난다(2026-08-24 실측: root 컨테이너에서 이 파일 2건 + coord-area
 * 1건 실패). 조용히 통과시키지 않고 `runIf` 로 **가시적 skip** 처리한다 — 같은 계열 선례는
 * `workspace/ignored-baseline.test.ts` 의 root 조기 반환이다.
 */
const CAN_DENY_WRITE = IS_POSIX && process.getuid?.() !== 0
const DIGEST = 'c'.repeat(32)
const MARKER_A = 'a'.repeat(64)
const MARKER_B = 'b'.repeat(64)

const instanceEndpoint = (): string => {
  const r = endpointFor(DIGEST, { kind: 'instance' })
  if (r.status !== 'ok') throw new Error('인스턴스 endpoint 유도 실패 — 테스트 전제 붕괴')
  return r.endpoint
}

const markerSource = (marker: string): InstanceMarkerSource => ({
  read: () => ({ status: 'ok', marker }),
})

let root: string
let ns: FakeNamespace

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-ai-'))
  ns = new Map()
})
afterEach(() => {
  // 0500 으로 잠근 디렉터리가 남을 수 있어 정리 전에 권한을 되돌린다.
  if (IS_POSIX) {
    try {
      chmodSync(root, 0o700)
    } catch {
      /* 이미 지워졌거나 원래 정상 */
    }
  }
  rmSync(root, { recursive: true, force: true })
})

const recordPath = (): string => join(root, ACTIVE_INSTANCE_FILE)
const readRecord = (): Record<string, unknown> =>
  JSON.parse(readFileSync(recordPath(), 'utf8')) as Record<string, unknown>

const claim = (
  opts: Omit<Partial<ClaimOptions>, 'marker'> & {
    marker?: string
    namespace?: FakeNamespace
  } = {},
): Promise<InstanceClaim> =>
  claimActiveInstance({
    areaRoot: root,
    digest: DIGEST,
    backend: opts.backend ?? createFakeLockBackend(opts.namespace ?? ns),
    marker: opts.marker !== undefined ? markerSource(opts.marker) : markerSource(MARKER_A),
    instanceId: opts.instanceId ?? newUlid(),
    now: opts.now,
  })

/** 「죽은 인스턴스가 남긴 잔재」 — 파일만 있고 endpoint 는 비어 있는 상태. */
const seedStale = (marker: string, instanceId = newUlid()): void => {
  writeFileSync(
    recordPath(),
    `${JSON.stringify({ engineInstanceId: instanceId, instanceMarker: marker, acquiredAt: 1 })}\n`,
  )
}

describe('최초 점유 — 빈 영역', () => {
  it('claimed 를 반환하고 레코드를 발행한다', async () => {
    const id = newUlid()
    const got = await claim({ instanceId: id, now: () => 1_700_000_000_000 })
    expect(got.status).toBe('claimed')
    expect(readRecord()).toEqual({
      engineInstanceId: id,
      instanceMarker: MARKER_A,
      acquiredAt: 1_700_000_000_000,
    })
    // 공개 표면 — 상수를 돌려주는 구현이 통과하지 않도록 핸들의 세 값을 함께 고정한다(R4-7).
    if (got.status !== 'claimed') return
    expect(got.handle.marker).toBe(MARKER_A)
    expect(got.handle.evidence).toBe('first-claim')
    expect(got.handle.isHeld()).toBe(true)
  })

  /** 레코드는 소유자만 읽고 쓴다(0700 영역 안의 심층 방어 · R4-5). */
  it.runIf(IS_POSIX)('발행된 레코드는 0600 이다', async () => {
    await claim()
    expect(statSync(recordPath()).mode & 0o777).toBe(0o600)
  })

  it('발행 후 영역 루트에는 레코드만 남는다(tmp 잔재 0 — 발행은 tmp+link 다)', async () => {
    await claim()
    expect(readdirSync(root)).toEqual([ACTIVE_INSTANCE_FILE])
  })

  /**
   * §3-T8b 조작화(계획 정정 ㊳). 「패자는 `listen()` 0」을 문면대로 세면 ⓐ의 생존 probe 와 충돌하므로,
   * **락 키(`r`·bench·slot) bind 0건 ∧ 인스턴스 키 bind 정확히 1건**으로 조작화한다.
   */
  it('bind 는 인스턴스 키에 정확히 1회 — 락 키는 건드리지 않는다', async () => {
    const backend = createFakeLockBackend(ns)
    await claim({ backend })
    const binds = backend.calls.filter((c) => c.op === 'bind')
    expect(binds).toEqual([{ op: 'bind', endpoint: instanceEndpoint() }])
  })
})

/**
 * **획득 순서를 관측 가능하게 만든다**(자체 적대 리뷰 R4-1). 결과만 보면 「발행 먼저 → bind 나중」 구현도
 * 전 스위트를 통과한다 — 그 구현은 패자가 코디네이션 영역에 tmp 를 쓰고, 영역 쓰기 불가일 때
 * `instance-active` 대신 `io-failure` 로 오진단한다. bind 호출 **시점의 영역 스냅샷**을 보면 순서가 값이 된다.
 */
describe('획득 순서 — bind 가 파일 접근보다 앞선다', () => {
  const withBindSnapshot = (inner: LockBackend, seen: string[][]): LockBackend => ({
    kind: inner.kind,
    bind: (endpoint) => {
      seen.push(readdirSync(root))
      return inner.bind(endpoint)
    },
  })

  it('bind 시점에 영역은 아직 사전 상태다(발행 먼저 구현이면 RED)', async () => {
    const seen: string[][] = []
    const got = await claim({ backend: withBindSnapshot(createFakeLockBackend(ns), seen) })
    expect(got.status).toBe('claimed')
    expect(seen).toEqual([[]])
  })

  it('잔재가 있어도 bind 시점 영역은 손대지 않은 상태다', async () => {
    seedStale(MARKER_B)
    const seen: string[][] = []
    await claim({ backend: withBindSnapshot(createFakeLockBackend(ns), seen) })
    expect(seen).toEqual([[ACTIVE_INSTANCE_FILE]])
  })

  it('점유된 endpoint 면 영역을 끝까지 건드리지 않는다', async () => {
    const backend = createFakeLockBackend(ns)
    backend.occupy(instanceEndpoint())
    const seen: string[][] = []
    const got = await claim({ backend: withBindSnapshot(backend, seen) })
    expect(got.status === 'blocked' && got.reason).toBe('instance-active')
    expect(seen).toEqual([[]])
    expect(readdirSync(root)).toEqual([])
  })
})

describe('ⓐ 살아있는 인스턴스 — endpoint 점유 중', () => {
  it('두 번째 획득은 instance-active 이고 파일을 건드리지 않는다', async () => {
    const first = await claim({ instanceId: newUlid() })
    expect(first.status).toBe('claimed')
    const before = readFileSync(recordPath(), 'utf8')

    const second = await claim({ instanceId: newUlid(), marker: MARKER_B })
    expect(second).toEqual({
      status: 'blocked',
      reason: 'instance-active',
      detail: expect.any(String),
    })
    expect(readFileSync(recordPath(), 'utf8')).toBe(before)
    expect(readdirSync(root)).toEqual([ACTIVE_INSTANCE_FILE])
  })

  /**
   * L-1: 연령은 판정 근거가 아니다. 아주 오래된 `acquiredAt` 이어도 endpoint 가 살아 있으면 회수하지
   * 않는다 — 「오래됐으면 회수」 한 줄이 여기서 RED 가 된다.
   */
  it('acquiredAt 이 아무리 오래돼도 살아있는 소유자를 회수하지 않는다', async () => {
    await claim()
    writeFileSync(
      recordPath(),
      `${JSON.stringify({ engineInstanceId: 'x', instanceMarker: MARKER_A, acquiredAt: 0 })}\n`,
    )
    const second = await claim({ marker: MARKER_A })
    expect(second.status === 'blocked' && second.reason).toBe('instance-active')
  })

  /**
   * **전제 판정이 경합 판정보다 앞선다.** 마커를 유도할 수 없는 표면은 살아있는 인스턴스가 있든 없든
   * Workbench 에 참여할 수 없으므로, 그때 `instance-active`(= 「기다리면 된다」)를 답하면 운영자가
   * 고칠 대상을 오인한다. 마커 유도는 **부수효과가 0**(읽기뿐)이라 이 순서가 승인 조건 ①과도 무충돌이다.
   * ㊳의 순서 계약이 구속하는 것은 「bind 가 **파일 접근**보다 앞선다」이다.
   */
  it('마커 유도 불가가 instance-active 보다 우선한다(고칠 대상을 오인하지 않는다)', async () => {
    await claim()
    const got = await claimActiveInstance({
      areaRoot: root,
      digest: DIGEST,
      backend: createFakeLockBackend(ns),
      marker: { read: () => ({ status: 'unavailable', detail: '유도 불가' }) },
      instanceId: newUlid(),
    })
    expect(got.status === 'blocked' && got.reason).toBe('marker-unavailable')
  })

  /** §3-T8c 「영구 고착 경로 부재」의 관측형(계획 정정 ㊺): 영원히 점유된 이름에서도 **턴 0 에** 답한다. */
  it('영원히 in-use 인 endpoint 에서도 hang 없이 즉시 blocked 를 반환한다', async () => {
    const backend = createFakeLockBackend(ns)
    backend.occupy(instanceEndpoint())
    vi.useFakeTimers()
    try {
      const got = await claim({ backend })
      expect(got.status === 'blocked' && got.reason).toBe('instance-active')
      expect(vi.getTimerCount()).toBe(0)
      expect(backend.calls.filter((c) => c.op === 'bind')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ⓑⓒ 잔재 회수 — endpoint 는 비었고 레코드만 남음', () => {
  it('마커 일치면 회수하고 증거를 kernel-proven 으로 기록한다', async () => {
    seedStale(MARKER_A)
    const id = newUlid()
    const got = await claim({ instanceId: id, marker: MARKER_A })
    expect(got.status).toBe('claimed')
    expect(got.status === 'claimed' && got.handle.evidence).toBe('kernel-proven')
    expect(readRecord()['engineInstanceId']).toBe(id)
  })

  it('마커 불일치면 회수하되 증거는 deployment-premise 다(커널이 보증하지 않는다)', async () => {
    seedStale(MARKER_B)
    const got = await claim({ marker: MARKER_A })
    expect(got.status === 'claimed' && got.handle.evidence).toBe('deployment-premise')
  })

  it('회수 후에도 루트에는 레코드만 남는다(tmp 잔재 0)', async () => {
    seedStale(MARKER_B)
    await claim()
    expect(readdirSync(root)).toEqual([ACTIVE_INSTANCE_FILE])
  })

  /**
   * **회수는 create-only 여야 한다**(계획 정정 ㊴ · 실측: `link` 는 기존 이름에 예외 없이 EEXIST).
   * 덮어쓰기(rename·writeFile)로 구현하면 두 회수자가 **둘 다 성공**한다.
   *
   * 결정론 확보: 주입 시계 `now()` 를 **interleaving seam** 으로 쓴다. 구현은 레코드를 발행 직전에
   * 조립하므로 `now()` 호출 시점이 곧 「쓰기 직전」이다. **2번째 호출**(= 잔재 `unlink` 직후의 회수 발행)
   * 에서 경쟁 회수자가 먼저 발행하게 하면 우리 `link` 는 반드시 EEXIST 를 만난다. 1번째 호출은 최초
   * 발행 시도라 아직 잔재가 그 자리에 있어 이 창이 아니다.
   * 덮어쓰기 구현은 이 행에서 경쟁자 레코드를 지우고 claimed 를 반환한다 = RED.
   */
  it('회수 도중 다른 회수자가 먼저 발행하면 덮어쓰지 않고 instance-active 로 물러난다', async () => {
    seedStale(MARKER_B)
    let calls = 0
    const winnerId = newUlid()
    const got = await claim({
      marker: MARKER_A,
      now: () => {
        calls += 1
        if (calls === 2) {
          writeFileSync(
            recordPath(),
            `${JSON.stringify({
              engineInstanceId: winnerId,
              instanceMarker: MARKER_A,
              acquiredAt: 2,
            })}\n`,
          )
        }
        return 3
      },
    })
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(got).toEqual({
      status: 'blocked',
      reason: 'instance-active',
      detail: expect.any(String),
    })
    expect(readRecord()['engineInstanceId']).toBe(winnerId)
  })
})

describe('ⓔ 판정 불가 — 자동 삭제 금지', () => {
  const expectReconciliation = (got: InstanceClaim): void => {
    expect(got.status).toBe('blocked')
    expect(got.status === 'blocked' && got.reason).toBe('reconciliation-required')
    // 운영자가 «무엇을 고쳐야 하는가»를 알 수 있어야 한다(형제 선례 coord-area 의 detail 규율).
    expect(got.status === 'blocked' && got.detail).toContain(ACTIVE_INSTANCE_FILE)
  }

  it('손상 JSON 은 삭제하지 않고 reconciliation-required', async () => {
    writeFileSync(recordPath(), '{ 이건 JSON 이 아니다')
    expectReconciliation(await claim())
    expect(readFileSync(recordPath(), 'utf8')).toBe('{ 이건 JSON 이 아니다')
  })

  it('빈 파일(발행 도중 크래시 잔재)도 삭제하지 않는다', async () => {
    writeFileSync(recordPath(), '')
    expectReconciliation(await claim())
    expect(readdirSync(root)).toEqual([ACTIVE_INSTANCE_FILE])
  })

  // 두 필수 필드 중 하나만 픽스처에 있으면 나머지 검사가 무신호다(「호출 부위 수 == 매칭 수」의 필드판 · R4-6).
  it.each([
    ['instanceMarker 누락', { engineInstanceId: 'x' }],
    ['engineInstanceId 누락', { instanceMarker: MARKER_A }],
    ['둘 다 누락', {}],
  ])('필수 필드 %s 는 판정 불가다', async (_label, rec) => {
    writeFileSync(recordPath(), JSON.stringify(rec))
    expectReconciliation(await claim())
  })

  /**
   * 스펙 §W-2-b 「마커 손상·판정 불가 = 자동 삭제 금지」(Codex 승인 조건 ③)의 falsifier.
   * 형태 검사가 없으면 손상 마커가 「불일치」로 읽혀 **회수의 적극적 근거**가 된다(R3-1 · 실측 7/7 조용한 삭제).
   */
  it.each([
    ['빈 문자열', ''],
    ['짧음', 'abc'],
    ['비-hex', 'z'.repeat(64)],
  ])('instanceMarker 형태 위반(%s)은 삭제하지 않고 판정 불가다', async (_label, bad) => {
    const raw = JSON.stringify({ engineInstanceId: 'OLD', instanceMarker: bad, acquiredAt: 1 })
    writeFileSync(recordPath(), raw)
    expectReconciliation(await claim())
    expect(readFileSync(recordPath(), 'utf8')).toBe(raw)
  })

  /** 자기 마커의 축퇴도 fail-closed — 쓰기·읽기 두 방향이 같은 술어를 공유한다(R3-2). */
  it('자기 마커가 형태 위반이면 marker-unavailable 로 막힌다(부수효과 0)', async () => {
    const backend = createFakeLockBackend(ns)
    const got = await claimActiveInstance({
      areaRoot: root,
      digest: DIGEST,
      backend,
      marker: { read: () => ({ status: 'ok', marker: '' }) },
      instanceId: newUlid(),
    })
    expect(got.status === 'blocked' && got.reason).toBe('marker-unavailable')
    expect(backend.calls).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })

  it('디렉터리가 그 자리에 있으면 판정 불가다', async () => {
    mkdirSync(recordPath())
    expectReconciliation(await claim())
  })

  /**
   * symlink 는 **영역 밖 JSON 을 권위로** 만들고, 회수 쓰기가 링크를 추종하면 영역 밖 파일을 덮어쓴다.
   * `open('wx')`·`link` 는 symlink·FIFO·디렉터리를 EEXIST 하나로만 답하므로 **lstat 만이 구분한다**
   * (실측 · 계획 정정 ㊵). win32 는 symlink 생성이 EPERM 이라 POSIX 게이트.
   */
  /**
   * ⚠ 링크 대상은 **유효한 레코드 JSON** 이어야 한다(R4-2). 비-JSON 을 쓰면 「종류로 거부」와 「추종해서
   * 읽고 파싱 실패」가 같은 결과를 내 종류 검사가 무신호가 된다 — 실제로 막아야 하는 것은 「영역 밖의
   * 멀쩡한 JSON 이 권위가 되는」 경우다. detail 도 걸어 거부 사유가 **종류**임을 고정한다.
   */
  it.runIf(IS_POSIX)('symlink 는 추종하지 않고 대상도 건드리지 않는다', () => {
    const outside = join(root, 'outside.json')
    const valid = JSON.stringify({
      engineInstanceId: 'OUTSIDE',
      instanceMarker: MARKER_B,
      acquiredAt: 1,
    })
    writeFileSync(outside, valid)
    symlinkSync(outside, recordPath())
    return claim().then((got) => {
      expectReconciliation(got)
      expect(got.status === 'blocked' && got.detail).toContain('정규 파일이 아님')
      expect(readFileSync(outside, 'utf8')).toBe(valid)
    })
  })

  it.runIf(IS_POSIX)('dangling symlink 도 판정 불가다(링크 대상을 만들지 않는다)', () => {
    symlinkSync(join(root, 'nowhere.json'), recordPath())
    return claim().then((got) => {
      expectReconciliation(got)
      expect(readdirSync(root).sort()).toEqual([ACTIVE_INSTANCE_FILE])
    })
  })

  /** FIFO 면 판독이 **무기한 블록**된다 — 종류 검사 없는 구현은 여기서 부팅이 영영 안 끝난다. */
  it.runIf(IS_POSIX)('FIFO 는 판독을 시도하지 않는다(부팅 블록 금지)', () => {
    execFileSync('mkfifo', [recordPath()])
    return claim().then(expectReconciliation)
  })
})

describe('부수효과 이전 판정 — 실패자는 아무것도 만지지 않는다', () => {
  it('마커 유도 불가면 bind 도 파일 접근도 하지 않는다', async () => {
    const backend = createFakeLockBackend(ns)
    const got = await claimActiveInstance({
      areaRoot: root,
      digest: DIGEST,
      backend,
      marker: { read: () => ({ status: 'unavailable', detail: '/proc 없음' }) },
      instanceId: newUlid(),
    })
    expect(got).toEqual({
      status: 'blocked',
      reason: 'marker-unavailable',
      detail: expect.stringContaining('/proc 없음'),
    })
    expect(backend.calls).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })

  it('endpoint 오류(미지 errno)는 endpoint-unavailable 이고 파일을 만들지 않는다', async () => {
    const backend = createFakeLockBackend(ns)
    backend.failNextBind('EPERM')
    const got = await claim({ backend })
    expect(got.status === 'blocked' && got.reason).toBe('endpoint-unavailable')
    expect(readdirSync(root)).toEqual([])
  })

  it('digest 문법 위반은 bind 이전에 거부된다', async () => {
    const backend = createFakeLockBackend(ns)
    const got = await claimActiveInstance({
      areaRoot: root,
      digest: 'not-a-digest',
      backend,
      marker: markerSource(MARKER_A),
      instanceId: newUlid(),
    })
    expect(got.status === 'blocked' && got.reason).toBe('endpoint-unavailable')
    expect(backend.calls).toEqual([])
  })

  /**
   * 영역이 사라진 뒤의 부팅(볼륨 미마운트·운영자 정리)은 **조용히 통과하면 안 된다.** 발행이 실패하면
   * `io-failure` 로 갈라야 `reconciliation-required`(레코드를 고쳐라)와 고칠 대상이 구분된다.
   */
  it('영역 디렉터리가 없으면 io-failure 다(사유를 뭉개지 않는다)', async () => {
    const gone = join(root, 'no-such-area')
    const got = await claimActiveInstance({
      areaRoot: gone,
      digest: DIGEST,
      backend: createFakeLockBackend(ns),
      marker: markerSource(MARKER_A),
      instanceId: newUlid(),
    })
    expect(got.status === 'blocked' && got.reason).toBe('io-failure')
    // 그 경로에서도 endpoint 는 놓는다.
    mkdirSync(gone)
    const retry = await claimActiveInstance({
      areaRoot: gone,
      digest: DIGEST,
      backend: createFakeLockBackend(ns),
      marker: markerSource(MARKER_A),
      instanceId: newUlid(),
    })
    expect(retry.status).toBe('claimed')
  })

  /** 잔재를 지울 수 없는 상태(부모 디렉터리 쓰기 불가)도 `io-failure` — 회수를 조용히 포기하지 않는다. */
  it.runIf(CAN_DENY_WRITE)('잔재 제거가 실패하면 io-failure 다', async () => {
    seedStale(MARKER_B)
    chmodSync(root, 0o500)
    const got = await claim()
    chmodSync(root, 0o700)
    expect(got.status === 'blocked' && got.reason).toBe('io-failure')
    expect(readRecord()['instanceMarker']).toBe(MARKER_B)
  })

  /**
   * **endpoint 를 누수하면 다음 부팅이 자기 자신을 「생존」으로 오판한다.** blocked 로 끝나는 모든 경로가
   * 잡았던 endpoint 를 놓아야 한다 — 이 행이 없으면 판정 불가 1회가 그 뒤 모든 부팅을 ⓐ로 고착시킨다.
   */
  /**
   * 경합 소진(`instance-active`) 경로도 endpoint 를 놓아야 한다 — 이 단언이 없으면 그 자리의 해제를
   * 지워도 무신호다(R2-4). `now()` 를 interleaving seam 으로 써서 매 회차 경쟁자가 먼저 발행하게 만든다.
   */
  it('발행 경합에 소진돼도 endpoint 를 놓는다', async () => {
    seedStale(MARKER_B)
    const winner = `${JSON.stringify({
      engineInstanceId: 'WINNER',
      instanceMarker: MARKER_A,
      acquiredAt: 2,
    })}\n`
    const got = await claim({
      now: () => {
        writeFileSync(recordPath(), winner)
        return 3
      },
    })
    expect(got.status === 'blocked' && got.reason).toBe('instance-active')
    unlinkSync(recordPath())
    expect((await claim()).status).toBe('claimed')
  })

  it('blocked 로 끝나면 잡았던 endpoint 를 반드시 놓는다', async () => {
    writeFileSync(recordPath(), 'corrupt')
    const first = await claim()
    expect(first.status === 'blocked' && first.reason).toBe('reconciliation-required')
    // 같은 네임스페이스에서 곧바로 다시 bind 가능해야 한다 = 이름이 비어 있다.
    unlinkSync(recordPath())
    const second = await claim()
    expect(second.status).toBe('claimed')
  })
})

describe('ⓓ 해제 — ReleaseOutcome', () => {
  it('정상 해제는 removed 이고 파일이 사라진다', async () => {
    const got = await claim()
    expect(got.status).toBe('claimed')
    if (got.status !== 'claimed') return
    expect(got.handle.release()).toEqual({ status: 'removed' })
    expect(readdirSync(root)).toEqual([])
  })

  it('해제 후에는 같은 네임스페이스에서 즉시 재획득된다(endpoint 도 놓는다)', async () => {
    const first = await claim()
    if (first.status !== 'claimed') throw new Error('전제 붕괴')
    first.handle.release()
    const second = await claim()
    expect(second.status).toBe('claimed')
  })

  /**
   * **not-owned 행이 필수다**(계획 정정 ㊹): 없으면 「무조건 unlink」 구현이 통과하고, 회수당한 구
   * 인스턴스의 **지연 종료가 새 인스턴스의 레코드를 지운다**(형제 계약 locks.ts:331-335 와 같은 규율).
   */
  it('내 레코드가 아니면 지우지 않고 not-owned 를 보고한다', async () => {
    const got = await claim()
    if (got.status !== 'claimed') throw new Error('전제 붕괴')
    const usurper = `${JSON.stringify({
      engineInstanceId: 'OTHER',
      instanceMarker: MARKER_B,
      acquiredAt: 9,
    })}\n`
    writeFileSync(recordPath(), usurper)

    const outcome = got.handle.release()
    expect(outcome.status).toBe('not-owned')
    expect(readFileSync(recordPath(), 'utf8')).toBe(usurper)
    // ⚠ **endpoint 는 놓아야 한다**(R4-4): 이 단언이 없으면 그 자리의 `close()` 를 지워도 무신호다.
    unlinkSync(recordPath())
    expect((await claim()).status).toBe('claimed')
  })

  it('파일이 이미 사라졌으면 removed 로 위장하지 않는다', async () => {
    const got = await claim()
    if (got.status !== 'claimed') throw new Error('전제 붕괴')
    unlinkSync(recordPath())
    expect(got.handle.release().status).toBe('not-owned')
  })

  /**
   * 승인 조건 ⑤ — 제거 실패를 성공으로 위장하지 않는다. 실 조건 주입은 POSIX 만 가능하다(실측:
   * win32 는 열린 파일도 읽기전용 파일도 `unlink` 가 **성공**해 실패를 만들 수 없다). 이 한계는 은폐하지
   * 않는다 — 대신 규칙 자체(부모 디렉터리 쓰기 불가 → `removal-failed` ∧ 파일 존속)를 여기서 고정한다.
   */
  it.runIf(CAN_DENY_WRITE)('제거가 실패하면 removal-failed 이고 파일이 남는다', async () => {
    const got = await claim()
    if (got.status !== 'claimed') throw new Error('전제 붕괴')
    chmodSync(root, 0o500)
    const outcome = got.handle.release()
    chmodSync(root, 0o700)
    expect(outcome.status).toBe('removal-failed')
    expect(outcome.status === 'removal-failed' && outcome.detail.length).toBeGreaterThan(0)
    expect(readdirSync(root)).toEqual([ACTIVE_INSTANCE_FILE])
    // 실패해도 endpoint 는 놓는다 — 그래야 다음 부팅이 잔재를 회수할 수 있다(R4-4).
    unlinkSync(recordPath())
    expect((await claim()).status).toBe('claimed')
  })

  /** 이미 해제된 핸들의 2차 호출이 **새 소유자의** 레코드를 만지지 않는다. */
  it('두 번째 release 는 아무것도 지우지 않는다', async () => {
    const got = await claim()
    if (got.status !== 'claimed') throw new Error('전제 붕괴')
    expect(got.handle.release().status).toBe('removed')
    expect(got.handle.isHeld()).toBe(false)
    const next = await claim()
    expect(next.status).toBe('claimed')
    expect(got.handle.release().status).toBe('not-owned')
    expect(readdirSync(root)).toEqual([ACTIVE_INSTANCE_FILE])
  })
})

/**
 * §3-T8c 「`held` 잔재로 영구 고착되는 경로가 존재하지 않음」의 관측형(계획 정정 ㊺).
 * 실존 부정형은 조작화가 불가능하므로 **온디스크 상태 전수 × 결과 유한집합 × 진행 가능성**으로 바꾼다.
 */
describe('상태표 — 어떤 온디스크 상태에서도 판정이 닫히고 고착이 없다', () => {
  const STATES: readonly {
    label: string
    seed: () => void
    occupied: boolean
    expected: 'claimed' | 'instance-active' | 'reconciliation-required'
  }[] = [
    { label: '부재', seed: () => {}, occupied: false, expected: 'claimed' },
    {
      label: '유효 레코드 + endpoint 점유',
      seed: () => seedStale(MARKER_A),
      occupied: true,
      expected: 'instance-active',
    },
    {
      label: '유효 레코드 + endpoint 비었고 마커 일치',
      seed: () => seedStale(MARKER_A),
      occupied: false,
      expected: 'claimed',
    },
    {
      label: '유효 레코드 + endpoint 비었고 마커 불일치',
      seed: () => seedStale(MARKER_B),
      occupied: false,
      expected: 'claimed',
    },
    {
      label: 'JSON 손상',
      seed: () => writeFileSync(recordPath(), '}{'),
      occupied: false,
      expected: 'reconciliation-required',
    },
    {
      label: '빈 파일',
      seed: () => writeFileSync(recordPath(), ''),
      occupied: false,
      expected: 'reconciliation-required',
    },
    {
      label: '비정규 파일(디렉터리)',
      seed: () => mkdirSync(recordPath()),
      occupied: false,
      expected: 'reconciliation-required',
    },
    {
      label: '마커 형태 위반',
      seed: () =>
        writeFileSync(
          recordPath(),
          JSON.stringify({ engineInstanceId: 'x', instanceMarker: 'nope', acquiredAt: 1 }),
        ),
      occupied: false,
      expected: 'reconciliation-required',
    },
  ]

  /** 표가 분기보다 짧으면 새 분기가 무신호로 들어온다 — 「호출 부위 수 == 매칭 수」 관용구의 응용. */
  it('표가 판정 결과 3종을 모두 덮는다(부분 표는 vacuous)', () => {
    expect(new Set(STATES.map((s) => s.expected)).size).toBe(3)
    expect(STATES).toHaveLength(8)
  })

  it.each(STATES)('$label → $expected', async ({ seed, occupied, expected }) => {
    seed()
    const backend = createFakeLockBackend(ns)
    if (occupied) backend.occupy(instanceEndpoint())
    const got = await claim({ backend, marker: MARKER_A })
    expect(got.status === 'claimed' ? 'claimed' : got.reason).toBe(expected)
  })

  /**
   * **고착 부재의 핵심 단언**: `reconciliation-required` 는 «운영자가 그 자리를 치우면 곧바로 진행 가능»
   * 해야 한다. 자기 자신을 재생산하는 구현(예: 판정 불가를 만나면 자기 레코드를 남기는 구현)이면 RED 다.
   * ⚠ **같은 백엔드 네임스페이스로 재시도한다** — 그래야 「blocked 경로가 endpoint 를 놓는다」까지 함께
   * 걸린다(놓지 않으면 재시도가 `instance-active` 로 떨어져 RED).
   */
  it.each(STATES.filter((s) => s.expected === 'reconciliation-required'))(
    '$label 상태는 자리를 치우면 즉시 진행 가능하다(fixpoint 부재)',
    async ({ seed }) => {
      seed()
      const first = await claim()
      expect(first.status).toBe('blocked')
      rmSync(recordPath(), { recursive: true, force: true })
      const retry = await claim()
      expect(retry.status).toBe('claimed')
    },
  )

  /** 획득에 성공한 상태들은 **해제 후 재획득**으로 진행 가능성을 보인다(수명 주기가 닫힌다). */
  it.each(STATES.filter((s) => s.expected === 'claimed'))(
    '$label 상태는 획득→해제→재획득이 닫힌다',
    async ({ seed }) => {
      seed()
      const first = await claim({ marker: MARKER_A })
      expect(first.status).toBe('claimed')
      if (first.status !== 'claimed') return
      expect(first.handle.release().status).toBe('removed')
      const again = await claim({ marker: MARKER_A })
      expect(again.status).toBe('claimed')
    },
  )
})

/**
 * **집행 범위의 경계를 값으로 고정한다**(자체 적대 리뷰 R1-01·R2-2). 페이크의 네임스페이스 Map 두 개 =
 * 서로 다른 net namespace 다. 그 구성에서 이 모듈은 **차단하지 않는다** — 커널 endpoint 가 서로를 못 보기
 * 때문이다. 이 행이 없으면 「런타임 층이 배포 계약의 구멍을 메운다」는 (틀린) 읽기가 문서에서 되살아난다.
 * 그 구간의 안전은 compose `container_name` 이 지며, 여기서는 **현 거동과 증거 등급**만 못 박는다.
 */
describe('집행 범위 — 별개 net namespace 는 차단하지 않고 등급으로 기록한다', () => {
  it('두 네임스페이스는 둘 다 claimed 이고 나중 쪽 증거는 deployment-premise 다', async () => {
    const nsA = new Map<string, symbol>()
    const nsB = new Map<string, symbol>()
    const a = await claim({ namespace: nsA, marker: MARKER_A, instanceId: newUlid() })
    expect(a.status).toBe('claimed')

    const b = await claim({ namespace: nsB, marker: MARKER_B, instanceId: newUlid() })
    expect(b.status).toBe('claimed')
    // 「커널이 침묵하는 회수」임이 값에 남는다 — kernel-proven 이면 거짓을 단언하는 것이다.
    expect(b.status === 'claimed' && b.handle.evidence).toBe('deployment-premise')

    // 그리고 A 는 자기 종료 시 «내 것이 아니다» 를 알게 된다(남의 레코드를 지우지 않는다).
    expect(a.status === 'claimed' && a.handle.release().status).toBe('not-owned')
    expect(readdirSync(root)).toEqual([ACTIVE_INSTANCE_FILE])
  })

  it('같은 네임스페이스였다면 두 번째는 막힌다(대조군 — 경계가 net ns 에 있음을 보인다)', async () => {
    const shared = new Map<string, symbol>()
    expect((await claim({ namespace: shared })).status).toBe('claimed')
    const second = await claim({ namespace: shared, marker: MARKER_B })
    expect(second.status === 'blocked' && second.reason).toBe('instance-active')
  })
})

describe('decideReclaim — 순수 판정(증거 등급)', () => {
  it('마커가 같으면 커널 증명, 다르면 배포 전제', () => {
    expect(decideReclaim(MARKER_A, MARKER_A)).toBe('kernel-proven')
    expect(decideReclaim(MARKER_B, MARKER_A)).toBe('deployment-premise')
  })

  /** 마커는 «판정 성분»이지 «유일성 보장»이 아니다 — 대소문자·공백 정규화 없이 정확 비교한다. */
  it('정규화하지 않는다(대소문자 다르면 다른 마커)', () => {
    expect(decideReclaim(MARKER_A.toUpperCase(), MARKER_A)).toBe('deployment-premise')
  })
})

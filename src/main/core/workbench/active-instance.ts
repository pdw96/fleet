import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { InstanceMarkerSource } from './instance-marker'
import { isMarkerForm } from './instance-marker'
import type { BoundEndpoint, LockBackend } from './locks'
import { endpointFor } from './locks'
import { isLinkSync } from '../workspace/path-guard'

/**
 * 인스턴스 배타 (#251 PR1c T5 · 스펙 §W-2-b ①) — **한 코디네이션 영역에 살아있는 엔진 인스턴스는 하나**.
 *
 * 이 계약은 편의 기능이 아니라 락 층(§W-3)의 **전제**다: 추상 소켓의 배타 범위는 network namespace 인데
 * 레포 공유 범위는 파일시스템이라, 인스턴스가 둘이면 두 축이 어긋나 이중 소유가 성립한다(locks.ts 상단 주석).
 *
 * ⚠ **집행 범위는 같은 net namespace 뿐이다**(은폐하지 않는 잔여 · 자체 적대 리뷰 R1-01). 별개 namespace 의
 * 두 인스턴스는 서로의 endpoint 를 보지 못해 **둘 다 획득에 성공**하고, 나중 쪽이 앞선 레코드를
 * `deployment-premise` 로 회수한다 — 이 모듈은 그 구간을 **차단하지 않고 증거 등급으로 기록**할 뿐이며,
 * 안전의 근거는 배포 계약(compose `container_name`)이다. 그 방향을 뒤집어 「런타임이 배포 계약의 구멍을
 * 메운다」로 읽으면 순환이 된다(ADR-0013).
 *
 * ## 획득 순서가 계약이다 (계획 정정 ㊳)
 *
 * ```text
 * ① 마커 유도 → 실패면 즉시 종료(bind·파일 접근 0)
 * ② 커널 endpoint bind
 *      in-use  → instance-active   (파일 미접촉 — 승인 조건 ①)
 *      error   → endpoint-unavailable
 * ③ (bind 성공 = 이 net ns 에 살아있는 인스턴스 없음) 파일 발행 = tmp + link(create-only)
 *      성공    → claimed
 *      EEXIST  → 잔재 판정 → 회수(unlink → 재발행) 또는 reconciliation-required
 * ```
 *
 * `wx` 를 먼저 하고 bind 를 나중에 하면, 승자가 bind 하기 전 창에서 다른 부팅의 probe 가 성공해
 * **같은 컨테이너 안에서 이중 인스턴스**가 성립한다. bind 가 먼저면 그 창 자체가 없다.
 *
 * ## 왜 `wx` 가 아니라 tmp + `link` 인가 (계획 정정 ㊴)
 *
 * `open(...,'wx')` 는 **바이트가 채워지기 전에 이름을 노출**한다 — 그 사이 크래시하면 「존재하는 빈 파일」이
 * 남고, 그것이 「마커 판정 불가 = 자동 삭제 금지」 규칙에 걸려 **크래시 1회가 운영자 개입 없이는 복구 불가**한
 * 고착이 된다. tmp 에 완전히 쓴 뒤 `link` 하면 「이름이 보이는 순간 내용이 완전」이 성립하고, `link` 는
 * 실측상 **모든 기존 이름**(일반 파일·live/dangling symlink·FIFO·디렉터리)에 EEXIST 라 create-only
 * 경합 의미론도 그대로다. 회수도 같은 프리미티브를 써야 두 회수자가 둘 다 성공하는 창이 닫힌다.
 * (내구 순서 fsync 는 §W-5 `DurableFs` = PR2 범위. 여기서는 **가시성**만 원자화한다.)
 *
 * ## 마커의 역할 = 증거 등급 (L-1)
 *
 * 회수 여부는 **커널이** 정한다(bind 성공 = 이 net ns 에 소유자 없음). 마커는 그 회수가 「같은 PID ns 의
 * 소유자가 죽었다는 커널 증명」인지 「다른 컨테이너였고 단일 인스턴스 배포 전제에 기대는 추론」인지를
 * 구분해 **기록**할 뿐이다. 연령(`acquiredAt`)·pid·mtime 은 어떤 분기 술어에도 등장하지 않는다.
 *
 * ## `ApprovalGate` 를 거치지 않는 이유 (명시 예외 · CodeRabbit PR#262)
 *
 * 이 모듈의 `writeFileSync`·`linkSync`·`unlinkSync` 는 **승인 게이트 밖**이다. 대상은 사용자 워크스페이스가
 * 아니라 **코디네이션 메타데이터 한 파일**(`<area>/active-instance.json` 과 그 tmp)뿐이고, 게이트의 범위는
 * 레포 전역에서 «LLM 변이·프로세스 spawn»이다(소비자 = `engine`·`orchestrator`·`mcp/host`·`tools/loop`).
 * 엔진 인프라 쓰기는 전부 게이트 밖이라는 선례가 이미 있다 — `store/json-file.ts` · `ignored-baseline.ts` ·
 * 형제 `coord-area.ts`(PR1a · Codex 리뷰 통과). 게다가 이 경로는 **부팅 시점**이라 승인자가 존재하지 않고,
 * §W-3 **L-5**(승인 대기 중 락 보유 금지)와 방향이 정면으로 충돌한다. 결정 근거는 ADR-0013.
 * ⚠ 「남의 레코드를 지울 수 있다」는 위험은 게이트가 아니라 **소유 확인 + create-only 경합**이 막는다
 * (해제 측 `not-owned` · 획득 측 마지막 회차 미접촉 규율).
 *
 * ⚠ **미착지**(PR7): 부팅 시 이 함수 호출 · `shutdown()` 에서 `release()` · 「제거 실패를 성공 종료로
 * 위장하지 않는다」(승인 조건 ⑤)의 **호출부 책임**. 이 모듈은 그 판정을 값으로 돌려줄 뿐이다.
 */

export const ACTIVE_INSTANCE_FILE = 'active-instance.json'

export interface ActiveInstanceRecord {
  readonly engineInstanceId: string
  readonly instanceMarker: string
  /** **진단 전용 · 기록 후 다시 읽지 않는다.** 연령을 회수 근거로 쓰는 순간 L-1 이 깨진다. */
  readonly acquiredAt: number
}

/** 회수의 증거 등급 — 값으로 남겨 안전 논증이 코드에 보이게 한다. */
export type ReclaimEvidence =
  /** 같은 PID ns 의 이전 소유자가 죽었음을 커널이 보장(마커 일치 + endpoint 회수됨). */
  | 'kernel-proven'
  /** 기록자가 다른 컨테이너다 — 커널은 침묵하고 **단일 인스턴스 배포 계약**이 근거다. */
  | 'deployment-premise'

export type ClaimBlockedReason =
  /** 이 영역에 살아있는 인스턴스가 있다(정상 대기). */
  | 'instance-active'
  /** 현 인스턴스 마커를 유도할 수 없다(비-Linux · `/proc` 형태 위반). */
  | 'marker-unavailable'
  /** endpoint 이름 유도·bind 가 모호하게 실패했다(fail-closed). */
  | 'endpoint-unavailable'
  /** 레코드가 비정규·판독 불가·손상 — **자동 삭제 금지**, 운영자 개입 필요. */
  | 'reconciliation-required'
  /** 발행·회수의 파일 조작이 실패했다. */
  | 'io-failure'

export interface InstanceHandle {
  readonly marker: string
  /**
   * 커널이 여전히 이 인스턴스에 배타 이름을 할당하고 있는가(로컬 조회 · 디스크 I/O 0).
   * 형제 `LockHandle.revalidate`(locks.ts)와 같은 표면이며, PR7 의 배선이 「배타를 잃었는지」를
   * 물어볼 수 있어야 하기 때문에 **핸들 모양이 굳기 전에** 넣는다(사후 추가 = 파괴적 변경).
   */
  isHeld(): boolean
  /** 이 획득이 무엇을 근거로 성립했는가. 최초 발행이면 `'first-claim'`. */
  readonly evidence: ReclaimEvidence | 'first-claim'
  release(): ReleaseOutcome
}

export type ReleaseOutcome =
  | { readonly status: 'removed' }
  /** 제거가 실패했다 — **성공 종료로 위장하지 않는다**(승인 조건 ⑤). */
  | { readonly status: 'removal-failed'; readonly detail: string }
  /** 그 자리의 레코드가 내 것이 아니다(회수당했거나 이미 사라졌다) — 남의 것을 지우지 않는다. */
  | { readonly status: 'not-owned'; readonly detail: string }

export type InstanceClaim =
  | { readonly status: 'claimed'; readonly handle: InstanceHandle }
  | {
      readonly status: 'blocked'
      readonly reason: ClaimBlockedReason
      readonly detail: string
    }

export interface ClaimOptions {
  /** 열린 코디네이션 영역의 루트(`<canonical common gitdir>/fleet`). */
  readonly areaRoot: string
  /** `endpointDigest()` 산출물(32 hex). */
  readonly digest: string
  /** 커널 endpoint 주입 seam — 실 어댑터(Linux)와 페이크가 같은 계약을 만족한다. */
  readonly backend: LockBackend
  readonly marker: InstanceMarkerSource
  /** 진단용 엔진 인스턴스 id(ULID). */
  readonly instanceId: string
  readonly now?: () => number
}

/**
 * 회수 증거 등급 판정(**순수**). 입력은 두 마커뿐이다 — 연령·pid·mtime·시각이 여기 들어오지 못하는 것이
 * 구조적 계약이며(`active-instance-structure.test.ts` 가 본문 스캔으로 고정), 정규화도 하지 않는다
 * (마커는 해시 문자열이고 정규화는 서로 다른 신원을 같은 것으로 붕괴시킨다).
 */
export function decideReclaim(recordedMarker: string, selfMarker: string): ReclaimEvidence {
  return recordedMarker === selfMarker ? 'kernel-proven' : 'deployment-premise'
}

/** 레코드 크기 상한. 3필드 수백 바이트이므로 넉넉히 잡아도 64KiB 면 충분하다. */
const MAX_RECORD_BYTES = 64 * 1024

/** 회수로 우리가 지운 이전 소유자를 진단에 싣는다 — 파괴 사실을 결과값에서 숨기지 않는다(R2-5). */
const destroyed = (reclaimedFrom: string | undefined): string =>
  reclaimedFrom === undefined ? '' : ` (직전 레코드 ${reclaimedFrom} 를 회수로 제거한 뒤였다)`

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : `알 수 없는 오류: ${String(err)}`

const isEexist = (err: unknown): boolean =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 캐스트를 리뷰에 보이게 두는 것 자체가 이 룰의 목적이다.
  (err as NodeJS.ErrnoException)?.code === 'EEXIST'

type RecordProbe =
  | { kind: 'missing' }
  | { kind: 'unusable'; detail: string }
  /** ⚠ **판정에 필요한 두 필드만** 싣는다 — `acquiredAt` 은 기록 전용이라 판정 경로에 존재하지 않는다. */
  | { kind: 'ok'; record: Pick<ActiveInstanceRecord, 'engineInstanceId' | 'instanceMarker'> }

/**
 * 레코드 1회 읽기 — **읽기 전에 파일 종류를 본다**(스펙 §W-2 「JSON = `'regular'|'missing'`」).
 * 형제 모듈 `coord-area.ts` 의 `probeRecord` 와 같은 규율이다: 이 영역은 ttyd 셸·CLI 에이전트와 같은
 * 신뢰 도메인이라(§W-2-a) 누구든 그 자리에 FIFO·symlink 를 놓을 수 있는데, FIFO 면 `readFileSync` 가
 * **무기한 블록**되고(부팅이 영영 안 끝난다) symlink 면 **영역 밖 JSON 이 권위**가 된다(실측). 악의가
 * 아니라 사고·경합 방어다.
 */
const probeRecord = (path: string): RecordProbe => {
  const kind = isLinkSync(path)
  if (kind === 'missing') return { kind: 'missing' }
  if (kind !== 'regular') {
    return { kind: 'unusable', detail: `${ACTIVE_INSTANCE_FILE} 이 정규 파일이 아님(${kind})` }
  }
  let raw: string
  try {
    // 크기 상한 — 레코드는 3필드 수백 바이트다. 같은 신뢰 도메인의 사고로 거대 파일이 그 자리에 오면
    // `readFileSync` 가 전량을 힙에 올려(실측: 400MB 파일에서 RSS +400MB) 컨테이너 한도에서는 진단을
    // 내기 전에 OOM 킬을 당한다. FIFO 를 막으면서 이 축을 비워 두지 않는다.
    if (statSync(path).size > MAX_RECORD_BYTES) {
      return { kind: 'unusable', detail: `${ACTIVE_INSTANCE_FILE} 크기 상한 초과(${path})` }
    }
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // ⚠ ENOENT 는 손상이 아니라 **경합**이다(형제 `coord-area.ts` 동형). `unusable` 로 승격시키면
    // 「존재하지 않는 파일을 고치라」는 운영자 개입 요구가 되고, 이 함수 호출부가 선언한
    // 「경합 상대가 방금 치웠다 → 재발행」 경로가 실제로는 도달 불가가 된다(자체 적대 리뷰 R2-3).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 캐스트를 리뷰에 보이게 두는 것 자체가 이 룰의 목적이다.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unusable', detail: `${ACTIVE_INSTANCE_FILE} 판독 불가: ${errText(err)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { kind: 'unusable', detail: `${ACTIVE_INSTANCE_FILE} 판독 불가: ${errText(err)}` }
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- `JSON.parse` 산출물(unknown)을 검사 대상 형태로 좁힌다. 바로 아래 필수 필드 검사가 실제 검증이며, 이 캐스트는 그 검사를 쓰기 위한 것이다.
  const rec = parsed as Partial<ActiveInstanceRecord> | null
  if (
    !rec ||
    typeof rec !== 'object' ||
    typeof rec.engineInstanceId !== 'string' ||
    typeof rec.instanceMarker !== 'string'
  ) {
    return {
      kind: 'unusable',
      detail: `${ACTIVE_INSTANCE_FILE} 필수 필드(engineInstanceId·instanceMarker) 누락(${path})`,
    }
  }
  // **마커 형태 검증**(스펙 §W-2-b 「마커 손상·판정 불가 = 자동 삭제 금지」 · Codex 승인 조건 ③).
  // 이 검사가 없으면 손상된 마커가 「불일치」로 읽혀 **회수의 적극적 근거**가 되고, 운영자가 보아야 할
  // 손상 신호가 부팅 1회로 소멸한다(자체 적대 리뷰 R3-1 · 실측 7/7 조용한 삭제).
  if (!isMarkerForm(rec.instanceMarker)) {
    return { kind: 'unusable', detail: `${ACTIVE_INSTANCE_FILE} instanceMarker 형태 위반(${path})` }
  }
  // ⚠ `acquiredAt` 은 **싣지 않는다** — 판정 경로에 그 값이 존재하지 않는 것이 L-1 의 구조적 보장이다
  // (기록 전용 진단 필드 · 자체 적대 리뷰 R1-06).
  return {
    kind: 'ok',
    record: { engineInstanceId: rec.engineInstanceId, instanceMarker: rec.instanceMarker },
  }
}

type PublishResult = { kind: 'published' } | { kind: 'exists' } | { kind: 'failed'; detail: string }

/**
 * 원자적 발행 — tmp 에 완전히 쓴 뒤 `link`. **`link` 의 EEXIST 가 경합 패배의 권위 신호**다
 * (덮어쓰기 계열 프리미티브는 두 회수자를 모두 성공시킨다).
 */
const publish = (root: string, record: ActiveInstanceRecord): PublishResult => {
  const tmp = join(root, `.${ACTIVE_INSTANCE_FILE}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    linkSync(tmp, join(root, ACTIVE_INSTANCE_FILE))
    return { kind: 'published' }
  } catch (err) {
    if (isEexist(err)) return { kind: 'exists' }
    return { kind: 'failed', detail: errText(err) }
  } finally {
    // 영역 디렉터리 내용이 계약이라 tmp 를 남기지 않는다(이름에 난수가 있어 삭제 실패도 다음 부팅을 막지 않는다).
    try {
      unlinkSync(tmp)
    } catch {
      /* 이미 없거나 지울 수 없음 */
    }
  }
}

export async function claimActiveInstance(opts: ClaimOptions): Promise<InstanceClaim> {
  const blocked = (reason: ClaimBlockedReason, detail: string): InstanceClaim => ({
    status: 'blocked',
    reason,
    detail,
  })

  // ① 마커부터. 유도 불가면 어떤 부수효과도 없이 끝낸다(bind 0 · 파일 접근 0).
  const marker = opts.marker.read()
  if (marker.status !== 'ok') return blocked('marker-unavailable', marker.detail)
  // 좁혀진 값을 여기서 고정한다 — tsc 는 중첩 함수 안까지 유니온 협소화를 옮기지 않아, 그러지 않으면
  // 아래 클로저마다 «도달 불가능한 unavailable 분기»를 다시 써야 한다(죽은 분기 = 커버리지 구멍).
  const selfMarker = marker.marker
  // 주입 소스가 돌려준 값도 **같은 술어로** 검사한다(쓰기/읽기 두 방향 공유). 형태를 검증하지 않으면
  // 상수 축퇴한 마커가 그대로 기록돼 최고 증거 등급까지 도달한다(자체 적대 리뷰 R3-2). 부수효과 0 구간이다.
  if (!isMarkerForm(selfMarker)) {
    return blocked('marker-unavailable', `인스턴스 마커 형태 위반: ${JSON.stringify(selfMarker)}`)
  }

  const ep = endpointFor(opts.digest, { kind: 'instance' })
  if (ep.status !== 'ok') {
    const detail =
      ep.status === 'invalid'
        ? `인스턴스 endpoint 이름 무효: ${ep.detail}`
        : `인스턴스 endpoint 이름이 예산 초과(${ep.bytes}B > ${ep.max}B)`
    return blocked('endpoint-unavailable', detail)
  }

  // ② 커널 endpoint. 여기서 in-use 면 **파일을 읽지도 않는다** — 커널이 이미 답했다.
  const bind = await opts.backend.bind(ep.endpoint)
  if (bind.status === 'in-use') {
    return blocked('instance-active', `이 영역에 살아있는 인스턴스가 있음(endpoint ${ep.key} 점유)`)
  }
  if (bind.status === 'error') {
    return blocked(
      'endpoint-unavailable',
      `인스턴스 endpoint bind 실패(code=${bind.code ?? '미지'}): ${bind.detail}`,
    )
  }
  const bound: BoundEndpoint = bind.endpoint

  const path = join(opts.areaRoot, ACTIVE_INSTANCE_FILE)
  const now = opts.now ?? Date.now
  const build = (): ActiveInstanceRecord => ({
    engineInstanceId: opts.instanceId,
    instanceMarker: selfMarker,
    acquiredAt: now(),
  })

  /**
   * ⚠ bind 성공 이후는 **구조적으로** 「claimed 로 나갈 때만 endpoint 를 넘긴다」로 보장한다(자체 적대
   * 리뷰 R2-7): 반환 지점마다 `close()` 를 손으로 배치하면 ⓐ빠뜨린 분기가 무신호로 남고(실측: 4분기가
   * 변이 무신호였다) ⓑ이 구간의 어떤 throw(주입 `now()`·`randomBytes`)도 endpoint 를 누수시킨다.
   * 누수하면 **다음 부팅이 자기 자신을 「생존」으로 오판**해 그 영역이 영구히 `instance-active` 로 고착된다.
   */
  let handedOver = false
  try {
    // ③ 발행. **유한 루프**(최대 2회)로 「발행 → 잔재면 판정 → 회수 → 재발행」을 한 경로에 둔다.
    // 재시도 상한이 계약이다 — 경합 상대가 계속 이기면 무한 루프가 되어 부팅이 끝나지 않는다.
    let evidence: ReclaimEvidence | 'first-claim' = 'first-claim'
    /** 회수로 **우리가 지운** 이전 소유자 — 이후 실패 시 그 파괴 사실을 진단에 싣기 위해 기억한다. */
    let reclaimedFrom: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const published = publish(opts.areaRoot, build())
      if (published.kind === 'failed') {
        return blocked(
          'io-failure',
          `레코드 발행 실패: ${published.detail}${destroyed(reclaimedFrom)}`,
        )
      }
      if (published.kind === 'published') {
        handedOver = true
        return { status: 'claimed', handle: makeHandle(evidence) }
      }

      // 잔재가 있다. 종류·판독·형태가 하나라도 어긋나면 **지우지 않고** 운영자에게 넘긴다.
      const probe = probeRecord(path)
      if (probe.kind === 'unusable') return blocked('reconciliation-required', probe.detail)
      // `missing` 이면 경합 상대가 이름을 방금 치운 것이다 — 판정할 잔재가 없으니 그대로 재발행한다.
      // ⚠ **마지막 회차에서는 잔재를 건드리지 않는다.** 그 시점에 보이는 레코드는 「죽은 인스턴스의 잔재」가
      // 아니라 **직전 회차 사이에 다른 회수자가 방금 발행한 것**일 수 있고, 지우면 승자의 레코드를 파괴한다.
      // 해제 측의 `not-owned` 규율(남의 것을 지우지 않는다)에 대응하는 획득 측 규율이다.
      if (probe.kind === 'ok' && attempt === 0) {
        evidence = decideReclaim(probe.record.instanceMarker, selfMarker)
        try {
          unlinkSync(path)
          reclaimedFrom = probe.record.engineInstanceId
        } catch (err) {
          return blocked('io-failure', `잔재 레코드 제거 실패: ${errText(err)}`)
        }
      }
    }
    // 상한까지 갔다 = 매번 다른 인스턴스가 먼저 발행했다. **덮어쓰지 않는다** — create-only 가 승자를 정한다.
    return blocked('instance-active', '레코드 발행 경합에서 밀림 — 다른 인스턴스가 먼저 발행했음')
  } finally {
    if (!handedOver) bound.close()
  }

  function makeHandle(evidenceOf: ReclaimEvidence | 'first-claim'): InstanceHandle {
    /** 해제는 한 번만 유효하다 — 두 번째 호출이 남의 레코드를 만지지 않게 한다. */
    let released = false
    const finish = (outcome: ReleaseOutcome): ReleaseOutcome => {
      released = true
      bound.close()
      return outcome
    }
    return {
      marker: selfMarker,
      evidence: evidenceOf,
      /**
       * 커널 상태 조회(로컬·디스크 I/O 0) — 형제 `LockHandle.revalidate`(locks.ts)와 같은 표면.
       * 실 어댑터는 bind **성공 이후**의 런타임 오류에서 서버를 닫으므로(lock-backend-uds.ts) 「보유자는
       * 살아있는데 이름은 공실」이 실재한다. 그 상태를 모르면 PR7 의 배선이 잃은 배타를 계속 가정하게 된다.
       */
      isHeld: () => !released && bound.isBound(),
      release(): ReleaseOutcome {
        if (released) return { status: 'not-owned', detail: '이미 해제된 핸들' }
        // 소유 확인이 **먼저**다. 회수당한 뒤의 지연 종료가 새 인스턴스의 레코드를 지우면 안 된다
        // (형제 계약 locks.ts 의 「내가 여전히 소유자일 때만 조작한다」와 같은 규율).
        // ⚠ 확인과 `unlink` 사이의 TOCTOU 창은 순수 Node 로 닫히지 않는다(레포 전역 한계 —
        // `path-guard.ts` 상단이 같은 성질을 명문화). 이 창은 **은폐하지 않는 잔여**다.
        const current = probeRecord(path)
        if (current.kind !== 'ok' || current.record.engineInstanceId !== opts.instanceId) {
          return finish({
            status: 'not-owned',
            detail:
              current.kind === 'ok'
                ? `레코드 소유자가 다름(${current.record.engineInstanceId})`
                : `레코드 없음·판독 불가(${current.kind})`,
          })
        }
        try {
          unlinkSync(path)
        } catch (err) {
          return finish({ status: 'removal-failed', detail: errText(err) })
        }
        return finish({ status: 'removed' })
      },
    }
  }
}

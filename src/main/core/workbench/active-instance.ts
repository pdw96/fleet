import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { InstanceMarkerSource } from './instance-marker'
import type { BoundEndpoint, LockBackend } from './locks'
import { endpointFor } from './locks'
import { isLinkSync } from '../workspace/path-guard'

/**
 * 인스턴스 배타 (#251 PR1c T5 · 스펙 §W-2-b ①) — **한 코디네이션 영역에 살아있는 엔진 인스턴스는 하나**.
 *
 * 이 계약은 편의 기능이 아니라 락 층(§W-3)의 **전제**다: 추상 소켓의 배타 범위는 network namespace 인데
 * 레포 공유 범위는 파일시스템이라, 인스턴스가 둘이면 두 축이 어긋나 이중 소유가 성립한다(locks.ts 상단 주석).
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

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : `알 수 없는 오류: ${String(err)}`

const isEexist = (err: unknown): boolean =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 캐스트를 리뷰에 보이게 두는 것 자체가 이 룰의 목적이다.
  (err as NodeJS.ErrnoException)?.code === 'EEXIST'

type RecordProbe =
  | { kind: 'missing' }
  | { kind: 'unusable'; detail: string }
  | { kind: 'ok'; record: ActiveInstanceRecord }

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
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
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
      detail: `${ACTIVE_INSTANCE_FILE} 필수 필드(engineInstanceId·instanceMarker) 누락`,
    }
  }
  return {
    kind: 'ok',
    record: {
      engineInstanceId: rec.engineInstanceId,
      instanceMarker: rec.instanceMarker,
      acquiredAt: typeof rec.acquiredAt === 'number' ? rec.acquiredAt : 0,
    },
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

  /** blocked 로 끝나는 모든 경로는 endpoint 를 놓는다 — 누수하면 다음 부팅이 자기 자신을 생존으로 오판한다. */
  const giveUp = (reason: ClaimBlockedReason, detail: string): InstanceClaim => {
    bound.close()
    return blocked(reason, detail)
  }

  const path = join(opts.areaRoot, ACTIVE_INSTANCE_FILE)
  const now = opts.now ?? Date.now
  const build = (): ActiveInstanceRecord => ({
    engineInstanceId: opts.instanceId,
    instanceMarker: marker.marker,
    acquiredAt: now(),
  })

  // ③ 발행. **유한 루프**(최대 2회)로 「발행 → 잔재면 판정 → 회수 → 재발행」을 한 경로에 둔다.
  // 재시도 상한이 계약이다 — 경합 상대가 계속 이기는 상황에서 무한 루프가 되면 부팅이 끝나지 않는다.
  let evidence: ReclaimEvidence | 'first-claim' = 'first-claim'
  for (let attempt = 0; attempt < 2; attempt++) {
    const published = publish(opts.areaRoot, build())
    if (published.kind === 'failed') {
      return giveUp('io-failure', `레코드 발행 실패: ${published.detail}`)
    }
    if (published.kind === 'published') return { status: 'claimed', handle: makeHandle(evidence) }

    // 잔재가 있다. 종류·판독·형태가 하나라도 어긋나면 **지우지 않고** 운영자에게 넘긴다.
    const probe = probeRecord(path)
    if (probe.kind === 'unusable') return giveUp('reconciliation-required', probe.detail)
    // 경합 상대가 이름을 방금 치웠다 — 판정할 잔재가 없으니 그대로 다시 발행을 시도한다.
    // ⚠ **마지막 회차에서는 잔재를 건드리지 않는다.** 그 시점에 보이는 레코드는 「죽은 인스턴스의 잔재」가
    // 아니라 **직전 회차 사이에 다른 회수자가 방금 발행한 것**일 수 있고, 지우면 승자의 레코드를 파괴한다.
    // 해제 측의 `not-owned` 규율(남의 것을 지우지 않는다)에 대응하는 획득 측 규율이다.
    if (probe.kind === 'ok' && attempt === 0) {
      evidence = decideReclaim(probe.record.instanceMarker, marker.marker)
      try {
        unlinkSync(path)
      } catch (err) {
        return giveUp('io-failure', `잔재 레코드 제거 실패: ${errText(err)}`)
      }
    }
  }
  // 상한까지 갔다 = 매번 다른 인스턴스가 먼저 발행했다. **덮어쓰지 않는다** — create-only 가 승자를 정한다.
  return giveUp('instance-active', '레코드 발행 경합에서 밀림 — 다른 인스턴스가 먼저 발행했음')

  function makeHandle(evidenceOf: ReclaimEvidence | 'first-claim'): InstanceHandle {
    return {
      marker: marker.status === 'ok' ? marker.marker : '',
      evidence: evidenceOf,
      release(): ReleaseOutcome {
        // 소유 확인이 **먼저**다. 회수당한 뒤의 지연 종료가 새 인스턴스의 레코드를 지우면 안 된다
        // (형제 계약 locks.ts 의 「내가 여전히 소유자일 때만 조작한다」와 같은 규율).
        const current = probeRecord(path)
        if (current.kind !== 'ok' || current.record.engineInstanceId !== opts.instanceId) {
          bound.close()
          return {
            status: 'not-owned',
            detail:
              current.kind === 'ok'
                ? `레코드 소유자가 다름(${current.record.engineInstanceId})`
                : `레코드 없음·판독 불가(${current.kind})`,
          }
        }
        try {
          unlinkSync(path)
        } catch (err) {
          bound.close()
          return { status: 'removal-failed', detail: errText(err) }
        }
        bound.close()
        return { status: 'removed' }
      },
    }
  }
}

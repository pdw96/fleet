import { createHash } from 'node:crypto'

/**
 * 인스턴스 마커 (#251 PR1c · 스펙 §W-2-b · §W-16 ②) — «기록자가 현 인스턴스인가»의 판정 성분.
 *
 * **이 파일은 플랫폼 무관 순수 층이다.** 실 `/proc` 리더는 `instance-marker-proc.ts`(Linux 전용 · 얇게)에
 * 있고, 소비자는 `InstanceMarkerSource` 주입 seam 뒤에서만 그것을 본다 — 그래야 인스턴스 배타 계약 전량이
 * **양 OS 에서** 페이크로 실행된다(계획 §3.1 대응 ⓐ · 정정 ㊷). 마커 산출 자체가 옳은지는
 * `instance-marker-proc.test.ts` 의 「테스트가 `/proc` 를 독립 재계산해 동치 단언」 행이 본다.
 *
 * **성분이 3개인 이유**(계획 정정 ㊶ · 스펙 §0.1 C8 문면 정정): 스펙 원문의 2성분
 * `sha256(bootId:pid1StartTicks)` 는 **단사가 아니다** — `starttime` 은 USER_HZ(10ms) 해상도라 같은
 * 호스트에서 동시에 뜬 두 컨테이너가 같은 값을 갖는다(실측: 8기 병렬 기동에서 2쌍 충돌). 그러면 스펙이
 * 주장한 «마커 일치 = 같은 PID 네임스페이스» 가 거짓이 된다. PID ns inode 를 넣으면 동시 기동이 갈리고
 * (실측 4026532386 ≠ 4026532686), 같은 컨테이너 재기동은 ino 가 **재사용**되더라도 `starttime` 이 전진해
 * 갈린다(실측 276512 → 277800) — 두 축이 서로의 사각을 정확히 덮는다.
 *
 * ⚠ **마커는 유일성 보장이 아니라 신원 판정 성분이다.** 「두 인스턴스는 반드시 다른 마커를 갖는다」를
 * 불변식으로 단언하지 않는다(부하 중 flaky). 마커는 **회수 증거의 등급**을 정하고, 회수 여부 자체는
 * 커널 endpoint 가 정한다(§W-3 L-1: 연령·pid 는 소유 근거가 아니다).
 */

/** `/proc/sys/kernel/random/boot_id` 형태 — 소문자 hex UUID 36자. 정규화하지 않고 **거부**한다. */
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** 0 은 «읽기 실패의 조용한 대체값» 과 구분되지 않으므로 유효값에서 뺀다. */
const POSITIVE_INT_RE = /^\d+$/

export interface MarkerComponents {
  readonly bootId: string
  readonly pid1StartTicks: string
  readonly pidNsIno: string
}

export type MarkerRead =
  | { readonly status: 'ok'; readonly marker: string }
  /** 유도 불가·형태 위반 — 호출자는 fail-closed 로 분기한다(조용한 상수 축퇴 금지). */
  | { readonly status: 'unavailable'; readonly detail: string }

/**
 * 마커 소스 주입 seam. 실 구현은 `createProcMarkerSource()`(Linux), 테스트는 고정값 페이크.
 * **동기**인 이유: 부팅 경로에서 어떤 부수효과보다 먼저 판정돼야 하고, `/proc` 읽기는 블로킹 I/O 가 아니다.
 */
export interface InstanceMarkerSource {
  read(): MarkerRead
}

/**
 * `/proc/1/stat` 의 **22번째 필드(starttime)** 파싱.
 *
 * ⚠ 공백 split 로 22번째를 집는 고전 구현은 **comm 에 괄호·공백이 있으면 조용히 틀린 값**을 준다.
 * 그런데 프로덕션 PID1 은 compose `init: true` 의 `docker-init` 이라 공백이 없어서, **실 컨테이너로만
 * 검증하면 naive 구현도 통과한다**(실측: 양쪽 다 264972). 그래서 커널 포맷대로 **마지막 `)` 기준**으로
 * comm 을 잘라내고, 나머지 필드 수(정상 50)를 함께 검사한다 — 이 규칙의 falsifier 는 실 `/proc` 가 아니라
 * 적대적 comm 픽스처다(`instance-marker.test.ts`).
 */
export function parsePid1StartTicks(raw: string): string | undefined {
  const close = raw.lastIndexOf(')')
  if (close < 0) return undefined
  const rest = raw
    .slice(close + 1)
    .trim()
    .split(/ +/)
  // 필드 3~52 = 50개. 짧으면 잘린 읽기(=`/proc` 를 길이 힌트로 읽은 구현)이므로 값을 만들지 않는다.
  if (rest.length < 50) return undefined
  const ticks = rest[19]
  if (ticks === undefined || !POSITIVE_INT_RE.test(ticks) || ticks === '0') return undefined
  return ticks
}

/**
 * 3성분 → 마커. **형태 검증이 여기 있는 이유**: `/proc` 파일은 `statSync().size === 0` 을 보고하므로
 * 길이 힌트로 읽는 구현은 빈 문자열을 얻고, 그것이 그대로 해시에 들어가면 **모든 인스턴스의 마커가 같아지는
 * 상수 축퇴**(fail-open)가 된다. throw 가 아니라 값으로 보고한다(판별 유니온 반환 원칙 · §W-4).
 */
export function composeMarker(components: MarkerComponents): MarkerRead {
  const { bootId, pid1StartTicks, pidNsIno } = components
  if (!BOOT_ID_RE.test(bootId)) {
    return { status: 'unavailable', detail: `boot_id 형태 위반: ${JSON.stringify(bootId)}` }
  }
  for (const [label, value] of [
    ['pid1 starttime', pid1StartTicks],
    ['PID ns inode', pidNsIno],
  ] as const) {
    if (!POSITIVE_INT_RE.test(value) || value === '0') {
      return { status: 'unavailable', detail: `${label} 형태 위반: ${JSON.stringify(value)}` }
    }
  }
  // 구분자 `:` 는 성분 경계다 — 빼면 (11,2233) 과 (1122,33) 이 같은 마커로 붕괴한다.
  const marker = createHash('sha256')
    .update(`${bootId}:${pid1StartTicks}:${pidNsIno}`)
    .digest('hex')
  return { status: 'ok', marker }
}

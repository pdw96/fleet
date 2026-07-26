import { readFileSync, statSync } from 'node:fs'

import type { InstanceMarkerSource, MarkerRead } from './instance-marker'
import { composeMarker, parsePid1StartTicks } from './instance-marker'

/**
 * 실 인스턴스 마커 소스 (#251 PR1c T5 · Linux) — `/proc` 3성분 리더.
 *
 * **의도적으로 얇다.** 이 파일의 실행 행은 Linux 에서만 도달하므로 개발자 win32 로컬 커버리지의 분모에만
 * 들어간다(§3.1 대응 ⓐ). 파싱·형태 검증·합성은 전부 `instance-marker.ts` 에 있고 양 OS 에서 돌기 때문에,
 * 여기 남는 것은 **커널 인터페이스 접근과 오류 매핑뿐**이어야 한다(`lock-backend-uds.ts` 와 같은 형태).
 *
 * 실측 근거(Docker · `--user 1000:1000` · 기본 seccomp):
 *   - 세 경로 전부 비특권 읽기 가능(`boot_id` · `/proc/1/stat` · `statSync('/proc/self/ns/pid').ino`)
 *   - `/proc` 파일의 `statSync().size` 는 **0** → 길이 힌트 기반 읽기는 빈 문자열(그래서 `readFileSync` 단독)
 *   - 동시 두 컨테이너의 PID ns ino 상이(4026532386 ≠ 4026532686) · `docker restart` 는 ino 재사용이지만
 *     `/proc/1/stat` f22 는 전진(276512 → 277800)
 */

/** 호스트 부팅 신원. 컨테이너 재기동으로 바뀌지 않는다(호스트 값 — 실측). */
export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'
/** PID1 의 `starttime`(22번째 필드) 출처. 컨테이너 인스턴스마다 전진한다. */
export const PID1_STAT_PATH = '/proc/1/stat'
/** PID 네임스페이스 신원. 동시 기동한 두 컨테이너를 가른다. */
export const PID_NS_PATH = '/proc/self/ns/pid'
/**
 * network 네임스페이스 신원 — **배타(커널 endpoint)의 실제 스코프**와 마커 축을 일치시킨다.
 * 실측: 같은 컨테이너의 두 프로세스는 동일(4026532388) · `--pid=container:X` 로 PID ns 만 공유하면
 * 앞 3성분이 전부 같고 **이 값만 다르다**(4026532687) — 그 구성을 가르는 유일한 성분이다.
 */
export const NET_NS_PATH = '/proc/self/ns/net'

export function createProcMarkerSource(): InstanceMarkerSource {
  return {
    read(): MarkerRead {
      // ⚠ 플랫폼 판정은 `process.platform` 으로 한다 — win32 에서 POSIX 절대경로는 **현재 드라이브 상대**로
      // 해석되므로(`/proc/x` → `C:\proc\x`) 파일 존재 검사는 판정 근거가 될 수 없다(실측 · 정정 ㊸).
      // `availableLockBackends`(locks.ts)와 같은 형태다.
      if (process.platform !== 'linux') {
        return { status: 'unavailable', detail: `인스턴스 마커는 Linux 전용(${process.platform})` }
      }
      try {
        const bootId = readFileSync(BOOT_ID_PATH, 'utf8').trim()
        const ticks = parsePid1StartTicks(readFileSync(PID1_STAT_PATH, 'utf8'))
        const pidNsIno = String(statSync(PID_NS_PATH).ino)
        const netNsIno = String(statSync(NET_NS_PATH).ino)
        // 파싱 실패는 빈 문자열로 넘겨 **형태 검증 한 곳**에서 걸리게 한다(사유 문자열 중복 금지).
        return composeMarker({ bootId, pid1StartTicks: ticks ?? '', pidNsIno, netNsIno })
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return { status: 'unavailable', detail: `/proc 읽기 실패: ${detail}` }
      }
    },
  }
}

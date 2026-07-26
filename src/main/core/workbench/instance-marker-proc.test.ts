import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createProcMarkerSource } from './instance-marker-proc'

/**
 * #251 PR1c T5 — 실 `/proc` 마커 소스(Linux 게이트 · 계획 정정 ㊷ 「산출 동치」 행).
 *
 * **왜 이 파일이 필요한가**: 판정 4분기는 페이크 마커로 양 OS 에서 돌지만, 그러면 「마커를 실제로
 * 읽는다」와 「성분이 옳다」가 **어느 단언으로도 검증되지 않는다** — 상수를 돌려주는 구현이 4분기 전부를
 * GREEN 통과한다. 그래서 여기서는 **테스트가 `/proc` 를 독립 재계산**해 모듈 산출값과 대조한다.
 *
 * ⚠ 경로를 모듈에서 import 하지 않고 **리터럴로 다시 적는 것이 계약**이다. 같은 상수를 공유하면 성분
 * 순서 교체·경로 오지정이 양쪽에 똑같이 반영돼 대조가 무력해진다. 대신 그 리터럴이 모듈 소스에 실재함을
 * `active-instance-structure.test.ts` 가 앵커로 고정한다.
 */

const IS_LINUX = process.platform === 'linux'

describe.skipIf(!IS_LINUX)('실 /proc 마커 — 독립 재계산 동치(Linux)', () => {
  it('모듈 산출값이 테스트의 독립 재계산과 정확히 같다', () => {
    const raw = readFileSync('/proc/1/stat', 'utf8')
    const rest = raw
      .slice(raw.lastIndexOf(')') + 1)
      .trim()
      .split(/ +/)
    const expected = createHash('sha256')
      .update(
        [
          readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          rest[19],
          String(statSync('/proc/self/ns/pid').ino),
          String(statSync('/proc/self/ns/net').ino),
        ].join(':'),
      )
      .digest('hex')

    const got = createProcMarkerSource().read()
    expect(got.status).toBe('ok')
    expect(got.status === 'ok' && got.marker).toBe(expected)
  })

  it('같은 프로세스에서 두 번 읽으면 같다(마커는 인스턴스 수명 동안 안정)', () => {
    const src = createProcMarkerSource()
    const a = src.read()
    const b = src.read()
    expect(a).toEqual(b)
    expect(a.status).toBe('ok')
  })
})

describe.skipIf(IS_LINUX)('비-Linux 표면 — 마커 유도 불가(fail-closed)', () => {
  it('unavailable 을 값으로 보고한다(throw 아님)', () => {
    const got = createProcMarkerSource().read()
    expect(got.status).toBe('unavailable')
    expect(got.status === 'unavailable' && got.detail).toMatch(/Linux/)
  })
})

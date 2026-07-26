import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { composeMarker, parsePid1StartTicks } from './instance-marker'

/**
 * #251 PR1c T5 — 인스턴스 마커 성분의 **순수** 층(§W-2-b · 계획 정정 ㊶·㊷·㊸).
 *
 * 이 파일이 양 OS 에서 도는 것이 계약이다. 실 `/proc` 리더는 `instance-marker-proc.ts`(Linux 게이트)에
 * 있고, 여기서 검증하는 것은 **파싱·형태 검증·합성 규칙**뿐이다 — 그래야 win32 로컬 verify 와 ubuntu CI 가
 * 같은 신호를 낸다(계획 §3.1 대응 ⓐ).
 */

/**
 * `/proc/1/stat` 픽스처. 실 커널 포맷 = `pid (comm) state ...` 이고 **starttime 은 22번째 필드**다.
 * comm 을 잘라낸 나머지에서 인덱스 19 가 그것이다(실측: 컨테이너에서 나머지 길이 50 · 필드 3~52).
 */
const makeStat = (comm: string, ticks: string, restLen = 50): string => {
  const rest = Array.from({ length: restLen }, (_, i) => String(i + 100))
  rest[19] = ticks
  return `1 (${comm}) ${rest.join(' ')}\n`
}

describe('parsePid1StartTicks — 22번째 필드(starttime)', () => {
  it('정상 comm 에서 starttime 을 뽑는다', () => {
    expect(parsePid1StartTicks(makeStat('docker-init', '276512'))).toBe('276512')
  })

  /**
   * **이 행이 파서의 유일한 양성 통제다**(계획 정정 ㊸). 프로덕션 PID1 은 compose `init: true` 의
   * `docker-init` 이라 공백·괄호가 없고, 그래서 **실 컨테이너로만 검증하면 naive 구현도 통과한다**
   * (실측: naive `split(/\s+/)[21]` 와 정답이 양쪽 다 264972). 적대적 comm 을 먹여야 비로소 갈린다.
   */
  it('comm 에 괄호·공백이 있어도 정확하다(naive split 구현이 여기서 RED)', () => {
    const raw = makeStat('ev) (il', '999123')
    expect(parsePid1StartTicks(raw)).toBe('999123')
    // 대조: 흔한 naive 구현은 같은 입력에서 다른 값을 낸다 = 이 픽스처가 실제로 구분력을 갖는다.
    expect(raw.split(/\s+/)[21]).not.toBe('999123')
  })

  it.each([
    ['괄호 없음', '1 docker-init S 0 1'],
    ['필드 부족', makeStat('docker-init', '5', 30)],
    ['starttime 이 숫자가 아님', makeStat('docker-init', 'x5')],
    ['starttime 이 0', makeStat('docker-init', '0')],
    ['빈 문자열', ''],
  ])('%s 이면 undefined(조용한 오답 금지)', (_label, raw) => {
    expect(parsePid1StartTicks(raw)).toBeUndefined()
  })
})

describe('composeMarker — 3성분 합성 · 형태 검증', () => {
  const ok = {
    bootId: '49fe4c5b-c490-4123-b866-ee40cbe8ebd6',
    pid1StartTicks: '276512',
    pidNsIno: '4026532386',
    netNsIno: '4026532388',
  }

  it('네 성분의 sha256(콜론 구분)을 준다', () => {
    const got = composeMarker(ok)
    expect(got.status).toBe('ok')
    expect(got.status === 'ok' && got.marker).toBe(
      createHash('sha256')
        .update(`${ok.bootId}:${ok.pid1StartTicks}:${ok.pidNsIno}:${ok.netNsIno}`)
        .digest('hex'),
    )
  })

  /**
   * **왜 3성분인가**(계획 정정 ㊶): `bootId:ticks` 2성분은 단사가 아니다 — starttime 은 USER_HZ(10ms)
   * 해상도라 같은 호스트에서 동시에 뜬 두 컨테이너가 **같은 마커**를 갖는다(감사 실측: 8기 병렬에서 2쌍
   * 충돌). PID 네임스페이스 ino 를 넣으면 동시 기동이 갈리고(실측: 4026532386 ≠ 4026532686),
   * 재기동은 ino 가 재사용되더라도 ticks 가 전진해 갈린다(실측: 276512 → 277800). 두 축이 서로의 사각을 덮는다.
   */
  it.each([
    ['bootId', { ...ok, bootId: '00000000-0000-0000-0000-000000000000' }],
    ['pid1StartTicks', { ...ok, pid1StartTicks: '277800' }],
    ['pidNsIno', { ...ok, pidNsIno: '4026532686' }],
    ['netNsIno', { ...ok, netNsIno: '4026532687' }],
  ])('%s 하나만 달라도 마커가 달라진다', (_label, other) => {
    const a = composeMarker(ok)
    const b = composeMarker(other)
    expect(a.status === 'ok' && b.status === 'ok' && a.marker !== b.marker).toBe(true)
  })

  /** 성분 경계가 흐려지면 다른 성분 조합이 같은 문자열로 붕괴한다(구분자 누락 계열 회귀). */
  it('성분 경계가 붕괴하지 않는다(구분자 누락 구현이 RED)', () => {
    const a = composeMarker({ ...ok, pid1StartTicks: '11', pidNsIno: '2233' })
    const b = composeMarker({ ...ok, pid1StartTicks: '1122', pidNsIno: '33' })
    expect(a.status === 'ok' && b.status === 'ok' && a.marker !== b.marker).toBe(true)
  })

  /**
   * **배타 범위와 마커 축의 일치**(Codex PR#262 P1 · 실측). 「PID ns 공유 + net ns 분리」 구성에서는
   * 앞 3성분이 전부 같다(pidns 4026532386 동일 · PID1 이 같으니 f22 도 동일). 그때 침입자가 자기 net ns
   * 에서 bind 에 성공하면 **살아있는** 소유자를 `kernel-proven` 으로 회수하게 된다 — net ns 성분이
   * 그 구성을 가르는 유일한 축이다. 반대로 같은 컨테이너(같은 net ns)의 일치는 그대로 유지돼야 한다.
   */
  it('PID ns 공유 + net ns 분리는 마커가 갈린다(살아있는 소유자 오판 차단)', () => {
    const owner = composeMarker(ok)
    const intruder = composeMarker({ ...ok, netNsIno: '4026532687' })
    expect(
      owner.status === 'ok' && intruder.status === 'ok' && owner.marker !== intruder.marker,
    ).toBe(true)
  })

  it('같은 컨테이너의 두 프로세스는 같은 마커다(kernel-proven 경로 보존)', () => {
    expect(composeMarker(ok)).toEqual(composeMarker({ ...ok }))
  })

  /**
   * `/proc` 파일은 `statSync().size === 0` 을 보고하므로(실측) 길이 힌트로 읽는 구현은 **빈 문자열**을
   * 얻는다. 그 값이 그대로 sha256 에 들어가면 **모든 인스턴스의 마커가 같아지는 상수 축퇴**(fail-open)다.
   * 형태 검증이 그 축퇴를 값으로 거부한다 — throw 가 아니라 `unavailable`(판별 유니온 반환 원칙).
   */
  it.each([
    ['bootId 빈 문자열', { ...ok, bootId: '' }],
    ['bootId 길이 부족', { ...ok, bootId: '49fe4c5b-c490-4123-b866-ee40cbe8eb' }],
    ['bootId 대문자', { ...ok, bootId: '49FE4C5B-C490-4123-B866-EE40CBE8EBD6' }],
    ['bootId 하이픈 위치 이상', { ...ok, bootId: '49fe4c5bc490-4123-b866-ee40cbe8ebd67' }],
    ['ticks 빈 문자열', { ...ok, pid1StartTicks: '' }],
    ['ticks 0', { ...ok, pid1StartTicks: '0' }],
    ['ticks 비숫자', { ...ok, pid1StartTicks: '12a' }],
    ['pid ns ino 빈 문자열', { ...ok, pidNsIno: '' }],
    ['pid ns ino 0', { ...ok, pidNsIno: '0' }],
    ['pid ns ino 비숫자', { ...ok, pidNsIno: '40e6' }],
    ['net ns ino 빈 문자열', { ...ok, netNsIno: '' }],
    ['net ns ino 0', { ...ok, netNsIno: '0' }],
    ['net ns ino 비숫자', { ...ok, netNsIno: '40e6' }],
  ])('%s 이면 unavailable(상수 축퇴 금지)', (_label, bad) => {
    const got = composeMarker(bad)
    expect(got.status).toBe('unavailable')
    expect(got.status === 'unavailable' && got.detail.length).toBeGreaterThan(0)
  })
})

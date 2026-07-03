import { describe, expect, it } from 'vitest'
import { decodeFrame, hasEventGap, makeErrFrame, makeOkFrame } from './protocol'

/**
 * WS 프레임 프로토콜 순수 헬퍼(#197 B2). Electron IPC 가 암묵 제공하던 직렬화·응답·gap 감지
 * 시맨틱을 명시 계약으로 고정한다 — 특히 `undefined`(void) 반환 정책과 rotation gap 판정 경계.
 */
describe('res 프레임 생성 (makeOkFrame / makeErrFrame)', () => {
  it('값 있는 성공은 value 를 싣는다', () => {
    expect(makeOkFrame(7, { a: 1 })).toEqual({ t: 'res', id: 7, ok: true, value: { a: 1 } })
  })

  it('void(undefined) 반환은 value 키를 생략한다 (프로토콜 고정 정책)', () => {
    const frame = makeOkFrame(3, undefined)
    expect(frame).toEqual({ t: 'res', id: 3, ok: true })
    expect('value' in frame).toBe(false)
  })

  it('null 은 정당한 값이라 생략하지 않는다 (undefined 와 구분)', () => {
    const frame = makeOkFrame(4, null)
    expect(frame).toEqual({ t: 'res', id: 4, ok: true, value: null })
    expect('value' in frame).toBe(true)
  })

  it('에러 프레임은 message 만 싣고 스택을 노출하지 않는다', () => {
    const frame = makeErrFrame(9, 'boom')
    expect(frame).toEqual({ t: 'res', id: 9, ok: false, error: { message: 'boom' } })
    expect(JSON.stringify(frame)).not.toContain('stack')
  })
})

describe('decodeFrame — 와이어 문자열 안전 파싱', () => {
  it('유효한 res/push/hello 를 타입 객체로 되돌린다', () => {
    expect(decodeFrame(JSON.stringify(makeOkFrame(1, 'x')))).toEqual({
      t: 'res',
      id: 1,
      ok: true,
      value: 'x',
    })
    expect(decodeFrame('{"t":"push","ch":"fleet:chat:stream","event":{"kind":"idle"}}')).toEqual({
      t: 'push',
      ch: 'fleet:chat:stream',
      event: { kind: 'idle' },
    })
    expect(decodeFrame('{"t":"hello","maxEventSeq":12,"minRetainedEventSeq":3}')).toEqual({
      t: 'hello',
      maxEventSeq: 12,
      minRetainedEventSeq: 3,
    })
  })

  it('void 성공 프레임 왕복 후 value 는 부재(undefined)다', () => {
    const wire = JSON.stringify(makeOkFrame(2, undefined))
    const decoded = decodeFrame(wire)
    expect(decoded).toEqual({ t: 'res', id: 2, ok: true })
    expect(decoded && 'value' in decoded).toBe(false)
  })

  it('깨진 JSON·미지 프레임·비객체는 null 을 반환한다', () => {
    expect(decodeFrame('not json{')).toBeNull()
    expect(decodeFrame('{"t":"unknown"}')).toBeNull()
    expect(decodeFrame('{"no":"t"}')).toBeNull()
    expect(decodeFrame('42')).toBeNull()
    expect(decodeFrame('null')).toBeNull()
    expect(decodeFrame('"str"')).toBeNull()
  })
})

describe('hasEventGap — rotation 폐기 구간 감지', () => {
  it('아무것도 폐기되지 않았으면 갭이 없다', () => {
    // 신규 클라(cursor 0), 보존 최소 1 = 폐기 0.
    expect(hasEventGap(0, { minRetainedEventSeq: 1 })).toBe(false)
    // 커서가 보존 최소 직전(다음 필요 seq = minRetained)이면 갭 없음.
    expect(hasEventGap(100, { minRetainedEventSeq: 101 })).toBe(false)
  })

  it('커서 다음 seq 가 보존 최소보다 작으면 갭이다 (강제 재하이드레이션)', () => {
    // 신규 클라(cursor 0)인데 1~4 가 이미 폐기(보존 최소 5) → 갭.
    expect(hasEventGap(0, { minRetainedEventSeq: 5 })).toBe(true)
    // 커서 100, 101~130 폐기(보존 최소 131) → 갭.
    expect(hasEventGap(100, { minRetainedEventSeq: 131 })).toBe(true)
  })
})

describe('decodeFrame — 프레임별 필드 불변식(신뢰 경계 완성)', () => {
  // 판별자 t 만 통과시키면 하류(handleMessage)가 무검증 역참조로 crash·영구 hang 한다(#197 B2 리뷰 P2).
  it('res: id 비수치·ok 비boolean·ok=false 시 error.message 부재를 null 로 떨군다', () => {
    expect(decodeFrame('{"t":"res","id":"x","ok":true}')).toBeNull() // id 비수치
    expect(decodeFrame('{"t":"res","id":1,"ok":"false"}')).toBeNull() // ok 비boolean(truthy 문자열)
    expect(decodeFrame('{"t":"res","id":1}')).toBeNull() // ok 부재
    expect(decodeFrame('{"t":"res","id":1,"ok":false}')).toBeNull() // error 부재
    expect(decodeFrame('{"t":"res","id":1,"ok":false,"error":{}}')).toBeNull() // error.message 부재
    expect(decodeFrame('{"t":"res","id":1,"ok":false,"error":{"message":5}}')).toBeNull() // message 비문자열
  })

  it('res: 정상 ok/err 프레임은 통과한다', () => {
    expect(decodeFrame('{"t":"res","id":1,"ok":true}')).toEqual({ t: 'res', id: 1, ok: true })
    expect(decodeFrame('{"t":"res","id":1,"ok":true,"value":null}')).toEqual({
      t: 'res',
      id: 1,
      ok: true,
      value: null,
    })
    expect(decodeFrame('{"t":"res","id":1,"ok":false,"error":{"message":"boom"}}')).toEqual({
      t: 'res',
      id: 1,
      ok: false,
      error: { message: 'boom' },
    })
  })

  it('push: ch 비문자열/부재를 null 로 떨군다', () => {
    expect(decodeFrame('{"t":"push","event":{}}')).toBeNull()
    expect(decodeFrame('{"t":"push","ch":5,"event":{}}')).toBeNull()
    expect(decodeFrame('{"t":"push","ch":"fleet:x","event":1}')).toEqual({
      t: 'push',
      ch: 'fleet:x',
      event: 1,
    })
  })

  it('hello: seq 비정수/부재를 null 로 떨군다(missed-gap 방지)', () => {
    expect(decodeFrame('{"t":"hello","maxEventSeq":"5","minRetainedEventSeq":1}')).toBeNull()
    expect(decodeFrame('{"t":"hello","minRetainedEventSeq":1}')).toBeNull() // max 부재
    expect(decodeFrame('{"t":"hello","maxEventSeq":5.5,"minRetainedEventSeq":1}')).toBeNull() // 비정수
    expect(decodeFrame('{"t":"hello","maxEventSeq":5,"minRetainedEventSeq":1}')).toEqual({
      t: 'hello',
      maxEventSeq: 5,
      minRetainedEventSeq: 1,
    })
  })
})

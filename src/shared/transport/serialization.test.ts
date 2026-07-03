import { describe, expect, it } from 'vitest'
import { invokeChannels } from './channels'
import { CHANNEL_FIXTURES } from './fixtures'
import { makeOkFrame } from './protocol'

/**
 * 채널 직렬화 계약(#197 B2). "채널 존재 parity"(bridge-parity)만으론 계약 parity 가 닫히지 않는다 —
 * WS 는 Electron IPC 의 structuredClone 대신 JSON 을 쓰므로 Error/Date/class instance/undefined 의
 * 직렬화가 갈린다. 각 both invoke 채널의 대표 args/result 를 JSON 왕복시켜 와이어 안전성을 핀하고,
 * void 반환은 프로토콜 정책(value 생략)으로 고정한다. 런타임 스키마 validator 는 비범위(fixture 로 대체).
 */
describe('채널 직렬화 fixture parity', () => {
  it('모든 both invoke 채널에 fixture 가 있다(신규 채널 = 강제 추가)', () => {
    expect(Object.keys(CHANNEL_FIXTURES).sort()).toEqual(invokeChannels('both'))
  })

  it('모든 fixture 의 args 는 JSON 왕복에 불변이다(직렬화 안전)', () => {
    for (const [ch, fx] of Object.entries(CHANNEL_FIXTURES)) {
      expect(JSON.parse(JSON.stringify(fx.args)), ch).toEqual(fx.args)
    }
  })

  it('값 반환 채널의 result 는 JSON 왕복에 불변, void 채널은 value 를 생략한다', () => {
    for (const [ch, fx] of Object.entries(CHANNEL_FIXTURES)) {
      if (fx.result === undefined) {
        const frame = makeOkFrame(1, fx.result)
        expect('value' in frame, ch).toBe(false)
      } else {
        expect(JSON.parse(JSON.stringify(fx.result)), ch).toEqual(fx.result)
      }
    }
  })

  it('왕복 검사는 비-JSON-safe 값(Date·NaN)을 실제로 잡는다(가드 유효성)', () => {
    // Date → ISO 문자열로 변질 → 불일치.
    const withDate = { d: new Date(0) }
    expect(JSON.parse(JSON.stringify(withDate))).not.toEqual(withDate)
    // NaN → null 로 변질 → 불일치.
    const withNaN = { n: NaN }
    expect(JSON.parse(JSON.stringify(withNaN))).not.toEqual(withNaN)
    // (참고: undefined 값 키는 JSON 에서 소실되지만 toEqual 은 부재 optional 과 동치로 봐 통과 —
    //  이는 와이어 계약상 올바른 동치라 fixture 검사가 이를 실패로 보지 않는 것이 정상이다.)
  })
})

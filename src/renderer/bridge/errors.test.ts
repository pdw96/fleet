import { describe, expect, it } from 'vitest'
import { TransportError } from './ws-bridge'
import { describeError } from './errors'

describe('describeError(#197 B4)', () => {
  it('전송 단절(disconnected/closed)은 "결과 미확인·자동 복원" 문구로', () => {
    expect(describeError(new TransportError('disconnected', 'x'))).toMatch(/재접속.*복원/)
    expect(describeError(new TransportError('closed', 'x'))).toMatch(/재접속.*복원/)
  })
  it('timeout 은 재시도 안내로', () => {
    expect(describeError(new TransportError('timeout', 'x'))).toMatch(/시간 초과/)
  })
  it('일반 Error 는 message 그대로', () => {
    expect(describeError(new Error('엔진 거부'))).toBe('엔진 거부')
  })
  it('비 Error 값은 String()', () => {
    expect(describeError('오류')).toBe('오류')
  })
})

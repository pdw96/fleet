import { describe, expect, it } from 'vitest'
import { createEnvKeyCrypto, parseSecretKey } from './env-key-crypto'

const HEX_KEY = 'a'.repeat(64)
const B64_KEY = Buffer.alloc(32, 7).toString('base64')

describe('parseSecretKey', () => {
  it('64자 hex → 32바이트', () => {
    expect(parseSecretKey(HEX_KEY)?.length).toBe(32)
  })
  it('32바이트 base64 → 32바이트', () => {
    expect(parseSecretKey(B64_KEY)?.length).toBe(32)
  })
  it.each([undefined, '', 'short', 'g'.repeat(64), Buffer.alloc(16).toString('base64')])(
    '부재/형식 오류(%s) → null',
    (raw) => {
      expect(parseSecretKey(raw)).toBeNull()
    },
  )
})

describe('createEnvKeyCrypto — AES-256-GCM(#197 B3)', () => {
  const crypto = createEnvKeyCrypto({ FLEET_SECRET_KEY: HEX_KEY })

  it('키 유효 → isAvailable true, 왕복 성공', () => {
    expect(crypto.isAvailable()).toBe(true)
    const token = crypto.encrypt('sk-api-키-비밀')
    expect(token.startsWith('ev1:')).toBe(true)
    expect(token).not.toContain('sk-api')
    expect(crypto.decrypt(token)).toBe('sk-api-키-비밀')
  })

  it('IV 랜덤 — 같은 평문도 매번 다른 암호문', () => {
    expect(crypto.encrypt('x')).not.toBe(crypto.encrypt('x'))
  })

  it('변조된 암호문 → throw (GCM 인증 실패)', () => {
    const token = crypto.encrypt('secret')
    const buf = Buffer.from(token.slice(4), 'base64')
    buf[buf.length - 1] ^= 0xff
    expect(() => crypto.decrypt('ev1:' + buf.toString('base64'))).toThrow()
  })

  it('다른 키로 decrypt → throw', () => {
    const other = createEnvKeyCrypto({ FLEET_SECRET_KEY: 'b'.repeat(64) })
    expect(() => other.decrypt(crypto.encrypt('secret'))).toThrow()
  })

  it('미지 prefix(safeStorage v1: 등) → 명시 throw', () => {
    expect(() => crypto.decrypt('v1:abcd')).toThrow(/포맷/)
  })

  it('키 부재 → isAvailable false, encrypt/decrypt throw', () => {
    const none = createEnvKeyCrypto({})
    expect(none.isAvailable()).toBe(false)
    expect(() => none.encrypt('x')).toThrow()
    expect(() => none.decrypt('ev1:xx')).toThrow()
  })
})

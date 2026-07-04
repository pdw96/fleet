import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretCrypto } from '../main/core/secret/types'

// 암호문 포맷 버전 — safeStorage 어댑터의 'v1:' 과 구분(포맷 혼동 시 decrypt 가 명시 throw).
const PREFIX = 'ev1:'
const IV_LEN = 12 // GCM 권장 96-bit
const TAG_LEN = 16

/** FLEET_SECRET_KEY 파싱 — 64자 hex 또는 32바이트 base64 만 유효. 그 외 null(미가용 강등). */
export function parseSecretKey(raw: string | undefined): Buffer | null {
  if (!raw) return null
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  const b = Buffer.from(raw, 'base64')
  return b.length === 32 ? b : null
}

/**
 * 서버용 SecretCrypto(#197 B3) — safeStorage(Electron OS 키체인) 대체 어댑터. 컨테이너엔 OS 키체인이
 * 없으므로 AES-256-GCM + env 키(FLEET_SECRET_KEY)로 API 키를 암호화 영속한다. 키 소스는 env 만
 * (파일/볼륨 로딩 금지 — 이슈 #197 B3). 키 부재/형식 오류는 isAvailable=false → 코어가 시크릿을
 * 영속하지 않는 안전 강등(NOOP_CRYPTO 동형). 포맷: ev1: + base64(iv(12) | tag(16) | ciphertext).
 */
export function createEnvKeyCrypto(env: NodeJS.ProcessEnv): SecretCrypto {
  const key = parseSecretKey(env['FLEET_SECRET_KEY'])
  const requireKey = (): Buffer => {
    if (!key) throw new Error('FLEET_SECRET_KEY 미설정/형식 오류(64자 hex 또는 32바이트 base64)')
    return key
  }
  return {
    isAvailable: () => key !== null,
    encrypt(plain) {
      const iv = randomBytes(IV_LEN)
      const cipher = createCipheriv('aes-256-gcm', requireKey(), iv)
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
    },
    decrypt(token) {
      if (!token.startsWith(PREFIX)) throw new Error('알 수 없는 암호문 포맷')
      const buf = Buffer.from(token.slice(PREFIX.length), 'base64')
      const decipher = createDecipheriv('aes-256-gcm', requireKey(), buf.subarray(0, IV_LEN))
      decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN))
      const ct = buf.subarray(IV_LEN + TAG_LEN)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    },
  }
}

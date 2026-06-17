// src/main/secret-crypto.ts
import { safeStorage } from 'electron'
import type { SecretCrypto } from './core/secret/types'

// 암호문 포맷 버전 — 향후 async safeStorage(Electron 41/42)나 다른 backend 이전 시 마이그레이션 식별자.
const V1 = 'v1:'

/**
 * Electron safeStorage 기반 SecretCrypto(동기). Electron 33 은 동기 API 만 제공한다.
 * (encryptStringAsync 등 async 변형은 최신 Electron 전용 — 33→42 업그레이드 후속.)
 * 코어가 electron 을 import 하지 않도록 어댑터를 main 에 둔다(engine 에 주입).
 */
export function createSafeStorageCrypto(): SecretCrypto {
  return {
    isAvailable() {
      try {
        if (!safeStorage.isEncryptionAvailable()) return false
        // Linux 키링 부재 시 basic_text(평문 폴백)는 실보호가 0 → 미사용 취급(secure-by-default).
        // mac(Keychain)/win(DPAPI)은 항상 실암호화.
        return (
          process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
        )
      } catch {
        return false
      }
    },
    encrypt(plain) {
      return V1 + safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(token) {
      if (!token.startsWith(V1)) throw new Error('알 수 없는 암호문 포맷')
      return safeStorage.decryptString(Buffer.from(token.slice(V1.length), 'base64'))
    },
  }
}

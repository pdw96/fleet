// src/main/core/secret/types.ts
/**
 * 시크릿 암복호화 포트. 코어는 safeStorage(electron)를 직접 import 하지 않고(AGENTS.md: 코어 Electron 비의존)
 * main 이 백엔드를 주입한다(store/http/approver 주입과 동일 패턴). Electron 33 은 동기 safeStorage 만
 * 제공하므로 동기 계약이다(async 변형은 후속 Electron·후속 PR — 버전 프리픽스로 마이그레이션 호환).
 */
export interface SecretCrypto {
  /** OS 암호화 가용 여부(win=DPAPI 상시·mac=Keychain·linux=keyring+ready). false 면 시크릿 미영속. */
  isAvailable(): boolean
  /** 평문 → 버전 프리픽스 붙은 암호문 토큰. 불가 시 throw. */
  encrypt(plain: string): string
  /** 암호문 토큰 → 평문. 미지 포맷·복호화 실패(키회전/손상) 시 throw. */
  decrypt(token: string): string
}

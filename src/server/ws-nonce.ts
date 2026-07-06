import { randomBytes } from 'node:crypto'

/**
 * WS nonce 저장소(#197 B5). CF_Authorization 쿠키 자동첨부 우회를 막는 단일사용 토큰:
 *   · issue(identity, origin) — nonce 발급 endpoint(secured)가 JWT 검증 후 호출. 32바이트 base64url.
 *   · take(nonce) — upgrade 파이프라인이 다른 어떤 검사보다 **먼저** 호출(선소모). 조회 즉시 삭제하고
 *     레코드를 반환한다("성패 무관 소모" — 실패해도 재사용 불가). 바인딩 대조(identity/origin)는 호출부
 *     (T7)가 JWT 검증 후 수행하므로 take 는 identity 를 선요구하지 않는다(체크포인트 4-R P2: consume→take).
 * TTL 60s·단일사용·cap 128(무한 성장 방지 — lazy sweep 후 최고령 evict). 클럭 주입식(테스트 결정론).
 */
export interface NonceRecord {
  identity: string
  origin: string
  issuedAt: number
}

export interface NonceStore {
  issue(identity: string, origin: string): string
  take(nonce: string): NonceRecord | null
}

export interface NonceStoreOptions {
  /** 만료(ms). 기본 60_000. */
  ttlMs?: number
  /** 저장소 상한(무한 성장 방지). 기본 128. */
  maxPending?: number
  /** 클럭 주입(테스트). 기본 Date.now. */
  now?: () => number
}

export function createNonceStore(opts: NonceStoreOptions = {}): NonceStore {
  const ttlMs = opts.ttlMs ?? 60_000
  const maxPending = opts.maxPending ?? 128
  const now = opts.now ?? (() => Date.now())
  // Map 삽입 순서 보존 → keys().next() = 최고령.
  const store = new Map<string, NonceRecord>()

  const isExpired = (rec: NonceRecord): boolean => now() - rec.issuedAt >= ttlMs

  const sweepExpired = (): void => {
    for (const [nonce, rec] of store) {
      if (isExpired(rec)) store.delete(nonce)
    }
  }

  return {
    issue(identity, origin) {
      if (store.size >= maxPending) {
        // 만료분을 먼저 정리(cap 잠식 방지) — 그래도 만원이면 최고령 evict.
        sweepExpired()
        if (store.size >= maxPending) {
          const oldest = store.keys().next().value
          if (oldest !== undefined) store.delete(oldest)
        }
      }
      const nonce = randomBytes(32).toString('base64url')
      store.set(nonce, { identity, origin, issuedAt: now() })
      return nonce
    },

    take(nonce) {
      const rec = store.get(nonce)
      if (rec === undefined) return null
      store.delete(nonce) // 성패 무관 소모 — 조회 즉시 삭제(재사용 원천 차단).
      if (isExpired(rec)) return null // 만료분은 삭제만 하고 null.
      return rec
    },
  }
}

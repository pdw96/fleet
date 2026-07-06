import { describe, expect, it } from 'vitest'
import { createNonceStore } from './ws-nonce'

describe('createNonceStore — 단일사용·TTL·identity+Origin 바인딩(#197 B5 T5)', () => {
  it('issue → take 성공(레코드 필드 일치)·재-take null(단일사용)', () => {
    const t = 5000
    const store = createNonceStore({ now: () => t })
    const n = store.issue('alice', 'https://fleet.example.com')
    expect(store.take(n)).toEqual({
      identity: 'alice',
      origin: 'https://fleet.example.com',
      issuedAt: 5000,
    })
    expect(store.take(n)).toBeNull() // 단일사용 — 재-take null
  })

  it('take 후 어떤 재시도도 null(선소모 — 바인딩 불일치로 인한 재시도 포함)', () => {
    const store = createNonceStore()
    const n = store.issue('alice', 'https://fleet.example.com')
    expect(store.take(n)).not.toBeNull() // 첫 소모(성패 무관 조회 즉시 삭제)
    expect(store.take(n)).toBeNull()
    expect(store.take(n)).toBeNull()
  })

  it('TTL 경계: 59_999 반환 · 60_000 null(>=)', () => {
    let t = 1000
    const store = createNonceStore({ ttlMs: 60_000, now: () => t })
    const n1 = store.issue('u', 'o')
    t = 1000 + 59_999
    expect(store.take(n1)).toMatchObject({ identity: 'u', origin: 'o' })

    t = 2000
    const n2 = store.issue('u', 'o')
    t = 2000 + 60_000
    expect(store.take(n2)).toBeNull() // 정확히 ttl 경과 → 만료(>=)
  })

  it('미지·빈 문자열 nonce → null', () => {
    const store = createNonceStore()
    expect(store.take('')).toBeNull()
    expect(store.take('never-issued-value')).toBeNull()
  })

  it('cap 초과 → 최고령(삽입 순서 첫) evict', () => {
    const store = createNonceStore({ maxPending: 3, now: () => 1000 })
    const a = store.issue('u', 'o')
    const b = store.issue('u', 'o')
    const c = store.issue('u', 'o')
    const d = store.issue('u', 'o') // size 3 → a evict → b,c,d
    expect(store.take(a)).toBeNull()
    expect(store.take(b)).not.toBeNull()
    expect(store.take(c)).not.toBeNull()
    expect(store.take(d)).not.toBeNull()
  })

  it('만료분 lazy sweep — cap 잠식 방지(만료 엔트리가 live 를 축출하지 않음)', () => {
    let t = 1000
    const store = createNonceStore({ maxPending: 3, ttlMs: 60_000, now: () => t })
    store.issue('u', 'o')
    store.issue('u', 'o')
    const c = store.issue('u', 'o') // size 3(full)
    t = 1000 + 70_000 // a·b·c 전부 만료
    const d = store.issue('u', 'o') // 스윕이 만료분 정리 → d 는 live 를 축출하지 않고 삽입
    expect(store.take(d)).not.toBeNull() // d 는 자기 TTL 안이라 유효
    expect(store.take(c)).toBeNull() // 만료분은 스윕/만료로 null
  })

  it('같은 identity 다중 발급 각각 독립(탭 2개)', () => {
    const store = createNonceStore()
    const n1 = store.issue('u', 'https://a.example.com')
    const n2 = store.issue('u', 'https://b.example.com')
    expect(n1).not.toBe(n2)
    expect(store.take(n1)).toMatchObject({ identity: 'u', origin: 'https://a.example.com' })
    expect(store.take(n2)).toMatchObject({ identity: 'u', origin: 'https://b.example.com' })
  })

  it('발급 nonce 매회 상이 · 43자 base64url(엔트로피 회귀 가드)', () => {
    const store = createNonceStore()
    const seen = new Set<string>()
    for (let i = 0; i < 64; i++) {
      const n = store.issue('u', 'o')
      expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32바이트 base64url = 43자·패딩 없음
      expect(seen.has(n)).toBe(false)
      seen.add(n)
    }
  })
})

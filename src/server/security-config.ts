/**
 * 서버 보안 모드 게이트(#197 B5). 3종 env 로 loopback / access 를 판정한다:
 *   · 전무(부재/공백) → loopback: B3/B4 시맨틱 보존(nonce/JWT 없이 접속·loopback bind 고정).
 *   · 완비(3종 전부) → access: Cloudflare Access JWT + nonce + Origin exact 로 게이팅, non-loopback bind 허용.
 *   · 부분(1~2종) → throw: 어중간한 보안은 조용한 강등 대신 부팅 실패(fail-fast) — 누락 env 를 명시.
 * teamDomain·publicOrigin 은 https 필수(평문 다운그레이드 배제). env 파싱은 `?.trim() ||` 관례
 * (빈 문자열/공백 = 미설정 — B3 static-dir 교훈).
 */
export type SecurityConfig =
  { mode: 'loopback' } | { mode: 'access'; teamDomain: URL; aud: string; publicOrigin: string }

const ACCESS_ENV_KEYS = [
  'FLEET_ACCESS_TEAM_DOMAIN',
  'FLEET_ACCESS_AUD',
  'FLEET_PUBLIC_ORIGIN',
] as const

/** https URL 만 허용해 파싱(평문 다운그레이드·비파싱 거부). 실패는 env 이름을 실은 throw. */
function parseHttpsUrl(raw: string, name: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} 가 유효한 URL 이 아님: ${raw}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${name} 는 https 여야 함(평문 다운그레이드 배제): ${raw}`)
  }
  return url
}

export function resolveSecurityConfig(env: NodeJS.ProcessEnv): SecurityConfig {
  // `?.trim() ||` — 빈 문자열/공백은 undefined(미설정)로 접는다.
  const values = ACCESS_ENV_KEYS.map((k) => env[k]?.trim() || undefined)
  const setCount = values.filter(Boolean).length
  if (setCount === 0) return { mode: 'loopback' }
  if (setCount < 3) {
    const missing = ACCESS_ENV_KEYS.filter((_, i) => !values[i])
    throw new Error(
      `보안(access) 모드 부분 설정 — 다음 env 를 전부 설정하거나 전부 비워라(누락): ${missing.join(', ')}`,
    )
  }
  const [teamDomainRaw, audRaw, publicOriginRaw] = values as [string, string, string]
  // teamDomain·publicOrigin 은 origin 만 권위(issuer·JWKS base·Origin exact 매칭) — path/query 제거.
  const teamDomain = new URL(parseHttpsUrl(teamDomainRaw, 'FLEET_ACCESS_TEAM_DOMAIN').origin)
  const publicOrigin = parseHttpsUrl(publicOriginRaw, 'FLEET_PUBLIC_ORIGIN').origin
  // aud 는 Cloudflare Access application audience tag — 불투명 문자열(형식 과결합 금지).
  return { mode: 'access', teamDomain, aud: audRaw, publicOrigin }
}

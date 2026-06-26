import type { CliAdapter } from '../../../shared/types'
import type { CommandResult } from './detect'

// CLI 세션 실행 실패가 인증 문제로 *보일 때* advisory recovery hint 를 만든다(스펙 2026-06-26).
// 정확한 per-CLI 시그니처가 미상이므로 best-effort 휴리스틱이며, 문구는 단정 회피("~일 수 있습니다").
// 놓치면 호출부가 기존 제네릭 오류로 폴백(무회귀), 오탐해도 단정하지 않으므로 안전하다.

// 1) rate-limit/quota 류는 인증 문제가 아님(재로그인으로 복구 안 됨) → 항상 우선 제외(exclude-first).
const NON_AUTH_PATTERN = /\b(rate[- ]?limit(?:ed)?|quota|overload(?:ed)?|too many requests|429)\b/i

// 2) auth 문맥이 충분히 강한 어구(stderr·stdout 공통 적용).
const STRONG_AUTH_PATTERN =
  /\b(not logged in|unauthori[sz]ed|not authori[sz]ed|unauthenticated|authentication (?:failed|required|error)|requires authentication|login required|log in to continue|please .{0,40}(?:log ?in|sign in|authenticate)|sign in|session expired|token (?:expired|invalid)|invalid token|expired credentials|invalid (?:api key|credentials?)|no credentials found|missing credentials|api key required|401)\b/i

// 3) 403/forbidden 은 파일권한·sandbox·org정책서도 나오므로 auth 문맥과 근접(±80자)할 때만(stderr 한정).
const FORBIDDEN_AUTH_CONTEXT_PATTERN =
  /\b(?:403|forbidden)\b.{0,80}\b(?:auth|login|log in|sign in|token|credential|api key|account|subscription|permission)\b|\b(?:auth|login|log in|sign in|token|credential|api key|account|subscription|permission)\b.{0,80}\b(?:403|forbidden)\b/i

function looksLikeAuth(text: string, allowForbiddenContext: boolean): boolean {
  if (!text) return false
  if (NON_AUTH_PATTERN.test(text)) return false // exclude-first
  if (STRONG_AUTH_PATTERN.test(text)) return true
  return allowForbiddenContext && FORBIDDEN_AUTH_CONTEXT_PATTERN.test(text)
}

/**
 * 실패한 CLI 실행이 인증 문제로 보이면 advisory recovery hint 문자열을, 아니면 null 을 반환한다.
 * - spawnError(ENOENT/ETIMEDOUT/ABORTED/ENOBUFS)·code 0·auth 메타 없음·패턴 미매치 → null(무회귀).
 * - 검사 텍스트: stderr 우선. stderr 가 비어 있을 때만 stdout 으로 폴백(stdout 은 strong-auth 만, forbidden-context 불허).
 */
export function classifyCliAuthHint(adapter: CliAdapter, res: CommandResult): string | null {
  if (res.spawnError) return null
  if (res.code === 0) return null
  const auth = adapter.auth
  if (!auth?.loginCommand) return null

  const stderr = res.stderr.trim()
  const isAuth =
    stderr !== ''
      ? looksLikeAuth(stderr, /*allowForbiddenContext*/ true)
      : looksLikeAuth(res.stdout, /*allowForbiddenContext*/ false)
  if (!isAuth) return null

  return `💡 인증 문제일 수 있습니다 — 터미널에서 \`${auth.loginCommand}\` 실행 후 다시 시도해 보세요. (문서: ${auth.docsUrl})`
}

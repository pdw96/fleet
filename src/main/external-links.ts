// picker 문서 링크 외부열기 가드. renderer 네비게이션이 아니라 main→OS 브라우저 핸드오프 경로다.
// 보증: 핸드오프하는 최초 URL이 컴파일타임 정적 allowlist docs URL임만 보증한다.
// browser-side redirect(핸드오프 이후)는 Fleet 앱 네비가 아니므로 보증 범위 밖이다.
// window-guards(renderer 전면차단)는 불변 — 이 경로는 그 가드를 우회/완화하지 않는다.
import { DOCS_HOST_ALLOWLIST } from '../shared/cliAuthInstallMeta'

/**
 * https + userinfo 금지 + port 금지 + exact hostname allowlist.
 * 사용자/원격/AI 입력 비주입(정적 docsUrl 전용). `new URL().hostname` 은 IDN→punycode·대문자→lowercase
 * 정규화하므로 homograph/대문자 트릭은 exact 매칭에서 걸러진다.
 */
export function isAllowedDocsUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    DOCS_HOST_ALLOWLIST.includes(parsed.hostname)
  )
}

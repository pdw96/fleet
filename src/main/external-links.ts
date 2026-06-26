// picker 문서 링크 외부열기 가드. renderer 네비게이션이 아니라 main→OS 브라우저 핸드오프 경로다.
// 보증: 핸드오프하는 최초 URL이 컴파일타임 정적 allowlist docs URL임만 보증한다.
// browser-side redirect(핸드오프 이후)는 Fleet 앱 네비가 아니므로 보증 범위 밖이다.
// window-guards(renderer 전면차단)는 불변 — 이 경로는 그 가드를 우회/완화하지 않는다.
import {
  CLI_AUTH_INSTALL_META,
  DOCS_HOST_ALLOWLIST,
  type CliAdapterId,
} from '../shared/cliAuthInstallMeta'

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

/**
 * adapterId(식별자만) → 정적 맵에서 docsUrl 도출 → 재검증 → OS 브라우저 위임.
 * renderer 는 URL 을 전달하지 않는다(주입면 0). `Object.hasOwn` 으로 프로토타입 체인
 * 스푸핑('__proto__'·'toString')을 차단하고, 도출한 URL 도 `isAllowedDocsUrl` 로 재검증한다
 * (정적 맵 미래 오염 대비 심층방어). `deps.openExternal` 주입으로 단위 테스트 가능.
 */
export async function openVerifiedCliDocs(
  adapterId: CliAdapterId,
  deps: { openExternal: (url: string) => Promise<void> },
): Promise<void> {
  // 타입은 CliAdapterId 지만 IPC 경계 런타임 값은 신뢰 불가 → Object.hasOwn 으로 재확인.
  if (!Object.hasOwn(CLI_AUTH_INSTALL_META, adapterId)) {
    throw new Error('unknown adapter')
  }
  const url = CLI_AUTH_INSTALL_META[adapterId].docsUrl
  if (!isAllowedDocsUrl(url)) {
    // 정적 맵이라 정상 경로는 항상 통과 — 도달 시 맵 오염 신호. path-free 로 거부.
    throw new Error('docs url failed allowlist')
  }
  await deps.openExternal(url)
}

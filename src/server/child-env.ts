/**
 * 자식 프로세스 env 격리(#197-B6). 서버가 spawn 하는 자식(CLI 세션·detect/probe·MCP stdio·verify·git)에
 * `FLEET_SECRET_KEY`·`FLEET_ACCESS_*` 등 서버 시크릿이 새지 않게 **allowlist(denylist 아님)** 로 필터한다.
 *
 * 두 단계:
 *  · runtimeBaseEnv  — 전 자식 공통 최소(로케일·PATH·HOME·프록시·win32 이식 등). provider 키·FLEET_* 부재.
 *                      detect(--version)·MCP stdio·verify·git 은 이것만 받는다.
 *  · cliSessionEnv   — base + provider 자격/구성 키(ANTHROPIC/OPENAI/GOOGLE 계열). CLI 세션 실행과 **probe(실
 *                      auth 왕복이라 세션과 같은 env 필요)** 경로에 부여.
 *                      임의 사용자 프로세스인 MCP 자식엔 provider 키가 기본 전달되면 유출 경로가 보존되므로 제외한다
 *                      (MCP 는 `spec.env` 가 명시적 per-server escape hatch).
 *
 * **여기 상수에 named 키를 추가하는 것만이 자식 env 확장 경로다** — 와일드카드·prefix·denylist 폴백 금지.
 * 그래야 미래에 추가되는 `FLEET_*`/임의 시크릿이 리뷰 없이 자식으로 새지 않는다(신종 시크릿 기본 차단).
 * `NODE_OPTIONS` 는 preload 주입(RCE) 벡터라 **의도적으로 배제**(#167).
 */

/** 전 자식 공통 런타임 base. 대소문자 무시 매칭이라 proxy 소문자 변형(http_proxy 등)도 자동 포함된다. */
export const RUNTIME_BASE_ALLOWLIST: readonly string[] = [
  // 코어
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  // 임시 디렉터리
  'TMPDIR',
  'TEMP',
  'TMP',
  // 로케일(정확 카테고리만 — LC_ 접두 와일드카드 금지)
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_COLLATE',
  'LC_MONETARY',
  'TERM',
  'COLORTERM',
  'TZ',
  // XDG(gemini/codex config·cache 위치)
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  // 프록시(대소문자 무시 매칭 → HTTP_PROXY/http_proxy 양쪽 커버)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  // win32 이식(node/cmd 기동에 필요)
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]

/**
 * CLI 세션 실행 전용 provider 자격/구성 키(context7 확정 — Claude Code·Gemini CLI·Codex). base 위에 얹는다.
 * 이들은 서버 시크릿이 아니라 사용자가 CLI 에 주려는 자격/게이트웨이 구성이다 — CLI 세션 경로에만 전달한다.
 */
export const CLI_SESSION_PROVIDER_ALLOWLIST: readonly string[] = [
  // Anthropic / Claude Code
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  // OpenAI / Codex
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  // Google / Gemini(Vertex 포함)
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GENAI_USE_VERTEXAI',
]

export interface ChildEnv {
  /** detect/probe·MCP stdio·verify/git 용 — base 만. */
  base(): NodeJS.ProcessEnv
  /** CLI 세션 실행용 — base + provider 키. */
  cliSession(): NodeJS.ProcessEnv
}

/** source 를 대소문자 무시로 allowlist(정확 키) 매칭해 pick한다. 값이 undefined 인 키는 제외(상속 의미 보존). */
function pick(source: NodeJS.ProcessEnv, allow: ReadonlySet<string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (value === undefined) continue
    if (allow.has(key.toUpperCase())) out[key] = value
  }
  return out
}

const BASE_SET: ReadonlySet<string> = new Set(RUNTIME_BASE_ALLOWLIST.map((k) => k.toUpperCase()))
const CLI_SET: ReadonlySet<string> = new Set(
  [...RUNTIME_BASE_ALLOWLIST, ...CLI_SESSION_PROVIDER_ALLOWLIST].map((k) => k.toUpperCase()),
)

/** 전 자식 공통 base env(provider 키·FLEET_* 부재). */
export function runtimeBaseEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return pick(source, BASE_SET)
}

/** CLI 세션 실행용 env(base + provider 키). */
export function cliSessionEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return pick(source, CLI_SET)
}

/**
 * 엔진 주입용 ChildEnv 팩토리(기본 source = `process.env`). base()/cliSession() 은 호출 시점 source 스냅샷을
 * 계산한다(런타임 env 변화 추종 · pick 은 작은 비용). 미주입이면 엔진은 현행처럼 자식 env 를 상속한다.
 */
export function createChildEnv(source: NodeJS.ProcessEnv = process.env): ChildEnv {
  return {
    base: () => runtimeBaseEnv(source),
    cliSession: () => cliSessionEnv(source),
  }
}

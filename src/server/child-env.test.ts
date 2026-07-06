import { describe, expect, it } from 'vitest'
import {
  CLI_SESSION_PROVIDER_ALLOWLIST,
  cliSessionEnv,
  createChildEnv,
  RUNTIME_BASE_ALLOWLIST,
  runtimeBaseEnv,
} from './child-env'

/**
 * #197-B6 T2 — 자식 env 2단 allowlist(denylist 아님).
 *  · runtimeBaseEnv: 전 자식 공통 최소(detect/probe·MCP stdio·verify·git). provider 키·FLEET_* 부재.
 *  · cliSessionEnv: base + provider 키(CLI 세션 실행 전용).
 * allowlist 이므로 목록에 없는 키(신종 시크릿 포함)는 자동 차단 — 이 원칙을 테스트로 못박는다.
 */
describe('자식 env 2단 allowlist(#197-B6 T2)', () => {
  const secrets = {
    FLEET_SECRET_KEY: 's',
    FLEET_ACCESS_AUD: 'a',
    FLEET_ACCESS_TEAM_DOMAIN: 't',
    FLEET_PUBLIC_ORIGIN: 'o',
    FLEET_HOST: 'h',
    FLEET_PORT: '1',
    FLEET_DATA_DIR: 'd',
    FLEET_WORKSPACE_ROOT: 'w',
    FLEET_STATIC_DIR: 'x',
    FLEET_E2E: '1',
  }
  const providerKeys = {
    ANTHROPIC_API_KEY: 'ak',
    ANTHROPIC_AUTH_TOKEN: 'at',
    ANTHROPIC_BASE_URL: 'https://gw',
    CLAUDE_CODE_OAUTH_TOKEN: 'ct',
    OPENAI_API_KEY: 'ok',
    OPENAI_BASE_URL: 'https://oa',
    GEMINI_API_KEY: 'gk',
    GOOGLE_API_KEY: 'ggk',
    GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
    GOOGLE_CLOUD_PROJECT: 'proj',
    GOOGLE_CLOUD_LOCATION: 'us',
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
  }

  it('runtimeBaseEnv 는 FLEET_* 서버 시크릿을 전부 배제한다', () => {
    const out = runtimeBaseEnv({ ...secrets, PATH: '/b', HOME: '/h' })
    for (const k of Object.keys(secrets)) expect(out[k]).toBeUndefined()
    expect(out.PATH).toBe('/b')
    expect(out.HOME).toBe('/h')
  })

  it('runtimeBaseEnv 는 allowlist 밖 임의 시크릿을 차단한다(denylist 아님)', () => {
    const src = { SOME_SECRET: 'x', AWS_SECRET_ACCESS_KEY: 'y', GITHUB_TOKEN: 'z', PATH: '/b' }
    const base = runtimeBaseEnv(src)
    const cli = cliSessionEnv(src)
    expect(base.SOME_SECRET).toBeUndefined()
    expect(base.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(base.GITHUB_TOKEN).toBeUndefined()
    expect(cli.SOME_SECRET).toBeUndefined()
    expect(cli.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(cli.GITHUB_TOKEN).toBeUndefined()
  })

  it('runtimeBaseEnv 에는 provider 키가 없다(MCP·detect/probe·verify/git 로 안 감)', () => {
    const out = runtimeBaseEnv({ ...providerKeys, PATH: '/b' })
    for (const k of Object.keys(providerKeys)) expect(out[k]).toBeUndefined()
    expect(out.PATH).toBe('/b')
  })

  it('cliSessionEnv 는 base + provider 키 전체를 통과시키되 FLEET_*·신종 시크릿은 여전히 배제한다', () => {
    const out = cliSessionEnv({
      ...secrets,
      ...providerKeys,
      SOME_SECRET: 'x',
      PATH: '/b',
      HOME: '/h',
    })
    for (const k of Object.keys(providerKeys))
      expect(out[k]).toBe(providerKeys[k as keyof typeof providerKeys])
    expect(out.PATH).toBe('/b')
    expect(out.HOME).toBe('/h')
    for (const k of Object.keys(secrets)) expect(out[k]).toBeUndefined()
    expect(out.SOME_SECRET).toBeUndefined()
  })

  it('base 에 proxy·XDG·win32 이식·로케일 키를 통과시킨다(대소문자 무시 매칭)', () => {
    const src = {
      HTTP_PROXY: 'p1',
      https_proxy: 'p2',
      NO_PROXY: 'localhost',
      XDG_CONFIG_HOME: '/xc',
      XDG_CACHE_HOME: '/xh',
      TMPDIR: '/tmp',
      TEMP: 'X:/Temp',
      TMP: 'X:/T',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      TERM: 'xterm',
      TZ: 'UTC',
      USERPROFILE: 'X:/profile',
      APPDATA: 'X:/profile/AppData/Roaming',
      LOCALAPPDATA: 'X:/profile/AppData/Local',
      SystemRoot: 'X:/Windows',
      ComSpec: 'X:/Windows/cmd.exe',
      PATHEXT: '.EXE;.CMD',
    }
    const out = runtimeBaseEnv(src)
    for (const k of Object.keys(src)) expect(out[k]).toBe(src[k as keyof typeof src])
  })

  it('NODE_OPTIONS 를 의도적으로 배제한다(preload RCE 벡터 #167)', () => {
    const src = { NODE_OPTIONS: '--require /evil.js', PATH: '/b' }
    expect(runtimeBaseEnv(src).NODE_OPTIONS).toBeUndefined()
    expect(cliSessionEnv(src).NODE_OPTIONS).toBeUndefined()
  })

  it('LC_ 정확 카테고리만 통과 — LC_SECRET·LCD_FAKE 오매칭 배제(와일드카드 금지)', () => {
    const src = { LC_ALL: 'C', LC_SECRET: 'leak', LCD_FAKE: 'nope', PATH: '/b' }
    const out = runtimeBaseEnv(src)
    expect(out.LC_ALL).toBe('C')
    expect(out.LC_SECRET).toBeUndefined()
    expect(out.LCD_FAKE).toBeUndefined()
  })

  it('값이 undefined 인 allowlist 키는 결과에서 제외한다', () => {
    const src: NodeJS.ProcessEnv = { PATH: undefined, HOME: '/h' }
    const out = runtimeBaseEnv(src)
    expect('PATH' in out).toBe(false)
    expect(out.HOME).toBe('/h')
  })

  it('createChildEnv(source) 는 base()/cliSession() 을 source 스냅샷으로 계산한다', () => {
    const childEnv = createChildEnv({ ...secrets, ...providerKeys, PATH: '/b' })
    expect(childEnv.base().PATH).toBe('/b')
    expect(childEnv.base().ANTHROPIC_API_KEY).toBeUndefined()
    expect(childEnv.base().FLEET_SECRET_KEY).toBeUndefined()
    expect(childEnv.cliSession().ANTHROPIC_API_KEY).toBe('ak')
    expect(childEnv.cliSession().FLEET_SECRET_KEY).toBeUndefined()
  })

  it('allowlist 상수는 FLEET_*·NODE_OPTIONS 를 포함하지 않는다(정적 계약)', () => {
    const all = [...RUNTIME_BASE_ALLOWLIST, ...CLI_SESSION_PROVIDER_ALLOWLIST]
    expect(all.some((k) => k.toUpperCase().startsWith('FLEET_'))).toBe(false)
    expect(all.map((k) => k.toUpperCase())).not.toContain('NODE_OPTIONS')
  })
})

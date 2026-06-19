import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentRole,
  ApiProviderConfig,
  CliDetectionResult,
  LlmDescriptor,
  McpServerSpec,
  McpServerStatus,
  ModelOption,
  ReasoningEffort,
} from '../../shared/types'
import { ASSIGNABLE_ROLES } from '../../shared/types'

interface Props {
  sessions: LlmDescriptor[]
  onRefresh: () => void
}

// 현재 세대(2026-06) 기본 모델 ID. 사용자가 입력란에서 자유롭게 덮어쓸 수 있다.
// 장기적으로는 provider 의 모델 목록 API 로 라이브 조회하는 것이 이상적(하드코딩 표류 방지).
const PROVIDER_DEFAULTS: Record<ApiProviderConfig['provider'], string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.5',
  google: 'gemini-3.5-flash',
  'openai-compatible': '',
}

// MCP 상태 경량 폴링 간격(ms). 포커스 유지 중 서버 종료/크래시도 반영하기 위한 보조 경로(#21 옵션B).
const MCP_POLL_INTERVAL_MS = 5000

export function SessionsPanel({ sessions, onRefresh }: Props) {
  const [clis, setClis] = useState<CliDetectionResult[]>([])
  const [detecting, setDetecting] = useState(false)
  const [stateful, setStateful] = useState(false)
  // CLI 세션 모델 오버라이드(비우면 CLI 기본 모델 사용).
  const [cliModel, setCliModel] = useState('')
  // MCP 설정(경로 또는 인라인 JSON). 현재 패스스루 지원 CLI 는 claude(--mcp-config).
  const [cliMcp, setCliMcp] = useState('')

  const [provider, setProvider] = useState<ApiProviderConfig['provider']>('anthropic')
  const [model, setModel] = useState(PROVIDER_DEFAULTS.anthropic)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  // 라이브 조회한 모델 목록(#13). 비면 모델 입력란은 PROVIDER_DEFAULTS 자유입력 폴백을 유지한다.
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  // 모델 조회 요청 시퀀스. provider/key/baseUrl 이 바뀌면 증가시켜, 이전 입력으로 보낸 in-flight 응답이
  // 늦게 도착해 stale 한 제안으로 datalist 를 덮어쓰는 레이스를 막는다(Codex P2).
  const modelReqSeq = useRef(0)
  // thinking effort 세션 기본값('' = 끄기). Anthropic(adaptive)·OpenAI(reasoning_effort)·Google(thinkingConfig) 매핑.
  const [effort, setEffort] = useState<'' | ReasoningEffort>('')
  // 캐시 TTL 세션 기본값(Anthropic 한정). '' = 기본(5m), '1h' = extended-cache. #72.
  const [cacheTtl, setCacheTtl] = useState<'' | '1h'>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // thinking(reasoning) 노브를 매핑하는 provider(anthropic·openai·google 전부) — provider 별 모델-인지
  // 정규화는 provider 책임(Gemini: 3.x thinkingLevel·2.5 thinkingBudget·그외 미전송 + starvation maxOutputTokens 가드).
  const thinkingSupported =
    provider === 'anthropic' ||
    provider === 'openai' ||
    provider === 'google' ||
    provider === 'openai-compatible'

  const asError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  useEffect(() => {
    void detect()
    // 마운트 1회 CLI 감지(detect 는 reactive 값을 닫지 않음) — 의존성 추가 불요·재실행 의도 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function detect() {
    setDetecting(true)
    setError(null)
    try {
      setClis(await window.fleet.detectClis())
    } catch (e) {
      setError(`CLI 감지 실패: ${asError(e)}`)
    } finally {
      setDetecting(false)
    }
  }

  async function registerCli(id: string) {
    setError(null)
    try {
      // 빈 선택 필드는 키 자체를 넣지 않는다(IPC 페이로드를 깔끔히 유지).
      const opts: { stateful: boolean; model?: string; mcpConfig?: string } = { stateful }
      const model = cliModel.trim()
      const mcpConfig = cliMcp.trim()
      if (model) opts.model = model
      if (mcpConfig) opts.mcpConfig = mcpConfig
      await window.fleet.registerCliSession(id, opts)
      onRefresh()
    } catch (e) {
      setError(`세션 등록 실패: ${asError(e)}`)
    }
  }

  async function toggleCapability(s: LlmDescriptor, role: AgentRole) {
    const current = s.capabilities ?? []
    const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role]
    setError(null)
    try {
      await window.fleet.setSessionCapabilities(s.id, next)
      onRefresh()
    } catch (e) {
      setError(`역량 변경 실패: ${asError(e)}`)
    }
  }

  async function removeSession(id: string) {
    setError(null)
    try {
      await window.fleet.removeSession(id)
      onRefresh()
    } catch (e) {
      setError(`세션 제거 실패: ${asError(e)}`)
    }
  }

  // ── MCP 서버(최소) ──
  const [mcpJson, setMcpJson] = useState('')
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus[]>([])

  // main 이 보유한 권위 상태로 표시를 동기화한다(상태는 main 이 권위 — 패널 로컬은 표시용).
  const refreshMcpStatus = useCallback(() => {
    void window.fleet
      .getMcpStatus()
      .then(setMcpStatus)
      .catch(() => {})
  }, [])

  // 마운트 하이드레이트(탭 재마운트 복원) + 포커스/가시성 복귀 재조회.
  // 마운트 1회로는 마운트 이후 서버 종료/크래시를 못 잡아 stale(connected=true) 표시가 남으므로,
  // 앱으로 돌아올 때마다 권위 상태를 다시 끌어온다(#21 옵션B — 새 IPC 표면 없이 최소 변경).
  // 다른 라이브 갱신부(ChatPanel onChatStream·ProjectPanel onOrchestratorEvent)는 main push 구독을
  // 쓰지만, MCP disconnect push 채널을 새로 깔면 preload/IPC 표면이 늘어 재시작 함정(AGENTS.md)을
  // 부른다. main host 가 권위 상태를 보유하니 멱등 재조회로 충분 — 그래서 의도적으로 구독 대신 폴링.
  useEffect(() => {
    refreshMcpStatus()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshMcpStatus()
    }
    window.addEventListener('focus', refreshMcpStatus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refreshMcpStatus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshMcpStatus])

  // 활성 서버가 있을 때만 경량 폴링(포커스 유지 중 크래시도 반영). 서버 미설정 시 타이머 없음.
  const hasMcpServers = mcpStatus.length > 0
  useEffect(() => {
    if (!hasMcpServers) return
    const timer = setInterval(refreshMcpStatus, MCP_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasMcpServers, refreshMcpStatus])

  async function applyMcp() {
    setError(null)
    let specs: unknown
    try {
      specs = JSON.parse(mcpJson)
    } catch {
      setError('MCP 서버 JSON 파싱 실패: 유효한 JSON 배열을 입력하세요.')
      return
    }
    if (!Array.isArray(specs)) {
      setError('MCP 서버 설정은 배열이어야 합니다([{ name, command, args }]).')
      return
    }
    try {
      setMcpStatus(await window.fleet.setMcpServers(specs as McpServerSpec[]))
    } catch (e) {
      setError(`MCP 적용 실패: ${asError(e)}`)
    }
  }

  // 현재 provider+키로 사용 가능한 모델을 라이브 조회한다(#13). 결과는 datalist 제안으로 노출되며
  // 진행 중 모델 조회를 무효화하고 stale 제안·로딩 상태를 즉시 정리한다. provider/key/baseUrl 이
  // 바뀔 때 호출 — seq 를 밀어 늦게 온 응답을 폐기하고, 로딩을 즉시 풀어 새 입력으로 바로 재시도하게 한다
  // (느린/불통 엔드포인트의 in-flight 요청이 settle 될 때까지 버튼이 잠기던 stuck 제거 — Codex P2).
  function invalidateModelLookup() {
    setModelOptions([])
    setLoadingModels(false)
    modelReqSeq.current++
  }

  // 입력란은 그대로 자유입력 — 실패하면 사유를 표시하고 PROVIDER_DEFAULTS 기본값을 유지한다.
  async function loadModels() {
    if (!apiKey.trim()) return
    if (provider === 'openai-compatible' && !baseUrl.trim()) return
    const seq = ++modelReqSeq.current // 이 요청의 토큰 — 응답 도착 시 최신 요청인지 확인
    setLoadingModels(true)
    setError(null)
    try {
      const probe: ApiProviderConfig = {
        id: `probe-${provider}`,
        provider,
        displayName: provider,
        model,
        apiKey: apiKey.trim(),
        ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
      }
      const options = await window.fleet.listModels(probe)
      if (seq === modelReqSeq.current) setModelOptions(options) // stale 응답(입력 변경됨)은 폐기
    } catch (e) {
      if (seq === modelReqSeq.current) setError(`모델 조회 실패: ${asError(e)}`)
    } finally {
      // 이 요청이 여전히 최신일 때만 해제 — 더 새 요청이 진행 중이면 그 로딩을 조기 해제하지 않는다.
      // 입력 변경 시엔 invalidateModelLookup 이 이미 즉시 해제하므로 stuck 되지 않는다.
      if (seq === modelReqSeq.current) setLoadingModels(false)
    }
  }

  async function registerApi() {
    if (!apiKey.trim()) return
    if (provider === 'openai-compatible' && (!baseUrl.trim() || !model.trim())) return
    setBusy(true)
    setError(null)
    try {
      // thinking 은 anthropic·openai·google 매핑 — 끄기('')면 키 자체를 넣지 않는다(IPC 페이로드 깔끔 유지).
      // 세션 설정은 비영속·불가시라 displayName 에도 노출해 어느 세션이 thinking 인지 확인 가능하게 한다.
      const thinkingOn = thinkingSupported && effort !== ''
      // 캐시 TTL 은 Anthropic 만 — '1h' 선택 시에만 config 에 싣는다(기본 5m=키 미포함, byte-동일).
      const cacheOn = provider === 'anthropic' && cacheTtl === '1h'
      const config: ApiProviderConfig = {
        id: `${provider}-${Date.now()}`,
        provider,
        displayName: `${provider} (${model}${thinkingOn ? `, thinking:${effort}` : ''}${cacheOn ? ', cache:1h' : ''})`,
        model,
        apiKey: apiKey.trim(),
        ...(provider === 'openai-compatible' ? { baseUrl: baseUrl.trim() } : {}),
        ...(thinkingOn ? { thinking: { effort } } : {}),
        ...(cacheOn ? { cacheTtl: '1h' } : {}),
      }
      await window.fleet.registerApiSession(config)
      setApiKey('')
      onRefresh()
    } catch (e) {
      setError(`API 세션 등록 실패: ${asError(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      {error && (
        <p className="note-bad" role="alert">
          {error}
        </p>
      )}
      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">01 — CLI</span>
          <h2 className="panel-title">구독제 / TUI LLM</h2>
          <div className="right">
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void detect()}
              disabled={detecting}
            >
              {detecting ? '감지 중…' : '다시 감지'}
            </button>
          </div>
        </div>

        <label className="check" style={{ marginBottom: 10 }}>
          <input
            type="checkbox"
            checked={stateful}
            onChange={(e) => setStateful(e.target.checked)}
          />
          <span>
            세션 재개(대화 맥락 유지) — CLI 자체 --resume 으로 멀티턴.{' '}
            <span className="note-warn">⚠ 오케스트레이터와 공유 시 검증용.</span>
          </span>
        </label>

        <label className="field-label" htmlFor="cli-model">
          모델 (선택)
        </label>
        <input
          id="cli-model"
          className="field"
          style={{ marginBottom: 10 }}
          value={cliModel}
          onChange={(e) => setCliModel(e.target.value)}
          placeholder="비우면 CLI 기본 모델 (예: claude-sonnet-4-6)"
        />

        <label className="field-label" htmlFor="cli-mcp">
          MCP 설정 (선택 · claude --mcp-config)
        </label>
        <input
          id="cli-mcp"
          className="field"
          style={{ marginBottom: 14 }}
          value={cliMcp}
          onChange={(e) => setCliMcp(e.target.value)}
          placeholder='파일 경로 또는 인라인 JSON ({"mcpServers":{…}})'
        />

        <ul className="list">
          {clis.map((c) => (
            <li key={c.id} className="line-item">
              <span
                className="dot"
                style={{ background: c.installed ? 'var(--ok)' : 'var(--faint)' }}
              />
              <span className="name" style={{ minWidth: 116 }}>
                {c.displayName}
              </span>
              <span className="meta">{c.installed ? `v${c.version ?? '?'}` : '미설치'}</span>
              <button
                className="btn btn-sm"
                style={{ marginLeft: 'auto' }}
                disabled={!c.installed}
                onClick={() => void registerCli(c.id)}
              >
                세션 등록
              </button>
            </li>
          ))}
          {clis.length === 0 && !detecting && <p className="empty">감지된 CLI 가 없습니다.</p>}
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">02 — API</span>
          <h2 className="panel-title">API 기반 LLM</h2>
        </div>
        <div className="grid-2">
          <div>
            <label className="field-label" htmlFor="api-provider">
              Provider
            </label>
            <select
              id="api-provider"
              className="field"
              value={provider}
              onChange={(e) => {
                const p = e.target.value as ApiProviderConfig['provider']
                setProvider(p)
                setModel(PROVIDER_DEFAULTS[p])
                invalidateModelLookup() // provider 전환 → stale 제안·in-flight 응답·로딩 즉시 정리
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="api-model">
              모델
            </label>
            <div className="row" style={{ display: 'flex', gap: 8 }}>
              <input
                id="api-model"
                className="field"
                style={{ flex: 1 }}
                list="api-model-options"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void loadModels()}
                disabled={
                  loadingModels ||
                  !apiKey.trim() ||
                  (provider === 'openai-compatible' && !baseUrl.trim())
                }
              >
                {loadingModels ? '불러오는 중…' : '모델 불러오기'}
              </button>
            </div>
            {/* 라이브 조회 모델을 자유입력 input 의 제안 목록으로 노출(#13) — 입력란은 그대로 편집 가능. */}
            <datalist id="api-model-options">
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </option>
              ))}
            </datalist>
          </div>
        </div>
        {provider === 'openai-compatible' && (
          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="api-base-url">
              Base URL
            </label>
            <input
              id="api-base-url"
              className="field"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value)
                invalidateModelLookup() // baseUrl 변경 → 이전 엔드포인트의 stale 제안·in-flight·로딩 정리
              }}
              placeholder="https://openrouter.ai/api/v1"
            />
            <p className="meta" style={{ marginTop: 6 }}>
              OpenAI Chat Completions 호환 엔드포인트(OpenRouter·로컬 vLLM 등). 키는 해당 서비스의
              API 키.
            </p>
          </div>
        )}
        {thinkingSupported && (
          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="api-thinking">
              Thinking effort (선택)
            </label>
            <select
              id="api-thinking"
              className="field"
              value={effort}
              onChange={(e) => setEffort(e.target.value as '' | ReasoningEffort)}
            >
              <option value="">끄기 (기본)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </select>
            <p className="meta" style={{ marginTop: 6 }}>
              {provider === 'anthropic'
                ? '현행 세대(Opus 4.6+ · Sonnet 4.6)에서만 적용 — 미지원 모델은 자동 off, 미지원 티어는 기본(high)으로 동작합니다.'
                : provider === 'openai'
                  ? 'reasoning 모델(o-series · GPT-5+, chat·o1 초기 모델 제외)에서만 적용 — 그 외는 미전송, xhigh/max 는 미지원 모델에서 high 로, pro 모델은 지원 티어로 자동 정규화됩니다.'
                  : provider === 'openai-compatible'
                    ? '엔드포인트/모델이 지원할 때만 reasoning_effort 로 적용됩니다(미지원 시 무시 또는 자동 제거). max 는 high 로 보냅니다.'
                    : 'Gemini 3.x(gemini-3-pro · 3.5-flash 등)는 effort→thinking 깊이(low/medium/high)로 적용 · Gemini 2.5 는 동적 사고(effort 티어 세분화는 후속) · 그 외 모델은 미전송. thinking 활성 시 답변 토큰 예산을 자동 상향(굶음 방지)합니다.'}
            </p>
          </div>
        )}
        {provider === 'anthropic' && (
          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="api-cache-ttl">
              캐시 TTL (선택)
            </label>
            <select
              id="api-cache-ttl"
              className="field"
              value={cacheTtl}
              onChange={(e) => setCacheTtl(e.target.value as '' | '1h')}
            >
              <option value="">기본 (5분)</option>
              <option value="1h">1시간 (extended-cache)</option>
            </select>
            <p className="meta" style={{ marginTop: 6 }}>
              5분을 초과해 같은 프리픽스가 재전송되는 tail 경로(긴 빌드·느린 MCP 도구 루프)에서만
              이득입니다. 1시간 캐시 쓰기는 비용이 약 2배라 평소엔 기본(5분)을 권장합니다.
            </p>
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <label className="field-label">API 키</label>
          <input
            className="field"
            type="password"
            value={apiKey}
            placeholder="sk-..."
            onChange={(e) => {
              setApiKey(e.target.value)
              invalidateModelLookup() // 키 변경 → 이전 키로 받은 stale 제안·in-flight·로딩 정리
            }}
          />
        </div>
        <button
          className="btn"
          style={{ marginTop: 14 }}
          onClick={() => void registerApi()}
          disabled={
            busy ||
            !apiKey.trim() ||
            (provider === 'openai-compatible' && (!baseUrl.trim() || !model.trim()))
          }
        >
          API 세션 등록
        </button>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">03 — FLEET</span>
          <h2 className="panel-title">등록된 세션</h2>
          <div className="right">
            <span className="chip chip-signal">{sessions.length} active</span>
          </div>
        </div>
        {sessions.length === 0 && <p className="empty">아직 등록된 LLM 세션이 없습니다.</p>}
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id} className="line-item" style={{ flexWrap: 'wrap' }}>
              <span className="chip chip-signal">{s.kind.toUpperCase()}</span>
              {s.stateful && (
                <span className="chip chip-live" title="세션 재개(대화 맥락 유지) 모드">
                  STATEFUL
                </span>
              )}
              <span className="name">{s.displayName}</span>
              <code className="id">{s.id}</code>
              <button
                className="btn btn-danger btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => void removeSession(s.id)}
              >
                제거
              </button>
              <div
                style={{
                  flexBasis: '100%',
                  display: 'flex',
                  gap: 6,
                  marginTop: 10,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  className="field-label"
                  style={{ margin: 0 }}
                  title="capability-scored 정책에서 이 LLM 에게 우선 배정할 역할"
                >
                  잘하는 역할
                </span>
                {ASSIGNABLE_ROLES.map((role) => {
                  const active = (s.capabilities ?? []).includes(role)
                  return (
                    <button
                      key={role}
                      className="chip"
                      onClick={() => void toggleCapability(s, role)}
                      style={{
                        cursor: 'pointer',
                        color: active ? 'var(--ok)' : 'var(--faint)',
                        borderColor: 'currentColor',
                      }}
                    >
                      {role}
                    </button>
                  )
                })}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">04 — MCP</span>
          <h2 className="panel-title">MCP 서버 (API 세션 도구)</h2>
        </div>
        <label className="field-label" htmlFor="mcp-servers">
          MCP 서버 (JSON 배열)
        </label>
        <textarea
          id="mcp-servers"
          className="field"
          style={{ minHeight: 96, fontFamily: 'monospace' }}
          value={mcpJson}
          onChange={(e) => setMcpJson(e.target.value)}
          placeholder='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}]'
        />
        <button className="btn" style={{ marginTop: 12 }} onClick={() => void applyMcp()}>
          MCP 적용
        </button>
        {mcpStatus.length > 0 && (
          <ul className="list" style={{ marginTop: 12 }}>
            {mcpStatus.map((s) => (
              <li key={s.name} className="line-item">
                <span
                  className="dot"
                  style={{ background: s.connected ? 'var(--ok)' : 'var(--faint)' }}
                />
                <span className="name" style={{ minWidth: 116 }}>
                  {s.name}
                </span>
                <span className="meta">
                  {s.connected ? `${s.toolCount} tools` : (s.error ?? '연결 실패')}
                </span>
                {s.tools.length > 0 && <code className="id">{s.tools.join(', ')}</code>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

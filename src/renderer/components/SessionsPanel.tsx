import { useEffect, useState } from 'react'
import type { AgentRole, ApiProviderConfig, CliDetectionResult, LlmDescriptor } from '../../shared/types'
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
}

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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const asError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  useEffect(() => {
    void detect()
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
      const model = cliModel.trim()
      const mcpConfig = cliMcp.trim()
      await window.fleet.registerCliSession(id, {
        stateful,
        model: model || undefined,
        mcpConfig: mcpConfig || undefined,
      })
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

  async function registerApi() {
    if (!apiKey.trim()) return
    setBusy(true)
    setError(null)
    try {
      const config: ApiProviderConfig = {
        id: `${provider}-${Date.now()}`,
        provider,
        displayName: `${provider} (${model})`,
        model,
        apiKey: apiKey.trim(),
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
            <button className="btn btn-ghost btn-sm" onClick={detect} disabled={detecting}>
              {detecting ? '감지 중…' : '다시 감지'}
            </button>
          </div>
        </div>

        <label className="check" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={stateful} onChange={(e) => setStateful(e.target.checked)} />
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
              <span className="dot" style={{ background: c.installed ? 'var(--ok)' : 'var(--faint)' }} />
              <span className="name" style={{ minWidth: 116 }}>
                {c.displayName}
              </span>
              <span className="meta">{c.installed ? `v${c.version ?? '?'}` : '미설치'}</span>
              <button
                className="btn btn-sm"
                style={{ marginLeft: 'auto' }}
                disabled={!c.installed}
                onClick={() => registerCli(c.id)}
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
            <label className="field-label">Provider</label>
            <select
              className="field"
              value={provider}
              onChange={(e) => {
                const p = e.target.value as ApiProviderConfig['provider']
                setProvider(p)
                setModel(PROVIDER_DEFAULTS[p])
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
            </select>
          </div>
          <div>
            <label className="field-label">모델</label>
            <input className="field" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label className="field-label">API 키</label>
          <input
            className="field"
            type="password"
            value={apiKey}
            placeholder="sk-..."
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <button className="btn" style={{ marginTop: 14 }} onClick={registerApi} disabled={busy || !apiKey.trim()}>
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
                style={{ flexBasis: '100%', display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <span className="field-label" style={{ margin: 0 }} title="capability-scored 정책에서 이 LLM 에게 우선 배정할 역할">
                  잘하는 역할
                </span>
                {ASSIGNABLE_ROLES.map((role) => {
                  const active = (s.capabilities ?? []).includes(role)
                  return (
                    <button
                      key={role}
                      className="chip"
                      onClick={() => toggleCapability(s, role)}
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
    </div>
  )
}

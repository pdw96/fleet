import { useEffect, useState } from 'react'
import type { AgentRole, ApiProviderConfig, CliDetectionResult, LlmDescriptor } from '../../shared/types'
import { ASSIGNABLE_ROLES } from '../../shared/types'

interface Props {
  sessions: LlmDescriptor[]
  onRefresh: () => void
}

const PROVIDER_DEFAULTS: Record<ApiProviderConfig['provider'], string> = {
  anthropic: 'claude-sonnet-4',
  openai: 'gpt-4o',
  google: 'gemini-1.5-pro',
}

export function SessionsPanel({ sessions, onRefresh }: Props) {
  const [clis, setClis] = useState<CliDetectionResult[]>([])
  const [detecting, setDetecting] = useState(false)
  const [stateful, setStateful] = useState(false)

  const [provider, setProvider] = useState<ApiProviderConfig['provider']>('anthropic')
  const [model, setModel] = useState(PROVIDER_DEFAULTS.anthropic)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void detect()
  }, [])

  async function detect() {
    setDetecting(true)
    try {
      setClis(await window.fleet.detectClis())
    } finally {
      setDetecting(false)
    }
  }

  async function registerCli(id: string) {
    await window.fleet.registerCliSession(id, { stateful })
    onRefresh()
  }

  async function toggleCapability(s: LlmDescriptor, role: AgentRole) {
    const current = s.capabilities ?? []
    const next = current.includes(role) ? current.filter((r) => r !== role) : [...current, role]
    await window.fleet.setSessionCapabilities(s.id, next)
    onRefresh()
  }

  async function registerApi() {
    if (!apiKey.trim()) return
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
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

        <label className="check" style={{ marginBottom: 14 }}>
          <input type="checkbox" checked={stateful} onChange={(e) => setStateful(e.target.checked)} />
          <span>
            세션 재개(대화 맥락 유지) — CLI 자체 --resume 으로 멀티턴.{' '}
            <span className="note-warn">⚠ 오케스트레이터와 공유 시 검증용.</span>
          </span>
        </label>

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
                onClick={async () => {
                  await window.fleet.removeSession(s.id)
                  onRefresh()
                }}
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

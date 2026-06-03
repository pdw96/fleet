import { useEffect, useState } from 'react'
import type { ApiProviderConfig, CliDetectionResult, LlmDescriptor } from '../../shared/types'
import { button, buttonGhost, card, colors, input, label } from '../ui'

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
    await window.fleet.registerCliSession(id)
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
    <div style={{ display: 'grid', gap: 16 }}>
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15 }}>구독제 / TUI LLM (API 키 불요)</h2>
          <button style={{ ...buttonGhost, marginLeft: 'auto' }} onClick={detect} disabled={detecting}>
            {detecting ? '감지 중…' : '다시 감지'}
          </button>
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
          {clis.map((c) => (
            <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: colors.panel2, borderRadius: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.installed ? colors.green : '#555' }} />
              <strong style={{ minWidth: 110 }}>{c.displayName}</strong>
              <span style={{ color: colors.muted, fontSize: 12 }}>
                {c.installed ? `v${c.version ?? '?'}` : '미설치'}
              </span>
              <button
                style={{ ...button, marginLeft: 'auto', opacity: c.installed ? 1 : 0.4 }}
                disabled={!c.installed}
                onClick={() => registerCli(c.id)}
              >
                세션 등록
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section style={card}>
        <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>API 기반 LLM</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label style={label}>Provider</label>
            <select
              style={input}
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
            <label style={label}>모델</label>
            <input style={input} value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={label}>API 키</label>
          <input style={input} type="password" value={apiKey} placeholder="sk-..." onChange={(e) => setApiKey(e.target.value)} />
        </div>
        <button style={{ ...button, marginTop: 12 }} onClick={registerApi} disabled={busy || !apiKey.trim()}>
          API 세션 등록
        </button>
      </section>

      <section style={card}>
        <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>등록된 세션 ({sessions.length})</h2>
        {sessions.length === 0 && <p style={{ color: colors.muted, fontSize: 13 }}>아직 등록된 LLM 세션이 없습니다.</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
          {sessions.map((s) => (
            <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: colors.panel2, borderRadius: 6 }}>
              <span style={{ fontSize: 11, color: colors.accent, border: `1px solid ${colors.accent}`, borderRadius: 4, padding: '1px 6px' }}>
                {s.kind.toUpperCase()}
              </span>
              <strong>{s.displayName}</strong>
              <code style={{ color: colors.muted, fontSize: 11 }}>{s.id}</code>
              <button
                style={{ ...buttonGhost, marginLeft: 'auto', color: colors.red }}
                onClick={async () => {
                  await window.fleet.removeSession(s.id)
                  onRefresh()
                }}
              >
                제거
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

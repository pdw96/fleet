import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, LlmDescriptor } from '../shared/types'
import { ChatPanel } from './components/ChatPanel'
import { ProjectPanel } from './components/ProjectPanel'
import { SessionsPanel } from './components/SessionsPanel'
import { buttonGhost, colors } from './ui'

type Tab = 'sessions' | 'project' | 'chat'

const TABS: { id: Tab; label: string }[] = [
  { id: 'sessions', label: '세션' },
  { id: 'project', label: '프로젝트' },
  { id: 'chat', label: '채팅' },
]

export function App() {
  const [tab, setTab] = useState<Tab>('sessions')
  const [sessions, setSessions] = useState<LlmDescriptor[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)

  const refreshSessions = useCallback(async () => {
    setSessions(await window.fleet.listSessions())
  }, [])

  useEffect(() => {
    void refreshSessions()
    void window.fleet
      .getAppInfo()
      .then(setInfo)
      .catch(() => undefined)
  }, [refreshSessions])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', color: colors.text, background: colors.bg, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 20px', borderBottom: `1px solid ${colors.border}` }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18 }}>Fleet</h1>
          <span style={{ fontSize: 11, color: colors.muted }}>멀티 LLM 오케스트레이션</span>
        </div>
        <nav style={{ display: 'flex', gap: 6, marginLeft: 24 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              style={{ ...buttonGhost, background: tab === t.id ? colors.accent : 'transparent', borderColor: tab === t.id ? colors.accent : colors.border }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: colors.muted }}>
          세션 {sessions.length}개
        </span>
      </header>

      <main style={{ flex: 1, padding: 20, overflow: 'auto' }}>
        {tab === 'sessions' && <SessionsPanel sessions={sessions} onRefresh={refreshSessions} />}
        {tab === 'project' && <ProjectPanel sessions={sessions} />}
        {tab === 'chat' && <ChatPanel sessions={sessions} />}
      </main>

      {info && (
        <footer style={{ padding: '8px 20px', borderTop: `1px solid ${colors.border}`, fontSize: 11, color: colors.muted }}>
          {info.name} · Electron {info.electron} · Node {info.node} · Chrome {info.chrome}
        </footer>
      )}
    </div>
  )
}

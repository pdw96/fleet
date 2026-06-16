import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, LlmDescriptor } from '../shared/types'
import { ApprovalModal } from './components/ApprovalModal'
import { ChatPanel } from './components/ChatPanel'
import { ProjectPanel } from './components/ProjectPanel'
import { SessionsPanel } from './components/SessionsPanel'

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
    try {
      setSessions(await window.fleet.listSessions())
    } catch {
      // 세션 목록 새로고침 실패는 조용히 무시한다(다음 액션에서 재시도).
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    void window.fleet
      .getAppInfo()
      .then(setInfo)
      .catch(() => undefined)
  }, [refreshSessions])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>
            FLEET<span className="dotmark">.</span>
          </h1>
          <span className="tag">멀티 LLM 오케스트레이션</span>
        </div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} className="nav-btn" data-active={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="live" data-live={sessions.length > 0}>
          <span className="beacon" data-on={sessions.length > 0} />
          <span>
            <span className="num">{sessions.length}</span> sessions
          </span>
        </div>
      </header>

      <main className="main">
        <div className="wrap">
          {tab === 'sessions' && <SessionsPanel sessions={sessions} onRefresh={() => void refreshSessions()} />}
          {tab === 'project' && <ProjectPanel sessions={sessions} />}
          {tab === 'chat' && <ChatPanel sessions={sessions} />}
        </div>
      </main>

      {info && (
        <footer className="footer">
          {info.name}
          <span className="sep">/</span>Electron {info.electron}
          <span className="sep">/</span>Node {info.node}
          <span className="sep">/</span>Chrome {info.chrome}
        </footer>
      )}

      <ApprovalModal />
    </div>
  )
}

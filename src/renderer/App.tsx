import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, LlmDescriptor } from '../shared/types'
import { ApprovalModal } from './components/ApprovalModal'
import { UpdateBanner } from './components/UpdateBanner'
import { ChatPanel } from './components/ChatPanel'
import { ProjectPanel } from './components/ProjectPanel'
import { SessionsPanel } from './components/SessionsPanel'
import { ConnectionBanner, useHydration } from './bridge/hydration'

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
  const { nonce: hydrateNonce } = useHydration()

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.fleet.listSessions())
    } catch {
      // 세션 목록 새로고침 실패는 조용히 무시한다(다음 액션에서 재시도).
    }
  }, [])

  useEffect(() => {
    // false-positive: refreshSessions 의 setSessions 는 await(IPC) 뒤에 실행돼 effect 본문 동기 setState 가 아니다.
    // 룰이 async/await 경계를 못 봐 호출부만 보고 플래그 — 룰은 켜 두고 이 site 만 명시 억제.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshSessions()
    void window.fleet
      .getAppInfo()
      .then(setInfo)
      .catch(() => undefined)
    // hydrateNonce: 웹 재접속 시 세션/앱정보 스냅샷 재조회(#197 B4 — 데스크톱은 0 고정이라 마운트 1회).
  }, [refreshSessions, hydrateNonce])

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
            <button
              key={t.id}
              className="nav-btn"
              data-active={tab === t.id}
              onClick={() => setTab(t.id)}
            >
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
          {tab === 'sessions' && (
            <SessionsPanel
              sessions={sessions}
              onRefresh={() => void refreshSessions()}
              runtime={info?.runtime ?? null}
            />
          )}
          {tab === 'project' && (
            <ProjectPanel sessions={sessions} runtime={info?.runtime ?? null} />
          )}
          {tab === 'chat' && <ChatPanel sessions={sessions} />}
        </div>
      </main>

      {info && (
        <footer className="footer">
          {info.name}
          {info.runtime === 'web' ? (
            <>
              <span className="sep">/</span>Web
              <span className="sep">/</span>v{info.version}
            </>
          ) : (
            <>
              <span className="sep">/</span>Electron {info.electron}
              <span className="sep">/</span>Node {info.node}
              <span className="sep">/</span>Chrome {info.chrome}
            </>
          )}
        </footer>
      )}

      {/* 자동 업데이트는 Electron 전용 표면 — runtime 확정(electron) 후에만 마운트한다(#197 B4).
          info 로드 전 마운트하면 웹에서도 구독(onUpdateEvent)이 발화해 게이팅이 무의미해진다.
          데스크톱은 info 도착(수 ms)까지 지연 마운트되지만 getUpdateState 스냅샷 하이드레이트가
          그 사이 상태를 복원하므로 시맨틱 무회귀. */}
      {info?.runtime === 'electron' && <UpdateBanner />}
      <ConnectionBanner />
      <ApprovalModal />
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentRole,
  LlmDescriptor,
  McpServerSpec,
  McpServerStatus,
  UpdaterChannel,
} from '../../shared/types'
import { ASSIGNABLE_ROLES } from '../../shared/types'
import { AddAiWizard } from './AddAiWizard'

interface Props {
  sessions: LlmDescriptor[]
  onRefresh: () => void
}

// MCP 상태 경량 폴링 간격(ms). 포커스 유지 중 서버 종료/크래시도 반영하기 위한 보조 경로(#21 옵션B).
const MCP_POLL_INTERVAL_MS = 5000

export function SessionsPanel({ sessions, onRefresh }: Props) {
  const [error, setError] = useState<string | null>(null)
  // 자동 업데이트 채널(#98). main(store)이 권위 — 마운트 시 1회 조회하고 토글 시 낙관적 반영.
  const [channel, setChannel] = useState<UpdaterChannel>('stable')
  // 사용자가 채널을 토글하면 마운트 하이드레이션의 늦은 응답이 그 선택을 덮어쓰지 않게 막는다.
  const channelEdited = useRef(false)
  // 하이드레이션 완료 여부 — 완료 전엔 표시값(기본 stable)이 실제 영속값과 다를 수 있어, 중복-스킵
  // early-return 을 하이드레이션 후로 미뤄 사용자의 첫 클릭이 유실되지 않게 한다.
  const channelHydrated = useRef(false)

  const asError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  // 업데이트 채널 초기 로드(#98) — main store 가 권위 소스.
  useEffect(() => {
    void window.fleet.getUpdaterChannel().then((c) => {
      channelHydrated.current = true
      if (!channelEdited.current) setChannel(c) // 사용자가 이미 토글했으면 늦은 하이드레이션 무시
    })
  }, [])

  async function changeChannel(next: UpdaterChannel): Promise<void> {
    channelEdited.current = true // 이후 도착하는 하이드레이션 응답이 이 선택을 덮어쓰지 않게
    // 하이드레이션 후에만 중복 스킵 — 완료 전엔 표시값이 실제와 다를 수 있어 클릭을 항상 반영한다.
    if (channelHydrated.current && next === channel) return
    const prev = channel
    setChannel(next) // 낙관적 반영
    try {
      await window.fleet.setUpdaterChannel(next)
    } catch (e) {
      setChannel(prev) // 실패 → 롤백(화면과 main 권위 일치 유지)
      setError(asError(e))
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

  return (
    <div className="stack">
      {error && (
        <p className="note-bad" role="alert">
          {error}
        </p>
      )}

      <AddAiWizard onRegistered={onRefresh} />

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
              {s.kind === 'cli' && (
                <span
                  className="badge badge-unverified"
                  title="설치만 확인됨 — 로그인/권한은 첫 사용 시 검증됩니다"
                >
                  로그인 미검증 · 첫 메시지에서 인증 확인
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

      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">05 — 업데이트</span>
          <h2 className="panel-title">업데이트 채널</h2>
        </div>
        <span className="field-label" style={{ margin: 0 }}>
          이 채널의 업데이트만 확인합니다.
        </span>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          {(['stable', 'beta'] as const).map((c) => (
            <button
              key={c}
              className="chip"
              onClick={() => void changeChannel(c)}
              style={{
                cursor: 'pointer',
                color: channel === c ? 'var(--ok)' : 'var(--faint)',
                borderColor: 'currentColor',
              }}
            >
              {c === 'stable' ? '안정(stable)' : '베타(beta)'}
            </button>
          ))}
        </div>
        <p className="meta" style={{ marginTop: 8 }}>
          {channel === 'stable'
            ? '안정 — 검증된 정식 릴리스만 받습니다(권장).'
            : '베타 — 프리릴리스를 먼저 받습니다(미검증 빌드 포함).'}
        </p>
      </section>
    </div>
  )
}

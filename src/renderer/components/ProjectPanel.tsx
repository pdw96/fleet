import { useEffect, useRef, useState } from 'react'
import type { AgentRole, AssignmentPolicy, LlmDescriptor, Project, Task } from '../../shared/types'
import { ASSIGNABLE_ROLES } from '../../shared/types'
import { statusColor } from '../ui'

interface Props {
  sessions: LlmDescriptor[]
}

/** 진행 로그 한 줄 — 저장소 재생(FleetEvent)과 라이브(OrchestratorEvent)를 동일 형태로 보관. */
interface LogLine {
  type: string
  message: string
}

export function ProjectPanel({ sessions }: Props) {
  // 새 프로젝트 폼 상태
  const [goal, setGoal] = useState('')
  const [policy, setPolicy] = useState<AssignmentPolicy>('round-robin')
  const [manual, setManual] = useState<Partial<Record<AgentRole, string>>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  // 진행 중 실행의 projectId — 취소 버튼용. project.created 이벤트에서 잡는다.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)

  // 방 목록 + 선택된 프로젝트 상세(저장소 기준)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [log, setLog] = useState<LogLine[]>([])
  // 라이브 요약(영속 안 됨 — 실행 직후에만 표시).
  const [summary, setSummary] = useState('')

  // 비동기 콜백이 '도착 시점'의 선택 방을 알도록 최신 selectedId 를 ref 로 추적(스테일 클로저 방지).
  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  async function refreshProjects(): Promise<Project[]> {
    const list = await window.fleet.listProjects()
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt) // 최신순
    setProjects(sorted)
    return sorted
  }

  async function refreshTasks(projectId: string): Promise<void> {
    const t = await window.fleet.getProjectTasks(projectId)
    if (selectedIdRef.current === projectId) setTasks(t)
  }

  // 마운트: 방 목록 로드 + 마지막 보던(없으면 최신) 프로젝트 자동 선택.
  useEffect(() => {
    void (async () => {
      const list = await refreshProjects()
      const last = await window.fleet.getLastActiveProject()
      const pick = last && list.some((p) => p.id === last) ? last : (list[0]?.id ?? null)
      if (pick) setSelectedId(pick)
    })()
  }, [])

  // 마운트: 워크스페이스 상태.
  useEffect(() => {
    void window.fleet
      .getWorkspace()
      .then(setWorkspace)
      .catch(() => undefined)
  }, [])

  // 마운트: 오케스트레이터 라이브 이벤트 구독(방 필터는 selectedIdRef 로).
  useEffect(() => {
    const unsub = window.fleet.onOrchestratorEvent((e) => {
      const pid = typeof e.data?.['projectId'] === 'string' ? (e.data['projectId'] as string) : undefined
      // 취소 버튼용 in-flight id.
      // 주의: project.created 시점엔 selectedIdRef 가 아직 이전 값이라 이 이벤트는 라이브 로그에 안 들어가지만,
      // 영속되어 있어 선택 effect 의 listProjectEvents 재조회로 곧 표시된다(허용된 동작).
      if (e.type === 'project.created' && pid) {
        setActiveProjectId(pid)
        void refreshProjects()
        setSelectedId(pid) // 새 프로젝트를 바로 연다
      }
      if ((e.type === 'project.done' || e.type === 'run.cancelled') && pid) {
        setActiveProjectId((cur) => (cur === pid ? null : cur))
      }
      // 현재 열려 있는 프로젝트의 이벤트만 라이브 로그/보드에 반영(크로스-프로젝트 누수 방지).
      if (pid && pid === selectedIdRef.current) {
        setLog((prev) => [...prev, { type: e.type, message: e.message }])
        if (e.type !== 'task.progress') void refreshTasks(pid) // 보드는 마일스톤에서만 갱신
      }
    })
    return unsub
  }, [])

  // 선택 변경: 보드/로그를 저장소에서 로드 + 마지막 선택 영속.
  useEffect(() => {
    if (!selectedId) {
      setTasks([])
      setLog([])
      return
    }
    void window.fleet.setLastActiveProject(selectedId)
    void (async () => {
      const [t, ev] = await Promise.all([
        window.fleet.getProjectTasks(selectedId),
        window.fleet.listProjectEvents(selectedId),
      ])
      if (selectedIdRef.current !== selectedId) return // 응답 도착 시 다른 방이면 무시
      setTasks(t)
      setLog(ev.map((e) => ({ type: e.type, message: e.message ?? '' })))
      setSummary('') // 다른 방으로 전환 시 라이브 요약 초기화
    })()
  }, [selectedId])

  async function pickWorkspace() {
    try {
      setWorkspace(await window.fleet.selectWorkspace())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function cancel() {
    if (!activeProjectId) return
    try {
      await window.fleet.cancelRun(activeProjectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function run() {
    if (!goal.trim()) return
    setRunning(true)
    setError(null)
    setActiveProjectId(null)
    setSummary('')
    try {
      const assignments =
        policy === 'manual'
          ? ASSIGNABLE_ROLES.map((role) => ({ role, llmId: manual[role] ?? sessions[0]?.id ?? '' }))
          : undefined
      const r = await window.fleet.runProject({ goal: goal.trim(), policy, assignments })
      setSummary(r.summary)
      await refreshProjects()
      if (selectedIdRef.current) await refreshTasks(selectedIdRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      setActiveProjectId(null)
    }
  }

  const canRun = sessions.length > 0 && goal.trim().length > 0 && !running
  const llmName = (id?: string) => (id ? (sessions.find((s) => s.id === id)?.displayName ?? id) : undefined)
  // capability-scored 인데 어떤 세션에도 역량이 없으면 사실상 round-robin — 침묵 격하 경고(2개 이상일 때만 의미).
  const noCapsConfigured =
    policy === 'capability-scored' && sessions.length > 1 && !sessions.some((s) => s.capabilities?.length)
  const selected = projects.find((p) => p.id === selectedId)

  return (
    <div className="project-layout">
      <aside className="panel rooms">
        <span className="eyebrow">프로젝트</span>
        <button className="room-btn" data-active={selectedId === null} onClick={() => setSelectedId(null)}>
          + 새 프로젝트
        </button>
        {projects.map((p) => (
          <button key={p.id} className="room-btn" data-active={p.id === selectedId} onClick={() => setSelectedId(p.id)}>
            <span className="proj-title">{p.title}</span>
            <span className="proj-status" style={{ color: statusColor(p.status) }}>
              {p.status}
            </span>
          </button>
        ))}
        {projects.length === 0 && <p className="empty">프로젝트가 없습니다.</p>}
      </aside>

      <div className="project-main">
        {/* 새 프로젝트 폼 — 항상 표시(새 실행 시작 경로). */}
        <section className="panel">
          <div className="panel-head">
            <span className="eyebrow">01 — GOAL</span>
            <h2 className="panel-title">새 프로젝트</h2>
          </div>
          {sessions.length === 0 && (
            <p className="note-warn" style={{ marginTop: 0 }}>
              먼저 [세션] 탭에서 LLM 세션을 1개 이상 등록하세요.
            </p>
          )}
          <textarea
            className="field"
            placeholder="예: 사용자 인증이 있는 할 일 관리 REST API 를 만든다…"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <div className="row" style={{ alignItems: 'flex-end', marginTop: 12 }}>
            <div style={{ width: 220 }}>
              <label className="field-label">역할 배정 정책</label>
              <select className="field" value={policy} onChange={(e) => setPolicy(e.target.value as AssignmentPolicy)}>
                <option value="round-robin">round-robin</option>
                <option value="capability-scored">capability-scored</option>
                <option value="manual">manual</option>
              </select>
            </div>
            <button className="btn" style={{ marginLeft: 'auto' }} onClick={run} disabled={!canRun}>
              {running ? '실행 중…' : '오케스트레이션 실행'}
            </button>
            {running && activeProjectId && (
              <button className="btn btn-danger" onClick={() => void cancel()}>
                취소
              </button>
            )}
          </div>
          <div className="row" style={{ alignItems: 'center', marginTop: 12, gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => void pickWorkspace()}>
              워크스페이스 선택
            </button>
            <span className="meta">
              {workspace
                ? `산출물·검증 활성 → ${workspace}`
                : '워크스페이스 미설정 — 파일 기록/검증 비활성(텍스트 산출물만)'}
            </span>
          </div>
          {noCapsConfigured && (
            <p className="note-warn" style={{ marginBottom: 0 }}>
              capability-scored 선택됨 — 어떤 세션에도 역량이 설정되지 않아 사실상 round-robin 으로 동작합니다. [세션] 탭에서
              역할을 지정하세요.
            </p>
          )}
          {policy === 'manual' && sessions.length > 0 && (
            <div className="grid-2" style={{ marginTop: 12 }}>
              {ASSIGNABLE_ROLES.map((role) => (
                <div key={role}>
                  <label className="field-label">{role}</label>
                  <select
                    className="field"
                    value={manual[role] ?? sessions[0]?.id ?? ''}
                    onChange={(e) => setManual((m) => ({ ...m, [role]: e.target.value }))}
                  >
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          {error && <p className="note-bad" style={{ marginBottom: 0 }}>오류: {error}</p>}
        </section>

        {/* 선택된 프로젝트 — 저장소 기준 진행 로그 + 보드. 탭/창 전환·재마운트해도 복원된다. */}
        {selectedId && (
          <>
            <section className="panel">
              <div className="panel-head">
                <span className="eyebrow">02 — STREAM</span>
                <h2 className="panel-title">진행 상황{selected ? ` · ${selected.title}` : ''}</h2>
                {selected && (
                  <div className="right">
                    <span className="chip" style={{ color: statusColor(selected.status), borderColor: 'currentColor' }}>
                      {selected.status}
                    </span>
                  </div>
                )}
              </div>
              <div className="log">
                {log.length === 0 && <p className="empty">기록된 진행 로그가 없습니다.</p>}
                {log.map((e, i) => (
                  <div key={i} className="log-line">
                    <span className="t">{e.type}</span>
                    <span>{e.message}</span>
                  </div>
                ))}
              </div>
            </section>

            {tasks.length > 0 && (
              <section className="panel">
                <div className="panel-head">
                  <span className="eyebrow">03 — BOARD</span>
                  <h2 className="panel-title">작업 보드</h2>
                  <div className="right">
                    <span className="chip">{tasks.length} tasks</span>
                  </div>
                </div>
                <ul className="list">
                  {tasks.map((t) => (
                    <li key={t.id} className="line-item">
                      <span
                        className="chip"
                        style={{ color: statusColor(t.status), borderColor: 'currentColor', minWidth: 62, justifyContent: 'center' }}
                      >
                        {t.status === 'skipped' ? '건너뜀' : t.status}
                      </span>
                      <span className="name">{t.title}</span>
                      {t.role && <span className="meta">{t.role}</span>}
                      {t.assignedLlmId && (
                        <span className="meta" title="실행 LLM" style={{ color: 'var(--accent, currentColor)' }}>
                          → {llmName(t.assignedLlmId)}
                        </span>
                      )}
                      {t.changedFiles && t.changedFiles.length > 0 && (
                        <span className="chip" title={t.changedFiles.join('\n')} style={{ marginLeft: 'auto' }}>
                          변경 {t.changedFiles.length}개
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {summary && (
              <section className="panel">
                <div className="panel-head">
                  <span className="eyebrow">04 — SUMMARY</span>
                  <h2 className="panel-title">최종 요약 / 누락 점검</h2>
                </div>
                <pre className="summary">{summary}</pre>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { AgentRole, AssignmentPolicy, LlmDescriptor, OrchestratorEvent, RunResult, Task } from '../../shared/types'
import { ASSIGNABLE_ROLES } from '../../shared/types'
import { statusColor } from '../ui'

interface Props {
  sessions: LlmDescriptor[]
}

export function ProjectPanel({ sessions }: Props) {
  const [goal, setGoal] = useState('')
  const [policy, setPolicy] = useState<AssignmentPolicy>('round-robin')
  const [manual, setManual] = useState<Partial<Record<AgentRole, string>>>({})
  const [running, setRunning] = useState(false)
  const [events, setEvents] = useState<OrchestratorEvent[]>([])
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsub = window.fleet.onOrchestratorEvent((e) => setEvents((prev) => [...prev, e]))
    return unsub
  }, [])

  async function run() {
    if (!goal.trim()) return
    setRunning(true)
    setEvents([])
    setResult(null)
    setError(null)
    try {
      const assignments =
        policy === 'manual'
          ? ASSIGNABLE_ROLES.map((role) => ({ role, llmId: manual[role] ?? sessions[0]?.id ?? '' }))
          : undefined
      const r = await window.fleet.runProject({ goal: goal.trim(), policy, assignments })
      setResult(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const tasks: Task[] = result?.tasks ?? []
  const canRun = sessions.length > 0 && goal.trim().length > 0 && !running
  const llmName = (id?: string) => (id ? (sessions.find((s) => s.id === id)?.displayName ?? id) : undefined)
  // capability-scored 인데 어떤 세션에도 역량이 없으면 사실상 round-robin — 침묵 격하 경고(2개 이상일 때만 의미).
  const noCapsConfigured =
    policy === 'capability-scored' && sessions.length > 1 && !sessions.some((s) => s.capabilities?.length)

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <span className="eyebrow">01 — GOAL</span>
          <h2 className="panel-title">프로젝트 목표</h2>
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

      {(events.length > 0 || running) && (
        <section className="panel">
          <div className="panel-head">
            <span className="eyebrow">02 — STREAM</span>
            <h2 className="panel-title">진행 상황</h2>
          </div>
          <div className="log">
            {events.map((e, i) => (
              <div key={i} className="log-line">
                <span className="t">{e.type}</span>
                <span>{e.message}</span>
              </div>
            ))}
          </div>
        </section>
      )}

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
                  {t.status}
                </span>
                <span className="name">{t.title}</span>
                {t.role && <span className="meta">{t.role}</span>}
                {t.assignedLlmId && (
                  <span className="meta" title="실행 LLM" style={{ color: 'var(--accent, currentColor)' }}>
                    → {llmName(t.assignedLlmId)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result?.summary && (
        <section className="panel">
          <div className="panel-head">
            <span className="eyebrow">04 — SUMMARY</span>
            <h2 className="panel-title">최종 요약 / 누락 점검</h2>
          </div>
          <pre className="summary">{result.summary}</pre>
        </section>
      )}
    </div>
  )
}

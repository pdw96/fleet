import { useEffect, useState } from 'react'
import type { AssignmentPolicy, LlmDescriptor, OrchestratorEvent, RunResult, Task } from '../../shared/types'
import { button, card, colors, input, label, statusColor } from '../ui'

interface Props {
  sessions: LlmDescriptor[]
}

export function ProjectPanel({ sessions }: Props) {
  const [goal, setGoal] = useState('')
  const [policy, setPolicy] = useState<AssignmentPolicy>('round-robin')
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
      const r = await window.fleet.runProject({ goal: goal.trim(), policy })
      setResult(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const tasks: Task[] = result?.tasks ?? []
  const canRun = sessions.length > 0 && goal.trim().length > 0 && !running

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section style={card}>
        <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>프로젝트 목표</h2>
        {sessions.length === 0 && (
          <p style={{ color: colors.amber, fontSize: 13 }}>먼저 [세션] 탭에서 LLM 세션을 1개 이상 등록하세요.</p>
        )}
        <textarea
          style={{ ...input, minHeight: 120, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="예: 사용자 인증이 있는 할 일 관리 REST API 를 만든다…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 10 }}>
          <div style={{ width: 200 }}>
            <label style={label}>역할 배정 정책</label>
            <select style={input} value={policy} onChange={(e) => setPolicy(e.target.value as AssignmentPolicy)}>
              <option value="round-robin">round-robin</option>
              <option value="capability-scored">capability-scored</option>
              <option value="manual">manual</option>
            </select>
          </div>
          <button style={{ ...button, marginLeft: 'auto' }} onClick={run} disabled={!canRun}>
            {running ? '실행 중…' : '오케스트레이션 실행'}
          </button>
        </div>
        {error && <p style={{ color: colors.red, fontSize: 13, marginTop: 10 }}>오류: {error}</p>}
      </section>

      {(events.length > 0 || running) && (
        <section style={card}>
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>진행 상황</h2>
          <div style={{ maxHeight: 180, overflow: 'auto', display: 'grid', gap: 4 }}>
            {events.map((e, i) => (
              <div key={i} style={{ fontSize: 12, color: colors.muted }}>
                <span style={{ color: colors.accent }}>{e.type}</span> · {e.message}
              </div>
            ))}
          </div>
        </section>
      )}

      {tasks.length > 0 && (
        <section style={card}>
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>작업 보드 ({tasks.length})</h2>
          <div style={{ display: 'grid', gap: 6 }}>
            {tasks.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 10px', background: colors.panel2, borderRadius: 6 }}>
                <span style={{ fontSize: 11, color: statusColor(t.status), border: `1px solid ${statusColor(t.status)}`, borderRadius: 4, padding: '1px 6px', minWidth: 56, textAlign: 'center' }}>
                  {t.status}
                </span>
                <div style={{ flex: 1 }}>
                  <strong style={{ fontSize: 13 }}>{t.title}</strong>
                  {t.role && <span style={{ color: colors.muted, fontSize: 11, marginLeft: 8 }}>{t.role}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {result?.summary && (
        <section style={card}>
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>최종 요약 / 누락 점검</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, color: colors.text, margin: 0 }}>
            {result.summary}
          </pre>
        </section>
      )}
    </div>
  )
}

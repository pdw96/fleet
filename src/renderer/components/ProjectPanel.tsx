import { useEffect, useRef, useState } from 'react'
import type { AgentRole, AssignmentPolicy, LlmDescriptor, Project, Task } from '../../shared/types'
import { ASSIGNABLE_ROLES, MAX_REPLAN_ROUNDS } from '../../shared/types'
import { statusColor } from '../ui'

interface Props {
  sessions: LlmDescriptor[]
}

/** 진행 로그 한 줄 — 저장소 재생(FleetEvent)과 라이브(OrchestratorEvent)를 동일 형태로 보관. */
interface LogLine {
  type: string
  message: string
  /** 영속 이벤트 id(스냅샷=FleetEvent.id, 라이브=data.eventId). 스냅샷·라이브 중복 dedup 용. task.progress 는 없음. */
  id?: string
}

export function ProjectPanel({ sessions }: Props) {
  // 새 프로젝트 폼 상태
  const [goal, setGoal] = useState('')
  const [policy, setPolicy] = useState<AssignmentPolicy>('round-robin')
  // 검증 실패가 verify-fix 로도 안 풀릴 때 planner 가 보정 작업을 분해해 재시도하는 라운드 수. 기본 0=비활성(opt-in).
  const [maxReplanRounds, setMaxReplanRounds] = useState(0)
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

  // 비동기 콜백이 '도착 시점'의 선택 방을 알도록 selectedId 를 ref 로 추적(스테일 클로저 방지).
  // selectProject() 가 방 전환 시 동기적으로 갱신한다 — 직후 도착하는 라이브 이벤트가 새 방 필터를 통과하도록.
  const selectedIdRef = useRef<string | null>(null)
  // 마운트 이후 한 번이라도 방을 선택했는지 — 마운트 자동선택이 실행 중 선택(project.created)을 덮어쓰지 않게 가드한다.
  const hasSelectedRef = useRef(false)
  // 선택 effect 의 스냅샷 로드가 끝나기 전에 도착해 log 에 append 된 라이브 행 수.
  // 로드 완료 시 스냅샷 뒤에 이 행들을 보존해 덮어쓰기로 인한 라이브 로그 유실을 막는다.
  const liveDuringLoadRef = useRef(0)
  // 보드(setTasks) 갱신의 단조 토큰 — refreshTasks 와 선택 effect 로드가 공유한다. 순서 뒤바뀐
  // getProjectTasks 응답이 최신 보드를 덮어쓰지 않게 하고(선택 스냅샷 vs 라이브 갱신 모두 포함) 최신 응답만 반영한다.
  const boardTokenRef = useRef(0)
  // 선택 스냅샷 로드의 단조 토큰 — 같은 방 재방문(P1→P2→P1)으로 중첩된 로드 중 최신 응답만 반영한다.
  const loadTokenRef = useRef(0)
  // 프로젝트 목록(setProjects) 갱신의 단조 토큰 — 근접 마일스톤들이 띄운 refreshProjects 응답이 순서 뒤바뀌어
  // 도착해도(예: 느린 plan.created 가 빠른 project.done 뒤에 resolve) 옛 스냅샷이 최신 목록/상태칩을 덮어쓰지 않게 한다.
  const projectsTokenRef = useRef(0)
  // 하이드레이션 레이스 가드: getRunActivity 스냅샷 resolve 전 도착한 라이브 *최종* 종료(project.done/
  // plan.failed)를 기록해, 스테일 스냅샷이 이미 끝난 실행을 "진행 중"으로 되살리지 않게 한다(라이브 우선).
  // run.cancelled 는 제외 — 취소 ack 시점엔 실행이 아직 revert 중(활성)이라 스냅샷이 복원해야 옳다(project.done
  // 까지 잠금 유지). 마운트 1회용이라 누적은 무해(ChatPanel 의 endedStreamsRef 와 동형).
  const endedRunsRef = useRef<Set<string>>(new Set())

  // 방 선택을 동기적으로 확정한다: selectedIdRef·카운터를 즉시 갱신하고 이전 방의 보드/로그/요약을 비운다.
  // 동기 처리라 (a) 직후 도착 라이브 이벤트가 새 방 필터를 통과하고(특히 막 생성된 프로젝트의 task.progress),
  // (b) 이전 방 내용이 새 방 제목 아래 잔류하지 않는다. 스냅샷 로드는 아래 선택 effect 가 이어받는다.
  function selectProject(pid: string | null) {
    // 이미 열린 방 재선택은 무시 — 클리어만 하고 setSelectedId 가 no-op 이라 재로드가 안 되면 빈 보드가 남는다.
    if (hasSelectedRef.current && pid === selectedIdRef.current) return
    hasSelectedRef.current = true
    selectedIdRef.current = pid
    liveDuringLoadRef.current = 0
    // 이전 방문의 in-flight 스냅샷/보드 응답을 즉시 무효화한다. 토큰 갱신을 선택 effect 로만 미루면,
    // 같은 방을 한 배치로 떠났다 돌아와(최종 selectedId 가 이전과 동일) [selectedId] effect 가 재실행되지 않는 경우
    // 옛 응답이 가드(loadToken/boardToken)를 통과해 보드/로그를 되돌릴 수 있다. 같은 방 재선택은 위에서 이미 제외.
    loadTokenRef.current += 1
    boardTokenRef.current += 1
    setTasks([])
    setLog([])
    setSummary('')
    setSelectedId(pid)
  }

  async function refreshProjects(): Promise<Project[]> {
    const token = ++projectsTokenRef.current
    const list = await window.fleet.listProjects()
    const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt) // 최신순
    // 더 새 refreshProjects 가 시작됐으면(순서 뒤바뀐 응답) setProjects 를 건너뛴다 — 반환값은 호출자(마운트 자동선택)용으로 유지.
    if (token === projectsTokenRef.current) setProjects(sorted)
    return sorted
  }

  async function refreshTasks(projectId: string): Promise<void> {
    const token = ++boardTokenRef.current
    const t = await window.fleet.getProjectTasks(projectId)
    // 다른 방으로 바뀌었거나(크로스-프로젝트) 더 새 보드 갱신이 시작됐으면(순서 뒤바뀐 응답) 폐기한다.
    if (selectedIdRef.current === projectId && token === boardTokenRef.current) setTasks(t)
  }

  // 마운트: 방 목록 로드 + 마지막 보던(없으면 최신) 프로젝트 자동 선택.
  useEffect(() => {
    void (async () => {
      const list = await refreshProjects()
      const last = await window.fleet.getLastActiveProject()
      const pick = last && list.some((p) => p.id === last) ? last : (list[0]?.id ?? null)
      // 마운트 await 동안 사용자가 이미 방을 선택했으면(예: 새 실행의 project.created) 자동선택으로 되돌리지 않는다.
      if (pick && !hasSelectedRef.current) selectProject(pick)
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
      // 취소 버튼용 in-flight id. selectProject 가 selectedIdRef 를 동기로 잡으므로 project.created 직후
      // 도착하는 task.progress(영속 안 됨, 재조회로 복원 불가)도 곧바로 라이브 로그 필터를 통과한다.
      if (e.type === 'project.created' && pid) {
        setActiveProjectId(pid)
        // running 잠금은 main 진행 신호로 켠다 — run() 을 호출하지 않은 마운트-옵저버도(스냅샷이 빈 사각
        // = created 직전 마운트) 진행 표시·동시 실행 차단을 얻는다. run() 호출자에겐 멱등(이미 true).
        setRunning(true)
        void refreshProjects()
        selectProject(pid) // 새 프로젝트를 바로 연다(ref 동기 갱신)
      }
      // 실행의 *최종* 종료(완료/계획실패): in-flight id·running 해제 + 목록 갱신 + 하이드레이션 가드 기록.
      // run() 을 시작하지 않은 마운트-옵저버 인스턴스(탭/창 전환 후 재마운트)도 여기서 사이드바·상태칩을
      // 갱신하고, 스냅샷으로 하이드레이트된 running 을 해제한다(이 인스턴스엔 풀어줄 run() 프로미스가 없다).
      // run.cancelled 는 *취소 ack* 일 뿐 — 오케스트레이터는 그 뒤에도 현재 작업을 revert 하며 unwinding 하고
      // 나중에 project.done 을 방출한다. running 잠금을 취소 ack 에서 풀면 그 정리 윈도우 동안 폼이 재활성돼
      // 두 번째 실행이 revert 와 경합(워크스페이스 파괴)할 수 있으므로, 잠금은 project.done/실패까지 유지한다
      // (engine 의 동시 실행 가드·activeRuns 도 cancelRun 에서 제거하지 않고 project.done 까지 유지 — 대칭).
      if ((e.type === 'project.done' || e.type === 'plan.failed') && pid) {
        endedRunsRef.current.add(pid) // 하이드레이션 레이스 가드(스냅샷 되살림 방지)
        setActiveProjectId((cur) => (cur === pid ? null : cur))
        setRunning(false)
        void refreshProjects()
      }
      // 취소 ack: 사이드바/로그만 갱신한다(running·activeProjectId 는 project.done 까지 유지 — 위 참조).
      if (e.type === 'run.cancelled' && pid) void refreshProjects()
      // 상태 전환 마일스톤도 목록 갱신 — planning→executing(plan.created), executing→verifying(verify.*).
      // 그러지 않으면 실행/검증 내내 사이드바·상태칩이 이전 단계(planning/executing)에 고착된다.
      // (verify.passed/failed/fixing 은 orchestrator 가 status 를 verifying 으로 바꾼 뒤 방출한다.)
      if (
        (e.type === 'plan.created' ||
          e.type === 'verify.passed' ||
          e.type === 'verify.failed' ||
          e.type === 'verify.fixing') &&
        pid
      )
        void refreshProjects()
      // 현재 열려 있는 프로젝트의 이벤트만 라이브 로그/보드에 반영(크로스-프로젝트 누수 방지).
      if (pid && pid === selectedIdRef.current) {
        const eventId = typeof e.data?.['eventId'] === 'string' ? (e.data['eventId'] as string) : undefined
        setLog((prev) => [...prev, { type: e.type, message: e.message, id: eventId }])
        liveDuringLoadRef.current += 1 // 진행 중 로드가 끝날 때 스냅샷 뒤로 보존할 라이브 행 카운트(아래 선택 effect 가 리셋·소비)
        // 보드는 마일스톤에서만 갱신. refreshTasks 가 boardToken 으로 순서를 보장하고, 선택 스냅샷보다 새 갱신이면
        // 스냅샷 setTasks 를 자연히 폐기시킨다(별도 플래그 불필요).
        if (e.type !== 'task.progress') void refreshTasks(pid)
      }
    })
    return unsub
  }, [])

  // 마운트 시 진행 중 실행 스냅샷 복원(단일 소스 오브 트루스) — 탭 재진입으로 로컬 state(running/activeProjectId)가
  // 날아가도 main 이 보유한 in-flight 실행을 되살려 (a) 취소 버튼 소실과 (b) running 해제로 인한 동시 2번째 실행
  // 시도(엔진 가드가 거부하지만 UX 가 나쁘다)를 막는다. 구독(onOrchestratorEvent)을 먼저 건 뒤 조회해, 조회와
  // 라이브 종료 이벤트 사이 간극을 최소화한다(라이브 우선 — 윈도우 중 끝난 실행은 endedRunsRef 로 거른다).
  useEffect(() => {
    void window.fleet.getRunActivity().then((a) => {
      // 스냅샷은 조회 시점값이라 resolve 전 도착한 라이브 종료보다 스테일할 수 있다. 이미 끝난 실행은 되살리지 않는다.
      const live = a.activeProjectIds.filter((pid) => !endedRunsRef.current.has(pid))
      if (live.length === 0) return // 진행 중 실행 없음 — 라이브가 이미 종료를 반영했거나 애초에 없었다.
      // 라이브 created 가 이미 잡았으면 그 값을 유지(라이브 우선). 순차 전제상 단일 실행이라 충돌은 없다.
      setActiveProjectId((cur) => cur ?? live[0])
      setRunning(true)
    })
  }, [])

  // 선택 변경: 저장소 스냅샷 로드(보드/로그)와 마지막 선택 영속. 보드/로그/요약 비우기와 카운터 리셋은
  // selectProject 가 선택 시점에 동기로 끝냈다(여기서 다시 비우면 그 사이 도착한 라이브 행을 잃는다).
  useEffect(() => {
    if (!selectedId) return // selectProject(null) 이 이미 보드/로그/요약을 비웠다
    void window.fleet.setLastActiveProject(selectedId)
    const token = ++loadTokenRef.current // 이 로드의 신원 — 같은 방 재방문으로 중첩된 로드 중 최신만 반영
    const boardToken = ++boardTokenRef.current // 보드 갱신 토큰 — 로드 중 라이브 refreshTasks 가 더 새 토큰을 만들면 이 스냅샷 setTasks 는 폐기
    void (async () => {
      const [t, ev] = await Promise.all([
        window.fleet.getProjectTasks(selectedId),
        window.fleet.listProjectEvents(selectedId),
      ])
      // 더 새 로드가 시작됐거나(같은 방 재방문) 다른 방으로 바뀌었으면 오래된 응답을 버린다.
      if (loadTokenRef.current !== token || selectedIdRef.current !== selectedId) return
      // 로드 중(또는 이후) 라이브 refreshTasks 가 보드를 더 최신으로 갱신했으면 오래된 스냅샷으로 덮어쓰지 않는다.
      if (boardToken === boardTokenRef.current) setTasks(t)
      const snapshot: LogLine[] = ev.map((e) => ({ type: e.type, message: e.message ?? '', id: e.id }))
      const snapshotIds = new Set(snapshot.map((s) => s.id))
      // 로드 중 도착한 라이브 행을 스냅샷 뒤에 보존하되, 스냅샷에 이미 영속된 같은 id 의 행만 중복으로 제외한다.
      // id 로 dedup 하므로 (type,message)가 같은 서로 다른 마일스톤(예: 여러 작업의 '리뷰 승인')은 보존되고,
      // id 없는 task.progress 도 항상 보존된다.
      setLog((prev) => {
        const tail = prev.slice(prev.length - liveDuringLoadRef.current)
        const fresh = tail.filter((r) => !(r.id && snapshotIds.has(r.id)))
        return [...snapshot, ...fresh]
      })
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
      const r = await window.fleet.runProject({ goal: goal.trim(), policy, assignments, maxReplanRounds })
      if (selectedIdRef.current === r.projectId) setSummary(r.summary) // 끝난 프로젝트가 아직 열려 있을 때만 요약 표시
      await refreshProjects()
      if (selectedIdRef.current) await refreshTasks(selectedIdRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      // 실행이 거부돼도 오케스트레이터가 프로젝트를 failed 로 표시했을 수 있으니 사이드바/상태칩을 갱신한다.
      await refreshProjects().catch(() => undefined)
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
        <button className="room-btn" data-active={selectedId === null} onClick={() => selectProject(null)}>
          + 새 프로젝트
        </button>
        {projects.map((p) => (
          <button key={p.id} className="room-btn" data-active={p.id === selectedId} onClick={() => selectProject(p.id)}>
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
            <div style={{ width: 160 }}>
              <label className="field-label" title="검증 실패가 verify-fix 로도 안 풀릴 때 planner 가 보정 작업을 추가 생성해 재시도하는 라운드 수">
                보정 재계획
              </label>
              <select
                className="field"
                aria-label="보정 재계획"
                value={maxReplanRounds}
                onChange={(e) => setMaxReplanRounds(Number(e.target.value))}
              >
                {/* 옵션은 공유 상수 MAX_REPLAN_ROUNDS 에서 파생 — engine 클램프 상한과 단일 진실 원천(표류 방지). */}
                {Array.from({ length: MAX_REPLAN_ROUNDS + 1 }, (_, n) => (
                  <option key={n} value={n}>
                    {n === 0 ? '비활성' : `${n}회`}
                  </option>
                ))}
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

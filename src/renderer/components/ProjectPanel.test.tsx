/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetEvent, LlmDescriptor, OrchestratorEvent, Project, RunResult, Task } from '../../shared/types'
import { ProjectPanel } from './ProjectPanel'

function mockFleet(overrides: Record<string, unknown> = {}) {
  let emit: ((e: OrchestratorEvent) => void) | undefined
  const fleet = {
    onOrchestratorEvent: vi.fn((cb: (e: OrchestratorEvent) => void) => {
      emit = cb
      return () => {
        emit = undefined
      }
    }),
    getWorkspace: vi.fn().mockResolvedValue(null),
    selectWorkspace: vi.fn().mockResolvedValue(null),
    runProject: vi.fn().mockResolvedValue({ projectId: 'p', tasks: [], summary: '' }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue([]),
    getProjectTasks: vi.fn().mockResolvedValue([]),
    listProjectEvents: vi.fn().mockResolvedValue([]),
    getLastActiveProject: vi.fn().mockResolvedValue(null),
    setLastActiveProject: vi.fn().mockResolvedValue(undefined),
    getRunActivity: vi.fn().mockResolvedValue({ activeProjectIds: [] }),
    ...overrides,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return Object.assign(fleet, {
    fire: (e: OrchestratorEvent) => act(() => emit?.(e)),
    // 여러 이벤트를 단일 act 로 방출 — 그 사이 effect 가 flush 되지 않아 핸들러 간 동기 레이스를 재현한다.
    fireBatch: (...events: OrchestratorEvent[]) => act(() => events.forEach((e) => emit?.(e))),
  })
}

const SESSION: LlmDescriptor = { id: 'llm-1', kind: 'cli', displayName: 'Claude', ref: 'claude' }
const P1: Project = { id: 'p1', goal: '로그인', title: '로그인 기능', status: 'done', createdAt: 1, updatedAt: 2 }
const P2: Project = { id: 'p2', goal: '결제', title: '결제 연동', status: 'executing', createdAt: 3, updatedAt: 4 }
const T1: Task = {
  id: 't1', projectId: 'p1', title: '구현 A', description: '', status: 'done',
  dependsOn: [], changedFiles: ['a.ts', 'b.ts'], createdAt: 0, updatedAt: 0,
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('ProjectPanel', () => {
  it('shows the workspace-inactive hint and disables run without sessions', async () => {
    mockFleet()
    render(<ProjectPanel sessions={[]} />)
    expect(await screen.findByText(/워크스페이스 미설정/)).toBeTruthy()
    const runBtn = screen.getByRole('button', { name: '오케스트레이션 실행' }) as HTMLButtonElement
    expect(runBtn.disabled).toBe(true)
  })

  it('shows the active workspace path when one is set', async () => {
    mockFleet({ getWorkspace: vi.fn().mockResolvedValue('/tmp/ws') })
    render(<ProjectPanel sessions={[]} />)
    expect(await screen.findByText(/산출물·검증 활성/)).toBeTruthy()
  })

  it('lists existing projects in the sidebar on mount', async () => {
    mockFleet({ listProjects: vi.fn().mockResolvedValue([P1, P2]) })
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('로그인 기능')).toBeTruthy()
    expect(screen.getByText('결제 연동')).toBeTruthy()
  })

  it('loads board and log from the store when a project is auto-selected', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks: vi.fn().mockResolvedValue([T1]),
      listProjectEvents: vi.fn().mockResolvedValue([
        { id: 'e1', type: 'plan.created', message: '2개 작업으로 분해', data: { projectId: 'p1' }, ts: 1 },
      ]),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy()
    expect(screen.getByText('2개 작업으로 분해')).toBeTruthy()
    expect(fleet.getProjectTasks).toHaveBeenCalledWith('p1')
    expect(fleet.listProjectEvents).toHaveBeenCalledWith('p1')
  })

  it('restores the board after unmount/remount without relying on the runProject return', async () => {
    mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks: vi.fn().mockResolvedValue([T1]),
    })
    const view = render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy()
    view.unmount()
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy()
  })

  it('ignores live events for a project other than the selected one', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    fleet.fire({ type: 'task.done', message: '다른 프로젝트 작업 완료', data: { projectId: 'OTHER' } })
    expect(screen.queryByText('다른 프로젝트 작업 완료')).toBeNull()
  })

  it('shows a 취소 button while running and calls cancelRun with the in-flight projectId', async () => {
    const fleet = mockFleet({ runProject: vi.fn(() => new Promise(() => {})) })
    render(<ProjectPanel sessions={[SESSION]} />)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    fleet.fire({ type: 'project.created', message: '프로젝트 생성', data: { projectId: 'proj-9' } })
    const cancelBtn = await screen.findByRole('button', { name: '취소' })
    fireEvent.click(cancelBtn)
    await act(async () => {})
    expect(fleet.cancelRun).toHaveBeenCalledWith('proj-9')
  })

  it('appends a live event for the selected project to the log', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    fleet.fire({ type: 'task.done', message: '구현 A 완료', data: { projectId: 'p1' } })
    expect(await screen.findByText('구현 A 완료')).toBeTruthy()
  })

  // Now ④(#12): 보정 재계획 라운드 셀렉트 값이 runProject 요청으로 전달돼야 한다(데드코드였던 maxReplanRounds 활성화).
  it('passes the selected maxReplanRounds to runProject', async () => {
    const fleet = mockFleet()
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.change(screen.getByLabelText('보정 재계획'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' })) })
    expect(fleet.runProject).toHaveBeenCalledWith(expect.objectContaining({ maxReplanRounds: 2 }))
  })

  // 기본값(비활성=0)은 그대로 전달돼 무회귀(opt-in 유지).
  it('defaults maxReplanRounds to 0 (replan disabled) when the select is untouched', async () => {
    const fleet = mockFleet()
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' })) })
    expect(fleet.runProject).toHaveBeenCalledWith(expect.objectContaining({ maxReplanRounds: 0 }))
  })

  // ② 실행이 거부되면(예: planner 미배정) store 가 프로젝트를 failed 로 표시했을 수 있으니 사이드바/상태칩을 갱신한다.
  it('refreshes the project list when a run is rejected', async () => {
    const fleet = mockFleet({
      runProject: vi.fn().mockRejectedValue(new Error('planner 역할에 배정된 LLM 세션이 없습니다.')),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    const before = fleet.listProjects.mock.calls.length
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    expect(await screen.findByText(/planner 역할/)).toBeTruthy()
    expect(fleet.listProjects.mock.calls.length).toBeGreaterThan(before)
  })

  // ③ 실행 중 다른 방으로 전환하면, 끝난 실행의 요약이 전환된 방 아래 표시돼선 안 된다.
  it('does not show a finished run summary under a different selected project', async () => {
    let resolveRun: (r: RunResult) => void = () => {}
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      runProject: vi.fn(() => new Promise<RunResult>((res) => { resolveRun = res })),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    fleet.fire({ type: 'project.created', message: '생성', data: { projectId: 'pA' } }) // pA 가 열린다
    fireEvent.click(screen.getByText('로그인 기능')) // 다른 방(P1)으로 전환
    await act(async () => {})
    await act(async () => { resolveRun({ projectId: 'pA', tasks: [], summary: 'A프로젝트요약' }) })
    expect(screen.queryByText('A프로젝트요약')).toBeNull()
  })

  // ④ 스냅샷 로드 중 도착한 라이브 로그 행이 스냅샷 교체로 유실되지 않아야 한다.
  it('preserves a live log row that arrives while the selection snapshot is loading', async () => {
    let resolveEvents: (e: FleetEvent[]) => void = () => {}
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      listProjectEvents: vi.fn(() => new Promise<FleetEvent[]>((res) => { resolveEvents = res })),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    await vi.waitFor(() => expect(fleet.listProjectEvents).toHaveBeenCalledWith('p1')) // 선택 effect 가 스냅샷 로드 디스패치
    fleet.fire({ type: 'task.done', message: '로딩중도착', data: { projectId: 'p1' } }) // 로드 중 라이브 도착
    await act(async () => {
      resolveEvents([{ id: 'e1', type: 'plan.created', message: '계획됨', data: { projectId: 'p1' }, ts: 1 }])
    })
    expect(screen.getByText('계획됨')).toBeTruthy() // 스냅샷 행
    expect(screen.getByText('로딩중도착')).toBeTruthy() // 보존된 라이브 행
  })

  // ⑤ run() 프로미스가 없는 마운트-옵저버도 project.done 라이브 이벤트로 프로젝트 목록을 갱신해야 한다.
  it('refreshes the project list when a live run finishes on a mounted observer', async () => {
    const running = { ...P2, status: 'executing' as const }
    const finished = { ...P2, status: 'done' as const }
    const listProjects = vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([finished])
    const fleet = mockFleet({ listProjects, getLastActiveProject: vi.fn().mockResolvedValue('p2') })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('결제 연동')
    const before = listProjects.mock.calls.length
    await act(async () => { fleet.fire({ type: 'project.done', message: '완료', data: { projectId: 'p2' } }) })
    expect(listProjects.mock.calls.length).toBeGreaterThan(before) // 종료 시 refreshProjects 호출됨
    expect(screen.getAllByText('done').length).toBeGreaterThan(0) // 상태칩이 갱신됨
  })

  // ⑨ plan.created(planning → executing) 전환에서도 목록을 갱신해 상태칩이 planning 에 고착되지 않아야 한다.
  it('refreshes the project list on plan.created so the status chip is not stuck on planning', async () => {
    const planning = { ...P2, status: 'planning' as const }
    const executing = { ...P2, status: 'executing' as const }
    const listProjects = vi.fn().mockResolvedValueOnce([planning]).mockResolvedValue([executing])
    const fleet = mockFleet({ listProjects, getLastActiveProject: vi.fn().mockResolvedValue('p2') })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('결제 연동')
    const before = listProjects.mock.calls.length
    await act(async () => { fleet.fire({ type: 'plan.created', message: '2개 작업으로 분해', data: { projectId: 'p2' } }) })
    expect(listProjects.mock.calls.length).toBeGreaterThan(before) // plan.created 에서 refreshProjects 호출됨
    expect(screen.getAllByText('executing').length).toBeGreaterThan(0) // planning 고착 아님
  })

  // ⑥ 마일스톤이 스냅샷과 라이브 tail 양쪽에 있어도 로그 행이 중복되지 않아야 한다.
  it('does not duplicate a milestone present in both the snapshot and the live tail', async () => {
    let resolveEvents: (e: FleetEvent[]) => void = () => {}
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      listProjectEvents: vi.fn(() => new Promise<FleetEvent[]>((res) => { resolveEvents = res })),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    await vi.waitFor(() => expect(fleet.listProjectEvents).toHaveBeenCalledWith('p1'))
    // 라이브 이벤트는 영속 id(eventId)를 함께 싣고 온다(orchestrator emit). 스냅샷의 같은 id 와 dedup 된다.
    fleet.fire({ type: 'task.done', message: '구현 A 완료', data: { projectId: 'p1', eventId: 'e1' } })
    await act(async () => {
      // 메인이 먼저 영속해 스냅샷에도 같은 id 의 마일스톤이 포함된 채 도착
      resolveEvents([{ id: 'e1', type: 'task.done', message: '구현 A 완료', data: { projectId: 'p1' }, ts: 1 }])
    })
    expect(screen.getAllByText('구현 A 완료')).toHaveLength(1) // 같은 id → 중복 아님
  })

  // ⑪ id 가 다른 반복 마일스톤(같은 type·message)은 dedup 으로 유실되지 않아야 한다.
  it('preserves distinct repeated milestones that share type and message', async () => {
    let resolveEvents: (e: FleetEvent[]) => void = () => {}
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      listProjectEvents: vi.fn(() => new Promise<FleetEvent[]>((res) => { resolveEvents = res })),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    await vi.waitFor(() => expect(fleet.listProjectEvents).toHaveBeenCalledWith('p1'))
    // 로드 중 두 번째 '리뷰 승인'(id e2)이 라이브로 도착 — 스냅샷의 첫 번째(id e1)와 같은 message 지만 다른 이벤트.
    fleet.fire({ type: 'task.review', message: '리뷰 승인', data: { projectId: 'p1', eventId: 'e2' } })
    await act(async () => {
      resolveEvents([{ id: 'e1', type: 'task.review', message: '리뷰 승인', data: { projectId: 'p1' }, ts: 1 }])
    })
    expect(screen.getAllByText('리뷰 승인')).toHaveLength(2) // 서로 다른 id → 둘 다 보존
  })

  // ⑩ 방 전환 시 이전 방의 보드·로그가 새 방 제목 아래 잔류하지 않아야 한다(동기 클리어).
  it('clears the previous board and log synchronously when switching projects', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1, P2]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks: vi.fn().mockResolvedValue([T1]),
      listProjectEvents: vi.fn().mockResolvedValue([
        { id: 'e1', type: 'plan.created', message: 'A 진행로그', data: { projectId: 'p1' }, ts: 1 },
      ]),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy() // P1 보드 로드됨
    expect(screen.getByText('A 진행로그')).toBeTruthy()
    // P2 로 전환 시 스냅샷을 지연시켜, 동기 클리어 여부만 검증
    fleet.getProjectTasks.mockImplementationOnce(() => new Promise<Task[]>(() => {}))
    fleet.listProjectEvents.mockImplementationOnce(() => new Promise<FleetEvent[]>(() => {}))
    await act(async () => { fireEvent.click(screen.getByText('결제 연동')) })
    expect(screen.queryByText('변경 2개')).toBeNull() // 이전 보드 잔류 안 함
    expect(screen.queryByText('A 진행로그')).toBeNull() // 이전 로그 잔류 안 함
  })

  // ⑦ 방 전환 시 이전 요약을 스냅샷 로드 완료 전(동기)에 제거해야 한다.
  it('clears a visible summary synchronously when switching projects', async () => {
    const getProjectTasks = vi.fn().mockResolvedValue([])
    mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1, P2]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks,
      runProject: vi.fn().mockResolvedValue({ projectId: 'p1', tasks: [], summary: 'S요약' }),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' })) })
    expect(await screen.findByText('S요약')).toBeTruthy() // p1 에 요약 표시(selectedId 유지)
    // P2 선택 시 스냅샷을 지연시켜, 동기 클리어 여부만 검증
    getProjectTasks.mockImplementationOnce(() => new Promise<Task[]>(() => {}))
    await act(async () => { fireEvent.click(screen.getByText('결제 연동')) })
    expect(screen.queryByText('S요약')).toBeNull() // 스냅샷 resolve 전에 이미 사라져야 함
  })

  // ⑧ 스냅샷 로드 중 라이브 마일스톤이 더 최신 보드를 만들면, 옛 스냅샷으로 덮어쓰지 않아야 한다.
  it('does not overwrite a newer live board update with the stale selection snapshot', async () => {
    const OLD: Task[] = [{ ...T1, status: 'running', changedFiles: [] }]
    const NEW: Task[] = [{ ...T1, status: 'done', changedFiles: ['a.ts', 'b.ts'] }]
    let resolveSnapshot: (t: Task[]) => void = () => {}
    const getProjectTasks = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Task[]>((res) => { resolveSnapshot = res })) // 선택 스냅샷(지연)
      .mockResolvedValue(NEW) // 라이브 refreshTasks 는 최신 보드
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks,
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    await vi.waitFor(() => expect(getProjectTasks).toHaveBeenCalledWith('p1'))
    await act(async () => { fleet.fire({ type: 'task.done', message: '구현 A 완료', data: { projectId: 'p1' } }) }) // 라이브 → NEW
    await act(async () => { resolveSnapshot(OLD) }) // 지연된 스냅샷이 OLD 로 늦게 도착
    expect(screen.getByText('변경 2개')).toBeTruthy() // NEW 유지(OLD 로 덮어쓰지 않음)
  })

  // N: 같은 방 재방문(P2 → P1 → P2) 중 첫 P2 로드가 늦게 도착해도 최신 P2 결과를 덮어쓰지 않아야 한다.
  // (refreshProjects 가 updatedAt 내림차순 정렬 → 마운트는 P2 를 자동선택한다.)
  it('ignores a stale snapshot load after revisiting the same project', async () => {
    const OLD: Task[] = [{ ...T1, changedFiles: [] }] // 변경 chip 없음
    const NEW: Task[] = [{ ...T1, changedFiles: ['a.ts', 'b.ts'] }] // 변경 2개
    let resolveOld: (t: Task[]) => void = () => {}
    const getProjectTasks = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Task[]>((res) => { resolveOld = res })) // #1 P2 마운트 자동선택(지연 OLD)
      .mockResolvedValueOnce([]) // #2 P1
      .mockResolvedValue(NEW) // #3 P2 재방문(즉시 NEW)
    mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1, P2]),
      getProjectTasks,
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('결제 연동')
    await vi.waitFor(() => expect(getProjectTasks).toHaveBeenCalledTimes(1)) // 마운트 P2 자동선택 로드(#1, 지연) 디스패치됨
    await act(async () => { fireEvent.click(screen.getByText('로그인 기능')) }) // P1 (#2)
    await act(async () => { fireEvent.click(screen.getByText('결제 연동')) }) // P2 재방문 (#3 → NEW)
    expect(await screen.findByText('변경 2개')).toBeTruthy() // 최신 로드(NEW) 반영
    await act(async () => { resolveOld(OLD) }) // 지연된 첫 P2 로드가 늦게 도착
    expect(screen.getByText('변경 2개')).toBeTruthy() // OLD 로 회귀하지 않음
  })

  // O: project.created 직후 도착하는 task.progress(영속 안 됨)가 ref 스테일로 드롭되지 않아야 한다.
  it('keeps task.progress that arrives immediately after project.created auto-select', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([]),
      getProjectTasks: vi.fn().mockResolvedValue([]),
      listProjectEvents: vi.fn().mockResolvedValue([]), // 새 프로젝트라 영속 이벤트 없음
      runProject: vi.fn(() => new Promise(() => {})), // 실행 진행 중(미완)
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    // 두 이벤트를 한 act 로 방출 — project.created 와 task.progress 사이에 selectedIdRef 동기화 effect 가
    // flush 되지 않게 해 실제 레이스(직후 task.progress)를 재현한다.
    fleet.fireBatch(
      { type: 'project.created', message: '생성', data: { projectId: 'pX' } }, // pX 자동선택(ref 동기)
      { type: 'task.progress', message: '토큰스트림조각', data: { projectId: 'pX' } }, // 직후 도착
    )
    expect(await screen.findByText('토큰스트림조각')).toBeTruthy() // 드롭되지 않고 라이브 로그 보존
  })

  // P: 이미 열린 방을 다시 클릭해도 보드/로그가 비워진 채 남지 않아야 한다(재선택 no-op).
  it('keeps the board and log when reselecting the already-active project', async () => {
    mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks: vi.fn().mockResolvedValue([T1]),
      listProjectEvents: vi.fn().mockResolvedValue([
        { id: 'e1', type: 'plan.created', message: 'A 진행로그', data: { projectId: 'p1' }, ts: 1 },
      ]),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    expect(await screen.findByText('변경 2개')).toBeTruthy() // P1 보드 로드됨
    expect(screen.getByText('A 진행로그')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByText('로그인 기능')) }) // 이미 선택된 P1 재클릭
    expect(screen.getByText('변경 2개')).toBeTruthy() // 보드 유지(빈 보드로 안 남음)
    expect(screen.getByText('A 진행로그')).toBeTruthy() // 로그 유지
  })

  // Q: 마운트 자동선택이 await 중일 때 새 실행이 선택한 프로젝트를 뒤늦게 덮어쓰면 안 된다.
  it('does not let a slow mount auto-select override a run-created selection', async () => {
    let resolveLast: (v: string | null) => void = () => {}
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn(() => new Promise<string | null>((res) => { resolveLast = res })), // 자동선택 지연
      getProjectTasks: vi.fn().mockResolvedValue([]),
      listProjectEvents: vi.fn().mockResolvedValue([]),
      runProject: vi.fn(() => new Promise(() => {})),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능') // 사이드바 로드됨, 자동선택은 getLastActiveProject 펜딩으로 보류
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    await fleet.fire({ type: 'project.created', message: '생성', data: { projectId: 'pX' } }) // pX 선택
    await fleet.fire({ type: 'task.done', message: 'pX작업완료', data: { projectId: 'pX' } }) // pX 라이브 로그
    expect(await screen.findByText('pX작업완료')).toBeTruthy()
    await act(async () => { resolveLast('p1') }) // 지연된 자동선택이 옛 last(p1)로 해소
    expect(screen.getByText('pX작업완료')).toBeTruthy() // 여전히 pX (p1 으로 안 바뀜)
  })

  // R: 근접 도착한 두 마일스톤의 보드 갱신이 순서 뒤바뀌어도 보드가 역행하지 않아야 한다.
  it('discards an out-of-order live board refresh (no board regression)', async () => {
    const RUNNING: Task[] = [{ ...T1, status: 'running', changedFiles: [] }]
    const DONE: Task[] = [{ ...T1, status: 'done', changedFiles: ['a.ts', 'b.ts'] }]
    let resolveFirst: (t: Task[]) => void = () => {}
    const getProjectTasks = vi
      .fn()
      .mockResolvedValueOnce(RUNNING) // #1 선택 스냅샷(마운트)
      .mockImplementationOnce(() => new Promise<Task[]>((res) => { resolveFirst = res })) // #2 라이브 refresh A(지연)
      .mockResolvedValue(DONE) // #3 라이브 refresh B(즉시 DONE)
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks,
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await vi.waitFor(() => expect(getProjectTasks).toHaveBeenCalledTimes(1)) // 선택 스냅샷(#1)
    await act(async () => { fleet.fire({ type: 'task.review', message: 'r1', data: { projectId: 'p1' } }) }) // refresh A(#2, 지연)
    await act(async () => { fleet.fire({ type: 'task.done', message: 'r2', data: { projectId: 'p1' } }) }) // refresh B(#3 → DONE)
    expect(await screen.findByText('변경 2개')).toBeTruthy() // 최신(DONE) 반영
    await act(async () => { resolveFirst(RUNNING) }) // 지연된 refresh A 가 늦게 도착
    expect(screen.getByText('변경 2개')).toBeTruthy() // DONE 유지(RUNNING 으로 역행 안 함)
  })

  // S: 같은 방을 한 배치로 떠났다 돌아오면(최종 selectedId 가 이전과 동일 → [selectedId] effect 미실행)
  //    이전 방문의 지연 스냅샷이 늦게 도착해도 보드를 옛 상태로 되돌리지 않아야 한다.
  //    선택 effect 가 재실행되지 않으므로 토큰 무효화는 selectProject 가 동기로 해야 한다.
  it('invalidates a stale snapshot load when leaving and re-entering a room in one batch', async () => {
    const OLD: Task[] = [{ ...T1, title: '옛작업' }]
    let resolveOld: (t: Task[]) => void = () => {}
    const getProjectTasks = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Task[]>((res) => { resolveOld = res })) // #1 마운트 p1 선택(지연 OLD)
      .mockResolvedValue([]) // 이후 로드
    mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'),
      getProjectTasks,
      listProjectEvents: vi.fn().mockResolvedValue([]),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('로그인 기능')
    await vi.waitFor(() => expect(getProjectTasks).toHaveBeenCalledTimes(1)) // #1(지연) 디스패치, selectedId=p1 커밋
    // + 새 프로젝트(null) → p1 을 단일 act 로 — 최종 selectedId 가 다시 p1 이라 [selectedId] effect 가 재실행되지 않는다.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '+ 새 프로젝트' }))
      fireEvent.click(screen.getByText('로그인 기능'))
    })
    expect(getProjectTasks).toHaveBeenCalledTimes(1) // 전제: 선택 effect 가 재실행되지 않아 재로드가 없음
    await act(async () => { resolveOld(OLD) }) // 지연된 첫 로드가 늦게 도착
    expect(screen.queryByText('옛작업')).toBeNull() // 옛 스냅샷이 보드를 되돌리지 않음
  })

  // T: 근접한 두 마일스톤의 refreshProjects 응답이 순서 뒤바뀌어 도착해도 상태칩이 옛 스냅샷으로 역행하지 않아야 한다.
  it('discards an out-of-order project list refresh (no status chip regression)', async () => {
    const executing = { ...P2, status: 'executing' as const }
    const done = { ...P2, status: 'done' as const }
    let resolveSlow: (p: Project[]) => void = () => {}
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce([executing]) // #1 마운트
      .mockImplementationOnce(() => new Promise<Project[]>((res) => { resolveSlow = res })) // #2 plan.created(느림 → executing)
      .mockResolvedValue([done]) // #3 project.done(즉시 → done)
    const fleet = mockFleet({ listProjects, getLastActiveProject: vi.fn().mockResolvedValue('p2') })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('결제 연동')
    // 두 마일스톤을 단일 배치로 — 핸들러가 refreshProjects 두 개를 순서대로 디스패치(plan.created #2, project.done #3)
    await act(async () => {
      fleet.fireBatch(
        { type: 'plan.created', message: '계획', data: { projectId: 'p2' } }, // #2 (느림)
        { type: 'project.done', message: '완료', data: { projectId: 'p2' } }, // #3 (즉시 done)
      )
    })
    expect(screen.getAllByText('done').length).toBeGreaterThan(0) // #3 가 done 반영
    await act(async () => { resolveSlow([executing]) }) // 느린 #2 가 늦게 executing 으로 도착
    expect(screen.queryAllByText('executing').length).toBe(0) // executing 으로 역행 안 함
    expect(screen.getAllByText('done').length).toBeGreaterThan(0) // done 유지
  })

  // U: verifying 단계 진입 시(verify.* 이벤트)에도 목록을 갱신해 상태칩이 executing 에 고착되지 않아야 한다.
  it('refreshes the project list on verify events so the status reflects verifying', async () => {
    const executing = { ...P2, status: 'executing' as const }
    const verifying = { ...P2, status: 'verifying' as const }
    const listProjects = vi.fn().mockResolvedValueOnce([executing]).mockResolvedValue([verifying])
    const fleet = mockFleet({ listProjects, getLastActiveProject: vi.fn().mockResolvedValue('p2') })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('결제 연동')
    const before = listProjects.mock.calls.length
    await act(async () => {
      fleet.fire({ type: 'verify.fixing', message: '검증 실패 — 수정 시도 (라운드 1)', data: { projectId: 'p2' } })
    })
    expect(listProjects.mock.calls.length).toBeGreaterThan(before) // verify.fixing 에서 refreshProjects 호출됨
    expect(screen.getAllByText('verifying').length).toBeGreaterThan(0) // executing 고착 아님
  })

  // V(Next②): 재마운트 시 getRunActivity 스냅샷으로 진행 중 실행을 복원한다 — 취소 버튼이 되살아나고
  //           run 버튼이 비활성(running)으로 잠겨 동시 2번째 실행 시도가 차단된다(엔진 가드 우회 UX 방지).
  it('restores the in-flight run (취소 button + running lock) from getRunActivity on mount', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P2]),
      getLastActiveProject: vi.fn().mockResolvedValue('p2'),
      getRunActivity: vi.fn().mockResolvedValue({ activeProjectIds: ['p2'] }),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    // 스냅샷 복원으로 취소 버튼이 나타난다(run() 프로미스 없이도 — 마운트-옵저버).
    expect(await screen.findByRole('button', { name: '취소' })).toBeTruthy()
    expect(fleet.getRunActivity).toHaveBeenCalled()
    // running 잠금: 목표를 입력해도 run 버튼이 비활성이라 두 번째 실행을 시도할 수 없다.
    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '다른 목표' } })
    expect((screen.getByRole('button', { name: '실행 중…' }) as HTMLButtonElement).disabled).toBe(true)
    // 취소는 스냅샷의 in-flight projectId 로 호출된다.
    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    await act(async () => {})
    expect(fleet.cancelRun).toHaveBeenCalledWith('p2')
  })

  // V2(Next②): getRunActivity 의 진행 중 실행 id 는 마운트 자동선택(보던 프로젝트)과 다를 수 있다 —
  //            activeProjectId(실행 중)와 selectedId(보는 중)는 설계상 분리(DESIGN.md). 취소 버튼은
  //            폼-레벨 실행 제어라 보는 프로젝트가 아니라 실제 진행 중 실행을 대상으로 한다. 두 개념 혼동 회귀 가드.
  it('cancels the in-flight run, not the viewed project, when they differ (activeProjectId vs selectedId 분리)', async () => {
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P1, P2]),
      getLastActiveProject: vi.fn().mockResolvedValue('p1'), // 보던(선택된) 프로젝트는 p1
      getProjectTasks: vi.fn().mockResolvedValue([]),
      listProjectEvents: vi.fn().mockResolvedValue([]),
      getRunActivity: vi.fn().mockResolvedValue({ activeProjectIds: ['p2'] }), // 실제 진행 중 실행은 p2
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    const cancelBtn = await screen.findByRole('button', { name: '취소' }) // running(p2) 복원
    fireEvent.click(cancelBtn)
    await act(async () => {})
    expect(fleet.cancelRun).toHaveBeenCalledWith('p2') // 보던 p1 이 아니라 진행 중 p2 를 취소
  })

  // W(Next②): 스냅샷 resolve 전 도착한 라이브 종료(terminal)는 스테일 스냅샷이 되살리지 않아야 한다(라이브 우선).
  it('does not resurrect a run that ended live before the getRunActivity snapshot resolved', async () => {
    let resolveActivity: (a: { activeProjectIds: string[] }) => void = () => {}
    const fleet = mockFleet({
      listProjects: vi.fn().mockResolvedValue([P2]),
      getLastActiveProject: vi.fn().mockResolvedValue('p2'),
      getRunActivity: vi.fn(() => new Promise<{ activeProjectIds: string[] }>((res) => { resolveActivity = res })),
    })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText('결제 연동')
    // 스냅샷 펜딩 중 라이브 종료가 먼저 도착(하이드레이션 윈도우 레이스).
    await act(async () => { fleet.fire({ type: 'project.done', message: '완료', data: { projectId: 'p2' } }) })
    // 스냅샷이 늦게 진행 중(p2)을 보고해도, 이미 종료된 실행이라 되살리지 않는다.
    await act(async () => { resolveActivity({ activeProjectIds: ['p2'] }) })
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull() // 취소 버튼 안 뜸
  })

  // X(Next②): 마운트-옵저버가 라이브 project.created 만으로도 running 잠금을 켜야 한다(스냅샷이 빈 경우의 사각 봉합).
  it('locks running on a live project.created even without a local run() (observer)', async () => {
    const fleet = mockFleet({ listProjects: vi.fn().mockResolvedValue([]) })
    render(<ProjectPanel sessions={[SESSION]} />)
    await screen.findByText(/워크스페이스 미설정/)
    // 이 인스턴스는 run() 을 호출하지 않았다 — 다른 경로로 시작된 실행의 created 만 관측.
    await act(async () => { fleet.fire({ type: 'project.created', message: '생성', data: { projectId: 'pY' } }) })
    expect(await screen.findByRole('button', { name: '취소' })).toBeTruthy() // running+activeProjectId → 취소 버튼
    // 종료 이벤트로 잠금 해제 — running 이 false 로 풀려 새 실행이 가능해진다.
    await act(async () => { fleet.fire({ type: 'project.done', message: '완료', data: { projectId: 'pY' } }) })
    expect(screen.queryByRole('button', { name: '취소' })).toBeNull()
  })
})

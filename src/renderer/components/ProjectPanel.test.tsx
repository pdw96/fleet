/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmDescriptor, OrchestratorEvent, Project, Task } from '../../shared/types'
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
    ...overrides,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return Object.assign(fleet, { fire: (e: OrchestratorEvent) => act(() => emit?.(e)) })
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
})

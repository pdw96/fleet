/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmDescriptor, OrchestratorEvent } from '../../shared/types'
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
    ...overrides,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return Object.assign(fleet, { fire: (e: OrchestratorEvent) => act(() => emit?.(e)) })
}

const SESSION: LlmDescriptor = { id: 'llm-1', kind: 'cli', displayName: 'Claude', ref: 'claude' }

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

  it('renders changed-file count for done tasks and a 건너뜀 badge for skipped tasks (not failed)', async () => {
    mockFleet({
      runProject: vi.fn().mockResolvedValue({
        projectId: 'p',
        summary: '',
        tasks: [
          {
            id: 't1',
            projectId: 'p',
            title: '구현 A',
            description: '',
            status: 'done',
            dependsOn: [],
            changedFiles: ['a.ts', 'b.ts'],
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: 't2',
            projectId: 'p',
            title: '구현 B',
            description: '',
            status: 'skipped',
            dependsOn: ['t1'],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    })
    render(<ProjectPanel sessions={[SESSION]} />)

    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))
    })

    // 변경 파일 수 — done 작업.
    expect(await screen.findByText('변경 2개')).toBeTruthy()
    // 건너뜀 배지 — skipped 작업. failed 로 표시되지 않는다.
    expect(screen.getByText('건너뜀')).toBeTruthy()
    expect(screen.queryByText('failed')).toBeNull()
    expect(screen.queryByText('skipped')).toBeNull()
  })

  it('shows a 취소 button while running and calls cancelRun with the in-flight projectId', async () => {
    // runProject 를 영원히 펜딩으로 둬 running 상태를 유지한다.
    const fleet = mockFleet({ runProject: vi.fn(() => new Promise(() => {})) })
    render(<ProjectPanel sessions={[SESSION]} />)

    fireEvent.change(screen.getByPlaceholderText(/사용자 인증/), { target: { value: '목표' } })
    fireEvent.click(screen.getByRole('button', { name: '오케스트레이션 실행' }))

    // 메인이 방출하는 project.created 로 in-flight projectId 를 잡는다.
    fleet.fire({ type: 'project.created', message: '프로젝트 생성', data: { projectId: 'proj-9' } })

    const cancelBtn = await screen.findByRole('button', { name: '취소' })
    fireEvent.click(cancelBtn)
    await waitFor(() => expect(fleet.cancelRun).toHaveBeenCalledWith('proj-9'))
  })
})

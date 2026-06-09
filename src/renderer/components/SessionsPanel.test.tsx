/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliDetectionResult } from '../../shared/types'
import { SessionsPanel } from './SessionsPanel'

const installedCli: CliDetectionResult = {
  id: 'claude',
  displayName: 'Claude Code',
  command: 'claude',
  kind: 'cli',
  installed: true,
  version: '1.0.0',
}

function mockFleet(overrides: Record<string, unknown> = {}) {
  const fleet: Record<string, unknown> = {
    detectClis: vi.fn().mockResolvedValue([installedCli]),
    registerCliSession: vi.fn().mockResolvedValue(undefined),
    setSessionCapabilities: vi.fn().mockResolvedValue(undefined),
    removeSession: vi.fn().mockResolvedValue(undefined),
    registerApiSession: vi.fn().mockResolvedValue(undefined),
    getMcpStatus: vi.fn().mockResolvedValue([]), // 마운트 시 하이드레이트 호출
    ...overrides,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return fleet
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('SessionsPanel', () => {
  it('surfaces an error and does not refresh when CLI registration fails', async () => {
    mockFleet({ registerCliSession: vi.fn().mockRejectedValue(new Error('등록 실패함')) })
    const onRefresh = vi.fn()
    render(<SessionsPanel sessions={[]} onRefresh={onRefresh} />)

    fireEvent.click(await screen.findByRole('button', { name: '세션 등록' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('세션 등록 실패')
    expect(alert.textContent).toContain('등록 실패함')
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('refreshes after a successful CLI registration', async () => {
    const fleet = mockFleet()
    const onRefresh = vi.fn()
    render(<SessionsPanel sessions={[]} onRefresh={onRefresh} />)

    fireEvent.click(await screen.findByRole('button', { name: '세션 등록' }))

    await waitFor(() => expect(onRefresh).toHaveBeenCalled())
    expect(fleet.registerCliSession).toHaveBeenCalledWith('claude', { stateful: false })
  })

  it('MCP 서버 JSON 을 적용하고 상태를 표시한다', async () => {
    const status = [{ name: 'fs', connected: true, toolCount: 2, tools: ['mcp__fs__read', 'mcp__fs__write'] }]
    const fleet = mockFleet({ setMcpServers: vi.fn().mockResolvedValue(status) })
    render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/MCP 서버/i), {
      target: { value: '[{"name":"fs","command":"node","args":["server.js"]}]' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'MCP 적용' }))

    await waitFor(() =>
      expect(fleet.setMcpServers).toHaveBeenCalledWith([{ name: 'fs', command: 'node', args: ['server.js'] }]),
    )
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()
  })

  it('잘못된 MCP JSON 은 IPC 호출 없이 에러를 표시한다', async () => {
    const fleet = mockFleet({ setMcpServers: vi.fn() })
    render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    fireEvent.change(screen.getByLabelText(/MCP 서버/i), { target: { value: '깨진 json' } })
    fireEvent.click(screen.getByRole('button', { name: 'MCP 적용' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('MCP')
    expect(fleet.setMcpServers).not.toHaveBeenCalled()
  })

  it('마운트 시 현재 MCP 상태를 하이드레이트한다(탭 재마운트 복원)', async () => {
    const fleet = mockFleet({
      getMcpStatus: vi
        .fn()
        .mockResolvedValue([{ name: 'fs', connected: true, toolCount: 1, tools: ['mcp__fs__read'] }]),
    })
    render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()
    expect(fleet.getMcpStatus).toHaveBeenCalled()
  })

  // 종료/크래시로 stale 상태를 재조회로 갱신하는 동적 상태 mock(처음=연결, 이후=종료).
  function dyingServerStatus() {
    return vi
      .fn()
      .mockResolvedValueOnce([{ name: 'fs', connected: true, toolCount: 1, tools: ['mcp__fs__read'] }])
      .mockResolvedValue([{ name: 'fs', connected: false, toolCount: 0, tools: [], error: 'exit' }])
  }

  it('윈도우 포커스 복귀 시 MCP 상태를 재조회해 stale 표시를 갱신한다', async () => {
    const fleet = mockFleet({ getMcpStatus: dyingServerStatus() })
    render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

    // 마운트 하이드레이트: 연결 상태(도구 노출) 표시
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()

    // 윈도우 포커스 복귀 → 재조회 → 종료 상태 반영
    fireEvent(window, new Event('focus'))

    expect(await screen.findByText('exit')).toBeTruthy()
    expect(screen.queryByText(/mcp__fs__read/)).toBeNull()
    expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)
  })

  it('탭 가시성 복귀 시 MCP 상태를 재조회한다', async () => {
    const fleet = mockFleet({ getMcpStatus: dyingServerStatus() })
    render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
    expect(await screen.findByText(/mcp__fs__read/)).toBeTruthy()

    fireEvent(document, new Event('visibilitychange'))

    expect(await screen.findByText('exit')).toBeTruthy()
    expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)
  })

  it('활성 MCP 서버가 있으면 경량 폴링으로 상태를 갱신한다', async () => {
    vi.useFakeTimers()
    try {
      const fleet = mockFleet({ getMcpStatus: dyingServerStatus() })
      render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)

      // 마운트 하이드레이트 promise flush → 연결 상태 + 폴링 타이머 가동
      await act(async () => {})
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1)

      // 폴링 간격 경과 → 재조회
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('MCP 서버 미설정 시 폴링 타이머를 만들지 않는다', async () => {
    vi.useFakeTimers()
    try {
      const fleet = mockFleet({ getMcpStatus: vi.fn().mockResolvedValue([]) })
      render(<SessionsPanel sessions={[]} onRefresh={vi.fn()} />)
      await act(async () => {})
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1) // 마운트 1회만

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(fleet.getMcpStatus).toHaveBeenCalledTimes(1) // 폴링 없음
    } finally {
      vi.useRealTimers()
    }
  })
})

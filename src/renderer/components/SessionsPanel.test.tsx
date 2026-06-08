/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
})

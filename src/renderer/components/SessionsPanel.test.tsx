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
  const fleet = {
    detectClis: vi.fn().mockResolvedValue([installedCli]),
    registerCliSession: vi.fn().mockResolvedValue(undefined),
    setSessionCapabilities: vi.fn().mockResolvedValue(undefined),
    removeSession: vi.fn().mockResolvedValue(undefined),
    registerApiSession: vi.fn().mockResolvedValue(undefined),
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
})

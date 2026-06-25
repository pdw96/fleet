/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddAiWizard } from './AddAiWizard'

function mockFleet(overrides: Record<string, unknown> = {}) {
  ;(window as unknown as { fleet: unknown }).fleet = {
    detectClis: vi
      .fn()
      .mockResolvedValue([
        {
          id: 'claude',
          displayName: 'Claude Code',
          command: 'claude',
          kind: 'cli',
          installed: true,
          version: '1.0.0',
        },
      ]),
    registerCliSession: vi.fn().mockResolvedValue(undefined),
    registerApiSession: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}
async function renderSettled(ui: Parameters<typeof render>[0]) {
  const r = render(ui)
  await act(async () => {})
  return r
}
afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('AddAiWizard', () => {
  it('provider 선택 → method 단계 전이', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }))
    expect(screen.getByRole('button', { name: /구독/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /API 키/ })).toBeTruthy()
  })
  it('openai-호환 은 구독 방식 미노출', async () => {
    mockFleet()
    await renderSettled(<AddAiWizard onRegistered={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /OpenAI 호환/ }))
    expect(screen.queryByRole('button', { name: /구독/ })).toBeNull()
    expect(screen.getByRole('button', { name: /API 키/ })).toBeTruthy()
  })
})

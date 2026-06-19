/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateEvent } from '../../shared/types'
import { UpdateBanner } from './UpdateBanner'

function mockFleet(snapshot: UpdateEvent = { kind: 'idle' }) {
  let handler: ((e: UpdateEvent) => void) | undefined
  const downloadUpdate = vi.fn().mockResolvedValue(undefined)
  const installUpdate = vi.fn().mockResolvedValue(undefined)
  const dismissUpdate = vi.fn().mockResolvedValue(undefined)
  const fleet = {
    onUpdateEvent: vi.fn((cb: (e: UpdateEvent) => void) => {
      handler = cb
      return () => {
        handler = undefined
      }
    }),
    getUpdateState: vi.fn().mockResolvedValue(snapshot),
    downloadUpdate,
    installUpdate,
    dismissUpdate,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return {
    fire: (e: UpdateEvent) => act(() => handler?.(e)),
    downloadUpdate,
    installUpdate,
    dismissUpdate,
  }
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('UpdateBanner', () => {
  it('idle 스냅샷이면 아무것도 렌더 안 함', async () => {
    mockFleet({ kind: 'idle' })
    const { container } = render(<UpdateBanner />)
    await act(async () => {})
    expect(container.querySelector('.update-banner')).toBeNull()
  })

  it('available 스냅샷을 하이드레이트해 다운로드 버튼 표시', async () => {
    mockFleet({ kind: 'available', version: '0.2.0' })
    render(<UpdateBanner />)
    expect(await screen.findByRole('button', { name: '다운로드' })).toBeTruthy()
    expect(screen.getByText(/0\.2\.0/)).toBeTruthy()
  })

  it('라이브 이벤트가 스냅샷을 이긴다(라이브 우선)', async () => {
    const { fire } = mockFleet({ kind: 'available', version: '0.2.0' })
    render(<UpdateBanner />)
    fire({ kind: 'not-available' }) // 스냅샷 resolve 전 라이브 도착
    await act(async () => {})
    expect(screen.queryByRole('button', { name: '다운로드' })).toBeNull()
  })

  it('다운로드 클릭 → downloadUpdate 호출', async () => {
    const { downloadUpdate } = mockFleet({ kind: 'available', version: '0.2.0' })
    render(<UpdateBanner />)
    fireEvent.click(await screen.findByRole('button', { name: '다운로드' }))
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('progress 퍼센트 표시', async () => {
    const { fire } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'progress', percent: 42 })
    expect(screen.getByText(/42%/)).toBeTruthy()
  })

  it('downloaded → 지금 클릭 → installUpdate', async () => {
    const { fire, installUpdate } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'downloaded', version: '0.2.0' })
    fireEvent.click(screen.getByRole('button', { name: '지금' }))
    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  it('downloaded → 나중에 클릭 → dismissUpdate + 배너 숨김', async () => {
    const { fire, dismissUpdate } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'downloaded', version: '0.2.0' })
    fireEvent.click(screen.getByRole('button', { name: '나중에' }))
    expect(dismissUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '지금' })).toBeNull()
  })

  it('error → 닫기 클릭 → dismissUpdate + 배너 숨김', async () => {
    const { fire, dismissUpdate } = mockFleet()
    render(<UpdateBanner />)
    fire({ kind: 'error', message: 'x' })
    expect(screen.getByText('업데이트 확인 실패')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(dismissUpdate).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('업데이트 확인 실패')).toBeNull()
  })
})

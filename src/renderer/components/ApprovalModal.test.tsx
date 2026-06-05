/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../../shared/types'
import { ApprovalModal } from './ApprovalModal'

function mockFleet() {
  let handler: ((req: ApprovalRequest) => void) | undefined
  const respondApproval = vi.fn().mockResolvedValue(undefined)
  const fleet = {
    onApprovalRequest: vi.fn((cb: (req: ApprovalRequest) => void) => {
      handler = cb
      return () => {
        handler = undefined
      }
    }),
    respondApproval,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return {
    fire: (req: ApprovalRequest) => act(() => handler?.(req)),
    respondApproval,
  }
}

const REQ: ApprovalRequest = {
  id: 'req-1',
  kind: 'file-write',
  summary: '파일 쓰기: config/.env',
  target: '/ws/config/.env',
  risk: 'destructive',
  ts: 1,
}

afterEach(() => {
  delete (window as unknown as { fleet?: unknown }).fleet
  vi.restoreAllMocks()
})

describe('ApprovalModal', () => {
  it('renders nothing until a request arrives', () => {
    mockFleet()
    const { container } = render(<ApprovalModal />)
    expect(container.querySelector('.modal-overlay')).toBeNull()
  })

  it('shows the request summary and target when one arrives', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    expect(screen.getByText('파일 쓰기: config/.env')).toBeTruthy()
    expect(screen.getByText('/ws/config/.env')).toBeTruthy()
  })

  it('approves and dequeues on the 승인 button', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fireEvent.click(screen.getByRole('button', { name: '승인' }))
    expect(respondApproval).toHaveBeenCalledWith('req-1', true)
    expect(screen.queryByRole('button', { name: '승인' })).toBeNull()
  })

  it('rejects on the 거부 button', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fireEvent.click(screen.getByRole('button', { name: '거부' }))
    expect(respondApproval).toHaveBeenCalledWith('req-1', false)
  })

  it('shows the 변경 적용 승인 title and file list for an apply-diff request', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire({
      id: 'req-diff',
      kind: 'apply-diff',
      summary: '작업 변경 적용: 구현 A',
      target: 'src/a.ts, src/b.ts',
      risk: 'caution',
      ts: 2,
    })
    expect(screen.getByText('변경 적용 승인')).toBeTruthy()
    expect(screen.getByText('src/a.ts, src/b.ts')).toBeTruthy()
  })

  it('shows queued requests one at a time', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fire({ ...REQ, id: 'req-2', summary: '파일 쓰기: secret.pem', target: '/ws/secret.pem' })
    expect(screen.getByText('파일 쓰기: config/.env')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '승인' }))
    expect(respondApproval).toHaveBeenCalledWith('req-1', true)
    expect(screen.getByText('파일 쓰기: secret.pem')).toBeTruthy()
  })
})

/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../../shared/types'
import { ApprovalModal } from './ApprovalModal'

function mockFleet(overrides: { respondApproval?: ReturnType<typeof vi.fn> } = {}) {
  let handler: ((req: ApprovalRequest) => void) | undefined
  const respondApproval = overrides.respondApproval ?? vi.fn().mockResolvedValue(undefined)
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
  expiresAt: 61_000,
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
      expiresAt: 62_000,
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

  it('rejects the current request on Escape (safe default)', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(respondApproval).toHaveBeenCalledWith('req-1', false)
    expect(screen.queryByRole('dialog')).toBeNull() // 디큐 — 다음 요청 없으면 모달 사라짐
  })

  it('focuses the 거부 button when a request appears', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '거부' }))
  })

  it('refocuses 거부 on the next queued request after a decision', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fire({ ...REQ, id: 'req-2', summary: '파일 쓰기: secret.pem', target: '/ws/secret.pem' })
    fireEvent.click(screen.getByRole('button', { name: '승인' })) // req-1 승인 → req-2 표시
    expect(screen.getByText('파일 쓰기: secret.pem')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '거부' }))
  })

  it('wraps focus from 승인(last) to 거부(first) on Tab', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    const approve = screen.getByRole('button', { name: '승인' })
    const reject = screen.getByRole('button', { name: '거부' })
    approve.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(reject)
  })

  it('wraps focus from 거부(first) to 승인(last) on Shift+Tab', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    const approve = screen.getByRole('button', { name: '승인' })
    const reject = screen.getByRole('button', { name: '거부' })
    reject.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(approve)
  })

  it('labels the dialog with its title, summary, and target for screen readers', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-labelledby')).toBe('approval-title')
    // target(전체경로/셸명령/파일목록 — 보안 결정적 텍스트)도 description 에 포함.
    expect(dialog.getAttribute('aria-describedby')).toBe('approval-summary approval-target')
    expect(document.getElementById('approval-title')?.textContent).toBe('위험 작업 승인')
    expect(document.getElementById('approval-summary')?.textContent).toBe('파일 쓰기: config/.env')
    expect(document.getElementById('approval-target')?.textContent).toBe('/ws/config/.env')
  })

  it('traps Tab even when focus has escaped to a background element (document-level)', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    const reject = screen.getByRole('button', { name: '거부' })
    // 배경 컨트롤이 포커스를 가져간 상황 — overlay onKeyDown 은 못 잡지만 document 트랩은 잡아야 한다.
    const bg = document.createElement('button')
    document.body.appendChild(bg)
    act(() => bg.focus())
    expect(document.activeElement).toBe(bg) // 포커스가 배경으로 유실
    fireEvent.keyDown(bg, { key: 'Tab' }) // overlay 밖(배경)에서 Tab
    expect(document.activeElement).toBe(reject) // 모달 내부(첫 버튼)로 복귀
    bg.remove()
  })

  it('refocuses 거부 on the next queued request after Escape rejects the current', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fire({ ...REQ, id: 'req-2', summary: '파일 쓰기: secret.pem', target: '/ws/secret.pem' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }) // req-1 거부 → req-2 표시
    expect(respondApproval).toHaveBeenCalledWith('req-1', false)
    expect(screen.getByText('파일 쓰기: secret.pem')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '거부' }))
  })

  it('does not intercept Enter — button activation stays native (no accidental decide)', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    fire(REQ)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' }) // dialog 핸들러는 Enter 를 무시
    expect(respondApproval).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy() // 모달 유지(우발적 결정 없음)
  })

  it('respondApproval reject 를 흡수한다 — 동기 throw 없이 큐 전진(#197 B4 reject audit)', async () => {
    // decide 가 respondApproval reject 를 .catch 로 흡수하므로 클릭이 동기 throw 없이 큐를 전진(모달 닫힘)
    // 시킨다. main/server 의 승인 타임아웃(fail-closed)이 회신 유실의 권위 — 렌더러는 재시도하지 않는다.
    const { fire, respondApproval } = mockFleet({
      respondApproval: vi.fn().mockRejectedValue(new Error('전송 단절')),
    })
    render(<ApprovalModal />)
    fire(REQ)
    expect(() => fireEvent.click(screen.getByRole('button', { name: '승인' }))).not.toThrow()
    expect(respondApproval).toHaveBeenCalledWith('req-1', true)
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull() // 큐 전진 — reject 가 decide 를 깨지 않음
  })
})

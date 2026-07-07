/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '../../shared/types'
import { HydrationContext } from '../bridge/hydration'
import { ApprovalModal } from './ApprovalModal'

function mockFleet(
  overrides: {
    respondApproval?: ReturnType<typeof vi.fn>
    pending?: ApprovalRequest[]
    listPendingApprovals?: ReturnType<typeof vi.fn>
  } = {},
) {
  let reqHandler: ((req: ApprovalRequest) => void) | undefined
  let withdrawHandler: ((id: string) => void) | undefined
  const respondApproval = overrides.respondApproval ?? vi.fn().mockResolvedValue(undefined)
  const listPendingApprovals =
    overrides.listPendingApprovals ?? vi.fn().mockResolvedValue(overrides.pending ?? [])
  const fleet = {
    onApprovalRequest: vi.fn((cb: (req: ApprovalRequest) => void) => {
      reqHandler = cb
      return () => {
        reqHandler = undefined
      }
    }),
    onApprovalWithdrawn: vi.fn((cb: (id: string) => void) => {
      withdrawHandler = cb
      return () => {
        withdrawHandler = undefined
      }
    }),
    listPendingApprovals,
    respondApproval,
  }
  ;(window as unknown as { fleet: unknown }).fleet = fleet
  return {
    fire: (req: ApprovalRequest) => act(() => reqHandler?.(req)),
    withdraw: (id: string) => act(() => withdrawHandler?.(id)),
    respondApproval,
    listPendingApprovals,
  }
}

/** HydrationContext 로 nonce 를 제어(재접속 재하이드레이션 구동). 미지정 nonce=0(마운트). */
function renderModal(nonce = 0) {
  return render(
    <HydrationContext.Provider value={{ nonce, connection: null }}>
      <ApprovalModal />
    </HydrationContext.Provider>,
  )
}

const REQ: ApprovalRequest = {
  id: 'req-1',
  kind: 'file-write',
  summary: '파일 쓰기: config/.env',
  target: '/ws/config/.env',
  risk: 'destructive',
  ts: 1,
  // 미래값 — 새 컴포넌트는 expiresAt<=now 를 만료로 필터한다(서버 권위 카운트다운).
  expiresAt: Date.now() + 60_000,
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
      expiresAt: Date.now() + 60_000,
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

  // ── C1(#216 C-7) — 재하이드레이션·tombstone·서버 권위 카운트다운 ──

  // #24 후접속 snapshot 카드
  it('#24 마운트 시 listPendingApprovals 스냅숏 조회 → 카드 재제시', async () => {
    mockFleet({ pending: [{ ...REQ, id: 'snap-1', summary: '스냅숏 승인' }] })
    renderModal()
    expect(await screen.findByText('스냅숏 승인')).toBeTruthy()
  })

  it('#24b 재접속(nonce+1) 전환 시 재하이드레이트(listPendingApprovals 재조회)', async () => {
    const { listPendingApprovals } = mockFleet({
      pending: [{ ...REQ, id: 'snap-1', summary: '스냅숏' }],
    })
    const view = renderModal(0)
    await act(async () => {})
    expect(listPendingApprovals).toHaveBeenCalledTimes(1) // 마운트(nonce 0)
    await act(async () => {
      view.rerender(
        <HydrationContext.Provider value={{ nonce: 1, connection: null }}>
          <ApprovalModal />
        </HydrationContext.Provider>,
      )
    })
    expect(listPendingApprovals).toHaveBeenCalledTimes(2) // nonce 전환 → 재조회
  })

  // #25 live+snapshot upsert dedupe (비파괴)
  it('#25 같은 id 라이브+스냅숏 → 단일 카드(dedupe)·스냅숏 없는 라이브 카드 보존(비파괴)', async () => {
    const A = { ...REQ, id: 'A', summary: 'A카드' }
    const B = { ...REQ, id: 'B', summary: 'B카드' }
    const { fire } = mockFleet({ pending: [A, B] })
    renderModal()
    fire(A) // 라이브 A (스냅숏에도 있음 — dedupe)
    fire({ ...REQ, id: 'C', summary: 'C카드' }) // 스냅숏에 없는 라이브 — 보존
    await act(async () => {}) // 마운트 hydration([A,B]) flush
    // A(단일)·C·B = 3장. A 가 중복이면 "대기 중 3건". 단일이므로 current(A) 외 "대기 중 2건".
    expect(screen.getByText('A카드')).toBeTruthy()
    expect(screen.getByText('대기 중 2건')).toBeTruthy()
  })

  // #P2 재접속 reconcile — 스냅숏에 없는 pre-hydration 카드 제거·하이드레이션 중 라이브-fresh 보존(Codex P2)
  it('#P2 재접속 시 권위 스냅숏에 없는 pre-hydration 카드는 제거하고 하이드레이션 중 라이브-fresh 는 보존한다', async () => {
    let resolveSnap!: (v: ApprovalRequest[]) => void
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([{ ...REQ, id: 'stale', summary: 'stale카드' }]) // 마운트 스냅숏
      .mockReturnValueOnce(
        new Promise<ApprovalRequest[]>((r) => {
          resolveSnap = r
        }),
      ) // 재접속 스냅숏(지연)
    const { fire } = mockFleet({ listPendingApprovals: listPending })
    const view = renderModal(0)
    await act(async () => {})
    expect(screen.getByText('stale카드')).toBeTruthy() // 마운트 하이드레이션

    // 재접속(nonce+1) → 하이드레이션 in-flight(preHydrationIds={stale} 포착).
    await act(async () => {
      view.rerender(
        <HydrationContext.Provider value={{ nonce: 1, connection: null }}>
          <ApprovalModal />
        </HydrationContext.Provider>,
      )
    })
    // 하이드레이션 in-flight 중 라이브 fresh 도착(preHydrationIds 밖 → 보호 대상).
    fire({ ...REQ, id: 'fresh', summary: 'fresh카드' })
    // 지연 스냅숏 resolve([]) — stale 이 사라진 권위 목록(offline 중 해소).
    await act(async () => {
      resolveSnap([])
      await Promise.resolve()
    })
    expect(screen.queryByText('stale카드')).toBeNull() // reconcile: 스냅숏 부재 pre-hydration 제거
    expect(screen.getByText('fresh카드')).toBeTruthy() // live-race 가드: 보존
  })

  // #26 tombstone 인터리브 — 지연 스냅숏 resolve 중 withdrawn → 부활 차단(apply 시점 재확인)
  it('#26 지연 스냅숏 resolve 전 withdrawn(id) → 늦은 스냅숏의 동일 id 미부활', async () => {
    let resolveSnap!: (v: ApprovalRequest[]) => void
    const snapPromise = new Promise<ApprovalRequest[]>((r) => {
      resolveSnap = r
    })
    const { withdraw } = mockFleet({
      listPendingApprovals: vi.fn().mockReturnValue(snapPromise),
    })
    renderModal() // 마운트 → listPendingApprovals(pending)
    withdraw('late-A') // 스냅숏 도착 전 A 철회 → tombstone 기록
    await act(async () => {
      resolveSnap([{ ...REQ, id: 'late-A', summary: '늦은 스냅 A' }]) // 늦은 스냅숏 도착
      await snapPromise
    })
    // apply 시점 tombstone 재확인 → late-A 미부활 → 표시 카드 없음.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('늦은 스냅 A')).toBeNull()
  })

  // #27 카운트다운 라이브 만료 — 서버 권위 expiresAt 기반·공유상수 회귀 가드
  it('#27 카운트다운은 expiresAt 기반(60s 공유상수 아님)·라이브 만료 시 카드 자동 소멸', () => {
    vi.useFakeTimers()
    try {
      const t0 = Date.now()
      const { fire } = mockFleet()
      renderModal()
      fire({ ...REQ, id: 'exp-1', expiresAt: t0 + 3000 }) // 3s 후 만료(공유상수 60s 아님)
      expect(screen.getByText('3s 후 자동 거부')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(3200) // 만료 초과 → 틱 prune
      })
      expect(screen.queryByRole('dialog')).toBeNull() // 카드 자동 소멸
    } finally {
      vi.useRealTimers()
    }
  })

  // 적대리뷰 P3 — 비동기 카드 스왑 중 마우스 오승인 차단(pointerdown intent 가드)
  it('withdrawn 로 카드가 스왑되면 조준하지 않은 다음 카드를 클릭이 오승인하지 않는다', () => {
    const { fire, withdraw, respondApproval } = mockFleet()
    renderModal()
    fire({ ...REQ, id: 'A', summary: 'A작업' })
    fire({ ...REQ, id: 'B', summary: 'B작업' })
    const approve = screen.getByRole('button', { name: '승인' })
    fireEvent.pointerDown(approve) // A 조준(current=A)
    withdraw('A') // A 철회 → B 가 current 로 스왑
    fireEvent.click(approve) // 클릭 — intent(A) ≠ current(B) → 무시
    expect(respondApproval).not.toHaveBeenCalled() // B 오승인 없음
    expect(screen.getByText('B작업')).toBeTruthy() // B 미결정·유지
    // 재조준하면 B 정상 결정
    fireEvent.pointerDown(screen.getByRole('button', { name: '승인' }))
    fireEvent.click(screen.getByRole('button', { name: '승인' }))
    expect(respondApproval).toHaveBeenCalledWith('B', true)
  })
})

/** @vitest-environment jsdom */
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, RiskLevel } from '../../shared/types'
import { HydrationContext } from '../bridge/hydration'
import { ApprovalModal, approvalReducer, formatCountdown } from './ApprovalModal'

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

/** 종류·위험을 지정한 라이브 요청 팩토리(미니칩 라벨 검증용·미래 expiresAt). */
function mkReq(
  id: string,
  summary: string,
  kind: ApprovalRequest['kind'],
  risk: RiskLevel,
): ApprovalRequest {
  return { id, kind, summary, target: `/ws/${id}`, risk, ts: 1, expiresAt: Date.now() + 60_000 }
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
    // A(단일)·C·B = 3장. A 가 중복이면 4장(1/4). 단일이므로 3장·current(A)=위치 1/3.
    expect(screen.getByText('A카드')).toBeTruthy()
    expect(screen.getByText('1 / 3')).toBeTruthy()
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

  // #27 카운트다운은 expiresAt 기반(60s 공유상수 아님)·로컬 만료 시 0s 클램프하되 카드는 로컬 시계로 드롭 안 함
  it('#27 카운트다운은 expiresAt 기반이고 로컬 만료 초과 시 0s 로 클램프하며 카드를 로컬 시계로 드롭하지 않는다', () => {
    vi.useFakeTimers()
    try {
      const t0 = Date.now()
      const { fire } = mockFleet()
      renderModal()
      fire({ ...REQ, id: 'exp-1', expiresAt: t0 + 3000 }) // 3s 후(공유상수 60s 아님)
      expect(screen.getByText('0:03 후 자동 거부')).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(3200) // 로컬 만료 초과
      })
      // 서버 권위(withdrawn)만 제거 — 로컬 시계로 드롭 금지(skew-ahead 폰 클라의 valid 카드 보존).
      expect(screen.getByText('0:00 후 자동 거부')).toBeTruthy() // 카운트다운 0s 클램프
      expect(screen.getByRole('dialog')).toBeTruthy() // 카드 유지(서버 withdrawn 대기)
    } finally {
      vi.useRealTimers()
    }
  })

  // 적대리뷰 Codex 재리뷰 P2 — skew-ahead 클라(로컬 시계가 서버보다 앞섬)에서도 서버 유효 카드 미드롭
  it('로컬 시계가 앞선 클라에서도 서버가 보낸(유효) 카드를 로컬 만료로 드롭하지 않고 표시한다', () => {
    const { fire } = mockFleet()
    renderModal()
    // 서버는 유효하다고 브로드캐스트한 카드지만 로컬 Date.now() 기준으론 이미 만료(폰 시계가 앞섬).
    fire({ ...REQ, id: 'skew-1', summary: 'skew 카드', expiresAt: Date.now() - 1000 })
    expect(screen.getByText('skew 카드')).toBeTruthy() // 로컬 만료라도 드롭 안 함(서버 권위 존재)
    expect(screen.getByText('0:00 후 자동 거부')).toBeTruthy() // 카운트다운만 0:00 클램프
    // 승인 가능 — 서버 resolve 가 자기 시계로 검증(멱등·만료면 서버가 거부 강등).
    fireEvent.pointerDown(screen.getByRole('button', { name: '승인' }))
    fireEvent.click(screen.getByRole('button', { name: '승인' }))
    // (respondApproval 호출됨 = 카드가 액션 가능했음)
    expect(screen.queryByText('skew 카드')).toBeNull() // decide 후 큐 전진
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

  // 적대리뷰 Codex 재리뷰 P2 — 키보드 활성화도 카드 스왑 오승인 차단(onKeyDown intent 가드)
  it('키보드(Enter) 활성화도 카드 스왑 시 조준하지 않은 카드를 오승인하지 않는다', () => {
    const { fire, withdraw, respondApproval } = mockFleet()
    renderModal()
    fire({ ...REQ, id: 'A', summary: 'A작업' })
    fire({ ...REQ, id: 'B', summary: 'B작업' })
    const approve = screen.getByRole('button', { name: '승인' })
    fireEvent.keyDown(approve, { key: 'Enter' }) // A 조준(키보드)
    withdraw('A') // A 철회 → B 가 current 로 스왑
    fireEvent.click(approve) // Enter 의 네이티브 click — intent(A) ≠ current(B) → 무시
    expect(respondApproval).not.toHaveBeenCalled() // B 오승인 없음
    expect(screen.getByText('B작업')).toBeTruthy()
  })

  // 적대리뷰 Codex 재리뷰 P2 — pre-hello 재접속 조회 실패 시 제한 재시도로 스냅숏 하이드레이트
  it('listPendingApprovals reject 시 제한 재시도로 스냅숏을 결국 재제시한다', async () => {
    vi.useFakeTimers()
    try {
      const t0 = Date.now()
      const listPending = vi
        .fn()
        .mockRejectedValueOnce(new Error('pre-hello close'))
        .mockResolvedValueOnce([
          { ...REQ, id: 'retry-1', summary: '재시도 카드', expiresAt: t0 + 60_000 },
        ])
      mockFleet({ listPendingApprovals: listPending })
      renderModal()
      await act(async () => {
        await Promise.resolve() // 첫 호출 reject flush
      })
      expect(listPending).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500) // 재시도 backoff(400ms) 경과 + 마이크로태스크 flush
      })
      expect(listPending).toHaveBeenCalledTimes(2)
      expect(screen.getByText('재시도 카드')).toBeTruthy() // 재시도 성공 → 하이드레이트
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('formatCountdown', () => {
  it('남은 ms 를 m:ss 로(ceil 초·0 클램프)', () => {
    expect(formatCountdown(600_000)).toBe('10:00')
    expect(formatCountdown(573_000)).toBe('9:33')
    expect(formatCountdown(65_000)).toBe('1:05')
    expect(formatCountdown(5_000)).toBe('0:05')
    expect(formatCountdown(1)).toBe('0:01') // ceil — 0 초과는 최소 0:01
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-1_000)).toBe('0:00')
  })
})

// 순수 reducer 유닛(#216 C2 §C-2) — queue+focusedId 원자 전이. DOM 없이 전이 자체를 고정.
const mk = (id: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id,
  kind: 'file-write',
  summary: id,
  target: `/ws/${id}`,
  risk: 'destructive',
  ts: 1,
  expiresAt: 2_000,
  ...over,
})

describe('approvalReducer', () => {
  it('UPSERT 는 큐 뒤 추가·focus 불변(얌체 점프 방지)', () => {
    const s0 = { queue: [mk('A'), mk('B')], focusedId: 'B' }
    const s1 = approvalReducer(s0, { type: 'UPSERT', req: mk('C') })
    expect(s1.queue.map((r) => r.id)).toEqual(['A', 'B', 'C'])
    expect(s1.focusedId).toBe('B') // 새 라이브에도 집중 불변
  })

  it('UPSERT 는 같은 id 갱신(dedupe·비파괴)', () => {
    const s0 = { queue: [mk('A', { summary: 'old' })], focusedId: null }
    const s1 = approvalReducer(s0, { type: 'UPSERT', req: mk('A', { summary: 'new' }) })
    expect(s1.queue).toHaveLength(1)
    expect(s1.queue[0].summary).toBe('new')
  })

  it('REMOVE(집중 카드) → 이웃으로 focus(다음, 없으면 이전, 없으면 null)', () => {
    const s1 = approvalReducer(
      { queue: [mk('A'), mk('B'), mk('C')], focusedId: 'B' },
      { type: 'REMOVE', id: 'B' },
    )
    expect(s1.queue.map((r) => r.id)).toEqual(['A', 'C'])
    expect(s1.focusedId).toBe('C') // idx=1 자리의 다음 카드
    const s2 = approvalReducer(
      { queue: [mk('A'), mk('B')], focusedId: 'B' },
      { type: 'REMOVE', id: 'B' },
    )
    expect(s2.focusedId).toBe('A') // 마지막이면 이전
    const s3 = approvalReducer({ queue: [mk('A')], focusedId: 'A' }, { type: 'REMOVE', id: 'A' })
    expect(s3.focusedId).toBeNull() // 마지막 1건이면 null
  })

  it('REMOVE(비집중 카드) → 집중 불변(id 추적 이점·조용한 스왑 없음)', () => {
    const s1 = approvalReducer(
      { queue: [mk('A'), mk('B'), mk('C')], focusedId: 'C' },
      { type: 'REMOVE', id: 'A' }, // 앞 카드 제거
    )
    expect(s1.focusedId).toBe('C') // index 추적이면 스왑됐을 상황 — id 추적이라 불변
  })

  it('FOCUS 는 큐에 있는 id 만 채택', () => {
    const s0 = { queue: [mk('A'), mk('B')], focusedId: 'A' }
    expect(approvalReducer(s0, { type: 'FOCUS', id: 'B' }).focusedId).toBe('B')
    expect(approvalReducer(s0, { type: 'FOCUS', id: 'Z' }).focusedId).toBe('A') // 없는 id 무시
  })

  it('FOCUS_DELTA 는 최신 큐 기준 ±1 클램프(순환 없음)', () => {
    const q = [mk('A'), mk('B'), mk('C')]
    expect(
      approvalReducer({ queue: q, focusedId: 'A' }, { type: 'FOCUS_DELTA', delta: 1 }).focusedId,
    ).toBe('B')
    expect(
      approvalReducer({ queue: q, focusedId: 'A' }, { type: 'FOCUS_DELTA', delta: -1 }).focusedId,
    ).toBe('A') // 경계 clamp
    expect(
      approvalReducer({ queue: q, focusedId: 'C' }, { type: 'FOCUS_DELTA', delta: 1 }).focusedId,
    ).toBe('C') // 경계 clamp
    expect(
      approvalReducer({ queue: q, focusedId: null }, { type: 'FOCUS_DELTA', delta: 1 }).focusedId,
    ).toBe('B') // null=큐 앞 기준
  })

  it('HYDRATE reconcile — 스냅숏 부재 pre-hydration 제거·라이브-fresh 보존·스냅숏 upsert', () => {
    const s1 = approvalReducer(
      { queue: [mk('stale'), mk('fresh')], focusedId: 'fresh' },
      { type: 'HYDRATE', pending: [], preHydrationIds: new Set(['stale']) },
    )
    expect(s1.queue.map((r) => r.id)).toEqual(['fresh']) // stale 제거·fresh(preHydration 밖) 보존
    expect(s1.focusedId).toBe('fresh') // 여전히 큐에 있음
    const s2 = approvalReducer(
      { queue: [mk('stale')], focusedId: 'stale' },
      { type: 'HYDRATE', pending: [], preHydrationIds: new Set(['stale']) },
    )
    expect(s2.focusedId).toBeNull() // 집중 카드가 사라지면 null 폴백(→ current=queue[0])
  })
})

describe('다중 pending 내비', () => {
  const three = (fire: (r: ApprovalRequest) => void) => {
    fire(mkReq('A', '도구 호출', 'tool-call', 'caution'))
    fire(mkReq('B', 'shell 실행', 'shell', 'destructive'))
    fire(mkReq('C', '변경 적용', 'apply-diff', 'safe'))
  }

  it('queue>1 이면 위치 텍스트·미니칩 스트립 표시', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    expect(screen.getByText('1 / 3')).toBeTruthy()
    expect(screen.getByRole('button', { name: /도구 호출.*주의.*1\/3/ })).toBeTruthy()
  })

  it('→ 키로 다음 카드 focus·경계 clamp', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    expect(screen.getByText('도구 호출 승인')).toBeTruthy() // A(tool-call) current
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    expect(screen.getByText('2 / 3')).toBeTruthy()
    expect(screen.getByText('위험 작업 승인')).toBeTruthy() // B(shell) current
  })

  it('미니칩 탭으로 그 카드 focus + aria-current', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    const chipC = screen.getByRole('button', { name: /변경 적용.*안전.*3\/3/ })
    fireEvent.click(chipC)
    expect(screen.getByText('3 / 3')).toBeTruthy()
    expect(chipC.getAttribute('aria-current')).toBe('true')
  })

  it('임의 순서 결정 — 2건째로 이동 후 승인 → 그 id 결정·나머지 유지', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' }) // B focus
    const approve = screen.getByRole('button', { name: '승인' })
    fireEvent.pointerDown(approve)
    fireEvent.click(approve)
    expect(respondApproval).toHaveBeenCalledWith('B', true)
    expect(screen.getByText('2 / 2')).toBeTruthy() // A·C 남음(current=이웃 C)
  })

  it('이동≠결정 — 화살표/칩 탭은 respondApproval 미호출', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    three(fire)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    fireEvent.click(screen.getByRole('button', { name: /변경 적용.*안전/ }))
    expect(respondApproval).not.toHaveBeenCalled()
  })

  it('Escape 는 잔류 pointerIntent 를 무시하고 현재(내비 후) 카드를 거부한다(적대리뷰 F2)', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    three(fire) // A(current)·B·C
    // 승인 버튼 조준(intent=A)했으나 click 없이 화살표로 current→B(intent 잔류=A).
    fireEvent.pointerDown(screen.getByRole('button', { name: '승인' }), { pointerType: 'touch' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' })
    // Escape=명시적 키보드 거부 → 잔류 intent(A) 무시하고 현재 카드(B) 거부(첫 Escape 삼킴 없음).
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(respondApproval).toHaveBeenCalledWith('B', false)
  })
})

describe('포커스 트랩(미니칩 존재·Codex 체크포인트 2 P2)', () => {
  const two = (fire: (r: ApprovalRequest) => void) => {
    fire(mkReq('A', '도구 호출', 'tool-call', 'caution'))
    fire(mkReq('B', 'shell 실행', 'shell', 'destructive'))
  }

  it('#11 포커스가 모달 밖으로 샜을 때 Tab → 거부 복귀(첫 칩 아님)', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    two(fire) // 미니칩 버튼이 액션 버튼보다 DOM 앞
    const reject = screen.getByRole('button', { name: '거부' })
    const bg = document.createElement('button')
    document.body.appendChild(bg)
    act(() => bg.focus())
    fireEvent.keyDown(bg, { key: 'Tab' })
    expect(document.activeElement).toBe(reject) // 첫 미니칩 아니라 거부
    bg.remove()
  })

  it('#12 미니칩 상태서도 Escape=거부·거부-우선 초기 포커스 유지', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '거부' })) // 초기 포커스
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(respondApproval).toHaveBeenCalledWith('A', false)
  })

  it('#13 칩 포함 상태서 Tab/Shift+Tab 이 모달 밖 탈출 안 함', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const card = screen.getByRole('dialog').querySelector('.modal-card') as HTMLElement
    const buttons = Array.from(card.querySelectorAll('button'))
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    last.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(first) // last→first 순환(탈출 없음)
    first.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last) // first→last 순환
  })

  it('#14 미니칩 focus 중 Enter 는 이동만·respondApproval 미호출', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const chipB = screen.getByRole('button', { name: /shell 실행.*위험.*2\/2/ })
    chipB.focus()
    fireEvent.keyDown(chipB, { key: 'Enter' }) // dialog 트랩은 Enter no-op
    fireEvent.click(chipB) // Enter 의 네이티브 click = FOCUS(이동)
    expect(respondApproval).not.toHaveBeenCalled()
    expect(screen.getByText('2 / 2')).toBeTruthy() // B 로 이동됨(위치 갱신)
  })
})

// jsdom 은 실 레이아웃을 계산하지 않으므로 styles.css 텍스트로 반응형 규칙 존재를 회귀 가드(#216 C2 §C-3).
// 실 앵커·엄지 도달성은 웹 e2e(폰 뷰포트)·라이브 폰 실측으로 검증.
describe('반응형 CSS(회귀 가드)', () => {
  // jsdom 은 CSS ?raw 를 빈 문자열로 주므로 원본 파일을 직접 읽는다(vitest cwd=레포 루트).
  const css = readFileSync(join(process.cwd(), 'src/renderer/styles.css'), 'utf8')

  it('폰 바텀시트 미디어쿼리·미니칩·액션 줄바꿈/바닥고정·시트 애니메이션 규칙 존재', () => {
    expect(css).toMatch(/@media \(max-width: *640px\)/) // 폰 바텀시트 분기
    expect(css).toContain('.modal-nav') // 내비 컨테이너
    expect(css).toContain('.modal-chips') // 미니칩 스트립
    expect(css).toMatch(/flex-wrap: *wrap/) // 모바일 액션 줄바꿈(카운트다운↑·버튼 풀폭·적대리뷰 F4)
    expect(css).toMatch(/position: *sticky/) // 액션 바닥 고정(오버플로 시 스크롤아웃 방지·적대리뷰 F5/F6)
    expect(css).toMatch(/@keyframes sheetUp/) // 시트 슬라이드(reduced-motion 서 무애니)
  })
})

describe('스와이프(진행적 향상)', () => {
  const cardOf = () => screen.getByRole('dialog').querySelector('.modal-card') as HTMLElement
  const two = (fire: (r: ApprovalRequest) => void) => {
    fire(mkReq('A', '도구 호출', 'tool-call', 'caution'))
    fire(mkReq('B', 'shell 실행', 'shell', 'destructive'))
  }

  it('터치 가로 스와이프(임계 초과)로 focus 이동·이동만(결정 아님)', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const card = cardOf()
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerUp(card, { pointerId: 1, pointerType: 'touch', clientX: 130, clientY: 108 }) // 좌 70px
    expect(screen.getByText('2 / 2')).toBeTruthy() // 다음(B) 로 이동
    expect(respondApproval).not.toHaveBeenCalled()
  })

  it('터치 세로 우세 제스처는 이동 안 함(시트 스크롤 보존)', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const card = cardOf()
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerUp(card, { pointerId: 1, pointerType: 'touch', clientX: 190, clientY: 200 }) // 세로 우세
    expect(screen.getByText('1 / 2')).toBeTruthy() // 이동 없음
  })

  it('마우스 드래그는 스와이프 미발화(폰 전용·데스크톱 텍스트선택/칩스크롤 오발화 차단·적대리뷰 F1/F7/F8)', () => {
    const { fire } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const card = cardOf()
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: 'mouse', clientX: 200, clientY: 100 })
    fireEvent.pointerUp(card, { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 104 }) // 좌 100px
    expect(screen.getByText('1 / 2')).toBeTruthy() // 마우스는 이동 없음(pointerType 게이트)
  })

  it('버튼서 시작한 제스처는 카드 스와이프를 발화하지 않는다(stopPropagation·적대리뷰 F1)', () => {
    const { fire, respondApproval } = mockFleet()
    render(<ApprovalModal />)
    two(fire)
    const approve = screen.getByRole('button', { name: '승인' })
    // 버튼 위 터치 pointerdown → captureIntent stopPropagation 으로 카드 swipeStart 미기록.
    fireEvent.pointerDown(approve, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 200,
      clientY: 100,
    })
    fireEvent.pointerUp(cardOf(), {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 104,
    })
    expect(screen.getByText('1 / 2')).toBeTruthy() // FOCUS_DELTA 미발화(A 유지)
    expect(respondApproval).not.toHaveBeenCalled()
  })
})

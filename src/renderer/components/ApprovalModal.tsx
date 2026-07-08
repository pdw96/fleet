import { useEffect, useReducer, useRef, useState } from 'react'
import type { ApprovalRequest, RiskLevel } from '../../shared/types'
import { useHydration } from '../bridge/hydration'

const RISK_LABEL: Record<RiskLevel, string> = {
  safe: '안전',
  caution: '주의',
  destructive: '위험',
}

/** 승인 종류별 모달 제목. apply-diff 는 작업 변경 적용 승인. */
const KIND_TITLE: Record<ApprovalRequest['kind'], string> = {
  'file-write': '위험 작업 승인',
  'file-delete': '위험 작업 승인',
  shell: '위험 작업 승인',
  'apply-diff': '변경 적용 승인',
  'tool-call': '도구 호출 승인',
}

/** 미니칩·스트립용 짧은 라벨(모달 제목 KIND_TITLE 과 별도 — 좁은 칩에 종류만 표기). */
const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  'file-write': '파일 쓰기',
  'file-delete': '파일 삭제',
  shell: 'shell 실행',
  'apply-diff': '변경 적용',
  'tool-call': '도구 호출',
}

/**
 * 남은 ms → "m:ss"(예 573000→"9:33", 5000→"0:05", 0/음수→"0:00"). ceil 초·max(0) 클램프.
 * 서버 권위 카운트다운 표시 전용(#216 C2 §C-4) — 로컬 만료로 카드를 제거하지 않는다(skew 계약).
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export type ApprovalState = { queue: ApprovalRequest[]; focusedId: string | null }
export type ApprovalAction =
  | { type: 'UPSERT'; req: ApprovalRequest }
  | { type: 'REMOVE'; id: string }
  | { type: 'FOCUS'; id: string }
  | { type: 'FOCUS_DELTA'; delta: number }
  | { type: 'HYDRATE'; pending: ApprovalRequest[]; preHydrationIds: Set<string> }

/**
 * 승인 큐+집중 카드 원자 전이(#216 C2 §C-2). `focusedId` 는 **id 로 추적**(위치 인덱스 아님) — 집중 카드보다
 * 앞 순번 카드가 제거돼도 가리키는 카드가 조용히 바뀌지 않아, 사용자가 읽지 않은 카드의 우발 결정 위험을 상태
 * 층에서 차단한다(C1 오조준 가드의 상태 층 보완). tombstone(이미-철회 id 부활 차단)은 순수 reducer 밖(ref)에서
 * dispatch 전 선필터한다 — HYDRATE 는 apply 시점(async resolve 후) 필터라 늦은 stale 스냅숏의 부활도 막는다.
 * **로컬 시계로 만료 카드를 드롭하지 않는다**(#216 skew 계약): 제거 권위는 서버(withdrawn·reconcile)이고,
 * 클라 expiresAt 은 카운트다운 표시 전용이다.
 */
export function approvalReducer(state: ApprovalState, action: ApprovalAction): ApprovalState {
  switch (action.type) {
    case 'UPSERT': {
      const i = state.queue.findIndex((r) => r.id === action.req.id)
      if (i >= 0) {
        const queue = [...state.queue]
        queue[i] = action.req
        return { ...state, queue } // 같은 id 갱신(비파괴)
      }
      return { ...state, queue: [...state.queue, action.req] } // 뒤 추가·focus 불변(얌체 점프 방지)
    }
    case 'REMOVE': {
      const idx = state.queue.findIndex((r) => r.id === action.id)
      if (idx < 0) return state
      const queue = state.queue.filter((r) => r.id !== action.id)
      if (state.focusedId !== action.id) return { ...state, queue } // 비집중 제거 — 집중 불변(id 추적)
      const neighbor = queue[idx] ?? queue[idx - 1] ?? null // 다음, 없으면 이전, 없으면 null
      return { queue, focusedId: neighbor ? neighbor.id : null }
    }
    case 'FOCUS':
      return state.queue.some((r) => r.id === action.id)
        ? { ...state, focusedId: action.id }
        : state
    case 'FOCUS_DELTA': {
      if (state.queue.length === 0) return state
      const cur = state.queue.findIndex((r) => r.id === (state.focusedId ?? state.queue[0].id))
      const ni = Math.min(state.queue.length - 1, Math.max(0, cur + action.delta))
      return { ...state, focusedId: state.queue[ni].id }
    }
    case 'HYDRATE': {
      const snapshotIds = new Set(action.pending.map((r) => r.id))
      // reconcile(#216 C1 §C-3·Codex P2): 스냅숏에 있거나(권위) preHydration 밖(라이브-fresh)인 카드 유지.
      const queue = state.queue.filter(
        (r) => snapshotIds.has(r.id) || !action.preHydrationIds.has(r.id),
      )
      for (const req of action.pending) {
        const i = queue.findIndex((r) => r.id === req.id)
        if (i >= 0) queue[i] = req
        else queue.push(req)
      }
      const focusedId =
        state.focusedId && queue.some((r) => r.id === state.focusedId) ? state.focusedId : null
      return { queue, focusedId }
    }
  }
}

/**
 * destructive 작업 승인 모달(#216 C1 — id-keyed·재하이드레이션·tombstone). App 레벨 상시 마운트.
 * 라이브 요청(onApprovalRequest)과 재접속 스냅숏(listPendingApprovals)을 id 로 병합(비파괴 upsert)하고,
 * 이탈 통지(onApprovalWithdrawn)로 카드를 제거+tombstone 한다. 카운트다운·자동 소멸은 서버 권위 expiresAt 기준.
 */
export function ApprovalModal() {
  const { nonce } = useHydration()
  const [{ queue, focusedId }, dispatch] = useReducer(approvalReducer, {
    queue: [],
    focusedId: null,
  })
  const [now, setNow] = useState(() => Date.now())
  // 철회된 id 집합(id=randomUUID 무재사용 → 영속 안전). 늦은 스냅숏의 이미-철회 id 부활 차단.
  const tombstone = useRef<Set<string>>(new Set())
  // 마우스 오승인 가드(#216 적대리뷰 P3): pointerdown 시 조준한 카드 id 스냅숏. 비동기 스왑(withdrawn/만료
  // prune)으로 눌렀다 뗀 사이 current 가 바뀌면 클릭을 무시 — 사용자가 읽지 않은 카드의 우발 결정 차단.
  const pointerIntent = useRef<string | null>(null)
  const rejectRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // 라이브 승인 요청 구독 — 마운트 1회. tombstone 선필터(이미-철회 부활 차단) 후 UPSERT.
  useEffect(() => {
    return window.fleet.onApprovalRequest((req) => {
      if (!tombstone.current.has(req.id)) dispatch({ type: 'UPSERT', req })
    })
  }, [])

  // 승인 이탈(응답/만료/철회/취소·rejectAll) 통지 — tombstone 기록 + REMOVE. 마운트 1회.
  useEffect(() => {
    return window.fleet.onApprovalWithdrawn((id) => {
      tombstone.current.add(id)
      dispatch({ type: 'REMOVE', id })
    })
  }, [])

  // 재하이드레이션(마운트 nonce=0 + 재접속 hello 마다 nonce+1) — listPendingApprovals 스냅숏 upsert(비파괴).
  // 데스크톱은 bridge=null → nonce 영구 0 → 마운트 1회(대개 빈 목록·무회귀). tombstone 재확인은 upsert 안(apply 시점).
  useEffect(() => {
    let cancelled = false
    let retries = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    // 하이드레이션 시작 시점(이 nonce 렌더)의 큐 id — reconcile 대상. 이후 라이브 추가(onApprovalRequest)는
    // 이 집합 밖이라 보존된다(§C-3 live-race 가드 — 하이드레이션 창 중 생성된 카드의 drop-hang 방지).
    const preHydrationIds = new Set(queue.map((r) => r.id))
    const fetchSnapshot = (): void => {
      window.fleet
        .listPendingApprovals()
        .then((pending) => {
          if (cancelled) return
          // apply 시점 tombstone 재확인(늦은 stale 스냅숏의 이미-철회 id 부활 차단) 후 HYDRATE.
          // reconcile(스냅숏 부재 pre-hydration 제거·라이브-fresh 보존)은 reducer 가 수행(#216 C2 §C-2).
          const clean = pending.filter((r) => !tombstone.current.has(r.id))
          dispatch({ type: 'HYDRATE', pending: clean, preHydrationIds })
        })
        .catch(() => {
          // pre-hello 재접속 등으로 조회가 reject 되면(소켓 조기 종료) 제한 재시도(#216 Codex 재리뷰 P2) —
          // HydrationProvider 가 그 재접속을 '최초 접속'으로 오분류해 nonce 를 못 올리는 창에서 held 승인이
          // 재제시되지 않던 갭 보완. 소진 시 다음 nonce 전환·라이브 구독이 이후 카드를 채운다(fail-safe).
          if (cancelled || retries >= 3) return
          retries += 1
          retryTimer = setTimeout(fetchSnapshot, 400 * retries)
        })
    }
    fetchSnapshot()
    return () => {
      cancelled = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
    }
    // queue 는 의도적 deps 제외 — nonce 전환 시점의 pre-hydration id 스냅숏만 필요(라이브 추가 보호).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  // 1s 틱 — 카운트다운 표시 갱신 전용(#216 Codex 재리뷰 P2). **로컬 시계로 카드를 제거하지 않는다** — 클라
  // (폰) 시계가 서버보다 앞서면 서버가 유효하다고 보는 카드를 로컬 prune 이 드롭해 승인 불가가 되기 때문.
  // 만료 제거 권위는 서버(withdrawn 브로드캐스트 · 재접속 reconcile). 카운트다운은 max(0,..)로 0s 클램프만.
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [])

  // 집중 카드 = focusedId 가 큐에 있으면 그 카드, 없거나 null 이면 큐 앞(FIFO 기본). position=1..N 표시.
  const current = queue.find((r) => r.id === focusedId) ?? queue[0]
  const position = current ? queue.findIndex((r) => r.id === current.id) + 1 : 0
  // 카운트다운 = 서버 권위 expiresAt 기준 mm:ss(공유 상수 APPROVAL_TIMEOUT_MS 소비 제거 — 카운트다운=실제 만료 정합).
  const remaining = current ? formatCountdown(current.expiresAt - now) : '0:00'

  // 결정 의도 스냅숏(#216 적대리뷰 P3·Codex P2) — pointerdown/keydown 시 조준한 카드 id 를 기록. 마우스·
  // 키보드(Enter/Space) 활성화가 커밋(click)되기 전 비동기 스왑(withdrawn/만료/reconcile)이 일어나면 decide
  // 가 intent≠current 로 무시해 사용자가 읽지 않은 카드의 우발 결정을 막는다.
  const captureIntent = (): void => {
    if (current) pointerIntent.current = current.id
  }
  const captureIntentKey = (e: { key: string }): void => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') captureIntent()
  }

  const decide = (approved: boolean): void => {
    if (!current) return
    // 마우스 결정 가드: pointerdown 시 조준한 id 와 현재 카드가 다르면(비동기 스왑) 이 클릭을 무시한다.
    // 키보드(Escape)·프로그램 호출은 pointerIntent 미설정(null)이라 가드를 우회해 현재 카드에 작용(안전 방향).
    const intent = pointerIntent.current
    pointerIntent.current = null
    if (intent !== null && intent !== current.id) return
    // 회신 유실(전송 단절)은 조용히 흡수 — main/server 의 승인 만료(fail-closed 자동 거부)가 권위라
    // 렌더러가 재시도하지 않는다. respond 는 이미 해소된 id 에 멱등 no-op.
    void window.fleet.respondApproval(current.id, approved).catch(() => undefined)
    dispatch({ type: 'REMOVE', id: current.id })
  }

  // 모달 열림·큐 전진(다음 요청)마다 거부 버튼에 초기 포커스 — Enter 가 거부로 떨어져 destructive 오승인 방지.
  useEffect(() => {
    if (current) rejectRef.current?.focus()
    // 요청 id 전환마다 거부 버튼 초기 포커스 — current 객체 변화가 아닌 id 변화 기준이 의도.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  // 키보드 트랩(document 레벨): Escape=거부 + Tab/Shift+Tab 을 모달 내 버튼(거부↔승인)으로 가둔다.
  // document 에 거는 이유 — overlay 에 건 핸들러는 포커스가 overlay 밖(배경/body)으로 새면 발화하지 않아
  // 배경으로의 Tab 탈출을 못 막는다(Codex P2). document 리스너는 포커스 위치와 무관하게 Tab 을 잡아,
  // 포커스가 모달 밖이면(!card.contains) 내부로 복귀시킨다.
  useEffect(() => {
    if (!current) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        decide(false) // 거부 — 자동거부 백스톱과 일관한 안전 방향
        return
      }
      // 화살표 = 집중 카드 이동(결정 아님·불변식③). 최신 큐 기준 ±1 clamp(reducer).
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        dispatch({ type: 'FOCUS_DELTA', delta: 1 })
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        dispatch({ type: 'FOCUS_DELTA', delta: -1 })
        return
      }
      if (e.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      const focusables = Array.from(card.querySelectorAll<HTMLElement>('button'))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!card.contains(active)) {
        e.preventDefault()
        // 이탈 복귀는 항상 거부(rejectRef) — 미니칩/내비가 액션 버튼보다 DOM 앞이라 첫 focusable 이
        // 칩일 수 있어, DOM 순서 무관하게 거부-우선 안전을 고정한다(#216 Codex 체크포인트 2 P2).
        rejectRef.current?.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // 요청 id 전환마다 리스너 재부착 — current/decide 객체 변화가 아닌 id 변화 기준이 의도(매 렌더 재부착 방지).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])

  if (!current) return null

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      aria-describedby="approval-summary approval-target"
    >
      <div className="panel modal-card" ref={cardRef}>
        <div className="panel-head">
          <span className="eyebrow">승인 필요</span>
          <h2 className="panel-title" id="approval-title">
            {KIND_TITLE[current.kind]}
          </h2>
          <div className="right">
            <span className="chip" style={{ color: 'var(--bad)', borderColor: 'currentColor' }}>
              {RISK_LABEL[current.risk]}
            </span>
          </div>
        </div>
        <p className="modal-summary" id="approval-summary">
          {current.summary}
        </p>
        <p className="modal-target" id="approval-target">
          {current.target}
        </p>
        {queue.length > 1 && (
          <div className="modal-nav" role="group" aria-label="대기 중 승인 이동">
            <div className="modal-chips">
              {queue.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  className={`modal-chip${r.id === current.id ? ' is-current' : ''}`}
                  aria-current={r.id === current.id ? 'true' : undefined}
                  aria-label={`${KIND_LABEL[r.kind]} · ${RISK_LABEL[r.risk]} (${i + 1}/${queue.length})`}
                  onClick={() => dispatch({ type: 'FOCUS', id: r.id })}
                >
                  <span className="modal-chip-kind">{KIND_LABEL[r.kind]}</span>
                  <span className="modal-chip-risk" data-risk={r.risk}>
                    {RISK_LABEL[r.risk]}
                  </span>
                </button>
              ))}
            </div>
            <span className="modal-pos">
              {position} / {queue.length}
            </span>
          </div>
        )}
        <div className="modal-actions">
          <span className="modal-countdown">{remaining} 후 자동 거부</span>
          <button
            ref={rejectRef}
            className="btn btn-danger"
            onPointerDown={captureIntent}
            onKeyDown={captureIntentKey}
            onClick={() => decide(false)}
          >
            거부
          </button>
          <button
            className="btn"
            onPointerDown={captureIntent}
            onKeyDown={captureIntentKey}
            onClick={() => decide(true)}
          >
            승인
          </button>
        </div>
      </div>
    </div>
  )
}

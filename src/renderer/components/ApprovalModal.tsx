import { useEffect, useRef, useState } from 'react'
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

/**
 * id-keyed 비파괴 upsert(#216 C1 §C-3) — 이미 철회(tombstone)된 요청만 부활 차단한다. tombstone 재확인을
 * 스냅숏 apply 시점에 수행해(async resolve 후 이 함수 호출) 늦게 도착한 stale 스냅숏의 이미-철회 id 부활을
 * 막는다. 같은 id 라이브+스냅숏은 단일 카드로 병합. **로컬 시계(Date.now)로 만료 카드를 드롭하지 않는다**
 * (#216 Codex 재리뷰 P2): 서버 권위 expiresAt 대비 클라(폰) 시계가 앞서면 서버가 아직 유효하다고 보는 카드를
 * 로컬이 드롭해 "외출 중 폰 승인"이 스큐 클라에서 실패한다. 존재/만료 권위는 서버(snapshot·withdrawn·resolve)에
 * 있고, 클라의 expiresAt 사용은 카운트다운 표시 전용이다(broadcast·server list() 는 유효 카드만 보낸다).
 */
function upsertApproval(
  prev: ApprovalRequest[],
  req: ApprovalRequest,
  tombstone: Set<string>,
): ApprovalRequest[] {
  if (tombstone.has(req.id)) return prev
  const i = prev.findIndex((r) => r.id === req.id)
  if (i >= 0) {
    const next = [...prev]
    next[i] = req
    return next
  }
  return [...prev, req]
}

/**
 * destructive 작업 승인 모달(#216 C1 — id-keyed·재하이드레이션·tombstone). App 레벨 상시 마운트.
 * 라이브 요청(onApprovalRequest)과 재접속 스냅숏(listPendingApprovals)을 id 로 병합(비파괴 upsert)하고,
 * 이탈 통지(onApprovalWithdrawn)로 카드를 제거+tombstone 한다. 카운트다운·자동 소멸은 서버 권위 expiresAt 기준.
 */
export function ApprovalModal() {
  const { nonce } = useHydration()
  const [queue, setQueue] = useState<ApprovalRequest[]>([])
  const [now, setNow] = useState(() => Date.now())
  // 철회된 id 집합(id=randomUUID 무재사용 → 영속 안전). 늦은 스냅숏의 이미-철회 id 부활 차단.
  const tombstone = useRef<Set<string>>(new Set())
  // 마우스 오승인 가드(#216 적대리뷰 P3): pointerdown 시 조준한 카드 id 스냅숏. 비동기 스왑(withdrawn/만료
  // prune)으로 눌렀다 뗀 사이 current 가 바뀌면 클릭을 무시 — 사용자가 읽지 않은 카드의 우발 결정 차단.
  const pointerIntent = useRef<string | null>(null)
  const rejectRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // 라이브 승인 요청 구독 — 마운트 1회. id-keyed upsert(tombstone/만료 가드).
  useEffect(() => {
    const unsub = window.fleet.onApprovalRequest((req) =>
      setQueue((prev) => upsertApproval(prev, req, tombstone.current)),
    )
    return unsub
  }, [])

  // 승인 이탈(응답/만료/철회/취소·rejectAll) 통지 — id 제거 + tombstone 기록. 마운트 1회.
  useEffect(() => {
    const unsub = window.fleet.onApprovalWithdrawn((id) => {
      tombstone.current.add(id)
      setQueue((prev) => prev.filter((r) => r.id !== id))
    })
    return unsub
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
          const snapshotIds = new Set(pending.map((r) => r.id))
          setQueue((prev) => {
            // reconcile(#216 적대리뷰 Codex P2): 하이드레이션 前 존재했으나 권위 스냅숏에 없는 카드를 제거 —
            // 재접속 중 놓친 withdrawn·타세션 해소를 정리(로컬 expiresAt·TTL 까지 유령 카드 잔존 방지). 라이브
            // -fresh(preHydrationIds 밖)는 보존해 drop-race 를 피한다. 스냅숏 카드는 이어서 upsert.
            let next = prev.filter((r) => snapshotIds.has(r.id) || !preHydrationIds.has(r.id))
            for (const req of pending) next = upsertApproval(next, req, tombstone.current)
            return next
          })
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

  const current = queue[0]
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
    setQueue((prev) => prev.filter((r) => r.id !== current.id))
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
        first.focus() // 포커스가 모달 밖으로 샜으면 내부(첫 버튼)로 복귀
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
        {queue.length > 1 && <p className="modal-pending">대기 중 {queue.length - 1}건</p>}
      </div>
    </div>
  )
}

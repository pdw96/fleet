import { APPROVAL_MAX_PENDING } from '../../../shared/types'
import type { ApprovalOutcome, ApprovalRequest } from '../../../shared/types'

export interface IpcApproverOptions {
  /** 렌더러/클라로 승인 요청 방출(브로드캐스트). best-effort(throw 무해 — 불변식 ③). */
  send: (req: ApprovalRequest) => void
  /** 응답 가능한 창이 있는지. `reject-immediate` 정책에서만 참조(없으면 즉시 거부). */
  hasWindow: () => boolean
  /**
   * presence=0 처리 정책(#216 C1). 기본 `reject-immediate`(데스크톱 무회귀). 서버는 `hold` —
   * 창 없어도 거부하지 않고 보류(스냅숏이 다음 접속에 재제시·타이머가 만료 종착).
   */
  presencePolicy?: 'reject-immediate' | 'hold'
  /**
   * pending 이탈(응답/만료/철회/rejectAll/abort) 시 id 통지 — 서버가 tombstone 브로드캐스트(best-effort).
   * throw 는 격리된다(불변식 ④ — resolve 선행 보존·만료 타이머 self-DoS 없음).
   */
  onWithdraw?: (id: string) => void
  /**
   * 주입 clock(#216 C1 §C-2) — 만료 타이머 delay·list 필터의 단일 시계. 기본 전역 setTimeout/
   * clearTimeout/Date.now. 서버는 boot 의 clock 을 주입해 통합 만료를 결정론화(§3-23).
   */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  /** 동시 pending 상한(초과 시 fail-closed 즉시 거부 + reason). 기본 APPROVAL_MAX_PENDING. */
  maxPending?: number
}

export interface IpcApprover {
  /**
   * ApprovalGate.approver 로 주입할 콜백. `ApprovalOutcome` 반환(#216 C1 — boolean 아님). `opts.signal`
   * 관통 시 취소(cancelRun/cancelChat) abort 가 대기 중 승인을 즉시 `{approved:false}` 로 해소한다(§C-5).
   */
  approver: (req: ApprovalRequest, opts?: { signal?: AbortSignal }) => Promise<ApprovalOutcome>
  /** 렌더러 회신을 해소한다. 미존재/이미 해소 id 는 무시(idempotent). */
  resolve: (id: string, approved: boolean) => void
  /**
   * 대기 중 승인 전원을 즉시 거부(resolve {approved:false})하고 타이머·맵을 비운다. 종료(close) drain·
   * (loopback 외) 인증 클라 0 전이 fail-closed 용. 이후 늦은 resolve 는 무시(멱등).
   */
  rejectAll: () => void
  /** 대기 중 요청 수(테스트/진단용). */
  pendingCount: () => number
  /**
   * 미만료 대기 승인 스냅숏(권위·#216 C1). `expiresAt<=now` 제외(순수 필터·비파괴 — 타이머가 유일
   * 제거 권위). 후접속 클라가 listPendingApprovals 로 재하이드레이트한다(§C-3).
   */
  list: () => ApprovalRequest[]
}

interface Pending {
  req: ApprovalRequest
  /** 이 pending 을 해소한다(멱등·전경로 단일 진입 — 불변식 ①). */
  settle: (outcome: ApprovalOutcome) => void
}

/**
 * destructive 승인 요청을 렌더러/클라로 보내고 회신을 id 로 상관한다(#216 C1 hold-with-expiry).
 * presencePolicy 로 데스크톱(reject-immediate)·서버(hold) 를 가른다. Electron 비의존(순수).
 *
 * 불변식(§1.8): ① 해소 순서(delete→resolve→onWithdraw·id당 1회) · ② aborted 선체크+addEventListener
 * 동일 동기 블록 · ③ send best-effort · ④ onWithdraw best-effort · ⑤ 중복 id 미고아 · ⑥ list 순수 필터.
 */
export function createIpcApprover(opts: IpcApproverOptions): IpcApprover {
  const presencePolicy = opts.presencePolicy ?? 'reject-immediate'
  const maxPending = opts.maxPending ?? APPROVAL_MAX_PENDING
  const now = opts.now ?? (() => Date.now())
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const t = setTimeout(fn, ms)
      // 대기 타이머가 프로세스 종료를 막지 않도록 unref(있을 때만 — fake timer 호환).
      if (typeof t === 'object' && t && 'unref' in t) (t as { unref: () => void }).unref()
      return t
    })
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const pending = new Map<string, Pending>()

  return {
    approver(req, callOpts) {
      const signal = callOpts?.signal
      // reject-immediate(데스크톱 무회귀): 창 없으면 즉시 거부.
      if (presencePolicy === 'reject-immediate' && !opts.hasWindow()) {
        return Promise.resolve({ approved: false })
      }
      // pending 상한(fail-closed) — enqueue 전 거부 + reason(gate 가 approval.decided 감사에 실음).
      if (pending.size >= maxPending) {
        return Promise.resolve({ approved: false, reason: 'pending-cap' })
      }
      // ⑤ 중복 id — 첫 pending 미고아, 둘째 거부(id=randomUUID 무재사용 전제).
      if (pending.has(req.id)) {
        return Promise.resolve({ approved: false })
      }
      // ② 진입 시 이미 aborted → enqueue/send 없이 즉시 거부. 이미-aborted signal 은 이후
      //    addEventListener('abort') 미발화이므로, 선체크와 등록은 반드시 같은 동기 블록(아래)이어야 한다.
      if (signal?.aborted) {
        return Promise.resolve({ approved: false })
      }
      return new Promise<ApprovalOutcome>((resolve) => {
        let settled = false
        const onAbort = (): void => settle({ approved: false })
        // ① 해소 순서: delete → resolve → onWithdraw. 리스너 정리 전경로. settled 로 id당 1회(재진입 안전).
        // (timer 는 아래 const 로 선언 — settle 은 타이머/abort/resolve 로만 호출돼 항상 timer 초기화 후 실행.)
        const settle = (outcome: ApprovalOutcome): void => {
          if (settled) return
          settled = true
          pending.delete(req.id)
          clearTimer(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
          resolve(outcome)
          try {
            opts.onWithdraw?.(req.id)
          } catch {
            // ④ best-effort — throw 가 resolve 선행을 스킵하거나 만료 콜백을 self-DoS 크래시시키지 않음.
          }
        }
        // 만료 타이머 — delay 와 list 필터가 같은 주입 clock(§C-2). expiresAt<=now 면 즉시(0) 발화.
        const timer = setTimer(
          () => settle({ approved: false }),
          Math.max(0, req.expiresAt - now()),
        )
        pending.set(req.id, { req, settle })
        // ② 선체크(위)와 동일 동기 블록. once 로 중복 발화 방지.
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
        // ③ send best-effort — 브로드캐스트 실패해도 pending 유지(스냅숏 재제시·타이머 종착).
        try {
          opts.send(req)
        } catch {
          // pending 유지 — send 실패로 promise reject·좀비 pending 을 만들지 않는다.
        }
      })
    },

    resolve(id, approved) {
      const p = pending.get(id)
      if (!p) return
      // fail-closed 만료 강등(#216 적대리뷰 Codex P1): 만료 데드라인(req.expiresAt)을 지난 late approved:true
      // 회신이 destructive 를 승인하지 못하게 한다. 만료 타이머가 event-loop 지연·타이머 스케줄링·주입 clock
      // 으로 아직 발화하지 않은 창에서, expiresAt 서버 권위를 resolve 경로에서도 재확인한다(list() 의
      // `expiresAt > now` 규율과 동일 — 경계 now===expiresAt 은 만료로 본다). 거부(false)는 무조건 통과.
      p.settle({ approved: approved && p.req.expiresAt > now() })
    },

    rejectAll() {
      // 맵을 먼저 비운 뒤 해소 — settle 이 재진입(동기 onWithdraw→rejectAll)해도 맵 부재·settled 로 재해소 없음.
      const outstanding = [...pending.values()]
      pending.clear()
      for (const p of outstanding) p.settle({ approved: false })
    },

    pendingCount() {
      return pending.size
    },

    list() {
      const t = now()
      // ⑥ 순수 필터(비파괴) — 미만료만. 제거는 타이머(권위) 단독.
      return [...pending.values()].filter((p) => p.req.expiresAt > t).map((p) => p.req)
    },
  }
}

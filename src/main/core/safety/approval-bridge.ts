import { APPROVAL_TIMEOUT_MS } from '../../../shared/types'
import type { ApprovalRequest } from '../../../shared/types'

export interface IpcApproverOptions {
  /** 렌더러로 승인 요청 방출(브로드캐스트). */
  send: (req: ApprovalRequest) => void
  /** 응답 가능한 창이 있는지. 없으면 즉시 거부(안전 기본값). */
  hasWindow: () => boolean
  /** 무응답 자동 거부까지(ms). 기본 APPROVAL_TIMEOUT_MS. */
  timeoutMs?: number
}

export interface IpcApprover {
  /** ApprovalGate.approver 로 주입할 콜백. */
  approver: (req: ApprovalRequest) => Promise<boolean>
  /** 렌더러 회신을 해소한다. 미존재/이미 해소 id 는 무시(idempotent). */
  resolve: (id: string, approved: boolean) => void
  /** 대기 중 요청 수(테스트/진단용). */
  pendingCount: () => number
}

interface Pending {
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * destructive 승인 요청을 렌더러로 보내고 회신을 id 로 상관한다.
 * 창이 없으면 즉시 거부, 무응답이면 타임아웃 후 거부(안전 기본값). Electron 비의존(순수).
 */
export function createIpcApprover(opts: IpcApproverOptions): IpcApprover {
  const timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS
  const pending = new Map<string, Pending>()

  return {
    approver(req) {
      if (!opts.hasWindow()) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.has(req.id)) return
          pending.delete(req.id)
          resolve(false)
        }, timeoutMs)
        // 대기 타이머가 프로세스 종료를 막지 않도록 unref(있을 때만 — fake timer 호환).
        if (typeof timer === 'object' && timer && 'unref' in timer) {
          ;(timer as { unref: () => void }).unref()
        }
        pending.set(req.id, { resolve, timer })
        opts.send(req)
      })
    },

    resolve(id, approved) {
      const p = pending.get(id)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(id)
      p.resolve(approved)
    },

    pendingCount() {
      return pending.size
    },
  }
}

import { randomUUID } from 'node:crypto'
import {
  APPROVAL_TIMEOUT_MS,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalRequest,
  type RiskLevel,
} from '../../../shared/types'

export const SENSITIVE_FILE = /(^|[/\\])\.env(\.|$)|\.(env|pem|key|p12|pfx)$|(^|[/\\])\.ssh[/\\]/i

export interface ApprovalGate {
  /**
   * 승인 요청. gate 가 id·ts·expiresAt 를 스탬프한다(#216 C1). `callOpts.signal` 은 approver 까지
   * 관통해 취소(cancelRun/cancelChat) 시 대기 중 승인이 즉시 해소되게 한다(§C-5).
   */
  request(
    req: Omit<ApprovalRequest, 'id' | 'ts' | 'expiresAt'>,
    callOpts?: { signal?: AbortSignal },
  ): Promise<ApprovalDecision>
}

export interface GateOptions {
  /** 자동 승인할 위험도 (기본 ['safe']) */
  autoApprove?: RiskLevel[]
  /**
   * 그 외 위험도에 대한 승인 요청 (없으면 거부 = 안전 기본값). `ApprovalOutcome` 를 반환하고
   * (boolean 아님), gate 가 `o.reason` 을 approval.decided 감사에 실는다(#216 C1 · reason 단일 책임).
   */
  approver?: (req: ApprovalRequest, opts?: { signal?: AbortSignal }) => Promise<ApprovalOutcome>
  /** 승인 무응답 자동거부까지(ms) — `expiresAt = ts + ttlMs`. 기본 APPROVAL_TIMEOUT_MS(60s). */
  ttlMs?: number
  idGen?: () => string
  now?: () => number
  onEvent?: (type: string, data: Record<string, unknown>) => void
}

/**
 * 승인 게이트 (요구사항 6). destructive 작업은 approver 승인 없이는 거부된다.
 * 게이트는 무엇이 destructive 인지 *판정하지 않는다* — 호출자(도구)가 신고한 req.risk 를
 * 집행할 뿐이다(risk classification 아닌 risk enforcement). 셸/명령 위험 분류는 코어가 아니라
 * sub-agent CLI 경계에 위임된다(#167/#170 — 코어 내 명령 denylist 없음).
 * 모든 요청/결정은 onEvent 로 감사 로그에 남는다.
 */
export function createApprovalGate(opts: GateOptions = {}): ApprovalGate {
  const autoApprove = new Set<RiskLevel>(opts.autoApprove ?? ['safe'])
  const idGen = opts.idGen ?? (() => randomUUID())
  const now = opts.now ?? (() => Date.now())
  const ttlMs = opts.ttlMs ?? APPROVAL_TIMEOUT_MS

  return {
    async request(partial, callOpts) {
      const ts = now()
      const req: ApprovalRequest = { ...partial, id: idGen(), ts, expiresAt: ts + ttlMs }
      opts.onEvent?.('approval.requested', {
        id: req.id,
        kind: req.kind,
        target: req.target,
        risk: req.risk,
      })

      let decision: ApprovalDecision
      let reason: string | undefined
      if (autoApprove.has(req.risk)) {
        decision = 'approved'
      } else if (opts.approver) {
        const o = await opts.approver(req, { signal: callOpts?.signal })
        // fail-closed 최후방어선(#216 적대리뷰 P3): `=== true` 로 협착 — 비-boolean truthy(예: WS 프레임이
        // 문자열 "false" 를 실어보내는 등)가 거부를 승인으로 뒤집지 못하게. decodeClientFrame 은 args 내용을
        // 검증하지 않으므로(protocol) 승인 결정의 단일 초크포인트에서 boolean 을 강제한다.
        decision = o.approved === true ? 'approved' : 'rejected'
        reason = o.reason
      } else {
        decision = 'rejected'
      }

      opts.onEvent?.('approval.decided', {
        id: req.id,
        decision,
        risk: req.risk,
        // reason 은 approver 가 실었을 때만 방출(auto-approve·무approver 경로는 없음 — reason 단일 책임).
        ...(reason !== undefined ? { reason } : {}),
      })
      return decision
    },
  }
}

import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, ApprovalRequest, RiskLevel } from '../../../shared/types'

export const SENSITIVE_FILE = /(^|[/\\])\.env(\.|$)|\.(env|pem|key|p12|pfx)$|(^|[/\\])\.ssh[/\\]/i

export interface ApprovalGate {
  request(req: Omit<ApprovalRequest, 'id' | 'ts'>): Promise<ApprovalDecision>
}

export interface GateOptions {
  /** 자동 승인할 위험도 (기본 ['safe']) */
  autoApprove?: RiskLevel[]
  /** 그 외 위험도에 대한 승인 요청 (없으면 거부 = 안전 기본값) */
  approver?: (req: ApprovalRequest) => Promise<boolean>
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

  return {
    async request(partial) {
      const req: ApprovalRequest = { ...partial, id: idGen(), ts: now() }
      opts.onEvent?.('approval.requested', {
        id: req.id,
        kind: req.kind,
        target: req.target,
        risk: req.risk,
      })

      let decision: ApprovalDecision
      if (autoApprove.has(req.risk)) {
        decision = 'approved'
      } else if (opts.approver) {
        decision = (await opts.approver(req)) ? 'approved' : 'rejected'
      } else {
        decision = 'rejected'
      }

      opts.onEvent?.('approval.decided', { id: req.id, decision, risk: req.risk })
      return decision
    },
  }
}

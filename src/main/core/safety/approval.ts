import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, ApprovalRequest, RiskLevel } from '../../../shared/types'

/** destructive(파괴적) 명령 패턴 (요구사항 6: 승인 없이 실행 금지). */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bgit\s+push\b.*--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bdrop\s+(table|database)\b/i,
  /\bshutdown\b/i,
  /\bsudo\b/i,
  />\s*\/dev\/sd/i,
]

export const SENSITIVE_FILE = /(^|[/\\])\.env(\.|$)|\.(env|pem|key|p12|pfx)$|(^|[/\\])\.ssh[/\\]/i

export function classifyCommandRisk(command: string): RiskLevel {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command)) ? 'destructive' : 'caution'
}

export function classifyFileRisk(kind: 'file-write' | 'file-delete', target: string): RiskLevel {
  if (kind === 'file-delete') return 'destructive'
  if (SENSITIVE_FILE.test(target)) return 'destructive'
  return 'caution'
}

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

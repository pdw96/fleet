import type { RiskLevel } from '../../../shared/types'
import type { DiffResult } from '../workspace/git'

const SENSITIVE = /\.(env|pem|key|p12|pfx)$|(^|[/\\])\.ssh[/\\]/i

export interface DiffRisk { risk: RiskLevel; reasons: string[] }

/** diff 위험 분류: 민감 파일·대량 삭제 → destructive, 그 외 → caution. */
export function classifyDiffRisk(diff: DiffResult, deleteThreshold = 5): DiffRisk {
  const reasons: string[] = []
  const sensitive = diff.files.filter((f) => SENSITIVE.test(f))
  if (sensitive.length > 0) reasons.push(`민감 파일 변경: ${sensitive.join(', ')}`)
  const deletions = (diff.patch.match(/^deleted file mode/gm) ?? []).length
  if (deletions > deleteThreshold) reasons.push(`대량 삭제 ${deletions}건`)
  return { risk: reasons.length > 0 ? 'destructive' : 'caution', reasons }
}

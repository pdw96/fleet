import type { RiskLevel } from '../../../shared/types'
import type { IgnoredChangeSet } from '../workspace/ignored-baseline'
import { SENSITIVE_FILE } from '../safety/approval'
import type { DiffResult } from '../workspace/git'

export interface DiffRisk {
  risk: RiskLevel
  reasons: string[]
}

/** diff 위험 분류: 민감 파일·대량 삭제·diff 절단 + ignored 변경 → destructive, 그 외 → caution. */
export function classifyDiffRisk(
  diff: DiffResult,
  ignored?: IgnoredChangeSet,
  deleteThreshold = 5,
): DiffRisk {
  const reasons: string[] = []
  const sensitive = diff.files.filter((f) => SENSITIVE_FILE.test(f))
  if (sensitive.length > 0) reasons.push(`민감 파일 변경: ${sensitive.join(', ')}`)
  const deletions = (diff.patch.match(/^deleted file mode/gm) ?? []).length
  if (deletions > deleteThreshold) reasons.push(`대량 삭제 ${deletions}건`)
  // patch 가 절단(60KB)된 경우 삭제 마커가 잘려 과소분류될 수 있으므로 안전하게 destructive 처리.
  if (diff.truncated) reasons.push('diff 절단(전체 검증 불가)')

  if (ignored) {
    for (const c of ignored.changes) {
      const label = c.sensitive ? '민감 ignored 변경' : 'ignored 변경'
      reasons.push(`${label}: ${c.path} (${c.change})`) // 경로·종류만, 내용 비노출
    }
    if (ignored.unrestorable.length > 0)
      reasons.push(
        `복원 불가 ignored ${ignored.unrestorable.length}건: ${ignored.unrestorable.map((u) => u.path).join(', ')}`,
      )
  }
  return { risk: reasons.length > 0 ? 'destructive' : 'caution', reasons }
}

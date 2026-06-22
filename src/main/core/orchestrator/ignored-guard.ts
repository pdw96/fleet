import type { Workspace } from '../workspace/git'
import type { IgnoredBaseline } from '../workspace/ignored-baseline'

/**
 * 거부·실패·취소 경로의 rollback: tracked revert → ignored 선택 복원(순서 고정).
 * 어느 쪽이 실패해도 흡수하지 않고 노트로 누적해 호출자가 task output/event 에 표면화한다(#7).
 *
 * 순서 불변식: ws.revert(base) 는 내부적으로 `git reset --hard` + `git clean -ffd` 를 실행한다.
 * `-ffd` 에는 `-x` 가 없으므로 .gitignore 대상(ignored) 파일은 제거되지 않는다.
 * 이 git 불변식 덕분에 revert 후에도 ignored 파일이 디스크에 살아남고,
 * 그 상태에서 restoreIgnoredBaseline 이 에이전트가 새로 만든 ignored 파일을 삭제하고
 * 수정/삭제된 기존 ignored 파일을 백업에서 복원할 수 있다.
 * (따라서 두 단계의 순서를 바꾸거나 clean -x 로 변경하면 restore 가 무의미해진다.)
 *
 * @returns `{ note, failed }` — `note` 는 호출자가 출력에 덧붙이는 용도(없으면 '').
 *   `failed` = true 는 ws.revert 또는 ws.restoreIgnoredBaseline 이 실제로 throw 한 경우만
 *   (dirty-tree 위험). capped 경고만 발생한 경우 failed = false (롤백 성공, 스캔 상한만 도달).
 */
export async function rollbackWithIgnored(
  ws: Pick<Workspace, 'revert' | 'restoreIgnoredBaseline'>,
  base: string,
  baseline: IgnoredBaseline | null,
): Promise<{ note: string; failed: boolean }> {
  const notes: string[] = []
  let failed = false
  try {
    await ws.revert(base)
  } catch (err) {
    failed = true
    notes.push(
      ` · 되돌리기 실패: ${err instanceof Error ? err.message : String(err)}(워크스페이스 부분 변경 잔존)`,
    )
  }
  if (baseline) {
    try {
      const { capped } = await ws.restoreIgnoredBaseline(baseline)
      if (capped) {
        // 스캔 상한은 경고일 뿐 rollback 실패가 아니다(failed 로 올리지 않음 — 재시도 경로 오중단 방지).
        notes.push(' · ignored 스캔 상한 도달(일부 ignored 파일이 rollback 에서 누락될 수 있음)')
      }
    } catch (err) {
      failed = true
      notes.push(
        ` · ignored 복원 실패: ${err instanceof Error ? err.message : String(err)}(ignored 파일 잔존)`,
      )
    }
  }
  return { note: notes.join(''), failed }
}

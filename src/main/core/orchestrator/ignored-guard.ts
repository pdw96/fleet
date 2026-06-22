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
 * @returns 실패 노트(없으면 ''), 호출자가 출력에 덧붙이는 용도.
 */
export async function rollbackWithIgnored(
  ws: Pick<Workspace, 'revert' | 'restoreIgnoredBaseline'>,
  base: string,
  baseline: IgnoredBaseline | null,
): Promise<string> {
  const notes: string[] = []
  try {
    await ws.revert(base)
  } catch (err) {
    notes.push(
      ` · 되돌리기 실패: ${err instanceof Error ? err.message : String(err)}(워크스페이스 부분 변경 잔존)`,
    )
  }
  if (baseline) {
    try {
      const { capped } = await ws.restoreIgnoredBaseline(baseline)
      if (capped) {
        notes.push(' · ignored 스캔 상한 도달(일부 ignored 파일이 rollback 에서 누락될 수 있음)')
      }
    } catch (err) {
      notes.push(
        ` · ignored 복원 실패: ${err instanceof Error ? err.message : String(err)}(ignored 파일 잔존)`,
      )
    }
  }
  return notes.join('')
}

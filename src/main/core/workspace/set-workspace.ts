import { statSync } from 'node:fs'
import { resolveWithin } from './path-guard'

/**
 * `fleet:workspace:set`(#197 B4) 의 공유 시맨틱 — desktop main·fleet-server 핸들러가 함께 쓴다.
 * 웹 UI 의 경로 입력을 FLEET_WORKSPACE_ROOT 하위로 한정(resolveWithin — symlink/junction 탈출도
 * realpath 로 차단, #128 path-guard 재사용)하고, 존재하는 디렉터리만 허용한다. 런 진행 중 변경은
 * 거부한다 — UI disabled 는 보조일 뿐 이 서버측 가드가 권위(단, per-run worktree 격리는 Phase C —
 * 이 가드는 Fleet UI 경로만 막는 UI-level 완화임을 이슈 비범위 절이 명시).
 * workspaceRoot === null 은 fail-closed(데스크톱 기본 — dialog 선택 경로만 유지·표면 확장 없음).
 */
export interface WorkspaceSetDeps {
  /** 허용 루트(FLEET_WORKSPACE_ROOT). null = 경로 설정 미지원. */
  workspaceRoot: string | null
  isRunActive(): boolean
  setWorkspace(dir: string): void
}

export function applyWorkspaceSet(deps: WorkspaceSetDeps, path: string): string {
  if (!deps.workspaceRoot) {
    throw new Error('워크스페이스 경로 설정이 지원되지 않습니다(FLEET_WORKSPACE_ROOT 미설정).')
  }
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('워크스페이스 경로가 비어 있습니다.')
  }
  if (deps.isRunActive()) {
    throw new Error('실행 진행 중에는 워크스페이스를 변경할 수 없습니다.')
  }
  const resolved = resolveWithin(deps.workspaceRoot, path.trim())
  if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`존재하는 디렉터리가 아닙니다: ${path}`)
  }
  deps.setWorkspace(resolved)
  return resolved
}

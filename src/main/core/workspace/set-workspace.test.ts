import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyWorkspaceSet, type WorkspaceSetDeps } from './set-workspace'

let root: string
let applied: string[]

function deps(over: Partial<WorkspaceSetDeps> = {}): WorkspaceSetDeps {
  return {
    workspaceRoot: root,
    isRunActive: () => false,
    setWorkspace: (dir) => applied.push(dir),
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-wsroot-'))
  mkdirSync(join(root, 'proj-a'))
  writeFileSync(join(root, 'file.txt'), 'x')
  applied = []
})

describe('applyWorkspaceSet(#197 B4)', () => {
  it('루트 하위 상대경로를 정준 절대경로로 적용·반환한다', () => {
    const r = applyWorkspaceSet(deps(), 'proj-a')
    expect(applied).toEqual([r])
    expect(r.toLowerCase()).toContain('proj-a')
  })

  it('루트 자기 자신("." )도 허용한다', () => {
    const r = applyWorkspaceSet(deps(), '.')
    expect(applied).toEqual([r])
  })

  it('루트 밖 절대경로 → throw(적용 없음)', () => {
    expect(() => applyWorkspaceSet(deps(), tmpdir())).toThrow(/밖/)
    expect(applied).toEqual([])
  })

  it('".." traversal → throw', () => {
    expect(() => applyWorkspaceSet(deps(), join('proj-a', '..', '..'))).toThrow()
    expect(applied).toEqual([])
  })

  it('미존재 경로 → throw', () => {
    expect(() => applyWorkspaceSet(deps(), 'nope')).toThrow(/디렉터리/)
  })

  it('디렉터리 아닌 파일 → throw', () => {
    expect(() => applyWorkspaceSet(deps(), 'file.txt')).toThrow(/디렉터리/)
  })

  it('런 진행 중 → 거부(경로 검증 이전)', () => {
    expect(() => applyWorkspaceSet(deps({ isRunActive: () => true }), 'proj-a')).toThrow(
      /실행 진행 중/,
    )
    expect(applied).toEqual([])
  })

  it('루트 밖을 가리키는 링크(junction) 경유 탈출 → throw (체크포인트 4 가드레일)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'fleet-outside-'))
    try {
      symlinkSync(outside, join(root, 'esc'), 'junction') // win 은 junction — 권한 불요
    } catch {
      return // 링크 생성 불가 환경 — resolveWithin 자체의 path-guard.test 가 탈출 차단을 커버(best-effort)
    }
    expect(() => applyWorkspaceSet(deps(), 'esc')).toThrow()
    expect(applied).toEqual([])
  })

  it('workspaceRoot 미설정(null) → fail-closed throw (데스크톱 기본)', () => {
    expect(() => applyWorkspaceSet(deps({ workspaceRoot: null }), 'proj-a')).toThrow(/미설정/)
  })

  it('빈/공백 경로 → throw', () => {
    expect(() => applyWorkspaceSet(deps(), '   ')).toThrow(/비어/)
  })
})

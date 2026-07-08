import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest, AppInfo, RunProjectRequest } from '../shared/types'
import { invokeChannels } from '../shared/transport/channels'
import { CHANNEL_FIXTURES } from '../shared/transport/fixtures'
import { createFleetEngine } from '../main/core/engine'
import { createIpcApprover } from '../main/core/safety/approval-bridge'
import { createHandlers } from './handlers'

const APP_INFO: AppInfo = {
  name: 'Fleet',
  version: '0.0.0-test',
  electron: '',
  node: process.versions.node,
  chrome: '',
  runtime: 'web',
}

function build(opts: { workspaceRoot?: string | null; isDraining?: () => boolean } = {}) {
  const sent: ApprovalRequest[] = []
  const approver = createIpcApprover({ send: (r) => sent.push(r), hasWindow: () => true })
  const engine = createFleetEngine({ approver: approver.approver })
  return {
    engine,
    approver,
    sent,
    handlers: createHandlers({
      engine,
      approver,
      appInfo: APP_INFO,
      workspaceRoot: opts.workspaceRoot ?? null,
      // 비옵셔널 계약(#216 C3 T2) — 기본 false(무회귀). 게이트 테스트가 () => true 로 덮는다.
      isDraining: opts.isDraining ?? (() => false),
    }),
  }
}

describe('서버 핸들러 테이블(#197 B3)', () => {
  it('테이블 키가 매니페스트 both invoke 와 정확히 일치한다(3면 parity 의 서버면)', () => {
    const { handlers } = build()
    expect(Object.keys(handlers).sort()).toEqual(invokeChannels('both'))
  })

  it('모든 both invoke 채널에 fixture 가 존재한다(직렬화 계약 커버리지 재확인)', () => {
    expect(Object.keys(CHANNEL_FIXTURES).sort()).toEqual(invokeChannels('both'))
  })

  it('draining=true → fleet:project:run 이 throw 하고 engine.runProjectFlow 를 호출하지 않는다(fail-closed)', () => {
    const { handlers, engine } = build({ isDraining: () => true })
    const spy = vi.spyOn(engine, 'runProjectFlow')
    const req: RunProjectRequest = { goal: '새 작업' }
    // 동기 throw(runProjectFlow 호출 이전) — dispatch catch 가 err frame 으로 변환·런 미시작.
    expect(() => handlers['fleet:project:run'](req)).toThrow(/서버 종료 중/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('draining=false → fleet:project:run 이 engine.runProjectFlow 에 위임한다', async () => {
    const { handlers, engine } = build({ isDraining: () => false })
    const spy = vi.spyOn(engine, 'runProjectFlow').mockRejectedValue(new Error('stub'))
    const req: RunProjectRequest = { goal: '새 작업' }
    await expect(handlers['fleet:project:run'](req)).rejects.toThrow('stub')
    expect(spy).toHaveBeenCalledWith(req)
  })

  it('app:info 가 runtime=web 을 스탬프한다', async () => {
    const { handlers } = build()
    await expect(Promise.resolve(handlers['fleet:app:info']())).resolves.toEqual(APP_INFO)
  })

  it('workspace:select 는 dialog 없이 현재 워크스페이스를 그대로 반환한다(취소 시맨틱)', async () => {
    const { handlers, engine } = build()
    expect(await handlers['fleet:workspace:select']()).toBeNull()
    engine.setWorkspace('C:/tmp/ws')
    expect(await handlers['fleet:workspace:select']()).toBe('C:/tmp/ws')
  })

  it('approval:respond 가 approver pending 을 해소한다', async () => {
    const { handlers, approver, sent } = build()
    const decision = approver.approver({
      id: 'appr-1',
      kind: 'shell',
      summary: 't',
      target: 'rm -rf /',
      risk: 'destructive',
      ts: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    expect(sent).toHaveLength(1)
    await handlers['fleet:approval:respond'](sent[0].id, true)
    await expect(decision).resolves.toEqual({ approved: true })
  })

  it('approval:pending 이 approver 의 미만료 대기 승인 스냅숏을 반환한다(#216 C1 재하이드레이션)', async () => {
    const { handlers, approver } = build()
    const req: ApprovalRequest = {
      id: 'p1',
      kind: 'shell',
      summary: 's',
      target: 'rm -rf /',
      risk: 'destructive',
      ts: Date.now(),
      expiresAt: Date.now() + 60_000,
    }
    void approver.approver(req) // hasWindow true → pending
    await expect(Promise.resolve(handlers['fleet:approval:pending']())).resolves.toEqual([req])
  })

  it('엔진 위임 대표 경로 — registerCli → session:list 왕복', async () => {
    const { handlers } = build()
    const desc = await handlers['fleet:session:registerCli']('claude', { stateful: true })
    expect(desc.id).toBe('cli:claude')
    const list = await handlers['fleet:session:list']()
    expect(list.map((s) => s.id)).toContain('cli:claude')
  })
})

describe('fleet:workspace:set(#197 B4)', () => {
  it('루트 하위 존재 디렉터리를 적용하고 정준 경로를 반환한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wsroot-'))
    mkdirSync(join(root, 'proj-a'))
    const { handlers, engine } = build({ workspaceRoot: root })
    const applied = await handlers['fleet:workspace:set']('proj-a')
    expect(engine.getWorkspace()).toBe(applied)
    expect(applied.toLowerCase()).toContain('proj-a')
  })

  it('루트 밖 경로는 거부한다(워크스페이스 무변경)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-wsroot-'))
    const { handlers, engine } = build({ workspaceRoot: root })
    // applyWorkspaceSet 은 동기 throw — async IIFE 로 rejection 정규화(연산 자체가 throw 하면
    // Promise.resolve(...) 인자 평가 중 throw 돼 rejects 단언이 성립하지 않는다).
    await expect((async () => handlers['fleet:workspace:set'](tmpdir()))()).rejects.toThrow()
    expect(engine.getWorkspace()).toBeNull()
  })

  it('workspaceRoot 미설정 서버는 fail-closed', async () => {
    const { handlers } = build({ workspaceRoot: null })
    await expect((async () => handlers['fleet:workspace:set']('x'))()).rejects.toThrow(/미설정/)
  })
})

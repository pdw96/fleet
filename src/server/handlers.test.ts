import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, AppInfo } from '../shared/types'
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

function build() {
  const sent: ApprovalRequest[] = []
  const approver = createIpcApprover({ send: (r) => sent.push(r), hasWindow: () => true })
  const engine = createFleetEngine({ approver: approver.approver })
  return {
    engine,
    approver,
    sent,
    handlers: createHandlers({ engine, approver, appInfo: APP_INFO }),
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
    })
    expect(sent).toHaveLength(1)
    await handlers['fleet:approval:respond'](sent[0].id, true)
    await expect(decision).resolves.toBe(true)
  })

  it('엔진 위임 대표 경로 — registerCli → session:list 왕복', async () => {
    const { handlers } = build()
    const desc = await handlers['fleet:session:registerCli']('claude', { stateful: true })
    expect(desc.id).toBe('cli:claude')
    const list = await handlers['fleet:session:list']()
    expect(list.map((s) => s.id)).toContain('cli:claude')
  })
})

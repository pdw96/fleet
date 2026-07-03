import { describe, expect, it } from 'vitest'
import { CHANNELS, invokeChannels, pushChannels } from './channels'

/**
 * 채널 매니페스트 구조 단언(#197 B2). 매니페스트는 preload/main 리터럴에서 파생된 3자 공유
 * 데이터 선언이다 — preload 와의 실제 표류 검출은 `bridge-parity.test.ts` 가 담당하고, 여기서는
 * 매니페스트 자체의 형태 불변식과 scope 분류(both↔desktop)만 핀한다.
 */
describe('전송 채널 매니페스트', () => {
  it('모든 채널명은 fleet: 네임스페이스를 쓴다', () => {
    const names = Object.keys(CHANNELS)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => !n.startsWith('fleet:'))).toEqual([])
  })

  it('모든 선언은 kind∈{invoke,push}·scope∈{both,desktop} 이다', () => {
    for (const [name, decl] of Object.entries(CHANNELS)) {
      expect(['invoke', 'push'], name).toContain(decl.kind)
      expect(['both', 'desktop'], name).toContain(decl.scope)
    }
  })

  it('핵심 채널의 kind·scope 분류가 정확하다', () => {
    // 오케스트레이션 코어(서버가 B3 에서 핸들) = both invoke.
    expect(CHANNELS['fleet:app:info']).toEqual({ kind: 'invoke', scope: 'both' })
    expect(CHANNELS['fleet:project:run']).toEqual({ kind: 'invoke', scope: 'both' })
    // 자동 업데이트 = Electron 전용(서버 미등록·웹 스텁) = desktop invoke.
    expect(CHANNELS['fleet:update:getState']).toEqual({ kind: 'invoke', scope: 'desktop' })
    expect(CHANNELS['fleet:update:setChannel']).toEqual({ kind: 'invoke', scope: 'desktop' })
    // 라이브 푸시 스트림 = both push, update 이벤트만 desktop push.
    expect(CHANNELS['fleet:orchestrator:event']).toEqual({ kind: 'push', scope: 'both' })
    expect(CHANNELS['fleet:update:event']).toEqual({ kind: 'push', scope: 'desktop' })
  })

  it('invokeChannels(desktop) 는 자동 업데이트 7채널이 전부다', () => {
    expect(invokeChannels('desktop')).toEqual([
      'fleet:update:check',
      'fleet:update:dismiss',
      'fleet:update:download',
      'fleet:update:getChannel',
      'fleet:update:getState',
      'fleet:update:install',
      'fleet:update:setChannel',
    ])
  })

  it('pushChannels(desktop) 는 update 이벤트 하나뿐이다', () => {
    expect(pushChannels('desktop')).toEqual(['fleet:update:event'])
  })

  it('invokeChannels()/pushChannels() 는 both+desktop 합집합이며 서로 배타적이다', () => {
    const inv = invokeChannels()
    const push = pushChannels()
    // 합집합 = 전체 채널.
    expect([...inv, ...push].sort()).toEqual(Object.keys(CHANNELS).sort())
    // invoke 와 push 는 겹치지 않는다.
    expect(inv.filter((c) => push.includes(c))).toEqual([])
    // both+desktop 분할이 kind 전체를 덮는다.
    expect([...invokeChannels('both'), ...invokeChannels('desktop')].sort()).toEqual(
      [...inv].sort(),
    )
  })

  it('결과는 정렬돼 결정론적이다', () => {
    const inv = invokeChannels()
    expect(inv).toEqual([...inv].sort())
  })
})

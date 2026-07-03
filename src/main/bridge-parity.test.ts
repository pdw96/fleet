import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { invokeChannels, pushChannels } from '../shared/transport/channels'

/**
 * 브리지 채널 매니페스트 3면 패리티(#197 B2). 채널 문자열은 세 곳에 흩어진 리터럴이라 타입체커가
 * 대조하지 못한다 — 매니페스트(단일 출처)를 preload(데스크톱)·ws-bridge(웹) 리터럴과 소스 텍스트로
 * 맞대어 표류를 컴파일타임 가까이로 끌어온다. server 핸들러 테이블(B3)↔매니페스트 대조는 B3 몫.
 *
 * (소스 텍스트 스크레이핑이라 node:fs 를 쓴다 → ipc-parity.test.ts 와 동형으로 src/main 에 둔다.
 *  src/shared 는 web tsconfig[DOM·no-node]에도 포함돼 node API 테스트를 못 담는다.)
 *
 * 검사 면:
 *  - 매니페스트 전체 invoke/push  ↔ preload `ipcRenderer.invoke/on` (데스크톱 = 전 채널 핸들)
 *  - 매니페스트 both invoke/push  ↔ ws-bridge `invoke/subscribe` (웹 = desktop 전용은 로컬 스텁)
 *  - 데스크톱 app:info 가 `runtime:'electron'` 을 스탬프(AppInfo.runtime 계약)
 *
 * 전제: 세 파일 모두 채널을 리터럴로 쓴다(변수/템플릿 금지). ipc-parity.test.ts 와 동형 전략.
 */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
}

const preloadSrc = read('../preload/index.ts')
const wsBridgeSrc = read('../renderer/bridge/ws-bridge.ts')
const mainSrc = read('./index.ts')

function literals(src: string, re: RegExp): string[] {
  return [...new Set([...src.matchAll(re)].map((m) => m[1]))].sort()
}

// preload: ipcRenderer.invoke('ch') / ipcRenderer.on('ch')
const preloadInvoke = literals(preloadSrc, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)
const preloadSubscribe = literals(preloadSrc, /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g)
// ws-bridge: invoke<T>('ch') / subscribe('ch') — 제네릭(<...>)은 선택.
const wsInvoke = literals(wsBridgeSrc, /\binvoke(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)
const wsSubscribe = literals(wsBridgeSrc, /\bsubscribe\(\s*['"]([^'"]+)['"]/g)

describe('매니페스트 ↔ preload 패리티 (데스크톱 = 전 채널)', () => {
  it('매니페스트 invoke 채널이 preload invoke 와 정확히 일치한다', () => {
    expect(invokeChannels()).toEqual(preloadInvoke)
  })

  it('매니페스트 push 채널이 preload on 구독과 정확히 일치한다', () => {
    expect(pushChannels()).toEqual(preloadSubscribe)
  })
})

describe('매니페스트 both ↔ ws-bridge 패리티 (웹 = desktop 전용은 스텁)', () => {
  it('ws-bridge 가 invoke 하는 채널이 매니페스트 both invoke 와 정확히 일치한다', () => {
    expect(wsInvoke).toEqual(invokeChannels('both'))
  })

  it('ws-bridge 가 subscribe 하는 채널이 매니페스트 both push 와 정확히 일치한다', () => {
    expect(wsSubscribe).toEqual(pushChannels('both'))
  })

  it('ws-bridge 는 desktop 전용(update) 채널을 wire 로 invoke/subscribe 하지 않는다', () => {
    for (const ch of invokeChannels('desktop')) expect(wsInvoke).not.toContain(ch)
    for (const ch of pushChannels('desktop')) expect(wsSubscribe).not.toContain(ch)
  })
})

describe('AppInfo.runtime 스탬프', () => {
  it('데스크톱 app:info 핸들러가 runtime:electron 을 스탬프한다', () => {
    expect(mainSrc).toMatch(/runtime:\s*'electron'/)
  })
})

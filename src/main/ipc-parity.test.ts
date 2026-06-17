import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * IPC 채널 문자열 정적 패리티 가드.
 *
 * preload(`window.fleet`)와 main(`registerIpc`)은 `'fleet:*'` 채널 문자열로만 연결되는데, 이 문자열은
 * 타입체커가 검증하지 못한다(양쪽에 박힌 리터럴이라 한쪽만 바꿔도 컴파일은 통과 — 런타임에 호출이 조용히
 * 멈출 뿐). 이 테스트는 두 파일의 소스를 읽어 채널 집합이 정확히 일치하는지 단언해 그 표류를 컴파일 타임
 * 가까이로 끌어온다. (소스를 import 하지 않고 텍스트로 읽는 이유: 두 모듈은 import 시 electron 부수효과를
 * 일으키고 채널은 `registerIpc()` 클로저 안에서만 등록돼, 정적 텍스트 추출이 더 가볍고 안전하다.)
 *
 * 검사 차원:
 * - 요청/응답: preload `ipcRenderer.invoke(ch)` ↔ main `ipcMain.handle(ch)`
 * - 푸시:      preload `ipcRenderer.on(ch)`     ↔ main `webContents.send(ch)`
 * - 구독 해제: preload `ipcRenderer.on(ch)`     ↔ preload `ipcRenderer.removeListener(ch)` (리스너 누수 방지)
 *
 * 비범위(의도적): preload 메서드명 ↔ `FleetBridge` 키 패리티는 tsc 가 `const api: FleetBridge = {…}` 로 이미
 * 강제하므로 여기서 다시 검사하지 않는다.
 *
 * 전제: 채널은 항상 리터럴 문자열로 쓴다(변수/템플릿/상수 보간 금지). 이 전제 위반은 '호출 부위 수 == 리터럴
 * 추출 수' 단언으로 잡는다 — 비리터럴 호출이 추출에서 조용히 빠지면 카운트가 어긋나 RED.
 */

/** 블록/라인 주석 제거 — 주석에 박힌 예시 호출이 라이브 채널로 오인되는 것 방지(`://` URL 은 보존). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const preloadSrc = stripComments(
  readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8'),
)
const mainSrc = stripComments(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'))

// 하드코딩 리터럴 정규식(ReDoS 무관 — `[^'"]+` 단일 문자클래스). `\s*` 로 멀티라인 `call(\n  'ch'` 도 잡는다.
const INVOKE_RE = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g
const HANDLE_RE = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g
const ON_RE = /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g
const REMOVE_RE = /ipcRenderer\.removeListener\(\s*['"]([^'"]+)['"]/g
const SEND_RE = /webContents\.send\(\s*['"]([^'"]+)['"]/g

// 호출 부위 자체(리터럴 여부 무관) — 리터럴 추출 수와 비교해 비리터럴 채널이 숨었는지 검출.
const INVOKE_CALL = /ipcRenderer\.invoke\(/g
const HANDLE_CALL = /ipcMain\.handle\(/g

/** 소스에서 채널 리터럴을 중복 제거·정렬해 뽑는다. */
function channels(src: string, re: RegExp): string[] {
  return [...new Set([...src.matchAll(re)].map((m) => m[1]))].sort()
}

/** 매칭 개수(중복 포함). */
function count(src: string, re: RegExp): number {
  return [...src.matchAll(re)].length
}

const invoke = channels(preloadSrc, INVOKE_RE)
const handle = channels(mainSrc, HANDLE_RE)
const subscribe = channels(preloadSrc, ON_RE)
const unsubscribe = channels(preloadSrc, REMOVE_RE)
const send = channels(mainSrc, SEND_RE)

describe('IPC 채널 패리티 (preload ↔ main)', () => {
  it('preload invoke 채널과 main handle 핸들러가 정확히 일치한다', () => {
    expect(invoke).toEqual(handle)
  })

  it('preload on 구독과 main webContents.send 발행 채널이 정확히 일치한다', () => {
    expect(subscribe).toEqual(send)
  })

  it('preload on 구독과 removeListener 해제 채널이 일치한다 (오타 시 리스너 누수)', () => {
    expect(unsubscribe).toEqual(subscribe)
  })

  it('모든 채널은 fleet: 네임스페이스를 쓰며 비어 있지 않다', () => {
    const all = [...invoke, ...subscribe]
    expect(all.length).toBeGreaterThan(0)
    expect(all.filter((c) => !c.startsWith('fleet:'))).toEqual([])
  })

  it('모든 invoke/handle 호출이 리터럴 채널이다 (비리터럴이면 추출에서 누락 → 카운트 불일치)', () => {
    // 리터럴 추출 수(중복 포함)가 호출 부위 수와 같아야 한다. 템플릿/상수로 바뀌면 어긋나 RED.
    expect(count(preloadSrc, INVOKE_RE)).toBe(count(preloadSrc, INVOKE_CALL))
    expect(count(mainSrc, HANDLE_RE)).toBe(count(mainSrc, HANDLE_CALL))
  })

  it('주석에 박힌 예시 호출은 채널로 집계하지 않는다 (stripComments 회귀)', () => {
    const sample =
      "// ipcRenderer.invoke('fleet:commented:out')\n/* ipcMain.handle('fleet:block', fn) */"
    const cleaned = stripComments(sample)
    expect(channels(cleaned, INVOKE_RE)).toEqual([])
    expect(channels(cleaned, HANDLE_RE)).toEqual([])
  })
})

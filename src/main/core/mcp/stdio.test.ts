import { describe, expect, it } from 'vitest'
import { createStdioTransport } from './stdio'
import type { McpChild } from './types'

/** 테스트용 fake child — 쓰기 캡처·stdout 청크 주입·종료 발사. */
function fakeChild() {
  let out: (chunk: string) => void = () => {}
  let close: (err?: Error) => void = () => {}
  const writes: string[] = []
  const child: McpChild = {
    write: (l) => writes.push(l),
    onStdout: (h) => {
      out = h
    },
    onClose: (h) => {
      close = h
    },
    kill: () => close(),
  }
  return { child, writes, emit: (c: string) => out(c), end: (e?: Error) => close(e) }
}

const spec = { name: 's', command: 'c' }

describe('createStdioTransport', () => {
  it('개행 구분 JSON 을 프레이밍하고 부분 청크를 버퍼링한다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    const msgs: Record<string, unknown>[] = []
    t.onMessage((m) => msgs.push(m))
    f.emit('{"jsonrpc":"2.0","id":1,') // 부분
    expect(msgs).toHaveLength(0)
    f.emit('"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{"a":1}}\n')
    expect(msgs).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: { a: 1 } },
    ])
  })

  it('send 는 개행을 붙여 직렬화한다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    t.send({ jsonrpc: '2.0', id: 1, method: 'x' })
    expect(f.writes).toEqual(['{"jsonrpc":"2.0","id":1,"method":"x"}\n'])
  })

  it('잘못된 JSON 라인은 건너뛰고 연결을 깨지 않는다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    const msgs: Record<string, unknown>[] = []
    t.onMessage((m) => msgs.push(m))
    f.emit('garbage\n{"id":1,"result":{}}\n')
    expect(msgs).toEqual([{ id: 1, result: {} }])
  })

  it('자식 종료를 onClose 로 전파한다', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    let err: Error | undefined | 'none' = 'none'
    t.onClose((e) => {
      err = e
    })
    f.end(new Error('dead'))
    expect((err as unknown as Error)?.message).toBe('dead')
  })

  it('close() 가 onClose 를 통지한다(진행 중 요청을 즉시 종료하도록)', () => {
    const f = fakeChild()
    const t = createStdioTransport(spec, () => f.child)
    let notified = 0
    t.onClose(() => {
      notified += 1
    })
    t.close()
    expect(notified).toBe(1) // close() 가 closeHandler 를 정확히 1회 호출(타임아웃 매달림 방지)
  })
})

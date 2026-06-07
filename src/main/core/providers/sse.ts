/**
 * 바이트 스트림(fetch body)을 SSE `data:` 페이로드(문자열) 단위로 yield 한다.
 * `event:`/주석/빈 줄은 무시하고, 종료 신호 `[DONE]` 도 거른다. 멀티바이트(UTF-8) 경계가
 * 청크 중간에서 끊겨도 TextDecoder(stream) 로 안전하게 이어 붙인다.
 */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buf = ''
  const flush = function* (line: string): Generator<string> {
    const trimmed = line.trimEnd()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (data && data !== '[DONE]') yield data
  }
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true })
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      yield* flush(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  }
  buf += decoder.decode()
  yield* flush(buf) // 마지막 개행 없는 잔여 라인
}

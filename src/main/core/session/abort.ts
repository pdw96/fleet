/**
 * signal 이 abort 되면 그 reason 으로 즉시 거부하고, 아니면 p 의 정착(resolve/reject)을 그대로 따른다.
 *
 * 세션(api/cli)의 직렬화 체인은 `await prior` 로 같은 세션의 동시 send 순서를 보장하는데, 그 대기 중에는
 * 아직 provider/runner 가 signal 을 관측하지 못해 '큐 대기 중인' send 의 취소(cancelChat/cancelRun)가
 * prior 완료까지 지연됐다(Codex P2 — 방이 계속 busy). 이 래퍼는 호출자에게 돌려줄 promise 만 abort 와
 * race 시켜 즉시 거부를 보장한다. 체인 순서(직렬화)는 호출부가 별도 링크(`await prior` 후 throwIfAborted)로
 * 독립 보존하므로, 큐 대기 중 취소된 send 는 실제 provider/runner 호출 없이 건너뛰며 다음 send 의 순서도
 * 깨지지 않는다. signal 미지정이면 p 를 그대로 반환한다(무회귀).
 */
export function settleOrAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    // p 의 정착으로 race 를 마무리하고, 어느 쪽이 이기든 리스너를 떼어 누수를 막는다.
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * abort 사유를 Error 로 정규화한다. AbortController.abort() 는 기본적으로 DOMException(AbortError, Error
 * 하위)을 reason 으로 설정하지만 임의 값으로 abort(reason) 할 수도 있어(타입상 any) 비-Error 사유를 방어한다.
 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : '작업이 취소되었습니다')
}

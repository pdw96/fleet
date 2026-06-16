/**
 * 세션(api/cli)의 직렬화 체인은 `await prior` 로 같은 세션의 동시 send 순서를 보장하는데, 그 '큐 대기'
 * 단계에서는 아직 provider/runner 가 signal 을 관측하지 못해 큐잉된 send 의 취소가 prior 완료까지
 * 지연됐다(Codex P2 — 방이 계속 busy). 이 래퍼는 호출자에게 돌려줄 promise 가 **큐 대기 중에만**
 * abort 와 race 해 즉시 거부하도록 한다.
 *
 * 단, `isStarted()` 가 true 가 된 뒤(=실제 provider/runner 호출이 시작된 뒤)의 abort 는 가로채지 않고
 * p 의 정착을 그대로 따른다 — 실행 중 취소는 provider/runner 의 signal 처리에 맡겨야 하기 때문이다.
 * 특히 편집(workspace) CLI 의 defaultRunner 는 abort 시 즉시 거부하지 않고 killTree/stream-close 까지
 * 기다린 뒤 정착해, 호출자(오케스트레이터)의 후속 revert 가 살아있는 자식 프로세스와 경합하지 않게
 * 보장한다(Codex P1). 이 단계에서 조기 거부하면 그 revert-안전성 불변식이 깨진다.
 *
 * 체인 순서(직렬화)는 호출부가 별도 링크(`await prior` → `throwIfAborted` → started=true → 실제 호출)로
 * 독립 보존하므로, 큐 대기 중 취소된 send 는 실제 호출 없이 건너뛰고 다음 send 순서도 안 깨진다.
 * signal 미지정이면 p 를 그대로 반환한다(무회귀).
 */
export function settleOrAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, isStarted: () => boolean): Promise<T> {
  if (!signal) return p
  // 진입 시점(아직 실행 전)에 이미 abort 됐으면 즉시 거부 — 큐 대기조차 시작하지 않는다.
  if (signal.aborted && !isStarted()) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    // 큐 대기 중(아직 미시작)의 abort 만 조기 거부한다. 실행 시작 후의 abort 는 무시하고 p(=runner/provider)
    // 의 정착을 따른다(프로세스 종료-후-정착 보장 보존).
    const onAbort = (): void => {
      if (!isStarted()) reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
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

/**
 * 여러 AbortSignal 을 합성한다 — 하나라도 abort 되면 합성 signal 도 abort 된다. 0개면 undefined,
 * 1개면 그대로 반환, 2개 이상이면 AbortSignal.any(Node 20+). 호출자 자체 signal 과 방/실행 취소
 * 컨트롤러를 함께 honor 하기 위해 쓴다(둘 중 하나만 넘기면 합성 비용 없이 그대로 통과).
 */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  return AbortSignal.any(present)
}

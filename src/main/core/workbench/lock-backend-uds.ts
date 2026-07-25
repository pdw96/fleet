import { createServer } from 'node:net'

import type { BindOutcome, BoundEndpoint, LockBackend } from './locks'

/**
 * 실 락 백엔드 — Linux **추상 유닉스 소켓**(#251 PR1b T3 · 스펙 §W-3).
 *
 * **의도적으로 얇다.** 이 파일의 모든 실행 행은 Linux 에서만 도달하므로 개발자 win32 로컬 커버리지의
 * 분모에만 들어간다(§3.1 대응 ⓐ). 판정·서열·리스 계약은 전부 `locks.ts` 에 있고 페이크로 양 OS 에서
 * 돌기 때문에, 여기 남는 것은 **커널 프리미티브 호출과 errno 매핑뿐**이어야 한다.
 *
 * 실측 근거(Docker · Node 22.22.3 / 24.18 양쪽 동일):
 *   - `listen({path:'\0name'})` 성공 → 배타 보유. 같은 이름 재bind = `EADDRINUSE`
 *   - 소유자 SIGKILL → **즉시** 재획득 성공(회수 프로토콜 불요 · 커널이 회수한다)
 *   - 파일시스템에 아무 항목도 만들지 않는다 → 어디를 지워도 보유가 영향받지 않는다
 *   - `unref()` 후에도 배타성 유지 · `close()` 는 fd 를 동기 해제(`listening` 즉시 false)
 *   - `close(cb)` 의 **cb 는 커넥션이 남아 있으면 발화하지 않는다** → 기다리면 안 된다
 */
export function createAbstractSocketBackend(): LockBackend {
  return {
    kind: 'uds-abstract',
    bind: (endpoint: string): Promise<BindOutcome> =>
      new Promise<BindOutcome>((resolve) => {
        const server = createServer()

        // 아무 프로세스나 이 endpoint 에 connect 할 수 있다(추상 네임스페이스엔 파일 권한이 없다).
        // 수락된 소켓을 남기면 이벤트 루프를 ref 해 종료가 지연되고 `close()` 의 'close' 도 막힌다.
        server.on('connection', (socket) => socket.destroy())

        // ⚠ 리스너를 `listen()` **호출 전에 동기 부착**한다. bind 결과는 동기 throw 가 아니라
        // `process.nextTick` 의 'error'/'listening' 이벤트로 오고(`setupListenHandle`), 그 사이에
        // 'error' 리스너가 없으면 **unhandled 'error' 로 프로세스가 죽는다**.
        //
        // ⚠ `once` 가 아니라 `on` 이다. 락 서버는 해제될 때까지 **장수**하므로 bind 성공 이후에도
        // 런타임 오류가 올 수 있는데, `once` 면 그때 리스너가 0개라 **프로세스가 죽는다**(EventEmitter
        // 의 'error' 규약). Promise 는 한 번만 해소되므로(이후 resolve 는 무시) 사후 오류는 판정을
        // 바꾸지 않는다 — 보유 여부의 권위는 어디까지나 `server.listening` 이다.
        server.on('error', (err: NodeJS.ErrnoException) => {
          // ⚠ bind **성공 이후**의 런타임 오류에서는 Node 가 서버를 자동으로 닫지 않는다 — 그대로 두면
          // `server.listening` 이 true 로 남아 `isBound()` 가 **쓸 수 없는 소켓을 `owned` 로** 답한다
          // (CodeRabbit PR#259). 판정 근거를 함께 정리해 fail-closed 방향을 유지한다.
          if (server.listening) server.close()
          // EADDRINUSE 만이 「소유자 생존」이다. 그 외 전부 fail-closed — 미지 errno 를 성공으로 읽지 않는다.
          resolve(
            err.code === 'EADDRINUSE'
              ? { status: 'in-use' }
              : { status: 'error', code: err.code, detail: err.message },
          )
        })

        server.once('listening', () => {
          // 락 보유가 프로세스 종료를 막지 않게 한다 — unref 해도 커널 bind 배타성은 유지된다(실측).
          server.unref()
          resolve({
            status: 'bound',
            endpoint: {
              name: endpoint,
              /**
               * `server.listening` 은 `!!server._handle` 이라 **syscall·디스크 I/O 0** 이고 `close()`
               * 호출 즉시 false 가 된다(L-6 의 「로컬 불리언」 요건).
               * ⚠ `server.address()` 를 **쓰지 않는다** — 그것은 `listen()` 인자의 에코(`_pipeName`)이며
               * `close()` 후에도 남으므로 보유·생존 판정 근거가 될 수 없다(실측).
               */
              isBound: () => server.listening,
              // 'close' 이벤트를 기다리지 않는다(위 실측 — 커넥션이 있으면 영구 미발화).
              close: () => void server.close(),
            } satisfies BoundEndpoint,
          })
        })

        try {
          server.listen({ path: endpoint })
        } catch (err) {
          // 상위(`endpointFor`)가 문법·예산을 이미 걸렀으므로 여기 오면 예상 밖이다 — 삼키지 않고 값으로 보고한다.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 이 룰의 목적은 브랜드 크레덴셜 위조 차단이며, 캐스트를 리뷰에 보이게 만드는 것 자체가 요구사항이다.
          const e = err as NodeJS.ErrnoException
          resolve({ status: 'error', code: e.code, detail: e.message ?? String(err) })
        }
      }),
  }
}

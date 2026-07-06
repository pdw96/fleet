import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * boot→engine childEnv 시임의 **결정론적** 회귀 가드(#197-B6 적대리뷰 CONFIRMED#4).
 *
 * B6 최상위 완료조건("서버 시크릿 FLEET_* 자식 미전달")의 프로덕션 경로는 boot.ts 가 createFleetEngine 에
 * childEnv 를 주입하는 단 한 줄에 달려 있다. 그 줄이 삭제되면 typecheck·전 기존 테스트가 GREEN 인 채 서버
 * 모드에서 자식이 FLEET_* 를 재상속한다(P1 유출 재발). 여기서는 createFleetEngine 을 **실 구현에 위임하되
 * 전달 opts 를 캡처하는 스파이**로 감싸(실 MCP spawn·승인·타이밍 없이) boot 이 FLEET_* 를 제거하는 childEnv 를
 * 엔진에 넘겼는지 직접 단언한다. (env 격리 자체는 child-env.test·detect(T1)·factory 실-spawn 테스트가 검증.)
 *
 * vi.mock 이 이 파일의 engine import 를 스파이로 대체하므로 boot 전용 파일로 격리했다(boot.test.ts 무영향).
 */
const captured = vi.hoisted(() => ({ opts: undefined as unknown }))

vi.mock('../main/core/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/core/engine')>()
  return {
    ...actual,
    createFleetEngine: (opts: Parameters<typeof actual.createFleetEngine>[0] = {}) => {
      captured.opts = opts
      return actual.createFleetEngine(opts)
    },
  }
})

import { bootServer } from './boot'

interface ChildEnvLike {
  base(): NodeJS.ProcessEnv
  cliSession(): NodeJS.ProcessEnv
}

describe('boot→engine childEnv 시임(#197-B6 CONFIRMED#4)', () => {
  it('boot 이 FLEET_* 를 제거하는 childEnv 를 엔진에 주입한다', async () => {
    const server = await bootServer({
      FLEET_PORT: '0',
      FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-seam-data-')),
      FLEET_SECRET_KEY: 'seam-server-secret', // 자식이 상속하면 base/cliSession 에서 보임 — 격리되면 부재
      FLEET_E2E: '1',
    })
    try {
      const opts = captured.opts as { childEnv?: ChildEnvLike } | undefined
      // (1) 시임 존재 — boot.ts 의 childEnv 주입 라인이 살아있다.
      expect(opts?.childEnv).toBeDefined()
      const childEnv = opts!.childEnv!
      // (2) 그 childEnv 가 서버 시크릿(FLEET_*)을 자식 base·cliSession 양쪽에서 제거한다.
      expect(childEnv.base().FLEET_SECRET_KEY).toBeUndefined()
      expect(childEnv.cliSession().FLEET_SECRET_KEY).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CliRegistry } from '../main/core/cli/registry'
import type { CliAdapter } from '../shared/types'

/**
 * boot→engine 샌드박스 경계 주입 시임의 **결정론적** 회귀 가드(#214 C3 · childenv-seam 동형).
 *
 * "컨테이너 = 유일 샌드박스 경계" posture 의 프로덕션 경로는 boot.ts 가 `FLEET_SANDBOX_BOUNDARY=container`
 * 일 때 container variant registry 를 createFleetEngine 에 주입하는 단 한 줄이다. 그 줄이 삭제되면
 * typecheck·전 기존 테스트가 GREEN 인 채 컨테이너에서 codex 가 다시 bwrap(user namespace)로 깨진다
 * (#214 원증상 재발·무신호). 여기서는 createFleetEngine 을 실 구현에 위임하되 전달 opts 를 캡처하는
 * 스파이로 감싸, boot 이 경계값에 따라 올바른 registry 를 (또는 undefined 를) 넘겼는지 직접 단언한다.
 * (variant args 자체는 registry.test 가 exact 핀 · 미지값 loud fail 은 boot.test 가 커버 — 여기선 중복 금지.)
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

const bootWith = (boundary?: string) =>
  bootServer({
    FLEET_PORT: '0',
    FLEET_DATA_DIR: mkdtempSync(join(tmpdir(), 'fleet-sbx-seam-')),
    FLEET_E2E: '1',
    ...(boundary === undefined ? {} : { FLEET_SANDBOX_BOUNDARY: boundary }),
  })

const capturedRegistry = (): CliRegistry | undefined =>
  (captured.opts as { cliRegistry?: CliRegistry } | undefined)?.cliRegistry

describe('boot→engine 샌드박스 경계 주입 시임(#214 C3)', () => {
  it("'container' → container variant registry 주입(codex danger-full-access·skip·claude 무변경)", async () => {
    const server = await bootWith('container')
    try {
      const reg = capturedRegistry()
      expect(reg).toBeDefined() // 주입 라인 생존
      const codex = reg!.get('codex')!
      expect(codex.headless?.args).toContain('danger-full-access')
      expect(codex.headless?.args).not.toContain('read-only')
      expect(codex.edit?.args).toContain('--skip-git-repo-check')
      expect(codex.session?.resumeArgs).toContain('sandbox_mode="danger-full-access"')
      // claude 무조정 — 기본 acceptEdits 그대로(단일 posture 가 다른 CLI 를 오염시키지 않는다).
      expect(reg!.get('claude')?.edit?.args).toEqual(['-p', '--permission-mode', 'acceptEdits'])
    } finally {
      await server.close()
    }
  })

  it('미설정 → cliRegistry 미전달(undefined · 기본 시드 경로 바이트 동일)', async () => {
    const server = await bootWith(undefined)
    try {
      expect(capturedRegistry()).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it("'cli' 명시 → 미설정과 등가(undefined)", async () => {
    const server = await bootWith('cli')
    try {
      expect(capturedRegistry()).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('runtime register() 비변환 — container 시드 registry 에 등록한 어댑터는 변형 없이 그대로 반환', async () => {
    const server = await bootWith('container')
    try {
      const reg = capturedRegistry()!
      const custom: CliAdapter = {
        id: 'custom-probe',
        displayName: 'Custom',
        command: 'custom',
        versionArgs: ['--version'],
        // codex 가 아니라도(그리고 codex 유사 args 라도) 런타임 등록분은 posture 변환 대상이 아니다.
        edit: { args: ['exec', '-s', 'workspace-write'], parse: 'text' },
      }
      reg.register(custom)
      expect(reg.get('custom-probe')).toBe(custom) // 동일 참조 — 변환 없음(주입 시점 시드만 변환)
    } finally {
      await server.close()
    }
  })
})

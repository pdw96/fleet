import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { isLinkSync } from './path-guard'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-pg-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isLinkSync', () => {
  it('일반 파일 → regular', () => {
    writeFileSync(join(root, 'a.txt'), 'x')
    expect(isLinkSync(join(root, 'a.txt'))).toBe('regular')
  })
  it('디렉터리 → dir', () => {
    mkdirSync(join(root, 'd'))
    expect(isLinkSync(join(root, 'd'))).toBe('dir')
  })
  it('미존재 → missing', () => {
    expect(isLinkSync(join(root, 'nope'))).toBe('missing')
  })
  // [#128-B2] best-effort 테스트 — vitest ESM 환경에서 node: 빌트인 named export 는
  // non-configurable(Object.defineProperty 금지)이라 vi.spyOn(fs, 'lstatSync') 가
  // "Cannot redefine property" 로 실패할 수 있다.
  // namespace import(`import * as fs`)는 spy 시도를 위해 의도적으로 유지한다(B1 m4 교훈).
  // spy 성공 환경에서는 완전히 검증되고, 실패 환경에서는 skip.
  it('lstat EINVAL/UNKNOWN(exotic reparse) → suspicious(fail-closed)', () => {
    const err = Object.assign(new Error('einval'), { code: 'EINVAL' })
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      spy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
        throw err
      })
    } catch {
      // ESM non-configurable: spy 미동작 — best-effort skip
      return
    }
    try {
      expect(isLinkSync(join(root, 'whatever'))).toBe('suspicious')
    } finally {
      spy?.mockRestore()
    }
  })
  it('FIFO 등 비정형(non-regular)은 suspicious', () => {
    if (process.platform === 'win32') return // mkfifo 불가
    const p = join(root, 'pipe.dat')
    execFileSync('mkfifo', [p])
    expect(isLinkSync(p)).toBe('suspicious')
  })
})

describe.skipIf(process.platform === 'win32')('isLinkSync (POSIX symlink)', () => {
  it('symlink → link', () => {
    writeFileSync(join(root, 'target.txt'), 'x')
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'))
    expect(isLinkSync(join(root, 'link.txt'))).toBe('link')
  })
})

describe.skipIf(process.platform !== 'win32')('isLinkSync (Windows junction)', () => {
  it('junction → link', () => {
    mkdirSync(join(root, 'realdir'))
    symlinkSync(join(root, 'realdir'), join(root, 'jdir'), 'junction')
    expect(isLinkSync(join(root, 'jdir'))).toBe('link')
  })
})

import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { mkdir as fsMkdir, readFile as fsReadFile, rm as fsRm, writeFile as fsWriteFile } from 'node:fs/promises'
import type { ApprovalGate } from '../safety/approval'
import { classifyFileRisk } from '../safety/approval'

/** 주입 가능한 최소 파일시스템 (테스트에서 in-memory mock). */
export interface FsLike {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  rm(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

const nodeFs: FsLike = {
  readFile: (p) => fsReadFile(p, 'utf8'),
  writeFile: (p, c) => fsWriteFile(p, c, 'utf8'),
  rm: (p) => fsRm(p, { force: true, recursive: true }),
  mkdir: async (p) => {
    await fsMkdir(p, { recursive: true })
  },
}

export interface FileOpsDeps {
  /** 모든 경로는 이 root 안으로 제한된다 (path traversal 차단). */
  root: string
  gate: ApprovalGate
  fs?: FsLike
  onEvent?: (type: string, data: Record<string, unknown>) => void
}

export interface FileOpResult {
  ok: boolean
  path: string
  reason?: string
  content?: string
}

/**
 * 프로젝트 파일 작업 (요구사항 6). 쓰기/삭제는 승인 게이트를 통과해야 하며,
 * 모든 작업은 root 안으로 제한되고 감사 이벤트를 남긴다.
 */
export function createFileOps(deps: FileOpsDeps) {
  const fs = deps.fs ?? nodeFs
  const root = resolve(deps.root)
  const log = (type: string, data: Record<string, unknown>): void => deps.onEvent?.(type, data)

  const confine = (p: string): string => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
    const rel = relative(root, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`root 밖 경로 접근 금지: ${p}`)
    }
    return abs
  }

  return {
    async write(path: string, content: string): Promise<FileOpResult> {
      const abs = confine(path)
      const risk = classifyFileRisk('file-write', path)
      const decision = await deps.gate.request({
        kind: 'file-write',
        summary: `파일 쓰기: ${path}`,
        target: abs,
        risk,
      })
      if (decision !== 'approved') {
        log('fileops.denied', { op: 'write', path })
        return { ok: false, path, reason: '승인 거부' }
      }
      await fs.mkdir(dirname(abs))
      await fs.writeFile(abs, content)
      log('fileops.write', { path })
      return { ok: true, path }
    },

    async remove(path: string): Promise<FileOpResult> {
      const abs = confine(path)
      const decision = await deps.gate.request({
        kind: 'file-delete',
        summary: `파일 삭제: ${path}`,
        target: abs,
        risk: classifyFileRisk('file-delete', path),
      })
      if (decision !== 'approved') {
        log('fileops.denied', { op: 'remove', path })
        return { ok: false, path, reason: '승인 거부' }
      }
      await fs.rm(abs)
      log('fileops.remove', { path })
      return { ok: true, path }
    },

    async read(path: string): Promise<FileOpResult> {
      const abs = confine(path)
      const content = await fs.readFile(abs)
      log('fileops.read', { path })
      return { ok: true, path, content }
    },
  }
}

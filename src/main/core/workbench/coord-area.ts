import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { GitRepo } from '../workspace/git'
import { isLinkSync } from '../workspace/path-guard'

/**
 * 코디네이션 영역 (#251 · 스펙 §W-2) — 같은 레포를 보는 모든 인스턴스가 수렴하는 단일 디렉터리.
 *
 * 위치 = `<canonical common gitdir>/fleet/`. 이 자리를 고른 근거는 git 위생 명령(`gc`·`repack`·`prune`·
 * `reflog expire`·`clean -xffd`·`worktree prune`·`fsck`) 전량 생존이 실측됐기 때문이다(§3-T54). 경쟁
 * 후보 `.git/worktrees/<id>/` 는 `git worktree prune` 이 커스텀 파일까지 지워 기각됐다.
 *
 * **축소 후 트리**(2026-07-23 서버 단일 표면 · §W-3 가 §W-2 의 트리 문안에 우선):
 * `area.json` · `active-instance.json` · `authority/` · `activity/` · `journal/` · `tmp/`.
 * **`locks/`·`owner/` 는 만들지 않는다** — 락 endpoint 는 커널 네임스페이스에 있어(pathname 부재)
 * 디스크 레코드가 필요 없고, 레코드를 두면 L-6 의 「디스크 I/O 0」과 §3-T10 의 「락 소유 권위 레코드
 * 부재」가 동시에 깨진다. 이 모듈은 **영역 루트와 `area.json` 만** 만든다(하위 디렉터리는 각 소유
 * 모듈이 자기 PR 에서 만든다).
 *
 * ⚠ **위협 모델(§W-2-a)**: 프로덕션에서 이 영역은 `/workspace/.git/fleet/` 이고 `/workspace` 는 ttyd
 * 컨테이너에도 마운트돼 **같은 uid** 로 열려 있다. 따라서 0700·uid 검사는 «사고·경합» 방어이지
 * 악의적 변조 방어가 아니다 — 비목표로 명시 선언돼 있다.
 */

export const AREA_DIR_NAME = 'fleet'
export const AREA_RECORD_FILE = 'area.json'
/** 스키마 버전 — **초과 버전은 거부**한다(구 버전이 신 버전 권위를 재초기화하면 두 인스턴스가 갈린다). */
export const AREA_SCHEMA_VERSION = 1

/** 이 코드베이스가 아는 락 백엔드 전체. 플랫폼별 **가용** 집합은 호출자가 주입한다. */
export const SUPPORTED_LOCK_BACKENDS = ['uds-abstract'] as const
export type LockBackendKind = (typeof SUPPORTED_LOCK_BACKENDS)[number]
const DEFAULT_LOCK_BACKEND: LockBackendKind = 'uds-abstract'

export interface AreaRecord {
  readonly schemaVersion: number
  readonly lockBackend: string
  readonly createdAt: number
  /** 진단 전용 — 최초 생성 인스턴스. **소유권 판정에 쓰지 않는다**(연령·신원은 소유 증거가 아니다). */
  readonly createdBy: string
}

export interface CoordinationArea {
  readonly root: string
  readonly commonGitDir: string
  readonly record: AreaRecord
  readonly lockBackend: LockBackendKind
  /** 락 endpoint 이름의 레포 스코프 성분(§W-3). 추상 소켓 이름공간은 net ns 전역이라 이게 유일한 분리 수단. */
  readonly digest: string
}

export type AreaDisabledReason =
  /** git 레포가 아니다(경로를 지어내지 않는다). */
  | 'not-a-repo'
  /** git 이 dubious ownership 으로 거부 — 배포의 `safe.directory` 커버리지 문제(조용한 폴백 금지). */
  | 'repo-unsafe-ownership'
  /** 기록된 백엔드를 이 코드베이스가 모른다(더 새 버전이 쓴 영역). */
  | 'unsupported-backend'
  /** 기록된 스키마가 지원 범위를 넘는다. */
  | 'incompatible-version'
  /** 백엔드는 알지만 이 플랫폼에서 가용하지 않다(win32·macOS = 추상 소켓 부재). */
  | 'platform-unsupported'
  /** 영역 경로가 링크/비정형이거나 소유자가 자신이 아니다. */
  | 'unsafe-path'
  /** 레코드 손상·판정 불가 — **자동 삭제 금지**. */
  | 'reconciliation-required'
  /** 디렉터리 생성·기록 쓰기 실패(권한 등). */
  | 'io-failure'

export type AreaOpenResult =
  | { status: 'open'; area: CoordinationArea }
  | { status: 'disabled'; reason: AreaDisabledReason; detail: string }

/**
 * 락 endpoint 이름의 레포 스코프 성분. **정준 common gitdir 로부터 유도**하므로 재시작·컨테이너 교체
 * 후에도 같은 값이고, 서로 다른 레포는 서로 다른 값을 갖는다.
 *
 * 길이가 계약인 이유: 추상 소켓 이름은 `sun_path`(108바이트) 안에 선행 NUL 포함으로 들어가야 하고
 * 초과하면 **무성 절단이 아니라 EINVAL** 이다(실측: 총 108 OK / 109 EINVAL). 32자로 고정해
 * `'fleet.wb.' + digest + '.' + key` 의 최대 길이를 컴파일 타임에 결정한다(§W-3 이름 예산).
 */
export function endpointDigest(canonicalCommonGitDir: string): string {
  return createHash('sha256').update(canonicalCommonGitDir).digest('hex').slice(0, 32)
}

export interface OpenAreaOptions {
  readonly repo: GitRepo
  /** 이 플랫폼에서 실제로 bind 가능한 백엔드 집합. 빈 배열 = 기능 비활성(fail-closed). */
  readonly supportedBackends: readonly LockBackendKind[]
  /** 진단용 엔진 인스턴스 id(ULID). */
  readonly instanceId: string
  readonly now?: () => number
}

const disabled = (reason: AreaDisabledReason, detail: string): AreaOpenResult => ({
  status: 'disabled',
  reason,
  detail,
})

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : `알 수 없는 오류: ${String(err)}`

type RecordProbe =
  { kind: 'missing' } | { kind: 'corrupt'; detail: string } | { kind: 'ok'; record: AreaRecord }

/** 레코드 1회 읽기 — 장기 핸들·watch 를 만들지 않는다(리더 규율 D-9). */
const probeRecord = (path: string): RecordProbe => {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'corrupt', detail: errText(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { kind: 'corrupt', detail: errText(err) }
  }
  const rec = parsed as Partial<AreaRecord> | null
  if (
    !rec ||
    typeof rec !== 'object' ||
    typeof rec.schemaVersion !== 'number' ||
    typeof rec.lockBackend !== 'string'
  ) {
    return { kind: 'corrupt', detail: '필수 필드(schemaVersion·lockBackend) 누락' }
  }
  return {
    kind: 'ok',
    record: {
      schemaVersion: rec.schemaVersion,
      lockBackend: rec.lockBackend,
      createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : 0,
      createdBy: typeof rec.createdBy === 'string' ? rec.createdBy : '',
    },
  }
}

/**
 * 영역을 연다(없으면 만든다). **모호는 전부 fail-closed** — 조용한 폴백·자동 삭제·자동 마이그레이션은
 * 하지 않는다. 반환이 `disabled` 면 호출자는 어떤 락 획득도 시도하지 않는다(L-4 동형).
 */
export async function openCoordinationArea(opts: OpenAreaOptions): Promise<AreaOpenResult> {
  const dir = await opts.repo.commonGitDir()
  if (dir.status === 'failed') {
    // 배포 실측(#251 PR1 착수 게이트): `safe.directory` 는 **정확 경로 일치**라 하위 디렉터리 레포는
    // 커버되지 않는다 — 컨테이너에서 `/workspace` 만 등재된 채 `/workspace/proj-a` 를 열면 여기로 온다.
    const reason = /dubious ownership/i.test(dir.stderr) ? 'repo-unsafe-ownership' : 'not-a-repo'
    return disabled(reason, dir.stderr)
  }

  let commonGitDir: string
  try {
    // git stdout 은 win32 에서 슬래시 절대경로(`C:/…`)를, realpath 는 역슬래시(`C:\…`)를 준다.
    // **정준값 하나만** 경로 유도·영속·대조에 쓴다(원문 문자열을 섞으면 신원 대조가 항상 어긋난다).
    commonGitDir = realpathSync.native(dir.path)
  } catch (err) {
    return disabled('io-failure', `common gitdir realpath 실패: ${errText(err)}`)
  }

  const root = join(commonGitDir, AREA_DIR_NAME)
  const kind = isLinkSync(root)
  if (kind !== 'dir' && kind !== 'missing') {
    return disabled('unsafe-path', `영역 루트가 디렉터리가 아님(${kind}): ${root}`)
  }

  const probe = probeRecord(join(root, AREA_RECORD_FILE))
  if (probe.kind === 'corrupt') {
    return disabled('reconciliation-required', `area.json 판정 불가: ${probe.detail}`)
  }

  // 기록이 있으면 **기록이 권위**다. 없으면 이 인스턴스가 기본 백엔드로 초기화한다.
  const backend = probe.kind === 'ok' ? probe.record.lockBackend : DEFAULT_LOCK_BACKEND
  if (probe.kind === 'ok' && probe.record.schemaVersion > AREA_SCHEMA_VERSION) {
    return disabled(
      'incompatible-version',
      `지원 범위 초과 schemaVersion=${probe.record.schemaVersion} (지원 ≤${AREA_SCHEMA_VERSION}) — 더 새 버전의 Fleet 으로 열 것`,
    )
  }
  if (!(SUPPORTED_LOCK_BACKENDS as readonly string[]).includes(backend)) {
    return disabled('unsupported-backend', `알 수 없는 lockBackend=${backend}`)
  }
  const lockBackend = backend as LockBackendKind
  if (!opts.supportedBackends.includes(lockBackend)) {
    // 부수효과 이전에 막는다 — 이 플랫폼에서는 어떤 endpoint 획득도 시도하지 않는다.
    return disabled('platform-unsupported', `이 플랫폼에서 ${lockBackend} 백엔드를 쓸 수 없음`)
  }

  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      // 이미 존재하던 디렉터리의 모드까지 강제한다(umask·과거 생성분 보정).
      chmodSync(root, 0o700)
    }
  } catch (err) {
    // 컨테이너 실측: git 이 성공해도 `.git` 소유자가 다르면 여기서 EACCES 다("git 성공 ⇒ 쓰기 가능"은 거짓).
    return disabled('io-failure', `영역 디렉터리 생성 실패: ${errText(err)}`)
  }

  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    const st = statSync(root)
    if (uid !== undefined && st.uid !== uid) {
      return disabled('unsafe-path', `영역 소유자가 자신이 아님(uid ${st.uid} ≠ ${uid}): ${root}`)
    }
  }

  let record: AreaRecord
  if (probe.kind === 'ok') {
    record = probe.record
  } else {
    const fresh: AreaRecord = {
      schemaVersion: AREA_SCHEMA_VERSION,
      lockBackend,
      createdAt: (opts.now ?? Date.now)(),
      createdBy: opts.instanceId,
    }
    try {
      // create-only — 동시 기동 경합에서 나중 도착자가 남의 기록을 덮지 않는다.
      writeFileSync(join(root, AREA_RECORD_FILE), `${JSON.stringify(fresh, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      record = fresh
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return disabled('io-failure', `area.json 기록 실패: ${errText(err)}`)
      }
      const again = probeRecord(join(root, AREA_RECORD_FILE))
      if (again.kind !== 'ok') {
        return disabled('reconciliation-required', 'area.json 경합 후 재판정 불가')
      }
      record = again.record
    }
  }

  return {
    status: 'open',
    area: { root, commonGitDir, record, lockBackend, digest: endpointDigest(commonGitDir) },
  }
}

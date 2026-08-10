import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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
 *
 * ## `ApprovalGate` 를 거치지 않는 이유 (명시 예외 · 형제 `active-instance.ts` 와 동형)
 *
 * 영역 생성은 `mkdir`·`chmod`·tmp 쓰기·`link` 로 파일시스템을 변이한다. 그럼에도 승인 게이트 밖인
 * 근거는 형제 모듈과 같다 — 게이트의 범위는 «LLM 변이·툴 실행·프로세스 spawn»이고(소비자 =
 * `engine`·`orchestrator`·`mcp/host`·`tools/loop`), 이 경로는 **부팅 시점**이라 승인자가 존재하지
 * 않으며 §W-3 **L-5**(승인 대기 중 락 보유 금지)와 방향이 충돌한다. 결정 근거는 ADR-0013.
 *
 * 무엇보다 **파괴할 기존 상태를 건드리지 않는다**: 기존 `area.json` 은 읽어서 검증할 뿐 덮어쓰지
 * 않고(전방호환 fail-closed), 발행은 tmp+`link` **create-only 경합**이라 패자만 자기 tmp 를 거둔다.
 * `unlinkSync` 가 닿는 유일한 대상이 그 자기 tmp 다.
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
 * 길이가 계약인 이유: 추상 소켓 이름은 `sun_path`(108바이트) 안에 선행 NUL 포함으로 들어가야 한다.
 * ⚠ **초과 시 동작은 런타임 메이저마다 다르다**(#251 PR1b 실측 정정): Node 24 는 `EINVAL` 이지만
 * Node 22.22.3(=`.nvmrc` · 필수 CI 게이트)은 **성공시키고 107바이트로 무성 절단**해 앞부분을 공유하는
 * 서로 다른 두 키를 같은 endpoint 로 붕괴시킨다. 그래서 예산 집행은 libuv 가 아니라 우리 preflight
 * (`locks.ts` 의 `nameBudget`)가 한다. 여기서 32자로 고정하는 것은 그 예산의 상수 성분을 못 박는 일이다.
 */
export function endpointDigest(canonicalCommonGitDir: string): string {
  return createHash('sha256').update(canonicalCommonGitDir).digest('hex').slice(0, 32)
}

type RecordVerdict =
  | { kind: 'ok'; lockBackend: LockBackendKind }
  | { kind: 'rejected'; reason: AreaDisabledReason; detail: string }

/**
 * 레코드 수용 판정(순수) — **레코드를 얻은 모든 경로가 이 하나를 통과한다.**
 *
 * 경로가 둘이라는 점이 핵심이다: ①부팅 시 probe ②create-only 경합에서 진 뒤의 재읽기. ②를 검증 없이
 * 채택하면 승자가 신버전/타 백엔드여도 이쪽은 `open` 을 반환하면서 **자기 기본 백엔드로 조정**하게 되어,
 * 같은 영역을 보는 두 인스턴스가 서로 다른 락 규칙을 쓴다(Codex PR #257 P1 · L-4/I12 위반).
 */
const verifyRecord = (
  record: AreaRecord,
  supportedBackends: readonly LockBackendKind[],
): RecordVerdict => {
  if (record.schemaVersion > AREA_SCHEMA_VERSION) {
    return {
      kind: 'rejected',
      reason: 'incompatible-version',
      detail: `지원 범위 초과 schemaVersion=${record.schemaVersion} (지원 ≤${AREA_SCHEMA_VERSION}) — 더 새 버전의 Fleet 으로 열 것`,
    }
  }
  if (!(SUPPORTED_LOCK_BACKENDS as readonly string[]).includes(record.lockBackend)) {
    return {
      kind: 'rejected',
      reason: 'unsupported-backend',
      detail: `알 수 없는 lockBackend=${record.lockBackend}`,
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- 바로 위 `SUPPORTED_LOCK_BACKENDS.includes` 가 이미 좁힌 값이다(타입 술어가 아니라 배열 includes 라 tsc 가 좁히지 못할 뿐).
  const lockBackend = record.lockBackend as LockBackendKind
  if (!supportedBackends.includes(lockBackend)) {
    // 부수효과 이전에 막는다 — 이 플랫폼에서는 어떤 endpoint 획득도 시도하지 않는다.
    return {
      kind: 'rejected',
      reason: 'platform-unsupported',
      detail: `이 플랫폼에서 ${lockBackend} 백엔드를 쓸 수 없음`,
    }
  }
  return { kind: 'ok', lockBackend }
}

/**
 * 소유자 판정(순수) — 실 파일시스템에서 **타 uid 소유 디렉터리를 만들려면 root 권한이 필요**해
 * 통합 테스트로는 이 규칙을 검증할 수 없다. 판정만 떼어 두면 규칙 자체는 어느 OS 에서도 검증된다.
 * `getuid` 부재(win32)면 판정하지 않는다 — 그 표면에서는 mode·uid 의미론이 다르다.
 */
export const ownerMismatch = (statUid: number, selfUid: number | undefined): boolean =>
  selfUid !== undefined && statUid !== selfUid

export interface OpenAreaOptions {
  /**
   * **`commonGitDir` 하나만** 받는다(#251 PR3). 전체 `GitRepo` 를 받으면 ⓐ영역 개방 경로가 ref 변이
   * (`casUpdateRef`)·worktree 변이 권한을 함께 쥐게 되고 ⓑ`GitRepo` 에 메서드가 늘 때마다 이 경로의
   * 테스트 더블이 **계약과 무관하게** 커진다. 필요한 것만 받는 것이 두 문제를 동시에 없앤다.
   */
  readonly repo: Pick<GitRepo, 'commonGitDir'>
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
  | { kind: 'missing' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'unsafe'; detail: string }
  | { kind: 'ok'; record: AreaRecord }

/**
 * 레코드 1회 읽기 — 장기 핸들·watch 를 만들지 않는다(리더 규율 D-9).
 *
 * **읽기 전에 파일 종류를 본다**(스펙 §W-2 「JSON = `'regular'|'missing'`」). 이 영역은 ttyd 셸·CLI
 * 에이전트와 **같은 신뢰 도메인**이라(§W-2-a) 누구든 그 자리에 FIFO 나 symlink 를 놓을 수 있다:
 * FIFO 면 `readFileSync` 가 **무기한 블록**되고(부팅이 영영 안 끝난다), symlink 면 **영역 밖 임의 JSON 이
 * 권위**가 된다. 둘 다 fail-closed 로 막는다.
 */
const probeRecord = (path: string): RecordProbe => {
  const kind = isLinkSync(path)
  if (kind === 'missing') return { kind: 'missing' }
  if (kind !== 'regular') {
    return { kind: 'unsafe', detail: `area.json 이 정규 파일이 아님(${kind}): ${path}` }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 이 룰의 목적은 브랜드 크레덴셜 위조 차단이며, 캐스트를 리뷰에 보이게 만드는 것 자체가 요구사항이다.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'corrupt', detail: errText(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { kind: 'corrupt', detail: errText(err) }
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- `JSON.parse` 산출물(unknown)을 검사 대상 형태로 좁힌다. 바로 아래 필수 필드 검사가 실제 검증이며, 이 캐스트는 그 검사를 쓰기 위한 것이다.
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
  if (probe.kind === 'unsafe') return disabled('unsafe-path', probe.detail)
  if (probe.kind === 'corrupt') {
    return disabled('reconciliation-required', `area.json 판정 불가: ${probe.detail}`)
  }

  // 기록이 있으면 **기록이 권위**다. 없으면 이 인스턴스가 기본 백엔드로 초기화한다.
  const intended: AreaRecord =
    probe.kind === 'ok'
      ? probe.record
      : {
          schemaVersion: AREA_SCHEMA_VERSION,
          lockBackend: DEFAULT_LOCK_BACKEND,
          createdAt: 0,
          createdBy: '',
        }
  const verdict = verifyRecord(intended, opts.supportedBackends)
  if (verdict.kind === 'rejected') return disabled(verdict.reason, verdict.detail)
  const lockBackend = verdict.lockBackend

  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  } catch (err) {
    // 컨테이너 실측: git 이 성공해도 `.git` 소유자가 다르면 여기서 EACCES 다("git 성공 ⇒ 쓰기 가능"은 거짓).
    return disabled('io-failure', `영역 디렉터리 생성 실패: ${errText(err)}`)
  }

  // ⚠ **소유자 검사가 `chmod` 보다 먼저**여야 한다(CodeRabbit PR #257). 남의 uid 소유 디렉터리에
  // `chmodSync` 하면 POSIX 에서 EPERM 이고, 그 예외를 io-failure 로 잡으면 **`unsafe-path` 진단이 가려진다**
  // — fail-closed 자체는 유지되지만 「운영자가 고칠 대상을 사유로 구분한다」는 이 모듈의 설계가 깨진다.
  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    const st = statSync(root)
    if (ownerMismatch(st.uid, uid)) {
      return disabled('unsafe-path', `영역 소유자가 자신이 아님(uid ${st.uid} ≠ ${uid}): ${root}`)
    }
    try {
      // 이미 존재하던 디렉터리의 모드까지 강제한다(umask·과거 생성분 보정).
      chmodSync(root, 0o700)
    } catch (err) {
      return disabled('io-failure', `영역 디렉터리 권한 설정 실패: ${errText(err)}`)
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
    // **원자적 발행**(Codex PR #257 P1): `flag:'wx'` 는 create-only 지만 **바이트가 채워지기 전에 이름이
    // 노출**된다 — 경합 상대가 EEXIST 를 받고 재읽기하면 빈/부분 JSON 을 보고 `reconciliation-required` 로
    // 오판할 수 있고, 쓰기 도중 크래시는 **영구 부분 파일**을 남긴다. tmp 에 완전히 쓴 뒤 `link` 로 발행하면
    // 「이름이 보이는 순간 내용이 완전」이 성립하고, `link` 자체가 원자적 create-only 라 경합 의미론도 유지된다.
    // (내구 순서 fsync 계약은 §W-5 `DurableFs` = PR2 범위. 여기서는 **가시성**만 원자화한다.)
    const tmp = join(root, `.${AREA_RECORD_FILE}.${randomBytes(8).toString('hex')}.tmp`)
    try {
      writeFileSync(tmp, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 })
      linkSync(tmp, join(root, AREA_RECORD_FILE))
      record = fresh
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 이 룰의 목적은 브랜드 크레덴셜 위조 차단이며, 캐스트를 리뷰에 보이게 만드는 것 자체가 요구사항이다.
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return disabled('io-failure', `area.json 기록 실패: ${errText(err)}`)
      }
      const again = probeRecord(join(root, AREA_RECORD_FILE))
      if (again.kind === 'unsafe') return disabled('unsafe-path', again.detail)
      if (again.kind !== 'ok') {
        return disabled('reconciliation-required', 'area.json 경합 후 재판정 불가')
      }
      // ⚠ 승자 기록은 **초기 probe 를 거치지 않았다** — 같은 검증을 다시 통과해야 한다(Codex PR #257 P1).
      // 빠뜨리면 승자가 신버전/타 백엔드여도 이쪽은 `open` 을 반환하고 **자기 기본 백엔드로 조정**하게
      // 되어, 같은 영역을 보는 두 인스턴스가 서로 다른 락 규칙을 쓴다(L-4/I12 가 막으려는 상태).
      const raced = verifyRecord(again.record, opts.supportedBackends)
      if (raced.kind === 'rejected') return disabled(raced.reason, raced.detail)
      return {
        status: 'open',
        area: {
          root,
          commonGitDir,
          record: again.record,
          // 채택한 기록과 **같은 출처**여야 한다(초기 기본값을 물고 가면 위 P1 이 다시 열린다).
          lockBackend: raced.lockBackend,
          digest: endpointDigest(commonGitDir),
        },
      }
    } finally {
      // 발행 성공이든 경합 패배든 tmp 는 남기지 않는다 — 영역 디렉터리 내용이 계약이기 때문
      // (「루트에는 area.json 만」 전수 단언). 삭제 실패는 진단 가치가 없어 삼킨다.
      try {
        unlinkSync(tmp)
      } catch {
        /* 이미 없거나 지울 수 없으면 다음 부팅이 같은 이름을 다시 쓰지 않는다(이름에 난수 포함) */
      }
    }
  }

  return {
    status: 'open',
    area: { root, commonGitDir, record, lockBackend, digest: endpointDigest(commonGitDir) },
  }
}

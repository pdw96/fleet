import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'

/**
 * 내구 쓰기 seam (#251 · 스펙 §W-5) — **IO 전량 주입이 계약**이다.
 *
 * 주입인 이유는 테스트 편의가 아니라 **검증 가능성**이다: 이 레포에서 `vi.spyOn(node:fs)` 는 win32 ESM 에서
 * 조용히 skip 되어(실측 선례 `ignored-baseline.test.ts:142-149,244-247`) fsync·rename 실패 주입 테스트가
 * 통째로 **false-GREEN** 이 된다. `GitRunner`(git.ts:29-31)·`idGen`(memory.ts:25)와 같은 형태의 seam 이다.
 *
 * ⚠ **플랫폼 대칭이 없다**(3면 실측 · 계획 정정 61). 같은 코드가 양 OS 에서 다른 답을 준다:
 * ```text
 *                       win32 24.16.0     linux 22.22.3 / 24.18.0
 *   openSync(dir,'r')  → fsync  EPERM          OK
 *   openSync(dir,'r+') → fsync  OK             EISDIR (열지도 못한다)
 *   fsync(파일 'r' fd)          EPERM          OK
 * ```
 * win32 의 EPERM 원인은 「디렉터리」가 아니라 **권한**이다 — `FlushFileBuffers` 는 `GENERIC_WRITE` 를
 * 요구하고(MS Learn), libuv `fs__sync_impl` 은 디렉터리 검사 없이 그 오류를 번역하며 `fs__open` 은
 * `FILE_FLAG_BACKUP_SEMANTICS` 를 무조건 세워 디렉터리 열기를 허용한다. 그래서 win32 에서도 `'r+'` 면
 * API 는 성공한다. 그럼에도 **등급을 올리지 않는 이유**는 `probeDurability` 주석에 있다.
 *
 * ## `ApprovalGate` 를 거치지 않는 이유 (명시 예외 · 형제 `active-instance.ts` 와 동형 · CodeRabbit PR#264)
 *
 * 이 어댑터는 `rename`·`unlinkIfExists` 로 **destructive 연산**을 노출한다. 그럼에도 승인 게이트 밖인
 * 근거는 형제 모듈과 같다 — 게이트의 범위는 «LLM 변이·프로세스 spawn»이고(소비자 = `engine`·
 * `orchestrator`·`mcp/host`·`tools/loop`), 엔진 인프라 쓰기는 전부 게이트 밖이라는 선례가 이미 있다
 * (`store/json-file.ts` · `ignored-baseline.ts` · `coord-area.ts` · `active-instance.ts`). 소비 경로도
 * **부팅·CAS 임계 구역**이라 승인자가 없고, §W-3 **L-5**(승인 대기 중 락 보유 금지)와 방향이 충돌한다.
 *
 * ⚠ 다만 이 파일은 **경로를 스스로 고르지 않는다** — 무엇을 rename/unlink 할지는 전적으로 호출자가 준다.
 * 따라서 「남의 파일을 지운다」를 막는 것은 이 어댑터가 아니라 **호출자의 소유 확인 + create-only 경합**
 * 이며(PR2b 의 `withAuthority` 가 리스 재검증 뒤에만 쓰기를 태운다), 그 책임 경계를 여기 명시해 둔다.
 * 이 seam 자체를 게이트로 감싸면 부팅·임계 구역이 승인 대기로 잠긴다.
 */

/**
 * 내구 등급(§0.1 C3 · U4). 조용한 강등 금지 — 값이 레코드에 **기록되어야** 하고 UI·런북에 노출되어야 한다.
 * ⚠ 이 PR 시점에 그 소비자는 **셋 다 없다**: 기록자 = PR2b(`writtenBy.durability`) · `area.json` 필드 = PR7 ·
 * UI = #253. 현재형으로 읽히지 않게 적는다(자체 적대 리뷰 R5-8).
 */
export type DurabilityLevel = 'file+dir' | 'file-only'

/**
 * 경로가 무엇인지. **읽기 전에 종류를 본다**가 이 레포의 확립된 규율이고(coord-area.ts:181-186 ·
 * active-instance 5분기), 그 근거는 실측이다 — FIFO 면 `readFileSync` 가 **무기한 블록**하고(부팅 정지),
 * symlink 면 **영역 밖 JSON 이 권위**가 된다. §W-5 원안에는 이 프리미티브가 없어 규율을 seam 위에서
 * 재현할 수 없었다(계획 정정 59).
 */
export interface PathKind {
  readonly kind: 'regular' | 'missing' | 'other'
  readonly size: number
}

/**
 * 내구 쓰기에 필요한 파일시스템 프리미티브 전량. **여기 없는 IO 를 store 가 직접 하지 않는 것**이 계약이다.
 */
export interface DurableFs {
  readFileUtf8(path: string): string
  statKind(path: string): PathKind
  /** `mode` 는 필수다 — 권위 디렉터리는 0700 이어야 하는데 기본값은 `0o777 & ~umask` 다(정정 65). */
  mkdirRecursive(path: string, mode: number): void
  /** `open(path,'wx',mode)` — create-only. 기존 이름은 종류를 불문하고 EEXIST(실측). */
  openExclusive(path: string, mode: number): number
  writeAll(fd: number, data: string): void
  fsync(fd: number): void
  close(fd: number): void
  rename(from: string, to: string): void
  /** **POSIX 전용.** `opendirSync` 는 fd 를 주지 않으므로(양 OS 실측) 구현은 `openSync(path,'r')` 다. */
  openDir(path: string): number
  unlinkIfExists(path: string): void
}

/**
 * 부분 쓰기 재개(순수) — `write` 가 요청보다 적게 받아들여도 **전량이 순서대로** 나갈 때까지 이어 쓴다.
 *
 * `fs.writeSync` 는 부분 쓰기가 가능하고(Node 자신이 `writeFileSync` 에서 같은 루프를 돈다), 재개는
 * 반드시 **바이트 오프셋**이어야 한다 — 반환된 바이트 수를 문자 인덱스로 오해하면 멀티바이트 경계가
 * 잘린다(한글 1자 = 3바이트). 순수 함수로 떼어낸 이유는 검증 가능성이다: 실 파일시스템에서는 부분
 * 쓰기를 결정론적으로 만들 수 없어(3면 실측: 8MiB 단일 호출도 전량 기록) 주입 없이는 이 규칙이
 * **영원히 미검증**으로 남는다(계획 정정 66).
 */
export function writeAllBytes(
  write: (buf: Buffer, offset: number, length: number) => number,
  data: string,
): void {
  const buf = Buffer.from(data, 'utf8')
  let off = 0
  while (off < buf.length) {
    const n = write(buf, off, buf.length - off)
    // **진행 보장**: `writeSync` 의 반환은 「기록된 바이트 수」일 뿐 전진을 보장하지 않는다. 0 을 받고도
    // 루프를 계속하면 **리스와 in-process 뮤텍스를 쥔 채 임계 구역이 영구 고착**된다. 그리고 그 고착은
    // RED 가 아니라 **hang** 이다 — 동기 루프가 이벤트 루프를 막아 vitest 의 `it` timeout 조차 발화하지
    // 않음이 실측됐다(가드를 빼고 돌리면 러너가 멈춘다). 실패로 승격해 호출자의 `io-failure` 로 보낸다.
    if (n <= 0)
      throw new Error(`writeAll 이 전진하지 않았다(반환 ${n} · 남은 ${buf.length - off}B)`)
    off += n
  }
}

/**
 * 실 파일시스템 어댑터 — **얇게 유지하는 것이 완료 조건**이다(계획 정정 75).
 *
 * 두께가 계약인 이유는 커버리지다: 이 파일의 플랫폼 전용 행(POSIX `openDir` · win32 rename 재시도)은
 * 반대편 OS 의 **분모에만** 들어간다. 판정·순서·재시도 로직을 여기 두면 그 손실이 양방향으로 커지므로,
 * 여기에는 **위임과 errno 협소화만** 두고 규칙은 전부 주입 seam 위(페이크로 양 OS 검증)에 둔다.
 */
export function createNodeDurableFs(): DurableFs {
  return {
    readFileUtf8: (path) => readFileSync(path, 'utf8'),
    statKind: (path) => {
      try {
        // **`lstat` 이다**(`stat` 아님) — symlink 를 따라가면 영역 밖 파일이 `regular` 로 보고돼
        // 「권위는 영역 안에 있다」가 무너진다. 형제 `path-guard.ts:29`·`coord-area.ts:191` 과 같은 규율.
        const st = lstatSync(path)
        return st.isFile() ? { kind: 'regular', size: st.size } : { kind: 'other', size: st.size }
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 캐스트를 리뷰에 보이게 두는 것 자체가 이 룰의 목적이다.
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'missing', size: 0 }
        // ENOENT 외(EACCES·ELOOP 등)는 **삼키지 않는다** — 「없음」과 「못 봄」은 다른 사실이고,
        // 뭉개면 호출자가 부재를 근거로 create-only 를 시도해 잘못된 분기를 탄다.
        throw err
      }
    },
    mkdirRecursive: (path, mode) => {
      mkdirSync(path, { recursive: true, mode })
    },
    openExclusive: (path, mode) => openSync(path, 'wx', mode),
    writeAll: (fd, data) => {
      writeAllBytes((buf, off, len) => writeSync(fd, buf, off, len), data)
    },
    fsync: (fd) => {
      fsyncSync(fd)
    },
    close: (fd) => {
      closeSync(fd)
    },
    rename: (from, to) => {
      renameSync(from, to)
    },
    // `'r'` 이 유일한 형태다: Linux 는 `'r+'` 가 EISDIR 이고, win32 는 `'r+'` 면 열리지만 그 fd 의 fsync
    // 성공이 문서화된 의미론이 아니라 등급을 올리지 않는다(`probeDurability` 주석 · 3면 실측).
    openDir: (path) => openSync(path, 'r'),
    unlinkIfExists: (path) => {
      try {
        unlinkSync(path)
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- catch 의 `unknown` 을 errno 형태로 협소화하는 표준 관용구(레포 전역). 캐스트를 리뷰에 보이게 두는 것 자체가 이 룰의 목적이다.
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
    },
  }
}

/**
 * 내구 등급 실측 — **프로브가 유일 권위**이고 쓰기 경로는 이 값을 소비한다(계획 정정 60).
 *
 * 판정자를 하나로 묶은 이유: 쓰기 경로가 플랫폼으로 분기하고 등급은 프로브로 정하면 둘이 어긋나는 조합이
 * 실재한다 — ⓐ프로브 성공 + 쓰기 생략 = **갖지 않은 내구성을 레코드가 주장** ⓑ프로브 실패 + 쓰기 시도 =
 * 매 CAS 가 `commit-uncertain`.
 *
 * ⚠ **win32 는 프로브를 시도하지 않는다**(상한 고정). API 로는 성공하지만(`'r+'` · 위 표), MS 문서는
 * `FlushFileBuffers` 의 `hFile` 을 "a handle to the open file" 로만 규정하고 **디렉터리 핸들의 의미론을
 * 규정하지 않는다** — 별도 규정이 있는 것은 *볼륨* 핸들뿐이며 그마저 관리자 권한을 요구한다. 문서화되지
 * 않은 성공을 POSIX `fsync(dirfd)` 등가로 취급하면 **조용한 승격**이 되고, 그것은 U4 가 금지한 「조용한
 * 강등」의 정확한 쌍대다. 시도 자체를 하지 않는 것이 「결과를 버린다」보다 강한 계약인 이유는, 후자가
 * 「성공하면 올린다」는 한 줄 변경과 관측상 구분되지 않기 때문이다.
 */
export function probeDurability(
  fs: DurableFs,
  dir: string,
  platform: NodeJS.Platform,
): DurabilityLevel {
  if (platform === 'win32') return 'file-only'
  try {
    const fd = fs.openDir(dir)
    try {
      fs.fsync(fd)
    } finally {
      fs.close(fd)
    }
    return 'file+dir'
  } catch {
    // 등급 판정은 **부팅을 막지 않는다** — 강등이 정답이고, 그 사실은 레코드에 남는다.
    return 'file-only'
  }
}

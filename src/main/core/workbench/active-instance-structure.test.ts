import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as activeInstance from './active-instance'
import * as instanceMarker from './instance-marker'
import * as instanceMarkerProc from './instance-marker-proc'

/**
 * #251 PR1c — 인스턴스 배타 층의 **구조 단언**(계획 정정 ㊲·㊻·㊸).
 *
 * 행동 테스트로 부족한 계약이 셋이다 — 전부 「무엇을 **하지 않는가**」다:
 *   ① 회수 판정에 **연령·pid·시각**이 들어오지 않음(레코드가 `acquiredAt` 을 들고 있어 유혹이 코드 안에 있다.
 *      「오래됐으면 회수」 한 줄은 레포의 어떤 기존 스캔에도 걸리지 않는다 — 감사 실측)
 *   ② 인스턴스 배타가 **락 서열 경로를 타지 않음**(`tryAcquire`/`createLockScope` 0건 — 락 키를 생존
 *      비콘으로 재사용하면 idle 인스턴스가 「사망」으로 오판된다)
 *   ③ 발행·회수가 **덮어쓰기 프리미티브를 쓰지 않음**(create-only 가 경합 승자를 정한다)
 * 셋 다 「그 코드가 존재하지 않음」이므로 소스 구조가 유일한 관측면이다.
 *
 * 방어 2종은 형제 선례(`locks-structure.test.ts`)에서 승계한다: ⓐ`stripComments` ⓑ**앵커**(대상·매칭이
 * 실재함을 먼저 단언 — 없으면 이름만 바뀌어도 「0건」이 vacuous 통과).
 */

/** 블록/라인 주석 제거(`://` URL 보존 — `locks-structure.test.ts:26-28` 동형). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** 이 PR 이 신설한 프로덕션 소스 전량. */
const PR1C_SOURCES = [
  'active-instance.ts',
  'instance-marker.ts',
  'instance-marker-proc.ts',
] as const
const source = (file: string): string => stripComments(readFileSync(join(HERE, file), 'utf8'))

describe('스캔 앵커 — 대상이 실재한다', () => {
  it.each(PR1C_SOURCES)('%s 는 실재하고 비어 있지 않다', (file) => {
    expect(source(file).length).toBeGreaterThan(400)
  })
})

/**
 * ① **L-1 재유입 가드**. 기존 가드(`locks-structure.test.ts:145-162`)는 하드코딩 3파일 목록에만 걸려
 * 있고, 그 목록을 이 모듈까지 넓히면 `acquiredAt` 기록·`fs` import 라는 **정당한** 코드가 즉시 RED 다.
 * 그래서 「판정을 순수 함수로 분리하고 그 **본문**을 본다」로 조작화한다.
 */
describe('T5 구조층 — 회수 판정에 연령·pid·시각이 없다', () => {
  const decideBody = (): string => {
    const src = source('active-instance.ts')
    const start = src.indexOf('export function decideReclaim')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = src.slice(start)
    const end = body.indexOf('\n}')
    expect(end).toBeGreaterThan(0)
    return body.slice(0, end)
  }

  it('앵커: 판정 함수 본문이 실재하고 마커를 비교한다', () => {
    expect(decideBody()).toMatch(/recordedMarker\s*===\s*selfMarker/)
  })

  it.each([
    ['acquiredAt(연령)', /acquiredAt/],
    ['Date.now', /Date\.now\s*\(/],
    ['mtime·birthtime', /\bmtimeMs?\b|\bbirthtime/],
    ['pid 조회', /\bprocess\.pid\b/],
    ['파일시스템 접근', /\b(?:readFileSync|statSync|lstatSync|existsSync)\s*\(/],
  ])('판정 본문에 %s 가 0건', (_label, pattern) => {
    expect(decideBody()).not.toMatch(pattern)
  })

  /**
   * `acquiredAt` 은 **기록 전용 진단 필드**다. 위 본문 스캔은 판정이 `decideReclaim` 안에 있을 때만
   * 유효하므로, 연령 로직이 **호출부에 인라인으로** 들어오는 경로를 두 겹으로 더 막는다:
   * ⓐ대소 비교·산술과 함께 등장하지 않는다(「오래됐으면 회수」의 문법적 형태)
   * ⓑ등장 횟수 자체를 고정한다(「호출 부위 수 == 매칭 수」 관용구 — 5번째 용례가 생기면 RED 이고
   *   리뷰를 강제한다). 현재 **2곳** = 타입 선언 · 기록. 자체 적대 리뷰(R1-06) 반영으로 `RecordProbe` 가
   *   그 필드를 아예 싣지 않게 되어 판정 경로에서 값이 **구조적으로 사라졌다**(파싱 3곳 소멸).
   */
  it('acquiredAt 이 대소 비교·산술에 쓰이지 않는다', () => {
    expect(source('active-instance.ts')).not.toMatch(
      /acquiredAt\s*(?:[<>]=?|[-+*/])|(?:[<>]=?|[-+*/])\s*[\w.]*acquiredAt/,
    )
  })

  it('acquiredAt 용례가 정확히 2곳이다(새 용례는 RED 로 리뷰를 강제한다)', () => {
    const hits = source('active-instance.ts').match(/acquiredAt/g) ?? []
    expect(hits).toHaveLength(2)
  })

  /** 판정 경로에 값이 **존재하지 않는다**: 읽기 결과 타입이 그 필드를 담지 않는다(구조적 보장). */
  it('RecordProbe 는 acquiredAt 을 싣지 않는다', () => {
    const src = source('active-instance.ts')
    const probeType = src.slice(src.indexOf('type RecordProbe'), src.indexOf('const probeRecord'))
    expect(probeType).toMatch(/Pick<ActiveInstanceRecord/)
    expect(probeType).not.toMatch(/acquiredAt/)
  })
})

/**
 * ② 인스턴스 배타는 **서열 밖**이다. 락 서열 합성을 타면 두 오작동이 열린다: 락 키를 생존 비콘으로
 * 재사용(→ idle 인스턴스 오판) · `r` 을 인스턴스 수명 내내 보유(→ 레포 변이 영구 정지).
 */
describe('T5 구조층 — 락 서열 경로를 타지 않는다', () => {
  it.each([
    ['tryAcquire 계열', /\.tryAcquire(?:BenchLease)?\s*\(/],
    ['createLockScope', /createLockScope/],
    ['서열 합성', /createOrderedLocks|LOCK_LEVEL/],
    ['레포 락 키', /REPO_LOCK_KEY/],
  ])('active-instance.ts 에 %s 가 0건', (_label, pattern) => {
    expect(source('active-instance.ts')).not.toMatch(pattern)
  })

  it('앵커: 대신 주입 백엔드를 직접 bind 하고 이름은 endpointFor 로 유도한다', () => {
    const src = source('active-instance.ts')
    expect(src).toMatch(/backend\.bind\s*\(/)
    expect(src).toMatch(/endpointFor\s*\(\s*opts\.digest,\s*\{\s*kind:\s*'instance'\s*\}/)
  })

  /**
   * **백엔드 bind 호출자 exact 핀**(계획 정정 ㊲ — 감사가 「무핀」으로 지적한 자리). 두 번째 획득 경로가
   * 무신호로 생기는 것을 막는다.
   *
   * ⚠ 술어를 `.bind(` 로 두면 **`Function.prototype.bind` 한 줄**이 이 워크벤치-로컬 테스트를 거짓 RED 로
   * 만든다(자체 적대 리뷰 R4-3·R6-5 · 변이 실증). 계약은 「주입 백엔드를 직접 부르는가」이므로 술어를
   * 그 대상에 귀속시키고, 「워크벤치 밖에서 `LockBackend` 를 쓰지 않는다」는 **별도 축**으로 본다.
   */
  const productionFiles = (): string[] => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(SRC_ROOT)
    return files
  }

  it('주입 백엔드를 직접 bind 하는 파일은 정확히 2개다', () => {
    const callers = productionFiles()
      .filter((f) => /\bbackend\.bind\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC_ROOT.length).replace(/\\/g, '/'))
      .sort()
    expect(callers).toEqual([
      'main/core/workbench/active-instance.ts',
      'main/core/workbench/locks.ts',
    ])
  })

  it('LockBackend 를 쓰는 프로덕션 파일은 워크벤치 안뿐이다(우회 경로 축)', () => {
    const users = productionFiles()
      .filter((f) => /\bLockBackend\b/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(SRC_ROOT.length).replace(/\\/g, '/'))
    expect(users.length).toBeGreaterThan(0)
    expect(users.every((f) => f.startsWith('main/core/workbench/'))).toBe(true)
  })
})

/** ③ 발행·회수는 create-only 다. 덮어쓰기 프리미티브는 두 회수자를 모두 성공시킨다. */
describe('T5 구조층 — 발행·회수는 create-only 프리미티브만 쓴다', () => {
  it('앵커: linkSync 로 발행한다', () => {
    expect(source('active-instance.ts')).toMatch(/linkSync\s*\(/)
  })

  it.each([
    ['renameSync(원자적 교체)', /renameSync/],
    ['copyFileSync', /copyFileSync/],
    ['appendFileSync', /appendFileSync/],
  ])('%s 가 0건', (_label, pattern) => {
    expect(source('active-instance.ts')).not.toMatch(pattern)
  })

  /** 대상 경로에 직접 쓰면 symlink 를 추종해 영역 밖 파일을 덮어쓴다 — 쓰기는 tmp 에만. */
  it('writeFileSync 의 대상은 tmp 뿐이다', () => {
    const writes = [...source('active-instance.ts').matchAll(/writeFileSync\s*\(\s*([\w.]+)/g)].map(
      (m) => m[1],
    )
    expect(writes).toEqual(['tmp'])
  })
})

/** 순수층 보장 — 파싱·형태 검증·합성이 파일시스템을 알면 양 OS 실행 계약이 깨진다. */
describe('마커 순수층 — instance-marker.ts 는 파일시스템을 알지 못한다', () => {
  const fsLike = (mod: string): RegExp =>
    new RegExp(
      String.raw`(?:from\s*|require\(\s*|import\(\s*)['"](?:node:)?${mod}(?:/promises)?['"]`,
    )

  it('fs 를 어떤 표기로도 import 하지 않는다', () => {
    expect(source('instance-marker.ts')).not.toMatch(fsLike('fs'))
  })

  it('앵커: 실 리더 쪽은 반대로 fs 를 쓴다', () => {
    expect(source('instance-marker-proc.ts')).toMatch(fsLike('fs'))
  })
})

/**
 * `instance-marker-proc.test.ts` 는 **경로를 리터럴로 다시 적어** 독립 재계산한다(상수 공유는 경로
 * 오지정을 양쪽에 똑같이 반영해 대조를 무력화한다). 그 리터럴이 실제 모듈에 실재함을 여기서 고정한다 —
 * 없으면 그 동치 단언이 「엉뚱한 경로끼리의 일치」가 된다.
 */
describe('마커 실 리더 — /proc 경로 앵커', () => {
  it.each(['/proc/sys/kernel/random/boot_id', '/proc/1/stat', '/proc/self/ns/pid'])(
    '%s 리터럴이 실재한다',
    (path) => {
      expect(source('instance-marker-proc.ts')).toContain(path)
    },
  )

  /**
   * win32 에서 POSIX 절대경로는 **현재 드라이브 상대**로 해석되므로(`/proc/x` → `C:\proc\x` · 실측)
   * 파일 존재 검사는 플랫폼 판정 근거가 될 수 없다 — 사용자가 `C:\proc` 를 만들면 위조된다.
   */
  it('플랫폼 판정은 process.platform 으로만 한다', () => {
    const src = source('instance-marker-proc.ts')
    expect(src).toMatch(/process\.platform\s*!==\s*'linux'/)
    expect(src).not.toMatch(/existsSync|accessSync/)
  })
})

/**
 * **선언된 차단 사유가 전부 계약 테스트에서 소비되는가**(계획 ㊺ⓒ 의 실제 조작화 · 자체 적대 리뷰 R1-05).
 * 상태표의 「표 길이 == 7」류 자기참조 앵커는 구현 분기가 늘어도 무신호다 — 사유 유니온을 소스에서 세어
 * 테스트 소비와 대조해야 「새 분기가 생기면 RED」가 성립한다.
 */
describe('T5 구조층 — ClaimBlockedReason 전수 소비', () => {
  const reasons = (): string[] => {
    const src = source('active-instance.ts')
    const start = src.indexOf('export type ClaimBlockedReason')
    const body = src.slice(start, src.indexOf('export interface InstanceHandle'))
    return [...body.matchAll(/\| '([a-z-]+)'/g)].map((m) => m[1] ?? '')
  }

  it('앵커: 사유 유니온을 소스에서 실제로 뽑는다', () => {
    expect(reasons()).toContain('instance-active')
    expect(reasons().length).toBeGreaterThanOrEqual(5)
  })

  it('모든 사유가 계약 테스트에 등장한다(새 사유는 테스트 없이 못 들어온다)', () => {
    const spec = readFileSync(join(HERE, 'active-instance.test.ts'), 'utf8')
    expect(reasons().filter((r) => !spec.includes(`'${r}'`))).toEqual([])
  })
})

/** 공개 표면 exact 동치 — raw 프리미티브가 실수로 공개되면 계약 밖 경로가 생긴다(형제 선례 동형). */
describe('T5 구조층 — 공개 표면 exact 동치', () => {
  it('active-instance.ts 값 export 3개', () => {
    expect(Object.keys(activeInstance).sort()).toEqual([
      'ACTIVE_INSTANCE_FILE',
      'claimActiveInstance',
      'decideReclaim',
    ])
  })

  it('instance-marker.ts 값 export 3개(순수 함수·술어만)', () => {
    expect(Object.keys(instanceMarker).sort()).toEqual([
      'composeMarker',
      'isMarkerForm',
      'parsePid1StartTicks',
    ])
  })

  it('instance-marker-proc.ts 값 export 4개(팩토리 + 경로 상수 3)', () => {
    expect(Object.keys(instanceMarkerProc).sort()).toEqual([
      'BOOT_ID_PATH',
      'PID1_STAT_PATH',
      'PID_NS_PATH',
      'createProcMarkerSource',
    ])
  })
})

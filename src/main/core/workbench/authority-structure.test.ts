import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #251 PR2a — 계약 사슬 골격의 **구조층**(§3-T62 D-9 분 · 계획 정정 75).
 *
 * 행동 테스트가 못 잡는 두 가지를 여기서 고정한다: ⓐ「하지 않음」(장기 핸들·직접 fs) ⓑ「크기」.
 * 둘 다 회귀 가드이므로 처음부터 GREEN 이다 — 그래서 **각 술어에 자기검사 앵커를 붙인다**. 앵커가 없으면
 * 오타 하나로 술어가 아무것도 매칭하지 않게 되어도 영원히 GREEN 이다(레포가 #137·#173 에서 물린 계열).
 */

const HERE = import.meta.dirname
const source = (file: string): string => readFileSync(join(HERE, file), 'utf8')

/** 블록·라인 주석 제거 — 주석 속 문자열이 위반으로 오탐되지 않게(형제 구조 테스트와 같은 술어). */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * **D-9 리더 규율**(§W-4:485-486). 권위·저널 파일은 `readFileSync` 즉시-close 만 허용한다. 장기 핸들·
 * `createReadStream`·`watch` 는 그 자체가 **타 표면의 쓰기를 EPERM 으로 무한 차단하는 DoS 표면**이다 —
 * win32 는 대상에 열린 핸들이 하나라도 있으면 rename 이 EPERM 이고(3면 실측), 그 rename 이 곧 CAS 커밋이다.
 */
describe('D-9 리더 규율 — 권위 경로는 장기 핸들을 만들지 않는다', () => {
  const LONG_HANDLE = /\b(?:createReadStream|createWriteStream|watchFile|watch)\s*\(/

  it.each(['authority.ts', 'durable-fs.ts'])('%s 에 장기 핸들 생성이 없다', (file) => {
    expect(stripComments(source(file))).not.toMatch(LONG_HANDLE)
  })

  it('앵커: 술어가 실제 위반 형태를 잡는다', () => {
    for (const sample of [
      'const s = createReadStream(p)',
      'fs.watch(dir, cb)',
      'watchFile(p, cb)',
      'createWriteStream(p)',
    ]) {
      expect(sample).toMatch(LONG_HANDLE)
    }
    // 음성 통제 — 허용된 관용구는 잡히지 않는다.
    expect('readFileSync(path, "utf8")').not.toMatch(LONG_HANDLE)
  })
})

/**
 * **IO 전량 주입**(§W-5:531). 권위 층이 `node:fs` 를 직접 import 하면 실패 주입이 `vi.spyOn(node:fs)` 로
 * 밀려나는데, 그것은 win32 ESM 에서 조용히 skip 되어(실측 선례 `ignored-baseline.test.ts:142-149`)
 * 단계별 실패 테스트 전체가 **false-GREEN** 이 된다. 즉 이 단언이 깨지면 PR2b 의 §3-T16 이 무의미해진다.
 */
describe('authority.ts — 파일시스템을 알지 못한다', () => {
  const fsLike = /(?:from\s*|require\(\s*|import\(\s*)['"](?:node:)?fs(?:\/promises)?['"]/

  it('fs 를 어떤 표기로도 import 하지 않는다', () => {
    expect(source('authority.ts')).not.toMatch(fsLike)
  })

  it('앵커: 술어가 실제 import 를 잡는다(형태별 자기검사)', () => {
    for (const sample of [
      "import { readFileSync } from 'fs'",
      "import x from 'node:fs'",
      "const x = require('fs')",
      "await import('node:fs/promises')",
    ]) {
      expect(sample).toMatch(fsLike)
    }
    // 대조: 실 어댑터는 fs 를 써야 하므로 같은 술어가 그 파일에서는 **매칭돼야** 한다(술어 생존 확인).
    expect(source('durable-fs.ts')).toMatch(fsLike)
  })
})

/**
 * 브랜드 심볼은 **미export** 여야 한다(§W-4:350). export 되면 다른 모듈이 정상 문법으로 토큰을 조립할 수
 * 있어 「CAS 성공 시에만 존재」가 무너진다 — eslint `no-unsafe-type-assertion` 은 캐스트를 잡지 캐스트
 * 없는 조립을 잡지 못한다.
 */
describe('브랜드 심볼 — 미export 가 계약이다', () => {
  it.each(['FRESH_READ', 'AUTHORITY_COMMIT'])('%s 는 export 되지 않는다', (name) => {
    const src = stripComments(source('authority.ts'))
    expect(src).toMatch(new RegExp(String.raw`declare const ${name}: unique symbol`))
    expect(src).not.toMatch(new RegExp(String.raw`export\s+declare\s+const\s+${name}\b`))
    expect(src).not.toMatch(new RegExp(String.raw`export\s*\{[^}]*\b${name}\b`))
  })
})

/**
 * **실 어댑터는 얇아야 한다**(계획 정정 75). 이 파일의 플랫폼 전용 행은 반대편 OS 의 **분모에만** 들어가므로
 * (POSIX `openDir` ↔ win32 rename 재시도), 규칙이 여기로 새면 커버리지 손실이 양방향으로 커진다.
 * 상한을 **절대 물리행**으로 두는 이유는 백분율이 분모 이동에 따라 조용히 늘어나기 때문이다(정정 ㉙ 승계).
 */
describe('durable-fs.ts — 실 어댑터 두께 상한', () => {
  it('전체 물리행이 상한(240) 이내다', () => {
    expect(source('durable-fs.ts').split('\n').length).toBeLessThanOrEqual(240)
  })

  it('주석을 뺀 코드 행이 상한(120) 이내다 — 규칙이 어댑터로 새지 않았다', () => {
    const code = stripComments(source('durable-fs.ts'))
      .split('\n')
      .filter((l) => l.trim().length > 0)
    expect(code.length).toBeLessThanOrEqual(120)
  })
})

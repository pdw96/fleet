import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #197 B3: 서버 번들(out/server)은 컨테이너 전용 — 데스크톱 asar 에 실리면 무의미한 비대화이고,
// files 글롭이 조용히 되돌아가도 빌드는 green 이라 무신호다 → 설정 텍스트로 핀한다.
describe('electron-builder 패키징 제외 핀(#197 B3)', () => {
  it('files 가 out/server 를 제외한다', () => {
    const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
    expect(yml).toMatch(/!out\/server\/\*\*/)
  })
})

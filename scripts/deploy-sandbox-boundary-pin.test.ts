import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #214 C4: FLEET_SANDBOX_BOUNDARY compose 라인·`.env.example` 문서화가 유실되면 부팅은 **정상 성공**
// 하고(미설정 → 코드 기본 cli) 런타임에 codex bubblewrap(user namespace) 에러로만 발현한다 = #214
// 원증상 재현·진단 고비용(judge B 가 "compose 핀 절삭" 안을 REFUTED 한 근거). electron-builder-pin
// 동형으로 설정 텍스트를 핀해 이 무신호 회귀를 막는다.
describe('deploy: FLEET_SANDBOX_BOUNDARY 배선 핀(#214 C4)', () => {
  it('docker-compose.yml fleet 서비스가 컨테이너 기본 container 로 경계를 세팅한다', () => {
    const yml = readFileSync(new URL('../deploy/docker-compose.yml', import.meta.url), 'utf8')
    expect(yml).toMatch(/FLEET_SANDBOX_BOUNDARY:\s*\$\{FLEET_SANDBOX_BOUNDARY:-container\}/)
  })

  it('.env.example 의 운영자 기본값 라인이 container 로 핀된다(값 드리프트도 RED)', () => {
    const env = readFileSync(new URL('../deploy/.env.example', import.meta.url), 'utf8')
    // 값 라인 exact 핀 — `/container/`(부분문자열)은 상단 주석의 "container" 에도 매치돼 기본값이 =cli 로
    // 뒤집혀도 GREEN(무신호). 값까지 잠가 .env.example 기본값 드리프트를 RED 로 잡는다(적대리뷰 P3 반영).
    expect(env).toMatch(/^FLEET_SANDBOX_BOUNDARY=container\s*$/m)
  })
})

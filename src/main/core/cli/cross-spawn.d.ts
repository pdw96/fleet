// @types/cross-spawn 미설치 대응 — child_process.spawn 과 동일 시그니처.
// Windows 에서 .cmd/.bat 셰임을 PATHEXT 로 찾고 인자를 안전하게 이스케이프해 실행한다.
declare module 'cross-spawn' {
  import type { ChildProcess, SpawnOptions } from 'node:child_process'
  function spawn(command: string, args?: readonly string[], options?: SpawnOptions): ChildProcess
  export default spawn
}

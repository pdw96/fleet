# CLI 세션 워크스페이스 cwd shadow 하드닝 — 설계 (#158)

> 백로그 #158 (#145 항목5 = PR #157 Codex P1 후속). #157 은 picker **표시 한계**를 UI/spec 고지로 한정했고
> ([2026-06-28-cli-resolved-path-design.md](./2026-06-28-cli-resolved-path-design.md) §2·§10·§12a),
> 이 스펙은 **실행계층 하드닝**을 분리해 다룬다. 근거: PR #157 Codex P1 인라인.

## 1. 배경 / 문제

`src/main/core/session/cli-session.ts` 의 `execute()` 는 모든 CLI 세션 spawn(스테이트리스·스테이트풀·편집·스트리밍)을
한 지점에서 수행하며 **bare `adapter.command`**(`claude`/`codex`/`gemini`)를 `runner(command, …, { cwd: sendOpts.workspace })`
로 실행한다(L120-130 스트리밍 분기·L144-149 비스트리밍 분기).

실행기 `defaultRunner`(`detect.ts`)는 `cross-spawn` 으로 spawn 한다. **실측(repo `node_modules` 의 which/cross-spawn
으로 검증)으로 정확한 실행 메커니즘을 확정했다** — 처음 가정과 달리 최종 cwd-vs-PATH 해석은 `which` 가 아니라
**`cmd.exe` 가** 한다:

1. cross-spawn `parse.js`(L12-25·L49-58): bare command 를 `resolveCommand`(내부 `process.chdir(cwd)` + `which.sync`)
   로 해석하지만 그 **resolved 경로(`parsed.file`)는 `needsShell` 판정·shebang 감지에만** 쓴다. `.cmd` 는 실행
   확장자(.com/.exe)가 아니라 `needsShell=true` → cmd.exe 경유 실행으로 분기.
2. 이때 `parsed.command` 은 **여전히 bare** 다(`detectShebang` 은 `parsed.file` 만 set·`parsed.command` 미변경).
   따라서 cross-spawn 은 `cmd.exe /d /s /c "<bare command>"` 를 **cwd=워크스페이스** 로 spawn 한다.
3. **그 bare 를 해석하는 것은 cmd.exe** 다. cmd.exe 는 기본적으로 **현재 디렉터리(=워크스페이스)를 PATH 보다 먼저**
   검색한다 → 워크스페이스 내 `claude.cmd`/`codex.cmd`/`gemini.cmd` 가 우선 실행된다.

→ 사용자가 **신뢰할 수 없는 레포를 워크스페이스로 열고** 거기에 동명 `*.cmd`(npm 셰임과 동형)를 두면 edit/project
send 시 **워크스페이스 내 악성 바이너리가 실제 실행**된다. Fleet 의 핵심 용도(워크스페이스 에이전트 실행)에서 실재하는
코드실행 벡터이고, 출하 런타임 = Windows([[fleet-runtime-node-version]]). 실제 CLI 는 npm `.cmd` 셰임이라 이 cmd.exe 경로가 항상 탄다.

**핵심 관측(실측 확정):**
- **벡터는 `NoDefaultCurrentDirectoryInExePath` 환경변수로 게이팅**된다. 이 변수가 set 이면 cmd.exe 가 cwd 를
  검색하지 않아 셰도가 무력화된다. 그러나 이 변수는 **Windows 기본값이 아니다**(User/Machine 레지스트리 비어 있고
  일부 셸/하니스만 Process 스코프로 주입). **일반 사용자가 탐색기/시작메뉴로 Electron 앱을 띄우면 미설정 → 취약.**
  (⚠️ **CI/개발 하니스엔 이 변수가 상속돼 있어 셰도가 마스킹**된다 — §5 테스트는 이를 제거해 취약 환경을 재현해야 한다.)
- **POSIX 는 안전** — cross-spawn 이 비-Windows 에선 cmd.exe 로 감싸지 않고(`parseNonShell` 의 `if(!isWin) return`),
  Node spawn 의 bare 해석은 `execvp`(PATH 기준, cwd 미검색)다. cwd 옵션은 자식 작업디렉터리만 바꾼다.
- **이미 절대경로면 무력화**: 절대경로를 spawn 에 넘기면 cross-spawn 이 `parsed.command` 을 그 절대경로로 두어
  `cmd.exe /c "<abs>.cmd"` 를 띄우므로 cmd.exe 가 cwd 를 거치지 않고 그 파일을 실행한다(실측: PATH 바이너리 실행 확인).

→ 벡터 성립 조건 = **`isWindows` ∧ custom `cwd` 지정 ∧ bare(비절대) command**. 이 교집합만 차단하면 된다.

> 실측 근거 전문: [#158 issuecomment-4826455004](https://github.com/pdw96/fleet/issues/158#issuecomment-4826455004).

## 2. 목표 / 비목표

**목표** — CLI 세션 실행이 **cwd-독립**이 되도록, custom cwd(워크스페이스) spawn 에서 bare command 를
**PATH-only 절대경로**로 미리 해석해 그 절대경로로 실행한다. 워크스페이스(또는 어떤 cwd)에 심긴 동명 바이너리가
실제 PATH 의 CLI 를 가로채는 것을 막는다.

**비목표**
- **picker 표시(#157) 변경 없음.** 등록 시점 picker 는 워크스페이스가 없어 앱 cwd/PATH 기준으로 해석하며,
  shadow 위험을 **경고**한다. 본 스펙의 **실행시점 거부**와 상보적 — 표시(경고)는 그대로 둔다.
- **비워크스페이스 send 동작 변경 없음.** `sendOpts.workspace` 가 없으면 cross-spawn 에 custom cwd 가 없어
  벡터가 성립하지 않는다(앱 cwd 기준 해석 = #157 이 picker 에서 경고하는 더 낮은 위험). 본 스펙은 건드리지 않는다.
- **detect 버전 프로브 변경 없음.** `detectCli` 의 `runner(adapter.command, versionArgs, {timeoutMs})` 는 cwd 가
  없으므로 게이트(아래 §3 D2)에 걸리지 않는다 → 무변경(설치 탐지 UX 보존).
- **POSIX 동작 변경 없음**(§1 — 이미 안전).
- 심볼릭링크 realpath 추적·CLI 평판 allowlist 없음(#157 과 동일 한계).

## 3. 결정 (D1~D6)

- **D1 — Seam = `defaultRunner`(spawn 프리미티브).** 해석을 `cli-session.execute()` 가 아니라 실행기
  `defaultRunner` 안에서 한다. 근거: `session.test.ts` 의 ~30개 테스트가 **mock `runner` 를 주입**하는데, 이들은
  `defaultRunner` 를 **우회**하므로 해석 로직이 이들이 보는 `command` 인자를 바꾸지 않는다(테스트 무영향). 프로덕션은
  `engine.ts` L190 `opts.runner ?? defaultRunner` 로 항상 `defaultRunner` 를 쓴다 → 프로덕션 하드닝 성립.
  기각: `execute()` seam(테스트가 보는 command 가 절대경로로 바뀌어 `command==='claude'` 단언 대량 회귀).
- **D2 — 게이트 = `isWindows ∧ opts.cwd != null ∧ 비절대 command`.** 벡터 성립 교집합과 정확히 일치(§1). 그 외
  (POSIX·cwd 없음·이미 절대경로)는 해석을 건너뛰어 기존 동작 보존. `isWindows` 정의는 which 의 것과 일치
  (`win32`/cygwin/msys)시켜 "벡터가 있는 곳에서만 막는다" 불변식을 맞춘다.
- **D3 — PATH-only 해석 = `which(cmd,{all:true})` + cwd-내부 매치 제외.** which 는 cwd 를 무조건 prepend 하므로
  cwd 제외 옵션이 없다. `{all:true}` 로 `[cwd?, …PATH]` 전체 매치를 받아 **dirname 이 현재 process cwd 인 매치를
  걸러** 첫 PATH 매치를 고른다. 해석은 cross-spawn 의 chdir **전**(앱 컨텍스트, `process.cwd()`=앱 cwd)에 수행되므로
  워크스페이스는 애초에 후보에 없고, 추가로 앱 cwd 매치를 걸러 **순수 PATH 절대경로**를 얻는다(= app-cwd shadow 까지 차단).
  같은 `which` 재사용 → 표시(#157, `defaultResolver`)와 동일 해석 계열 유지. 병든 PATH(스테일 네트워크 마운트)
  대비 기존 `RESOLVE_TIMEOUT_MS`(2s) race 패턴 재사용.
- **D4 — 해석 실패(null) = 보안 거부.** PATH 에서 못 찾으면(앱 cwd/워크스페이스에만 존재 포함) `spawn` 하지 않고
  `CommandResult { code: null, spawnError: 'ENOENT' }` 를 반환한다. **cwd 는 고의로 미조회**하므로 "cwd 에만 있는
  바이너리는 실행하지 않는다"는 보안 불변식이 성립. 기존 `assertRunOk`(`cli-session.ts`)가 `spawnError` 를 그대로
  표면화(`${command} 실행 실패: ENOENT`). 신규 에러 분기 0.
- **D5 — 절대경로 short-circuit.** command 가 `path.isAbsolute` 면 해석 없이 그대로 사용. 근거: `detect.test.ts` 의
  기존 win32 테스트들(L250 `echoarg.cmd`·L287 `sleeper.cmd`)이 **절대 `.cmd` 경로 + cwd** 로 호출 → short-circuit
  으로 무변경 보장. 절대 `.cmd` 의 cross-spawn 실행(PATHEXT·cmd.exe 라우팅·인자 이스케이프)은 기존 검증된 경로 그대로.
- **D6 — ADR 불요.** 국소 실행계층 보안 결정·#157 §6a/§10 보안 계약이 영역 지배·신규 신뢰경계/IPC/저장포맷 변경 없음.
  보안 불변식은 본 스펙 §6 에 명시.
- **D7 — Fix A(절대경로 해석) 채택 vs Fix B(env 변수 주입).** 실측이 연 분기: 변수 게이팅을 역이용해 자식 env 에
  `NoDefaultCurrentDirectoryInExePath=1` 을 주입하는 Fix B 가 ~2줄로 `.cmd` 위협을 막는다. **Codex 코딩-전 리뷰는
  Fix B 를 독립 추천**([issuecomment-4826477…] 계열, "inherited empty value override" 디테일 포함). **사용자는
  defense-in-depth 를 우선해 Fix A 선택**(명시적 실행경로 고정·`.cmd`+`.exe` 공통·"표시=실행" 불변식·OS 변수 의존
  제거). Fix B 는 cmd.exe 셰임 한정·암묵적 OS 변수 의존이 단점. (참고: Codex 가 코멘트로 알린 `1837a43` 커밋·후속
  PR 은 **샌드박스 유령** — GitHub 미랜딩·자체 테스트 BLOCKED 확인, 폐기. [[codex-cloud-phantom-commits]].)

## 4. 구현 (`src/main/core/cli/detect.ts`)

해석 헬퍼(`resolveCommandPath` 인근, `which` 직접 의존 재사용):

```ts
// which 의 isWindows 정의와 일치(cwd-prepend 가 실제로 일어나는 플랫폼). 이 교집합에서만 벡터가 성립.
const isWindowsLike =
  process.platform === 'win32' || process.env.OSTYPE === 'cygwin' || process.env.OSTYPE === 'msys'

/**
 * PATH-only 절대경로 해석기 — custom cwd spawn 의 cwd-셰도 차단용(#158).
 * which({all}) 로 [cwd?, …PATH] 전체 매치를 받아 **현재 process cwd 내부 매치를 제외**한 첫 PATH 매치를 반환.
 * - 이미 절대경로면 그대로(호출자 해석 완료).
 * - not-found(전부 cwd 내부거나 0매치)·예외·타임아웃 → null(호출자가 보안 거부).
 * which 는 cross-spawn 의 chdir 전(앱 컨텍스트)에 호출되므로 워크스페이스는 후보에 없다.
 */
export type AllResolver = (command: string) => Promise<string[]>
const defaultAllResolver: AllResolver = (command) => which(command, { all: true })

export async function resolvePathOnly(
  command: string,
  resolver: AllResolver = defaultAllResolver,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<string | null> {
  if (path.isAbsolute(command)) return command
  // which 의 cwd 스냅샷(호출 시점 process.cwd())과 필터 기준을 일치시키려 await 전에 캡처
  // (다른 spawn 의 cross-spawn chdir 은 동기 복원이라 실제 경합은 없으나 명시적 일관성 확보).
  const cwd = path.resolve(process.cwd())
  let matches: string[] | null
  try {
    matches = await Promise.race([
      resolver(command).catch(() => [] as string[]),   // 비동기 which 는 not-found 시 reject → [] 정규화
      new Promise<null>((r) => setTimeout(() => r(null), timeoutMs).unref?.()),
    ])
  } catch {
    return null
  }
  if (!matches) return null               // 타임아웃
  const outsideCwd = matches.find((m) => {
    const dir = path.resolve(path.dirname(m))
    return isWindowsLike ? dir.toLowerCase() !== cwd.toLowerCase() : dir !== cwd
  })
  return outsideCwd ?? null
}
```

`defaultRunner` 가드(spawn 직전, executor 를 async 로 감싸 해석 후 spawn):

```ts
export const defaultRunner: CommandRunner = async (command, args, opts, onStdout) => {
  // 워크스페이스(custom cwd) Windows spawn 은 cross-spawn 이 bare 를 cmd.exe 로 넘기고 cmd.exe 가 cwd 를 PATH 보다
  // 먼저 검색하므로, bare command 를 PATH-only 절대경로로 미리 해석해 cwd-셰도(워크스페이스 내 악성 claude.cmd) 실행을 차단(#158).
  let resolved = command
  if (isWindowsLike && opts.cwd != null && !path.isAbsolute(command)) {
    const abs = await resolvePathOnly(command)
    if (abs == null) return { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }
    resolved = abs
  }
  return new Promise<CommandResult>((resolve) => {
    /* …기존 본문, spawn(resolved, …) … */
  })
}
```

> `defaultRunner` 를 async 함수로 바꾸되 반환은 여전히 `Promise<CommandResult>` 라 `CommandRunner` 계약 불변.
> 기존 Promise executor 본문은 그대로 안쪽으로 이동.

## 5. 테스트 (TDD)

- **⚠️ 테스트 전제 — 취약 환경 재현(필수)**: CI/하니스엔 `NoDefaultCurrentDirectoryInExePath` 가 상속돼 cmd.exe 가
  cwd 를 안 뒤져 **셰도가 마스킹**된다(실측). win32 통합 테스트는 spawn 직전 `process.env` 에서 이 변수를 **삭제**해
  (대소문자 변형 포함, save→delete→`finally` 복원) 일반 사용자 환경을 재현해야 한다. 안 하면 미수정 코드도 통과하는
  **false-GREEN** 이 된다. (이 변수 자체가 OS 하드닝이라 제거는 *테스트에서만* — 프로덕션 fix 는 절대경로 해석으로 독립.)
- **RED(win32, 핵심)** — `detect.test.ts` 신규 `describe.skipIf(process.platform!=='win32')('cwd shadow 하드닝')`:
  temp `bin/` 에 `shadow.cmd`(echo `PATH-MARKER`)를 두고 `process.env.PATH` 앞에 추가, temp `ws/`(워크스페이스)에도
  `shadow.cmd`(echo `CWD-MARKER`)를 둔다. **위 전제대로 변수 제거 후** `defaultRunner('shadow', [], { cwd: ws })`
  출력이 **`PATH-MARKER`** 여야 한다(미수정 시 `CWD-MARKER` → RED — 실측으로 RED/GREEN 양상 사전 확정).
- **보안 거부** — (변수 제거 상태) PATH 에 없고 `ws/` 에만 `shadow.cmd` 가 있을 때 `defaultRunner('shadow', [], {cwd: ws})`
  → `spawnError === 'ENOENT'`(cwd 바이너리 미실행).
- **절대경로 short-circuit** — 절대 `.cmd` 경로 + cwd → 해석 건너뛰고 그 경로 실행(기존 L250/L287 회귀 보존 확인).
- **플랫폼 무관 단위** — `resolvePathOnly` 를 `AllResolver` 주입으로 검증: `['<cwd>/x','/usr/bin/x']` → `/usr/bin/x`
  선택, `['<cwd>/x']` 단독 → null, `[]` → null, 절대경로 입력 → 그대로.
- **무회귀** — 기존 `'runs the child in the given cwd'`(node+cwd, 비-gated)·`.cmd shim`·트리킬·stdin·ENOBUFS 테스트
  green 유지(node 는 PATH 해석되어 통과; cwd 없는 spawn·절대경로 spawn 은 게이트 미적용).

## 6. 보안 불변식

1. **custom cwd Windows 세션 spawn 은 PATH 해석 절대경로로만 실행**한다 — cwd(워크스페이스/앱)에 심긴 동명
   바이너리는 절대 실행되지 않는다.
2. PATH 에서 못 찾으면 **실행을 거부**(ENOENT)한다 — cwd fallback 으로 셰도를 실행하지 않는다.
3. 비-Windows·cwd 없는 spawn·이미 절대경로인 command 는 **무변경**(불필요한 동작 변화·성능 부담 회피).
4. 표시(picker, #157)와 실행(본 스펙)은 같은 `which` 해석 계열을 써 **"보이는 위험 = 막는 위험"** 정합을 유지한다.

## 7. 영향 / 위험

- **동작 변경 1건(의도)**: win32 워크스페이스 send 에서 CLI 가 PATH 에 없고 cwd/워크스페이스에만 있으면 실행 거부
  (ENOENT). 이것이 차단 대상이므로 보안상 정당. "PATH 미설치·워크스페이스 전용 CLI" 라는 비정상 워크플로만 영향(희소).
- 성능: 워크스페이스 send 당 `which` PATH 워크 1회(stat 수회, 보통 sub-ms) — 뒤따르는 CLI 실행 대비 무시 가능.
  병든 PATH 는 2s race 로 상한.
- 의존성 변화 0(`which` 는 #157 에서 이미 직접 의존 승격).

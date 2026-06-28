# CLI resolved-path 표시 (PATH shadowing 탐지) — 설계 (#145 항목5)

> 백로그 #145 후속 항목5. 근거 계약 = 머지된 스펙 `docs/superpowers/specs/2026-06-25-session-auth-picker-design.md` **§6a** 마지막 줄: *"PATH shadowing 고지 … v1은 version/name 감지만, **후속으로 resolved path 표시 고려**."* — 이 스펙이 그 후속.
>
> 설계 체크포인트(코딩 전) Codex 독립 리뷰 **승인** + 5보강 반영: [#145 issuecomment-4825835589](https://github.com/pdw96/fleet/issues/145#issuecomment-4825835589). 본 스펙 §11 참조.

## 1. 배경 / 문제

`src/main/core/cli/detect.ts`의 `detectCli`는 `cross-spawn`으로 `adapter.command + versionArgs`를 실행해 **설치 여부·버전·원본출력·에러만** 보고한다(`CliDetectionResult`). **실제로 어떤 바이너리가 실행되는지(절대경로)는 노출하지 않는다.** 따라서 악성 `claude`/`codex`/`gemini`가 사용자 PATH 앞쪽에 끼어들어도(= PATH shadowing) 사용자가 picker에서 알아챌 수단이 없다.

실행기 `cross-spawn`(직접 의존 `^7.0.6`)은 내부적으로 **`which@2`**로 명령을 해석한다(lockfile 검증: `cross-spawn@7.0.6` → `which: ^2.0.1`, hoisted `node_modules/which@2.0.2`).

## 2. 목표 / 비목표

**목표** — picker 구독 단계에서 각 CLI의 **실제 실행될 절대경로를 표시**해 사용자가 PATH shadowing을 **눈으로 검증**하게 한다. 상대/CWD PATH 엔트리로 해석되는 명백한 shadow 벡터는 경고한다.

**비목표(정직한 한계 — Codex 보강)**
- **전체 shadow 탐지 아님.** 절대경로 디렉터리(예: `/tmp/evil/claude`, `C:\Users\me\bin\gemini.cmd`)에 심긴 shadow는 `path.isAbsolute`가 true라 **자동 판정하지 않는다.** 사용자가 `resolvedPath`를 직접 보고 판단한다.
- CLI별 "예상 설치 위치" 평판 판정·allowlist 없음(npm/volta/fnm/homebrew 등 정당 위치가 너무 다양 → false-positive·유지보수 부담).
- 심볼릭링크 realpath 추적 없음(which가 주는 PATH 해석 경로 = 실제 실행 경로 = 정직한 답).
- 차단 게이트 아님 — 표시/advisory UX. 경고 중에도 등록 허용.

## 3. 결정 (D1~D7)

- **D1 — 해석 = `which` 재사용(직접 의존성 승격).** cross-spawn이 실제로 쓰는 동일 계열 resolver를 직접 의존으로 명시(`which(cmd,{nothrow:true})`) → **표시 경로 = 실제 실행 경로** 정직성 확보. 기각: zero-dep 자체 PATH/PATHEXT 워커(해석 규칙이 cross-spawn과 1%라도 어긋나면 "실행되는 것과 다른 경로"를 보안 기능에서 표시 = 더 나쁜 보안 UX).
- **D2 — 표시 = 경로 항상 표시 + 상대 PATH·cwd 히트 경고 플래그.** "shadow 탐지"가 아니라 **"resolved path 표시 + 상대 PATH/cwd 위험 플래그"**로 정직하게 명명(Codex 보강). **cwd 히트도 플래그**: which@2 가 Windows(+cygwin/msys)에서 PATH 보다 cwd 를 먼저 검색해 cwd shadow 를 절대경로로 반환하므로 `path.isAbsolute` 만으로는 못 잡는다(PR Codex P2). UI 문구 3단(§7).
- **D3 — 보안 판정은 main(신뢰경계)에서.** `path.isAbsolute` 계산을 main에서 수행, **boolean만** renderer로 송출. renderer는 cross-platform 절대경로 판정 안 함.
- **D4 — 신규 IPC 0.** `CliDetectionResult`에 optional 2필드 추가 → 기존 `fleet:cli:detect`(`detectClis`) 결과에 실려감. 직렬화 안전·하위호환(기존 소비자는 optional 필드 무시).
- **D5 — 경고 비차단.** §8(앞 스펙) "위험 배너 강행 허용" 일관. 등록 비차단.
- **D6 — 방어적 해석 + 동시 실행.** 비동기 `which` 는 `{nothrow}` 를 무시하고 not-found 시 reject 하므로 `defaultResolver` 가 catch→null 로 정규화(계약 `null = not-found`). `resolveCommandPath` 는 예외·null·**타임아웃** 모두 빈 객체로 흡수해 **`which` 가 실패하거나 멈춰도 `--version` 감지를 깨거나 매달지 않는다**(resolved-path는 부가 정보 — 표시용 해석은 자체 타임아웃으로 상한). 버전 spawn과 `Promise.all` 동시 실행(추가 지연 0). `installed:true & 경로 미해석`(드문 불일치, 예: Windows App Paths) → `resolvedPath` undefined·`pathShadowRisk` undefined → UI "확인할 수 없음".
- **D7 — ADR 불요.** 국소 기능 결정·§6a 보안 계약이 영역 지배·신규 신뢰경계/IPC/저장포맷 변경 없음(Codex 동의). 대신 §10 보안 불변식을 본 스펙에 명시.

## 4. 데이터 모델 (`src/shared/types.ts`)

`CliDetectionResult`에 optional 2필드 추가:

```ts
export interface CliDetectionResult {
  // ...기존...
  /** which 해석된 실제 실행 경로(보통 절대; 상대 PATH 해석 시 비절대 — pathShadowRisk 참조). 미설치/미해석 시 undefined. 표시 전용. */
  resolvedPath?: string
  /** resolvedPath 가 비절대(상대/CWD PATH 엔트리)로 해석된 경우 true — 상대 PATH shadow 위험. main 에서 path.isAbsolute 로 판정. */
  pathShadowRisk?: boolean
}
```

## 5. main 해석 (`src/main/core/cli/detect.ts`)

- `import which from 'which'` (직접 의존 승격).
- resolver 타입 + DI(테스트 주입; 기존 `runner` DI 패턴 동형):

```ts
export type PathResolver = (command: string) => Promise<string | null>
// 비동기 which 는 {nothrow} 를 무시하고 not-found 시 reject → catch→null 로 정규화(계약: null = not-found).
const defaultResolver: PathResolver = async (command) => {
  try {
    return await which(command)
  } catch {
    return null
  }
}
```

- 순수 헬퍼(표시용 해석에 자체 타임아웃 상한 — 병든 PATH 순회가 detectCli 를 매달지 않게):

```ts
const RESOLVE_TIMEOUT_MS = 2000

export async function resolveCommandPath(
  command: string,
  resolver: PathResolver = defaultResolver,
  timeoutMs = RESOLVE_TIMEOUT_MS,
): Promise<{ resolvedPath?: string; pathShadowRisk?: boolean }> {
  try {
    const p = await Promise.race([
      resolver(command),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs).unref?.()
      }),
    ])
    if (!p) return {}
    return path.isAbsolute(p) ? { resolvedPath: p } : { resolvedPath: p, pathShadowRisk: true }
  } catch {
    return {} // 경로 해석 실패가 탐지 자체를 깨지 않게 한다(D6)
  }
}
```

- `detectCli(adapter, runner, timeoutMs, resolver = defaultResolver)`: 버전 spawn과 `resolveCommandPath`를 `Promise.all` 로 동시 실행, 결과 병합. `spawnError`(미설치)여도 resolver 호출은 무해(null 반환) — 단, 미설치면 어차피 경로 미표시.

## 6. IPC

**신규 채널 0.** `resolvedPath`/`pathShadowRisk`는 기존 `detectClis()`(`fleet:cli:detect`) 결과에 실려 renderer 로 전달. preload/main IPC 표면 무변경.

## 7. UI (`src/renderer/components/AddAiWizard.tsx`) — 문구 3단 (Codex 보강)

구독 단계 `installed === true` CLI 카드 근처:

1. **항상 경로 표시**(`<code>`/plain text — 클릭/실행 버튼 없음):
   - `resolvedPath` 있으면 → `실행 경로: <resolvedPath>`
   - `installed` 인데 `resolvedPath` 없으면(D6) → `실행 경로: 확인할 수 없음`
2. **`pathShadowRisk === true` 일 때만 강한 경고**(`role="alert"`): `현재 작업 디렉터리(cwd) 또는 상대 PATH 항목에서 해석되었습니다 — 의도하지 않은 실행 파일로 바꿔치기될 수 있습니다(PATH shadowing).`
3. **항상 낮은 강도 보조문구**: `의도한 공식 CLI 설치 경로인지 확인하세요.`

경고는 **비차단**(D5) — 등록 버튼 계속 활성. 미설치 흐름·기존 stateful/모델/MCP 입력 전부 불변.

## 8. 에러 / 엣지

- which not-found(비동기 reject) → defaultResolver catch→null → 필드 undefined.
- which 예외 → 삼킴, 탐지 정상.
- **which 멈춤(병든 PATH 순회) → 타임아웃(2s)으로 빈 객체, 탐지 비차단**(표시용 해석이 detectCli 를 매달지 않음).
- `installed:true & 경로 미해석` → 경로 "확인할 수 없음", 크래시 없음.
- 비절대 해석 → `pathShadowRisk:true` + 강한 경고.
- TOCTOU(spawn↔which 별도 호출): advisory 로 수용(D6) — "현재 PATH 해석 기준" 정보 제공이지 차단 게이트 아님.

## 9. 테스트

- **`detect.test.ts`**(runner+resolver 둘 다 mock 주입):
  - 절대경로 해석 → `resolvedPath` 설정·`pathShadowRisk` 미설정.
  - 상대경로 해석(`'./claude'`, `'node_modules/.bin/codex'`) → `pathShadowRisk:true`.
  - resolver null → 두 필드 undefined.
  - resolver throw → 삼킴(두 필드 undefined)·`installed`/`version` 정상.
  - 미설치(spawnError) → 경로 없음·기존 계약 불변.
- **`AddAiWizard.test.tsx`**:
  - `resolvedPath` 렌더(설치 카드).
  - `pathShadowRisk` 시 `role="alert"` 경고 렌더.
  - 절대경로 시 강한 경고 없음(보조문구는 유지).
  - `installed & resolvedPath` 없음 → "확인할 수 없음".
  - risk 여도 등록 버튼 비차단.
- 기존 직렬화/계약 단언 유지(함수 비포함).

## 10. 보안 불변식 (ADR 대체 기록 — Codex 보강)

- Fleet 은 resolved path 를 **표시만** 한다(클릭/실행/열기 버튼 없음, `dangerouslySetInnerHTML` 미사용 — React 기본 escape).
- `pathShadowRisk` 는 **상대 PATH 해석 + cwd 히트**(Windows which cwd-first 포함)를 경고한다. **그 외 절대경로 디렉터리에 심긴 shadow 는 자동 판정하지 않는다**(사용자 육안 검증 — 보조문구로 고지).
- 실제 실행과 **동일 계열 resolver(`which@2`, cross-spawn 의존 계열)** 를 사용한다.
- 보안 판정(`path.isAbsolute`)은 **main 에서만** 수행, renderer 는 boolean 만 받는다.
- `which` 실패해도 **detection 본 기능(설치/버전)은 깨지지 않는다.**
- `resolvedPath`(사용자명/home 포함 가능)는 로컬 사용자 본인에게만 표시 — **telemetry/log/LLM prompt 로 자동 전송하지 않는다.**

## 11. 의존성

- **deps**: `which ^2.0.2` 승격 — cross-spawn 이 의존하는 hoisted `which@2.0.2` 를 직접 import 가능하게 명시. (트리엔 다른 도구용 `which@4+` 중첩 사본이 별개로 존재하므로 "트리에 which 하나뿐"이 아니라 **"which@2 계열을 직접 사용"** 으로 이해 — Codex 정정. which@2 계열 자체는 중복 안 생김.)
- **devDeps**: `@types/which ^2.0.2`(which@2 는 번들 타입 없음). 기존 `safe-regex` + `@types/safe-regex` 선례 동형.
- `npm install` 로 lockfile 갱신.

## 12. Codex 설계 리뷰 반영 (2026-06-28, #145 항목5)

체크포인트 독립 리뷰 **승인 의견** 5보강 전량 반영:

1. **D2 정직성**(§2·§3·§7) — "shadow 탐지" → "resolved path 표시 + 상대 PATH 위험 플래그"로 명명. 절대경로 shadow 미탐지 한계를 비목표·보조문구로 명시.
2. **D1 의존성 framing**(§11) — "트리에 which 하나뿐" 과장 정정 → "which@2 계열을 직접 사용"·중복은 lockfile 로 확인.
3. **D6 `installed:true & which null`**(§5·§7·§8) — UI "확인할 수 없음", 탐지 비파괴.
4. **D3/D4 privacy**(§10) — 경로는 표시 전용(클릭/실행 없음)·telemetry/log/LLM 미전송·main 에서만 절대경로 판정.
5. **D7 ADR 불요**(§3·§10) — 동의, 대신 보안 불변식 6종을 §10 에 명시.

### 12a. PR 단계 봇 리뷰 반영 (2026-06-28, PR #157)

자체 4렌즈 적대리뷰 확정 2건 + CodeRabbit 인라인 3건 + Codex 인라인 1건 반영:
- **(자체)** 비동기 which `{nothrow}` 무시 → `defaultResolver` catch→null 정규화 / 스펙 §9 "비차단" 회귀 가드 테스트.
- **(CodeRabbit Major)** 표시용 `resolveCommandPath` 가 timeout 무바운드 → `Promise.race` 자체 타임아웃(2s)으로 detectCli 매달림 방지(§5·§8).
- **(CodeRabbit Minor×2)** types.ts `resolvedPath` 주석·spec D1/§5 예제를 async 실제 계약에 일치(§4·§5).
- **(Codex P2 — 보안)** which@2 Windows cwd-first 로 cwd shadow 가 절대경로로 위장 → **cwd 히트도 pathShadowRisk 플래그**(`isShadowRisk`, §3 D2·§7·§10). 출하 런타임=Windows 라 핵심 벡터.

## 13. 영향 파일

`src/shared/types.ts`(필드 2) · `src/main/core/cli/detect.ts`(`PathResolver`·`resolveCommandPath`·`detectCli` DI) · `src/renderer/components/AddAiWizard.tsx`(경로 표시·risk alert·보조문구) · `src/main/core/cli/detect.test.ts` · `src/renderer/components/AddAiWizard.test.tsx` · `package.json`/`package-lock.json`.

PR 본문 = **`Part of #145`**(5항목 묶음, 항목5만 — `Closes` 금지).

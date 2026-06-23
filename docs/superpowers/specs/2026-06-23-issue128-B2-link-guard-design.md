# #128-B2 설계 — 워크스페이스 격리: link-guard 하드닝 (advisory · Codex 리뷰 반영판)

> **이슈:** #128 (부모 #123·#27) · **선행:** #128-B1 머지(PR #129, `35a4b97`)
> **체크포인트:** 설계 코멘트 [#4775522688](https://github.com/pdw96/fleet/issues/128#issuecomment-4775522688) + Codex 독립 리뷰(이슈 #128 스레드, chatgpt-codex-connector 2026-06-23) 반영.
> **날짜:** 2026-06-23

## 배경 / 스코프

#128 §1 원안의 "프로세스 수준 워크스페이스 격리"(symlink/junction 차단 또는 강한 sandbox 경로로만 실행 + 순차→disposable worktree)를 세 갈래 결정으로 **advisory 하드닝**으로 재정의한다.

1. **위협모델 = 탐지·완화(advisory).** 주 위협 = 우발/게으른 워크스페이스 탈출. 결정적 적대자 보장은 **비목표**(문서화). OS/CLI 샌드박스 신규 배선 안 함.
2. **순차 실행 = 직접편집 유지.** disposable worktree 전환 안 함. advisory 모델에선 worktree로 옮겨도 적대자 보장이 안 생기고(worktree 밖 symlink 가능) UX·복잡도만 ↑.
3. **구현 = link-guard 하드닝 + helper 통일.** 그린필드 아님 — `workspace-tools.ts`엔 검증된 link-guard(`resolveWithin` realpath containment, `walk`의 Dirent symlink-skip)가 이미 있는데 `ignored-baseline.ts`만 `statSync`(링크 추종)로 이탈. B2 = 이탈한 쪽을 표준으로 끌어올리고 helper를 단일화.

**핵심 보안 동기.** 현재 `ignored-baseline`의 walk/capture/collect/restore가 전부 `statSync`(링크 추종)를 쓴다. 워크스페이스 안에 `~/.ssh/id_rsa`를 가리키는 ignored symlink/junction을 심으면 Fleet 자체가 그걸 따라가 `readFileSync`로 읽어 백업 Buffer에 담고, restore 시 `writeFileSync`/`rmSync`로 워크스페이스 밖에 쓰거나 지운다. B1의 non-regular 가드는 `statSync`가 링크를 따라가 `isFile()=true`로 보고하므로 이 벡터를 못 잡는다.

## Feasibility (GREEN — 실증 + 문서 검증)

win32 머신(Node v24.16.0 = Electron 42 런타임)에서 junction/symlink fixture 실증 + 3-에이전트 리서치(context7 Node 문서·containment prior art·CLI sandbox 지형)로 교차검증.

| 대상 | `lstat().isSymbolicLink()` | `statSync()`(링크 추종) | `realpath` | `Dirent.isSymbolicLink()` |
|---|---|---|---|---|
| **Windows junction**(admin 불요 생성) | ✅ `true`, isDir/isFile=false | `isDirectory()=true`(밖 추종) | 밖 target 해소 | ✅ `true` |
| 일반 파일 | false | isFile=true | 자기 자신 | false |

- **탐지 primitive 확정**: `lstat`/`Dirent`의 `isSymbolicLink()`가 POSIX symlink + Windows junction(reparse mount point) 둘 다 신뢰성 있게 잡는다(Node 18~24 안정 — libuv가 `IO_REPARSE_TAG_SYMLINK`·`IO_REPARSE_TAG_MOUNT_POINT`를 S_IFLNK로 매핑). junction은 admin 불요 생성 → win32 CI 실 fixture 가능.
- **주의**: junction↔symlink 구분 API 없음(둘 다 "링크"). OneDrive/AppExecLink 등 exotic reparse는 `lstat`가 EINVAL/UNKNOWN throw → try/catch로 `suspicious`(fail-closed).
- **containment**: lexical 비교는 symlink 비해소라 무력. `realpathSync.native(root)` 정준화(드라이브 케이스·8.3 단축명) + "최근접 존재 조상 realpath + 미존재 tail 재부착" + 정확 predicate + win32 case-fold가 검증된 공식(is-path-inside / node-tar / zip-slip).
- **TOCTOU**: 순수 Node로 완전차단 불가 — `O_NOFOLLOW`는 Windows에 없고(POSIX 전용·leaf만 보호), `openat2(RESOLVE_BENEATH)` 바인딩 없음. → advisory로 문서화.

## 컴포넌트 설계

### 0. 공유 helper — `src/main/core/workspace/path-guard.ts` (신규, sync)

```ts
// lstat 기반 링크/종류 판정. EINVAL/UNKNOWN(exotic reparse) → suspicious(fail-closed).
type LinkKind = 'regular' | 'dir' | 'link' | 'suspicious' | 'missing'
export function isLinkSync(abs: string): LinkKind

// realpath 기반 containment. 밖이면 throw. (workspace-tools·옵션으로 ignored-baseline 사용)
export function resolveWithin(root: string, p: string): string
// 비-throw 변형(skip+surface 용도)
export function escapesRoot(root: string, abs: string): boolean
```

- `isLinkSync`: `lstatSync(abs)` → `isSymbolicLink()`면 `link`; `isDirectory()`면 `dir`; `isFile()`이면 `regular`; catch에서 `err.code` ENOENT→`missing`, EINVAL/UNKNOWN→`suspicious`, 기타→`suspicious`(보수적).
- `resolveWithin` 알고리즘(Codex 권장 5단계):
  1. `realRoot = realpathSync.native(root)` (root가 symlink여도 정준 경로 기준 — **root realpath 기준 고정**, 아래 §정책).
  2. `abs = resolve(realRoot, p)`.
  3. `abs`에서 존재하는 최근접 조상까지 올라가 그 조상의 `realpathSync.native` 계산.
  4. 미존재 tail을 lexical로 재부착.
  5. `rel = relative(realRoot, realCandidate)` (win32은 양변 case-fold). predicate: `rel === ''` 허용 / `rel === '..'`·`rel.startsWith('..'+sep)`·`isAbsolute(rel)` 거부.
- `realpathSync.native`가 root/존재 조상에서 throw → fail-closed(명확한 에러 메시지: root 자체 실패는 "워크스페이스 realpath 해소 불가" 운영 에러).
- **sync 코어**: `ignored-baseline`(전부 sync) 직접 사용. `workspace-tools`의 `await resolveWithin(...)`은 sync 반환에 await가 무해 no-op이라 시그니처만 sync로 바꿔도 호출부 무수정.

### 1. `ignored-baseline.ts` 하드닝 (B1 분기 재사용)

**전수 스윕 — `statSync` 5지점**(Codex 권장 #2): list walk · capture · collect · ancestor cleanup · leaf restore. 전부 link-aware로.

- **`listIgnored.walk`**: `statSync().isDirectory()`(추종) → `readdirSync(resolve(root,relDir), { withFileTypes:true })` + `Dirent.isSymbolicLink()`. 링크면 재귀/수집 안 함, `skipped{reason:'symlink'}`. 최상위 git-보고 ignored 엔트리(`for (const e of ignored)`)도 `isLinkSync`로 링크면 skip+표면화(파일·디렉터리 가정 전).
- **`captureIgnoredBaseline`**: `statSync(abs)`→`lstatSync(abs)`. 링크 = `isFile()=false` → **B1 non-regular 분기 자동 적중**(sensitive→throw fail-closed / else→`skipped{reason:'not-regular'}`). 링크 target read 안 함 → 비밀 유출 차단. size cap·hash는 regular(lstat==stat)에서 그대로.
- **`collectIgnoredChanges`**: `statSync(abs)`→`lstatSync(abs)`. baseline 일반파일이 symlink로 교체돼도 `isFile()=false`→read 없이 `modified`(backup 있으면 restorable). 누적 byte cap·hash 재계산은 regular 경로 유지.
- **`restoreIgnoredBaseline`(쓰기 측)**:
  - `clearNonDirAncestors`: `statSync(cur).isDirectory()`→`lstatSync`. 제거 조건을 **`!isDirectory() || isSymbolicLink()`로 명시**(Codex #2.1 — junction은 lstat isDirectory=false라 기능상 이미 잡히나 symlink 조건을 명시해 의도 고정). 첫 해당 조상 제거 후 return → `mkdirSync(recursive)`가 root 안에 체인 재생성. (단일 제거+재생성은 다중 링크 조상에도 안전 — 재생성 후 링크 조상 잔존 없음.)
  - leaf write: `statSync(abs)`→`lstatSync`. symlink leaf는 `isFile()=false`→`rmSync`(링크 자체)→`writeFileSync`가 root 안 실파일 생성. 링크 통한 밖 쓰기 차단.
  - created 엔트리 삭제(현 `rmSync(resolve(root,path),{recursive:true,force:true})` 직행): **helper 경유**(Codex #3) — `isLinkSync`로 링크면 recursive 없는 unlink 경로로 명시 처리(POSIX 실측상 recursive도 링크만 제거하나, 보안 의도·플랫폼 차이 테스트 고정·향후 refactor 의심 제거).

`skipped` reason union에 `'symlink'` 추가(`'over-cap'|'read-failed'|'not-regular'|'symlink'`).

### 2. `workspace-tools.ts` 통일

인라인 `resolveWithin`(부정확 `startsWith('..')`·JS realpath) 제거 → path-guard `resolveWithin` import. `walk`(이미 Dirent로 링크 skip) 유지. `read_file.classify`의 직접 `realpathSync(...)` 민감도 승격도 helper 경유로 정합(Codex #3.classify).

## 표면화 & 정책 (A/B1 계승 · leak-zero)

- 탐지된 링크는 기존 `skipped`/`unrestorable` + `workspace.ignored_changes` store 이벤트로 **경로(workspace-상대) + reason/kind만**. **링크 target(밖 경로)·파일 내용은 절대 노출 안 함.**
- sensitive-명 링크·`suspicious`(exotic reparse) = fail-closed. UX 문구는 target 비노출 선에서 "알 수 없는 링크/재분석 지점이라 안전상 처리하지 않음"(Codex #6).
- **root 자체가 symlink인 워크스페이스**: `realpathSync.native(root)` 기준으로 containment 판정(root realpath를 정준 기준으로 고정). 문서·테스트로 고정(Codex #8.4).

## 문서화 (TOCTOU + 격리 한계 — advisory 정직성)

스펙 §+코드 주석 양쪽(Codex #8.5): "경로검사 ≠ 격리". lstat-refusal은 *Fleet 자체 정상 FS 경로*가 링크를 안 따라가게 줄이는 advisory guard일 뿐, 스폰된 CLI의 직접 쓰기는 못 막고, leaf lstat→write 사이 TOCTOU 창이 남는다(순수 Node openat2/O_NOFOLLOW 크로스플랫폼 부재). **강한 격리 = OS/CLI 샌드박스(B-tier 향후)**: Codex 편집은 이미 `-s workspace-write`(registry.ts)로 OS 쓰기 경계 부분 적용 = B2(Fleet 내부 FS 층)와 별개 층이라 중복 아님; Claude(`acceptEdits`)·Gemini(`auto_edit`)는 권한 레이어일 뿐 + Claude sandbox는 native Windows 미지원(WSL2).

## 테스트

- **path-guard 단위 먼저(TDD, Codex #8.1)**: `..foo` 정상 허용 / `../x` 거부 / 존재 symlink 조상 아래 미존재 tail 거부 / cross-drive·UNC 거부 / win32 case-fold / junction fixture(가능 시) / `lstatSync` EINVAL·UNKNOWN mock→`suspicious`.
- **ignored-baseline**: walk junction 비재귀(win32)·symlink 비재귀(POSIX) / capture 링크 비-read(sensitive throw·else skip) / collect 일반→symlink 교체 modified / restore junction·symlink 조상→밖 쓰기 없음·root 안 복원 / symlink leaf→링크 제거 후 root 안 write / created 링크 unlink(밖 내용 보존).
- junction 생성 admin 불요 → win32 vitest(`win32 보안 회귀`) required check 실 fixture. POSIX symlink는 POSIX CI. fakeGit + 실 FS fixture(B1 패턴 계승).
- 5게이트(`typecheck·lint·format:check·test·build`) + `npm run brain` + leak-zero 불변식.

## 비목표

- OS/CLI 샌드박스 신규 배선(향후 B-tier·문서화).
- denylist 내부 sensitive(B1 확정 비목표).
- TOCTOU 완전차단(순수 Node 불가·문서화).
- 적대자 결정적 보장 · 순차→worktree 전환.
- **finding5(`workspace.ignored_discarded` live emit)** — Codex #5 권장대로 **별도 PR로 분리**(B2는 보안 link-guard 핵심; live emit은 UX 표면화·`OrchestratorEventType` union 확장 별건).
- **symlink→symlink 치환 구분** — baseline symlink 가 다른 symlink 로 교체된 경우, target 을 읽지 않고는 구분 불가(no-follow/leak-zero 불변식 충돌). `readlink` 없이는 "원래 symlink 그대로" 인지 "에이전트 교체 symlink" 인지 알 수 없다. 따라서 그런 경우 rollback 이 에이전트 교체 symlink 를 남길 수 있음(advisory 비목표). 강한 격리는 OS/CLI 샌드박스(향후 B-tier) 로 이관.

## 영향 파일

`src/main/core/workspace/path-guard.ts`(신규+test) · `ignored-baseline.ts`(+test) · `workspace-tools.ts`(+test) · (필요 시 `git.ts` `samePath`를 helper로 흡수 검토). 신규 win32/POSIX 분기 테스트.

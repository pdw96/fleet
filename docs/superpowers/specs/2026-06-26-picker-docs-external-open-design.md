# picker 문서 링크 클릭형 외부열기 (가드된 채널) — 설계

- 날짜: 2026-06-26
- 트랙: 세션 등록 UX (#145 항목4 — picker 후속)
- 상태: 설계 (Codex 독립 리뷰 승인 반영) → 구현 계획 대기
- 연계: #145(picker 후속)·#27(백로그)·머지 스펙 `docs/superpowers/specs/2026-06-25-session-auth-picker-design.md` §6a(외부 링크 보안 계약)
- 체크포인트 리뷰: [#145 issuecomment-4807449557](https://github.com/pdw96/fleet/issues/145#issuecomment-4807449557) (Codex `chatgpt-codex-connector` — **승인 의견**)

## 1. 동기 / 배경

세션 등록 picker(#143/#144, squash `a71df18`)는 CLI 구독 분기에서 설치/로그인 **문서 URL**(`CLI_AUTH_INSTALL_META[adapterId].docsUrl`)을 **copy-only**(`<code>` 표시 + clipboard 복사)로만 노출한다. 머지 스펙 §6a가 v1을 의도적으로 copy-only로 묶고, **"클릭형 외부열기는 가드된 후속"**으로 미뤘다. 이 작업이 그 후속을 구현한다 — 사용자가 문서 URL을 손으로 복사·붙여넣기하지 않고 버튼 한 번으로 OS 기본 브라우저에서 열 수 있게.

핵심 제약: Fleet은 **단일 창 SPA**라 renderer가 외부로 네비게이트하는 정상 경로가 **의도적으로 없다**(`src/main/window-guards.ts` `installNavigationGuards`가 새 창·`will-navigate`/`will-redirect`/`will-frame-navigate`를 전면 차단). 따라서 외부열기는 renderer 네비가 아니라 **main이 검증된 정적 URL을 OS 브라우저에 위임**하는 별도 통제 경로로만 도입한다.

## 2. 핵심 결정

| # | 결정 | 근거 |
|---|---|---|
| **D1** | IPC 형태 = **식별자만 전달** | renderer는 `adapterId`(`'claude'\|'codex'\|'gemini'`)**만** 전달 → main이 정적 `CLI_AUTH_INSTALL_META[adapterId].docsUrl`을 도출. renderer/LLM출력/DOM이 URL 문자열을 결정 못 함 → **주입면 0**. 기각 대안: "URL 전달 + main 재검증"(검증 버그 시 임의-URL 입력면 잔존). Codex 리뷰 Q1 = "이 설계가 더 안전" 확인 |
| **D2** | 범위 = **`docsUrl`만** | `loginCommand`/`installHint`는 명령어라 외부열기 대상 아님 → **copy-only 유지**(§6a "복사용 명령은 표시·복사 전용", 터미널 자동실행 비목표) |
| **D3** | window-guards **불변** | `shell.openExternal`은 **main→OS 브라우저 핸드오프**(renderer 네비/`window.open` 아님). `installNavigationGuards`(전면차단) 약화 0. ⚠️ 문서화 시 "renderer navigation 예외"가 아니라 **"main-mediated OS browser handoff 예외"**로 정확히 표현(Codex Q2) |
| **D4** | **심층방어 이중 가드** | renderer가 식별자만 보내도 main이 (a) `Object.hasOwn(CLI_AUTH_INSTALL_META, adapterId)` 런타임 재확인 + (b) 도출한 URL을 `isAllowedDocsUrl`로 **재검증**(정적 맵 미래 오염 대비). Codex 권장 |
| **D5** | **짧은 정책 ADR** 1개 | "전면차단 모델의 첫 의도적 예외" — 미래 보안감사 "왜 window-guard는 전면차단인데 docs는 열리나?"에 대비. 스펙 반복 금지, 결정·보안 불변식·한계만 기록(Codex Q4 권장 + AGENTS §결정기록 + #140 ADR 시스템) |

## 3. 스코프

**In**
- main 검증 헬퍼 `src/main/external-links.ts` — 순수 `isAllowedDocsUrl(url)` + `openVerifiedCliDocs(adapterId, deps)`
- IPC 채널 `fleet:external:openDocs` (main 핸들러 + preload `openCliDocs` + `FleetBridge` 타입)
- AddAiWizard 구독 단계에 **"문서 열기"** 버튼 추가 (URL 텍스트·복사 버튼 유지)
- 짧은 ADR `docs/adr/0005-picker-docs-외부열기.md` (현재 최대 0004 → 다음 0005)

**Out (비목표)**
- `loginCommand`/`installHint` 외부열기 (copy-only 유지)
- URL 전달형 IPC·임의 URL 외부열기 API
- browser-side redirect 추적/검증 (정적 상수만 보증 — §5 참조)
- window-guards 변경·완화

## 4. 데이터 흐름

```text
[AddAiWizard 구독 단계] "문서 열기" 버튼 클릭
  → window.fleet.openCliDocs(adapterId)               [preload — adapterId만]
  → ipcRenderer.invoke('fleet:external:openDocs', adapterId)
  → ipcMain.handle('fleet:external:openDocs') (src/main/index.ts)
  → openVerifiedCliDocs(adapterId, { openExternal: shell.openExternal })
       1. Object.hasOwn(CLI_AUTH_INSTALL_META, adapterId) ? : reject (스푸핑 adapterId)
       2. url = CLI_AUTH_INSTALL_META[adapterId].docsUrl   (정적 shared 맵)
       3. isAllowedDocsUrl(url) ? : reject               (심층방어 재검증)
       4. await openExternal(url)                         (OS 기본 브라우저)
```

renderer는 식별자만 보내고, URL은 main 내부에서만 흐른다.

## 5. 검증 함수 (적대 가드)

```ts
// src/main/external-links.ts — 순수(I/O 없음), 적대 케이스 전수 테스트 대상
export function isAllowedDocsUrl(raw: string): boolean {
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  return (
    parsed.protocol === 'https:' &&   // http/file/javascript/vbscript/SMB 차단
    parsed.username === '' &&         // userinfo 트릭 심층방어 (Codex)
    parsed.password === '' &&
    parsed.port === '' &&             // 정적 docs URL은 포트 없음 → 더 엄격 (Codex)
    DOCS_HOST_ALLOWLIST.includes(parsed.hostname)  // exact 매칭 — 부분일치 금지
  )
}
```

| 차단 대상 | 방어 |
|---|---|
| `http:`/`file:`/`javascript:`/`vbscript:`/SMB(`\\`) | `protocol === 'https:'` |
| `docs.anthropic.com.evil.com` 서브도메인 트릭 | `hostname` allowlist **exact** 매칭 |
| `https://docs.anthropic.com@evil.com` userinfo | `new URL().hostname`→`evil.com` → 매칭 실패 (+ `username===''` 이중) |
| `https://user:pass@docs.anthropic.com` (allowlisted host + userinfo) | `username/password === ''` 심층방어 |
| `https://docs.anthropic.com:8443` 비정상 포트 | `port === ''` |
| IDN homograph / punycode | `new URL().hostname`이 punycode ASCII 정규화 → ASCII-only allowlist와 exact 매칭 실패 |
| 대문자 `https://DOCS.ANTHROPIC.COM` | `hostname` lowercase 정규화 → allowlist(소문자)와 매칭, **허용**(테스트로 동작 고정) |
| 스푸핑된 adapterId | `Object.hasOwn` 런타임 가드 |

**보증 범위 명시(Codex Q3)**: Fleet은 **OS 브라우저에 넘기는 최초 URL이 컴파일타임 정적 allowlist docs URL임만 보증**한다. 핸드오프 이후 브라우저가 따라가는 redirect는 Fleet 앱 내부 네비가 아니므로 보증 범위 밖 — 주석·테스트명·ADR에 명기.

## 6. 신규 표면 / 파일

- **`src/main/external-links.ts`** (신규) — `isAllowedDocsUrl`(순수) + `openVerifiedCliDocs(adapterId, { openExternal })`(DI). `electron` shell 의존이라 `src/main/` 직속(= `window-guards.ts`·`secret-crypto.ts` 동급, **`src/main/core/*` 아님** — AGENTS line 34 core-Electron-금지 준수).
- **`src/main/external-links.test.ts`** (신규) — §9.
- **`src/main/index.ts`** — `ipcMain.handle('fleet:external:openDocs', (_e, adapterId) => openVerifiedCliDocs(adapterId, { openExternal: shell.openExternal }))`.
- **`src/preload/index.ts`** — `openCliDocs: (adapterId) => ipcRenderer.invoke('fleet:external:openDocs', adapterId)`.
- **`src/shared/types.ts`** — `FleetBridge.openCliDocs(adapterId: CliAdapterId): Promise<void>`. `CliAdapterId = keyof typeof CLI_AUTH_INSTALL_META`(`'claude'\|'codex'\|'gemini'`) 좁은 타입을 shared로 공유(Codex 권장).
- **`src/renderer/components/AddAiWizard.tsx`** — 구독 단계 "URL 복사" 옆 "문서 열기" 버튼: `onClick={() => void window.fleet.openCliDocs(adapterId)}`. URL `<code>` 표시·복사 버튼 유지.

## 7. window-guards 관계 (D3 정밀화)

`installNavigationGuards`는 **창 생성 시 그대로 설치**되고 변경하지 않는다. 외부열기는 그 가드를 우회/완화하는 게 아니라, **renderer가 외부로 못 간다는 모델은 유지한 채** main이 검증된 정적 URL만 OS 브라우저에 위임하는 **별도 경로**다. renderer 측엔 `<a href>`/`window.open`/`location.href`/`target=_blank`를 일절 추가하지 않는다(계획서 §15 금지 유지) — 유일한 외부열기 경로는 `openCliDocs(adapterId)` IPC.

## 8. ADR

`docs/adr/0005-picker-docs-외부열기.md` (짧게):
- **결정**: picker docs 외부열기는 renderer navigation이 아니라 **main-mediated 정적 URL handoff**로만 허용.
- **대안**: copy-only 유지 / URL 전달형 IPC (둘 다 기각, 근거 D1).
- **보안 불변식**: ① renderer는 URL 미전달(식별자만) ② command/install hint는 copy-only 유지 ③ `window.open`/navigation guard 불변 ④ https + userinfo 금지 + exact hostname allowlist + 정적 docs URL.
- **한계**: 핸드오프 이후 browser-side redirect는 Fleet 보증 밖.
- 스펙 §6a를 반복하지 않고 "전면차단 모델의 예외가 아니라 별도 통제 경로"라는 결정만 기록.

## 9. 테스트 (TDD)

- **단위 `external-links.test.ts`** (RED 먼저):
  - https 통과 / `http:`·`file:`·`javascript:` 거부
  - allowlist 9-host 각각 통과 / 비-allowlist 거부
  - `docs.anthropic.com.evil.com`(서브도메인)·`@evil.com`(userinfo)·`user:pass@`(userinfo on allowlisted)·비정상 포트·non-allowlist punycode 거부
  - 대문자 host 허용(정규화) 동작 고정
  - **회귀: 각 adapterId의 `meta.docsUrl`이 `isAllowedDocsUrl` 통과**(meta 변경 시 가드와 동기화 강제)
  - `openVerifiedCliDocs`: 검증 통과 시 주입 `openExternal` 호출 / 스푸핑 adapterId·검증 실패 시 미호출
- **renderer**(vitest): "문서 열기" 버튼이 `window.fleet.openCliDocs(adapterId)` 호출.
- **ipc-parity**: `fleet:external:openDocs` preload↔main parity 자동 통과.
- **e2e**: 실 `shell.openExternal`은 OS 브라우저를 띄워 헤드리스 e2e 불안정 → 단위로 충분(window-hardening e2e 패턴과 일관 — 외부 효과는 단위 mock).

## 10. Codex 설계 리뷰 반영 (2026-06-26, #145)

Codex 독립 리뷰(설계만·승인 의견)의 4개 보강 전량 반영:
1. **Q1 식별자-전달 IPC** — "더 안전" 확인 → D1 유지. `CliAdapterId` 좁은 타입 + main `Object.hasOwn` 재확인(D4) 추가.
2. **Q2 window-guards** — "main-mediated OS browser handoff 예외"로 문구 정밀화(D3·§7).
3. **Q3 적대 벡터** — `username/password===''`·`port===''` 심층방어 + userinfo/punycode/대문자 전수 테스트 + redirect 보증범위 명시(§5).
4. **Q4 ADR** — 내 사전판단(불요)에서 **선회** → 짧은 정책 ADR(D5·§8).

## 참고
- 현행 코드: `src/renderer/components/AddAiWizard.tsx`(L147-254 구독 단계)·`src/shared/cliAuthInstallMeta.ts`(`DOCS_HOST_ALLOWLIST`·`docsUrl`)·`src/main/window-guards.ts`·`src/main/index.ts`(IPC)·`src/preload/index.ts`·`src/shared/types.ts`(`FleetBridge`).
- 머지 스펙 §6a·계획서 §15(외부링크 copy-only 계약).

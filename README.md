# Fleet

[![CI](https://github.com/pdw96/fleet/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/pdw96/fleet/actions/workflows/ci.yml)

멀티 LLM 오케스트레이션 데스크톱 앱 — 여러 LLM(구독제 CLI/TUI + API)이 하나의 작업방에서
협업하여 사용자의 프로젝트를 높은 정확도로 완수한다.

자세한 설계는 [`DESIGN.md`](./DESIGN.md) 참조.

## 설치 (사용자)

**지원 OS: Windows · Linux.** macOS 빌드는 아직 제공하지 않는다(1.0 이후 과제 — ADR-0017).

최신 인스톨러는 **[Releases](https://github.com/pdw96/fleet/releases/latest)** 에서 받는다.

| OS | 파일 |
| --- | --- |
| Windows | `Fleet-Setup-<버전>.exe` |
| Linux | `Fleet-<버전>.AppImage` |

### 전제조건

- **구독형 CLI 최소 1개** (`claude` · `codex` · `gemini`) — **프로젝트 실행에 필수다.** 구현
  (implementer) 역할이 워크스페이스를 직접 편집하므로 CLI 세션이 하나도 없으면 실행이 시작되지 않고
  거부된다. API 키만으로는 프로젝트를 실행할 수 없다.
- **provider API 키**(Anthropic · OpenAI · Google) — 선택. 계획·리뷰·요약 역할과 채팅에 쓸 수 있고,
  CLI 와 섞어 역할을 나눌 수 있다. **CLI 를 대체하지는 못한다.**
- **git** — 오케스트레이션이 작업 체크포인트에 git 을 쓴다. 없으면 프로젝트 실행이 실패한다.

둘 다 앱의 [세션] 탭에서 등록한다.

### ⚠ 미서명 빌드 — OS 경고 우회

현재 릴리스에는 **코드서명이 적용돼 있지 않다**(ADR-0017 — 사용자 0·수익 0 단계의 연간 고정비를
피하고, 대신 아래 안내와 build provenance attestation 으로 완화한다). 그래서 설치 시 OS 가 막는다.

- **Windows**: SmartScreen 이 전체화면으로 *"Windows에서 PC를 보호했습니다"* 를 띄우고 기본 버튼이
  **"실행 안 함"** 이다. → **「추가 정보」 → 「실행」** 을 누른다.
- **Linux**: AppImage 는 실행 권한이 필요하다. → `chmod +x Fleet-<버전>.AppImage` 후 실행.

**출처를 직접 검증하려면**(권장) — 이 저장소의 GitHub Actions 가 빌드했다는 SLSA build provenance
attestation 이 **인스톨러 자산**(`.exe` · `.AppImage`)에 붙어 있다:

```bash
gh attestation verify Fleet-Setup-<버전>.exe --repo pdw96/fleet
```

> ⚠ attestation 은 **인스톨러 두 종에만** 발행된다. 릴리스에 함께 올라가는 업데이트 메타데이터
> (`latest.yml` · `latest-linux.yml` · `.blockmap`)에는 **없다.** 자동 업데이트 시 `electron-updater`
> 는 `latest.yml` 의 sha512 로 **내려받은 인스톨러가 그 메타데이터와 일치하는지**를 확인한다 —
> 메타데이터 자체를 인증하지는 못하므로, 릴리스 자산을 바꿀 수 있는 공격자는 체크섬과 인스톨러를
> 함께 바꿀 수 있다. 그 층의 신뢰는 GitHub Releases 의 HTTPS 전송과 계정 보안에 의존한다.
> 인스톨러의 출처를 독립적으로 확인하려면 위 `gh attestation verify` 를 쓰는 것이 유일한 경로다.
> 자세한 위협모델은 [`SECURITY.md`](./SECURITY.md).

### 첫 실행 3단계

1. **[세션] 탭** — 쓸 LLM 을 등록한다(설치된 CLI 자동 탐지 또는 API 키 입력).
2. **[프로젝트] 탭** — 작업할 **워크스페이스 폴더**를 고른다(git 저장소 권장).
3. 목표를 적고 실행 — 역할(planner · implementer · reviewer · summarizer)이 배정돼 협업한다.

> ⚠ **에이전트가 워크스페이스를 직접 편집한다.** 변경은 위험도로 분류되며 **`destructive` 로 분류된
> 것만 승인 모달을 띄운다**(민감 파일 변경 · 대량 삭제 · ignored 파일 변경 등). 일반적인 코드 편집은
> `caution` 으로 분류돼 **모달 없이 자동 승인**되고, 검증 명령(`npm run typecheck`·`lint`·`test`)도
> 게이트를 거치지 않는다. 즉 모달은 최후의 방어선이지 모든 변경의 확인 절차가 아니다 —
> **작업 내용이 git 으로 되돌릴 수 있는 워크스페이스에서 쓰는 것을 전제로 한다.**

> 업데이트는 앱이 GitHub Releases 피드에서 확인해 알린다(자동 다운로드는 꺼져 있어 사용자가
> 승인해야 받는다). 보안 신고 절차와 위협모델은 [`SECURITY.md`](./SECURITY.md) 참조.

## 스택

- **Electron + TypeScript** (main/preload, Node)
- **React + Vite** (renderer, electron-vite)
- 코어 엔진은 Electron 비의존 순수 TS → `vitest`로 헤드리스 검증

## 개발

```bash
npm install
npm run dev         # 개발 모드 (electron-vite)
npm run build       # 프로덕션 빌드 (= 기동 가능성 smoke)
npm run typecheck   # tsc --noEmit (main + renderer)
npm run lint        # eslint
npm test            # vitest (코어 엔진 단위/통합)
```

## 구조

```
src/
  main/        Electron 메인 (Node) — index.ts 가 앱 엔트리이자 IPC 등록 지점
    core/      순수 TS 엔진 (Electron 비의존) — cli · providers · session · orchestrator ·
               chat · store · verify · workspace · workbench · safety · secret · mcp ·
               tools · process
  preload/     contextBridge (window.fleet)
  renderer/    React UI
  server/      웹 표면(fleet-server + ws-bridge) — 데스크톱과 같은 코어를 재사용
  shared/      main/renderer/server 공유 타입 (단일 진실 원천)
```

> 파일 단위 지도(역할·의존·피의존·IPC 배선)의 **권위는 [`brain.md`](./brain.md)**(`npm run brain`
> 자동 생성 · CI 가 신선도 강제)다. 위 블록은 첫 방향 잡기용 요약이라 세부는 brain.md 를 본다.

## 역할 배정 정책

오케스트레이션 실행 시 [프로젝트] 탭의 **역할 배정 정책** 드롭다운으로 역할↔LLM 배정 방식을 고른다.
배정 대상은 오케스트레이터가 실제 실행하는 `ASSIGNABLE_ROLES`(planner · implementer · reviewer ·
summarizer)로 한정된다. 실행된 LLM 은 작업 보드에 `→ 이름` 칩으로 표시되고 `Task.assignedLlmId`(폴백
해소 후 id)로 기록된다.

- **`round-robin`** (기본): 역할 순서대로 등록된 세션을 순환 배정한다.
- **`capability-scored`**: 세션별 역량(capabilities)을 근거로 적합도 배정한다(아래 참조).
- **`manual`**: [프로젝트] 탭에서 역할마다 LLM 을 직접 지정한다. 지정하지 않은 역할은 첫 세션으로 기본
  채워지며, 선택값은 `RunProjectRequest.assignments` 로 전달되어 정책 계산보다 우선한다.

### 역량(capabilities) 시드 — `capability-scored`

각 LLM 이 "잘하는 역할"(capabilities)을 근거로 역할을 배정한다. 세션 등록 시 CLI 어댑터 / API provider
별로 아래 기본값이 시드되며, **[세션] 탭에서 토글로 언제든 수정**할 수 있다. 수정값은 store 에
영속되어 앱 재시작 시에도 복원된다(#52 세션 영속화; 손상값은 기본 시드로 폴백).

| CLI 어댑터 | API provider | 기본 역량 |
|-----------|--------------|-----------|
| `claude`  | `anthropic`  | `reviewer` |
| `codex`   | `openai`     | `implementer` |
| —         | `openai-compatible` | `implementer` |
| `gemini`  | `google`     | `planner`, `summarizer` |

- 채점: 이진 적합도(역할 포함=1) 최고 LLM → 동점 시 덜 쓰인 LLM(부하분산) → 인덱스. 어떤 세션도 맡지
  않는 역할은 `round-robin` 으로 수렴한다. 어떤 세션에도 역량이 없으면 사실상 `round-robin` 으로
  격하된다([프로젝트] 탭에서 경고).
- 그 외 역할(architect · critic · tester)로 시드/설정해도 `ASSIGNABLE_ROLES` 밖이라 배정에 반영되지 않는다.
- 정의: [`src/main/core/engine.ts`](./src/main/core/engine.ts) 의 `DEFAULT_CAPABILITIES`.

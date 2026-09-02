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

- **LLM 접근 수단 최소 1개** — 구독형 CLI(`claude` · `codex` · `gemini`) 중 하나가 설치돼 있거나,
  provider API 키(Anthropic · OpenAI · Google) 중 하나. 앱의 [세션] 탭에서 등록한다.
- **git** — 오케스트레이션이 작업 체크포인트에 git 을 쓴다. 없으면 프로젝트 실행이 실패한다.

### ⚠ 미서명 빌드 — OS 경고 우회

현재 릴리스에는 **코드서명이 적용돼 있지 않다**(ADR-0017 — 사용자 0·수익 0 단계의 연간 고정비를
피하고, 대신 아래 안내와 build provenance attestation 으로 완화한다). 그래서 설치 시 OS 가 막는다.

- **Windows**: SmartScreen 이 전체화면으로 *"Windows에서 PC를 보호했습니다"* 를 띄우고 기본 버튼이
  **"실행 안 함"** 이다. → **「추가 정보」 → 「실행」** 을 누른다.
- **Linux**: AppImage 는 실행 권한이 필요하다. → `chmod +x Fleet-<버전>.AppImage` 후 실행.

**출처를 직접 검증하려면**(권장) — 이 저장소의 GitHub Actions 가 빌드했다는 SLSA build provenance
attestation 이 모든 릴리스 자산에 붙어 있다:

```bash
gh attestation verify Fleet-Setup-<버전>.exe --repo pdw96/fleet
```

### 첫 실행 3단계

1. **[세션] 탭** — 쓸 LLM 을 등록한다(설치된 CLI 자동 탐지 또는 API 키 입력).
2. **[프로젝트] 탭** — 작업할 **워크스페이스 폴더**를 고른다(git 저장소 권장).
3. 목표를 적고 실행 — 역할(planner · implementer · reviewer · summarizer)이 배정돼 협업한다.
   파일 변경·삭제·shell 실행은 **승인 모달**을 거친다(기본은 destructive 차단).

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

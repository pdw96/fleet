# Fleet

[![CI](https://github.com/pdw96/fleet/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/pdw96/fleet/actions/workflows/ci.yml)

멀티 LLM 오케스트레이션 데스크톱 앱 — 여러 LLM(구독제 CLI/TUI + API)이 하나의 작업방에서
협업하여 사용자의 프로젝트를 높은 정확도로 완수한다.

자세한 설계는 [`DESIGN.md`](./DESIGN.md) 참조.

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
  main/        Electron 메인 (Node)
    core/      순수 TS 엔진 (cli, providers, session, orchestrator, chat, store, verify, fileops)
    ipc/       IPC 핸들러
    index.ts   앱 엔트리
  preload/     contextBridge (window.fleet)
  renderer/    React UI
  shared/      main/renderer 공유 타입 (단일 진실 원천)
```

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
| `gemini`  | `google`     | `planner`, `summarizer` |

- 채점: 이진 적합도(역할 포함=1) 최고 LLM → 동점 시 덜 쓰인 LLM(부하분산) → 인덱스. 어떤 세션도 맡지
  않는 역할은 `round-robin` 으로 수렴한다. 어떤 세션에도 역량이 없으면 사실상 `round-robin` 으로
  격하된다([프로젝트] 탭에서 경고).
- 그 외 역할(architect · critic · tester)로 시드/설정해도 `ASSIGNABLE_ROLES` 밖이라 배정에 반영되지 않는다.
- 정의: [`src/main/core/engine.ts`](./src/main/core/engine.ts) 의 `DEFAULT_CAPABILITIES`.

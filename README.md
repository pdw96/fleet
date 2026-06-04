# Fleet

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

## 역할 배정 — 역량(capabilities) 시드

`capability-scored` 배정 정책은 각 LLM 이 "잘하는 역할"(capabilities)을 근거로 역할을 배정한다.
세션 등록 시 CLI 어댑터 / API provider 별로 아래 기본값이 시드되며, **[세션] 탭에서 토글로 언제든
수정**할 수 있다. 값은 세션 수명 동안 유지된다(세션이 in-memory 이므로 앱 재시작 시 초기화).

| CLI 어댑터 | API provider | 기본 역량 |
|-----------|--------------|-----------|
| `claude`  | `anthropic`  | `reviewer` |
| `codex`   | `openai`     | `implementer` |
| `gemini`  | `google`     | `planner`, `summarizer` |

- 대상 역할은 오케스트레이터가 실제 배정하는 `ASSIGNABLE_ROLES`(planner · implementer · reviewer ·
  summarizer)로 제한된다. 그 외 역할로 시드/설정해도 배정에 반영되지 않는다.
- 서로 다른 역할로 시드되어 `capability-scored` 가 한 LLM 독식 없이 즉시 분산 동작한다. 어떤 세션에도
  역량이 없으면 사실상 `round-robin` 으로 격하된다(프로젝트 탭에서 경고).
- 정의: [`src/main/core/engine.ts`](./src/main/core/engine.ts) 의 `DEFAULT_CAPABILITIES`.

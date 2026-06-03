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

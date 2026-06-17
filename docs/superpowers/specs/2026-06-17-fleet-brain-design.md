# Fleet 설계도 (Second Brain) — 설계

> 코드에서 자동 추출돼 항상 최신인 Fleet 구조의 외부 지도. 머리로 외우는 대신
> 들여다보는 "두 번째 뇌" — Obsidian 그래프 뷰 미감의 인터랙티브 P&ID.

날짜: 2026-06-17 · 브랜치: `feat/fleet-brain` · 상태: 구현 완료(검증)

---

## 1. 목적 / 한 줄 정의

**Fleet 앱의 구조를 코드에서 자동 추출해, (1) 에이전트가 읽는 압축 다이제스트 `brain.md` 와 (2) 사람이 보는
Obsidian식 그래프 `fleet-brain.html` 로 낸다.**

- **1차 목적 = 에이전트 토큰 절약.** 코딩 에이전트(Claude/Codex/Gemini)가 `src/` 전체(≈90K 토큰)를 매번
  탐색하는 대신 `brain.md`(≈6K 토큰) 한 장으로 구조·역할·배선을 파악. `AGENTS.md` 가 "코드 전에 `brain.md` 먼저"로 유도.
- **2차 = 사람용 시각화.** 같은 데이터로 만든 인터랙티브 그래프(사람이 클릭해 탐색).
- 위키(문서 중심)가 아니라 **구조 지도**(파일=노드, 실제 배선=엣지) + 비전공자용 설명.
- 손으로 그리지 않고 `src/**` 에서 **derive** 하므로 코드가 바뀌면 다시 생성만 하면 동기화된다(drift 불가).
  **앱 본체(`src/`)는 건드리지 않는다.**

## 2. 산출물

| 경로 | 역할 |
|---|---|
| `scripts/brain/extract.mjs` | 추출기 — TS 컴파일러 API 로 `src/**/*.ts(x)` 파싱 → 그래프 모델 |
| `scripts/brain/markdown.mjs` | **에이전트용 `brain.md` 다이제스트** 생성기 (토큰 절약) |
| `scripts/brain/template.html` | 사람용 뷰어 — force-graph + Command Deck 미감, 인터랙션 |
| `scripts/brain/build.mjs` | 빌더 — `brain.md` + `fleet-brain.html` 동시 생성 |
| `scripts/brain/watch.mjs` | 워치 — `src/` 저장 시 자동 재생성 |
| `scripts/brain/descriptions.json` | 비전공자용 쉬운 설명(파일·모듈·레이어·인트로) 사이드카 |
| `brain.md` (**커밋**) | 에이전트용 다이제스트 — 체크아웃만으로 읽힘. `AGENTS.md` 가 가리킴 |
| `fleet-brain.html` (gitignore) | 사람용 시각 그래프 — `npm run brain` 으로 재생성 |

`npm run brain` (`brain.md` + html 동시 생성) · `npm run brain:watch` (저장 시 자동). `AGENTS.md` 에 "코드 전에 `brain.md` 먼저" 포인터.

## 3. 데이터 모델 (extract)

순수 Node + `typescript` 만 의존(코어 규칙과 동형: Electron 비의존).

- **노드 = 파일.** `*.test.*`·`*.d.ts` 제외. 필드: `id`(src 기준 경로) · `label` · `layer`(renderer/preload/main/core/shared) ·
  `group`(도메인=색 클러스터; core 하위 디렉터리명, core 직속은 파일명) · `loc` · `externals`(외부 패키지) · `degree` ·
  플래그 `entry`/`registry`/`gate`/`hub`.
- **엣지 = import 의존.** 정적 import · `export…from` · 동적 `import()` · `require`. 상대경로만 내부 해석
  (확장자·`index` 후보 순차 시도). bare specifier 는 외부로 집계.
- **의미 오버레이**(코드만 봐선 안 보이는 런타임 배선 — 이게 P&ID 를 dep-graph 와 구분):
  - 렌더러(`window.fleet` 참조) → `preload/index.ts` (kind `ipc`, 파생)
  - `preload/index.ts` → `main/index.ts` (kind `ipc`, `N IPC channels` 레이블)
  - `cli-session` → `ext:cli`(claude/codex/gemini) · `api-session` → `ext:api`(Anthropic/OpenAI/Google) ·
    `mcp/stdio` → `ext:mcp` (kind `runtime`, 존재 시에만)
- 허브: degree 상위 6 노드에 글로우 강조.

검증 기준값(현 코드): 54 files · 134 import wires · 31 IPC channels · 고립 노드 0.
허브 = `shared/types.ts`(36, 단일 진실 원천) · `engine.ts`(24, 오케스트레이션 허브).

## 4. 뷰어 (template, force-graph 1.51)

- **렌더**: 2D 캔버스 force-directed. 노드 크기 ∝ degree, 색 = group, 허브/외부 글로우, 특수 링(gate=적·entry=앰버·registry=민트 점선).
- **인터랙션**: 호버→이웃만 강조·나머지 흐림 · 클릭→인스펙터(의존/피의존 리스트·외부 패키지·**VS Code 열기** `vscode://`) ·
  검색(`/`)·레전드(배선 3종·표식 5종 의미 + 도메인 칩으로 표시/숨김) · **파일↔모듈 토글**(모듈=group 단위 집약 고수준 P&ID) · **배선 오버레이 토글** · 맞춤(zoomToFit).
- **미감**: Obsidian *Command Deck* 토큰 — 흑요석 #0a0b0d · 앰버 #ffc24b · 민트 #4fe0c0 · 도메인별 hue · 글로우 · 도트그리드/비네팅(CSS 그라디언트) · 세리프×모노.
- **배선**: 방향 화살표 + 하이라이트 시 파티클. ipc=민트 점선, runtime=회색 점선(곡률).
- **콘솔 핸들**: `window.brain.focus('engine')` 등 파워유저 스크립팅.

## 4b. 비전공자 설명 레이어 (descriptions.json)

구조(연결)만으론 비개발자가 각 부품의 역할을 알기 어렵다 → 쉬운 한국어 설명을 곁들인다.

- **생성**: 모듈별 서브에이전트(워크플로)가 실제 코드를 읽고 파일별 `role`(한 문장)·`detail`(1~2문장)·모듈 요약을
  비전공자 눈높이로 작성(54 파일·18 모듈, 1회 생성 후 손으로 다듬을 수 있음). 인트로·레이어·외부 경계 설명은 큐레이션.
- **표시**: 인트로 모달("이게 뭐죠?" — 앱 소개 + 6개 레이어, 첫 진입 자동·`?` 버튼 재호출) · 노드 호버 툴팁(역할) ·
  클릭 인스펙터 상단의 역할+상세.
- **동기화 경계**: 구조는 코드에서 자동, 설명(`descriptions.json`)은 사이드카라 코드 변경 시 자동 갱신되진 않는다
  (부품의 '목적'은 잘 안 변하므로 수용 가능 — 필요 시 재생성/수정). extract 가 id 로 병합, 없으면 설명 없이 동작.

## 5. 자기완결성 / 제약

- force-graph UMD dist(177KB)를 HTML 에 **인라인** → CDN 0, 오프라인 동작(레포 ethos: 로컬 번들·CSP `default-src 'self'` 정신).
- 생성물은 gitignore(코드에서 derive 되는 파생물). 제너레이터·force-graph(devDep)만 커밋.
- 폰트는 Fraunces/Plex 미설치 시 시스템 세리프/모노로 폴백.

## 6. 품질 게이트

- `npm run lint` ✅ (`.mjs` 는 `disableTypeChecked` 적용; clean)
- `npm run typecheck` ✅ (scripts 는 tsconfig 비포함)
- `npm test` / `npm run build` — `src/`·테스트 미변경이라 영향권 밖(확인).

## 7. 의도적 비범위 (YAGNI)

- 앱 내장 탭(별도 IPC/렌더러 표면) — 본체를 안 건드리는 standalone 우선.
- 함수 호출그래프·타입 의존 등 import 보다 깊은 분석 — v1 은 파일 단위 import + 런타임 오버레이로 한정.
- 외부 패키지를 그래프 노드화 — 노이즈라 노드 메타(클릭 시 표시)로만.

# typed-linting 설계 (2026-06-16)

이슈 #27 7차 재랭킹 🔴 Now 1순위. `eslint.config.mjs` 의 구문 전용 린팅에 **타입인지(type-aware) 룰**을 추가해 비동기 버그(미처리 Promise·async 핸들러 오용)와 타입 안전성 결함을 품질게이트(`npm run lint`)에서 기계적으로 차단한다.

## 배경 / 문제

- `eslint.config.mjs:7` 이 `...tseslint.configs.recommended`(구문 전용)만 사용 → `parserOptions.project`/`projectService` 없음. 타입 정보가 필요한 룰(`no-floating-promises`·`no-misused-promises`·`no-unsafe-*`·`await-thenable` 등)이 **전무**.
- `typescript-eslint`(`package.json:39` ^8.10, 설치본 8.60.1)는 이미 설치됨 → **신규 top-level 의존성 0**. `tsconfig.base.json` 은 이미 `strict:true`.
- `ChatPanel.tsx:69` 주석이 unhandled-rejection 누수를 자인하는 등, fire-and-forget(`void`/`.catch()`)가 120+ 지점에서 손-관리됨.

## 측정된 위반 표면 (프로브 실측, 2026-06-16)

`recommendedTypeChecked` + `parserOptions.project` 배열로 임시 프로브 실행 → 총 **307 errors / 93 files**:

| 룰 | 건수 | 위치 |
|---|---:|---|
| `require-await` | 252 | **251 test 스텁** + 1 src(`api-session.ts:160` `dispose`) |
| `no-misused-promises` | 10 | **전부 렌더러 async onClick**(App.tsx:64·ChatPanel 291/357/381/398·ProjectPanel:325·SessionsPanel 207/257/355/401) |
| `no-unsafe-assignment` | 11 | test 7(providers.test)·src 3(anthropic:183·google:236·openai:208)·loop.test 1 |
| `no-unsafe-member-access` | 11 | 전부 providers.test |
| `no-unnecessary-type-assertion` | 13 | (auto-fix 대상) |
| `no-redundant-type-constituents` | 4 | (auto-fix 대상) |
| `prefer-promise-reject-errors` | 2 | `resilient.ts` 15/21 |
| `await-thenable` | 2 | ProjectPanel.test:414/415 |
| `no-floating-promises` | 1 | `stdio.ts:33` |
| `no-unsafe-argument` | 1 | SessionsPanel:161 |

**핵심**: 252건(82%)이 `require-await`이고 그중 **251건이 테스트 목/스텁**(async 인터페이스 충족용, await 없음 = 정당). 진짜 버그탐지 가치는 **src ~18건**에 집중.

## 설계 결정

1. **파서 = `parserOptions.project` 배열** `['./tsconfig.node.json','./tsconfig.web.json','./tsconfig.e2e.json']` + `tsconfigRootDir: import.meta.dirname`.
   - `projectService:true` 는 루트 `tsconfig.json` 부재로 전 파일 "not found by the project service" (프로브 실증). 배열 방식이 영역별 lib/types 분리(node↔web↔e2e)도 보존.
2. **타입인지 룰 적용 범위 = `**/*.{ts,tsx}`** 에 `...tseslint.configs.recommendedTypeChecked` 스프레드. **JS/mjs** 는 `...tseslint.configs.disableTypeChecked`(tsconfig 비포함이라 타입정보 없음).
3. **`require-await` = off** (근거 주석 동반): 251/252 가 테스트 스텁, 1건은 `dispose` 인터페이스 충족 → 버그탐지 0·252 churn. 스타일 룰이라 끈다.
4. **테스트 override**(`**/*.test.{ts,tsx}`): `no-unsafe-*`(assignment·member-access·argument) → off. 테스트가 파싱 JSON·부분 fixture 를 의도적으로 다룬다. **src 는 strict 유지.**
5. **착륙 = 곧장 `error`**: 전건 수정 후 고가치 룰을 `recommendedTypeChecked` 기본(error)으로 둔다. 표면이 작아 warn 유예 불요 → 즉시 실효 게이트. 기존 `no-explicit-any`·`no-unused-vars` 는 warn 유지(불변).

## src 수정 (전건, ~18)

- **렌더러 onClick `no-misused-promises` 10**: `onClick={handleX}`(async)를 `onClick={() => void handleX()}` 로 래핑 — 동작 보존(반환 Promise 의 미처리 rejection만 차단), 핸들러 내부 try/catch 유지.
- **`no-floating-promises` 1**(`stdio.ts:33`): `void` 접두 또는 `.catch()` 로 의도 명시.
- **src `no-unsafe-*` 4**(anthropic:183·google:236·openai:208 파싱 응답·SessionsPanel:161): 파싱 결과에 좁은 타입/타입가드 부여 또는 국소 캐스팅.
- **`prefer-promise-reject-errors` 2**(`resilient.ts` 15/21): `reject(new Error(...))` 로 교정.
- **`no-unnecessary-type-assertion` 13 + `no-redundant-type-constituents` 4**: 대부분 `eslint --fix` 자동수정(잔여만 수동).
- **test `await-thenable` 2**(ProjectPanel.test): `await` 제거 또는 thenable 로 교정.

## 검증

- **게이트가 곧 테스트**: `npm run lint` 가 0 exit 로 통과(= 새 타입인지 게이트 실효). 4게이트(typecheck·lint·test·build) 전부 녹색.
- **무회귀**: onClick 래핑은 동작 보존이라 기존 렌더러 테스트(ApprovalModal/ChatPanel/ProjectPanel/SessionsPanel) 그린 유지. src 타입 수정은 런타임 동작 불변.
- **회귀 잠금**: 룰이 `error` 라 향후 신규 미처리 Promise·async 핸들러 오용이 CI 에서 자동 차단.
- CI(ubuntu+windows) 녹색.

## 비범위

- `eslint-plugin-react-hooks`(7차 Next #2 — 별도 PR), `require-await` 를 src 에서 재활성화(현행 1건 dispose 가 양성이라 무가치).
- `no-explicit-any` warn→error 승격(별도 정리), 테스트 `no-unsafe-*` 의 근본 타이핑(fixture 타입화 — 가치 낮음).

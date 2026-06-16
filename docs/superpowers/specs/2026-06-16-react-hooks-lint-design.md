# eslint-plugin-react-hooks 린팅 게이트 설계 (2026-06-16)

이슈 #27 7차 재랭킹 🟡 Next #2(typed-linting 페어). 렌더러의 **훅 의존성·Rules of Hooks** 를 품질게이트(`npm run lint`)에서 기계적으로 검증해, 수기로 관리하던 effect 의존성/마운트-once 패턴의 회귀를 자동 차단한다. typed-linting(#66) 직후의 동일 품질게이트 결.

## 배경 / 문제

- `eslint.config.mjs` 에 훅 규칙이 **전무**(`react-hooks` 플러그인 미설치). 렌더러는 `ChatPanel`·`ProjectPanel`·`ApprovalModal`·`SessionsPanel` 에서 effect 의존성을 **주석으로만** 관리(스테일 클로저 가드·마운트 1회 구독·`current?.id` 키잉 등). 회귀 시 린트가 못 잡는다.
- `App.tsx`·`SessionsPanel`(MCP)은 이미 `useCallback`+의존성 패턴으로 올바르게 작성됨 → 모범 패턴 존재.

## 버전 결정 (context7 + npm 실측, 2026-06-16)

이슈는 "v6" 로 적었으나 **실측 결과 `latest` = 7.1.1** (v6.0.0 은 `rc` 태그). 이슈의 버전 숫자는 작성 시점 스냅샷 — 실질(아래 API·스코프)은 버전 독립적.

- **v7.1.1 채택.** peerDeps `eslint: …||^9.0.0||^10.0.0`(설치본 9.39.4 ✓·ESLint 10 선대응), `node>=18`(설치본 24.16 ✓). 플러그인 자체에 React peer 없음(버전 무관). v6.1.1 은 eslint peer 가 `^9.0.0` 까지라 ESLint 10 비대응.
- **API `reactHooks.configs.flat.recommended` 유효(런타임 실측).** v7.1.1 의 `configs.flat.recommended` 가 존재하며 16룰을 싣는다(아래). 후보의 `recommended-latest` 도 존재하나 `recommended` 가 정설(context7 react.dev: React Compiler 1.0 문서가 `flat.recommended` 제시).
- **`flat.recommended` 16룰**(실측): 기반 2 — `rules-of-hooks`(error)·`exhaustive-deps`(warn); React-Compiler 14 — `static-components`·`use-memo`·`preserve-manual-memoization`·`immutability`·`globals`·`refs`·`set-state-in-effect`·`error-boundaries`·`purity`·`set-state-in-render`·`config`·`gating`(error)·`incompatible-library`·`unsupported-syntax`(warn). compiler 룰은 컴파일러 미도입에도 진단을 표면화(context7 확인).

## 측정된 위반 표면 (프로브 실측, 2026-06-16)

`flat.recommended` 를 `src/renderer/**/*.tsx` 스코프로 임시 프로브 → **총 7건**(예상보다 작음):

| 룰 | 건수 | 위치 / 분류 |
|---|---:|---|
| `exhaustive-deps` (warn) | 5 | ChatPanel:70(`refreshRooms`·마운트1회)·SessionsPanel:57(`detect`·마운트1회)·ApprovalModal 47/52/87(`current`/`decide`·`current?.id` 의도적 키잉) — **전부 의도적 패턴** |
| `set-state-in-effect` (error) | 2 | App.tsx:30(`void refreshSessions()` — **false-positive**: setState 는 `await` 후라 비동기)·ApprovalModal:44(`setRemaining` — 진짜 동기지만 의도적·무해한 카운트다운 리셋) |

**핵심 관찰**:
- 이슈가 노이즈로 지목한 `immutability`·`refs`(no-ref-access-during-render)는 **0건** — 렌더러가 ref 를 effect/콜백에서만 접근(렌더 중 미접근)하기 때문. 즉 이슈의 *구체적* 예측은 빗나갔고(그래서 프로브한다), 원칙(컴파일러 룰 노이즈는 타깃 disable)만 유효.
- `ProjectPanel` 0건: ref-heavy 설계(8+ 가드 ref)가 오히려 `exhaustive-deps` 를 **만족** — ref 는 reactive 가 아니라 의존성 누락이 아니다. v7 `exhaustive-deps` 가 reactive 클로저만 정확히 플래그.
- `set-state-in-effect` 는 App.tsx 의 직접 async-refresh 호출(`void asyncFn()`)에 false-positive — 단 **실측상 1건뿐**(`.then()`/async-IIFE 는 미발화)이라 만성 아님 → 룰-off 대신 site-별 disable 로 충분(설계 결정 4).

## 설계 결정

1. **스코프 = `src/renderer/**/*.tsx`.** 훅은 렌더러 컴포넌트에만 존재(grep 실증: App/ApprovalModal/ChatPanel/ProjectPanel/SessionsPanel 만 훅 사용). 테스트 tsx 포함하나 프로브상 0건. 코어/main 은 비대상.
2. **`flat.recommended` 전체 채택**(이슈 지정·공식 프리셋). 0건인 13 compiler 룰은 그대로 둔다 — **공짜 회귀 가드**(향후 진짜 mutation-in-render·impure 컴포넌트 등 차단).
3. **`exhaustive-deps` = `error`(warn 에서 승격).** 목표가 회귀 *방지* 이고, `npm run lint`(=`eslint .`)는 `--max-warnings 0` 가 없어 warn 은 CI 를 못 막는다(baseline 0/0 확인). typed-linting "곧장 error 착륙" 철학과 동형. 의도적 예외는 인라인 disable 로 명시.
4. **`set-state-in-effect` = 유지(프리셋 error) + 2건 인라인 disable.** (적대 코드리뷰 반영 — 초안의 룰-off 를 교정.) 룰을 스코프-전체 off 하면 (a) 향후 신규 *진짜* 동기 setState 회귀를 못 잡아 PR 목표("회귀 자동 차단")와 모순되고, (b) exhaustive-deps 의 site-별 disable 규율과 비대칭이다. **실측상 false-positive 는 만성이 아님**: 룰 강제 ON 시 정확히 2건만 발화(App.tsx:30·ApprovalModal:44)하고, 흔한 `.then()`/async-IIFE setState(ChatPanel·ProjectPanel)는 미발화. 2건 다 비-버그라 각 site 인라인 명시: App.tsx:30(false-positive — setState 가 `await` 뒤)·ApprovalModal:44(의도적 카운트다운 리셋, `[current?.id]` 라 자기 재발화 없음). 룰은 켜 둬 신규 코드 가드 유지. 진짜 위험(렌더 중 setState)은 `set-state-in-render`(0건)도 별도 가드.
5. 그 외 룰 레벨은 프리셋 기본 유지(`incompatible-library`·`unsupported-syntax` warn 등 — React 팀 의도적 보수 레벨, 현재 0건).

설정 블록(스프레드 덮어쓰기 함정 회피 위해 명시 형태):
```js
import reactHooks from 'eslint-plugin-react-hooks'
// …
{
  files: ['src/renderer/**/*.tsx'],
  plugins: { 'react-hooks': reactHooks },
  rules: {
    ...reactHooks.configs.flat.recommended.rules,
    'react-hooks/exhaustive-deps': 'error',   // 회귀 하드 게이트(의도적 예외는 인라인 disable)
  },
}
```
(구현 시 `flat.recommended` 가 `plugins`/`rules` 외 `languageOptions`/`settings` 를 싣지 않음을 확인 — 프로브상 미포함. 싣는다면 스프레드 형태로 전환.) ESLint 9 flat config 는 `reportUnusedDisableDirectives` 기본 warn 이라, 룰을 끄지 않고 site-별 disable 을 쓰면 죽은 directive 가 즉시 드러난다(룰-off 대비 이점).

## src 수정 (전부 인라인 disable, 7건 — 동작 불변)

의도적 패턴이라 "수정"(의존성 추가/구조 변경)은 동작을 바꾼다 → React 팀 권장 방식인 `// eslint-disable-next-line <rule>` + 한국어 근거를 각 site 에 붙인다(룰은 다른 곳·신규 코드에서 가드 유지).

**exhaustive-deps 5건:**
- **ChatPanel `useEffect(…, [])`**(refreshRooms): 마운트 1회 방 목록 로드(refreshRooms 는 초기 activeRoom=null 로 1회 실행 의도 — 의존성 추가 시 방 전환마다 재실행되어 잘못).
- **SessionsPanel `useEffect(…, [])`**(detect): 마운트 1회 CLI 감지(detect 는 reactive 값 미참조).
- **ApprovalModal 3건**(`[current?.id]` 키잉): 카운트다운 리셋·거부버튼 포커스·키보드 트랩. `current`(=queue[0]) 객체 변화가 아닌 *요청 id* 변화에만 재실행하려는 의도(#57 a11y). `current`/`decide` 추가 시 매 큐 변동/렌더마다 재실행되어 리스너 재부착·포커스 튐.

**set-state-in-effect 2건:**
- **App.tsx:30**(`void refreshSessions()`): false-positive — setState 가 `await window.fleet.listSessions()` 뒤 마이크로태스크라 동기 아님. 룰이 async 경계를 못 봐 호출부만 보고 플래그.
- **ApprovalModal:44**(`setRemaining`): 의도적·무해한 표시용 카운트다운 리셋(요청당 1회 추가 렌더·`[current?.id]` 라 루프 없음·실제 자동거부는 메인 권위).

## 검증

- **게이트가 곧 테스트**: `npm run lint` 0 exit(= 새 훅 게이트 실효). 4게이트(typecheck·lint·test·build) 전부 녹색. **런타임 동작 불변**(설정+주석만) → 기존 렌더러 테스트(ChatPanel/ProjectPanel/ApprovalModal/SessionsPanel) 그린 유지.
- **회귀 잠금**: `rules-of-hooks`·`exhaustive-deps` 가 error → 향후 신규 훅 순서 위반·미선언 reactive 의존성이 CI 자동 차단. 13 compiler 룰도 error/warn 으로 잠복 가드.
- **무회귀 재프로브**: 구현 후 `eslint .` 가 0/0(error+warning) 확인(인라인 disable 7 = exhaustive-deps 5 + set-state-in-effect 2 억제). `--report-unused-disable-directives` 로 죽은 directive 0 확인(7건 전부 실효).
- CI(ubuntu+windows·Node 22) 녹색 + Codex 봇 리뷰 대기·반영.

## 비범위

- React Compiler 도입(`babel-plugin-react-compiler`·runtime) — 별건. 본 PR 은 린트 게이트만.
- `.ts` 커스텀 훅 커버(현재 0개 — 컨벤션상 훅은 .tsx). 생기면 스코프 확장.
- `--max-warnings 0` 를 lint 스크립트에 추가(레포 전역 warn 정책 강제) — 교차절단 결정이라 별도. 본 PR 은 exhaustive-deps 만 error 로 타깃 승격.
- safeStorage(Next #1)·chat-cancel-ipc(Next #3) 등 후속 백로그.

# eslint-plugin-react-hooks 린팅 게이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 렌더러 훅 의존성·Rules of Hooks 를 `npm run lint` 게이트로 기계 검증해 회귀를 자동 차단한다.

**Architecture:** `eslint.config.mjs` 에 `eslint-plugin-react-hooks@7.1.1` 의 `flat.recommended` 를 `src/renderer/**/*.tsx` 스코프로 추가. `exhaustive-deps` 는 `error` 로 승격(하드 게이트). 의도적 예외 7건(마운트-once·id-keyed effect 5 + set-state-in-effect false-positive/카운트다운 2)은 인라인 `eslint-disable-next-line` + 한국어 근거로 명시. 런타임 동작 불변(설정+주석만).

> **적대 코드리뷰 반영(2026-06-16)**: 초안은 `set-state-in-effect: 'off'`(스코프 전체) 였으나, 룰-off 가 향후 신규 동기 setState 회귀를 못 잡아 PR 목표·exhaustive-deps 규율과 비대칭이라는 지적(8 confirmed·0 must-fix) 수용 → **룰은 프리셋 error 로 유지하고 2건만 site-별 inline disable**. 아래 Task 1/2 는 그 최종형을 반영.

**Tech Stack:** ESLint 9.39.4 flat config · eslint-plugin-react-hooks 7.1.1 · React 18.3.1 · TypeScript

설계 근거: [`docs/superpowers/specs/2026-06-16-react-hooks-lint-design.md`](../specs/2026-06-16-react-hooks-lint-design.md)

---

### Task 1: 플러그인 설치 확인 + 설정 블록 추가

**Files:**
- Modify: `package.json`(devDependencies — 이미 설치됨, 확인만), `eslint.config.mjs`

- [ ] **Step 1: 설치·exports 확인**

Run:
```bash
node -e "const r=require('eslint-plugin-react-hooks');const p=require('eslint-plugin-react-hooks/package.json');console.log('v',p.version);const c=r.configs.flat.recommended;console.log('keys',Object.keys(c));console.log('rules#',Object.keys(c.rules).length)"
```
Expected: `v 7.1.1`, `keys [ 'plugins', 'rules' ]`(또는 추가로 'languageOptions'/'settings'), `rules# 16`.
- `keys` 에 `languageOptions`/`settings` 가 **있으면** Step 2 에서 명시 블록 대신 `{ files, ...c, rules:{...c.rules, 오버라이드} }` 스프레드 형태로 전환할 것.

- [ ] **Step 2: 설정 블록 추가**

`eslint.config.mjs` 최상단 import 에 추가:
```js
import reactHooks from 'eslint-plugin-react-hooks'
```

`tseslint.config(...)` 의 **마지막 인자**로(기존 일반 `rules` 블록 다음) 다음 블록 추가:
```js
  // 렌더러 훅 회귀 가드(react-hooks v7 flat.recommended). exhaustive-deps 는 error 로 승격해
  // 하드 게이트화(eslint 가 --max-warnings 0 미사용이라 warn 은 CI 를 못 막음). set-state-in-effect 는
  // 이 레포의 effect-내-async-refresh idiom 에 false-positive(App.tsx)+의도적 카운트다운 리셋(ApprovalModal)
  // 뿐이라 끈다 — 진짜 위험(렌더 중 setState)은 set-state-in-render 가 잡는다. 의도적 마운트-once·
  // id-keyed effect 는 각 site 인라인 disable 로 명시(룰은 다른 곳에서 가드 유지).
  {
    files: ['src/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/exhaustive-deps': 'error',
    },
  },
```

- [ ] **Step 3: 위반 표면 재프로브(설계 실측과 일치 확인)**

Run:
```bash
npx eslint "src/renderer/**/*.tsx" -f json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);const by={};for(const f of d)for(const m of f.messages){if(!m.ruleId||!m.ruleId.startsWith('react-hooks/'))continue;by[m.ruleId]=(by[m.ruleId]||0)+1}console.log(JSON.stringify(by))})"
```
Expected(인라인 disable 적용 전): `{"react-hooks/exhaustive-deps":5,"react-hooks/set-state-in-effect":2}` — exhaustive-deps 5 + set-state-in-effect 2(App.tsx:30·ApprovalModal:44). 다르면 Task 2 전 원인 조사. (Task 2 의 인라인 disable 7건이 전부 억제 → 최종 0.)

- [ ] **Step 4: 커밋**

```bash
git add package.json package-lock.json eslint.config.mjs docs/superpowers/specs/2026-06-16-react-hooks-lint-design.md docs/superpowers/plans/2026-06-16-react-hooks-lint.md
git commit -m "$(cat <<'EOF'
build(lint): eslint-plugin-react-hooks v7 flat.recommended 도입 — 렌더러 훅 게이트 (#27 Next#2)

src/renderer/**/*.tsx 스코프. exhaustive-deps=error(하드 게이트), set-state-in-effect=off
(false-positive + 의도적 노이즈). 위반 해소는 후속 커밋.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: react-hooks 7건 인라인 disable (exhaustive-deps 5 + set-state-in-effect 2)

**Files:**
- Modify: `src/renderer/App.tsx`, `src/renderer/components/ChatPanel.tsx`, `src/renderer/components/SessionsPanel.tsx`, `src/renderer/components/ApprovalModal.tsx`

exhaustive-deps: 각 effect 의 의존성 배열 `}, [...])` 바로 앞 줄에 disable 주석(경고는 의존성 배열 줄에 앵커). set-state-in-effect: 룰이 가리키는 setState 호출/호출부 바로 앞 줄에.

- [ ] **Step 1: ChatPanel — 마운트 1회 방 목록 로드**

`src/renderer/components/ChatPanel.tsx` 의 첫 useEffect(현재 66–70):
```js
  useEffect(() => {
    // fire-and-forget 갱신은 reject 를 직접 처리해야 한다 — 안 그러면 일시적 IPC 실패가
    // unhandled rejection 으로 샌다(앱·테스트 양쪽). 최선노력 갱신이라 로그만 남기고 무시한다.
    refreshRooms().catch((e) => console.error('방 목록 갱신 실패', e))
    // 마운트 1회 로드(refreshRooms 는 초기 activeRoom=null 로 1회 실행 의도) — 의존성 추가 시 방 전환마다 재실행되어 잘못.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
```

- [ ] **Step 2: SessionsPanel — 마운트 1회 CLI 감지**

`src/renderer/components/SessionsPanel.tsx` 의 detect effect(현재 55–57):
```js
  useEffect(() => {
    void detect()
    // 마운트 1회 CLI 감지(detect 는 reactive 값을 닫지 않음) — 의존성 추가 불요·재실행 의도 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
```

- [ ] **Step 3: ApprovalModal — id-keyed effect 3건**

`src/renderer/components/ApprovalModal.tsx`. 세 effect 모두 `current`(=queue[0]) 객체 변화가 아닌 *요청 id* 변화에만 재실행하려는 의도(#57 a11y). `current`/`decide` 추가 시 매 큐 변동/렌더마다 재실행돼 카운트다운·리스너·포커스가 튄다.

카운트다운 리셋(현재 42–47):
```js
  useEffect(() => {
    if (!current) return
    setRemaining(Math.ceil(APPROVAL_TIMEOUT_MS / 1000))
    const iv = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000)
    return () => clearInterval(iv)
    // current?.id(요청 신원) 전환에만 카운트다운 리셋 — current 객체 변화가 아닌 id 변화 기준이 의도.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])
```

초기 포커스(현재 50–52):
```js
  useEffect(() => {
    if (current) rejectRef.current?.focus()
    // 요청 id 전환마다 거부 버튼 초기 포커스 — current 객체 변화가 아닌 id 변화 기준이 의도.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])
```

키보드 트랩(현재 58–87): `return () => document.removeEventListener('keydown', onKeyDown)` 다음 줄에:
```js
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // 요청 id 전환마다 리스너 재부착 — current/decide 객체 변화가 아닌 id 변화 기준이 의도(매 렌더 재부착 방지).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id])
```

- [ ] **Step 4: set-state-in-effect 2건 인라인 disable**

`src/renderer/App.tsx` 의 마운트 effect, `void refreshSessions()` 바로 앞:
```js
    // false-positive: refreshSessions 의 setSessions 는 await(IPC) 뒤에 실행돼 effect 본문 동기 setState 가 아니다.
    // 룰이 async/await 경계를 못 봐 호출부만 보고 플래그 — 룰은 켜 두고 이 site 만 명시 억제.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshSessions()
```

`src/renderer/components/ApprovalModal.tsx` 카운트다운 effect, `if (!current) return` 다음·`setRemaining(...)` 앞:
```js
    if (!current) return
    // 의도적 동기 setState: 요청 전환 시 표시용 카운트다운을 즉시 리셋(요청당 1회 추가 렌더·무해, [current?.id] 라
    // 자기 재발화 없음). 실제 자동거부는 메인 권위. 룰은 켜 두고 이 site 만 명시 억제.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRemaining(Math.ceil(APPROVAL_TIMEOUT_MS / 1000))
```

- [ ] **Step 5: lint 0 + 죽은 directive 0 확인**

Run: `npm run lint`
Expected: exit 0, 출력 없음(error+warning 0).

Run: `npx eslint src/renderer/App.tsx src/renderer/components/ApprovalModal.tsx src/renderer/components/ChatPanel.tsx src/renderer/components/SessionsPanel.tsx --report-unused-disable-directives`
Expected: exit 0, 출력 없음(7 directive 전부 실효 — 죽은 것 0).

추가 확인(warning 까지 0):
```bash
npx eslint . -f json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);let e=0,w=0;for(const f of d)for(const m of f.messages){m.severity===2?e++:w++}console.log('errors',e,'warnings',w)})"
```
Expected: `errors 0 warnings 0`.

- [ ] **Step 6: 커밋**

```bash
git add src/renderer/App.tsx src/renderer/components/ChatPanel.tsx src/renderer/components/SessionsPanel.tsx src/renderer/components/ApprovalModal.tsx eslint.config.mjs
git commit -m "react-hooks 의도적 예외 7건 인라인 disable (exhaustive-deps 5 + set-state-in-effect 2)"
```

---

### Task 3: 4게이트 전건 녹색 검증

**Files:** 없음(검증 전용)

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: exit 0(타입 변경 없음 — 주석/설정만).

- [ ] **Step 2: lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 3: test(vitest)**

Run: `npm test`
Expected: 전건 PASS(런타임 동작 불변 → 기존 740 그린 유지). 실패 시 disable 주석이 코드를 건드렸는지 점검.

- [ ] **Step 4: build(smoke)**

Run: `npm run build`
Expected: exit 0(electron-vite build 성공).

- [ ] **Step 5: (커밋 불요 — 검증만)** 4게이트 결과를 기록하고 적대 코드리뷰 단계로 진행.

---

## Self-Review

**Spec coverage:**
- 버전 v7.1.1 채택 → Task 1 Step 1(확인). ✅
- flat.recommended 스코프 추가 → Task 1 Step 2. ✅
- exhaustive-deps=error → Task 1 Step 2. ✅
- set-state-in-effect 유지(프리셋 error) + 2건 인라인 disable → Task 1 Step 2(off 미설정)·Task 2 Step 4. ✅
- 인라인 disable 7건(exhaustive-deps 5 + set-state-in-effect 2) → Task 2 Step 1–4. ✅
- 4게이트 녹색·무회귀 → Task 3. ✅
- 스프레드 덮어쓰기 함정 회피(명시 블록) + languageOptions 확인 → Task 1 Step 1–2. ✅

**Placeholder scan:** 없음 — 모든 disable 주석·설정 코드·검증 명령이 구체적.

**Type consistency:** 타입 변경 없음(설정 파일 + 주석). rules 키명 `react-hooks/exhaustive-deps`·`react-hooks/set-state-in-effect` 는 Task 1 Step 1 실측 룰명과 일치.

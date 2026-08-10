---
adr: 0015
title: Vite 8(@vitejs/plugin-react 6) 은 electron-vite 가 stable 로 지원할 때까지 차단하고, 해제 조건과 동반 검증을 문서로 집행한다
status: Accepted
date: 2026-08-10
related: "#261, PR#278, memory:dependabot-merge-verification-playbook, memory:fleet-dependabot-ci-blindspot"
---

## 맥락

Dependabot #261 (`@vitejs/plugin-react` 5.2.0 → 6.x) 이 `npm ci` ERESOLVE 로 CI 3잡 red
상태로 매주 재생성됐다. 원인은 우리 코드가 아니라 업스트림 peer 사슬이다.

| 패키지 | 선언 | 결과 |
| --- | --- | --- |
| `@vitejs/plugin-react@6.x` | peer `vite ^8.0.0` (그것 하나뿐) | vite 8 요구 |
| `electron-vite@5.0.0` (유일한 stable) | peer `vite ^5.0.0 \|\| ^6.0.0 \|\| ^7.0.0` | **vite 8 배제** |

vitest 4·`@vitest/mocker` 는 이미 `vite ^8` peer 를 허용하므로 블로커가 아니다 — **단일
블로커가 electron-vite** 이고, Fleet 의 빌드 경로(`dev`/`build`/`dist` 전 스크립트)가
electron-vite 라 우회로가 없다.

vite 8 을 지원하는 유일한 빌드 `electron-vite@6.0.0-beta.1` 은 2026-04-12 발행 후
2026-08-10 현재까지 신규 발행이 없고(dist-tags: `latest=5.0.0` · `beta=6.0.0-beta.1`),
오픈 버그 `alex8088/electron-vite#906` 이 `vite:esm-shim` 으로 main 엔트리를 0.00 kB 로
비운다 — 정확히 Fleet 의 main 타깃이다.

**결정적 근거**: `electron-vite@5` + `vite@8` 강제 조합은 **빌드가 green 인데 `electron` 이
외부화되지 않고 main 번들에 인라인돼 죽은 앱을 산출**한다(격리 재현). `npm run verify` 의
`build` 단계는 번들링만 하고 산출물을 기동하지 않으므로 이 실패를 통과시킨다. 즉 "CI 만
통과시키면 된다" 는 접근이 가장 위험하다.

## 결정

`@vitejs/plugin-react` 의 semver-major 를 `.github/dependabot.yml` 의 `ignore` 로 차단하고
(`@types/node`·`typescript` 와 동일 패턴), 해제 조건과 동반 검증 절차를 이 ADR 에 남긴다.

**해제 조건**: electron-vite 가 **stable**(dist-tag `latest`) 로 `vite ^8` peer 를 선언
— 업스트림 `#894` 종결 **그리고** `#906` 수정. 둘 중 하나만으론 부족하다.

**해제 시 한 커밋으로 동반 처리할 것**

1. `vite` 7→8 · `electron-vite` 5→6 · `@vitejs/plugin-react` 5→6 동반 범프.
   Node 엔진 변경은 불필요(`vite@8` engines `^20.19.0 || >=22.12.0` ⊇ 현행 `>=22.22.2`).

2. **외부화를 산출물에서 정적 검증**(결정적). 빌드 후 아래가 성립해야 한다.

   ```text
   out/main/index.js    → require("electron")  ·  require("electron-updater")
   out/preload/index.js → require("electron")
   ```

   `electron.vite.config.ts` 가 명시 외부화하는 건 `electron-updater` 하나뿐이고
   **`electron` 자체는 electron-vite 의 자동 처리에 의존**한다. 위에 적은 실측 실패 모드가
   정확히 「electron 인라인」이라 updater 만 검사하면 회귀를 놓친다. vite 8 은 외부화 모듈의
   `require` 를 `import` 로 변환하지 않고 보존하므로 외부화 결과 자체가 달라질 수 있다.
   `vite.server.config.ts` 의 SSR 번들도 같이 볼 것.

   ⚠ **`npm run test:e2e` 로는 이 축을 못 잡는다.** e2e 는 `FLEET_E2E=1` 로 unpackaged
   기동이라 `installAutoUpdate` 가 무장되지 않아(`src/main/index.ts` 의 `isPackaged`·`isE2E`
   가드) updater 경로를 아예 타지 않는다 — 인라인된 번들이 우연히 기동하면 통과한다.
   e2e 는 기동 검증으로 **병행**하되, 외부화 판정의 근거는 위 정적 검사다.

3. **패키지 경로까지 검증**. (2)의 정적 검사와 e2e 는 **둘 다 `package.json` 의 `main` 을
   거치지 않는다** — e2e 런처는 `out/main/index.js` 를 인자로 직접 실행하고, 정적 검사는
   빌드 디렉터리만 본다. vite 8/electron-vite 6 이 `.mjs` 로 출력할 경우 검사와 런처만
   고치고 `package.json` 의 `"main": "./out/main/index.js"` 를 놓쳐도 전부 통과한다.

   - `npm run dist:dir` 후 `app.asar` 안에 `node_modules/electron-updater` 실재 확인
     (외부화는 asar 동봉이 전제 — 현행 asar top-level = `node_modules`/`out`/`package.json`).
   - 패키지된 실행 파일을 `FLEET_SMOKE=1` 로 기동해 `main` 해석 성립 확인(2초 후 self-quit).
     단 `FLEET_SMOKE` 는 updater 를 무장 해제하므로 **기동 검증 전용**이다.

4. **esbuild 하한 감사**(단순 삭제 아님). 현재 esbuild 인스턴스는 2개다 —
   `vite/node_modules/esbuild`(`overrides.vite.esbuild` 적용)와 `node_modules/esbuild`
   (electron-vite 의 `^0.25.11` · **override 미적용**). vite 8 이 esbuild 의존을 버리면
   `overrides.vite.esbuild` 는 무효 키가 될 뿐이고 삭제가 곧 하한 유지가 아니다. 락파일의
   **전체 esbuild 그래프**를 확인해 필요한 하한을 실제 부모/전역에 재적용할 것. 인스턴스가
   하나도 없을 때만 키 삭제가 단순 정리다.

5. *(deprecation 정리 · 필수 아님)* `build.rollupOptions` → `build.rolldownOptions`
   (`electron.vite.config.ts` 3곳 + `vite.server.config.ts` 1곳). vite 8 은
   `setupRollupOptionCompat` 으로 구 이름을 프록시 별칭으로 유지해 동작은 계속되지만 향후
   제거 예정이다. 또한 Lightning CSS 기본 CSS 최소화·`configLoader: 'native'` 전환 예고가
   renderer 산출물과 `vite.server.config.ts` 에 영향을 주는지 이때 함께 확인한다.

## 고려한 대안 / 기각 사유

- **`electron-vite@6.0.0-beta.1` 로 올려 지금 전환** → 기각. 데스크톱 앱의 빌드 경로 전체를
  4개월간 정체된 beta 에 건다. 게다가 오픈 버그 `#906` 이 main 엔트리를 비우는데, 그게 바로
  Fleet 이 쓰는 타깃이다.
- **`--legacy-peer-deps`/`overrides` 로 peer 충돌만 무력화** → 기각. peer 를 무시하면
  `npm ci` 는 통과하지만 electron 이 인라인된 죽은 앱이 green 으로 나온다. 게이트가 못 잡는
  실패를 게이트 통과로 위장하는 최악의 선택.
- **#261 을 열어둔 채 업스트림 대기** → 기각. PR 목록이 계속 red 이고 npm
  `open-pull-requests-limit: 3` 슬롯 하나를 상시 점유한다. 차단하면 슬롯이 회수된다.
- **#261 만 닫고 ignore 미등재** → 기각. Dependabot 이 다음 주기에 동일 PR 을 재생성해
  같은 판단을 매주 반복하게 된다.

## 결과 (Consequences)

- `@vitejs/plugin-react` 5.x 의 마이너/패치는 `npm-minor-patch` 그룹으로 계속 추적되고
  6.x 만 막힌다. 우리가 해제를 결정하기 전엔 봇이 재제안하지 않는다.
- 비용: **차단 해제를 능동적으로 감시해야 한다.** 봇이 더는 알려주지 않으므로 electron-vite
  릴리스를 주기적으로 확인하지 않으면 무기한 vite 7 에 머문다.
- 재검토 트리거: electron-vite `6.0.0` stable 발행 · 업스트림 `#894`/`#906` 종결 ·
  vite 7 이 보안 권고를 받고 vite 8 에서만 패치되는 경우(그때는 beta 리스크와 저울질).

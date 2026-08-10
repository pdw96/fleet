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

`vite` **와** `@vitejs/plugin-react` 의 semver-major 를 `.github/dependabot.yml` 의 `ignore` 로
차단하고(`@types/node`·`typescript` 와 동일 패턴), 해제 조건과 동반 검증 절차를 이 ADR 에 남긴다.

둘 다 막아야 결정이 구현된다 — `npm-minor-patch` 그룹은 minor/patch 만 묶으므로 메이저는
개별 PR 로 열리는데, `vite` 도 직접 devDependency 라 `vite` 8 제안이 따로 뜨고 그 PR 역시
같은 이유로 ERESOLVE 다. 한쪽만 막으면 회수하려던 PR 슬롯을 다시 점유당한다.

**해제 조건**: electron-vite 가 **stable**(dist-tag `latest`) 로 `vite ^8` peer 를 선언
— 업스트림 `#894` 종결 **그리고** `#906` 수정. 둘 중 하나만으론 부족하다.

**해제 커밋의 필수 단계는 1–4 다. 5 는 후속 선택**(완료 조건 아님).

1. `.github/dependabot.yml` 의 `vite`·`@vitejs/plugin-react` **ignore 항목과 주석을 제거**한 뒤
   `vite` 7→8 · `electron-vite` 5→6 · `@vitejs/plugin-react` 5→6 동반 범프.
   ignore 를 남기면 `version-update:semver-major` 가 6.x 만 가리키는 규칙이 아니라서 다음
   7.x 메이저까지 계속 숨겨지고, 「메이저는 개별 PR 로 적대검증」 정책으로 복귀하지 못한다.

   **Node engines floor 를 재감사한다 — "불필요" 로 단정하지 말 것.** 오늘 기준 `vite@8` 의
   engines(`^20.19.0 || >=22.12.0`)는 현행 floor 를 넘지 않지만, 해제 시점의 electron-vite 6 과
   신규 transitive(rolldown · lightningcss 및 각 네이티브 바인딩)는 아직 발행되지도 않았다.
   `.npmrc` 의 `engine-strict=true` 때문에 선언 floor 와 트리의 *실제* 바닥이 어긋나면
   `npm ci` 가 EBADENGINE 로 하드 실패한다(AGENTS.md 「engine-strict floor 정직성」). CI 는
   핀된 Node 로 돌아 통과하는데 `engines` 가 계속 지원한다고 선언한 Node 22 에서만 깨지는
   비대칭이 생긴다. → 범프 후 **락파일 전체의 실제 engine floor 를 감사**해 루트 `engines` 를
   정직하게 상향하고, 락파일 루트 `engines` 드리프트는 `npm install --package-lock-only` 로
   동기화한다. 최신 메이저를 다운그레이드해 회피하지 않는다.

   **floor 를 올렸으면 `.nvmrc` 와 그보다 낮은 런타임 핀도 같이 올린다.** 현재 `.nvmrc` 는
   `22.22.3` 이고 `ci.yml`(2곳)·`e2e.yml`·`release.yml` 이 전부 `node-version-file: '.nvmrc'`
   로 읽는다. 루트 `engines` 만 올리고 `.nvmrc` 를 두면 그 잡들이 `npm ci` 에서 즉시
   EBADENGINE 로 죽어 해제 커밋 자체가 통과하지 못한다. 새로 선언한 최저 Node 에서 설치와
   `npm run verify` 를 실제로 돌려 확인할 것.

2. **외부화를 산출물에서 정적 검증**(결정적). 빌드 후 아래가 성립해야 한다.

   판정 기준은 **"외부 참조로 남았는가"** 이지 `require` 문자열이 아니다. electron-vite 6 이
   `.mjs`(ESM)로 출력할 수 있으므로 CJS 의 외부 `require(...)` 와 ESM 의 외부 `import ... from`
   **둘 다 합격**으로 인정하고, 해당 모듈 본문이 번들에 인라인되지 않았음을 판정한다.
   (엔트리 확장자가 바뀌면 3번의 `package.json.main` 동기화가 함께 걸린다.)

   ```text
   out/main/index.{js,mjs}    → electron  ·  electron-updater  가 외부 참조
   out/preload/index.{js,mjs} → electron                        가 외부 참조
   ```

   `electron.vite.config.ts` 가 명시 외부화하는 건 `electron-updater` 하나뿐이고
   **`electron` 자체는 electron-vite 의 자동 처리에 의존**한다. 위에 적은 실측 실패 모드가
   정확히 「electron 인라인」이라 updater 만 검사하면 회귀를 놓친다. vite 8 은 외부화 모듈의
   `require` 를 `import` 로 변환하지 않고 보존하므로 외부화 결과 자체가 달라질 수 있다.
   **SSR 번들의 합격 조건도 명시한다**(모호하면 검사되지 않는다). `deploy/fleet/Dockerfile` 이
   `CMD ["node", "out/server/index.mjs"]` 로 **엔트리명을 하드코딩**하므로 (a) `out/server/index.mjs`
   가 그 이름 그대로 산출되고 (b) `ws`·`jose` 가 외부 참조로 남는지 단언한다. `npm run verify` 는
   번들 생성까지만 보므로 여기서 갈린다. 가능하면 `deploy/smoke.sh`(fleet 서버 이미지를 실제
   빌드·기동하는 `fleet-server-smoke` 섹션 포함)까지 돌려 이미지 레벨을 확인한다.

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
   - **updater 바인딩 표면을 단언한다.** 위 두 검사만으로는 `require("electron-updater")` 는
     남았는데 CJS interop 변화로 named `autoUpdater` 가 `undefined` 인 경우를 통과시킨다 —
     asar 검사는 파일 존재만 보고, `FLEET_SMOKE` 는 `installAutoUpdate` 가 `!armed` 에서
     **updater 를 역참조하기 전에 조기 return** 하기 때문이다(`src/main/auto-update.ts` 의
     early-return 이 `const { updater } = deps` 보다 앞선다). 그 상태로 출하하면 실제 패키지
     실행은 무장 분기에서 `updater.autoDownload` 대입 즉시 크래시한다. → smoke 중 import 한
     `autoUpdater` 가 `UpdaterPort` 표면(`autoDownload` · `autoInstallOnAppQuit` ·
     `allowPrerelease` · `allowDowngrade` · `channel` · `on` · `checkForUpdates` ·
     `downloadUpdate` · `quitAndInstall`)을 갖는지 단언하거나, 네트워크를 차단한 채
     updater-armed 패키지 검증을 별도로 둔다.

4. **esbuild 하한 감사**(단순 삭제 아님). 현재 esbuild 인스턴스는 2개다 —
   `vite/node_modules/esbuild`(`overrides.vite.esbuild` 적용)와 `node_modules/esbuild`
   (electron-vite 의 `^0.25.11` · **override 미적용**). vite 8 이 esbuild 의존을 버리면
   `overrides.vite.esbuild` 는 무효 키가 될 뿐이고 삭제가 곧 하한 유지가 아니다. 락파일의
   **전체 esbuild 그래프**를 확인해 필요한 하한을 실제 부모/전역에 재적용할 것. 인스턴스가
   하나도 없을 때만 키 삭제가 단순 정리다.

**후속 선택 (해제 커밋의 완료 조건 아님 — 별도 PR 로 빼도 된다)**

5. `build.rollupOptions` → `build.rolldownOptions`(`electron.vite.config.ts` 3곳 +
   `vite.server.config.ts` 1곳). vite 8 은 `setupRollupOptionCompat` 으로 구 이름을 프록시
   별칭으로 유지해 **동작은 계속되므로 업그레이드 성립의 조건이 아니다**. 다만 향후 제거
   예정이라 언젠가는 해야 한다. Lightning CSS 기본 CSS 최소화·`configLoader: 'native'` 전환
   예고가 renderer 산출물과 `vite.server.config.ts` 에 영향을 주는지도 이때 함께 본다.

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

- `vite` 7.x · `@vitejs/plugin-react` 5.x 의 마이너/패치는 `npm-minor-patch` 그룹으로 계속
  추적된다. 반면 `version-update:semver-major` 는 6.x 만 가리키는 규칙이 아니라 **현재의
  6.x 를 포함해 이후 모든 메이저**(7.x 이상)를 막는다 — 그래서 해제 커밋의 1단계가 ignore
  제거인 것이고, 안 지우면 다음 메이저까지 조용히 숨는다.
- **`electron-vite` 는 ignore 대상이 아니다** — 그룹이 minor/patch 만 묶으므로 `6.0.0` stable
  이 발행되면 Dependabot 이 메이저 PR 을 열어 **해제 트리거를 자동으로 알려준다**. 따라서
  "능동 감시" 부담은 생각보다 작다. 다만 그 PR 은 **해제 커밋과 별개의 수동 호환성 검증
  대상**이다 — electron-vite 만 6 으로 올리면 vite 7 과의 조합을 새로 검증해야 하고, 반대로
  그 PR 을 그대로 머지한다고 이 ADR 의 해제 절차가 수행되는 것도 아니다.
- 비용: 감시가 완전히 자동은 아니다. 업스트림 `#894`/`#906` 종결 여부는 봇이 알려주지
  않으므로 electron-vite 메이저 PR 이 떴을 때 그 두 조건을 직접 확인해야 한다.
- 재검토 트리거: Dependabot 의 electron-vite 메이저 PR · 업스트림 `#894`/`#906` 종결 ·
  vite 7 이 보안 권고를 받고 vite 8 에서만 패치되는 경우(그때는 beta 리스크와 저울질).

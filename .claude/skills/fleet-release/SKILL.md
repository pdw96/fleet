---
name: fleet-release
description: Fleet 출하 절차 래퍼 — 개시 전 점검(버전 3곳 미러·verify·기존 릴리스 상태) → 태그 ref 생성 → release.yml 양 레그 감시 → 채널·자산 확인 → 실사용 확인. "릴리스 내자", "출하하자", "v0.1.3 내보내줘", "태그 밀어줘", "이번 주기 나갈 때 됐나", "릴리스 준비됐는지 봐줘" 류 요청에 반드시 사용할 것. 2주 리듬 점검·프리릴리스(rc/beta) 출하도 포함한다. 사용자가 '스킬'이라 말하지 않아도 출하·태그·버전 상향 맥락이면 적극 사용한다.
---

# Fleet 출하 절차

AGENTS.md 「릴리스 절차」(ADR-0018 리듬 · ADR-0021 개시 조건)의 실행가능 래퍼다. **산문 권위는
AGENTS.md 이고 이 문서는 순서와 점검 지점만 고정한다** — 두 문서가 어긋나면 AGENTS.md 가 이긴다.

## 왜 래퍼가 필요한가

출하는 「준비되면」이 아니라 **주기**다. v0.1.0 이후 79 PR 이 머지되는 동안 릴리스가 0건이던 상태가
ADR-0018 을 낳았다. 그런데 절차가 산문으로만 있으면 매 주기 세션이 70줄을 다시 읽고 재구성해야 하고,
**그 재구성이 한 번 틀려서 `v0.1.1` 이 자산 0개로 나갔다**(immutable releases 때문에 복구가
`v0.1.2` 재출하뿐이었다). 이 스킬은 그 두 사고의 표면을 각각 닫는다.

## 0. 주기 점검 (「나갈 때가 됐나」 류 질문이면 여기서 멈춰도 된다)

- 최신 태그와 `package.json` 의 version 을 대조한다.
- 최신 태그 이후 `master` 에 머지된 커밋 수를 센다.
- **최신 릴리스의 발행 시각과 지금의 차이를 잰다 — 이 절의 판정은 시각으로 한다.** 태그·버전·커밋
  수만 보면 출하 1일째와 15일째가 같은 값을 내므로 2주 주기도, 「두 번 연속 미준수」도 판정할 수
  없다. 태그의 커밋 날짜가 아니라 **릴리스 발행 시각**이어야 한다 — 태그는 출하보다 먼저 찍히고,
  `v0.1.1` 처럼 태그는 있는데 배달은 없던 선례가 있다.

  ⚠ **`gh release view`(태그 생략)도 `…/releases/latest` 도 쓰지 마라 — 둘 다 프리릴리스를
  건너뛴다.** REST 의 `releases/latest` 는 「가장 최근의 non-prerelease·non-draft 릴리스」로
  정의돼 있고, `gh release view` 의 태그 생략 조회도 같은 자리를 가리킨다. 그런데 ADR-0018 은
  `v1.0.0-rc.1` 을 **주기 출하 그 자체**로 처방한다 — RC 를 낸 직후에도 앵커가 이전 stable 에
  머물러, 방금 지킨 주기를 「미준수」로, 심하면 ADR supersede 대상으로 오판한다. draft 만 걸러내고
  프리릴리스는 **포함해** 직접 고른다:

  ```sh
  gh api repos/pdw96/fleet/releases \
    --jq 'map(select(.draft|not)) | sort_by(.published_at) | last | {tag_name, published_at, prerelease}'
  ```
- **매 주기에는 그때까지 완료된 것만 싣는다.** 「이번 주기에 X 가 들어가야 하니 미룬다」는 금지다 —
  그 사고방식이 79 PR / 0 릴리스를 만들었다. `v1.0.0-rc.1` 도 리듬의 개시 *조건*이 아니라 W4 가
  끝나는 주기의 출하일 뿐이다.
- 주기를 **두 번 연속** 지키지 못했으면 출하가 아니라 ADR-0018 supersede 를 사용자에게 제안한다 —
  지켜지지 않는 절차를 문서에 남겨두지 않는 것이 리듬의 자기 폐기 조항이다.

## 1. 개시 전 점검 (전부 통과해야 태그를 만든다)

1. **버전 3곳 미러** — `package.json` version · `package-lock.json` 루트(`npm install
   --package-lock-only` 로 **재생성**, 손편집 금지) · `src/main/core/mcp/client.ts` 의
   `CLIENT_VERSION`. 셋의 정합은 `scripts/mcp-client-version.test.ts` 가 전부 대조하므로 verify 가
   잡는다 — 락파일은 같은 버전을 두 곳(`version` · `packages[""].version`)에 적고 둘 다 본다.
2. **`npm run verify` GREEN.**
3. **같은 이름의 릴리스가 이미 공개돼 있지 않은지** — `prepare` 잡이 기존 릴리스가 draft 가 아니면
   하드 실패한다(`scripts/release-pipeline-gates.test.ts` 가 핀). 미리 보면 실패 왕복을 아낀다.
4. **1.0 이상이면** `CHANGELOG.md` 해당 절 + `--notes-file` 전환이 착지했는지(#304 ③). 0.x 는
   자동 노트 + 푸터 스텝으로 충족된다.

## 2. 개시 — 태그 ref 생성뿐

**방법은 둘, 그리고 이 둘뿐이다:**

**출하 커밋은 `master` 여야 한다 — 이 절 전체의 전제다.** 두 경로 모두 「지금 고른 것」의 HEAD 를
그대로 태깅하고, 되돌릴 수 없다 — immutable releases 라 잘못 나간 출하의 복구는 재출하뿐이다
(v0.1.1 선례). **`prepare` 잡이 이를 강제한다**(아래 「게이트가 지키는 것」). 다만 게이트는 **개시에
쓰인 ref 의 `release.yml` 안에** 있으므로 두 방어가 겹치는 것은 **같은 ref 에 둘 다 있을 때뿐**이다
— 아래 두 경로의 점검은 편의가 아니라 규칙으로 남는다.

- **CLI** — **`master` 위에서, 버전 상향을 먼저 커밋한 뒤** 태그를 만들고 민다:

  ```sh
  git rev-parse --abbrev-ref HEAD   # master 여야 한다
  git fetch origin master
  git rev-parse HEAD origin/master  # 두 줄이 같은 SHA 여야 한다 — 게이트보다 엄격한 점검
  git status --porcelain            # 비어 있어야 한다 — 상향이 커밋됐다는 뜻
  git tag v${version}               # 대상 생략 = 현재 HEAD
  git rev-parse v${version} HEAD    # 두 줄이 같은 SHA 여야 한다
  git push origin v${version}
  ```

  ⚠ **버전 3곳을 고쳐 두고 커밋하지 않은 채 태그를 찍으면 안 된다.** `git tag <name>` 은 대상을
  생략하면 현재 `HEAD` 를 가리키므로, 1단계의 미러 점검과 `verify` 가 워크트리 내용으로 통과해도
  태그는 **상향 이전 커밋**에 붙는다. 그대로 밀면 `release.yml` 의 `prepare` 가 `package.json`
  버전 대조에서 하드 실패하고 원격에는 잘못된 태그만 남는다.

  ⚠ `git tag` 자체를 빼면 push 가 `error: src refspec v${version} does not match any` 로 실패한다
  (실측). 이 레포의 버전 상향은 손편집 + `npm install --package-lock-only` 라, `npm version` 처럼
  태그가 딸려 만들어지지 않는다 — 그래서 두 단계가 다 명시적이어야 한다.
- **Actions** → **Release** → 「Run workflow」 (브라우저 전용 환경용. `prepare` 가 `package.json` 과
  대조한 뒤 태그 ref 를 직접 만든다 — 이쪽은 로컬 태그가 필요 없다).
  ⚠ **「Use workflow from」에서 반드시 `master` 를 고를 것 — 이건 규칙이다.** 「태그 ref 보장」
  스텝이 고른 ref 의 `$GITHUB_SHA` 에 태그를 만들므로, 특성 브랜치를 고르면 그 브랜치 HEAD 가
  출하 대상이 된다. 아래 게이트가 태그 생성 전에 막지만 — **게이트도 고른 ref 의 파일이라**,
  게이트가 없는 브랜치를 고르면 게이트도 없다(아래 「남는 공백」).

> **게이트가 지키는 것 — 「출하 커밋 master 포함 확인」.** `prepare` 가 **태그 ref 를 만들기 전에**
> 체크아웃된 커밋이 `master` 에 포함되는지 본다 — `compare/master...<sha>` 의 `status` 가
> `identical`·`behind` 면 통과, `ahead`·`diverged` 면 하드 실패다(REST 스키마상 이 넷이 전부다).
> 판정을 브랜치 **이름**이 아니라 **포함 관계**로 하는 이유는 두 개시 경로를 한 술어로 덮기
> 위해서다 — dispatch 는 고른 ref 이름을 주지만 태그 push 는 태그만 온다. 그래서 이 스텝엔
> 이벤트 분기가 없고, 넣으면 핀이 RED 다.
> 대상은 `$GITHUB_SHA` 가 아니라 `git rev-parse HEAD` 다 — 후자는 checkout 이 무엇을 해석했든
> **항상 커밋**이라 「annotated 태그 push 에서 `GITHUB_SHA` 가 무엇인가」에 의존하지 않고,
> build 잡이 실제로 빌드하는 그 커밋이다.
> ⚠ `behind`(master 의 **조상**) 허용은 **squash 머지 관례에 기댄다** — squash 아래서만
> 「master 에 포함 == 리뷰됨」이 성립한다. 머지 커밋이나 master 직접 push 가 들어오면 재검토할 것.
> `scripts/release-pipeline-gates.test.ts` 가 핀한다 — 정적 핀 8종에 더해 **실행 계약 테스트**가
> 워크플로의 `run:` 본문을 파일에서 그대로 뽑아 가짜 `gh` 로 돌린다(status 4값 + 빈 값 + 미지의 값
> + API 실패 → 종료코드). 뮤턴트 15종에서 전부 RED 확인(#328).

> **남는 공백 — 게이트는 자기가 판정할 커밋 안에 산다.** Actions 는 이벤트의 커밋/ref 에 있는
> 워크플로 버전을 실행한다. 즉 **이 게이트를 포함하지 않는 ref 로 개시하면 게이트도 없다** —
> #328 머지 이전에 분기해 그 뒤로 rebase 하지 않은 브랜치가 그 집합이다. 창은 좁다(그런 브랜치는
> 「태그↔`package.json` 버전 대조」도 자기 브랜치 값으로 통과해야 한다) 그리고 시간이 지나면 닫힌다.
> 워크플로 파일 안의 어떤 스텝으로도 원리적으로 못 막으므로 — `environment:` 조차 같은 파일에 있다 —
> **ref 독립 강제는 태그 ruleset(`v*` 생성 제한)뿐이고 그것은 레포 설정이라 별건이다.**
> 그때까지 위 두 경로의 사람 확인이 이 공백을 덮는 유일한 통제다.

**개시가 하드 실패했으면 태그부터 지운다** — `git push --delete origin v${version}`. 태그 push 로
개시했다면 게이트(또는 버전 대조)가 막아도 태그는 이미 원격에 있다. 지우지 않으면 재push 는
`Everything up-to-date` 로 조용히 no-op 이고 dispatch 는 「태그 ref 보장」에서 막혀, **두 경로가 다
잠긴다.** 지운 뒤 원인을 고치고 다시 개시할 것.

**⚠ GitHub 웹의 「Draft a new release」로 릴리스를 만들어 발행하지 마라.** 이 항의 실제 불변식은
*electron-builder 가 도착했을 때 공개된 릴리스가 없을 것* 이다. 웹 UI 발행은 그 행위가 태그를 만들어
워크플로를 띄우는데 파이프라인 도착 시점엔 이미 릴리스가 공개 상태다 —
`electron-builder.yml` 의 `releaseType: draft` 는 공개 릴리스에 자산을 올리지 않고 **경고만 내고
exit 0** 하므로, **4개 잡이 전부 초록인 채 자산 0개 릴리스가 나간다.** `v0.1.1` 이 정확히 그렇게
나갔다.

## 3. 파이프라인 감시

`release.yml` 양 레그(windows·ubuntu)가 성공해야 한다. `release` 잡이 `needs: build` 라 실패하면
draft 가 공개되지 않는다(fail-closed).

⚠ **잡 성공은 자산 존재를 뜻하지 않는다** — electron-builder 는 업로드를 건너뛰고도 exit 0 한다.
그래서 `release` 잡이 `--draft=false` **전에** 자산을 직접 세고, 인스톨러(`*.exe`·`*.AppImage`)와
양 OS 업데이트 메타데이터가 하나라도 없으면 공개하지 않고 실패한다.

원격 세션이면 폴링 대신 이벤트를 쓴다 — Actions 결과를 GitHub MCP 로 조회하고, 긴 대기는
`send_later` 로 잡는다. 로컬이면 `/loop`.

## 4. 산출물 확인 — **여기가 사람 눈의 자리다**

부류(인스톨러·메타데이터) 존재는 3단계 게이트가 이미 막는다. 게이트가 못 보는 것은 **채널이
맞는가**다. 파일명이 채널을 따른다:

| 태그 | 기대 메타데이터 |
|---|---|
| stable (`v1.2.3`) | `latest.yml` · `latest-linux.yml` |
| `-rc` · `-beta` · 그 외 식별자 | `beta.yml` · `beta-linux.yml` |
| `-alpha` | `alpha.yml` · `alpha-linux.yml` |

⚠ **프리릴리스 자산에 `latest*` 가 있으면 정상이 아니라 채널 격리가 깨졌다는 신호다** — stable
사용자에게 프리릴리스가 흘렀다는 뜻이다. 반대로 누락 시 증상은 크래시가 아니라 **조용한
무업데이트**라 아무 신호가 없다. 그래서 이 확인을 건너뛰면 실패를 나중에도 못 본다.

프리릴리스를 stable 보다 먼저 밀어도 안전한 이유가 이 라우팅이다 — 금지 대상이 아니다.
다만 **미검증 잔여 리스크**: v0.1.0 잔존 설치본은 `allowPrerelease = true` 로 나갔고, 그 코호트가
프리릴리스를 최신으로 집었을 때 `latest.yml` 부재를 어떻게 다루는지는 실측되지 않았다. RC 태그를
밀기 전에 그 코호트의 업데이트 확인 동작을 확인할 것(#304 ⑤).

## 5. 실사용 확인

최소 1개 OS 에서 다운로드 → 설치(경고 우회 절차대로) → 기동 → 업데이트 확인. `npm run build` 는
번들 생성까지라 이 단계를 대체하지 못한다(ADR-0015).

## 경계

- **1.0 표면은 Windows / Linux 데스크톱 전용 · 미서명**(ADR-0017). macOS·셀프호스트 서버는
  post-1.0 — 서버 번들은 `electron-builder.yml` 이 asar 에서 제외해 배포 자산에 실리지 않는다.
- **미서명 완화책은 노트 푸터 하나뿐이다.** `prepare` 잡의 「Append 설치·경고 우회 안내 푸터」
  스텝이 SmartScreen 우회·AppImage `chmod +x`·attestation 검증·README 링크를 붙인다. 마커
  (`<!-- fleet-install-footer -->`)로 중복을 막아 재실행에 안전하다. **이 스텝을 지우면 ADR-0017 의
  의무가 사라진다** — 리팩터 시 보존할 것.
- 태그 push 는 되돌릴 수 없다(immutable releases). **개시는 사용자 승인 후에만** 한다.

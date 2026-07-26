# Fleet 배포 스택 (Phase A #195 · Phase B #197)

> **Part of #193** (v3 터널 셀프호스트). 설계 근거: `docs/fleet-saas-infra-plan-v3.html` §4·§7·§8·§10 ·
> `docs/adr/0008-saas-전환-v3-터널-셀프호스트-채택.md`.

**두 개의 문**을 셀프호스트로 연다:

- **문 ① 웹터미널**(Phase A · #195) — "어디서든 브라우저로 `claude` 를 친다". 컨테이너에서
  `claude`/`codex`/`gemini` 를 데스크톱과 똑같이 라이브 대화하고, 폰 화면이 꺼지거나 탭을 닫아도 tmux
  세션이 살아있어 재접속하면 이어서 본다.
- **문 ② Fleet 오케스트레이션**(Phase B · #197 — `fleet` 서비스) — 브라우저에서 Fleet 오케스트레이션
  UI(역할 DAG·승인 카드·라이브 진행)를 연다. 코어 엔진·renderer·승인 게이트는 데스크톱과 동일하고
  **전송층만** Electron IPC→WebSocket 으로 교체했다. 헤드리스 `fleet-server` 로 구동한다.

두 문은 같은 워크스페이스·같은 cli-auth 로그인을 공유하되, `fleet-data`(서버 store·이벤트·암호문)는
**문 ②에만** 마운트된다. 자세한 문 ② 설정은 「문 ② Fleet 오케스트레이션 서버」 절 참조.

---

## 구성

```
deploy/
  docker-compose.yml          ttyd + fleet + cloudflared(tunnel 프로파일)
  .env.example                환경 변수 (→ .env 로 복사)
  webterminal/                문 ① 웹터미널
    Dockerfile                node:24-bookworm-slim + CLI 3종(고정) + git + ttyd + tmux, 비특권 node
    entrypoint.sh             tmux eager-start + ttyd(-W -O) exec
    tmux.conf                 세션 영속·모바일 사용성 (/etc/tmux.conf 로 탑재)
  fleet/                      문 ② 오케스트레이션 서버 (#197-B6)
    Dockerfile                멀티스테이지(빌드→런타임) · CLI 3종(고정) + git + 서버 번들, 비특권 node
  cloudflared/
    config.example.yml        로컬 관리 터널 예시(대안 — 기본은 토큰 기반)
  smoke.sh                    로컬 불변식 검증(터널/폰/로그인 불요 · 두 문 모두)
```

| 서비스        | 이미지                          | 역할                                | 마운트                                   |
| ------------- | ------------------------------- | ----------------------------------- | ---------------------------------------- |
| `ttyd`        | 로컬 빌드 `fleet-webterminal`   | 문 ① 웹터미널(PTY→WebSocket)+tmux   | **workspace + cli-auth 만**              |
| `fleet`       | 로컬 빌드 `fleet-server`        | 문 ② 오케스트레이션 서버(엔진+WS+정적) | **fleet-data + cli-auth + workspace**    |
| `cloudflared` | `cloudflare/cloudflared:2026.6.1` | 터널 사이드카(토큰·무상태)          | **없음**(볼륨·소켓 모두 미마운트)         |

---

## 빠른 시작

### 1. 사전 준비

- Docker + Docker Compose (WSL2 백엔드 권장 — 워크스페이스는 WSL2 파일시스템에 두면 I/O 가 빠르다).
- Cloudflare 계정 + 도메인 하나(Zero Trust 무료 플랜, 도메인 ~$10/년). Tailscale 대안은 아래 결정 기록 참조.
- 호스트 디스크 암호화(BitLocker) — cli-auth 볼륨은 CLI 로그인 토큰을 담는다(§8 전제).

### 2. 터널 + Access (Cloudflare)

1. Zero Trust 대시보드 > **Networks > Tunnels** 에서 터널 생성 → **토큰** 복사.
2. 그 터널의 **Public Hostname** 추가: Subdomain=`terminal` (예), Service=**`http://ttyd:7681`**
   (반드시 compose 서비스명 — `localhost` 아님).
3. **Access > Applications** 에 `terminal.<도메인>` 을 **Self-hosted** 앱으로 추가하고, **Allow** 정책에
   본인 이메일만 Include + **MFA 필수**(One-time PIN 또는 SSO). 터미널 = 원격 셸이므로 이 정책은
   다른 호스트네임보다 엄격하게(§8).

### 3. 빌드 · 기동

```bash
cd deploy
cp .env.example .env          # TUNNEL_TOKEN, WORKSPACE_DIR 등 채우기 (.env 는 커밋 금지)
docker compose --env-file .env --profile tunnel up -d --build
```

`--profile tunnel` 없이 올리면 `ttyd` 만 뜬다(터널 없음 = 공개 경로 없음 → 로컬 검증엔 `smoke.sh` 사용).

> **워크스페이스 소유권(native Linux/WSL2-ext4).** bind 마운트는 호스트 폴더 소유권을 그대로 쓴다.
> `WORKSPACE_DIR` 이 가리키는 폴더가 컨테이너 유저(uid 1000)가 못 쓰는 소유(예: Docker 가 미존재
> 경로를 root 로 자동 생성)면 CLI 파일 쓰기가 실패한다. entrypoint 가 첫 기동에 이를 감지해 명확히
> 중단하니, 안내대로 `sudo chown -R 1000:1000 <WORKSPACE_DIR>` 후 다시 올린다.
> (Docker Desktop Win/Mac 은 보통 자동 해결되어 해당 없음.)

### 4. 구독 로그인 (한 번)

폰/브라우저로 `terminal.<도메인>` 에 접속(→ Access 인증) 후 터미널에서:

| CLI      | 로그인                                                                                          | 상태 저장 경로              |
| -------- | ----------------------------------------------------------------------------------------------- | --------------------------- |
| `claude` | `claude` 실행 → `/login` → `c` 로 URL 복사 → 딴 브라우저서 로그인 → **코드 붙여넣기**(컨테이너 정석 경로) | `~/.claude/.credentials.json` (0600) |
| `codex`  | 헤드리스 OAuth 콜백(loopback:1455)이 안 되므로 **브라우저 있는 PC 에서 `codex login` 후 `~/.codex/auth.json` 을 복사**해 넣는 게 견고 | `~/.codex/auth.json`        |
| `gemini` | 헤드리스 OAuth 가 취약(동적 포트 콜백) → **PC 에서 로그인 후 `~/.gemini/oauth_creds.json` 복사**가 권장 | `~/.gemini/oauth_creds.json` |

세 경로 모두 `cli-auth` 볼륨(`/home/node`)에 영속되어 재기동에도 유지된다.
`docker cp <PC의 파일> <컨테이너>:/home/node/.codex/auth.json` 등으로 주입 시 소유자가 `node`(uid 1000)인지 확인.

> **⚠️ API 키를 넣지 말 것(구독 모드).** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` 가 env 에
> 있으면 구독 OAuth 를 덮어써 인증이 조용히 깨지거나 엉뚱한 조직에 과금된다(v3 §9). API 키 폴백은 Phase B/opt-in.

---

## 마운트 범위 & 보안 경계 <a id="mount-scope"></a>

_(#195 완료항목: 마운트 범위 문서화)_

웹터미널은 **원격 셸**이다. 계정이 뚫리면 내 PC 의 셸을 내주는 것과 같다. 그래서 **터널 앞단 인증이
유일한 사전 방어선**이고, 마운트를 최소화해 **정직한 피해 반경 = `workspace` + `cli-auth`** 로 못박는다.

| 대상                         | ttyd 컨테이너         | 이유                                                               |
| ---------------------------- | --------------------- | ------------------------------------------------------------------ |
| `workspace/` (프로젝트 폴더) | ✅ 바인드 `/workspace` | 두 문이 같은 폴더를 본다                                           |
| `cli-auth` (CLI 로그인 토큰) | ✅ 볼륨 `/home/node`   | 문 ①의 본질 — 터미널에서 CLI 를 쓰려면 로그인 상태가 있어야 함     |
| `fleet-data` (store·이벤트)  | ❌ **미마운트**        | 셸에서 store·시크릿 비노출 (Phase B 의 `fleet` 서비스 전용)         |
| host Docker 소켓             | ❌ **미마운트**        | 데몬 접근 = 사실상 host root — 인터넷에 노출된 셸에서 절대 불가     |
| 시크릿 키                    | ❌ 이미지/볼륨에 없음  | env 주입(서버 한정, Phase B) — cli-auth 와 같은 볼륨에 두지 않음    |

추가 통제:

- **비특권 실행** — 컨테이너는 `node`(uid 1000). 웹터미널 = node 셸(root 셸 아님). `smoke.sh` 가 강제 검증.
- **ttyd 는 loopback 이 아니라 컨테이너 인터페이스(0.0.0.0)에 바인드** — 분리 서비스인 cloudflared 가
  서비스명으로 도달해야 하기 때문. 격리는 «`ports:` 미퍼블리시 + 내부 Docker 망 + 터널 앞 Access» 로 확보한다.
  호스트로 포트를 열지 않으므로 LAN·인터넷에서 직접 도달 불가, 공개 경로는 인증된 터널뿐.
- **`-O`(check-origin)** 로 cross-site WebSocket 하이재킹 차단, **`-W`** 없으면 입력 불가(기본 읽기전용).
- **한계(정직하게)** — 승인 게이트는 문 ②의 **사후** 게이트이고 문 ①엔 게이트가 없다. 스폰된 프로세스의
  pre-exec 차단이 아니므로, 계정이 뚫린 상태의 `rm -rf`·유출은 데스크톱과 동일하게 막지 못한다. 그래서
  **Access MFA 가 타협 불가 전제**이고, 워크스페이스 복구는 git 롤백에 의존한다(§8).

---

## 문 ② Fleet 오케스트레이션 서버 (Phase B · #197-B6) <a id="fleet-server"></a>

`fleet` 서비스 = 코어 엔진 + renderer 정적 서빙 + WebSocket 전송층을 헤드리스로 구동한다. 폰/브라우저에서
Fleet 오케스트레이션 UI 를 열어 역할 DAG·승인 카드·라이브 진행을 본다.

### 설정

1. **`.env`** — 문 ② access 3종 + 시크릿을 채운다(`.env.example` 참조):
   - `FLEET_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` · `FLEET_ACCESS_AUD=<Access 앱 audience tag>`
     · `FLEET_PUBLIC_ORIGIN=https://fleet.<도메인>` — **셋 다 있어야** `FLEET_HOST=0.0.0.0` 부팅이 통과한다
     (미완비면 loud-fail — 조용한 loopback 강등이 아니라 명시적 부팅 거부 = 이중 게이트).
   - `FLEET_SECRET_KEY=<base64 32B>` — API 키 디스크 영속 암호화(AES-256-GCM env-key). 미설정 시 API 키는
     영속되지 않는다(라이브 세션만 유지 · 구독 CLI 는 cli-auth 볼륨이라 무영향). ⚠️ 시크릿 — 커밋 금지.
2. **터널 ingress** — 대시보드 > Networks > Tunnels > (터널) > **Public Hostname** 추가: Subdomain=`fleet`(예),
   Service=**`http://fleet:8791`**(compose 서비스명 — `localhost` 아님). 그리고 **Access > Applications** 에
   `fleet.<도메인>` 을 Self-hosted 앱으로 추가 + 본인 이메일 Include + **MFA 필수**.
   `FLEET_ACCESS_AUD` 는 그 앱 상세의 **Application Audience (AUD) Tag** 다.
3. **기동** — `docker compose --env-file .env --profile tunnel up -d --build` (문 ①·②·터널 함께).

### 자식 프로세스 시크릿 격리 (#197-B6)

서버가 spawn 하는 자식(**CLI 세션·detect/probe·MCP stdio·verify·git**)에 서버 시크릿(`FLEET_SECRET_KEY`·
`FLEET_ACCESS_*` 등 전 `FLEET_*`)이 상속되지 않도록 **allowlist** 로 env 를 필터한다(코드층 `src/server/child-env.ts`):

- **런타임 base** = `PATH`·`HOME`·로케일·프록시·win32 이식 등 최소. `FLEET_*` 자동 배제·`NODE_OPTIONS`
  의도적 배제(preload 주입 벡터). **detect(--version)·MCP stdio·verify·git** 은 이것만.
- **CLI 세션 + probe** = base + provider 자격/구성 키(`ANTHROPIC_*`·`OPENAI_*`·`GOOGLE_*` 계열). probe(연결
  테스트)는 실 모델 왕복으로 **인증**을 확인하므로 세션과 같은 provider env 를 받는다(안 그러면 API-키 인증 CLI 의
  연결 테스트가 오탐). MCP 자식엔 **provider 키 부재**(임의 사용자 프로세스라 `spec.env` 가 명시적 per-server escape hatch).

> **⚠️ 워크스페이스 명령 격리 경계 (env ≠ 파일 격리).** 위 allowlist 는 **서버 env 시크릿(FLEET_\*)** 이 자식에
> 안 새게 한다. 그러나 `verify` 스크립트(워크스페이스 `npm` 스크립트)·`git` 훅은 컨테이너 사용자(uid node)와
> **같은 파일시스템 뷰**로 실행되므로 `HOME`(cli-auth 마운트 `/home/node`) 하위 자격파일을 **절대경로/`getpwuid`
> 로 읽을 수 있다** — env 필터로는 안 닫힌다. Phase B 위협모델(**단일 사용자·단일 인스턴스**)에선 워크스페이스와
> cli-auth 가 **동일 주체**라 자기 자격 읽기는 신규 exfil 이 아니나, **완전한 파일 격리(별도 uid / RO cli-auth 마운트
> / per-run worktree)는 Phase C** 다. 즉 B6 의 보장은 "서버 env 시크릿 격리"이지 "워크스페이스 명령의 cli-auth
> 파일 접근 차단"이 아니다.

### CLI 샌드박스 경계 — 컨테이너 unsandboxed posture (#214 · ADR-0010)

비특권 컨테이너(uid 1000)는 **중첩 user namespace 생성을 불허**해, codex 가 파일 작업 시 만드는
bubblewrap FS 샌드박스가 `bwrap: No permissions to create a new namespace` 로 깨진다(런이 "변경 0개"로
실패). Fleet 은 **컨테이너를 유일한 샌드박스 경계로 신뢰**하고 컨테이너 모드에서 CLI 내부 샌드박스를 끈다:

- **`FLEET_SANDBOX_BOUNDARY`** ∈ `cli`(코드 기본) | `container`(compose 기본). **명시 opt-in 만** —
  자동 감지 없음(오판 방향이 보안 완화라). 그 외 값은 **부팅 거부(loud fail)**.
- `container` = codex 를 `danger-full-access`(no-sandbox) + `--skip-git-repo-check`(신뢰-디렉터리 검사
  통과)로 돌린다(headless·session·edit 전 경로 · CODEX_VERSION 0.142.5 실측 verdict). claude/gemini 는
  내부 샌드박스가 opt-in 이라 무조정. headless 의 read-only 상실은 보안 경계가 아니라 **역할 규율**
  (분석 역할의 파일 쓰기 차단) 상실이다(워크스페이스 무결성은 오케스트레이터 층이 별도 방어).
- **데스크톱·베어호스트 무회귀** — 코드 기본이 `cli` 라 env 미설정 시 CLI 내부 샌드박스를 유지한다.

**운영 롤백(재빌드 불요):** `.env` 에 `FLEET_SANDBOX_BOUNDARY=cli` 를 설정한 뒤
`docker compose --env-file .env --profile tunnel up -d`(`--build` 불요)로 fleet 컨테이너를 recreate 하면
현행 posture 로 복귀한다(컨테이너선 #214 이전 파손으로의 회귀일 뿐 신규 파손 아님). ⚠️ `.env` 편집만으론
이미 기동 중인 컨테이너의 env 가 안 바뀐다 — env 반영은 `up -d`(config-drift 감지 → recreate)가 필요하다.

**부팅이 재시작 루프에 빠지면** — 오타 등 미지값이면 서버가 loud-fail 로 부팅을 거부한다(`restart:
unless-stopped` 라 compose 가 재시작 루프를 돈다). `docker logs <fleet 컨테이너>` 에서
`FLEET_SANDBOX_BOUNDARY` 메시지를 확인하고 값을 `cli`/`container` 로 교정한다.

**`FLEET_APPROVAL_TTL_MS`(#216 C1)** — presence=0(외출·접속 클라 0) 승인이 시한부로 보류되는 시간(ms).
미설정=`600000`(10분), 유효 `[5000, 1800000]`(5초~30분), 범위 밖·비수치는 부팅 거부(loud fail — `docker logs`
에서 `FLEET_APPROVAL_TTL_MS` 메시지). "외출 중 폰 승인"은 응답 여유를 위해 상향 권장(예 `1800000`=30분).
fail-closed 종착은 **만료 거부 + 취소 abort 두 경로**뿐이며 자동 승인은 없다. presence=0 에서도 인가 경계는
불변(응답은 Access 인증 소켓만 · B5 층 무변경).

**문 ①(ttyd 인터랙티브 codex)** — cli-auth 볼륨이 `/home/node` 를 덮어 이미지에 구운 `~/.codex/config.toml`
을 마스킹하므로, 터미널에서 직접 codex 로 파일을 편집하려면 셸 안에서 `~/.codex/config.toml` 에
`sandbox_mode = "danger-full-access"` 를 수동 설정한다(문 ② fleet-server 자동 적용과 별개 · entrypoint
시드는 후속 이슈).

**CODEX_VERSION 상향 시** — 위 플래그(특히 resume 의 `--config sandbox_mode` 라우트·trust-dir 스코프)는
핀 버전 컨테이너 실측 verdict 다(#214 T0). 버전을 올리면 컨테이너 안에서 재실측하고 `containerCliAdapters`
(`src/main/core/cli/registry.ts`)를 갱신한다.

### 단일 인스턴스 전제

- **`fleet-data` 는 서버(문 ②) 전용** — 데스크톱 Electron `userData` 와 **공유 금지**. JSON store 를 두 프로세스가
  동시에 쓰면 손상된다(파일 store 는 단일 writer 전제).
- **workspace root 하나 = Fleet 인스턴스 하나.** 다중 인스턴스·다중 사용자는 Phase B 전체 비범위.
- **"런 중 workspace 변경 거부" 는 UI 가드일 뿐** — 진짜 per-run 격리(worktree)는 **Phase C**. 현재는 한 워크스페이스를
  순차 런이 공유한다.
- **`container_name: fleet-server` 는 이 전제의 배포층 집행**(#251 §W-2-b). compose 는 이 키가 있는 서비스의
  `scale>1` 을 거부한다(실측: `--scale fleet=2` → exit 1 + `Remove the custom name to scale the service`).
  없으면 `--scale fleet=3` 이 **경고 없이** 성공해, 같은 코디네이션 영역을 두 인스턴스가 물게 된다.
  - **집행되는 것**: 같은 프로젝트의 `--scale` · 같은 이름을 쓰는 교차 프로젝트 · compose 밖 stray `docker run`
    (전부 이름 충돌로 loud-fail).
  - **집행되지 않는 것**: 같은 `WORKSPACE_DIR` 을 가리키는 **다른 이름의 스택** · 호스트 직접 실행.
    그 층은 런타임(`<workspace>/.git/fleet/active-instance.json` 배타)이 담당한다.
  - 재배포 시 별도 조치는 필요 없다 — compose 는 컨테이너를 라벨(project+service)로 식별하므로 이름 추가·제거가
    양방향 모두 recreate 로 흡수된다(실측). 단 호스트에 `fleet-server` 이름을 **선점한 컨테이너**가 있으면
    배포가 이름 충돌로 loud-fail 하니 그 컨테이너를 먼저 정리한다.

### Workbench 킬스위치 (#251)

- **`FLEET_WORKBENCH`** ∈ `0`(기본 · 비활성) | `1`(명시 opt-in). 그 외 값은 **부팅 거부**(조용한 비활성 강등이면
  「켰는데 안 켜짐」을 운영자가 못 본다). 롤백은 코드 revert 가 아니라 이 값을 `0` 으로 되돌리는 것이다.
- **서버(컨테이너) 표면 전용** — 데스크톱 Electron 은 이 값과 무관하다(별도 이슈 #255).
- 코어를 랜딩하는 중이라, 현재 `1` 로 켜도 bench 는 생성·실행되지 않는다(기동 로그가 그 상태를 명시한다).

### 잔여 리스크 (문서화)

- **cli-auth RW 공유** — 문 ①·② 가 같은 `cli-auth` 볼륨을 RW 로 공유한다(#195 실측: 동시 사용 간섭 미관측).
  refresh 로테이션 경합(특히 gemini `oauth_creds.json` 토큰 갱신마다 rewrite)은 이론적 잔여 — 신호 시 문 ② 쪽만
  RO 마운트 또는 세션별 사본으로 분리(v3 §7 후속).
- **소켓 수명 중 토큰 만료** — access 모드는 handshake 시 검증한 JWT 의 `exp` 를 소켓에 기록해 **만료 시각에 서버가
  소켓을 닫는다**(#197-B6 · #209 이관). 주기 JWKS 재검증 대신 exp-시한 종료를 택한 이유: Access 는 세션 철회를
  토큰 만료로 표현하고, 만료 전 키 롤오버는 다음 handshake 가 흡수한다. **관리자가 토큰 만료 전 세션을 revoke 하면
  그 소켓엔 즉시 반영되지 않는다**(다음 handshake 에서 차단) — 이 잔여는 수용한다. 클라이언트는 재접속(nonce
  재발급 → 신선한 CF 쿠키/JWT)으로 자동 복구한다.

---

## 결정 기록 ① — ttyd vs code-server <a id="ttyd-vs-code-server"></a>

_(#195 완료항목)_ **채택: ttyd + tmux.** 기준별 비교:

| 기준                | ttyd + tmux                                              | code-server (브라우저 VS Code)                          |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| 노출 표면(피해 반경) | **작다** — PTY 하나를 WS 로. 정적 바이너리(~1.3MB)       | 크다 — 풀 IDE 서버(확장·파일 API·설정 동기화·자체 인증) |
| 목표 적합성          | **정확** — 문 ①은 "TUI 대화" 가 전부                     | 과함 — 에디터+터미널 일체는 Phase A 범위 밖             |
| 모바일 사용성        | tmux + xterm.js, 좁지만 대화엔 충분·`mouse on`·OSC52 복사 | 폰에서 VS Code UI 는 무겁고 좁다                        |
| 세션 영속           | **tmux 로 명시적**(재접속=attach)                        | 워크벤치 상태 복원은 있으나 셸 세션 영속은 별도         |
| 인증 경계           | 단순 — 터널 Access 하나 + (선택)basic-auth               | code-server 자체 인증 레이어가 하나 더(중복·혼동)       |
| 프로세스 격리       | 셸=비특권 node, 마운트 2개로 명확                        | 확장·터미널·파일서버가 같은 권한 — 표면 넓음            |

code-server 는 "브라우저에서 코드도 편집" 이 필요해질 때 재검토할 후속(취향 문제, v3 §12). Phase A 의
**"최소 표면으로 원격 셸을 먼저"** 목표엔 ttyd 가 정합하다. 실제로 code-server 를 병행해 보고 싶으면
별도 서비스로 띄워 A/B 하되, 기본 문 ①은 ttyd 로 확정한다.

---

## 결정 기록 ② — Cloudflare Tunnel vs Tailscale <a id="tunnel-choice"></a>

_(#195 완료항목)_ **채택: Cloudflare Tunnel + Access.** 1차 목표가 **"폰에서 아무 브라우저로나"** 이기
때문이다.

| 기준            | Cloudflare Tunnel + Access                        | Tailscale                                       |
| --------------- | ------------------------------------------------- | ----------------------------------------------- |
| 접속 기기       | **임의 브라우저**(앱 설치 불요) — 목표에 정합      | 접속 기기도 tailnet 소속 필요(Tailscale 앱 설치) |
| 인증            | Access(이메일 OTP/SSO + **MFA**) 엣지 강제         | tailnet ACL·기기 인증(브라우저 로그인 흐름 아님) |
| 노출            | 호스트네임만, 인바운드 포트 0(아웃바운드 터널)     | tailnet 내부만, 인바운드 포트 0                  |
| 비용            | $0(Zero Trust 무료) + 도메인 ~$10/년              | $0(개인 tailnet)                                |
| 셋업            | 대시보드에서 터널+Access, 토큰 하나                | 기기마다 tailnet 조인                           |

Tailscale 은 "내 기기만, 도메인 없이, 더 세게 통제" 가 우선일 때 유효한 대안이다. 하지만 "외출 중
아무 폰 브라우저로 연다" 는 시나리오는 Cloudflare 가 직접 만족한다. **기본 = Cloudflare Access**,
Tailscale 은 문서화된 대안으로 남긴다.

---

## CLI 로그인 볼륨 동시 세션 간섭 — 실측 절차 <a id="concurrent-interference"></a>

_(#195 완료항목 — 방법론. 실제 측정은 구독 로그인이 있는 라이브 환경 필요 → 아래 「라이브 완료 체크리스트」)_

**질문**: 문 ①(웹터미널)과 문 ②(오케스트레이션, Phase B)가 **같은 `cli-auth` 볼륨**을 공유할 때, 두
세션이 동시에 같은 CLI 로그인 상태를 쓰면 토큰 갱신 경합·세션 무효화가 생기는가?

측정 절차(로그인 후 실행):

1. 웹터미널에서 `claude` 대화를 진행하며 활성 세션을 만든다.
2. 동시에 다른 프로세스로 같은 볼륨을 쓰는 `claude`(또는 `codex`/`gemini`)를 헤드리스로 돌린다.
3. 관측: (a) 한쪽 로그아웃/토큰 갱신이 다른 쪽을 끊는가, (b) `~/.claude/.credentials.json` 쓰기 경합으로
   손상되는가, (c) provider 측 동시-세션 레이트리밋에 걸리는가.
4. gemini 는 `oauth_creds.json` 을 토큰 갱신마다 rewrite 하므로 특히 경합 관측 대상.

**기록 위치**: 결과를 이슈 **#195 코멘트**로 남긴다(간섭 있음/없음 + 근거). 간섭이 크면 Phase B 는
"세션별 auth 사본/RO 마운트"(v3 §7 후속) 로 분리하는 신호가 된다.

---

## 로컬 스모크

터널·폰·로그인 없이 이미지·컨테이너 불변식을 검증한다:

```bash
bash deploy/smoke.sh
```

검증 — **문 ①**: (1) CLI 3종+ttyd+tmux 존재, (2) 비특권 uid=1000, (3) ttyd HTTP 200 서빙, (4) tmux 세션이
클라이언트 0 에서도 생존, (5) 마운트 = workspace+cli-auth 만·Docker 소켓·fleet-data 미마운트.
**문 ②**(#197-B6): (10) fleet 이미지 비특권·이미지 env 시크릿 부재·CLI 3종/git/curl 존재, (11) 컨테이너
기동(loopback)·정적 200·**fleet-data 0700**·uid 1000, (12) compose 불변식(fleet ports 미공개·fleet-data 는
fleet 서비스만·docker.sock 미마운트), (13) 컨테이너 브라우저 런-완주는 라이브 5종 위임(명시).
`SMOKE_PORT=nnnn` 로 로컬 포트 변경 가능. **Linux/WSL2 에서 실행**(win32 Git Bash 는 경로 마운트 미지원).

---

## 라이브 완료 체크리스트 <a id="live-checklist"></a>

사용자가 라이브 환경에서 마무리할 항목:

**문 ① 웹터미널(#195):**

- [ ] 폰 브라우저에서 `terminal.<도메인>` 접속(Access 인증) → `claude` 대화 성공
- [ ] 탭 닫기/화면 끄기 후 재접속 시 tmux 세션 그대로 복귀(진행 중 화면 유지)
- [ ] CLI 로그인 볼륨 동시 세션 간섭 실측 → **#195 코멘트**에 기록 (위 절차)

**문 ② Fleet 오케스트레이션(#197-B6 · #193 게이트 ④):**

- [ ] 터널 실배포 → 폰 브라우저에서 `fleet.<도메인>` 접속(Access 실로그인) → 오케스트레이션 UI 로드
- [ ] 세션 등록(CLI/API) → 라이브 목록 반영
- [ ] 목표 입력 → 런 완주(역할 DAG 진행·산출물 검증까지)
- [ ] **승인 보류(#216 C1) — "외출 중 폰 승인"**: 위험 작업 승인 요청 → (PC 탭 닫아 인증 클라 0 전이) →
      승인이 즉시 거부되지 않고 **`FLEET_APPROVAL_TTL_MS`(기본 10분)까지 보류** → 폰 재접속 → 스냅숏 카드
      **재제시**(`listPendingApprovals`) → 폰에서 승인 → PC 런이 이어서 실행 → 만료/취소 시 카드 소멸(withdrawn)
- [ ] 재접속 복구 — 탭 닫기/토큰 만료 후 재접속 시 nonce 재발급으로 자동 복구·스냅샷 재하이드레이션
- [ ] **graceful drain(#216 C3) — 배포 컨텍스트**: 진행 중 런이 있는 상태에서 배포 컨테이너 `docker stop` →
      `docker logs <fleet> 2>&1 | grep '\[fleet\] draining'` 관측 → 진행 런이 상한(`FLEET_DRAIN_TIMEOUT_MS`) 안에서
      대기/정리 → clean exit(유예 `stop_grace_period` 내). *(로컬: 프로세스급 드레인은 `e2e/drain.web.e2e.ts`
      Linux 실행이 커버 — 이 라이브는 실 컨테이너 grace 조율까지 종단 확인.)*

> **완료 정의(#216) 종단**: 위 「승인 보류」 + 「graceful drain」 라이브가 통과하면 그 결과를 #216 코멘트로
> 기록하고 마지막 PR 이 `Closes #216`. (그때까지 C5 PR 은 `Part of #216`.)

_(제공됨: 이미지·compose·터널/Access 설정·자식 격리·결정 기록·로컬 스모크·운영 런북([백업](#runbook-backup)·
[키 로테이션](#runbook-keyrot)·[드레인 업그레이드](#runbook-upgrade))·로컬 하니스(`e2e/approval-handoff.web.e2e.ts`
교차컨텍스트 승인 핸드오프·`e2e/drain.web.e2e.ts` 드레인). 위 라이브 항목은 실제 Cloudflare 계정·구독 로그인·폰이
있어야 하므로 사용자 환경에서 수행한다 — 사일런트 캡 아님.)_

---

## GHCR CD — 무인 배포 <a id="ghcr-cd"></a>

_(#222 · Part of #98)_ master 머지 → GitHub Actions(`.github/workflows/deploy.yml`)가 fleet·ttyd 이미지를
빌드하고 `deploy/smoke.sh` 게이트를 통과한 뒤 **GHCR 에 발행**한다. 24/7 서버는 그 이미지를 pull 해 recreate
한다. 데스크톱 앱 릴리스(`release.yml`·tags `v*`)와 완전 별개다.

### 발행 (클라우드 — 지금 자동)

- **트리거**: `master` push(`paths-ignore` 역필터 — docs-only 머지는 스킵) + `workflow_dispatch`(수동 강제 발행).
- **게이트**: `deploy/smoke.sh`(이미지 빌드 + 불변식 13종 + override 병합 canary). FAIL → 발행 없음 → 서버 직전 이미지 유지.
- **태그**: `ghcr.io/pdw96/fleet-{server,webterminal}` 에 `sha-<12hex>`(**항상**) + `latest`(**GITHUB_SHA==master tip 일 때만**).
- ⚠️ **발행 게이트 = smoke(컨테이너 불변식) only.** 코드 정합(vitest·typecheck)은 **PR CI 선행 전제**다 — smoke 는
  머지-후에만 돌아 Dockerfile/compose 를 깨는 PR 은 CI green 으로 머지되고 발행 실패로만 사후 발현한다. (CI green
  후로 게이트하려면 `workflow_run` 승격 — 후속.)
- ⚠️ `latest` 는 master tip 일 때만 이동한다. 옛 workflow 재실행/stale dispatch 는 `sha-*` 만 발행하고 `latest`
  를 건드리지 않는다(cron 이 latest 추종 시 프로덕션이 뒤로 롤백되는 것을 발행측에서 원천 차단).

### 서버 (pull — 서버 마련 후)

**요구**: Docker + **Docker Compose 2.24+**(override 의 `!reset`) · 아웃바운드망만(인바운드 0 유지) · **amd64(x86_64) 호스트**(아래 「아키텍처」 ⚠️).

1. **GHCR 인증**(1회) — **classic PAT** `read:packages`(GHCR 는 fine-grained PAT 를 docker login 에 미지원 —
   classic 전용):
   ```bash
   echo "<classic-PAT>" | docker login ghcr.io -u <github-user> --password-stdin
   chmod 600 ~/.docker/config.json     # 자격 파일 권한 조임
   ```
   PAT 는 만료를 짧게 두고 주기 로테이션한다. read-only 라 유출돼도 push 불가(기밀만).
2. **`.env`** — 서버는 `GHCR_TAG` 로 pull 태그를 고른다(로컬 빌드용 `IMAGE_TAG` 와 분리 — `IMAGE_TAG=local` 을
   복사해도 GHCR pull 은 `GHCR_TAG` 를 쓴다). 기본 `latest`, 프로덕션은 **`GHCR_TAG=sha-<N>` 단일 핀 강권장**(두
   이미지 동일 커밋 세트 보장 — 크로스이미지 스큐·latest 회귀 방지). ⚠️ `:latest` 는 서비스별 순차 promote 라
   **일시적 부분 스큐 창**이 있다(Codex PR P2 — `fleet-server:latest` 갱신 후 `fleet-webterminal:latest` 전 실패
   시 혼합) → sha 핀이 스큐 없이 안전. access 3종+`FLEET_SECRET_KEY` 도 완비해야 fleet 이 부팅한다(아래 ⚠️).
3. **갱신(cron)** — 기본 권장(단순·투명·데몬 없음):
   ```
   */5 * * * * /path/to/deploy/pull-deploy.sh >> ~/fleet-deploy.log 2>&1
   ```
   `pull-deploy.sh` = flock(겹침 방지) → **git ff-only(compose/override 갱신)** → Compose 2.24 가드 → `pull` →
   `up -d --wait` → dangling prune. ⚠️ 서버는 이 레포를 **clone** 해 두어야 compose/override 변경(env·volume·
   healthcheck·profile)이 이미지와 함께 반영된다(Codex PR P2 — 비-git이면 git 갱신 skip → compose 수동 동기화).
   (watchtower 옵션: fleet/ttyd 라벨만 감시하게 설정 가능하나, cron 이 "무엇이 언제 갱신됐는지" 로그로 더 투명하다.)

> ⚠️ **런타임 시크릿 전제.** `up --wait` 의 healthcheck GREEN 은 이미지 무결과 **별개**로 서버 `.env` 의
> `FLEET_ACCESS_*`·`FLEET_SECRET_KEY` 완비를 요구한다(`resolveBindHost` 이중게이트 · `FLEET_HOST=0.0.0.0`). access
> env 가 없어 `--wait` 가 타임아웃하면 "배포 실패" 처럼 보이지만 실은 **config 갭**이다 — `docker logs` 확인.

### 롤백

⚠️ **`up --wait` 실패 = 새(깨진) 이미지가 이미 recreate 된 상태**다(compose 는 healthy 확인 전에 컨테이너를
교체한다 · Codex PR P1). 이전 컨테이너로 자동 복귀하지 않으므로 즉시 롤백한다. `latest` 를 되돌리지 않고 —
**이전 커밋의 immutable `sha` 태그로 명시 핀**한다:

```bash
export GHCR_TAG=sha-<이전12hex>
docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel pull
docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel up -d --wait
```

### 서버 권장 · 첫-발행 · retention

- **서버 권장(미정)** — 저가 VPS(상시·고정 IP·백업 용이) 또는 홈서버/미니PC(비용 0·전기만). 둘 다 인바운드 0
  (아웃바운드 pull + 아웃바운드 터널)이면 충분하다.
- **아키텍처** — ⚠️ 발행 이미지는 **amd64(x86_64) 전용**이다(클라우드 러너 `ubuntu-latest`=x64 빌드). arm64 호스트
  (일부 미니PC·arm VPS)는 `docker compose pull` 이 no matching manifest 로 실패한다(Codex PR P2) → **amd64 호스트를
  쓰거나**, arm64 는 buildx 멀티아치 발행 후속(서버 아키텍처 확정 후). Dockerfile 자체는 arm64 빌드 가능(ttyd arm64 SHA 포함).
- **첫 발행** — `GITHUB_TOKEN`(packages:write)이 미존재 private 패키지를 최초 생성할 때 403 이 날 수 있다(패키지가
  아직 레포 권한 상속 전). Dockerfile 의 `org.opencontainers.image.source` 라벨이 패키지↔레포 자동 링크를 의도하나,
  첫 머지 후 GHCR UI 에서 패키지 가시성·레포 링크를 1회 확인하라(안 되면 수동 부트스트랩).
- **retention** — 매 비-docs 머지가 새 immutable `sha-<12>` 버전을 쌓아 private 스토리지가 증가한다. 주기적으로
  오래된 `sha` 버전을 정리하라(`gh api -X DELETE /users/pdw96/packages/container/fleet-server/versions/<id>` 또는
  후속 keep-last-N cleanup 워크플로). `latest` + 최근 N 개 `sha` 만 유지하면 롤백 창은 보존된다.

### 라이브 완료 체크리스트 (서버 마련 후)

- [ ] 서버 `docker login ghcr.io`(read:packages PAT) → private 이미지 pull 성공
- [ ] `docker-compose.ghcr.yml` override 로 서버가 **로컬 빌드 없이** GHCR 이미지로 기동(`compose config` 에 build 부재)
- [ ] cron(또는 watchtower) → master 머지 후 새 이미지 자동 pull→recreate 관측
- [ ] 갱신 후 터널 뒤 fleet·ttyd 정상(폰 브라우저 접속·오케스트레이션 UI 로드)
- [ ] 롤백 실증 — `GHCR_TAG=sha-<이전>` → pull → up 으로 이전 버전 복귀
- [ ] 첫 발행 후 GHCR 패키지 가시성·레포 링크 확인(403 시 수동 부트스트랩)

---

## 운영

- **버전 갱신** — `.env`(또는 Dockerfile ARG)의 `*_VERSION` 을 올린다 → 재빌드 → `bash deploy/smoke.sh`
  GREEN 확인 → 교체. 새 CLI 버전이 stream-json 출력 계약을 깨는 회귀는 Phase B 스모크에서 잡는다(문 ①은
  TUI 라 해당 없음). CLI 는 `/usr/local` 에 설치되고 컨테이너는 비특권이라 **런타임 self-update 는 EACCES 로
  자연 차단** — 버전은 이미지가 고정한다.
- **재기동 의미** — tmux 세션 영속은 «브라우저 disconnect 간» 이지 «컨테이너 재시작 간» 이 아니다.
  `restart: unless-stopped` 로 컨테이너를 살려두면 세션이 유지된다. 컨테이너를 내리면 세션은 사라지나
  CLI 세션 resume 으로 대화는 이어받을 수 있다.
- **핀 요약** — node `24-bookworm-slim` · ttyd `1.7.7` · cloudflared `2026.6.1` · claude
  `2.1.199` · codex `0.142.5` · gemini `0.49.0` (2026-07-03 현행 조사 기준).
- **무결성** — ttyd 정적 바이너리는 git 에 커밋된 SHA256 으로 TOFU 핀(Dockerfile `TTYD_SHA256_*`) →
  업스트림 릴리스 자산이 사후 변조되면 재빌드가 실패한다. base·cloudflared 는 태그 핀(digest 아님)
  으로 두어 재빌드 시 OS/CLI 보안 패치를 계속 받는다(느린 정적 바이너리인 ttyd 만 해시 고정이 유효).

---

## 운영 런북 (C5 · #216) <a id="runbook"></a>

_(Phase C · #216. 아래 절차의 코드 근거는 커밋 시점 라인이며, 동작이 바뀌면 함께 갱신한다.)_

### fleet-data 백업·복원 <a id="runbook-backup"></a>

**무엇을 백업하나.** 서버가 영속하는 것은 **단일 파일** `<FLEET_DATA_DIR>/fleet/fleet-store.json`(컨테이너
`/app/fleet-data/fleet/fleet-store.json`)뿐이다. 전체 상태(projects·tasks·rooms·messages·events·sessions·
eventSeq)를 하나의 JSON 으로 원자적 write(tmp+rename)하며, 파싱 실패 시 `.corrupt` 형제가 생긴다(발견 = 과거
손상 흔적, 조사 대상). 이 파일은 named volume **`fleet-data`** 에 있고 fleet 서비스에만 마운트된다.

> ⚠️ **백업 파일 전체를 기밀로 취급하라.** store JSON 은 `messages[]`·`events[]`·`tasks[].output` 을 **평문**으로
> 담는다(대화·산출물). "시크릿은 키뿐이니 tar 는 아무 데나" 는 틀렸다.

**볼륨 실제명은 동적으로 해소한다(하드코딩·substring 매칭 금지).** compose 가 프로젝트명을 `name: fleet-webterminal`
로 고정하므로 실제 named volume 명은 `fleet-webterminal_fleet-data` 다. 하지만 하드코딩하면 환경 차이에서 틀린
이름이 에러가 아니라 **빈 볼륨을 조용히 새로 생성**해 위양성 백업/조용한 미복원이 된다. ⚠️ **substring grep 도 금지** —
호스트에 `fleet-data` 를 포함하는 볼륨이 둘 이상이면(옛 오타로 생긴 빈 볼륨·다른 compose 프로젝트) `grep` 이 엉뚱한
볼륨을 집어 성공한 듯 잘못 백업/복원한다. **compose 라벨로 정확히 특정**하라(project+volume 라벨 = 결정론):

```bash
# compose 가 named volume 에 붙이는 라벨로 정확히 1개 선택(substring 오선택 회피)
VOL=$(docker volume ls -q \
  --filter label=com.docker.compose.project=fleet-webterminal \
  --filter label=com.docker.compose.volume=fleet-data)
# 정확히 1개가 아니면 중단(0개=미기동/오프로젝트 · 2개+=중복 — 사람이 확인)
[ "$(printf '%s\n' "$VOL" | grep -c .)" = 1 ] || { echo "fleet-data 볼륨 특정 실패(0 또는 다중): [$VOL]" >&2; exit 1; }
echo "$VOL"   # 예: fleet-webterminal_fleet-data
```

**백업.** 위에서 특정한 `$VOL` 로 helper 컨테이너 tar(진짜 point-in-time 일관이 필요하면 `docker stop`/드레인 후
실행 — 평상시엔 원자적 write 라 실행 중 스냅숏도 완전한 파일을 관측한다):

```bash
docker run --rm -v "$VOL":/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/fleet-data-$(date +%Y%m%d-%H%M%S).tgz -C /data ./fleet/fleet-store.json
```

**키를 별도로 에스크로하라.** `fleet-store.json` 안의 API 키(`sessions[].encryptedApiKey`)는 `FLEET_SECRET_KEY`
(AES-256-GCM)로만 복호되며, 그 키는 **env 전용이라 볼륨에 없다.** 볼륨만 백업하고 키를 잃으면 복원 후 전 API
세션이 조용히 드롭된다(→ [키 로테이션](#runbook-keyrot)). `FLEET_SECRET_KEY` 를 볼륨 백업과 **다른 저장소**에
보관하라. ⚠️ 범위: 이 키는 kind:'api' 세션에만 쓰인다 — **구독 CLI(ttyd)만 쓰는 배포는 API 세션이 없어 키
에스크로가 무의미**하고 볼륨 백업만으로 충분하다.

**복원(권한 보존이 핵심).** tar 를 풀고 **트리 전체**를 uid 1000(node) 소유로 되돌린다:

```bash
docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine sh -c \
  'tar xzf /backup/fleet-data-<타임스탬프>.tgz -C /data && chown -R 1000:1000 /data'
```

소유권이 틀리면 두 가지로 표면화된다(errno 를 헛짚지 말 것):

- **mount root(`/app/fleet-data`)가 root 소유** → 부팅 시 서버가 `chmodSync(0700)` 를 시도하다 **EPERM →
  bootServer reject → 컨테이너 crash-loop(loud)**. `docker logs` 에서 즉시 보인다(사일런트 손상보다 안전).
- **하위 `fleet/`·`fleet-store.json` 만 root 소유** → 부팅은 통과하나 store write 가 실패해 **영속 불능(조용)**.

`docker stop` 없이 원자적 스냅숏을 떴다면 `.tmp` 형제는 무시하고 로드 대상은 오직 `fleet-store.json` 임을 유의.

**복원/백업 검증(권위 = 라이브 세션 목록).** 서버 부팅 로그에 정상 "key loaded" 표시는 **없다**(성공은 무음).
따라서 로그 부재만으로 정상을 단정하지 말고, **오케스트레이션 UI 의 라이브 세션 목록이 기대대로 비어있지 않은지**로
확인하라. 보조로 `docker logs <fleet> 2>&1 | grep 영속되지 않는다`(= FLEET_SECRET_KEY 미설정 신호)가 비어야 한다.
⚠️ 단 `복호화 실패` 는 과거 로테이션으로 남은 고아 암호문(→ [키 로테이션](#runbook-keyrot))이 store 에 있으면
정상 복원본에서도 계속 나오므로 완료기준으로 쓰지 말라 — 권위는 라이브 세션 목록이다.

**주의사항.**

- **pending 승인은 복원되지 않는다(by design).** 승인 보류는 서버 메모리에만 있어 재시작 시 0 으로 시작한다 —
  이는 데이터 손실이 아니다.
- **서버↔데스크톱 비호환.** 서버는 `ev1:`(AES-GCM env-key), 데스크톱 Electron 은 `v1:`(OS safeStorage)로 암호화
  하므로 서로의 store 를 복원하면 API 키 복호가 실패한다. 서버 백업은 서버에만 복원하라.
- `cli-auth` 볼륨(`/home/node` 의 구독 CLI 로그인)은 재로그인으로 복구 가능하므로 백업은 선택이다(핵심은 fleet-data).

### FLEET_SECRET_KEY 키 로테이션 <a id="runbook-keyrot"></a>

> ⚠️ **hard truth — 무중단 로테이션은 불가능하고, 잘못하면 API 세션이 조용히 전멸한다.** 아래를 정확히 따르라.

**동작 계약(코드 근거).**

- **로테이션 = 기존 API 세션 전량 복호 불가 → 조용히 드롭.** 키를 바꾸면 부팅 시 기존 암호문의 GCM 인증이 실패하고,
  서버는 이를 catch 하여 경고만 남기고(`console.warn('… 복호화 실패(키회전/손상) …')`) 해당 세션을 건너뛴다.
  **크래시하지 않고, UI/헬스체크에도 안 뜨며, 평문으로 폴백하지 않는다.**
- **재암호화 경로가 없다.** 자동 마이그레이션이 없으므로 로테이션 후 **모든 API 키를 수동 재등록**해야 한다.
  ⚠️ **재등록해도 구 암호문은 덮이지 않는다** — 오케스트레이션 UI(세션 추가)는 등록 때마다 새 세션 id
  (`<provider>-<시각>`)를 발급하고 사용자가 id 를 지정할 수 없어, upsert 키(`api:<id>`)가 매번 달라 구 엔트리를
  못 덮는다. 구 암호문은 **고아**로 남아 부팅마다 복호 실패로 조용히 skip 될 뿐 자동 삭제되지 않는다(→ 아래 절차 7).
- **`ev1:` 은 포맷 버전이지 키 버전이 아니다** — 암호문에 키 식별자가 없어 **듀얼키(구/신 동시 인정) 창이 원천
  불가**하다.
- **CLI 세션은 영향 없다**(구독 CLI 는 저장 비밀값이 없다). 로테이션 영향 범위 = API 키 provider 한정.
- **키 포맷.** 64자 hex **또는** 32바이트 base64. 공백 영향은 **포맷별로 다르다**: hex 는 개행/공백이 붙으면 파싱
  실패(→ 미가용 강등), base64 는 디코더가 주변 공백을 관용해 유효할 수 있다. 혼동 방지를 위해 **두 포맷 모두
  공백 없이** 설정하라.

**절차.**

```bash
# 1) 백업 먼저(위 [백업] 절차 — 되돌릴 안전망)
# 2) 새 키 생성(공백 없이 .env 의 FLEET_SECRET_KEY 에 붙여넣기)
openssl rand -hex 32
# 3) .env 교체 → 재배포(아래 [드레인-인지 업그레이드])
# 4) 드롭된 세션 확인
docker logs <fleet> 2>&1 | grep -E '복호화 실패|API 세션 복원 skip'
# 5) 각 API 키를 오케스트레이션 UI 에서 재등록(새 세션으로 추가된다 — UI 가 매번 새 id 를 발급하므로 구
#    암호문은 덮이지 않고 고아로 남는다).
# 6) 검증: 라이브 세션 목록이 기대대로 채워졌는지 확인(권위=유일 완료기준). ⚠️ 4)의 '복호화 실패' grep 은
#    고아 때문에 이후 재기동에서도 계속 나오는 게 정상 — grep 공백을 완료기준으로 쓰지 말 것.
# 7) (선택) 고아 암호문 정리: 무해하나 누적된다. fleet-store.json 의 구 API 세션 sessions[] 엔트리를 수동 삭제
#    (백업 후). UI 에는 비활성 persisted 세션 삭제 어포던스가 없다.
```

**triage(로그로 원인 구분).** 두 skip 메시지가 다르다 — `암호화 미가용` = 키가 아예 미설정/파싱 실패(예: 공백
깨진 hex), `복호화 실패(키회전/손상)` = 키는 있으나 틀림(진짜 로테이션). 둘 다 `API 세션 복원 skip` 을 포함한다.

**부수 시크릿.** `TUNNEL_TOKEN`·GHCR PAT 로테이션은 Cloudflare/GitHub 콘솔 절차다(이 문서 범위 밖) — PAT 는 만료를
짧게 두고 주기 교체(위 [GHCR CD](#ghcr-cd) 참조).

### 드레인-인지 업그레이드·롤백 <a id="runbook-upgrade"></a>

**종료 시퀀스(#216 C3).** `docker stop`/재배포의 SIGTERM 을 받으면 서버는 `draining` 을 켜(신규 런 거부) →
클라에 통지 → **진행 중 런을 상한(`FLEET_DRAIN_TIMEOUT_MS`, 기본 25s)까지 완료 대기** → force close(잔여 런
abort·pending 승인 rejectAll). 재배포 로그로 확인:

```bash
docker logs <fleet> 2>&1 | grep '\[fleet\] draining'
```

**⚠️ grace 조율 불변식(코드가 강제하지 않음).** `FLEET_STOP_GRACE ≥ FLEET_DRAIN_TIMEOUT_MS/1000 + 3` 을
운영자가 유지해야 한다. Docker 는 `stop_grace_period` 만료 시 SIGKILL 로 드레인을 절단하므로, drain 상한을 올리면
`FLEET_STOP_GRACE` 도 함께 올려야 실제로 honor 된다(안 그러면 상한만 올리고 보호받는다고 착각). smoke canary 는
`stop_grace_period` **존재**만 확인하지 산술은 검증하지 않는다. ⚠️ 이 상향은 **다음 종료부터** 유효하다 — 이번
재배포로 정지되는 구 컨테이너는 생성 시점 grace 로 stop 된다.

**⚠️ pending 승인 중 재배포는 지양.** 드레인은 런만 대기하고 pending 승인은 close 의 rejectAll 로 정리되므로,
승인 수명이 TTL(기본 10분)에서 drain 상한으로 붕괴한다 — 런에 묶인 승인은 상한(~25s)까지 대기 후, **활성 런 없이
떠 있던 독립 승인은 거의 즉시(~0s)** reject 된다. 승인 게이트 근처 진행 작업은 revert 될 수 있다(완주 보장 없음).

**롤백은 NOT blue-green.** `up -d --wait` 는 구 컨테이너를 먼저 stop-remove 하고 신 컨테이너를 헬스 게이트하므로,
**헬스 실패 시 구 컨테이너는 이미 사라진 상태**다(자동 복귀 없음). 즉시 이전 immutable 태그로 롤백:

```bash
export GHCR_TAG=sha-<이전12hex>   # latest 를 되돌리지 말고 immutable sha 로 명시 핀
docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel pull
docker compose --env-file .env -f docker-compose.yml -f docker-compose.ghcr.yml --profile tunnel up -d --wait
# git 로 compose/override 를 동기화했다면 그 ff 도 이전 커밋으로 되돌린다(이미지↔compose 세트 정합).
```

**⚠️ 시크릿 누락은 두 갈래(혼동 금지).** `up --wait` 는 신 컨테이너 healthy 를 요구하나 healthcheck 는 정적 200
확인일 뿐이다:

- **`FLEET_ACCESS_*` 부분/전무 + `FLEET_HOST=0.0.0.0`(compose 기본)** → 부팅 거부 → restart crash-loop → `up
  --wait` **300s 타임아웃(loud)**. "배포 실패" 처럼 보이지만 실은 config 갭 — `docker logs` 확인.
- **`FLEET_SECRET_KEY` 미설정/형식오류** → **크래시하지 않는다.** 강등되어 계속 부팅하고 정적 200 이라 `up --wait`
  **GREEN(배포 "성공")** 이지만 API 키가 영속되지 않는다(**조용한 강등** — 재기동 시 전 API 세션 드롭). `up --wait`
  GREEN 은 `FLEET_ACCESS_*` 완비만 방증하지 `FLEET_SECRET_KEY` 는 검증하지 않으므로, GREEN 이어도
  `docker logs <fleet> 2>&1 | grep 영속되지 않는다` 로 별도 확인하라.

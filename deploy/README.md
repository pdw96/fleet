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

**운영 롤백(재배포 불요):** `.env` 에 `FLEET_SANDBOX_BOUNDARY=cli` → 즉시 현행 posture 복귀(컨테이너선
#214 이전 파손으로의 회귀일 뿐 신규 파손 아님).

**부팅이 재시작 루프에 빠지면** — 오타 등 미지값이면 서버가 loud-fail 로 부팅을 거부한다(`restart:
unless-stopped` 라 compose 가 재시작 루프를 돈다). `docker logs <fleet 컨테이너>` 에서
`FLEET_SANDBOX_BOUNDARY` 메시지를 확인하고 값을 `cli`/`container` 로 교정한다.

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
- [ ] 승인 카드 fail-closed — 인증 클라 0 전이(탭 닫기) 시 outstanding 승인이 즉시 거부됨
- [ ] 재접속 복구 — 탭 닫기/토큰 만료 후 재접속 시 nonce 재발급으로 자동 복구·스냅샷 재하이드레이션

_(제공됨: 이미지·compose·터널/Access 설정·자식 격리·결정 기록·로컬 스모크. 위 라이브 항목은 실제
Cloudflare 계정·구독 로그인·폰이 있어야 하므로 사용자 환경에서 수행한다. 컨테이너 브라우저 런-완주 스모크는
host 네트워킹+playwright 가 필요해 이 라이브 5종이 실경로를 대체한다 — 사일런트 캡 아님.)_

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

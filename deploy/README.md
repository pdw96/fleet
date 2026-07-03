# Fleet 웹터미널 스택 (Phase A · #195)

> **Part of #193** (v3 터널 셀프호스트). 설계 근거: `docs/fleet-saas-infra-plan-v3.html` §4·§7·§8·§10 ·
> `docs/adr/0008-saas-전환-v3-터널-셀프호스트-채택.md`.

**"어디서든 브라우저로 `claude` 를 친다"** 를 **Fleet 코드 변경 0** 으로 먼저 가동하는 스택이다.
컨테이너에서 `claude`/`codex`/`gemini` 를 데스크톱과 똑같이 라이브 대화하고, 폰 화면이 꺼지거나 탭을
닫아도 tmux 세션이 살아있어 재접속하면 이어서 본다. 동시에 터널·인증·컨테이너 운영을 실전 검증해
Phase B(전송층 IPC→WS)의 기반 unknown 을 줄인다.

이 스택은 **문 ① 웹터미널** 만이다. **문 ② Fleet 오케스트레이션**(fleet-server·전송층·승인 카드)은
Phase B 이며 이 디렉터리에 `fleet` 서비스로 추가된다.

---

## 구성

```
deploy/
  docker-compose.yml          ttyd + cloudflared(tunnel 프로파일)
  .env.example                환경 변수 (→ .env 로 복사)
  webterminal/
    Dockerfile                node:24-bookworm-slim + CLI 3종(고정) + git + ttyd + tmux, 비특권 node
    entrypoint.sh             tmux eager-start + ttyd(-W -O) exec
    tmux.conf                 세션 영속·모바일 사용성 (/etc/tmux.conf 로 탑재)
  cloudflared/
    config.example.yml        로컬 관리 터널 예시(대안 — 기본은 토큰 기반)
  smoke.sh                    로컬 불변식 검증(터널/폰/로그인 불요)
```

| 서비스        | 이미지                          | 역할                         | 마운트                          |
| ------------- | ------------------------------- | ---------------------------- | ------------------------------- |
| `ttyd`        | 로컬 빌드 `fleet-webterminal`   | 웹터미널(PTY→WebSocket)+tmux | **workspace + cli-auth 만**     |
| `cloudflared` | `cloudflare/cloudflared:2026.6.1` | 터널 사이드카(토큰·무상태)   | **없음**(볼륨·소켓 모두 미마운트) |

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

검증: (1) CLI 3종+ttyd+tmux 존재, (2) 비특권 uid=1000, (3) ttyd HTTP 200 서빙, (4) tmux 세션이
클라이언트 0 에서도 생존, (5) 마운트 = workspace+cli-auth 만·Docker 소켓·fleet-data 미마운트.
`SMOKE_PORT=nnnn` 로 로컬 포트 변경 가능.

---

## 라이브 완료 체크리스트 <a id="live-checklist"></a>

이 스택으로 사용자가 라이브 환경에서 마무리할 항목(#195 완료 정의 중 실측이 필요한 것):

- [ ] 폰 브라우저에서 `terminal.<도메인>` 접속(Access 인증) → `claude` 대화 성공
- [ ] 탭 닫기/화면 끄기 후 재접속 시 tmux 세션 그대로 복귀(진행 중 화면 유지)
- [ ] CLI 로그인 볼륨 동시 세션 간섭 실측 → **#195 코멘트**에 기록 (위 절차)

_(제공됨: 이미지·compose·터널/Access 설정·결정 기록·로컬 스모크. 위 3개는 실제 Cloudflare 계정·구독
로그인·폰이 있어야 하므로 사용자 환경에서 수행한다.)_

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

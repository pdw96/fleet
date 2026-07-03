#!/bin/sh
# Fleet 웹터미널 entrypoint (Phase A · #195). 비특권 node 로 실행된다.
#  1) 로그인 상태 디렉터리 보장 + 자동 업데이트 nag 차단(파일 없을 때만 시드 — 사용자 설정 클로버 금지).
#  2) tmux 서버를 부팅 시 미리 띄운다(detached) — 브라우저 없이도 세션이 존재해, 첫 클라이언트가
#     끊겨도 세션이 죽지 않는다.
#  3) ttyd 를 writable + (기본)cross-origin 거부로 exec. TLS 는 터널 엣지에서 종단.
#
# 네트워크 주의: TTYD_INTERFACE 기본은 0.0.0.0 이다. compose 에서 ttyd·cloudflared 는 분리 서비스라
# cloudflared 가 서비스명(http://ttyd:7681)으로 도달하려면 loopback 이 아니라 컨테이너 인터페이스에
# 바인드해야 한다. 격리는 loopback 이 아니라 «ports 미퍼블리시 + 내부 Docker 망 + 터널 앞 Access» 로
# 확보한다(v3 §7·§8 · ADR-0008).
set -eu

TTYD_PORT="${TTYD_PORT:-7681}"
TTYD_INTERFACE="${TTYD_INTERFACE:-0.0.0.0}"
TTYD_MAX_CLIENTS="${TTYD_MAX_CLIENTS:-5}"
TMUX_SESSION="${TMUX_SESSION:-main}"

# 0) workspace 쓰기 프리플라이트. bind 마운트는 이미지의 `chown node:node /workspace` 를 마스킹하고
#    호스트 소유권을 그대로 노출한다 — 호스트 폴더가 uid 1000(node)이 못 쓰는 소유면(예: Docker 가
#    미존재 bind 소스를 root:root 로 자동 생성) claude/codex 의 파일 쓰기가 조용히 실패한다. 실제로
#    쓰기 불가일 때만(native Linux/WSL2-ext4 의 uid 불일치; Docker Desktop 은 permissivize 되어 통과)
#    원인·해결책과 함께 명확히 중단한다 — healthy 로 뜬 채 쓰기만 깨지는 무성 파손을 막는다.
if ! ( : >"/workspace/.fleet-write-check" ) 2>/dev/null; then
  echo "FATAL: /workspace 에 쓸 수 없습니다 (컨테이너 uid $(id -u) 소유권 불일치)." >&2
  echo "  호스트에서 워크스페이스 폴더 소유권을 컨테이너 유저(uid 1000)로 맞추세요:" >&2
  echo "    sudo chown -R 1000:1000 <WORKSPACE_DIR>     # 예: ./workspace" >&2
  echo "  (Docker Desktop Win/Mac 은 보통 자동 해결됨 — 이 오류는 주로 native Linux/WSL2-ext4)" >&2
  exit 1
fi
rm -f "/workspace/.fleet-write-check" 2>/dev/null || true

# 1) 로그인 상태 디렉터리 (cli-auth 볼륨 = /home/node). named volume 은 이미지 소유를 상속하므로
#    보통 이미 node 소유지만, 최초 bind-mount 등을 대비해 존재만 보장한다.
mkdir -p "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" 2>/dev/null || true

# 자동 업데이트 차단(파일이 없을 때만). 비특권+/usr/local 설치라 persistent self-update 는 어차피
# EACCES 로 실패하지만, 시작 시 nag/hang(gemini)·업데이트 프로브(codex)를 없앤다. claude 는 ENV
# DISABLE_AUTOUPDATER=1 로 처리(Dockerfile).
if [ ! -e "$HOME/.gemini/settings.json" ]; then
  printf '{\n  "general": { "disableAutoUpdate": true, "disableUpdateNag": true }\n}\n' \
    >"$HOME/.gemini/settings.json" 2>/dev/null || true
fi
if [ ! -e "$HOME/.codex/config.toml" ]; then
  printf 'check_for_update_on_startup = false\n' \
    >"$HOME/.codex/config.toml" 2>/dev/null || true
fi

# 2) tmux 서버 미리 기동(detached). 첫 접속/재접속 모두 같은 live 세션에 attach 한다.
tmux -f /etc/tmux.conf new-session -d -s "$TMUX_SESSION" 2>/dev/null || true

# 3) ttyd 인자 조립: writable(-W) 없으면 입력 불가(1.7.4+ 기본 읽기전용) · 클라이언트 상한.
set -- ttyd \
  --interface "$TTYD_INTERFACE" \
  --port "$TTYD_PORT" \
  --writable \
  --max-clients "$TTYD_MAX_CLIENTS"

# cross-origin WebSocket 거부(-O): CSWSH(cross-site WebSocket hijacking) 방어이지 «접근제어»가 아니다.
# 정상 터널에선 cloudflared 가 원본 Host 를 보존해 -O 가 깨질 일이 드물다(→ 끌 이유가 거의 없다).
# ⚠️ 끄면 Access 가 있어도 CSWSH 가 열린다 — Access 쿠키(CF_Authorization)는 기본 SameSite=None 이라
#    악성 사이트발 cross-origin WS 에도 자동 첨부돼 엣지 Access 를 통과한다. 부득이 0 으로 둘 때는
#    반드시 TTYD_CREDENTIAL(basic-auth)을 함께 설정할 것.
if [ "${TTYD_CHECK_ORIGIN:-1}" = "1" ]; then
  set -- "$@" --check-origin
elif [ -z "${TTYD_CREDENTIAL:-}" ]; then
  # fail-closed: -O 를 끄는데 basic-auth 도 없으면 writable 원격 셸이 CSWSH 에 무방비로 열린다.
  # 한 줄 env 변경으로 조용히 취약해지는 것을 막는다(v3 의 fail-closed 원칙).
  echo "FATAL: TTYD_CHECK_ORIGIN=0 인데 TTYD_CREDENTIAL 이 없습니다 — writable ttyd 가 CSWSH 에 노출됩니다." >&2
  echo "  -O 를 끄려면 반드시 TTYD_CREDENTIAL=\"user:password\" 를 함께 설정하세요(.env)." >&2
  echo "  (정상 터널에선 -O 가 깨질 일이 드무니, 대개 TTYD_CHECK_ORIGIN=1 유지가 맞습니다.)" >&2
  exit 1
fi

# 선택: ttyd basic-auth (Access 뒤 심층방어). TTYD_CREDENTIAL="user:pass" 있을 때만.
# 주의: argv 는 컨테이너 내 ps 에 노출된다 — 1차 게이트는 어디까지나 Cloudflare Access.
if [ -n "${TTYD_CREDENTIAL:-}" ]; then
  set -- "$@" --credential "$TTYD_CREDENTIAL"
fi

# 실행 명령 = tmux attach-or-create(-A). -D(다른 클라이언트 detach)는 쓰지 않는다 — 여러 클라이언트가
# 같은 세션을 미러링(랩탑+폰 동시)하게 두고, 재접속 시 stale 클라이언트의 창 크기 clamp 는 tmux.conf 의
# window-size latest + aggressive-resize 로 처리한다(-D 는 live 뷰어까지 축출해 미러링 약속을 깨뜨림).
set -- "$@" tmux -f /etc/tmux.conf new-session -A -s "$TMUX_SESSION"

exec "$@"

#!/usr/bin/env bash
# Fleet 웹터미널 로컬 스모크 (Phase A · #195).
# 라이브 터널/폰/구독 로그인 없이 이미지·컨테이너 «불변식» 을 검증한다.
#
# 통과 = 이미지가 (1) CLI 3종+ttyd+tmux 를 담고, (2) 비특권 node(uid 1000)로 실행되며,
#        (3) ttyd 가 셸을 서빙하고, (4) tmux 세션이 클라이언트 없이도 생존하며,
#        (5) 마운트 범위가 workspace+cli-auth 로 제한되고 Docker 소켓/fleet-data 가 미마운트다.
#
# 검증하지 «못하는» 것(사용자 라이브 환경 필요 — README 「라이브 완료 체크리스트」 참조):
#   실제 Cloudflare 터널·Access, 폰 브라우저 접속, 구독 로그인, CLI 로그인 볼륨 동시 세션 간섭.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="" # step 1(compose build)에서 해석된 이미지명으로 설정
CONTAINER="fleet-webterminal-smoke"
RO_CONTAINER="fleet-webterminal-smoke-ro"
FC_CONTAINER="fleet-webterminal-smoke-fc"
VOL_AUTH="fleet-smoke-cli-auth"
VOL_WS="fleet-smoke-workspace"
HOST_PORT="${SMOKE_PORT:-7681}"
PASS=0
FAIL=0

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() {
  printf '  \033[32mPASS\033[0m %s\n' "$*"
  PASS=$((PASS + 1))
}
bad() {
  printf '  \033[31mFAIL\033[0m %s\n' "$*"
  FAIL=$((FAIL + 1))
}

cleanup() {
  docker rm -f "$CONTAINER" "$RO_CONTAINER" "$FC_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOL_AUTH" "$VOL_WS" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup

log "1) 이미지 빌드 (compose — .env 의 버전 build-arg 를 반영해 실제 배포될 이미지를 검증)"
COMPOSE=(docker compose -f "$SCRIPT_DIR/docker-compose.yml")
[ -f "$SCRIPT_DIR/.env" ] && COMPOSE+=(--env-file "$SCRIPT_DIR/.env")
"${COMPOSE[@]}" build ttyd
IMAGES="$("${COMPOSE[@]}" config --images 2>/dev/null || true)"
IMAGE="$(printf '%s\n' "$IMAGES" | grep '^fleet-webterminal:' | head -n1 || true)"
[ -n "$IMAGE" ] || IMAGE="fleet-webterminal:local"
echo "    빌드·검증 대상 이미지: $IMAGE"

log "2) 도구 존재 + 비특권 실행"
# entrypoint 를 우회. whoami 는 이미지 기본 USER(node)여야 한다. 각 도구를 PATH 에서 찾고(command -v)
# 실제로 --version 이 돈다(버전 출력)를 함께 확인 — 버전 출력에 도구명이 없는 CLI(claude/gemini)도 잡는다.
TOOLS="$(docker run --rm --entrypoint sh "$IMAGE" -lc \
  'echo "user=$(whoami) uid=$(id -u)"; for t in ttyd tmux git node claude codex gemini; do if command -v "$t" >/dev/null 2>&1; then printf "present %s -> " "$t"; "$t" --version 2>&1 | head -n1; else echo "MISSING $t"; fi; done' 2>&1)"
printf '%s\n' "$TOOLS" | sed 's/^/    /'
echo "$TOOLS" | grep -q 'uid=1000' && ok "비특권 실행 (uid=1000 node)" || bad "root 로 실행됨 (uid!=1000)"
for t in ttyd tmux git node claude codex gemini; do
  if echo "$TOOLS" | grep -q "present $t ->"; then ok "도구 존재·실행: $t"; else bad "도구 누락/미동작: $t"; fi
done

log "3) 컨테이너 기동 (named volume 2개 = cli-auth + workspace)"
docker volume create "$VOL_AUTH" >/dev/null
docker volume create "$VOL_WS" >/dev/null
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:${HOST_PORT}:7681" \
  -v "$VOL_WS:/workspace" \
  -v "$VOL_AUTH:/home/node" \
  "$IMAGE" >/dev/null
# ttyd 가 뜰 시간을 준다(폴링).
for _ in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}" || true)"
  [ "$code" = "200" ] && break
  sleep 0.5
done

log "4) ttyd 가 셸을 서빙"
[ "${code:-}" = "200" ] && ok "ttyd HTTP 200 (http://127.0.0.1:${HOST_PORT})" || bad "ttyd 응답 없음 (code=${code:-none})"
# 본문을 파일로 받아 grep(파이프 X) — 700KB+ 본문을 `curl|grep -q` 하면 pipefail+SIGPIPE 로 오탐한다.
BODY_FILE="$(mktemp)"
curl -s "http://127.0.0.1:${HOST_PORT}" -o "$BODY_FILE" || true
grep -qiE 'ttyd|xterm|terminal' "$BODY_FILE" && ok "ttyd 프론트엔드 서빙 확인" || bad "ttyd HTML 아님"
rm -f "$BODY_FILE"

log "5) ttyd 프로세스가 node(uid 1000)로 실행"
PROC_UID="$(docker exec "$CONTAINER" sh -lc 'id -u' 2>/dev/null || echo '?')"
[ "$PROC_UID" = "1000" ] && ok "컨테이너 실행 uid=1000" || bad "컨테이너 실행 uid=$PROC_UID (root?)"

log "6) tmux 세션이 클라이언트 없이 생존 (부팅 시 eager start)"
# 브라우저가 한 번도 붙지 않았어도 detached 세션 main 이 존재해야 한다.
docker exec "$CONTAINER" tmux has-session -t main 2>/dev/null && ok "tmux 세션 main 존재(클라이언트 0)" || bad "tmux 세션 없음"
# 세션 안에 마커를 남기고, 잠시 후에도 살아있는지 → 세션 상태가 지속됨을 실증.
docker exec "$CONTAINER" tmux send-keys -t main 'echo FLEET_SMOKE_MARKER > /tmp/marker.txt' Enter 2>/dev/null || true
sleep 1
MARKER="$(docker exec "$CONTAINER" sh -lc 'cat /tmp/marker.txt 2>/dev/null' || true)"
[ "$MARKER" = "FLEET_SMOKE_MARKER" ] && ok "tmux 세션 내 명령 실행·상태 지속" || bad "tmux 세션 상태 미지속 (marker='$MARKER')"

log "7) 마운트 범위 = workspace + cli-auth 만 · Docker 소켓/fleet-data 미마운트"
MOUNTS="$(docker inspect -f '{{range .Mounts}}{{.Destination}}={{.Source}}{{"\n"}}{{end}}' "$CONTAINER")"
printf '%s' "$MOUNTS" | sed 's/^/    /'
echo "$MOUNTS" | grep -q '^/workspace=' && ok "workspace 마운트 존재" || bad "workspace 마운트 없음"
echo "$MOUNTS" | grep -q '^/home/node=' && ok "cli-auth(/home/node) 마운트 존재" || bad "cli-auth 마운트 없음"
echo "$MOUNTS" | grep -qi 'docker.sock' && bad "Docker 소켓이 마운트됨 (금지!)" || ok "Docker 소켓 미마운트"
echo "$MOUNTS" | grep -qi 'fleet-data' && bad "fleet-data 가 마운트됨 (Phase A 금지!)" || ok "fleet-data 미마운트"
# 마운트 개수 = 정확히 2 (workspace + cli-auth)
MCOUNT="$(printf '%s' "$MOUNTS" | grep -c '=' || true)"
[ "$MCOUNT" = "2" ] && ok "마운트 개수 정확히 2" || bad "마운트 개수=$MCOUNT (기대 2)"

log "8) 쓰기 불가 workspace → 프리플라이트가 loud-fail (bind 소유권 트랩 가드)"
# workspace 를 읽기전용(:ro)으로 마운트 → entrypoint 의 쓰기 프리플라이트가 실패해 명확히 중단해야 한다.
# (호스트 uid 조작 없이 이식성 있게 «쓰기 불가» 조건을 재현 — production 의 root-owned bind 실패와 동형)
docker run -d --name "$RO_CONTAINER" -v "$VOL_WS:/workspace:ro" "$IMAGE" >/dev/null 2>&1 || true
sleep 3
RO_LOGS="$(docker logs "$RO_CONTAINER" 2>&1 || true)"
RO_RUNNING="$(docker inspect -f '{{.State.Running}}' "$RO_CONTAINER" 2>/dev/null || echo unknown)"
echo "$RO_LOGS" | grep -qiE 'FATAL|chown' && ok "쓰기 불가 → 프리플라이트 loud-fail(원인·해결책 로그)" || bad "프리플라이트 미작동 (logs: $RO_LOGS)"
[ "$RO_RUNNING" != "true" ] && ok "가드가 컨테이너를 중단(Running=$RO_RUNNING)" || bad "쓰기 불가인데 컨테이너가 계속 실행됨"

log "9) -O 비활성 + credential 없음 → fail-closed (CSWSH 방어 강제)"
# TTYD_CHECK_ORIGIN=0 인데 TTYD_CREDENTIAL 이 없으면 entrypoint 가 시작을 거부해야 한다(무방비 CSWSH 차단).
docker run -d --name "$FC_CONTAINER" -e TTYD_CHECK_ORIGIN=0 \
  -v "$VOL_WS:/workspace" -v "$VOL_AUTH:/home/node" "$IMAGE" >/dev/null 2>&1 || true
sleep 3
FC_LOGS="$(docker logs "$FC_CONTAINER" 2>&1 || true)"
FC_RUNNING="$(docker inspect -f '{{.State.Running}}' "$FC_CONTAINER" 2>/dev/null || echo unknown)"
echo "$FC_LOGS" | grep -qiE 'CSWSH|TTYD_CREDENTIAL' && ok "-O 끄고 credential 없음 → fail-closed(경고 로그)" || bad "fail-closed 미작동 (logs: $FC_LOGS)"
[ "$FC_RUNNING" != "true" ] && ok "가드가 컨테이너 중단(Running=$FC_RUNNING)" || bad "취약 구성인데 계속 실행됨"

log "결과: PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" = "0" ] || exit 1

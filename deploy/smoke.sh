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
FLEET_IMAGE="" # step 10(compose build fleet)에서 해석
CONTAINER="fleet-webterminal-smoke"
RO_CONTAINER="fleet-webterminal-smoke-ro"
FC_CONTAINER="fleet-webterminal-smoke-fc"
FLEET_CONTAINER="fleet-server-smoke"
VOL_AUTH="fleet-smoke-cli-auth"
VOL_WS="fleet-smoke-workspace"
HOST_PORT="${SMOKE_PORT:-7681}"
FLEET_PORT_SMOKE=8791
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
  docker rm -f "$CONTAINER" "$RO_CONTAINER" "$FC_CONTAINER" "$FLEET_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOL_AUTH" "$VOL_WS" fleet-smoke-data >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup

log "1) 이미지 빌드 (compose — .env 의 버전 build-arg 를 반영해 실제 배포될 이미지를 검증)"
# --profile tunnel — fleet(문②)·cloudflared 가 tunnel 프로파일이라, 이게 없으면 `compose config` 가 fleet 을
# 제외해 아래 fleet 불변식 검사(섹션 12)가 빈 블록으로 무증상 통과한다(canary 로도 잡히나 애초에 포함시킨다).
# ttyd(무프로파일)는 항상 활성이라 영향 없다.
COMPOSE=(docker compose -f "$SCRIPT_DIR/docker-compose.yml" --profile tunnel)
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

# ─────────────────────── 문② fleet 서버 (#197-B6 · Phase B) ───────────────────────
log "10) fleet 이미지 빌드 + 비특권 + 시크릿 미포함"
"${COMPOSE[@]}" build fleet
FLEET_IMAGE="$(printf '%s\n' "$IMAGES" | grep '^fleet-server:' | head -n1 || true)"
[ -n "$FLEET_IMAGE" ] || FLEET_IMAGE="fleet-server:local"
echo "    fleet 이미지: $FLEET_IMAGE"
# 비특권 uid=1000 (root 면 FAIL).
FUID="$(docker run --rm --entrypoint sh "$FLEET_IMAGE" -c 'id -u' 2>&1 || echo '?')"
[ "$FUID" = "1000" ] && ok "fleet 비특권 실행 (uid=1000 node)" || bad "fleet root 실행 (uid=$FUID)"
# 시크릿 이미지 baking 금지 — 빌드 env 에 FLEET_SECRET_KEY/FLEET_ACCESS_ 부재.
FENV="$(docker run --rm --entrypoint sh "$FLEET_IMAGE" -c 'env' 2>&1 || true)"
echo "$FENV" | grep -qE '^FLEET_SECRET_KEY=|^FLEET_ACCESS_' && bad "시크릿이 이미지에 baking 됨!" || ok "이미지 env 에 시크릿 부재"
# 이미지 레이어에 .env 미포함(빌드 컨텍스트 유출 차단).
docker run --rm --entrypoint sh "$FLEET_IMAGE" -c 'ls -a / /app 2>/dev/null' 2>&1 | grep -qE '(^| )\.env( |$)' \
  && bad ".env 가 이미지에 포함됨!" || ok "이미지에 .env 미포함"
# CLI 3종·git·curl 존재.
FTOOLS="$(docker run --rm --entrypoint sh "$FLEET_IMAGE" -c 'for t in node git curl claude codex gemini; do command -v "$t" >/dev/null 2>&1 && echo "present $t" || echo "MISSING $t"; done' 2>&1)"
for t in node git curl claude codex gemini; do
  echo "$FTOOLS" | grep -q "present $t" && ok "fleet 도구 존재: $t" || bad "fleet 도구 누락: $t"
done

log "11) fleet 컨테이너 기동 (loopback 모드) + 정적 200 + fleet-data 0700"
# access env 미설정 + FLEET_HOST unset → loopback(127.0.0.1) 부팅. named volume 이 이미지 node 소유 상속.
docker run -d --name "$FLEET_CONTAINER" \
  -v "$VOL_WS:/workspace" \
  -v "fleet-smoke-data:/app/fleet-data" \
  "$FLEET_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  FCODE="$(docker exec "$FLEET_CONTAINER" curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${FLEET_PORT_SMOKE}/" 2>/dev/null || true)"
  [ "$FCODE" = "200" ] && break
  sleep 0.5
done
[ "${FCODE:-}" = "200" ] && ok "fleet 정적 200 (in-container loopback)" || bad "fleet 응답 없음 (code=${FCODE:-none}) — logs: $(docker logs "$FLEET_CONTAINER" 2>&1 | tail -3)"
# fleet-data 0700 (서버가 런타임 강제 — T5). 컨테이너 내부(linux)라 POSIX mode 유효.
FDMODE="$(docker exec "$FLEET_CONTAINER" stat -c '%a' /app/fleet-data 2>/dev/null || echo '?')"
[ "$FDMODE" = "700" ] && ok "fleet-data 0700" || bad "fleet-data mode=$FDMODE (기대 700)"
# 컨테이너 실행 uid=1000.
FRUID="$(docker exec "$FLEET_CONTAINER" id -u 2>/dev/null || echo '?')"
[ "$FRUID" = "1000" ] && ok "fleet 컨테이너 실행 uid=1000" || bad "fleet 컨테이너 uid=$FRUID"

log "12) compose 불변식 — fleet ports 미공개 · fleet-data 는 fleet 서비스만 · docker.sock 미마운트"
FCONF="$("${COMPOSE[@]}" config 2>/dev/null || true)"
# 서비스 블록 추출(2-space 들여쓰기 서비스 헤더 ~ 다음 서비스/최상위 키까지). python/yaml 의존 회피.
FLEET_BLOCK="$(printf '%s\n' "$FCONF" | awk '/^  fleet:$/{f=1;next} /^  [a-zA-Z]/{f=0} /^[a-zA-Z]/{f=0} f')"
TTYD_BLOCK="$(printf '%s\n' "$FCONF" | awk '/^  ttyd:$/{f=1;next} /^  [a-zA-Z]/{f=0} /^[a-zA-Z]/{f=0} f')"
# canary — 블록 추출이 비어 있으면(config 실패·docker compose 출력포맷 변경으로 awk 앵커 파손) 아래 음성
# 검사(grep -q … || ok)가 무증상 통과해 false-GREEN 이 된다. 추출 성공을 먼저 단언한다(적대리뷰 CONFIRMED#3).
printf '%s' "$FLEET_BLOCK" | grep -q . && ok "fleet 서비스 블록 추출됨(canary)" || bad "fleet 블록 추출 실패 — 이하 불변식 검사 신뢰불가"
printf '%s' "$TTYD_BLOCK" | grep -q . && ok "ttyd 서비스 블록 추출됨(canary)" || bad "ttyd 블록 추출 실패"
# fleet 서비스에 published ports 없음(ports 있으면 config 에 'published:' 출력).
printf '%s' "$FLEET_BLOCK" | grep -q 'published:' && bad "fleet 에 published ports 존재!" || ok "fleet ports 미공개"
# fleet-data 는 fleet 블록에만(ttyd 블록엔 부재 — Phase A 약속 유지).
printf '%s' "$FLEET_BLOCK" | grep -q 'source: fleet-data' && ok "fleet-data 는 fleet 서비스에 마운트" || bad "fleet 에 fleet-data 마운트 없음"
printf '%s' "$TTYD_BLOCK" | grep -q 'fleet-data' && bad "ttyd 에 fleet-data 마운트됨 (Phase A 금지!)" || ok "ttyd 에 fleet-data 미마운트"
# fleet 서비스에 docker.sock 미마운트.
printf '%s' "$FLEET_BLOCK" | grep -qi 'docker.sock' && bad "fleet 에 Docker 소켓 마운트!" || ok "fleet Docker 소켓 미마운트"

# ─────────────────── override(docker-compose.ghcr.yml) 병합 canary (#222 CD) ───────────────────
# 서버측 pull override 가 base 의 build: 를 !reset 으로 제거해 "로컬 빌드 없이 GHCR pull" 이 되는지
# config 로 물성화 검증(서버 없이·빌드 없이). !reset 미지원(Compose <2.24) 이면 config 가 loud-fail.
log "12b) GHCR override 병합 — build:!reset 로 서버가 로컬 빌드 없이 pull(config 물성화)"
GHCR_YML="$SCRIPT_DIR/docker-compose.ghcr.yml"
GHCR_CONF="$(docker compose -f "$SCRIPT_DIR/docker-compose.yml" -f "$GHCR_YML" --profile tunnel config 2>/dev/null || true)"
printf '%s' "$GHCR_CONF" | grep -q . && ok "override 병합 config 생성(!reset 수용)" || bad "override 병합 실패 — Compose 2.24+(!reset) 필요"
GHCR_FLEET="$(printf '%s\n' "$GHCR_CONF" | awk '/^  fleet:$/{f=1;next} /^  [a-zA-Z]/{f=0} /^[a-zA-Z]/{f=0} f')"
GHCR_TTYD="$(printf '%s\n' "$GHCR_CONF" | awk '/^  ttyd:$/{f=1;next} /^  [a-zA-Z]/{f=0} /^[a-zA-Z]/{f=0} f')"
printf '%s' "$GHCR_FLEET" | grep -q . && ok "override fleet 블록 추출(canary)" || bad "override fleet 블록 추출 실패 — 이하 신뢰불가"
printf '%s' "$GHCR_TTYD" | grep -q . && ok "override ttyd 블록 추출(canary)" || bad "override ttyd 블록 추출 실패"
printf '%s' "$GHCR_FLEET" | grep -q 'image: ghcr.io/pdw96/fleet-server' && ok "fleet image=GHCR" || bad "fleet image 가 GHCR 아님"
printf '%s' "$GHCR_FLEET" | grep -q 'build:' && bad "fleet 에 build: 잔존(!reset 미적용 — 서버 로컬 빌드 시도)" || ok "fleet build: 제거됨(!reset)"
printf '%s' "$GHCR_TTYD" | grep -q 'image: ghcr.io/pdw96/fleet-webterminal' && ok "ttyd image=GHCR" || bad "ttyd image 가 GHCR 아님"
printf '%s' "$GHCR_TTYD" | grep -q 'build:' && bad "ttyd 에 build: 잔존(!reset 미적용)" || ok "ttyd build: 제거됨(!reset)"

# 컨테이너 브라우저 스모크(#193 게이트 ③ — 목표 입력→런 완주): host 네트워킹 + FLEET_E2E=1 + 호스트
# playwright(B4 웹스모크 재사용)가 필요하다. CI-이식 bash 스모크 범위를 넘어 라이브 5종(실 터널·폰 브라우저)이
# 실경로를 덮는다 — 사일런트 캡 금지(명시 위임). README 「라이브 완료 체크리스트」 참조.
log "13) 컨테이너 브라우저 런-완주 스모크 → 라이브 5종에 위임(명시)"
echo "    (host 네트워킹+호스트 playwright 필요 · 실 터널/폰 브라우저 라이브 검증이 실경로를 커버)"

# 스모크 전용 데이터 볼륨 정리.
docker volume rm fleet-smoke-data >/dev/null 2>&1 || true

log "결과: PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" = "0" ] || exit 1

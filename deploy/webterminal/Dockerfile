# syntax=docker/dockerfile:1
#
# Fleet 웹터미널 이미지 (Phase A · #195 · Part of #193) — "어디서든 브라우저 터미널".
# node:24-bookworm-slim + claude/codex/gemini CLI(버전 고정) + git + ttyd + tmux.
# Fleet 소스는 담지 않는다(Phase A = Fleet 코드 변경 0). fleet-server·IPC→WS 전송층은 Phase B.
#
# 보안 전제(v3 계획서 §8 · ADR-0008): 이 이미지가 서빙하는 것은 원격 셸이다.
#  - ttyd 는 읽기전용 기본(-W 로만 입력 허용), TLS 는 터널 엣지에서 종단(이미지 안엔 TLS 없음).
#  - 컨테이너는 비특권 `node`(uid 1000)로 실행 — 웹터미널 = node 셸(root 셸이 아니다).
#  - 유일한 사전 방어선은 터널 앞단 인증(Cloudflare Access MFA). 정직한 피해 반경 = workspace + cli-auth.

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

# GHCR 패키지 ↔ 레포 자동 링크(#222 CD) — private-inherit 가시성·provenance. 빌드 라벨일 뿐 env/파일 무변경.
LABEL org.opencontainers.image.source="https://github.com/pdw96/fleet"

# --- CLI/도구 버전 고정 (자동 업데이트 차단; 갱신 = ARG bump → 재빌드 → 스모크 GREEN → 교체) ---
ARG CLAUDE_VERSION=2.1.199
ARG CODEX_VERSION=0.142.5
ARG GEMINI_VERSION=0.49.0
ARG TTYD_VERSION=1.7.7
# ttyd 정적 바이너리 무결성 핀(TOFU) — 릴리스 SHA256SUMS 의 정본 해시를 git 에 커밋해 매 재빌드마다
# 대조한다. 업스트림 릴리스 자산이 사후 변조/재업로드되면 빌드가 명시적으로 실패한다. TTYD_VERSION
# 을 올릴 때 이 두 해시도 함께 갱신한다(새 릴리스의 SHA256SUMS 에서).
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165

# --- OS deps + UTF-8 locale + ttyd 정적 바이너리 (단일 레이어) ---
# ttyd 는 Debian main 에 없다 → GitHub 릴리스의 정적(musl) 바이너리를 arch 별로 받는다.
# tmux 는 apt(bookworm 3.3a). less/procps = 셸 사용성. curl/ca-certificates = 바이너리 페치+git https.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl tmux locales less procps \
 && sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen && locale-gen \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) t=x86_64 ; sha="$TTYD_SHA256_AMD64" ;; \
      arm64) t=aarch64 ; sha="$TTYD_SHA256_ARM64" ;; \
      *) echo "unsupported arch: $arch" >&2 ; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${t}" \
      -o /usr/local/bin/ttyd \
 && echo "${sha}  /usr/local/bin/ttyd" | sha256sum -c - \
 && chmod +x /usr/local/bin/ttyd \
 && ttyd --version \
 && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    DISABLE_AUTOUPDATER=1

# --- CLI 3종 전역 설치 (root 로 /usr/local 에) ---
# 비특권 node 는 이후 실행만 한다 → 런타임 self-update 는 /usr/local 쓰기 EACCES 로 자연 차단.
# claude 는 네이티브 바이너리를 optionalDependencies 로 받으므로 --omit=optional 금지.
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@google/gemini-cli@${GEMINI_VERSION}" \
 && npm cache clean --force \
 && claude --version && codex --version && gemini --version

# 시스템 tmux 설정 — /etc 에 둔다(cli-auth 볼륨 밖 → 이미지 갱신 시 드리프트 없음).
COPY tmux.conf /etc/tmux.conf
COPY entrypoint.sh /usr/local/bin/fleet-webterminal-entrypoint
RUN chmod +x /usr/local/bin/fleet-webterminal-entrypoint

# workspace = 두 문이 공유하는 프로젝트 폴더(compose 에서 바인드). node 소유로 준비.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace

# 비특권 실행. cli-auth named volume 을 /home/node 에 마운트하면 이미지의 node 소유가
# 그대로 복사돼(named-volume 초기화 규칙) 로그인 파일(~/.claude 등) 쓰기가 가능하다.
USER node

# 문서용 — 실제 공개는 하지 않는다(compose 에 ports: 없음, cloudflared 만 내부망으로 도달).
EXPOSE 7681

ENTRYPOINT ["/usr/local/bin/fleet-webterminal-entrypoint"]

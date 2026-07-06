# syntax=docker/dockerfile:1
#
# Fleet 서버 이미지 (Phase B · #197-B6 · Part of #193) — 브라우저 오케스트레이션 UI(문②).
# fleet-server(코어 엔진 + renderer 정적 서빙 + WS 전송층)를 헤드리스로 구동한다.
#
# 보안 전제(v3 §7·§8 · ADR-0008):
#  - 비특권 `node`(uid 1000) 실행 → 서버가 spawn 하는 전 자식(CLI 세션·MCP·verify·git)이 자동 비특권.
#  - 시크릿(FLEET_SECRET_KEY·FLEET_ACCESS_*)은 런타임 env 주입만 — 이미지/볼륨에 baking 금지.
#  - 자식 env 격리(#197-B6): 서버가 allowlist 로 FLEET_* 를 자식에서 제거(코드층 · child-env.ts).
#  - ports 미공개 — 도달 경로는 cloudflared 내부망뿐(compose 에 ports: 없음).

ARG NODE_IMAGE=node:24-bookworm-slim

# ── builder: 레포 빌드 → out/{server,renderer,...} ─────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /build
# electron 바이너리(~수백 MB) 다운로드 스킵 — 서버/renderer 번들 빌드는 electron 런타임 불요.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
# .dockerignore 가 node_modules/out/.git 를 제외하므로 위 npm ci 산출 node_modules 는 보존된다.
COPY . .
RUN npm run build # electron-vite build + vite(server) → out/server/index.mjs + out/renderer

# ── runtime: CLI 3종 + 프로덕션 node_modules + out/ ────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# CLI 버전 고정(webterminal 과 동일 패턴 — 자동 업데이트 차단; 갱신 = ARG bump → 재빌드 → 스모크 GREEN).
ARG CLAUDE_VERSION=2.1.199
ARG CODEX_VERSION=0.142.5
ARG GEMINI_VERSION=0.49.0

# git = 워크스페이스 스냅샷/verify · curl = healthcheck/스모크 · locale = UTF-8 · less/procps = 진단.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl locales less procps \
 && sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LANGUAGE=en_US:en \
    LC_ALL=en_US.UTF-8 \
    DISABLE_AUTOUPDATER=1

# CLI 3종 전역 설치(root 로 /usr/local). 비특권 node 는 실행만 — 런타임 self-update 는 EACCES 로 자연 차단.
# claude 네이티브 바이너리는 optionalDependencies → --omit=optional 금지.
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@google/gemini-cli@${GEMINI_VERSION}" \
 && npm cache clean --force \
 && claude --version && codex --version && gemini --version

WORKDIR /app
# 프로덕션 런타임 dep만(ws·jose·cross-spawn·which·safe-regex — 서버 번들 externals). electron 은 devDep 라 미설치.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
# 빌드 산출물 — out/server/index.mjs 와 out/renderer 를 sibling 으로 배치(boot 정적서빙 기본 = ../renderer).
COPY --chown=node:node --from=builder /build/out ./out

# fleet-data 0700 강제는 서버가 런타임에 수행(T5). named-volume 초기화가 node 소유를 상속하도록 미리 node
# 소유로 만든다(volume 을 미존재 경로에 마운트하면 root 소유 → EACCES). workspace 는 compose 바인드.
ENV FLEET_DATA_DIR=/app/fleet-data
RUN mkdir -p /app/fleet-data /workspace && chown node:node /app/fleet-data /workspace

USER node
# 문서용 — 실제 공개 없음(compose ports: 없음 · cloudflared 내부망만 도달). 기본 포트 8791(FLEET_PORT).
EXPOSE 8791
CMD ["node", "out/server/index.mjs"]

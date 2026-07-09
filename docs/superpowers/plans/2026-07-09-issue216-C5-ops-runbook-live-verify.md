# C5 — 운영 런북 + 라이브 실측 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Phase C(#216) 완료 정의("외출 중 폰 승인 → PC 런 완주")를 운영자가 운용 가능한 **운영 런북** +
반복 검증 **로컬 하니스**로 성립시키고, 실 폰/실 터널 라이브 실측을 사용자 협업으로 위임(Part of #216).

**Architecture:** 프로덕션 동작은 C1~C3 로 이미 출하 — C5 는 **문서화·검증층**. (1) `deploy/README.md` 「운영」에
백업·키로테이션·드레인업그레이드 런북 3섹션 추가, (2) 완료정의 코어를 지키는 e2e 2종(교차컨텍스트 승인 핸드오프 ·
graceful drain) 커밋, (3) drain 관측성용 `boot.ts` 1-line 로그. 유일 프로덕션 src 변경 = 그 1-line.

**Tech Stack:** Playwright(@playwright/test·기존 `e2e/*.web.e2e.ts` 패턴) · Node child_process(기존
`e2e/web-server.ts`) · Markdown 런북 · Docker/Compose(런북 대상).

## Global Constraints (스펙에서 verbatim)

- **런북 오문 = 위험** — §1.2 키 로테이션 3점(재암호화 없음·수동 재등록·조용한 드롭)을 정확히. 완료조건 1 = "§1.2
  hard truth 오문 0". 모든 런북 주장은 커밋 전 코드 라인 재확인.
- **볼륨명** = `fleet-webterminal_fleet-data`(compose `name: fleet-webterminal` 고정) — 하드코딩 금지·**동적 해소** 지시.
- **키 로테이션** = 조용한 드롭·재암호화 경로 0·수동 재등록(동일 provider/session id)·라이브 세션 목록이 권위 검증.
- **시크릿 누락 2갈래** — `FLEET_ACCESS_*`=crash-loop(loud) / `FLEET_SECRET_KEY`=조용한 GREEN 강등.
- **`FLEET_E2E=1` = 프로덕션 P1 격리 가드** — 운영 compose 절대 미주입. e2e 한정.
- **drain 하니스 = win32 skip**(kill=force-terminate·실 SIGTERM 미발화). docker `stop_grace_period` 나이앙스는 §2b 위임.
- **커밋 트레일러**(레포 규약):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BAkXfc9J7wCN1fgVCKEQnG
  ```
- 상세 계약 = `docs/superpowers/specs/2026-07-09-issue216-C5-ops-runbook-live-verify-design.md` (스펙 권위).

## File Structure

- Create: `e2e/approval-handoff.web.e2e.ts` — 교차컨텍스트 승인 핸드오프 회귀 하니스(완료정의 코어).
- Create: `e2e/drain.e2e.ts` — graceful drain 프로세스급 회귀 하니스(Linux-gated).
- Modify: `e2e/web-server.ts` — SIGTERM+종료 타이밍·stdout 캡처 헬퍼 `startFleetWebServerRaw` 추가.
- Modify: `src/server/boot.ts:675` — drain 관측성 1-line `console.warn`(runbook 로그 가시성·drain e2e 결정론 관측).
- Modify: `deploy/README.md` 「운영」 — 런북 3섹션(백업·로테이션·드레인업그레이드) + 2b 라이브 체크리스트 정제.
- Modify: `deploy/pull-deploy.sh:9` — FLEET_SECRET_KEY/FLEET_ACCESS_* 뭉뚱그림 주석 정정.

---

### Task 1: drain 관측성 로그 + web-server 드레인 헬퍼

**Files:**
- Modify: `src/server/boot.ts:675`
- Modify: `e2e/web-server.ts`

**Interfaces:**
- Produces: `startFleetWebServerRaw(extraEnv?): Promise<RawWebServer>` where
  `RawWebServer = { url: string; sigterm(): void; waitExit(): Promise<{ code: number | null; elapsedMs: number; stdout: string }> }`.
  Task 3(drain e2e)가 소비.
- Produces: boot stdout 에 `[fleet] draining` 라인(drain 시작 시 1회).

- [ ] **Step 1: boot.ts drain 로그 추가**

`src/server/boot.ts:675`(broadcast 직전)에 1-line 추가:

```ts
    shutdownPromise = (async () => {
      // ② 클라 통지(best-effort) — attach(인증 통과) 소켓만 도달·safeSend 격리. 정적 페이로드(민감값 0).
      console.warn('[fleet] draining — 신규 런 거부·진행 런 완료 대기 후 종료(#216 C3)') // 운영 로그 가시성(C5 런북 §1.3)
      wsHost?.broadcast('fleet:server:draining', { reason: 'shutdown' })
```

- [ ] **Step 2: web-server.ts 에 raw 헬퍼 추가**

`e2e/web-server.ts` 끝에 추가(기존 `startFleetWebServer` 의 spawn/포트파싱 로직 재사용·중복 최소화를 위해
내부 spawn 을 공유 헬퍼로 뽑아도 좋으나, 최소 변경으로 별도 export 도 허용). 아래는 별도 export 형태:

```ts
export interface RawWebServer {
  url: string
  sigterm(): void
  waitExit(): Promise<{ code: number | null; elapsedMs: number; stdout: string }>
}

/**
 * drain e2e 전용(#216 C5) — 서버 프로세스에 실 SIGTERM 을 보내고 종료 타이밍·stdout 을 관측한다.
 * `stop()` 대신 sigterm()+waitExit() 로 드레인 시퀀스(대기 경과·clean exit·draining 로그)를 단언한다.
 * win32 에서 kill('SIGTERM') 은 강제 종료라 드레인이 발화하지 않는다 — 호출측이 skip 한다.
 */
export async function startFleetWebServerRaw(
  extraEnv: Record<string, string> = {},
): Promise<RawWebServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'fleet-drain-e2e-'))
  const child = spawn(process.execPath, [resolve(__dirname, '..', 'out', 'server', 'index.mjs')], {
    env: { ...process.env, FLEET_E2E: '1', FLEET_PORT: '0', FLEET_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
  const url = await new Promise<string>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`기동 타임아웃:\n${out}`)), 15_000)
    const onData = () => {
      const m = out.match(/fleet-server: (http:\/\/127\.0\.0\.1:\d+)/)
      if (m) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        res(m[1])
      }
    }
    child.stdout?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      rej(new Error(`조기 종료(code ${code}):\n${out}`))
    })
  })
  return {
    url,
    sigterm: () => child.kill('SIGTERM'),
    waitExit: () =>
      new Promise((res) => {
        const t0 = Date.now()
        if (child.exitCode !== null || child.signalCode !== null) {
          rmSync(dataDir, { recursive: true, force: true })
          res({ code: child.exitCode, elapsedMs: 0, stdout: out })
          return
        }
        child.once('exit', (code) => {
          rmSync(dataDir, { recursive: true, force: true })
          res({ code, elapsedMs: Date.now() - t0, stdout: out })
        })
      }),
  }
}
```

> ⚠️ `waitExit()` 의 `t0` 는 호출 시점이다 — drain e2e 는 `sigterm()` **직후** `waitExit()` 를 호출해 경과가
> drain 대기와 정렬되게 한다(아래 Task 3 참조).

- [ ] **Step 3: 타입/빌드 확인**

Run: `npm run build` (또는 `npm run typecheck`)
Expected: PASS (신규 export·1-line 로그가 타입 통과). drain e2e 가 out/server/index.mjs 를 쓰므로 빌드 필수.

- [ ] **Step 4: 커밋**

```bash
git add src/server/boot.ts e2e/web-server.ts
git commit -m "feat(#216-C5): drain 관측성 로그 + web-server SIGTERM/타이밍 헬퍼

boot 종료 시 '[fleet] draining' 1-line(운영 로그 가시성·런북 §1.3). drain e2e 전용
startFleetWebServerRaw(sigterm+waitExit+stdout 캡처)."
```

---

### Task 2: 교차컨텍스트 승인 핸드오프 e2e (완료정의 코어 회귀 하니스)

**Files:**
- Create: `e2e/approval-handoff.web.e2e.ts`

**Interfaces:**
- Consumes: `startFleetWebServer` (기존 `e2e/web-server.ts`).

이 테스트는 **기존 출하 동작(C1 hold + listPendingApprovals)에 대한 회귀 하니스**다 — 새 프로덕션 코드를
구동하지 않고, 완료정의 코어(A 완전 close → fresh 컨텍스트 B 재하이드레이션)를 결정론 고정한다. 따라서 첫 실행에서
**PASS 가 정상**(RED 는 "동작이 이미 있으니 초록"이며, 회귀 시 적색이 된다).

- [ ] **Step 1: 테스트 작성**

`e2e/approval-handoff.web.e2e.ts`:

```ts
import { expect, test } from '@playwright/test'
import { startFleetWebServer, type RunningWebServer } from './web-server'

/**
 * C5 승인 핸드오프(#216) — 완료정의("외출 중 폰 승인 → PC 이어서") 코어의 로컬 loopback 회귀 하니스.
 * 컨텍스트 A(PC)에서 held 승인을 유발하고 **A 컨텍스트를 완전 close**(소켓 단절·presence→0)한 뒤, **fresh
 * 컨텍스트 B(폰뷰)**가 listPendingApprovals 스냅숏으로 카드를 재제시받아 승인 → withdrawn 을 검증한다.
 * 기존 approval-hold 테스트는 **같은 컨텍스트 reload** 만 증명 — 이 테스트는 **별도 컨텍스트 완전 teardown**
 * 후 재하이드레이션으로 진짜 presence 전이 정황을 증명한다(실 Access-인증 교차 핸드오프는 C5 §2b 라이브 위임).
 * loopback 은 컨텍스트별 auth/nonce 가 없어 clientCount 를 black-box 로 직접 단언할 수 없으므로, 주장은
 * "A close → 서버가 재하이드레이션으로 B 에 pending 재제시"로 한정한다(Codex 체크포인트 P2).
 */
test.describe('C5 승인 핸드오프(#216) — 컨텍스트 A close → fresh 컨텍스트 B 재하이드레이션', () => {
  let server: RunningWebServer

  test.beforeAll(async () => {
    server = await startFleetWebServer()
  })
  test.afterAll(async () => {
    await server?.stop()
  })

  test('A held 승인 → A 완전 close → B(폰뷰) 스냅숏 재제시 → 승인 소멸', async ({ browser }) => {
    // 컨텍스트 A(PC) — MCP spawn(destructive) 게이트로 held 승인 유발.
    const ctxA = await browser.newContext()
    const pageA = await ctxA.newPage()
    await pageA.goto(server.url)
    await pageA.getByText('FLEET').first().waitFor()
    await pageA.evaluate(() => {
      void (
        window as unknown as { fleet: { setMcpServers: (s: unknown[]) => Promise<unknown> } }
      ).fleet
        .setMcpServers([{ name: 'c5-handoff', command: 'nonexistent-approval-probe' }])
        .catch(() => undefined)
    })
    await expect(pageA.getByText('MCP 서버 실행: c5-handoff')).toBeVisible({ timeout: 10_000 })

    // A 컨텍스트 완전 teardown — WS 소켓 단절, presence→0. hold 정책이라 held 승인은 생존해야 한다.
    await ctxA.close()

    // fresh 컨텍스트 B(폰뷰) — App mount 가 listPendingApprovals 스냅숏으로 카드 재제시.
    // (B 가 카드를 본다는 것 자체가 "A close 후 서버가 held 를 유지했다"는 증명 — withdrawn 이었으면 안 보임.)
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const pageB = await ctxB.newPage()
    await pageB.goto(server.url)
    await pageB.getByText('FLEET').first().waitFor()
    await expect(pageB.getByText('MCP 서버 실행: c5-handoff')).toBeVisible({ timeout: 10_000 })

    // B 에서 승인 → respondApproval → 서버 resolve → withdrawn → 카드 소멸.
    await pageB.getByRole('button', { name: '승인' }).click()
    await expect(pageB.getByRole('dialog')).toHaveCount(0)
    await ctxB.close()
  })
})
```

- [ ] **Step 2: 빌드(번들 최신화) 후 테스트 실행**

Run: `npm run build && npx playwright test e2e/approval-handoff.web.e2e.ts --project=chromium`
(정확한 project 명/러너는 `playwright.config.ts` 확인 — 기존 web e2e 와 동일 커맨드 사용.)
Expected: PASS(1 passed). 카드가 A close 후 B 에서 재제시되고 승인 시 소멸.

- [ ] **Step 3: 회귀 민감도 확인(선택·수동)**

핸드오프가 진짜 검증되는지 확인하려면 임시로 hold 정책을 끄거나 listPendingApprovals 를 빈 배열로 만들면 B 의
카드 단언이 실패해야 한다(확인 후 원복). *실제로 코드 변경 없이 넘어가도 무방 — 회귀 하니스임.*

- [ ] **Step 4: 커밋**

```bash
git add e2e/approval-handoff.web.e2e.ts
git commit -m "test(#216-C5): 교차컨텍스트 승인 핸드오프 e2e(완료정의 코어)

컨텍스트 A held 승인 → A 완전 close(presence→0) → fresh 컨텍스트 B(폰뷰)가
listPendingApprovals 스냅숏 재제시 → 승인 소멸. 기존 reload 테스트와 달리 별도
컨텍스트 완전 teardown 후 재하이드레이션 검증(Codex P2 반영 — clientCount 직접단언 대신 주장 한정)."
```

---

### Task 3: graceful drain e2e (프로세스급 드레인 시퀀스 회귀 하니스)

**Files:**
- Create: `e2e/drain.e2e.ts`

**Interfaces:**
- Consumes: `startFleetWebServerRaw` (Task 1).

- [ ] **Step 1: 테스트 작성**

`e2e/drain.e2e.ts`:

```ts
import { expect, test } from '@playwright/test'
import { startFleetWebServerRaw, type RawWebServer } from './web-server'

/**
 * C5 graceful drain(#216 C3) 프로세스급 회귀 하니스 — hang 런(기본 e2e 러너가 planTasks 에서 hang)을 활성으로
 * 만든 뒤 서버 프로세스에 **실 SIGTERM** 을 보내, 드레인 시퀀스(draining 브로드캐스트/로그 → waitForRunDrain 이
 * 진행 런을 상한까지 대기 → force close → clean exit 0)를 단언한다. 유휴 서버 SIGTERM 은 즉시 종료(false-green)
 * 이므로 hang 런으로 activeProjectIds 를 채우고 **경과 ≥ 상한** canary 로 실제 대기를 증명한다.
 * win32 는 kill('SIGTERM')=강제 종료라 드레인 미발화 → skip(실 docker stop 조율은 C5 §2b 라이브 위임).
 */
test.describe('C5 graceful drain(#216 C3) — hang 런 활성 중 SIGTERM → 대기 → clean exit', () => {
  test.skip(
    process.platform === 'win32',
    'win32 kill=강제 종료 — 드레인 미발화(실 Linux SIGTERM 필요·§2b docker 위임)',
  )

  test('hang 런 활성 → SIGTERM → draining 로그 + drain 상한 대기(경과 canary) + clean exit 0', async ({
    browser,
  }) => {
    // 짧은 drain 상한(2500ms)으로 기동 — hang 런은 abort 를 미honor 하므로 상한까지 대기 후 force close.
    const server: RawWebServer = await startFleetWebServerRaw({ FLEET_DRAIN_TIMEOUT_MS: '2500' })
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(server.url)
    await page.getByText('FLEET').first().waitFor()

    // hang 런 개시(기본 러너 planTasks hang) → activeProjectIds 비지 않음(취소 버튼 = 진행 잠금).
    await page.getByRole('button', { name: '프로젝트' }).click()
    await page.getByPlaceholder(/사용자 인증/).fill('C5 drain — hang 목표')
    await page.getByRole('button', { name: '오케스트레이션 실행' }).click()
    await expect(page.getByRole('button', { name: '취소' })).toBeVisible()

    // 실 SIGTERM → 드레인 시작. 브라우저(WS 클라)가 draining 배너 관측(broadcast 증명·best-effort·race 허용).
    server.sigterm()
    await expect(page.getByRole('status').filter({ hasText: '서버 종료 중' })).toBeVisible({
      timeout: 8_000,
    })

    // 프로세스가 drain 상한만큼 대기 후 종료. 경과 ≥ ~상한 = 진짜 대기(유휴 즉시종료 false-green 차단).
    const { code, elapsedMs, stdout } = await server.waitExit()
    expect(stdout).toContain('[fleet] draining') // 결정론 broadcast 관측(로그)
    expect(elapsedMs).toBeGreaterThanOrEqual(2000) // ≥ ~상한: 실제 드레인 대기 증명
    expect(code).toBe(0) // clean shutdown(exit 0)
    await ctx.close()
  })
})
```

> ⚠️ 구현 노트: (1) `sigterm()` 후 `waitExit()` 를 **즉시** await 하되, draining 배너 단언은 그 전에 건다
> (배너는 close 전 ~2.5s 창에서만 표시되고 close 후 reconnecting 으로 전이하므로). 배너 race 가 flaky 하면
> 배너 단언을 제거하고 `stdout` 의 `[fleet] draining` 만 결정론 관측으로 남긴다(로그가 권위). (2) `취소` 버튼
> 텍스트/placeholder 는 `e2e/web-orchestration.web.e2e.ts` 와 동일 — 변경 시 그 파일 기준으로 맞춘다.

- [ ] **Step 2: 빌드 후 실행(Linux/WSL2)**

Run: `npm run build && npx playwright test e2e/drain.e2e.ts --project=chromium`
Expected(Linux): PASS. `elapsedMs≈2500+`·exit 0·stdout 에 draining. Expected(win32): SKIPPED.

- [ ] **Step 3: 커밋**

```bash
git add e2e/drain.e2e.ts
git commit -m "test(#216-C5): graceful drain 프로세스급 e2e(Linux-gated)

hang 런 활성 중 실 SIGTERM → draining 로그 + drain 상한 대기(경과 canary·유휴 false-green
차단) + clean exit 0. win32 skip(kill=force). docker stop_grace_period 조율은 §2b 라이브 위임."
```

---

### Task 4: 런북 §1.1 — fleet-data 백업·복원 (deploy/README.md)

**Files:**
- Modify: `deploy/README.md` 「운영」 섹션(현 line ~405-418 뒤에 하위 섹션 추가)

스펙 §1.1 계약을 산문+명령으로. **반드시 포함**(각 항목 코드 라인은 커밋 전 재확인):

- 영속물 = 단일 `<volume>/fleet/fleet-store.json`(atomic tmp+rename·`.corrupt`=과거 파싱 실패).
- 볼륨 실제명 = **동적 해소**(하드코딩 금지):
  ```bash
  # 정확한 named volume 명 확인(compose name: fleet-webterminal 프리픽스)
  docker compose -f deploy/docker-compose.yml config --volumes   # → fleet-data (키)
  docker volume ls | grep fleet-data                             # → fleet-webterminal_fleet-data (실제명)
  ```
- 백업(helper 컨테이너 tar·`.tmp` 제외·진짜 일관 필요 시 `docker stop`/드레인 후):
  ```bash
  VOL=$(docker volume ls -q | grep fleet-data)   # 실제명 해소
  docker run --rm -v "$VOL":/data:ro -v "$PWD":/backup alpine \
    tar czf /backup/fleet-data-$(git rev-parse --short HEAD).tgz -C /data ./fleet/fleet-store.json
  ```
  ⚠️ **백업 파일 전체를 기밀로 취급** — store JSON 은 messages/events/tasks output 을 평문으로 담는다.
- `FLEET_SECRET_KEY` 를 **볼륨과 다른 저장소에 별도 에스크로**(API 세션 등록한 배포 한정 — 구독 CLI 만이면 무의미).
- 복원 + **트리 전체 chown**(2증상 명시):
  ```bash
  docker run --rm -v "$VOL":/data -v "$PWD":/backup alpine sh -c \
    'tar xzf /backup/fleet-data-<sha>.tgz -C /data && chown -R 1000:1000 /data'
  ```
  - (a) mount root(dataDir) root 소유 → 부팅 시 `chmodSync` **EPERM crash-loop(loud)**.
  - (b) 하위 `fleet/`·`fleet-store.json` root 소유 → boot 통과하나 **store write 실패=영속 불능(조용)**.
- 복원 검증 = **라이브 세션 목록 비었지 않음(권위)** + `docker logs` grep `복호화 실패`/`영속되지 않는다` 부재(보조).
- pending 승인 = in-memory(복원 0 = by design·손실 아님). 서버 `ev1:`↔데스크톱 `v1:` 비호환(교차 복원 금지).
- `cli-auth` 볼륨(`/home/node` CLI 로그인)은 재로그인 가능이라 백업 선택.

- [ ] **Step 1: 섹션 작성**(위 계약을 산문으로).
- [ ] **Step 2: 코드 라인 재확인** — `boot.ts:381,386-388` · `json-file.ts:27-28,52` · `env-key-crypto.ts:24` ·
  `compose:13,100-102,147-149` · `store/types.ts:44,50-68` 인용이 현행과 일치하는지 대조.
- [ ] **Step 3: 커밋**
  ```bash
  git add deploy/README.md
  git commit -m "docs(#216-C5): 운영 런북 §1.1 — fleet-data 백업·복원

  단일 fleet-store.json·동적 볼륨명 해소·키 별도 에스크로·백업 전체 기밀·복원 트리 chown(2증상)·
  라이브 목록 권위 검증·pending in-memory·cross-runtime 비호환."
  ```

---

### Task 5: 런북 §1.2 — FLEET_SECRET_KEY 키 로테이션 (deploy/README.md)

**Files:**
- Modify: `deploy/README.md` 「운영」(§1.1 뒤)

스펙 §1.2 계약. **반드시 포함**:

- 포맷 = 64 hex 또는 32B base64. 공백 영향 **포맷별**(hex=실패 강등 / base64=Node 디코더 관용) → "공백=항상
  실패" 오문 금지·두 포맷 공백 없이 권장.
- `ev1:`=포맷 버전이지 키 버전 아님 → **듀얼키 오버랩 불가·무중단 로테이션 불가**.
- **로테이션 = 전 API 세션 조용히 드롭**(catch+continue+warn·크래시/평문폴백 없음·UI/헬스 미노출).
- **재암호화 경로 0** → **모든 API 키 수동 재등록**(⚠️ 동일 provider/session id → upsert 가 고아 자동 덮음).
- triage: `암호화 미가용`(키 미설정) vs `복호화 실패`(키 틀림). positive "key OK" 로그 없음 → **라이브 세션 목록 권위**.
- CLI 세션 무영향.
- 절차:
  ```bash
  openssl rand -hex 32                 # 새 키(공백 없이 .env 의 FLEET_SECRET_KEY 에)
  # 백업(§1.1) → .env 교체 → 재배포(§1.3 드레인) →
  docker logs <fleet> 2>&1 | grep -E '복호화 실패|API 세션 복원 skip'   # 드롭된 세션 확인
  # → 각 API 키를 동일 provider/session id 로 재등록 → 라이브 세션 목록 비었지 않음 확인
  ```
- TUNNEL_TOKEN·GHCR PAT 로테이션은 외부 콘솔 절차 → 포인터만.

- [ ] **Step 1: 섹션 작성**.
- [ ] **Step 2: 코드 라인 재확인** — `env-key-crypto.ts:12-14,30,35` · `engine.ts:489,502-513,569-595`.
- [ ] **Step 3: 커밋**
  ```bash
  git add deploy/README.md
  git commit -m "docs(#216-C5): 운영 런북 §1.2 — FLEET_SECRET_KEY 키 로테이션

  hard truth: 조용한 드롭·재암호화 0·수동 재등록(동일 id)·포맷별 공백·triage 2메시지·라이브 목록 권위."
  ```

---

### Task 6: 런북 §1.3 + pull-deploy.sh 주석 정정 (deploy/README.md · deploy/pull-deploy.sh)

**Files:**
- Modify: `deploy/README.md` 「운영」(§1.2 뒤)
- Modify: `deploy/pull-deploy.sh` 주석(현 line ~9 부근 FLEET_SECRET_KEY/FLEET_ACCESS_* 뭉뚱그림)

스펙 §1.3 계약. **반드시 포함**:

- 종료 시퀀스(C3): draining→broadcast→waitForRunDrain(런만·cap)→close(rejectAll→terminate→dispose).
- 불변식 `STOP_GRACE ≥ DRAIN/1000+3` **코드 미강제** → 상한 올리면 STOP_GRACE 동반 필수(안 그러면 SIGKILL 절단).
- **grace/drain 상향은 다음 종료부터** 유효(이번 정지되는 구 컨테이너는 생성 시점 grace).
- `up -d --wait` = NOT blue-green(헬스 실패=구 컨테이너 이미 소멸) → 롤백 `GHCR_TAG=sha-<이전>`+compose 되돌림.
- **pending 승인 중 재배포**: 런에 묶인 승인=cap(~25s) 후 rejectAll / 독립 승인=거의 즉시(~0s) → pending 중 재배포 지양.
- **시크릿 2갈래**: (1) `FLEET_ACCESS_*` 부분/전무+`FLEET_HOST=0.0.0.0` → crash-loop→300s 타임아웃(loud). (2)
  `FLEET_SECRET_KEY` 미설정/오류 → **크래시 아님·GREEN**·API 미영속(조용한 강등) → `docker logs` grep `영속되지 않는다`.
  **GREEN 은 FLEET_ACCESS_* 만 검증**.
- 재배포 로그로 드레인 확인 = `docker logs` grep `[fleet] draining`(Task 1 로그).

- [ ] **Step 1: README §1.3 작성**.
- [ ] **Step 2: pull-deploy.sh:9 주석 정정** — 현행:
  `up --wait GREEN 은 … FLEET_ACCESS_*·FLEET_SECRET_KEY 완비를 전제` →
  정정: `up --wait GREEN 은 FLEET_ACCESS_* 완비를 전제(FLEET_HOST=0.0.0.0). FLEET_SECRET_KEY 누락은 GREEN 을
  막지 않고 API 키 미영속(조용한 강등)이 되므로 docker logs 로 별도 확인` (정확 문구는 파일 문맥에 맞춰 다듬음).
- [ ] **Step 3: 코드 라인 재확인** — `boot.ts:193-201,667-683` · `security-config.ts:36-42` · `compose:74-75,117` ·
  `pull-deploy.sh:54` · `smoke.sh:191-193` · ADR-0011.
- [ ] **Step 4: 커밋**
  ```bash
  git add deploy/README.md deploy/pull-deploy.sh
  git commit -m "docs(#216-C5): 운영 런북 §1.3 드레인-인지 업그레이드 + pull-deploy 주석 정정

  시퀀스·불변식 미강제·NOT blue-green·pending 중 재배포 위험·시크릿 2갈래(ACCESS crash-loop /
  SECRET_KEY 조용한 GREEN 강등)·drain 로그. pull-deploy.sh 뭉뚱그림 주석 분리."
  ```

---

### Task 7: 2b 라이브 체크리스트 정제 + verify + brain + 자체 적대리뷰

**Files:**
- Modify: `deploy/README.md` 라이브 완료 체크리스트(현 line ~296-318)
- Regenerate: `brain.md`(src 변경 = Task 1 boot.ts → **모든 src 변경 후 최종에** 재생성)

- [ ] **Step 1: 2b 체크리스트 정제** — 기존 「문 ② 라이브 체크리스트」의 승인 보류 항목을 완료정의 흐름으로
  다듬는다(이미 상당히 정확 — C5 §2b 문구와 정합화·`docker stop` 실 드레인 관측 항목 추가):
  - [ ] 실 터널+실 폰 Access → 세션 등록 → 목표 → 런 → 위험 작업 승인 요청 → **PC 탭 닫기** → 폰 재접속 →
        스냅숏 카드 재제시 → **폰 승인 → PC 런 이어서 완주**
  - [ ] 배포 컨테이너 `docker stop` → `docker logs` 에 `[fleet] draining` → 진행 런 대기 → clean exit(유예 내)
  - [ ] 결과를 #216 코멘트로 기록(통과 시 마지막 PR `Closes #216`)
- [ ] **Step 2: brain 재생성**(src 변경 반영·최종):
  Run: `npm run brain:generate`(또는 레포 규약 커맨드 — `AGENTS.md` 확인). 이후 추가 src 변경 금지.
- [ ] **Step 3: verify 7게이트**:
  Run: `npm run verify`(레포 7게이트 — typecheck·lint·format:check·test·brain:check·skills:lint 등 `AGENTS.md` 기준)
  Expected: 전 게이트 GREEN.
- [ ] **Step 4: 전체 e2e**:
  Run: `npm run build && npx playwright test`(신규 2 + 기존 무회귀). win32 는 drain skip 확인.
  로컬 win 병렬 spawn flake 시 `--workers=1` 또는 `--no-file-parallelism`(memory).
- [ ] **Step 5: 자체 적대리뷰** — `fleet-finder` 다렌즈(**런북 안전주장 정확성 렌즈 포함**) → `fleet-refuter` verify.
  correctness P1/P2 0 목표. 발견은 반영 후 재확인.
- [ ] **Step 6: 커밋**(brain + 체크리스트):
  ```bash
  git add deploy/README.md brain.md
  git commit -m "docs(#216-C5): 2b 라이브 체크리스트 정제 + brain 재생성

  완료정의 흐름(폰 승인→PC 완주)·docker stop drain 관측 항목. brain = boot drain 로그 반영."
  ```

---

## Self-Review

**1. Spec coverage:**
- §1.1 백업 → Task 4 ✅ / §1.2 로테이션 → Task 5 ✅ / §1.3 업그레이드+pull-deploy → Task 6 ✅
- Part 2a e2e 핸드오프 → Task 2 ✅ / drain 하니스 → Task 3(+Task 1 로그·헬퍼) ✅
- Part 2b 라이브 체크리스트 → Task 7 ✅ / 완료조건 4(적대리뷰)·5(verify) → Task 7 ✅
- 완료조건 6(PR Part of #216·C4 후속·CLOSE 위임) → 이 계획 밖(태스크 관리 #8) — PR 단계에서.

**2. Placeholder scan:** pull-deploy.sh 주석 정정 문구는 "파일 문맥에 맞춰 다듬음"으로 남겼으나, 정정 방향(2갈래
분리)과 대상 라인이 명시되어 실행 가능 — 실제 문구는 파일 현행을 읽고 확정. 런북 산문은 계약(bullet)+명령으로
완전 지정(스펙이 권위). TBD/TODO 없음.

**3. Type consistency:** `startFleetWebServerRaw`/`RawWebServer`(Task 1 produces) ↔ Task 3 consumes 일치.
`sigterm()`/`waitExit()` 시그니처 일관. draining 배너 텍스트 `'서버 종료 중'`(hydration.tsx:123) 실측 일치.
`[fleet] draining` 로그(Task 1) ↔ Task 3 stdout 단언 일치.

**Notes:** 드레인 하니스는 스펙의 `deploy/drain-smoke.sh` 를 **`e2e/drain.e2e.ts`(Linux-gated)로 실현**(ADR-0003 —
기존 e2e 인프라 재사용·신규 docker-bash/WS 드라이버 회피·FLEET_E2E 가드 우려 무효화). docker `stop_grace_period`
SIGKILL 조율은 §2b 라이브가 커버(스펙 완료조건 3 갱신 반영).

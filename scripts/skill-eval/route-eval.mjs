// scripts/skill-eval/route-eval.mjs
// 스킬 트리거 라우팅 측정 — `.claude/skills/` 의 description 이 의도한 쿼리에서 실제로
// 발동하는지, 그리고 **엉뚱한 스킬을 켜지는 않는지**를 헤들리스 `claude -p` 로 실측한다.
//
// 왜 이 도구인가: skill-creator 의 run_eval.py 는 스킬 하나를 격리해 「발동/미발동」 이진
// 판정만 한다. Fleet 은 7개 스킬이 서로 겹치는 표면(백로그 착수↔재랭킹, PR 리뷰↔갭 감사)을
// 가지므로 정작 알아야 할 것은 「어느 스킬이 켜졌나」다 — 그래야 혼동 행렬이 나온다.
//
// 사용:
//   node scripts/skill-eval/route-eval.mjs --out /tmp/iter1.jsonl
//   node scripts/skill-eval/route-eval.mjs --only pan-1,pr-3 --runs 1 --out /tmp/spot.jsonl
//   node scripts/skill-eval/report.mjs /tmp/iter1.jsonl

import crossSpawn from 'cross-spawn'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 프로브에 허용하는 **내장 도구 allowlist**(`--tools` 는 denylist 가 아니라 배타적 목록이다).
 *
 * 이것이 부작용을 막는 **1차 방벽**이다. 사본·자격증명 격리는 「할 수 있는데 대상을 치웠다」
 * 이지만, 이쪽은 **할 수단 자체를 없앤다** — Bash·Write·Edit·Task·WebFetch 가 사라지면
 * 파일을 고칠 수도, `git push` 를 할 수도, 자격증명을 쓸 수도 없다. 실측 확인:
 * 거부 메시지가 「Bash is disabled for this session, **in subagents as well as here**」라
 * 서브에이전트 우회까지 닫힌다.
 *
 * `Skill` 은 당연히 남긴다(측정 대상). `Read`·`Glob`·`Grep` 은 읽기 전용이고, 모델이 스킬을
 * 열기 전에 맥락을 훑는 경로라 실사용과 맞추기 위해 남긴다.
 *
 * `--restricted` 는 **쓰지 않는다.** 명령 실행 도구를 제거해주지만 project 설정을 함께
 * 무시해 **스킬 레지스트리가 사라진다** — 실측에서 `Skill` 도구가 한 번도 호출되지 않고
 * 모델이 Glob/Grep 으로 헤매다 12번째 호출에서 `SKILL.md` 를 직접 Read 했다. 그러면
 * description 이 아니라 파일 검색 능력을 측정하게 된다. `--tools` 만으로 Bash 는 이미 막힌다.
 *
 * `--strict-mcp-config` 로 MCP 서버를 전부 뺀다 — `mcp__github__*` 같은 변형 도구가 남으면
 * 위 allowlist 를 우회해 살아있는 리소스를 건드릴 수 있다.
 */
const PROBE_TOOLS = 'Read,Glob,Grep,Skill'

/**
 * 격리 사본에서 제외할 디렉터리. 프로브는 빌드·설치를 하지 않으므로 없어도 무방하고,
 * 이것들을 넣으면 사본 생성이 수 분 단위로 늘어난다.
 */
const ISOLATE_SKIP = new Set([
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  '.playwright-mcp',
  'fleet-data',
])

/**
 * 프로브 자식에서 지워야 하는 환경변수.
 *
 * - `CLAUDECODE` — 대화형 터미널 충돌 방지 가드라 서브프로세스 중첩에서는 벗긴다.
 * - `CLAUDE_CODE_REMOTE` — 이게 `'true'` 면 `.claude/hooks/session-start.mjs` 가 원격
 *   부트스트랩 분기를 타고 **`npm install` 을 동기 실행한다**. 프로브마다 그게 돌면
 *   사본에 node_modules 318MB 가 깔리고(실측), 그 시간이 라우팅 결과로 기록되며,
 *   프롬프트와 무관하게 트리가 변형된다. 프로브는 verify 를 돌릴 일이 없으므로 끈다.
 *   훅의 안내 문구 출력은 이 분기보다 앞이라 그대로 유지된다.
 */
const STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_REMOTE',
  // 자격증명 — 아래 「원격 무력화」 주석 참조.
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'SSH_AUTH_SOCK',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
]

/** 접두사로 지우는 환경변수. `GIT_CONFIG_COUNT`/`_KEY_n`/`_VALUE_n` 주입이 git 인증을 실어나른다. */
const STRIP_ENV_PREFIX = ['GIT_CONFIG_']

/**
 * 프로브 자식에게 줄 환경을 만든다.
 *
 * 환경변수를 **지우는 것만으로는 부족하다** — 디스크에 남은 자격증명이 그대로 살아난다.
 * `GH_CONFIG_DIR` 를 지우면 `gh` 가 `$HOME/.config/gh` 로 폴백해 로그인 상태를 되찾고,
 * ssh 는 `-F` 로 설정을 끊어도 기본 `~/.ssh/id_*` 를 계속 시도한다. 그러면 origin 을
 * 무력화해도 `gh --repo pdw96/fleet …` 나 명시 URL 푸시로 **살아있는 리소스를 건드릴 수 있다**.
 * 그래서 지우는 대신 **빈 샌드박스로 가리킨다**.
 *
 * `HOME` 자체는 건드리지 않는다 — claude 의 인증·설정(`~/.claude`)이 거기 있어서 옮기면
 * 측정 자체가 불가능해진다. 자격증명 표면만 골라서 끊는다.
 */
function probeEnv(sandbox) {
  const env = { ...process.env }
  for (const k of STRIP_ENV) delete env[k]
  for (const k of Object.keys(env)) {
    if (STRIP_ENV_PREFIX.some((p) => k.startsWith(p))) delete env[k]
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    // gh 를 빈 설정 디렉터리로 묶어 디스크 로그인을 못 보게 한다.
    GH_CONFIG_DIR: sandbox.ghConfigDir,
    // 전역·시스템 git 설정(자격증명 헬퍼 포함)을 빈 파일로 대체한다.
    GIT_CONFIG_GLOBAL: sandbox.emptyFile,
    GIT_CONFIG_SYSTEM: sandbox.emptyFile,
    // 에이전트·기본 키·사용자 ssh_config 를 전부 끊는다.
    GIT_SSH_COMMAND:
      `ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none ` +
      `-F "${sandbox.emptyFile}" -i "${sandbox.emptyFile}"`,
  }
}

/**
 * win32 시스템 taskkill 절대경로. bare `taskkill` 은 CreateProcess 가 cwd·PATH 를 뒤지므로
 * 프로브가 심어둔 가짜 `taskkill.exe` 로 하이재킹될 수 있다 —
 * `src/main/core/process/kill-tree.ts` 와 같은 이유로 절대경로로 못 박는다.
 */
function taskkillPath() {
  const sysRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return join(sysRoot, 'System32', 'taskkill.exe')
}

/**
 * 자식 프로세스의 **전체 트리**를 종료한다.
 *
 * win32 에서 POSIX 의 음수 PID(프로세스 그룹) 형식은 지원되지 않아 `process.kill(-pid)` 가
 * 그대로 throw 한다. 그걸 catch 로 삼키면 **detached 된 claude 가 프롬프트를 끝까지 실행한다**.
 * 권위 구현: `src/main/core/process/kill-tree.ts`(TS 라 여기서 직접 import 하지 못해 재현).
 */
function killTree(child) {
  if (child.pid == null) return Promise.resolve()
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 이미 종료됨 */
      }
    }
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    try {
      const tk = spawn(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
      tk.on('error', () => {
        try {
          child.kill()
        } catch {
          /* 이미 종료됨 */
        }
        finish()
      })
      tk.on('exit', finish)
    } catch {
      try {
        child.kill()
      } catch {
        /* 이미 종료됨 */
      }
      finish()
    }
  })
}

/** 실행 중인 프로브 — 인터럽트 시 전부 죽이기 위한 전역 등록부. */
const live = new Set()

/**
 * 종료 개시 플래그. 스냅샷만 죽이면 부족하다 — 죽은 자식의 `close` 로 워커가 다음 작업으로
 * 넘어가 **교체 프로브를 새로 띄우고**, 그건 스냅샷에 없어서 `process.exit` 후에도 살아남는다.
 * 워커가 사본을 뜨거나 spawn 하기 전에 이걸 본다.
 */
let cancelled = false

/** `plugin:skill` → `skill`. Skill 도구 인자는 플러그인 접두사를 달고 올 수 있다. */
function normalize(name) {
  const n = name.trim()
  return n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n
}

/**
 * 이 도구 호출이 「스킬을 열었다」에 해당하는지 판정한다.
 * win32 네이티브 절대경로는 역슬래시로 오므로 정규화 후 매칭한다.
 */
function skillFromTool(tool, input) {
  if (tool === 'Skill' && typeof input.skill === 'string') return normalize(input.skill)
  if (tool === 'Read' && typeof input.file_path === 'string') {
    const p = input.file_path.replace(/\\/g, '/')
    if (p.includes('.claude/skills/') && p.endsWith('SKILL.md')) {
      return p.split('.claude/skills/')[1].split('/')[0]
    }
  }
  return null
}

/**
 * 쿼리 하나를 1회 실행하고 무엇이 발동했는지 돌려준다.
 *
 * 도구 예산(maxTools)은 **도구 호출 건수**(tool_use id 기준)로 센다. 이름으로 중복 제거해
 * 세면 `WebFetch` 를 열 번 불러도 1 로 잡혀 예산이 무력해진다.
 *
 * 예산 검사는 **진행 중인 tool_use 블록이 닫힌 뒤에만** 한다. `content_block_start` 에서
 * 검사하면 스킬 호출이 하필 예산의 마지막 호출일 때 이름이 도착하기 전에 끊겨 정당한
 * 발동이 `none` 으로 기록된다 — 예산이 포화된 바로 그 지점에서 통계가 깨진다.
 */
function runOnce(query, cwd, model, timeoutMs, maxTools, sandbox, probeTools) {
  return new Promise((resolve) => {
    const env = probeEnv(sandbox)

    // cross-spawn 을 쓰는 이유: Windows 에서 npm 설치 CLI 는 `claude.cmd` 배치 셰임이라
    // node 의 spawn 으로는 PATHEXT 미해석 ENOENT, `.cmd` 명시는 Node 20+ 의 차단(CVE-2024-27980)
    // 으로 EINVAL 이 난다 — 프로브가 전부 실패한다. 권위 설명은 `src/main/core/cli/detect.ts`.
    const child = crossSpawn(
      'claude',
      [
        '-p',
        query,
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--model',
        model,
        // 부작용 1차 방벽 — 위 PROBE_TOOLS 주석 참조.
        '--tools',
        probeTools,
        '--strict-mcp-config',
      ],
      { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    live.add(child)

    const start = Date.now()
    const tools = [] // 진단용(이름 중복 제거)
    const callIds = new Set() // 예산 산정용(호출 건수)
    let fired = null
    let curTool = null
    let curJson = ''
    let buf = ''
    let stderrTail = ''
    let sawAnyEvent = false
    let timedOut = false
    let settled = false
    let stoppedByUs = false

    const done = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      live.delete(child)
      resolve({
        fired: fired ?? 'none',
        elapsed: Math.round((Date.now() - start) / 100) / 10,
        tools: tools.slice(0, 8),
        tool_calls: callIds.size,
        timed_out: timedOut,
        ...extra,
      })
    }

    /** 측정 목적을 달성했거나 예산이 끝났다 — 트리를 죽이고 표본을 확정한다. */
    const stop = () => {
      if (settled || stoppedByUs) return
      stoppedByUs = true
      void killTree(child).then(() => done({}))
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)

    const countCall = (id) => {
      if (typeof id === 'string' && id) callIds.add(id)
      else callIds.add(`anon-${callIds.size}`)
    }

    const consider = (tool, input) => {
      if (!tools.includes(tool)) tools.push(tool)
      if (fired === null) fired = skillFromTool(tool, input)
    }

    child.stderr.on('data', (c) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-2000)
    })

    child.stdout.on('data', (chunk) => {
      if (settled || stoppedByUs) return
      buf += chunk.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let ev
        try {
          ev = JSON.parse(line)
        } catch {
          continue /* 부분 줄 — 다음 청크에서 완성된다 */
        }
        sawAnyEvent = true

        if (ev.type === 'stream_event') {
          const se = ev.event ?? {}
          if (se.type === 'content_block_start') {
            const cb = se.content_block ?? {}
            if (cb.type === 'tool_use') {
              curTool = cb.name ?? ''
              curJson = ''
              countCall(cb.id)
            } else {
              curTool = null
            }
          } else if (se.type === 'content_block_delta' && curTool) {
            const d = se.delta ?? {}
            if (d.type === 'input_json_delta') {
              curJson += d.partial_json ?? ''
              // 인자가 완성되는 순간 판정해 도구가 실제로 실행되기 전에 끊는 것이 목적이다.
              try {
                consider(curTool, JSON.parse(curJson))
              } catch {
                /* 아직 미완 */
              }
            }
          } else if (se.type === 'content_block_stop' && curTool) {
            try {
              consider(curTool, JSON.parse(curJson || '{}'))
            } catch {
              consider(curTool, {})
            }
            curTool = null
          }
        } else if (ev.type === 'assistant') {
          // partial 이벤트가 없는 경로 폴백. id 집합이라 위와 중복 계수되지 않는다.
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_use') {
              countCall(c.id)
              consider(c.name ?? '', c.input ?? {})
            }
          }
        }

        // 발동을 봤으면 즉시 끝. 예산 초과는 **블록이 닫힌 뒤에만** 적용한다(위 주석 참조).
        if (fired || (curTool === null && callIds.size >= maxTools)) {
          stop()
          return
        }
      }
    })

    // CLI 가 아예 못 뜨거나(실행 파일 없음) 비정상 종료하면(인증 만료·잘못된 모델·레이트리밋)
    // 조용히 `none` 으로 기록해선 안 된다 — 인프라 실패가 negative 정답이자 positive 미스로
    // 둔갑해 그럴듯하지만 오염된 실험이 된다. 표본을 invalid 로 찍어 통계에서 제외시킨다.
    child.on('error', (err) => {
      done({ invalid: true, error: `spawn 실패: ${err.message}` })
    })
    child.on('close', (code, signal) => {
      if (stoppedByUs || settled) return
      if (code === 0 && sawAnyEvent) {
        done({})
        return
      }
      const why =
        code === 0 ? '이벤트 없이 종료' : `exit=${code}${signal ? ` signal=${signal}` : ''}`
      done({
        invalid: true,
        error: `${why}${stderrTail ? ` — ${stderrTail.trim().slice(-400)}` : ''}`,
      })
    })
  })
}

/** 동시 실행 한도를 지키는 최소 워커 풀. */
async function pool(items, limit, fn) {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !cancelled) {
      const idx = next++
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}

/**
 * 프로브용 원본 템플릿을 만든다.
 *
 * `.git` 이 **파일**이면 linked worktree 라 그 안에 원본 저장소의 관리 디렉터리를 가리키는
 * 포인터가 들어있다. 그대로 복사하면 프로브의 `git add`·`commit`·`tag` 가 **살아있는
 * 저장소의 인덱스·ref 를 실제로 변형**하고, temp 디렉터리를 지워도 되돌아오지 않는다.
 * 그 경우 `.git` 을 빼고 복사한 뒤 빈 저장소를 새로 만들고 origin 만 물려준다
 * (`gh` 가 레포를 해석하는 데는 remote 만 있으면 된다).
 */
async function makeTemplate(src) {
  const root = await mkdtemp(join(tmpdir(), 'fleet-skill-eval-'))
  const tpl = join(root, 'template')
  const gitStat = await stat(join(src, '.git')).catch(() => null)
  const linkedWorktree = gitStat?.isFile() ?? false

  await cp(src, tpl, {
    recursive: true,
    filter: (from) =>
      !ISOLATE_SKIP.has(basename(from)) && !(linkedWorktree && basename(from) === '.git'),
  })

  // **원격 무력화.** 사본은 로컬 파일만 지킨다 — ref·GitHub 작업·자격증명은 지키지 못한다.
  // 스킬이 안 열린 프로브는 프롬프트를 계속 수행하는데, `rel-3`("rc 로 먼저 태그 밀어보자")
  // 같은 쿼리에서 `fleet-release` 가 미발동하면 에이전트가 문서대로 `git push origin v…` 를
  // 실행할 수 있고, 그러면 **실제 태그가 올라가 release.yml 이 진짜 릴리스를 낸다**.
  // 그래서 origin 을 temp 안의 빈 bare 저장소로 갈아끼우고(푸시가 갈 곳이 없다),
  // 위 `probeEnv()` 가 토큰·git 설정 주입·SSH 에이전트를 벗긴다.
  //
  // 대가로 프로브의 `gh` 는 레포를 해석하지 못한다. 측정 충실도를 조금 잃지만, 라우팅 판정은
  // 앞쪽 도구 호출 몇 개에서 끝나므로 영향이 작고, 반대 방향의 사고는 되돌릴 수 없다.
  const neutered = join(root, 'origin.git')
  try {
    execFileSync('git', ['init', '--bare', '-q', neutered], { stdio: 'ignore' })
    if (linkedWorktree) execFileSync('git', ['-C', tpl, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', tpl, 'remote', 'remove', 'origin'], { stdio: 'ignore' })
  } catch {
    /* origin 이 없었거나 git 미가용 — 아래 add 로 이어간다 */
  }
  try {
    execFileSync('git', ['-C', tpl, 'remote', 'add', 'origin', neutered], { stdio: 'ignore' })
  } catch {
    /* git 미가용 — 프로브는 remote 없이 돈다(더 안전한 쪽) */
  }

  // 디스크 자격증명을 가릴 빈 샌드박스(위 `probeEnv()` 주석 참조).
  const sandbox = { ghConfigDir: join(root, 'gh-config'), emptyFile: join(root, 'empty') }
  await mkdir(sandbox.ghConfigDir, { recursive: true })
  await writeFile(sandbox.emptyFile, '')

  return { root, tpl, linkedWorktree, sandbox }
}

async function main() {
  const { values } = parseArgs({
    options: {
      queries: { type: 'string', default: join(HERE, 'queries.json') },
      cwd: { type: 'string', default: process.cwd() },
      model: { type: 'string', default: 'claude-opus-5' },
      runs: { type: 'string', default: '3' },
      timeout: { type: 'string', default: '150' },
      'max-tools': { type: 'string', default: '8' },
      workers: { type: 'string', default: '8' },
      only: { type: 'string' },
      out: { type: 'string' },
      'no-isolate': { type: 'boolean', default: false },
      tools: { type: 'string', default: PROBE_TOOLS },
    },
  })

  if (!values.out) {
    console.error('--out <경로.jsonl> 이 필요하다')
    process.exit(2)
  }

  const runs = Number(values.runs)
  const timeoutMs = Number(values.timeout) * 1000
  const maxTools = Number(values['max-tools'])
  const workers = Number(values.workers)
  const isolate = !values['no-isolate']

  let queries = JSON.parse(await readFile(values.queries, 'utf8'))
  if (values.only) {
    const keep = new Set(values.only.split(','))
    queries = queries.filter((q) => keep.has(q.id))
  }
  const jobs = queries.flatMap((q) => Array.from({ length: runs }, (_, i) => ({ q, run: i })))

  let template = null
  if (isolate) {
    console.error('격리 템플릿 생성 중…')
    template = await makeTemplate(values.cwd)
    if (template.linkedWorktree) {
      console.error('⚠ linked worktree 감지 — `.git` 대신 빈 저장소 + origin 만 물렸다')
    }
  } else {
    console.error('⚠ --no-isolate — 프로브가 실제 체크아웃을 수정할 수 있다')
  }

  await mkdir(dirname(values.out), { recursive: true })
  // 불완전한 결과 파일이 100% 로 보고되는 것을 막는 매니페스트. report.mjs 가 검증한다.
  const manifestPath = `${values.out}.manifest.json`
  const manifest = {
    queries: queries.map((q) => q.id),
    runs,
    expected: jobs.length,
    model: values.model,
    maxTools,
    timeoutSeconds: Number(values.timeout),
    isolate,
    startedAt: new Date().toISOString(),
    completedAt: null,
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  const fh = createWriteStream(values.out)
  let finished = 0
  let invalid = 0

  // 인터럽트·치명적 오류로 부모가 죽을 때 살아있는 프로브를 전부 데려간다. 없으면
  // 10~20분짜리 명령을 Ctrl-C 한 뒤에도 유료 세션 여러 개가 계속 프롬프트를 실행한다.
  const shutdown = async (why) => {
    if (cancelled) return
    cancelled = true // 워커가 교체 프로브를 띄우지 못하게 먼저 막는다
    console.error(`\n${why} — 실행 중인 프로브 ${live.size}개 종료 중…`)
    // 이미 spawn 직전까지 간 워커가 하나 더 띄울 수 있으므로, live 가 비고 그 상태가
    // 유지되는 것을 확인할 때까지 반복한다.
    for (let i = 0; i < 20; i++) {
      if (live.size) await Promise.all([...live].map((c) => killTree(c)))
      await new Promise((r) => setTimeout(r, 100))
      if (!live.size) break
    }
    if (template) await rm(template.root, { recursive: true, force: true })
    process.exit(130)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('uncaughtException', (e) => void shutdown(`예외: ${e.message}`))

  try {
    await pool(jobs, workers, async ({ q, run }, idx) => {
      if (cancelled) return // 종료 개시 후에는 사본도 뜨지 않고 프로브도 띄우지 않는다
      // 작업마다 템플릿에서 새 사본을 뜬다. 하나를 공유하면 파일을 고치라는 negative
      // 프로브(`neg-2`·`neg-3`)가 남긴 변경·git 인덱스를 뒤따르는 프로브가 보게 되어
      // 결과가 스케줄링에 의존한다.
      let jobCwd = values.cwd
      let jobDir = null
      let jobOrigin = null
      if (template) {
        jobDir = join(template.root, `job-${idx}`)
        await cp(template.tpl, jobDir, { recursive: true })
        jobCwd = jobDir
        // 무력화된 origin 도 **작업마다 따로** 둔다. 하나를 공유하면, 라우팅이 빗나간
        // 프로브가 push 를 성사시켰을 때 뒤따르는 프로브가 fetch·remote 조회로 그 태그·ref 를
        // 보게 되어 결과가 다시 스케줄링에 의존한다.
        jobOrigin = `${jobDir}-origin.git`
        try {
          execFileSync('git', ['init', '--bare', '-q', jobOrigin], { stdio: 'ignore' })
          execFileSync('git', ['-C', jobDir, 'remote', 'set-url', 'origin', jobOrigin], {
            stdio: 'ignore',
          })
        } catch {
          /* git 미가용 — 템플릿의 공유 무력 origin 을 그대로 쓴다 */
        }
      }
      try {
        const res = await runOnce(
          q.query,
          jobCwd,
          values.model,
          timeoutMs,
          maxTools,
          template?.sandbox ?? { ghConfigDir: '', emptyFile: '' },
          values.tools,
        )
        const rec = { id: q.id, run, expected: q.expected, ...res }
        fh.write(JSON.stringify(rec) + '\n')
        finished += 1
        if (rec.invalid) invalid += 1
        const mark = rec.invalid ? 'INVALID' : rec.fired === rec.expected ? 'ok  ' : 'MISS'
        console.error(
          `[${finished}/${jobs.length}] ${mark} ${q.id}#${run} exp=${q.expected} got=${rec.fired} ` +
            `calls=${res.tool_calls} tools=[${res.tools.join(',')}] ` +
            `(${res.elapsed}s${res.timed_out ? ' TIMEOUT' : ''})${rec.error ? ` ${rec.error}` : ''}`,
        )
      } finally {
        if (jobDir) await rm(jobDir, { recursive: true, force: true })
        if (jobOrigin) await rm(jobOrigin, { recursive: true, force: true })
      }
    })
    manifest.completedAt = new Date().toISOString()
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  } finally {
    await new Promise((r) => fh.end(r))
    if (template) await rm(template.root, { recursive: true, force: true })
  }

  if (invalid > 0) {
    console.error(
      `\n⚠ invalid 표본 ${invalid}/${jobs.length} — 통계에서 제외된다. 원인을 먼저 보라.`,
    )
  }
}

await main()

// scripts/skill-eval/route-eval.mjs
// 스킬 트리거 라우팅 측정 — `.claude/skills/` 의 description 이 의도한 쿼리에서 실제로
// 발동하는지, 그리고 **엉뚱한 스킬을 켜지는 않는지**를 헤들리스 `claude -p` 로 실측한다.
//
// 왜 이 도구인가: skill-creator 의 run_eval.py 는 스킬 하나를 격리해 「발동/미발동」 이진
// 판정만 한다. Fleet 은 7개 스킬이 서로 겹치는 표면(백로그 착수↔재랭킹, PR 리뷰↔갭 감사)을
// 가지므로 정작 알아야 할 것은 「어느 스킬이 켜졌나」다 — 그래야 혼동 행렬이 나온다.
// 그래서 모든 스킬이 살아있는 레포 트리에서 돌리고 발동한 스킬 이름을 기록한다.
//
// 사용:
//   node scripts/skill-eval/route-eval.mjs --out /tmp/iter1.jsonl
//   node scripts/skill-eval/route-eval.mjs --only pan-1,pr-3 --runs 1 --out /tmp/spot.jsonl
//   node scripts/skill-eval/report.mjs /tmp/iter1.jsonl

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 격리 사본에서 제외할 디렉터리. 프로브는 빌드·설치를 하지 않으므로 없어도 무방하고,
 * 이것들을 넣으면 사본 생성이 수 분 단위로 늘어난다. `.git` 은 **일부러 포함한다** —
 * 프로브가 `git`·`gh` 로 레포 맥락을 조회하는 경로가 실사용과 같아야 측정이 유효하다.
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
 * 그대로 throw 한다. 그걸 catch 로 삼키면 **detached 된 claude 가 프롬프트를 끝까지 실행한다** —
 * 93런 평가가 유료 세션 수십 개를 동시에 방치하게 된다. 플랫폼별로 갈라 처리한다
 * (권위 구현: `src/main/core/process/kill-tree.ts`. 그쪽은 TS 라 여기서 직접 import 하지 못해
 * 같은 정책을 최소 형태로 재현한다).
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

/** `plugin:skill` → `skill`. Skill 도구 인자는 플러그인 접두사를 달고 올 수 있다. */
function normalize(name) {
  const n = name.trim()
  return n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n
}

/**
 * 이 도구 호출이 「스킬을 열었다」에 해당하는지 판정한다.
 * Skill 도구가 정규 경로지만, SKILL.md 를 직접 Read 하는 것도 같은 의도이므로 함께 센다.
 *
 * win32 네이티브 절대경로는 `.claude\skills\foo\SKILL.md` 처럼 역슬래시로 온다 —
 * 정규화하지 않으면 정당한 발동이 `none` 으로 기록되어 Windows 측정이 체계적으로 저평가된다.
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
 * 도구 예산(maxTools)은 **도구 호출 건수**(tool_use id 기준)로 센다. 이름 기준으로 중복
 * 제거해서 세면 `WebFetch` 를 열 번 불러도 1로 잡혀 예산이 사실상 무력해지고, 프로브가
 * 설정보다 훨씬 많은 일을 하게 되어 예산을 맞춘 비교가 깨진다.
 *
 * 예산이 필요한 이유: 모델이 스킬을 열기 전에 이슈 조회 같은 선행 작업을 먼저 하는 경우가
 * 있다. 너무 작으면 「뒤늦게 연」 성공을 미발동으로 기록해 **없는 회귀를 만들어낸다**.
 */
function runOnce(query, cwd, model, timeoutMs, maxTools) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    // CLAUDECODE 가드는 대화형 터미널 충돌 방지용이라 서브프로세스 중첩에서는 벗긴다.
    delete env.CLAUDECODE

    const child = spawn(
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
      ],
      { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
    )

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
              // 인자가 스트리밍 중이라 대개 파싱에 실패한다. 완성되는 순간 판정해
              // 도구가 실제로 실행되기 전에 끊는 것이 목적이다.
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

        if (fired || callIds.size >= maxTools) {
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
    while (next < items.length) {
      const idx = next++
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}

/**
 * 프로브를 돌릴 일회용 사본을 만든다.
 *
 * 프로브가 스킬을 열지 않으면 예산·타임아웃까지 프롬프트를 계속 실행한다. negative 쿼리 중
 * `neg-2`·`neg-3` 은 **파일을 고치라는 지시**이고, 사용자의 claude 설정이 Edit/Bash 를 이미
 * 허용해뒀다면 살아있는 체크아웃을 실제로 건드린다 — 「작업은 수행되지 않는다」가 깨진다.
 * 사본에서 돌리면 변경이 사본에만 남고 종료 시 통째로 버려진다.
 */
async function makeIsolatedCopy(src) {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-skill-eval-'))
  const dest = join(dir, basename(src) || 'repo')
  await cp(src, dest, {
    recursive: true,
    filter: (from) => !ISOLATE_SKIP.has(basename(from)),
  })
  return { dest, dir }
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
      isolate: { type: 'boolean', default: true },
      'no-isolate': { type: 'boolean', default: false },
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
  const isolate = values.isolate && !values['no-isolate']

  let queries = JSON.parse(await readFile(values.queries, 'utf8'))
  if (values.only) {
    const keep = new Set(values.only.split(','))
    queries = queries.filter((q) => keep.has(q.id))
  }

  let probeCwd = values.cwd
  let tempRoot = null
  if (isolate) {
    console.error('격리 사본 생성 중…')
    const made = await makeIsolatedCopy(values.cwd)
    probeCwd = made.dest
    tempRoot = made.dir
    console.error(`프로브 cwd = ${probeCwd}`)
  } else {
    console.error('⚠ --no-isolate — 프로브가 실제 체크아웃을 수정할 수 있다')
  }

  const jobs = queries.flatMap((q) => Array.from({ length: runs }, (_, i) => ({ q, run: i })))

  await mkdir(dirname(values.out), { recursive: true })
  const fh = createWriteStream(values.out)
  let finished = 0
  let invalid = 0

  try {
    await pool(jobs, workers, async ({ q, run }) => {
      const res = await runOnce(q.query, probeCwd, values.model, timeoutMs, maxTools)
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
    })
  } finally {
    await new Promise((r) => fh.end(r))
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  }

  if (invalid > 0) {
    console.error(
      `\n⚠ invalid 표본 ${invalid}/${jobs.length} — 통계에서 제외된다. 원인을 먼저 보라.`,
    )
  }
}

await main()

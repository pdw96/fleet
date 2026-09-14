// scripts/skill-eval/route-eval.mjs
// 스킬 트리거 라우팅 측정 — `.claude/skills/` 의 description 이 의도한 쿼리에서 실제로
// 발동하는지, 그리고 **엉뚱한 스킬을 켜지는 않는지**를 헤들리스 `claude -p` 로 실측한다.
//
// 왜 이 도구인가: skill-creator 의 run_eval.py 는 스킬 하나를 격리해 「발동/미발동」 이진
// 판정만 한다. Fleet 은 7개 스킬이 서로 겹치는 표면(백로그 착수↔재랭킹, PR 리뷰↔갭 감사)을
// 가지므로 정작 알아야 할 것은 「어느 스킬이 켜졌나」다 — 그래야 혼동 행렬이 나온다.
// 그래서 모든 스킬이 살아있는 실제 레포에서 돌리고 발동한 스킬 이름을 기록한다.
//
// 실제 작업은 수행되지 않는다: 스킬이 열리는 즉시(또는 도구 예산 소진 시) 프로세스 그룹을 죽인다.
//
// 사용:
//   node scripts/skill-eval/route-eval.mjs --out /tmp/iter1.jsonl
//   node scripts/skill-eval/route-eval.mjs --only pan-1,pr-3 --runs 1 --out /tmp/spot.jsonl
//   node scripts/skill-eval/report.mjs /tmp/iter1.jsonl

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))

/** `plugin:skill` → `skill`. Skill 도구 인자는 플러그인 접두사를 달고 올 수 있다. */
function normalize(name) {
  const n = name.trim()
  return n.includes(':') ? n.slice(n.lastIndexOf(':') + 1) : n
}

/**
 * 이 도구 호출이 「스킬을 열었다」에 해당하는지 판정한다.
 * Skill 도구가 정규 경로지만, SKILL.md 를 직접 Read 하는 것도 같은 의도이므로 함께 센다.
 */
function skillFromTool(tool, input) {
  if (tool === 'Skill' && typeof input.skill === 'string') return normalize(input.skill)
  if (tool === 'Read' && typeof input.file_path === 'string') {
    const p = input.file_path
    if (p.includes('.claude/skills/') && p.endsWith('SKILL.md')) {
      return p.split('.claude/skills/')[1].split('/')[0]
    }
  }
  return null
}

/**
 * 쿼리 하나를 1회 실행하고 무엇이 발동했는지 돌려준다.
 *
 * 도구 예산(maxTools)이 필요한 이유: 모델이 스킬을 열기 전에 이슈 조회 같은 선행 작업을
 * 먼저 하는 경우가 있다. 예산이 너무 작으면 「6번째 도구에서 열었을 뿐인」 성공을 미발동으로
 * 기록해 없는 회귀를 만들어낸다(실제로 겪음 — 예산 5에서 fleet-backlog-induction 이
 * 92%→67% 로 보였으나 예산 12에서는 차이가 사라졌다). 기본 8은 그 함정을 피하면서
 * negative 쿼리가 끝없이 실제 작업을 하는 것을 막는 절충이다.
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
      { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )

    const start = Date.now()
    const tools = []
    let fired = null
    let curTool = null
    let curJson = ''
    let buf = ''
    let timedOut = false
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* 이미 종료됨 */
      }
      resolve({
        fired: fired ?? 'none',
        elapsed: Math.round((Date.now() - start) / 100) / 10,
        tools: tools.slice(0, 8),
        timed_out: timedOut,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      finish()
    }, timeoutMs)

    const consider = (tool, input) => {
      if (!tools.includes(tool)) tools.push(tool)
      if (fired === null) fired = skillFromTool(tool, input)
    }

    child.stdout.on('data', (chunk) => {
      if (settled) return
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

        if (ev.type === 'stream_event') {
          const se = ev.event ?? {}
          if (se.type === 'content_block_start') {
            const cb = se.content_block ?? {}
            curTool = cb.type === 'tool_use' ? (cb.name ?? '') : null
            curJson = ''
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
          // partial 이벤트가 없는 경로(캐시된 턴 등) 폴백.
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_use') consider(c.name ?? '', c.input ?? {})
          }
        }

        if (fired || tools.length >= maxTools) {
          finish()
          return
        }
      }
    })

    child.on('close', finish)
    child.on('error', finish)
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

  let queries = JSON.parse(await readFile(values.queries, 'utf8'))
  if (values.only) {
    const keep = new Set(values.only.split(','))
    queries = queries.filter((q) => keep.has(q.id))
  }

  const jobs = queries.flatMap((q) => Array.from({ length: runs }, (_, i) => ({ q, run: i })))

  await mkdir(dirname(values.out), { recursive: true })
  const fh = createWriteStream(values.out)
  let done = 0

  await pool(jobs, workers, async ({ q, run }) => {
    const res = await runOnce(q.query, values.cwd, values.model, timeoutMs, maxTools)
    const rec = { id: q.id, run, expected: q.expected, ...res }
    fh.write(JSON.stringify(rec) + '\n')
    done += 1
    const mark = rec.fired === rec.expected ? 'ok  ' : 'MISS'
    console.error(
      `[${done}/${jobs.length}] ${mark} ${q.id}#${run} exp=${q.expected} got=${rec.fired} ` +
        `tools=[${res.tools.join(',')}] (${res.elapsed}s${res.timed_out ? ' TIMEOUT' : ''})`,
    )
  })

  await new Promise((r) => fh.end(r))
}

await main()

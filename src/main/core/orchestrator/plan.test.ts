import { describe, expect, it } from 'vitest'
import type { VerificationResult } from '../../../shared/types'
import type { LlmSession } from '../session/types'
import {
  buildPlannerPrompt,
  buildReplanPrompt,
  extractJsonArray,
  parsePlannedTasks,
  planCorrectiveTasks,
  planTasks,
  PLANNER_SCHEMA,
} from './plan'

function fakeSession(reply: string): LlmSession {
  return {
    id: 'p',
    descriptor: { id: 'p', kind: 'api', displayName: 'p', ref: 'p', model: '' },
    async send() {
      return reply
    },
    async dispose() {},
  }
}

describe('extractJsonArray', () => {
  it('extracts from a fenced code block', () => {
    expect(extractJsonArray('```json\n[1, 2]\n```')).toEqual([1, 2])
  })
  it('extracts a bare array surrounded by prose', () => {
    expect(extractJsonArray('계획입니다: [{"a":1}] 이상')).toEqual([{ a: 1 }])
  })
  it('throws when there is no array', () => {
    expect(() => extractJsonArray('배열 없음')).toThrow()
  })
})

describe('parsePlannedTasks', () => {
  it('parses valid tasks with roles and deps', () => {
    const tasks = parsePlannedTasks(
      '[{"title":"설계","description":"d","role":"architect"},{"title":"구현","description":"e","role":"implementer","dependsOn":[0]}]',
    )
    expect(tasks).toHaveLength(2)
    expect(tasks[0].role).toBe('architect')
    expect(tasks[1].dependsOn).toEqual([0])
  })

  it('is lenient: drops invalid role, defaults missing title', () => {
    const tasks = parsePlannedTasks('[{"description":"x","role":"bogus"}]')
    expect(tasks[0].title).toBe('작업 1')
    expect(tasks[0].role).toBeUndefined()
  })

  it('throws when the task list is empty', () => {
    expect(() => parsePlannedTasks('[]')).toThrow()
  })

  it('구조화 출력 객체 {tasks:[...]} 를 파싱한다', () => {
    const tasks = parsePlannedTasks('{"tasks":[{"title":"T","description":"D","role":"tester"}]}')
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('T')
    expect(tasks[0].role).toBe('tester')
  })

  it('산문에 둘러싸인 {tasks:[...]} 도 폴백으로 파싱한다', () => {
    const tasks = parsePlannedTasks('계획: {"tasks":[{"title":"A","description":"d"}]} 이상')
    expect(tasks[0].title).toBe('A')
  })

  it('기존 bare 배열 입력은 그대로 파싱한다(회귀)', () => {
    const tasks = parsePlannedTasks('[{"title":"B","description":"d"}]')
    expect(tasks[0].title).toBe('B')
  })

  it('allowEmpty 옵션이면 빈 목록을 [] 로 반환한다(보정 맥락)', () => {
    expect(parsePlannedTasks('{"tasks":[]}', { allowEmpty: true })).toEqual([])
    expect(parsePlannedTasks('[]', { allowEmpty: true })).toEqual([])
  })

  it('allowEmpty 없이는 빈 {tasks:[]} 도 throw 한다(기존 동작 보존)', () => {
    expect(() => parsePlannedTasks('{"tasks":[]}')).toThrow()
  })
})

describe('buildPlannerPrompt', () => {
  it('embeds the goal and asks for JSON', () => {
    const p = buildPlannerPrompt('멀티 LLM 앱')
    expect(p).toContain('멀티 LLM 앱')
    expect(p).toContain('JSON')
  })

  it('tasks 키를 가진 JSON 객체 형태를 요청한다', () => {
    expect(buildPlannerPrompt('목표')).toContain('tasks')
  })
})

describe('planTasks', () => {
  it('decomposes via the planner session', async () => {
    const tasks = await planTasks('goal', fakeSession('[{"title":"T","description":"D"}]'))
    expect(tasks[0].title).toBe('T')
  })
})

describe('PLANNER_SCHEMA', () => {
  it('루트는 object 이고 tasks 배열을 가진다(OpenAI strict 호환)', () => {
    expect(PLANNER_SCHEMA.type).toBe('object')
    expect((PLANNER_SCHEMA.properties as Record<string, { type?: string }>).tasks.type).toBe(
      'array',
    )
    expect(PLANNER_SCHEMA.additionalProperties).toBe(false)
  })

  it('item 스키마는 모든 property 를 required 로 둔다(OpenAI strict 호환)', () => {
    const items = (PLANNER_SCHEMA.properties as { tasks: { items: { required: string[] } } }).tasks
      .items
    expect([...items.required].sort()).toEqual(['dependsOn', 'description', 'role', 'title'])
  })
})

describe('buildReplanPrompt', () => {
  it('목표와 검증 실패 요약(kind/command/analysis)을 포함한다', () => {
    const p = buildReplanPrompt('목표X', [
      {
        kind: 'test',
        command: 'npm test',
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: 'boom',
        analysis: '테스트 깨짐',
        durationMs: 1,
      },
    ])
    expect(p).toContain('목표X')
    expect(p).toContain('npm test')
    expect(p).toContain('테스트 깨짐')
    expect(p).toContain('tasks')
  })

  it('analysis 가 없으면 stderr 로 폴백한다', () => {
    const p = buildReplanPrompt('목표', [
      {
        kind: 'lint',
        command: 'npm run lint',
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: 'lint error text',
        durationMs: 1,
      },
    ])
    expect(p).toContain('lint error text')
  })

  it('거대한 실패 상세는 2000자로 잘라 planner 컨텍스트 폭주를 막는다', () => {
    const huge = 'x'.repeat(10_000)
    const p = buildReplanPrompt('목표', [
      {
        kind: 'test',
        command: 'npm test',
        passed: false,
        exitCode: 1,
        stdout: '',
        stderr: huge,
        durationMs: 1,
      },
    ])
    expect(p).toContain('x'.repeat(2_000)) // 캡 이내는 포함
    expect(p).not.toContain('x'.repeat(2_001)) // 캡 초과분은 잘림
  })
})

describe('planCorrectiveTasks', () => {
  const fail: VerificationResult = {
    kind: 'test',
    command: 'npm test',
    passed: false,
    exitCode: 1,
    stdout: '',
    stderr: 'x',
    durationMs: 1,
  }

  it('보정 작업 목록을 분해한다', async () => {
    const tasks = await planCorrectiveTasks(
      'g',
      [fail],
      fakeSession('{"tasks":[{"title":"수정","description":"d"}]}'),
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('수정')
  })

  it('보정 불필요({tasks:[]})면 빈 배열을 반환한다', async () => {
    const tasks = await planCorrectiveTasks('g', [fail], fakeSession('{"tasks":[]}'))
    expect(tasks).toEqual([])
  })

  it('실패가 없으면 planner 호출 없이 빈 배열을 반환한다(방어적 가드)', async () => {
    let called = false
    const guardSession: LlmSession = {
      id: 'p',
      descriptor: { id: 'p', kind: 'api', displayName: 'p', ref: 'p', model: '' },
      async send() {
        called = true
        return '{"tasks":[]}'
      },
      async dispose() {},
    }
    const tasks = await planCorrectiveTasks('g', [], guardSession)
    expect(tasks).toEqual([])
    expect(called).toBe(false) // 실패 없으면 planner 를 호출하지 않는다
  })
})

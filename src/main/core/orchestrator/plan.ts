import type { AgentRole } from '../../../shared/types'
import type { LlmSession } from '../session/types'
import { ALL_ROLES } from './assignment'

export interface PlannedTask {
  title: string
  description: string
  role?: AgentRole
  /** 계획 내 다른 작업의 인덱스(0-base)에 대한 의존 */
  dependsOn?: number[]
}

const VALID_ROLES = new Set<string>(ALL_ROLES)

/** 목표 분해를 요청하는 자기완결적 프롬프트 (CLI/API 세션 공통, system 비의존). */
export function buildPlannerPrompt(goal: string): string {
  return [
    '너는 소프트웨어 프로젝트 플래너다. 아래 목표를 실행 가능한 4~8개의 작업으로 분해하라.',
    '반드시 아래 형식의 JSON 배열만 출력하라(설명/마크다운 금지):',
    '[{"title":"작업명","description":"무엇을 어떻게","role":"architect|implementer|reviewer|tester","dependsOn":[의존작업인덱스]}]',
    '',
    '목표:',
    goal,
  ].join('\n')
}

/** LLM 출력 텍스트에서 JSON 배열을 견고하게 추출. */
export function extractJsonArray(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : text
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('계획 JSON 배열을 찾을 수 없습니다.')
  }
  return JSON.parse(candidate.slice(start, end + 1))
}

/** LLM 계획 출력 → PlannedTask[] (불완전 입력에 관대하게). */
export function parsePlannedTasks(text: string): PlannedTask[] {
  const arr = extractJsonArray(text)
  if (!Array.isArray(arr)) throw new Error('계획은 JSON 배열이어야 합니다.')
  if (arr.length === 0) throw new Error('분해된 작업이 없습니다(빈 계획).')

  return arr.map((raw, i): PlannedTask => {
    const o = (raw ?? {}) as Record<string, unknown>
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `작업 ${i + 1}`
    const description = typeof o.description === 'string' ? o.description : ''
    const role = typeof o.role === 'string' && VALID_ROLES.has(o.role) ? (o.role as AgentRole) : undefined
    const dependsOn = Array.isArray(o.dependsOn)
      ? o.dependsOn.filter((n): n is number => typeof n === 'number')
      : undefined
    return { title, description, role, dependsOn }
  })
}

/** planner 세션을 사용해 목표를 작업으로 분해. signal 로 분해 중 취소를 전파한다. */
export async function planTasks(goal: string, planner: LlmSession, signal?: AbortSignal): Promise<PlannedTask[]> {
  // fresh: 분해는 독립 1회 호출(세션 맥락에 의존하지 않는 자기완결 프롬프트).
  // signal: 분해 진행 중 취소되면 planner 호출도 중단한다.
  const reply = await planner.send(buildPlannerPrompt(goal), { fresh: true, signal })
  return parsePlannedTasks(reply)
}

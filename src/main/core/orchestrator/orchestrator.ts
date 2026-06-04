import type { AgentRole, OrchestratorEvent, RoleAssignment, RunResult } from '../../../shared/types'
import type { SessionManager } from '../session/manager'
import type { Store } from '../store/types'
import { resolveLlmForRole } from './assignment'
import { planTasks } from './plan'
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, parseReviewVerdict } from './review'

export type { OrchestratorEvent, RunResult } from '../../../shared/types'

export interface RunOptions {
  store: Store
  sessions: SessionManager
  assignments: readonly RoleAssignment[]
  /** 작업당 최대 재검토 라운드 (기본 2) */
  maxReviewRounds?: number
  onEvent?: (e: OrchestratorEvent) => void
}

/**
 * 오케스트레이션 실행 (요구사항 4,5):
 * 목표 → Planner 분해 → 작업별 (Implementer 구현 → Reviewer 교차검토 → 재검토 루프) → Summarizer 요약.
 * 모든 단계는 store 에 상태/감사 이벤트를 남기고 onEvent 로 진행을 방출한다.
 */
export async function runProject(goal: string, opts: RunOptions): Promise<RunResult> {
  const { store, sessions, assignments } = opts
  const maxRounds = opts.maxReviewRounds ?? 2
  const emit = (e: OrchestratorEvent): void => {
    store.appendEvent({ type: e.type, data: e.data ?? {} })
    opts.onEvent?.(e)
  }
  const sessionForRole = (role: AgentRole, fallback?: AgentRole) => {
    const id = resolveLlmForRole(assignments, role, fallback)
    return id ? sessions.get(id) : undefined
  }

  const project = store.createProject({ goal })
  emit({ type: 'project.created', message: `프로젝트 생성: ${project.title}`, data: { projectId: project.id } })

  // ── 1) 목표 분해 ──
  const planner = sessionForRole('planner')
  if (!planner) throw new Error('planner 역할에 배정된 LLM 세션이 없습니다.')

  let plannedCount = 0
  try {
    const planned = await planTasks(goal, planner)
    store.updateProject(project.id, { status: 'executing' })
    for (const pt of planned) {
      store.createTask({
        projectId: project.id,
        title: pt.title,
        description: pt.description,
        role: pt.role ?? 'implementer',
      })
    }
    plannedCount = planned.length
    emit({ type: 'plan.created', message: `${plannedCount}개 작업으로 분해`, data: { count: plannedCount } })
  } catch (err) {
    store.updateProject(project.id, { status: 'failed' })
    emit({ type: 'plan.failed', message: `분해 실패: ${(err as Error).message}`, data: { projectId: project.id } })
    throw err
  }

  // ── 2) 작업별 구현 + 교차 리뷰 + 재검토 루프 ──
  for (const task of store.listTasks(project.id)) {
    store.updateTask(task.id, { status: 'running' })
    emit({ type: 'task.started', message: `작업 시작: ${task.title}`, data: { taskId: task.id } })

    const implRole: AgentRole = task.role ?? 'implementer'
    const implementerId = resolveLlmForRole(assignments, implRole, 'implementer')
    const implementer = implementerId ? sessions.get(implementerId) : undefined
    if (!implementer) {
      store.updateTask(task.id, { status: 'failed', output: '구현 역할에 배정된 LLM 없음' })
      emit({ type: 'task.failed', message: `${task.title}: 구현 LLM 미배정`, data: { taskId: task.id } })
      continue
    }
    // 폴백까지 해소된 실제 실행 LLM 을 기록해 배정 정책 효과를 추적 가능하게 한다.
    store.updateTask(task.id, { assignedLlmId: implementerId })

    let output = ''
    let approved = false
    let feedback = ''
    for (let round = 0; round <= maxRounds; round++) {
      output = await implementer.send(buildImplementPrompt(goal, task.title, task.description, feedback || undefined), {
        fresh: true,
      })
      store.updateTask(task.id, { status: 'review', output })
      emit({ type: 'task.implemented', message: `구현 완료 (라운드 ${round + 1})`, data: { taskId: task.id, round } })

      const reviewer = sessionForRole('reviewer')
      if (!reviewer) {
        approved = true // 리뷰어 미배정 시 승인 간주
        break
      }
      const verdict = parseReviewVerdict(
        await reviewer.send(buildReviewPrompt(task.title, task.description, output), { fresh: true }),
      )
      emit({
        type: 'task.review',
        message: verdict.approved ? '리뷰 승인' : '수정 요청',
        data: { taskId: task.id, approved: verdict.approved, round },
      })
      if (verdict.approved) {
        approved = true
        break
      }
      feedback = verdict.feedback
    }

    store.updateTask(task.id, { status: approved ? 'done' : 'failed', output })
    emit({
      type: approved ? 'task.done' : 'task.failed',
      message: `${task.title}: ${approved ? '완료' : '미승인(재검토 한도 초과)'}`,
      data: { taskId: task.id },
    })
  }

  // ── 3) 최종 요약 / 누락 점검 ──
  let summary = ''
  const summarizer = sessionForRole('summarizer', 'reviewer')
  if (summarizer) {
    const finalTasks = store.listTasks(project.id)
    summary = await summarizer.send(buildSummaryPrompt(goal, finalTasks), { fresh: true })
    emit({ type: 'summary', message: '최종 요약 완료', data: { projectId: project.id } })
  }

  store.updateProject(project.id, { status: 'done' })
  emit({ type: 'project.done', message: `프로젝트 완료: ${project.title}`, data: { projectId: project.id } })

  return { projectId: project.id, tasks: store.listTasks(project.id), summary }
}

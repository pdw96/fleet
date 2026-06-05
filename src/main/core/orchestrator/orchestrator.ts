import type {
  AgentRole,
  OrchestratorEvent,
  RoleAssignment,
  RunResult,
  Task,
  VerificationResult,
} from '../../../shared/types'
import type { SessionManager } from '../session/manager'
import type { Store } from '../store/types'
import { parseArtifacts } from './artifacts'
import { resolveLlmForRole } from './assignment'
import { planTasks } from './plan'
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, buildVerifyFixPrompt, parseReviewVerdict } from './review'

export type { OrchestratorEvent, RunResult } from '../../../shared/types'

/** 승인 게이트·경로 제한을 갖춘 파일 기록기(구조적으로 fileops.createFileOps 가 만족). */
export interface ProjectFileWriter {
  write(path: string, content: string): Promise<{ ok: boolean; path: string; reason?: string }>
}

export interface RunOptions {
  store: Store
  sessions: SessionManager
  assignments: readonly RoleAssignment[]
  /** 작업당 최대 구현→검토 시도 횟수 (기본 2, 최소 1) */
  maxReviewRounds?: number
  /** 있으면 implementer 산출물의 파일 아티팩트를 워크스페이스에 기록한다(승인 게이트 경유). */
  fileWriter?: ProjectFileWriter
  /** 있으면 모든 작업 후 검증을 실행하고 결과를 RunResult/이벤트로 surface 한다(요구사항 5). */
  verify?: () => Promise<VerificationResult[]>
  /** verify 실패 시 implementer 재구현→재검증을 최대 N회 시도(기본 2, 0=비활성). */
  maxVerifyFixRounds?: number
  onEvent?: (e: OrchestratorEvent) => void
}

/**
 * 오케스트레이션 실행 (요구사항 4,5):
 * 목표 → Planner 분해 → 작업별 (Implementer 구현 → Reviewer 교차검토 → 재검토 루프) → Summarizer 요약.
 * 모든 단계는 store 에 상태/감사 이벤트를 남기고 onEvent 로 진행을 방출한다.
 */
export async function runProject(goal: string, opts: RunOptions): Promise<RunResult> {
  const { store, sessions, assignments } = opts
  // 작업당 최대 구현→검토 시도 횟수. 0/음수/NaN 은 최소 1회로 보정한다.
  const requested = Math.floor(opts.maxReviewRounds ?? 2)
  const maxRounds = Number.isFinite(requested) && requested >= 1 ? requested : 1
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
    // 1차: 작업 생성으로 계획 인덱스 → taskId 매핑 확보.
    const createdIds = planned.map(
      (pt) =>
        store.createTask({
          projectId: project.id,
          title: pt.title,
          description: pt.description,
          role: pt.role ?? 'implementer',
        }).id,
    )
    // 2차: dependsOn(계획 인덱스)을 taskId 로 해소한다. 범위 밖·자기참조 인덱스는 무시.
    planned.forEach((pt, i) => {
      const deps = (pt.dependsOn ?? [])
        .filter((d) => Number.isInteger(d) && d >= 0 && d < createdIds.length && d !== i)
        .map((d) => createdIds[d])
      if (deps.length > 0) store.updateTask(createdIds[i], { dependsOn: deps })
    })
    plannedCount = planned.length
    emit({ type: 'plan.created', message: `${plannedCount}개 작업으로 분해`, data: { count: plannedCount } })
  } catch (err) {
    store.updateProject(project.id, { status: 'failed' })
    emit({ type: 'plan.failed', message: `분해 실패: ${(err as Error).message}`, data: { projectId: project.id } })
    throw err
  }

  // ── 2) 작업별 구현 + 교차 리뷰 (dependsOn 위상 순서, 실패 전파) ──
  const tasks = store.listTasks(project.id)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const done = new Set<string>()
  const failed = new Set<string>()
  // verify 수정-루프가 implementer 에게 보여줄 '현재 워크스페이스 파일' 원장(성공 기록분 누적).
  const artifactLedger = new Map<string, string>()

  /** 승인된 산출물의 파일 아티팩트를 워크스페이스에 기록하고 원장을 갱신한다(fileWriter 가 있을 때만). */
  const writeArtifacts = async (output: string, ctx: { taskId?: string }): Promise<void> => {
    const fw = opts.fileWriter
    if (!fw) return
    const arts = parseArtifacts(output)
    if (arts.length === 0) return
    const written: string[] = []
    const denied: string[] = []
    for (const a of arts) {
      try {
        const res = await fw.write(a.path, a.content)
        if (res.ok) {
          written.push(res.path)
          artifactLedger.set(a.path, a.content)
        } else {
          denied.push(`${a.path}(${res.reason ?? '거부'})`)
        }
      } catch (err) {
        denied.push(`${a.path}(${err instanceof Error ? err.message : String(err)})`)
      }
    }
    emit({
      type: 'task.artifacts',
      message: `파일 기록 ${written.length}개${denied.length ? `, 거부/실패 ${denied.length}개` : ''}`,
      data: { taskId: ctx.taskId, written, denied },
    })
  }

  /** 단일 작업 실행: 구현→교차리뷰 루프. 결과를 done/failed 집합에 반영한다. */
  const runTask = async (task: Task): Promise<void> => {
    store.updateTask(task.id, { status: 'running' })
    emit({ type: 'task.started', message: `작업 시작: ${task.title}`, data: { taskId: task.id } })

    const implRole: AgentRole = task.role ?? 'implementer'
    const implementerId = resolveLlmForRole(assignments, implRole, 'implementer')
    const implementer = implementerId ? sessions.get(implementerId) : undefined
    if (!implementer) {
      store.updateTask(task.id, { status: 'failed', output: '구현 역할에 배정된 LLM 없음' })
      emit({ type: 'task.failed', message: `${task.title}: 구현 LLM 미배정`, data: { taskId: task.id } })
      failed.add(task.id)
      return
    }
    // 폴백까지 해소된 실제 실행 LLM 을 기록해 배정 정책 효과를 추적 가능하게 한다.
    store.updateTask(task.id, { assignedLlmId: implementerId })

    // 자기검토 경고: 같은 LLM 이 구현·검토를 모두 맡으면 교차검증 의미가 약해진다(감사 로그에 기록, 차단은 안 함).
    const reviewerId = resolveLlmForRole(assignments, 'reviewer')
    if (reviewerId && reviewerId === implementerId) {
      store.appendEvent({ type: 'task.self_review', data: { taskId: task.id, llmId: implementerId } })
    }

    try {
      let output = ''
      let approved = false
      let feedback = ''
      for (let round = 0; round < maxRounds; round++) {
        output = await implementer.send(
          buildImplementPrompt(goal, task.title, task.description, feedback || undefined, !!opts.fileWriter),
          { fresh: true },
        )
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

      if (approved) await writeArtifacts(output, { taskId: task.id })
      store.updateTask(task.id, { status: approved ? 'done' : 'failed', output })
      emit({
        type: approved ? 'task.done' : 'task.failed',
        message: `${task.title}: ${approved ? '완료' : '미승인(재검토 한도 초과)'}`,
        data: { taskId: task.id },
      })
      if (approved) done.add(task.id)
      else failed.add(task.id)
    } catch (err) {
      // LLM 호출(네트워크/CLI) 실패를 작업 단위로 격리한다 — 한 작업 실패가 전체 실행을 중단시키지 않는다.
      const message = err instanceof Error ? err.message : String(err)
      store.updateTask(task.id, { status: 'failed', output: `실행 오류: ${message}` })
      emit({ type: 'task.failed', message: `${task.title}: 실행 오류 - ${message}`, data: { taskId: task.id } })
      failed.add(task.id)
    }
  }

  // 위상 스케줄: 의존성이 모두 done 인 작업을 생성 순서대로 실행한다(결정론).
  // 의존 작업이 failed 면 해당 작업은 실행 없이 실패 전파한다.
  const pending = tasks.map((t) => t.id)
  let progressed = true
  while (pending.length > 0 && progressed) {
    progressed = false
    for (let i = 0; i < pending.length; ) {
      const task = byId.get(pending[i])
      if (!task) {
        pending.splice(i, 1)
        continue
      }
      const deps = task.dependsOn ?? []
      if (deps.some((d) => failed.has(d))) {
        store.updateTask(task.id, { status: 'failed', output: '의존 작업 실패로 건너뜀' })
        emit({ type: 'task.failed', message: `${task.title}: 의존 작업 실패로 건너뜀`, data: { taskId: task.id } })
        failed.add(task.id)
        pending.splice(i, 1)
        progressed = true
        continue
      }
      if (deps.every((d) => done.has(d))) {
        await runTask(task)
        pending.splice(i, 1)
        progressed = true
        continue
      }
      i++ // 의존성 미해소 → 다음 sweep 으로 미룬다
    }
  }
  // 위상 정렬로 해소되지 않은 작업(순환 의존 등)은 실패 처리해 무한 대기를 막는다.
  for (const id of pending) {
    const task = byId.get(id)
    if (!task) continue
    store.updateTask(id, { status: 'failed', output: '의존성 해소 불가(순환 가능)' })
    emit({ type: 'task.failed', message: `${task.title}: 의존성 해소 불가(순환 가능)`, data: { taskId: id } })
  }

  // ── 3) 최종 요약 / 누락 점검 ──
  let summary = ''
  const summarizer = sessionForRole('summarizer', 'reviewer')
  if (summarizer) {
    try {
      const finalTasks = store.listTasks(project.id)
      summary = await summarizer.send(buildSummaryPrompt(goal, finalTasks), { fresh: true })
      emit({ type: 'summary', message: '최종 요약 완료', data: { projectId: project.id } })
    } catch (err) {
      // 요약 실패가 완료된 작업 결과를 무효화하지 않도록 격리한다(summary 는 빈 문자열로 둔다).
      emit({ type: 'summary', message: `요약 실패: ${err instanceof Error ? err.message : String(err)}`, data: { projectId: project.id } })
    }
  }

  // ── 4) 검증 + 자동 수정-루프 (요구사항 5 후속) ──
  // verify 실패 시 실패 분석 + 현재 아티팩트를 implementer 에 피드백해 교정본을 재구현·게이트경유 재기록하고
  // 재검증한다. 최대 maxVerifyFixRounds 회(기본 2, 0=비활성). implementer/fileWriter 없으면 루프 생략.
  let verifications: VerificationResult[] | undefined
  if (opts.verify) {
    const run = opts.verify
    const requestedFix = Math.floor(opts.maxVerifyFixRounds ?? 2)
    const maxFix = Number.isFinite(requestedFix) && requestedFix >= 0 ? requestedFix : 2
    store.updateProject(project.id, { status: 'verifying' })

    const verifyOnce = async (): Promise<VerificationResult[]> => {
      try {
        return await run()
      } catch (err) {
        emit({
          type: 'verify.failed',
          message: `검증 실행 오류: ${err instanceof Error ? err.message : String(err)}`,
          data: { projectId: project.id },
        })
        return []
      }
    }
    const emitVerify = (v: readonly VerificationResult[]): void => {
      if (v.length === 0) return // 실행 오류는 verifyOnce 가 이미 방출
      const ok = v.every((r) => r.passed)
      emit({
        type: ok ? 'verify.passed' : 'verify.failed',
        message: ok ? '검증 통과' : `검증 실패: ${v.filter((r) => !r.passed).map((r) => r.kind).join(', ')}`,
        data: { projectId: project.id },
      })
    }

    verifications = await verifyOnce()
    emitVerify(verifications)

    const fixImplementerId = resolveLlmForRole(assignments, 'implementer', 'implementer')
    const fixImplementer = fixImplementerId ? sessions.get(fixImplementerId) : undefined

    for (
      let round = 1;
      round <= maxFix && verifications.some((v) => !v.passed) && !!opts.fileWriter && !!fixImplementer;
      round++
    ) {
      const failing = verifications.filter((v) => !v.passed)
      emit({
        type: 'verify.fixing',
        message: `검증 실패 — 수정 시도 (라운드 ${round})`,
        data: { projectId: project.id, round },
      })
      try {
        const fixOutput = await fixImplementer.send(buildVerifyFixPrompt(goal, failing, artifactLedger), { fresh: true })
        await writeArtifacts(fixOutput, {})
      } catch (err) {
        emit({
          type: 'verify.fixing',
          message: `수정 실패: ${err instanceof Error ? err.message : String(err)}`,
          data: { projectId: project.id, round },
        })
        break
      }
      verifications = await verifyOnce()
      emitVerify(verifications)
    }
  }

  const verifyFailed =
    !!opts.verify && !(verifications !== undefined && verifications.length > 0 && verifications.every((v) => v.passed))
  store.updateProject(project.id, { status: verifyFailed ? 'failed' : 'done' })
  emit({ type: 'project.done', message: `프로젝트 완료: ${project.title}`, data: { projectId: project.id } })

  return { projectId: project.id, tasks: store.listTasks(project.id), summary, verifications }
}

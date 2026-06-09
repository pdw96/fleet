import type {
  AgentRole,
  OrchestratorEvent,
  RoleAssignment,
  RunResult,
  Task,
  VerificationResult,
} from '../../../shared/types'
import type { ApprovalGate } from '../safety/approval'
import type { SessionManager } from '../session/manager'
import type { Store } from '../store/types'
import type { Workspace } from '../workspace/git'
import { resolveLlmForRole } from './assignment'
import { classifyDiffRisk } from './diff-risk'
import { planCorrectiveTasks, planTasks, type PlannedTask } from './plan'
import { buildImplementPrompt, buildReviewPrompt, buildSummaryPrompt, buildVerifyFixPrompt, parseReviewVerdict, REVIEW_SCHEMA } from './review'

export type { OrchestratorEvent, RunResult } from '../../../shared/types'

export interface RunOptions {
  store: Store
  sessions: SessionManager
  assignments: readonly RoleAssignment[]
  maxReviewRounds?: number
  /** 있으면 작업을 git 체크포인트/diff 기반으로 실행한다(직접 편집 모델). 없으면 작업 실행 불가로 스킵. */
  workspace?: Workspace
  /** 워크스페이스 디렉터리 경로. send({workspace})로 CLI 에이전트 cwd에 전달한다. */
  workspaceRoot?: string
  /** diff 위험 승인 게이트. 없으면 위험 변경은 거부(안전 기본값). */
  gate?: ApprovalGate
  verify?: () => Promise<VerificationResult[]>
  maxVerifyFixRounds?: number
  /** 검증 실패 시 planner 가 보정 작업을 분해→append→실행→재검증하는 최대 라운드. 0/음수/NaN → 0(비활성). */
  maxReplanRounds?: number
  /** 작업 LLM 호출 타임아웃(편집 에이전트는 길다). send 에 전달. */
  taskTimeoutMs?: number
  /** (예약) 향후 false면 첫 실패 시 후속 작업 중단 예정. 현재는 미배선 — 항상 부분 진행한다. */
  continueOnFailure?: boolean
  /** 실행 취소 신호. abort 시 진행 중 작업을 revert 하고 중단한다. */
  signal?: AbortSignal
  onEvent?: (e: OrchestratorEvent) => void
}

/**
 * 오케스트레이션 실행 (요구사항 4,5) — 직접 편집(diff 기반) 모델:
 * 목표 → Planner 분해 → 작업별 (Implementer 가 워크스페이스를 직접 편집 → Reviewer 가 diff 교차검토 → 재검토 루프
 *   → 위험 diff 승인 게이트 → git keep) → Summarizer 요약 → 검증 + 에이전트 수정-루프.
 * 모든 단계는 store 에 상태/감사 이벤트를 남기고 onEvent 로 진행을 방출한다.
 */
export async function runProject(goal: string, opts: RunOptions): Promise<RunResult> {
  const { store, sessions, assignments } = opts
  // 작업당 최대 구현→검토 시도 횟수. 0/음수/NaN 은 최소 1회로 보정한다.
  const requested = Math.floor(opts.maxReviewRounds ?? 2)
  const maxRounds = Number.isFinite(requested) && requested >= 1 ? requested : 1
  // 편집 에이전트 작업은 수 분이 걸린다 — 미지정 시 15분 기본(채팅용 120s 기본을 상속하지 않게).
  const DEFAULT_TASK_TIMEOUT_MS = 900_000
  const requestedTaskTimeout = Math.floor(opts.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)
  const taskTimeoutMs = Number.isFinite(requestedTaskTimeout) && requestedTaskTimeout > 0 ? requestedTaskTimeout : DEFAULT_TASK_TIMEOUT_MS
  // planner 세션은 프로젝트 생성 전에 검증한다 — 없으면 store 에 고아 프로젝트(planning 상태로 영구 정체)를 남기지 않는다.
  const plannerId = resolveLlmForRole(assignments, 'planner')
  const planner = plannerId ? sessions.get(plannerId) : undefined
  if (!planner) throw new Error('planner 역할에 배정된 LLM 세션이 없습니다.')

  // 프로젝트를 먼저 만들어 projectId 를 const 로 확보한다(emit 클로저가 캡처).
  const project = store.createProject({ goal })
  const projectId = project.id
  const emit = (e: OrchestratorEvent): void => {
    // 라이브(onEvent)와 영속 이벤트가 같은 data(projectId 포함)를 갖도록 한 번만 enrich 한다.
    // 이렇게 해야 렌더러가 projectId 로 라이브 이벤트를 필터링할 수 있다(task.* 이벤트는 원래 taskId 만 보유).
    const enriched: OrchestratorEvent = { ...e, data: { ...(e.data ?? {}), projectId } }
    // task.progress(토큰 델타)는 영속하지 않는다 — 재생 로그 노이즈 + 매 토큰 전체 스냅샷 재기록 방지(라이브 onEvent 만).
    if (e.type !== 'task.progress') {
      // 영속 이벤트의 id 를 라이브 페이로드(data.eventId)에도 실어 보낸다 — 렌더러가 스냅샷 재조회 시
      // 라이브로 이미 받은 행과 영속본을 같은 id 로 정확히 dedup 하도록(반복 메시지 과잉제거 방지).
      const persisted = store.appendEvent({ type: enriched.type, message: enriched.message, data: enriched.data ?? {} })
      opts.onEvent?.({ ...enriched, data: { ...enriched.data, eventId: persisted.id } })
      return
    }
    opts.onEvent?.(enriched)
  }
  const sessionForRole = (role: AgentRole, fallback?: AgentRole) => {
    const id = resolveLlmForRole(assignments, role, fallback)
    return id ? sessions.get(id) : undefined
  }

  emit({ type: 'project.created', message: `프로젝트 생성: ${project.title}`, data: { projectId } })

  // ── 1) 목표 분해 ── (planner 는 위에서 검증됨)
  let plannedCount = 0
  try {
    const planned = await planTasks(goal, planner, opts.signal)
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

  // 직접 편집 모델: 작업 루프 전에 워크스페이스가 git 저장소인지 보장한다.
  // 초기화 실패는 'executing' 상태로 방치하지 않고 project failed + 종료 이벤트를 남긴 뒤 rethrow 한다.
  if (opts.workspace) {
    try {
      await opts.workspace.ensureRepo()
    } catch (err) {
      store.updateProject(project.id, { status: 'failed' })
      emit({
        type: 'project.done',
        message: `워크스페이스 초기화 실패: ${err instanceof Error ? err.message : String(err)}`,
        data: { projectId: project.id },
      })
      throw err
    }
  }

  // ── 2) 작업별 직접 편집 + diff 교차 리뷰 (dependsOn 위상 순서, 실패 격리) ──
  const tasks = store.listTasks(project.id)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const done = new Set<string>()
  const failed = new Set<string>()

  /** 단일 작업 실행: 직접 편집→diff 교차리뷰 루프→위험게이트→keep. 결과를 done/failed 집합에 반영한다. */
  const runTask = async (task: Task): Promise<void> => {
    const ws = opts.workspace
    // #1: 모든 작업은 워크스페이스를 편집하므로 항상 implementer 역할로 실행 세션을 해소한다.
    // planner 가 role:"reviewer"(혹은 다른 비-implementer)를 붙여도 비편집 세션으로 오라우팅되지 않게 한다
    // (task.role 은 표시용 라벨로만 보존된다).
    const implementerId = resolveLlmForRole(assignments, 'implementer', 'implementer')
    const implementer = implementerId ? sessions.get(implementerId) : undefined
    if (!implementer) {
      store.updateTask(task.id, { status: 'failed', output: '구현 역할에 배정된 LLM 없음' })
      emit({ type: 'task.failed', message: `${task.title}: 구현 LLM 미배정`, data: { taskId: task.id } })
      failed.add(task.id)
      return
    }
    // 직접 편집은 CLI 세션만 가능(API는 파일을 못 만짐).
    if (implementer.descriptor.kind !== 'cli' || !ws) {
      store.updateTask(task.id, { status: 'skipped', output: 'CLI 에이전트/워크스페이스 필요(직접 편집 불가)' })
      emit({ type: 'task.skipped', message: `${task.title}: 직접 편집 불가(API 또는 워크스페이스 없음)`, data: { taskId: task.id } })
      failed.add(task.id)
      return
    }
    store.updateTask(task.id, { status: 'running', assignedLlmId: implementerId })
    emit({ type: 'task.started', message: `작업 시작: ${task.title}`, data: { taskId: task.id } })

    // 자기검토 경고: 같은 LLM 이 구현·검토를 모두 맡으면 교차검증 의미가 약해진다(감사 로그에 기록, 차단은 안 함).
    const reviewerId = resolveLlmForRole(assignments, 'reviewer')
    if (reviewerId && reviewerId === implementerId) {
      store.appendEvent({ type: 'task.self_review', data: { taskId: task.id, llmId: implementerId } })
    }

    const base = await ws.checkpoint()
    store.updateTask(task.id, { checkpoint: base })
    try {
      let approved = false
      let feedback = ''
      let diff = { files: [] as string[], patch: '', truncated: false }
      for (let round = 0; round < maxRounds; round++) {
        await implementer.send(buildImplementPrompt(goal, task.title, task.description, feedback || undefined), {
          fresh: true,
          workspace: opts.workspaceRoot,
          signal: opts.signal,
          timeoutMs: taskTimeoutMs,
          onChunk: (delta) => emit({ type: 'task.progress', message: delta, data: { taskId: task.id } }),
        })
        diff = await ws.collectDiff(base)
        store.updateTask(task.id, { status: 'review', changedFiles: diff.files })
        emit({ type: 'task.implemented', message: `구현 완료 (라운드 ${round + 1}, 변경 ${diff.files.length}개)`, data: { taskId: task.id, round } })

        // #5: 민감/위험 diff 는 리뷰어(외부 API 가능)에게 보내기 전에 승인 게이트를 거친다(비밀 유출 방지).
        const dr = classifyDiffRisk(diff)
        if (dr.risk === 'destructive') {
          const decision = opts.gate
            ? await opts.gate.request({ kind: 'apply-diff', summary: `${task.title} 변경 적용`, target: diff.files.join(', '), risk: 'destructive' })
            : 'rejected'
          if (decision !== 'approved') {
            await ws.revert(base)
            store.updateTask(task.id, { status: 'failed', output: `위험 변경 미승인: ${dr.reasons.join('; ')}`, changedFiles: [] })
            emit({ type: 'task.failed', message: `${task.title}: 위험 변경 미승인`, data: { taskId: task.id } })
            failed.add(task.id)
            return
          }
        }

        const reviewer = sessionForRole('reviewer')
        if (!reviewer) {
          approved = true
          break
        }
        const verdict = parseReviewVerdict(
          await reviewer.send(buildReviewPrompt(task.title, task.description, diff.patch), {
            fresh: true,
            signal: opts.signal,
            responseSchema: { name: 'review', schema: REVIEW_SCHEMA },
            bypassTools: true,
          }),
        )
        emit({ type: 'task.review', message: verdict.approved ? '리뷰 승인' : '수정 요청', data: { taskId: task.id, approved: verdict.approved, round } })
        if (verdict.approved) {
          approved = true
          break
        }
        feedback = verdict.feedback
        await ws.revert(base) // 거절된 시도는 되돌리고 다음 라운드 재시도
      }

      if (!approved) {
        await ws.revert(base)
        store.updateTask(task.id, { status: 'failed', output: '미승인(재검토 한도 초과)', changedFiles: [] })
        emit({ type: 'task.failed', message: `${task.title}: 미승인(재검토 한도 초과)`, data: { taskId: task.id } })
        failed.add(task.id)
        return
      }

      await ws.keep(`[${task.title}] by ${implementerId}`)
      store.updateTask(task.id, { status: 'done', output: `변경 ${diff.files.length}개 적용`, changedFiles: diff.files })
      emit({ type: 'task.done', message: `${task.title}: 완료(변경 ${diff.files.length}개)`, data: { taskId: task.id } })
      done.add(task.id)
    } catch (err) {
      // LLM 호출(네트워크/CLI) 실패를 작업 단위로 격리한다 — 한 작업 실패가 전체 실행을 중단시키지 않는다.
      await ws.revert(base).catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      store.updateTask(task.id, { status: 'failed', output: `실행 오류: ${message}` })
      emit({ type: 'task.failed', message: `${task.title}: 실행 오류 - ${message}`, data: { taskId: task.id } })
      failed.add(task.id)
    }
  }

  // 위상 스케줄: 의존성이 모두 done 인 작업을 생성 순서대로 실행한다(결정론).
  // 의존 작업이 failed/skipped 면 해당 작업은 실행 없이 skipped 로 전파한다.
  const pending = tasks.map((t) => t.id)
  let progressed = true
  let aborted = false
  while (pending.length > 0 && progressed && !aborted) {
    progressed = false
    for (let i = 0; i < pending.length; ) {
      const task = byId.get(pending[i])
      if (!task) {
        pending.splice(i, 1)
        continue
      }
      // 취소되면 더 이상 스케줄링하지 않는다 — 남은 pending 은 아래에서 skipped 처리.
      if (opts.signal?.aborted) {
        aborted = true
        break
      }
      const deps = task.dependsOn ?? []
      if (deps.some((d) => failed.has(d))) {
        store.updateTask(task.id, { status: 'skipped', output: '의존 작업 실패로 건너뜀' })
        emit({ type: 'task.skipped', message: `${task.title}: 의존 작업 실패로 건너뜀`, data: { taskId: task.id } })
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
  // 남은 작업 처리. 취소 시에는 skipped(실행 취소됨), 그 외(순환 의존 등)는 failed 로 무한 대기를 막는다.
  for (const id of pending) {
    const task = byId.get(id)
    if (!task) continue
    if (opts.signal?.aborted) {
      store.updateTask(id, { status: 'skipped', output: '실행 취소됨' })
      emit({ type: 'task.skipped', message: `${task.title}: 실행 취소됨`, data: { taskId: id } })
    } else {
      store.updateTask(id, { status: 'failed', output: '의존성 해소 불가(순환 가능)' })
      emit({ type: 'task.failed', message: `${task.title}: 의존성 해소 불가(순환 가능)`, data: { taskId: id } })
    }
  }

  // ── 3) 최종 요약 / 누락 점검 ── (취소 시 생략)
  let summary = ''
  const summarizer = sessionForRole('summarizer', 'reviewer')
  if (summarizer && !opts.signal?.aborted) {
    try {
      const finalTasks = store.listTasks(project.id)
      summary = await summarizer.send(buildSummaryPrompt(goal, finalTasks), { fresh: true, signal: opts.signal, bypassTools: true })
      emit({ type: 'summary', message: '최종 요약 완료', data: { projectId: project.id } })
    } catch (err) {
      // 요약 실패가 완료된 작업 결과를 무효화하지 않도록 격리한다(summary 는 빈 문자열로 둔다).
      emit({ type: 'summary', message: `요약 실패: ${err instanceof Error ? err.message : String(err)}`, data: { projectId: project.id } })
    }
  }

  // ── 4) 검증 + 자동 수정-루프 (요구사항 5 후속) ──
  // verify 실패 시 implementer 에이전트를 워크스페이스에서 재실행해 직접 수정·커밋하고 재검증한다.
  // 최대 maxVerifyFixRounds 회(기본 2, 0=비활성). 워크스페이스/CLI implementer 없으면 루프 생략.
  let verifications: VerificationResult[] | undefined
  if (opts.verify && !opts.signal?.aborted) {
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
      round <= maxFix &&
      verifications.some((v) => !v.passed) &&
      !!opts.workspace &&
      !!fixImplementer &&
      fixImplementer.descriptor.kind === 'cli';
      round++
    ) {
      const failing = verifications.filter((v) => !v.passed)
      emit({ type: 'verify.fixing', message: `검증 실패 — 수정 시도 (라운드 ${round})`, data: { projectId: project.id, round } })
      const base = await opts.workspace.checkpoint()
      try {
        await fixImplementer.send(buildVerifyFixPrompt(goal, failing), {
          fresh: true,
          workspace: opts.workspaceRoot,
          signal: opts.signal,
          timeoutMs: taskTimeoutMs,
        })
        // 작업 경로와 동일하게 verify-fix diff 도 위험 분류·승인 게이트를 거친다.
        const diff = await opts.workspace.collectDiff(base)
        const dr = classifyDiffRisk(diff)
        if (dr.risk === 'destructive') {
          const decision = opts.gate
            ? await opts.gate.request({ kind: 'apply-diff', summary: `verify-fix r${round} 변경 적용`, target: diff.files.join(', '), risk: 'destructive' })
            : 'rejected'
          if (decision !== 'approved') {
            await opts.workspace.revert(base)
            emit({ type: 'verify.fixing', message: `수정 위험 변경 미승인: ${dr.reasons.join('; ')}`, data: { projectId: project.id, round } })
            break
          }
        }
        await opts.workspace.keep(`[verify-fix r${round}]`)
      } catch (err) {
        await opts.workspace.revert(base).catch(() => {})
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

    // ── 5) (옵션) append-only 보정 replan ──
    // verify-fix 가 소진된 뒤에도 검증이 실패하면, planner 에게 검증 실패를 되먹여 '보정 작업'을
    // 받아 store 에 append(기존 작업 불변)하고 기존 runTask 로 순차 실행한 뒤 재검증한다.
    // 최대 maxReplanRounds 회(기본 0=비활성). planner 가 빈 목록을 주면 조기 종료(결정론).
    // 워크스페이스/CLI implementer 없거나 취소되면 생략(verify-fix 루프와 동일 가드).
    const requestedReplan = Math.floor(opts.maxReplanRounds ?? 0)
    const maxReplan = Number.isFinite(requestedReplan) && requestedReplan >= 0 ? requestedReplan : 0
    for (
      let round = 1;
      round <= maxReplan &&
      verifications.some((v) => !v.passed) &&
      !!opts.workspace &&
      !!fixImplementer &&
      fixImplementer.descriptor.kind === 'cli' &&
      !opts.signal?.aborted;
      round++
    ) {
      const failing = verifications.filter((v) => !v.passed)
      let corrective: PlannedTask[]
      try {
        corrective = await planCorrectiveTasks(goal, failing, planner, opts.signal)
      } catch (err) {
        // 보정 계획 실패는 완료된 작업을 무효화하지 않는다 — 표면화(비-silent)하고 replan 중단.
        emit({
          type: 'replan',
          message: `보정 계획 실패: ${err instanceof Error ? err.message : String(err)}`,
          data: { projectId: project.id, round },
        })
        break
      }
      if (corrective.length === 0) {
        emit({ type: 'replan', message: '보정 작업 없음 — replan 종료', data: { projectId: project.id, round, count: 0 } })
        break
      }
      emit({
        type: 'replan',
        message: `보정 작업 ${corrective.length}개 추가 (라운드 ${round})`,
        data: { projectId: project.id, round, count: corrective.length },
      })
      // append-only: 보정 작업은 의존성 없는 평면 목록 → store 에 추가하고 순차 실행(위상 sweep 불필요).
      for (const ct of corrective) {
        if (opts.signal?.aborted) break
        const created = store.createTask({
          projectId: project.id,
          title: ct.title,
          description: ct.description,
          role: ct.role ?? 'implementer',
        })
        await runTask(created)
      }
      verifications = await verifyOnce()
      emitVerify(verifications)
    }
  }

  // 취소되면 검증·요약을 건너뛰었으므로 무조건 failed 로 종료한다(misleading done 방지).
  // run.cancelled 는 engine 이 별도로 방출하므로 오케스트레이터는 일을 멈추기만 하면 된다.
  const verifyFailed =
    !!opts.verify && !(verifications !== undefined && verifications.length > 0 && verifications.every((v) => v.passed))
  store.updateProject(project.id, { status: opts.signal?.aborted || verifyFailed ? 'failed' : 'done' })
  emit({ type: 'project.done', message: `프로젝트 완료: ${project.title}`, data: { projectId: project.id } })

  return { projectId: project.id, tasks: store.listTasks(project.id), summary, verifications }
}

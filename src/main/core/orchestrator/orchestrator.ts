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
import type { TaskWorktree, Workspace } from '../workspace/git'
import { disposeBaseline, type IgnoredBaseline } from '../workspace/ignored-baseline'
import { resolveLlmForRole } from './assignment'
import { classifyDiffRisk } from './diff-risk'
import { rollbackWithIgnored } from './ignored-guard'
import { planCorrectiveTasks, planTasks, type PlannedTask } from './plan'
import {
  buildImplementPrompt,
  buildReviewPrompt,
  buildSummaryPrompt,
  buildVerifyFixPrompt,
  parseReviewVerdict,
  REVIEW_SCHEMA,
} from './review'

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
  /** 독립 작업 최대 동시 실행 수(기본 1=순차). 1 이면 기존 순차 경로를 그대로 탄다(무회귀). */
  maxConcurrency?: number
  /** 작업 LLM 호출 타임아웃(편집 에이전트는 길다). send 에 전달. */
  taskTimeoutMs?: number
  /** (예약) 향후 false면 첫 실패 시 후속 작업 중단 예정. 현재는 미배선 — 항상 부분 진행한다. */
  continueOnFailure?: boolean
  /** 실행 취소 신호. abort 시 진행 중 작업을 revert 하고 중단한다. */
  signal?: AbortSignal
  onEvent?: (e: OrchestratorEvent) => void
  /**
   * 병렬 모드(maxConcurrency > 1)에서 작업별 독립 편집 세션을 만드는 팩토리.
   * 호출마다 implementer 와 동등한 새 독립 CLI 세션 인스턴스(자체 chain)를 반환한다.
   * 미지정이거나 순차 모드(maxConcurrency === 1)면 단일 implementer 세션을 그대로 사용한다(무회귀).
   * (#80 결함①: worktree 격리 시에도 단일 CLI chain 직렬화를 우회하는 핵심 배선)
   */
  makeEditSession?: () => import('../session/types').LlmSession
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
  const taskTimeoutMs =
    Number.isFinite(requestedTaskTimeout) && requestedTaskTimeout > 0
      ? requestedTaskTimeout
      : DEFAULT_TASK_TIMEOUT_MS
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
      const persisted = store.appendEvent({
        type: enriched.type,
        message: enriched.message,
        data: enriched.data ?? {},
      })
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
    const plannedCount = planned.length
    emit({
      type: 'plan.created',
      message: `${plannedCount}개 작업으로 분해`,
      data: { count: plannedCount },
    })
  } catch (err) {
    store.updateProject(project.id, { status: 'failed' })
    emit({
      type: 'plan.failed',
      message: `분해 실패: ${(err as Error).message}`,
      data: { projectId: project.id },
    })
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

  /**
   * 단일 작업 실행 핵심 로직: 직접 편집→diff 교차리뷰 루프→위험게이트→keep.
   * 결과를 done/failed 집합에 반영하고, done 경로에서 keep 커밋 해시를 반환한다.
   * Task 5(병렬 스케줄러)가 작업별 worktree·독립 세션을 주입할 수 있도록 ws·implementer 를 인자로 받는다.
   * @param editRoot 편집 에이전트(implementer.send)의 cwd. 병렬 시 worktree 경로(wt.path), 순차 시 메인(opts.workspaceRoot).
   *   (P1 #1) 이 값을 send({workspace})로 넘겨야 편집이 격리된 worktree 안에서 일어난다 — 메인을 쓰면 격리가 무력화된다.
   * @returns done 경로: keep 커밋 해시(string). 실패·스킵·미승인·취소: undefined.
   */
  const runTaskIn = async (
    task: Task,
    ws: Workspace | undefined,
    implementer: import('../session/types').LlmSession | undefined,
    editRoot: string | undefined,
  ): Promise<string | undefined> => {
    // implementer 세션 미존재 가드 — 기존 failed 처리와 동일
    if (!implementer) {
      store.updateTask(task.id, { status: 'failed', output: '구현 역할에 배정된 LLM 없음' })
      emit({
        type: 'task.failed',
        message: `${task.title}: 구현 LLM 미배정`,
        data: { taskId: task.id },
      })
      failed.add(task.id)
      return undefined
    }
    // 직접 편집은 CLI 세션만 가능(API는 파일을 못 만짐).
    if (implementer.descriptor.kind !== 'cli' || !ws) {
      store.updateTask(task.id, {
        status: 'skipped',
        output: 'CLI 에이전트/워크스페이스 필요(직접 편집 불가)',
      })
      emit({
        type: 'task.skipped',
        message: `${task.title}: 직접 편집 불가(API 또는 워크스페이스 없음)`,
        data: { taskId: task.id },
      })
      failed.add(task.id)
      return undefined
    }
    const implementerId = implementer.id
    store.updateTask(task.id, { status: 'running', assignedLlmId: implementerId })
    emit({ type: 'task.started', message: `작업 시작: ${task.title}`, data: { taskId: task.id } })

    // 자기검토 경고: 같은 LLM 이 구현·검토를 모두 맡으면 교차검증 의미가 약해진다(감사 로그에 기록, 차단은 안 함).
    const reviewerId = resolveLlmForRole(assignments, 'reviewer')
    if (reviewerId && reviewerId === implementerId) {
      store.appendEvent({
        type: 'task.self_review',
        data: { taskId: task.id, llmId: implementerId },
      })
    }

    const base = await ws.checkpoint()
    store.updateTask(task.id, { checkpoint: base })
    // captureIgnoredBaseline 실패(민감 파일 백업 불가) = hard-stop. capture 성공 시 baseline 을 보유한다.
    let ignoredBaseline: IgnoredBaseline | null
    try {
      ignoredBaseline = await ws.captureIgnoredBaseline()
    } catch (err) {
      // 민감 ignored 백업 실패 = hard-stop. tracked 변경 없음이므로 revert 만.
      const note = await rollbackWithIgnored(ws, base, null)
      store.updateTask(task.id, {
        status: 'failed',
        output: `민감 ignored 백업 실패: ${err instanceof Error ? err.message : String(err)}${note}`,
      })
      store.appendEvent({ type: 'task.failed', data: { taskId: task.id } })
      emit({
        type: 'task.failed',
        message: `${task.title}: 민감 ignored 백업 실패`,
        data: { taskId: task.id },
      })
      failed.add(task.id)
      return undefined
    }
    try {
      let approved = false
      let feedback = ''
      let diff = { files: [] as string[], patch: '', truncated: false }
      for (let round = 0; round < maxRounds; round++) {
        await implementer.send(
          buildImplementPrompt(goal, task.title, task.description, feedback || undefined),
          {
            fresh: true,
            // (P1 #1) editRoot = 병렬이면 worktree(wt.path), 순차면 메인(opts.workspaceRoot).
            // 편집이 격리된 worktree 안에서 일어나도록 메인이 아니라 이 경로를 cwd 로 쓴다.
            workspace: editRoot,
            signal: opts.signal,
            timeoutMs: taskTimeoutMs,
            onChunk: (delta) =>
              emit({ type: 'task.progress', message: delta, data: { taskId: task.id } }),
          },
        )
        diff = await ws.collectDiff(base)
        const ignoredChanges = await ws.collectIgnoredChanges(ignoredBaseline)
        store.updateTask(task.id, { status: 'review', changedFiles: diff.files })
        emit({
          type: 'task.implemented',
          message: `구현 완료 (라운드 ${round + 1}, 변경 ${diff.files.length}개)`,
          data: { taskId: task.id, round },
        })
        if (ignoredChanges.changes.length > 0 || ignoredChanges.unrestorable.length > 0) {
          // P2-5: data 에 projectId 를 명시한다 — listProjectEvents(projectId) 가 이 이벤트를
          // 포함하려면 data.projectId 가 필요하다(store 필터: e.data?.projectId === projectId).
          store.appendEvent({
            type: 'workspace.ignored_changes',
            data: {
              projectId,
              taskId: task.id,
              changes: ignoredChanges.changes.map((c) => ({
                path: c.path,
                change: c.change,
                sensitive: c.sensitive,
              })),
              unrestorable: ignoredChanges.unrestorable.map((u) => u.path),
            },
          })
        }

        // #5: 민감/위험 diff 는 리뷰어(외부 API 가능)에게 보내기 전에 승인 게이트를 거친다(비밀 유출 방지).
        const dr = classifyDiffRisk(diff, ignoredChanges)
        if (dr.risk === 'destructive') {
          // P2-1: diff.files 가 비어 있으면(ignored-only destructive) target 이 공백이 된다.
          // 승인자가 어떤 ignored 경로·종류를 승인하는지 알 수 있도록 sanitized reasons 를 포함한다
          // (경로·변경종류만, 내용·hash 없음).
          const trackedTarget = diff.files.join(', ')
          const gateTarget =
            trackedTarget.length > 0
              ? trackedTarget
              : dr.reasons.filter((r) => !r.startsWith('복원 불가')).join('; ') ||
                dr.reasons.join('; ')
          const decision = opts.gate
            ? await opts.gate.request({
                kind: 'apply-diff',
                summary: `${task.title} 변경 적용`,
                target: gateTarget,
                risk: 'destructive',
              })
            : 'rejected'
          if (decision !== 'approved') {
            const note = await rollbackWithIgnored(ws, base, ignoredBaseline)
            store.updateTask(task.id, {
              status: 'failed',
              output: `위험 변경 미승인: ${dr.reasons.join('; ')}${note}`,
              changedFiles: [],
            })
            emit({
              type: 'task.failed',
              message: `${task.title}: 위험 변경 미승인`,
              data: { taskId: task.id },
            })
            failed.add(task.id)
            return undefined
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
        // P2-2: rollback 실패(dirty-tree) 시 재시도하면 오염된 트리에서 다음 라운드가 시작된다.
        // non-empty note = rollback 실패 → 즉시 task failed + 루프 탈출(재시도 중단).
        const rejectRollbackNote = await rollbackWithIgnored(ws, base, ignoredBaseline)
        if (rejectRollbackNote) {
          store.updateTask(task.id, {
            status: 'failed',
            output: `리뷰 거절 후 되돌리기 실패: ${rejectRollbackNote}`,
            changedFiles: [],
          })
          emit({
            type: 'task.failed',
            message: `${task.title}: 리뷰 거절 후 되돌리기 실패`,
            data: { taskId: task.id },
          })
          failed.add(task.id)
          return undefined
        }
      }

      if (!approved) {
        const note = await rollbackWithIgnored(ws, base, ignoredBaseline)
        store.updateTask(task.id, {
          status: 'failed',
          output: `미승인(재검토 한도 초과)${note}`,
          changedFiles: [],
        })
        emit({
          type: 'task.failed',
          message: `${task.title}: 미승인(재검토 한도 초과)`,
          data: { taskId: task.id },
        })
        failed.add(task.id)
        return undefined
      }

      // done 경로: keep 커밋 해시를 캡처해 반환 — Task 5 병렬 통합(ws.integrate)에서 사용.
      const keepHash = await ws.keep(`[${task.title}] by ${implementerId}`)
      store.updateTask(task.id, {
        status: 'done',
        output: `변경 ${diff.files.length}개 적용`,
        changedFiles: diff.files,
      })
      emit({
        type: 'task.done',
        message: `${task.title}: 완료(변경 ${diff.files.length}개)`,
        data: { taskId: task.id },
      })
      done.add(task.id)
      return keepHash
    } catch (err) {
      // LLM 호출(네트워크/CLI) 실패를 작업 단위로 격리한다 — 한 작업 실패가 전체 실행을 중단시키지 않는다.
      // 부분 편집을 되돌린다. revert/restore 실패는 잔존 변경을 남기므로 무성흡수하지 않고 표면화한다(#7).
      const revertNote = await rollbackWithIgnored(ws, base, ignoredBaseline)
      // 취소(abort)로 인한 중단은 '실행 오류'가 아니다 — 취소(skipped)로 정확히 라벨한다
      // (pending 취소 경로의 '실행 취소됨'·task.skipped 와 동일 컨벤션). failed 집계에도 넣지 않는다.
      if (opts.signal?.aborted) {
        store.updateTask(task.id, { status: 'skipped', output: `실행 취소됨${revertNote}` })
        emit({
          type: 'task.skipped',
          message: `${task.title}: 실행 취소됨${revertNote}`,
          data: { taskId: task.id },
        })
        return undefined
      }
      const message = err instanceof Error ? err.message : String(err)
      store.updateTask(task.id, { status: 'failed', output: `실행 오류: ${message}${revertNote}` })
      emit({
        type: 'task.failed',
        message: `${task.title}: 실행 오류 - ${message}${revertNote}`,
        data: { taskId: task.id },
      })
      failed.add(task.id)
      return undefined
    } finally {
      if (ignoredBaseline) disposeBaseline(ignoredBaseline)
    }
  }

  // 단일 워크스페이스·단일 implementer 로 기존과 동일하게 실행(무회귀 경로).
  // #1: 모든 작업은 워크스페이스를 편집하므로 항상 implementer 역할로 실행 세션을 해소한다.
  // planner 가 role:"reviewer"(혹은 다른 비-implementer)를 붙여도 비편집 세션으로 오라우팅되지 않게 한다
  // (task.role 은 표시용 라벨로만 보존된다).
  const seqImplementerId = resolveLlmForRole(assignments, 'implementer', 'implementer')
  const seqImplementer = seqImplementerId ? sessions.get(seqImplementerId) : undefined
  const runTask = (task: Task): Promise<string | undefined> =>
    // 순차 경로: 편집 cwd 는 메인 워크스페이스(opts.workspaceRoot) — 무회귀.
    runTaskIn(task, opts.workspace, seqImplementer, opts.workspaceRoot)

  // 위상 스케줄: 의존성이 모두 done 인 작업을 생성 순서대로 실행한다(결정론).
  // 의존 작업이 failed/skipped 면 해당 작업은 실행 없이 skipped 로 전파한다.
  const pending = tasks.map((t) => t.id)

  // 의존 작업이 실패/스킵된 작업을 실행 없이 skipped 로 전파한다(순차·병렬 공용).
  // @returns 전파를 1건 이상 수행했으면 true(진행 있음).
  const propagateDepFailures = (): boolean => {
    let progressed = false
    for (let i = 0; i < pending.length; ) {
      const task = byId.get(pending[i])
      if (!task) {
        pending.splice(i, 1)
        continue
      }
      const deps = task.dependsOn ?? []
      if (deps.some((d) => failed.has(d))) {
        store.updateTask(task.id, { status: 'skipped', output: '의존 작업 실패로 건너뜀' })
        emit({
          type: 'task.skipped',
          message: `${task.title}: 의존 작업 실패로 건너뜀`,
          data: { taskId: task.id },
        })
        failed.add(task.id)
        pending.splice(i, 1)
        progressed = true
        continue
      }
      i++
    }
    return progressed
  }

  // ── 병렬 sweep(maxConcurrency > 1) ──
  // 매 라운드 실행가능(deps 모두 done) 집합을 concurrency 만큼 묶어 worktree 격리로 동시 실행한다.
  // worktree 생성/정리·메인 통합은 순차(common gitdir·main HEAD 보호), 편집만 병렬.
  // 결정론: 통합은 작업 생성 순서(병렬 완료 순서 아님)로 cherry-pick 한다.
  // canParallel 이 false 면 이 블록을 통째로 건너뛰고 기존 순차 루프를 그대로 탄다(무회귀).
  const concurrency = Math.max(1, Math.floor(opts.maxConcurrency ?? 1))
  const canParallel =
    concurrency > 1 &&
    !!opts.workspace &&
    !!opts.makeEditSession &&
    typeof opts.workspace.addWorktree === 'function'
  if (canParallel) {
    const ws = opts.workspace as Workspace
    const makeEditSession = opts.makeEditSession as () => import('../session/types').LlmSession
    while (pending.length > 0 && !opts.signal?.aborted) {
      // 1) 의존 실패 전파(기존 로직 재사용) 후, 실행가능 집합 수집.
      propagateDepFailures()
      if (pending.length === 0 || opts.signal?.aborted) break
      const runnable = pending
        .map((id) => byId.get(id))
        .filter((t): t is Task => {
          if (!t) return false
          const deps = t.dependsOn ?? []
          return !deps.some((d) => failed.has(d)) && deps.every((d) => done.has(d))
        })
      if (runnable.length === 0) break // 진행 불가(의존성 미해소·순환) → 잔여는 아래 cleanup 으로

      const batch = runnable.slice(0, concurrency)
      const base = await ws.checkpoint()
      // 2) worktree 순차 생성(common gitdir 보호).
      // (P2 #3) 생성 도중 addWorktree 가 throw(예: 스테일 .fleet-wt-* 잔존)하면, 그때까지 누적된
      //   worktree 가 정리 섹션 도달 전 디스크에 잔존한다. try 로 감싸 누적분을 전부 정리하고,
      //   실패한 작업은 failed 처리한 뒤 이번 배치를 건너뛴다(project.done 경로 보존).
      const wts: { task: Task; wt: TaskWorktree }[] = []
      let createFailed = false
      try {
        for (const task of batch) {
          wts.push({ task, wt: await ws.addWorktree(task.id, base) })
        }
      } catch (err) {
        createFailed = true
        const message = err instanceof Error ? err.message : String(err)
        // 이미 만든 worktree 를 전부 정리(누수 0). 정리 실패는 다음 작업 정리를 막지 않게 흡수.
        for (const { task } of wts) {
          await ws.removeWorktree(task.id).catch(() => {})
          const idx = pending.indexOf(task.id)
          if (idx >= 0) pending.splice(idx, 1)
        }
        // 정리한(생성 성공했던) 작업들은 아직 실행 안 됐으므로 pending 으로 되돌린다 — 다음 sweep 재시도.
        for (const { task } of wts) pending.push(task.id)
        // 생성에 실패한 작업(batch 에서 wts 에 안 들어간 첫 작업)을 failed 처리해 무한 재시도를 막는다.
        const failedTask = batch.find((t) => !wts.some((w) => w.task.id === t.id))
        if (failedTask) {
          store.updateTask(failedTask.id, {
            status: 'failed',
            output: `worktree 생성 실패: ${message}`,
          })
          emit({
            type: 'task.failed',
            message: `${failedTask.title}: worktree 생성 실패 - ${message}`,
            data: { taskId: failedTask.id },
          })
          failed.add(failedTask.id)
          const idx = pending.indexOf(failedTask.id)
          if (idx >= 0) pending.splice(idx, 1)
        }
      }
      if (createFailed) continue // 이번 배치 통합/편집 스킵 — 다음 sweep 으로
      // 3) 편집 병렬(작업별 독립 worktree·세션). 실패는 allSettled 로 격리.
      //    각 fulfilled value = keep 해시(done) 또는 undefined(실패/스킵/미승인/취소).
      const settled = await Promise.allSettled(
        // (P1 #1) 편집 cwd = wt.path — 편집이 작업별 worktree 안에서 일어나 격리가 성립한다.
        wts.map(({ task, wt }) => runTaskIn(task, wt, makeEditSession(), wt.path)),
      )
      // 4) 생성순 통합(결정론) + 정리(순차). 충돌·취소여도 worktree 는 반드시 정리한다.
      for (let k = 0; k < wts.length; k++) {
        const { task } = wts[k]
        const r = settled[k]
        // (P2 #5) runTaskIn 의 try/catch 밖(예: ws.checkpoint)에서 reject 하면 allSettled 가 rejected 다.
        //   이 경우 task 가 running 인 채 남으므로 failed 처리한다(실패 이벤트 없이 영구 running 방지).
        //   취소(abort) 중 reject 는 취소로 라벨한다(다른 abort 경로와 일관).
        if (r.status === 'rejected') {
          if (!done.has(task.id) && !failed.has(task.id)) {
            if (opts.signal?.aborted) {
              store.updateTask(task.id, { status: 'skipped', output: '실행 취소됨' })
              emit({
                type: 'task.skipped',
                message: `${task.title}: 실행 취소됨`,
                data: { taskId: task.id },
              })
            } else {
              const message = r.reason instanceof Error ? r.reason.message : String(r.reason)
              store.updateTask(task.id, { status: 'failed', output: `실행 오류: ${message}` })
              emit({
                type: 'task.failed',
                message: `${task.title}: 실행 오류 - ${message}`,
                data: { taskId: task.id },
              })
              failed.add(task.id)
            }
          }
          // 정리 실패를 흡수 — P2#3 생성-실패 catch 블록과 parity. sweep/배치 흐름을 끊지 않는다.
          await ws.removeWorktree(task.id).catch(() => {})
          const idxR = pending.indexOf(task.id)
          if (idxR >= 0) pending.splice(idxR, 1)
          continue
        }
        const keepHash = r.value
        // (P1 #2) 변경 없는(원래-빈) worktree 는 통합을 스킵한다 — 구버전 git 에서 빈 cherry-pick 이
        //   `unknown option`/empty-stop 으로 깨지지 않도록 사전 방어. runTaskIn 이 store 에 기록한
        //   changedFiles 로 판정한다(변경 0 → 통합 불필요, 작업은 이미 done 으로 정직).
        const changed = store.getTask(task.id)?.changedFiles ?? []
        if (done.has(task.id) && keepHash && opts.signal?.aborted) {
          // (P2 #4) abort 로 통합을 스킵한다. runTaskIn 이 이미 done 으로 갱신했지만 cherry-pick 은
          //   수행되지 않았으므로(main 미반영) done 을 철회하고 skipped 로 다운그레이드한다(오해 방지).
          done.delete(task.id)
          store.updateTask(task.id, { status: 'skipped', output: '실행 취소됨(통합 전)' })
          emit({
            type: 'task.skipped',
            message: `${task.title}: 실행 취소됨(통합 전)`,
            data: { taskId: task.id },
          })
        } else if (done.has(task.id) && keepHash && changed.length > 0) {
          // done 표시 + keep 해시 보유 + 변경 있음 + abort 아님 → 통합.
          const res = await ws.integrate(keepHash)
          if (!res.ok) {
            // 통합 충돌 → done 철회·failed 전환(결정론적 작업 상태 계약).
            done.delete(task.id)
            failed.add(task.id)
            store.updateTask(task.id, {
              status: 'failed',
              output: `통합 충돌: ${res.conflict ?? ''}`,
            })
            emit({
              type: 'task.failed',
              message: `${task.title}: 통합 충돌`,
              data: { taskId: task.id },
            })
          }
        }
        // 정리(순차) — 충돌·취소·실패여도 worktree 잔존 0 보장. 정리 실패는 흡수(P2#3 parity).
        await ws.removeWorktree(task.id).catch(() => {})
        const idx = pending.indexOf(task.id)
        if (idx >= 0) pending.splice(idx, 1)
      }
    }
    // abort/잔여(순환 의존 등)는 아래 공용 cleanup 으로 흘려보낸다.
  }

  let progressed = true
  let aborted = false
  while (!canParallel && pending.length > 0 && progressed && !aborted) {
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
        emit({
          type: 'task.skipped',
          message: `${task.title}: 의존 작업 실패로 건너뜀`,
          data: { taskId: task.id },
        })
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
      emit({
        type: 'task.failed',
        message: `${task.title}: 의존성 해소 불가(순환 가능)`,
        data: { taskId: id },
      })
    }
  }

  // ── 3) 최종 요약 / 누락 점검 ── (취소 시 생략)
  // closure 로 둔다 — replan 이 작업을 append 하면(아래 6) 최종 작업 목록으로 한 번 더 갱신한다.
  let summary = ''
  const summarizer = sessionForRole('summarizer', 'reviewer')
  const summarize = async (): Promise<void> => {
    if (!summarizer || opts.signal?.aborted) return
    try {
      const finalTasks = store.listTasks(project.id)
      summary = await summarizer.send(buildSummaryPrompt(goal, finalTasks), {
        fresh: true,
        signal: opts.signal,
        bypassTools: true,
      })
      emit({ type: 'summary', message: '최종 요약 완료', data: { projectId: project.id } })
    } catch (err) {
      // 요약 실패가 완료된 작업 결과를 무효화하지 않도록 격리한다(summary 는 빈 문자열로 둔다).
      emit({
        type: 'summary',
        message: `요약 실패: ${err instanceof Error ? err.message : String(err)}`,
        data: { projectId: project.id },
      })
    }
  }
  await summarize()
  // replan 이 보정 작업을 append 했는지 추적 — 했다면 아래 6 에서 요약을 갱신한다.
  let replanAppended = false

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
        message: ok
          ? '검증 통과'
          : `검증 실패: ${v
              .filter((r) => !r.passed)
              .map((r) => r.kind)
              .join(', ')}`,
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
      emit({
        type: 'verify.fixing',
        message: `검증 실패 — 수정 시도 (라운드 ${round})`,
        data: { projectId: project.id, round },
      })
      const base = await opts.workspace.checkpoint()
      // captureIgnoredBaseline 실패(민감 파일 백업 불가) = 이번 라운드 중단.
      let vfBaseline: IgnoredBaseline | undefined
      try {
        vfBaseline = await opts.workspace.captureIgnoredBaseline()
      } catch (err) {
        emit({
          type: 'verify.fixing',
          message: `민감 ignored 백업 실패로 수정 중단: ${err instanceof Error ? err.message : String(err)}`,
          data: { projectId: project.id, round },
        })
        break
      }
      try {
        await fixImplementer.send(buildVerifyFixPrompt(goal, failing), {
          fresh: true,
          workspace: opts.workspaceRoot,
          signal: opts.signal,
          timeoutMs: taskTimeoutMs,
        })
        // 작업 경로와 동일하게 verify-fix diff 도 위험 분류·승인 게이트를 거친다.
        const diff = await opts.workspace.collectDiff(base)
        const ignoredChanges = await opts.workspace.collectIgnoredChanges(vfBaseline)
        if (ignoredChanges.changes.length > 0 || ignoredChanges.unrestorable.length > 0) {
          // P2-5: data 에 projectId 를 명시한다 — runTaskIn 경로와 동일하게 listProjectEvents 필터를 통과하도록.
          store.appendEvent({
            type: 'workspace.ignored_changes',
            data: {
              projectId,
              round,
              changes: ignoredChanges.changes.map((c) => ({
                path: c.path,
                change: c.change,
                sensitive: c.sensitive,
              })),
              unrestorable: ignoredChanges.unrestorable.map((u) => u.path),
            },
          })
        }
        const dr = classifyDiffRisk(diff, ignoredChanges)
        if (dr.risk === 'destructive') {
          // P2-1: ignored-only destructive 시 diff.files 가 비어 gate target 이 공백이 되지 않도록
          // sanitized reasons 를 포함한다(경로·종류만, 내용 없음).
          const trackedTarget = diff.files.join(', ')
          const vfGateTarget =
            trackedTarget.length > 0
              ? trackedTarget
              : dr.reasons.filter((r) => !r.startsWith('복원 불가')).join('; ') ||
                dr.reasons.join('; ')
          const decision = opts.gate
            ? await opts.gate.request({
                kind: 'apply-diff',
                summary: `verify-fix r${round} 변경 적용`,
                target: vfGateTarget,
                risk: 'destructive',
              })
            : 'rejected'
          if (decision !== 'approved') {
            const note = await rollbackWithIgnored(opts.workspace, base, vfBaseline ?? null)
            emit({
              type: 'verify.fixing',
              message: `수정 위험 변경 미승인: ${dr.reasons.join('; ')}${note}`,
              data: { projectId: project.id, round },
            })
            break
          }
        }
        await opts.workspace.keep(`[verify-fix r${round}]`)
      } catch (err) {
        // 부분 수정을 되돌린다. revert 실패는 무성흡수하지 않고 수정 실패 메시지에 덧붙여 표면화한다(#7).
        const revertNote = await rollbackWithIgnored(opts.workspace, base, vfBaseline ?? null)
        emit({
          type: 'verify.fixing',
          message: `수정 실패: ${err instanceof Error ? err.message : String(err)}${revertNote}`,
          data: { projectId: project.id, round },
        })
        break
      } finally {
        if (vfBaseline) disposeBaseline(vfBaseline)
      }
      verifications = await verifyOnce()
      emitVerify(verifications)
    }

    // ── 5) (옵션) append-only 보정 replan ──
    // verify-fix 가 소진된 뒤에도 검증이 실패하면, planner 에게 검증 실패를 되먹여 '보정 작업'을
    // 받아 store 에 append(기존 작업 불변)하고 기존 runTask 로 순차 실행한 뒤 재검증한다.
    // 최대 maxReplanRounds 회(기본 0=비활성). planner 가 빈 목록을 주면 조기 종료(결정론).
    // 워크스페이스/CLI implementer 없거나 취소되면 생략(verify-fix 루프와 동일 가드).
    // verifyOnce 가 예외로 빈 배열을 돌려주면 .some()=false → 진입 없음(정보 없는 보정 불가, 의도된 동작).
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
        emit({
          type: 'replan',
          message: '보정 작업 없음 — replan 종료',
          data: { projectId: project.id, round, count: 0 },
        })
        break
      }
      emit({
        type: 'replan',
        message: `보정 작업 ${corrective.length}개 추가 (라운드 ${round})`,
        data: { projectId: project.id, round, count: corrective.length },
      })
      replanAppended = true
      // append-only: 보정 작업은 의존성 없는 평면 목록 → store 에 추가하고 순차 실행(위상 sweep 불필요).
      for (const ct of corrective) {
        if (opts.signal?.aborted) break
        const created = store.createTask({
          projectId: project.id,
          title: ct.title,
          description: ct.description,
          role: ct.role ?? 'implementer', // 표시용 라벨 — runTask 는 task.role 무시하고 항상 implementer 로 실행
        })
        await runTask(created)
      }
      // 보정 작업 실행 중 취소되면 재검증을 건너뛴다(abort 계약: 취소 시 verify 생략 — verify-fix catch-break 와 대칭).
      if (opts.signal?.aborted) break
      verifications = await verifyOnce()
      emitVerify(verifications)
    }
  }

  // ── 6) 보정 replan 후 요약 갱신 ── replan 이 작업을 추가했으면 최종 작업 목록으로 요약을 다시 만든다
  // (섹션 3 요약은 보정 작업 생성 전이라 누락된다). 취소 시 생략.
  if (replanAppended && !opts.signal?.aborted) await summarize()

  // 취소되면 검증·요약을 건너뛰었으므로 무조건 failed 로 종료한다(misleading done 방지).
  // run.cancelled 는 engine 이 별도로 방출하므로 오케스트레이터는 일을 멈추기만 하면 된다.
  const signalAborted = opts.signal?.aborted === true
  const verifyFailed =
    !!opts.verify &&
    !(
      verifications !== undefined &&
      verifications.length > 0 &&
      verifications.every((v) => v.passed)
    )
  store.updateProject(project.id, { status: signalAborted || verifyFailed ? 'failed' : 'done' })
  // project.done 메시지는 실제 종료 상태를 반영한다 — 취소/검증 실패를 항상 '완료'로 위장하지 않는다(#7).
  // 이벤트 타입('project.done')·data.projectId 는 불변 — engine 의 activeRuns 정리(타입 기반)와 렌더러
  // running 잠금 해제(타입 기반)가 여기에 의존하므로 메시지 텍스트만 정확화한다.
  const doneMessage = signalAborted
    ? `프로젝트 취소됨: ${project.title}`
    : verifyFailed
      ? `프로젝트 실패: ${project.title}`
      : `프로젝트 완료: ${project.title}`
  emit({ type: 'project.done', message: doneMessage, data: { projectId: project.id } })

  return { projectId: project.id, tasks: store.listTasks(project.id), summary, verifications }
}

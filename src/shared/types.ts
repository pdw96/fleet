/**
 * 단일 진실 원천 타입 — main / preload / renderer 가 공유한다.
 * 런타임/DOM/Node 의존이 없는 순수 타입 선언만 둔다.
 */

// ── 앱 메타 ────────────────────────────────────────────────────────────────
export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
  /**
   * 실행 런타임(#197 B2). 데스크톱 Electron main 은 'electron', 컨테이너 fleet-server(B3)는 'web'.
   * renderer 가 Electron 전용 표면(자동 업데이트 배너·footer)을 게이팅하는 단일 판별값(B4).
   */
  runtime: 'electron' | 'web'
}

// ── LLM 연결 ────────────────────────────────────────────────────────────────
/** 구독(CLI) 어댑터 식별자 — picker·외부열기 IPC·registry 공용 단일 출처. */
export type CliAdapterId = 'claude' | 'codex' | 'gemini'
export type LlmConnectionKind = 'cli' | 'api'

/**
 * 헤드리스 stdout 정제 전략.
 * - 'text'        : 트림만 (기본). claude `-p`, gemini `-p` 처럼 응답만 출력하는 CLI.
 * - 'codex-jsonl' : codex `exec --json` 의 JSONL 이벤트에서 최종 agent_message 만 추출.
 */
export type CliOutputFormat = 'text' | 'codex-jsonl'

/**
 * 스테이트풀 세션의 id 획득 전략.
 * - 'preassigned'  : 우리가 UUID 를 생성해 startArgs/resumeArgs 에 주입(추출 불필요). claude/gemini.
 * - 'codex-thread' : 첫 응답 JSONL 의 `thread.started` 이벤트에서 thread_id 를 추출. codex.
 */
export type SessionIdSource = 'preassigned' | 'codex-thread'

/**
 * CLI 자체 세션 재개로 프로세스 간 대화 맥락을 유지하는 사양('길 A').
 * 미지정 어댑터는 헤드리스 1회 실행(stateless)만 지원한다.
 */
export interface CliSessionSpec {
  /** 새 세션 첫 호출 인자. '{prompt}','{sessionId}' 토큰이 치환된다. */
  startArgs: string[]
  /** 세션 재개 후속 호출 인자. '{prompt}','{sessionId}' 토큰이 치환된다. */
  resumeArgs: string[]
  idSource: SessionIdSource
}

/**
 * 스트림 라인 → 텍스트 델타 추출 전략(실측 확정).
 * - 'claude-stream' : `{type:'stream_event', event.delta:{type:'text_delta', text}}` 의 text.
 * - 'gemini-stream' : `{type:'message', role:'assistant', delta:true, content}` 의 content.
 * - 'codex-jsonl'   : `{type:'item.completed', item:{type:'agent_message', text}}` 의 text(이벤트 단위).
 */
export type StreamParseFormat = 'claude-stream' | 'gemini-stream' | 'codex-jsonl'

/** 토큰/이벤트 스트리밍 사양('길 A' 2단계). onChunk 가 주어질 때만 활성화된다. */
export interface CliStreamSpec {
  /** 스트리밍 활성 추가 인자(base 인자 뒤에 덧붙는다). codex 는 base 에 --json 이 이미 있어 []. */
  args: string[]
  parse: StreamParseFormat
}

/** 등록 가능한 CLI 어댑터 (요구사항 2A). 새 CLI 는 이 형태로 레지스트리에 추가. */
export interface CliAdapter {
  id: string
  displayName: string
  /** 실행 명령 (예: 'claude') */
  command: string
  /** 버전 확인 인자 (예: ['--version']) */
  versionArgs: string[]
  /**
   * 모델 지정 플래그 (예: '--model'). descriptor.model 이 비어있지 않으면 모든 실행 인자 끝에
   * `[modelFlag, model]` 이 덧붙는다. 미지정이거나 model 이 빈 값이면 생략(CLI 기본 모델 사용).
   */
  modelFlag?: string
  /**
   * MCP 설정 패스스루 플래그 (예: claude '--mcp-config'). descriptor.mcpConfig(경로 또는 인라인 JSON)
   * 가 있으면 `[mcpConfigFlag, mcpConfig]` 이 덧붙는다. CLI 마다 메커니즘이 달라(claude 만 플래그;
   * codex 는 ~/.codex/config.toml [mcp_servers], gemini 는 .gemini/settings.json mcpServers)
   * 플래그가 없는 어댑터는 mcpConfig 를 무시한다.
   * ⚠ CliAdapter 는 IPC 로 직렬화되므로 함수가 아닌 데이터 필드만 둔다.
   */
  mcpConfigFlag?: string
  /** mcpConfig 전달 시 함께 붙일 격리 플래그(예: claude '--strict-mcp-config'). 미지정이면 생략. */
  mcpStrictArg?: string
  /** TUI 세션 spawn 시 인자 (없으면 대화형 기본 실행) */
  spawnArgs?: string[]
  /**
   * 프롬프트 전달 경로.
   * - 'arg'(기본/미지정): 프롬프트를 인자 템플릿의 '{prompt}' 토큰에 치환해 argv 로 전달.
   * - 'stdin': 프롬프트를 자식 stdin 으로 전달. 인자 템플릿에는 '{prompt}' 토큰을 두지 않는다
   *   (긴 프롬프트를 argv 로 넘기면 Windows 명령줄 길이 한도에 걸린다 — 특히 npm .cmd 셰임은
   *   cmd.exe 경유라 ~8191자, 네이티브 exe 도 ~32767자. stdin 은 한도가 없다).
   */
  promptVia?: 'arg' | 'stdin'
  /**
   * 헤드리스(비대화형) 1회 실행 인자 템플릿. '{prompt}' 토큰이 프롬프트로 치환된다.
   * `parse` 로 stdout 정제 전략을 지정한다(미지정 시 'text' = 트림만).
   */
  headless?: { args: string[]; parse?: CliOutputFormat }
  /**
   * 스테이트풀 세션 재개 사양('길 A'). 존재해도 기본은 stateless 이며,
   * createCliSession 의 `stateful` 옵션이 켜질 때만 활성화된다. stdout 정제는
   * headless.parse 를 재사용한다(codex 는 'codex-jsonl', claude/gemini 는 'text').
   */
  session?: CliSessionSpec
  /** 토큰/이벤트 스트리밍 사양('길 A' 2단계). 미지정 시 버퍼링(최종 1회). */
  streaming?: CliStreamSpec
  /**
   * 편집 에이전트 1회 실행 인자 템플릿. '{prompt}'·'{workspace}' 토큰이 치환된다.
   * 존재하면 send({workspace}) 호출이 이 인자로 cwd=workspace 에서 에이전트를 실행해
   * 워크스페이스 파일을 직접 편집한다. 미지정 어댑터는 implementer 역할에 쓸 수 없다.
   */
  edit?: { args: string[]; parse?: CliOutputFormat }
  /** 구독 로그인 안내용 정적 데이터(표시·복사 전용 — Fleet 이 실행하지 않음). shared 단일출처 주입. */
  auth?: { loginCommand: string; docsUrl: string }
  /** 미설치 시 설치 안내용 정적 데이터(표시·복사 전용). shared 단일출처 주입. */
  install?: { hint: string; docsUrl: string }
}

/** CLI 감지 결과 — IPC 로 renderer 에 전달. */
export interface CliDetectionResult {
  id: string
  displayName: string
  command: string
  kind: 'cli'
  installed: boolean
  version?: string
  /** 원본 --version 출력 */
  raw?: string
  error?: string
  /** which 해석된 실제 실행 경로(보통 절대; 상대 PATH 해석 시 비절대 — pathShadowRisk 참조). 미설치/미해석 시 undefined. 표시 전용. */
  resolvedPath?: string
  /** resolvedPath 가 비절대(상대/CWD PATH 엔트리)로 해석된 경우 true — 상대 PATH shadow 위험(main 에서 path.isAbsolute 판정). */
  pathShadowRisk?: boolean
}

// CLI 세션 "연결 테스트" probe 결과(#150). transient — 저장하지 않는다.
export type ProbeStatus = 'ok' | 'auth' | 'error' | 'timeout'
export interface ProbeResult {
  status: ProbeStatus
  /** status==='auth' — classifyCliAuthHint 결과(advisory). */
  hint?: string
  /** status==='error' — sanitize 된 stderr/stdout(또는 spawnError). */
  detail?: string
}

// ── MCP 호스트 (Track 2) ────────────────────────────────────────────────────
/** 등록할 MCP 서버 사양(stdio JSON-RPC). 도구 이름은 mcp__<name>__<tool> 로 프리픽스된다. */
export interface McpServerSpec {
  /** 고유 서버 식별자(도구 이름 프리픽스에 사용). */
  name: string
  command: string
  args?: string[]
  /** process.env 위에 병합할 환경변수. */
  env?: Record<string, string>
  cwd?: string
}

/** MCP 서버 연결 상태(IPC 로 렌더러에 전달). */
export interface McpServerStatus {
  name: string
  connected: boolean
  /** 노출된(프리픽스된) 도구 수. */
  toolCount: number
  /** 노출된 도구 이름(프리픽스 포함). */
  tools: string[]
  /** 연결 실패/오류 메시지(있으면). */
  error?: string
}

/**
 * 모델 reasoning(extended thinking) 깊이. provider-중립 명목 집합 — Anthropic 은 output_config.effort,
 * OpenAI 는 reasoning_effort 로 매핑(Gemini 는 후속). 상위 티어(xhigh, max)는 모델별 가용성이 달라
 * 각 provider 가 모델-인지 정규화(미지원 티어 하향/생략)를 책임진다 — max 는 OpenAI 무효값이라 모델
 * 최상위 티어(xhigh/high)로 매핑된다.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 프롬프트 캐시 TTL. Anthropic cache_control.ttl 매핑('1h'=extended-cache-ttl 베타). 미지정/기본=5m. #72. */
export type CacheTtl = '5m' | '1h'

/** API provider 설정 (요구사항 2B). */
export interface ApiProviderConfig {
  id: string
  provider: 'anthropic' | 'openai' | 'google' | 'openai-compatible'
  displayName: string
  model: string
  apiKey?: string
  /** OpenAI 호환 엔드포인트 베이스 URL(예: https://openrouter.ai/api/v1). provider==='openai-compatible' 일 때 필수, 그 외 무시. */
  baseUrl?: string
  temperature?: number
  maxTokens?: number
  /**
   * 모델 reasoning(extended thinking) 세션 기본값. 지정 시 이 세션의 모든 호출에 적용된다
   * (per-call ApiCallOptions.thinking 이 우선). 미지정=off. Anthropic·OpenAI 매핑(Gemini 후속).
   */
  thinking?: { effort?: ReasoningEffort }
  /**
   * 프롬프트 캐시 TTL 세션 기본값(Anthropic 한정). '1h' 면 재사용 프리픽스 cache_control 에 ttl:'1h' +
   * extended-cache-ttl 베타를 싣는다(per-call ApiCallOptions.cacheTtl 우선). 미지정=5m(현행). #72.
   */
  cacheTtl?: CacheTtl
}

/**
 * provider 모델 목록 API 로 라이브 조회한 모델 항목. id=모델 식별자(세션에 제출하는 값),
 * label=표시명(없으면 id 를 표시). 하드코딩 PROVIDER_DEFAULTS 표류 제거용 — 실패 시 폴백. #13
 */
export interface ModelOption {
  id: string
  label?: string
}

/** 등록된 LLM 디스크립터 (CLI 또는 API 통합). */
export interface LlmDescriptor {
  id: string
  kind: LlmConnectionKind
  displayName: string
  /** kind==='cli' → CliAdapter.id, kind==='api' → ApiProviderConfig.id */
  ref: string
  model?: string
  /** CLI 세션이 맥락 유지(세션 재개) 모드로 등록되었는지. */
  stateful?: boolean
  /** CLI 세션에 전달할 MCP 설정(파일 경로 또는 인라인 JSON). adapter.mcpConfigFlag 가 있을 때만 적용. */
  mcpConfig?: string
  /** 이 LLM 이 잘하는 역할들 (capability-scored 배정 정책의 선호 근거). 세션 수명 동안 유지. */
  capabilities?: AgentRole[]
}

// ── 채팅 / 메시지 (요구사항 3) ────────────────────────────────────────────
export type ChatAuthor = { type: 'user' } | { type: 'system' } | { type: 'llm'; llmId: string }

export interface ChatMessage {
  id: string
  roomId: string
  author: ChatAuthor
  /** 발화 시의 역할(있으면) */
  role?: AgentRole
  content: string
  /** epoch ms */
  ts: number
}

export interface ChatRoom {
  id: string
  title: string
  /** 참여 LLM id 목록 */
  participants: string[]
  createdAt: number
}

// ── 오케스트레이션 (요구사항 4,5) ──────────────────────────────────────────
export type AgentRole =
  'planner' | 'architect' | 'implementer' | 'reviewer' | 'tester' | 'critic' | 'summarizer'

export interface RoleAssignment {
  role: AgentRole
  llmId: string
}

export type AssignmentPolicy = 'manual' | 'round-robin' | 'capability-scored'

/** 오케스트레이터가 실제로 배정·실행하는 역할 집합 (요구사항 8 MVP). 배정 UI·채점도 이 집합으로 제한한다. */
export const ASSIGNABLE_ROLES: readonly AgentRole[] = [
  'planner',
  'implementer',
  'reviewer',
  'summarizer',
]

export type TaskStatus = 'pending' | 'running' | 'review' | 'done' | 'failed' | 'skipped'

export interface Task {
  id: string
  projectId: string
  title: string
  description: string
  status: TaskStatus
  /** 담당 역할 */
  role?: AgentRole
  /** 배정된 LLM */
  assignedLlmId?: string
  /** 의존 작업 id */
  dependsOn: string[]
  /** 산출물 요약 */
  output?: string
  /** keep 직전 변경된 파일 목록(diff 기반). */
  changedFiles?: string[]
  /** 작업 전 체크포인트 커밋 해시. */
  checkpoint?: string
  createdAt: number
  updatedAt: number
}

export interface Project {
  id: string
  goal: string
  title: string
  status: 'planning' | 'executing' | 'verifying' | 'done' | 'partial' | 'failed'
  createdAt: number
  updatedAt: number
}

// ── 검증 (요구사항 5) ──────────────────────────────────────────────────────
export type VerifyKind = 'test' | 'lint' | 'typecheck' | 'smoke' | 'custom'

export interface VerificationResult {
  kind: VerifyKind
  command: string
  passed: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** 실패 원인 분석(선택) */
  analysis?: string
  durationMs: number
  /** verify 스크립트가 자명한 no-op(exit 0 류)이라 실제 검사를 안 했음 (있을 때만). */
  noop?: boolean
}

// ── 안전 (요구사항 6) ──────────────────────────────────────────────────────
export type RiskLevel = 'safe' | 'caution' | 'destructive'

export interface ApprovalRequest {
  id: string
  kind: 'file-write' | 'file-delete' | 'shell' | 'apply-diff' | 'tool-call'
  summary: string
  /** 대상 경로 또는 명령 */
  target: string
  risk: RiskLevel
  ts: number
  /**
   * 서버 권위 자동거부 시각(ms epoch) = ts + ttlMs (#216 C1). 렌더러 카운트다운·approver 만료
   * 타이머의 단일 출처(카운트다운=실제 만료 불일치 원천 차단). gate 가 요청 생성 시 스탬프한다.
   */
  expiresAt: number
}

export type ApprovalDecision = 'approved' | 'rejected'

/**
 * approver 결정 + (거부 시) 감사 사유(#216 C1). approver 는 boolean 대신 이 결과를 반환하고, 감사는
 * gate 가 단일 책임으로 `approval.decided` 에 실어(reason 배관). abort/만료/거부는 예외가 아니라
 * `{approved:false}` 로 해소한다(예외 기반 rejection 은 비계약 — §C-3·§C-5).
 */
export type ApprovalOutcome = { approved: boolean; reason?: string }

/** destructive 승인 무응답 시 자동 거부까지의 시간(메인 측 권위 + 렌더러 카운트다운 공용). */
export const APPROVAL_TIMEOUT_MS = 60_000

/**
 * 동시 대기(pending) 승인 상한(#216 C1). approver enqueue 시 `pending.size >= max` 면 즉시 거부 +
 * 감사(reason:'pending-cap'). 공격자 다량 tool-call 로부터 메모리·UI 카드 무한 적재 차단.
 */
export const APPROVAL_MAX_PENDING = 64

// ── 감사 로그 (요구사항 6) ────────────────────────────────────────────────
export interface FleetEvent {
  id: string
  /**
   * store 가 append 시 단조 증가로 스탬프하는 시퀀스(재접속 이벤트 커서용 · #197 B1). 1부터 시작하고
   * rotation(#126) 폐기에도 후퇴하지 않는다. 구파일(pre-B1)엔 부재 → 로드 시 백필하므로 store 가
   * 반환하는 이벤트는 항상 보유한다. 옵셔널은 오직 디스크 전방호환(구파일 로드 순간)을 위한 것.
   */
  seq?: number
  type: string
  /** 사람이 읽는 진행 메시지(오케스트레이터 이벤트 재생용, 감사 이벤트엔 없을 수 있음). */
  message?: string
  /** 자유 형식 payload */
  data: Record<string, unknown>
  ts: number
}

// ── 오케스트레이션 결과 / 이벤트 (IPC 계약 표면) ─────────────────────────────
export interface RunResult {
  projectId: string
  tasks: Task[]
  summary: string
  /** 검증 단계가 실행된 경우의 결과(요구사항 5). 미실행이면 undefined. */
  verifications?: VerificationResult[]
}

export type OrchestratorEventType =
  | 'project.created'
  | 'plan.created'
  | 'plan.failed'
  | 'task.started'
  | 'task.implemented'
  | 'task.review'
  | 'task.done'
  | 'task.failed'
  | 'task.progress'
  | 'task.skipped'
  // 리뷰 미승인이나 마지막 시도를 경고와 함께 채택(#162) — cascade 실패 대신 진행. data: {taskId, round, feedback}.
  | 'task.accepted_with_warnings'
  | 'run.cancelled'
  | 'verify.passed'
  | 'verify.failed'
  | 'verify.fixing'
  | 'replan'
  | 'summary'
  | 'project.done'
  // 워크스페이스 무결성 감사(#123-A/#128) — store 영속 + 라이브 표면화. 경로·종류만, 내용·hash 비노출.
  | 'workspace.ignored_changes'
  | 'workspace.ignored_discarded'

export interface OrchestratorEvent {
  type: OrchestratorEventType
  message: string
  data?: Record<string, unknown>
  /**
   * 영속 이벤트의 store seq(#197 B1). emit 이 영속 성공 후 라이브 방출 이벤트에 스탬프 —
   * 재접속 시 렌더러가 커서를 갱신하는 데 쓴다. 비영속 task.progress(토큰 델타)엔 부재
   * (재접속 재생 불가 = 명시적 비범위 · RunActivity 스냅숏이 상태 권위).
   */
  seq?: number
}

/**
 * 보정 재계획(replan) 라운드 상한 — UI 셀렉트의 지원 범위(0..MAX)이자 engine 신뢰 경계의 안전 상한.
 * 렌더러가 보낸 값은 main 기준 신뢰 경계를 넘어오므로(devtools/커스텀 렌더러가 UI 우회 가능) engine 이
 * 이 값으로 클램프해, 검증이 계속 실패하는 한 무한정 planner/구현/검증 사이클이 도는 runaway 를 막는다.
 */
export const MAX_REPLAN_ROUNDS = 3

/**
 * 한 프로젝트 내 독립 작업의 최대 동시 실행 수. 1=순차(기본·무회귀). engine 경계에서 [1,MAX_CONCURRENCY] 정수 clamp.
 */
export const MAX_CONCURRENCY = 4

export interface RunProjectRequest {
  goal: string
  policy?: AssignmentPolicy
  /** manual 정책용 사용자 지정 역할↔LLM 배정. 지정 시 policy 보다 우선한다. */
  assignments?: RoleAssignment[]
  maxReviewRounds?: number
  /** 검증 실패가 verify-fix 로도 안 풀릴 때, planner 가 보정 작업을 분해→append→실행→재검증하는 최대 라운드. 0/미지정=비활성. */
  maxReplanRounds?: number
  /** 의존성 없는 독립 작업의 최대 동시 실행 수(기본 1=순차). engine 이 [1,MAX_CONCURRENCY] 정수로 보정. */
  maxConcurrency?: number
  taskTimeoutMs?: number
  /** (예약) 향후 false면 첫 실패 시 후속 작업 중단 예정. 현재는 미배선 — 항상 부분 진행한다. */
  continueOnFailure?: boolean
}

// ── 채팅 토큰 스트리밍 (IPC 이벤트 채널) ─────────────────────────────────────
/**
 * LLM 응답을 토큰 단위로 렌더러에 흘리는 이벤트(메인 → 렌더러 브로드캐스트).
 * 최종 ChatMessage.id 는 store 영속 시점에야 정해지므로, in-flight 응답은
 * 메인이 발급한 `streamId` 로 식별한다. 한 발언(askLlm 1회)이 한 streamId 다.
 *
 *  - start : 발언 시작. 렌더러는 빈 말풍선(작성자/역할 표시)을 즉시 띄운다.
 *  - delta : 토큰/이벤트 증분 텍스트. 누적해 말풍선에 이어 붙인다. `seq`(streamId 별 1부터
 *            증가)로 멱등 적용·하이드레이션 레이스 정렬을 보장한다(스냅샷 seq 보다 큰 델타만 적용).
 *  - end   : 발언 완료. 영속된 최종 메시지를 싣는다(스트리밍 말풍선 → 확정 메시지로 교체).
 *  - error : 발언 실패. 렌더러는 말풍선을 에러 표시로 바꾸거나 제거한다.
 *  - busy  : 방에서 ask/discuss 연산이 시작됨(첫 연산 경계). 렌더러는 진행 표시를 켠다.
 *  - idle  : 방의 마지막 연산이 끝남(연산 경계). 렌더러는 진행 표시를 끈다.
 *
 * start/delta/end/error 는 한 발언(streamId)에 매인 스트림 이벤트, busy/idle 은 방(roomId)
 * 단위 진행 경계 이벤트다. 모든 변형에 roomId 를 실어 렌더러가 활성 방이 아닌 이벤트를 쉽게 거른다.
 * busy/idle 의 권위 소스는 main 이며(getChatActivity), 탭 언마운트로 렌더러가 이벤트를 놓쳐도
 * 재마운트 시 스냅샷 재조회로 메운다. 비스트리밍 세션은 delta 가 최종 텍스트 1회로 도착한다.
 */
/**
 * 도구 실행 단계(라이브 진행 관측용 — 대화 기록이 아니라 in-flight 표시 전용). 한 발언(streamId)
 * 안에서 텍스트 델타와 interleave 되어 흐른다. id 로 칩을 in-place 갱신한다(running → ok/error).
 */
export interface ToolStep {
  /** tool_use id(없으면 도구명 기반 합성). 칩 식별자. */
  id: string
  name: string
  /** running: 실행 시작 · ok: 성공 · error: 실패/거부/미존재. */
  phase: 'running' | 'ok' | 'error'
  risk?: RiskLevel
  /** 인자 요약(running 시) 또는 짧은 오류 요지(error 시). */
  summary?: string
}

/**
 * 자동 업데이트 상태/이벤트 (main → 렌더러). main(currentState)이 권위 스냅샷이며
 * 렌더러는 onUpdateEvent 구독 + getUpdateState 하이드레이트로 동기화한다.
 * idle/checking/not-available/unsupported → 배너 미표시.
 */
export type UpdateEvent =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }

/**
 * 자동 업데이트 채널(#98). stable=안정 릴리스만, beta=프리릴리스(allowPrerelease) 포함.
 * 기본 stable — 베타는 사용자 opt-in. 미설정 구버전 store 파일은 stable 로 해석.
 */
export type UpdaterChannel = 'stable' | 'beta'

export type ChatStreamEvent =
  | { kind: 'start'; streamId: string; roomId: string; llmId: string; role?: AgentRole }
  | { kind: 'delta'; streamId: string; roomId: string; delta: string; seq: number }
  | { kind: 'tool'; streamId: string; roomId: string; step: ToolStep; seq: number }
  | { kind: 'end'; streamId: string; roomId: string; message: ChatMessage }
  | { kind: 'error'; streamId: string; roomId: string; message: string }
  | { kind: 'busy'; roomId: string }
  | { kind: 'idle'; roomId: string }

/** main 이 보유한 in-flight 스트림 스냅샷(렌더러 재마운트 catch-up 용). */
export interface ActiveChatStream {
  streamId: string
  roomId: string
  llmId: string
  role?: AgentRole
  /** 지금까지 누적된 델타 텍스트. */
  text: string
  /** text·steps 에 반영된 마지막 이벤트 seq(델타·도구 단계 공유 카운터). 이보다 큰 것만 적용한다. */
  seq: number
  /** 지금까지 관측된 도구 단계들(id 로 in-place 갱신된 최신 상태). 재마운트 catch-up 용. */
  steps: ToolStep[]
}

/**
 * 채팅 진행 상태 스냅샷(단일 소스 오브 트루스). 렌더러가 ChatPanel 마운트 시 1회 조회해
 * 진행 표시(busyRooms)와 라이브 말풍선(streams)을 복원한다 — 탭 전환으로 컴포넌트가
 * 언마운트돼 로컬 state 가 날아가도 진행 상태가 살아남게 한다.
 */
export interface ChatActivity {
  /** 진행 중(ask/discuss)인 방 id 목록. */
  busyRooms: string[]
  /** 현재 타이핑 중인 라이브 스트림들. */
  streams: ActiveChatStream[]
}

/**
 * 프로젝트 실행 진행 상태 스냅샷(단일 소스 오브 트루스). 렌더러가 ProjectPanel 마운트 시 1회 조회해
 * 진행 표시(running 잠금·취소 버튼)를 복원한다 — 탭 전환으로 컴포넌트가 언마운트돼 로컬 state 가
 * 날아가도 진행 중 실행의 권위는 항상 main(activeRuns)에 있다. ChatActivity 와 동형이다.
 */
export interface RunActivity {
  /** 진행 중인 프로젝트 실행 id 목록. DESIGN.md 순차 전제상 0 또는 1건(동시 실행 가드). */
  activeProjectIds: string[]
}

// ── preload 가 노출하는 브리지 계약 ────────────────────────────────────────
export interface FleetBridge {
  getAppInfo(): Promise<AppInfo>

  // 세션 / CLI
  detectClis(): Promise<CliDetectionResult[]>
  listAdapters(): Promise<CliAdapter[]>
  registerCliSession(
    adapterId: string,
    opts?: { stateful?: boolean; model?: string; mcpConfig?: string },
  ): Promise<LlmDescriptor>
  registerApiSession(config: ApiProviderConfig): Promise<LlmDescriptor>
  listSessions(): Promise<LlmDescriptor[]>
  removeSession(id: string): Promise<void>
  /** 세션의 적합 역할(capabilities)을 설정한다. capability-scored 배정의 근거. */
  setSessionCapabilities(id: string, roles: AgentRole[]): Promise<LlmDescriptor>
  /** provider API 로 모델 목록을 라이브 조회한다. 미지원 provider 는 빈 배열, HTTP/인증 실패는 reject(렌더러가 사유 표시·입력은 하드코딩 폴백). #13 */
  listModels(config: ApiProviderConfig): Promise<ModelOption[]>
  /** picker 문서 링크 외부열기 — adapterId만 전달, main이 정적 docsUrl 도출·검증 후 shell.openExternal */
  openCliDocs(adapterId: CliAdapterId): Promise<void>
  /** CLI 세션 "연결 테스트"(#150) — adapterId만 전달, main이 probe 수행. 결과는 transient(비저장). */
  probeCli(adapterId: CliAdapterId): Promise<ProbeResult>

  // 프로젝트 / 오케스트레이션
  listProjects(): Promise<Project[]>
  getProjectTasks(projectId: string): Promise<Task[]>
  /** 프로젝트의 진행 이벤트(영속된 마일스톤)를 시간순 반환. task.progress 토큰 델타는 제외. */
  listProjectEvents(projectId: string): Promise<FleetEvent[]>
  /** 마지막으로 본 프로젝트 id 조회(없으면 null). */
  getLastActiveProject(): Promise<string | null>
  /** 마지막으로 본 프로젝트 id 저장(null 이면 해제). */
  setLastActiveProject(projectId: string | null): Promise<void>
  runProject(req: RunProjectRequest): Promise<RunResult>
  /** 진행 중인 프로젝트 실행을 취소한다. */
  cancelRun(projectId: string): Promise<void>
  /** 프로젝트 실행 진행 상태 스냅샷(진행 중 실행 id). ProjectPanel 마운트 시 running·취소 버튼 복원용. */
  getRunActivity(): Promise<RunActivity>
  /** 산출물 기록·검증 워크스페이스 조회. null 이면 비활성(파일 기록/검증 안 함). */
  getWorkspace(): Promise<string | null>
  /** 워크스페이스 디렉터리 선택(취소 시 기존 값 유지). 적용된 경로(또는 null) 반환. */
  selectWorkspace(): Promise<string | null>
  /**
   * 워크스페이스 경로 직접 설정(#197 B4 — 웹 UI 경로 입력). FLEET_WORKSPACE_ROOT 하위 한정·존재
   * 디렉터리만·런 진행 중 거부. 적용된 정준 절대경로를 반환한다. 데스크톱은 루트 env 미설정 시
   * reject(fail-closed — dialog 선택이 유일 경로).
   */
  setWorkspace(path: string): Promise<string>

  // 채팅
  createRoom(title: string, participants?: string[]): Promise<ChatRoom>
  listRooms(): Promise<ChatRoom[]>
  roomHistory(roomId: string): Promise<ChatMessage[]>
  postUserMessage(roomId: string, content: string): Promise<ChatMessage>
  askLlm(roomId: string, llmId: string): Promise<ChatMessage>
  discussRoom(roomId: string, llmIds: string[], rounds?: number): Promise<ChatMessage[]>
  /** 진행 중인 채팅 발언(ask/discuss)을 취소한다(in-flight 호출 abort). ChatPanel 취소 버튼용. */
  cancelChat(roomId: string): Promise<void>
  /** 채팅 진행 상태 스냅샷(진행 중 방 + 라이브 스트림). ChatPanel 마운트 시 복원용. */
  getChatActivity(): Promise<ChatActivity>

  // MCP 호스트
  /** MCP 서버 목록 설정(전체 교체). 연결 후 서버별 상태 반환. */
  setMcpServers(servers: McpServerSpec[]): Promise<McpServerStatus[]>
  /** 현재 MCP 서버 연결 상태/도구 목록. */
  getMcpStatus(): Promise<McpServerStatus[]>

  // 감사 / 이벤트 스트림
  listEvents(): Promise<FleetEvent[]>
  /** 오케스트레이터 진행 이벤트 구독 (해제 함수 반환). */
  onOrchestratorEvent(callback: (event: OrchestratorEvent) => void): () => void
  /** 채팅 응답 토큰 스트림 구독 (해제 함수 반환). */
  onChatStream(callback: (event: ChatStreamEvent) => void): () => void
  /** destructive 작업 승인 요청 구독 (해제 함수 반환). */
  onApprovalRequest(callback: (req: ApprovalRequest) => void): () => void
  /** 승인 모달 결정 회신(메인이 id 로 상관). */
  respondApproval(id: string, approved: boolean): Promise<void>
  /**
   * 미만료 대기 승인 스냅숏(재하이드레이션 · #216 C1). 후접속/재접속 클라가 브로드캐스트를 놓친
   * 대기 승인 카드를 재제시한다(hold 정책 하 "외출 중 폰 승인" 완료정의). 데스크톱은 대개 빈 목록.
   */
  listPendingApprovals(): Promise<ApprovalRequest[]>
  /**
   * 승인 이탈(응답/만료/철회/취소·rejectAll) 통지 구독 — payload = bare string id(해제 함수 반환).
   * 렌더러가 카드를 제거하고 tombstone 에 기록한다(늦은 스냅숏의 이미-철회 id 부활 차단 · #216 C1).
   */
  onApprovalWithdrawn(callback: (id: string) => void): () => void
  /**
   * graceful drain 통지 구독(#216 C3) — 서버 종료 시작 시 「곧 재접속」 배너용. payload = 정적
   * `{reason:'shutdown'}`(민감 필드 금지). 웹 전용 실효(데스크톱은 bridge=null 로 미구독·inert). 해제 함수 반환.
   */
  onServerDraining(callback: (event: { reason: string }) => void): () => void

  // 자동 업데이트
  /** 업데이트 상태 스냅샷(배너 마운트 하이드레이트). */
  getUpdateState(): Promise<UpdateEvent>
  /** 수동 업데이트 확인(백그라운드 분류). */
  checkForUpdate(): Promise<void>
  /** 다운로드 시작(사용자 액션). */
  downloadUpdate(): Promise<void>
  /** 다운로드분 설치·재시작(quitAndInstall). */
  installUpdate(): Promise<void>
  /** 배너 닫기 — main currentState=idle. */
  dismissUpdate(): Promise<void>
  /** 업데이트 이벤트 구독(해제 함수 반환). */
  onUpdateEvent(callback: (event: UpdateEvent) => void): () => void
  /** 업데이트 채널 조회(기본 stable). #98 */
  getUpdaterChannel(): Promise<UpdaterChannel>
  /** 업데이트 채널 설정 — 영속 + updater.allowPrerelease 즉시 적용 + 새 채널 재확인. #98 */
  setUpdaterChannel(channel: UpdaterChannel): Promise<void>
}

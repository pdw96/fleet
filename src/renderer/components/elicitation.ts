/**
 * #171 의도 elicitation — 선택형 폼 답을 결정적으로 goal 에 접합하는 순수 모듈(렌더러).
 * React 비의존·부수효과 0. 실행 경로(run/IPC/orchestrator)와 무관 — 합성된 문자열은
 * 호출측이 goal textarea 에 써넣고, 기존 runProject({ goal }) 경로가 그대로 전송한다.
 */

/** 완성도 수준 select 값. ''=미지정(접합 미기여). */
export type Completeness = '' | 'prototype' | 'standard' | 'high'

export interface ElicitationFields {
  completeness: Completeness
  audience: string
  reference: string
  success: string
  constraints: string
}

export const EMPTY_FIELDS: ElicitationFields = {
  completeness: '',
  audience: '',
  reference: '',
  success: '',
  constraints: '',
}

/** completeness 옵션값 → planner 가 읽는 문구. '' 는 미포함이라 키 없음(planner 가 도메인 맥락에 맞게 해석). */
const COMPLETENESS_PHRASE: Record<Exclude<Completeness, ''>, string> = {
  prototype: '빠른 프로토타입 (핵심 동작 위주, 폴리시 최소)',
  standard: '표준 (실사용 가능한 완성도)',
  high: '높은 완성도 (폴리시·엣지케이스·견고함까지 투자)',
}

export interface FieldMeta {
  key: keyof ElicitationFields
  label: string
  kind: 'text' | 'select'
  placeholder?: string
  options?: { value: Completeness; label: string }[]
}

/** 폼 필드 메타 — 라벨·입력종류·접합 순서(이 배열 순서가 [추가 맥락] 블록 순서). 전부 분야 무관·선택. */
export const ELICITATION_FIELDS: FieldMeta[] = [
  {
    key: 'completeness',
    label: '완성도 수준',
    kind: 'select',
    options: [
      { value: '', label: '미지정' },
      { value: 'prototype', label: '빠른 프로토타입' },
      { value: 'standard', label: '표준' },
      { value: 'high', label: '높은 완성도' },
    ],
  },
  {
    key: 'audience',
    label: '대상 사용자',
    kind: 'text',
    placeholder: '누가 사용하나 (예: 초등학생, 사내 개발자)',
  },
  {
    key: 'reference',
    label: '참고 레퍼런스 / 원하는 결과물 느낌',
    kind: 'text',
    placeholder: '"이것처럼" (예: Stripe API처럼, 레트로 게임풍)',
  },
  {
    key: 'success',
    label: '성공 기준',
    kind: 'text',
    placeholder: '무엇이 되면 잘 된 것 (예: JWT 로그인 동작)',
  },
  {
    key: 'constraints',
    label: '제약·필수',
    kind: 'text',
    placeholder: '반드시/절대 (예: 바닐라 JS만, 외부 라이브러리 금지)',
  },
]

/** 필드 값이 present(부재 아님)인가. 텍스트·select 공통: trim 후 비어있지 않음(select '' = 미지정 = 부재). */
export function isPresent(value: string): boolean {
  return value.trim().length > 0
}

/** 폼에 present 필드가 하나라도 있는가 — composeGoal 과 dirty-form 힌트가 공유하는 단일 기준. */
export function hasAnyPresent(fields: ElicitationFields): boolean {
  return ELICITATION_FIELDS.some((f) => isPresent(fields[f.key]))
}

/** 접합 표시값 — select 는 문구 매핑, 텍스트는 trim 값. */
function displayValue(meta: FieldMeta, fields: ElicitationFields): string {
  const raw = fields[meta.key]
  if (meta.kind === 'select') return COMPLETENESS_PHRASE[raw as Exclude<Completeness, ''>] ?? ''
  return raw.trim()
}

/**
 * base goal 에 present 필드를 `[추가 맥락]` 블록으로 결정적 접합한다.
 * - 전 필드 부재 → base 그대로(===) 반환(무회귀).
 * - base 본문 보존, 접합 경계 trailing 공백만 정규화(정확히 한 빈 줄 구분).
 * 결정적이되 멱등 아님 — 같은 fields 반복 적용 시 블록 중복. 중복 방지는 호출측 "접합 후 폼 비움".
 */
export function composeGoal(base: string, fields: ElicitationFields): string {
  const lines = ELICITATION_FIELDS.filter((f) => isPresent(fields[f.key])).map(
    (f) => `- ${f.label}: ${displayValue(f, fields)}`,
  )
  if (lines.length === 0) return base
  const block = `[추가 맥락]\n${lines.join('\n')}`
  const head = base.trimEnd()
  return head ? `${head}\n\n${block}` : block
}

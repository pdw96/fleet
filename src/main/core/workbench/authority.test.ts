import { describe, expect, it } from 'vitest'

import type {
  AuthorityCommit,
  BenchAuthorityDraft,
  BenchAuthorityRecord,
  CasResult,
  PostCommitStep,
  PreCommitStep,
} from './authority'
import { SUPPORTED_AUTHORITY_SCHEMA } from './authority'

/**
 * #251 PR2a T6b — 계약 사슬 골격(§W-4)의 **타입 층** 핀.
 *
 * ⚠ **이 파일의 유일한 강제자는 `npm run typecheck` 다**(계획 정정 ㉒ — 테스트 파일이 tsconfig 프로그램에
 * 포함된다). vitest 는 아래 `@ts-expect-error` 를 실행하지 않으므로 GREEN 이어도 의미가 없다. 그래서 각
 * 핀에는 「어떤 잘못된 타입 정의가 이 지시자를 **Unused** 로 만드는가」를 적는다 — 계약이 느슨해지면
 * 에러가 사라지고 `ban-ts-comment` 가 미사용 지시자로 RED 를 낸다.
 */

describe('스키마 버전', () => {
  it('지원 범위는 1 이다', () => {
    expect(SUPPORTED_AUTHORITY_SCHEMA).toBe(1)
  })
})

describe('타입 핀 — typecheck 가 판정자다', () => {
  it('draft 는 revision·writtenBy 를 실을 수 없다(저장소만 배정 · §W-4:465)', () => {
    const base = {
      schemaVersion: 1,
      identity: { commonGitDir: '/r/.git', benchRoot: '/wb', benchId: '0'.repeat(26) },
      lifecycle: 'open',
      sourceGeneration: 1,
    } satisfies BenchAuthorityDraft

    // @ts-expect-error revision 은 draft 에 없다 — 있으면 호출자가 세대를 조작할 수 있다(§W-4:465).
    const forged: BenchAuthorityDraft = { ...base, revision: 99 }
    expect(forged).toBeDefined()
  })

  /**
   * 정정 53 의 핵심. `io-failure` 는 **rename 성공 전** 단계만 실을 수 있다 — `'fsync-dir'` 이 여기
   * 들어가면 「쓰기 실패·상태 무변」과 「디스크 revision 전진」이 같은 종별로 뭉개져 Codex 체크포인트 2
   * P1-5 로 이미 닫힌 구분이 되돌아온다. 단계 유니온을 하나로 두면 이 오답이 **타입상 합법**이다.
   */
  it('io-failure 는 rename 이후 단계를 실을 수 없다(정정 53)', () => {
    const pre: PreCommitStep = 'rename'
    const post: PostCommitStep = 'fsync-dir'
    expect([pre, post]).toHaveLength(2)

    // @ts-expect-error 'fsync-dir' 은 PostCommitStep 이라 io-failure.step 에 들어갈 수 없다.
    const wrong: CasResult = { kind: 'io-failure', step: 'fsync-dir', path: '/p', cause: null }
    expect(wrong).toBeDefined()
  })

  it('commit-uncertain 은 rename 이후 단계만 실는다(정정 53 잔여 구멍)', () => {
    const ok: CasResult = {
      kind: 'commit-uncertain',
      step: 'close-dir',
      advancedRevision: 2,
      cause: null,
    }
    expect(ok.kind).toBe('commit-uncertain')

    const wrong: CasResult = {
      kind: 'commit-uncertain',
      // ⚠ 지시자는 **에러가 나는 줄 바로 위**에 둔다 — 선언 앞에 두면 prettier 가 객체를 여러 줄로
      // 펴는 순간 지시자가 덮는 줄과 에러 줄이 어긋나 「Unused directive」로 스스로 RED 가 된다(실측).
      // @ts-expect-error 'rename' 은 PreCommitStep 이라 commit-uncertain 에 들어갈 수 없다.
      step: 'rename',
      advancedRevision: 2,
      cause: null,
    }
    expect(wrong).toBeDefined()
  })

  /**
   * 브랜드는 **미export `unique symbol`** 이어야 한다(§W-4:350 · PR1b 실측: 문자열 프로퍼티 브랜드는
   * 리터럴로 위조 가능). 구조적 리터럴로 `AuthorityCommit` 을 만들 수 없음을 고정한다.
   */
  it('AuthorityCommit 은 리터럴로 위조되지 않는다', () => {
    // @ts-expect-error 브랜드 심볼이 미export 라 리터럴에는 넣을 수 없다.
    const forged: AuthorityCommit = {
      identity: { commonGitDir: '/r/.git', benchRoot: '/wb', benchId: '0'.repeat(26) },
      revision: 2,
      sourceGeneration: 1,
      durability: 'file-only',
    }
    expect(forged).toBeDefined()
  })

  it('record 는 draft 의 모든 필드를 포함한다(Omit 방향이 뒤집히면 RED)', () => {
    const rec = {} as BenchAuthorityRecord
    const asDraft: BenchAuthorityDraft = rec
    expect(asDraft).toBe(rec)
  })
})

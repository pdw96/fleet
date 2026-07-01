---
name: fleet-cutoff-gap-audit
description: Fleet 컷오프 갭 감사 — context7 현행 문서와 Fleet 코드를 fan-out 대조해 net-new 기능·정정 후보를 찾는다. "컷오프 갭 분석", "현행 문서 대비 누락 점검" 시 사용.
cloud-tools:
  - Read
  - Task
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
  - Bash(gh issue view:*)
  - Bash(gh issue comment 135:*)
---

# Fleet 컷오프 갭 감사

provider/SDK/CLI의 **현행 문서(context7)** 와 Fleet 코드를 대조해 미반영 기능·정정 대상을 수확한다.

## 언제

"컷오프 갭 분석", "context7 대비 Fleet 누락", "provider 현행 기능 점검" 류 요청.

## 행동 (CLI 비종속)

1. **영역 분할** — anthropic·openai·google·mcp 등 영역별로 나눈다.
2. **fan-out 대조** — 영역마다 **독립 서브에이전트 디스패치**: context7로 현행 문서를 받아
   Fleet 코드(`src/main/core/providers/*` 등)와 대조, net-new/정정 후보 추출.
3. **적대 검증** — 후보를 refute(이미 출하됨? 클라 SHOULD≠MUST? stale 전제?).
4. **산출** — net-new + 정정 표를 근거와 함께. 등재 가치 있으면 #27 후보로.

## 주의

- 모델 페이지 endpoints 표는 보일러플레이트 — prose가 권위.
- 절대 추측 금지: 갭 주장은 context7 현행 문서로 뒷받침.

#!/usr/bin/env node
// Gemini CLI SessionStart 훅 — 규율 안내를 세션 컨텍스트에 주입한다.
//
// ## 왜 이 파일이 따로 있는가 (Codex PR#334 P1)
// `.claude/hooks/session-start.mjs` 는 `.claude/settings.json` 이 등록하므로 **Claude Code
// 세션에만** 발동한다. Gemini CLI 는 `GEMINI.md` 를 읽는데 그것도 「AGENTS.md 를 먼저 읽어라」는
// 얇은 포인터라, 포인터를 따라가지 않은 Gemini 세션은 규율을 통째로 잃는다 — Claude 쪽에서
// 닫은 것과 **정확히 같은 구멍**이다. 그래서 짝을 만든다.
//
// ## 왜 훅 본체를 공유하지 않는가
// 주입 경로가 다르다. Claude Code 는 훅 stdout **원문**을 컨텍스트에 넣지만, Gemini CLI 는
// stdout 을 JSON 으로 파싱해 `hookSpecificOutput.additionalContext` 를 첫 턴으로 주입한다.
// 원문을 그대로 뱉으면 Gemini 쪽에서는 파싱 실패로 **조용히 사라진다**.
// 갈리는 것은 이 봉투뿐이고, **문구는 `scripts/agent-guidance.mjs` 단일 출처를 공유**한다
// (두 호스트가 같은 바이트를 내는지는 `scripts/session-start-hook.test.ts` 가 핀한다).
//
// ## 경계
// - `SessionStart` 는 advisory 다 — `continue`·`decision` 은 무시되고 세션 시작은 차단되지 않는다.
//   안내가 강제가 아니라는 이 훅의 성격과 일치한다(강제는 verify·ruleset·머지 게이트).
// - stdin(`{"source":"startup"|"resume"|"clear"}`)은 읽지 않는다 — 세 경우 모두 같은 안내를 낸다.
// - 부트스트랩(`npm install`·`gh`)은 여기 없다. 그것은 Claude Code 원격 컨테이너 전용 사정이다.
import { AGENT_GUIDANCE } from '../../scripts/agent-guidance.mjs'

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: AGENT_GUIDANCE,
    },
  }),
)

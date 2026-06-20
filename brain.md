# Fleet — 코드베이스 브레인 (자동 생성)

> `npm run brain` 로 `src/` 에서 자동 추출한 구조 지도다. **코드를 탐색하기 전에 이 파일을 먼저 읽어** 토큰을 아껴라.
> 58 files · 142 import wires · 39 IPC channels · 생성 2026-06-20T14:48 UTC
> 표기: `파일 — 역할 · →의존 · ←피의존`. id 는 `main/core/` 생략(예: `session/manager`).

## 레이어 (위 → 아래로 흐름)
- **화면 renderer** — 네가 눈으로 보고 클릭하는 모든 것 — 채팅창, 세션 목록, 프로젝트 보드, 승인 창.
- **다리 preload** — 화면과 내부 엔진 사이에서 메시지를 안전하게 주고받는 단 하나의 통로. 화면은 이 다리(window.fleet)로만 엔진에 말을 걸 수 있어요.
- **본체 main** — 앱 창을 띄우고, 화면의 요청을 받아 엔진에 넘기는 Electron 본체. 보안 빗장도 여기서 걸어요.
- **두뇌 core** — 화면 없이도 혼자 도는 순수 엔진. 실제 일 — AI 호출, 목표를 작업으로 쪼개기, 결과 검증 — 이 전부 여기서 일어나요.
- **공용 사전 shared** — 화면·다리·엔진이 똑같이 쓰는 데이터의 모양(타입)을 한곳에 정의. 모두가 같은 말을 쓰게 해주는 사전.
- **바깥 세계 runtime** — 앱 밖의 실제 대상 — 설치된 AI CLI(클로드/코덱스/제미니), AI 회사 API, 외부 도구(MCP) 서버.

## 한눈에
- **허브**(많이 연결): shared/types(38) · engine(25) · providers/types(11) · orchestrator/orchestrator(10) · tools/types(10) · main/index(10)
- **진입점**: main/e2e · main/index · preload/index · renderer/main
- **레지스트리**(확장점, 분기 대신 등록): cli/registry · providers/registry · tools/registry
- **승인 게이트**(위험작업 차단): safety/approval

## 런타임 배선 (import 로는 안 보이는 연결)
- renderer/App, renderer/components/ApprovalModal, renderer/components/ChatPanel, renderer/components/ProjectPanel, renderer/components/SessionsPanel, renderer/components/UpdateBanner →(window.fleet)→ preload/index.ts → main/index.ts (39 IPC channels) → engine
- session/cli-session → claude · codex · gemini
- session/api-session → Anthropic · OpenAI · Google
- mcp/stdio → MCP servers

## 모듈별 (파일 — 역할 · →의존 · ←피의존)

### renderer · renderer — 사용자가 실제로 보고 클릭하는 앱 화면 전체를 그리고, 세션 등록·프로젝트 실행·AI 채팅·승인 같은 모든 조작 화면을 담당하는 부분입니다.
- **renderer/App** — 앱 화면의 큰 틀과 위쪽 탭 메뉴를 그리는 부품 _맨 위 'FLEET' 제목과 세션·프로젝트·채팅 세 탭을 보여주고, 누른 탭에 맞는 화면을 갈아끼웁니다. 현재 등록된 AI 세션 개수와 위험 작업 승인 창도 항상 켜 둡니다._
  - →의존: renderer/components/ApprovalModal, renderer/components/ChatPanel, renderer/components/ProjectPanel, renderer/components/SessionsPanel, renderer/components/UpdateBanner, shared/types · ←피의존: renderer/main · 95줄
- **renderer/components/ChatPanel** — 여러 AI와 한 작업방에서 대화하고 자동 토론을 시키는 채팅 화면 _작업방을 만들어 사용자가 메시지를 보내고 특정 AI에게 묻거나 여러 AI를 자동으로 토론시킬 수 있으며, AI 답변이 한 글자씩 실시간으로 흘러나오는 모습을 말풍선으로 보여줍니다. 탭을 떠났다 돌아와도 진행 중이던 대화가 사라지지 않게 상태를 되살립니다._
  - →의존: renderer/ui, shared/types · ←피의존: renderer/App · 479줄
- **renderer/components/ProjectPanel** — 목표를 적으면 여러 AI가 역할을 나눠 작업하게 시키는 프로젝트 실행 화면 _원하는 목표와 역할 배정 방식을 입력해 '실행'을 누르면 AI들이 계획·작업·검증을 진행하고, 그 과정을 진행 로그와 작업 보드로 실시간 보여주며 도중에 취소할 수도 있습니다._
  - →의존: renderer/ui, shared/types · ←피의존: renderer/App · 505줄
- **renderer/components/ApprovalModal** — 위험한 작업을 하기 전에 사용자에게 허락을 받는 확인 창 _파일 삭제·명령 실행 같은 위험 작업이 생기면 '거부/승인' 팝업을 띄우고, 정해진 시간이 지나면 자동으로 거부합니다. 실수로 엔터를 눌러도 거부 쪽으로 떨어지게 해 위험한 작업이 잘못 승인되는 걸 막습니다._
  - →의존: shared/types · ←피의존: renderer/App · 140줄
- **renderer/components/SessionsPanel** — 어떤 AI를 쓸지 등록하고 설정하는 세션 관리 화면 _컴퓨터에 깔린 클로드·코덱스 같은 CLI 도구를 감지해 등록하거나, API 키를 넣어 Anthropic·OpenAI·Google AI를 추가하고, 각 AI가 잘하는 역할과 외부 도구(MCP) 연결도 지정합니다._
  - →의존: shared/types · ←피의존: renderer/App · 602줄
- **renderer/components/UpdateBanner**
  - →의존: shared/types · ←피의존: renderer/App · 72줄
- **renderer/ui** — 화면의 색과 클래스 이름을 다루는 작은 도우미 모음 _작업 상태(완료·실패·진행 중 등)에 맞는 색을 골라 주고, 채팅에 참여한 AI마다 고유한 색을 정해 누가 말했는지 한눈에 구분되게 합니다. 조건에 맞는 화면 스타일 이름을 합치는 간단한 기능도 들어 있습니다._
  - →의존: — · ←피의존: renderer/components/ChatPanel, renderer/components/ProjectPanel · 46줄
- **renderer/main** — 앱 화면을 맨 처음 켜서 빈 페이지에 띄우는 시작 부품 _웹 페이지의 빈 자리를 찾아 그 안에 위의 App 화면 전체를 그려 넣어 앱을 처음 띄웁니다. 개발 중 실수를 더 잘 잡아주는 점검 모드로 감싸 실행합니다._
  - →의존: renderer/App · ←피의존: — · 14줄

### preload · preload — 화면(앱 창)과 앱의 두뇌(본체)를 안전하게 이어주는 다리로, 화면이 본체에 일을 시키고 결과를 돌려받게 해 주는 창구 역할을 한다.
- **preload/index** — 앱 화면과 본체 사이를 안전하게 잇는 단 하나의 통로(창구) 부품 _화면 쪽 코드는 본체에 직접 손대지 못하고, 이 파일이 미리 정해 둔 'fleet'이라는 안내 데스크를 통해서만 요청을 전달한다. 마치 은행 창구처럼, 손님(화면)이 정해진 양식으로만 요청하고 직원(본체)이 처리해 결과를 돌려주는 구조라 안전하다._
  - →의존: shared/types · ←피의존: — · 98줄

### main · main — Fleet 앱의 본체(메인 프로세스)를 켜고, 창과 보안 빗장을 설치하며, 화면과 AI 엔진을 안전하게 연결하는 시동·관문 묶음이다.
- **main/index** — 앱에 시동을 걸어 창을 띄우고 화면과 AI 엔진을 이어주는 '시동·교환대' _앱이 준비되면 AI 엔진을 만들고, 화면(창)을 띄우며, 화면이 보내는 모든 요청(세션 등록·채팅·프로젝트 실행·승인 응답 등)을 엔진의 해당 기능으로 연결하는 전화 교환대 역할을 한다. 창을 만들 때 보안 빗장 두 개(이동 차단·권한 차단)를 걸고, 앱을 끌 때는 켜져 있던 AI 프로그램들을 깔끔히 정리한 뒤 종료해 '좀비' 프로세스가 남지 않게 한다._
  - →의존: engine, main/auto-update, main/crash-recovery, main/e2e, main/permission-guards, main/secret-crypto, main/window-guards, safety/approval-bridge, shared/types, store/json-file · ←피의존: — · 250줄
- **main/e2e** — 자동 테스트할 때만 켜지는 '연습용 가짜 AI' 장치 _진짜 AI를 부르는 대신 미리 정해둔 답을 흉내 내, 화면 자동검사(Playwright)가 흔들림 없이 돌아가게 한다. 가짜 AI 둘과 토론방 하나, 임시 작업폴더를 미리 깔아두며, 일부러 '응답 중' 상태에서 멈춰 탭을 옮겼다 돌아와도 진행 표시가 살아있는지 확인하게 해준다. FLEET_E2E 라는 스위치가 정확히 '1'일 때만 작동하고 평소엔 절대 끼어들지 않는다._
  - →의존: cli/detect, engine · ←피의존: main/index · 39줄
- **main/auto-update**
  - →의존: shared/types · ←피의존: main/index · 152줄
- **main/secret-crypto** — API 키 같은 비밀번호를 운영체제 금고로 잠갔다 푸는 '비밀 자물쇠' _맥의 키체인, 윈도우의 DPAPI 같은 운영체제 내장 금고를 이용해 API 키를 암호화해 저장하고, 필요할 때 다시 풀어준다. 리눅스에서 진짜 암호화가 안 되는 경우(평문 저장)는 보호가 0이라 아예 '사용 불가'로 처리해, 비밀이 무방비로 새지 않게 막는다._
  - →의존: secret/types · ←피의존: main/index · 36줄
- **main/crash-recovery** — 렌더러가 죽어 흰 화면이 되면 자동으로 다시 띄워 복구하는 '크래시 구급대' _AI 화면(렌더러)이 갑자기 죽으면 창이 흰 화면으로 멈추는데, 이를 감지해 잠깐 기다렸다 화면을 다시 불러와 복구한다. 같은 크래시가 연달아 나면 간격을 점점 늘리고 한도를 넘으면 멈춰 무한 깜빡임을 막고, 앱을 끄는 중이거나 창이 이미 닫혔으면 다시 띄우지 않는다. 외부에서 강제 종료(killed)된 렌더러도 창은 살아있어 복구 대상이며, GPU 같은 보조 프로세스가 죽는 건 크롬이 알아서 되살리므로 기록만 남긴다._
  - →의존: — · ←피의존: main/index · 170줄
- **main/permission-guards** — 카메라·마이크 같은 장치·권한 요청을 무조건 거절하는 '권한 문지기' _이 앱은 카메라, 마이크, 위치, 알림, USB 장치 등을 쓸 일이 없으므로 그런 권한 요청을 전부 거절한다. AI가 만든 내용이 화면에 들어오는 앱이라, 혹시 끼어든 코드가 몰래 장치를 켜려 해도 기본적으로 다 막아두는 안전장치다._
  - →의존: — · ←피의존: main/index · 37줄
- **main/window-guards** — 새 창 열기와 다른 페이지로의 이동을 전부 막는 '이동 문지기' _이 앱은 화면이 하나뿐이라 새 창을 열거나 다른 웹페이지로 넘어갈 일이 없으므로, window.open·외부 링크·리다이렉트·하위 프레임 이동 등을 모두 차단한다. AI 출력에 섞여 들어온 코드가 몰래 다른 곳으로 화면을 끌고 가는 일을 막는 안전 가드이며, 앱의 정상적인 첫 화면 로딩은 그대로 둔다._
  - →의존: — · ←피의존: main/index · 36줄

### providers · core — 클로드·제미니·GPT 같은 여러 AI 서비스의 서로 다른 대화 방식을 똑같은 형태로 맞춰주고, 인터넷 장애에도 잘 견디게 해주는 'AI 통역·연결 창구' 모음.
- **providers/types** — 모든 AI 창구가 똑같이 쓰는 공통 약속(데이터 모양)과 기본 도구를 모아 둔 규격집 _대화 한 마디, 답변 결과, 도구 호출, 토큰 사용량 같은 데이터의 표준 모양을 정의해 어떤 AI든 같은 형태로 주고받게 한다. 또 API 키 확인, 인터넷 통신 기본 도구, 오류 표현 같은 공용 부품도 함께 담고 있다._
  - →의존: shared/types · ←피의존: engine, providers/anthropic, providers/google, providers/openai, providers/registry, providers/resilient, session/api-session, tools/context, tools/loop, tools/types · 295줄
- **providers/registry** — 설정에 적힌 AI 종류를 보고 알맞은 창구를 골라 만들어 주는 안내데스크 _'anthropic·openai·google' 중 무엇인지 보고 그에 맞는 대화 창구를 하나 만들어 돌려준다. 새 AI 서비스를 추가할 때 여기 한 곳만 고치면 되도록 분기점을 모아 둔 곳이다._
  - →의존: providers/anthropic, providers/google, providers/openai, providers/types, shared/types · ←피의존: engine · 31줄
- **providers/anthropic** — 클로드(Anthropic) AI 와 대화하는 전용 창구 _클로드에게 질문을 보내고 답을 받아오며, 답이 한 글자씩 실시간으로 오게 하는 처리도 한다. 또 클로드의 '깊이 생각하기' 기능이 켜지면 답이 잘리지 않게 답변 분량을 더 넉넉히 잡아주고, 모델 종류에 맞춰 안 통하는 설정은 알아서 빼준다._
  - →의존: providers/sse, providers/types, shared/types · ←피의존: providers/registry · 549줄
- **providers/google** — 구글 제미니(Gemini) AI 와 대화하는 전용 창구 _제미니에게 질문을 보내고 답을 받아오며, 제미니 버전(2.5/3 등)마다 다른 '생각 깊이' 설정 방식을 알아서 맞춰 보낸다. 생각하기를 켜면 답이 굶지 않도록 답변 분량을 늘리고, 제미니가 답을 차단했는지도 가려낸다._
  - →의존: providers/sse, providers/types, shared/types · ←피의존: providers/registry · 555줄
- **providers/openai** — OpenAI(GPT) 및 같은 방식을 쓰는 호환 AI 와 대화하는 전용 창구 _GPT 에게 질문을 보내고 답을 받아오며, o1·GPT-5 같은 추론 모델이 거부하는 설정(온도·토큰 항목 등)을 모델에 맞게 알아서 바꿔 보낸다. 같은 방식을 쓰는 다른 회사 AI(openai-compatible)도 이 창구로 함께 처리한다._
  - →의존: providers/sse, providers/types, shared/types · ←피의존: providers/registry · 478줄
- **providers/sse** — 실시간으로 조각조각 도착하는 답변 데이터를 한 덩어리씩 깔끔히 잘라 주는 도구 _AI 가 답을 한 글자씩 흘려보낼 때 인터넷으로 들어오는 데이터 조각에서 실제 내용만 골라내고, 의미 없는 줄이나 종료 신호는 걸러낸다. 글자가 중간에 끊겨 깨지지 않도록 안전하게 이어 붙인다._
  - →의존: — · ←피의존: providers/anthropic, providers/google, providers/openai · 27줄
- **providers/resilient** — 인터넷 장애·지연에도 요청이 잘 끝나게 감싸 주는 안전장치 _응답이 너무 안 오면 무한정 기다리지 않게 제한시간을 걸고, 일시적 오류(과부하·서버 오류)면 잠깐 쉬었다 자동으로 다시 시도한다. 단, 사용자가 직접 취소하면 재시도하지 않고 즉시 멈춘다._
  - →의존: providers/types · ←피의존: engine · 84줄

### orchestrator · core — 여러 AI에게 역할을 나눠주고, 목표를 작은 작업들로 쪼개 차례로 시키고, 서로 검토·수정·요약까지 마치도록 전체 흐름을 지휘하는 '작업 진행 본부' 모듈이다.
- **orchestrator/orchestrator** — 목표 하나를 받아 계획·구현·검토·검증·요약까지 전 과정을 지휘하는 작업 총괄 지휘자 _목표를 작은 작업들로 쪼갠 뒤, 각 작업을 구현 AI가 실제 파일을 고치게 하고 다른 AI가 그 변경을 교차 검토해 통과할 때까지 반복하며, 위험한 변경은 승인을 받고 최종에는 테스트로 검증하고 실패하면 자동으로 고치게 합니다. 한 작업이 실패해도 전체가 멈추지 않게 격리하고, 사용자가 취소하면 진행 중 변경을 되돌리고 중단합니다._
  - →의존: orchestrator/assignment, orchestrator/diff-risk, orchestrator/plan, orchestrator/review, safety/approval, session/manager, shared/types, store/types, workspace/git · ←피의존: engine · 843줄
- **orchestrator/plan** — 큰 목표를 실행 가능한 작은 작업 목록으로 쪼개 주는 계획 분해기 _기획 담당 AI에게 목표를 4~8개의 작업으로 나눠 달라고 요청하고, AI가 돌려준 응답이 형식이 조금 어긋나도 너그럽게 읽어내 작업 목록으로 정리합니다. 검증(테스트·빌드)이 실패하면 그 실패 내용을 다시 AI에게 알려 부족한 부분만 채울 '추가 보정 작업'도 뽑아냅니다._
  - →의존: orchestrator/assignment, orchestrator/review, session/types, shared/types · ←피의존: orchestrator/orchestrator · 159줄
- **orchestrator/assignment** — 어떤 AI에게 어떤 역할(기획·구현·검토 등)을 맡길지 정하는 자리 배정표 _'계획짜기·설계·구현·검토·테스트' 같은 7가지 역할을 정해진 규칙(수동 지정·차례로 돌리기·잘하는 사람 우선)에 따라 AI들에게 나눠 줍니다. 같은 입력이면 늘 같은 결과가 나오고, '잘하는 사람 우선' 규칙에서도 한 AI에게 일이 몰리지 않도록 적게 쓴 AI를 먼저 골라 균형을 맞춥니다._
  - →의존: shared/types · ←피의존: engine, orchestrator/orchestrator, orchestrator/plan · 96줄
- **orchestrator/diff-risk** — AI가 바꾼 코드가 위험한 변경인지 판정하는 위험 신호등 _AI가 고친 내용을 보고 비밀번호 같은 민감한 파일을 건드렸거나, 파일을 너무 많이 지웠거나, 변경 내용이 너무 길어 끝이 잘려 확인이 불가능하면 '위험'으로 표시하고 그 이유를 함께 알려 줍니다. 의심스러우면 안전하게 '위험' 쪽으로 분류합니다._
  - →의존: safety/approval, shared/types, workspace/git · ←피의존: orchestrator/orchestrator · 21줄
- **orchestrator/review** — 각 단계에서 AI에게 보낼 지시문을 만들고 검토 결과를 읽어내는 대화 문구 담당 _구현·검토·요약·수정 단계마다 AI에게 보낼 안내 문구를 상황에 맞게 만들어 주고, 검토 AI의 답에서 '승인인지 수정 요청인지'와 그 피드백을 뽑아냅니다. AI가 형식을 안 지킨 어수선한 답을 줘도 핵심을 읽어내도록 대비책을 갖췄습니다._
  - →의존: shared/types · ←피의존: orchestrator/orchestrator, orchestrator/plan · 121줄

### session · core — 여러 AI(구독형 CLI와 API)를 똑같은 방식으로 다룰 수 있게 감싸서, 작업방이 AI의 종류를 신경 쓰지 않고 '말 걸고-답받기'만 하면 되도록 통일해 주는 모듈.
- **session/api-session** — Anthropic·OpenAI·Google 같은 인터넷 API로 AI와 대화하며 이전 대화를 기억하게 해 주는 일꾼 _주고받은 대화를 차곡차곡 쌓아 여러 번 이어서 물을 수 있게 하고, 필요하면 AI가 도구를 쓰며 일을 처리하는 반복 과정도 돌린다. 빈 답이 조용히 넘어가지 않도록 (필터 차단·글자 한도 초과·생각만 하고 답 없음 같은 경우) 명확한 오류로 알려 주고, 사용한 토큰량을 따로 기록하며, 같은 세션의 동시 요청이 대화 기록을 뒤섞지 않게 순서를 보장한다._
  - →의존: providers/types, session/abort, session/types, shared/types, tools/loop, tools/types · ←피의존: engine · 193줄
- **session/cli-session** — 클로드·코덱스·제미니 같은 설치형 AI 프로그램을 실제로 실행해 대화를 주고받는 일꾼 _프롬프트를 명령어 형태로 만들어 해당 AI 프로그램을 돌리고 결과 글을 받아 깔끔하게 정리해 돌려준다. 매번 새 프로그램을 띄우는 '독립 실행', AI 자체 기능으로 대화를 이어가는 '대화 유지', 지정한 폴더의 파일을 직접 고치는 '편집'의 세 가지 방식을 지원하며, 가능하면 답을 한 글자씩 실시간으로 흘려보내고 같은 세션의 동시 요청은 순서대로 줄 세운다._
  - →의존: cli/detect, cli/output, session/abort, session/types, shared/types · ←피의존: engine · 239줄
- **session/manager** — 등록된 모든 AI 세션을 한곳에 모아 두고 종류 상관없이 꺼내 쓰게 해 주는 보관함 _AI 세션을 이름표(id)로 추가·조회·목록 확인·삭제할 수 있게 하고, 각 AI가 맡을 수 있는 역할 정보를 그 자리에서 바꿔 화면까지 반영되게 한다. 세션을 지우거나 전체를 닫을 때는 각 세션의 정리 작업을 호출해 깔끔히 마무리한다._
  - →의존: session/types, shared/types · ←피의존: chat/room, engine, orchestrator/orchestrator · 59줄
- **session/types** — 모든 AI 세션이 똑같이 지켜야 할 약속(규격)을 적어 둔 설계도 _AI에게 말을 거는 send 함수와 정리하는 dispose 함수를 모든 AI가 똑같은 모양으로 갖추도록 정해 둔다. 또 말을 걸 때 붙일 수 있는 옵션들(취소 신호, 답을 조금씩 받아보기, 이번 한 번만 맥락 없이 깨끗하게 묻기, 작업 폴더 지정, 시간제한, 정해진 형식으로 답 받기 등)도 함께 규정한다._
  - →의존: shared/types · ←피의존: orchestrator/plan, session/api-session, session/cli-session, session/manager · 53줄
- **session/abort**
  - →의존: — · ←피의존: engine, session/api-session, session/cli-session · 57줄

### engine · core — 여러 AI(구독형 CLI와 API)를 한곳에서 등록·관리하고, 채팅과 프로젝트 작업을 진행시키는 앱의 중앙 관제실 역할을 하는 모듈이다.
- **engine** — 앱의 모든 핵심 기능을 한곳에 모아 화면 쪽에 단일 창구로 내주는 '중앙 관제실' 부품 _AI 세션 등록·삭제, 채팅 주고받기, 프로젝트 작업 실행과 취소, 외부 도구 연결 같은 기능을 묶어 화면(IPC) 쪽에서 부르기 쉬운 하나의 입구로 제공한다. 앱을 다시 켜도 저장해 둔 AI 세션을 다시 살려내고, API 키는 OS 암호화로 안전하게 보관·복원한다._
  - →의존: chat/room, cli/detect, cli/registry, mcp/host, mcp/types, orchestrator/assignment, orchestrator/orchestrator, providers/registry, providers/resilient, providers/types, +13 · ←피의존: main/e2e, main/index · 825줄

### mcp · core — 바깥에서 가져온 도구 프로그램(MCP 서버)을 Fleet 안으로 안전하게 연결해, AI들이 쓸 수 있는 도구로 바꿔 관리하는 모듈이다.
- **mcp/types** — 이 모듈의 부품들이 공유하는 약속(설계도) 모음 파일 _자식 프로세스, 통신 통로, 도구 정보, 서버 관리자 등이 각각 어떤 기능을 갖춰야 하는지 형태만 정의해 둔다. 실제 동작 코드는 없고, 부품들이 서로 같은 규격으로 끼워 맞춰지도록 하는 인터페이스다._
  - →의존: safety/approval, shared/types, tools/types · ←피의존: engine, mcp/client, mcp/host, mcp/stdio, mcp/wrap · 111줄
- **mcp/host** — 여러 도구 서버를 한꺼번에 켜고 끄고 정리하는 총괄 관리자 부품 _서버 목록을 받아 새것은 연결하고 빠진 것은 닫으며, 새 서버를 실행하기 전에는 사용자 승인(ApprovalGate)을 먼저 받는다. 같은 이름의 도구가 겹치면 먼저 등록된 쪽만 노출하고, 서버가 죽거나 도구 목록이 바뀌면 상태를 다시 계산한다._
  - →의존: mcp/client, mcp/stdio, mcp/types, mcp/wrap, shared/types, tools/types · ←피의존: engine · 325줄
- **mcp/stdio** — 도구 서버 프로그램을 실제로 실행하고 글자를 주고받게 연결하는 부품 _외부 프로그램을 자식 프로세스로 띄우고, 들어오는 글자를 줄바꿈 단위로 잘라 하나의 메시지로 묶어 전달한다. 깨진 메시지 한 줄은 버려서 연결 전체가 무너지지 않게 하고, 종료 통지는 정확히 한 번만 가도록 모은다._
  - →의존: mcp/types, process/kill-tree, shared/types · ←피의존: mcp/host · 92줄
- **mcp/wrap** — 외부 도구 하나를 Fleet 안에서 쓸 수 있는 표준 도구로 포장하는 부품 _도구 이름을 'mcp__서버명__도구명' 형식으로 바꾸고 규칙에 안 맞는 글자는 정리하며, 모든 외부 도구를 '위험(승인 필요)'으로 분류한다. 도구 실행 결과는 글자로 합치되 64KB를 넘으면 잘라서 화면이 폭주하지 않게 한다._
  - →의존: mcp/types, shared/types, tools/types · ←피의존: mcp/host · 103줄
- **mcp/client** — 외부 도구 서버 한 곳과 대화를 주고받는 통신 담당 부품 _요청에 번호표를 붙여 보내고 같은 번호의 답이 오면 짝지어 돌려준다. 30초가 지나거나 사용자가 취소하면 대기를 정리하고 서버에도 '취소' 통보를 보내며, 연결이 끊기면 기다리던 요청을 모두 실패 처리한다._
  - →의존: mcp/types · ←피의존: mcp/host · 278줄

### tools · core — AI가 작업방 안의 파일을 직접 읽고 찾아볼 수 있게 해주는 '도구 묶음'과, 그 도구들을 안전하게 반복 사용하도록 진행을 관리하는 살림꾼 모음.
- **tools/types** — 도구가 어떤 모양과 기능을 갖춰야 하는지 정해두는 규격서(설계도) _도구라면 반드시 가져야 할 것들(AI에게 보여줄 설명, 위험도 판정, 실제 실행 함수)과 도구 명부·진행 관리자가 주고받을 정보의 형태를 약속으로 정의한다. 실제 동작 코드는 없고, 다른 파일들이 따라야 할 틀만 담는다._
  - →의존: providers/types, safety/approval, shared/types · ←피의존: mcp/host, mcp/types, mcp/wrap, session/api-session, tools/loop, tools/registry, tools/workspace-tools · 42줄
- **tools/loop** — AI가 도구를 쓰겠다고 하면 실제로 실행해주고 그 결과를 다시 AI에게 돌려주길 반복하는 진행 관리자 _AI가 '이 도구를 써 달라'고 하면 승인을 받은 뒤 도구를 실행하고 결과를 다시 AI에게 전달하는 일을 도구 호출이 끝날 때까지 되풀이한다. 무한 반복을 막으려 최대 8번으로 제한하고, 그동안 쓴 비용(토큰)을 합산하며, 알 수 없는 도구나 승인 거부·실행 오류는 오류로 표시해 돌려준다._
  - →의존: providers/types, tools/context, tools/types · ←피의존: session/api-session · 225줄
- **tools/workspace-tools** — 작업 폴더 안의 파일을 읽고 찾아보게 해주는 안전한 읽기 전용 도구 4종 세트 _파일 읽기·폴더 목록·내용 검색(grep)·파일 찾기(glob) 네 가지 도구를 만들며, 모두 지정한 작업 폴더 밖으로는 절대 나가지 못하게 막고 비밀번호 같은 민감 파일은 건너뛴다. 너무 큰 파일이나 많은 결과는 일부만 보여주고, 위험할 수 있는 검색 패턴은 미리 거부해 앱이 멈추지 않게 보호한다._
  - →의존: safety/approval, tools/types · ←피의존: engine · 374줄
- **tools/context** — 대화 기록이 너무 길어지지 않게 오래된 도구 결과를 짧은 표식으로 줄여주는 정리 담당 _AI에게 보내는 대화가 정해진 분량을 넘으면, 예전에 받았던 도구 실행 결과 내용을 '이전 도구 결과 정리됨'이라는 짧은 문구로 바꿔 자리를 비운다. 최근 결과 몇 개와 방금 막 만든 결과는 그대로 보존하고, 글자 수를 대략 세어(영어는 4글자에 한 토막, 한글·한자는 글자마다 한 토막으로 넉넉히) 한도 초과를 미리 막는다._
  - →의존: providers/types · ←피의존: tools/loop · 154줄
- **tools/registry** — 여러 도구를 이름표로 정리해 이름만 대면 바로 찾아 쓰게 해주는 도구 명부 _넘겨받은 도구들을 이름표 순으로 정리해, 이름으로 도구를 찾거나 목록을 뽑아낼 수 있게 한다. 같은 이름의 도구가 두 번 들어오면 헷갈림을 막기 위해 충돌 오류를 낸다._
  - →의존: tools/types · ←피의존: engine · 17줄

### store · core — 앱이 다루는 모든 데이터(프로젝트, 할 일, 채팅방, 대화, 기록, AI 연결 정보)를 한곳에 모아 보관하고, 컴퓨터를 껐다 켜도 그대로 남도록 파일에 저장하는 '데이터 창고'다.
- **store/types** — 창고에 담기는 데이터들의 모양과 규칙을 미리 적어 둔 설계도 부품 _프로젝트·할 일·채팅방·저장된 AI 세션 등이 각각 어떤 항목들로 이뤄지는지 형태를 정의한 명세서다. 특히 AI 연결 정보는 구독형 CLI(클로드·코덱스 등)와 API 두 종류로 나뉘며, API 키 같은 비밀번호는 절대 그대로 적지 않고 암호로 바꾼 형태만 저장하도록 규칙을 못 박아 둔다._
  - →의존: shared/types · ←피의존: chat/room, engine, orchestrator/orchestrator, store/json-file, store/memory · 143줄
- **store/memory** — 데이터를 메모리에서 직접 넣고 빼고 고치는 실제 일꾼 부품 _프로젝트·할 일·채팅방·메시지·기록 등을 만들고(create), 찾고(get), 목록을 보고(list), 수정하는(update) 모든 기능이 여기에 들어 있다. 데이터를 바꿀 때마다 사본을 따로 떠서 넘겨주어 원본이 바깥에서 함부로 바뀌지 않게 보호하고, 변경이 생기면 위의 파일 저장 담당에게 알려 디스크에 기록하게 한다._
  - →의존: shared/types, store/types · ←피의존: engine, store/json-file · 216줄
- **store/json-file** — 데이터를 컴퓨터 안 파일에 안전하게 저장해 두는 보관 담당 부품 _앱이 다루는 모든 정보를 'fleet-store.json'이라는 파일에 적어두고, 다음에 앱을 켜면 다시 불러온다. 저장할 때는 임시 파일에 먼저 쓴 뒤 이름만 바꿔치기해서 도중에 멈춰도 원본이 안 깨지게 하고, 파일이 읽다가 망가져 있으면 '.corrupt' 라는 이름으로 따로 백업해 둔 뒤 빈 상태로 시작한다._
  - →의존: store/memory, store/types · ←피의존: main/index · 60줄

### cli · core — 클로드·코덱스·제미니 같은 명령어형 AI 프로그램(CLI)이 컴퓨터에 깔려 있는지 확인하고, 그 프로그램을 실제로 실행해 답변 글자만 깔끔하게 뽑아내며, 각 프로그램의 사용법(명령어 종류)을 한곳에 정리해 두는 모듈이다.
- **cli/detect** — AI 명령어 프로그램을 실제로 실행하고, 깔려 있는지·어느 버전인지 확인하는 부품 _사람이 터미널에 명령어를 치듯 클로드·코덱스·제미니 프로그램을 대신 실행해 그 결과(출력 글자)를 받아온다. '--version'을 물어 설치 여부와 버전을 알아내고, 응답이 너무 오래 걸리거나(시간초과) 사용자가 중간에 취소하면 그 프로그램과 거기서 또 생긴 자식 프로그램들까지 끝까지 종료시킨 뒤 마무리한다. 여러 AI를 한꺼번에 동시 점검하는 기능도 있다._
  - →의존: process/kill-tree, shared/types · ←피의존: engine, main/e2e, session/cli-session, workspace/git · 208줄
- **cli/output** — AI가 쏟아낸 잡다한 출력에서 사람에게 보여줄 답변 글자만 골라내는 부품 _코덱스 같은 프로그램은 답변 말고도 시작 안내·생각 과정·토큰 사용량 같은 군더더기를 줄줄이 함께 뱉는데, 이 부품이 그중 진짜 답변 글자만 추려낸다. 또 답변이 한 글자씩 흘러나올 때(스트리밍) 각 줄에서 새로 추가된 글자 조각만 뽑아 화면에 실시간으로 이어 붙일 수 있게 하고, 대화를 이어가기 위한 세션 식별 번호도 찾아낸다._
  - →의존: shared/types · ←피의존: session/cli-session · 130줄
- **cli/registry** — 각 AI 프로그램을 어떻게 부르고 어떤 명령어로 실행하는지 적어 둔 사용설명 목록이자 보관함 _클로드·코덱스·제미니 각각의 실행 명령어 이름, 버전 확인법, 프롬프트 전달 방식, 대화 이어가기·파일 직접 수정에 필요한 옵션을 한곳에 카드처럼 정리해 둔다. 새로운 AI를 나중에 목록에 추가하거나 이름으로 꺼내 쓸 수 있게 해 주는 보관함 역할도 한다._
  - →의존: shared/types · ←피의존: engine · 102줄

### safety · core — AI 가 위험한 작업(파일 삭제, 강제 푸시 등)을 하려 할 때 자동으로 위험도를 판별하고, 위험하면 사람에게 "정말 해도 되나요?" 허락을 받아내는 안전장치 모듈.
- **safety/approval** — 명령이나 파일 작업이 얼마나 위험한지 등급을 매기고, 위험한 것은 허락 없이는 못 하게 막는 검문소 _파일 강제 삭제·rm -rf·git 강제 푸시·디스크 포맷·DB 테이블 삭제 같은 위험 패턴이나 .env·열쇠 파일(.key, .pem 등)을 알아채 '파괴적' 위험으로 분류하고, 안전한 작업은 그냥 통과시키되 위험한 작업은 사람의 승인을 받아야만 실행하고 아니면 거절한다. 모든 요청과 결정은 기록(감사 로그)으로 남긴다._
  - →의존: shared/types · ←피의존: engine, mcp/types, orchestrator/diff-risk, orchestrator/orchestrator, tools/types, tools/workspace-tools · 78줄
- **safety/approval-bridge** — 허락이 필요한 작업을 사용자 화면에 물어보고, 사용자의 예/아니오 답을 도로 전달해 주는 중개 창구 _AI 가 위험한 일을 하려 하면 그 요청을 화면(렌더러)으로 보내 사용자에게 묻고, 답이 오면 해당 요청과 짝지어 처리한다. 물어볼 창이 없으면 즉시 거절하고, 사람이 일정 시간(기본 타임아웃) 안에 답하지 않아도 자동으로 거절하는 '안전 우선' 방식이며, 같은 답이 두 번 와도 한 번만 처리한다._
  - →의존: shared/types · ←피의존: main/index · 66줄

### chat · core — 여러 AI가 한 채팅방에서 서로의 말을 보고 토론하도록 진행을 맡아 주는 모듈이다.
- **chat/room** — 여러 AI가 한 채팅방에서 차례로 발언하며 토론하도록 진행을 맡는 사회자 부품 _사용자나 시스템의 글을 방에 올리고, 특정 AI를 지목해 지금까지의 대화 내용을 보여준 뒤 다음 발언을 받아 다시 방에 저장한다. 여러 AI에게 한 주제를 정해진 횟수만큼 돌아가며 토론시키는 기능도 있어, 회의의 진행자처럼 누가 언제 말할지를 정리해 준다._
  - →의존: session/manager, shared/types, store/types · ←피의존: engine · 150줄

### workspace · core — AI들이 작업방에서 코드를 고칠 때, 시작 시점을 기록해 두고 무엇이 바뀌었는지 보여주거나 통째로 되돌릴 수 있게 해주는 안전장치 모듈.
- **workspace/git** — AI가 코드를 고치기 전 상태를 저장해 두고, 바뀐 내용을 모아 보여주거나 처음으로 되돌리는 작업 기록 관리원 _작업방을 버전 관리 저장소(git)로 만들어 '시작 사진'을 찍어두고, AI가 무엇을 바꿨는지 변경 목록과 그 내용(diff)을 모아 보여주거나, 마음에 안 들면 시작 사진 시점으로 통째로 되돌립니다. 사용자가 미리 만들어둔 작업은 시작 때 따로 보존해 지워지지 않게 하고, 여러 AI가 동시에 저장소를 건드려 생기는 잠금 충돌은 잠깐 기다렸다 다시 시도하며, 변경 내용이 너무 길면 6만 자에서 잘라 보여줍니다._
  - →의존: cli/detect · ←피의존: engine, orchestrator/diff-risk, orchestrator/orchestrator · 219줄

### process · core — AI 도구를 강제로 멈출 때, 겉껍데기뿐 아니라 그 아래 딸린 자식 프로그램들까지 한꺼번에 깔끔히 종료시키는 일을 맡는 모듈.
- **process/kill-tree** — 실행 중인 AI 프로그램과 그것이 줄줄이 띄운 하위 프로그램들을 통째로 종료시키는 부품 _작업을 취소하거나 시간 초과로 멈출 때, 윈도우에서는 시스템의 taskkill 명령(/T 트리·/F 강제)으로 부모부터 손자까지 가족 전체를 한 번에 끝낸다. 윈도우가 아니면 그냥 프로그램 하나만 끄면 충분하므로 바로 멈춘다._
  - →의존: — · ←피의존: cli/detect, mcp/stdio · 92줄

### secret · core — 사용자의 API 키 같은 비밀 정보를 컴퓨터에 안전하게 잠그고(암호화) 다시 푸는(복호화) 방법을 정해두는 규칙 모음이다.
- **secret/types** — 비밀 정보를 안전하게 잠그고 푸는 기능이 갖춰야 할 약속(규칙표)을 적어둔 설계도 _API 키 같은 중요한 비밀을 다룰 때 '잠금이 가능한지 확인', '평문을 암호로 잠그기', '암호를 다시 평문으로 풀기' 이 세 가지 기능을 반드시 제공하도록 정해둔 약속이다. 실제 잠금 작업은 운영체제(윈도우·맥·리눅스)의 금고 기능에 맡기고, 이 파일은 그 기능이 따라야 할 형식만 명시한다._
  - →의존: — · ←피의존: engine, main/secret-crypto · 15줄

### verify · core — AI가 고친 코드가 정말 멀쩡한지, 타입 검사·문법 검사·테스트 같은 점검 명령을 실제로 돌려보고 합격/불합격 결과를 정리해 주는 '코드 자동 검사 담당' 부품 모음.
- **verify/run** — 고친 코드가 제대로 됐는지 점검 명령을 실제로 돌려 합격·불합격을 가려내는 자동 검사 부품. _타입 검사·문법 검사·테스트 같은 점검 명령을 컴퓨터에서 실제로 실행하고, 끝난 결과(성공했는지, 화면에 뜬 글, 걸린 시간)를 모아 합격/불합격으로 정리한다. 실패하면 출력에서 'error'·'fail' 같은 단어가 든 대표 한 줄을 뽑아 무엇이 잘못됐는지 요약해 주고, 사용자가 도중에 멈추라고 하면(취소) 돌던 검사를 중단시키며, 너무 오래 걸리면(2분 기본) 시간 초과로 끊는다._
  - →의존: shared/types · ←피의존: engine · 147줄

### shared · shared — 앱의 모든 부분(메인·중계·화면)이 똑같이 쓰는 '공용 용어 사전'으로, 주고받는 데이터의 모양과 약속을 한곳에 정의해 둔 파일이다.
- **shared/types** — 앱 전체가 함께 쓰는 데이터 모양 약속 모음(공용 설명서) _AI 연결 정보, 채팅방·메시지, 작업과 프로젝트, 승인 요청, 화면-내부 사이에 오가는 신호 등 앱이 다루는 거의 모든 정보의 '겉모양과 규칙'을 글자 그대로 적어 둔 사전이다. 여기에는 실제로 동작하는 기능은 없고, 모두가 같은 틀로 데이터를 주고받도록 맞춰 주는 약속만 들어 있다._
  - →의존: — · ←피의존: chat/room, cli/detect, cli/output, cli/registry, engine, main/auto-update, main/index, mcp/host, mcp/stdio, mcp/types, +28 · 569줄

---
_이 파일은 자동 생성물이다. 코드 변경 후 `npm run brain` 으로 갱신. 설명은 `scripts/brain/descriptions.json` 에서 손볼 수 있다._

# 보안 정책

Fleet 는 멀티 LLM 오케스트레이션 **데스크톱 단독 앱**(Electron)이다. 백엔드 서버·멀티테넌트가
없고, provider API 키 같은 민감정보가 **사용자 기기 로컬에만** 저장된다. 보안 취약점 신고는 아래
절차를 따른다.

## 취약점 신고

**공개 이슈로 올리지 말 것.** GitHub 의 **비공개 취약점 신고(Private vulnerability reporting)** 를
사용한다:

- 레포 상단 **Security 탭 → "Report a vulnerability"** 버튼 → 비공개 advisory 작성.
  ([GitHub 안내](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability))

신고에 가능한 한 포함해 주면 좋은 것:

- 영향 받는 버전·플랫폼(Windows/macOS/Linux)
- 재현 절차(PoC) 또는 취약 코드 경로
- 예상 영향(예: 로컬 secret 노출, 임의 명령 실행, 승인 게이트 우회)

솔로 메인테이너 운영이라 공식 SLA 는 없지만 **최선을 다해 빠르게** 분류·응답한다. 수정이 나가기
전까지는 비공개를 유지해 달라(coordinated disclosure). 유효한 신고는 advisory 크레딧에 반영한다.

## 지원 버전

`1.0` 이전 **0.x 단계**다. 보안 수정은 **최신 릴리스(`0.x.y` 최신 1건)** 에만 반영한다. 0.x 동안은
breaking change 가 자유롭게 발생할 수 있으니 항상 최신 릴리스 사용을 권장한다.

| 버전 | 보안 지원 |
| ---- | --------- |
| 최신 `0.x.y` | ✅ |
| 그 외 이전 버전 | ❌ |

## 보안 자세 (신고 범위 이해용)

설계상 방어선 — 신고 시 어디까지가 의도된 동작인지 가늠하는 데 참고하라. 아키텍처 규칙 원본은
[`AGENTS.md`](./AGENTS.md) 「안전 우선」 + `src/main/core/safety/` 를 본다.

- **secret 저장 — OS 금고 암호화.** provider API 키는 Electron `safeStorage` 로 암호화해 저장한다
  (macOS Keychain · Windows DPAPI). 키는 **평문으로 디스크/로그에 기록하지 않는다.** Linux 에서
  키링이 없어 `basic_text`(평문 폴백)로 떨어지면 실보호가 0 이므로 **secret 저장을 비활성**한다
  (secure-by-default, `src/main/secret-crypto.ts`).
- **외부 CLI 실행 — shell 미경유.** claude/codex/gemini CLI·MCP 서버는 `cross-spawn` 으로 **argv
  배열**(`shell:false` 동등)을 통해 띄운다 → 셸 메타문자 주입 표면을 차단한다.
- **승인 게이트(ApprovalGate).** 파괴적 명령(`rm -rf`·`git push --force`·`drop table` 등)과
  민감파일(`.env`·`.pem`·`.key`·`.p12`·`.pfx`·`.ssh/`) 쓰기/삭제는 사용자 승인을 **필수**로 한다.
  기본 정책은 destructive 차단(`src/main/core/safety/`).
- **Electron 하드닝.** 렌더러는 `contextIsolation: true` + `sandbox: true`, preload 는
  `contextBridge`/`ipcRenderer` 만 노출한다. 새 창/`window.open`·페이지발 네비게이션·외부 권한
  요청(미디어·지오·WebUSB/Serial/HID)은 가드로 거부한다(`window-guards.ts`·`permission-guards.ts`).
- **ReDoS 방어.** AI 도구의 grep 패턴은 `safe-regex` 사전검증 + 길이/스캔 한도로 거른다.
- **네트워크 표면.** 리스닝 서버/열린 포트가 없다. 통신은 IPC(main↔renderer)와 **아웃바운드 LLM
  API 호출**뿐이다. 자동 업데이트는 GitHub Releases(HTTPS) 피드 기반으로, `electron-updater` 가
  `latest.yml` 의 **sha512 체크섬으로 무결성을 검증**하고 `autoDownload: false`(사용자 승인 후
  다운로드)로 동작한다. 릴리스 아티팩트는 **빌드 provenance attestation**(SLSA, `gh attestation
  verify`)으로 출처를 검증할 수 있다.

## 범위 밖 / 알려진 한계

- **Linux 키링 부재 환경**: secret 저장이 비활성화된다(평문 저장은 하지 않는다 — 의도된 동작).
- **devDependency 취약점**: 빌드/테스트 도구(electron-builder·jsdom·vite 등) 한정이며 **배포되는
  앱 런타임과 무관**하다. Dependabot · `dependency-review` 워크플로 · `npm audit` 로 추적하고,
  필요 시 `package.json` `overrides` 로 패치한다.
- **MCP 서버 환경변수(`env`)**: 사용자가 명시 입력하는 값으로 **의도적 평문** 저장이다(secret 운반은
  사용자 책임 — 인라인 secret 대신 파일 경로 사용 권장).
- **미서명 바이너리**: 현재 릴리스 빌드에는 OS 코드서명(Windows Authenticode·macOS notarization)이
  적용되지 않았다 — 설치 시 OS 경고가 뜰 수 있고, 업데이트 무결성은 위 HTTPS 피드 + sha512 체크섬 +
  빌드 provenance attestation 에 의존한다(코드서명은 후속 과제).

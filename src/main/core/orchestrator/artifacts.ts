/** LLM 산출물에서 추출한 파일 아티팩트. */
export interface FileArtifact {
  path: string
  content: string
}

// 펜스 블록: ```<info>\n<content>``` . info 안의 file:<path> 토큰이 있으면 아티팩트로 본다.
const FENCE = /```([^\n]*)\n([\s\S]*?)```/g
const FILE_TAG = /(?:^|\s)file:(\S+)/i

/**
 * LLM 출력에서 파일 아티팩트를 추출한다. 펜스 정보줄에 `file:경로` 가 있으면
 * (언어 힌트 동반 가능: ```ts file:src/x.ts) 그 블록 본문을 파일 내용으로 본다.
 * 닫는 펜스 앞 개행 1개는 정규화로 제거한다.
 */
export function parseArtifacts(text: string): FileArtifact[] {
  const out: FileArtifact[] = []
  for (const m of text.matchAll(FENCE)) {
    const tag = FILE_TAG.exec(m[1].trim())
    if (!tag) continue
    const content = m[2].endsWith('\n') ? m[2].slice(0, -1) : m[2]
    out.push({ path: tag[1], content })
  }
  return out
}

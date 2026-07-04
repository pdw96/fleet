import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// fleet-server SSR 번들(#197 B3) — electron-vite 3타깃과 별도(체크포인트 2 결정 2).
// ESM(.mjs) 출력: 레포 package.json 이 CJS 기본이라 확장자로 모듈 종류를 고정하고
// import.meta.url(정적 서빙 기본 경로·version 읽기)을 원형 보존한다.
export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/server/index.ts'),
    outDir: 'out/server',
    target: 'node24',
    emptyOutDir: true,
    rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } },
  },
  ssr: { external: ['ws'] }, // 런타임 dep — 번들 미포함(node_modules 해소)
})

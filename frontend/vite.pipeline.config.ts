import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// /pipeline 확인실은 백엔드가 파이프라인/index.html을 직접 서빙한다.
// React Flow 노드 지도만 별도 IIFE 번들로 만들어 같은 폴더에 둔다.
export default defineConfig({
  plugins: [react()],
  // IIFE 번들이 브라우저에서 process.env를 찾지 않도록 상수로 고정한다.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: fileURLToPath(new URL('../파이프라인', import.meta.url)),
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL('./src/pipeline-flow-entry.tsx', import.meta.url)),
      formats: ['iife'],
      name: 'PipelineFlowMap',
      fileName: () => 'flow-map.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: assetInfo => {
          if (assetInfo.name?.endsWith('.css')) return 'flow-map.css'
          return 'flow-map.[ext]'
        },
      },
    },
  },
})

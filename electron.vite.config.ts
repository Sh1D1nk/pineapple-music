import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [
      // music-metadata is ESM-only and is bundled (not required at runtime) so the CJS main
      // process can use it without a dynamic-import dance. Everything native stays external.
      externalizeDepsPlugin({ exclude: ['music-metadata'] })
    ],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'worker-analysis': resolve(__dirname, 'src/main/workers/analysis.worker.ts'),
          'worker-stem': resolve(__dirname, 'src/main/workers/stem.worker.ts')
        },
        // `electron` is a devDependency, so the plugin would otherwise inline the npm shim that
        // merely exports the binary path instead of the runtime module.
        external: ['electron', 'better-sqlite3', 'onnxruntime-node']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        external: ['electron']
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react()],
    css: {
      modules: { localsConvention: 'camelCaseOnly' }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      },
      chunkSizeWarningLimit: 4096
    },
    server: { port: 5173, strictPort: true }
  }
})

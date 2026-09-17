import { defineConfig, build, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_')

  return {
    define: {
      __REVIEW_AGENT_BUILD_MODE__: JSON.stringify(mode),
      __REVIEW_AGENT_BASE_URL__: JSON.stringify(
        process.env.VITE_AGENT_BASE_URL ?? env.VITE_AGENT_BASE_URL ?? '',
      ),
    },
    plugins: [react(), {
      name: 'extension-entries',
      async closeBundle() {
        for (const entry of ['content', 'background']) {
          await build({ configFile: false, build: {
            emptyOutDir: false,
            lib: { entry: resolve(import.meta.dirname, `src/browser/${entry}.ts`), formats: ['iife'], name: entry, fileName: () => `${entry}.js` },
          } })
        }
      },
    }],
  }
})

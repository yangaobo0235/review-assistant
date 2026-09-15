import { defineConfig, build } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
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
})

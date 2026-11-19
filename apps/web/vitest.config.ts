import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { bundledPluginAliases } from './bundledPluginDeps'

// Dedicated test config — avoids the Tailwind/PWA plugins used by the app build.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Matches the app build: the shadcn CLI writes `@/…` into the components
    // it copies.
    alias: [{ find: /^@\//, replacement: `${resolve(import.meta.dirname, 'src')}/` }, ...bundledPluginAliases(import.meta.dirname)],
  },
  server: {
    fs: {
      allow: ['../..'],
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
    // Elapsed runtime is advisory; CI or the operator cancels stuck runs.
    testTimeout: 0,
    hookTimeout: 0,
    // Per-package cache path: the default resolves to the workspace-root
    // node_modules, which the other packages' runs would share and race on.
    experimental: {
      fsModuleCache: true,
      fsModuleCachePath: "node_modules/.vitest-cache",
      // Keep slow imports visible without turning machine load into failure.
      importDurations: { print: "on-warn", failOnDanger: false, thresholds: { warn: 3_000, danger: 8_000 } },
    },
    reporters: ['default', ['../../tools/vitest/budgetReporter.mjs', { budgetPath: 'src/test/perf-budget.json' }]],
  },
})

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Dedicated test config — avoids the Tailwind/PWA plugins used by the app build.
export default defineConfig({
  plugins: [react()],
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
    // Timeouts are generous because a file that passes in under a second on
    // its own can sit behind other work under full fan-out. The worker cap
    // that used to sit here was a workaround for the server suite hogging the
    // machine at the same time; on its own this suite is fastest at full
    // parallelism.
    testTimeout: 30000,
    hookTimeout: 60000,
    // Per-package cache path: the default resolves to the workspace-root
    // node_modules, which the other packages' runs would share and race on.
    experimental: {
      fsModuleCache: true,
      fsModuleCachePath: "node_modules/.vitest-cache",
      // Hard gate on any one import's time; see tools/vitest/budgetReporter.mjs
      // for why the suites are budgeted rather than documented.
      importDurations: { failOnDanger: true, thresholds: { warn: 3_000, danger: 8_000 } },
    },
    reporters: ['default', ['../../tools/vitest/budgetReporter.mjs', { budgetPath: 'src/test/perf-budget.json' }]],
  },
})

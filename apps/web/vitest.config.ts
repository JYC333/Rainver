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
    // jsdom render tests are cheap alone but sit behind other work under
    // parallel load; 15s was failing a rotating handful of files on contention
    // rather than on anything being wrong, which made a green run a coin flip.
    // Raising the timeout alone did not settle it — a file that fails at 30s
    // under full fan-out passes in under a second by itself — so the run also
    // leaves half the cores free rather than starting a jsdom environment on
    // every one of them.
    testTimeout: 30000,
    hookTimeout: 60000,
    poolOptions: {
      threads: { maxThreads: 6 },
      forks: { maxForks: 6 },
    },
  },
})

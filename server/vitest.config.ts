import { defineConfig } from "vitest/config";

// Plain Node environment — the gateway has no DOM or framework UI; tests exercise
// config parsing, server-owned routes, and the proxy against a mock upstream.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/setupOfficialPlugins.ts"],
    // Records executed SQL when SQL_CAPTURE_DIR is set, so the statements that
    // are assembled at runtime (and therefore invisible to the static SQL
    // guard) can be prepared afterwards. Inert without the env var.
    setupFiles: ["./test/support/sqlCapture.ts"],
    // The real-Postgres suites create a database per file and run in parallel,
    // so an individual test can sit behind heavy contention for far longer than
    // it takes in isolation. Vitest's 5s default was failing a different handful
    // of files on every run — starvation reported as failure, which made "the
    // suite is green" a coin flip and hid real breakage in the noise.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});

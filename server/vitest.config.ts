import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Files that `vi.mock()` a module must run in their own worker: without
// isolation a mock stays registered for every file that follows in that
// worker. Everything else shares one module graph per worker. Do not isolate
// the files that do not mock. Module evaluation across the suite would
// dominate the run.
function listTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTestFiles(path);
    return entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
const mockingFiles = listTestFiles("test").filter((file) => readFileSync(file, "utf8").includes("vi.mock("));

// Plain Node environment — the gateway has no DOM or framework UI; tests exercise
// config parsing, server-owned routes, and the proxy against a mock upstream.
export default defineConfig({
  test: {
    environment: "node",
    projects: [
      { extends: true, test: { name: "shared", include: ["test/**/*.test.ts"], exclude: mockingFiles, isolate: false } },
      { extends: true, test: { name: "isolated", include: mockingFiles, isolate: true } },
    ],
    globalSetup: ["./test/setupOfficialPlugins.ts"],
    // Records executed SQL when SQL_CAPTURE_DIR is set, so the statements that
    // are assembled at runtime (and therefore invisible to the static SQL
    // guard) can be prepared afterwards. Inert without the env var.
    setupFiles: ["./test/support/sqlCapture.ts"],
    // The real-Postgres suites create a database per file and run in parallel,
    // so an individual test can sit behind heavy contention for far longer than
    // it takes in isolation. Do not use Vitest's 5s default. Starvation would
    // be reported as failure, "the suite is green" would be a coin flip, and
    // real breakage would hide in the noise.
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Per-package cache path: the default resolves to the workspace-root
    // node_modules, which the other packages' runs would share and race on.
    experimental: {
      fsModuleCache: true,
      fsModuleCachePath: "node_modules/.vitest-cache",
      // Hard gate on any one import's time; see tools/vitest/budgetReporter.mjs
      // for why the suites are budgeted rather than documented.
      importDurations: { failOnDanger: true, thresholds: { warn: 8_000, danger: 25_000 } },
    },
    reporters: ["default", ["../tools/vitest/budgetReporter.mjs", { budgetPath: "test/perf-budget.json" }]],
  },
});

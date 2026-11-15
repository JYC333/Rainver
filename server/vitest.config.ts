import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Every worker drives the one shared PostgreSQL container, and many files fork
// jobs-worker processes of their own. Past ~16 workers the host is
// oversubscribed: per-file time more than doubles, the full run gets slower,
// and Postgres runs out of lock slots. Small machines (CI) keep Vitest's default.
const maxWorkers = Math.min(16, Math.max(1, availableParallelism() - 1));

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
const testFiles = listTestFiles("test");
// Reviewed imports: Node filesystem/YAML only, or config.ts (Node builtins).
// Unreviewed files conservatively retain integration setup.
const pureFiles = [
  "test/agentGuides.test.ts", "test/composeConfig.test.ts", "test/config.test.ts", "test/testHygiene.test.ts",
  "test/boundaries.test.ts", "test/frontendProxy.test.ts", "test/legacyRuntimeContextAbsence.test.ts",
  "test/personStartedTriggerOrigin.test.ts", "test/projectReadingQualityFixture.test.ts",
  // Shell-only archive fixtures provide their own fake docker executable.
  "test/backupHardeningOps.test.ts",
];
const mockingFiles = testFiles.filter((file) => readFileSync(file, "utf8").includes("vi.mock("));

// Plain Node environment — the gateway has no DOM or framework UI; tests exercise
// config parsing, server-owned routes, and the proxy against a mock upstream.
export default defineConfig({
  test: {
    environment: "node",
    maxWorkers,
    projects: [
      ...([false, true] as const).flatMap((isolate) => {
        const files = testFiles.filter((file) => mockingFiles.includes(file) === isolate);
        return [
          { extends: true as const, test: { name: isolate ? "pure-isolated" : "pure", include: files.filter((file) => pureFiles.includes(file)), isolate } },
          { extends: true as const, test: {
            name: isolate ? "isolated" : "shared",
            include: files.filter((file) => !pureFiles.includes(file)), isolate,
            globalSetup: ["./test/setupIntegration.ts"],
            setupFiles: ["./test/support/sqlCapture.ts"],
          } },
        ];
      }),
    ],
    // Elapsed runtime is advisory; CI or the operator cancels stuck runs.
    testTimeout: 0,
    hookTimeout: 0,
    // Per-package cache path: the default resolves to the workspace-root
    // node_modules, which the other packages' runs would share and race on.
    experimental: {
      fsModuleCache: true,
      fsModuleCachePath: "node_modules/.vitest-cache",
      // Keep slow imports visible without turning machine load into failure.
      importDurations: { print: "on-warn", failOnDanger: false, thresholds: { warn: 8_000, danger: 25_000 } },
    },
    reporters: ["default", ["../tools/vitest/budgetReporter.mjs", { budgetPath: "test/perf-budget.json" }]],
  },
});

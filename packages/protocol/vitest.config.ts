import { defineConfig } from "vitest/config";

// Plain Node environment — the protocol package has no DOM, framework, or
// backend dependencies; tests only exercise schema parsing and type-level
// contracts.
export default defineConfig({
  test: {
    testTimeout: 0,
    hookTimeout: 0,
    reporters: ["default", "../../tools/vitest/budgetReporter.mjs"],
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

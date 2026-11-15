import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runtime warns; CI or the operator cancels stuck runs.
    testTimeout: 0,
    hookTimeout: 0,
    reporters: ["default", "../../tools/vitest/budgetReporter.mjs"],
  },
});

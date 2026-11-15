import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Explicit integration/visual acceptance; not part of the canonical server suite.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: undefined, globalSetup: ["./test/setupIntegration.ts"], setupFiles: ["./test/support/sqlCapture.ts"],
    include: ['test/readingBrowserAcceptance.browser.ts','test/projectReading.browser.ts'],
    maxWorkers: 1,
  },
});

import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Explicit integration/visual acceptance; not part of the canonical server suite.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: undefined,
    include: ['test/readingBrowserAcceptance.browser.ts'],
    maxWorkers: 1,
  },
});

import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({ ...base, test: { ...base.test, projects: undefined, include: ['test/problemWorkspace.browser.ts'], maxWorkers: 1 } });

import {defineConfig} from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({...base,test:{...base.test,projects:undefined,globalSetup:["./test/setupIntegration.ts"],setupFiles:["./test/support/sqlCapture.ts"],include:['test/sourceGoalBrowser.browser.ts'],maxWorkers:1}});

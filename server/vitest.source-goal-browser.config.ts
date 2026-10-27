import {defineConfig} from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({...base,test:{...base.test,projects:undefined,include:['test/sourceGoalBrowser.browser.ts'],maxWorkers:1,testTimeout:60000}});

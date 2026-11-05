// Part 3 of 3 of sourceGoalsDb.suite.ts; split because one file runs serially (support/testPartition.ts).
import {partitionTests} from './support/testPartition.js';
import {defineSourceGoalsDbSuite} from './sourceGoalsDb.suite.js';

defineSourceGoalsDbSuite(import.meta.filename, partitionTests(2, 3));

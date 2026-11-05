// Part 1 of 3 of projectDeepReadingDb.suite.ts; split because one file runs serially (support/testPartition.ts).
import {partitionTests} from './support/testPartition.js';
import {defineProjectDeepReadingDbSuite} from './projectDeepReadingDb.suite.js';

defineProjectDeepReadingDbSuite(import.meta.filename, partitionTests(0, 3));

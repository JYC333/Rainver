// Part 2 of 2 of readingMethodGenerationDb.suite.ts; split because one file runs serially (support/testPartition.ts).
import {partitionTests} from './support/testPartition.js';
import {defineReadingMethodGenerationDbSuite} from './readingMethodGenerationDb.suite.js';

defineReadingMethodGenerationDbSuite(import.meta.filename, partitionTests(1, 2));

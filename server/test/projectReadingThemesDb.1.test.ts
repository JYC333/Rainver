// Part 1 of 3 of projectReadingThemesDb.suite.ts; split because one file runs serially (support/testPartition.ts).
import {partitionTests} from './support/testPartition.js';
import {defineProjectReadingThemesDbSuite} from './projectReadingThemesDb.suite.js';

defineProjectReadingThemesDbSuite(import.meta.filename, partitionTests(0, 3));

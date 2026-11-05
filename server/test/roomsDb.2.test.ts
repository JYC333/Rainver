// Part 2 of 3 of roomsDb.suite.ts; split because one file runs serially (support/testPartition.ts).
import {partitionTests} from './support/testPartition.js';
import {defineRoomsDbSuite,ROOMSDB_ROUTES} from './roomsDb.suite.js';

defineRoomsDbSuite(import.meta.filename, partitionTests(1, 3, ROOMSDB_ROUTES));

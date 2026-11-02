import {pgTable,varchar,integer,jsonb,timestamp,unique,foreignKey,check,index} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {spaces} from './spaces.js';
import {projects} from './projects.js';
import {sourceGoals,sourceGoalVersions} from './sourceGoals.js';
import {informationBriefings} from './informationBriefings.js';
/** Persistent completion barrier for exactly the targets admitted by one
 * Following collection job; output lives in the existing briefing version store. */
export const projectReadingRounds=pgTable('project_reading_rounds',{
 id:varchar({length:36}).primaryKey(),spaceId:varchar('space_id',{length:36}).notNull().references(()=>spaces.id),projectId:varchar('project_id',{length:36}).notNull(),goalId:varchar('goal_id',{length:36}).notNull(),versionId:varchar('version_id',{length:36}).notNull(),
 sequence:integer().notNull(),slotKey:varchar('slot_key',{length:128}).notNull(),
 status:varchar({length:24}).notNull().default('collecting'),targetsJson:jsonb('targets_json').notNull(),coverageJson:jsonb('coverage_json').notNull().default({}),
 executionJson:jsonb('execution_json').notNull(),briefingId:varchar('briefing_id',{length:36}),errorCode:varchar('error_code',{length:64}),
 deadlineAt:timestamp('deadline_at',{withTimezone:true,mode:'string'}).notNull(),createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>[
 unique('uq_project_reading_round_slot').on(t.spaceId,t.goalId,t.slotKey),unique('uq_project_reading_round_sequence').on(t.spaceId,t.goalId,t.sequence),
 foreignKey({columns:[t.projectId,t.spaceId],foreignColumns:[projects.id,projects.spaceId]}).onDelete('cascade'),
 foreignKey({columns:[t.spaceId,t.goalId],foreignColumns:[sourceGoals.spaceId,sourceGoals.id]}),
 foreignKey({columns:[t.spaceId,t.versionId],foreignColumns:[sourceGoalVersions.spaceId,sourceGoalVersions.id]}),
 foreignKey({columns:[t.briefingId,t.spaceId],foreignColumns:[informationBriefings.id,informationBriefings.spaceId]}),
 check('ck_project_reading_round_sequence',sql`sequence>0`),check('ck_project_reading_round_status',sql`status IN ('collecting','generating','complete','blocked','superseded')`),index('ix_project_reading_round_pending').on(t.status,t.deadlineAt),
]);

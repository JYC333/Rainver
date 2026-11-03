import {pgTable,varchar,integer,jsonb,timestamp,date,index,unique,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {projects} from './projects.js';
/** Immutable ordered references; text stays in the authorized theme version. */
export const projectReadingCompositions=pgTable('project_reading_compositions',{
 id:varchar({length:36}).primaryKey(),spaceId:varchar('space_id',{length:36}).notNull(),projectId:varchar('project_id',{length:36}).notNull(),
 editionDate:date('edition_date'),timezone:varchar({length:100}),dayRevision:integer('day_revision'),roundsJson:jsonb('rounds_json').notNull().default([]),
 revision:integer().notNull(),previousId:varchar('previous_id',{length:36}),sectionsJson:jsonb('sections_json').notNull(),
 reason:varchar({length:32}).notNull(),createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>[unique('uq_project_reading_day_revision').on(t.spaceId,t.projectId,t.editionDate,t.dayRevision),index('ix_project_reading_day').on(t.spaceId,t.projectId,t.editionDate),check('ck_project_reading_day',sql`(edition_date IS NULL AND timezone IS NULL AND day_revision IS NULL) OR (edition_date IS NOT NULL AND timezone IS NOT NULL AND day_revision IS NOT NULL AND day_revision>0)`),unique('uq_project_reading_composition_revision').on(t.spaceId,t.projectId,t.revision),foreignKey({columns:[t.projectId,t.spaceId],foreignColumns:[projects.id,projects.spaceId]}).onDelete('cascade'),check('ck_project_reading_composition_revision',sql`revision>0`)]);

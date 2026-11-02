import {pgTable,varchar,integer,jsonb,timestamp,unique,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {projects} from './projects.js';
/** Immutable ordered references; text stays in the authorized theme version. */
export const projectReadingCompositions=pgTable('project_reading_compositions',{
 id:varchar({length:36}).primaryKey(),spaceId:varchar('space_id',{length:36}).notNull(),projectId:varchar('project_id',{length:36}).notNull(),
 revision:integer().notNull(),previousId:varchar('previous_id',{length:36}),sectionsJson:jsonb('sections_json').notNull(),
 reason:varchar({length:32}).notNull(),createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull().defaultNow(),
},t=>[unique('uq_project_reading_composition_revision').on(t.spaceId,t.projectId,t.revision),foreignKey({columns:[t.projectId,t.spaceId],foreignColumns:[projects.id,projects.spaceId]}).onDelete('cascade'),check('ck_project_reading_composition_revision',sql`revision>0`)]);

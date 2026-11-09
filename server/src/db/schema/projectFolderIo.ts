import {pgTable,varchar,jsonb,timestamp,index,uniqueIndex,foreignKey,check} from 'drizzle-orm/pg-core';
import {sql} from 'drizzle-orm';
import {spaces} from './spaces.js';
import {users} from './auth.js';
import {projects} from './projects.js';
/** Private Folder import/file-effect intent. Jobs carry only this row's opaque id. */
export const projectFolderIoIntents=pgTable('project_folder_io_intents',{
  id:varchar({length:36}).primaryKey().notNull(),
  spaceId:varchar('space_id',{length:36}).notNull(),
  projectId:varchar('project_id',{length:36}).notNull(),
  userId:varchar('user_id',{length:36}).notNull(),
  folderId:varchar('folder_id',{length:36}),
  kind:varchar({length:24}).notNull(),
  scopeKey:varchar('scope_key',{length:64}).notNull(),
  status:varchar({length:24}).notNull(),
  jobId:varchar('job_id',{length:36}),
  frozenJson:jsonb('frozen_json').notNull(),
  effectJson:jsonb('effect_json').notNull(),
  resultJson:jsonb('result_json'),
  errorCode:varchar('error_code',{length:64}),
  createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
},table=>[
  index('ix_project_folder_io_owner').on(table.spaceId,table.userId,table.projectId,table.createdAt),
  uniqueIndex('uq_project_folder_io_active_scope').on(table.spaceId,table.projectId,table.scopeKey).where(sql`status IN ('pending','prepared','applied')`),
  foreignKey({columns:[table.spaceId],foreignColumns:[spaces.id]}),
  foreignKey({columns:[table.projectId,table.spaceId],foreignColumns:[projects.id,projects.spaceId]}),
  foreignKey({columns:[table.userId],foreignColumns:[users.id]}),
  check('ck_project_folder_io_kind',sql`kind IN ('create','scan','save_draft','restore_revision')`),
  check('ck_project_folder_io_status',sql`status IN ('pending','prepared','applied','succeeded','failed','needs_attention')`),
]);

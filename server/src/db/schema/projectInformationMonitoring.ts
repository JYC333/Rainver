import { pgTable, varchar, integer, jsonb, timestamp, unique, foreignKey, index } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { sourceChannels } from './sourceChannels.js';
import { users } from './auth.js';
export const projectInformationMonitoringVersions = pgTable('project_information_monitoring_versions', {
  id: varchar({
    length: 36
  }).primaryKey().notNull(),
  spaceId: varchar('space_id', {
    length: 36
  }).notNull(),
  projectId: varchar('project_id', {
    length: 36
  }).notNull(),
  version: integer().notNull(),
  configJson: jsonb('config_json').notNull(),
  configHash: varchar('config_hash', {
    length: 64
  }).notNull(),
  queryFingerprint: varchar('query_fingerprint', {
    length: 128
  }).default('').notNull(),
  sourceChannelId: varchar('source_channel_id', {
    length: 36
  }).notNull(),
  backfillPlanId: varchar('backfill_plan_id', {
    length: 36
  }),
  ruleId: varchar('rule_id', {
    length: 36
  }),
  proposalId: varchar('proposal_id', {
    length: 36
  }),
  createdByUserId: varchar('created_by_user_id', {
    length: 36
  }).notNull(),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string'
  }).notNull()
}, t => [unique('uq_project_monitoring_version').on(t.spaceId, t.projectId, t.version), unique('uq_project_monitoring_id_project_space').on(t.id, t.projectId, t.spaceId), index('ix_project_monitoring_channel').on(t.spaceId, t.sourceChannelId), foreignKey({
  columns: [t.projectId, t.spaceId],
  foreignColumns: [projects.id, projects.spaceId]
}).onDelete('cascade'), foreignKey({
  columns: [t.sourceChannelId, t.spaceId],
  foreignColumns: [sourceChannels.id, sourceChannels.spaceId]
}), foreignKey({
  columns: [t.createdByUserId],
  foreignColumns: [users.id]
})]);

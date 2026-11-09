import { pgTable, varchar, text, jsonb, timestamp, uniqueIndex, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { spaces } from './spaces.js';
import { users } from './auth.js';
import { proposals } from './proposals.js';
export const codePatchDecisions = pgTable('code_patch_decisions', {
  id: varchar({
    length: 36
  }).primaryKey().notNull(),
  spaceId: varchar('space_id', {
    length: 36
  }).notNull(),
  proposalId: varchar('proposal_id', {
    length: 36
  }).notNull(),
  userId: varchar('user_id', {
    length: 36
  }).notNull(),
  phase: varchar({
    length: 16
  }).notNull(),
  fingerprint: varchar({
    length: 64
  }).notNull(),
  status: varchar({
    length: 32
  }).notNull(),
  jobId: varchar('job_id', {
    length: 36
  }),
  frozenJson: jsonb('frozen_json').notNull(),
  effectJson: jsonb('effect_json').notNull(),
  resultJson: jsonb('result_json'),
  error: text(),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string'
  }).notNull(),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string'
  }).notNull()
}, t => [uniqueIndex('uq_code_patch_decision_input').on(t.spaceId, t.proposalId, t.phase, t.fingerprint), uniqueIndex('uq_code_patch_decision_active').on(t.spaceId, t.proposalId).where(sql`status IN ('pending','applying','compensating','compensation_failed')`), foreignKey({
  columns: [t.spaceId],
  foreignColumns: [spaces.id]
}), foreignKey({
  columns: [t.proposalId],
  foreignColumns: [proposals.id]
}), foreignKey({
  columns: [t.userId],
  foreignColumns: [users.id]
}), check('ck_code_patch_decision_phase', sql`phase IN ('apply','rollback')`), check('ck_code_patch_decision_status', sql`status IN ('pending','applying','succeeded','failed','compensating','compensation_failed')`)]);

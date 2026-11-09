import { pgTable, varchar, jsonb, integer, timestamp, unique, index, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { spaces } from './spaces.js';
import { proposals } from './proposals.js';
export const operationIdempotency = pgTable('operation_idempotency', {
  id: varchar({
    length: 36
  }).primaryKey().notNull(),
  spaceId: varchar('space_id', {
    length: 36
  }).notNull(),
  principalKind: varchar('principal_kind', {
    length: 16
  }).notNull(),
  principalId: varchar('principal_id', {
    length: 128
  }).notNull(),
  // Tagged encoding distinguishes a personless invocation from all user ids.
  onBehalf: varchar('on_behalf', {
    length: 256
  }).notNull(),
  authorityScopeId: varchar('authority_scope_id', {
    length: 256
  }).notNull(),
  operationId: varchar('operation_id', {
    length: 256
  }).notNull(),
  idempotencyKey: varchar('idempotency_key', {
    length: 256
  }).notNull(),
  operationVersion: integer('operation_version').notNull(),
  fingerprint: varchar({
    length: 64
  }).notNull(),
  state: varchar({
    length: 32
  }).notNull(),
  proposalId: varchar('proposal_id', {
    length: 36
  }),
  frozenJson: jsonb('frozen_json'),
  resultJson: jsonb('result_json'),
  httpStatus: integer('http_status'),
  createdAt: timestamp('created_at', {
    withTimezone: true,
    mode: 'string'
  }).notNull(),
  terminalAt: timestamp('terminal_at', {
    withTimezone: true,
    mode: 'string'
  })
}, t => [unique('uq_operation_request_scope').on(t.spaceId, t.principalKind, t.principalId, t.onBehalf, t.authorityScopeId, t.operationId, t.idempotencyKey), unique('uq_operation_proposal').on(t.proposalId), index('ix_operation_retention').on(t.state, t.terminalAt), foreignKey({
  columns: [t.spaceId],
  foreignColumns: [spaces.id]
}).onDelete('cascade'), foreignKey({
  columns: [t.proposalId, t.spaceId],
  foreignColumns: [proposals.id, proposals.spaceId]
}), check('operation_request_state', sql`${t.state} IN ('pending_approval','succeeded','failed','rejected','expired','superseded')`), check('operation_request_terminal', sql`(${t.state}='pending_approval' AND ${t.terminalAt} IS NULL AND ${t.proposalId} IS NOT NULL) OR (${t.state}<>'pending_approval' AND ${t.terminalAt} IS NOT NULL)`)]);

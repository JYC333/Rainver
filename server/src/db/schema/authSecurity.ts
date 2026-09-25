import {
  pgTable,
  index,
  unique,
  check,
  foreignKey,
  jsonb,
  varchar,
  timestamp,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaceInvitations } from "./spaces.js";

/**
 * Short-lived authority held by a registration flow. The browser receives the
 * raw claim secret once; only its digest is stored here. Provisioning owns the
 * state transition and invitation reservation transaction.
 */
export const registrationIntents = pgTable("registration_intents", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  claimSecretHash: varchar("claim_secret_hash", { length: 128 }).notNull(),
  email: varchar({ length: 256 }).notNull(),
  authority: varchar({ length: 32 }).notNull(),
  invitationId: varchar("invitation_id", { length: 36 }),
  state: varchar({ length: 32 }).notNull(),
  pendingUserId: varchar("pending_user_id", { length: 36 }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
}, (table): PgTableExtraConfigValue[] => [
  unique("uq_registration_intents_claim_secret_hash").on(table.claimSecretHash),
  unique("uq_registration_intents_pending_user").on(table.pendingUserId),
  index("ix_registration_intents_state_expiry").using(
    "btree",
    table.state.asc().nullsLast(),
    table.expiresAt.asc().nullsLast(),
  ),
  index("ix_registration_intents_email").using("btree", table.email.asc().nullsLast()),
  foreignKey({
    columns: [table.invitationId],
    foreignColumns: [spaceInvitations.id],
    name: "registration_intents_invitation_id_fkey",
  }),
  foreignKey({
    columns: [table.pendingUserId],
    foreignColumns: [users.id],
    name: "registration_intents_pending_user_id_fkey",
  }).onDelete("cascade"),
  check("ck_registration_intents_authority", sql`authority IN ('bootstrap', 'space_invitation')`),
  check("ck_registration_intents_state", sql`state IN ('issued', 'claimed', 'provisioning', 'completed', 'expired')`),
  check(
    "ck_registration_intents_invitation_authority",
    sql`(authority = 'space_invitation' AND invitation_id IS NOT NULL) OR (authority = 'bootstrap' AND invitation_id IS NULL)`,
  ),
]);

/** Append-only safe auth telemetry; never put credentials or raw tokens here. */
export const authSecurityEvents = pgTable("auth_security_events", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  actorUserId: varchar("actor_user_id", { length: 36 }),
  subjectUserId: varchar("subject_user_id", { length: 36 }),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  outcome: varchar({ length: 16 }).notNull(),
  requestId: varchar("request_id", { length: 128 }),
  sourceIp: varchar("source_ip", { length: 128 }),
  detailsJson: jsonb("details_json").default({}).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  index("ix_auth_security_events_occurred_at").using("btree", table.occurredAt.desc()),
  index("ix_auth_security_events_subject").using(
    "btree",
    table.subjectUserId.asc().nullsLast(),
    table.occurredAt.desc(),
  ),
  foreignKey({
    columns: [table.actorUserId],
    foreignColumns: [users.id],
    name: "auth_security_events_actor_user_id_fkey",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.subjectUserId],
    foreignColumns: [users.id],
    name: "auth_security_events_subject_user_id_fkey",
  }).onDelete("set null"),
  check("ck_auth_security_events_outcome", sql`outcome IN ('success', 'failure', 'throttled', 'degraded')`),
]);

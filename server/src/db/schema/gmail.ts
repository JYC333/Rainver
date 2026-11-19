import { pgTable, index, unique, uniqueIndex, check, foreignKey, primaryKey, varchar, integer, boolean, jsonb, text, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { credentials } from "./providers.js";
import { projects } from "./projects.js";
import { messages, sessions } from "./sessions.js";
import { agents } from "./agents.js";
import { runs } from "./runs.js";
import { proposals } from "./proposals.js";

/**
 * A person's private Gmail connection (`.agent/modules/sources.md`, "Personal
 * Gmail connections"). Not a SourceConnection: no visibility column, no
 * catalog connector, owner-only service. One row per owner + Space + Google
 * account (`google_subject` = OIDC `sub`); reconnecting the same account
 * reuses the row, another account is another row. An `active` row always has
 * its `gmail_oauth` credential and every other status has none.
 */
export const gmailConnections = pgTable("gmail_connections", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	googleSubject: varchar("google_subject", { length: 255 }).notNull(),
	mailboxEmail: varchar("mailbox_email", { length: 320 }).notNull(),
	credentialId: varchar("credential_id", { length: 36 }),
	status: varchar({ length: 32 }).notNull(),
	generation: integer().notNull(),
	grantedScopes: jsonb("granted_scopes").notNull(),
	lastErrorClass: varchar("last_error_class", { length: 32 }),
	connectedAt: timestamp("connected_at", { withTimezone: true, mode: 'string' }).notNull(),
	disconnectedAt: timestamp("disconnected_at", { withTimezone: true, mode: 'string' }),
	/**
	 * The owner's opt-in that their own private Project conversations may offer
	 * an Agent the on-demand mail read (ADR 0032/0033). Off by default; reads
	 * still need the owner's standing consent for each Project, and turning it
	 * off ends every such consent.
	 */
	agentReadEnabled: boolean("agent_read_enabled").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_gmail_connections_owner_space").using("btree", table.ownerUserId.asc().nullsLast(), table.spaceId.asc().nullsLast()),
	unique("uq_gmail_connections_owner_subject").on(table.spaceId, table.ownerUserId, table.googleSubject),
	unique("uq_gmail_connections_credential").on(table.credentialId),
	unique("uq_gmail_connections_id_space_owner").on(table.id, table.spaceId, table.ownerUserId),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "gmail_connections_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "gmail_connections_owner_user_id_fkey" }).onDelete("cascade"),
	// No ON DELETE action: a writer clears the link (and the status) before deleting the credential.
	foreignKey({ columns: [table.credentialId], foreignColumns: [credentials.id], name: "gmail_connections_credential_id_fkey" }),
	check("ck_gmail_connections_status", sql`status IN ('active', 'reauth_required', 'disconnected')`),
	check("ck_gmail_connections_credential_status", sql`(status = 'active') = (credential_id IS NOT NULL)`),
	check("ck_gmail_connections_generation", sql`generation >= 1`),
	check("ck_gmail_connections_scopes", sql`jsonb_typeof(granted_scopes) = 'array'`),
	check("ck_gmail_connections_error_class", sql`last_error_class IS NULL OR last_error_class IN ('transient', 'invalid_grant', 'scope', 'uncertain')`),
	check("ck_gmail_connections_subject", sql`google_subject ~ '^[!-~]{1,255}$'`),
]);

/**
 * One OAuth authorization attempt: single-use, expiring, bound to the person
 * and Space that started it. Only the SHA-256 of `state` is stored; the PKCE
 * verifier is derived from the state with a server key and never stored, and
 * the authorization code is never persisted.
 *
 * `reconnect_generation` binds a reconnect to the target's generation at start.
 * Installation locks the (consumed) attempt row and requires it still exists:
 * a disconnect deletes the owner's attempts in that Space, and a successful
 * install deletes the owner's other attempts there, so an older or paused
 * callback can never reinstall a credential.
 */
export const gmailOauthAttempts = pgTable("gmail_oauth_attempts", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	stateSha256: varchar("state_sha256", { length: 64 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	reconnectConnectionId: varchar("reconnect_connection_id", { length: 36 }),
	reconnectGeneration: integer("reconnect_generation"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_gmail_oauth_attempts_state").on(table.stateSha256),
	index("ix_gmail_oauth_attempts_user_expires").using("btree", table.userId.asc().nullsLast(), table.expiresAt.asc().nullsLast()),
	index("ix_gmail_oauth_attempts_expires").using("btree", table.expiresAt.asc().nullsLast()),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "gmail_oauth_attempts_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.userId], foreignColumns: [users.id], name: "gmail_oauth_attempts_user_id_fkey" }).onDelete("cascade"),
	// A forgotten connection's pending reconnect cannot complete.
	foreignKey({ columns: [table.reconnectConnectionId], foreignColumns: [gmailConnections.id], name: "gmail_oauth_attempts_reconnect_connection_id_fkey" }).onDelete("cascade"),
	check("ck_gmail_oauth_attempts_state_sha256", sql`state_sha256 ~ '^[0-9a-f]{64}$'`),
	check("ck_gmail_oauth_attempts_reconnect_generation", sql`(reconnect_connection_id IS NULL) = (reconnect_generation IS NULL)`),
]);

/**
 * The owner's selection of one Gmail thread for one Project: a reference only
 * (no subject, snippet, address or body), visible to its owner alone even in a
 * shared Project. Google ids are scoped by connection (one Google account), never
 * deduplicated across connections. `read_after`/`read_before` bound which of the
 * thread's messages a read returns (null = unbounded side).
 */
export const gmailProjectThreadSelections = pgTable("gmail_project_thread_selections", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	gmailConnectionId: varchar("gmail_connection_id", { length: 36 }).notNull(),
	googleThreadId: varchar("google_thread_id", { length: 64 }).notNull(),
	readAfter: timestamp("read_after", { withTimezone: true, mode: 'string' }),
	readBefore: timestamp("read_before", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_gmail_thread_selections_connection_project_thread").on(table.gmailConnectionId, table.projectId, table.googleThreadId),
	index("ix_gmail_thread_selections_owner_project").using("btree", table.ownerUserId.asc().nullsLast(), table.projectId.asc().nullsLast()),
	foreignKey({ columns: [table.gmailConnectionId, table.spaceId, table.ownerUserId], foreignColumns: [gmailConnections.id, gmailConnections.spaceId, gmailConnections.ownerUserId], name: "gmail_thread_selections_connection_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "gmail_thread_selections_project_fkey" }).onDelete("cascade"),
	check("ck_gmail_thread_selections_thread_id", sql`google_thread_id ~ '^[0-9a-f]{1,64}$'`),
	check("ck_gmail_thread_selections_window", sql`read_after IS NULL OR read_before IS NULL OR read_after < read_before`),
]);

/**
 * Owner-read audit of released Gmail content (search results or a thread page).
 * Not `content_access_logs` (B11 records only cross-person reads; its CHECK
 * forbids viewer = owner). Ids, counts and flags only: never query text,
 * headers, snippets or bodies. One row commits before any content is serialized.
 */
export const gmailReadAuditEvents = pgTable("gmail_read_audit_events", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	actorUserId: varchar("actor_user_id", { length: 36 }).notNull(),
	gmailConnectionId: varchar("gmail_connection_id", { length: 36 }),
	projectId: varchar("project_id", { length: 36 }),
	selectionId: varchar("selection_id", { length: 36 }),
	operation: varchar({ length: 32 }).notNull(),
	googleThreadId: varchar("google_thread_id", { length: 64 }),
	itemCount: integer("item_count").notNull(),
	truncated: boolean().notNull(),
	requestId: varchar("request_id", { length: 128 }).notNull(),
	/** An Agent read on the owner's behalf (ADR 0032): the Run and Agent that read; null for the owner's own read. */
	runId: varchar("run_id", { length: 36 }),
	agentId: varchar("agent_id", { length: 36 }),
	accessedAt: timestamp("accessed_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_gmail_read_audit_owner_accessed").using("btree", table.ownerUserId.asc().nullsLast(), table.spaceId.asc().nullsLast(), table.accessedAt.asc().nullsLast()),
	index("ix_gmail_read_audit_accessed").using("btree", table.accessedAt.asc().nullsLast()),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "gmail_read_audit_events_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "gmail_read_audit_events_owner_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.gmailConnectionId], foreignColumns: [gmailConnections.id], name: "gmail_read_audit_events_connection_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "gmail_read_audit_events_project_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.selectionId], foreignColumns: [gmailProjectThreadSelections.id], name: "gmail_read_audit_events_selection_id_fkey" }).onDelete("set null"),
	// The owner is always the actor: an Agent reads only on the owner's behalf, recorded with its Run (ADR 0032).
	check("ck_gmail_read_audit_actor_owner", sql`actor_user_id = owner_user_id`),
	check("ck_gmail_read_audit_operation", sql`operation IN ('thread_search', 'thread_read', 'agent_read', 'digest_read')`),
	check("ck_gmail_read_audit_agent_run", sql`(operation IN ('agent_read', 'digest_read')) = (run_id IS NOT NULL) AND (run_id IS NULL) = (agent_id IS NULL)`),
	check("ck_gmail_read_audit_item_count", sql`item_count >= 0`),
	check("ck_gmail_read_audit_thread_id", sql`google_thread_id IS NULL OR google_thread_id ~ '^[0-9a-f]{1,64}$'`),
]);

/**
 * Gmail V2 new-mail monitoring: the owner's private rule. Matched by the
 * server against new mail's headers in memory; no subject, sender or text is
 * stored. `project_id` is an optional *context* label (SET NULL when the
 * Project goes away), never an audience: no Project member but the owner can
 * see it. Created only by the owner accepting a `gmail_monitor_create`
 * proposal; `active_since` is that acceptance time — older mail never matches.
 */
export const gmailMonitorRules = pgTable("gmail_monitor_rules", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	gmailConnectionId: varchar("gmail_connection_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }),
	purpose: varchar({ length: 280 }).notNull(),
	criteria: jsonb().notNull(),
	status: varchar({ length: 16 }).notNull(),
	activeSince: timestamp("active_since", { withTimezone: true, mode: 'string' }).notNull(),
	proposalId: varchar("proposal_id", { length: 36 }),
	matchCount: integer("match_count").notNull(),
	lastMatchedAt: timestamp("last_matched_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_gmail_monitor_rules_owner_space").using("btree", table.ownerUserId.asc().nullsLast(), table.spaceId.asc().nullsLast()),
	index("ix_gmail_monitor_rules_connection_status").using("btree", table.gmailConnectionId.asc().nullsLast(), table.status.asc().nullsLast()),
	unique("uq_gmail_monitor_rules_proposal").on(table.proposalId),
	foreignKey({ columns: [table.gmailConnectionId, table.spaceId, table.ownerUserId], foreignColumns: [gmailConnections.id, gmailConnections.spaceId, gmailConnections.ownerUserId], name: "gmail_monitor_rules_connection_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "gmail_monitor_rules_project_id_fkey" }).onDelete("set null"),
	check("ck_gmail_monitor_rules_status", sql`status IN ('active', 'paused')`),
	check("ck_gmail_monitor_rules_criteria", sql`jsonb_typeof(criteria) = 'object'`),
	check("ck_gmail_monitor_rules_match_count", sql`match_count >= 0`),
	check("ck_gmail_monitor_rules_purpose", sql`length(btrim(purpose)) > 0`),
]);

/**
 * The one persisted Gmail history cursor per connection, shared by push and
 * scheduled checks. `history_id` only moves forward (numeric compare under the
 * lease). `baseline` means no cursor yet (first enable: the current mailbox
 * position is taken and only mail since the monitor was accepted is checked);
 * `recovering` means Google expired the cursor and a bounded `after:` scan
 * from `recovery_after` runs before history resumes. The lease serializes
 * syncs; `sync_requested_at` is a push or follow-up waiting for the next one.
 */
export const gmailMailboxSyncStates = pgTable("gmail_mailbox_sync_states", {
	gmailConnectionId: varchar("gmail_connection_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	historyId: varchar("history_id", { length: 32 }),
	state: varchar({ length: 16 }).notNull(),
	recoveryAfter: timestamp("recovery_after", { withTimezone: true, mode: 'string' }),
	recoveryPartial: boolean("recovery_partial").notNull(),
	leaseId: varchar("lease_id", { length: 36 }),
	leaseUntil: timestamp("lease_until", { withTimezone: true, mode: 'string' }),
	syncRequestedAt: timestamp("sync_requested_at", { withTimezone: true, mode: 'string' }),
	nextPollAt: timestamp("next_poll_at", { withTimezone: true, mode: 'string' }).notNull(),
	lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: 'string' }),
	lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: 'string' }),
	failureCount: integer("failure_count").notNull(),
	lastErrorCode: varchar("last_error_code", { length: 64 }),
	watchExpiresAt: timestamp("watch_expires_at", { withTimezone: true, mode: 'string' }),
	watchCheckedAt: timestamp("watch_checked_at", { withTimezone: true, mode: 'string' }),
	lastPushAt: timestamp("last_push_at", { withTimezone: true, mode: 'string' }),
	/** In-record progress: a history record holding more new mail than one sync reads. The cursor stays before it until it is done. */
	recordHistoryId: varchar("record_history_id", { length: 32 }),
	recordOffset: integer("record_offset").default(0).notNull(),
	/** Durable retry floor after a failure: neither a push, a monitor change nor the schedule starts a sync before it. */
	retryNotBefore: timestamp("retry_not_before", { withTimezone: true, mode: 'string' }),
	/** `users.watch` renewal, recorded apart from the sync result. */
	watchErrorCode: varchar("watch_error_code", { length: 64 }),
	watchRetryAt: timestamp("watch_retry_at", { withTimezone: true, mode: 'string' }),
	watchFailureCount: integer("watch_failure_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_gmail_mailbox_sync_due").using("btree", table.nextPollAt.asc().nullsLast()),
	foreignKey({ columns: [table.gmailConnectionId, table.spaceId, table.ownerUserId], foreignColumns: [gmailConnections.id, gmailConnections.spaceId, gmailConnections.ownerUserId], name: "gmail_mailbox_sync_states_connection_fkey" }).onDelete("cascade"),
	check("ck_gmail_mailbox_sync_state", sql`state IN ('baseline', 'ok', 'recovering')`),
	check("ck_gmail_mailbox_sync_history_id", sql`history_id IS NULL OR history_id ~ '^[0-9]{1,20}$'`),
	check("ck_gmail_mailbox_sync_cursor", sql`state = 'baseline' OR history_id IS NOT NULL`),
	check("ck_gmail_mailbox_sync_recovery", sql`(state = 'recovering') = (recovery_after IS NOT NULL)`),
	check("ck_gmail_mailbox_sync_lease", sql`(lease_id IS NULL) = (lease_until IS NULL)`),
	check("ck_gmail_mailbox_sync_failures", sql`failure_count >= 0`),
	check("ck_gmail_mailbox_sync_error_code", sql`last_error_code IS NULL OR last_error_code ~ '^gmail_[a-z_]{1,58}$'`),
	check("ck_gmail_mailbox_sync_record", sql`(record_history_id IS NULL AND record_offset = 0) OR (record_history_id ~ '^[0-9]{1,20}$' AND record_offset > 0)`),
	check("ck_gmail_mailbox_sync_watch_error_code", sql`watch_error_code IS NULL OR watch_error_code ~ '^gmail_[a-z_]{1,58}$'`),
	check("ck_gmail_mailbox_sync_watch_failures", sql`watch_failure_count >= 0`),
]);

/**
 * Persisted dedup of reminders: one row per (monitor, Gmail message) the
 * monitor matched. Ids only. A replayed push, an overlapping recovery scan or
 * a retried sync inserts nothing new, so each message reminds at most once per
 * monitor. Pruned after the retention window (older than any overlap).
 */
export const gmailMonitorMatches = pgTable("gmail_monitor_matches", {
	ruleId: varchar("rule_id", { length: 36 }).notNull(),
	googleMessageId: varchar("google_message_id", { length: 64 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	matchedAt: timestamp("matched_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	primaryKey({ columns: [table.ruleId, table.googleMessageId], name: "gmail_monitor_matches_pkey" }),
	index("ix_gmail_monitor_matches_owner_matched").using("btree", table.ownerUserId.asc().nullsLast(), table.spaceId.asc().nullsLast(), table.matchedAt.asc().nullsLast()),
	index("ix_gmail_monitor_matches_matched").using("btree", table.matchedAt.asc().nullsLast()),
	foreignKey({ columns: [table.ruleId], foreignColumns: [gmailMonitorRules.id], name: "gmail_monitor_matches_rule_id_fkey" }).onDelete("cascade"),
	check("ck_gmail_monitor_matches_message_id", sql`google_message_id ~ '^[0-9a-f]{1,64}$'`),
]);

/**
 * ADR 0033 phase B: the owner's scheduled private Gmail digest. Created only
 * by the owner accepting a `gmail_digest_create` proposal in their private
 * Project conversation (`session_id`, where every digest is delivered). Its
 * authority is the owner's `plugin_data_grants` row (`grant_id`, purpose
 * `daily_digest`/`rule_digest`, bound to the Project, connection and its
 * generation): when that consent ends — revoke, opt-out, disconnect,
 * reconnect, re-authorization, leaving the Project, account disable — the
 * digest stops. `covered_until` is where the next daily window starts (the
 * end of the last delivered one) or since when rule matches count; it moves
 * only when a delivery succeeds, so a failure never skips mail.
 */
export const gmailDigests = pgTable("gmail_digests", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	gmailConnectionId: varchar("gmail_connection_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	grantId: varchar("grant_id", { length: 36 }),
	proposalId: varchar("proposal_id", { length: 36 }).notNull(),
	kind: varchar({ length: 16 }).notNull(),
	localTime: varchar("local_time", { length: 5 }),
	timeZone: varchar("time_zone", { length: 64 }),
	status: varchar({ length: 16 }).notNull(),
	coveredUntil: timestamp("covered_until", { withTimezone: true, mode: 'string' }).notNull(),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }),
	retryNotBefore: timestamp("retry_not_before", { withTimezone: true, mode: 'string' }),
	failureCount: integer("failure_count").default(0).notNull(),
	lastErrorCode: varchar("last_error_code", { length: 64 }),
	lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true, mode: 'string' }),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_gmail_digests_owner_space").using("btree", table.ownerUserId.asc().nullsLast(), table.spaceId.asc().nullsLast()),
	index("ix_gmail_digests_due").using("btree", table.status.asc().nullsLast(), table.nextRunAt.asc().nullsLast()),
	unique("uq_gmail_digests_proposal").on(table.proposalId),
	// One live digest of a kind per mailbox and Project; its consent's own unique index says the same.
	uniqueIndex("uq_gmail_digests_live").on(table.gmailConnectionId, table.projectId, table.kind).where(sql`status <> 'ended'`),
	foreignKey({ columns: [table.gmailConnectionId, table.spaceId, table.ownerUserId], foreignColumns: [gmailConnections.id, gmailConnections.spaceId, gmailConnections.ownerUserId], name: "gmail_digests_connection_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "gmail_digests_project_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.sessionId, table.spaceId], foreignColumns: [sessions.id, sessions.spaceId], name: "gmail_digests_session_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.agentId], foreignColumns: [agents.id], name: "gmail_digests_agent_id_fkey" }).onDelete("cascade"),
	check("ck_gmail_digests_kind", sql`kind IN ('daily', 'rule')`),
	check("ck_gmail_digests_status", sql`status IN ('active', 'paused', 'ended')`),
	check("ck_gmail_digests_ended", sql`(status = 'ended') = (ended_at IS NOT NULL)`),
	check("ck_gmail_digests_local_time", sql`(kind = 'daily' AND local_time IS NOT NULL AND time_zone IS NOT NULL AND local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') OR (kind = 'rule' AND local_time IS NULL AND time_zone IS NULL)`),
	check("ck_gmail_digests_failures", sql`failure_count >= 0`),
	check("ck_gmail_digests_error_code", sql`last_error_code IS NULL OR last_error_code ~ '^gmail_[a-z_]{1,58}$'`),
]);

/**
 * One delivery attempt of a digest: the window (daily) or the frozen matched
 * message ids (rule) its Run reads, and how it ended. Ids and counts only.
 * At most one runs per digest; a failed one is retried with the same window.
 */
export const gmailDigestDeliveries = pgTable("gmail_digest_deliveries", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	digestId: varchar("digest_id", { length: 36 }).notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	windowStart: timestamp("window_start", { withTimezone: true, mode: 'string' }).notNull(),
	windowEnd: timestamp("window_end", { withTimezone: true, mode: 'string' }).notNull(),
	gapBefore: boolean("gap_before").notNull(),
	messageIds: jsonb("message_ids"),
	runId: varchar("run_id", { length: 36 }),
	status: varchar({ length: 16 }).notNull(),
	messageCount: integer("message_count").default(0).notNull(),
	/** A released read reached the end of the window (or of the frozen ids): nothing of it was left unread. */
	readComplete: boolean("read_complete").default(false).notNull(),
	errorCode: varchar("error_code", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_gmail_digest_deliveries_digest").using("btree", table.digestId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ix_gmail_digest_deliveries_run").using("btree", table.runId.asc().nullsLast()),
	uniqueIndex("uq_gmail_digest_deliveries_running").on(table.digestId).where(sql`status = 'running'`),
	foreignKey({ columns: [table.digestId], foreignColumns: [gmailDigests.id], name: "gmail_digest_deliveries_digest_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.runId], foreignColumns: [runs.id], name: "gmail_digest_deliveries_run_id_fkey" }).onDelete("set null"),
	check("ck_gmail_digest_deliveries_status", sql`status IN ('running', 'delivered', 'failed')`),
	check("ck_gmail_digest_deliveries_window", sql`window_start <= window_end`),
	check("ck_gmail_digest_deliveries_ids", sql`message_ids IS NULL OR jsonb_typeof(message_ids) = 'array'`),
	check("ck_gmail_digest_deliveries_finished", sql`(status = 'running') = (finished_at IS NULL)`),
	check("ck_gmail_digest_deliveries_count", sql`message_count >= 0`),
	check("ck_gmail_digest_deliveries_error_code", sql`error_code IS NULL OR error_code ~ '^gmail_[a-z_]{1,58}$'`),
]);

/** Rule digests: each matched message is delivered once per digest. Ids only; pruned with the match ledger. */
export const gmailDigestItems = pgTable("gmail_digest_items", {
	digestId: varchar("digest_id", { length: 36 }).notNull(),
	googleMessageId: varchar("google_message_id", { length: 64 }).notNull(),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	primaryKey({ columns: [table.digestId, table.googleMessageId], name: "gmail_digest_items_pkey" }),
	index("ix_gmail_digest_items_delivered").using("btree", table.deliveredAt.asc().nullsLast()),
	foreignKey({ columns: [table.digestId], foreignColumns: [gmailDigests.id], name: "gmail_digest_items_digest_id_fkey" }).onDelete("cascade"),
	check("ck_gmail_digest_items_message_id", sql`google_message_id ~ '^[0-9a-f]{1,64}$'`),
]);

/**
 * One owner-only Gmail check asked for in a shared conversation of a Project
 * (a Room or the Project mainline; ADR 0033 §6). It is the server-side,
 * one-time execution context of that request: bound to the person's original
 * message (its author is the owner), the conversation it was asked in, the
 * Project, one mailbox at its generation and the owner-only card
 * (`proposal_id`) shown on the shared Run's reply. It runs at most one
 * Session-less, owner-only Run (`run_id`, set once), whose CLI profile and cwd
 * are that Run's own (`container_kind = 'run'`), never the conversation's.
 * The Run's answer is delivered here, readable only by the owner while they
 * can still read the original message; the shared conversation, its Runs and
 * its other readers never receive it.
 *
 * `gmail_connection_id` is a snapshot like a consent's: forgetting the
 * connection keeps the history and the check never admits again.
 */
export const gmailPrivateChecks = pgTable("gmail_private_checks", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	gmailConnectionId: varchar("gmail_connection_id", { length: 36 }).notNull(),
	connectionGeneration: integer("connection_generation").notNull(),
	sourceSessionId: varchar("source_session_id", { length: 36 }).notNull(),
	sourceMessageId: varchar("source_message_id", { length: 36 }).notNull(),
	sourceRunId: varchar("source_run_id", { length: 36 }).notNull(),
	agentId: varchar("agent_id", { length: 36 }).notNull(),
	proposalId: varchar("proposal_id", { length: 36 }).notNull(),
	grantId: varchar("grant_id", { length: 36 }),
	runId: varchar("run_id", { length: 36 }),
	status: varchar({ length: 24 }).notNull(),
	resultText: text("result_text"),
	errorCode: varchar("error_code", { length: 64 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_gmail_private_checks_owner_space").using("btree", table.ownerUserId.asc().nullsLast(), table.spaceId.asc().nullsLast()),
	index("ix_gmail_private_checks_running").using("btree", table.status.asc().nullsLast()).where(sql`status = 'running'`),
	unique("uq_gmail_private_checks_proposal").on(table.proposalId),
	// One check per shared turn: a replay of the tool returns it.
	unique("uq_gmail_private_checks_source_run").on(table.sourceRunId),
	// Its one Run, set once.
	unique("uq_gmail_private_checks_run").on(table.runId),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "gmail_private_checks_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "gmail_private_checks_owner_user_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId, table.spaceId], foreignColumns: [projects.id, projects.spaceId], name: "gmail_private_checks_project_fkey" }).onDelete("cascade"),
	// The original message goes, and the answer with it.
	foreignKey({ columns: [table.sourceMessageId, table.spaceId, table.sourceSessionId], foreignColumns: [messages.id, messages.spaceId, messages.sessionId], name: "gmail_private_checks_message_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.proposalId], foreignColumns: [proposals.id], name: "gmail_private_checks_proposal_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.agentId], foreignColumns: [agents.id], name: "gmail_private_checks_agent_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.runId], foreignColumns: [runs.id], name: "gmail_private_checks_run_id_fkey" }).onDelete("set null"),
	check("ck_gmail_private_checks_status", sql`status IN ('awaiting_consent', 'running', 'delivered', 'failed', 'declined')`),
	check("ck_gmail_private_checks_result", sql`(status = 'delivered') = (result_text IS NOT NULL)`),
	check("ck_gmail_private_checks_started", sql`run_id IS NULL OR started_at IS NOT NULL`),
	check("ck_gmail_private_checks_finished", sql`(status IN ('delivered', 'failed', 'declined')) = (finished_at IS NOT NULL)`),
	check("ck_gmail_private_checks_generation", sql`connection_generation >= 1`),
	check("ck_gmail_private_checks_error_code", sql`error_code IS NULL OR error_code ~ '^gmail_[a-z_]{1,58}$'`),
]);

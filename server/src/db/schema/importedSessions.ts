import {
	pgTable,
	index,
	unique,
	check,
	foreignKey,
	varchar,
	text,
	integer,
	boolean,
	jsonb,
	timestamp,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { projects } from "./projects.js";
import { projectFolders } from "./projectFolders.js";
import { hosts } from "./hosts.js";
import { workspaceLocations } from "./workspaceLocations.js";

/**
 * Sessions a person had with their own coding CLI in a folder, outside
 * Rainver, imported from a paired execution host
 * (`.agent/modules/imported-sessions.md`).
 *
 * This is an independent root entity, not a `space_objects` row: an imported
 * session participates in no cross-domain semantic relation and is only ever
 * cited as provenance. It is registered as a content resource so the one
 * canonical read gate filters it like everything else.
 *
 * The source is never mirrored. A row here outlives the session on the host:
 * the vendor deletes sessions on its own schedule, and an import that
 * vanished with its source would be an archive that erases itself.
 */
export const importedSessions = pgTable("imported_sessions", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	projectId: varchar("project_id", { length: 36 }).notNull(),
	/**
	 * Null once the Folder's registration row is removed. Unregistering a
	 * folder is documented as removing only Rainver's record of it — it must
	 * not take the imported history with it, for the same reason unbinding a
	 * Location does not. The Project remains, and it is the Project that owns
	 * this.
	 */
	projectFolderId: varchar("project_folder_id", { length: 36 }),
	/**
	 * Where the import came from, and null once that Location is unregistered.
	 * An imported session belongs to the Project, not to the checkout it was
	 * read from: unbinding a folder stops future syncs, it does not destroy
	 * the history — which by then may be the only copy, since the vendor
	 * deletes its own sessions on its own schedule.
	 */
	workspaceLocationId: varchar("workspace_location_id", { length: 36 }),
	executionHostId: varchar("execution_host_id", { length: 36 }),
	/** The host owner: the only person who may import from that machine (ADR 0016). */
	ownerUserId: varchar("owner_user_id", { length: 36 }).notNull(),
	adapterType: varchar("adapter_type", { length: 64 }).notNull(),
	/** `own` or `managed:<version>` — the copy whose login the session lives in. */
	installation: varchar({ length: 64 }).notNull(),
	/** The runtime's own opaque session id, in its own format. */
	vendorSessionId: varchar("vendor_session_id", { length: 256 }).notNull(),
	/** As the host reported it; the control plane never resolves a remote path. */
	cwd: varchar({ length: 1024 }),
	title: varchar({ length: 512 }),
	visibility: varchar({ length: 32 }).default('space_shared').notNull(),
	accessLevel: varchar("access_level", { length: 16 }).default('full').notNull(),
	/**
	 * Whether the session was still on the host at the last sync. A gone
	 * session keeps every record it contributed; the state is information for
	 * the reader, not an error and not a reason to delete.
	 */
	sourceState: varchar("source_state", { length: 16 }).default('present').notNull(),
	/** `partial` when a replay failed part way; the next sync retries it. */
	loadState: varchar("load_state", { length: 16 }).default('complete').notNull(),
	lastError: text("last_error"),
	recordCount: integer("record_count").default(0).notNull(),
	firstRecordAt: timestamp("first_record_at", { withTimezone: true, mode: 'string' }),
	lastRecordAt: timestamp("last_record_at", { withTimezone: true, mode: 'string' }),
	vendorUpdatedAt: timestamp("vendor_updated_at", { withTimezone: true, mode: 'string' }),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	lastSeenOnHostAt: timestamp("last_seen_on_host_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_imported_sessions_project_id").using("btree", table.projectId.asc().nullsLast()),
	index("ix_imported_sessions_location_id").using("btree", table.workspaceLocationId.asc().nullsLast()),
	index("ix_imported_sessions_owner_user_id").using("btree", table.ownerUserId.asc().nullsLast()),
	index("ix_imported_sessions_space_last_record").using("btree", table.spaceId.asc().nullsLast(), table.lastRecordAt.desc().nullsLast()),
	// Identity is the copy plus the runtime's own id: the same session id from
	// two installations is two sessions, and re-importing the same one twice
	// must land on the same row rather than a duplicate.
	unique("uq_imported_sessions_source").on(table.workspaceLocationId, table.adapterType, table.installation, table.vendorSessionId),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "imported_sessions_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectId], foreignColumns: [projects.id], name: "imported_sessions_project_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.projectFolderId], foreignColumns: [projectFolders.id], name: "imported_sessions_project_folder_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.workspaceLocationId], foreignColumns: [workspaceLocations.id], name: "imported_sessions_workspace_location_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.executionHostId], foreignColumns: [hosts.id], name: "imported_sessions_execution_host_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [users.id], name: "imported_sessions_owner_user_id_fkey" }).onDelete("cascade"),
	check("ck_imported_sessions_visibility", sql`(visibility)::text = ANY (ARRAY[('private'::character varying)::text, ('space_shared'::character varying)::text, ('selected_users'::character varying)::text])`),
	// `metadata` is excluded deliberately: the content gate admits only `full`
	// and `summary`, so a row stored at `metadata` would be invisible to
	// everyone including its owner.
	check("ck_imported_sessions_access_level", sql`(access_level)::text = ANY (ARRAY[('full'::character varying)::text, ('summary'::character varying)::text])`),
	check("ck_imported_sessions_source_state", sql`(source_state)::text = ANY (ARRAY[('present'::character varying)::text, ('gone'::character varying)::text])`),
	check("ck_imported_sessions_load_state", sql`(load_state)::text = ANY (ARRAY[('complete'::character varying)::text, ('partial'::character varying)::text])`),
]);

/**
 * One trimmed record: a whole message, or a whole tool call with its result.
 *
 * Sync is a set reconciliation, not a cursor advance: ambient sources are
 * rewritten by resume, split by compaction, and forked by rewind, so any
 * "everything after position N" bookmark is wrong the first time a person
 * uses their own CLI normally. Identity is `(session, record_key)` and
 * `content_hash` decides sameness. A record that comes back different is
 * never overwritten — `conflict_hash` records that the source disagreed with
 * what was imported, and the first import stays authoritative.
 */
export const importedSessionRecords = pgTable("imported_session_records", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	importedSessionId: varchar("imported_session_id", { length: 36 }).notNull(),
	/** The runtime's message or tool-call id; unique only within its session. */
	recordKey: varchar("record_key", { length: 256 }).notNull(),
	contentHash: varchar("content_hash", { length: 128 }).notNull(),
	conflictHash: varchar("conflict_hash", { length: 128 }),
	kind: varchar({ length: 32 }).notNull(),
	sequence: integer().notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }),
	text: text(),
	toolName: varchar("tool_name", { length: 256 }),
	toolStatus: varchar("tool_status", { length: 64 }),
	toolInput: text("tool_input"),
	toolOutput: text("tool_output"),
	/** Set only for `unknown` kinds, so a later parser version can re-derive them. */
	rawJson: jsonb("raw_json"),
	truncated: boolean().default(false).notNull(),
	parserVersion: varchar("parser_version", { length: 64 }).notNull(),
	/**
	 * The extraction that has read this record.
	 *
	 * `claim:<id>` while an extraction holds it and has not yet produced its
	 * proposals, then the bare id once they exist. The two are distinguishable
	 * on purpose: an extraction whose process dies between the two would
	 * otherwise leave records marked read, referenced by nothing, and
	 * invisible to every future extraction with no way back short of SQL.
	 */
	extractedIn: varchar("extracted_in", { length: 48 }),
	extractedAt: timestamp("extracted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	unique("uq_imported_session_records_key").on(table.importedSessionId, table.recordKey),
	index("ix_imported_session_records_session_sequence").using("btree", table.importedSessionId.asc().nullsLast(), table.sequence.asc().nullsLast()),
	// Phase 2 selects unextracted records across a Project; the partial index
	// keeps that from scanning every record ever imported.
	index("ix_imported_session_records_unextracted").using("btree", table.spaceId.asc().nullsLast(), table.importedSessionId.asc().nullsLast()).where(sql`extracted_in IS NULL`),
	foreignKey({ columns: [table.spaceId], foreignColumns: [spaces.id], name: "imported_session_records_space_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.importedSessionId], foreignColumns: [importedSessions.id], name: "imported_session_records_imported_session_id_fkey" }).onDelete("cascade"),
	check("ck_imported_session_records_kind", sql`(kind)::text = ANY (ARRAY[('user_message'::character varying)::text, ('agent_message'::character varying)::text, ('tool_call'::character varying)::text, ('plan'::character varying)::text, ('unknown'::character varying)::text])`),
]);

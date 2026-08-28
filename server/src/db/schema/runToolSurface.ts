import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { runs } from "./runs.js";
import { spaces } from "./spaces.js";
import { tasks } from "./tasks.js";

/**
 * The identity a dispatched agent presents when it calls back into Rainver.
 *
 * Durable rather than in-process because the caller outlives this process: a
 * remote run's CLI keeps running across a server restart, and an identity held
 * only in a `Map` would come back unrecognized — the agent would lose its tool
 * surface mid-run with no way to re-acquire one. Only the SHA-256 digest is
 * stored, so a database read cannot recover a live token.
 *
 * One row per Run: an identity is issued once at launch and revoked when the
 * Run reaches a terminal state, which is also when its lease is revoked.
 */
export const runToolIdentities = pgTable("run_tool_identities", {
	runId: varchar("run_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	/** Hex SHA-256 of the bearer token. The token itself is never stored. */
	tokenDigest: varchar("token_digest", { length: 64 }).notNull(),
	/**
	 * Which Skill text this Run was given, as a content hash. The Skill changes
	 * what an agent does the way a prompt does, so explaining the Run later has
	 * to be able to name the exact text it saw; the content is code, versioned
	 * by git, so the hash identifies it without storing a copy per Run.
	 */
	skillContentHash: varchar("skill_content_hash", { length: 64 }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_tool_identities_space_id").using("btree", table.spaceId.asc().nullsLast()),
	unique("uq_run_tool_identities_token_digest").on(table.tokenDigest),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_tool_identities_run_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_tool_identities_space_id_fkey"
		}),
]);

/**
 * What a Run said one of the files it will leave behind actually is.
 *
 * Settlement closes a Task only when every entry of its
 * `required_outputs_json` is matched by the `artifact_type` of one of its
 * `role = 'output'` artifacts (`architecture/PROJECT_WORK.md` §4). Files
 * collected from a CLI Run arrive as anonymous paths, so without a
 * declaration nothing a dispatched agent produces can ever match a declared
 * output and every such Task parks for review.
 *
 * A declaration is about identity and role, not content: materialization
 * still collects the file's final state from disk. Declaring the same path
 * twice in one Run replaces the earlier declaration — an agent correcting
 * itself is not two artifacts.
 */
export const runArtifactDeclarations = pgTable("run_artifact_declarations", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	runId: varchar("run_id", { length: 36 }).notNull(),
	taskId: varchar("task_id", { length: 36 }).notNull(),
	/** Path inside the run's artifact output directory, normalized on write. */
	path: varchar({ length: 1024 }).notNull(),
	artifactType: varchar("artifact_type", { length: 64 }).notNull(),
	role: varchar({ length: 32 }).notNull(),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_run_artifact_declarations_run_id").using("btree", table.runId.asc().nullsLast()),
	index("ix_run_artifact_declarations_task_id").using("btree", table.taskId.asc().nullsLast()),
	index("ix_run_artifact_declarations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	unique("uq_run_artifact_declarations_run_path").on(table.runId, table.path),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [runs.id],
			name: "run_artifact_declarations_run_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.taskId],
			foreignColumns: [tasks.id],
			name: "run_artifact_declarations_task_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "run_artifact_declarations_space_id_fkey"
		}),
	check("ck_run_artifact_declarations_role", sql`role IN ('output', 'evidence', 'draft')`),
]);

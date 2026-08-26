import { pgTable, index, uniqueIndex, check, foreignKey, varchar, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";
import { spaces } from "./spaces.js";
import { proposals } from "./proposals.js";
import { evolvableAssets, evolvableAssetVersions } from "./evolvableAssets.js";

const SCOPE_TYPES = sql`ARRAY[('system'::character varying)::text, ('space'::character varying)::text, ('project'::character varying)::text, ('user'::character varying)::text, ('agent'::character varying)::text]`;

export const promptDeploymentRefs = pgTable("prompt_deployment_refs", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }),
	assetId: varchar("asset_id", { length: 36 }).notNull(),
	scopeType: varchar("scope_type", { length: 16 }).notNull(),
	scopeId: varchar("scope_id", { length: 36 }),
	label: varchar({ length: 64 }).notNull(),
	versionId: varchar("version_id", { length: 36 }).notNull(),
	status: varchar({ length: 16 }).default('active').notNull(),
	promotedByUserId: varchar("promoted_by_user_id", { length: 36 }),
	promotedFromProposalId: varchar("promoted_from_proposal_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_prompt_deployment_refs_asset_label").using("btree", table.assetId.asc().nullsLast(), table.label.asc().nullsLast()),
	index("ix_prompt_deployment_refs_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_prompt_deployment_refs_version_id").using("btree", table.versionId.asc().nullsLast()),
	uniqueIndex("uq_prompt_deployment_refs_active_scope_label")
		.using("btree", sql`COALESCE(${table.spaceId}, '')`, table.assetId.asc().nullsLast(), table.scopeType.asc().nullsLast(), sql`COALESCE(${table.scopeId}, '')`, table.label.asc().nullsLast())
		.where(sql`(status)::text = 'active'::text`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "prompt_deployment_refs_space_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.assetId],
			foreignColumns: [evolvableAssets.id],
			name: "prompt_deployment_refs_asset_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.versionId],
			foreignColumns: [evolvableAssetVersions.id],
			name: "prompt_deployment_refs_version_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.promotedByUserId],
			foreignColumns: [users.id],
			name: "prompt_deployment_refs_promoted_by_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.promotedFromProposalId],
			foreignColumns: [proposals.id],
			name: "prompt_deployment_refs_promoted_from_proposal_id_fkey"
		}).onDelete("set null"),
	check("ck_prompt_deployment_refs_label", sql`(label)::text ~ '^[a-z][a-z0-9_.-]{0,63}$'::text`),
	check("ck_prompt_deployment_refs_scope_type", sql`(scope_type)::text = ANY (${SCOPE_TYPES})`),
	check("ck_prompt_deployment_refs_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text])`),
	check("ck_prompt_deployment_refs_scope_id", sql`(((scope_type)::text = 'system'::text) AND (scope_id IS NULL)) OR (((scope_type)::text <> 'system'::text) AND (scope_id IS NOT NULL))`),
	check("ck_prompt_deployment_refs_space_id", sql`(((scope_type)::text = 'system'::text) AND (space_id IS NULL)) OR (((scope_type)::text <> 'system'::text) AND (space_id IS NOT NULL))`),
]);

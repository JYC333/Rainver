import {
	pgTable,
	index,
	unique,
	foreignKey,
	varchar,
	timestamp,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { spaceMemberships, spaces } from "./spaces.js";
import { projects } from "./projects.js";
import { spaceObjects } from "./knowledge.js";

/**
 * Additional Project scopes for a `space_objects` row (U8/U9).
 *
 * `space_objects.primary_project_id` is governance ownership and stays single —
 * the content read gate evaluates it as a hard AND before visibility and grants,
 * so a note filed in Project A is unreadable to a non-member of A no matter what
 * per-user grant exists. That is what made cross-Project placement impossible
 * rather than merely unimplemented.
 *
 * This table widens the *scope* half of that predicate and nothing else. A share
 * says "members of this other Project may reach past the project barrier"; it
 * does not touch `visibility`, `access_level`, or `content_access_grants`, so a
 * `private` object stays private to its owner however many Projects it is
 * shared into. Read-only by construction: there is deliberately no access level
 * here, because the scope clause has no notion of one.
 *
 * Declared at `space_objects` granularity because that is where the read gate
 * works (see `contentAccessRegistry`) — one row shape serves every ontology
 * subtype. Only the note share action writes rows today.
 */
export const spaceObjectProjectShares = pgTable("space_object_project_shares", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	/** The shared object. */
	objectId: varchar("object_id", { length: 36 }).notNull(),
	/** The Project whose members gain scope access. Never the object's own. */
	projectId: varchar("project_id", { length: 36 }).notNull(),
	sharedByUserId: varchar("shared_by_user_id", { length: 36 }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
	/** Set on revoke. Rows are kept so a re-share reuses one row and the history
	 * of who opened the object to which Project survives the revoke. */
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
	revokedByUserId: varchar("revoked_by_user_id", { length: 36 }),
}, (table): PgTableExtraConfigValue[] => [
	// The read gate's lookup: "is this object shared into any Project this user
	// can read". Leads with the object because that is what the predicate binds.
	index("ix_space_object_project_shares_object").using(
		"btree",
		table.spaceId.asc().nullsLast(),
		table.objectId.asc().nullsLast(),
		table.revokedAt.asc().nullsLast(),
	),
	index("ix_space_object_project_shares_project").using(
		"btree",
		table.spaceId.asc().nullsLast(),
		table.projectId.asc().nullsLast(),
		table.revokedAt.asc().nullsLast(),
	),
	unique("uq_space_object_project_shares_object_project").on(
		table.spaceId,
		table.objectId,
		table.projectId,
	),
	foreignKey({
		columns: [table.spaceId],
		foreignColumns: [spaces.id],
		name: "space_object_project_shares_space_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.objectId, table.spaceId],
		foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
		name: "space_object_project_shares_object_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.projectId, table.spaceId],
		foreignColumns: [projects.id, projects.spaceId],
		name: "space_object_project_shares_project_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.spaceId, table.sharedByUserId],
		foreignColumns: [spaceMemberships.spaceId, spaceMemberships.userId],
		name: "space_object_project_shares_sharer_membership_fkey",
	}),
	foreignKey({
		columns: [table.revokedByUserId],
		foreignColumns: [users.id],
		name: "space_object_project_shares_revoked_by_user_id_fkey",
	}),
]);

import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, text, boolean, doublePrecision, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agents } from "./agents";
import { activityRecords } from "./activity";
import { users } from "./auth";
import { spaces } from "./spaces";
import { spaceObjects, extractedEvidence } from "./knowledge";
import { sourceItems } from "./sources";

// Relation Core MVP batch 1 (people, organizations, identities, affiliations,
// notes, source links). Interactions/participants/important-dates and the
// optional import/merge foundations are deferred to a follow-up batch. See
// .agent/modules/relations.md for current ownership boundaries.

export const relationPeople = pgTable("relation_people", {
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	pronouns: varchar({ length: 32 }),
	headline: varchar({ length: 256 }),
	// Domain lifecycle state, moved off `space_objects` (B12D). Person and
	// Organization fell in the unconstrained ELSE arm of the former
	// `ck_space_objects_status_by_type`, so this vocabulary is stated here for
	// the first time; it matches observed usage in `relations/repository.ts`
	// (created active, archived on delete, filtered against deleted).
	status: varchar({ length: 32 }).default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_relation_people_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_relation_people_status").using("btree", table.status.asc().nullsLast()),
	check("ck_relation_people_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text])`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "relation_people_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "relation_people_object_id_fkey"
		}).onDelete("cascade"),
	unique("relation_people_object_id_space_id_key").on(table.objectId, table.spaceId),
]);

export const relationOrganizations = pgTable("relation_organizations", {
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	orgType: varchar("org_type", { length: 32 }).default('other').notNull(),
	homepageUrl: text("homepage_url"),
	parentOrganizationObjectId: varchar("parent_organization_object_id", { length: 36 }),
	// See the note on `relation_people.status`.
	status: varchar({ length: 32 }).default('active').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_relation_organizations_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_relation_organizations_status").using("btree", table.status.asc().nullsLast()),
	check("ck_relation_organizations_status", sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('archived'::character varying)::text, ('deleted'::character varying)::text])`),
	index("ix_relation_organizations_parent").using("btree", table.parentOrganizationObjectId.asc().nullsLast()),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "relation_organizations_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "relation_organizations_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentOrganizationObjectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "relation_organizations_parent_object_id_fkey"
		}),
	unique("relation_organizations_object_id_space_id_key").on(table.objectId, table.spaceId),
	check("ck_relation_organizations_org_type", sql`(org_type)::text = ANY (ARRAY[('company'::character varying)::text, ('university'::character varying)::text, ('lab'::character varying)::text, ('research_group'::character varying)::text, ('nonprofit'::character varying)::text, ('government'::character varying)::text, ('community'::character varying)::text, ('family'::character varying)::text, ('other'::character varying)::text])`),
]);

export const relationIdentities = pgTable("relation_identities", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectId: varchar("object_id", { length: 36 }).notNull(),
	idType: varchar("id_type", { length: 32 }).notNull(),
	idValue: varchar("id_value", { length: 512 }).notNull(),
	isPrimary: boolean("is_primary").default(false).notNull(),
	confidence: doublePrecision(),
	source: varchar({ length: 32 }).default('manual').notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_relation_identities_object_id").using("btree", table.objectId.asc().nullsLast()),
	index("ix_relation_identities_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_relation_identities_id_type").using("btree", table.idType.asc().nullsLast()),
	uniqueIndex("uq_relation_identities_object_type_value").using("btree", table.spaceId.asc().nullsLast(), table.objectId.asc().nullsLast(), table.idType.asc().nullsLast(), table.idValue.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "relation_identities_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "relation_identities_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "relation_identities_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "relation_identities_object_id_fkey"
		}).onDelete("cascade"),
	check("ck_relation_identities_id_type", sql`(id_type)::text = ANY (ARRAY[('email'::character varying)::text, ('url'::character varying)::text, ('phone'::character varying)::text, ('orcid'::character varying)::text, ('github'::character varying)::text, ('twitter'::character varying)::text, ('linkedin'::character varying)::text, ('other'::character varying)::text])`),
	check("ck_relation_identities_source", sql`(source)::text = ANY (ARRAY[('manual'::character varying)::text, ('import'::character varying)::text, ('source_sync'::character varying)::text, ('agent'::character varying)::text])`),
]);

// Deliberately not the generic `notes` table: generic notes are linked to
// their subject via `noteLinks`, whose endpoint types are constrained to the
// `retrieval_object_type` DB domain (knowledge_item/note/source/claim/...),
// which does not include person/organization. A flat relation-scoped table
// avoids widening that domain for a simple free-text annotation.
export const relationNotes = pgTable("relation_notes", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectId: varchar("object_id", { length: 36 }).notNull(),
	body: text().notNull(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_relation_notes_object_id").using("btree", table.objectId.asc().nullsLast()),
	index("ix_relation_notes_space_id").using("btree", table.spaceId.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "relation_notes_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "relation_notes_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "relation_notes_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "relation_notes_object_id_fkey"
		}).onDelete("cascade"),
]);

export const relationSourceLinks = pgTable("relation_source_links", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	objectId: varchar("object_id", { length: 36 }).notNull(),
	linkType: varchar("link_type", { length: 32 }).notNull(),
	activityId: varchar("activity_id", { length: 36 }),
	sourceItemId: varchar("source_item_id", { length: 36 }),
	evidenceId: varchar("evidence_id", { length: 36 }),
	externalRef: text("external_ref"),
	note: text(),
	createdByUserId: varchar("created_by_user_id", { length: 36 }),
	createdByAgentId: varchar("created_by_agent_id", { length: 36 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_relation_source_links_object_id").using("btree", table.objectId.asc().nullsLast()),
	index("ix_relation_source_links_space_id").using("btree", table.spaceId.asc().nullsLast()),
	index("ix_relation_source_links_activity_id").using("btree", table.activityId.asc().nullsLast()),
	index("ix_relation_source_links_source_item_id").using("btree", table.sourceItemId.asc().nullsLast()),
	index("ix_relation_source_links_evidence_id").using("btree", table.evidenceId.asc().nullsLast()),
	foreignKey({
			columns: [table.createdByAgentId],
			foreignColumns: [agents.id],
			name: "relation_source_links_created_by_agent_id_fkey"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "relation_source_links_created_by_user_id_fkey"
		}),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "relation_source_links_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [spaceObjects.id, spaceObjects.spaceId],
			name: "relation_source_links_object_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.activityId],
			foreignColumns: [activityRecords.id],
			name: "relation_source_links_activity_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceItemId],
			foreignColumns: [sourceItems.id],
			name: "relation_source_links_source_item_id_fkey"
		}),
	foreignKey({
			columns: [table.evidenceId],
			foreignColumns: [extractedEvidence.id],
			name: "relation_source_links_evidence_id_fkey"
		}),
	check("ck_relation_source_links_link_type", sql`(link_type)::text = ANY (ARRAY[('activity'::character varying)::text, ('source_item'::character varying)::text, ('evidence'::character varying)::text, ('external'::character varying)::text])`),
	check("ck_relation_source_links_exactly_one_target", sql`num_nonnulls(activity_id, source_item_id, evidence_id, external_ref) = 1`),
	check("ck_relation_source_links_target_matches_type", sql`(link_type = 'activity' AND activity_id IS NOT NULL) OR (link_type = 'source_item' AND source_item_id IS NOT NULL) OR (link_type = 'evidence' AND evidence_id IS NOT NULL) OR (link_type = 'external' AND external_ref IS NOT NULL)`),
]);

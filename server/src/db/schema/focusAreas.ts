import { pgTable, index, unique, uniqueIndex, check, foreignKey, varchar, text, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";

/**
 * A user-created durable focus area: "my finances", "Rust", a research subject.
 *
 * It classifies, it does not gate. Nothing here participates in the content
 * read predicate — see ADR 0015. The table is deliberately thin: an area that
 * needed fields of its own would be a module, which is a different concept.
 */
export const focusAreas = pgTable("focus_areas", {
	id: varchar({ length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	ownerUserId: varchar("owner_user_id", { length: 36 }),
	name: varchar({ length: 256 }).notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_focus_areas_space").using("btree", table.spaceId.asc().nullsLast()),
	// Referenced by the composite FKs on space_objects and projects, which carry
	// the Space so classification cannot cross one.
	unique("uq_focus_areas_space_id_id").on(table.id, table.spaceId),
	// Two areas in one Space must not share a name; an archived one releases it.
	uniqueIndex("uq_focus_areas_space_name")
		.using("btree", table.spaceId.asc().nullsLast(), table.name.asc().nullsLast())
		.where(sql`archived_at IS NULL`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "focus_areas_space_id_fkey"
		}),
	foreignKey({
			columns: [table.ownerUserId],
			foreignColumns: [users.id],
			name: "focus_areas_owner_user_id_fkey"
		}).onDelete("set null"),
	check("ck_focus_areas_name_nonempty", sql`length(trim(name)) > 0`),
]);

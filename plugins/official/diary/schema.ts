import {sql} from 'drizzle-orm';
import {check, date, foreignKey, index, pgSchema, text, timestamp, unique} from 'drizzle-orm/pg-core';

/**
 * Plugin-owned tables of the Diary package (schema `plugin_diary`). The Diary
 * is personal and user-level: a row belongs to one person across every Space,
 * so rows are keyed by `user_id` only, never by the Space a call came from.
 */
const schema = pgSchema('plugin_diary');

export const entries = schema.table('entries', {
  id: text('id').notNull().primaryKey().default(sql`gen_random_uuid()::text`),
  userId: text('user_id').notNull(),
  entryDate: date('entry_date').notNull(),
  content: text('content').notNull().default(''),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [
  unique('entries_user_date').on(t.userId, t.entryDate),
  // The composite key lets a reflection reference its entry together with the entry's owner.
  unique('entries_user_id_id').on(t.userId, t.id),
  check('entries_user_id_nonempty', sql`length(trim(${t.userId})) > 0`),
  index('entries_user_month_day_idx').on(t.userId, sql`extract(month from ${t.entryDate})`, sql`extract(day from ${t.entryDate})`),
]);

export const reflections = schema.table('reflections', {
  id: text('id').notNull().primaryKey().default(sql`gen_random_uuid()::text`),
  userId: text('user_id').notNull(),
  entryId: text('entry_id').notNull(),
  reflectionDate: date('reflection_date').notNull(),
  content: text('content').notNull(),
  aiModel: text('ai_model'),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
}, t => [
  // One reflection per entry and day: two workers generating it at once land one row.
  unique('reflections_entry_date').on(t.entryId, t.reflectionDate),
  foreignKey({columns: [t.userId, t.entryId], foreignColumns: [entries.userId, entries.id], name: 'reflections_entry_fk'}).onDelete('cascade'),
]);

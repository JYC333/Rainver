import { pgTable, varchar, timestamp, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { users } from "./auth.js";
import { spaceObjects } from "./knowledge.js";

/** Private navigational binding only; note contents/lifecycle belong to Notes.
 * Deleting a document never cascades into a person's note. */
export const readerDocumentNotes = pgTable("reader_document_notes", {
  id: varchar({ length: 36 }).primaryKey().notNull(),
  spaceId: varchar("space_id", { length: 36 }).notNull().references(() => spaces.id, { onDelete: "cascade" }),
  userId: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  documentType: varchar("document_type", { length: 64 }).notNull(),
  documentId: varchar("document_id", { length: 36 }).notNull(),
  noteSpaceId: varchar("note_space_id", { length: 36 }).notNull(),
  noteId: varchar("note_id", { length: 36 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, table => [
  uniqueIndex("ix_reader_document_notes_person_document").on(table.spaceId, table.userId, table.documentType, table.documentId),
  foreignKey({ columns: [table.noteId, table.noteSpaceId], foreignColumns: [spaceObjects.id, spaceObjects.spaceId], name: "reader_document_notes_note_space_fk" }).onDelete("cascade"),
  check("reader_document_notes_document_type", sql`${table.documentType} in ('source_item','source_snapshot','research_report','research_notebook')`),
]);

import { pgTable, index, uniqueIndex, unique, check, foreignKey, varchar, integer, timestamp, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { spaces } from "./spaces.js";
import { sources } from "./knowledge.js";

// Academic object extensions. A paper is backed by the *existing*
// `sources` extension (object_type='source', source_type='paper' — already
// whitelisted by ck_sources_source_type), not a new space_objects object_type
// or a new space_object_profiles entry. This table adds only the fields generic
// `sources` doesn't carry. See .agent/modules/relations.md for the reusable
// relationship foundation and .agent/architecture/PROJECTS.md for preset use.
export const academicPapers = pgTable("academic_papers", {
	objectId: varchar("object_id", { length: 36 }).primaryKey().notNull(),
	spaceId: varchar("space_id", { length: 36 }).notNull(),
	doi: varchar({ length: 256 }),
	arxivId: varchar("arxiv_id", { length: 64 }),
	pmid: varchar({ length: 32 }),
	openalexId: varchar("openalex_id", { length: 64 }),
	semanticScholarId: varchar("semantic_scholar_id", { length: 64 }),
	publicationDate: timestamp("publication_date", { withTimezone: true, mode: 'string' }),
	venue: varchar({ length: 512 }),
	paperType: varchar("paper_type", { length: 32 }).default('article').notNull(),
	citedByCount: integer("cited_by_count"),
	referenceCount: integer("reference_count"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
	index("ix_academic_papers_space_id").using("btree", table.spaceId.asc().nullsLast()),
	uniqueIndex("uq_academic_papers_space_doi").using("btree", table.spaceId.asc().nullsLast(), table.doi.asc().nullsLast()).where(sql`(doi IS NOT NULL)`),
	uniqueIndex("uq_academic_papers_space_arxiv_id").using("btree", table.spaceId.asc().nullsLast(), table.arxivId.asc().nullsLast()).where(sql`(arxiv_id IS NOT NULL)`),
	uniqueIndex("uq_academic_papers_space_openalex_id").using("btree", table.spaceId.asc().nullsLast(), table.openalexId.asc().nullsLast()).where(sql`(openalex_id IS NOT NULL)`),
	uniqueIndex("uq_academic_papers_space_semantic_scholar_id").using("btree", table.spaceId.asc().nullsLast(), table.semanticScholarId.asc().nullsLast()).where(sql`(semantic_scholar_id IS NOT NULL)`),
	foreignKey({
			columns: [table.spaceId],
			foreignColumns: [spaces.id],
			name: "academic_papers_space_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.spaceId],
			foreignColumns: [sources.objectId, sources.spaceId],
			name: "academic_papers_object_id_fkey"
		}).onDelete("cascade"),
	unique("academic_papers_object_id_space_id_key").on(table.objectId, table.spaceId),
	check("ck_academic_papers_paper_type", sql`(paper_type)::text = ANY (ARRAY[('article'::character varying)::text, ('preprint'::character varying)::text, ('conference_paper'::character varying)::text, ('book_chapter'::character varying)::text, ('thesis'::character varying)::text, ('report'::character varying)::text, ('other'::character varying)::text])`),
	check("ck_academic_papers_canonical_identity", sql`(doi IS NULL OR (doi <> '' AND doi = lower(btrim(doi)))) AND (arxiv_id IS NULL OR (arxiv_id <> '' AND arxiv_id = lower(btrim(arxiv_id)))) AND (pmid IS NULL OR (pmid <> '' AND pmid = lower(btrim(pmid)))) AND (openalex_id IS NULL OR (openalex_id <> '' AND openalex_id = lower(btrim(openalex_id)))) AND (semantic_scholar_id IS NULL OR (semantic_scholar_id <> '' AND semantic_scholar_id = lower(btrim(semantic_scholar_id))))`),
]);

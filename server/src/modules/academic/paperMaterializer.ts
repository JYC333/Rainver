import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter.js";
import { randomUUID } from "node:crypto";
import { withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { inheritContentAccessGrants } from "../access/contentAccessInheritance.js";
import type { ExtractionProfileMaterializationInput } from "../extractionProfiles/registry.js";
import { canonicalAcademicIdentity } from "./identity.js";

interface SourceItemForMaterialization {
  id: string;
  space_id: string;
  title: string;
  metadata_json: unknown;
  reference_object_id: string | null;
  reference_project_id: string | null;
  created_by_user_id: string | null;
  owner_user_id: string | null;
  visibility: string;
  access_level: string;
}

interface AcademicItemMetadata {
  provider: "arxiv" | "openalex" | "semantic_scholar";
  arxivId: string | null;
  doi: string | null;
  openalexId: string | null;
  semanticScholarId: string | null;
  authors: string[];
  categories: string[];
  primaryCategory: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  absUrl: string | null;
  htmlUrl: string | null;
  pdfUrl: string | null;
  journalRef: string | null;
  comment: string | null;
  venue: string | null;
  paperType: string;
  citedByCount: number | null;
  referenceCount: number | null;
}

const PAPER_TYPES = new Set(["article", "preprint", "conference_paper", "book_chapter", "thesis", "report", "other"]);

export interface MaterializeAcademicPaperResult {
  objectId: string;
  created: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

/** Reads the normalized metadata emitted by supported academic connectors. */
function academicMetadataFromItem(item: SourceItemForMaterialization): AcademicItemMetadata | null {
  const meta = record(item.metadata_json);
  const arxivId = canonicalAcademicIdentity(stringOrNull(meta.arxiv_id));
  const openalexId = canonicalAcademicIdentity(stringOrNull(meta.openalex_id));
  const semanticScholarId = canonicalAcademicIdentity(stringOrNull(meta.semantic_scholar_id));
  const provider = stringOrNull(meta.academic_provider) ?? (arxivId ? "arxiv" : null);
  if (!provider || !["arxiv", "openalex", "semantic_scholar"].includes(provider)) return null;
  if (!arxivId && !openalexId && !semanticScholarId && !stringOrNull(meta.doi)) return null;
  return {
    provider: provider as AcademicItemMetadata["provider"],
    arxivId,
    doi: canonicalAcademicIdentity(stringOrNull(meta.doi)),
    openalexId,
    semanticScholarId,
    authors: stringArray(meta.authors),
    categories: stringArray(meta.categories),
    primaryCategory: stringOrNull(meta.primary_category),
    publishedAt: stringOrNull(meta.published_at),
    updatedAt: stringOrNull(meta.updated_at),
    absUrl: stringOrNull(meta.abs_url) ?? stringOrNull(meta.source_url),
    htmlUrl: stringOrNull(meta.html_url),
    pdfUrl: stringOrNull(meta.pdf_url),
    journalRef: stringOrNull(meta.journal_ref),
    comment: stringOrNull(meta.comment),
    venue: stringOrNull(meta.venue),
    paperType: PAPER_TYPES.has(stringOrNull(meta.paper_type) ?? "")
      ? stringOrNull(meta.paper_type)!
      : provider === "arxiv" ? "preprint" : "other",
    citedByCount: Number.isInteger(meta.cited_by_count) ? Number(meta.cited_by_count) : null,
    referenceCount: Number.isInteger(meta.reference_count) ? Number(meta.reference_count) : null,
  };
}

/**
 * Materializes an academic-provider `source_item` into an `academic_paper_v1`
 * object: `space_objects` (object_type='source') + `sources`
 * (source_type='paper') + `academic_papers`, deduped per space by
 * DOI and provider-native ids (matches the partial unique indexes on
 * `academic_papers`).
 * Idempotent — a SourceItem with an existing `source_item_references` row is
 * treated as already materialized, and re-running against an existing
 * arxiv_id/doi links the item to that paper instead of creating a duplicate.
 *
 * Author/category strings stay on the paper's `sources.metadata_json` only.
 * Canonical `person` objects are not auto-created from author strings
 * without a disambiguation/review path.
 *
 * Returns null when the item does not exist or has no supported academic id.
 */
export async function materializeAcademicPaperFromSourceItem(
  db: Queryable,
  input: ExtractionProfileMaterializationInput,
): Promise<MaterializeAcademicPaperResult | null> {
  return withQueryableTransaction(db, (tx) => materializeAcademicPaperInTransaction(tx, input));
}

async function materializeAcademicPaperInTransaction(
  db: Queryable,
  input: ExtractionProfileMaterializationInput,
): Promise<MaterializeAcademicPaperResult | null> {
  const itemResult = await db.query<SourceItemForMaterialization>(
    `SELECT si.id, si.space_id, si.title, si.metadata_json,
            sir.reference_object_id, reference.primary_project_id AS reference_project_id, si.created_by_user_id,
            si.owner_user_id, si.visibility, si.access_level
       FROM source_items si
       LEFT JOIN source_item_references sir
         ON sir.source_item_id = si.id AND sir.space_id = si.space_id
       LEFT JOIN space_objects reference
         ON reference.id = sir.reference_object_id AND reference.space_id = sir.space_id
      WHERE si.space_id = $1 AND si.id = $2 AND si.deleted_at IS NULL
      LIMIT 1
      FOR UPDATE OF si`,
    [input.spaceId, input.sourceItemId],
  );
  const item = itemResult.rows[0];
  if (!item) return null;
  if (item.reference_object_id) {
    if (item.reference_project_id && item.reference_project_id !== input.projectId) {
      throw new Error("Academic paper is already materialized for a different Project");
    }
    return { objectId: item.reference_object_id, created: false };
  }

  const academic = academicMetadataFromItem(item);
  if (!academic) return null;

  // Different SourceItems for the same paper do not share a row lock. Lock
  // every available external identity in a deterministic order so overlapping
  // DOI/provider-id sets serialize without deadlocking. The surrounding
  // transaction makes the dedupe read and all created rows one atomic unit.
  const identityKeys = [
    academic.arxivId ? `arxiv:${academic.arxivId.toLowerCase()}` : null,
    academic.doi ? `doi:${academic.doi.toLowerCase()}` : null,
    academic.openalexId ? `openalex:${academic.openalexId.toLowerCase()}` : null,
    academic.semanticScholarId ? `semantic-scholar:${academic.semanticScholarId.toLowerCase()}` : null,
  ].filter((value): value is string => Boolean(value)).sort();
  for (const identityKey of identityKeys) {
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`academic-paper:${input.spaceId}:${identityKey}`],
    );
  }

  const existing = await db.query<{ object_id: string; primary_project_id: string | null }>(
    `SELECT ap.object_id, so.primary_project_id
       FROM academic_papers ap
       JOIN space_objects so ON so.id = ap.object_id AND so.space_id = ap.space_id
      WHERE ap.space_id = $1
        AND so.deleted_at IS NULL
        AND (($2::varchar IS NOT NULL AND ap.arxiv_id = $2)
          OR ($3::varchar IS NOT NULL AND ap.doi = $3)
          OR ($4::varchar IS NOT NULL AND ap.openalex_id = $4)
          OR ($5::varchar IS NOT NULL AND ap.semantic_scholar_id = $5))
      LIMIT 1`,
    [input.spaceId, academic.arxivId, academic.doi, academic.openalexId, academic.semanticScholarId],
  );
  const now = new Date().toISOString();
  const existingObjectId = existing.rows[0]?.object_id;
  const existingProjectId = existing.rows[0]?.primary_project_id ?? null;
  if (existingObjectId && existingProjectId && existingProjectId !== input.projectId) {
    throw new Error("Academic paper is already materialized for a different Project");
  }
  if (existingObjectId) {
    await db.query(
      `UPDATE academic_papers
          SET doi=COALESCE(doi,$3), arxiv_id=COALESCE(arxiv_id,$4),
              openalex_id=COALESCE(openalex_id,$5), semantic_scholar_id=COALESCE(semantic_scholar_id,$6),
              publication_date=COALESCE(publication_date,$7::timestamptz), venue=COALESCE(venue,$8),
              cited_by_count=CASE WHEN $9::integer IS NULL THEN cited_by_count ELSE GREATEST(COALESCE(cited_by_count,$9),$9) END,
              reference_count=CASE WHEN $10::integer IS NULL THEN reference_count ELSE GREATEST(COALESCE(reference_count,$10),$10) END, updated_at=$11
        WHERE space_id=$1 AND object_id=$2`,
      [input.spaceId, existingObjectId, academic.doi, academic.arxivId, academic.openalexId,
        academic.semanticScholarId, academic.publishedAt ?? academic.updatedAt, academic.venue,
        academic.citedByCount, academic.referenceCount, now],
    );
    await linkSourceItemReference(db, input.spaceId, input.sourceItemId, existingObjectId, now);
    return { objectId: existingObjectId, created: false };
  }

  const objectId = randomUUID();
  // No slice here: the writer projects the label to the root column's width in
  // one place. Slicing at 1024 was past `space_objects.title`'s 512, so a long
  // paper title failed the insert rather than being shortened.
  const title = item.title?.trim() || academic.arxivId || academic.openalexId || academic.semanticScholarId || academic.doi || "Academic paper";
  const object = buildSpaceObjectInsert({
    id: objectId,
    spaceId: input.spaceId,
    objectType: "source",
    title,
    visibility: item.visibility,
    accessLevel: item.access_level,
    ownerUserId: item.owner_user_id,
    primaryProjectId: input.projectId,
    // Background ingestion has no acting user or run, but the SourceItem it
    // derives from has an owner, and "this exists because that user's source
    // produced it" is accurate attribution. Without this the object would be
    // untraceable to anyone (B12H).
    createdByUserId: item.created_by_user_id ?? item.owner_user_id,
    createdAt: now,
  });
  await db.query(object.sql, object.params);
  if (item.visibility === "selected_users") {
    await inheritContentAccessGrants(db, {
      spaceId: input.spaceId,
      sourceResourceType: "source_item",
      sourceResourceId: item.id,
      targetResourceType: "space_object",
      targetResourceId: objectId,
      inheritedAt: now,
    });
  }
  await db.query(
    `INSERT INTO sources (object_id, space_id, status, source_type, uri, metadata_json)
     VALUES ($1, $2, 'processed', 'paper', $3, $4::jsonb)`,
    [
      objectId,
      input.spaceId,
      academic.absUrl,
      JSON.stringify({
        academic_provider: academic.provider,
        authors: academic.authors,
        categories: academic.categories,
        primary_category: academic.primaryCategory,
        abs_url: academic.absUrl,
        html_url: academic.htmlUrl,
        pdf_url: academic.pdfUrl,
        journal_ref: academic.journalRef,
        comment: academic.comment,
      }),
    ],
  );
  await db.query(
    `INSERT INTO academic_papers (
       object_id, space_id, doi, arxiv_id, pmid, openalex_id, semantic_scholar_id, publication_date,
       venue, paper_type, cited_by_count, reference_count, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7::timestamptz, $8, $9, $10, $11, $12, $12)`,
    [objectId, input.spaceId, academic.doi, academic.arxivId, academic.openalexId, academic.semanticScholarId,
      academic.publishedAt ?? academic.updatedAt, academic.venue, academic.paperType, academic.citedByCount, academic.referenceCount, now],
  );
  await linkSourceItemReference(db, input.spaceId, input.sourceItemId, objectId, now);
  return { objectId, created: true };
}

async function linkSourceItemReference(
  db: Queryable,
  spaceId: string,
  sourceItemId: string,
  referenceObjectId: string,
  now: string,
): Promise<void> {
  await db.query(
    `INSERT INTO source_item_references (
       source_item_id, space_id, reference_object_id, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (source_item_id) DO UPDATE SET
       reference_object_id = EXCLUDED.reference_object_id,
       updated_at = EXCLUDED.updated_at`,
    [sourceItemId, spaceId, referenceObjectId, now],
  );
}

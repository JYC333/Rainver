import { objectStatusScalarSql } from "../../db/objectStatusSql";
import { randomUUID } from "node:crypto";
import {
  HttpError,
  countFromRow,
  dateIso,
  numberValue,
  objectValue,
  optionalObject,
  optionalString,
  page,
  withQueryableTransaction,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import { contentReadSql } from "../access/contentAccessSql";
import { sourceItemReadableClause, sourceSnapshotReadableForEvidenceClause } from "../sources/sourceItemAccess";
import { assertProjectReadable, assertProjectWriter, lockActiveProjectForMutation } from "./access";
import { materializePassingProjectCorpusItems } from "./corpusMaterialization";

export type ProjectCorpusRole = "candidate" | "reference" | "primary" | "related" | "background";
export type ProjectCorpusStatus = "active" | "archived";
export type ProjectCorpusTriageStatus = "new" | "relevant" | "maybe" | "excluded" | "included";
export type ProjectCorpusReadStatus = "unread" | "skimmed" | "read" | "discussed";
export type ProjectCorpusRelevance = "relevant" | "maybe" | "not_relevant";

interface ProjectCorpusItemRow {
  id: string;
  space_id: string;
  project_id: string;
  object_id: string | null;
  source_item_id: string | null;
  evidence_id: string | null;
  source_connection_id: string | null;
  source_decision_id: string | null;
  role: ProjectCorpusRole;
  status: ProjectCorpusStatus;
  triage_status: ProjectCorpusTriageStatus;
  triage_confirmed_by_user: boolean;
  read_status: ProjectCorpusReadStatus;
  relevance: ProjectCorpusRelevance | null;
  confidence: number | null;
  reason: string | null;
  added_by_user_id: string | null;
  metadata_json: unknown;
  created_at: unknown;
  updated_at: unknown;
  last_reviewed_at: unknown;
  last_read_at: unknown;
  object_type: string | null;
  object_title: string | null;
  object_summary: string | null;
  object_status: string | null;
  source_item_type: string | null;
  source_item_title: string | null;
  source_item_uri: string | null;
  source_item_domain: string | null;
  source_item_excerpt: string | null;
  evidence_type: string | null;
  evidence_title: string | null;
  evidence_excerpt: string | null;
  academic_arxiv_id: string | null;
  academic_doi: string | null;
  academic_publication_date: unknown;
  academic_venue: string | null;
  academic_paper_type: string | null;
  academic_cited_by_count: number | null;
  academic_reference_count: number | null;
  academic_source_uri: string | null;
  academic_authors: unknown;
  academic_categories: unknown;
}

const CORPUS_COLUMNS = `
  pci.id, pci.space_id, pci.project_id, pci.object_id, si.id AS source_item_id,
  pci.evidence_id, pci.source_connection_id, pci.source_decision_id,
  pci.role, pci.status, pci.triage_status, pci.triage_confirmed_by_user, pci.read_status, pci.relevance,
  pci.confidence, pci.reason, pci.added_by_user_id, pci.metadata_json,
  pci.created_at, pci.updated_at, pci.last_reviewed_at, pci.last_read_at,
  so.object_type, so.title AS object_title, so.summary AS object_summary, ${objectStatusScalarSql("so")} AS object_status,
  si.item_type AS source_item_type, si.title AS source_item_title,
  si.source_uri AS source_item_uri, si.source_domain AS source_item_domain, si.excerpt AS source_item_excerpt,
  ev.evidence_type, ev.title AS evidence_title, ev.content_excerpt AS evidence_excerpt,
  ap.arxiv_id AS academic_arxiv_id, ap.doi AS academic_doi, ap.publication_date AS academic_publication_date,
  ap.venue AS academic_venue, ap.paper_type AS academic_paper_type,
  ap.cited_by_count AS academic_cited_by_count, ap.reference_count AS academic_reference_count,
  src.uri AS academic_source_uri, src.metadata_json->'authors' AS academic_authors,
  src.metadata_json->'categories' AS academic_categories
`;

const ROLES = new Set<ProjectCorpusRole>(["candidate", "reference", "primary", "related", "background"]);
const STATUSES = new Set<ProjectCorpusStatus>(["active", "archived"]);
const TRIAGE_STATUSES = new Set<ProjectCorpusTriageStatus>(["new", "relevant", "maybe", "excluded", "included"]);
const READ_STATUSES = new Set<ProjectCorpusReadStatus>(["unread", "skimmed", "read", "discussed"]);
const RELEVANCES = new Set<ProjectCorpusRelevance>(["relevant", "maybe", "not_relevant"]);

function corpusPrimarySourceJoin(viewerParam: string): string {
  return `LEFT JOIN LATERAL (
    SELECT source_item.*
      FROM project_corpus_item_sources provenance
      JOIN source_items source_item
        ON source_item.id = provenance.source_item_id
       AND source_item.space_id = provenance.space_id
     WHERE provenance.corpus_item_id = pci.id
       AND provenance.space_id = pci.space_id
       AND source_item.deleted_at IS NULL
       AND ${sourceItemReadableClause("source_item", viewerParam, false)}
     ORDER BY CASE WHEN source_item.id = pci.source_item_id THEN 0 ELSE 1 END,
              source_item.last_seen_at DESC, source_item.id ASC
     LIMIT 1
  ) si ON true`;
}

/**
 * The FROM/WHERE of "corpus rows this viewer may read", shared by the id
 * lookup and the Overview's counts so the two can never drift. Space and
 * Project are always `$1`/`$2`; the viewer parameter is named by the caller
 * because the two queries bind it at different positions.
 */
function readableCorpusItemFrom(viewerParam: string): string {
  return `FROM project_corpus_items pci
         LEFT JOIN space_objects so ON so.id = pci.object_id AND so.space_id = pci.space_id
         ${corpusPrimarySourceJoin(viewerParam)}
         LEFT JOIN extracted_evidence ev ON ev.id = pci.evidence_id AND ev.space_id = pci.space_id
         LEFT JOIN source_items evidence_source
           ON evidence_source.id = COALESCE(ev.source_item_id, ev.origin_source_item_id)
          AND evidence_source.space_id = ev.space_id
          AND evidence_source.deleted_at IS NULL
        WHERE pci.space_id = $1 AND pci.project_id = $2
          AND (pci.object_id IS NULL OR (so.id IS NOT NULL AND ${contentReadSql("space_object", "so", viewerParam)}))
          AND (pci.source_item_id IS NULL OR si.id IS NOT NULL)
          AND (
            pci.evidence_id IS NULL
            OR (
              ev.id IS NOT NULL
              AND ${contentReadSql("extracted_evidence", "ev", viewerParam)}
              AND (
                COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NULL
                OR (
                  evidence_source.id IS NOT NULL
                  AND ${sourceItemReadableClause("evidence_source", viewerParam, false)}
                )
              )
              AND ${sourceSnapshotReadableForEvidenceClause("ev", viewerParam)}
            )
          )`;
}

export interface ProjectCorpusBackfillResult {
  project_id: string;
  source_items: number;
  source_objects: number;
  evidence_items: number;
  evidence_objects: number;
  source_decisions: number;
  archived_source_items: number;
}

export class ProjectCorpusRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Public owning-domain access boundary for Project Corpus references.
   * Consumers such as Inquiry must not infer that Project membership grants
   * access to the Source/Object/Evidence behind a Corpus row.
   */
  async canReadItem(identity: SpaceUserIdentity, projectId: string, corpusItemId: string): Promise<boolean> {
    return (await this.readableItemIds(identity, projectId, [corpusItemId])).has(corpusItemId);
  }

  /**
   * How much collected material and extracted evidence this Project holds,
   * counted through the same readability predicate the corpus list uses.
   *
   * These are Project-owned rows, so the Overview reads them here rather than
   * through the entity summary registry, which exists to keep the Project
   * module out of *other* domains' tables.
   */
  async entityCounts(
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<{ source_item_count: number; extracted_evidence_count: number }> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    // Counted in SQL rather than by materializing every corpus id and
    // intersecting in memory: a Project's corpus is unbounded, and the
    // Overview asks for this on every visit.
    const result = await this.db.query<{ source_items: string | number; evidence_items: string | number }>(
      `SELECT count(*)::text AS source_items,
              count(*) FILTER (WHERE pci.evidence_id IS NOT NULL)::text AS evidence_items
         ${readableCorpusItemFrom("$3")}
          AND pci.status = 'active'`,
      [identity.spaceId, projectId, identity.userId],
    );
    const row = result.rows[0];
    return {
      source_item_count: Number(row?.source_items ?? 0),
      extracted_evidence_count: Number(row?.evidence_items ?? 0),
    };
  }

  async readableItemIds(
    identity: SpaceUserIdentity,
    projectId: string,
    corpusItemIds: readonly string[],
  ): Promise<Set<string>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const ids = [...new Set(corpusItemIds)];
    if (ids.length === 0) return new Set();
    const result = await this.db.query<{ id: string }>(
      `SELECT pci.id
         ${readableCorpusItemFrom("$4")}
          AND pci.id = ANY($3::varchar[])`,
      [identity.spaceId, projectId, ids, identity.userId],
    );
    return new Set(result.rows.map((row) => row.id));
  }

  async list(
    identity: SpaceUserIdentity,
    projectId: string,
    filters: {
      status?: string | null;
      triageStatus?: string | null;
      readStatus?: string | null;
      role?: string | null;
      q?: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const params: unknown[] = [identity.spaceId, projectId, identity.userId];
    const clauses = [
      "pci.space_id = $1",
      "pci.project_id = $2",
      `(pci.object_id IS NULL OR (so.id IS NOT NULL AND ${contentReadSql("space_object", "so", "$3")}))`,
      `(pci.source_item_id IS NULL OR (si.id IS NOT NULL AND ${sourceItemReadableClause("si", "$3", false)}))`,
      `(pci.evidence_id IS NULL OR (
        ev.id IS NOT NULL
        AND ${contentReadSql("extracted_evidence", "ev", "$3")}
        AND (
          COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NULL
          OR (
            evidence_source.id IS NOT NULL
            AND ${sourceItemReadableClause("evidence_source", "$3", false)}
          )
        )
        AND ${sourceSnapshotReadableForEvidenceClause("ev", "$3")}
      ))`,
    ];
    if (filters.status) {
      if (!STATUSES.has(filters.status as ProjectCorpusStatus)) {
        throw new HttpError(422, "status must be active or archived");
      }
      params.push(filters.status);
      clauses.push(`pci.status = $${params.length}`);
    } else {
      clauses.push("pci.status = 'active'");
    }
    if (filters.triageStatus) {
      if (!TRIAGE_STATUSES.has(filters.triageStatus as ProjectCorpusTriageStatus)) {
        throw new HttpError(422, "triage_status is invalid");
      }
      params.push(filters.triageStatus);
      clauses.push(`pci.triage_status = $${params.length}`);
    }
    if (filters.readStatus) {
      if (!READ_STATUSES.has(filters.readStatus as ProjectCorpusReadStatus)) {
        throw new HttpError(422, "read_status is invalid");
      }
      params.push(filters.readStatus);
      clauses.push(`pci.read_status = $${params.length}`);
    }
    if (filters.role) {
      if (!ROLES.has(filters.role as ProjectCorpusRole)) throw new HttpError(422, "role is invalid");
      params.push(filters.role);
      clauses.push(`pci.role = $${params.length}`);
    }
    if (filters.q) {
      params.push(`%${escapeLike(filters.q)}%`);
      clauses.push(`(
        so.title ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(so.summary, '') ILIKE $${params.length} ESCAPE '\\'
        OR si.title ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(si.excerpt, '') ILIKE $${params.length} ESCAPE '\\'
        OR ev.title ILIKE $${params.length} ESCAPE '\\'
        OR COALESCE(ev.content_excerpt, '') ILIKE $${params.length} ESCAPE '\\'
      )`);
    }
    const where = clauses.join(" AND ");
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(pci.id)::text AS total
         FROM project_corpus_items pci
         LEFT JOIN space_objects so ON so.id = pci.object_id AND so.space_id = pci.space_id
         ${corpusPrimarySourceJoin("$3")}
         LEFT JOIN extracted_evidence ev ON ev.id = pci.evidence_id AND ev.space_id = pci.space_id
         LEFT JOIN source_items evidence_source
           ON evidence_source.id = COALESCE(ev.source_item_id, ev.origin_source_item_id)
          AND evidence_source.space_id = ev.space_id
          AND evidence_source.deleted_at IS NULL
        WHERE ${where}`,
      params,
    );
    const rows = await this.db.query<ProjectCorpusItemRow>(
      `SELECT ${CORPUS_COLUMNS}
         FROM project_corpus_items pci
         LEFT JOIN space_objects so ON so.id = pci.object_id AND so.space_id = pci.space_id
         ${corpusPrimarySourceJoin("$3")}
         LEFT JOIN extracted_evidence ev ON ev.id = pci.evidence_id AND ev.space_id = pci.space_id
         LEFT JOIN source_items evidence_source
           ON evidence_source.id = COALESCE(ev.source_item_id, ev.origin_source_item_id)
          AND evidence_source.space_id = ev.space_id
          AND evidence_source.deleted_at IS NULL
         LEFT JOIN academic_papers ap ON ap.object_id = so.id AND ap.space_id = pci.space_id
         LEFT JOIN sources src ON src.object_id = so.id AND src.space_id = pci.space_id
        WHERE ${where}
        ORDER BY pci.updated_at DESC, pci.created_at DESC, pci.id ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(projectCorpusItemOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async upsert(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return withQueryableTransaction(this.db, (db) =>
      new ProjectCorpusRepository(db).upsertLocked(identity, projectId, body),
    );
  }

  private async upsertLocked(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const target = await this.resolveTarget(identity, projectId, body);
    const now = new Date().toISOString();
    const role = roleValue(body.role) ?? "candidate";
    const status = statusValue(body.status) ?? "active";
    const triageStatus = triageStatusValue(body.triage_status) ?? "new";
    const triageConfirmed = body.triage_status !== undefined;
    const readStatus = readStatusValue(body.read_status) ?? "unread";
    const relevance = relevanceValue(body.relevance);
    const confidence = confidenceValue(body.confidence);
    const metadata = optionalObject(body.metadata_json) ?? {};
    const conflict = conflictClause(target);
    // Every logical usage gets its own parameter number (no $N reuse), even
    // where the JS value repeats (e.g. `now`): this pg version/driver
    // combination raises "inconsistent types deduced for parameter" when a
    // parameter is referenced more than once in a statement.
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO project_corpus_items (
         id, space_id, project_id, object_id, source_item_id, evidence_id,
         source_connection_id, source_decision_id, role, status, triage_status,
         triage_confirmed_by_user, read_status, relevance, confidence, reason, added_by_user_id,
         metadata_json, created_at, updated_at, last_reviewed_at, last_read_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17,
         $18::jsonb, $19, $20,
         CASE WHEN $21::boolean THEN $22::timestamptz ELSE NULL END,
         CASE WHEN $23::varchar <> 'unread' THEN $24::timestamptz ELSE NULL END
       )
       ${conflict}
       DO UPDATE SET object_id = COALESCE(EXCLUDED.object_id, project_corpus_items.object_id),
                     source_item_id = COALESCE(EXCLUDED.source_item_id, project_corpus_items.source_item_id),
                     evidence_id = COALESCE(EXCLUDED.evidence_id, project_corpus_items.evidence_id),
                     source_connection_id = COALESCE(EXCLUDED.source_connection_id, project_corpus_items.source_connection_id),
                     source_decision_id = COALESCE(EXCLUDED.source_decision_id, project_corpus_items.source_decision_id),
                     role = EXCLUDED.role,
                     status = EXCLUDED.status,
                     triage_status = EXCLUDED.triage_status,
                     triage_confirmed_by_user = CASE
                       WHEN EXCLUDED.triage_confirmed_by_user THEN true
                       ELSE project_corpus_items.triage_confirmed_by_user
                     END,
                     read_status = EXCLUDED.read_status,
                     relevance = EXCLUDED.relevance,
                     confidence = EXCLUDED.confidence,
                     reason = EXCLUDED.reason,
                     metadata_json = EXCLUDED.metadata_json,
                     updated_at = EXCLUDED.updated_at,
                     last_reviewed_at = COALESCE(EXCLUDED.last_reviewed_at, project_corpus_items.last_reviewed_at),
                     last_read_at = CASE
                       WHEN EXCLUDED.read_status <> project_corpus_items.read_status THEN EXCLUDED.updated_at
                       ELSE project_corpus_items.last_read_at
                     END
       RETURNING id`,
      [
        randomUUID(),
        identity.spaceId,
        projectId,
        target.objectId,
        target.sourceItemId,
        target.evidenceId,
        target.sourceConnectionId,
        target.sourceDecisionId,
        role,
        status,
        triageStatus,
        triageConfirmed,
        readStatus,
        relevance,
        confidence,
        optionalString(body.reason),
        identity.userId,
        JSON.stringify(metadata),
        now,
        now,
        triageConfirmed,
        now,
        readStatus,
        now,
      ],
    );
    const corpusItemId = result.rows[0]!.id;
    if (target.provenanceSourceItemId) {
      await insertCorpusItemSourceProvenance(this.db, {
        corpusItemId,
        spaceId: identity.spaceId,
        projectId,
        sourceItemId: target.provenanceSourceItemId,
        now,
      });
    }
    if (target.sourceItemId) {
      await materializePassingProjectCorpusItems(this.db, { spaceId: identity.spaceId, projectId, sourceItemId: target.sourceItemId, corpusItemId });
      await upsertProjectCorpusObjectsFromSourceItems(this.db, { spaceId: identity.spaceId, projectId, sourceItemId: target.sourceItemId });
    }
    const item = await this.getById(identity, projectId, corpusItemId);
    if (!item) throw new HttpError(500, "Failed to upsert project corpus item");
    return projectCorpusItemOut(item);
  }

  async update(
    identity: SpaceUserIdentity,
    projectId: string,
    corpusItemId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return withQueryableTransaction(this.db, (db) =>
      new ProjectCorpusRepository(db).updateLocked(identity, projectId, corpusItemId, body),
    );
  }

  private async updateLocked(
    identity: SpaceUserIdentity,
    projectId: string,
    corpusItemId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    await lockActiveProjectForMutation(this.db, identity.spaceId, projectId);
    const current = await this.getById(identity, projectId, corpusItemId);
    if (!current) throw new HttpError(404, "Project corpus item not found");
    const nextRole = body.role === undefined ? current.role : roleValue(body.role) ?? current.role;
    const nextStatus = body.status === undefined ? current.status : statusValue(body.status) ?? current.status;
    const nextTriage = body.triage_status === undefined
      ? current.triage_status
      : triageStatusValue(body.triage_status) ?? current.triage_status;
    const triageConfirmed = body.triage_status !== undefined || current.triage_confirmed_by_user;
    const triageExplicitlyConfirmed = body.triage_status !== undefined;
    const nextRead = body.read_status === undefined ? current.read_status : readStatusValue(body.read_status) ?? current.read_status;
    const nextRelevance = body.relevance === undefined ? current.relevance : relevanceValue(body.relevance);
    const nextConfidence = body.confidence === undefined ? current.confidence : confidenceValue(body.confidence);
    const nextMetadata = body.metadata_json === undefined
      ? objectValue(current.metadata_json)
      : optionalObject(body.metadata_json) ?? {};
    const now = new Date().toISOString();
    // read_status is passed twice (once for the plain SET, once for the CASE
    // comparison) rather than reusing one parameter
    // number: this pg version/driver combination raises "inconsistent types
    // deduced for parameter" when the same parameter is referenced more
    // than once in a statement (reproduced independently of this change).
    await this.db.query(
      `UPDATE project_corpus_items
          SET role = $4,
              status = $5,
              triage_status = $6,
              triage_confirmed_by_user = $14,
              read_status = $7,
              relevance = $8,
              confidence = $9,
              reason = $10,
              metadata_json = $11::jsonb,
              updated_at = $12,
              last_reviewed_at = CASE WHEN $15::boolean THEN $12::timestamptz ELSE last_reviewed_at END,
              last_read_at = CASE WHEN read_status <> $13 THEN $12::timestamptz ELSE last_read_at END
        WHERE space_id = $1 AND project_id = $2 AND id = $3`,
      [
        identity.spaceId,
        projectId,
        corpusItemId,
        nextRole,
        nextStatus,
        nextTriage,
        nextRead,
        nextRelevance,
        nextConfidence,
        body.reason === undefined ? current.reason : optionalString(body.reason),
        JSON.stringify(nextMetadata),
        now,
        nextRead,
        triageConfirmed,
        triageExplicitlyConfirmed,
      ],
    );
    if (current.source_item_id) {
      await materializePassingProjectCorpusItems(this.db, { spaceId: identity.spaceId, projectId, sourceItemId: current.source_item_id, corpusItemId });
      await upsertProjectCorpusObjectsFromSourceItems(this.db, { spaceId: identity.spaceId, projectId, sourceItemId: current.source_item_id });
    }
    const updated = await this.getById(identity, projectId, corpusItemId);
    if (!updated) throw new HttpError(404, "Project corpus item not found");
    return projectCorpusItemOut(updated);
  }

  async backfillFromSources(identity: SpaceUserIdentity, projectId: string): Promise<ProjectCorpusBackfillResult> {
    return withQueryableTransaction(this.db, async (db) => {
      await assertProjectWriter(db, identity.spaceId, projectId, identity.userId);
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await lockCorpusProjects(db, { spaceId: identity.spaceId, projectId, sourceItemId: null });
      const sourceItems = await upsertProjectCorpusSourceItemsFromLinks(db, { spaceId: identity.spaceId, projectId });
      const sourceDecisions = await syncProjectCorpusSourceDecisions(db, { spaceId: identity.spaceId, projectId });
      await materializePassingProjectCorpusItems(db, { spaceId: identity.spaceId, projectId });
      const sourceObjects = await upsertProjectCorpusObjectsFromSourceItems(db, { spaceId: identity.spaceId, projectId });
      const evidenceItems = await upsertProjectCorpusEvidenceFromLinks(db, { spaceId: identity.spaceId, projectId });
      const evidenceObjects = await upsertProjectCorpusObjectsFromEvidence(db, { spaceId: identity.spaceId, projectId });
      const archivedSourceItems = await archiveCorpusSourceItemsWithoutActiveLinks(db, { spaceId: identity.spaceId, projectId });
      return {
        project_id: projectId,
        source_items: sourceItems,
        source_objects: sourceObjects,
        evidence_items: evidenceItems,
        evidence_objects: evidenceObjects,
        source_decisions: sourceDecisions,
        archived_source_items: archivedSourceItems,
      };
    });
  }

  private async resolveTarget(
    identity: SpaceUserIdentity,
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{
    objectId: string | null;
    sourceItemId: string | null;
    evidenceId: string | null;
    sourceConnectionId: string | null;
    sourceDecisionId: string | null;
    provenanceSourceItemId: string | null;
  }> {
    let objectId = optionalString(body.object_id);
    let sourceItemId = optionalString(body.source_item_id);
    const evidenceId = optionalString(body.evidence_id);
    const sourceDecisionId = optionalString(body.source_decision_id);
    if ([objectId, sourceItemId, evidenceId].filter(Boolean).length !== 1) {
      throw new HttpError(422, "exactly one of object_id, source_item_id, or evidence_id is required");
    }
    let sourceConnectionId = optionalString(body.source_connection_id);
    let targetSourceItemId = sourceItemId;
    if (objectId) {
      const object = await this.db.query<{ id: string }>(
        `SELECT so.id
           FROM space_objects so
          WHERE so.space_id = $1
            AND so.id = $2
            AND so.deleted_at IS NULL
            AND ${contentReadSql("space_object", "so", "$3")}
          LIMIT 1`,
        [identity.spaceId, objectId, identity.userId],
      );
      if (!object.rows[0]) throw new HttpError(422, "object_id is not readable by this user");
      const linkedSource = await this.db.query<{ source_item_id: string; source_connection_id: string | null }>(
        `SELECT psil.source_item_id, COALESCE(psil.source_connection_id, si.connection_id) AS source_connection_id
           FROM source_item_references sir
           JOIN project_source_item_links psil
             ON psil.space_id = sir.space_id
            AND psil.project_id = $3
            AND psil.source_item_id = sir.source_item_id
            AND psil.status = 'active'
           JOIN source_items si
             ON si.id = sir.source_item_id AND si.space_id = sir.space_id AND si.deleted_at IS NULL
          WHERE sir.space_id = $1 AND sir.reference_object_id = $2
            AND ${sourceItemReadableClause("si", "$4", false)}
          ORDER BY psil.matched_at DESC, psil.id ASC
          LIMIT 1`,
        [identity.spaceId, objectId, projectId, identity.userId],
      );
      targetSourceItemId = linkedSource.rows[0]?.source_item_id ?? null;
      sourceConnectionId ??= linkedSource.rows[0]?.source_connection_id ?? null;
    }
    if (sourceItemId) {
      const requestedSourceItemId = sourceItemId;
      const item = await this.db.query<{
        connection_id: string | null;
        reference_object_id: string | null;
        reference_readable: boolean;
      }>(
        `SELECT si.connection_id,
                sir.reference_object_id,
                CASE
                  WHEN sir.reference_object_id IS NULL THEN true
                  ELSE so.id IS NOT NULL AND ${contentReadSql("space_object", "so", "$3")}
                END AS reference_readable
           FROM source_items si
           LEFT JOIN source_item_references sir
             ON sir.source_item_id = si.id AND sir.space_id = si.space_id
           LEFT JOIN space_objects so
             ON so.id = sir.reference_object_id
            AND so.space_id = sir.space_id
            AND so.deleted_at IS NULL
          WHERE si.space_id = $1
            AND si.id = $2
            AND si.deleted_at IS NULL
            AND ${sourceItemReadableClause("si", "$3", false)}
          LIMIT 1`,
        [identity.spaceId, sourceItemId, identity.userId],
      );
      if (!item.rows[0]) throw new HttpError(422, "source_item_id is not readable by this user");
      sourceConnectionId ??= item.rows[0].connection_id;
      if (item.rows[0].reference_object_id) {
        if (!item.rows[0].reference_readable) {
          throw new HttpError(422, "source_item_id materializes to an object that is not readable by this user");
        }
        objectId = item.rows[0].reference_object_id;
        sourceItemId = null;
        targetSourceItemId = requestedSourceItemId;
      }
    }
    if (evidenceId) {
      const evidence = await this.db.query<{ source_item_id: string | null; source_item_connection_id: string | null }>(
        `SELECT COALESCE(ev.source_item_id, ev.origin_source_item_id) AS source_item_id,
                si.connection_id AS source_item_connection_id
           FROM extracted_evidence ev
           LEFT JOIN source_items si ON si.id = COALESCE(ev.source_item_id, ev.origin_source_item_id) AND si.space_id = ev.space_id
           LEFT JOIN source_snapshots ss ON ss.id=ev.source_snapshot_id AND ss.space_id=ev.space_id
           LEFT JOIN space_objects so ON so.id = ev.source_object_id AND so.space_id = ev.space_id
          WHERE ev.space_id = $1
            AND ev.id = $2
            AND ev.deleted_at IS NULL
            AND ${contentReadSql("extracted_evidence", "ev", "$3")}
            AND ${sourceSnapshotReadableForEvidenceClause("ev", "$3")}
            AND (
              (
                COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NOT NULL
                AND si.deleted_at IS NULL
                AND ${sourceItemReadableClause("si", "$3", false)}
              )
              OR (
                COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NULL
                AND ev.source_object_id IS NOT NULL
                AND so.deleted_at IS NULL
                AND ${contentReadSql("space_object", "so", "$3")}
              )
              OR (
                COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NULL
                AND ev.source_snapshot_id IS NOT NULL
                AND ss.id IS NOT NULL
              )
              OR (
                COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NULL
                AND ev.source_object_id IS NULL
              )
            )
          LIMIT 1`,
        [identity.spaceId, evidenceId, identity.userId],
      );
      if (!evidence.rows[0]) throw new HttpError(422, "evidence_id is not readable by this user");
      targetSourceItemId = evidence.rows[0].source_item_id;
      sourceConnectionId ??= evidence.rows[0].source_item_connection_id;
    }
    if (sourceDecisionId) {
      const decision = await this.db.query<{ source_connection_id: string | null; source_item_id: string }>(
        `SELECT sc.id AS source_connection_id, d.source_item_id
           FROM source_post_processing_item_decisions d
           LEFT JOIN source_channels ch ON ch.id = d.source_channel_id AND ch.space_id = d.space_id
           LEFT JOIN source_connections sc ON sc.id = ch.source_connection_id
         WHERE d.space_id = $1 AND d.project_id = $2 AND d.id = $3
          LIMIT 1`,
        [identity.spaceId, projectId, sourceDecisionId],
      );
      const row = decision.rows[0];
      if (!row) throw new HttpError(422, "source_decision_id does not reference this project");
      if (targetSourceItemId && row.source_item_id !== targetSourceItemId) {
        throw new HttpError(422, "source_decision_id must match the Corpus target's SourceItem");
      }
      if (objectId && !targetSourceItemId) {
        const reference = await this.db.query<{ found: boolean }>(
          `SELECT true AS found
             FROM source_item_references
            WHERE space_id = $1 AND reference_object_id = $2 AND source_item_id = $3
            LIMIT 1`,
          [identity.spaceId, objectId, row.source_item_id],
        );
        if (!reference.rows[0]) {
          throw new HttpError(422, "source_decision_id must originate from a SourceItem materialized as object_id");
        }
        targetSourceItemId = row.source_item_id;
      } else if (!targetSourceItemId) {
        throw new HttpError(422, "source_decision_id requires a Corpus target with SourceItem provenance");
      }
      sourceConnectionId ??= row.source_connection_id;
    }
    return {
      objectId,
      sourceItemId,
      evidenceId,
      sourceConnectionId,
      sourceDecisionId,
      provenanceSourceItemId: targetSourceItemId,
    };
  }

  private async getById(identity: SpaceUserIdentity, projectId: string, corpusItemId: string): Promise<ProjectCorpusItemRow | null> {
    const result = await this.db.query<ProjectCorpusItemRow>(
      `SELECT ${CORPUS_COLUMNS}
         FROM project_corpus_items pci
         LEFT JOIN space_objects so ON so.id = pci.object_id AND so.space_id = pci.space_id
         ${corpusPrimarySourceJoin("$4")}
         LEFT JOIN extracted_evidence ev ON ev.id = pci.evidence_id AND ev.space_id = pci.space_id
         LEFT JOIN source_items evidence_source
           ON evidence_source.id = COALESCE(ev.source_item_id, ev.origin_source_item_id)
          AND evidence_source.space_id = ev.space_id
          AND evidence_source.deleted_at IS NULL
         LEFT JOIN academic_papers ap ON ap.object_id = so.id AND ap.space_id = pci.space_id
         LEFT JOIN sources src ON src.object_id = so.id AND src.space_id = pci.space_id
        WHERE pci.space_id = $1 AND pci.project_id = $2 AND pci.id = $3
          AND (pci.object_id IS NULL OR (so.id IS NOT NULL AND ${contentReadSql("space_object", "so", "$4")}))
          AND (pci.source_item_id IS NULL OR si.id IS NOT NULL)
          AND (
            pci.evidence_id IS NULL
            OR (
              ev.id IS NOT NULL
              AND ${contentReadSql("extracted_evidence", "ev", "$4")}
              AND (
                COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NULL
                OR (
                  evidence_source.id IS NOT NULL
                  AND ${sourceItemReadableClause("evidence_source", "$4", false)}
                )
              )
              AND ${sourceSnapshotReadableForEvidenceClause("ev", "$4")}
            )
          )
        LIMIT 1`,
      [identity.spaceId, projectId, corpusItemId, identity.userId],
    );
    return result.rows[0] ?? null;
  }
}

export async function syncProjectCorpusForSourceItem(
  db: Queryable,
  input: { spaceId: string; sourceItemId: string; projectId?: string | null },
): Promise<{ source_items: number; source_objects: number; archived_source_items: number }> {
  return withQueryableTransaction(db, async (tx) => {
    await lockCorpusProjects(tx, input);
    const sourceItems = await upsertProjectCorpusSourceItemsFromLinks(tx, input);
    await materializePassingProjectCorpusItems(tx, input);
    const sourceObjects = await upsertProjectCorpusObjectsFromSourceItems(tx, input);
    const archivedSourceItems = await archiveCorpusSourceItemsWithoutActiveLinks(tx, input);
    return { source_items: sourceItems, source_objects: sourceObjects, archived_source_items: archivedSourceItems };
  });
}

export async function syncProjectCorpusEvidenceForSourceItem(
  db: Queryable,
  input: { spaceId: string; sourceItemId: string; projectId?: string | null },
): Promise<{ evidence_items: number; evidence_objects: number }> {
  return withQueryableTransaction(db, async (tx) => {
    await lockCorpusProjects(tx, input);
    const evidenceItems = await upsertProjectCorpusEvidenceFromLinks(tx, input);
    const evidenceObjects = await upsertProjectCorpusObjectsFromEvidence(tx, input);
    return { evidence_items: evidenceItems, evidence_objects: evidenceObjects };
  });
}

/**
 * Applies the latest source-post-processing decision to the project corpus.
 * User-confirmed triage is intentionally preserved by the SQL upsert below.
 */
export async function syncProjectCorpusDecisionForSourceItem(
  db: Queryable,
  input: { spaceId: string; sourceItemId: string; projectId?: string | null },
): Promise<number> {
  return withQueryableTransaction(db, async (tx) => {
    await lockCorpusProjects(tx, input);
    const decisions = await syncProjectCorpusSourceDecisions(tx, input);
    await materializePassingProjectCorpusItems(tx, input);
    await upsertProjectCorpusObjectsFromSourceItems(tx, input);
    return decisions;
  });
}

async function lockCorpusProjects(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<void> {
  const projects = await db.query<{ id: string; status: string }>(
    `SELECT project.id, project.status
       FROM projects project
      WHERE project.space_id = $1
        AND (
          ($3::varchar IS NOT NULL AND project.id = $3)
          OR (
            $3::varchar IS NULL
            AND $2::varchar IS NOT NULL
            AND (
              EXISTS (
                SELECT 1 FROM project_source_item_links link
                 WHERE link.space_id = project.space_id
                   AND link.project_id = project.id
                   AND link.source_item_id = $2
              )
              OR EXISTS (
                SELECT 1 FROM project_corpus_item_sources provenance
                 WHERE provenance.space_id = project.space_id
                   AND provenance.project_id = project.id
                   AND provenance.source_item_id = $2
              )
            )
          )
        )
      ORDER BY project.id
      FOR UPDATE`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null],
  );
  if (projects.rows.some((project) => project.status !== "active")) {
    throw new HttpError(409, "Project is archived; reactivate it before making changes");
  }
}

async function insertCorpusItemSourceProvenance(
  db: Queryable,
  input: { corpusItemId: string; spaceId: string; projectId: string; sourceItemId: string; now: string },
): Promise<void> {
  await db.query(
    `INSERT INTO project_corpus_item_sources (
       id, corpus_item_id, space_id, project_id, source_item_id, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (corpus_item_id, source_item_id) DO NOTHING`,
    [randomUUID(), input.corpusItemId, input.spaceId, input.projectId, input.sourceItemId, input.now],
  );
}

async function syncProjectCorpusItemSourceProvenance(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.query(
    `WITH candidates AS (
       SELECT pci.id AS corpus_item_id, pci.space_id, pci.project_id, pci.source_item_id
         FROM project_corpus_items pci
        WHERE pci.source_item_id IS NOT NULL
       UNION
       SELECT pci.id, pci.space_id, pci.project_id,
              COALESCE(ev.source_item_id, ev.origin_source_item_id) AS source_item_id
         FROM project_corpus_items pci
         JOIN extracted_evidence ev ON ev.id = pci.evidence_id AND ev.space_id = pci.space_id
        WHERE COALESCE(ev.source_item_id, ev.origin_source_item_id) IS NOT NULL
       UNION
       SELECT pci.id, pci.space_id, pci.project_id, psil.source_item_id
         FROM project_corpus_items pci
         JOIN source_item_references sir
           ON sir.reference_object_id = pci.object_id AND sir.space_id = pci.space_id
         JOIN project_source_item_links psil
           ON psil.space_id = pci.space_id
          AND psil.project_id = pci.project_id
          AND psil.source_item_id = sir.source_item_id
          AND psil.status = 'active'
     )
     INSERT INTO project_corpus_item_sources (
       id, corpus_item_id, space_id, project_id, source_item_id, created_at
     )
     SELECT gen_random_uuid()::varchar, candidate.corpus_item_id, candidate.space_id,
            candidate.project_id, candidate.source_item_id, $4
       FROM candidates candidate
       JOIN source_items si
         ON si.id = candidate.source_item_id AND si.space_id = candidate.space_id
      WHERE candidate.space_id = $1
        AND si.deleted_at IS NULL
        AND ($2::varchar IS NULL OR candidate.source_item_id = $2)
        AND ($3::varchar IS NULL OR candidate.project_id = $3)
     ON CONFLICT (corpus_item_id, source_item_id) DO NOTHING`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  return result.rowCount ?? 0;
}

async function upsertProjectCorpusSourceItemsFromLinks(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.query(
    `INSERT INTO project_corpus_items (
       id, space_id, project_id, source_item_id, source_connection_id,
       role, status, triage_status, read_status, reason, metadata_json, created_at, updated_at
     )
     SELECT DISTINCT ON (psil.project_id, psil.source_item_id)
            gen_random_uuid()::varchar, psil.space_id, psil.project_id, psil.source_item_id,
            COALESCE(psil.source_connection_id, si.connection_id),
            'candidate', 'active', 'new', 'unread',
            psil.match_reason, '{}'::jsonb, $4, $4
       FROM project_source_item_links psil
       JOIN source_items si ON si.id = psil.source_item_id AND si.space_id = psil.space_id
       LEFT JOIN source_item_references sir
         ON sir.source_item_id = si.id AND sir.space_id = si.space_id
      WHERE psil.space_id = $1
        AND psil.status = 'active'
        AND si.deleted_at IS NULL
        AND sir.source_item_id IS NULL
        AND ($2::varchar IS NULL OR psil.source_item_id = $2)
        AND ($3::varchar IS NULL OR psil.project_id = $3)
      ORDER BY psil.project_id, psil.source_item_id, psil.matched_at DESC, psil.id ASC
     ON CONFLICT (space_id, project_id, source_item_id)
       WHERE source_item_id IS NOT NULL
     DO UPDATE SET status = 'active',
                   source_connection_id = COALESCE(project_corpus_items.source_connection_id, EXCLUDED.source_connection_id),
                   reason = COALESCE(project_corpus_items.reason, EXCLUDED.reason),
                   updated_at = EXCLUDED.updated_at`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  return result.rowCount ?? 0;
}

async function upsertProjectCorpusObjectsFromSourceItems(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  await syncProjectCorpusItemSourceProvenance(db, input);
  const promoted = await db.query(
    `WITH promoted AS (
       SELECT DISTINCT ON (pci.project_id, sir.reference_object_id)
              pci.id, sir.reference_object_id
         FROM project_corpus_items pci
         JOIN source_item_references sir
           ON sir.source_item_id = pci.source_item_id AND sir.space_id = pci.space_id
        WHERE pci.space_id = $1
          AND pci.source_item_id IS NOT NULL
          AND ($2::varchar IS NULL OR pci.source_item_id = $2)
          AND ($3::varchar IS NULL OR pci.project_id = $3)
          AND NOT EXISTS (
            SELECT 1 FROM project_corpus_items existing
             WHERE existing.space_id = pci.space_id
               AND existing.project_id = pci.project_id
               AND existing.object_id = sir.reference_object_id
          )
        ORDER BY pci.project_id, sir.reference_object_id, pci.created_at ASC, pci.id ASC
     )
     UPDATE project_corpus_items pci
        SET object_id = promoted.reference_object_id,
            source_item_id = NULL,
            updated_at = $4
       FROM promoted
      WHERE pci.id = promoted.id`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  const result = await db.query(
    `INSERT INTO project_corpus_items (
       id, space_id, project_id, object_id, source_connection_id,
       role, status, triage_status, read_status, reason, metadata_json, created_at, updated_at
     )
     SELECT DISTINCT ON (psil.project_id, sir.reference_object_id)
            gen_random_uuid()::varchar, psil.space_id, psil.project_id, sir.reference_object_id,
            COALESCE(psil.source_connection_id, si.connection_id),
            'candidate', 'active', 'new', 'unread',
            psil.match_reason, '{}'::jsonb, $4, $4
       FROM project_source_item_links psil
       JOIN source_items si ON si.id = psil.source_item_id AND si.space_id = psil.space_id
       JOIN source_item_references sir
         ON sir.source_item_id = si.id AND sir.space_id = si.space_id
       JOIN space_objects so ON so.id = sir.reference_object_id AND so.space_id = sir.space_id
      WHERE psil.space_id = $1
        AND psil.status = 'active'
        AND si.deleted_at IS NULL
        AND so.deleted_at IS NULL
        AND ($2::varchar IS NULL OR psil.source_item_id = $2)
        AND ($3::varchar IS NULL OR psil.project_id = $3)
      ORDER BY psil.project_id, sir.reference_object_id, psil.matched_at DESC, psil.id ASC
     ON CONFLICT (space_id, project_id, object_id)
       WHERE object_id IS NOT NULL
     DO UPDATE SET status = 'active',
                   source_connection_id = COALESCE(project_corpus_items.source_connection_id, EXCLUDED.source_connection_id),
                   reason = COALESCE(project_corpus_items.reason, EXCLUDED.reason),
                   updated_at = EXCLUDED.updated_at`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  await syncProjectCorpusItemSourceProvenance(db, input);
  await db.query(
    `WITH duplicates AS (
       SELECT duplicate.id AS duplicate_id, canonical.id AS canonical_id, duplicate.space_id,
              duplicate.triage_status, duplicate.triage_confirmed_by_user,
              duplicate.read_status, duplicate.last_reviewed_at, duplicate.last_read_at,
              duplicate.source_decision_id, duplicate.relevance, duplicate.confidence,
              duplicate.reason, duplicate.created_at, duplicate.updated_at
         FROM project_corpus_items duplicate
         JOIN source_item_references sir
           ON sir.source_item_id = duplicate.source_item_id AND sir.space_id = duplicate.space_id
         JOIN project_corpus_items canonical
           ON canonical.space_id = duplicate.space_id
          AND canonical.project_id = duplicate.project_id
          AND canonical.object_id = sir.reference_object_id
        WHERE duplicate.space_id = $1
          AND ($2::varchar IS NULL OR duplicate.source_item_id = $2)
          AND ($3::varchar IS NULL OR duplicate.project_id = $3)
     ), selected_triage AS (
       SELECT DISTINCT ON (canonical_id) canonical_id, triage_status,
              COALESCE(last_reviewed_at, created_at) AS confirmed_at
         FROM duplicates
        WHERE triage_confirmed_by_user
        ORDER BY canonical_id, COALESCE(last_reviewed_at, created_at) DESC, duplicate_id ASC
     ), decision_candidates AS (
       SELECT duplicates.canonical_id, duplicates.source_decision_id,
              duplicates.triage_status AS decision_triage_status,
              duplicates.relevance, duplicates.confidence, duplicates.reason,
              decision.updated_at AS decision_updated_at,
              1 AS source_priority, duplicates.duplicate_id AS candidate_id
         FROM duplicates
         JOIN source_post_processing_item_decisions decision
           ON decision.id = duplicates.source_decision_id
          AND decision.space_id = duplicates.space_id
       UNION ALL
       SELECT canonical.id, canonical.source_decision_id,
              canonical.triage_status, canonical.relevance, canonical.confidence, canonical.reason,
              decision.updated_at, 0 AS source_priority, canonical.id AS candidate_id
         FROM project_corpus_items canonical
         JOIN (SELECT DISTINCT canonical_id FROM duplicates) duplicate_targets
           ON duplicate_targets.canonical_id = canonical.id
         JOIN source_post_processing_item_decisions decision
           ON decision.id = canonical.source_decision_id
          AND decision.space_id = canonical.space_id
     ), selected_decision AS (
       SELECT DISTINCT ON (canonical_id) canonical_id, source_decision_id,
              decision_triage_status, relevance, confidence, reason
         FROM decision_candidates
        ORDER BY canonical_id, decision_updated_at DESC, source_priority ASC, candidate_id ASC
     ), duplicate_state AS (
       SELECT canonical_id,
              max(CASE read_status
                    WHEN 'unread' THEN 0 WHEN 'skimmed' THEN 1
                    WHEN 'read' THEN 2 WHEN 'discussed' THEN 3 END) AS read_rank,
              max(last_reviewed_at) AS last_reviewed_at,
              max(last_read_at) AS last_read_at
        FROM duplicates
        GROUP BY canonical_id
     ), copied_provenance AS (
       INSERT INTO project_corpus_item_sources (
         id, corpus_item_id, space_id, project_id, source_item_id, created_at
       )
       SELECT gen_random_uuid()::varchar, duplicates.canonical_id,
              provenance.space_id, provenance.project_id, provenance.source_item_id, $4
         FROM duplicates
         JOIN project_corpus_item_sources provenance
           ON provenance.corpus_item_id = duplicates.duplicate_id
       ON CONFLICT (corpus_item_id, source_item_id) DO NOTHING
       RETURNING corpus_item_id
     ), merged AS (
       UPDATE project_corpus_items canonical
          SET triage_status = CASE
                WHEN canonical.triage_confirmed_by_user
                 AND (selected_triage.canonical_id IS NULL
                   OR COALESCE(canonical.last_reviewed_at, canonical.created_at) >= selected_triage.confirmed_at)
                  THEN canonical.triage_status
                ELSE COALESCE(
                  selected_triage.triage_status,
                  CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.decision_triage_status END,
                  canonical.triage_status
                )
              END,
              triage_confirmed_by_user = canonical.triage_confirmed_by_user OR selected_triage.canonical_id IS NOT NULL,
              read_status = CASE GREATEST(
                CASE canonical.read_status
                  WHEN 'unread' THEN 0 WHEN 'skimmed' THEN 1
                  WHEN 'read' THEN 2 WHEN 'discussed' THEN 3 END,
                duplicate_state.read_rank
              ) WHEN 0 THEN 'unread' WHEN 1 THEN 'skimmed' WHEN 2 THEN 'read' ELSE 'discussed' END,
              last_reviewed_at = GREATEST(
                canonical.last_reviewed_at,
                duplicate_state.last_reviewed_at,
                selected_triage.confirmed_at,
                CASE WHEN canonical.triage_confirmed_by_user THEN canonical.created_at END
              ),
              last_read_at = GREATEST(canonical.last_read_at, duplicate_state.last_read_at),
              source_decision_id = COALESCE(selected_decision.source_decision_id, canonical.source_decision_id),
              relevance = CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.relevance ELSE canonical.relevance END,
              confidence = CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.confidence ELSE canonical.confidence END,
              reason = CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.reason ELSE canonical.reason END,
              updated_at = $4
         FROM duplicate_state
         LEFT JOIN selected_triage ON selected_triage.canonical_id = duplicate_state.canonical_id
         LEFT JOIN selected_decision ON selected_decision.canonical_id = duplicate_state.canonical_id
        WHERE canonical.id = duplicate_state.canonical_id
        RETURNING canonical.id
     )
     DELETE FROM project_corpus_items duplicate
      USING duplicates, merged
      WHERE duplicate.id = duplicates.duplicate_id
        AND merged.id = duplicates.canonical_id`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  return (promoted.rowCount ?? 0) + (result.rowCount ?? 0);
}

async function upsertProjectCorpusEvidenceFromLinks(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.query(
    `INSERT INTO project_corpus_items (
       id, space_id, project_id, evidence_id, source_connection_id,
       role, status, triage_status, read_status, confidence, reason, metadata_json, created_at, updated_at
     )
     SELECT DISTINCT ON (el.target_id, ev.id)
            gen_random_uuid()::varchar, ev.space_id, el.target_id, ev.id,
            si.connection_id, 'candidate', 'active', 'new', 'unread',
            ev.confidence, el.reason, '{}'::jsonb, $4, $4
       FROM evidence_links el
       JOIN extracted_evidence ev ON ev.id = el.evidence_id AND ev.space_id = el.space_id
       LEFT JOIN source_items si ON si.id = ev.source_item_id AND si.space_id = ev.space_id
      WHERE el.space_id = $1
        AND el.target_type = 'project'
        AND el.status = 'active'
        AND ev.deleted_at IS NULL
        AND ($2::varchar IS NULL OR ev.source_item_id = $2)
        AND ($3::varchar IS NULL OR el.target_id = $3)
      ORDER BY el.target_id, ev.id, el.updated_at DESC, el.id ASC
     ON CONFLICT (space_id, project_id, evidence_id)
       WHERE evidence_id IS NOT NULL
     DO UPDATE SET status = 'active',
                   source_connection_id = COALESCE(project_corpus_items.source_connection_id, EXCLUDED.source_connection_id),
                   confidence = COALESCE(project_corpus_items.confidence, EXCLUDED.confidence),
                   reason = COALESCE(project_corpus_items.reason, EXCLUDED.reason),
                   updated_at = EXCLUDED.updated_at`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  return result.rowCount ?? 0;
}

async function upsertProjectCorpusObjectsFromEvidence(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  await syncProjectCorpusItemSourceProvenance(db, input);
  const promoted = await db.query(
    `WITH evidence_references AS (
       SELECT ev.id AS evidence_id, ev.space_id, ev.source_item_id,
              COALESCE(sir.reference_object_id, so.id) AS reference_object_id
         FROM extracted_evidence ev
         LEFT JOIN source_item_references sir
           ON sir.source_item_id = ev.source_item_id AND sir.space_id = ev.space_id
         LEFT JOIN space_objects so
           ON so.id = ev.source_object_id AND so.space_id = ev.space_id
          AND so.object_type = 'source' AND so.deleted_at IS NULL
        WHERE ev.space_id = $1 AND ev.deleted_at IS NULL
     ), promoted AS (
       SELECT DISTINCT ON (pci.project_id, er.reference_object_id)
              pci.id, er.reference_object_id
         FROM project_corpus_items pci
         JOIN evidence_references er
           ON er.evidence_id = pci.evidence_id AND er.space_id = pci.space_id
        WHERE er.reference_object_id IS NOT NULL
          AND ($2::varchar IS NULL OR er.source_item_id = $2)
          AND ($3::varchar IS NULL OR pci.project_id = $3)
          AND NOT EXISTS (
            SELECT 1 FROM project_corpus_items existing
             WHERE existing.space_id = pci.space_id
               AND existing.project_id = pci.project_id
               AND existing.object_id = er.reference_object_id
          )
        ORDER BY pci.project_id, er.reference_object_id, pci.created_at ASC, pci.id ASC
     )
     UPDATE project_corpus_items pci
        SET object_id = promoted.reference_object_id,
            evidence_id = NULL,
            updated_at = $4
       FROM promoted
      WHERE pci.id = promoted.id`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  const result = await db.query(
    `WITH evidence_references AS (
       SELECT ev.id AS evidence_id, ev.space_id, ev.source_item_id,
              COALESCE(sir.reference_object_id, so.id) AS reference_object_id
         FROM extracted_evidence ev
         LEFT JOIN source_item_references sir
           ON sir.source_item_id = ev.source_item_id AND sir.space_id = ev.space_id
         LEFT JOIN space_objects so
           ON so.id = ev.source_object_id AND so.space_id = ev.space_id
          AND so.object_type = 'source' AND so.deleted_at IS NULL
        WHERE ev.space_id = $1 AND ev.deleted_at IS NULL
     )
     INSERT INTO project_corpus_items (
       id, space_id, project_id, object_id, source_connection_id,
       role, status, triage_status, read_status, confidence, reason, metadata_json, created_at, updated_at
     )
     SELECT DISTINCT ON (el.target_id, er.reference_object_id)
            gen_random_uuid()::varchar, ev.space_id, el.target_id, er.reference_object_id,
            si.connection_id,
            'candidate', 'active', 'new', 'unread',
            ev.confidence, el.reason, '{}'::jsonb, $4, $4
       FROM evidence_links el
       JOIN extracted_evidence ev ON ev.id = el.evidence_id AND ev.space_id = el.space_id
       JOIN evidence_references er ON er.evidence_id = ev.id AND er.space_id = ev.space_id
       JOIN space_objects reference ON reference.id = er.reference_object_id AND reference.space_id = er.space_id
       LEFT JOIN source_items si ON si.id = ev.source_item_id AND si.space_id = ev.space_id
      WHERE el.space_id = $1
        AND el.target_type = 'project'
        AND el.status = 'active'
        AND ev.deleted_at IS NULL
        AND er.reference_object_id IS NOT NULL
        AND reference.deleted_at IS NULL
        AND ($2::varchar IS NULL OR ev.source_item_id = $2)
        AND ($3::varchar IS NULL OR el.target_id = $3)
      ORDER BY el.target_id, er.reference_object_id, el.updated_at DESC, el.id ASC
     ON CONFLICT (space_id, project_id, object_id)
       WHERE object_id IS NOT NULL
     DO UPDATE SET status = 'active',
                   source_connection_id = COALESCE(project_corpus_items.source_connection_id, EXCLUDED.source_connection_id),
                   confidence = COALESCE(project_corpus_items.confidence, EXCLUDED.confidence),
                   reason = COALESCE(project_corpus_items.reason, EXCLUDED.reason),
                   updated_at = EXCLUDED.updated_at`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  await syncProjectCorpusItemSourceProvenance(db, input);
  await db.query(
    `WITH evidence_references AS (
       SELECT ev.id AS evidence_id, ev.space_id, ev.source_item_id,
              COALESCE(sir.reference_object_id, so.id) AS reference_object_id
         FROM extracted_evidence ev
         LEFT JOIN source_item_references sir
           ON sir.source_item_id = ev.source_item_id AND sir.space_id = ev.space_id
         LEFT JOIN space_objects so
           ON so.id = ev.source_object_id AND so.space_id = ev.space_id
          AND so.object_type = 'source' AND so.deleted_at IS NULL
        WHERE ev.space_id = $1 AND ev.deleted_at IS NULL
     ), duplicates AS (
       SELECT duplicate.id AS duplicate_id, canonical.id AS canonical_id, duplicate.space_id,
              duplicate.triage_status, duplicate.triage_confirmed_by_user,
              duplicate.read_status, duplicate.last_reviewed_at, duplicate.last_read_at,
              duplicate.source_decision_id, duplicate.relevance, duplicate.confidence,
              duplicate.reason, duplicate.created_at, duplicate.updated_at
         FROM project_corpus_items duplicate
         JOIN evidence_references er
           ON er.evidence_id = duplicate.evidence_id AND er.space_id = duplicate.space_id
         JOIN project_corpus_items canonical
           ON canonical.space_id = duplicate.space_id
          AND canonical.project_id = duplicate.project_id
          AND canonical.object_id = er.reference_object_id
        WHERE er.reference_object_id IS NOT NULL
          AND ($2::varchar IS NULL OR er.source_item_id = $2)
          AND ($3::varchar IS NULL OR duplicate.project_id = $3)
     ), selected_triage AS (
       SELECT DISTINCT ON (canonical_id) canonical_id, triage_status,
              COALESCE(last_reviewed_at, created_at) AS confirmed_at
         FROM duplicates
        WHERE triage_confirmed_by_user
        ORDER BY canonical_id, COALESCE(last_reviewed_at, created_at) DESC, duplicate_id ASC
     ), decision_candidates AS (
       SELECT duplicates.canonical_id, duplicates.source_decision_id,
              duplicates.triage_status AS decision_triage_status,
              duplicates.relevance, duplicates.confidence, duplicates.reason,
              decision.updated_at AS decision_updated_at,
              1 AS source_priority, duplicates.duplicate_id AS candidate_id
         FROM duplicates
         JOIN source_post_processing_item_decisions decision
           ON decision.id = duplicates.source_decision_id
          AND decision.space_id = duplicates.space_id
       UNION ALL
       SELECT canonical.id, canonical.source_decision_id,
              canonical.triage_status, canonical.relevance, canonical.confidence, canonical.reason,
              decision.updated_at, 0 AS source_priority, canonical.id AS candidate_id
         FROM project_corpus_items canonical
         JOIN (SELECT DISTINCT canonical_id FROM duplicates) duplicate_targets
           ON duplicate_targets.canonical_id = canonical.id
         JOIN source_post_processing_item_decisions decision
           ON decision.id = canonical.source_decision_id
          AND decision.space_id = canonical.space_id
     ), selected_decision AS (
       SELECT DISTINCT ON (canonical_id) canonical_id, source_decision_id,
              decision_triage_status, relevance, confidence, reason
         FROM decision_candidates
        ORDER BY canonical_id, decision_updated_at DESC, source_priority ASC, candidate_id ASC
     ), duplicate_state AS (
       SELECT canonical_id,
              max(CASE read_status
                    WHEN 'unread' THEN 0 WHEN 'skimmed' THEN 1
                    WHEN 'read' THEN 2 WHEN 'discussed' THEN 3 END) AS read_rank,
              max(last_reviewed_at) AS last_reviewed_at,
              max(last_read_at) AS last_read_at
        FROM duplicates
        GROUP BY canonical_id
     ), copied_provenance AS (
       INSERT INTO project_corpus_item_sources (
         id, corpus_item_id, space_id, project_id, source_item_id, created_at
       )
       SELECT gen_random_uuid()::varchar, duplicates.canonical_id,
              provenance.space_id, provenance.project_id, provenance.source_item_id, $4
         FROM duplicates
         JOIN project_corpus_item_sources provenance
           ON provenance.corpus_item_id = duplicates.duplicate_id
       ON CONFLICT (corpus_item_id, source_item_id) DO NOTHING
       RETURNING corpus_item_id
     ), merged AS (
       UPDATE project_corpus_items canonical
          SET triage_status = CASE
                WHEN canonical.triage_confirmed_by_user
                 AND (selected_triage.canonical_id IS NULL
                   OR COALESCE(canonical.last_reviewed_at, canonical.created_at) >= selected_triage.confirmed_at)
                  THEN canonical.triage_status
                ELSE COALESCE(
                  selected_triage.triage_status,
                  CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.decision_triage_status END,
                  canonical.triage_status
                )
              END,
              triage_confirmed_by_user = canonical.triage_confirmed_by_user OR selected_triage.canonical_id IS NOT NULL,
              read_status = CASE GREATEST(
                CASE canonical.read_status
                  WHEN 'unread' THEN 0 WHEN 'skimmed' THEN 1
                  WHEN 'read' THEN 2 WHEN 'discussed' THEN 3 END,
                duplicate_state.read_rank
              ) WHEN 0 THEN 'unread' WHEN 1 THEN 'skimmed' WHEN 2 THEN 'read' ELSE 'discussed' END,
              last_reviewed_at = GREATEST(
                canonical.last_reviewed_at,
                duplicate_state.last_reviewed_at,
                selected_triage.confirmed_at,
                CASE WHEN canonical.triage_confirmed_by_user THEN canonical.created_at END
              ),
              last_read_at = GREATEST(canonical.last_read_at, duplicate_state.last_read_at),
              source_decision_id = COALESCE(selected_decision.source_decision_id, canonical.source_decision_id),
              relevance = CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.relevance ELSE canonical.relevance END,
              confidence = CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.confidence ELSE canonical.confidence END,
              reason = CASE WHEN selected_decision.canonical_id IS NOT NULL THEN selected_decision.reason ELSE canonical.reason END,
              updated_at = $4
         FROM duplicate_state
         LEFT JOIN selected_triage ON selected_triage.canonical_id = duplicate_state.canonical_id
         LEFT JOIN selected_decision ON selected_decision.canonical_id = duplicate_state.canonical_id
        WHERE canonical.id = duplicate_state.canonical_id
        RETURNING canonical.id
     )
     DELETE FROM project_corpus_items duplicate
      USING duplicates, merged
      WHERE duplicate.id = duplicates.duplicate_id
        AND merged.id = duplicates.canonical_id`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  return (promoted.rowCount ?? 0) + (result.rowCount ?? 0);
}

async function syncProjectCorpusSourceDecisions(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.query(
    `WITH latest_decisions AS (
       SELECT DISTINCT ON (d.project_id, d.source_item_id)
              d.id, d.space_id, d.project_id, sc.id AS source_connection_id, d.source_item_id,
              d.relevance, d.confidence, d.reason
         FROM source_post_processing_item_decisions d
         JOIN source_items si ON si.id = d.source_item_id AND si.space_id = d.space_id
         LEFT JOIN source_channels ch ON ch.id = d.source_channel_id AND ch.space_id = d.space_id
         LEFT JOIN source_connections sc ON sc.id = ch.source_connection_id
        WHERE d.space_id = $1
          AND si.deleted_at IS NULL
          AND d.project_id IS NOT NULL
          AND ($2::varchar IS NULL OR d.source_item_id = $2)
          AND ($3::varchar IS NULL OR d.project_id = $3)
        ORDER BY d.project_id, d.source_item_id, d.research_question_version DESC, d.updated_at DESC, d.id ASC
     )
     INSERT INTO project_corpus_items (
       id, space_id, project_id, source_item_id, source_connection_id, source_decision_id,
       role, status, triage_status, read_status, relevance, confidence, reason,
       metadata_json, created_at, updated_at, last_reviewed_at
     )
     SELECT gen_random_uuid()::varchar, d.space_id, d.project_id, d.source_item_id,
            d.source_connection_id, d.id,
            'candidate', 'active',
            CASE d.relevance
              WHEN 'relevant' THEN 'relevant'
              WHEN 'maybe' THEN 'maybe'
              ELSE 'excluded'
            END,
            'unread', d.relevance, d.confidence, d.reason, '{}'::jsonb, $4, $4, $4
       FROM latest_decisions d
     ON CONFLICT (space_id, project_id, source_item_id)
       WHERE source_item_id IS NOT NULL
     DO UPDATE SET status = 'active',
                   source_connection_id = COALESCE(project_corpus_items.source_connection_id, EXCLUDED.source_connection_id),
                   source_decision_id = EXCLUDED.source_decision_id,
                   relevance = EXCLUDED.relevance,
                   confidence = EXCLUDED.confidence,
                   triage_status = CASE
                     WHEN project_corpus_items.triage_confirmed_by_user THEN project_corpus_items.triage_status
                     WHEN project_corpus_items.triage_status IN ('new', 'relevant', 'maybe', 'excluded')
                       THEN EXCLUDED.triage_status
                     ELSE project_corpus_items.triage_status
                   END,
                   reason = COALESCE(EXCLUDED.reason, project_corpus_items.reason),
                   updated_at = EXCLUDED.updated_at,
                   last_reviewed_at = CASE
                     WHEN project_corpus_items.triage_confirmed_by_user THEN project_corpus_items.last_reviewed_at
                     WHEN project_corpus_items.triage_status IN ('new', 'relevant', 'maybe', 'excluded')
                       THEN EXCLUDED.updated_at
                     ELSE project_corpus_items.last_reviewed_at
                   END`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  return result.rowCount ?? 0;
}

async function archiveCorpusSourceItemsWithoutActiveLinks(
  db: Queryable,
  input: { spaceId: string; sourceItemId?: string | null; projectId?: string | null },
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.query(
    `UPDATE project_corpus_items pci
        SET status = 'archived',
            updated_at = $4
      WHERE pci.space_id = $1
        AND pci.object_id IS NULL
        AND pci.evidence_id IS NULL
        AND pci.source_item_id IS NOT NULL
        AND pci.status = 'active'
        AND ($2::varchar IS NULL OR pci.source_item_id = $2)
        AND ($3::varchar IS NULL OR pci.project_id = $3)
        AND NOT EXISTS (
          SELECT 1
            FROM project_source_item_links psil
           WHERE psil.space_id = pci.space_id
             AND psil.project_id = pci.project_id
             AND psil.source_item_id = pci.source_item_id
             AND psil.status = 'active'
        )`,
    [input.spaceId, input.sourceItemId ?? null, input.projectId ?? null, now],
  );
  return result.rowCount ?? 0;
}

function projectCorpusItemOut(row: ProjectCorpusItemRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    object_id: row.object_id,
    source_item_id: row.source_item_id,
    evidence_id: row.evidence_id,
    source_connection_id: row.source_connection_id,
    source_decision_id: row.source_decision_id,
    role: row.role,
    status: row.status,
    triage_status: row.triage_status,
    triage_confirmed_by_user: row.triage_confirmed_by_user,
    read_status: row.read_status,
    relevance: row.relevance,
    confidence: row.confidence,
    reason: row.reason,
    added_by_user_id: row.added_by_user_id,
    metadata_json: objectValue(row.metadata_json),
    created_at: dateIso(row.created_at) ?? new Date(0).toISOString(),
    updated_at: dateIso(row.updated_at) ?? new Date(0).toISOString(),
    last_reviewed_at: dateIso(row.last_reviewed_at),
    last_read_at: dateIso(row.last_read_at),
    object: row.object_id
      ? {
          id: row.object_id,
          object_type: row.object_type,
          title: row.object_title,
          summary: row.object_summary,
          status: row.object_status,
          // academic_papers.paper_type is NOT NULL (defaults to 'article'),
          // so it's a reliable "the LEFT JOIN matched" signal — arxiv_id/doi
          // are both nullable and a manually-created paper can have neither.
          academic: row.academic_paper_type !== null
            ? {
                arxiv_id: row.academic_arxiv_id,
                doi: row.academic_doi,
                publication_date: dateIso(row.academic_publication_date),
                venue: row.academic_venue,
                paper_type: row.academic_paper_type,
                cited_by_count: row.academic_cited_by_count,
                reference_count: row.academic_reference_count,
                source_uri: row.academic_source_uri,
                authors: Array.isArray(row.academic_authors) ? row.academic_authors : [],
                categories: Array.isArray(row.academic_categories) ? row.academic_categories : [],
              }
            : null,
        }
      : null,
    source_item: row.source_item_id
      ? {
          id: row.source_item_id,
          item_type: row.source_item_type,
          title: row.source_item_title,
          source_uri: row.source_item_uri,
          source_domain: row.source_item_domain,
          excerpt: row.source_item_excerpt,
        }
      : null,
    evidence: row.evidence_id
      ? {
          id: row.evidence_id,
          evidence_type: row.evidence_type,
          title: row.evidence_title,
          content_excerpt: row.evidence_excerpt,
        }
      : null,
  };
}

function conflictClause(target: { objectId: string | null; evidenceId: string | null; sourceItemId: string | null }): string {
  if (target.objectId) {
    return `ON CONFLICT (space_id, project_id, object_id) WHERE object_id IS NOT NULL`;
  }
  if (target.evidenceId) {
    return `ON CONFLICT (space_id, project_id, evidence_id) WHERE evidence_id IS NOT NULL AND object_id IS NULL`;
  }
  return `ON CONFLICT (space_id, project_id, source_item_id) WHERE source_item_id IS NOT NULL AND object_id IS NULL AND evidence_id IS NULL`;
}

function roleValue(value: unknown): ProjectCorpusRole | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!ROLES.has(text as ProjectCorpusRole)) throw new HttpError(422, "role is invalid");
  return text as ProjectCorpusRole;
}

function statusValue(value: unknown): ProjectCorpusStatus | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!STATUSES.has(text as ProjectCorpusStatus)) throw new HttpError(422, "status must be active or archived");
  return text as ProjectCorpusStatus;
}

function triageStatusValue(value: unknown): ProjectCorpusTriageStatus | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!TRIAGE_STATUSES.has(text as ProjectCorpusTriageStatus)) throw new HttpError(422, "triage_status is invalid");
  return text as ProjectCorpusTriageStatus;
}

function readStatusValue(value: unknown): ProjectCorpusReadStatus | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!READ_STATUSES.has(text as ProjectCorpusReadStatus)) throw new HttpError(422, "read_status is invalid");
  return text as ProjectCorpusReadStatus;
}

function relevanceValue(value: unknown): ProjectCorpusRelevance | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!RELEVANCES.has(text as ProjectCorpusRelevance)) throw new HttpError(422, "relevance is invalid");
  return text as ProjectCorpusRelevance;
}

function confidenceValue(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const confidence = numberValue(value);
  if (confidence === null) return null;
  if (confidence < 0 || confidence > 1) throw new HttpError(422, "confidence must be between 0 and 1");
  return confidence;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

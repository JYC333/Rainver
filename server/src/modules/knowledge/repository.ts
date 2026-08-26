import { PgOntologyRepository } from "../ontology/repository.js";
import { assertEvidenceableObjectType } from "../ontology/validation.js";
import { hasDeclaration } from "../ontology/linkTypes.js";
import { buildSpaceObjectInsert } from "../../db/spaceObjectWriter.js";
import {
  appendMarginalia,
  type MarginaliaInput,
  type MarginaliaProjection,
} from "./noteMarginalia.js";
import {
  accessibleProjectIds,
  assertProjectReadable,
  assertProjectWriter,
  canWriteProject,
} from "../projects/access.js";
import { objectStatusScalarSql } from "../../db/objectStatusSql.js";
import { createHash, randomUUID } from "node:crypto";
import {
  HttpError,
  countFromRow,
  dateIso,
  numberValue,
  optionalObject,
  optionalString,
  page,
  requiredString,
  stringArray,
  withQueryableTransaction,
  type SpaceUserIdentity,
  type Queryable,
  confidence,
} from "../routeUtils/common.js";
import { contentReadSql, contentVisibilityParamFilterSql } from "../access/contentAccessSql.js";
import { recordDetailRead } from "../contentAccess/audit.js";
import { proposalToOut } from "../proposals/repository.js";
import { insertProposalRow } from "../proposals/reviewPackets.js";
import type { ProposalOut } from "@rainver/protocol";
import {
  canMutateClaim,
  canMutateKnowledge,
  claimOut,
  claimSourceOut,
  claimSummaryOut,
  knowledgeItemOut,
  knowledgeSummaryOut,
  normalizeDates,
  noteCollectionOut,
  noteOut,
  noteSummaryOut,
  objectRelationOut,
  sourceOut,
  sourceSummaryOut,
} from "./knowledgeRepositoryMappers.js";
import {
  CLAIM_COLUMNS,
  CLAIM_CONFIDENCE_METHODS,
  CLAIM_EVIDENCE_ROLES,
  CLAIM_FROM,
  CLAIM_KINDS,
  CLAIM_RESOLUTION_STATES,
  CLAIM_SOURCE_COLUMNS,
  CLAIM_SOURCE_REF_TYPES,
  CLAIM_SOURCE_TRUST_LEVELS,
  CLAIM_STATUSES,
  CONTENT_FORMATS,
  KNOWLEDGE_ITEM_FROM,
  KNOWLEDGE_ITEM_COLUMNS,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_VISIBILITIES,
  NOTE_FROM,
  NOTE_COLLECTION_COLUMNS,
  NOTE_COLUMNS,
  NOTE_PLACEMENTS_JOIN,
  NOTE_STATUSES,
  OBJECT_RELATION_COLUMNS,
  SOURCE_FROM,
  SOURCE_COLUMNS,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  type ClaimRow,
  type ClaimSourceRow,
  type KnowledgeItemRow,
  type NoteCollectionRow,
  type NoteRow,
  type ObjectRelationRow,
  type ProvenanceLinkRow,
  type SourceRow,
} from "./knowledgeRepositoryRows.js";
import {
  RetrievalProjectionService,
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourcePolicyAllowsRead,
} from "../retrieval/index.js";
import { knowledgeRetrievalRegistry } from "./retrievalAdapter.js";
import { isKnowledgeRetrievalObjectType } from "./retrievalObjectTypes.js";
import { markdownToPm } from "./noteDocument.js";
import { ensureProjectNotesFolder, projectOwningCollection } from "./noteProjectFolders.js";
import { NOTE_PROJECT_ROLE_DEFAULT_TITLES } from "./noteProjectRoles.js";
import { listNoteRevisions as listNoteRevisionRows } from "./noteRevisionService.js";
import {
  listSpaceObjectProjectShares,
  revokeSpaceObjectProjectShare,
} from "./spaceObjectProjectShares.js";
import {
  addNotePlacement,
  moveNoteToCollection,
  removeNotePlacement,
  withNoteWrites,
  type NoteInsert,
  type NoteWriteScope,
} from "./noteWriter.js";
import {
  claimCreateStatusError,
  claimResolutionStateError,
  claimStatusTransitionError,
} from "./claimStatusRules.js";

interface SpaceObjectRow {
  id: string;
  space_id: string;
  object_type: string;
  title: string;
  status: string;
  visibility: string;
  owner_user_id: string | null;
  primary_project_id: string | null;
  project_folder_id: string | null;
  created_by_user_id: string | null;
}



interface NoteLinkRow {
  id: string;
  space_id: string;
  from_object_id: string;
  from_object_type: string;
  to_object_id: string;
  to_object_type: string;
  link_type: string;
  status: string;
  confidence: number | string | null;
  metadata_json: unknown;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}



const OBJECT_PROFILE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const NOTE_PURGE_RETENTION_DAYS = 30;

export class PgKnowledgeRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Counts for the Knowledge overview — every one of them gated.
   *
   * Three of these four used to filter on `space_id` alone while the fourth
   * applied the content gate, which is the shape an oversight takes rather than
   * a decision: whoever added the claim count gated it and did not backfill the
   * older three. A count is a weaker leak than a list — no titles, no bodies —
   * but it is still an answer about content the viewer cannot open, and "47
   * notes" next to twelve openable ones is also just wrong as a number.
   */
  async summary(identity: SpaceUserIdentity): Promise<Record<string, unknown>> {
    const [notes, wiki, sources, claims] = await Promise.all([
      this.db.query<{ status: string; total: string }>(
        `SELECT n.status, count(*)::text AS total
           FROM notes n
           JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
          WHERE n.space_id = $1 AND so.object_type = 'note'
            AND ${this.readableSpaceObjectClause("so")}
          GROUP BY n.status`,
        [identity.spaceId, identity.userId],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM ${KNOWLEDGE_ITEM_FROM}
          WHERE ki.space_id = $1 AND ki.status = 'active'
            AND ${this.readableSpaceObjectClause("so")}`,
        [identity.spaceId, identity.userId],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM ${SOURCE_FROM}
         WHERE s.space_id = $1
           AND ${this.readableSpaceObjectClause("so")}`,
        [identity.spaceId, identity.userId],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM ${CLAIM_FROM}
          WHERE c.space_id = $1
            AND c.status = 'active'
            AND ${this.readableSpaceObjectClause("so")}`,
        [identity.spaceId, identity.userId],
      ),
    ]);
    const noteCounts = { active: 0, archived: 0, deleted: 0, total: 0 };
    for (const row of notes.rows) {
      const total = Number(row.total);
      if (row.status === "active") noteCounts.active = total;
      if (row.status === "archived") noteCounts.archived = total;
      if (row.status === "deleted") noteCounts.deleted = total;
      noteCounts.total += total;
    }
    return {
      notes: noteCounts,
      wiki: { active: countFromRow(wiki.rows[0]) },
      sources: { total: countFromRow(sources.rows[0]) },
      claims: { active: countFromRow(claims.rows[0]) },
    };
  }









  async listItems(identity: SpaceUserIdentity, filters: {
    knowledgeKind: string | null;
    status: string | null;
    visibility: string | null;
    projectId: string | null;
    projectFolderId: string | null;
    q: string | null;
    limit: number;
    offset: number;
  }): Promise<Record<string, unknown>> {
    const built = this.buildItemWhere(identity, filters);
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${KNOWLEDGE_ITEM_FROM} ${built.where}`,
      built.params,
    );
    const rows = await this.db.query<KnowledgeItemRow>(
      `SELECT ${KNOWLEDGE_ITEM_COLUMNS}
         FROM ${KNOWLEDGE_ITEM_FROM}
        ${built.where}
        ORDER BY so.updated_at DESC, ki.object_id DESC
        LIMIT $${built.params.length + 1} OFFSET $${built.params.length + 2}`,
      [...built.params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(knowledgeSummaryOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async getItem(identity: SpaceUserIdentity, itemId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getVisibleItemRow(identity, itemId);
    if (!row) return null;
    return knowledgeItemOut(row, await this.listKnowledgeSourceRefs(identity, row.id));
  }

  async itemRelations(identity: SpaceUserIdentity, itemId: string): Promise<Record<string, unknown>[]> {
    const item = await this.getVisibleItemRow(identity, itemId);
    if (!item) throw new HttpError(404, "Knowledge item not found");
    const rows = await this.db.query<ObjectRelationRow>(
      `SELECT r.id, r.space_id,
              r.from_object_id, from_so.object_type AS from_object_type,
              r.to_object_id, to_so.object_type AS to_object_type,
              r.link_type, r.status, r.confidence, r.evidence_summary,
              r.source_claim_id, r.source_object_id, r.source_proposal_id,
              r.metadata_json, r.created_by_user_id, r.created_by_agent_id,
              r.created_at, r.updated_at
         FROM object_relations r
         JOIN space_objects from_so
           ON from_so.id = r.from_object_id
          AND from_so.space_id = r.space_id
          AND from_so.object_type = 'knowledge_item'
          AND from_so.deleted_at IS NULL
         JOIN space_objects to_so
           ON to_so.id = r.to_object_id
          AND to_so.space_id = r.space_id
          AND to_so.object_type = 'knowledge_item'
          AND to_so.deleted_at IS NULL
        WHERE r.space_id = $1
          AND (r.from_object_id = $3 OR r.to_object_id = $3)
          AND r.status <> 'archived'
          AND ${this.readableSpaceObjectClause("from_so")}
          AND ${this.readableSpaceObjectClause("to_so")}
        ORDER BY r.updated_at DESC, r.id DESC`,
      [identity.spaceId, identity.userId, itemId],
    );
    return rows.rows.map(objectRelationAsKnowledgeRelationOut);
  }

  async entityLinks(identity: SpaceUserIdentity, filters: Record<string, string | undefined>): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const clauses = [
      "r.space_id = $1",
      this.readableSpaceObjectClause("from_so"),
      this.readableSpaceObjectClause("to_so"),
    ];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const sourceType = optionalString(filters.source_type);
    const sourceId = optionalString(filters.source_id);
    const targetType = optionalString(filters.target_type);
    const targetId = optionalString(filters.target_id);
    const status = optionalString(filters.status);
    if (sourceType) clauses.push(`from_so.object_type = ${add(sourceType)}`);
    if (sourceId) clauses.push(`r.from_object_id = ${add(sourceId)}`);
    if (targetType) clauses.push(`to_so.object_type = ${add(targetType)}`);
    if (targetId) clauses.push(`r.to_object_id = ${add(targetId)}`);
    if (status) clauses.push(`r.status = ${add(status)}`);
    const rows = await this.db.query<ObjectRelationRow>(
      `SELECT r.id, r.space_id,
              r.from_object_id, from_so.object_type AS from_object_type,
              r.to_object_id, to_so.object_type AS to_object_type,
              r.link_type, r.status, r.confidence, r.evidence_summary,
              r.source_claim_id, r.source_object_id, r.source_proposal_id,
              r.metadata_json, r.created_by_user_id, r.created_by_agent_id,
              r.created_at, r.updated_at
         FROM object_relations r
         JOIN space_objects from_so
           ON from_so.id = r.from_object_id
          AND from_so.space_id = r.space_id
          AND from_so.deleted_at IS NULL
         JOIN space_objects to_so
           ON to_so.id = r.to_object_id
          AND to_so.space_id = r.space_id
          AND to_so.deleted_at IS NULL
        WHERE ${clauses.join(" AND ")}
        ORDER BY r.created_at DESC, r.id DESC`,
      params,
    );
    return rows.rows.map(objectRelationAsEntityLinkOut);
  }

  async listClaims(identity: SpaceUserIdentity, filters: {
    claimKind: string | null;
    status: string | null;
    subjectObjectId: string | null;
    q: string | null;
    limit: number;
    offset: number;
  }): Promise<Record<string, unknown>> {
    const built = this.buildClaimWhere(identity, filters);
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${CLAIM_FROM} ${built.where}`,
      built.params,
    );
    const rows = await this.db.query<ClaimRow>(
      `SELECT ${CLAIM_COLUMNS}
         FROM ${CLAIM_FROM}
        ${built.where}
        ORDER BY so.updated_at DESC, c.object_id DESC
        LIMIT $${built.params.length + 1} OFFSET $${built.params.length + 2}`,
      [...built.params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(claimSummaryOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async getClaim(identity: SpaceUserIdentity, claimId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getVisibleClaimRow(identity, claimId);
    if (!row) return null;
    return claimOut(row, await this.listClaimSourceRows(identity, claimId));
  }

  async claimSources(identity: SpaceUserIdentity, claimId: string): Promise<Record<string, unknown>[]> {
    const claim = await this.getVisibleClaimRow(identity, claimId);
    if (!claim) throw new HttpError(404, "Claim not found");
    return this.listClaimSourceRows(identity, claimId);
  }

  async claimRelations(identity: SpaceUserIdentity, claimId: string): Promise<Record<string, unknown>[]> {
    const claim = await this.getVisibleClaimRow(identity, claimId);
    if (!claim) throw new HttpError(404, "Claim not found");
    const rows = await this.db.query<ObjectRelationRow>(
      `SELECT r.id, r.space_id,
              r.from_object_id, from_so.object_type AS from_object_type,
              r.to_object_id, to_so.object_type AS to_object_type,
              r.link_type, r.status, r.confidence, r.evidence_summary,
              r.source_claim_id, r.source_object_id, r.source_proposal_id,
              r.metadata_json, r.created_by_user_id, r.created_by_agent_id,
              r.created_at, r.updated_at
         FROM object_relations r
         JOIN space_objects from_so
           ON from_so.id = r.from_object_id
          AND from_so.space_id = r.space_id
          AND from_so.object_type = 'claim'
          AND from_so.deleted_at IS NULL
         JOIN space_objects to_so
           ON to_so.id = r.to_object_id
          AND to_so.space_id = r.space_id
          AND to_so.object_type = 'claim'
          AND to_so.deleted_at IS NULL
        WHERE r.space_id = $1
          AND (r.from_object_id = $3 OR r.to_object_id = $3)
          AND r.status <> 'archived'
          AND ${this.readableSpaceObjectClause("from_so")}
          AND ${this.readableSpaceObjectClause("to_so")}
        ORDER BY r.updated_at DESC, r.id DESC`,
      [identity.spaceId, identity.userId, claimId],
    );
    return rows.rows.map(objectRelationAsClaimRelationOut);
  }

  async objectRelations(identity: SpaceUserIdentity, filters: Record<string, string | undefined>): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const clauses = [
      "r.space_id = $1",
      this.readableSpaceObjectClause("from_so"),
      this.readableSpaceObjectClause("to_so"),
      `(r.source_claim_id IS NULL OR (
        source_claim_so.id IS NOT NULL
        AND ${this.readableSpaceObjectClause("source_claim_so")}
      ))`,
      `(r.source_object_id IS NULL OR (
        source_so.id IS NOT NULL
        AND ${this.readableSpaceObjectClause("source_so")}
      ))`,
    ];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    for (const key of ["from_object_id", "to_object_id", "link_type", "status", "source_claim_id", "source_object_id"]) {
      const value = optionalString(filters[key]);
      if (value) clauses.push(`r.${key} = ${add(value)}`);
    }
    const rows = await this.db.query<ObjectRelationRow>(
      `SELECT r.id, r.space_id,
              r.from_object_id, from_so.object_type AS from_object_type,
              r.to_object_id, to_so.object_type AS to_object_type,
              r.link_type, r.status, r.confidence, r.evidence_summary,
              r.source_claim_id, r.source_object_id, r.source_proposal_id,
              r.metadata_json, r.created_by_user_id, r.created_by_agent_id,
              r.created_at, r.updated_at
         FROM object_relations r
         JOIN space_objects from_so
           ON from_so.id = r.from_object_id
          AND from_so.space_id = r.space_id
          AND from_so.deleted_at IS NULL
         JOIN space_objects to_so
           ON to_so.id = r.to_object_id
          AND to_so.space_id = r.space_id
          AND to_so.deleted_at IS NULL
         LEFT JOIN claims source_claim
           ON source_claim.object_id = r.source_claim_id
          AND source_claim.space_id = r.space_id
         LEFT JOIN space_objects source_claim_so
           ON source_claim_so.id = source_claim.object_id
          AND source_claim_so.space_id = source_claim.space_id
          AND source_claim_so.object_type = 'claim'
          AND source_claim_so.deleted_at IS NULL
         LEFT JOIN space_objects source_so
           ON source_so.id = r.source_object_id
          AND source_so.space_id = r.space_id
          AND source_so.deleted_at IS NULL
        WHERE ${clauses.join(" AND ")}
        ORDER BY r.updated_at DESC, r.id DESC`,
      params,
    );
    return rows.rows.map(objectRelationOut);
  }

  async proposeClaimCreate(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<ProposalOut> {
    const claimText = requiredString(body.claim_text, "claim_text");
    const claimKind = requiredString(body.claim_kind ?? "fact", "claim_kind");
    if (!CLAIM_KINDS.has(claimKind)) throw new HttpError(422, "invalid claim_kind");
    const objectProfileValidation = await this.validateObjectProfileProposalFields(identity, "claim", claimKind, body, {
      validateWhenFieldsAbsent: true,
    });
    const status = requiredString(body.status ?? "active", "status");
    if (!CLAIM_STATUSES.has(status)) throw new HttpError(422, "invalid claim status");
    const createStatusError = claimCreateStatusError(status);
    if (createStatusError) throw new HttpError(422, createStatusError);
    const visibility = requiredString(body.visibility ?? "space_shared", "visibility");
    if (!KNOWLEDGE_VISIBILITIES.has(visibility)) throw new HttpError(422, "invalid visibility");
    const confidenceMethod = requiredString(body.confidence_method ?? "human_confirmed", "confidence_method");
    if (!CLAIM_CONFIDENCE_METHODS.has(confidenceMethod)) throw new HttpError(422, "invalid confidence_method");
    const resolutionState = requiredString(body.resolution_state ?? "unreviewed", "resolution_state");
    if (!CLAIM_RESOLUTION_STATES.has(resolutionState)) throw new HttpError(422, "invalid resolution_state");
    const resolutionStateError = claimResolutionStateError(status, resolutionState);
    if (resolutionStateError) throw new HttpError(422, resolutionStateError);
    const subjectObjectId = optionalString(body.subject_object_id);
    const subjectText = optionalString(body.subject_text);
    if (!subjectObjectId && !subjectText) throw new HttpError(422, "subject_object_id or subject_text is required");
    if (subjectObjectId) await this.requireVisibleSpaceObject(identity, subjectObjectId, "Claim subject not found");
    const holderObjectId = optionalString(body.holder_object_id);
    if (holderObjectId) await this.requireVisibleSpaceObject(identity, holderObjectId, "Claim holder not found");
    const holderType = optionalString(body.holder_type);
    const holderId = optionalString(body.holder_id);
    if ((holderType && !holderId) || (!holderType && holderId)) throw new HttpError(422, "holder_type and holder_id must be provided together");
    if (holderObjectId && (holderType || holderId)) throw new HttpError(422, "holder_object_id cannot be combined with holder_type/holder_id");
    const sources = await this.normalizeClaimSources(identity, Array.isArray(body.sources) ? body.sources : body.claim_sources);
    const title = optionalString(body.title) ?? titleFromClaimText(claimText);
    const metadata = optionalObject(body.metadata) ?? {};
    const payload = {
      ...body,
      operation: "claim_create",
      claim_kind: claimKind,
      claim_text: claimText,
      title,
      subject_object_id: subjectObjectId,
      subject_text: subjectText,
      holder_object_id: holderObjectId,
      holder_type: holderType,
      holder_id: holderId,
      status,
      visibility,
      confidence: confidence(body.confidence),
      confidence_method: confidenceMethod,
      resolution_state: resolutionState,
      normalized_claim_hash: optionalString(body.normalized_claim_hash) ?? hashClaimText(claimText),
      sources,
      metadata: withObjectProfileFieldMetadata(metadata, objectProfileValidation.fields),
      ...objectProfileValidationPayload(objectProfileValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "claim_create",
      title: `Claim: ${title}`,
      payload,
      rationale: optionalString(body.rationale) ?? "Claim creation requested.",
      projectFolderId: optionalString(body.project_folder_id),
      projectId: optionalString(body.project_id),
      visibility: visibility as "private" | "space_shared" | "selected_users",
    });
  }

  async proposeClaimUpdate(identity: SpaceUserIdentity, claimId: string, body: Record<string, unknown>): Promise<ProposalOut> {
    assertNoContentAccessUpdate(body);
    const claim = await this.getVisibleClaimRow(identity, claimId);
    if (!claim || !canMutateClaim(claim, identity.userId)) throw new HttpError(404, "Claim not found");
    const claimKind = optionalString(body.claim_kind);
    if (claimKind && !CLAIM_KINDS.has(claimKind)) throw new HttpError(422, "invalid claim_kind");
    const nextClaimKindForValidation = claimKind ?? claim.claim_kind;
    const objectProfileValidation = await this.validateObjectProfileProposalFields(identity, "claim", nextClaimKindForValidation, body, {
      validateWhenFieldsAbsent: Boolean(claimKind),
    });
    const status = optionalString(body.status);
    if (status && !CLAIM_STATUSES.has(status)) throw new HttpError(422, "invalid claim status");
    const nextStatus = status ?? claim.status;
    const transitionError = claimStatusTransitionError(claim.status, nextStatus);
    if (transitionError) throw new HttpError(422, transitionError);
    const confidenceMethod = optionalString(body.confidence_method);
    if (confidenceMethod && !CLAIM_CONFIDENCE_METHODS.has(confidenceMethod)) throw new HttpError(422, "invalid confidence_method");
    const resolutionState = optionalString(body.resolution_state);
    if (resolutionState && !CLAIM_RESOLUTION_STATES.has(resolutionState)) throw new HttpError(422, "invalid resolution_state");
    const nextResolutionState = resolutionState ?? claim.resolution_state;
    const resolutionStateError = claimResolutionStateError(nextStatus, nextResolutionState);
    if (resolutionStateError) throw new HttpError(422, resolutionStateError);
    const subjectObjectId = optionalString(body.subject_object_id);
    if (subjectObjectId) await this.requireVisibleSpaceObject(identity, subjectObjectId, "Claim subject not found");
    const holderObjectId = optionalString(body.holder_object_id);
    if (holderObjectId) await this.requireVisibleSpaceObject(identity, holderObjectId, "Claim holder not found");
    const sources = Object.hasOwn(body, "sources") || Object.hasOwn(body, "claim_sources")
      ? await this.normalizeClaimSources(identity, Array.isArray(body.sources) ? body.sources : body.claim_sources)
      : undefined;
    const nextText = optionalString(body.claim_text) ?? claim.claim_text;
    const supersededByClaimId = optionalString(body.superseded_by_claim_id);
    let metadata = Object.hasOwn(body, "metadata") ? (optionalObject(body.metadata) ?? {}) : undefined;
    if (objectProfileValidation.fields) {
      metadata = withObjectProfileFieldMetadata(metadata ?? optionalObject(claim.metadata_json) ?? {}, objectProfileValidation.fields);
    }
    if (supersededByClaimId) {
      if (supersededByClaimId === claimId) throw new HttpError(422, "superseded_by_claim_id must differ from target claim");
      const successor = await this.getVisibleClaimRow(identity, supersededByClaimId);
      if (!successor || !canMutateClaim(successor, identity.userId)) {
        throw new HttpError(404, "Superseding Claim not found");
      }
      metadata = { ...(metadata ?? optionalObject(claim.metadata_json) ?? {}), superseded_by_claim_id: supersededByClaimId };
    }
    if (nextStatus === "superseded" && !supersededByClaimId && !(await this.hasActiveSupersedingClaimRelation(identity.spaceId, claimId))) {
      throw new HttpError(422, "superseded Claims require superseded_by_claim_id or an active supersedes relation");
    }
    const payload = {
      ...body,
      operation: "claim_update",
      target_claim_id: claimId,
      claim_kind: claimKind,
      claim_text: optionalString(body.claim_text),
      title: optionalString(body.title),
      status,
      confidence: Object.hasOwn(body, "confidence") ? confidence(body.confidence) : undefined,
      confidence_method: confidenceMethod,
      resolution_state: resolutionState,
      normalized_claim_hash: optionalString(body.normalized_claim_hash) ?? (Object.hasOwn(body, "claim_text") ? hashClaimText(nextText) : undefined),
      sources,
      superseded_by_claim_id: supersededByClaimId,
      metadata,
      ...objectProfileValidationPayload(objectProfileValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "claim_update",
      title: `Update claim: ${claim.title}`,
      payload,
      rationale: optionalString(body.rationale) ?? "Claim update requested.",
      projectFolderId: claim.project_folder_id,
      projectId: claim.primary_project_id,
      visibility: normalizedKnowledgeVisibility(claim.visibility),
    });
  }

  async proposeClaimArchive(identity: SpaceUserIdentity, claimId: string): Promise<ProposalOut> {
    const claim = await this.getVisibleClaimRow(identity, claimId);
    if (!claim || !canMutateClaim(claim, identity.userId)) throw new HttpError(404, "Claim not found");
    const transitionError = claimStatusTransitionError(claim.status, "archived");
    if (transitionError) throw new HttpError(422, transitionError);
    return this.insertKnowledgeProposal(identity, {
      proposalType: "claim_archive",
      title: `Archive claim: ${claim.title}`,
      payload: {
        operation: "claim_archive",
        target_claim_id: claimId,
        proposed_content: claim.claim_text,
      },
      rationale: "Claim archive requested.",
      projectFolderId: claim.project_folder_id,
      projectId: claim.primary_project_id,
      visibility: normalizedKnowledgeVisibility(claim.visibility),
    });
  }


  async proposeObjectRelationArchive(
    identity: SpaceUserIdentity,
    relationId: string,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<ProposalOut> {
    const relation = await this.getObjectRelationRow(identity, relationId);
    if (!relation) throw new HttpError(404, "Object relation not found");
    const fromObject = await this.requireVisibleSpaceObject(identity, relation.from_object_id, "Object relation not found");
    await this.requireVisibleSpaceObject(identity, relation.to_object_id, "Object relation not found");
    return this.insertKnowledgeProposal(identity, {
      proposalType: "object_relation_delete",
      title: "Archive object relation",
      payload: {
        operation: "object_relation_delete",
        relation_id: relationId,
        metadata_patch: metadataPatch,
      },
      rationale: "Object relation archive requested.",
      projectFolderId: fromObject.project_folder_id,
      projectId: fromObject.primary_project_id,
      visibility: normalizedKnowledgeVisibility(fromObject.visibility),
    });
  }

  async proposeCreate(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<ProposalOut> {
    const knowledgeKind = requiredString(body.knowledge_kind ?? "concept", "knowledge_kind");
    if (!KNOWLEDGE_KINDS.has(knowledgeKind)) throw new HttpError(422, "invalid knowledge_kind");
    const objectProfileValidation = await this.validateObjectProfileProposalFields(identity, "knowledge_item", knowledgeKind, body, {
      validateWhenFieldsAbsent: true,
    });
    const contentFormat = requiredString(body.content_format ?? "markdown", "content_format");
    if (!CONTENT_FORMATS.has(contentFormat)) throw new HttpError(422, "invalid content_format");
    const visibility = requiredString(body.visibility ?? "space_shared", "visibility");
    if (!KNOWLEDGE_VISIBILITIES.has(visibility)) throw new HttpError(422, "invalid visibility");
    const payload = {
      ...body,
      operation: "create",
      knowledge_kind: knowledgeKind,
      title: requiredString(body.title, "title"),
      content: requiredString(body.content, "content"),
      content_format: contentFormat,
      visibility,
      tags: stringArray(body.tags),
      source_refs: Array.isArray(body.source_refs) ? body.source_refs : [],
      ...objectProfileValidationPayload(objectProfileValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "knowledge_create",
      title: payload.title,
      payload,
      rationale: optionalString(body.rationale) ?? "Knowledge creation requested.",
      projectFolderId: optionalString(body.project_folder_id),
      projectId: optionalString(body.project_id),
      visibility: visibility as "private" | "space_shared" | "selected_users",
    });
  }

  /**
   * Promote a passage of a Note into a Knowledge Item (ND).
   *
   * Governance is unchanged: this builds an ordinary `knowledge_create`
   * proposal and nothing bypasses the review gate. What it adds is the
   * provenance the model could not express before — "this knowledge came from
   * my note" — carried as a `source_refs` entry of type `note`.
   *
   * The carrier is `provenance_links`, chosen over the plan's two other
   * candidates. Widening `knowledge_item_sources.source_id`'s foreign key from
   * `sources(object_id)` to `space_objects(id)` would enlarge what B12A calls
   * a *curated citation and evidence* path so it could carry an unreviewed
   * one; a dedicated column or table would be a third provenance mechanism.
   * `provenance_links` already answers this exact question — a knowledge
   * item's `source_refs` are read from it with `target_type = 'knowledge'` —
   * so `note` joins a vocabulary that is now owned in one place rather than
   * copied into three.
   *
   * The Note keeps its content. Promotion is not a move.
   */
  async promoteNoteToKnowledge(identity: SpaceUserIdentity, noteId: string, body: Record<string, unknown>): Promise<ProposalOut> {
    const note = await this.getNoteRow(identity, noteId);
    if (!note) throw new HttpError(404, "Note not found");
    const content = requiredString(body.content, "content");
    // The passage the user selected, not the note's whole text: a note usually
    // holds several ideas, and promoting all of them as one item is what N6's
    // selection scoping exists to avoid.
    const title = optionalString(body.title) ?? note.title;
    const projectId = optionalString(body.project_id) ?? note.primary_project_id;
    return this.proposeCreate(identity, {
      ...body,
      title,
      content,
      source_refs: [
        ...(Array.isArray(body.source_refs) ? body.source_refs : []),
        {
          source_type: "note",
          source_id: noteId,
          source_trust: "user_confirmed",
          evidence_json: { note_version: note.version, excerpt: content.slice(0, 2000) },
        },
      ],
      // A promoted passage stays in the Project the note belongs to unless the
      // caller says otherwise, so the item lands where the work happened.
      ...(projectId ? { project_id: projectId } : {}),
    });
  }

  /**
   * The knowledge items a note produced (ND).
   *
   * The forward direction already worked — an item lists its `source_refs`, so
   * it can say it came from a note. This is the direction the note needs: a
   * user who promoted three passages should see the three items without
   * knowing their ids. Read from `provenance_links` rather than `note_links`,
   * because promotion records provenance, not navigation — and an item created
   * from a note may never be linked to it.
   */
  async knowledgeItemsPromotedFromNote(identity: SpaceUserIdentity, noteId: string): Promise<Record<string, unknown>[]> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    const rows = await this.db.query<KnowledgeItemRow>(
      `SELECT ${KNOWLEDGE_ITEM_COLUMNS}
         FROM ${KNOWLEDGE_ITEM_FROM}
         JOIN provenance_links pl
           ON pl.space_id = ki.space_id AND pl.target_type = 'knowledge' AND pl.target_id = ki.object_id
        WHERE ki.space_id = $1 AND pl.source_type = 'note' AND pl.source_id = $3
          AND so.deleted_at IS NULL
          AND ${contentReadSql("space_object", "so", "$2")}
        ORDER BY so.created_at DESC`,
      [identity.spaceId, identity.userId, noteId],
    );
    return rows.rows.map(knowledgeSummaryOut);
  }

  async proposeUpdate(identity: SpaceUserIdentity, itemId: string, body: Record<string, unknown>): Promise<ProposalOut> {
    assertNoContentAccessUpdate(body);
    const item = await this.getVisibleItemRow(identity, itemId);
    if (!item) throw new HttpError(404, "Knowledge item not found");
    if (!canMutateKnowledge(item, identity.userId)) throw new HttpError(404, "Knowledge item not found");
    const objectProfileValidation = await this.validateObjectProfileProposalFields(identity, "knowledge_item", item.knowledge_kind, body, {
      validateWhenFieldsAbsent: false,
    });
    const contentFormat = requiredString(body.content_format ?? item.content_format, "content_format");
    if (!CONTENT_FORMATS.has(contentFormat)) throw new HttpError(422, "invalid content_format");
    const payload = {
      ...body,
      operation: "update",
      target_item_id: itemId,
      title: requiredString(body.title, "title"),
      content: requiredString(body.content, "content"),
      content_format: contentFormat,
      tags: stringArray(body.tags),
      source_refs: Array.isArray(body.source_refs) ? body.source_refs : [],
      ...objectProfileValidationPayload(objectProfileValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "knowledge_update",
      title: `Update: ${payload.title}`,
      payload,
      rationale: optionalString(body.rationale) ?? "Knowledge update requested.",
      projectFolderId: item.project_folder_id,
      projectId: item.project_id,
      visibility: normalizedKnowledgeVisibility(item.visibility),
    });
  }

  async proposeArchive(identity: SpaceUserIdentity, itemId: string): Promise<ProposalOut> {
    const item = await this.getVisibleItemRow(identity, itemId);
    if (!item || !canMutateKnowledge(item, identity.userId)) {
      throw new HttpError(404, "Knowledge item not found");
    }
    return this.insertKnowledgeProposal(identity, {
      proposalType: "knowledge_archive",
      title: `Archive: ${item.title}`,
      payload: {
        operation: "archive",
        target_item_id: itemId,
        proposed_content: item.content,
      },
      rationale: "Knowledge archive requested.",
      projectFolderId: item.project_folder_id,
      projectId: item.project_id,
      visibility: normalizedKnowledgeVisibility(item.visibility),
    });
  }

  async listSources(identity: SpaceUserIdentity, filters: {
    sourceType: string | null;
    status: string | null;
    q: string | null;
    limit: number;
    offset: number;
  }): Promise<Record<string, unknown>> {
    const params: unknown[] = [identity.spaceId];
    const clauses = ["s.space_id = $1"];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.sourceType) clauses.push(`s.source_type = ${add(filters.sourceType)}`);
    if (filters.status) clauses.push(`s.status = ${add(filters.status)}`);
    if (filters.q) clauses.push(`(so.title ILIKE ${add(`%${filters.q}%`)} OR s.uri ILIKE $${params.length})`);
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = await this.db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${SOURCE_FROM} ${where}`,
      params,
    );
    const rows = await this.db.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS}
         FROM ${SOURCE_FROM}
        ${where}
        ORDER BY so.updated_at DESC, s.object_id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(sourceSummaryOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async getSource(identity: SpaceUserIdentity, sourceId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getSourceRow(identity, sourceId);
    return row ? sourceOut(row) : null;
  }

  async createSource(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const sourceType = requiredString(body.source_type, "source_type");
    if (!SOURCE_TYPES.has(sourceType)) throw new HttpError(422, "invalid source_type");
    const status = optionalString(body.status) ?? "raw";
    if (!SOURCE_STATUSES.has(status)) throw new HttpError(422, "invalid source status");
    const objectId = randomUUID();
    const object = buildSpaceObjectInsert({
      id: objectId,
      spaceId: identity.spaceId,
      objectType: "source",
      title: requiredString(body.title, "title"),
      summary: optionalString(body.summary),
      visibility: requiredString(body.visibility, "visibility"),
      primaryProjectId: optionalString(body.project_id),
      projectFolderId: optionalString(body.project_folder_id),
      ownerUserId: identity.userId,
      createdByUserId: identity.userId,
      createdAt: now,
    });
    const n = object.params.length;
    const result = await this.db.query<SourceRow>(
      `WITH obj AS (
         ${object.sql}
       ), src AS (
         INSERT INTO sources (
           object_id, space_id, status, source_type, uri, content_ref, raw_text, summary,
           metadata_json, source_activity_id
         ) VALUES (
           $${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8},
           $${n + 9}::jsonb, $${n + 10}
         )
       )
       SELECT ${SOURCE_COLUMNS}
         FROM ${SOURCE_FROM}
        WHERE s.object_id = $${n + 1} AND s.space_id = $${n + 2}`,
      [
        ...object.params,
        objectId,
        identity.spaceId,
        status,
        sourceType,
        optionalString(body.uri),
        optionalString(body.content_ref),
        optionalString(body.raw_text),
        optionalString(body.summary),
        JSON.stringify(optionalObject(body.metadata) ?? {}),
        optionalString(body.source_activity_id),
      ],
    );
    const row = result.rows[0]!;
    await this.safeReindex((p) => p.reindex(identity.spaceId, "source", row.id));
    return sourceOut(row);
  }

  async updateSource(identity: SpaceUserIdentity, sourceId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.getSourceRow(identity, sourceId);
    if (!existing) throw new HttpError(404, "Source not found");
    const now = new Date().toISOString();
    const status = optionalString(body.status);
    if (status && !SOURCE_STATUSES.has(status)) throw new HttpError(422, "invalid source status");
    const result = await this.db.query<SourceRow>(
      `WITH obj AS (
         UPDATE space_objects
            SET title = COALESCE($3, title),
                summary = CASE WHEN $10::boolean THEN $11 ELSE summary END,
                updated_at = $15
          WHERE id = $1 AND space_id = $2 AND object_type = 'source'
          RETURNING id
       ), src AS (
         UPDATE sources
            SET status = COALESCE($14, status),
                uri = CASE WHEN $4::boolean THEN $5 ELSE uri END,
                content_ref = CASE WHEN $6::boolean THEN $7 ELSE content_ref END,
                raw_text = CASE WHEN $8::boolean THEN $9 ELSE raw_text END,
                summary = CASE WHEN $10::boolean THEN $11 ELSE summary END,
                metadata_json = CASE WHEN $12::boolean THEN $13::jsonb ELSE metadata_json END
          WHERE object_id = $1 AND space_id = $2 AND EXISTS (SELECT 1 FROM obj)
          RETURNING object_id
       )
       SELECT ${SOURCE_COLUMNS}
         FROM ${SOURCE_FROM}
        WHERE s.object_id = $1 AND s.space_id = $2`,
      [
        sourceId,
        identity.spaceId,
        optionalString(body.title),
        Object.hasOwn(body, "uri"),
        optionalString(body.uri),
        Object.hasOwn(body, "content_ref"),
        optionalString(body.content_ref),
        Object.hasOwn(body, "raw_text"),
        optionalString(body.raw_text),
        Object.hasOwn(body, "summary"),
        optionalString(body.summary),
        Object.hasOwn(body, "metadata"),
        JSON.stringify(optionalObject(body.metadata) ?? {}),
        status,
        now,
      ],
    );
    const row = result.rows[0]!;
    await this.safeReindex((p) => p.reindex(identity.spaceId, "source", row.id));
    return sourceOut(row);
  }

  async archiveSource(identity: SpaceUserIdentity, sourceId: string): Promise<Record<string, unknown>> {
    const row = await this.updateSource(identity, sourceId, { status: "archived" });
    return row;
  }

  async listItemSources(identity: SpaceUserIdentity, itemId: string): Promise<Record<string, unknown>[]> {
    const item = await this.getVisibleItemRow(identity, itemId);
    if (!item) throw new HttpError(404, "Knowledge item not found");
    return this.listKnowledgeItemSourceLinks("knowledge_item_id", itemId, identity.spaceId);
  }

  async listSourceItems(identity: SpaceUserIdentity, sourceId: string): Promise<Record<string, unknown>[]> {
    const source = await this.getSourceRow(identity, sourceId);
    if (!source) throw new HttpError(404, "Source not found");
    return this.listKnowledgeItemSourceLinks("source_id", sourceId, identity.spaceId);
  }

  async createItemSource(identity: SpaceUserIdentity, itemId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const item = await this.getVisibleItemRow(identity, itemId);
    if (!item || !canMutateKnowledge(item, identity.userId)) throw new HttpError(404, "Knowledge item not found");
    const sourceId = requiredString(body.source_id, "source_id");
    if (!(await this.getSourceRow(identity, sourceId))) throw new HttpError(404, "Source not found");
    const now = new Date().toISOString();
    const result = await this.db.query<Record<string, unknown>>(
      `INSERT INTO knowledge_item_sources (
         id, space_id, knowledge_item_id, source_id, relation_type, locator,
         quote, note, confidence, created_by_user_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11
       )
       RETURNING id, space_id, knowledge_item_id, source_id, relation_type,
                 locator, quote, note, confidence, created_by_user_id, created_at`,
      [
        randomUUID(),
        identity.spaceId,
        itemId,
        sourceId,
        // The column, the list read model, and this route's RETURNING all call
        // it relation_type; `link_type` stays accepted for older callers.
        optionalString(body.relation_type) ?? optionalString(body.link_type) ?? "derived_from",
        optionalString(body.locator),
        optionalString(body.quote),
        optionalString(body.note),
        confidence(body.confidence),
        identity.userId,
        now,
      ],
    );
    const row = normalizeDates(result.rows[0]!);
    await this.safeReindex(async (p) => {
      await p.reindex(identity.spaceId, "knowledge_item", itemId);
      await p.reindex(identity.spaceId, "source", sourceId);
    });
    return row;
  }

  async deleteItemSource(identity: SpaceUserIdentity, itemId: string, linkId: string): Promise<void> {
    const item = await this.getVisibleItemRow(identity, itemId);
    if (!item || !canMutateKnowledge(item, identity.userId)) throw new HttpError(404, "Knowledge item not found");
    await this.db.query(
      `DELETE FROM knowledge_item_sources
        WHERE id = $1 AND knowledge_item_id = $2 AND space_id = $3`,
      [linkId, itemId, identity.spaceId],
    );
    await this.safeReindex((p) => p.reindex(identity.spaceId, "knowledge_item", itemId));
  }

  async listNotes(identity: SpaceUserIdentity, filters: {
    status: string | null;
    projectId: string | null;
    collectionId: string | null;
    collectionIds: string[] | null;
    q: string | null;
    limit: number;
    offset: number;
  }): Promise<Record<string, unknown>> {
    const built = buildNoteWhere(identity, filters);
    // The membership join exists only to answer "is this note in *that* folder,
    // and where in its order" — a single collection, so it contributes at most
    // one row. Joined unconditionally it multiplied every note by its number of
    // placements, which is why the page rows and the DISTINCT count disagreed
    // for any note filed in two folders.
    const membershipJoin = filters.collectionId
      ? `LEFT JOIN note_collection_items nci_filter
           ON nci_filter.note_id = n.object_id
          AND nci_filter.space_id = n.space_id`
      : "";
    const total = await this.db.query<{ total: string }>(
      `SELECT count(DISTINCT n.object_id)::text AS total
         FROM ${NOTE_FROM}
         ${membershipJoin}
        ${built.where}`,
      built.params,
    );
    const rows = await this.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS}
         FROM ${NOTE_FROM}
         ${NOTE_PLACEMENTS_JOIN}
         ${membershipJoin}
        ${built.where}
        ORDER BY ${filters.collectionId ? "nci_filter.sort_order ASC," : ""} so.updated_at DESC, n.object_id DESC
        LIMIT $${built.params.length + 1} OFFSET $${built.params.length + 2}`,
      [...built.params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(noteSummaryOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async listNoteCollections(identity: SpaceUserIdentity): Promise<Record<string, unknown>[]> {
    return (await this.listVisibleNoteCollectionRows(identity)).map(noteCollectionOut);
  }

  private async listVisibleNoteCollectionRows(identity: SpaceUserIdentity): Promise<NoteCollectionRow[]> {
    const rows = await this.db.query<NoteCollectionRow>(
      `SELECT ${NOTE_COLLECTION_COLUMNS}
         FROM note_collections
        WHERE space_id = $1
        ORDER BY sort_order ASC, created_at ASC, id ASC`,
      [identity.spaceId],
    );
    const readableProjects = await accessibleProjectIds(
      this.db,
      identity.spaceId,
      identity.userId,
      rows.rows.map((row) => row.project_id),
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const owningProject = (row: NoteCollectionRow): string | null => {
      const visited = new Set<string>();
      let current: NoteCollectionRow | undefined = row;
      while (current) {
        if (visited.has(current.id)) return null;
        visited.add(current.id);
        if (current.project_id) return current.project_id;
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
      return null;
    };

    // Project folders and every descendant inherit the Project ACL. Without
    // this filter, the global Notes tree reveals private Project names and
    // folder structure to every member of the Space.
    return rows.rows.filter((row) => {
      const projectId = owningProject(row);
      return !projectId || readableProjects.has(projectId);
    });
  }

  async createNoteCollection(
    identity: SpaceUserIdentity,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parentId = optionalString(body.parent_id);
    if (parentId) {
      await this.requireNoteCollection(identity, parentId);
      const projectId = await projectOwningCollection(this.db, identity.spaceId, parentId);
      if (projectId) {
        await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
      }
    }
    const requestedSortOrder = numberValue(body.sort_order);
    let sortOrder = requestedSortOrder;
    if (sortOrder === null) {
      // The route runs this method inside a transaction. A parent-scoped
      // advisory lock prevents concurrent creates into an empty sibling list
      // from receiving the same append position.
      await this.db.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`note-collection-order:${identity.spaceId}:${parentId ?? "root"}`],
      );
      const next = await this.db.query<{ sort_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order
           FROM note_collections
          WHERE space_id = $1
            AND parent_id IS NOT DISTINCT FROM $2`,
        [identity.spaceId, parentId],
      );
      sortOrder = next.rows[0]?.sort_order ?? 0;
    }
    const now = new Date().toISOString();
    const result = await this.db.query<NoteCollectionRow>(
      `INSERT INTO note_collections (
         id, space_id, parent_id, name, system_role, sort_order,
         is_system, is_hidden, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'normal', $5,
         false, false, $6, $6
       )
       RETURNING ${NOTE_COLLECTION_COLUMNS}`,
      [
        optionalString(body.id) ?? randomUUID(),
        identity.spaceId,
        parentId,
        requiredString(body.name, "name"),
        sortOrder,
        now,
      ],
    );
    return noteCollectionOut(result.rows[0]!);
  }

  async updateNoteCollection(
    identity: SpaceUserIdentity,
    collectionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const current = await this.getNoteCollectionRow(identity, collectionId);
    if (!current) throw new HttpError(404, "Note collection not found");
    const currentProjectId = await projectOwningCollection(this.db, identity.spaceId, collectionId);
    if (currentProjectId) {
      await assertProjectWriter(this.db, identity.spaceId, currentProjectId, identity.userId);
    }
    if (current.is_system && Object.hasOwn(body, "system_role")) {
      throw new HttpError(422, "system_role cannot be changed");
    }
    // System folders (Inbox/Archive/each project's notes folder) are exempt
    // from client-side drag affordances via isProtectedCollection(), but that
    // is UI-only — enforce it here too so the invariant holds regardless of
    // caller.
    if (current.is_system && Object.hasOwn(body, "parent_id") && optionalString(body.parent_id) !== current.parent_id) {
      throw new HttpError(422, "System folders cannot be moved");
    }
    const parentId = Object.hasOwn(body, "parent_id")
      ? optionalString(body.parent_id)
      : current.parent_id;
    if (parentId === collectionId) throw new HttpError(422, "parent_id cannot reference the same collection");
    if (parentId) await this.requireNoteCollection(identity, parentId);
    if (parentId !== current.parent_id) {
      const nextProjectId = current.project_id
        ?? (parentId ? await projectOwningCollection(this.db, identity.spaceId, parentId) : null);
      if (currentProjectId !== nextProjectId) {
        throw new HttpError(422, "Folders cannot be moved into or out of a Project notes workspace");
      }
    }

    const now = new Date().toISOString();
    const result = await this.db.query<NoteCollectionRow>(
      `UPDATE note_collections
          SET parent_id = $3,
              name = COALESCE($4, name),
              sort_order = COALESCE($5::int, sort_order),
              is_hidden = COALESCE($6::boolean, is_hidden),
              updated_at = $7
        WHERE id = $1 AND space_id = $2
        RETURNING ${NOTE_COLLECTION_COLUMNS}`,
      [
        collectionId,
        identity.spaceId,
        parentId,
        optionalString(body.name),
        numberValue(body.sort_order),
        typeof body.is_hidden === "boolean" ? body.is_hidden : null,
        now,
      ],
    );
    return noteCollectionOut(result.rows[0]!);
  }

  /**
   * The Project's notes folder, created on first use (U1: notes are a
   * Project-level surface, so the folder cannot depend on the Research Area
   * having been opened). Creating it is a write to the Project.
   */
  async ensureProjectNotesCollection(
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<Record<string, unknown>> {
    await assertProjectReadable(this.db, identity.spaceId, projectId, identity.userId);
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM note_collections WHERE space_id = $1 AND project_id = $2`,
      [identity.spaceId, projectId],
    );
    let collectionId = existing.rows[0]?.id;
    if (!collectionId) {
      await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
      collectionId = await withQueryableTransaction(this.db, (tx) =>
        ensureProjectNotesFolder(tx, identity.spaceId, projectId));
    }
    const row = await this.getNoteCollectionRow(identity, collectionId);
    if (!row) throw new HttpError(404, "Note collection not found");
    return noteCollectionOut(row);
  }

  async deleteNoteCollection(identity: SpaceUserIdentity, collectionId: string): Promise<void> {
    const current = await this.getNoteCollectionRow(identity, collectionId);
    if (!current) throw new HttpError(404, "Note collection not found");
    const projectId = await projectOwningCollection(this.db, identity.spaceId, collectionId);
    if (projectId) {
      await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    }
    if (current.is_system) throw new HttpError(422, "System note collections cannot be deleted");
    await this.db.query(
      `DELETE FROM note_collections WHERE id = $1 AND space_id = $2`,
      [collectionId, identity.spaceId],
    );
  }

  async getNote(identity: SpaceUserIdentity, noteId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getNoteRow(identity, noteId);
    if (!row) return null;
    await recordDetailRead(this.db, {
      spaceId: identity.spaceId,
      viewerUserId: identity.userId,
      resourceType: "space_object",
      resourceId: noteId,
    });
    return noteOut(row);
  }

  async createNote(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const noteId = await withNoteWrites(this.db, async (scope) => {
      const created = await scope.create(this.noteInsertFrom(identity, body));
      return created.id;
    });
    return (await this.getNote(identity, noteId))!;
  }

  /** Shared by `createNote` and the jot path, which differ only in their body. */
  private noteInsertFrom(identity: SpaceUserIdentity, body: Record<string, unknown>): NoteInsert {
    return {
      spaceId: identity.spaceId,
      actor: { userId: identity.userId },
      title: requiredString(body.title, "title"),
      summary: optionalString(body.excerpt) ?? undefined,
      visibility: body.visibility === "private" ? "private" : "space_shared",
      doc: optionalObject(body.content_json) ?? {},
      plainText: optionalString(body.plain_text) ?? null,
      contentFormat: optionalString(body.content_format) ?? "markdown",
      contentSchemaVersion: numberValue(body.content_schema_version),
      primaryProjectId: optionalString(body.primary_project_id),
      createdFromActivityId: optionalString(body.created_from_activity_id),
      collectionId: optionalString(body.collection_id),
    };
  }

  async updateNote(identity: SpaceUserIdentity, noteId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.requireWritableNote(identity, noteId);
    const now = new Date().toISOString();
    const status = optionalString(body.status);
    if (status && !NOTE_STATUSES.has(status)) throw new HttpError(422, "invalid note status");
    // Binding a note to a Project is a write to that Project — see the note
    // writer. Checked here rather than inside the update statement because the
    // whole request has to be refused before any of it lands.
    const movedToProject = Object.hasOwn(body, "primary_project_id") ? optionalString(body.primary_project_id) : null;
    if (movedToProject) await assertProjectWriter(this.db, identity.spaceId, movedToProject, identity.userId);
    await withNoteWrites(this.db, async (scope) => {
      await this.applyNoteUpdate(scope, identity, noteId, body, status, now);
    });
    return (await this.getNote(identity, noteId))!;
  }

  /** The body of {@link updateNote}, inside the note write scope. */
  private async applyNoteUpdate(
    scope: NoteWriteScope,
    identity: SpaceUserIdentity,
    noteId: string,
    body: Record<string, unknown>,
    status: string | null | undefined,
    now: string,
  ): Promise<void> {
    await scope.db.query(
      `WITH obj AS (
         UPDATE space_objects
            SET title = COALESCE($3, title),
                summary = CASE WHEN $6::boolean THEN $7 ELSE summary END,
                primary_project_id = CASE WHEN $9::boolean THEN $10 ELSE primary_project_id END,
                archived_at = CASE WHEN $8::varchar(32) = 'archived' THEN $11::timestamptz ELSE archived_at END,
                deleted_at = CASE WHEN $8::varchar(32) = 'deleted' THEN $11::timestamptz ELSE deleted_at END,
                updated_at = $11
          WHERE id = $1 AND space_id = $2 AND object_type = 'note'
          RETURNING id
       )
       UPDATE notes
          SET status = COALESCE($8::varchar(32), status),
              content_format = COALESCE($4, content_format),
              content_schema_version = COALESCE($5::int, content_schema_version)
        WHERE object_id = $1 AND space_id = $2 AND EXISTS (SELECT 1 FROM obj)`,
      [
        noteId,
        identity.spaceId,
        optionalString(body.title),
        optionalString(body.content_format),
        numberValue(body.content_schema_version),
        Object.hasOwn(body, "excerpt"),
        optionalString(body.excerpt),
        status,
        Object.hasOwn(body, "primary_project_id"),
        optionalString(body.primary_project_id),
        now,
      ],
    );
    // Moving a note out of the Project its role is scoped to drops the role:
    // a note cannot hold a baseline slot in a Project it no longer belongs to,
    // and leaving the pair behind would let the slot resolve to a note the
    // Project can no longer see. Runs before the assignment below so a move
    // and an assignment in one request end on the new Project.
    if (Object.hasOwn(body, "primary_project_id")) {
      await scope.db.query(
        `UPDATE notes n SET project_role = NULL, role_project_id = NULL
           FROM space_objects so
          WHERE n.object_id = $1 AND n.space_id = $2 AND so.id = n.object_id AND so.space_id = n.space_id
            AND n.project_role IS NOT NULL AND n.role_project_id IS DISTINCT FROM so.primary_project_id`,
        [noteId, identity.spaceId],
      );
    }
    // A marginalia note that is archived, deleted, or moved to another Project
    // is no longer what the capture path resolves, so it must stop occupying
    // the one-per-member slot. Leaving the binding behind would make the next
    // capture insert a second row for the same slot and fail the unique index,
    // which no later action could recover from.
    await scope.db.query(
      `UPDATE notes n
          SET marginalia_project_id = NULL,
              marginalia_owner_user_id = NULL,
              marginalia_target_object_id = NULL
         FROM space_objects so
        WHERE n.object_id = $1 AND n.space_id = $2
          AND so.id = n.object_id AND so.space_id = n.space_id
          AND n.marginalia_owner_user_id IS NOT NULL
          AND (n.status <> 'active'
               OR so.deleted_at IS NOT NULL
               OR n.marginalia_project_id IS DISTINCT FROM so.primary_project_id)`,
      [noteId, identity.spaceId],
    );
    // Runs after the root update above, so assigning a role in the same
    // request that moves a note into a Project scopes the role to the new
    // Project rather than the old one.
    if (Object.hasOwn(body, "project_role")) {
      await scope.setProjectRole({
        spaceId: identity.spaceId,
        noteId,
        actor: { userId: identity.userId },
        role: optionalString(body.project_role) ?? null,
        at: now,
      });
    }
    // Content changes go through the versioned writer so every save (not
    // just AI-driven ones) produces a note_revisions row and an incrementing
    // version — see .agent knowledge-base notes-vs-AI-co-edit unification.
    if (Object.hasOwn(body, "content_json")) {
      const plainText = Object.hasOwn(body, "plain_text") ? optionalString(body.plain_text) ?? "" : undefined;
      const result = await scope.write({
        spaceId: identity.spaceId,
        noteId,
        expectVersion: Object.hasOwn(body, "expect_version") ? numberValue(body.expect_version) ?? null : null,
        content: { kind: "doc", doc: optionalObject(body.content_json) ?? {}, plainText },
        source: "user_edit",
        userId: identity.userId,
      });
      if (result.outcome === "version_conflict") {
        throw new HttpError(409, "Note changed since it was loaded; reload and retry", { current_version: result.currentVersion });
      }
    }
    const collectionId = optionalString(body.collection_id);
    if (collectionId) {
      await moveNoteToCollection(scope.db, identity.spaceId, noteId, collectionId, { userId: identity.userId });
    }
    // Metadata-only edits (a rename, an archive) still change what retrieval
    // should return, so the scope is told even when no content write happened.
    await scope.touch(identity.spaceId, noteId);
  }

  /**
   * Place a note in a further folder without taking it out of the ones it is
   * already in (U5). A distinct action from moving it, because a drag that
   * silently widened where a note lives would be a different decision than the
   * one the user made.
   */
  async addNotePlacement(
    identity: SpaceUserIdentity,
    noteId: string,
    collectionId: string,
    /** Confirms the cross-Project case; see `bindNoteToPlacementProject` (U8). */
    shareWithProject = false,
  ): Promise<Record<string, unknown>> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    await withQueryableTransaction(this.db, (tx) =>
      addNotePlacement(tx, identity.spaceId, noteId, collectionId, { userId: identity.userId }, shareWithProject));
    return (await this.getNote(identity, noteId))!;
  }

  /**
   * The contextless half of a jot (U11): append to the Project's `inbox` note.
   *
   * The inbox is a fifth `project_role`, so it survives a rename and a move
   * between folders the way the research baseline's four do. It is created on
   * first use rather than seeded with the Project, because a Project that never
   * captures anything should not carry an empty note — and because the notes
   * folder itself is created lazily for the same reason.
   */
  private async jotToProjectInbox(
    identity: SpaceUserIdentity,
    body: Record<string, unknown>,
    text: string,
  ): Promise<Record<string, unknown>> {
    const projectId = requiredString(body.project_id, "project_id");
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const noteId = await withNoteWrites(this.db, async (scope) => {
      const existing = await scope.db.query<{ object_id: string }>(
        `SELECT n.object_id
           FROM notes n
           JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
          WHERE n.space_id = $1 AND n.role_project_id = $2 AND n.project_role = 'inbox'
            AND n.status = 'active' AND so.deleted_at IS NULL
          LIMIT 1`,
        [identity.spaceId, projectId],
      );
      const inboxId = existing.rows[0]?.object_id;
      if (inboxId) {
        // The inbox is `space_shared` by construction, but a user can narrow any
        // note. Appending to one this caller cannot read would write their text
        // somewhere they can never see it, and the reply — which goes through
        // the gated read — would come back empty. Refuse instead. Displacing the
        // role to start a second inbox would be worse: the index allows one per
        // Project, so it would take the note away from its owner.
        if (!(await new PgKnowledgeRepository(scope.db).getNoteRow(identity, inboxId))) {
          throw new HttpError(409, "This project's inbox note is not readable by you");
        }
        // Append, with no `expectVersion`: a capture adds a paragraph at the
        // end and cannot conflict with an edit elsewhere in the document.
        const result = await scope.write({
          spaceId: identity.spaceId,
          noteId: inboxId,
          content: { kind: "ops", ops: [{ op: "append", markdown: text }] },
          source: "user_edit",
          userId: identity.userId,
        });
        if (result.outcome !== "written") {
          throw new HttpError(409, "Note changed while appending; reload and retry", {
            current_version: result.currentVersion,
          });
        }
        return inboxId;
      }
      const collectionId = optionalString(body.collection_id)
        ?? await ensureProjectNotesFolder(scope.db, identity.spaceId, projectId);
      const created = await scope.create({
        spaceId: identity.spaceId,
        actor: { userId: identity.userId },
        title: NOTE_PROJECT_ROLE_DEFAULT_TITLES.inbox,
        doc: markdownToPm(text),
        contentFormat: "prosemirror_json",
        plainText: text,
        primaryProjectId: projectId,
        collectionId,
        projectRole: "inbox",
      });
      return created.id;
    });
    return (await this.getNote(identity, noteId))!;
  }

  /**
   * The Projects this note is shared into, beyond the one that owns it (U8).
   * Read through the same gate as the note itself: a caller who cannot see the
   * note cannot enumerate who else can.
   */
  async listNoteProjectShares(
    identity: SpaceUserIdentity,
    noteId: string,
  ): Promise<Array<Record<string, unknown>>> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    const shares = await listSpaceObjectProjectShares(this.db, identity.spaceId, noteId);
    if (shares.length === 0) return [];
    const readableProjectIds = await accessibleProjectIds(
      this.db,
      identity.spaceId,
      identity.userId,
      shares.map((share) => share.project_id),
    );
    const visibleShares = shares.filter((share) => readableProjectIds.has(share.project_id));
    if (visibleShares.length === 0) return [];
    const names = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE space_id = $1 AND id = ANY($2::varchar[])`,
      [identity.spaceId, visibleShares.map((share) => share.project_id)],
    );
    const nameById = new Map(names.rows.map((row) => [row.id, row.name]));
    return visibleShares.map((share) => ({
      project_id: share.project_id,
      project_name: nameById.get(share.project_id) ?? null,
      shared_by_user_id: share.shared_by_user_id,
      created_at: dateIso(share.created_at),
    }));
  }

  /**
   * Withdraws a share. Takes the note's placements inside that Project with it —
   * see the share module for why leaving them is worse than removing them.
   */
  async revokeNoteProjectShare(
    identity: SpaceUserIdentity,
    noteId: string,
    projectId: string,
  ): Promise<Record<string, unknown>> {
    const note = await this.getNoteRow(identity, noteId);
    if (!note) throw new HttpError(404, "Note not found");
    await withQueryableTransaction(this.db, (tx) => revokeSpaceObjectProjectShare(tx, {
      spaceId: identity.spaceId,
      objectId: noteId,
      projectId,
      ownerProjectId: note.primary_project_id,
      userId: identity.userId,
    }));
    return (await this.getNote(identity, noteId))!;
  }

  /** Take a note out of one folder. Refused on the last one — see the writer. */
  async removeNotePlacement(
    identity: SpaceUserIdentity,
    noteId: string,
    collectionId: string,
  ): Promise<Record<string, unknown>> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    // In a transaction: the last-placement refusal reads the placement rows
    // `FOR UPDATE` and then deletes one, and the two have to see the same set.
    await withQueryableTransaction(this.db, (tx) =>
      removeNotePlacement(tx, identity.spaceId, noteId, collectionId, { userId: identity.userId }));
    return (await this.getNote(identity, noteId))!;
  }

  async listNoteRevisions(identity: SpaceUserIdentity, noteId: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    return listNoteRevisionRows(this.db, { spaceId: identity.spaceId, noteId, limit });
  }

  async rollbackNote(identity: SpaceUserIdentity, noteId: string, toVersion: number): Promise<Record<string, unknown>> {
    await this.requireWritableNote(identity, noteId);
    await withNoteWrites(this.db, (scope) =>
      scope.rollback({ spaceId: identity.spaceId, noteId, toVersion, userId: identity.userId }));
    return (await this.getNote(identity, noteId))!;
  }

  async deleteNote(identity: SpaceUserIdentity, noteId: string): Promise<Record<string, unknown>> {
    return this.updateNote(identity, noteId, { status: "deleted" });
  }

  /**
   * "Jot a note" from an evidence or material card (N7).
   *
   * One call, because the two-step version is the reason the connection never
   * got made: a user reading a paper had to leave for the Notes page, create a
   * note, come back for the id, and link it — so in practice nobody recorded
   * what a conclusion rested on. Creating the note and the link separately
   * from the client would also leave a stranded note whenever the second call
   * failed.
   *
   * Appends to an existing note when given one, so jotting twice against the
   * same paper accumulates in one place rather than littering the tree. The
   * link is created once: a second jot against a target the note already links
   * to adds the text without a duplicate edge.
   *
   * **`target_id` is optional** (U11). A thought that arrives while doing an
   * experiment or weighing a decision has no object to hang on, and the two
   * obvious answers are both wrong: always appending to one inbox buries ten
   * papers' annotations in a single note, and always creating a new note turns
   * the tree into fragments. So: *with* a context object, one note per object;
   * *without* one, append to the Project's `inbox` note, created on first use.
   * The inbox is found by its `project_role`, never by title — the previous
   * work removed title-based note resolution and this must not reintroduce it.
   */
  async jotNoteForObject(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const targetId = optionalString(body.target_id);
    const text = requiredString(body.text, "text");
    if (!targetId) return this.jotToProjectInbox(identity, body, text);
    const noteId = optionalString(body.note_id);
    const projectId = optionalString(body.project_id);
    const collectionId = optionalString(body.collection_id);
    const linkType = optionalString(body.link_type) ?? "references";
    // Resolved before anything is written: a target the caller cannot see must
    // not leave a new note behind as evidence that it exists.
    const target = await this.requireVisibleSpaceObject(identity, targetId, "Link target not found");

    const jottedNoteId = await withNoteWrites(this.db, async (scope) => {
      const scoped = new PgKnowledgeRepository(scope.db);
      await scope.db.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`note-jot:${identity.spaceId}:${projectId ?? "unbound"}:${targetId}`],
      );
      let jottedId: string;
      // `null` owner: a jot from an evidence card is team material, so every
      // member's private marginalia note on the same object is excluded.
      const existingNoteId = noteId ?? await scoped.noteForJotTarget(identity, targetId, projectId, null);
      if (existingNoteId) {
        await scoped.requireWritableNote(identity, existingNoteId);
        // Append rather than replace, and with no `expectVersion`: a jot adds a
        // paragraph at the end, so it cannot conflict with an edit elsewhere in
        // the document the way a whole-document save would.
        const result = await scope.write({
          spaceId: identity.spaceId,
          noteId: existingNoteId,
          content: { kind: "ops", ops: [{ op: "append", markdown: text }] },
          source: "user_edit",
          userId: identity.userId,
        });
        if (result.outcome !== "written") {
          throw new HttpError(409, "Note changed while appending; reload and retry", { current_version: result.currentVersion });
        }
        jottedId = existingNoteId;
      } else {
        const created = await scope.create({
          spaceId: identity.spaceId,
          actor: { userId: identity.userId },
          // The target's own title is the most useful default, and the user can
          // rename it — NA made titles safe to change.
          title: `Note on ${target.title}`,
          doc: markdownToPm(text),
          contentFormat: "prosemirror_json",
          plainText: text,
          primaryProjectId: projectId,
          collectionId,
        });
        jottedId = created.id;
      }

      const existingLink = await scope.db.query<{ id: string }>(
        `SELECT id FROM note_links
          WHERE space_id = $1 AND from_object_id = $2 AND to_object_id = $3 AND link_type = $4`,
        [identity.spaceId, jottedId, targetId, linkType],
      );
      if (!existingLink.rows[0]) {
        await scoped.createNoteLink(identity, jottedId, {
          target_type: target.object_type,
          target_id: targetId,
          link_type: linkType,
        });
      }
      return jottedId;
    });
    return (await this.getNote(identity, jottedNoteId))!;
  }

  /**
   * The note half of a marginalia capture (ADR 0013 decision 3a).
   *
   * Lives beside the shared jot rather than inside it: a jot from an evidence
   * card is team material by intent, while marginalia is one member's private
   * margin note, and collapsing them would mean one of the two silently gets
   * the other's visibility.
   */
  appendMarginalia(
    identity: SpaceUserIdentity,
    input: MarginaliaInput,
  ): Promise<MarginaliaProjection> {
    return appendMarginalia(this.db, identity, input, {
      requireVisibleSpaceObject: (db, id, objectId, message) =>
        new PgKnowledgeRepository(db).requireVisibleSpaceObject(id, objectId, message),
      createNoteLink: (db, id, noteId, body) => new PgKnowledgeRepository(db).createNoteLink(id, noteId, body),
      noteForJotTarget: (db, id, targetId, projectId, ownerUserId) =>
        new PgKnowledgeRepository(db).noteForJotTarget(id, targetId, projectId, ownerUserId),
    });
  }

  // The purge is a hard DELETE, so it honors the retention window it reports:
  // a note deleted a minute ago is still recoverable by un-deleting it, and
  // only notes past the window are actually destroyed.
  async purgeDeletedNotes(identity: SpaceUserIdentity): Promise<Record<string, unknown>> {
    const result = await this.db.query<{ deleted: string }>(
      `DELETE FROM space_objects
        WHERE space_id = $1 AND object_type = 'note' AND deleted_at IS NOT NULL
          AND deleted_at < now() - ($2 || ' days')::interval
        RETURNING id`,
      [identity.spaceId, String(NOTE_PURGE_RETENTION_DAYS)],
    );
    return {
      deleted: result.rowCount ?? result.rows.length,
      retention_days: NOTE_PURGE_RETENTION_DAYS,
    };
  }

  /**
   * The notes linking to a non-note object — the other half of N7's "both
   * ways".
   *
   * {@link noteLinks} cannot answer this: it is note-keyed on both sides, so
   * `backlinks` there means "notes linking to *this note*". Asking an evidence
   * card what notes cite it needs the target to be anything, which is why this
   * is a separate read rather than a flag on that one.
   */
  async notesLinkingToObject(identity: SpaceUserIdentity, objectId: string): Promise<Record<string, unknown>[]> {
    await this.requireVisibleSpaceObject(identity, objectId, "Object not found");
    const rows = await this.db.query<NoteLinkRow>(
      `SELECT nl.id, nl.space_id,
              nl.from_object_id, from_so.object_type AS from_object_type,
              nl.to_object_id, to_so.object_type AS to_object_type,
              nl.link_type AS link_type, nl.status, nl.confidence,
              nl.metadata_json, nl.created_by_user_id,
              nl.created_at, nl.updated_at
         FROM note_links nl
         JOIN space_objects from_so
           ON from_so.id = nl.from_object_id AND from_so.space_id = nl.space_id AND from_so.deleted_at IS NULL
         JOIN space_objects to_so
           ON to_so.id = nl.to_object_id AND to_so.space_id = nl.space_id AND to_so.deleted_at IS NULL
        WHERE nl.space_id = $1 AND nl.status = 'active'
          AND nl.to_object_id = $3 AND from_so.object_type = 'note'
          AND ${this.readableSpaceObjectClause("from_so")}
          AND ${this.readableSpaceObjectClause("to_so")}
        ORDER BY nl.created_at DESC, nl.id DESC`,
      [identity.spaceId, identity.userId, objectId],
    );
    return rows.rows.map(noteLinkAsEntityLinkOut);
  }

  async noteLinks(identity: SpaceUserIdentity, noteId: string, backlinks = false): Promise<Record<string, unknown>[]> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    const rows = await this.db.query<NoteLinkRow>(
      `SELECT nl.id, nl.space_id,
              nl.from_object_id, from_so.object_type AS from_object_type,
              nl.to_object_id, to_so.object_type AS to_object_type,
              nl.link_type AS link_type, nl.status, nl.confidence,
              nl.metadata_json, nl.created_by_user_id,
              nl.created_at, nl.updated_at
         FROM note_links nl
         JOIN space_objects from_so
           ON from_so.id = nl.from_object_id
          AND from_so.space_id = nl.space_id
          AND from_so.deleted_at IS NULL
         JOIN space_objects to_so
           ON to_so.id = nl.to_object_id
          AND to_so.space_id = nl.space_id
          AND to_so.deleted_at IS NULL
        WHERE nl.space_id = $1
          AND nl.status = 'active'
          AND ${backlinks ? "to_so.object_type = 'note' AND nl.to_object_id = $3" : "from_so.object_type = 'note' AND nl.from_object_id = $3"}
          AND ${this.readableSpaceObjectClause("from_so")}
          AND ${this.readableSpaceObjectClause("to_so")}
        ORDER BY nl.created_at DESC, nl.id DESC`,
      [identity.spaceId, identity.userId, noteId],
    );
    return rows.rows.map(noteLinkAsEntityLinkOut);
  }

  async createNoteLink(identity: SpaceUserIdentity, noteId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.requireWritableNote(identity, noteId);
    const direction = optionalString(body.direction) ?? "outgoing";
    const targetType = requiredString(body.target_type, "target_type");
    const targetId = requiredString(body.target_id, "target_id");
    const sourceType = direction === "incoming" ? targetType : "note";
    const sourceId = direction === "incoming" ? targetId : noteId;
    const finalTargetType = direction === "incoming" ? "note" : targetType;
    const finalTargetId = direction === "incoming" ? noteId : targetId;
    const sourceObject = await this.requireVisibleSpaceObject(identity, sourceId, "Note link source not found");
    const targetObject = await this.requireVisibleSpaceObject(identity, finalTargetId, "Note link target not found");
    if (sourceObject.object_type !== sourceType || targetObject.object_type !== finalTargetType) {
      throw new HttpError(404, "Note link endpoint not found");
    }
    const linkType = optionalString(body.link_type) ?? "related_to";
    if (!hasDeclaration(linkType)) {
      throw new HttpError(422, "invalid link_type");
    }
    const now = new Date().toISOString();
    const result = await this.db.query<NoteLinkRow>(
      `INSERT INTO note_links (
         id, space_id, from_object_id, from_object_type, to_object_id, to_object_type,
         link_type, status, confidence, metadata_json, created_by_user_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, 'active', $8, $9, $10,
         $11, $11
       )
       RETURNING id, space_id,
                 from_object_id, from_object_type,
                 to_object_id, to_object_type,
                 link_type AS link_type, status, confidence,
                 metadata_json, created_by_user_id,
                 created_at, updated_at`,
      [
        randomUUID(),
        identity.spaceId,
        sourceId,
        sourceType,
        finalTargetId,
        finalTargetType,
        linkType,
        confidence(body.confidence),
        JSON.stringify({ link_origin: "note_link_ui", canonical_graph: false }),
        identity.userId,
        now,
      ],
    );
    const row = noteLinkAsEntityLinkOut(result.rows[0]!);
    await this.safeReindex((p) => p.reindex(identity.spaceId, "note", noteId));
    await this.reindexLinkedTarget(identity.spaceId, finalTargetType, finalTargetId);
    return row;
  }

  async deleteNoteLink(identity: SpaceUserIdentity, noteId: string, linkId: string): Promise<void> {
    await this.requireWritableNote(identity, noteId);
    const links = await this.db.query<{
      from_object_type: string;
      from_object_id: string;
      to_object_type: string;
      to_object_id: string;
    }>(
      `SELECT from_so.object_type AS from_object_type, nl.from_object_id,
              to_so.object_type AS to_object_type, nl.to_object_id
         FROM note_links nl
         JOIN space_objects from_so ON from_so.id = nl.from_object_id AND from_so.space_id = nl.space_id
         JOIN space_objects to_so ON to_so.id = nl.to_object_id AND to_so.space_id = nl.space_id
        WHERE nl.id = $1 AND nl.space_id = $2
          AND ((from_so.object_type = 'note' AND nl.from_object_id = $3) OR (to_so.object_type = 'note' AND nl.to_object_id = $3))`,
      [linkId, identity.spaceId, noteId],
    );
    await this.db.query(
      `DELETE FROM note_links
        WHERE id = $1 AND space_id = $2
          AND EXISTS (
            SELECT 1 FROM space_objects from_so, space_objects to_so
             WHERE from_so.id = note_links.from_object_id
               AND from_so.space_id = note_links.space_id
               AND to_so.id = note_links.to_object_id
               AND to_so.space_id = note_links.space_id
               AND ((from_so.object_type = 'note' AND note_links.from_object_id = $3)
                 OR (to_so.object_type = 'note' AND note_links.to_object_id = $3))
          )`,
      [linkId, identity.spaceId, noteId],
    );
    for (const row of links.rows) {
      await this.reindexLinkedTarget(identity.spaceId, row.from_object_type, row.from_object_id);
      await this.reindexLinkedTarget(identity.spaceId, row.to_object_type, row.to_object_id);
    }
  }

  // Reindex is best-effort: the derived projection must never fail a canonical
  // CRUD write. These repository methods run on a pool connection (no ambient
  // transaction), so a thrown projection query is contained by this catch and
  // logged rather than surfaced as a 500 on a write that already committed.
  private async safeReindex(
    run: (projection: RetrievalProjectionService) => Promise<void>,
  ): Promise<void> {
    try {
      await run(new RetrievalProjectionService(this.db, knowledgeRetrievalRegistry));
    } catch (error) {
      process.stderr.write(
        `[knowledge.retrieval] reindex failed after canonical write: ${String((error as Error)?.message ?? error)}\n`,
      );
    }
  }

  private async reindexLinkedTarget(spaceId: string, targetType: string, targetId: string): Promise<void> {
    if (!isKnowledgeRetrievalObjectType(targetType)) return;
    await this.safeReindex((projection) => projection.reindex(spaceId, targetType, targetId));
  }

  private buildItemWhere(
    identity: SpaceUserIdentity,
    filters: {
    knowledgeKind: string | null;
      status: string | null;
      visibility: string | null;
      projectId: string | null;
      projectFolderId: string | null;
      q: string | null;
    },
  ): { where: string; params: unknown[] } {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const clauses = [
      "ki.space_id = $1",
      this.readableSpaceObjectClause("so"),
    ];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.knowledgeKind) clauses.push(`ki.knowledge_kind = ${add(filters.knowledgeKind)}`);
    if (filters.status) clauses.push(`ki.status = ${add(filters.status)}`);
    if (filters.visibility) {
      clauses.push(contentVisibilityParamFilterSql("so", add(filters.visibility)));
    }
    if (filters.projectId) clauses.push(`so.primary_project_id = ${add(filters.projectId)}`);
    if (filters.projectFolderId) clauses.push(`so.project_folder_id = ${add(filters.projectFolderId)}`);
    if (filters.q) clauses.push(`(so.title ILIKE ${add(`%${filters.q}%`)} OR ki.content ILIKE $${params.length})`);
    return { where: `WHERE ${clauses.join(" AND ")}`, params };
  }

  private buildClaimWhere(
    identity: SpaceUserIdentity,
    filters: {
      claimKind: string | null;
      status: string | null;
      subjectObjectId: string | null;
      q: string | null;
    },
  ): { where: string; params: unknown[] } {
    const params: unknown[] = [identity.spaceId, identity.userId];
    const clauses = [
      "c.space_id = $1",
      this.readableSpaceObjectClause("so"),
    ];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.claimKind) clauses.push(`c.claim_kind = ${add(filters.claimKind)}`);
    if (filters.status) clauses.push(`c.status = ${add(filters.status)}`);
    if (filters.subjectObjectId) clauses.push(`c.subject_object_id = ${add(filters.subjectObjectId)}`);
    if (filters.q) {
      const slot = add(`%${filters.q}%`);
      clauses.push(`(so.title ILIKE ${slot} OR c.claim_text ILIKE ${slot} OR c.subject_text ILIKE ${slot})`);
    }
    return { where: `WHERE ${clauses.join(" AND ")}`, params };
  }

  private readableSpaceObjectClause(alias: string, userParam = "$2"): string {
    return contentReadSql("space_object", alias, userParam);
  }

  private async getVisibleItemRow(identity: SpaceUserIdentity, itemId: string): Promise<KnowledgeItemRow | null> {
    const result = await this.db.query<KnowledgeItemRow>(
      `SELECT ${KNOWLEDGE_ITEM_COLUMNS}
         FROM ${KNOWLEDGE_ITEM_FROM}
        WHERE ki.object_id = $1 AND ki.space_id = $2
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [itemId, identity.spaceId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  // Kept for the import path; used by profile-key uniqueness checks.
  /**
   * Ontology surfaces delegate to `PgOntologyRepository`. The public routes keep
   * their `/api/v1/knowledge/` paths — moving them would be a client-visible
   * break this phase does not imply — but the implementation and its ownership
   * now live with the ontology (ADR 0012 decision 3, B12I).
   */
  private ontology(): PgOntologyRepository {
    return new PgOntologyRepository(this.db, {
      insertProposal: (identity, input) => this.insertKnowledgeProposal(identity, input),
      getVisibleClaimRow: (identity, claimId) => this.getVisibleClaimRow(identity, claimId),
      requireVisibleSpaceObject: (identity, objectId, message) =>
        this.requireVisibleSpaceObject(identity, objectId, message),
    });
  }

  listObjectProfiles(...args: Parameters<PgOntologyRepository["listObjectProfiles"]>) {
    return this.ontology().listObjectProfiles(...args);
  }

  getObjectProfile(...args: Parameters<PgOntologyRepository["getObjectProfile"]>) {
    return this.ontology().getObjectProfile(...args);
  }

  proposeObjectProfileCreate(...args: Parameters<PgOntologyRepository["proposeObjectProfileCreate"]>) {
    return this.ontology().proposeObjectProfileCreate(...args);
  }

  proposeObjectProfileUpdate(...args: Parameters<PgOntologyRepository["proposeObjectProfileUpdate"]>) {
    return this.ontology().proposeObjectProfileUpdate(...args);
  }

  proposeObjectProfileDeprecate(...args: Parameters<PgOntologyRepository["proposeObjectProfileDeprecate"]>) {
    return this.ontology().proposeObjectProfileDeprecate(...args);
  }

  proposeObjectProfileArchive(...args: Parameters<PgOntologyRepository["proposeObjectProfileArchive"]>) {
    return this.ontology().proposeObjectProfileArchive(...args);
  }

  exportObjectSchema(...args: Parameters<PgOntologyRepository["exportObjectSchema"]>) {
    return this.ontology().exportObjectSchema(...args);
  }

  proposeObjectRelation(...args: Parameters<PgOntologyRepository["proposeObjectRelation"]>) {
    return this.ontology().proposeObjectRelation(...args);
  }

  importObjectSchemaManifest(...args: Parameters<PgOntologyRepository["importObjectSchemaManifest"]>) {
    return this.ontology().importObjectSchemaManifest(...args);
  }



  private async getVisibleClaimRow(identity: SpaceUserIdentity, claimId: string): Promise<ClaimRow | null> {
    const result = await this.db.query<ClaimRow>(
      `SELECT ${CLAIM_COLUMNS}
         FROM ${CLAIM_FROM}
        WHERE c.object_id = $1 AND c.space_id = $2
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [claimId, identity.spaceId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  private async hasActiveSupersedingClaimRelation(spaceId: string, claimId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `SELECT r.id
         FROM object_relations r
         JOIN space_objects from_so
           ON from_so.id = r.from_object_id
          AND from_so.space_id = r.space_id
          AND from_so.object_type = 'claim'
          AND from_so.deleted_at IS NULL
         JOIN space_objects to_so
           ON to_so.id = r.to_object_id
          AND to_so.space_id = r.space_id
          AND to_so.object_type = 'claim'
          AND to_so.deleted_at IS NULL
        WHERE r.space_id = $1
          AND r.to_object_id = $2
          AND r.link_type = 'supersedes'
          AND r.status = 'active'
        LIMIT 1`,
      [spaceId, claimId],
    );
    return Boolean(result.rows[0]);
  }

  private async getObjectRelationRow(identity: SpaceUserIdentity, relationId: string): Promise<ObjectRelationRow | null> {
    const result = await this.db.query<ObjectRelationRow>(
      `SELECT ${OBJECT_RELATION_COLUMNS}
         FROM object_relations
        WHERE id = $1 AND space_id = $2`,
      [relationId, identity.spaceId],
    );
    return result.rows[0] ?? null;
  }







  private async validateObjectProfileProposalFields(
    identity: SpaceUserIdentity,
    baseObjectType: string,
    key: string,
    body: Record<string, unknown>,
    options: { validateWhenFieldsAbsent: boolean },
  ): Promise<ObjectProfileProposalFieldValidation> {
    const row = await this.ontology().activeObjectProfileByKey(identity, baseObjectType, key);
    if (!row) return {};
    const fields = objectProfileFieldValuesInput(body, options.validateWhenFieldsAbsent);
    if (!fields) return {};
    const result = validateObjectProfileFieldSchema(row.field_schema_json, fields);
    const validation = {
      object_profile_id: row.id,
      object_profile: row.key,
      object_profile_label: row.label,
      enforcement: result.enforcement,
      ok: result.errors.length === 0,
      errors: result.errors,
      warnings: result.enforcement === "strict" ? [] : result.errors,
    };
    if (result.enforcement === "strict" && result.errors.length > 0) {
      throw new HttpError(422, `object_profile_fields invalid: ${result.errors.join("; ")}`);
    }
    return { fields, validation };
  }



  private async listClaimSourceRows(identity: SpaceUserIdentity, claimId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<ClaimSourceRow>(
      `SELECT ${CLAIM_SOURCE_COLUMNS}
         FROM claim_sources
        WHERE claim_id = $1 AND space_id = $2
        ORDER BY created_at ASC, id ASC`,
      [claimId, identity.spaceId],
    );
    // Source-policy gate: a visible claim can carry evidence sourced from a
    // connection that restricts this viewer (allowed readers / agents /
    // `allow_space_admins = false`). Those evidence rows — including their
    // quote/locator — must not render. Fail-closed: a named connection without a
    // readable snapshot drops the row. Mirrors retrieval's `enforceSourceReadPolicy`.
    const allowed = await this.filterClaimSourceRowsByPolicy(identity, rows.rows);
    return allowed.map(claimSourceOut);
  }

  private async filterClaimSourceRowsByPolicy(
    identity: SpaceUserIdentity,
    rows: readonly ClaimSourceRow[],
  ): Promise<ClaimSourceRow[]> {
    const sourceIds = [
      ...new Set(rows.map((row) => row.source_connection_id).filter((id): id is string => Boolean(id))),
    ];
    if (sourceIds.length === 0) return [...rows];
    const [snapshots, viewerSpaceRole] = await Promise.all([
      loadSourcePolicySnapshots(this.db, identity.spaceId, sourceIds),
      loadViewerSpaceRole(this.db, identity.spaceId, identity.userId),
    ]);
    return rows.filter((row) => {
      if (!row.source_connection_id) return true;
      const snapshot = snapshots.get(row.source_connection_id);
      return snapshot
        ? sourcePolicyAllowsRead(snapshot, { viewerUserId: identity.userId, viewerSpaceRole })
        : false;
    });
  }

  /** Gated for the same reason as {@link getNoteRow}: it backs reads and writes. */
  private async getSourceRow(identity: SpaceUserIdentity, sourceId: string): Promise<SourceRow | null> {
    const result = await this.db.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS}
         FROM ${SOURCE_FROM}
        WHERE s.object_id = $1 AND s.space_id = $2
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [sourceId, identity.spaceId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  private async requireVisibleSpaceObject(
    identity: SpaceUserIdentity,
    objectId: string,
    notFoundMessage: string,
  ): Promise<SpaceObjectRow> {
    const object = await this.getVisibleSpaceObjectRow(identity, objectId);
    if (!object) throw new HttpError(404, notFoundMessage);
    return object;
  }

  private async getVisibleSpaceObjectRow(identity: SpaceUserIdentity, objectId: string): Promise<SpaceObjectRow | null> {
    const result = await this.db.query<SpaceObjectRow>(
      `SELECT id, space_id, object_type, title,
              ${objectStatusScalarSql("so")} AS status, visibility,
              owner_user_id, primary_project_id, project_folder_id, created_by_user_id
         FROM space_objects so
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [objectId, identity.spaceId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  private async normalizeClaimSources(identity: SpaceUserIdentity, rawSources: unknown): Promise<Record<string, unknown>[]> {
    const sources = Array.isArray(rawSources) ? rawSources : [];
    const normalized: Record<string, unknown>[] = [];
    for (const raw of sources) {
      const source = optionalObject(raw);
      if (!source) throw new HttpError(422, "claim source entries must be objects");
      const sourceObjectId = optionalString(source.source_object_id);
      if (sourceObjectId) {
        const sourceObject = await this.requireVisibleSpaceObject(identity, sourceObjectId, "Claim source object not found");
        // `Evidenceable` decides what may back a claim, rather than every
        // caller deciding for itself.
        assertEvidenceableObjectType(sourceObject.object_type);
      }
      const sourceConnectionId = optionalString(source.source_connection_id);
      if (sourceConnectionId) await this.requireSourceConnection(identity, sourceConnectionId);
      const sourceRefType = optionalString(source.source_ref_type);
      const sourceRefId = optionalString(source.source_ref_id);
      if ((sourceRefType && !sourceRefId) || (!sourceRefType && sourceRefId)) {
        throw new HttpError(422, "source_ref_type and source_ref_id must be provided together");
      }
      if (sourceRefType && !CLAIM_SOURCE_REF_TYPES.has(sourceRefType)) throw new HttpError(422, "invalid source_ref_type");
      if (sourceRefType && !sourceConnectionId) {
        throw new HttpError(422, "source_ref entries require source_connection_id");
      }
      if (!sourceObjectId && !sourceConnectionId && !sourceRefType) {
        throw new HttpError(422, "claim source requires source_object_id, source_connection_id, or source_ref_type/source_ref_id");
      }
      const evidenceRole = requiredString(source.evidence_role ?? "supports", "evidence_role");
      if (!CLAIM_EVIDENCE_ROLES.has(evidenceRole)) throw new HttpError(422, "invalid evidence_role");
      const sourceTrust = optionalString(source.source_trust);
      if (sourceTrust && !CLAIM_SOURCE_TRUST_LEVELS.has(sourceTrust)) throw new HttpError(422, "invalid source_trust");
      normalized.push({
        source_object_id: sourceObjectId,
        source_ref_type: sourceRefType,
        source_ref_id: sourceRefId,
        source_connection_id: sourceConnectionId,
        source_policy_snapshot: optionalObject(source.source_policy_snapshot) ?? optionalObject(source.source_policy_snapshot_json) ?? {},
        locator: optionalString(source.locator),
        quote_excerpt: optionalString(source.quote_excerpt),
        evidence_role: evidenceRole,
        source_trust: sourceTrust,
        confidence: confidence(source.confidence),
        metadata: optionalObject(source.metadata) ?? {},
      });
    }
    return normalized;
  }

  private async requireSourceConnection(identity: SpaceUserIdentity, connectionId: string): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM source_connections
        WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [connectionId, identity.spaceId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Claim source connection not found");
  }

  private async listKnowledgeSourceRefs(identity: SpaceUserIdentity, itemId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<ProvenanceLinkRow>(
      `SELECT source_type, source_id, source_trust, evidence_json, created_at
         FROM provenance_links
        WHERE space_id = $1 AND target_type = 'knowledge' AND target_id = $2
        ORDER BY created_at ASC, source_type ASC, source_id ASC`,
      [identity.spaceId, itemId],
    );
    return rows.rows.map((row) => ({
      source_type: row.source_type,
      source_id: row.source_id,
      source_trust: row.source_trust,
      evidence_json: optionalObject(row.evidence_json),
      created_at: dateIso(row.created_at),
    }));
  }

  private async listKnowledgeItemSourceLinks(
    column: "knowledge_item_id" | "source_id",
    value: string,
    spaceId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, space_id, knowledge_item_id, source_id, relation_type,
              locator, quote, note, confidence, created_by_user_id, created_at
         FROM knowledge_item_sources
        WHERE ${column} = $1 AND space_id = $2
        ORDER BY created_at DESC, id DESC`,
      [value, spaceId],
    );
    return rows.rows.map(normalizeDates);
  }

  /**
   * The shared lookup behind every single-note read *and* mutation.
   *
   * It applies the read gate, which the list path has always applied and this
   * did not: a private note was absent from the list and returned by a direct
   * fetch, and because `updateNote` / `deleteNote` / `rollbackNote` all gate on
   * this row's existence, it was also editable by anyone in the Space. The same
   * defect class the ontology audit fixed for `requireCase` and
   * `definitionRow`; gating here means a caller cannot mutate what it cannot
   * see.
   */
  private async getNoteRow(identity: SpaceUserIdentity, noteId: string): Promise<NoteRow | null> {
    const result = await this.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS}
         FROM ${NOTE_FROM}
         ${NOTE_PLACEMENTS_JOIN}
        WHERE n.object_id = $1 AND n.space_id = $2
          AND ${contentReadSql("space_object", "so", "$3")}`,
      [noteId, identity.spaceId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * A Project share widens read scope only. Mutating a Project-owned note still
   * requires writer authority in the Project that owns its governance scope.
   * Return the same 404 as the content gate so viewer/shared-reader denials do
   * not turn mutation routes into a Project-membership oracle.
   */
  private async requireWritableNote(identity: SpaceUserIdentity, noteId: string): Promise<NoteRow> {
    const note = await this.getNoteRow(identity, noteId);
    if (!note) throw new HttpError(404, "Note not found");
    if (note.primary_project_id && !(await canWriteProject(
      this.db,
      identity.spaceId,
      note.primary_project_id,
      identity.userId,
    ))) {
      throw new HttpError(404, "Note not found");
    }
    return note;
  }

  /**
   * Resolve the existing capture note for one target inside one scope.
   *
   * The owner dimension is what keeps the two kinds of note about the same
   * object apart. A jot from an evidence card is team material and passes
   * `null`; a marginalia capture passes its owner. Without the split the
   * shared jot would find the caller's own private note first — it is linked
   * to the same object and the caller can read it — and quietly append team
   * material into something no teammate can see.
   *
   * The two branches deliberately key on different things. Marginalia keys on
   * the binding columns, which are also its uniqueness key, so the lookup can
   * never miss a row the index would reject — deleting the note's link, which
   * the note editor offers, must not turn the next capture into a constraint
   * violation. The shared jot keys on the link, which is all a team note about
   * an object has, and additionally refuses a `private` note: a binding can be
   * cleared (by an archive, say) while the note stays private, and "no binding"
   * alone would then read as "team note".
   */
  async noteForJotTarget(
    identity: SpaceUserIdentity,
    targetId: string,
    projectId: string | null,
    marginaliaOwnerUserId: string | null = null,
  ): Promise<string | null> {
    const candidates = await this.db.query<{ note_id: string }>(
      `SELECT n.object_id AS note_id
         FROM notes n
         JOIN space_objects note_so
           ON note_so.id = n.object_id
          AND note_so.space_id = n.space_id
          AND note_so.object_type = 'note'
          AND note_so.deleted_at IS NULL
        WHERE n.space_id = $1
          AND n.status = 'active'
          AND note_so.primary_project_id IS NOT DISTINCT FROM $3::varchar
          AND CASE WHEN $4::varchar IS NULL
                   THEN n.marginalia_owner_user_id IS NULL
                        AND note_so.visibility <> 'private'
                        AND EXISTS (
                          SELECT 1 FROM note_links nl
                           WHERE nl.space_id = n.space_id
                             AND nl.from_object_id = n.object_id
                             AND nl.to_object_id = $2
                             AND nl.status = 'active')
                   ELSE n.marginalia_owner_user_id = $4::varchar
                        AND n.marginalia_target_object_id = $2
              END
        ORDER BY note_so.created_at ASC, n.object_id ASC`,
      [identity.spaceId, targetId, projectId, marginaliaOwnerUserId],
    );
    for (const candidate of candidates.rows) {
      if (await this.getNoteRow(identity, candidate.note_id)) return candidate.note_id;
    }
    return null;
  }

  private async getNoteCollectionRow(
    identity: SpaceUserIdentity,
    collectionId: string,
  ): Promise<NoteCollectionRow | null> {
    const rows = await this.listVisibleNoteCollectionRows(identity);
    return rows.find((row) => row.id === collectionId) ?? null;
  }

  private async requireNoteCollection(identity: SpaceUserIdentity, collectionId: string): Promise<void> {
    if (!(await this.getNoteCollectionRow(identity, collectionId))) {
      throw new HttpError(404, "Note collection not found");
    }
  }


  private async insertKnowledgeProposal(inputIdentity: SpaceUserIdentity, input: {
    proposalType: string;
    title: string;
    payload: Record<string, unknown>;
    rationale: string;
    projectFolderId: string | null;
    projectId: string | null;
    visibility: "private" | "space_shared" | "selected_users";
    riskLevel?: "low" | "medium" | "high" | "critical";
  }): Promise<ProposalOut> {
    const now = new Date();
    const row = await insertProposalRow(this.db, {
      spaceId: inputIdentity.spaceId,
      proposalType: input.proposalType,
      title: input.title,
      payload: input.payload,
      rationale: input.rationale,
      projectFolderId: input.projectFolderId,
      projectId: input.projectId,
      createdByUserId: inputIdentity.userId,
      visibility: input.visibility,
      riskLevel: input.riskLevel ?? "low",
    });
    return proposalToOut(row, now);
  }
}

function buildNoteWhere(
  identity: SpaceUserIdentity,
  filters: {
    status: string | null;
    projectId: string | null;
    collectionId: string | null;
    collectionIds: string[] | null;
    q: string | null;
  },
): { where: string; params: unknown[] } {
  const params: unknown[] = [identity.spaceId];
  const clauses = ["n.space_id = $1"];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  // The list was gated by Space membership alone: `getNoteRow` applies the
  // content gate but this did not, so every note in the Space was listable by
  // any member regardless of owner, visibility, or Project — the note bodies
  // and titles with them. A list that leaks what a detail read refuses is the
  // same defect the ontology audit fixed for `requireCase`, one level up.
  clauses.push(contentReadSql("space_object", "so", add(identity.userId)));
  clauses.push(filters.status ? `n.status = ${add(filters.status)}` : "n.status <> 'deleted'");
  if (filters.projectId) clauses.push(`so.primary_project_id = ${add(filters.projectId)}`);
  if (filters.collectionId) clauses.push(`nci_filter.collection_id = ${add(filters.collectionId)}`);
  // `collection_ids` restricts to a *set* of folders — the hoisted subtree a
  // notes surface is focused on — where `collection_id` selects one folder's
  // ordered contents. A search run while hoisted must not reach outside the
  // subtree, and filtering only what is drawn is the wrong half of that.
  //
  // EXISTS rather than a predicate on the joined row: a note may sit in several
  // of the scoped folders at once (multi-placement is expressible and kept), and
  // a join predicate would return it once per placement.
  if (filters.collectionIds?.length) {
    clauses.push(
      `EXISTS (SELECT 1 FROM note_collection_items nci_scope
                WHERE nci_scope.note_id = n.object_id
                  AND nci_scope.space_id = n.space_id
                  AND nci_scope.collection_id = ANY(${add(filters.collectionIds)}::varchar[]))`,
    );
  }
  if (filters.q) clauses.push(`(so.title ILIKE ${add(`%${filters.q}%`)} OR n.plain_text ILIKE $${params.length})`);
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

interface ObjectProfileProposalFieldValidation {
  fields?: Record<string, unknown>;
  validation?: Record<string, unknown>;
}

interface ParsedObjectProfileField {
  key: string;
  type: string | null;
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  min: number | null;
  max: number | null;
  values: string[] | null;
}

function objectProfileFieldValuesInput(
  body: Record<string, unknown>,
  validateWhenFieldsAbsent: boolean,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(body, "object_profile_fields")) {
    return validateWhenFieldsAbsent ? {} : undefined;
  }
  const record = optionalObject(body.object_profile_fields);
  if (!record) throw new HttpError(422, "object_profile_fields must be a JSON object");
  return record;
}

function objectProfileValidationPayload(input: ObjectProfileProposalFieldValidation): Record<string, unknown> {
  return {
    ...(input.fields ? { object_profile_fields: input.fields } : {}),
    ...(input.validation ? { object_profile_validation: input.validation } : {}),
  };
}

function withObjectProfileFieldMetadata(
  metadata: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fields) return metadata;
  return { ...metadata, object_profile_fields: fields };
}

function validateObjectProfileFieldSchema(
  fieldSchema: unknown,
  values: Record<string, unknown>,
): { enforcement: "advisory" | "strict"; errors: string[] } {
  const schema = optionalObject(fieldSchema) ?? {};
  const enforcement = objectProfileSchemaEnforcement(schema);
  const fields = parseObjectProfileFields(schema);
  const errors: string[] = [];

  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) errors.push(`${field.key} is required`);
      continue;
    }
    const typeError = objectProfileFieldTypeError(field, value);
    if (typeError) {
      errors.push(typeError);
      continue;
    }
    if (typeof value === "string") {
      if (field.minLength !== null && value.length < field.minLength) {
        errors.push(`${field.key} must be at least ${field.minLength} characters`);
      }
      if (field.maxLength !== null && value.length > field.maxLength) {
        errors.push(`${field.key} must be at most ${field.maxLength} characters`);
      }
    }
    if (typeof value === "number") {
      if (field.min !== null && value < field.min) errors.push(`${field.key} must be >= ${field.min}`);
      if (field.max !== null && value > field.max) errors.push(`${field.key} must be <= ${field.max}`);
    }
    if (field.values && !field.values.includes(String(value))) {
      errors.push(`${field.key} must be one of ${field.values.join(", ")}`);
    }
  }

  if (schema.additional_properties === false || schema.additionalProperties === false) {
    const allowed = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) errors.push(`${key} is not allowed`);
    }
  }

  return { enforcement, errors };
}

function objectProfileSchemaEnforcement(schema: Record<string, unknown>): "advisory" | "strict" {
  const raw = optionalString(schema.enforcement)
    ?? optionalString(schema.validation_mode)
    ?? optionalString(schema.mode);
  return raw === "strict" || raw === "enforced" || raw === "required" ? "strict" : "advisory";
}

function parseObjectProfileFields(schema: Record<string, unknown>): ParsedObjectProfileField[] {
  const required = new Set(stringArray(schema.required));
  const fields: ParsedObjectProfileField[] = [];
  const seen = new Set<string>();
  const addField = (key: string, config: Record<string, unknown>) => {
    if (!OBJECT_PROFILE_KEY_PATTERN.test(key) || seen.has(key)) return;
    seen.add(key);
    fields.push({
      key,
      type: objectProfileFieldType(config),
      required: required.has(key) || config.required === true,
      minLength: integerOption(config.min_length ?? config.minLength),
      maxLength: integerOption(config.max_length ?? config.maxLength),
      min: numberValue(config.min ?? config.minimum),
      max: numberValue(config.max ?? config.maximum),
      values: stringArray(config.values ?? config.enum),
    });
  };

  const fieldArray = Array.isArray(schema.fields) ? schema.fields : [];
  for (const entry of fieldArray) {
    const config = optionalObject(entry);
    const key = optionalString(config?.key);
    if (key && config) addField(key, config);
  }

  const properties = optionalObject(schema.properties);
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      addField(key, optionalObject(value) ?? {});
    }
  }
  return fields;
}

function objectProfileFieldType(config: Record<string, unknown>): string | null {
  const type = optionalString(config.type);
  if (!type) return null;
  const normalized = type.toLowerCase();
  return ["string", "number", "integer", "boolean", "array", "object"].includes(normalized)
    ? normalized
    : null;
}

function objectProfileFieldTypeError(field: ParsedObjectProfileField, value: unknown): string | null {
  switch (field.type) {
    case null:
      return null;
    case "string":
      return typeof value === "string" ? null : `${field.key} must be a string`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${field.key} must be a number`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? null : `${field.key} must be an integer`;
    case "boolean":
      return typeof value === "boolean" ? null : `${field.key} must be a boolean`;
    case "array":
      return Array.isArray(value) ? null : `${field.key} must be an array`;
    case "object":
      return optionalObject(value) ? null : `${field.key} must be an object`;
  }
  return null;
}

function integerOption(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}









function objectRelationAsKnowledgeRelationOut(row: ObjectRelationRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    from_item_id: row.from_object_id,
    to_item_id: row.to_object_id,
    link_type: row.link_type,
    status: row.status,
    confidence: row.confidence,
    evidence_summary: row.evidence_summary,
    source_proposal_id: row.source_proposal_id,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_from_assessment_id: null,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

function objectRelationAsClaimRelationOut(row: ObjectRelationRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    from_claim_id: row.from_object_id,
    to_claim_id: row.to_object_id,
    link_type: row.link_type,
    status: row.status,
    confidence: row.confidence,
    evidence_summary: row.evidence_summary,
    source_proposal_id: row.source_proposal_id,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

function objectRelationAsEntityLinkOut(row: ObjectRelationRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    source_type: row.from_object_type,
    source_id: row.from_object_id,
    target_type: row.to_object_type,
    target_id: row.to_object_id,
    link_type: row.link_type,
    confidence: row.confidence,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at),
  };
}

function noteLinkAsEntityLinkOut(row: NoteLinkRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    source_type: row.from_object_type,
    source_id: row.from_object_id,
    target_type: row.to_object_type,
    target_id: row.to_object_id,
    link_type: row.link_type,
    confidence: row.confidence,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at),
  };
}




function assertNoContentAccessUpdate(body: Record<string, unknown>): void {
  if (body.visibility !== undefined || body.access_level !== undefined || body.grants !== undefined) {
    throw new HttpError(422, "Use the content-access API to update Knowledge permissions");
  }
}

function normalizedKnowledgeVisibility(value: string): "private" | "space_shared" | "selected_users" {
  if (value === "private" || value === "space_shared" || value === "selected_users") return value;
  throw new Error(`Invalid persisted Knowledge visibility: ${value}`);
}

function titleFromClaimText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function hashClaimText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

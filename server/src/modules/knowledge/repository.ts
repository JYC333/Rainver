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
  type SpaceUserIdentity,
  type Queryable,
} from "../routeUtils/common";
import { contentReadSql, contentVisibilityParamFilterSql } from "../access/contentAccessSql";
import { proposalToOut } from "../proposals/repository";
import { insertProposalRow } from "../proposals/reviewPackets";
import type { ProposalOut } from "@agent-space/protocol" with { "resolution-mode": "import" };
import { RETRIEVAL_OBJECT_TYPE_VALUES } from "../retrieval/objectTypes";
import {
  canMutateClaim,
  canMutateKnowledge,
  claimOut,
  claimSourceOut,
  claimSummaryOut,
  confidence,
  knowledgeItemOut,
  knowledgeSummaryOut,
  normalizeDates,
  noteCollectionOut,
  noteOut,
  noteSummaryOut,
  objectRelationOut,
  sourceOut,
  sourceSummaryOut,
} from "./knowledgeRepositoryMappers";
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
  NOTE_STATUSES,
  OBJECT_RELATION_COLUMNS,
  OBJECT_RELATION_TYPES,
  RELATION_TYPES,
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
} from "./knowledgeRepositoryRows";
import {
  RetrievalProjectionService,
  loadSourcePolicySnapshots,
  loadViewerSpaceRole,
  sourcePolicyAllowsRead,
} from "../retrieval";
import { knowledgeRetrievalRegistry } from "./retrievalAdapter";
import { isKnowledgeRetrievalObjectType } from "./retrievalObjectTypes";
import {
  writeNote,
  listNoteRevisions as listNoteRevisionRows,
  rollbackNote as rollbackNoteContent,
  insertInitialNoteRevision,
  sha256,
} from "./noteRevisionService";
import {
  RELATION_CREATE_STATUSES,
  claimCreateStatusError,
  claimResolutionStateError,
  claimStatusTransitionError,
} from "./claimStatusRules";
import { allowedObjectKindKeys } from "./objectKindSubtypeKeys";

interface SpaceObjectRow {
  id: string;
  space_id: string;
  object_type: string;
  title: string;
  status: string;
  visibility: string;
  owner_user_id: string | null;
  primary_project_id: string | null;
  workspace_id: string | null;
  created_by_user_id: string | null;
}

interface SpaceObjectKindRow {
  id: string;
  space_id: string;
  key: string;
  label: string;
  description: string | null;
  base_object_type: string;
  status: string;
  version: number | string;
  field_schema_json: unknown;
  extraction_policy_json: unknown;
  retrieval_policy_json: unknown;
  ui_config_json: unknown;
  created_by_user_id: string | null;
  created_from_proposal_id: string | null;
  updated_from_proposal_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SpaceObjectKindRelationHintRow {
  id: string;
  object_kind_id: string;
  endpoint_object_type: string;
  endpoint_object_kind_id: string | null;
  endpoint_object_kind_key: string | null;
  relation_type: string;
  direction: string;
  confidence_default: number | string;
  required: boolean;
}

interface NoteLinkRow {
  id: string;
  space_id: string;
  from_object_id: string;
  from_object_type: string;
  to_object_id: string;
  to_object_type: string;
  relation_type: string;
  status: string;
  confidence: number | string | null;
  metadata_json: unknown;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const OBJECT_KIND_COLUMNS = `
  id, space_id, key, label, description, base_object_type, status, version,
  field_schema_json, extraction_policy_json, retrieval_policy_json, ui_config_json,
  created_by_user_id, created_from_proposal_id, updated_from_proposal_id,
  created_at, updated_at
`;

const OBJECT_KIND_BASE_TYPES = new Set<string>(RETRIEVAL_OBJECT_TYPE_VALUES);
const OBJECT_KIND_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UNSAFE_OBJECT_KIND_CONFIG_KEY_TOKENS = new Set([
  "script",
  "scripts",
  "shell",
  "command",
  "commands",
  "sql",
  "query_sql",
  "regex",
  "regexp",
  "pattern",
  "patterns",
  "provider_tool",
  "provider_tools",
  "tool",
  "tools",
  "executable",
]);

export class PgKnowledgeRepository {
  constructor(private readonly db: Queryable) {}

  async summary(identity: SpaceUserIdentity): Promise<Record<string, unknown>> {
    const [notes, wiki, sources, claims] = await Promise.all([
      this.db.query<{ status: string; total: string }>(
        `SELECT so.status, count(*)::text AS total
           FROM notes n
           JOIN space_objects so ON so.id = n.object_id AND so.space_id = n.space_id
          WHERE n.space_id = $1 AND so.object_type = 'note'
          GROUP BY so.status`,
        [identity.spaceId],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM ${KNOWLEDGE_ITEM_FROM}
          WHERE ki.space_id = $1 AND so.status = 'active'`,
        [identity.spaceId],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM ${SOURCE_FROM}
         WHERE s.space_id = $1`,
        [identity.spaceId],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM ${CLAIM_FROM}
          WHERE c.space_id = $1
            AND so.status = 'active'
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

  async listObjectKinds(
    identity: SpaceUserIdentity,
    filters: {
      baseObjectType: string | null;
      status: string | null;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }> {
    const params: unknown[] = [identity.spaceId];
    const clauses = ["space_id = $1"];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filters.baseObjectType) {
      if (!OBJECT_KIND_BASE_TYPES.has(filters.baseObjectType)) throw new HttpError(422, "invalid base_object_type");
      clauses.push(`base_object_type = ${addParam(filters.baseObjectType)}`);
    }
    if (filters.status) clauses.push(`status = ${addParam(filters.status)}`);
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(*)::text AS total FROM space_object_kinds ${where}`,
      params,
    );
    const rows = await this.db.query<SpaceObjectKindRow>(
      `SELECT ${OBJECT_KIND_COLUMNS}
         FROM space_object_kinds
        ${where}
        ORDER BY base_object_type ASC, key ASC
        LIMIT ${addParam(filters.limit)} OFFSET ${addParam(filters.offset)}`,
      params,
    );
    const hintsByKind = await this.loadObjectKindRelationHints(identity.spaceId, rows.rows.map((row) => row.id));
    return page(
      rows.rows.map((row) => objectKindOut(row, hintsByKind.get(row.id) ?? [])),
      countFromRow(total.rows[0]),
      filters.limit,
      filters.offset,
    );
  }

  async getObjectKind(identity: SpaceUserIdentity, kindId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getObjectKindRow(identity, kindId);
    if (!row) return null;
    const hintsByKind = await this.loadObjectKindRelationHints(identity.spaceId, [row.id]);
    return objectKindOut(row, hintsByKind.get(row.id) ?? []);
  }

  async exportObjectSchema(identity: SpaceUserIdentity): Promise<Record<string, unknown>> {
    const rows = await this.db.query<SpaceObjectKindRow>(
      `SELECT ${OBJECT_KIND_COLUMNS}
         FROM space_object_kinds
        WHERE space_id = $1
          AND status <> 'archived'
        ORDER BY base_object_type ASC, key ASC`,
      [identity.spaceId],
    );
    const kindIds = rows.rows.map((row) => row.id);
    const hints = kindIds.length > 0
      ? await this.db.query<SpaceObjectKindRelationHintRow>(
          `SELECT h.id,
                  h.object_kind_id,
                  h.endpoint_object_type,
                  h.endpoint_object_kind_id,
                  endpoint_kind.key AS endpoint_object_kind_key,
                  h.relation_type,
                  h.direction,
                  h.confidence_default,
                  h.required
             FROM space_object_kind_relation_hints h
             LEFT JOIN space_object_kinds endpoint_kind
               ON endpoint_kind.id = h.endpoint_object_kind_id
              AND endpoint_kind.space_id = h.space_id
            WHERE h.space_id = $1
              AND h.object_kind_id = ANY($2::varchar[])
            ORDER BY h.object_kind_id ASC, h.required DESC, h.relation_type ASC, h.id ASC`,
          [identity.spaceId, kindIds],
        )
      : { rows: [] as SpaceObjectKindRelationHintRow[] };
    const hintsByKind = new Map<string, SpaceObjectKindRelationHintRow[]>();
    for (const hint of hints.rows) {
      const arr = hintsByKind.get(hint.object_kind_id) ?? [];
      arr.push(hint);
      hintsByKind.set(hint.object_kind_id, arr);
    }
    const versions = rows.rows.map((row) => numberValue(row.version) ?? 0);
    return {
      format: "agent_space.object_schema.v1",
      exported_at: new Date().toISOString(),
      object_schema_version: versions.length > 0 ? Math.max(...versions) : 0,
      object_kinds: rows.rows.map((row) => objectKindManifestOut(row, hintsByKind.get(row.id) ?? [])),
      metadata: {
        object_kind_count: rows.rows.length,
        relation_hint_count: hints.rows.length,
        content_included: false,
        proposal_history_included: false,
      },
    };
  }

  async importObjectSchemaManifest(
    identity: SpaceUserIdentity,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const manifest = optionalObject(body.manifest);
    if (!manifest) throw new HttpError(422, "manifest is required");
    if (optionalString(manifest.format) !== "agent_space.object_schema.v1") {
      throw new HttpError(422, "unsupported object_schema manifest format");
    }
    const rawKinds = Array.isArray(manifest.object_kinds) ? manifest.object_kinds : [];
    if (rawKinds.length > 500) throw new HttpError(422, "object schema manifest has too many object kinds");
    const warnings: string[] = [];
    const skipped: Record<string, unknown>[] = [];
    const proposalIds: string[] = [];
    const seen = new Set<string>();

    for (const rawKind of rawKinds) {
      const kind = optionalObject(rawKind);
      if (!kind) {
        skipped.push({ reason: "invalid_kind_entry" });
        continue;
      }
      const key = objectKindKey(kind.key);
      const baseObjectType = objectKindBaseType(kind.base_object_type);
      assertObjectKindKeyMatchesBase(baseObjectType, key);
      const dedupeKey = `${baseObjectType}:${key}`;
      if (seen.has(dedupeKey)) {
        skipped.push({ key, base_object_type: baseObjectType, reason: "duplicate_in_manifest" });
        continue;
      }
      seen.add(dedupeKey);
      const existing = await this.getObjectKindByKeyAny(identity, baseObjectType, key);
      if (existing) {
        skipped.push({ key, base_object_type: baseObjectType, reason: "key_already_exists" });
        continue;
      }
      const relationHints = await this.objectSchemaManifestRelationHints(identity, kind, warnings, key);
      const proposal = await this.insertKnowledgeProposal(identity, {
        proposalType: "object_kind_create",
        title: `Import object kind draft: ${requiredString(kind.label, "label")}`,
        payload: objectKindProposalPayload("object_kind_create", {
          key,
          label: requiredString(kind.label, "label"),
          description: optionalString(kind.description),
          base_object_type: baseObjectType,
          status: "draft",
          field_schema: objectKindConfigInput(kind.field_schema, "field_schema"),
          extraction_policy: objectKindConfigInput(kind.extraction_policy, "extraction_policy"),
          retrieval_policy: objectKindConfigInput(kind.retrieval_policy, "retrieval_policy"),
          ui_config: objectKindConfigInput(kind.ui_config, "ui_config"),
          relation_hints: relationHints,
          import_metadata: {
            manifest_format: manifest.format,
            source_status: optionalString(kind.status),
            source_version: numberValue(kind.version),
          },
        }),
        rationale: optionalString(body.rationale) ?? "Object schema import requested.",
        workspaceId: null,
        projectId: null,
        riskLevel: "high",
      });
      proposalIds.push(proposal.id);
    }

    return {
      created_proposal_count: proposalIds.length,
      skipped_count: skipped.length,
      proposal_ids: proposalIds,
      skipped,
      warnings,
    };
  }

  async proposeObjectKindCreate(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<ProposalOut> {
    const key = objectKindKey(body.key);
    const baseObjectType = objectKindBaseType(body.base_object_type);
    assertObjectKindKeyMatchesBase(baseObjectType, key);
    const label = requiredString(body.label, "label");
    const status = optionalString(body.status) ?? "active";
    if (status !== "active" && status !== "draft") throw new HttpError(422, "object kind status must be active or draft");
    const relationHints = await this.normalizeObjectKindRelationHints(identity, body.relation_hints);
    return this.insertKnowledgeProposal(identity, {
      proposalType: "object_kind_create",
      title: `Create object kind: ${label}`,
      payload: objectKindProposalPayload("object_kind_create", {
        key,
        label,
        description: optionalString(body.description),
        base_object_type: baseObjectType,
        status,
        field_schema: objectKindConfigInput(body.field_schema, "field_schema"),
        extraction_policy: objectKindConfigInput(body.extraction_policy, "extraction_policy"),
        retrieval_policy: objectKindConfigInput(body.retrieval_policy, "retrieval_policy"),
        ui_config: objectKindConfigInput(body.ui_config, "ui_config"),
        relation_hints: relationHints,
      }),
      rationale: optionalString(body.rationale) ?? "Object kind creation requested.",
      workspaceId: null,
      projectId: null,
      riskLevel: "high",
    });
  }

  async proposeObjectKindUpdate(
    identity: SpaceUserIdentity,
    kindId: string,
    body: Record<string, unknown>,
  ): Promise<ProposalOut> {
    const current = await this.requireMutableObjectKind(identity, kindId);
    const payload: Record<string, unknown> = { target_kind_id: kindId };
    if ("label" in body) payload.label = requiredString(body.label, "label");
    if ("description" in body) payload.description = optionalString(body.description);
    if ("status" in body) {
      const status = objectKindActivationStatus(body.status);
      if (current.status !== "draft") throw new HttpError(422, "only draft object kinds can be activated");
      payload.status = status;
    }
    if ("field_schema" in body) payload.field_schema = objectKindConfigInput(body.field_schema, "field_schema");
    if ("extraction_policy" in body) payload.extraction_policy = objectKindConfigInput(body.extraction_policy, "extraction_policy");
    if ("retrieval_policy" in body) payload.retrieval_policy = objectKindConfigInput(body.retrieval_policy, "retrieval_policy");
    if ("ui_config" in body) payload.ui_config = objectKindConfigInput(body.ui_config, "ui_config");
    if ("relation_hints" in body) payload.relation_hints = await this.normalizeObjectKindRelationHints(identity, body.relation_hints);
    return this.insertKnowledgeProposal(identity, {
      proposalType: "object_kind_update",
      title: `Update object kind: ${current.label}`,
      payload: objectKindProposalPayload("object_kind_update", payload),
      rationale: optionalString(body.rationale) ?? "Object kind update requested.",
      workspaceId: null,
      projectId: null,
      riskLevel: "high",
    });
  }

  async proposeObjectKindDeprecate(
    identity: SpaceUserIdentity,
    kindId: string,
    body: Record<string, unknown> = {},
  ): Promise<ProposalOut> {
    const current = await this.requireMutableObjectKind(identity, kindId);
    return this.insertKnowledgeProposal(identity, {
      proposalType: "object_kind_deprecate",
      title: `Deprecate object kind: ${current.label}`,
      payload: objectKindProposalPayload("object_kind_deprecate", { target_kind_id: kindId }),
      rationale: optionalString(body.rationale) ?? "Object kind deprecation requested.",
      workspaceId: null,
      projectId: null,
      riskLevel: "high",
    });
  }

  async proposeObjectKindArchive(
    identity: SpaceUserIdentity,
    kindId: string,
    body: Record<string, unknown> = {},
  ): Promise<ProposalOut> {
    const current = await this.requireMutableObjectKind(identity, kindId);
    return this.insertKnowledgeProposal(identity, {
      proposalType: "object_kind_archive",
      title: `Archive object kind: ${current.label}`,
      payload: objectKindProposalPayload("object_kind_archive", { target_kind_id: kindId }),
      rationale: optionalString(body.rationale) ?? "Object kind archive requested.",
      workspaceId: null,
      projectId: null,
      riskLevel: "high",
    });
  }

  async listItems(identity: SpaceUserIdentity, filters: {
    knowledgeKind: string | null;
    status: string | null;
    visibility: string | null;
    projectId: string | null;
    workspaceId: string | null;
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
              r.relation_type, r.status, r.confidence, r.evidence_summary,
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
              r.relation_type, r.status, r.confidence, r.evidence_summary,
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
              r.relation_type, r.status, r.confidence, r.evidence_summary,
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
    for (const key of ["from_object_id", "to_object_id", "relation_type", "status", "source_claim_id", "source_object_id"]) {
      const value = optionalString(filters[key]);
      if (value) clauses.push(`r.${key} = ${add(value)}`);
    }
    const rows = await this.db.query<ObjectRelationRow>(
      `SELECT r.id, r.space_id,
              r.from_object_id, from_so.object_type AS from_object_type,
              r.to_object_id, to_so.object_type AS to_object_type,
              r.relation_type, r.status, r.confidence, r.evidence_summary,
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
    const objectKindValidation = await this.validateObjectKindProposalFields(identity, "claim", claimKind, body, {
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
      metadata: withObjectKindFieldMetadata(metadata, objectKindValidation.fields),
      ...objectKindValidationPayload(objectKindValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "claim_create",
      title: `Claim: ${title}`,
      payload,
      rationale: optionalString(body.rationale) ?? "Claim creation requested.",
      workspaceId: optionalString(body.workspace_id),
      projectId: optionalString(body.project_id),
    });
  }

  async proposeClaimUpdate(identity: SpaceUserIdentity, claimId: string, body: Record<string, unknown>): Promise<ProposalOut> {
    assertNoContentAccessUpdate(body);
    const claim = await this.getVisibleClaimRow(identity, claimId);
    if (!claim || !canMutateClaim(claim, identity.userId)) throw new HttpError(404, "Claim not found");
    const claimKind = optionalString(body.claim_kind);
    if (claimKind && !CLAIM_KINDS.has(claimKind)) throw new HttpError(422, "invalid claim_kind");
    const nextClaimKindForValidation = claimKind ?? claim.claim_kind;
    const objectKindValidation = await this.validateObjectKindProposalFields(identity, "claim", nextClaimKindForValidation, body, {
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
    if (objectKindValidation.fields) {
      metadata = withObjectKindFieldMetadata(metadata ?? optionalObject(claim.metadata_json) ?? {}, objectKindValidation.fields);
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
      ...objectKindValidationPayload(objectKindValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "claim_update",
      title: `Update claim: ${claim.title}`,
      payload,
      rationale: optionalString(body.rationale) ?? "Claim update requested.",
      workspaceId: claim.workspace_id,
      projectId: claim.primary_project_id,
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
      workspaceId: claim.workspace_id,
      projectId: claim.primary_project_id,
    });
  }

  async proposeObjectRelation(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<ProposalOut> {
    const fromObjectId = requiredString(body.from_object_id, "from_object_id");
    const toObjectId = requiredString(body.to_object_id, "to_object_id");
    if (fromObjectId === toObjectId) throw new HttpError(422, "object relation endpoints must differ");
    const relationType = requiredString(body.relation_type, "relation_type");
    if (!OBJECT_RELATION_TYPES.has(relationType)) throw new HttpError(422, "invalid relation_type");
    const status = optionalString(body.status) ?? "active";
    if (!RELATION_CREATE_STATUSES.has(status)) throw new HttpError(422, "invalid relation status");
    const fromObject = await this.requireVisibleSpaceObject(identity, fromObjectId, "Object relation endpoint not found");
    const toObject = await this.requireVisibleSpaceObject(identity, toObjectId, "Object relation endpoint not found");
    const sourceClaimId = optionalString(body.source_claim_id);
    if (sourceClaimId) {
      const sourceClaim = await this.getVisibleClaimRow(identity, sourceClaimId);
      if (!sourceClaim) throw new HttpError(404, "Object relation source claim not found");
    }
    const sourceObjectId = optionalString(body.source_object_id);
    if (sourceObjectId) await this.requireVisibleSpaceObject(identity, sourceObjectId, "Object relation source object not found");
    return this.insertKnowledgeProposal(identity, {
      proposalType: "object_relation_create",
      title: `Relate objects: ${fromObject.title} -> ${toObject.title}`,
      payload: {
        operation: "object_relation_create",
        from_object_id: fromObjectId,
        to_object_id: toObjectId,
        relation_type: relationType,
        status,
        confidence: confidence(body.confidence),
        evidence_summary: optionalString(body.evidence_summary),
        source_claim_id: sourceClaimId,
        source_object_id: sourceObjectId,
        metadata: optionalObject(body.metadata) ?? {},
      },
      rationale: optionalString(body.rationale) ?? "Object relation requested.",
      workspaceId: fromObject.workspace_id,
      projectId: fromObject.primary_project_id,
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
      workspaceId: fromObject.workspace_id,
      projectId: fromObject.primary_project_id,
    });
  }

  async proposeCreate(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<ProposalOut> {
    const knowledgeKind = requiredString(body.knowledge_kind ?? "concept", "knowledge_kind");
    if (!KNOWLEDGE_KINDS.has(knowledgeKind)) throw new HttpError(422, "invalid knowledge_kind");
    const objectKindValidation = await this.validateObjectKindProposalFields(identity, "knowledge_item", knowledgeKind, body, {
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
      ...objectKindValidationPayload(objectKindValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "knowledge_create",
      title: payload.title,
      payload,
      rationale: optionalString(body.rationale) ?? "Knowledge creation requested.",
      workspaceId: optionalString(body.workspace_id),
      projectId: optionalString(body.project_id),
    });
  }

  async proposeUpdate(identity: SpaceUserIdentity, itemId: string, body: Record<string, unknown>): Promise<ProposalOut> {
    assertNoContentAccessUpdate(body);
    const item = await this.getVisibleItemRow(identity, itemId);
    if (!item) throw new HttpError(404, "Knowledge item not found");
    if (!canMutateKnowledge(item, identity.userId)) throw new HttpError(404, "Knowledge item not found");
    const objectKindValidation = await this.validateObjectKindProposalFields(identity, "knowledge_item", item.knowledge_kind, body, {
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
      ...objectKindValidationPayload(objectKindValidation),
    };
    return this.insertKnowledgeProposal(identity, {
      proposalType: "knowledge_update",
      title: `Update: ${payload.title}`,
      payload,
      rationale: optionalString(body.rationale) ?? "Knowledge update requested.",
      workspaceId: item.workspace_id,
      projectId: item.project_id,
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
      workspaceId: item.workspace_id,
      projectId: item.project_id,
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
    if (filters.status) clauses.push(`so.status = ${add(filters.status)}`);
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
    const result = await this.db.query<SourceRow>(
      `WITH obj AS (
         INSERT INTO space_objects (
           id, space_id, object_type, title, summary, status, visibility,
           owner_user_id, created_by_user_id, created_at, updated_at
         ) VALUES (
           $1, $2, 'source', $3, $4, $5, 'space_shared',
           $6, $6, $7, $7
         )
       ), src AS (
         INSERT INTO sources (
           object_id, space_id, source_type, uri, content_ref, raw_text, summary,
           metadata_json, source_activity_id
         ) VALUES (
           $1, $2, $8, $9, $10, $11, $4,
           $12::jsonb, $13
         )
       )
       SELECT ${SOURCE_COLUMNS}
         FROM ${SOURCE_FROM}
        WHERE s.object_id = $1 AND s.space_id = $2`,
      [
        objectId,
        identity.spaceId,
        requiredString(body.title, "title"),
        optionalString(body.summary),
        status,
        identity.userId,
        now,
        sourceType,
        optionalString(body.uri),
        optionalString(body.content_ref),
        optionalString(body.raw_text),
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
                status = COALESCE($14, status),
                updated_at = $15
          WHERE id = $1 AND space_id = $2 AND object_type = 'source'
          RETURNING id
       ), src AS (
         UPDATE sources
            SET uri = CASE WHEN $4::boolean THEN $5 ELSE uri END,
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
        optionalString(body.relation_type) ?? "derived_from",
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
    q: string | null;
    limit: number;
    offset: number;
  }): Promise<Record<string, unknown>> {
    const built = buildNoteWhere(identity, filters);
    const total = await this.db.query<{ total: string }>(
      `SELECT count(DISTINCT n.object_id)::text AS total
         FROM ${NOTE_FROM}
         LEFT JOIN note_collection_items nci_filter
           ON nci_filter.note_id = n.object_id
          AND nci_filter.space_id = n.space_id
        ${built.where}`,
      built.params,
    );
    const rows = await this.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS}
         FROM ${NOTE_FROM}
         LEFT JOIN LATERAL (
           SELECT nci.collection_id, nci.sort_order
             FROM note_collection_items nci
            WHERE nci.note_id = n.object_id
              AND nci.space_id = n.space_id
            ORDER BY nci.created_at ASC
            LIMIT 1
         ) first_collection ON true
         LEFT JOIN note_collection_items nci_filter
           ON nci_filter.note_id = n.object_id
          AND nci_filter.space_id = n.space_id
        ${built.where}
        ORDER BY ${filters.collectionId ? "nci_filter.sort_order ASC," : ""} so.updated_at DESC, n.object_id DESC
        LIMIT $${built.params.length + 1} OFFSET $${built.params.length + 2}`,
      [...built.params, filters.limit, filters.offset],
    );
    return page(rows.rows.map(noteSummaryOut), countFromRow(total.rows[0]), filters.limit, filters.offset);
  }

  async listNoteCollections(identity: SpaceUserIdentity): Promise<Record<string, unknown>[]> {
    const rows = await this.db.query<NoteCollectionRow>(
      `SELECT ${NOTE_COLLECTION_COLUMNS}
         FROM note_collections
        WHERE space_id = $1
        ORDER BY sort_order ASC, created_at ASC, id ASC`,
      [identity.spaceId],
    );
    return rows.rows.map(noteCollectionOut);
  }

  async createNoteCollection(
    identity: SpaceUserIdentity,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parentId = optionalString(body.parent_id);
    if (parentId) await this.requireNoteCollection(identity, parentId);
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

  async deleteNoteCollection(identity: SpaceUserIdentity, collectionId: string): Promise<void> {
    const current = await this.getNoteCollectionRow(identity, collectionId);
    if (!current) throw new HttpError(404, "Note collection not found");
    if (current.is_system) throw new HttpError(422, "System note collections cannot be deleted");
    await this.db.query(
      `DELETE FROM note_collections WHERE id = $1 AND space_id = $2`,
      [collectionId, identity.spaceId],
    );
  }

  async getNote(identity: SpaceUserIdentity, noteId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getNoteRow(identity, noteId);
    return row ? noteOut(row) : null;
  }

  async createNote(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    const plainText = optionalString(body.plain_text);
    const objectId = randomUUID();
    const result = await this.db.query<{ id: string }>(
      `WITH obj AS (
         INSERT INTO space_objects (
           id, space_id, object_type, title, summary, status, visibility,
           owner_user_id, primary_project_id, created_by_user_id,
           created_at, updated_at
         ) VALUES (
           $1, $2, 'note', $3, $4, 'active', 'space_shared',
           $5, $6, $5,
           $7, $7
         )
       ), note AS (
         INSERT INTO notes (
           object_id, space_id, content_json, content_format, content_schema_version,
           plain_text, created_from_activity_id, version, content_hash
         ) VALUES (
           $1, $2, $8::jsonb, $9, COALESCE($10::int, 1),
           $11, $12, 1, $13
         )
       )
       SELECT $1::varchar AS id`,
      [
        objectId,
        identity.spaceId,
        requiredString(body.title, "title"),
        optionalString(body.excerpt) ?? (plainText ? plainText.slice(0, 280) : null),
        identity.userId,
        optionalString(body.primary_project_id),
        now,
        JSON.stringify(optionalObject(body.content_json)),
        optionalString(body.content_format) ?? "markdown",
        numberValue(body.content_schema_version),
        plainText,
        optionalString(body.created_from_activity_id),
        sha256(plainText ?? ""),
      ],
    );
    const note = result.rows[0]!;
    await insertInitialNoteRevision(this.db, {
      spaceId: identity.spaceId,
      noteId: note.id,
      doc: optionalObject(body.content_json) ?? {},
      at: now,
      userId: identity.userId,
    });
    const collectionId = optionalString(body.collection_id);
    if (collectionId) await this.addNoteToCollection(identity, note.id, collectionId);
    await this.safeReindex((p) => p.reindex(identity.spaceId, "note", note.id));
    return (await this.getNote(identity, note.id))!;
  }

  async updateNote(identity: SpaceUserIdentity, noteId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    const now = new Date().toISOString();
    const status = optionalString(body.status);
    if (status && !NOTE_STATUSES.has(status)) throw new HttpError(422, "invalid note status");
    await this.db.query(
      `WITH obj AS (
         UPDATE space_objects
            SET title = COALESCE($3, title),
                summary = CASE WHEN $6::boolean THEN $7 ELSE summary END,
                status = COALESCE($8::varchar(32), status),
                primary_project_id = CASE WHEN $9::boolean THEN $10 ELSE primary_project_id END,
                archived_at = CASE WHEN $8::varchar(32) = 'archived' THEN $11::timestamptz ELSE archived_at END,
                deleted_at = CASE WHEN $8::varchar(32) = 'deleted' THEN $11::timestamptz ELSE deleted_at END,
                updated_at = $11
          WHERE id = $1 AND space_id = $2 AND object_type = 'note'
          RETURNING id
       )
       UPDATE notes
          SET content_format = COALESCE($4, content_format),
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
    // Content changes go through the versioned writer so every save (not
    // just AI-driven ones) produces a note_revisions row and an incrementing
    // version — see .agent knowledge-base notes-vs-AI-co-edit unification.
    if (Object.hasOwn(body, "content_json")) {
      const plainText = Object.hasOwn(body, "plain_text") ? optionalString(body.plain_text) ?? "" : undefined;
      const result = await writeNote(this.db, {
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
    if (collectionId) await this.addNoteToCollection(identity, noteId, collectionId);
    await this.safeReindex((p) => p.reindex(identity.spaceId, "note", noteId));
    return (await this.getNote(identity, noteId))!;
  }

  async listNoteRevisions(identity: SpaceUserIdentity, noteId: string, limit?: number): Promise<Array<Record<string, unknown>>> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    return listNoteRevisionRows(this.db, { spaceId: identity.spaceId, noteId, limit });
  }

  async rollbackNote(identity: SpaceUserIdentity, noteId: string, toVersion: number): Promise<Record<string, unknown>> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    await rollbackNoteContent(this.db, { spaceId: identity.spaceId, noteId, toVersion, userId: identity.userId });
    await this.safeReindex((p) => p.reindex(identity.spaceId, "note", noteId));
    return (await this.getNote(identity, noteId))!;
  }

  async deleteNote(identity: SpaceUserIdentity, noteId: string): Promise<Record<string, unknown>> {
    return this.updateNote(identity, noteId, { status: "deleted" });
  }

  async purgeDeletedNotes(identity: SpaceUserIdentity): Promise<Record<string, unknown>> {
    const result = await this.db.query<{ deleted: string }>(
      `DELETE FROM space_objects
        WHERE space_id = $1 AND object_type = 'note' AND status = 'deleted'
        RETURNING id`,
      [identity.spaceId],
    );
    return { deleted: result.rowCount ?? result.rows.length, retention_days: 30 };
  }

  async noteLinks(identity: SpaceUserIdentity, noteId: string, backlinks = false): Promise<Record<string, unknown>[]> {
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
    const rows = await this.db.query<NoteLinkRow>(
      `SELECT nl.id, nl.space_id,
              nl.from_object_id, from_so.object_type AS from_object_type,
              nl.to_object_id, to_so.object_type AS to_object_type,
              nl.link_type AS relation_type, nl.status, nl.confidence,
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
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
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
    if (!RELATION_TYPES.has(linkType) && !OBJECT_RELATION_TYPES.has(linkType)) {
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
                 link_type AS relation_type, status, confidence,
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
    if (!(await this.getNoteRow(identity, noteId))) throw new HttpError(404, "Note not found");
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
      workspaceId: string | null;
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
    if (filters.status) clauses.push(`so.status = ${add(filters.status)}`);
    if (filters.visibility) {
      clauses.push(contentVisibilityParamFilterSql("so", add(filters.visibility)));
    }
    if (filters.projectId) clauses.push(`so.primary_project_id = ${add(filters.projectId)}`);
    if (filters.workspaceId) clauses.push(`so.workspace_id = ${add(filters.workspaceId)}`);
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
    if (filters.status) clauses.push(`so.status = ${add(filters.status)}`);
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
        WHERE space_id = $1
          AND r.to_object_id = $2
          AND r.relation_type = 'supersedes'
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

  private async getObjectKindRow(identity: SpaceUserIdentity, kindId: string): Promise<SpaceObjectKindRow | null> {
    const result = await this.db.query<SpaceObjectKindRow>(
      `SELECT ${OBJECT_KIND_COLUMNS}
         FROM space_object_kinds
        WHERE id = $1 AND space_id = $2`,
      [kindId, identity.spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async loadObjectKindRelationHints(
    spaceId: string,
    kindIds: readonly string[],
  ): Promise<Map<string, SpaceObjectKindRelationHintRow[]>> {
    const out = new Map<string, SpaceObjectKindRelationHintRow[]>();
    if (kindIds.length === 0) return out;
    const hints = await this.db.query<SpaceObjectKindRelationHintRow>(
      `SELECT h.id,
              h.object_kind_id,
              h.endpoint_object_type,
              h.endpoint_object_kind_id,
              endpoint_kind.key AS endpoint_object_kind_key,
              h.relation_type,
              h.direction,
              h.confidence_default,
              h.required
         FROM space_object_kind_relation_hints h
         LEFT JOIN space_object_kinds endpoint_kind
           ON endpoint_kind.id = h.endpoint_object_kind_id
          AND endpoint_kind.space_id = h.space_id
        WHERE h.space_id = $1
          AND h.object_kind_id = ANY($2::varchar[])
        ORDER BY h.object_kind_id ASC, h.required DESC, h.relation_type ASC, h.id ASC`,
      [spaceId, kindIds],
    );
    for (const hint of hints.rows) {
      const arr = out.get(hint.object_kind_id) ?? [];
      arr.push(hint);
      out.set(hint.object_kind_id, arr);
    }
    return out;
  }

  private async getObjectKindByKeyAny(
    identity: SpaceUserIdentity,
    baseObjectType: string,
    key: string,
  ): Promise<SpaceObjectKindRow | null> {
    const result = await this.db.query<SpaceObjectKindRow>(
      `SELECT ${OBJECT_KIND_COLUMNS}
         FROM space_object_kinds
        WHERE space_id = $1
          AND base_object_type = $2
          AND key = $3
        LIMIT 1`,
      [identity.spaceId, baseObjectType, key],
    );
    return result.rows[0] ?? null;
  }

  private async requireObjectKind(identity: SpaceUserIdentity, kindId: string): Promise<SpaceObjectKindRow> {
    const row = await this.getObjectKindRow(identity, kindId);
    if (!row) throw new HttpError(404, "Object kind not found");
    return row;
  }

  private async requireMutableObjectKind(identity: SpaceUserIdentity, kindId: string): Promise<SpaceObjectKindRow> {
    const row = await this.requireObjectKind(identity, kindId);
    if (row.status === "archived") throw new HttpError(422, "archived object kinds cannot be changed");
    return row;
  }

  private async getActiveObjectKindByKey(
    identity: SpaceUserIdentity,
    baseObjectType: string,
    key: string,
  ): Promise<SpaceObjectKindRow | null> {
    const result = await this.db.query<SpaceObjectKindRow>(
      `SELECT ${OBJECT_KIND_COLUMNS}
         FROM space_object_kinds
        WHERE space_id = $1
          AND base_object_type = $2
          AND key = $3
          AND status = 'active'
        LIMIT 1`,
      [identity.spaceId, baseObjectType, key],
    );
    return result.rows[0] ?? null;
  }

  private async validateObjectKindProposalFields(
    identity: SpaceUserIdentity,
    baseObjectType: string,
    key: string,
    body: Record<string, unknown>,
    options: { validateWhenFieldsAbsent: boolean },
  ): Promise<ObjectKindProposalFieldValidation> {
    const row = await this.getActiveObjectKindByKey(identity, baseObjectType, key);
    if (!row) return {};
    const fields = objectKindFieldValuesInput(body, options.validateWhenFieldsAbsent);
    if (!fields) return {};
    const result = validateObjectKindFieldSchema(row.field_schema_json, fields);
    const validation = {
      object_kind_id: row.id,
      object_kind: row.key,
      object_kind_label: row.label,
      enforcement: result.enforcement,
      ok: result.errors.length === 0,
      errors: result.errors,
      warnings: result.enforcement === "strict" ? [] : result.errors,
    };
    if (result.enforcement === "strict" && result.errors.length > 0) {
      throw new HttpError(422, `object_kind_fields invalid: ${result.errors.join("; ")}`);
    }
    return { fields, validation };
  }

  private async normalizeObjectKindRelationHints(
    identity: SpaceUserIdentity,
    rawHints: unknown,
  ): Promise<Record<string, unknown>[]> {
    if (rawHints === undefined || rawHints === null) return [];
    if (!Array.isArray(rawHints)) throw new HttpError(422, "relation_hints must be an array");
    if (rawHints.length > 50) throw new HttpError(422, "relation_hints can include at most 50 entries");
    const hints: Record<string, unknown>[] = [];
    for (const rawHint of rawHints) {
      const hint = optionalObject(rawHint);
      if (!hint) throw new HttpError(422, "relation_hints entries must be JSON objects");
      const endpointObjectType = objectKindBaseType(hint.endpoint_object_type);
      const relationType = requiredString(hint.relation_type, "relation_type");
      if (!RELATION_TYPES.has(relationType) && !OBJECT_RELATION_TYPES.has(relationType)) {
        throw new HttpError(422, "invalid relation_hints relation_type");
      }
      const direction = optionalString(hint.direction) ?? "from";
      if (direction !== "from" && direction !== "to" && direction !== "either") {
        throw new HttpError(422, "invalid relation_hints direction");
      }
      const confidenceDefault = numberValue(hint.confidence_default) ?? 0.55;
      if (confidenceDefault < 0 || confidenceDefault > 1) {
        throw new HttpError(422, "relation_hints confidence_default must be between 0 and 1");
      }
      const endpointObjectKindId = optionalString(hint.endpoint_object_kind_id);
      if (endpointObjectKindId) {
        const endpointKind = await this.getObjectKindRow(identity, endpointObjectKindId);
        if (!endpointKind) throw new HttpError(404, "Relation hint endpoint object kind not found");
        if (endpointKind.status === "archived") throw new HttpError(422, "Relation hint endpoint object kind is archived");
        if (endpointKind.base_object_type !== endpointObjectType) {
          throw new HttpError(422, "relation_hints endpoint_object_kind_id must match endpoint_object_type");
        }
      }
      hints.push({
        endpoint_object_type: endpointObjectType,
        endpoint_object_kind_id: endpointObjectKindId,
        relation_type: relationType,
        direction,
        confidence_default: confidenceDefault,
        required: hint.required === true,
      });
    }
    return hints;
  }

  private async objectSchemaManifestRelationHints(
    identity: SpaceUserIdentity,
    kind: Record<string, unknown>,
    warnings: string[],
    sourceKindKey: string,
  ): Promise<Record<string, unknown>[]> {
    const rawHints = Array.isArray(kind.relation_hints) ? kind.relation_hints : [];
    const converted: Record<string, unknown>[] = [];
    for (const rawHint of rawHints) {
      const hint = optionalObject(rawHint);
      if (!hint) continue;
      const endpointObjectType = objectKindBaseType(hint.endpoint_object_type);
      const endpointObjectKindKey = optionalString(hint.endpoint_object_kind_key);
      let endpointObjectKindId: string | null = null;
      if (endpointObjectKindKey) {
        const endpointKind = await this.getObjectKindByKeyAny(identity, endpointObjectType, endpointObjectKindKey);
        if (endpointKind && endpointKind.status !== "archived") {
          endpointObjectKindId = endpointKind.id;
        } else {
          warnings.push(
            `relation hint on ${sourceKindKey} references unresolved endpoint kind ${endpointObjectType}:${endpointObjectKindKey}; imported as object-type-only hint`,
          );
        }
      }
      converted.push({
        endpoint_object_type: endpointObjectType,
        endpoint_object_kind_id: endpointObjectKindId,
        relation_type: hint.relation_type,
        direction: hint.direction,
        confidence_default: hint.confidence_default,
        required: hint.required,
      });
    }
    return this.normalizeObjectKindRelationHints(identity, converted);
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

  private async getSourceRow(identity: SpaceUserIdentity, sourceId: string): Promise<SourceRow | null> {
    const result = await this.db.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS}
         FROM ${SOURCE_FROM}
        WHERE s.object_id = $1 AND s.space_id = $2`,
      [sourceId, identity.spaceId],
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
      `SELECT id, space_id, object_type, title, status, visibility,
              owner_user_id, primary_project_id, workspace_id, created_by_user_id
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
      if (sourceObjectId) await this.requireVisibleSpaceObject(identity, sourceObjectId, "Claim source object not found");
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

  private async getNoteRow(identity: SpaceUserIdentity, noteId: string): Promise<NoteRow | null> {
    const result = await this.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS}
         FROM ${NOTE_FROM}
         LEFT JOIN LATERAL (
           SELECT nci.collection_id, nci.sort_order
             FROM note_collection_items nci
            WHERE nci.note_id = n.object_id
              AND nci.space_id = n.space_id
            ORDER BY nci.created_at ASC
            LIMIT 1
         ) first_collection ON true
        WHERE n.object_id = $1 AND n.space_id = $2`,
      [noteId, identity.spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async getNoteCollectionRow(
    identity: SpaceUserIdentity,
    collectionId: string,
  ): Promise<NoteCollectionRow | null> {
    const result = await this.db.query<NoteCollectionRow>(
      `SELECT ${NOTE_COLLECTION_COLUMNS}
         FROM note_collections
        WHERE id = $1 AND space_id = $2
        LIMIT 1`,
      [collectionId, identity.spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async requireNoteCollection(identity: SpaceUserIdentity, collectionId: string): Promise<void> {
    if (!(await this.getNoteCollectionRow(identity, collectionId))) {
      throw new HttpError(404, "Note collection not found");
    }
  }

  private async addNoteToCollection(identity: SpaceUserIdentity, noteId: string, collectionId: string): Promise<void> {
    const exists = await this.db.query<{ id: string }>(
      `SELECT id FROM note_collections WHERE id = $1 AND space_id = $2`,
      [collectionId, identity.spaceId],
    );
    if (!exists.rows[0]) throw new HttpError(404, "Note collection not found");
    await this.db.query(`DELETE FROM note_collection_items WHERE note_id = $1 AND space_id = $2`, [noteId, identity.spaceId]);
    // Default: append after this collection's existing notes, so a moved-in
    // note doesn't silently jump to the front of an already-ordered folder.
    const sortOrder = await this.nextNoteSortOrder(identity.spaceId, collectionId);
    await this.db.query(
      `INSERT INTO note_collection_items (id, space_id, collection_id, note_id, sort_order, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), identity.spaceId, collectionId, noteId, sortOrder, new Date().toISOString()],
    );
  }

  private async nextNoteSortOrder(spaceId: string, collectionId: string): Promise<number> {
    const result = await this.db.query<{ next_sort_order: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order FROM note_collection_items WHERE space_id=$1 AND collection_id=$2`,
      [spaceId, collectionId],
    );
    return Number(result.rows[0]?.next_sort_order ?? 0);
  }

  private async insertKnowledgeProposal(inputIdentity: SpaceUserIdentity, input: {
    proposalType: string;
    title: string;
    payload: Record<string, unknown>;
    rationale: string;
    workspaceId: string | null;
    projectId: string | null;
    riskLevel?: "low" | "medium" | "high" | "critical";
  }): Promise<ProposalOut> {
    const now = new Date();
    const row = await insertProposalRow(this.db, {
      spaceId: inputIdentity.spaceId,
      proposalType: input.proposalType,
      title: input.title,
      payload: input.payload,
      rationale: input.rationale,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      createdByUserId: inputIdentity.userId,
      visibility: "space_shared",
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
    q: string | null;
  },
): { where: string; params: unknown[] } {
  const params: unknown[] = [identity.spaceId];
  const clauses = ["n.space_id = $1"];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  clauses.push(filters.status ? `so.status = ${add(filters.status)}` : "so.status <> 'deleted'");
  if (filters.projectId) clauses.push(`so.primary_project_id = ${add(filters.projectId)}`);
  if (filters.collectionId) clauses.push(`nci_filter.collection_id = ${add(filters.collectionId)}`);
  if (filters.q) clauses.push(`(so.title ILIKE ${add(`%${filters.q}%`)} OR n.plain_text ILIKE $${params.length})`);
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

interface ObjectKindProposalFieldValidation {
  fields?: Record<string, unknown>;
  validation?: Record<string, unknown>;
}

interface ParsedObjectKindField {
  key: string;
  type: string | null;
  required: boolean;
  minLength: number | null;
  maxLength: number | null;
  min: number | null;
  max: number | null;
  values: string[] | null;
}

function objectKindFieldValuesInput(
  body: Record<string, unknown>,
  validateWhenFieldsAbsent: boolean,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(body, "object_kind_fields")) {
    return validateWhenFieldsAbsent ? {} : undefined;
  }
  const record = optionalObject(body.object_kind_fields);
  if (!record) throw new HttpError(422, "object_kind_fields must be a JSON object");
  return record;
}

function objectKindValidationPayload(input: ObjectKindProposalFieldValidation): Record<string, unknown> {
  return {
    ...(input.fields ? { object_kind_fields: input.fields } : {}),
    ...(input.validation ? { object_kind_validation: input.validation } : {}),
  };
}

function withObjectKindFieldMetadata(
  metadata: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fields) return metadata;
  return { ...metadata, object_kind_fields: fields };
}

function validateObjectKindFieldSchema(
  fieldSchema: unknown,
  values: Record<string, unknown>,
): { enforcement: "advisory" | "strict"; errors: string[] } {
  const schema = optionalObject(fieldSchema) ?? {};
  const enforcement = objectKindSchemaEnforcement(schema);
  const fields = parseObjectKindFields(schema);
  const errors: string[] = [];

  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) errors.push(`${field.key} is required`);
      continue;
    }
    const typeError = objectKindFieldTypeError(field, value);
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

function objectKindSchemaEnforcement(schema: Record<string, unknown>): "advisory" | "strict" {
  const raw = optionalString(schema.enforcement)
    ?? optionalString(schema.validation_mode)
    ?? optionalString(schema.mode);
  return raw === "strict" || raw === "enforced" || raw === "required" ? "strict" : "advisory";
}

function parseObjectKindFields(schema: Record<string, unknown>): ParsedObjectKindField[] {
  const required = new Set(stringArray(schema.required));
  const fields: ParsedObjectKindField[] = [];
  const seen = new Set<string>();
  const addField = (key: string, config: Record<string, unknown>) => {
    if (!OBJECT_KIND_KEY_PATTERN.test(key) || seen.has(key)) return;
    seen.add(key);
    fields.push({
      key,
      type: objectKindFieldType(config),
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

function objectKindFieldType(config: Record<string, unknown>): string | null {
  const type = optionalString(config.type);
  if (!type) return null;
  const normalized = type.toLowerCase();
  return ["string", "number", "integer", "boolean", "array", "object"].includes(normalized)
    ? normalized
    : null;
}

function objectKindFieldTypeError(field: ParsedObjectKindField, value: unknown): string | null {
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

function objectKindOut(
  row: SpaceObjectKindRow,
  relationHints: readonly SpaceObjectKindRelationHintRow[] = [],
): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    key: row.key,
    label: row.label,
    description: row.description,
    base_object_type: row.base_object_type,
    status: row.status,
    version: numberValue(row.version) ?? 1,
    field_schema: optionalObject(row.field_schema_json) ?? {},
    extraction_policy: optionalObject(row.extraction_policy_json) ?? {},
    retrieval_policy: optionalObject(row.retrieval_policy_json) ?? {},
    ui_config: optionalObject(row.ui_config_json) ?? {},
    relation_hints: relationHints.map((hint) => ({
      id: hint.id,
      endpoint_object_type: hint.endpoint_object_type,
      endpoint_object_kind_id: hint.endpoint_object_kind_id,
      relation_type: hint.relation_type,
      direction: hint.direction,
      confidence_default: numberValue(hint.confidence_default) ?? 0.55,
      required: hint.required === true,
    })),
    created_by_user_id: row.created_by_user_id,
    created_from_proposal_id: row.created_from_proposal_id,
    updated_from_proposal_id: row.updated_from_proposal_id,
    created_at: row.created_at ? dateIso(row.created_at) : new Date(0).toISOString(),
    updated_at: row.updated_at ? dateIso(row.updated_at) : new Date(0).toISOString(),
  };
}

function objectKindManifestOut(
  row: SpaceObjectKindRow,
  hints: readonly SpaceObjectKindRelationHintRow[],
): Record<string, unknown> {
  return {
    key: row.key,
    label: row.label,
    description: row.description,
    base_object_type: row.base_object_type,
    status: row.status,
    version: numberValue(row.version) ?? 1,
    field_schema: optionalObject(row.field_schema_json) ?? {},
    extraction_policy: optionalObject(row.extraction_policy_json) ?? {},
    retrieval_policy: optionalObject(row.retrieval_policy_json) ?? {},
    ui_config: optionalObject(row.ui_config_json) ?? {},
    relation_hints: hints.map((hint) => ({
      endpoint_object_type: hint.endpoint_object_type,
      endpoint_object_kind_key: hint.endpoint_object_kind_key,
      relation_type: hint.relation_type,
      direction: hint.direction,
      confidence_default: numberValue(hint.confidence_default) ?? 0.55,
      required: hint.required === true,
    })),
  };
}

function objectKindProposalPayload(operation: string, values: Record<string, unknown>): Record<string, unknown> {
  return {
    operation,
    target_scope: "object_schema",
    target_namespace: "object_schema.object_kinds",
    proposed_content: objectKindProposedContent(operation, values),
    ...values,
  };
}

function objectKindProposedContent(operation: string, values: Record<string, unknown>): string {
  const label = optionalString(values.label);
  const key = optionalString(values.key);
  const target = optionalString(values.target_kind_id);
  if (label && key) return `${operation}: ${label} (${key})`;
  if (label || key) return `${operation}: ${label ?? key}`;
  return `${operation}: ${target ?? "object kind"}`;
}

function objectKindKey(value: unknown): string {
  const key = requiredString(value, "key");
  if (!OBJECT_KIND_KEY_PATTERN.test(key)) {
    throw new HttpError(422, "object kind key must be lowercase letters, numbers, or underscores and start with a letter");
  }
  return key;
}

function objectKindBaseType(value: unknown): string {
  const baseObjectType = requiredString(value, "base_object_type");
  if (!OBJECT_KIND_BASE_TYPES.has(baseObjectType)) throw new HttpError(422, "invalid base_object_type");
  return baseObjectType;
}

function assertObjectKindKeyMatchesBase(baseObjectType: string, key: string): void {
  const allowed = allowedObjectKindKeys(baseObjectType);
  if (!allowed?.includes(key)) {
    throw new HttpError(
      422,
      `object kind key must match the canonical ${baseObjectType} subtype (${allowed?.join(", ") ?? "none"})`,
    );
  }
}

function objectKindActivationStatus(value: unknown): "active" {
  const status = requiredString(value, "status");
  if (status !== "active") throw new HttpError(422, "object kind update status can only be active");
  return status;
}

function objectRelationAsKnowledgeRelationOut(row: ObjectRelationRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    from_item_id: row.from_object_id,
    to_item_id: row.to_object_id,
    relation_type: row.relation_type,
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
    relation_type: row.relation_type,
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
    link_type: row.relation_type,
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
    link_type: row.relation_type,
    confidence: row.confidence,
    status: row.status,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at),
  };
}

function objectKindConfigInput(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const record = optionalObject(value);
  if (!record) throw new HttpError(422, `${field} must be a JSON object`);
  let serialized = "";
  try {
    serialized = JSON.stringify(record);
  } catch {
    throw new HttpError(422, `${field} must be JSON serializable`);
  }
  if (serialized.length > 16_000) throw new HttpError(422, `${field} is too large`);
  const violation = objectKindConfigViolation(record, field, 0);
  if (violation) throw new HttpError(422, violation);
  return record;
}

function objectKindConfigViolation(value: unknown, path: string, depth: number): string | null {
  if (depth > 8) return `${path} is too deeply nested`;
  if (Array.isArray(value)) {
    if (value.length > 200) return `${path} has too many array entries`;
    for (let index = 0; index < value.length; index += 1) {
      const violation = objectKindConfigViolation(value[index], `${path}[${index}]`, depth + 1);
      if (violation) return violation;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (unsafeObjectKindConfigKey(key)) {
      return `${path}.${key} is not allowed in object schema config`;
    }
    const violation = objectKindConfigViolation(entry, `${path}.${key}`, depth + 1);
    if (violation) return violation;
  }
  return null;
}

function unsafeObjectKindConfigKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => UNSAFE_OBJECT_KIND_CONFIG_KEY_TOKENS.has(token));
}

function assertNoContentAccessUpdate(body: Record<string, unknown>): void {
  if (body.visibility !== undefined || body.access_level !== undefined || body.grants !== undefined) {
    throw new HttpError(422, "Use the content-access API to update Knowledge permissions");
  }
}

function titleFromClaimText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}

function hashClaimText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

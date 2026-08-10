import type { Queryable, SpaceUserIdentity } from "../routeUtils/common";
import { HttpError, confidence, countFromRow, numberValue, optionalObject, optionalString, page, requiredString } from "../routeUtils/common";
import { retrievableEntityTypes } from "./entities";
import { allowedObjectProfileKeys } from "./objectProfileSubtypeKeys";

const OBJECT_PROFILE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RELATION_CREATE_STATUSES = new Set(["candidate", "active"]);
import { assertLinkTypeAllowed } from "./validation";
import { hasDeclaration } from "./linkTypes";

/**
 * Ontology-owned reads and proposal writes: object profiles, their relation
 * hints, the object-schema export, and object relations.
 *
 * These lived on `PgKnowledgeRepository` because `knowledge` was the ontology's
 * de-facto owner (ADR 0012 decision 3). Two collaborators stay behind rather
 * than being duplicated: proposal creation is shared with governed Knowledge
 * writes, and Claim lookup is Knowledge's own. They are passed in as an
 * explicit seam so the dependency direction is visible instead of implied.
 */
/**
 * What a proposal-creating seam is handed. Stated here rather than typed as a
 * bag so a mismatch between this module and its host is a compile error: the
 * seams were originally cast through `as never`, which would have accepted a
 * transposed argument or a changed return silently.
 */
export interface OntologyProposalInput {
  proposalType: string;
  title: string;
  payload: Record<string, unknown>;
  rationale: string;
  projectFolderId: string | null;
  projectId: string | null;
  visibility: "private" | "space_shared" | "selected_users";
  riskLevel?: "low" | "medium" | "high" | "critical";
}

function normalizedContentVisibility(value: string): "private" | "space_shared" | "selected_users" {
  if (value === "private" || value === "space_shared" || value === "selected_users") return value;
  throw new Error(`Invalid persisted content visibility: ${value}`);
}

/** The only fields this module reads off an endpoint object. */
export interface OntologyObjectRef {
  object_type: string;
  title: string | null;
  project_folder_id: string | null;
  primary_project_id: string | null;
  visibility: string;
}

export interface OntologyRepositorySeams {
  insertProposal: (identity: SpaceUserIdentity, input: OntologyProposalInput) => Promise<Record<string, unknown>>;
  /** Existence and visibility only — the row's shape belongs to its own module. */
  getVisibleClaimRow: (identity: SpaceUserIdentity, claimId: string) => Promise<object | null>;
  requireVisibleSpaceObject: (
    identity: SpaceUserIdentity,
    objectId: string,
    message: string,
  ) => Promise<OntologyObjectRef>;
}

export const OBJECT_PROFILE_COLUMNS = `
  id, space_id, key, label, description, base_object_type, status, version,
  field_schema_json, extraction_policy_json, retrieval_policy_json, ui_config_json,
  created_by_user_id, created_from_proposal_id, updated_from_proposal_id,
  created_at, updated_at
`;

export interface SpaceObjectProfileRow {
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

interface SpaceObjectProfileRelationHintRow {
  id: string;
  object_profile_id: string;
  endpoint_object_type: string;
  endpoint_object_profile_id: string | null;
  endpoint_object_profile_key: string | null;
  link_type: string;
  direction: string;
  confidence_default: number | string;
  required: boolean;
}

function objectProfileProposalPayload(operation: string, values: Record<string, unknown>): Record<string, unknown> {
  return {
    operation,
    target_scope: "object_schema",
    target_namespace: "object_schema.object_profiles",
    proposed_content: objectProfileProposedContent(operation, values),
    ...values,
  };
}

function objectProfileConfigInput(value: unknown, field: string): Record<string, unknown> {
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
  const violation = objectProfileConfigViolation(record, field, 0);
  if (violation) throw new HttpError(422, violation);
  return record;
}

function objectProfileOut(
  row: SpaceObjectProfileRow,
  relationHints: readonly SpaceObjectProfileRelationHintRow[] = [],
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
      endpoint_object_profile_id: hint.endpoint_object_profile_id,
      link_type: hint.link_type,
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

function objectProfileBaseType(value: unknown): string {
  const baseObjectType = requiredString(value, "base_object_type");
  if (!OBJECT_PROFILE_BASE_TYPES.has(baseObjectType)) throw new HttpError(422, "invalid base_object_type");
  return baseObjectType;
}

function objectProfileProposedContent(operation: string, values: Record<string, unknown>): string {
  const label = optionalString(values.label);
  const key = optionalString(values.key);
  const target = optionalString(values.target_profile_id);
  if (label && key) return `${operation}: ${label} (${key})`;
  if (label || key) return `${operation}: ${label ?? key}`;
  return `${operation}: ${target ?? "object kind"}`;
}

function objectProfileConfigViolation(value: unknown, path: string, depth: number): string | null {
  if (depth > 8) return `${path} is too deeply nested`;
  if (Array.isArray(value)) {
    if (value.length > 200) return `${path} has too many array entries`;
    for (let index = 0; index < value.length; index += 1) {
      const violation = objectProfileConfigViolation(value[index], `${path}[${index}]`, depth + 1);
      if (violation) return violation;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (unsafeObjectProfileConfigKey(key)) {
      return `${path}.${key} is not allowed in object schema config`;
    }
    const violation = objectProfileConfigViolation(entry, `${path}.${key}`, depth + 1);
    if (violation) return violation;
  }
  return null;
}
// Base types are the Retrievable entity types — the registry is the source
// (B12G), not a second copy of the list.
const OBJECT_PROFILE_BASE_TYPES = new Set<string>(retrievableEntityTypes());

function unsafeObjectProfileConfigKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => UNSAFE_OBJECT_PROFILE_CONFIG_KEY_TOKENS.has(token));
}

function dateIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function assertObjectProfileKeyMatchesBase(baseObjectType: string, key: string): void {
  const allowed = allowedObjectProfileKeys(baseObjectType);
  if (!allowed?.includes(key)) {
    throw new HttpError(
      422,
      `object kind key must match the canonical ${baseObjectType} subtype (${allowed?.join(", ") ?? "none"})`,
    );
  }
}

function objectProfileActivationStatus(value: unknown): "active" {
  const status = requiredString(value, "status");
  if (status !== "active") throw new HttpError(422, "object kind update status can only be active");
  return status;
}

function objectProfileKey(value: unknown): string {
  const key = requiredString(value, "key");
  if (!OBJECT_PROFILE_KEY_PATTERN.test(key)) {
    throw new HttpError(422, "object kind key must be lowercase letters, numbers, or underscores and start with a letter");
  }
  return key;
}

function objectProfileManifestOut(
  row: SpaceObjectProfileRow,
  hints: readonly SpaceObjectProfileRelationHintRow[],
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
      endpoint_object_profile_key: hint.endpoint_object_profile_key,
      link_type: hint.link_type,
      direction: hint.direction,
      confidence_default: numberValue(hint.confidence_default) ?? 0.55,
      required: hint.required === true,
    })),
  };
}
const UNSAFE_OBJECT_PROFILE_CONFIG_KEY_TOKENS = new Set([
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

export class PgOntologyRepository {
  constructor(
    private readonly db: Queryable,
    private readonly seams: OntologyRepositorySeams,
  ) {}

  async listObjectProfiles(
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
      if (!OBJECT_PROFILE_BASE_TYPES.has(filters.baseObjectType)) throw new HttpError(422, "invalid base_object_type");
      clauses.push(`base_object_type = ${addParam(filters.baseObjectType)}`);
    }
    if (filters.status) clauses.push(`status = ${addParam(filters.status)}`);
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(*)::text AS total FROM space_object_profiles ${where}`,
      params,
    );
    const rows = await this.db.query<SpaceObjectProfileRow>(
      `SELECT ${OBJECT_PROFILE_COLUMNS}
         FROM space_object_profiles
        ${where}
        ORDER BY base_object_type ASC, key ASC
        LIMIT ${addParam(filters.limit)} OFFSET ${addParam(filters.offset)}`,
      params,
    );
    const hintsByKind = await this.loadObjectProfileRelationHints(identity.spaceId, rows.rows.map((row) => row.id));
    return page(
      rows.rows.map((row) => objectProfileOut(row, hintsByKind.get(row.id) ?? [])),
      countFromRow(total.rows[0]),
      filters.limit,
      filters.offset,
    );
  }

  async getObjectProfile(identity: SpaceUserIdentity, profileId: string): Promise<Record<string, unknown> | null> {
    const row = await this.getObjectProfileRow(identity, profileId);
    if (!row) return null;
    const hintsByKind = await this.loadObjectProfileRelationHints(identity.spaceId, [row.id]);
    return objectProfileOut(row, hintsByKind.get(row.id) ?? []);
  }

  async proposeObjectProfileCreate(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = objectProfileKey(body.key);
    const baseObjectType = objectProfileBaseType(body.base_object_type);
    assertObjectProfileKeyMatchesBase(baseObjectType, key);
    const label = requiredString(body.label, "label");
    const status = optionalString(body.status) ?? "active";
    if (status !== "active" && status !== "draft") throw new HttpError(422, "object kind status must be active or draft");
    const relationHints = await this.normalizeObjectProfileRelationHints(identity, body.relation_hints);
    return this.seams.insertProposal(identity, {
      proposalType: "object_profile_create",
      title: `Create object kind: ${label}`,
      payload: objectProfileProposalPayload("object_profile_create", {
        key,
        label,
        description: optionalString(body.description),
        base_object_type: baseObjectType,
        status,
        field_schema: objectProfileConfigInput(body.field_schema, "field_schema"),
        extraction_policy: objectProfileConfigInput(body.extraction_policy, "extraction_policy"),
        retrieval_policy: objectProfileConfigInput(body.retrieval_policy, "retrieval_policy"),
        ui_config: objectProfileConfigInput(body.ui_config, "ui_config"),
        relation_hints: relationHints,
      }),
      rationale: optionalString(body.rationale) ?? "Object kind creation requested.",
      projectFolderId: null,
      projectId: null,
      visibility: "space_shared",
      riskLevel: "high",
    });
  }

  async proposeObjectProfileUpdate(
    identity: SpaceUserIdentity,
    profileId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const current = await this.requireMutableObjectProfile(identity, profileId);
    const payload: Record<string, unknown> = { target_profile_id: profileId };
    if ("label" in body) payload.label = requiredString(body.label, "label");
    if ("description" in body) payload.description = optionalString(body.description);
    if ("status" in body) {
      const status = objectProfileActivationStatus(body.status);
      if (current.status !== "draft") throw new HttpError(422, "only draft object kinds can be activated");
      payload.status = status;
    }
    if ("field_schema" in body) payload.field_schema = objectProfileConfigInput(body.field_schema, "field_schema");
    if ("extraction_policy" in body) payload.extraction_policy = objectProfileConfigInput(body.extraction_policy, "extraction_policy");
    if ("retrieval_policy" in body) payload.retrieval_policy = objectProfileConfigInput(body.retrieval_policy, "retrieval_policy");
    if ("ui_config" in body) payload.ui_config = objectProfileConfigInput(body.ui_config, "ui_config");
    if ("relation_hints" in body) payload.relation_hints = await this.normalizeObjectProfileRelationHints(identity, body.relation_hints);
    return this.seams.insertProposal(identity, {
      proposalType: "object_profile_update",
      title: `Update object kind: ${current.label}`,
      payload: objectProfileProposalPayload("object_profile_update", payload),
      rationale: optionalString(body.rationale) ?? "Object kind update requested.",
      projectFolderId: null,
      projectId: null,
      visibility: "space_shared",
      riskLevel: "high",
    });
  }

  async proposeObjectProfileDeprecate(
    identity: SpaceUserIdentity,
    profileId: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const current = await this.requireMutableObjectProfile(identity, profileId);
    return this.seams.insertProposal(identity, {
      proposalType: "object_profile_deprecate",
      title: `Deprecate object kind: ${current.label}`,
      payload: objectProfileProposalPayload("object_profile_deprecate", { target_profile_id: profileId }),
      rationale: optionalString(body.rationale) ?? "Object kind deprecation requested.",
      projectFolderId: null,
      projectId: null,
      visibility: "space_shared",
      riskLevel: "high",
    });
  }

  async proposeObjectProfileArchive(
    identity: SpaceUserIdentity,
    profileId: string,
    body: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const current = await this.requireMutableObjectProfile(identity, profileId);
    return this.seams.insertProposal(identity, {
      proposalType: "object_profile_archive",
      title: `Archive object kind: ${current.label}`,
      payload: objectProfileProposalPayload("object_profile_archive", { target_profile_id: profileId }),
      rationale: optionalString(body.rationale) ?? "Object kind archive requested.",
      projectFolderId: null,
      projectId: null,
      visibility: "space_shared",
      riskLevel: "high",
    });
  }

  async exportObjectSchema(identity: SpaceUserIdentity): Promise<Record<string, unknown>> {
    const rows = await this.db.query<SpaceObjectProfileRow>(
      `SELECT ${OBJECT_PROFILE_COLUMNS}
         FROM space_object_profiles
        WHERE space_id = $1
          AND status <> 'archived'
        ORDER BY base_object_type ASC, key ASC`,
      [identity.spaceId],
    );
    const profileIds = rows.rows.map((row) => row.id);
    const hints = profileIds.length > 0
      ? await this.db.query<SpaceObjectProfileRelationHintRow>(
          `SELECT h.id,
                  h.object_profile_id,
                  h.endpoint_object_type,
                  h.endpoint_object_profile_id,
                  endpoint_kind.key AS endpoint_object_profile_key,
                  h.link_type,
                  h.direction,
                  h.confidence_default,
                  h.required
             FROM space_object_profile_relation_hints h
             LEFT JOIN space_object_profiles endpoint_kind
               ON endpoint_kind.id = h.endpoint_object_profile_id
              AND endpoint_kind.space_id = h.space_id
            WHERE h.space_id = $1
              AND h.object_profile_id = ANY($2::varchar[])
            ORDER BY h.object_profile_id ASC, h.required DESC, h.link_type ASC, h.id ASC`,
          [identity.spaceId, profileIds],
        )
      : { rows: [] as SpaceObjectProfileRelationHintRow[] };
    const hintsByKind = new Map<string, SpaceObjectProfileRelationHintRow[]>();
    for (const hint of hints.rows) {
      const arr = hintsByKind.get(hint.object_profile_id) ?? [];
      arr.push(hint);
      hintsByKind.set(hint.object_profile_id, arr);
    }
    const versions = rows.rows.map((row) => numberValue(row.version) ?? 0);
    return {
      format: "agent_space.object_schema.v1",
      exported_at: new Date().toISOString(),
      object_schema_version: versions.length > 0 ? Math.max(...versions) : 0,
      object_profiles: rows.rows.map((row) => objectProfileManifestOut(row, hintsByKind.get(row.id) ?? [])),
      metadata: {
        object_profile_count: rows.rows.length,
        relation_hint_count: hints.rows.length,
        content_included: false,
        proposal_history_included: false,
      },
    };
  }

  async proposeObjectRelation(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fromObjectId = requiredString(body.from_object_id, "from_object_id");
    const toObjectId = requiredString(body.to_object_id, "to_object_id");
    if (fromObjectId === toObjectId) throw new HttpError(422, "object relation endpoints must differ");
    const linkType = requiredString(body.link_type, "link_type");
    const status = optionalString(body.status) ?? "active";
    if (!RELATION_CREATE_STATUSES.has(status)) throw new HttpError(422, "invalid relation status");
    const fromObject = await this.seams.requireVisibleSpaceObject(identity, fromObjectId, "Object relation endpoint not found");
    const toObject = await this.seams.requireVisibleSpaceObject(identity, toObjectId, "Object relation endpoint not found");
    // The registry is the vocabulary (B12F). It also decides whether this edge
    // may be proposed at all: a link type declared `direct` is written by its
    // owning domain, and routing it through review is a category error.
    assertLinkTypeAllowed({
      linkType,
      fromObjectType: String(fromObject.object_type ?? ""),
      toObjectType: String(toObject.object_type ?? ""),
      via: "proposal",
    });
    const sourceClaimId = optionalString(body.source_claim_id);
    if (sourceClaimId) {
      const sourceClaim = await this.seams.getVisibleClaimRow(identity, sourceClaimId);
      if (!sourceClaim) throw new HttpError(404, "Object relation source claim not found");
    }
    const sourceObjectId = optionalString(body.source_object_id);
    if (sourceObjectId) await this.seams.requireVisibleSpaceObject(identity, sourceObjectId, "Object relation source object not found");
    return this.seams.insertProposal(identity, {
      proposalType: "object_relation_create",
      title: `Relate objects: ${fromObject.title} -> ${toObject.title}`,
      payload: {
        operation: "object_relation_create",
        from_object_id: fromObjectId,
        to_object_id: toObjectId,
        link_type: linkType,
        status,
        confidence: confidence(body.confidence),
        evidence_summary: optionalString(body.evidence_summary),
        source_claim_id: sourceClaimId,
        source_object_id: sourceObjectId,
        metadata: optionalObject(body.metadata) ?? {},
      },
      rationale: optionalString(body.rationale) ?? "Object relation requested.",
      projectFolderId: fromObject.project_folder_id,
      projectId: fromObject.primary_project_id,
      visibility: normalizedContentVisibility(fromObject.visibility),
    });
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
    const rawKinds = Array.isArray(manifest.object_profiles) ? manifest.object_profiles : [];
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
      const key = objectProfileKey(kind.key);
      const baseObjectType = objectProfileBaseType(kind.base_object_type);
      assertObjectProfileKeyMatchesBase(baseObjectType, key);
      const dedupeKey = `${baseObjectType}:${key}`;
      if (seen.has(dedupeKey)) {
        skipped.push({ key, base_object_type: baseObjectType, reason: "duplicate_in_manifest" });
        continue;
      }
      seen.add(dedupeKey);
      const existing = await this.getObjectProfileByKeyAny(identity, baseObjectType, key);
      if (existing) {
        skipped.push({ key, base_object_type: baseObjectType, reason: "key_already_exists" });
        continue;
      }
      const relationHints = await this.objectSchemaManifestRelationHints(identity, kind, warnings, key);
      const proposal = await this.seams.insertProposal(identity, {
        proposalType: "object_profile_create",
        title: `Import object kind draft: ${requiredString(kind.label, "label")}`,
        payload: objectProfileProposalPayload("object_profile_create", {
          key,
          label: requiredString(kind.label, "label"),
          description: optionalString(kind.description),
          base_object_type: baseObjectType,
          status: "draft",
          field_schema: objectProfileConfigInput(kind.field_schema, "field_schema"),
          extraction_policy: objectProfileConfigInput(kind.extraction_policy, "extraction_policy"),
          retrieval_policy: objectProfileConfigInput(kind.retrieval_policy, "retrieval_policy"),
          ui_config: objectProfileConfigInput(kind.ui_config, "ui_config"),
          relation_hints: relationHints,
          import_metadata: {
            manifest_format: manifest.format,
            source_status: optionalString(kind.status),
            source_version: numberValue(kind.version),
          },
        }),
        rationale: optionalString(body.rationale) ?? "Object schema import requested.",
        projectFolderId: null,
        projectId: null,
        visibility: "space_shared",
        riskLevel: "high",
      });
      proposalIds.push(String(proposal.id));
    }

    return {
      created_proposal_count: proposalIds.length,
      skipped_count: skipped.length,
      proposal_ids: proposalIds,
      skipped,
      warnings,
    };
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
      const endpointObjectType = objectProfileBaseType(hint.endpoint_object_type);
      const endpointObjectProfileKey = optionalString(hint.endpoint_object_profile_key);
      let endpointObjectProfileId: string | null = null;
      if (endpointObjectProfileKey) {
        const endpointKind = await this.getObjectProfileByKeyAny(identity, endpointObjectType, endpointObjectProfileKey);
        if (endpointKind && endpointKind.status !== "archived") {
          endpointObjectProfileId = endpointKind.id;
        } else {
          warnings.push(
            `relation hint on ${sourceKindKey} references unresolved endpoint kind ${endpointObjectType}:${endpointObjectProfileKey}; imported as object-type-only hint`,
          );
        }
      }
      converted.push({
        endpoint_object_type: endpointObjectType,
        endpoint_object_profile_id: endpointObjectProfileId,
        link_type: hint.link_type,
        direction: hint.direction,
        confidence_default: hint.confidence_default,
        required: hint.required,
      });
    }
    return this.normalizeObjectProfileRelationHints(identity, converted);
  }

  private async getObjectProfileByKeyAny(
    identity: SpaceUserIdentity,
    baseObjectType: string,
    key: string,
  ): Promise<SpaceObjectProfileRow | null> {
    const result = await this.db.query<SpaceObjectProfileRow>(
      `SELECT ${OBJECT_PROFILE_COLUMNS}
         FROM space_object_profiles
        WHERE space_id = $1
          AND base_object_type = $2
          AND key = $3
        LIMIT 1`,
      [identity.spaceId, baseObjectType, key],
    );
    return result.rows[0] ?? null;
  }

  async activeObjectProfileByKey(
    identity: SpaceUserIdentity,
    baseObjectType: string,
    key: string,
  ): Promise<SpaceObjectProfileRow | null> {
    const result = await this.db.query<SpaceObjectProfileRow>(
      `SELECT ${OBJECT_PROFILE_COLUMNS}
         FROM space_object_profiles
        WHERE space_id = $1
          AND base_object_type = $2
          AND key = $3
          AND status = 'active'
        LIMIT 1`,
      [identity.spaceId, baseObjectType, key],
    );
    return result.rows[0] ?? null;
  }

  private async getObjectProfileRow(identity: SpaceUserIdentity, profileId: string): Promise<SpaceObjectProfileRow | null> {
    const result = await this.db.query<SpaceObjectProfileRow>(
      `SELECT ${OBJECT_PROFILE_COLUMNS}
         FROM space_object_profiles
        WHERE id = $1 AND space_id = $2`,
      [profileId, identity.spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async loadObjectProfileRelationHints(
    spaceId: string,
    profileIds: readonly string[],
  ): Promise<Map<string, SpaceObjectProfileRelationHintRow[]>> {
    const out = new Map<string, SpaceObjectProfileRelationHintRow[]>();
    if (profileIds.length === 0) return out;
    const hints = await this.db.query<SpaceObjectProfileRelationHintRow>(
      `SELECT h.id,
              h.object_profile_id,
              h.endpoint_object_type,
              h.endpoint_object_profile_id,
              endpoint_kind.key AS endpoint_object_profile_key,
              h.link_type,
              h.direction,
              h.confidence_default,
              h.required
         FROM space_object_profile_relation_hints h
         LEFT JOIN space_object_profiles endpoint_kind
           ON endpoint_kind.id = h.endpoint_object_profile_id
          AND endpoint_kind.space_id = h.space_id
        WHERE h.space_id = $1
          AND h.object_profile_id = ANY($2::varchar[])
        ORDER BY h.object_profile_id ASC, h.required DESC, h.link_type ASC, h.id ASC`,
      [spaceId, profileIds],
    );
    for (const hint of hints.rows) {
      const arr = out.get(hint.object_profile_id) ?? [];
      arr.push(hint);
      out.set(hint.object_profile_id, arr);
    }
    return out;
  }

  private async normalizeObjectProfileRelationHints(
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
      const endpointObjectType = objectProfileBaseType(hint.endpoint_object_type);
      const linkType = requiredString(hint.link_type, "link_type");
      if (!hasDeclaration(linkType)) {
        throw new HttpError(422, "invalid relation_hints link_type");
      }
      const direction = optionalString(hint.direction) ?? "from";
      if (direction !== "from" && direction !== "to" && direction !== "either") {
        throw new HttpError(422, "invalid relation_hints direction");
      }
      const confidenceDefault = numberValue(hint.confidence_default) ?? 0.55;
      if (confidenceDefault < 0 || confidenceDefault > 1) {
        throw new HttpError(422, "relation_hints confidence_default must be between 0 and 1");
      }
      const endpointObjectProfileId = optionalString(hint.endpoint_object_profile_id);
      if (endpointObjectProfileId) {
        const endpointKind = await this.getObjectProfileRow(identity, endpointObjectProfileId);
        if (!endpointKind) throw new HttpError(404, "Relation hint endpoint object kind not found");
        if (endpointKind.status === "archived") throw new HttpError(422, "Relation hint endpoint object kind is archived");
        if (endpointKind.base_object_type !== endpointObjectType) {
          throw new HttpError(422, "relation_hints endpoint_object_profile_id must match endpoint_object_type");
        }
      }
      hints.push({
        endpoint_object_type: endpointObjectType,
        endpoint_object_profile_id: endpointObjectProfileId,
        link_type: linkType,
        direction,
        confidence_default: confidenceDefault,
        required: hint.required === true,
      });
    }
    return hints;
  }

  private async requireMutableObjectProfile(identity: SpaceUserIdentity, profileId: string): Promise<SpaceObjectProfileRow> {
    const row = await this.requireObjectProfile(identity, profileId);
    if (row.status === "archived") throw new HttpError(422, "archived object kinds cannot be changed");
    return row;
  }


  private async requireObjectProfile(identity: SpaceUserIdentity, profileId: string): Promise<SpaceObjectProfileRow> {
    const row = await this.getObjectProfileRow(identity, profileId);
    if (!row) throw new HttpError(404, "Object kind not found");
    return row;
  }

}

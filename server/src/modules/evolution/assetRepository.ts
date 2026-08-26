import { randomUUID } from "node:crypto";
import * as protocol from "@rainver/protocol";
import {
  HttpError,
  dateIso,
  objectValue,
  optionalObject,
  optionalString,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common.js";
import {
  assertAssetAllowsTargetScope,
  assertCanPinScope,
  assertCanReadAssetOwnerScope,
  assertCanWriteAssetOwnerScope,
  canReadAssetOwnerScope,
  canViewScopedRef,
  normalizeAssetOwnerScopeForCreate,
  normalizeVersionScopeForWrite,
  type EvolvableAssetAccessRow,
} from "./assetAccess.js";

const ASSET_TYPES = new Set([
  "prompt_template",
  "workflow_template",
  "agent_config",
  "runtime_skill_binding",
  "source_post_processing_rule",
]);
const OWNER_SCOPE_TYPES = new Set(["system", "space", "project", "user", "agent"]);
const PIN_SCOPE_TYPES = new Set(["space", "project", "user", "agent"]);
const VERSION_SOURCES = new Set(["built_in", "user_authored", "evolved", "imported", "generated"]);
// approved/deprecated are reachable only through the promotion proposal
// applier. This repository's own transitionVersionStatus rejects them so
// human review remains the only durable promotion path.
const DIRECT_VERSION_STATUSES = new Set(["draft", "candidate", "testing", "archived"]);

function requiredDateIso(value: unknown): string {
  return dateIso(value) ?? new Date(0).toISOString();
}

function enumValue(value: unknown, allowed: Set<string>, field: string): string | null {
  const text = optionalString(value);
  if (!text) return null;
  if (!allowed.has(text)) throw new HttpError(422, `${field} must be one of ${[...allowed].join(", ")}`);
  return text;
}

interface AssetRow extends EvolvableAssetAccessRow {
  id: string;
  space_id: string | null;
  asset_type: string;
  asset_key: string;
  display_name: string;
  description: string | null;
  owner_scope_type: string;
  owner_scope_id: string | null;
  status: string;
  current_system_version_id: string | null;
  default_eval_suite_ref_json: unknown;
  metadata_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

const ASSET_COLUMNS = `
  id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
  status, current_system_version_id, default_eval_suite_ref_json, metadata_json, created_at, updated_at
`;

function assetOut(row: AssetRow): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    asset_type: row.asset_type,
    asset_key: row.asset_key,
    display_name: row.display_name,
    description: row.description,
    owner_scope_type: row.owner_scope_type,
    owner_scope_id: row.owner_scope_id,
    status: row.status,
    current_system_version_id: row.current_system_version_id,
    default_eval_suite_ref: row.default_eval_suite_ref_json ?? null,
    metadata_json: objectValue(row.metadata_json),
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

interface VersionRow {
  id: string;
  asset_id: string;
  space_id: string | null;
  scope_type: string;
  scope_id: string | null;
  parent_version_id: string | null;
  version: number;
  status: string;
  source: string;
  content_ref: string | null;
  content_hash: string | null;
  content_json: unknown;
  eval_summary_json: unknown;
  promotion_proposal_id: string | null;
  created_by_user_id: string | null;
  approved_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const VERSION_COLUMNS = `
  id, asset_id, space_id, scope_type, scope_id, parent_version_id, version, status, source,
  content_ref, content_hash, content_json, eval_summary_json, promotion_proposal_id,
  created_by_user_id, approved_by_user_id, created_at, updated_at
`;

function versionOut(row: VersionRow, stale: boolean): Record<string, unknown> {
  return {
    id: row.id,
    asset_id: row.asset_id,
    space_id: row.space_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    parent_version_id: row.parent_version_id,
    version: row.version,
    status: row.status,
    source: row.source,
    content_ref: row.content_ref,
    content_hash: row.content_hash,
    content_json: row.content_json ?? null,
    eval_summary_json: row.eval_summary_json ?? null,
    promotion_proposal_id: row.promotion_proposal_id,
    created_by_user_id: row.created_by_user_id,
    approved_by_user_id: row.approved_by_user_id,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
    stale_parent: stale,
  };
}

interface PinRow {
  id: string;
  asset_id: string;
  scope_type: string;
  scope_id: string;
  version_id: string;
  status: string;
  pinned_by_user_id: string | null;
  reason: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const PIN_COLUMNS = `
  id, asset_id, scope_type, scope_id, version_id, status, pinned_by_user_id, reason, created_at, updated_at
`;

function pinOut(row: PinRow): Record<string, unknown> {
  return {
    id: row.id,
    asset_id: row.asset_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    version_id: row.version_id,
    status: row.status,
    pinned_by_user_id: row.pinned_by_user_id,
    reason: row.reason,
    created_at: requiredDateIso(row.created_at),
    updated_at: requiredDateIso(row.updated_at),
  };
}

export class EvolvableAssetRepository {
  constructor(private readonly db: Queryable) {}

  // --- Assets ---------------------------------------------------------

  async listAssets(identity: SpaceUserIdentity, filters: { assetType?: string | null }): Promise<Record<string, unknown>[]> {
    const params: unknown[] = [identity.spaceId];
    const clauses = ["(space_id = $1 OR space_id IS NULL)"];
    if (filters.assetType) {
      if (!ASSET_TYPES.has(filters.assetType)) throw new HttpError(422, "asset_type is invalid");
      params.push(filters.assetType);
      clauses.push(`asset_type = $${params.length}`);
    }
    const result = await this.db.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM evolvable_assets WHERE ${clauses.join(" AND ")} ORDER BY asset_key ASC`,
      params,
    );
    const out: Record<string, unknown>[] = [];
    for (const row of result.rows) {
      if (await canReadAssetOwnerScope(this.db, identity, row)) out.push(assetOut(row));
    }
    return out;
  }

  async createAsset(identity: SpaceUserIdentity, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const assetType = enumValue(body.asset_type, ASSET_TYPES, "asset_type");
    if (!assetType) throw new HttpError(422, "asset_type is required");
    const assetKey = optionalString(body.asset_key);
    if (!assetKey) throw new HttpError(422, "asset_key is required");
    const displayName = optionalString(body.display_name);
    if (!displayName) throw new HttpError(422, "display_name is required");
    const ownerScopeType = enumValue(body.owner_scope_type, OWNER_SCOPE_TYPES, "owner_scope_type") ?? "space";
    const ownerScope = await normalizeAssetOwnerScopeForCreate(
      this.db,
      identity,
      ownerScopeType,
      optionalString(body.owner_scope_id),
    );
    const metadata = objectValue(body.metadata_json);
    if (assetType === "prompt_template" && optionalString(metadata.prompt_type)) {
      const reserved = await this.db.query<{ id: string }>(
        `SELECT id
           FROM evolvable_assets
          WHERE space_id IS NULL
            AND asset_type = 'prompt_template'
            AND asset_key = $1
            AND status = 'active'
            AND metadata_json ? 'prompt_type'
          LIMIT 1`,
        [assetKey],
      );
      if (reserved.rows[0]) {
        throw new HttpError(409, "system prompt asset_key is reserved; evolve the existing prompt asset instead");
      }
    }
    const existing = await this.db.query<{ id: string }>(
      `SELECT id FROM evolvable_assets WHERE space_id = $1 AND asset_key = $2 LIMIT 1`,
      [identity.spaceId, assetKey],
    );
    if (existing.rows[0]) throw new HttpError(409, "asset_key is already in use in this space");
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO evolvable_assets (
         id, space_id, asset_type, asset_key, display_name, description, owner_scope_type, owner_scope_id,
         status, default_eval_suite_ref_json, metadata_json, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9::jsonb, $10::jsonb, $11, $11)`,
      [
        id,
        identity.spaceId,
        assetType,
        assetKey,
        displayName,
        optionalString(body.description),
        ownerScope.ownerScopeType,
        ownerScope.ownerScopeId,
        optionalObject(body.default_eval_suite_ref) ? JSON.stringify(body.default_eval_suite_ref) : null,
        JSON.stringify(metadata),
        now,
      ],
    );
    const row = await this.assetRow(identity.spaceId, id);
    if (!row) throw new HttpError(500, "Failed to create evolvable asset");
    return assetOut(row);
  }

  async getAsset(identity: SpaceUserIdentity, assetId: string): Promise<Record<string, unknown>> {
    const row = await this.assetRow(identity.spaceId, assetId);
    if (!row) throw new HttpError(404, "Evolvable asset not found");
    await assertCanReadAssetOwnerScope(this.db, identity, row);
    return assetOut(row);
  }

  private async assetRow(spaceId: string, assetId: string): Promise<AssetRow | null> {
    const result = await this.db.query<AssetRow>(
      `SELECT ${ASSET_COLUMNS} FROM evolvable_assets WHERE id = $1 AND (space_id = $2 OR space_id IS NULL) LIMIT 1`,
      [assetId, spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async requireReadableAsset(identity: SpaceUserIdentity, assetId: string): Promise<AssetRow> {
    const row = await this.assetRow(identity.spaceId, assetId);
    if (!row) throw new HttpError(404, "Evolvable asset not found");
    await assertCanReadAssetOwnerScope(this.db, identity, row);
    return row;
  }

  private async requireWritableAsset(identity: SpaceUserIdentity, assetId: string): Promise<AssetRow> {
    const row = await this.assetRow(identity.spaceId, assetId);
    if (!row) throw new HttpError(404, "Evolvable asset not found");
    await assertCanWriteAssetOwnerScope(this.db, identity, row);
    return row;
  }

  // --- Versions ---------------------------------------------------------

  async listVersions(identity: SpaceUserIdentity, assetId: string): Promise<Record<string, unknown>[]> {
    await this.requireReadableAsset(identity, assetId);
    const result = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM evolvable_asset_versions WHERE asset_id = $1 ORDER BY version DESC`,
      [assetId],
    );
    const rows: VersionRow[] = [];
    for (const row of result.rows) {
      if (await canViewVersionScope(this.db, identity, row)) rows.push(row);
    }
    const staleByScope = await this.currentApprovedVersionByScope(identity, assetId);
    return rows.map((row) => {
      const currentApproved = staleByScope.get(scopeKey(row.scope_type, row.scope_id));
      const stale = Boolean(
        row.parent_version_id &&
          ["candidate", "testing"].includes(row.status) &&
          currentApproved &&
          currentApproved !== row.parent_version_id,
      );
      return versionOut(row, stale);
    });
  }

  private async currentApprovedVersionByScope(identity: SpaceUserIdentity, assetId: string): Promise<Map<string, string>> {
    const result = await this.db.query<VersionRow>(
      `SELECT DISTINCT ON (scope_type, scope_id) ${VERSION_COLUMNS}
         FROM evolvable_asset_versions
        WHERE asset_id = $1 AND status = 'approved' AND (space_id IS NULL OR space_id = $2)
        ORDER BY scope_type, scope_id, version DESC`,
      [assetId, identity.spaceId],
    );
    const map = new Map<string, string>();
    for (const row of result.rows) {
      if (await canViewVersionScope(this.db, identity, row)) map.set(scopeKey(row.scope_type, row.scope_id), row.id);
    }
    return map;
  }

  async createVersion(identity: SpaceUserIdentity, assetId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    const scopeType = enumValue(body.scope_type, OWNER_SCOPE_TYPES, "scope_type") ?? "space";
    const scopeId = await normalizeVersionScopeForWrite(this.db, identity, scopeType, optionalString(body.scope_id));
    assertAssetAllowsTargetScope(asset, identity, scopeType, scopeId);
    const source = enumValue(body.source, VERSION_SOURCES, "source") ?? "user_authored";
    const parentVersionId = optionalString(body.parent_version_id);
    if (parentVersionId) {
      const parent = await this.versionRow(assetId, parentVersionId);
      if (!parent) throw new HttpError(422, "parent_version_id does not reference a version of this asset");
    }
    const contentJson = await validateAssetVersionContent(asset.asset_type, optionalObject(body.content_json));
    const contentRef = optionalString(body.content_ref);
    if (!contentJson && !contentRef) throw new HttpError(422, "content_json or content_ref is required");
    const nextVersionResult = await this.db.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM evolvable_asset_versions WHERE asset_id = $1`,
      [assetId],
    );
    const nextVersion = nextVersionResult.rows[0]?.next ?? 1;
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO evolvable_asset_versions (
         id, asset_id, space_id, scope_type, scope_id, parent_version_id, version, status, source,
         content_ref, content_hash, content_json, created_by_user_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11::jsonb, $12, $13, $13)`,
      [
        id,
        assetId,
        identity.spaceId,
        scopeType,
        scopeId,
        parentVersionId,
        nextVersion,
        source,
        contentRef,
        optionalString(body.content_hash),
        contentJson ? JSON.stringify(contentJson) : null,
        identity.userId,
        now,
      ],
    );
    const row = await this.versionRow(assetId, id);
    if (!row) throw new HttpError(500, "Failed to create asset version");
    return versionOut(row, false);
  }

  async updateVersionContent(
    identity: SpaceUserIdentity,
    assetId: string,
    versionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    const current = await this.versionRow(assetId, versionId);
    if (!current) throw new HttpError(404, "Asset version not found");
    await normalizeVersionScopeForWrite(this.db, identity, current.scope_type, current.scope_id);
    assertAssetAllowsTargetScope(asset, identity, current.scope_type, current.scope_id);
    if (current.status !== "draft") {
      throw new HttpError(422, "Only draft versions can be edited — create a child version instead");
    }
    const contentJson = body.content_json === undefined
      ? optionalObject(current.content_json)
      : optionalObject(body.content_json);
    const validatedContentJson = await validateAssetVersionContent(asset.asset_type, contentJson);
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE evolvable_asset_versions
          SET content_ref = $3, content_hash = $4, content_json = $5::jsonb, updated_at = $6
        WHERE asset_id = $1 AND id = $2`,
      [
        assetId,
        versionId,
        body.content_ref === undefined ? current.content_ref : optionalString(body.content_ref),
        body.content_hash === undefined ? current.content_hash : optionalString(body.content_hash),
        validatedContentJson ? JSON.stringify(validatedContentJson) : null,
        now,
      ],
    );
    const updated = await this.versionRow(assetId, versionId);
    if (!updated) throw new HttpError(500, "Failed to update asset version");
    return versionOut(updated, false);
  }

  async transitionVersionStatus(
    identity: SpaceUserIdentity,
    assetId: string,
    versionId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    const current = await this.versionRow(assetId, versionId);
    if (!current) throw new HttpError(404, "Asset version not found");
    await normalizeVersionScopeForWrite(this.db, identity, current.scope_type, current.scope_id);
    assertAssetAllowsTargetScope(asset, identity, current.scope_type, current.scope_id);
    const status = optionalString(body.status);
    if (!status) throw new HttpError(422, "status is required");
    if (!DIRECT_VERSION_STATUSES.has(status)) {
      throw new HttpError(422, "'approved' and 'deprecated' are only reachable through the promotion proposal flow");
    }
    if (current.status === "approved" || current.status === "deprecated") {
      throw new HttpError(422, `Cannot transition a ${current.status} version directly — use rollback/promotion instead`);
    }
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE evolvable_asset_versions SET status = $3, updated_at = $4 WHERE asset_id = $1 AND id = $2`,
      [assetId, versionId, status, now],
    );
    const updated = await this.versionRow(assetId, versionId);
    if (!updated) throw new HttpError(500, "Failed to transition asset version");
    return versionOut(updated, false);
  }

  private async versionRow(assetId: string, versionId: string): Promise<VersionRow | null> {
    const result = await this.db.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM evolvable_asset_versions WHERE asset_id = $1 AND id = $2 LIMIT 1`,
      [assetId, versionId],
    );
    return result.rows[0] ?? null;
  }

  // --- Pins ---------------------------------------------------------

  async listPins(identity: SpaceUserIdentity, assetId: string): Promise<Record<string, unknown>[]> {
    await this.requireReadableAsset(identity, assetId);
    const result = await this.db.query<PinRow>(
      `SELECT ${PIN_COLUMNS} FROM evolvable_asset_pins
        WHERE space_id = $1 AND asset_id = $2 AND status = 'active'
        ORDER BY scope_type ASC, scope_id ASC`,
      [identity.spaceId, assetId],
    );
    const out: Record<string, unknown>[] = [];
    for (const row of result.rows) {
      if (await canViewScopedRef(this.db, identity, row.scope_type, row.scope_id)) out.push(pinOut(row));
    }
    return out;
  }

  async setPin(
    identity: SpaceUserIdentity,
    assetId: string,
    scopeType: string,
    scopeId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireWritableAsset(identity, assetId);
    if (!PIN_SCOPE_TYPES.has(scopeType)) throw new HttpError(422, "scope_type must be one of space, project, user, agent");
    await assertCanPinScope(this.db, identity, scopeType, scopeId);
    assertAssetAllowsTargetScope(asset, identity, scopeType, scopeId);
    const versionId = optionalString(body.version_id);
    if (!versionId) throw new HttpError(422, "version_id is required");
    const version = await this.versionRow(assetId, versionId);
    if (!version) throw new HttpError(422, "version_id does not reference a version of this asset");
    if (version.status !== "approved") throw new HttpError(422, "Only an approved version can be pinned");
    if (!canPinVersionToScope(identity, scopeType, scopeId, version)) {
      throw new HttpError(422, "version_id is not visible to the target pin scope");
    }
    // Archive any existing active pin for this exact scope target (same
    // scope_type AND scope_id — not just scope_type, which would archive an
    // unrelated project/agent/user's pin on the same asset), then insert a
    // fresh row — keeps pin history instead of updating in place.
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE evolvable_asset_pins
          SET status = 'archived', updated_at = $5
        WHERE space_id = $1 AND asset_id = $2 AND scope_type = $3 AND scope_id = $4 AND status = 'active'`,
      [identity.spaceId, assetId, scopeType, scopeId, now],
    );
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO evolvable_asset_pins (
         id, space_id, asset_id, scope_type, scope_id, version_id, status, pinned_by_user_id, reason, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $9)`,
      [id, identity.spaceId, assetId, scopeType, scopeId, versionId, identity.userId, optionalString(body.reason), now],
    );
    const result = await this.db.query<PinRow>(`SELECT ${PIN_COLUMNS} FROM evolvable_asset_pins WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw new HttpError(500, "Failed to set pin");
    return pinOut(row);
  }

  async archivePin(identity: SpaceUserIdentity, assetId: string, scopeType: string, scopeId: string): Promise<void> {
    const asset = await this.requireWritableAsset(identity, assetId);
    await assertCanPinScope(this.db, identity, scopeType, scopeId);
    assertAssetAllowsTargetScope(asset, identity, scopeType, scopeId);
    const now = new Date().toISOString();
    await this.db.query(
      `UPDATE evolvable_asset_pins
          SET status = 'archived', updated_at = $5
        WHERE space_id = $1 AND asset_id = $2 AND scope_type = $3 AND scope_id = $4 AND status = 'active'`,
      [identity.spaceId, assetId, scopeType, scopeId, now],
    );
  }
}

async function canViewVersionScope(
  db: Queryable,
  identity: SpaceUserIdentity,
  row: VersionRow,
): Promise<boolean> {
  if (row.space_id === null) return row.scope_type === "system";
  if (row.space_id !== identity.spaceId) return false;
  return canViewScopedRef(db, identity, row.scope_type, row.scope_id);
}

async function validateAssetVersionContent(
  assetType: string,
  contentJson: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (assetType !== "workflow_template") return contentJson;
  if (!contentJson) throw new HttpError(422, "workflow_template versions require content_json");
  const parsed = protocol.WorkflowDefinitionSchema.safeParse(contentJson);
  if (!parsed.success) {
    throw new HttpError(422, `workflow_definition.v1 is invalid: ${parsed.error.issues[0]?.message ?? "invalid content"}`);
  }
  return parsed.data as Record<string, unknown>;
}

function canPinVersionToScope(
  identity: SpaceUserIdentity,
  targetScopeType: string,
  targetScopeId: string,
  version: VersionRow,
): boolean {
  if (version.space_id === null) return version.scope_type === "system";
  if (version.space_id !== identity.spaceId) return false;
  if (version.scope_type === "system") return true;
  if (version.scope_type === "space") return version.scope_id === identity.spaceId;
  if (version.scope_type === "project") return targetScopeType === "project" && version.scope_id === targetScopeId;
  if (version.scope_type === "user") {
    return targetScopeType === "user" && targetScopeId === identity.userId && version.scope_id === targetScopeId;
  }
  if (version.scope_type === "agent") return targetScopeType === "agent" && version.scope_id === targetScopeId;
  return false;
}

function scopeKey(scopeType: string, scopeId: string | null): string {
  return `${scopeType}:${scopeId ?? ""}`;
}

import { HttpError, type Queryable } from "../routeUtils/common.js";
import { assetAllowsUserScope, canReadAssetOwnerScope, type EvolvableAssetAccessRow } from "./assetAccess.js";

export interface ResolveEvolvableAssetVersionInput {
  assetId?: string | null;
  spaceId: string;
  assetKey: string;
  assetType?: string | null;
  projectId?: string | null;
  userId?: string | null;
  agentId?: string | null;
  explicitVersionId?: string | null;
  /**
   * User pins never affect shared Project outputs unless a caller explicitly
   * opts into user-personal behavior. Defaults to false.
   */
  allowUserPin?: boolean;
}

export interface ResolvedEvolvableAssetVersion {
  assetId: string;
  versionId: string;
  contentRef: string | null;
  contentHash: string | null;
  contentJson: unknown;
  resolutionTrace: string[];
  fallbackReason: string | null;
}

interface VersionContentRow {
  id: string;
  space_id: string | null;
  scope_type: string;
  scope_id: string | null;
  content_ref: string | null;
  content_hash: string | null;
  content_json: unknown;
  status: string;
}

interface AssetResolveRow extends EvolvableAssetAccessRow {
  id: string;
  asset_key: string;
  asset_type: string;
  current_system_version_id: string | null;
}

/**
 * Runtime resolution for evolvable prompt/workflow-template assets:
 * explicit approved override -> project pin -> agent pin -> user pin
 * (gated) -> space pin -> space approved version -> system baseline.
 * Every call returns a
 * resolution trace so Runs/workflow artifacts can record reproducibility
 * provenance.
 */
export async function resolveEvolvableAssetVersion(
  db: Queryable,
  input: ResolveEvolvableAssetVersionInput,
): Promise<ResolvedEvolvableAssetVersion> {
  const trace: string[] = [];
  const asset = input.assetId
    ? await db.query<AssetResolveRow>(
        `SELECT id, asset_key, asset_type, current_system_version_id, space_id, owner_scope_type, owner_scope_id, metadata_json
           FROM evolvable_assets
          WHERE id = $1 AND (space_id = $2 OR space_id IS NULL) AND status = 'active'
          LIMIT 1`,
        [input.assetId, input.spaceId],
      )
    : await db.query<AssetResolveRow>(
        `SELECT id, asset_key, asset_type, current_system_version_id, space_id, owner_scope_type, owner_scope_id, metadata_json
           FROM evolvable_assets
          WHERE asset_key = $1 AND (space_id = $2 OR space_id IS NULL) AND status = 'active'
          ORDER BY space_id NULLS LAST
          LIMIT 10`,
        [input.assetKey, input.spaceId],
      );
  const assetRow = await firstReadableAssetForResolution(db, input, asset.rows);
  if (!assetRow) throw new HttpError(404, `No active evolvable asset registered for asset_key '${input.assetKey}'`);
  if (assetRow.asset_key !== input.assetKey) {
    throw new HttpError(422, `asset_id does not reference asset_key '${input.assetKey}'`);
  }
  if (input.assetType && assetRow.asset_type !== input.assetType) {
    throw new HttpError(422, `asset_key '${input.assetKey}' is asset_type '${assetRow.asset_type}', not '${input.assetType}'`);
  }
  const assetId = assetRow.id;
  if (input.allowUserPin && !input.userId) {
    throw new HttpError(422, "allowUserPin requires userId");
  }
  const allowUserPin = Boolean(input.allowUserPin && input.userId && assetAllowsUserScope(assetRow, input.userId));
  if (input.allowUserPin && input.userId && !allowUserPin) {
    throw new HttpError(403, "User-scoped overrides are not allowed for this asset");
  }
  const resolutionInput: ResolveEvolvableAssetVersionInput = { ...input, allowUserPin };

  if (input.explicitVersionId) {
    const version = await versionContent(db, assetId, input.explicitVersionId, { approvedOnly: true });
    if (!version) {
      throw new HttpError(422, "explicit_version_id must reference an approved version of this asset");
    }
    if (!canUseVersionForResolution(version, resolutionInput)) {
      throw new HttpError(422, "explicit_version_id must reference an approved version visible to this resolution scope");
    }
    trace.push(`explicit_override:${version.id}`);
    return resolved(assetId, version, trace, null);
  }

  if (input.projectId) {
    const pinned = await resolveViaPin(db, assetId, input.spaceId, "project", input.projectId, trace, resolutionInput);
    if (pinned) return resolved(assetId, pinned, trace, null);
  }
  if (input.agentId) {
    const pinned = await resolveViaPin(db, assetId, input.spaceId, "agent", input.agentId, trace, resolutionInput);
    if (pinned) return resolved(assetId, pinned, trace, null);
  }
  if (resolutionInput.allowUserPin && resolutionInput.userId) {
    const pinned = await resolveViaPin(db, assetId, input.spaceId, "user", resolutionInput.userId, trace, resolutionInput);
    if (pinned) return resolved(assetId, pinned, trace, null);
  }
  {
    const pinned = await resolveViaPin(db, assetId, input.spaceId, "space", input.spaceId, trace, resolutionInput);
    if (pinned) return resolved(assetId, pinned, trace, null);
  }

  const spaceApproved = await db.query<VersionContentRow>(
    `SELECT id, space_id, scope_type, scope_id, content_ref, content_hash, content_json, status FROM evolvable_asset_versions
      WHERE asset_id = $1 AND space_id = $2 AND scope_type = 'space' AND scope_id = $2 AND status = 'approved'
      ORDER BY version DESC LIMIT 1`,
    [assetId, input.spaceId],
  );
  if (spaceApproved.rows[0]) {
    trace.push(`space_approved:${spaceApproved.rows[0].id}`);
    return resolved(assetId, spaceApproved.rows[0], trace, null);
  }

  if (assetRow.current_system_version_id) {
    const version = await versionContent(db, assetId, assetRow.current_system_version_id, { approvedOnly: true });
    if (version && canUseVersionForResolution(version, resolutionInput)) {
      trace.push(`system_baseline:${version.id}`);
      return resolved(assetId, version, trace, "no project/agent/user pin or space-approved version; used current_system_version_id");
    }
  }
  const systemApproved = await db.query<VersionContentRow>(
    `SELECT id, space_id, scope_type, scope_id, content_ref, content_hash, content_json, status FROM evolvable_asset_versions
      WHERE asset_id = $1 AND scope_type = 'system' AND status = 'approved' AND (space_id IS NULL OR space_id = $2)
      ORDER BY version DESC LIMIT 1`,
    [assetId, input.spaceId],
  );
  if (systemApproved.rows[0]) {
    trace.push(`system_baseline:${systemApproved.rows[0].id}`);
    return resolved(assetId, systemApproved.rows[0], trace, "no project/agent/user pin or space-approved version; used system baseline");
  }

  throw new HttpError(404, `No resolvable version for asset_key '${input.assetKey}' (no pin, space-approved, or system-baseline version)`);
}

async function firstReadableAssetForResolution(
  db: Queryable,
  input: ResolveEvolvableAssetVersionInput,
  rows: AssetResolveRow[],
): Promise<AssetResolveRow | null> {
  for (const row of rows) {
    if (!input.userId) {
      if (row.owner_scope_type === "system" || row.owner_scope_type === "space") return row;
      continue;
    }
    if (await canReadAssetOwnerScope(db, { spaceId: input.spaceId, userId: input.userId }, row)) return row;
  }
  return null;
}

async function resolveViaPin(
  db: Queryable,
  assetId: string,
  spaceId: string,
  scopeType: "project" | "agent" | "user" | "space",
  scopeId: string,
  trace: string[],
  input: ResolveEvolvableAssetVersionInput,
): Promise<VersionContentRow | null> {
  const pin = await db.query<{ version_id: string }>(
    `SELECT version_id FROM evolvable_asset_pins
      WHERE space_id = $1 AND asset_id = $2 AND scope_type = $3 AND scope_id = $4 AND status = 'active'
      LIMIT 1`,
    [spaceId, assetId, scopeType, scopeId],
  );
  const pinRow = pin.rows[0];
  if (!pinRow) return null;
  const version = await versionContent(db, assetId, pinRow.version_id, { approvedOnly: true });
  if (!version || !canUseVersionForResolution(version, input)) {
    throw new HttpError(422, `Active ${scopeType} pin references a missing, non-approved, or non-visible asset version`);
  }
  trace.push(`${scopeType}_pin:${version.id}`);
  return version;
}

async function versionContent(
  db: Queryable,
  assetId: string,
  versionId: string,
  options: { approvedOnly?: boolean } = {},
): Promise<VersionContentRow | null> {
  const approvedClause = options.approvedOnly ? " AND status = 'approved'" : "";
  const result = await db.query<VersionContentRow>(
    `SELECT id, space_id, scope_type, scope_id, content_ref, content_hash, content_json, status
       FROM evolvable_asset_versions
      WHERE asset_id = $1 AND id = $2${approvedClause}
      LIMIT 1`,
    [assetId, versionId],
  );
  return result.rows[0] ?? null;
}

function canUseVersionForResolution(
  version: VersionContentRow,
  input: ResolveEvolvableAssetVersionInput,
): boolean {
  if (version.space_id === null) return version.scope_type === "system";
  if (version.space_id !== input.spaceId) return false;
  if (version.scope_type === "system") return true;
  if (version.scope_type === "space") return version.scope_id === input.spaceId;
  if (version.scope_type === "project") return Boolean(input.projectId && version.scope_id === input.projectId);
  if (version.scope_type === "agent") return Boolean(input.agentId && version.scope_id === input.agentId);
  if (version.scope_type === "user") return Boolean(input.allowUserPin && input.userId && version.scope_id === input.userId);
  return false;
}

function resolved(
  assetId: string,
  version: VersionContentRow,
  trace: string[],
  fallbackReason: string | null,
): ResolvedEvolvableAssetVersion {
  return {
    assetId,
    versionId: version.id,
    contentRef: version.content_ref,
    contentHash: version.content_hash,
    contentJson: version.content_json ?? null,
    resolutionTrace: trace,
    fallbackReason,
  };
}

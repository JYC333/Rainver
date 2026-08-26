import { HttpError, objectValue, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter, canWriteProject } from "../projects/access.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";

export interface EvolvableAssetAccessRow {
  id: string;
  space_id: string | null;
  owner_scope_type: string;
  owner_scope_id: string | null;
  metadata_json?: unknown;
}

export interface NormalizedOwnerScope {
  ownerScopeType: string;
  ownerScopeId: string | null;
}

export async function normalizeAssetOwnerScopeForCreate(
  db: Queryable,
  identity: SpaceUserIdentity,
  ownerScopeType: string,
  ownerScopeId: string | null,
): Promise<NormalizedOwnerScope> {
  if (ownerScopeType === "system") {
    throw new HttpError(422, "system-owned assets are reserved for built-in catalog sync");
  }
  if (ownerScopeType === "space") {
    if (ownerScopeId && ownerScopeId !== identity.spaceId) {
      throw new HttpError(422, "space-owned asset owner_scope_id must match the active space_id when provided");
    }
    await assertSpaceOwnerOrAdmin(db, identity, "Requires space owner/admin role to create a space-owned asset");
    return { ownerScopeType, ownerScopeId: null };
  }
  if (ownerScopeType === "project") {
    if (!ownerScopeId) throw new HttpError(422, "owner_scope_id is required for project-owned assets");
    await assertProjectWriter(db, identity.spaceId, ownerScopeId, identity.userId);
    return { ownerScopeType, ownerScopeId };
  }
  if (ownerScopeType === "user") {
    if (ownerScopeId && ownerScopeId !== identity.userId) {
      throw new HttpError(403, "User-owned assets can only target the calling user");
    }
    return { ownerScopeType, ownerScopeId: identity.userId };
  }
  if (ownerScopeType === "agent") {
    if (!ownerScopeId) throw new HttpError(422, "owner_scope_id is required for agent-owned assets");
    await assertCanManageAgentScope(db, identity, ownerScopeId, "Requires agent owner or space owner/admin role to create an agent-owned asset");
    return { ownerScopeType, ownerScopeId };
  }
  throw new HttpError(422, "owner_scope_type must be one of space, project, user, agent");
}

export async function canReadAssetOwnerScope(
  db: Queryable,
  identity: SpaceUserIdentity,
  asset: EvolvableAssetAccessRow,
): Promise<boolean> {
  if (asset.space_id !== null && asset.space_id !== identity.spaceId) return false;
  if (asset.owner_scope_type === "system" || asset.owner_scope_type === "space") return true;
  if (!asset.owner_scope_id) return false;
  if (asset.owner_scope_type === "project") return canWriteProject(db, identity.spaceId, asset.owner_scope_id, identity.userId);
  if (asset.owner_scope_type === "user") return asset.owner_scope_id === identity.userId;
  if (asset.owner_scope_type === "agent") return canManageAgentScope(db, identity, asset.owner_scope_id, { missingAsFalse: true });
  return false;
}

export async function assertCanReadAssetOwnerScope(
  db: Queryable,
  identity: SpaceUserIdentity,
  asset: EvolvableAssetAccessRow,
): Promise<void> {
  if (!(await canReadAssetOwnerScope(db, identity, asset))) {
    throw new HttpError(404, "Evolvable asset not found");
  }
}

export async function assertCanWriteAssetOwnerScope(
  db: Queryable,
  identity: SpaceUserIdentity,
  asset: EvolvableAssetAccessRow,
  message = "Requires permission to manage this asset",
): Promise<void> {
  if (asset.space_id !== null && asset.space_id !== identity.spaceId) {
    throw new HttpError(404, "Evolvable asset not found");
  }
  if (asset.owner_scope_type === "system" || asset.owner_scope_type === "space") {
    await assertSpaceOwnerOrAdmin(db, identity, message);
    return;
  }
  if (!asset.owner_scope_id) throw new HttpError(404, "Evolvable asset not found");
  if (asset.owner_scope_type === "project") {
    await assertProjectWriter(db, identity.spaceId, asset.owner_scope_id, identity.userId);
    return;
  }
  if (asset.owner_scope_type === "user") {
    if (asset.owner_scope_id !== identity.userId) throw new HttpError(404, "Evolvable asset not found");
    return;
  }
  if (asset.owner_scope_type === "agent") {
    await assertCanManageAgentScope(db, identity, asset.owner_scope_id, message);
    return;
  }
  throw new HttpError(404, "Evolvable asset not found");
}

export async function normalizeVersionScopeForWrite(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeType: string,
  scopeId: string | null,
): Promise<string | null> {
  if (scopeType === "system") {
    if (scopeId) throw new HttpError(422, "system-scoped asset versions must not include scope_id");
    await assertSpaceOwnerOrAdmin(db, identity, "Requires space owner/admin role to create a system-scoped asset version");
    return null;
  }
  if (scopeType === "space") {
    if (scopeId && scopeId !== identity.spaceId) {
      throw new HttpError(422, "space-scoped asset version scope_id must match the active space_id");
    }
    await assertSpaceOwnerOrAdmin(db, identity, "Requires space owner/admin role to create a space-scoped asset version");
    return identity.spaceId;
  }
  if (!scopeId) throw new HttpError(422, `scope_id is required for ${scopeType}-scoped asset versions`);
  if (scopeType === "project") {
    await assertProjectWriter(db, identity.spaceId, scopeId, identity.userId);
    return scopeId;
  }
  if (scopeType === "user") {
    if (scopeId !== identity.userId) {
      throw new HttpError(403, "User-scoped asset versions can only target the calling user");
    }
    return scopeId;
  }
  if (scopeType === "agent") {
    await assertCanManageAgentScope(db, identity, scopeId, "Requires agent owner or space owner/admin role to create an agent-scoped asset version");
    return scopeId;
  }
  throw new HttpError(422, "scope_type must be one of system, space, project, user, agent");
}

export function assertAssetAllowsTargetScope(
  asset: EvolvableAssetAccessRow,
  identity: SpaceUserIdentity,
  scopeType: string,
  scopeId: string | null,
): void {
  if (asset.owner_scope_type === "user") {
    if (scopeType !== "user" || asset.owner_scope_id !== identity.userId || scopeId !== identity.userId) {
      throw new HttpError(403, "User-owned assets can only create user-scoped versions and pins for the owner");
    }
    return;
  }
  if (scopeType === "user" && !assetAllowsUserScope(asset, identity.userId)) {
    throw new HttpError(403, "User-scoped overrides are not allowed for this asset");
  }
}

export function assetAllowsUserScope(asset: EvolvableAssetAccessRow, userId: string): boolean {
  if (asset.owner_scope_type === "user" && asset.owner_scope_id === userId) return true;
  return objectValue(asset.metadata_json).allow_user_override === true;
}

export async function canViewScopedRef(
  db: Queryable,
  identity: SpaceUserIdentity,
  scopeType: string,
  scopeId: string | null,
): Promise<boolean> {
  if (scopeType === "system" || scopeType === "space") return true;
  if (!scopeId) return false;
  if (scopeType === "project") return canWriteProject(db, identity.spaceId, scopeId, identity.userId);
  if (scopeType === "user") return scopeId === identity.userId;
  if (scopeType === "agent") return canManageAgentScope(db, identity, scopeId, { missingAsFalse: true });
  return false;
}

export async function assertCanPinScope(db: Queryable, identity: SpaceUserIdentity, scopeType: string, scopeId: string): Promise<void> {
  if (scopeType === "project") {
    await assertProjectWriter(db, identity.spaceId, scopeId, identity.userId);
    return;
  }
  if (scopeType === "space") {
    if (scopeId !== identity.spaceId) {
      throw new HttpError(422, "space pin scope_id must match the active space_id");
    }
    await assertSpaceOwnerOrAdmin(db, identity, "Requires space owner/admin role to pin a space-scoped asset version");
    return;
  }
  if (scopeType === "user") {
    if (scopeId !== identity.userId) {
      throw new HttpError(403, "User-scoped asset pins can only target the calling user");
    }
    return;
  }
  if (scopeType === "agent") {
    await assertCanManageAgentScope(db, identity, scopeId, "Requires agent owner or space owner/admin role to pin an agent-scoped asset version");
  }
}

export async function assertCanManageAgentScope(
  db: Queryable,
  identity: SpaceUserIdentity,
  agentId: string,
  message: string,
): Promise<void> {
  if (!(await canManageAgentScope(db, identity, agentId))) {
    throw new HttpError(403, message);
  }
}

export async function canManageAgentScope(
  db: Queryable,
  identity: SpaceUserIdentity,
  agentId: string,
  options: { missingAsFalse?: boolean } = {},
): Promise<boolean> {
  const agent = await db.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id
       FROM agents
      WHERE id = $1 AND space_id = $2 AND status = 'active'
      LIMIT 1`,
    [agentId, identity.spaceId],
  );
  const row = agent.rows[0];
  if (!row) {
    if (options.missingAsFalse) return false;
    throw new HttpError(404, "Agent not found");
  }
  if (row.owner_user_id === identity.userId) return true;
  return isSpaceOwnerOrAdmin(await activeSpaceRole(db, identity));
}

export async function assertSpaceOwnerOrAdmin(db: Queryable, identity: SpaceUserIdentity, message: string): Promise<void> {
  if (!isSpaceOwnerOrAdmin(await activeSpaceRole(db, identity))) {
    throw new HttpError(403, message);
  }
}

async function activeSpaceRole(db: Queryable, identity: SpaceUserIdentity): Promise<string | undefined> {
  const membership = await db.query<{ role: string }>(
    `SELECT role FROM space_memberships WHERE space_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1`,
    [identity.spaceId, identity.userId],
  );
  return membership.rows[0]?.role;
}

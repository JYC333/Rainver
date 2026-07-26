import { randomUUID } from "node:crypto";
import type {
  ContextPack,
  ContextProfile,
  ContextProfileScope,
  ContextProfileStatus,
  ContextRoutingManifest,
} from "@agent-space/protocol" with { "resolution-mode": "import" };
import type { ServerConfig } from "../../config";
import { getDbPool } from "../../db/pool";
import {
  dateIso,
  HttpError,
  objectValue,
  type Queryable,
  type SpaceUserIdentity,
} from "../routeUtils/common";
import {
  DEFAULT_CONTEXT_ROUTING_MANIFEST,
  invalidContextRoutingManifestEntries,
  mergeContextRoutingManifests,
  selectAgentDocPaths,
} from "./routingManifest";
import type { RunContextRecord } from "./repository";

interface ContextProfileRow {
  id: string;
  space_id: string;
  scope_type: ContextProfileScope;
  scope_id: string | null;
  status: ContextProfileStatus;
  version: number | string;
  context_pack_json: unknown;
  routing_manifest_json: unknown;
  created_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const CONTEXT_PROFILE_COLUMNS = `id, space_id, scope_type, scope_id, status, version,
  context_pack_json, routing_manifest_json, created_by_user_id, created_at, updated_at`;

export class PgContextProfileRepository {
  constructor(private readonly db: Queryable) {}

  static fromConfig(config: ServerConfig): PgContextProfileRepository {
    if (!config.databaseUrl) {
      throw new HttpError(502, "Context profile repository requires SERVER_DATABASE_URL");
    }
    return new PgContextProfileRepository(getDbPool(config.databaseUrl));
  }

  async list(
    identity: SpaceUserIdentity,
    filters: {
      scopeType?: string | null;
      scopeId?: string | null;
      status?: string | null;
    } = {},
  ): Promise<ContextProfile[]> {
    const params: unknown[] = [identity.spaceId];
    const where = ["space_id = $1"];
    if (filters.scopeType) {
      ensureScopeType(filters.scopeType);
      params.push(filters.scopeType);
      where.push(`scope_type = $${params.length}`);
    }
    if (filters.scopeId) {
      params.push(filters.scopeId);
      where.push(`scope_id = $${params.length}`);
    }
    const status = filters.status ?? "active";
    ensureStatus(status);
    params.push(status);
    where.push(`status = $${params.length}`);
    const rows = await this.db.query<ContextProfileRow>(
      `SELECT ${CONTEXT_PROFILE_COLUMNS}
         FROM context_profiles
        WHERE ${where.join(" AND ")}
        ORDER BY scope_type ASC, updated_at DESC`,
      params,
    );
    return rows.rows.map(contextProfileOut);
  }

  async upsert(
    identity: SpaceUserIdentity,
    body: {
      scope_type: ContextProfileScope;
      scope_id?: string | null;
      status: ContextProfileStatus;
      version: number;
      context_pack_json: ContextPack;
      routing_manifest_json: ContextRoutingManifest;
    },
  ): Promise<ContextProfile> {
    const scopeType = ensureScopeType(body.scope_type);
    const scopeId = normalizeScopeId(scopeType, body.scope_id ?? null, identity.userId);
    const status = ensureStatus(body.status);
    assertRoutingManifestSafe(body.routing_manifest_json);
    await this.ensureScopeExists(identity, scopeType, scopeId);
    const now = new Date().toISOString();
    if (status === "archived") {
      const archived = await this.db.query<ContextProfileRow>(
        `UPDATE context_profiles
            SET status = 'archived', updated_at = $4
          WHERE space_id = $1 AND scope_type = $2
            AND COALESCE(scope_id, '') = COALESCE($3::varchar, '')
            AND status = 'active'
          RETURNING ${CONTEXT_PROFILE_COLUMNS}`,
        [identity.spaceId, scopeType, scopeId, now],
      );
      if (!archived.rows[0]) {
        throw new HttpError(404, "Active context profile not found");
      }
      return contextProfileOut(archived.rows[0]);
    }

    const updated = await this.db.query<ContextProfileRow>(
      `UPDATE context_profiles
          SET version = $4,
              context_pack_json = $5::jsonb,
              routing_manifest_json = $6::jsonb,
              updated_at = $7
        WHERE space_id = $1 AND scope_type = $2
          AND COALESCE(scope_id, '') = COALESCE($3::varchar, '')
          AND status = 'active'
        RETURNING ${CONTEXT_PROFILE_COLUMNS}`,
      [
        identity.spaceId,
        scopeType,
        scopeId,
        body.version,
        JSON.stringify(body.context_pack_json ?? {}),
        JSON.stringify(body.routing_manifest_json ?? {}),
        now,
      ],
    );
    if (updated.rows[0]) return contextProfileOut(updated.rows[0]);

    const inserted = await this.db.query<ContextProfileRow>(
      `INSERT INTO context_profiles (
         id, space_id, scope_type, scope_id, status, version,
         context_pack_json, routing_manifest_json, created_by_user_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'active', $5,
         $6::jsonb, $7::jsonb, $8,
         $9, $9
       )
       RETURNING ${CONTEXT_PROFILE_COLUMNS}`,
      [
        randomUUID(),
        identity.spaceId,
        scopeType,
        scopeId,
        body.version,
        JSON.stringify(body.context_pack_json ?? {}),
        JSON.stringify(body.routing_manifest_json ?? {}),
        identity.userId,
        now,
      ],
    );
    return contextProfileOut(inserted.rows[0]!);
  }

  async getFolderRouting(
    identity: SpaceUserIdentity,
    projectFolderId: string,
  ): Promise<{
    project_folder_id: string;
    profiles: ContextProfile[];
    effective_manifest: ContextRoutingManifest;
    selected_agent_doc_paths: string[];
  }> {
    await this.ensureScopeExists(identity, "project_folder", projectFolderId);
    const profiles = await this.loadProfilesForScopes(identity.spaceId, [
      { scopeType: "space", scopeId: null },
      { scopeType: "project_folder", scopeId: projectFolderId },
    ]);
    const effective = mergeContextRoutingManifests([
      DEFAULT_CONTEXT_ROUTING_MANIFEST,
      ...profiles.map((profile) => profile.routing_manifest_json),
    ]);
    return {
      project_folder_id: projectFolderId,
      profiles,
      effective_manifest: effective,
      selected_agent_doc_paths: selectAgentDocPaths({ manifest: effective }),
    };
  }

  async loadEffectiveManifestForRun(
    run: RunContextRecord,
    userId: string | null,
  ): Promise<ContextRoutingManifest> {
    const scopes: Array<{ scopeType: ContextProfileScope; scopeId: string | null }> = [
      { scopeType: "space", scopeId: null },
    ];
    if (run.project_id) scopes.push({ scopeType: "project", scopeId: run.project_id });
    if (run.project_folder_id) scopes.push({ scopeType: "project_folder", scopeId: run.project_folder_id });
    if (run.agent_id) scopes.push({ scopeType: "agent", scopeId: run.agent_id });
    if (userId) scopes.push({ scopeType: "user", scopeId: userId });
    const profiles = await this.loadProfilesForScopes(run.space_id, scopes);
    return mergeContextRoutingManifests([
      DEFAULT_CONTEXT_ROUTING_MANIFEST,
      ...profiles.map((profile) => profile.routing_manifest_json),
    ]);
  }

  private async loadProfilesForScopes(
    spaceId: string,
    scopes: readonly { scopeType: ContextProfileScope; scopeId: string | null }[],
  ): Promise<ContextProfile[]> {
    if (scopes.length === 0) return [];
    const predicates: string[] = [];
    const params: unknown[] = [spaceId];
    for (const scope of scopes) {
      params.push(scope.scopeType, scope.scopeId);
      predicates.push(`(scope_type = $${params.length - 1} AND COALESCE(scope_id, '') = COALESCE($${params.length}::varchar, ''))`);
    }
    const rows = await this.db.query<ContextProfileRow>(
      `SELECT ${CONTEXT_PROFILE_COLUMNS}
         FROM context_profiles
        WHERE space_id = $1
          AND status = 'active'
          AND (${predicates.join(" OR ")})
        ORDER BY CASE scope_type
          WHEN 'space' THEN 10
          WHEN 'project' THEN 20
          WHEN 'project_folder' THEN 30
          WHEN 'agent' THEN 40
          WHEN 'user' THEN 50
          ELSE 100
        END ASC, updated_at ASC`,
      params,
    );
    return rows.rows.map(contextProfileOut);
  }

  private async ensureScopeExists(
    identity: SpaceUserIdentity,
    scopeType: ContextProfileScope,
    scopeId: string | null,
  ): Promise<void> {
    if (scopeType === "space") return;
    if (!scopeId) throw new HttpError(422, "scope_id is required for this scope_type");
    if (scopeType === "user") {
      if (scopeId !== identity.userId) throw new HttpError(403, "user context profile scope must be the current user");
      return;
    }
    const table =
      scopeType === "project_folder"
        ? "project_folders"
        : scopeType === "project"
          ? "projects"
          : scopeType === "agent"
            ? "agents"
            : null;
    if (!table) throw new HttpError(422, "unsupported scope_type");
    const statusPredicate =
      scopeType === "project"
        ? "AND status <> 'deleted'"
        : scopeType === "project_folder"
          ? "AND status <> 'archived'"
          : "AND status <> 'archived'";
    const found = await this.db.query<{ id: string }>(
      `SELECT id FROM ${table}
        WHERE id = $1 AND space_id = $2 ${statusPredicate}
        LIMIT 1`,
      [scopeId, identity.spaceId],
    );
    if (!found.rows[0]) throw new HttpError(404, `${scopeType} not found`);
  }
}

function assertRoutingManifestSafe(manifest: ContextRoutingManifest): void {
  const invalid = invalidContextRoutingManifestEntries(manifest);
  if (invalid.length > 0) {
    throw new HttpError(422, `routing_manifest_json contains invalid .agent doc path or glob: ${invalid[0]}`);
  }
}

function contextProfileOut(row: ContextProfileRow): ContextProfile {
  return {
    id: row.id,
    space_id: row.space_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    status: row.status,
    version: Number(row.version),
    context_pack_json: objectValue(row.context_pack_json) as ContextPack,
    routing_manifest_json: objectValue(row.routing_manifest_json) as ContextRoutingManifest,
    created_by_user_id: row.created_by_user_id,
    created_at: dateIso(row.created_at) ?? "",
    updated_at: dateIso(row.updated_at) ?? "",
  };
}

function ensureScopeType(value: string): ContextProfileScope {
  if (["space", "project", "project_folder", "agent", "user"].includes(value)) {
    return value as ContextProfileScope;
  }
  throw new HttpError(422, "scope_type must be one of space, project, project_folder, agent, user");
}

function ensureStatus(value: string): ContextProfileStatus {
  if (value === "active" || value === "archived") return value;
  throw new HttpError(422, "status must be active or archived");
}

function normalizeScopeId(
  scopeType: ContextProfileScope,
  scopeId: string | null,
  userId: string,
): string | null {
  if (scopeType === "space") {
    if (scopeId) throw new HttpError(422, "space context profile must not include scope_id");
    return null;
  }
  if (scopeType === "user" && !scopeId) return userId;
  if (!scopeId) throw new HttpError(422, "scope_id is required for this scope_type");
  return scopeId;
}

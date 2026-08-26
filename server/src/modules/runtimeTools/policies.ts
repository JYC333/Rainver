import { randomUUID } from "node:crypto";
import { BUILTIN_RUNTIME_ADAPTER_SPECS, type RuntimeAdapterType } from "../runtimeAdapters/index.js";
import { HttpError, dateIso, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { isSpaceOwnerOrAdmin } from "../access/roles.js";
import { RuntimeToolRegistry } from "./service.js";

export interface SpaceRuntimeToolPolicy {
  id: string;
  space_id: string;
  runtime: string;
  enabled: boolean;
  default_version: string | null;
  allowed_versions: string[];
  updated_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SpaceRuntimeToolPolicyRow {
  id: string;
  space_id: string;
  runtime: string;
  enabled: boolean;
  default_version: string | null;
  allowed_versions_json: unknown;
  updated_by_user_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export function isCliRuntimeTool(runtime: string | null | undefined): boolean {
  if (!runtime) return false;
  const spec = BUILTIN_RUNTIME_ADAPTER_SPECS[runtime as RuntimeAdapterType];
  return Boolean(
    spec && spec.runtime_kind === "local_cli" && spec.implementation_status === "implemented",
  );
}

function cleanRuntime(runtime: string): string {
  if (!isCliRuntimeTool(runtime)) {
    throw new HttpError(404, `Runtime tool '${runtime}' is not configurable`);
  }
  return runtime;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            .map((item) => item.trim()),
        ),
      ]
    : [];
}

function out(row: SpaceRuntimeToolPolicyRow): SpaceRuntimeToolPolicy {
  return {
    id: row.id,
    space_id: row.space_id,
    runtime: row.runtime,
    enabled: row.enabled,
    default_version: row.default_version,
    allowed_versions: stringArray(row.allowed_versions_json),
    updated_by_user_id: row.updated_by_user_id,
    created_at: dateIso(row.created_at)!,
    updated_at: dateIso(row.updated_at)!,
  };
}

export class RuntimeToolPolicyRepository {
  constructor(private readonly db: Queryable) {}

  async list(spaceId: string): Promise<SpaceRuntimeToolPolicy[]> {
    const rows = await this.db.query<SpaceRuntimeToolPolicyRow>(
      `SELECT id, space_id, runtime, enabled, default_version,
              allowed_versions_json, updated_by_user_id, created_at, updated_at
         FROM space_runtime_tool_policies
        WHERE space_id = $1
        ORDER BY runtime ASC`,
      [spaceId],
    );
    return rows.rows.map(out);
  }

  async get(spaceId: string, runtime: string): Promise<SpaceRuntimeToolPolicy | null> {
    const rows = await this.db.query<SpaceRuntimeToolPolicyRow>(
      `SELECT id, space_id, runtime, enabled, default_version,
              allowed_versions_json, updated_by_user_id, created_at, updated_at
         FROM space_runtime_tool_policies
        WHERE space_id = $1 AND runtime = $2
        LIMIT 1`,
      [spaceId, cleanRuntime(runtime)],
    );
    return rows.rows[0] ? out(rows.rows[0]) : null;
  }

  async upsert(
    identity: SpaceUserIdentity,
    runtime: string,
    input: {
      enabled?: boolean;
      default_version?: string | null;
      allowed_versions?: string[];
    },
  ): Promise<SpaceRuntimeToolPolicy> {
    const clean = cleanRuntime(runtime);
    await this.requireSpaceAdmin(identity.userId, identity.spaceId);
    const allowedVersions = input.allowed_versions ?? [];
    const now = new Date().toISOString();
    const rows = await this.db.query<SpaceRuntimeToolPolicyRow>(
      `INSERT INTO space_runtime_tool_policies
         (id, space_id, runtime, enabled, default_version, allowed_versions_json,
          updated_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8)
       ON CONFLICT (space_id, runtime)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         default_version = EXCLUDED.default_version,
         allowed_versions_json = EXCLUDED.allowed_versions_json,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = EXCLUDED.updated_at
       RETURNING id, space_id, runtime, enabled, default_version,
                 allowed_versions_json, updated_by_user_id, created_at, updated_at`,
      [
        randomUUID(),
        identity.spaceId,
        clean,
        input.enabled ?? true,
        input.default_version ?? null,
        JSON.stringify(allowedVersions),
        identity.userId,
        now,
      ],
    );
    return out(rows.rows[0]!);
  }

  async requireSpaceAdmin(userId: string, spaceId: string): Promise<void> {
    const rows = await this.db.query<{ role: string }>(
      `SELECT role
         FROM space_memberships
        WHERE user_id = $1 AND space_id = $2 AND status = 'active'
        LIMIT 1`,
      [userId, spaceId],
    );
    const role = rows.rows[0]?.role;
    if (!isSpaceOwnerOrAdmin(role)) {
      throw new HttpError(403, "Requires space admin role");
    }
  }
}

export async function resolveRuntimeToolVersionForSpace(
  db: Queryable,
  registry: RuntimeToolRegistry,
  spaceId: string,
  runtime: string,
  requestedVersion?: string | null,
): Promise<string> {
  const clean = cleanRuntime(runtime);
  const repository = new RuntimeToolPolicyRepository(db);
  const policy = await repository.get(spaceId, clean);
  if (!policy || !policy.enabled) {
    throw new HttpError(409, `Runtime tool '${clean}' is not enabled for this space`);
  }
  const status = await registry.status(clean);
  const installedVersions = status.installed_versions.filter(version => version.installed).map(version => version.version);
  const allowedByPolicy = policy?.allowed_versions.length
    ? installedVersions.filter(version => policy.allowed_versions.includes(version))
    : installedVersions;
  const requested = requestedVersion?.trim() || null;
  const candidate = requested ?? policy?.default_version ?? status.active_version ?? allowedByPolicy[0] ?? null;
  if (!candidate) {
    throw new HttpError(409, `Runtime tool '${clean}' has no installed version`);
  }
  if (!installedVersions.includes(candidate)) {
    throw new HttpError(409, `Runtime tool '${clean}' version '${candidate}' is not installed`);
  }
  if (!allowedByPolicy.includes(candidate)) {
    throw new HttpError(403, `Runtime tool '${clean}' version '${candidate}' is not allowed in this space`);
  }
  return candidate;
}

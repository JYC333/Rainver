import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { HttpError } from "../routeUtils/common.js";
import { isStale } from "../hosts/repository.js";
import type { AmbientSessionCount, HostExecutionTarget, HostExecutionTargetAdapter } from "@rainver/protocol";
import { isGitRepo, runGit } from "@rainver/folder-read";
import { normalizeHostCapabilities } from "../hosts/capabilities.js";
import { getLocalCliRuntimeAdapterSpec, listRuntimeAdapterSpecs } from "../runtimeAdapters/index.js";

/**
 * execution-topology-and-project-control-plane-plan.md P1 / D2: one
 * physical checkout of a logical `project_folders` row. See
 * `server/src/db/schema/workspaceLocations.ts` for the persisted runtime
 * readiness fact reported by the owning execution host.
 */
export interface WorkspaceLocationRow {
  id: string;
  space_id: string;
  project_folder_id: string;
  execution_host_id: string;
  execution_host_kind: string;
  display_path: string | null;
  root_path: string | null;
  branch: string | null;
  git_head: string | null;
  dirty: boolean | null;
  execution_ready: boolean;
  status: string;
  preferred: boolean;
  last_seen_at: string | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface WorkspaceLocationOut {
  id: string;
  project_folder_id: string;
  execution_host_id: string;
  execution_host_kind: string;
  display_path: string | null;
  root_path: string | null;
  branch: string | null;
  git_head: string | null;
  dirty: boolean | null;
  status: string;
  preferred: boolean;
  execution_ready: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  host_name: string | null;
  host_online: boolean;
  host_owner_is_me: boolean;
}

export interface PreferredLocationWithHost extends WorkspaceLocationRow {
  host_name: string;
  host_owner_user_id: string | null;
  host_status: string;
  last_heartbeat_at: string | null;
  host_online: boolean;
}

/**
 * The host daemon's legacy workspace-list contract. A daemon lists logical
 * workspace registrations, while execution is now backed by a Location row;
 * keep the old field names and join the Folder identity fields here rather
 * than leaking the internal Location vocabulary onto the daemon wire.
 */
export interface HostWorkspaceOut {
  id: string;
  project_id: string;
  name: string;
  display_path: string | null;
  host_kind: string;
  root_path: string | null;
  created_at: string;
}

const COLUMNS = `id, space_id, project_folder_id, execution_host_id, execution_host_kind,
  display_path, root_path, branch, git_head, dirty, execution_ready, status, preferred, last_seen_at,
  created_at, updated_at`;

export class PgWorkspaceLocationRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Creates a Location for a Folder that already exists. The first Location
   * a Folder ever gets is created `preferred` automatically (there is
   * nothing else to prefer); a later one is not, unless the caller asks.
   */
  async create(input: {
    spaceId: string;
    projectFolderId: string;
    executionHostId: string;
    executionHostKind: "server" | "remote";
    rootPath?: string | null;
    displayPath?: string | null;
    preferred?: boolean;
  }): Promise<WorkspaceLocationRow> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const existing = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_locations WHERE project_folder_id = $1`,
      [input.projectFolderId],
    );
    const preferred = input.preferred ?? Number(existing.rows[0]?.count ?? "0") === 0;
    if (preferred) await this.clearPreferred(input.projectFolderId);
    const row = await this.db.query<WorkspaceLocationRow>(
      `INSERT INTO workspace_locations (
         id, space_id, project_folder_id, execution_host_id, execution_host_kind,
         root_path, display_path, execution_ready, status, preferred, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'active', $8, $9, $9)
       RETURNING ${COLUMNS}`,
      [id, input.spaceId, input.projectFolderId, input.executionHostId, input.executionHostKind, input.rootPath ?? null, input.displayPath ?? null, preferred, now],
    );
    return row.rows[0]!;
  }

  async listForFolder(identity: SpaceUserIdentity, folderId: string): Promise<WorkspaceLocationOut[]> {
    const result = await this.db.query<WorkspaceLocationRow & { host_status: string; last_heartbeat_at: string | null; host_name: string; host_owner_user_id: string | null }>(
      `SELECT wl.*, h.status AS host_status, h.last_heartbeat_at, h.name AS host_name, h.owner_user_id AS host_owner_user_id
         FROM workspace_locations wl
         JOIN hosts h ON h.id = wl.execution_host_id
        WHERE wl.project_folder_id = $1 AND wl.space_id = $2 AND wl.status = 'active'
        ORDER BY wl.preferred DESC, wl.created_at ASC`,
      [folderId, identity.spaceId],
    );
    return result.rows.map((row) => locationToOut(row, identity.userId));
  }

  /** Selector read model: only the caller's live remote hosts and this Project's registered Locations. */
  async listHostExecutionTargets(
    spaceId: string,
    projectId: string | null,
    userId: string,
  ): Promise<HostExecutionTarget[]> {
    const result = await this.db.query<{
      host_id: string;
      host_name: string;
      host_status: string;
      last_heartbeat_at: string | null;
      capabilities_json: unknown;
      location_id: string | null;
      project_folder_id: string | null;
      folder_name: string | null;
      display_path: string | null;
      execution_ready: boolean | null;
    }>(
      `SELECT host.id AS host_id, host.name AS host_name, host.status AS host_status,
              host.last_heartbeat_at, host.capabilities_json,
              location.id AS location_id, location.project_folder_id,
              folder.name AS folder_name, location.display_path,
              location.execution_ready
         FROM hosts host
         LEFT JOIN workspace_locations location
           ON location.execution_host_id = host.id
          AND location.status = 'active'
          AND $3::varchar IS NOT NULL
         LEFT JOIN project_folders folder
           ON folder.id = location.project_folder_id
          AND folder.status = 'active'
          AND folder.space_id = $2
          AND folder.project_id = $3
        WHERE host.owner_user_id = $1
          AND host.kind = 'remote'
          AND host.status <> 'revoked'
          AND ($3::varchar IS NULL OR folder.id IS NOT NULL)
        ORDER BY host.name ASC, folder.name ASC NULLS LAST, location.created_at ASC NULLS LAST`,
      [userId, spaceId, projectId],
    );
    const grouped = new Map<string, HostExecutionTarget & { capabilities_json: unknown }>();
    for (const row of result.rows) {
      let target = grouped.get(row.host_id);
      if (!target) {
        const created = {
          host_id: row.host_id,
          host_name: row.host_name,
          host_online: row.host_status === "online" && !isStale(row.last_heartbeat_at),
          locations: [],
          adapters: [],
          managed_workspace_available: true,
          capabilities_json: row.capabilities_json,
        };
        grouped.set(row.host_id, created);
        target = created;
      }
      if (row.location_id && row.project_folder_id && row.folder_name && row.execution_ready !== null) {
        target.locations.push({
          id: row.location_id,
          project_folder_id: row.project_folder_id,
          folder_name: row.folder_name,
          display_path: row.display_path,
          execution_ready: row.execution_ready,
        });
      }
    }
    const adapters = listRuntimeAdapterSpecs()
      .map((spec) => getLocalCliRuntimeAdapterSpec(spec.adapter_type))
      .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))
      .filter((spec) => spec.implementation_status === "implemented" && spec.invocation.protocol === "acp");
    for (const target of grouped.values()) {
      const capabilities = normalizeHostCapabilities(target.capabilities_json);
      target.adapters = adapters.flatMap<HostExecutionTargetAdapter>((spec) => {
        const installations = capabilities.installations[spec.adapter_type];
        if (!installations?.length) return [];
        return [{
          adapter_type: spec.adapter_type,
          display_name: spec.display_name,
          installations: installations.map(({ id, version, logged_in }) => ({ id, version, logged_in })),
        }];
      });
    }
    return [...grouped.values()]
      .filter((target) => target.host_online)
      .map(({ capabilities_json: _capabilities, ...target }) => target);
  }

  async get(identity: SpaceUserIdentity, folderId: string, locationId: string): Promise<WorkspaceLocationOut | null> {
    const result = await this.db.query<WorkspaceLocationRow & { host_status: string; last_heartbeat_at: string | null; host_name: string; host_owner_user_id: string | null }>(
      `SELECT wl.*, h.status AS host_status, h.last_heartbeat_at, h.name AS host_name, h.owner_user_id AS host_owner_user_id
         FROM workspace_locations wl
         JOIN hosts h ON h.id = wl.execution_host_id
        WHERE wl.id = $1 AND wl.project_folder_id = $2 AND wl.space_id = $3
        LIMIT 1`,
      [locationId, folderId, identity.spaceId],
    );
    const row = result.rows[0];
    return row ? locationToOut(row, identity.userId) : null;
  }

  /** Row-level lookup for internal callers that already hold a checked folder/space id (dispatch, orchestration). */
  async getRow(locationId: string): Promise<WorkspaceLocationRow | null> {
    const result = await this.db.query<WorkspaceLocationRow>(`SELECT ${COLUMNS} FROM workspace_locations WHERE id = $1 LIMIT 1`, [locationId]);
    return result.rows[0] ?? null;
  }

  async getPreferred(folderId: string): Promise<WorkspaceLocationRow | null> {
    const result = await this.db.query<WorkspaceLocationRow>(
      `SELECT ${COLUMNS} FROM workspace_locations WHERE project_folder_id = $1 AND status = 'active' AND preferred = true LIMIT 1`,
      [folderId],
    );
    return result.rows[0] ?? null;
  }

  async setPreferred(identity: SpaceUserIdentity, folderId: string, locationId: string): Promise<boolean> {
    const target = await this.db.query<{ id: string }>(
      `SELECT id FROM workspace_locations WHERE id = $1 AND project_folder_id = $2 AND space_id = $3 AND status = 'active'`,
      [locationId, folderId, identity.spaceId],
    );
    if (!target.rows[0]) return false;
    await this.clearPreferred(folderId);
    await this.db.query(
      `UPDATE workspace_locations SET preferred = true, updated_at = $2 WHERE id = $1`,
      [locationId, new Date().toISOString()],
    );
    return true;
  }

  private async clearPreferred(folderId: string): Promise<void> {
    await this.db.query(`UPDATE workspace_locations SET preferred = false WHERE project_folder_id = $1 AND preferred = true`, [folderId]);
  }

  /** `workspace list`: every active logical workspace registered under this host. */
  async listForHost(hostId: string): Promise<HostWorkspaceOut[]> {
    const result = await this.db.query<HostWorkspaceOut & { created_at: unknown }>(
      `SELECT wl.id, pf.project_id, pf.name, wl.display_path,
              wl.execution_host_kind AS host_kind, wl.root_path, wl.created_at
         FROM workspace_locations wl
         JOIN project_folders pf ON pf.id = wl.project_folder_id AND pf.space_id = wl.space_id
         JOIN hosts h ON h.id = wl.execution_host_id
        WHERE wl.execution_host_id = $1 AND wl.status = 'active' AND pf.status = 'active'
        ORDER BY wl.created_at ASC`,
      [hostId],
    );
    return result.rows.map((row) => ({ ...row, created_at: dateIso(row.created_at) }));
  }

  /** `workspace remove`: scoped to the calling host's own token, exactly like `unregisterForHost` before P1. */
  async unregisterForHost(hostId: string, locationId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM workspace_locations WHERE id = $1 AND execution_host_id = $2 AND execution_host_kind = 'remote'`,
      [locationId, hostId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Everything the dispatch endpoint (and any authorization check keyed off
   * "where does this Run execute") needs, in one query. Replaces
   * `hosts/repository.ts`'s folder-keyed `resolveDispatchTarget` — a Folder
   * no longer determines a single host, a Location does.
   */
  async resolveDispatchTarget(locationId: string): Promise<{
    location_id: string;
    project_folder_id: string;
    space_id: string;
    project_id: string;
    execution_host_kind: string;
    host_id: string;
    host_owner_user_id: string | null;
    host_online: boolean;
    execution_ready: boolean;
    capabilities_json: Record<string, unknown> | null;
  } | null> {
    const result = await this.db.query<{
      location_id: string;
      project_folder_id: string;
      space_id: string;
      project_id: string;
      execution_host_kind: string;
      host_id: string;
      host_owner_user_id: string | null;
      host_status: string;
      last_heartbeat_at: string | null;
      execution_ready: boolean;
      capabilities_json: Record<string, unknown> | null;
    }>(
      `SELECT wl.id AS location_id, wl.project_folder_id, wl.space_id, pf.project_id,
              wl.execution_host_kind, h.id AS host_id, h.owner_user_id AS host_owner_user_id,
              h.status AS host_status, h.last_heartbeat_at, h.capabilities_json,
              wl.execution_ready
         FROM workspace_locations wl
         JOIN project_folders pf ON pf.id = wl.project_folder_id
         JOIN hosts h ON h.id = wl.execution_host_id
        WHERE wl.id = $1 AND wl.status = 'active'
        LIMIT 1`,
      [locationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const hostOnline = row.execution_host_kind === "server" || (row.host_status === "online" && !isStale(row.last_heartbeat_at));
    return { ...row, host_online: hostOnline };
  }

  /** Server-host only — reuses the same `isGitRepo`/`runGit` helpers the pre-P1 Folder-level git endpoints used. */
  async refreshGitStatus(location: Pick<WorkspaceLocationRow, "id" | "root_path" | "execution_host_kind">, workspaceRoot: string): Promise<void> {
    if (location.execution_host_kind !== "server") return;
    const root = locationAbsoluteRoot(location, workspaceRoot);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) {
      await this.db.query(
        `UPDATE workspace_locations SET execution_ready = false, branch = NULL, git_head = NULL,
                dirty = NULL, last_seen_at = $2, updated_at = $2 WHERE id = $1`,
        [location.id, new Date().toISOString()],
      );
      return;
    }
    if (!(await isGitRepo(root))) {
      await this.db.query(
        `UPDATE workspace_locations SET execution_ready = true, branch = NULL, git_head = NULL,
                dirty = NULL, last_seen_at = $2, updated_at = $2 WHERE id = $1`,
        [location.id, new Date().toISOString()],
      );
      return;
    }
    const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], root, 10_000)).stdout.trim() || null;
    const head = (await runGit(["rev-parse", "HEAD"], root, 10_000)).stdout.trim() || null;
    const status = await runGit(["status", "--porcelain"], root, 10_000);
    await this.db.query(
      `UPDATE workspace_locations SET branch = $2, git_head = $3, dirty = $4, execution_ready = true,
              last_seen_at = $5, updated_at = $5 WHERE id = $1`,
      [location.id, branch, head, status.stdout.trim().length > 0, new Date().toISOString()],
    );
  }

  /** Refresh migrated server Locations during server startup as well as after a new Folder is created. */
  async refreshServerLocations(workspaceRoot: string): Promise<void> {
    const result = await this.db.query<WorkspaceLocationRow>(
      `SELECT ${COLUMNS}
         FROM workspace_locations
        WHERE execution_host_kind = 'server' AND status = 'active'
        ORDER BY created_at ASC`,
    );
    for (const location of result.rows) {
      await this.refreshGitStatus(location, workspaceRoot);
    }
  }

  /**
   * Records what the daemon observed about each Location's ambient CLI
   * history. Counts only — no content ever reaches this path, and nothing
   * here decides whether an import may happen; that is the Location's
   * `ambient_import_policy_json`, which only a person writes.
   */
  async recordAmbientSessionCounts(hostId: string, counts: readonly AmbientSessionCount[]): Promise<void> {
    const byLocation = new Map<string, AmbientSessionCount[]>();
    for (const count of counts) {
      const existing = byLocation.get(count.location_id);
      if (existing) existing.push(count);
      else byLocation.set(count.location_id, [count]);
    }
    for (const [locationId, locationCounts] of byLocation) {
      await this.db.query(
        `UPDATE workspace_locations
            SET ambient_session_counts_json = $3::jsonb, updated_at = now()
          WHERE id = $1 AND execution_host_id = $2 AND execution_host_kind = 'remote' AND status = 'active'`,
        [locationId, hostId, JSON.stringify(locationCounts)],
      );
    }
  }

  /** Applies the complete location report from one remote daemon heartbeat. */
  async recordDaemonHeartbeat(hostId: string, reports: WorkspaceLocationHeartbeat[]): Promise<void> {
    const seen = reports.map((report) => report.location_id);
    if (seen.length === 0) {
      await this.db.query(
        `UPDATE workspace_locations
            SET execution_ready = false, updated_at = now()
          WHERE execution_host_id = $1 AND execution_host_kind = 'remote' AND status = 'active'`,
        [hostId],
      );
      return;
    }
    for (const report of reports) {
      await this.db.query(
        `UPDATE workspace_locations
            SET branch = $3, git_head = $4, dirty = $5, execution_ready = $6,
                last_seen_at = now(), updated_at = now()
          WHERE id = $1 AND execution_host_id = $2 AND execution_host_kind = 'remote' AND status = 'active'`,
        [report.location_id, hostId, report.branch ?? null, report.git_head ?? null, report.dirty ?? null, report.execution_ready],
      );
    }
    await this.db.query(
      `UPDATE workspace_locations
          SET execution_ready = false, updated_at = now()
        WHERE execution_host_id = $1 AND execution_host_kind = 'remote' AND status = 'active'
          AND NOT (id = ANY($2::varchar[]))`,
      [hostId, seen],
    );
  }
}

function locationToOut(
  row: WorkspaceLocationRow & { host_status: string; last_heartbeat_at: string | null; host_name?: string | null; host_owner_user_id?: string | null },
  userId: string,
): WorkspaceLocationOut {
  const hostOwner = row.host_owner_user_id ?? null;
  const hostName = row.host_name ?? null;
  const hostOnline = row.execution_host_kind === "server" || (row.host_status === "online" && !isStale(row.last_heartbeat_at));
  return {
    id: row.id,
    project_folder_id: row.project_folder_id,
    execution_host_id: row.execution_host_id,
    execution_host_kind: row.execution_host_kind,
    display_path: row.display_path,
    root_path: row.root_path,
    branch: row.branch,
    git_head: row.git_head,
    dirty: row.dirty,
    status: row.status,
    preferred: row.preferred,
    execution_ready: row.execution_ready,
    last_seen_at: row.last_seen_at,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    host_name: hostName,
    host_online: hostOnline,
    host_owner_is_me: hostOwner === userId,
  };
}

export interface WorkspaceLocationHeartbeat {
  location_id: string;
  branch?: string | null;
  git_head?: string | null;
  dirty?: boolean | null;
  execution_ready: boolean;
}

/**
 * ADR 0016 / B62-B64, moved from `project_folders` to `workspace_locations`
 * in P1: a remote Location has no server-side path at all — `root_path` is
 * always NULL for it (schema-enforced,
 * `ck_workspace_locations_remote_no_root_path`).
 */
export function assertServerHostLocation(location: Pick<WorkspaceLocationRow, "execution_host_kind">): void {
  if (location.execution_host_kind !== "server") {
    throw new HttpError(409, "This Workspace Location is bound to a remote execution host; the server holds no local path for it.");
  }
}

/**
 * Shared by the sandbox/code-patch/proposal-apply call sites that used to
 * fetch a Folder and call `assertServerHostFolder` +
 * `projectFolderAbsoluteRoot` directly — all three only ever resolved a
 * Folder's single implicit host-bound path, which is now its preferred
 * Location. `allow_external_root` and other logical-repo policy fields
 * still come from the Folder row itself; this only replaces the physical
 * path half.
 */
export async function resolvePreferredServerHostLocation(
  db: Queryable,
  spaceId: string,
  projectFolderId: string,
): Promise<WorkspaceLocationRow> {
  const location = await new PgWorkspaceLocationRepository(db).getPreferred(projectFolderId);
  if (!location || location.space_id !== spaceId) {
    throw new HttpError(404, "Project Folder not found");
  }
  assertServerHostLocation(location);
  return location;
}

/** Resolves the Folder's preferred Location together with the host facts used
 * by live remote reads. Unlike the server-host helper this deliberately keeps
 * remote Locations, because the daemon is the path authority for them. */
export async function resolvePreferredLocationWithHost(
  db: Queryable,
  spaceId: string,
  projectFolderId: string,
): Promise<PreferredLocationWithHost> {
  const result = await db.query<WorkspaceLocationRow & {
    host_name: string;
    host_owner_user_id: string | null;
    host_status: string;
    last_heartbeat_at: string | null;
  }>(
    `SELECT wl.*, h.name AS host_name, h.owner_user_id AS host_owner_user_id,
            h.status AS host_status, h.last_heartbeat_at
       FROM workspace_locations wl
       JOIN hosts h ON h.id = wl.execution_host_id
      WHERE wl.project_folder_id = $1 AND wl.space_id = $2
        AND wl.status = 'active' AND wl.preferred = true
      LIMIT 1`,
    [projectFolderId, spaceId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Project Folder not found");
  return {
    ...row,
    host_online: row.execution_host_kind === "server" || (row.host_status === "online" && !isStale(row.last_heartbeat_at)),
  };
}

/** Resolve the physical server checkout selected by a Run. A Run may target
 * a non-preferred Location, so provisioning must honor its immutable binding
 * rather than falling back to the Folder's current preferred Location. */
export async function resolveServerHostLocationForRun(
  db: Queryable,
  run: Pick<WorkspaceLocationRow, "space_id" | "project_folder_id"> & { workspace_location_id?: string | null },
): Promise<WorkspaceLocationRow> {
  const location = run.workspace_location_id
    ? await new PgWorkspaceLocationRepository(db).getRow(run.workspace_location_id)
    : await new PgWorkspaceLocationRepository(db).getPreferred(run.project_folder_id);
  if (
    !location
    || location.space_id !== run.space_id
    || location.project_folder_id !== run.project_folder_id
    || location.status !== "active"
  ) {
    throw new HttpError(404, "Project Folder not found");
  }
  assertServerHostLocation(location);
  return location;
}

export function locationAbsoluteRoot(
  location: Pick<WorkspaceLocationRow, "id" | "root_path">,
  workspaceRoot: string,
): string {
  if (location.root_path) {
    return isAbsolute(location.root_path)
      ? resolve(location.root_path)
      : resolve(workspaceRoot, location.root_path);
  }
  return resolve(workspaceRoot, location.id);
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

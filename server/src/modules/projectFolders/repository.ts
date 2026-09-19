import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildTree,
  folderGitDiff,
  folderGitStatus,
  FolderReadError,
  ensureGitRepository,
  isWireRelativePath,
  looksSecretLikePath,
  readFolderFile,
  restoreFolderFile,
  resolveRelativePath,
  runGit,
  writeFolderFile,
  type FileContent,
  type FileNode,
  type GitStatus,
} from "@rainver/folder-read";
import { sharedHostConnectionRegistry, type FolderReadFailure, type FolderReadKind, type FolderReadPayload, type FolderWriteFailureCode } from "../hosts/connectionRegistry.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { loadActionRegistry } from "../policy/actionRegistry.js";
import { enforce } from "../policy/service.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter, assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access.js";
import { projectFolderReadAccessSql } from "./access.js";
import { isStale, PgHostRepository } from "../hosts/repository.js";
import {
  PgWorkspaceLocationRepository,
  locationAbsoluteRoot,
  resolveActiveLocationWithHost,
  resolveLocationWithHost,
  type ActiveLocationWithHost,
  type WorkspaceLocationOut,
} from "./workspaceLocations.js";
import { PgProjectFileRevisionStore, type ProjectFileRevisionOut } from "./fileRevisionStore.js";
import {
  DraftQuotaError,
  DraftVersionConflictError,
  PgProjectFileDraftRepository,
  PROJECT_FILE_DRAFT_MAX_BYTES,
  PROJECT_FILE_DRAFT_MAX_TOTAL_BYTES,
  type ProjectFileDraftMutation,
  type ProjectFileDraftRow,
} from "./draftRepository.js";

const FOLDER_KINDS = new Set(["code", "data", "docs"]);

export interface ProjectFolderRow {
  id: string;
  space_id: string;
  project_id: string;
  created_by_user_id: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  kind: string;
  is_primary: boolean;
  repo_url: string | null;
  default_branch: string | null;
  status: string;
  protected: boolean;
  system_managed: boolean;
  registered_from: string | null;
  metadata_json: Record<string, unknown> | null;
  snapshot_retention_days: number | null;
  snapshot_max_count: number | null;
  created_at: unknown;
  updated_at: unknown;
}

export interface ProjectFolderOut {
  id: string;
  space_id: string;
  project_id: string;
  created_by_user_id: string;
  name: string;
  slug: string | null;
  description: string | null;
  kind: string;
  is_primary: boolean;
  repo_url: string | null;
  default_branch: string | null;
  status: string;
  protected: boolean;
  system_managed: boolean;
  registered_from: string | null;
  metadata_json: Record<string, unknown> | null;
  snapshot_retention_days: number | null;
  snapshot_max_count: number | null;
  created_at: string;
  updated_at: string;
}

/** `workspace add`'s response shape — a merged view the host daemon expects
 * (`packages/host-daemon/src/api.ts`'s `WorkspaceOut`), predating the
 * Folder/Location split. `id` is the Location's id, not the Folder's — see
 * `createRemoteWorkspace`'s doc comment for why. */
export interface RemoteWorkspaceOut {
  id: string;
  project_id: string;
  name: string;
  display_path: string | null;
  host_kind: string;
  root_path: string | null;
  registered_from: string | null;
  created_at: string;
}

export interface ProjectFolderPage {
  items: ProjectFolderOut[];
  total: number;
  limit: number;
  offset: number;
}

export interface ScanCandidate {
  name: string;
  path: string;
}

export interface ProjectFileDraftSaveOut {
  file: FileContent;
  revision: ProjectFileRevisionOut;
  draft_deleted: boolean;
  newer_draft_retained: boolean;
}

export class PgProjectFolderRepository {
  constructor(
    private readonly db: Queryable,
    private readonly config: ServerConfig,
  ) {}

  static fromConfig(config: ServerConfig): PgProjectFolderRepository {
    if (!config.databaseUrl) {
      throw new HttpError(502, "Project Folder repository requires SERVER_DATABASE_URL");
    }
    return new PgProjectFolderRepository(getDbPool(config.databaseUrl), config);
  }

  async list(
    identity: SpaceUserIdentity,
    projectId: string,
    filters: { status: string | null; limit: number; offset: number },
  ): Promise<ProjectFolderPage> {
    const params: unknown[] = [identity.spaceId, projectId, identity.userId];
    const clauses = [
      "space_id = $1",
      "project_id = $2",
      projectFolderReadAccessSql({
        spaceExpr: "project_folders.space_id",
        projectFolderExpr: "project_folders.id",
        userExpr: "$3",
      }),
    ];
    if (filters.status) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = await this.db.query<{ total: string | number }>(
      `SELECT count(id)::text AS total FROM project_folders ${where}`,
      params,
    );
    const rows = await this.db.query<ProjectFolderRow>(
      `${folderSelect()} ${where}
        ORDER BY is_primary DESC, updated_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );
    return {
      items: rows.rows.map(folderToOut),
      total: numberValue(total.rows[0]?.total) ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * The three Project Folder connection flows share one entry point:
   * - `repo_url` with no `root_path` clones into a managed directory;
   * - `root_path` (from `scanCandidates`) connects an existing directory
   *   already inside an allowed managed root;
   * - neither creates a fresh managed directory.
   * All three validate Project write access, allowed roots, collisions,
   * repository state, and Folder kind before registration.
   */
  async create(identity: SpaceUserIdentity, projectId: string, body: Record<string, unknown>): Promise<ProjectFolderOut> {
    await this.assertProjectActive(identity, projectId);
    const name = requiredText(body.name, "name");
    const kind = optionalText(body.kind) ?? "code";
    if (!FOLDER_KINDS.has(kind)) throw new HttpError(422, "kind must be one of code, data, docs");
    const isPrimary = body.is_primary === true;

    const duplicate = await this.db.query<{ id: string }>(
      `SELECT id FROM project_folders
        WHERE space_id = $1 AND project_id = $2 AND name = $3 AND status = 'active'
        LIMIT 1`,
      [identity.spaceId, projectId, name],
    );
    if (duplicate.rows[0]) {
      throw new HttpError(409, `A Project Folder named '${name}' already exists in this Project`);
    }

    const repoUrl = optionalText(body.repo_url);
    const requestedRootPath = optionalText(body.root_path);
    let rootPath: string;
    let registeredFrom: "managed" | "clone" | "scan";
    if (requestedRootPath) {
      rootPath = await this.connectExistingPath(identity.spaceId, requestedRootPath);
      registeredFrom = "scan";
    } else if (repoUrl) {
      rootPath = await this.cloneRepository(identity.spaceId, name, repoUrl);
      registeredFrom = "clone";
    } else {
      rootPath = await this.createManagedDir(identity.spaceId, name, { initializeGit: true });
      registeredFrom = "managed";
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    // This flow (mkdir/clone/scan under `workspaceRoot`) only ever creates a
    // folder on the server host — remote-host workspace registration is a
    // separate daemon-driven path (P1's hosts module), not this endpoint.
    const serverHostId = await new PgHostRepository(this.db).ensureServerHostId();
    const folder = await withTransactionIfPool(this.db, async (db) => {
      if (isPrimary) await demotePrimary(db, identity.spaceId, projectId);
      const row = await db.query<ProjectFolderRow>(
        `INSERT INTO project_folders (
           id, space_id, project_id, created_by_user_id, name, description, kind,
           is_primary, repo_url, default_branch,
           metadata_json, status, protected, system_managed, registered_from,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10,
           $11::jsonb, 'active', false, $12, $13,
           $14, $14
         )
         RETURNING ${folderColumns()}`,
        [
          id,
          identity.spaceId,
          projectId,
          identity.userId,
          name,
          optionalText(body.description),
          kind,
          isPrimary,
          repoUrl,
          optionalText(body.default_branch),
          JSON.stringify(optionalObject(body.metadata_json)),
          registeredFrom !== "scan",
          registeredFrom,
          now,
        ],
      );
      // execution-topology-and-project-control-plane-plan.md P1 / D2: this
      // flow's single physical checkout is this Folder's one active Location.
      await new PgWorkspaceLocationRepository(db).create({
        spaceId: identity.spaceId,
        projectFolderId: id,
        executionHostId: serverHostId,
        executionHostKind: "server",
        rootPath,
      });
      return folderToOut(row.rows[0]!);
    });
    const location = await new PgWorkspaceLocationRepository(this.db).getActive(id);
    if (location) await new PgWorkspaceLocationRepository(this.db).refreshGitStatus(location, this.config.workspaceRoot);
    return folder;
  }

  /**
   * "Connect existing Folder" step 1: candidate directories inside the
   * space's managed root that are not already registered as an active
   * Folder anywhere in the space. Arbitrary host paths are never accepted —
   * only entries from this list may be passed as `root_path` to `create`.
   */
  async scanCandidates(
    identity: SpaceUserIdentity,
    projectId: string,
  ): Promise<ScanCandidate[]> {
    await this.assertProjectActive(identity, projectId);
    return this.availableScanCandidates(identity.spaceId);
  }

  private async availableScanCandidates(spaceId: string): Promise<ScanCandidate[]> {
    const registered = await this.db.query<{ root_path: string | null }>(
      `SELECT root_path FROM workspace_locations WHERE space_id = $1 AND status = 'active'`,
      [spaceId],
    );
    const knownPaths = new Set(
      registered.rows
        .map((row) => row.root_path)
        .filter((path): path is string => Boolean(path))
        .map((path) => resolve(path)),
    );
    const spaceRoot = resolve(this.config.workspaceRoot, spaceId);
    const canonicalRoot = await realpath(spaceRoot).catch(() => null);
    if (!canonicalRoot) return [];
    const entries = await readdir(spaceRoot, { withFileTypes: true }).catch(() => []);
    const candidates: ScanCandidate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = resolve(spaceRoot, entry.name);
      const canonicalPath = await realpath(path).catch(() => null);
      if (
        !canonicalPath ||
        dirname(canonicalPath) !== canonicalRoot ||
        knownPaths.has(canonicalPath)
      ) {
        continue;
      }
      candidates.push({ name: entry.name, path: canonicalPath });
    }
    return candidates;
  }

  async get(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<ProjectFolderOut | null> {
    const result = await this.db.query<ProjectFolderRow>(
      `${folderSelect()} WHERE id = $1 AND space_id = $2 AND project_id = $3
        AND ${projectFolderReadAccessSql({
          spaceExpr: "project_folders.space_id",
          projectFolderExpr: "project_folders.id",
          userExpr: "$4",
        })}
        LIMIT 1`,
      [folderId, identity.spaceId, projectId, identity.userId],
    );
    const row = result.rows[0] ?? null;
    return row ? folderToOut(row) : null;
  }

  async listLocations(identity: SpaceUserIdentity, projectId: string, folderId: string) {
    const folder = await this.get(identity, projectId, folderId);
    if (!folder) throw new HttpError(404, "Project Folder not found");
    return new PgWorkspaceLocationRepository(this.db).listForFolder(identity, folderId);
  }

  async activateLocation(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    locationId: string,
  ): Promise<WorkspaceLocationOut> {
    await withTransactionIfPool(this.db, async (db) => {
      await lockActiveProjectForMutation(db, identity.spaceId, projectId);
      await assertProjectWriterForMutation(db, identity.spaceId, projectId, identity.userId);
      const folder = await db.query<{ id: string }>(
        `SELECT id FROM project_folders
          WHERE id = $1 AND space_id = $2 AND project_id = $3 AND status = 'active'
          FOR UPDATE`,
        [folderId, identity.spaceId, projectId],
      );
      if (!folder.rows[0]) throw new HttpError(404, "Project Folder not found");
      const target = await db.query<{
        id: string;
        status: string;
        execution_ready: boolean;
        execution_host_kind: string;
        host_owner_user_id: string | null;
        host_status: string;
        last_heartbeat_at: string | null;
      }>(
        `SELECT location.id, location.status, location.execution_ready,
                location.execution_host_kind,
                host.owner_user_id AS host_owner_user_id,
                host.status AS host_status, host.last_heartbeat_at
           FROM workspace_locations location
           JOIN hosts host ON host.id = location.execution_host_id
          WHERE location.id = $1
            AND location.project_folder_id = $2
            AND location.space_id = $3
          FOR UPDATE OF location`,
        [locationId, folderId, identity.spaceId],
      );
      const candidate = target.rows[0];
      if (!candidate) throw new HttpError(404, "Workspace Location not found");
      if (candidate.status !== "stale") {
        throw new HttpError(409, "Only a stale Workspace Location candidate can become active");
      }
      if (!candidate.execution_ready) {
        throw new HttpError(409, "The Workspace Location must be ready before it can become active");
      }
      if (candidate.execution_host_kind === "remote") {
        if (candidate.host_owner_user_id !== identity.userId) {
          throw new HttpError(403, "Only the target Host owner can activate this Workspace Location");
        }
        if (candidate.host_status !== "online" || isStale(candidate.last_heartbeat_at)) {
          throw new HttpError(409, "The target execution Host is offline");
        }
      }
      await db.query(
        `UPDATE workspace_locations
            SET status = 'stale', updated_at = now()
          WHERE project_folder_id = $1 AND space_id = $2 AND status = 'active'`,
        [folderId, identity.spaceId],
      );
      await db.query(
        `UPDATE workspace_locations SET status = 'active', updated_at = now()
          WHERE id = $1 AND project_folder_id = $2 AND space_id = $3 AND status = 'stale'`,
        [locationId, folderId, identity.spaceId],
      );
    });
    const activated = await new PgWorkspaceLocationRepository(this.db).get(identity, folderId, locationId);
    if (!activated) throw new HttpError(409, "Workspace Location activation did not complete");
    return activated;
  }

  async listHostExecutionTargets(identity: SpaceUserIdentity, projectId: string) {
    return new PgWorkspaceLocationRepository(this.db).listHostExecutionTargets(
      identity.spaceId,
      projectId,
      identity.userId,
    );
  }

  async update(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    body: Record<string, unknown>,
  ): Promise<ProjectFolderOut | null> {
    await this.assertProjectActive(identity, projectId, { allowArchived: true });
    const existing = await this.getRow(identity.spaceId, projectId, folderId, false);
    if (!existing) return null;
    const allowed = [
      "name",
      "description",
      "kind",
      "is_primary",
      "default_branch",
      "status",
      "metadata_json",
      "snapshot_retention_days",
      "snapshot_max_count",
    ];
    const sets: string[] = [];
    const params: unknown[] = [folderId, identity.spaceId, projectId];
    let makePrimary = false;
    for (const key of allowed) {
      if (!(key in body)) continue;
      if (key === "kind" && !FOLDER_KINDS.has(String(body[key]))) {
        throw new HttpError(422, "kind must be one of code, data, docs");
      }
      if (key === "is_primary") {
        if (body[key] === true) makePrimary = true;
        else if (body[key] !== false) continue;
      }
      params.push(key === "metadata_json" ? JSON.stringify(optionalObject(body[key])) : body[key] ?? null);
      sets.push(`${key} = $${params.length}${key === "metadata_json" ? "::jsonb" : ""}`);
    }
    if (sets.length === 0) return folderToOut(existing);
    params.push(new Date().toISOString());
    return withTransactionIfPool(this.db, async (db) => {
      if (makePrimary) await demotePrimary(db, identity.spaceId, projectId);
      const row = await db.query<ProjectFolderRow>(
        `UPDATE project_folders
            SET ${sets.join(", ")}, updated_at = $${params.length}
          WHERE id = $1 AND space_id = $2 AND project_id = $3
          RETURNING ${folderColumns()}`,
        params,
      );
      return row.rows[0] ? folderToOut(row.rows[0]) : null;
    });
  }

  /**
   * Disables new Folder-backed execution without touching disk. Distinct
   * from `unregister`, which removes the registration entirely.
   */
  async archive(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<boolean> {
    await this.assertProjectActive(identity, projectId, { allowArchived: true });
    const now = new Date().toISOString();
    const run = async (db: Queryable): Promise<boolean> => {
      const result = await db.query(
        `UPDATE project_folders
            SET status = 'archived', updated_at = $4
          WHERE id = $1 AND space_id = $2 AND project_id = $3`,
        [folderId, identity.spaceId, projectId, now],
      );
      if ((result.rowCount ?? 0) === 0) return false;
      return true;
    };
    if (isPool(this.db)) return withTransaction(this.db, (client) => run(client));
    return run(this.db);
  }

  /**
   * Removes only the Rainver registration row. Never deletes, moves, or
   * rewrites the physical directory.
   */
  async unregister(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    options: { confirm?: boolean } = {},
  ): Promise<boolean> {
    return withTransactionIfPool(this.db, async (db) => {
      const project = await db.query<{ status: string }>(
        `SELECT status FROM projects
          WHERE id = $1 AND space_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [projectId, identity.spaceId],
      );
      if (!project.rows[0]) throw new HttpError(404, "Project not found");
      await assertProjectWriterForMutation(db, identity.spaceId, projectId, identity.userId);
      const folder = await db.query<{ id: string }>(
        `SELECT id FROM project_folders
          WHERE id = $1 AND space_id = $2 AND project_id = $3
          FOR UPDATE`,
        [folderId, identity.spaceId, projectId],
      );
      if (!folder.rows[0]) return false;
      const drafts = await db.query<{ active_draft_count: string | number; affected_user_count: string | number }>(
        `SELECT count(*)::bigint AS active_draft_count,
                count(DISTINCT owner_user_id)::bigint AS affected_user_count
           FROM project_file_drafts
          WHERE space_id = $1 AND project_folder_id = $2 AND expires_at > NOW()`,
        [identity.spaceId, folderId],
      );
      const activeDraftCount = Number(drafts.rows[0]?.active_draft_count ?? 0);
      const affectedUserCount = Number(drafts.rows[0]?.affected_user_count ?? 0);
      if (activeDraftCount > 0 && options.confirm !== true) {
        throw new HttpError(409, "Active File drafts must be explicitly confirmed before unregistering this Folder", {
          detail: "Active File drafts must be explicitly confirmed before unregistering this Folder",
          code: "active_drafts_require_confirmation",
          active_draft_count: activeDraftCount,
          affected_user_count: affectedUserCount,
        });
      }
      await new PgProjectFileDraftRepository(db).deleteForFolder(db, identity.spaceId, folderId);
      const result = await db.query(
        `DELETE FROM project_folders WHERE id = $1 AND space_id = $2 AND project_id = $3`,
        [folderId, identity.spaceId, projectId],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * ADR 0016 `workspace add`: registers a directory the daemon already has
   * on its own machine — never mkdir/clone/scan, never a local `root_path`.
   * Called with the host's owner as `userId`; write access to the target
   * Project is still required, exactly as the server-host `create` flow.
   *
   * execution-topology-and-project-control-plane-plan.md P1 / D2: creates a
   * logical Folder *and* its one remote Location together, keeping the
   * daemon's `workspace add` UX exactly as it was pre-P1 (one call, one
   * result). The returned `id` is the **Location's** id, not the Folder's —
   * the host daemon's wire protocol uses `workspace_location_id`, and this
   * value pins a task thread and a Run to one execution site. Registering a
   * *second* Location for an
   * existing Folder (the same repo checked out on another host) is
   * `addWorkspaceLocation`, not this method — this one always creates a
   * fresh Folder, matching the daemon CLI's current one-shot `workspace add`
   * command, which does not yet offer "attach to an existing Folder"
   * (deferred with real Windows+WSL hardware, per the plan's P1
   * acceptance section).
   */
  async createRemoteWorkspace(
    projectId: string,
    userId: string,
    hostId: string,
    input: { name: string; displayPath: string | null },
  ): Promise<RemoteWorkspaceOut> {
    const project = await this.db.query<{ space_id: string }>(
      `SELECT space_id FROM projects WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const spaceId = project.rows[0]?.space_id;
    if (!spaceId) throw new HttpError(404, "Project not found");
    await assertProjectWriter(this.db, spaceId, projectId, userId);
    const name = requiredText(input.name, "name");
    const duplicate = await this.db.query<{ id: string }>(
      `SELECT id FROM project_folders
        WHERE space_id = $1 AND project_id = $2 AND name = $3 AND status = 'active'
        LIMIT 1`,
      [spaceId, projectId, name],
    );
    if (duplicate.rows[0]) {
      throw new HttpError(409, `A Project Folder named '${name}' already exists in this Project`);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    return withTransactionIfPool(this.db, async (db) => {
      await db.query<ProjectFolderRow>(
        `INSERT INTO project_folders (
           id, space_id, project_id, created_by_user_id, name, status,
           kind, is_primary, protected, system_managed,
           registered_from, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'active',
           'code', false, false, false,
           'daemon_registered', $6, $6
         )
         RETURNING ${folderColumns()}`,
        [id, spaceId, projectId, userId, name, now],
      );
      const location = await new PgWorkspaceLocationRepository(db).create({
        spaceId,
        projectFolderId: id,
        executionHostId: hostId,
        executionHostKind: "remote",
        displayPath: optionalText(input.displayPath),
      });
      return {
        id: location.id,
        project_id: projectId,
        name,
        display_path: location.display_path,
        host_kind: location.execution_host_kind,
        root_path: location.root_path,
        registered_from: "daemon_registered",
        created_at: now,
      };
    });
  }

  async getTree(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    options: { workspaceLocationId?: string; signal?: AbortSignal } = {},
  ): Promise<FileNode> {
    const folder = await this.requireReadableActiveFolder(identity, projectId, folderId);
    const location = options.workspaceLocationId
      ? await resolveLocationWithHost(this.db, identity.spaceId, folderId, options.workspaceLocationId)
      : await resolveActiveLocationWithHost(this.db, identity.spaceId, folderId);
    if (location.execution_host_kind === "remote") {
      return this.readRemote(folder, identity.userId, location, "tree", undefined, options.signal);
    }
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    await this.enforceFolderRead(folder, identity.userId, "tree");
    try {
      return await buildTree(root, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw mapFolderReadError(error);
    }
  }

  async getFile(identity: SpaceUserIdentity, projectId: string, folderId: string, requestedPath: string, options: { includeUtf16Preview?: boolean } = {}): Promise<FileContent> {
    const folder = await this.requireReadableActiveFolder(identity, projectId, folderId);
    const location = await resolveActiveLocationWithHost(this.db, identity.spaceId, folderId);
    if (location.execution_host_kind === "remote") {
      return this.readRemote(folder, identity.userId, location, "file", requestedPath, undefined, options);
    }
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    const relPath = resolveRelativePath(root, requestedPath, { protectedFolder: folder.protected }).relative;
    await this.enforceFolderRead(folder, identity.userId, "file", relPath);
    try {
      const content = await readFolderFile(root, requestedPath, { protectedFolder: folder.protected, includeUtf16Preview: options.includeUtf16Preview });
      return { ...content, path: requestedPath };
    } catch (error) {
      throw mapFolderReadError(error);
    }
  }

  async getDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    requestedPath: string,
  ): Promise<ProjectFileDraftRow | null> {
    const folder = await this.requireWritableActiveFolder(identity, projectId, folderId);
    const path = parseEditablePath(requestedPath);
    const location = await resolveActiveLocationWithHost(this.db, identity.spaceId, folder.id);
    return new PgProjectFileDraftRepository(this.db).get({
      spaceId: folder.space_id,
      ownerUserId: identity.userId,
      projectFolderId: folder.id,
      workspaceLocationId: location.id,
      relativePath: path,
    });
  }

  async upsertDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    body: Record<string, unknown>,
  ): Promise<ProjectFileDraftRow> {
    const folder = await this.requireWritableActiveFolder(identity, projectId, folderId);
    const mutation = parseDraftMutation(body);
    if (mutation.sourceEncoding !== "utf8") {
      throw new HttpError(415, "Convert the UTF-16 file to UTF-8 before creating a draft");
    }
    const location = await resolveActiveLocationWithHost(this.db, identity.spaceId, folder.id);
    try {
      return await new PgProjectFileDraftRepository(this.db).upsert({
        spaceId: folder.space_id,
        projectId,
        projectFolderId: folder.id,
        workspaceLocationId: location.id,
        ownerUserId: identity.userId,
        mutation,
      });
    } catch (error) {
      if (error instanceof DraftVersionConflictError) {
        throw new HttpError(409, error.message, {
          detail: error.message,
          code: "draft_version_conflict",
          current: error.current,
        });
      }
      if (error instanceof DraftQuotaError) {
        throw new HttpError(413, error.message, {
          detail: error.message,
          code: "draft_quota_exceeded",
          used_bytes: error.usedBytes,
          requested_bytes: error.requestedBytes,
          limit_bytes: PROJECT_FILE_DRAFT_MAX_TOTAL_BYTES,
        });
      }
      throw error;
    }
  }

  async discardDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    body: Record<string, unknown>,
  ): Promise<{ discarded: true }> {
    const folder = await this.requireWritableActiveFolder(identity, projectId, folderId);
    const id = requiredText(body.draft_id, "draft_id");
    const version = positiveInteger(body.draft_version, "draft_version");
    const drafts = new PgProjectFileDraftRepository(this.db);
    const current = await drafts.getById({ id, spaceId: folder.space_id, ownerUserId: identity.userId, projectFolderId: folder.id });
    if (!current) throw new HttpError(404, "Draft not found or expired");
    if (current.version !== version) {
      throw new HttpError(409, "The draft changed in another tab", { detail: "The draft changed in another tab", code: "draft_version_conflict", current });
    }
    if (!await drafts.discard({ id, spaceId: folder.space_id, ownerUserId: identity.userId, expectedVersion: version })) {
      throw new HttpError(409, "The draft changed in another tab", { detail: "The draft changed in another tab", code: "draft_version_conflict" });
    }
    return { discarded: true };
  }

  async draftQuota(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
  ): Promise<{ used_bytes: number; limit_bytes: number }> {
    await this.requireWritableActiveFolder(identity, projectId, folderId);
    return new PgProjectFileDraftRepository(this.db).quota(identity.spaceId, identity.userId);
  }

  async saveDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    body: Record<string, unknown>,
  ): Promise<ProjectFileDraftSaveOut> {
    const folder = await this.requireWritableActiveFolder(identity, projectId, folderId);
    const draftId = requiredText(body.draft_id, "draft_id");
    const requestedVersion = positiveInteger(body.draft_version, "draft_version");
    const drafts = new PgProjectFileDraftRepository(this.db);
    const draft = await drafts.getById({ id: draftId, spaceId: folder.space_id, ownerUserId: identity.userId, projectFolderId: folder.id });
    if (!draft) throw new HttpError(404, "Draft not found or expired");
    if (draft.version !== requestedVersion) {
      throw new HttpError(409, "The draft changed in another tab", { detail: "The draft changed in another tab", code: "draft_version_conflict", current: draft });
    }
    await this.enforceFolderWrite(folder, identity.userId, draft.relative_path);
    const location = await resolveLocationWithHost(this.db, folder.space_id, folder.id, draft.workspace_location_id);
    const current = await this.readCurrentFileForDraft(folder, identity.userId, location, draft.relative_path);
    if (current.exists !== draft.base_exists || (draft.base_exists && current.file?.sha256 !== draft.base_sha256)) {
      throw new HttpError(409, "The Project Folder file changed since this draft was created", {
        detail: "The Project Folder file changed since this draft was created",
        code: "host_file_conflict",
        draft,
        current: current.file ? { sha256: current.file.sha256, size: current.file.size } : { exists: false },
      });
    }
    const normalizesMixedLineEndings = draft.line_ending_mode === "mixed"
      || lineEndingMode(draft.content) === "mixed"
      || current.file?.line_ending_mode === "mixed";
    if (normalizesMixedLineEndings && body.confirm_mixed_line_ending_normalization !== true) {
      throw new HttpError(409, "Saving this draft will normalize mixed line endings", {
        detail: "Saving this draft will normalize mixed line endings",
        code: "mixed_line_endings_confirmation_required",
      });
    }

    const serialized = serializeDraftText(draft);
    const afterSha256 = hashText(serialized);
    let beforeExists = current.exists;
    let beforeContent = current.file ? revisionText(current.file) : null;
    let physicalWritten = false;
    try {
      if (location.execution_host_kind === "remote") {
        assertRemoteWriteAccess(location, identity.userId);
        const result = await sharedHostConnectionRegistry.requestFolderWrite(location.execution_host_id, {
          workspace_location_id: location.id,
          path: draft.relative_path,
          content: serialized,
          expected_exists: current.exists,
          expected_sha256: current.file?.sha256 ?? null,
          protected: Boolean(folder.protected),
          allow_encoding_conversion: current.file?.encoding === "utf16le" || current.file?.encoding === "utf16be",
        });
        if (!result.ok) throw mapRemoteFolderWriteError(result, location.host_name);
        physicalWritten = true;
        if (!result.exists || result.sha256 !== afterSha256) throw new HttpError(502, "The host acknowledged an unexpected file version");
      } else {
        const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
        const result = await writeFolderFile(root, draft.relative_path, serialized, {
          protectedFolder: Boolean(folder.protected),
          expectedExists: current.exists,
          expectedSha256: current.file?.sha256 ?? null,
          allowEncodingConversion: current.file?.encoding === "utf16le" || current.file?.encoding === "utf16be",
        });
        physicalWritten = true;
        beforeExists = result.before.exists;
        if (result.sha256 !== afterSha256) throw new HttpError(502, "The host acknowledged an unexpected file version");
      }

      const revisionStore = new PgProjectFileRevisionStore(this.db);
      const committed = await withTransactionIfPool(this.db, async (db) => {
        const revision = await revisionStore.createInTransaction(db, {
          spaceId: folder.space_id,
          projectId,
          projectFolderId: folder.id,
          workspaceLocationId: location.id,
          path: draft.relative_path,
          beforeExists,
          beforeContent,
          afterExists: true,
          afterSha256,
          userId: identity.userId,
          retentionDays: folder.snapshot_retention_days,
          maxCount: folder.snapshot_max_count,
        });
        const draftDeleted = await drafts.deleteExact(db, {
          id: draft.id,
          spaceId: folder.space_id,
          ownerUserId: identity.userId,
          version: draft.version,
        });
        return { revision, draftDeleted };
      });
      return {
        file: savedFileContent(draft, serialized, afterSha256),
        revision: committed.revision,
        draft_deleted: committed.draftDeleted,
        newer_draft_retained: !committed.draftDeleted,
      };
    } catch (error) {
      if (!physicalWritten) throw error;
      try {
        await this.restorePhysicalFile(
          folder,
          identity.userId,
          location,
          draft.relative_path,
          beforeContent,
          true,
          afterSha256,
          current.file?.encoding === "utf16le" || current.file?.encoding === "utf16be" ? current.file.encoding : "utf8",
        );
      } catch (rollbackError) {
        throw new HttpError(502, `The draft save failed and automatic rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"}`);
      }
      throw error;
    }
  }

  async restoreRevisionAsDraft(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    body: Record<string, unknown>,
  ): Promise<ProjectFileDraftRow> {
    const folder = await this.requireWritableActiveFolder(identity, projectId, folderId);
    const revisionId = requiredText(body.revision_id, "revision_id");
    const revision = await new PgProjectFileRevisionStore(this.db).getAvailable(folder.space_id, projectId, folder.id, revisionId);
    if (!revision) throw new HttpError(404, "File revision not found or expired");
    const location = await resolveLocationWithHost(this.db, folder.space_id, folder.id, revision.workspace_location_id);
    const current = await this.readCurrentFileForDraft(folder, identity.userId, location, revision.path);
    const content = revision.before_exists ? revision.before_content ?? "" : "";
    return new PgProjectFileDraftRepository(this.db).upsert({
      spaceId: folder.space_id,
      projectId,
      projectFolderId: folder.id,
      workspaceLocationId: location.id,
      ownerUserId: identity.userId,
      mutation: {
        targetKind: current.exists ? "existing" : "new",
        relativePath: revision.path,
        baseExists: current.exists,
        baseSha256: current.file?.sha256 ?? null,
        content,
        contentSha256: hashText(content),
        byteSize: Buffer.byteLength(content, "utf8"),
        sourceEncoding: "utf8",
        preserveBom: content.startsWith("\uFEFF"),
        lineEndingMode: lineEndingMode(content),
      },
    });
  }

  async previewRevision(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    revisionId: string,
  ): Promise<{ revision: ProjectFileRevisionOut; content: string | null }> {
    const folder = await this.requireWritableActiveFolder(identity, projectId, folderId);
    const id = requiredText(revisionId, "revision_id");
    const revision = await new PgProjectFileRevisionStore(this.db).getAvailable(folder.space_id, projectId, folder.id, id);
    if (!revision) throw new HttpError(404, "File revision not found or expired");
    return {
      revision,
      content: revision.before_exists ? revision.before_content ?? "" : null,
    };
  }

  private async readCurrentFileForDraft(
    folder: ProjectFolderRow,
    userId: string,
    location: ActiveLocationWithHost,
    path: string,
  ): Promise<{ exists: boolean; file: FileContent | null }> {
    try {
      const file = location.execution_host_kind === "remote"
        ? await this.readRemoteFileForWrite(folder, userId, location, path)
        : await (async () => {
            const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
            await this.enforceFolderRead(folder, userId, "file", path);
            return readFolderFile(root, path, { protectedFolder: Boolean(folder.protected), includeUtf16Preview: true });
          })();
      if (!file) return { exists: false, file: null };
      const convertibleUtf16 = (file.encoding === "utf16le" || file.encoding === "utf16be")
        && file.conversion_available === true;
      if (!convertibleUtf16 && (file.writable === false || (file.encoding && file.encoding !== "utf8"))) {
        throw new HttpError(415, "Only valid UTF-8 text files can be saved");
      }
      return { exists: true, file };
    } catch (error) {
      // A missing file is how a *new* file starts, on either host kind. The
      // local branch reports it as `FolderReadError("not_found")`, so it has to
      // be mapped before the 404 test rather than after it.
      const mapped = error instanceof FolderReadError ? folderReadHttpError(error) : error;
      if (mapped instanceof HttpError && mapped.statusCode === 404) return { exists: false, file: null };
      throw mapped;
    }
  }

  async listFileRevisions(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    requestedPath: string,
  ): Promise<ProjectFileRevisionOut[]> {
    await this.requireWritableActiveFolder(identity, projectId, folderId);
    const path = parseEditablePath(requestedPath);
    const location = await resolveActiveLocationWithHost(this.db, identity.spaceId, folderId);
    return new PgProjectFileRevisionStore(this.db).listForFile(identity.spaceId, projectId, folderId, location.id, path);
  }

  async getGitStatus(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<GitStatus> {
    const folder = await this.requireReadableActiveFolder(identity, projectId, folderId);
    const location = await resolveActiveLocationWithHost(this.db, identity.spaceId, folderId);
    if (location.execution_host_kind === "remote") {
      return this.readRemote(folder, identity.userId, location, "git_status");
    }
    await this.enforceFolderRead(folder, identity.userId, "git_status");
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    return folderGitStatus(root);
  }

  async getGitDiff(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    requestedPath: string | null,
  ): Promise<{ diff: string; path: string | null; truncated: boolean; redacted: boolean }> {
    const folder = await this.requireReadableActiveFolder(identity, projectId, folderId);
    const location = await resolveActiveLocationWithHost(this.db, identity.spaceId, folderId);
    if (location.execution_host_kind === "remote") {
      return this.readRemote(folder, identity.userId, location, "git_diff", requestedPath ?? undefined);
    }
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    const relPath = requestedPath
      ? resolveRelativePath(root, requestedPath, { protectedFolder: folder.protected }).relative
      : null;
    await this.enforceFolderRead(folder, identity.userId, "git_diff", relPath);
    try {
      const result = await folderGitDiff(root, requestedPath, { protectedFolder: folder.protected });
      return { ...result, path: requestedPath };
    } catch (error) {
      throw mapFolderReadError(error);
    }
  }

  /** Run-scope lookup: not project-fenced, callers already hold `run.project_id`. */
  async getFolder(spaceId: string, folderId: string, activeOnly = true): Promise<ProjectFolderRow | null> {
    const result = await this.db.query<ProjectFolderRow>(
      `${folderSelect()}
        WHERE id = $1 AND space_id = $2 ${activeOnly ? "AND status = 'active'" : ""}
        LIMIT 1`,
      [folderId, spaceId],
    );
    return result.rows[0] ?? null;
  }

  private async getRow(spaceId: string, projectId: string, folderId: string, activeOnly: boolean): Promise<ProjectFolderRow | null> {
    const result = await this.db.query<ProjectFolderRow>(
      `${folderSelect()}
        WHERE id = $1 AND space_id = $2 AND project_id = $3 ${activeOnly ? "AND status = 'active'" : ""}
        LIMIT 1`,
      [folderId, spaceId, projectId],
    );
    return result.rows[0] ?? null;
  }

  private async requireReadableActiveFolder(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
  ): Promise<ProjectFolderRow> {
    const result = await this.db.query<ProjectFolderRow>(
      `${folderSelect()}
        WHERE id = $1 AND space_id = $2 AND project_id = $3 AND status = 'active'
          AND ${projectFolderReadAccessSql({
            spaceExpr: "project_folders.space_id",
            projectFolderExpr: "project_folders.id",
            userExpr: "$4",
          })}
        LIMIT 1`,
      [folderId, identity.spaceId, projectId, identity.userId],
    );
    const folder = result.rows[0];
    if (!folder) throw new HttpError(404, "Project Folder not found");
    return folder;
  }

  private async requireWritableActiveFolder(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
  ): Promise<ProjectFolderRow> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId);
    const folder = await this.getRow(identity.spaceId, projectId, folderId, true);
    if (!folder) throw new HttpError(404, "Project Folder not found");
    return folder;
  }

  // Folder access inherits the Project ACL completely — the Project
  // writer/active check is the only authority gate for Folder mutation.
  private async assertProjectActive(
    identity: SpaceUserIdentity,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ): Promise<void> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId, options);
  }

  private async createManagedDir(
    spaceId: string,
    name: string,
    options: { initializeGit?: boolean } = {},
  ): Promise<string> {
    const spaceRoot = resolve(this.config.workspaceRoot, spaceId);
    await mkdir(spaceRoot, { recursive: true });
    const base = folderDirName(name);
    let candidate = resolve(spaceRoot, base);
    for (let i = 1; await stat(candidate).catch(() => null); i += 1) {
      candidate = resolve(spaceRoot, `${base}-${i}`);
    }
    await mkdir(candidate, { recursive: true });
    if (options.initializeGit) {
      if (!await ensureGitRepository(candidate)) {
        throw new HttpError(422, "Failed to initialize Git repository");
      }
    }
    return candidate;
  }

  private async cloneRepository(spaceId: string, name: string, repoUrl: string): Promise<string> {
    const target = await this.createManagedDir(spaceId, name);
    const result = await runGit(["clone", "--", repoUrl, target], resolve(this.config.workspaceRoot, spaceId), 120_000);
    if (result.code !== 0) {
      throw new HttpError(422, `Failed to clone repository: ${result.stderr.slice(0, 400)}`);
    }
    return target;
  }

  private async connectExistingPath(spaceId: string, requestedPath: string): Promise<string> {
    const candidate = resolve(requestedPath);
    const candidates = await this.availableScanCandidates(spaceId);
    if (!candidates.some((item) => item.path === candidate)) {
      throw new HttpError(422, "root_path must be inside the space's managed root — pick from scanCandidates");
    }
    const linkInfo = await lstat(candidate).catch(() => null);
    if (!linkInfo?.isDirectory() || linkInfo.isSymbolicLink()) {
      throw new HttpError(422, "root_path must be a scanned directory, not a symbolic link");
    }
    const canonicalPath = await realpath(candidate).catch(() => null);
    if (!canonicalPath || canonicalPath !== candidate) {
      throw new HttpError(422, "root_path changed after scanning; scan again");
    }
    const collision = await this.db.query<{ id: string }>(
      `SELECT id FROM workspace_locations WHERE space_id = $1 AND root_path = $2 AND status = 'active' LIMIT 1`,
      [spaceId, canonicalPath],
    );
    if (collision.rows[0]) throw new HttpError(409, "This directory is already a registered Workspace Location");
    return canonicalPath;
  }

  private async enforceFolderRead(
    folder: ProjectFolderRow,
    userId: string,
    readKind: string,
    relativePath: string | null = null,
    options: { forceRecord?: boolean; hostId?: string } = {},
  ): Promise<void> {
    const auditReasons = folderReadAuditReasons(folder, readKind, relativePath);
    const registry = await loadActionRegistry();
    const result = await enforce(this.config, registry, {
      action: "project_folder.read",
      actor_type: "user",
      actor_id: userId,
      space_id: folder.space_id,
      resource_type: "project_folder",
      resource_id: folder.id,
      resource_space_id: folder.space_id,
      context: {
        read_kind: readKind,
        relative_path: relativePath,
        folder_protected: Boolean(folder.protected),
        folder_system_managed: Boolean(folder.system_managed),
        ...(options.hostId ? { host_id: options.hostId } : {}),
        audit_reasons: auditReasons,
      },
      metadata_json: {
        read_kind: readKind,
        relative_path: relativePath,
        ...(options.hostId ? { host_id: options.hostId } : {}),
        audit_reasons: auditReasons,
      },
      force_record: options.forceRecord ?? auditReasons.length > 0,
    });
    if (result.status === "allow") return;
    if (result.status === "error") {
      throw new HttpError(500, result.message ?? "Project Folder read policy audit failed");
    }
    throw new HttpError(403, result.message ?? "Project Folder read denied by policy");
  }

  private async enforceFolderWrite(
    folder: ProjectFolderRow,
    userId: string,
    relativePath: string,
  ): Promise<void> {
    const result = await enforce(this.config, await loadActionRegistry(), {
      action: "project_folder.apply_patch",
      actor_type: "user",
      actor_id: userId,
      space_id: folder.space_id,
      resource_type: "project_folder",
      resource_id: folder.id,
      resource_space_id: folder.space_id,
      context: {
        direct_user_write: true,
        file_operation: "write",
        project_folder_id: folder.id,
        relative_path: relativePath,
      },
      metadata_json: {
        direct_user_write: true,
        file_operation: "write",
        project_folder_id: folder.id,
        relative_path: relativePath,
      },
      force_record: true,
    });
    if (result.status === "allow") return;
    if (result.status === "error") throw new HttpError(500, result.message ?? "Project Folder write policy audit failed");
    throw new HttpError(403, result.message ?? "Project Folder write denied by policy");
  }

  private async readRemoteFileForWrite(
    folder: ProjectFolderRow,
    userId: string,
    location: ActiveLocationWithHost,
    path: string,
  ): Promise<FileContent | null> {
    try {
      return await this.readRemote(folder, userId, location, "file", path, undefined, { includeUtf16Preview: true });
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) return null;
      throw error;
    }
  }

  private async restorePhysicalFile(
    folder: ProjectFolderRow,
    userId: string,
    location: ActiveLocationWithHost,
    path: string,
    content: string | null,
    expectedExists: boolean,
    expectedSha256: string | null,
    restoreEncoding: "utf8" | "utf16le" | "utf16be",
  ): Promise<void> {
    if (location.execution_host_kind === "remote") {
      assertRemoteWriteAccess(location, userId);
      const result = await sharedHostConnectionRegistry.requestFolderWrite(location.execution_host_id, {
        workspace_location_id: location.id,
        path,
        content,
        expected_exists: expectedExists,
        expected_sha256: expectedSha256,
        protected: Boolean(folder.protected),
        restore_encoding: restoreEncoding,
      });
      if (!result.ok) throw mapRemoteFolderWriteError(result, location.host_name);
      return;
    }
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    await restoreFolderFile(root, path, content, {
      protectedFolder: Boolean(folder.protected),
      expectedExists,
      expectedSha256,
      restoreEncoding,
    });
  }

  private async readRemote<K extends FolderReadKind>(
    folder: ProjectFolderRow,
    userId: string,
    location: ActiveLocationWithHost,
    kind: K,
    requestedPath?: string,
    signal?: AbortSignal,
    options: { includeUtf16Preview?: boolean } = {},
  ): Promise<FolderReadPayload[K]> {
    if (requestedPath !== undefined && !isWireRelativePath(requestedPath)) {
      const detail = "folder_read paths must be relative";
      throw new HttpError(403, detail, { detail, code: "path_forbidden" });
    }
    await this.enforceFolderRead(folder, userId, kind, requestedPath ?? null, { forceRecord: true, hostId: location.execution_host_id });
    if (location.host_owner_user_id !== userId) {
      throw new HttpError(403, `This Folder is on ${location.host_name}'s machine; only its owner can browse it here.`, {
        detail: `This Folder is on ${location.host_name}'s machine; only its owner can browse it here.`,
        code: "host_not_owned",
        host_name: location.host_name,
      });
    }
    if (!location.host_online) {
      const detail = `This Folder is on ${location.host_name}, which is offline.`;
      throw new HttpError(409, detail, {
        detail,
        code: "host_offline",
        host_name: location.host_name,
        last_heartbeat_at: location.last_heartbeat_at,
      });
    }
    const result = await sharedHostConnectionRegistry.requestFolderRead(location.execution_host_id, {
      workspace_location_id: location.id,
      kind,
      ...(requestedPath === undefined ? {} : { path: requestedPath }),
      protected: Boolean(folder.protected),
      ...(options.includeUtf16Preview === true ? { include_utf16_preview: true } : {}),
    }, signal);
    if (result.ok) return result.result;
    throw mapRemoteFolderReadError(result, location.host_name);
  }
}

export function folderToOut(row: ProjectFolderRow): ProjectFolderOut {
  return {
    id: row.id,
    space_id: row.space_id,
    project_id: row.project_id,
    created_by_user_id: row.created_by_user_id ?? "",
    name: row.name,
    slug: row.slug,
    description: row.description,
    kind: row.kind,
    is_primary: Boolean(row.is_primary),
    repo_url: row.repo_url,
    default_branch: row.default_branch,
    status: row.status,
    protected: Boolean(row.protected),
    system_managed: Boolean(row.system_managed),
    registered_from: row.registered_from,
    metadata_json: row.metadata_json,
    snapshot_retention_days: row.snapshot_retention_days,
    snapshot_max_count: row.snapshot_max_count,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
  };
}

async function demotePrimary(db: Queryable, spaceId: string, projectId: string): Promise<void> {
  await db.query(
    `UPDATE project_folders SET is_primary = false, updated_at = $3
      WHERE space_id = $1 AND project_id = $2 AND is_primary = true`,
    [spaceId, projectId, new Date().toISOString()],
  );
}

async function withTransactionIfPool<T>(db: Queryable, fn: (db: Queryable) => Promise<T>): Promise<T> {
  if (isPool(db)) return withTransaction(db, (client) => fn(client));
  return fn(db);
}

function folderColumns(): string {
  return `id, space_id, project_id, created_by_user_id, name, slug, description, kind,
          is_primary, repo_url, default_branch, status,
          protected, system_managed, registered_from, metadata_json,
          allow_external_root, snapshot_retention_days, snapshot_max_count,
          created_at, updated_at`;
}

function folderSelect(): string {
  return `SELECT ${folderColumns()} FROM project_folders`;
}

function isPool(db: Queryable): db is Pool {
  return typeof (db as Partial<Pool>).connect === "function";
}

function mapFolderReadError(error: unknown): never {
  if (!(error instanceof FolderReadError)) throw error;
  throw folderReadHttpError(error);
}

function folderReadHttpError(error: FolderReadError): HttpError {
  switch (error.code) {
    case "not_found":
      return new HttpError(404, error.message);
    case "is_directory":
      return new HttpError(400, error.message);
    case "too_large":
      return new HttpError(413, error.message);
    case "path_forbidden":
      return new HttpError(403, error.message);
  }
  return new HttpError(500, "Unknown Folder read failure");
}

function mapRemoteFolderReadError(result: FolderReadFailure, hostName: string): HttpError {
  const message = result.message ?? `Remote Folder read failed on ${hostName}`;
  switch (result.error) {
    case "path_forbidden":
      return new HttpError(403, message, { detail: message, code: "path_forbidden" });
    case "not_found":
      return new HttpError(404, message, { detail: message, code: "not_found" });
    case "is_directory":
      return new HttpError(400, message, { detail: message, code: "is_directory" });
    case "too_large":
      return new HttpError(413, message, { detail: message, code: "too_large" });
    case "location_unknown":
      return new HttpError(409, `The daemon on ${hostName} no longer knows this directory. Run 'rainver-host workspace add' there.`, {
        detail: `The daemon on ${hostName} no longer knows this directory. Run 'rainver-host workspace add' there.`,
        code: "location_unknown_on_host",
        host_name: hostName,
      });
    case "host_timeout":
      return new HttpError(409, `The host ${hostName} did not respond in time.`, { detail: `The host ${hostName} did not respond in time.`, code: "host_timeout", host_name: hostName });
    case "host_offline":
      return new HttpError(409, `The host ${hostName} is offline.`, { detail: `The host ${hostName} is offline.`, code: "host_offline", host_name: hostName });
    case "read_failed":
      return new HttpError(502, message, { detail: message, code: "read_failed", host_name: hostName });
  }
  return new HttpError(502, message, { detail: message, code: "read_failed", host_name: hostName });
}

function mapRemoteFolderWriteError(
  result: { ok: false; error: FolderWriteFailureCode; message?: string },
  hostName: string,
): HttpError {
  const message = result.message ?? `Remote Folder write failed on ${hostName}`;
  switch (result.error) {
    case "path_forbidden":
      return new HttpError(403, message, { detail: message, code: "path_forbidden" });
    case "not_found":
      return new HttpError(404, message, { detail: message, code: "not_found" });
    case "is_directory":
      return new HttpError(400, message, { detail: message, code: "is_directory" });
    case "too_large":
      return new HttpError(413, message, { detail: message, code: "too_large" });
    case "not_text":
      return new HttpError(415, message, { detail: message, code: "not_text", host_name: hostName });
    case "stale":
      return new HttpError(409, message, { detail: message, code: "stale_file" });
    case "location_unknown":
      return new HttpError(409, `The daemon on ${hostName} no longer knows this directory. Run 'rainver-host workspace add' there.`, {
        detail: `The daemon on ${hostName} no longer knows this directory. Run 'rainver-host workspace add' there.`,
        code: "location_unknown_on_host",
        host_name: hostName,
      });
    case "host_timeout":
      return new HttpError(409, `The host ${hostName} did not respond in time.`, { detail: `The host ${hostName} did not respond in time.`, code: "host_timeout", host_name: hostName });
    case "host_offline":
      return new HttpError(409, `The host ${hostName} is offline.`, { detail: `The host ${hostName} is offline.`, code: "host_offline", host_name: hostName });
    case "write_failed":
      return new HttpError(502, message, { detail: message, code: "write_failed", host_name: hostName });
  }
  return new HttpError(502, message, { detail: message, code: "write_failed", host_name: hostName });
}

function parseDraftMutation(body: Record<string, unknown>): ProjectFileDraftMutation {
  const targetKind = body.target_kind === "new" || body.target_kind === "existing" ? body.target_kind : null;
  if (!targetKind) throw new HttpError(422, "target_kind must be existing or new");
  const relativePath = parseEditablePath(body.relative_path);
  if (typeof body.content !== "string") throw new HttpError(422, "content is required");
  const byteSize = body.byte_size;
  if (!Number.isSafeInteger(byteSize) || (byteSize as number) < 0 || (byteSize as number) > PROJECT_FILE_DRAFT_MAX_BYTES) {
    throw new HttpError(422, "byte_size is outside the draft limit");
  }
  const actualByteSize = Buffer.byteLength(body.content, "utf8");
  if (actualByteSize !== byteSize) throw new HttpError(422, "byte_size does not match UTF-8 content");
  const contentSha256 = body.content_sha256;
  if (typeof contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(contentSha256) || contentSha256 !== hashText(body.content)) {
    throw new HttpError(422, "content_sha256 does not match UTF-8 content");
  }
  const baseExists = body.base_exists;
  if (typeof baseExists !== "boolean") throw new HttpError(422, "base_exists is required");
  if (targetKind === "new" && baseExists) {
    throw new HttpError(422, "base_exists must be false for a new file");
  }
  const baseSha256 = body.base_sha256 === null ? null : body.base_sha256;
  if (baseExists && (typeof baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(baseSha256))) {
    throw new HttpError(422, "base_sha256 is required for an existing file");
  }
  if (!baseExists && baseSha256 !== null) throw new HttpError(422, "base_sha256 must be null for a new file");
  const sourceEncoding = body.source_encoding === "utf8" || body.source_encoding === "utf16le" || body.source_encoding === "utf16be"
    ? body.source_encoding
    : null;
  if (!sourceEncoding) throw new HttpError(422, "source_encoding is invalid");
  const preserveBom = body.preserve_bom;
  if (typeof preserveBom !== "boolean") throw new HttpError(422, "preserve_bom is required");
  const lineEndingMode = body.line_ending_mode === "lf" || body.line_ending_mode === "crlf" || body.line_ending_mode === "mixed" || body.line_ending_mode === "none"
    ? body.line_ending_mode
    : null;
  if (!lineEndingMode) throw new HttpError(422, "line_ending_mode is invalid");
  const expectedVersion = body.expected_version === undefined || body.expected_version === null
    ? body.expected_version ?? null
    : positiveInteger(body.expected_version, "expected_version");
  return {
    expectedVersion,
    targetKind,
    relativePath,
    baseExists,
    baseSha256: baseSha256 as string | null,
    content: body.content,
    contentSha256,
    byteSize: byteSize as number,
    sourceEncoding,
    preserveBom,
    lineEndingMode,
  };
}

function serializeDraftText(draft: ProjectFileDraftRow): string {
  let content = draft.content.replace(/\r\n|\r|\n/gu, "\n");
  if (content.startsWith("\uFEFF")) content = content.slice(1);
  if (draft.line_ending_mode === "crlf") content = content.replace(/\n/gu, "\r\n");
  if (draft.preserve_bom && !content.startsWith("\uFEFF")) content = `\uFEFF${content}`;
  return content;
}

function revisionText(file: FileContent): string {
  return file.has_bom ? `\uFEFF${file.content}` : file.content;
}

function lineEndingMode(content: string): "lf" | "crlf" | "mixed" | "none" {
  const crlf = /\r\n/u.test(content);
  const loneLf = /(^|[^\r])\n/u.test(content);
  const loneCr = /\r(?!\n)/u.test(content);
  if (!crlf && !loneLf && !loneCr) return "none";
  if (loneCr || (crlf && loneLf)) return "mixed";
  return crlf ? "crlf" : "lf";
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new HttpError(422, `${field} must be a positive integer`);
  return value as number;
}

function parseEditablePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || !isWireRelativePath(value) || value === ".") {
    throw new HttpError(422, "path must be a relative file path");
  }
  const path = value.trim();
  if (path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new HttpError(422, "path must not contain traversal segments");
  }
  return path;
}

function assertRemoteWriteAccess(location: ActiveLocationWithHost, userId: string): void {
  if (location.host_owner_user_id !== userId) {
    throw new HttpError(403, `This Folder is on ${location.host_name}'s machine; only its owner can edit it here.`, {
      detail: `This Folder is on ${location.host_name}'s machine; only its owner can edit it here.`,
      code: "host_not_owned",
      host_name: location.host_name,
    });
  }
  if (!location.host_online) {
    throw new HttpError(409, `This Folder is on ${location.host_name}, which is offline.`, {
      detail: `This Folder is on ${location.host_name}, which is offline.`,
      code: "host_offline",
      host_name: location.host_name,
      last_heartbeat_at: location.last_heartbeat_at,
    });
  }
}

/**
 * The saved file exactly as a fresh `getFile` would report it: `content` is the
 * decoded body without its BOM, while `size`/`sha256` describe the bytes on
 * disk. Returning a body-only shape here made the cached result drop
 * `has_bom`/`encoding`, so the next draft built from it silently stripped the
 * file's BOM.
 */
function savedFileContent(draft: ProjectFileDraftRow, serialized: string, sha256: string): FileContent {
  const content = draft.preserve_bom && serialized.startsWith("\uFEFF") ? serialized.slice(1) : serialized;
  return {
    path: draft.relative_path,
    content,
    size: Buffer.byteLength(serialized, "utf8"),
    line_count: content.split(/\n/).length,
    sha256,
    encoding: "utf8",
    has_bom: draft.preserve_bom,
    line_ending_mode: lineEndingMode(content),
    writable: true,
    conversion_available: false,
  };
}

function hashText(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function folderReadAuditReasons(
  folder: ProjectFolderRow,
  readKind: string,
  relativePath: string | null,
): string[] {
  const reasons: string[] = [];
  if (folder.system_managed) reasons.push("system_managed");
  if (folder.protected) reasons.push("protected_folder");
  if (readKind === "git_diff" && relativePath === null) reasons.push("full_diff");
  if (looksSecretLikePath(relativePath)) reasons.push("secret_like_path");
  return reasons;
}

function folderDirName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "folder";
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value);
  if (!text) throw new HttpError(422, `${field} is required`);
  return text;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

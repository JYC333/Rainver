import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildTree,
  folderGitDiff,
  folderGitStatus,
  FolderReadError,
  isWireRelativePath,
  looksSecretLikePath,
  readFolderFile,
  resolveRelativePath,
  runGit,
  type FileContent,
  type FileNode,
  type GitStatus,
} from "@rainver/folder-read";
import { sharedHostConnectionRegistry, type FolderReadFailure, type FolderReadKind, type FolderReadPayload } from "../hosts/connectionRegistry.js";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { withTransaction } from "../../db/tx.js";
import { loadActionRegistry } from "../policy/actionRegistry.js";
import { enforce } from "../policy/service.js";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriter } from "../projects/access.js";
import { projectFolderReadAccessSql } from "./access.js";
import { PgHostRepository } from "../hosts/repository.js";
import {
  PgWorkspaceLocationRepository,
  locationAbsoluteRoot,
  resolvePreferredLocationWithHost,
  type PreferredLocationWithHost,
} from "./workspaceLocations.js";

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
  allow_external_root: boolean;
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
      rootPath = await this.createManagedDir(identity.spaceId, name);
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
      // flow's single physical checkout is this Folder's one (and, at
      // creation time, only) Location — created `preferred` automatically.
      await new PgWorkspaceLocationRepository(db).create({
        spaceId: identity.spaceId,
        projectFolderId: id,
        executionHostId: serverHostId,
        executionHostKind: "server",
        rootPath,
      });
      return folderToOut(row.rows[0]!);
    });
    const location = await new PgWorkspaceLocationRepository(this.db).getPreferred(id);
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
  async unregister(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<boolean> {
    await this.assertProjectActive(identity, projectId, { allowArchived: true });
    const result = await this.db.query(
      `DELETE FROM project_folders WHERE id = $1 AND space_id = $2 AND project_id = $3`,
      [folderId, identity.spaceId, projectId],
    );
    return (result.rowCount ?? 0) > 0;
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

  async getTree(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<FileNode> {
    const folder = await this.requireReadableActiveFolder(identity, projectId, folderId);
    const location = await resolvePreferredLocationWithHost(this.db, identity.spaceId, folderId);
    if (location.execution_host_kind === "remote") {
      return this.readRemote(folder, identity.userId, location, "tree");
    }
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    await this.enforceFolderRead(folder, identity.userId, "tree");
    try {
      return await buildTree(root);
    } catch (error) {
      throw mapFolderReadError(error);
    }
  }

  async getFile(identity: SpaceUserIdentity, projectId: string, folderId: string, requestedPath: string): Promise<FileContent> {
    const folder = await this.requireReadableActiveFolder(identity, projectId, folderId);
    const location = await resolvePreferredLocationWithHost(this.db, identity.spaceId, folderId);
    if (location.execution_host_kind === "remote") {
      return this.readRemote(folder, identity.userId, location, "file", requestedPath);
    }
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    const relPath = resolveRelativePath(root, requestedPath, { protectedFolder: folder.protected }).relative;
    await this.enforceFolderRead(folder, identity.userId, "file", relPath);
    try {
      const content = await readFolderFile(root, requestedPath, { protectedFolder: folder.protected });
      return { ...content, path: requestedPath };
    } catch (error) {
      throw mapFolderReadError(error);
    }
  }

  async getGitStatus(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<GitStatus> {
    const folder = await this.requireReadableActiveFolder(identity, projectId, folderId);
    const location = await resolvePreferredLocationWithHost(this.db, identity.spaceId, folderId);
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
    const location = await resolvePreferredLocationWithHost(this.db, identity.spaceId, folderId);
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

  // Folder access inherits the Project ACL completely — the Project
  // writer/active check is the only authority gate for Folder mutation.
  private async assertProjectActive(
    identity: SpaceUserIdentity,
    projectId: string,
    options: { allowArchived?: boolean } = {},
  ): Promise<void> {
    await assertProjectWriter(this.db, identity.spaceId, projectId, identity.userId, options);
  }

  private async createManagedDir(spaceId: string, name: string): Promise<string> {
    const spaceRoot = resolve(this.config.workspaceRoot, spaceId);
    await mkdir(spaceRoot, { recursive: true });
    const base = folderDirName(name);
    let candidate = resolve(spaceRoot, base);
    for (let i = 1; await stat(candidate).catch(() => null); i += 1) {
      candidate = resolve(spaceRoot, `${base}-${i}`);
    }
    await mkdir(candidate, { recursive: true });
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
        folder_external_root: Boolean(folder.allow_external_root),
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

  private async readRemote<K extends FolderReadKind>(
    folder: ProjectFolderRow,
    userId: string,
    location: PreferredLocationWithHost,
    kind: K,
    requestedPath?: string,
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
    });
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
  switch (error.code) {
    case "not_found":
      throw new HttpError(404, error.message);
    case "is_directory":
      throw new HttpError(400, error.message);
    case "too_large":
      throw new HttpError(413, error.message);
    case "path_forbidden":
      throw new HttpError(403, error.message);
  }
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
}

function folderReadAuditReasons(
  folder: ProjectFolderRow,
  readKind: string,
  relativePath: string | null,
): string[] {
  const reasons: string[] = [];
  if (folder.system_managed) reasons.push("system_managed");
  if (folder.allow_external_root) reasons.push("external_root");
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

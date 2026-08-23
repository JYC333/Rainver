import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ServerConfig } from "../../config";
import { getDbPool, type Pool } from "../../db/pool";
import { withTransaction } from "../../db/tx";
import { loadActionRegistry } from "../policy/actionRegistry";
import { enforce } from "../policy/service";
import { HttpError, type Queryable, type SpaceUserIdentity } from "../routeUtils/common";
import { assertProjectWriter } from "../projects/access";
import { projectFolderReadAccessSql } from "./access";
import {
  diffTouchesSecretLikePath,
  looksSecretLikePath,
  redactSecretLikeDiff,
  validatePath,
} from "./pathPolicy";
import { isGitRepo, runGit } from "./git";
import { PgHostRepository } from "../hosts/repository";

const MAX_DEPTH = 5;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1_048_576;
const MAX_DIFF_BYTES = 512 * 1024;
const FOLDER_KINDS = new Set(["code", "data", "docs"]);

const IGNORE_DIRS = new Set([
  ".git",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
]);
const SHOW_HIDDEN = new Set([
  ".gitignore",
  ".env.example",
  ".env.dev.example",
  ".env.test.example",
  ".env.prod.example",
  ".claude",
  ".editorconfig",
]);

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
  execution_enabled: boolean;
  repo_url: string | null;
  root_path: string | null;
  default_branch: string | null;
  status: string;
  protected: boolean;
  system_managed: boolean;
  registered_from: string | null;
  metadata_json: Record<string, unknown> | null;
  allow_external_root: boolean;
  snapshot_retention_days: number | null;
  snapshot_max_count: number | null;
  host_id: string;
  host_kind: string;
  display_path: string | null;
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
  execution_enabled: boolean;
  repo_url: string | null;
  root_path: string | null;
  default_branch: string | null;
  status: string;
  protected: boolean;
  system_managed: boolean;
  registered_from: string | null;
  metadata_json: Record<string, unknown> | null;
  snapshot_retention_days: number | null;
  snapshot_max_count: number | null;
  host_id: string;
  host_kind: string;
  display_path: string | null;
  created_at: string;
  updated_at: string;
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

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: FileNode[];
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  line_count: number;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  files: Array<{ path: string; status: string }>;
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
    return withTransactionIfPool(this.db, async (db) => {
      if (isPrimary) await demotePrimary(db, identity.spaceId, projectId);
      const row = await db.query<ProjectFolderRow>(
        `INSERT INTO project_folders (
           id, space_id, project_id, created_by_user_id, name, description, kind,
           is_primary, execution_enabled, repo_url, root_path, default_branch,
           metadata_json, status, protected, system_managed, registered_from,
           host_id, host_kind,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, true, $9, $10, $11,
           $12::jsonb, 'active', false, $13, $14,
           $15, 'server',
           $16, $16
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
          rootPath,
          optionalText(body.default_branch),
          JSON.stringify(optionalObject(body.metadata_json)),
          registeredFrom !== "scan",
          registeredFrom,
          serverHostId,
          now,
        ],
      );
      return folderToOut(row.rows[0]!);
    });
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
      `SELECT root_path FROM project_folders WHERE space_id = $1 AND status = 'active'`,
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
      "execution_enabled",
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
   * Removes only the Agent-Space registration row. Never deletes, moves, or
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
   */
  async createRemoteWorkspace(
    projectId: string,
    userId: string,
    hostId: string,
    input: { name: string; displayPath: string | null },
  ): Promise<ProjectFolderOut> {
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
    const row = await this.db.query<ProjectFolderRow>(
      `INSERT INTO project_folders (
         id, space_id, project_id, created_by_user_id, name, root_path, status,
         kind, is_primary, execution_enabled, protected, system_managed,
         registered_from, host_id, host_kind, display_path,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, NULL, 'active',
         'code', false, true, false, false,
         'daemon_registered', $6, 'remote', $7,
         $8, $8
       )
       RETURNING ${folderColumns()}`,
      [id, spaceId, projectId, userId, name, hostId, optionalText(input.displayPath), now],
    );
    return folderToOut(row.rows[0]!);
  }

  /** `workspace list`: every active Folder registered under this host. */
  async listForHost(hostId: string): Promise<ProjectFolderOut[]> {
    const result = await this.db.query<ProjectFolderRow>(
      `${folderSelect()} WHERE host_id = $1 AND status = 'active' ORDER BY created_at ASC`,
      [hostId],
    );
    return result.rows.map(folderToOut);
  }

  /**
   * `workspace remove`: removes only the registration row, scoped to the
   * calling host's own token — a host can never remove another host's
   * workspace, and this never touches the directory itself (the daemon owns
   * that; see `unregister` for the equivalent server-host semantics).
   */
  async unregisterForHost(hostId: string, folderId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM project_folders WHERE id = $1 AND host_id = $2 AND host_kind = 'remote'`,
      [folderId, hostId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getTree(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<FileNode> {
    const folder = await this.requireActiveFolder(identity.spaceId, projectId, folderId);
    assertServerHostFolder(folder);
    await this.enforceFolderRead(folder, identity.userId, "tree");
    const root = projectFolderAbsoluteRoot(folder, this.config.workspaceRoot);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) throw new HttpError(404, "Project Folder directory not found on disk");
    return buildTree(root, root, 0, { count: 0 });
  }

  async getFile(identity: SpaceUserIdentity, projectId: string, folderId: string, requestedPath: string): Promise<FileContent> {
    const folder = await this.requireActiveFolder(identity.spaceId, projectId, folderId);
    assertServerHostFolder(folder);
    const root = projectFolderAbsoluteRoot(folder, this.config.workspaceRoot);
    const safe = validatePath({
      path: resolve(root, requestedPath),
      allowedRoot: root,
      mode: "read",
      protectedFolder: folder.protected,
    });
    const info = await stat(safe).catch(() => null);
    if (!info) throw new HttpError(404, "File not found");
    if (!info.isFile()) throw new HttpError(400, "Path is a directory");
    const relPath = relative(root, safe).split("\\").join("/");
    await this.enforceFolderRead(folder, identity.userId, "file", relPath);
    if (info.size > MAX_FILE_BYTES) {
      throw new HttpError(413, "File too large to display (max 1 MiB)");
    }
    const content = await readFile(safe, "utf8");
    return {
      path: requestedPath,
      content,
      size: info.size,
      line_count: content.split(/\n/).length,
    };
  }

  async getGitStatus(identity: SpaceUserIdentity, projectId: string, folderId: string): Promise<GitStatus> {
    const folder = await this.requireActiveFolder(identity.spaceId, projectId, folderId);
    assertServerHostFolder(folder);
    await this.enforceFolderRead(folder, identity.userId, "git_status");
    const root = projectFolderAbsoluteRoot(folder, this.config.workspaceRoot);
    if (!await isGitRepo(root)) return { is_repo: false, branch: null, files: [] };
    const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], root, 10_000)).stdout.trim() || null;
    const raw = await runGit(["status", "--porcelain"], root, 10_000);
    return { is_repo: true, branch, files: parsePorcelain(raw.stdout) };
  }

  async getGitDiff(
    identity: SpaceUserIdentity,
    projectId: string,
    folderId: string,
    requestedPath: string | null,
  ): Promise<{ diff: string; path: string | null; truncated: boolean; redacted: boolean }> {
    const folder = await this.requireActiveFolder(identity.spaceId, projectId, folderId);
    assertServerHostFolder(folder);
    const root = projectFolderAbsoluteRoot(folder, this.config.workspaceRoot);
    let relPath: string | null = null;
    if (requestedPath) {
      const safe = validatePath({
        path: resolve(root, requestedPath),
        allowedRoot: root,
        mode: "read",
        protectedFolder: folder.protected,
      });
      relPath = relative(root, safe).split("\\").join("/");
    }
    await this.enforceFolderRead(folder, identity.userId, "git_diff", relPath);
    const args = requestedPath ? ["diff", "HEAD", "--", relPath ?? requestedPath] : ["diff", "HEAD", "--"];
    let diff = (await runGit(args, root, 15_000)).stdout;
    if (!diff) {
      diff = (await runGit(requestedPath ? ["diff", "--", relPath ?? requestedPath] : ["diff", "--"], root, 15_000)).stdout;
    }
    if (diffTouchesSecretLikePath(diff)) {
      throw new HttpError(403, "Diff includes blocked path");
    }
    const redacted = redactSecretLikeDiff(diff);
    diff = redacted.diff;
    const encoded = Buffer.from(diff, "utf8");
    const truncated = encoded.length > MAX_DIFF_BYTES;
    if (truncated) diff = encoded.subarray(0, MAX_DIFF_BYTES).toString("utf8");
    return { diff, path: requestedPath, truncated, redacted: redacted.redacted };
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

  private async requireActiveFolder(spaceId: string, projectId: string, folderId: string): Promise<ProjectFolderRow> {
    const folder = await this.getRow(spaceId, projectId, folderId, true);
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
      `SELECT id FROM project_folders WHERE space_id = $1 AND root_path = $2 AND status = 'active' LIMIT 1`,
      [spaceId, canonicalPath],
    );
    if (collision.rows[0]) throw new HttpError(409, "This directory is already a registered Project Folder");
    return canonicalPath;
  }

  private async enforceFolderRead(
    folder: ProjectFolderRow,
    userId: string,
    readKind: string,
    relativePath: string | null = null,
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
        audit_reasons: auditReasons,
      },
      metadata_json: {
        read_kind: readKind,
        relative_path: relativePath,
        audit_reasons: auditReasons,
      },
      force_record: auditReasons.length > 0,
    });
    if (result.status === "allow") return;
    if (result.status === "error") {
      throw new HttpError(500, result.message ?? "Project Folder read policy audit failed");
    }
    throw new HttpError(403, result.message ?? "Project Folder read denied by policy");
  }
}

/**
 * ADR 0016 / B62-B64: a remote-host Folder has no server-side path at all —
 * `root_path` is always NULL for it (schema-enforced,
 * `ck_project_folders_remote_no_root_path`). Every repository method that
 * touches the local filesystem must call this first, so a remote row can
 * never fall through to `projectFolderAbsoluteRoot`'s `resolve(workspaceRoot,
 * folder.id)` default and accidentally read/write a server-local path that
 * has nothing to do with the folder it claims to represent.
 */
export function assertServerHostFolder(folder: Pick<ProjectFolderRow, "host_kind">): void {
  if (folder.host_kind !== "server") {
    throw new HttpError(409, "This Project Folder is bound to a remote execution host; the server holds no local path for it.");
  }
}

export function projectFolderAbsoluteRoot(
  folder: Pick<ProjectFolderRow, "id" | "root_path">,
  workspaceRoot: string,
): string {
  if (folder.root_path) {
    return isAbsolute(folder.root_path)
      ? resolve(folder.root_path)
      : resolve(workspaceRoot, folder.root_path);
  }
  return resolve(workspaceRoot, folder.id);
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
    execution_enabled: Boolean(row.execution_enabled),
    repo_url: row.repo_url,
    root_path: row.root_path,
    default_branch: row.default_branch,
    status: row.status,
    protected: Boolean(row.protected),
    system_managed: Boolean(row.system_managed),
    registered_from: row.registered_from,
    metadata_json: row.metadata_json,
    snapshot_retention_days: row.snapshot_retention_days,
    snapshot_max_count: row.snapshot_max_count,
    host_id: row.host_id,
    host_kind: row.host_kind,
    display_path: row.display_path,
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
          is_primary, execution_enabled, repo_url, root_path, default_branch, status,
          protected, system_managed, registered_from, metadata_json,
          allow_external_root, snapshot_retention_days, snapshot_max_count,
          host_id, host_kind, display_path,
          created_at, updated_at`;
}

function folderSelect(): string {
  return `SELECT ${folderColumns()} FROM project_folders`;
}

function isPool(db: Queryable): db is Pool {
  return typeof (db as Partial<Pool>).connect === "function";
}

async function buildTree(root: string, nodePath: string, depth: number, counter: { count: number }): Promise<FileNode> {
  const info = await stat(nodePath);
  const rel = nodePath === root ? "." : relative(root, nodePath).split("\\").join("/");
  const node: FileNode = {
    name: nodePath === root ? root.split(/[\\/]/).pop() || root : nodePath.split(/[\\/]/).pop() || nodePath,
    path: rel,
    type: info.isDirectory() ? "dir" : "file",
  };
  if (info.isFile()) {
    node.size = info.size;
    return node;
  }
  if (!info.isDirectory() || depth >= MAX_DEPTH || counter.count >= MAX_FILES) {
    return node;
  }
  const entries = await readdir(nodePath, { withFileTypes: true }).catch(() => []);
  const children: FileNode[] = [];
  for (const entry of entries.sort((a, b) => Number(a.isFile()) - Number(b.isFile()) || a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && !SHOW_HIDDEN.has(entry.name)) continue;
    counter.count += 1;
    if (counter.count > MAX_FILES) break;
    children.push(await buildTree(root, join(nodePath, entry.name), depth + 1, counter));
  }
  node.children = children;
  return node;
}

function parsePorcelain(output: string): Array<{ path: string; status: string }> {
  const result: Array<{ path: string; status: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    const path = line.slice(3).trim();
    let status = "modified";
    if (xy.includes("?")) status = "untracked";
    else if (xy.includes("R")) status = "renamed";
    else if (xy.includes("D")) status = "deleted";
    else if (xy.includes("A")) status = "added";
    result.push({ path, status });
  }
  return result;
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

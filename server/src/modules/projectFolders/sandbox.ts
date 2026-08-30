import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, type Queryable } from "../routeUtils/common.js";
import type { RunRecord } from "../runs/repository.js";
import { gitOutput, isGitRepo, isInside, runGit } from "@rainver/folder-read";
import { PgProjectFolderRepository, type ProjectFolderRow } from "./repository.js";
import { resolveServerHostLocationForRun, locationAbsoluteRoot } from "./workspaceLocations.js";

export interface PreparedRunSandbox {
  sandbox_cwd: string | null;
  context_cwd: string | null;
  cleanup_kind: "none" | "plain_workdir" | "git_worktree";
  sandbox_kind: "none" | "plain_workdir" | "read_only_project" | "worktree";
  project_folder_root: string | null;
  base_commit_sha: string | null;
  project_folder_is_dirty: boolean | null;
}

export interface RunSandboxManagerPort {
  prepareRunWorkspace(run: RunRecord): Promise<PreparedRunSandbox>;
  cleanupRunWorkspace(input: {
    runId: string;
    spaceId: string;
    cleanupKind: string;
    sandboxCwd: string | null;
    workspaceRoot: string | null;
  }): Promise<void>;
  gcSandboxes(maxAgeMs?: number): Promise<{ removed: number; errors: number }>;
}

const WORKTREE_ROOT_DIR = "worktrees";
const READ_ONLY_CONTEXT_ROOT_DIR = "read-only-context";
const DEFAULT_GC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class PgRunSandboxManager implements RunSandboxManagerPort {
  constructor(
    private readonly config: ServerConfig,
    private readonly db: Queryable,
  ) {}

  static fromConfig(config: ServerConfig): PgRunSandboxManager {
    if (!config.databaseUrl) {
      throw new HttpError(502, "Run sandbox manager requires SERVER_DATABASE_URL");
    }
    return new PgRunSandboxManager(config, getDbPool(config.databaseUrl));
  }

  async prepareRunWorkspace(run: RunRecord): Promise<PreparedRunSandbox> {
    const level = run.required_sandbox_level ?? "none";
    if (level === "none" || level === "dry_run") {
      return emptyPreparedSandbox();
    }
    if (
      level !== "worktree"
      && level !== "ephemeral"
      && level !== "read_only"
      && level !== "one_shot_docker"
    ) {
      throw new HttpError(422, `Unsupported sandbox level ${JSON.stringify(level)}`);
    }

    const projectFolderId = run.project_folder_id;
    if (!projectFolderId) {
      return this.preparePlainWorkdir(run);
    }

    const folder = await new PgProjectFolderRepository(this.db, this.config)
      .getFolder(run.space_id, projectFolderId, true);
    if (!folder) {
      throw new HttpError(404, "Project Folder not found");
    }
    // ADR 0016 P1: sandbox provisioning (worktree/read-only/managed dir) is
    // server-host-only. Resolve the Run-bound Location, not the Folder's
    // mutable preferred Location; remote-host Runs are rejected before any
    // local filesystem path is resolved.
    const location = await resolveServerHostLocationForRun(this.db, {
      space_id: run.space_id,
      project_folder_id: projectFolderId,
      workspace_location_id: run.workspace_location_id,
    });
    const folderRoot = await this.validateFolderRoot(folder, location);
    if (level === "read_only") {
      const contextCwd = this.readOnlyContextPath(run.space_id, run.id);
      await rm(contextCwd, { recursive: true, force: true });
      await mkdir(contextCwd, { recursive: true, mode: 0o700 });
      let executionRoot = folderRoot;
      if (!isInside(folderRoot, this.config.workspaceRoot)) {
        executionRoot = resolve(contextCwd, "external-project");
        await cp(folderRoot, executionRoot, { recursive: true, verbatimSymlinks: true });
      }
      await this.setRunSandboxPath(run.space_id, run.id, contextCwd);
      return {
        sandbox_cwd: executionRoot,
        context_cwd: contextCwd,
        cleanup_kind: "plain_workdir",
        sandbox_kind: "read_only_project",
        project_folder_root: folderRoot,
        base_commit_sha: null,
        project_folder_is_dirty: null,
      };
    }
    if (!await isGitRepo(folderRoot)) {
      throw new HttpError(422, "Project Folder worktree execution requires a git repository");
    }

    const baseCommitSha = (await gitOutput(["rev-parse", "HEAD"], folderRoot, 10_000)).trim();
    const status = await runGit(["status", "--porcelain"], folderRoot, 10_000);
    const sandboxCwd = this.runSandboxPath(run.space_id, run.id);
    await this.removeExistingSandbox(sandboxCwd, folderRoot, "git_worktree");
    await mkdir(resolve(this.config.sandboxRoot, WORKTREE_ROOT_DIR, run.space_id), { recursive: true });
    // A detached standalone clone keeps the isolated workspace's Git object
    // database inside the selected sandbox. Mounting the source repository's
    // absolute `.git/worktrees/*` backing path into a runtime namespace would
    // otherwise widen the Runner authority boundary.
    await gitOutput(["clone", "--no-local", "--no-checkout", folderRoot, sandboxCwd], dirname(sandboxCwd), 60_000);
    await gitOutput(["checkout", "--detach", baseCommitSha], sandboxCwd, 60_000);
    await this.setRunSandboxPath(run.space_id, run.id, sandboxCwd);
    return {
      sandbox_cwd: sandboxCwd,
      context_cwd: sandboxCwd,
      cleanup_kind: "plain_workdir",
      sandbox_kind: "worktree",
      project_folder_root: folderRoot,
      base_commit_sha: baseCommitSha,
      project_folder_is_dirty: status.stdout.trim().length > 0,
    };
  }

  async cleanupRunWorkspace(input: {
    runId: string;
    spaceId: string;
    cleanupKind: string;
    sandboxCwd: string | null;
    workspaceRoot: string | null;
  }): Promise<void> {
    if (!input.sandboxCwd) {
      await this.clearRunSandboxPath(input.spaceId, input.runId);
      return;
    }
    const sandboxCwd = resolve(input.sandboxCwd);
    if (!isInside(sandboxCwd, resolve(this.config.sandboxRoot))) {
      throw new HttpError(403, "Refusing to remove sandbox outside SANDBOX_ROOT");
    }
    if (input.cleanupKind === "git_worktree" && input.workspaceRoot) {
      const folderRoot = resolve(input.workspaceRoot);
      await runGit(["worktree", "remove", "--force", sandboxCwd], folderRoot, 60_000)
        .catch(() => undefined);
    }
    await rm(sandboxCwd, { recursive: true, force: true });
    await this.clearRunSandboxPath(input.spaceId, input.runId);
  }

  async gcSandboxes(maxAgeMs = DEFAULT_GC_MAX_AGE_MS): Promise<{ removed: number; errors: number }> {
    const root = resolve(this.config.sandboxRoot, WORKTREE_ROOT_DIR);
    const cutoff = Date.now() - maxAgeMs;
    const spaceEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    let errors = 0;
    for (const spaceEntry of spaceEntries) {
      if (!spaceEntry.isDirectory()) continue;
      const spacePath = resolve(root, spaceEntry.name);
      const runEntries = await readdir(spacePath, { withFileTypes: true }).catch(() => []);
      for (const runEntry of runEntries) {
        if (!runEntry.isDirectory()) continue;
        const path = resolve(spacePath, runEntry.name);
        try {
          const info = await stat(path);
          if (info.mtimeMs >= cutoff) continue;
          await rm(path, { recursive: true, force: true });
          removed += 1;
        } catch {
          errors += 1;
        }
      }
    }
    return { removed, errors };
  }

  private async preparePlainWorkdir(run: RunRecord): Promise<PreparedRunSandbox> {
    const sandboxCwd = this.runSandboxPath(run.space_id, run.id);
    await this.removeExistingSandbox(sandboxCwd, null, "plain_workdir");
    await mkdir(sandboxCwd, { recursive: true });
    await this.setRunSandboxPath(run.space_id, run.id, sandboxCwd);
    return {
      sandbox_cwd: sandboxCwd,
      context_cwd: sandboxCwd,
      cleanup_kind: "plain_workdir",
      sandbox_kind: "plain_workdir",
      project_folder_root: null,
      base_commit_sha: null,
      project_folder_is_dirty: null,
    };
  }

  private runSandboxPath(spaceId: string, runId: string): string {
    const root = resolve(this.config.sandboxRoot, WORKTREE_ROOT_DIR);
    const path = resolve(root, spaceId, runId);
    if (!isInside(path, root)) {
      throw new HttpError(403, "Invalid sandbox path");
    }
    return path;
  }

  private readOnlyContextPath(spaceId: string, runId: string): string {
    const root = resolve(this.config.sandboxRoot, READ_ONLY_CONTEXT_ROOT_DIR);
    const path = resolve(root, spaceId, runId);
    if (!isInside(path, root)) {
      throw new HttpError(403, "Invalid read-only context path");
    }
    return path;
  }

  private async validateFolderRoot(folder: ProjectFolderRow, location: Parameters<typeof locationAbsoluteRoot>[0]): Promise<string> {
    const root = locationAbsoluteRoot(location, this.config.workspaceRoot);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) {
      throw new HttpError(404, "Project Folder directory not found on disk");
    }
    if (!folder.allow_external_root && !isInside(root, this.config.workspaceRoot)) {
      throw new HttpError(403, "Project Folder root is outside WORKSPACE_ROOT");
    }
    return root;
  }

  private async removeExistingSandbox(
    sandboxCwd: string,
    folderRoot: string | null,
    cleanupKind: string,
  ): Promise<void> {
    const exists = await stat(sandboxCwd).catch(() => null);
    if (!exists) return;
    if (cleanupKind === "git_worktree" && folderRoot) {
      await runGit(["worktree", "remove", "--force", sandboxCwd], folderRoot, 60_000)
        .catch(() => undefined);
    }
    await rm(sandboxCwd, { recursive: true, force: true });
  }

  private async setRunSandboxPath(spaceId: string, runId: string, sandboxPath: string): Promise<void> {
    await this.db.query(
      `UPDATE runs SET sandbox_path = $3, updated_at = $4 WHERE id = $1 AND space_id = $2`,
      [runId, spaceId, sandboxPath, new Date().toISOString()],
    );
  }

  private async clearRunSandboxPath(spaceId: string, runId: string): Promise<void> {
    await this.db.query(
      `UPDATE runs SET sandbox_path = NULL, updated_at = $3 WHERE id = $1 AND space_id = $2`,
      [runId, spaceId, new Date().toISOString()],
    );
  }
}

function emptyPreparedSandbox(): PreparedRunSandbox {
  return {
    sandbox_cwd: null,
    context_cwd: null,
    cleanup_kind: "none",
    sandbox_kind: "none",
    project_folder_root: null,
    base_commit_sha: null,
    project_folder_is_dirty: null,
  };
}

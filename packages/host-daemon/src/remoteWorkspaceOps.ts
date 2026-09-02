import { readdir, stat } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import { workspaceAdd } from "./commands/workspace.js";
import { requireConfig, saveConfig } from "./config.js";

/**
 * The daemon side of registering a workspace from the web UI (plan
 * `host-workspace-frontend-registration-plan.md`). The control plane forwards
 * the owner's request over the WS; this module answers it the same way the
 * CLI does — the daemon stays the only thing that resolves or validates a
 * path (ADR 0016 §3).
 */

export const LIST_DIRS_MAX_ENTRIES = 500;

export interface ListDirsResult {
  ok: boolean;
  path: string | null;
  parent: string | null;
  dirs: string[];
  truncated: boolean;
  error: string | null;
}

/** One level of subdirectory names — the VS Code-Remote readdir shape: lazy, bounded, directories only. */
export async function listDirectories(rawPath: unknown): Promise<ListDirsResult> {
  const failure = (error: string): ListDirsResult => ({ ok: false, path: null, parent: null, dirs: [], truncated: false, error });
  if (typeof rawPath !== "string" || !rawPath.trim()) return failure("path is required");
  if (rawPath.includes("\0")) return failure("path contains an invalid character");
  if (!isAbsolute(rawPath)) return failure("path must be absolute");
  const path = resolve(rawPath);
  const info = await stat(path).catch(() => null);
  if (!info) return failure("Path does not exist on this machine");
  if (!info.isDirectory()) return failure("Not a directory");
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) return failure("Directory could not be read");
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const truncated = dirs.length > LIST_DIRS_MAX_ENTRIES;
  return {
    ok: true,
    path,
    parent: dirname(path) === path ? null : dirname(path),
    dirs: truncated ? dirs.slice(0, LIST_DIRS_MAX_ENTRIES) : dirs,
    truncated,
    error: null,
  };
}

export interface RegisterWorkspaceResult {
  ok: boolean;
  workspace_id: string | null;
  display_path: string | null;
  error: string | null;
}

/** Runs the exact CLI `workspace add` path, so UI and terminal registration cannot diverge. */
export async function registerWorkspace(input: { path: unknown; project_id: unknown; name: unknown }): Promise<RegisterWorkspaceResult> {
  const failure = (error: string): RegisterWorkspaceResult => ({ ok: false, workspace_id: null, display_path: null, error });
  if (typeof input.path !== "string" || !input.path.trim() || !isAbsolute(input.path)) return failure("path must be an absolute path");
  if (typeof input.project_id !== "string" || !input.project_id.trim()) return failure("project_id is required");
  if (typeof input.name !== "string" || !input.name.trim()) return failure("name is required");
  try {
    const created = await workspaceAdd({ path: input.path, projectId: input.project_id, name: input.name.trim() });
    return { ok: true, workspace_id: created.id, display_path: resolve(input.path), error: null };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Drops the local path mapping after a server-side unregister; the row is already gone there. */
export async function forgetWorkspace(workspaceId: unknown): Promise<{ ok: boolean; changed: boolean; error: string | null }> {
  if (typeof workspaceId !== "string" || !workspaceId.trim()) return { ok: false, changed: false, error: "workspace_id is required" };
  const config = await requireConfig();
  if (!(workspaceId in config.workspaces)) return { ok: true, changed: false, error: null };
  const workspaces = { ...config.workspaces };
  delete workspaces[workspaceId];
  await saveConfig({ ...config, workspaces });
  return { ok: true, changed: true, error: null };
}

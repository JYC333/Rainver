import { resolve } from "node:path";
import { createWorkspace, listWorkspaces, removeWorkspace, type WorkspaceOut } from "../api.js";
import { requireConfig, saveConfig } from "../config.js";

export interface LocalWorkspace extends WorkspaceOut {
  local_path: string | null;
}

export async function workspaceAdd(options: { path: string; projectId: string; name: string }): Promise<WorkspaceOut> {
  const config = await requireConfig();
  const absolutePath = resolve(options.path);
  const created = await createWorkspace(config.server_url, config.token, {
    projectId: options.projectId,
    name: options.name,
    displayPath: absolutePath,
  });
  await saveConfig({ ...config, workspaces: { ...config.workspaces, [created.id]: absolutePath } });
  return created;
}

/**
 * Merges the server's view (what is registered) with the local config's
 * view (where it actually lives on this disk) — the two can diverge if a
 * workspace was removed on the server directly, or this config was
 * restored from a backup; both fields are shown so that is visible rather
 * than silently guessed at.
 */
export async function workspaceList(): Promise<LocalWorkspace[]> {
  const config = await requireConfig();
  const remote = await listWorkspaces(config.server_url, config.token);
  return remote.map((workspace) => ({ ...workspace, local_path: config.workspaces[workspace.id] ?? null }));
}

export async function workspaceRemove(options: { id: string }): Promise<void> {
  const config = await requireConfig();
  await removeWorkspace(config.server_url, config.token, options.id);
  const workspaces = { ...config.workspaces };
  delete workspaces[options.id];
  await saveConfig({ ...config, workspaces });
}

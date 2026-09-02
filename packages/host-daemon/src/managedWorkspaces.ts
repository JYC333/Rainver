import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { configDir } from "./config.js";

const ARCHIVE_MARKER = ".removed-";
export const MANAGED_WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ManagedWorkspaceContainerKind = "direct" | "conversation";

export interface ManagedWorkspaceContainer {
  kind: ManagedWorkspaceContainerKind;
  id: string;
}

export type ManagedWorkspaceHeartbeat =
  | {
      agent_id: string;
      container_kind: "direct";
      container_id: string;
      archived_available: boolean;
    }
  | {
      container_kind: "conversation";
      container_id: string;
      archived_available: boolean;
    };

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertManagedWorkspaceId(value: string, label: string): void {
  if (!UUID_LIKE.test(value)) throw new Error(`${label} must be a UUID-like identifier`);
}

function kindDirectory(kind: ManagedWorkspaceContainerKind): "direct" | "conversations" {
  return kind === "direct" ? "direct" : "conversations";
}

function root(agentId: string, container: ManagedWorkspaceContainer): string {
  assertManagedWorkspaceId(agentId, "agent_id");
  assertManagedWorkspaceId(container.id, "container_id");
  if (container.kind === "conversation") return join(configDir(), "conversations");
  return join(configDir(), "agents", agentId, kindDirectory(container.kind));
}

export function managedWorkspacePath(agentId: string, container: ManagedWorkspaceContainer): string {
  return join(root(agentId, container), container.id);
}

function archivePrefix(containerId: string): string {
  return `${containerId}${ARCHIVE_MARKER}`;
}

export async function archiveManagedWorkspace(
  agentId: string,
  container: ManagedWorkspaceContainer,
): Promise<boolean> {
  const live = managedWorkspacePath(agentId, container);
  const info = await stat(live).catch(() => null);
  if (!info) return false;
  if (!info.isDirectory()) throw new Error(`Managed workspace is not a directory: ${live}`);
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  await rename(live, `${live}${ARCHIVE_MARKER}${timestamp}`);
  return true;
}

export async function restoreManagedWorkspace(
  agentId: string,
  container: ManagedWorkspaceContainer,
): Promise<boolean> {
  const live = managedWorkspacePath(agentId, container);
  if (await stat(live).then(() => true).catch(() => false)) {
    throw new Error("Managed workspace already exists");
  }
  const base = root(agentId, container);
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const archives = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(archivePrefix(container.id)))
    .sort((a, b) => b.name.localeCompare(a.name));
  const newest = archives[0];
  if (!newest) return false;
  await rename(join(base, newest.name), live);
  return true;
}

export async function sweepManagedWorkspaceArchives(now = new Date()): Promise<number> {
  const agentsRoot = join(configDir(), "agents");
  const agents = await readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const agent of agents) {
    if (!agent.isDirectory() || !UUID_LIKE.test(agent.name)) continue;
    for (const kind of ["direct"] as const) {
      const base = join(agentsRoot, agent.name, kind);
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.includes(ARCHIVE_MARKER)) continue;
        const path = join(base, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && now.getTime() - info.mtimeMs > MANAGED_WORKSPACE_RETENTION_MS) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        }
      }
    }
  }
  const conversationsRoot = join(configDir(), "conversations");
  const conversationEntries = await readdir(conversationsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of conversationEntries) {
    if (!entry.isDirectory() || !entry.name.includes(ARCHIVE_MARKER)) continue;
    const path = join(conversationsRoot, entry.name);
    const info = await stat(path).catch(() => null);
    if (info && now.getTime() - info.mtimeMs > MANAGED_WORKSPACE_RETENTION_MS) {
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export async function listManagedWorkspaces(): Promise<ManagedWorkspaceHeartbeat[]> {
  const agentsRoot = join(configDir(), "agents");
  const agents = await readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  const result: ManagedWorkspaceHeartbeat[] = [];
  for (const agent of agents) {
    if (!agent.isDirectory() || !UUID_LIKE.test(agent.name)) continue;
    for (const [kind, wireKind] of [["direct", "direct"]] as const) {
      const base = join(agentsRoot, agent.name, kind);
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      const liveIds = entries
        .filter((entry) => entry.isDirectory() && UUID_LIKE.test(entry.name))
        .map((entry) => entry.name);
      const archivedIds = new Set(
        entries
          .filter((entry) => entry.isDirectory() && entry.name.includes(ARCHIVE_MARKER))
          .map((entry) => entry.name.split(ARCHIVE_MARKER, 1)[0])
          .filter((id) => UUID_LIKE.test(id)),
      );
      for (const id of new Set([...liveIds, ...archivedIds])) {
        result.push({
          agent_id: agent.name,
          container_kind: wireKind,
          container_id: id,
          archived_available: archivedIds.has(id),
        });
      }
    }
  }
  const conversationsRoot = join(configDir(), "conversations");
  const conversationEntries = await readdir(conversationsRoot, { withFileTypes: true }).catch(() => []);
  const liveConversationIds = conversationEntries
    .filter((entry) => entry.isDirectory() && UUID_LIKE.test(entry.name))
    .map((entry) => entry.name);
  const archivedConversationIds = new Set(
    conversationEntries
      .filter((entry) => entry.isDirectory() && entry.name.includes(ARCHIVE_MARKER))
      .map((entry) => entry.name.split(ARCHIVE_MARKER, 1)[0])
      .filter((id) => UUID_LIKE.test(id)),
  );
  for (const id of new Set([...liveConversationIds, ...archivedConversationIds])) {
    result.push({
      container_kind: "conversation",
      container_id: id,
      archived_available: archivedConversationIds.has(id),
    });
  }
  return result;
}

export async function ensureManagedWorkspace(
  agentId: string,
  container: ManagedWorkspaceContainer,
): Promise<string> {
  const path = managedWorkspacePath(agentId, container);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

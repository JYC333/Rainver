import { lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureGitRepository } from "@rainver/folder-read";
import { configDir } from "./config.js";

const ARCHIVE_MARKER = ".removed-";
// Archive/restore/cache eviction share one local lifecycle queue. Never evict a
// path while another daemon operation is bringing it back into service.
let lifecycleTail: Promise<unknown> = Promise.resolve();
function lifecycle<T>(work: () => Promise<T>): Promise<T> {
  const next = lifecycleTail.then(work, work);
  lifecycleTail = next.catch(() => undefined);
  return next;
}

/** Follow no links on the way to a disposable cache (including the cache itself). */
async function realDirectory(path: string): Promise<boolean> {
  return (await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }))?.isDirectory() ?? false;
}

// Vendor downloads/catalogs only. Sessions, SQLite (including WAL/SHM), login,
// skills, installed-plugin registration and user work never enter this list.
const PROFILE_CACHES = {
  codex_cli: [
    [".codex", "cache", "remote_plugin_catalog"],
    [".codex", "cache", "codex_apps_tools"],
    [".codex", "cache", "codex_apps_server_info"],
    [".codex", "plugins", "cache", "openai-curated-remote"],
  ],
} as const;

async function trimProfileCaches(archive: string): Promise<void> {
  if (!await realDirectory(archive)) return;
  for (const [runtime, paths] of Object.entries(PROFILE_CACHES)) {
    const runtimeRoot = join(archive, runtime);
    if (!await realDirectory(runtimeRoot)) continue;
    for (const provider of await readdir(runtimeRoot, { withFileTypes: true })) {
      if (!provider.isDirectory()) continue;
      const providerRoot = join(runtimeRoot, provider.name);
      for (const parts of paths) {
        let target = providerRoot;
        let safe = true;
        for (const part of parts) {
          target = join(target, part);
          if (!await realDirectory(target)) { safe = false; break; }
        }
        if (safe) await rm(target, { recursive: true, force: true });
      }
    }
  }
}

const MANAGED_WORKSPACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ManagedWorkspaceContainerKind = "direct" | "conversation";

/**
 * The container kinds a runtime profile can belong to. `location` is the third
 * and has no managed workspace: a Task thread, an Automation, a Plan or
 * Workflow node and an evolution run all execute in a registered
 * WorkspaceLocation the user owns, and that Location is what their vendor
 * session already belongs to.
 */
type RuntimeProfileContainerKind = ManagedWorkspaceContainerKind | "location" | "agent" | "workspace";

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

/**
 * Every runtime profile this Agent has in this container, as a directory.
 *
 * The profile tree mirrors the profile key the control plane sends
 * (`agents/<agent_id>/<container_kind>/<container_id>/<runtime_key>/<provider>`),
 * so archiving a container means moving the `<container_id>` level: one move
 * takes every runtime × backend the Agent used in that Room or that direct
 * chat, which is what "clear what this Agent remembers here" means.
 */
export function runtimeProfileContainerPath(
  agentId: string,
  containerKind: RuntimeProfileContainerKind,
  containerId: string,
): string {
  assertManagedWorkspaceId(agentId, "agent_id");
  assertManagedWorkspaceId(containerId, "container_id");
  return join(configDir(), "agents", agentId, "profiles", containerKind, containerId);
}

/** Every profile container of one Agent — what `host-state/reset` moves. */
function agentProfilesRoot(agentId: string): string {
  assertManagedWorkspaceId(agentId, "agent_id");
  return join(configDir(), "agents", agentId, "profiles");
}

/** Moves one live directory aside under the archive marker. False when there was none. */
async function archiveDirectory(live: string, profile = false): Promise<boolean> {
  return lifecycle(async () => {
    const info = await stat(live).catch(() => null);
    if (!info) return false;
    if (!info.isDirectory()) throw new Error(`Not a directory: ${live}`);
    const timestamp = new Date().toISOString().replace(/:/g, "-");
    const archived = `${live}${ARCHIVE_MARKER}${timestamp}`;
    await rename(live, archived);
    // Cache failure must not turn a successful archive into a failed lifecycle
    // command. The connection/hourly sweep retries it and reports any error.
    if (profile) await trimProfileCaches(archived).catch(() => undefined);
    return true;
  });
}

/** Brings the newest archive of one directory back, if the live one is gone. */
async function restoreDirectory(live: string, base: string, id: string): Promise<boolean> {
  return lifecycle(async () => {
    if (await stat(live).then(() => true).catch(() => false)) {
      throw new Error(`Already exists: ${live}`);
    }
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const newest = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(archivePrefix(id)))
      .sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!newest) return false;
    await rename(join(base, newest.name), live);
    return true;
  });
}

/**
 * Archives what this Agent leaves behind in one container.
 *
 * Two things, with different owners. The Agent's **runtime profile** — its
 * login, its vendor sessions, its CLI auto-memory — is the Agent's alone and
 * always moves. The **workspace** is shared by every Agent in a Conversation,
 * so it moves only when the control plane says this was the last one
 * (`include_workspace`).
 */
export async function archiveManagedWorkspace(
  agentId: string,
  container: ManagedWorkspaceContainer,
  includeWorkspace: boolean,
): Promise<boolean> {
  const profileMoved = await archiveDirectory(
    runtimeProfileContainerPath(agentId, container.kind, container.id), true,
  );
  if (!includeWorkspace) return profileMoved;
  const workspaceMoved = await archiveDirectory(managedWorkspacePath(agentId, container));
  return profileMoved || workspaceMoved;
}

/**
 * Brings back what one Agent left in one container.
 *
 * The workspace goes first, and only it refuses a live directory. A shared
 * Conversation cwd that already exists is a real conflict — another Agent has
 * been working in it — and restoring an archive over it would be a silent
 * merge. A live *profile* is not: it means this Agent has already dispatched
 * here since, and the archive is simply older, so there is nothing to do.
 * Ordering the throwing half first is what keeps a failed restore from leaving
 * the profile already moved with the caller told it failed.
 */
export async function restoreManagedWorkspace(
  agentId: string,
  container: ManagedWorkspaceContainer,
  includeWorkspace: boolean,
): Promise<boolean> {
  const workspaceMoved = includeWorkspace
    ? await restoreDirectory(managedWorkspacePath(agentId, container), root(agentId, container), container.id)
    : false;
  const profilePath = runtimeProfileContainerPath(agentId, container.kind, container.id);
  const profileMoved = await stat(profilePath).then(() => false).catch(
    () => restoreDirectory(profilePath, dirname(profilePath), container.id),
  );
  return workspaceMoved || profileMoved;
}

/**
 * "Clear this Agent's CLI memory on this host": archives every runtime profile
 * the Agent has here, in every container, and touches no workspace.
 *
 * Archived rather than deleted, like everything else in this tree — the same
 * 30-day sweep removes it, and until then a person who did this by mistake
 * still has what was there.
 */
export async function archiveRuntimeProfileContainer(agentId:string,kind:RuntimeProfileContainerKind,id:string){
 return archiveDirectory(runtimeProfileContainerPath(agentId,kind,id), true);
}

export async function archiveAgentProfiles(agentId: string): Promise<boolean> {
  const profilesRoot = agentProfilesRoot(agentId);
  const kinds = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  let moved = false;
  for (const kind of kinds) {
    if (!kind.isDirectory()) continue;
    const base = join(profilesRoot, kind.name);
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !UUID_LIKE.test(entry.name)) continue;
      if (await archiveDirectory(join(base, entry.name), true)) moved = true;
    }
  }
  return moved;
}

/**
 * When a directory was archived, read from the timestamp `archiveDirectory`
 * put in its name. Not its mtime: a rename leaves that alone, so a profile
 * untouched since its first use would count as archived that long ago and be
 * swept the moment it was archived.
 */
function archivedAtFromName(name: string): number | null {
  const stamp = name.slice(name.lastIndexOf(ARCHIVE_MARKER) + ARCHIVE_MARKER.length);
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/u, "T$1:$2:$3");
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/** Removes every archive under one directory that is past the retention window. */
async function sweepArchivesIn(base: string, now: Date, profiles = false): Promise<number> {
  return lifecycle(async () => {
    if (!await realDirectory(base)) return 0;
    let removed = 0;
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !entry.name.includes(ARCHIVE_MARKER)) continue;
      const path = join(base, entry.name);
      const archivedAt = archivedAtFromName(entry.name)
        ?? (await stat(path).catch(() => null))?.mtimeMs
        ?? null;
      if (archivedAt !== null && now.getTime() - archivedAt > MANAGED_WORKSPACE_RETENTION_MS) {
        await rm(path, { recursive: true, force: true });
        removed += 1;
      } else if (profiles) {
        await trimProfileCaches(path);
      }
    }
    return removed;
  });
}

/**
 * Moves `<configDir>/profiles/<adapter>/<provider>` aside. Nothing reads it.
 * Archive it under the marker and sweep it after the retention window. Do
 * not delete it outright, and do not share one login across every Agent on
 * the machine. False when there was nothing to move.
 */
export async function archiveLegacyProfileTree(): Promise<boolean> {
  return archiveDirectory(join(configDir(), "profiles"), true);
}

let archiveSweep: Promise<number> | null = null;
/** Concurrent triggers join the current pass instead of queuing more scans. */
export function sweepManagedWorkspaceArchives(now = new Date()): Promise<number> {
  if (archiveSweep) return archiveSweep;
  archiveSweep = sweepAllArchives(now).finally(() => { archiveSweep = null; });
  return archiveSweep;
}

async function sweepAllArchives(now: Date): Promise<number> {
  // The archived profile tree sits at the config root.
  let removed = await sweepArchivesIn(configDir(), now, true);
  const agentsRoot = join(configDir(), "agents");
  const agents = await readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  for (const agent of agents) {
    if (!agent.isDirectory() || !UUID_LIKE.test(agent.name)) continue;
    removed += await sweepArchivesIn(join(agentsRoot, agent.name, "direct"), now);
    // Runtime profiles archive on the same 30-day clock as the workspaces
    // beside them: a Room an Agent was removed from, a direct chat that was
    // deleted, or a `host-state/reset` a person ran by mistake all leave one,
    // and nothing else would ever remove it.
    const profilesRoot = join(agentsRoot, agent.name, "profiles");
    if (!await realDirectory(profilesRoot)) continue;
    for (const kind of await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])) {
      if (!kind.isDirectory()) continue;
      removed += await sweepArchivesIn(join(profilesRoot, kind.name), now, true);
    }
  }
  removed += await sweepArchivesIn(join(configDir(), "conversations"), now);
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
  // A repository from the first Run, so a managed workspace has the same diff
  // and the same undo a Location does. ADR 0016 section 11's undo is git.
  // Do not leave this workspace as a plain directory.
  await ensureGitRepository(path);
  return path;
}

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ManagedWorkspaceErrorCode } from "@rainver/protocol";
import { configDir } from "./config.js";
import { admitLegacyArchive } from "./legacyArchiveDrain.js";
import {
  archiveManagedWorkspace,
  assertManagedWorkspaceId,
  managedWorkspacePath,
  restoreManagedWorkspace,
  runtimeProfileContainerPath,
  type ManagedWorkspaceContainer,
  type ManagedWorkspaceContainerKind,
} from "./managedWorkspaces.js";

const ARCHIVE_MARKER = ".removed-";
/** Receipts kept per target. The generation fence, not this history, is what refuses a late old request. */
const RECEIPTS_PER_TARGET = 64;
const OPERATION_ID = /^[A-Za-z0-9:_-]{1,160}$/u;

export interface ManagedWorkspaceOperationFrame {
  action: "archive" | "restore";
  agent_id: string;
  /** `workspace`: an isolated execution workspace's profile container; a journaled profile-only archive. */
  container_kind: ManagedWorkspaceContainerKind | "workspace";
  container_id: string;
  include_workspace: boolean;
  /** Durable identity of this request; a repeat of it replays its receipt and never moves anything twice. */
  operation_id?: string;
  /** Control-plane order of archive/restore intents for this target; an older one arriving late is refused. */
  generation?: number;
}

export interface ManagedWorkspaceOperationResult {
  ok: boolean;
  changed: boolean;
  error: string | null;
  error_code?: ManagedWorkspaceErrorCode;
}

type StageName = "workspace" | "profile";
interface Stage {
  name: StageName;
  /** Archive entry name: a restore's source, an archive's destination. Null: nothing to move. */
  entry: string | null;
  done: boolean;
  moved: boolean;
  /** The shared cwd stage another Agent's newer operation on this conversation owns; never executed. */
  superseded?: boolean;
}
interface Receipt {
  action: "archive" | "restore";
  generation: number;
  include_workspace: boolean;
  status: "in_progress" | "done" | "refused";
  stages: Stage[];
  result: ManagedWorkspaceOperationResult | null;
  updated_at: string;
}
interface TargetState {
  version: 1;
  /** Highest generation admitted for this target. */
  generation: number;
  operations: Record<string, Receipt>;
}
/**
 * The fence of one Conversation's shared cwd. Every Agent's profile has its own
 * journal, but the cwd is one directory for all of them, so the operation that
 * last moved it — whichever Agent's — is what an older one must not undo.
 */
interface ConversationFence {
  version: 1;
  generation: number;
  /** The operation that holds `generation`: its own repeat after a crash is not fenced by it. */
  operation_id: string | null;
}

/** Test seam: runs after each move and before its stage is recorded, where a crash leaves the journal behind the filesystem. */
export interface ManagedWorkspaceOperationHooks {
  afterMove?: (stage: StageName) => void | Promise<void>;
  /** An identity-less request admitted and still running: before its move, where the legacy drain must wait for it. */
  beforeLegacyMove?: () => Promise<void>;
}

const locks = new Map<string, Promise<unknown>>();

/** One target's operations run one at a time in this process; the journal carries them across a restart. */
async function withTargetLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}

/**
 * A Conversation operation holds its conversation's lock, then its Agent's —
 * always in that order, so two Agents' operations on one shared cwd never run
 * together and never wait on each other in a cycle. A direct container's cwd
 * is the Agent's own and needs only the Agent's lock.
 */
async function withOperationLocks<T>(frame: ManagedWorkspaceOperationFrame, work: () => Promise<T>): Promise<T> {
  const container = { kind: frame.container_kind, id: frame.container_id };
  const agentLocked = () => withTargetLock(journalPath(frame.agent_id, container), work);
  return frame.container_kind === "conversation"
    ? withTargetLock(conversationFencePath(frame.container_id), agentLocked)
    : agentLocked();
}

function journalPath(agentId: string, container: { kind: ManagedWorkspaceOperationFrame["container_kind"]; id: string }): string {
  return join(configDir(), "managed-operations", agentId, container.kind, `${container.id}.json`);
}

/** Beside the per-Agent journals; `conversations` is never an Agent id, which is a UUID. */
function conversationFencePath(conversationId: string): string {
  return join(configDir(), "managed-operations", "conversations", `${conversationId}.json`);
}

async function loadFence(path: string): Promise<ConversationFence> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return { version: 1, generation: 0, operation_id: null };
  const parsed = JSON.parse(text) as ConversationFence;
  if (parsed.version !== 1 || typeof parsed.generation !== "number") throw new Error(`Unreadable conversation fence: ${path}`);
  return parsed;
}

/** Whether a newer operation — or another one at this generation — already owns the shared cwd. */
const cwdFenced = (fence: ConversationFence | null, generation: number, operationId: string) =>
  fence !== null && (fence.generation > generation || (fence.generation === generation && fence.operation_id !== operationId));

async function loadState(path: string): Promise<TargetState> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return { version: 1, generation: 0, operations: {} };
  const parsed = JSON.parse(text) as TargetState;
  if (parsed.version !== 1 || typeof parsed.generation !== "number" || typeof parsed.operations !== "object") {
    throw new Error(`Unreadable managed workspace journal: ${path}`);
  }
  return parsed;
}

async function saveState(path: string, state: TargetState): Promise<void> {
  const entries = Object.entries(state.operations);
  if (entries.length > RECEIPTS_PER_TARGET) {
    entries.sort((a, b) => a[1].generation - b[1].generation);
    state.operations = Object.fromEntries(entries.slice(entries.length - RECEIPTS_PER_TARGET));
  }
  await saveDurably(path, state);
}

/** Durable before it returns: temporary file, fsync, rename, fsync of the directory. */
async function saveDurably(path: string, value: TargetState | ConversationFence): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return false;
  if (!info.isDirectory()) throw new Error(`Not a directory: ${path}`);
  return true;
}

async function newestArchive(base: string, id: string): Promise<string | null> {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${id}${ARCHIVE_MARKER}`))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))[0] ?? null;
}

function livePath(frame: ManagedWorkspaceOperationFrame, stage: StageName): string {
  // A workspace-kind frame has no cwd stage (refused before planning): its cwd is never moved here.
  const container = { kind: frame.container_kind, id: frame.container_id } as ManagedWorkspaceContainer;
  return stage === "workspace"
    ? managedWorkspacePath(frame.agent_id, container)
    : runtimeProfileContainerPath(frame.agent_id, frame.container_kind, frame.container_id);
}

const refused = (code: ManagedWorkspaceErrorCode, error: string): ManagedWorkspaceOperationResult =>
  ({ ok: false, changed: false, error, error_code: code });

/**
 * Fixes what this operation will move before anything moves, so a replay after
 * a crash finishes the same plan rather than choosing again. A restore keeps
 * the existing rule that a live shared workspace is a conflict, never merged
 * over or removed; a live profile means this Agent already ran here since.
 */
async function plan(frame: ManagedWorkspaceOperationFrame, cwdSuperseded: boolean): Promise<Pick<Receipt, "stages" | "status" | "result">> {
  const names: StageName[] = frame.action === "restore"
    ? [...(frame.include_workspace ? ["workspace" as const] : []), "profile"]
    : ["profile", ...(frame.include_workspace ? ["workspace" as const] : [])];
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const stages: Stage[] = [];
  for (const name of names) {
    if (name === "workspace" && cwdSuperseded) {
      stages.push({ name, entry: null, done: true, moved: false, superseded: true });
      continue;
    }
    const live = livePath(frame, name);
    const exists = await isDirectory(live);
    if (frame.action === "archive") {
      stages.push({ name, entry: exists ? `${frame.container_id}${ARCHIVE_MARKER}${stamp}` : null, done: !exists, moved: false });
      continue;
    }
    if (exists && name === "workspace") {
      return { stages: [], status: "refused", result: refused("live_conflict", `Already exists: ${name}`) };
    }
    const entry = exists ? null : await newestArchive(dirname(live), frame.container_id);
    stages.push({ name, entry, done: entry === null, moved: false });
  }
  return { stages, status: "in_progress", result: null };
}

/**
 * Brings one stage to its planned end, deciding from the filesystem whether an
 * interrupted earlier attempt already moved it: the planned source gone and
 * the destination present is that attempt's move, not something to redo.
 * Returns a refusal only for a live directory that appeared since the plan.
 */
async function applyStage(frame: ManagedWorkspaceOperationFrame, stage: Stage, hooks?: ManagedWorkspaceOperationHooks): Promise<ManagedWorkspaceOperationResult | null> {
  if (!stage.entry) { stage.done = true; return null; }
  const live = livePath(frame, stage.name);
  const archived = join(dirname(live), stage.entry);
  const [liveExists, archivedExists] = [await isDirectory(live), await isDirectory(archived)];
  if (frame.action === "archive") {
    if (liveExists && !archivedExists) {
      await rename(live, archived);
      await hooks?.afterMove?.(stage.name);
      stage.moved = true;
    } else {
      // Moved by the interrupted attempt; a live directory beside it is newer work, left alone.
      stage.moved = archivedExists;
    }
  } else if (archivedExists && !liveExists) {
    await rename(archived, live);
    await hooks?.afterMove?.(stage.name);
    stage.moved = true;
  } else if (archivedExists && liveExists) {
    if (stage.name === "workspace") return refused("live_conflict", "Already exists: workspace");
    stage.moved = false;
  } else {
    // Gone with the live directory present: this operation's own earlier move.
    // Both gone: the archive was swept, nothing left to bring back.
    stage.moved = liveExists;
  }
  stage.done = true;
  return null;
}

/**
 * Archives or restores one Agent's state in one container.
 *
 * A request with an `operation_id` is journaled per target under the config
 * directory: its plan and every completed stage are durable before the next
 * step, so a repeat of the same operation — after a lost reply, a timeout or a
 * daemon crash between moving the workspace and the profile — finishes or
 * replays it instead of meeting its own earlier move as a conflict.
 *
 * Its `generation` fences it, on admission and on every repeat until it is
 * done. The Agent's profile is fenced by that Agent × container's newest
 * admitted operation: an older one arriving late is refused, and one left in
 * progress by a crash is ended, not continued, once a newer one was admitted —
 * finishing it would undo that newer move. A Conversation's shared cwd is
 * fenced across Agents by the newest operation that owns it: a stage on it
 * that another Agent's newer operation took over is skipped, while that
 * Agent's own profile stage still runs. Only a completed receipt replays its
 * result without touching the filesystem. A request without an identity is the
 * legacy single-shot move, tracked for the legacy drain and refused after it
 * (`legacyArchiveDrain.ts`).
 */
export async function executeManagedWorkspaceOperation(
  frame: ManagedWorkspaceOperationFrame,
  hooks?: ManagedWorkspaceOperationHooks,
): Promise<ManagedWorkspaceOperationResult> {
  try {
    assertManagedWorkspaceId(frame.agent_id, "agent_id");
    assertManagedWorkspaceId(frame.container_id, "container_id");
  } catch (error) {
    return refused("invalid_request", error instanceof Error ? error.message : String(error));
  }
  if (frame.container_kind === "workspace" && (frame.action !== "archive" || frame.include_workspace || frame.operation_id === undefined)) {
    // An isolated workspace's cwd is its Git worktree, never moved here; its profile has no legacy path.
    return refused("invalid_request", "A workspace profile operation is a journaled profile-only archive");
  }
  const container = { kind: frame.container_kind, id: frame.container_id };
  if (frame.operation_id === undefined) {
    const managed = container as ManagedWorkspaceContainer;
    // Admitted in this tick, so a drain dispatched after this frame waits for it; refused once drained.
    return admitLegacyArchive(() => withOperationLocks(frame, async () => {
      try {
        await hooks?.beforeLegacyMove?.();
        const changed = frame.action === "archive"
          ? await archiveManagedWorkspace(frame.agent_id, managed, frame.include_workspace)
          : await restoreManagedWorkspace(frame.agent_id, managed, frame.include_workspace);
        return { ok: true, changed, error: null };
      } catch (error) {
        return { ok: false, changed: false, error: error instanceof Error ? error.message : String(error) };
      }
    })) ?? refused("legacy_closed", "This Host no longer accepts managed-workspace requests without an operation identity");
  }
  const operationId = frame.operation_id;
  const generation = frame.generation;
  if (!OPERATION_ID.test(operationId) || generation === undefined || !Number.isSafeInteger(generation) || generation <= 0) {
    return refused("invalid_request", "operation_id requires a positive integer generation");
  }
  const path = journalPath(frame.agent_id, container);
  const sharesCwd = frame.container_kind === "conversation" && frame.include_workspace;
  const fencePath = conversationFencePath(frame.container_id);
  return withOperationLocks(frame, async () => {
    try {
      const state = await loadState(path);
      const fence = sharesCwd ? await loadFence(fencePath) : null;
      let receipt = state.operations[operationId];
      if (receipt) {
        if (receipt.action !== frame.action || receipt.generation !== generation || receipt.include_workspace !== frame.include_workspace) {
          return refused("operation_mismatch", "operation_id was used for a different request");
        }
        if (receipt.status !== "in_progress") return receipt.result!;
        if (receipt.generation < state.generation) {
          // Interrupted, then overtaken by a newer operation on this target: what is left of it would undo that one.
          receipt.status = "refused";
          receipt.result = { ...refused("stale_generation", "A newer operation for this container was applied before this one finished"),
            changed: receipt.stages.some((stage) => stage.moved) };
          receipt.updated_at = new Date().toISOString();
          await saveState(path, state);
          return receipt.result;
        }
      } else {
        if (generation <= state.generation) {
          return refused("stale_generation", "A newer operation for this container was already applied");
        }
        const cwdSuperseded = cwdFenced(fence, generation, operationId);
        receipt = { action: frame.action, generation, include_workspace: frame.include_workspace, ...await plan(frame, cwdSuperseded), updated_at: new Date().toISOString() };
        if (fence && !cwdSuperseded && receipt.status !== "refused") {
          // Claimed before this Agent's journal records the plan: a crash in between is repaired by the
          // same operation's repeat, which the fence recognises as its own.
          await saveDurably(fencePath, { version: 1, generation, operation_id: operationId });
          fence.generation = generation;
          fence.operation_id = operationId;
        }
        state.generation = generation;
        state.operations[operationId] = receipt;
        await saveState(path, state);
        if (receipt.status === "refused") return receipt.result!;
      }
      for (const stage of receipt.stages) {
        if (stage.done) continue;
        if (stage.name === "workspace" && cwdFenced(fence, receipt.generation, operationId)) {
          // Another Agent's newer operation moved the shared cwd since: it is that operation's now.
          stage.done = true;
          stage.superseded = true;
        } else {
          const refusal = await applyStage(frame, stage, hooks);
          if (refusal) {
            receipt.status = "refused";
            receipt.result = { ...refusal, changed: receipt.stages.some((item) => item.moved) };
            receipt.updated_at = new Date().toISOString();
            await saveState(path, state);
            return receipt.result;
          }
        }
        receipt.updated_at = new Date().toISOString();
        await saveState(path, state);
      }
      receipt.status = "done";
      receipt.result = { ok: true, changed: receipt.stages.some((stage) => stage.moved), error: null };
      await saveState(path, state);
      return receipt.result;
    } catch (error) {
      // The journal still holds the operation in progress: a repeat continues it, under the same fences.
      return { ok: false, changed: false, error: error instanceof Error ? error.message : String(error), error_code: "io_error" };
    }
  });
}

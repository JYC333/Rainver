import { randomUUID } from "node:crypto";
import type { Queryable } from "../routeUtils/common.js";
import { sharedHostConnectionRegistry, type ManagedWorkspaceResult } from "./connectionRegistry.js";
import { PgHostThreadRepository } from "./threadRepository.js";

/**
 * Managed-workspace archive and restore as durable, ordered Host operations.
 *
 * Every archive intent (`host_threads.pending_archive_at`) carries a
 * generation from `managed_workspace_generation_seq`, and a restore takes a
 * later one when it commits. Both go to the Host with a stable operation
 * identity and parameters fixed when the intent committed, so a retry of
 * either is the same operation: the Host's journal replays its receipt or
 * finishes its remaining stage. The Host refuses an operation older than the
 * newest it admitted for the same Agent × container — admitted or left in
 * progress — and skips a Conversation cwd stage that another Agent's newer
 * operation owns, which is what stops an archive delivered late from undoing
 * a restore. Clearing the database intent alone cannot recall a request
 * already sent.
 */

export interface ManagedWorkspaceTarget {
  hostId: string;
  agentId: string;
  containerKind: "direct" | "conversation";
  containerId: string;
  includeWorkspace: boolean;
}

type HostRegistry = Pick<typeof sharedHostConnectionRegistry, "requestManagedWorkspaceAction" | "drainLegacyManagedWorkspaceArchives">;

/** A Host that predates the journal can neither replay nor fence; it is sent no restore. */
export const HOST_UPDATE_REQUIRED = "host_update_required";

export async function hostJournalsManagedWorkspaceOperations(db: Queryable, hostId: string): Promise<boolean> {
  const row = (await db.query<{ journaled: boolean }>(
    `SELECT (capabilities_json->>'managed_workspace_operations') = '1' AS journaled FROM hosts WHERE id = $1`, [hostId])).rows[0];
  return row?.journaled === true;
}

/** A Host that journals an isolated workspace's `archive_profiles` under the thread's archive identity. */
export async function hostJournalsWorkspaceProfileArchives(db: Queryable, hostId: string): Promise<boolean> {
  const row = (await db.query<{ journaled: boolean }>(
    `SELECT (capabilities_json->>'workspace_profile_operations') = '1' AS journaled FROM hosts WHERE id = $1`, [hostId])).rows[0];
  return row?.journaled === true;
}

/**
 * Records, before it is sent, that an archive of this thread goes out without
 * an identity. An acknowledgement of it proves nothing about another copy
 * still in flight (an earlier send that timed out, or one the daemon still
 * runs detached from a connection since replaced), so the launch and restore
 * barriers stay closed on its target until `releaseUnfencedArchives` has the
 * Host's drain. The wall clock, not the transaction's: a drain covers exactly
 * the markers recorded before it was asked for.
 */
export async function markArchiveUnfenced(db: Queryable, threadId: string): Promise<void> {
  await db.query(`UPDATE host_threads SET archive_unfenced_at = clock_timestamp(), updated_at = now() WHERE id = $1`, [threadId]);
}

/** A Host that can prove its identity-less archives drained (`managed_workspace_legacy_drain`). */
export async function hostDrainsLegacyArchives(db: Queryable, hostId: string): Promise<boolean> {
  const row = (await db.query<{ drains: boolean }>(
    `SELECT (capabilities_json->>'legacy_archive_drain') = '1' AS drains FROM hosts WHERE id = $1`, [hostId])).rows[0];
  return row?.drains === true;
}

type DrainRegistry = Pick<typeof sharedHostConnectionRegistry, "drainLegacyManagedWorkspaceArchives">;

/**
 * The Host's proof that no identity-less archive can still move anything:
 * the daemon closes them for good — a later one, in this process or a
 * restarted one, is refused — and answers once every one it admitted
 * finished. Neither a reported capability nor a reconnect is that proof: the
 * same process keeps running requests a replaced connection delivered. The
 * returned time, read before the request, is what the drain covers.
 */
export async function drainUnfencedArchives(db: Queryable, hostId: string, hosts: DrainRegistry = sharedHostConnectionRegistry):
  Promise<{ ok: true; drainedBefore: string } | { ok: false; result: ManagedWorkspaceResult }> {
  if (!await hostDrainsLegacyArchives(db, hostId)) return { ok: false, result: { ok: false, changed: false, error: HOST_UPDATE_REQUIRED } };
  const drainedBefore = (await db.query<{ at: string }>(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  const answer = await hosts.drainLegacyManagedWorkspaceArchives(hostId)
    .catch((error: unknown) => ({ ok: false, changed: false, error: `host_request_failed: ${error instanceof Error ? error.message : String(error)}` }));
  return answer.ok ? { ok: true, drainedBefore } : { ok: false, result: { ...answer, ok: false, changed: false } };
}

/**
 * Lets the barriers pass threads that were sent unfenced archives, only
 * after the Host drained them (`drainUnfencedArchives`); their markers are
 * then cleared. Until then the caller refuses the launch or restore with the
 * returned answer — `host_update_required` from a Host that cannot drain —
 * never released by a capability, a reconnect or the pending intent clearing.
 */
export async function releaseUnfencedArchives(db: Queryable, hostId: string, threadIds: readonly string[],
  hosts: DrainRegistry = sharedHostConnectionRegistry): Promise<ManagedWorkspaceResult> {
  if (!threadIds.length) return { ok: true, changed: false, error: null };
  const drained = await drainUnfencedArchives(db, hostId, hosts);
  if (!drained.ok) return drained.result;
  await db.query(`UPDATE host_threads SET archive_unfenced_at = NULL, updated_at = now()
    WHERE id = ANY($1::varchar[]) AND execution_host_id = $2 AND archive_unfenced_at <= $3::timestamptz`, [threadIds, hostId, drained.drainedBefore]);
  return { ok: true, changed: false, error: null };
}

/**
 * What a pending archive intent is: its generation, whether it takes the
 * shared cwd, and whether that cwd scope is confirmed. An intent this release
 * commits fixes its scope as it commits (`archive_scope_confirmed`), and every
 * send — the after-commit attempt, a reconnect, the recovery pass, a restore
 * or launch settling it first — carries exactly that, however membership
 * changed since. An intent from before then is not confirmed: its earlier
 * sends chose the scope per send, so the value inferred for it (by migration
 * 0021, or here when still unset) is only the first guess, and the Host's
 * receipt for the operation, if it has one, is what the operation is
 * (`sendPendingManagedWorkspaceArchive`). Null once settled.
 */
export interface PendingArchiveIntent { generation: number; includeWorkspace: boolean; confirmed: boolean }

export async function pendingArchiveIntent(db: Queryable, threadId: string): Promise<PendingArchiveIntent | null> {
  const row = (await db.query<{ archive_generation: string; archive_include_workspace: boolean; archive_scope_confirmed: boolean }>(
    `UPDATE host_threads thread
        SET archive_generation = COALESCE(thread.archive_generation, nextval('managed_workspace_generation_seq')),
            archive_include_workspace = COALESCE(thread.archive_include_workspace, (
              thread.workspace_mode = 'managed' AND (
                thread.container_kind = 'direct' OR NOT EXISTS (
                  SELECT 1 FROM host_threads other
                   WHERE other.id <> thread.id AND other.session_id = thread.session_id AND other.space_id = thread.space_id
                     AND other.container_kind = 'conversation' AND other.status IN ('active', 'session_reset')))))
      WHERE thread.id = $1 AND thread.status = 'closed' AND thread.pending_archive_at IS NOT NULL
      RETURNING thread.archive_generation, thread.archive_include_workspace, thread.archive_scope_confirmed`, [threadId])).rows[0];
  return row ? {
    generation: Number(row.archive_generation),
    includeWorkspace: row.archive_include_workspace === true,
    confirmed: row.archive_scope_confirmed === true,
  } : null;
}

/** Records the scope the Host's journal holds for an unconfirmed intent; never changes a confirmed one or another generation's. */
async function confirmArchiveScope(db: Queryable, threadId: string, generation: number, includeWorkspace: boolean): Promise<void> {
  await db.query(
    `UPDATE host_threads SET archive_include_workspace = $3, archive_scope_confirmed = true, updated_at = now()
      WHERE id = $1 AND archive_generation = $2 AND status = 'closed' AND pending_archive_at IS NOT NULL
        AND archive_scope_confirmed = false`, [threadId, generation, includeWorkspace]);
}

/**
 * Whether this thread's archive is known to have taken the shared cwd: a
 * confirmed scope only. An inferred one whose operation the Host settled
 * without saying which it held (a newer operation fenced it) is not counted.
 */
export async function archiveTookConversationCwd(db: Queryable, threadId: string): Promise<boolean> {
  const row = (await db.query<{ cwd: boolean }>(
    `SELECT (archive_include_workspace IS TRUE AND archive_scope_confirmed) AS cwd FROM host_threads WHERE id = $1`, [threadId])).rows[0];
  return row?.cwd === true;
}

export async function nextManagedWorkspaceGeneration(db: Queryable): Promise<number> {
  const row = (await db.query<{ generation: string }>(`SELECT nextval('managed_workspace_generation_seq') AS generation`)).rows[0]!;
  return Number(row.generation);
}

export const archiveOperationId = (threadId: string, generation: number) => `archive:${threadId}:${generation}`;

/**
 * Whether an answer settles the operation. `retry` covers every answer that
 * leaves the Host's effect unknown or temporarily blocked — offline, timed
 * out, an unsent frame, an interrupted move, an error the Host did not
 * classify — which a repeat of the same operation can safely resolve.
 */
export function classifyManagedWorkspaceResult(result: ManagedWorkspaceResult): "done" | "refused" | "retry" {
  if (result.ok) return "done";
  if (result.error === HOST_UPDATE_REQUIRED) return "refused";
  if (result.error_code && result.error_code !== "io_error") return "refused";
  return "retry";
}

async function send(hosts: HostRegistry, type: "managed_workspace_archive" | "managed_workspace_restore", target: ManagedWorkspaceTarget,
  identity: { operation_id: string; generation: number } | null): Promise<ManagedWorkspaceResult> {
  return hosts.requestManagedWorkspaceAction(target.hostId, type, {
    agent_id: target.agentId, container_kind: target.containerKind, container_id: target.containerId,
    include_workspace: target.includeWorkspace, ...(identity ?? {}),
  }).catch((error: unknown) => ({ ok: false, changed: false, error: `host_request_failed: ${error instanceof Error ? error.message : String(error)}` }));
}

/**
 * Sends one thread's pending archive and settles its intent when the Host
 * finished it, or refused it as older than an operation it already applied
 * (that newer restore or archive supersedes it). Anything else stays pending
 * for the next attempt, which is the same operation.
 */
export async function sendPendingManagedWorkspaceArchive(
  db: Queryable,
  threadId: string,
  target: Omit<ManagedWorkspaceTarget, "includeWorkspace">,
  hosts: HostRegistry = sharedHostConnectionRegistry,
): Promise<ManagedWorkspaceResult & { settled: boolean }> {
  const intent = await pendingArchiveIntent(db, threadId);
  if (intent === null) return { ok: true, changed: false, error: null, settled: true };
  const { generation, includeWorkspace, confirmed } = intent;
  const journaled = await hostJournalsManagedWorkspaceOperations(db, target.hostId);
  const identity = journaled ? { operation_id: archiveOperationId(threadId, generation), generation } : null;
  if (!identity) await markArchiveUnfenced(db, threadId);
  // An older Host gets the legacy archive: archiving is idempotent there, and only the restore needs the journal.
  let result = await send(hosts, "managed_workspace_archive", { ...target, includeWorkspace }, identity);
  if (identity && !confirmed && result.error_code === "operation_mismatch") {
    // An earlier send of this very operation, choosing its scope per send, reached the Host with the other
    // value: the Host's receipt is the operation. Repeat it as it is — the journal replays it, or finishes it
    // under its fences — rather than inventing a new generation that would leave it in flight.
    result = await send(hosts, "managed_workspace_archive", { ...target, includeWorkspace: !includeWorkspace }, identity);
    if (result.error_code !== "operation_mismatch") await confirmArchiveScope(db, threadId, generation, !includeWorkspace);
  } else if (identity && !confirmed && result.ok) {
    // The Host holds the operation with the value just sent, newly or as an earlier send's receipt.
    await confirmArchiveScope(db, threadId, generation, includeWorkspace);
  }
  const settled = result.ok || result.error_code === "stale_generation";
  if (settled) await new PgHostThreadRepository(db).acknowledgeManagedWorkspaceArchive(threadId, generation);
  return { ...result, settled };
}

export async function requestManagedWorkspaceRestore(
  db: Queryable,
  target: ManagedWorkspaceTarget & { operationId: string; generation: number },
  hosts: HostRegistry = sharedHostConnectionRegistry,
): Promise<ManagedWorkspaceResult> {
  if (!await hostJournalsManagedWorkspaceOperations(db, target.hostId)) {
    return { ok: false, changed: false, error: HOST_UPDATE_REQUIRED };
  }
  return send(hosts, "managed_workspace_restore", target, { operation_id: target.operationId, generation: target.generation });
}

/** The durable identity a direct chat turn's restore carries from the turn that asked for it to every retry of it. */
export interface DirectRestoreIdentity { operation_id: string; generation: number }

export async function newDirectRestoreIdentity(db: Queryable): Promise<DirectRestoreIdentity> {
  return { operation_id: `restore:${randomUUID()}`, generation: await nextManagedWorkspaceGeneration(db) };
}

export function directRestoreIdentity(value: unknown): DirectRestoreIdentity | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const generation = Number(record?.generation);
  return typeof record?.operation_id === "string" && Number.isSafeInteger(generation) && generation > 0
    ? { operation_id: record.operation_id, generation } : null;
}

/**
 * A direct chat turn's restore, before its launch. This Agent's still-pending
 * direct archives on the Host are settled first under their own identities,
 * so the Host applies them before the restore and refuses any late copy, and
 * one ever sent without an identity is drained first (`releaseUnfencedArchives`); the
 * restore itself is the turn's one operation, so a retried turn after a lost
 * reply replays it instead of meeting its own restored workspace as a conflict.
 */
export async function restoreDirectManagedWorkspace(
  db: Queryable,
  input: { hostId: string; agentId: string; userId: string; includeWorkspace: boolean; identity: DirectRestoreIdentity | null },
  hosts: HostRegistry = sharedHostConnectionRegistry,
): Promise<ManagedWorkspaceResult> {
  if (!input.identity || !await hostJournalsManagedWorkspaceOperations(db, input.hostId)) {
    return { ok: false, changed: false, error: HOST_UPDATE_REQUIRED };
  }
  const owed = await db.query<{ id: string; pending: boolean; unfenced: boolean }>(
    `SELECT id, pending_archive_at IS NOT NULL AS pending, archive_unfenced_at IS NOT NULL AS unfenced FROM host_threads
      WHERE container_kind = 'direct' AND agent_id = $1 AND container_user_id = $2 AND execution_host_id = $3
        AND status = 'closed' AND (pending_archive_at IS NOT NULL OR archive_unfenced_at IS NOT NULL)
      ORDER BY archive_generation NULLS FIRST`, [input.agentId, input.userId, input.hostId]);
  // A legacy archive copy still in flight would move the restored state away again: drained first.
  const released = await releaseUnfencedArchives(db, input.hostId, owed.rows.filter((row) => row.unfenced).map((row) => row.id), hosts);
  if (!released.ok) return released;
  const pending = { rows: owed.rows.filter((row) => row.pending) };
  const target = { hostId: input.hostId, agentId: input.agentId, containerKind: "direct" as const, containerId: input.userId };
  for (const thread of pending.rows) {
    const archived = await sendPendingManagedWorkspaceArchive(db, thread.id, target, hosts);
    if (!archived.settled && classifyManagedWorkspaceResult(archived) === "retry") return archived;
  }
  return send(hosts, "managed_workspace_restore", { ...target, includeWorkspace: input.includeWorkspace }, input.identity);
}

/**
 * Before a Run starts in a Conversation's managed cwd on a Host, every
 * archive intent there that moves that cwd is settled first, in the order
 * the intents committed. An archive fixed its cwd scope when the last Agent
 * left; delivered after another Agent began working in the cwd, it would move
 * that Agent's work out from under it. Settled first, the Run starts in a cwd
 * no earlier operation can still move. An unconfirmed archive is returned for
 * the caller to refuse the launch on; the next turn repeats the same operation.
 * An intent whose cwd scope was only inferred is settled too, since the Host
 * may hold it as a cwd archive. A Host without the journal refuses the launch
 * while one is owed; its recovery pass still delivers it.
 */
export async function settleConversationCwdArchives(
  db: Queryable,
  input: { hostId: string; conversationId: string },
  hosts: HostRegistry = sharedHostConnectionRegistry,
): Promise<ManagedWorkspaceResult> {
  const rows = await db.query<{ id: string; agent_id: string; pending: boolean; unfenced: boolean }>(
    `SELECT id, agent_id, pending_archive_at IS NOT NULL AND cwd AS pending, archive_unfenced_at IS NOT NULL AS unfenced
       FROM (SELECT thread.*,
                    -- An unconfirmed scope may be the Host's cwd archive whatever was inferred for it.
                    (archive_include_workspace IS NOT FALSE OR NOT archive_scope_confirmed) AS cwd FROM host_threads thread) thread
      WHERE container_kind = 'conversation' AND session_id = $1 AND execution_host_id = $2 AND agent_id IS NOT NULL
        AND status = 'closed' AND execution_workspace_json IS NULL
        -- A legacy copy chose its cwd scope per send: whatever this intent's scope, it may take the cwd.
        AND ((pending_archive_at IS NOT NULL AND cwd) OR archive_unfenced_at IS NOT NULL)
      ORDER BY archive_generation NULLS FIRST`, [input.conversationId, input.hostId]);
  // An archive once sent without an identity may still be in flight however it was acknowledged: the Host drains it.
  const released = await releaseUnfencedArchives(db, input.hostId, rows.rows.filter((row) => row.unfenced).map((row) => row.id), hosts);
  if (!released.ok) return released;
  const pending = { rows: rows.rows.filter((row) => row.pending) };
  // A legacy archive has no identity or fence: a late copy of it could not be told from a new one.
  if (pending.rows.length && !await hostJournalsManagedWorkspaceOperations(db, input.hostId)) {
    return { ok: false, changed: false, error: HOST_UPDATE_REQUIRED };
  }
  for (const thread of pending.rows) {
    const archived = await sendPendingManagedWorkspaceArchive(db, thread.id,
      { hostId: input.hostId, agentId: thread.agent_id, containerKind: "conversation", containerId: input.conversationId }, hosts);
    if (!archived.settled && classifyManagedWorkspaceResult(archived) === "retry") return archived;
  }
  return { ok: true, changed: false, error: null };
}

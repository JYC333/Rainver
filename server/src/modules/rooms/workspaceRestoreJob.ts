import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { optionalString, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { agentHostResetFence } from "../hosts/hostCommands.js";
import { JobDeferredError, type JobHandlerRegistry, type JobHandlerResult } from "../jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { canWriteProject } from "../projects/access.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { PgRoomRepository } from "./repository.js";
import type { ManagedConversationRestoreTarget } from "./rosterService.js";
import {
  classifyManagedWorkspaceResult,
  HOST_UPDATE_REQUIRED,
  hostJournalsManagedWorkspaceOperations,
  nextManagedWorkspaceGeneration,
  archiveTookConversationCwd,
  pendingArchiveIntent,
  releaseUnfencedArchives,
  requestManagedWorkspaceRestore,
  sendPendingManagedWorkspaceArchive,
} from "../hosts/managedWorkspaceOperations.js";
import { randomUUID } from "node:crypto";

export const ROOM_AGENT_WORKSPACE_RESTORE_JOB = "room_agent_workspace_restore";
/** While the Host is offline the restore waits for it, polling at this pace. */
const HOST_OFFLINE_RETRY_MS = 60_000;
/** A timed-out, unsent or interrupted operation is repeated at this pace; the repeat replays the Host's receipt. */
const HOST_UNCERTAIN_RETRY_MS = 5 * 60_000;
/**
 * A restore still unsettled after a week is reported to the person, once, and
 * keeps being reconciled — more slowly — until the Host settles it or the
 * request is withdrawn. The deadline is a warning, never an outcome: what the
 * Host did with an operation it may already hold is still unknown.
 */
const RESTORE_OVERDUE_MS = 7 * 24 * 60 * 60 * 1000;
const RESTORE_OVERDUE_RETRY_MS = 60 * 60_000;

/**
 * Commits the restore a person requested with the Agent's re-add, in that same
 * transaction: the exact closed thread, Host and conversation it was resolved
 * against, and who asked. A replay of the add finds this Job already committed.
 * At most one pending restore per thread; a second request is the same promise.
 */
export async function enqueueRoomAgentWorkspaceRestore(
  db: Queryable,
  input: { spaceId: string; userId: string; roomId: string; target: ManagedConversationRestoreTarget },
): Promise<void> {
  const existing = await db.query(
    `SELECT 1 FROM jobs WHERE space_id = $1 AND job_type = $2 AND payload_json->>'thread_id' = $3
        AND status IN ('pending', 'claimed', 'running') LIMIT 1`,
    [input.spaceId, ROOM_AGENT_WORKSPACE_RESTORE_JOB, input.target.threadId],
  );
  if (existing.rows[0]) return;
  // The thread's own archive intent keeps the generation and cwd scope it committed with; the
  // restore is ordered after it, so the Host refuses that archive if it lands later. An archive
  // still to move the shared cwd means this restore brings it back: decided now, once.
  const archive = await pendingArchiveIntent(db, input.target.threadId);
  const generation = await nextManagedWorkspaceGeneration(db);
  await new PgJobQueueRepository(db).enqueue({
    job_type: ROOM_AGENT_WORKSPACE_RESTORE_JOB,
    space_id: input.spaceId,
    user_id: input.userId,
    agent_id: input.target.agentId,
    max_attempts: 5,
    payload: {
      room_id: input.roomId,
      thread_id: input.target.threadId,
      host_id: input.target.hostId,
      agent_id: input.target.agentId,
      conversation_id: input.target.conversationId,
      include_workspace: input.target.includeWorkspace || (archive?.confirmed === true && archive.includeWorkspace),
      // An inferred archive scope is only known once the Host settles that archive; the restore's own
      // cwd scope is then fixed from it, once, before the restore is first sent.
      ...(archive && !archive.confirmed ? { include_workspace_after_archive: true } : {}),
      requested_at: new Date().toISOString(),
      // Every attempt of this Job is this one Host operation, with these parameters.
      operation_id: `restore:${randomUUID()}`,
      generation,
    },
  });
}

/**
 * `partially_restored`: the Agent's own profile came back, but the follow-up
 * that would bring back the shared cwd its archive took did not — refused
 * because another Agent's live cwd is there (`live_conflict`, never
 * overwritten; the old cwd stays archived on the Host), or nothing was left in
 * the Host's archive to bring back (`workspace_archive_missing`). The person is
 * told which part came back.
 */
type RestoreOutcome = "restored" | "partially_restored" | "nothing_restored" | "superseded" | "withdrawn" | "unavailable";

/**
 * Performs one committed restore, outside any transaction. Before the Host is
 * asked, the request must still be what was committed: the Agent is still an
 * active Room member, the requester still writes the Room's Project and owns
 * the Host, and the thread is still the closed one the Agent left with no
 * newer thread for it in the conversation. Anything else is not restored —
 * a withdrawn permission never restores, and a newer thread is never clobbered.
 */
export async function processRoomAgentWorkspaceRestore(
  pool: Pool,
  job: { job_id?: string; space_id: string; user_id: string | null; attempts: number; payload: Record<string, unknown> },
): Promise<{ outcome: RestoreOutcome; error?: string | null }> {
  const roomId = optionalString(job.payload.room_id), threadId = optionalString(job.payload.thread_id);
  const hostId = optionalString(job.payload.host_id), agentId = optionalString(job.payload.agent_id);
  const conversationId = optionalString(job.payload.conversation_id), userId = job.user_id;
  if (!roomId || !threadId || !hostId || !agentId || !conversationId || !userId) {
    throw new Error(`${ROOM_AGENT_WORKSPACE_RESTORE_JOB} requires room, thread, host, agent, conversation and user`);
  }
  const spaceId = job.space_id;
  const room = await new PgRoomRepository(pool).getVisibleRoom(spaceId, userId, roomId);
  const member = room
    ? (await pool.query<{ status: string }>(
      `SELECT status FROM room_agent_members WHERE space_id = $1 AND room_id = $2 AND agent_id = $3`,
      [spaceId, roomId, agentId])).rows[0]
    : undefined;
  if (!room || member?.status !== "active" || !await canWriteProject(pool, spaceId, room.project_id, userId)) {
    return { outcome: "withdrawn" };
  }
  const binding = (await pool.query<{ ok: boolean; newer: boolean }>(
    `SELECT (thread.status = 'closed' AND thread.execution_host_id = $3 AND thread.agent_id = $4
              AND thread.session_id = $5 AND conversation.room_id = $6
              AND host.owner_user_id = $7 AND host.status <> 'revoked') AS ok,
            EXISTS (SELECT 1 FROM host_threads other
                     WHERE other.space_id = thread.space_id AND other.session_id = thread.session_id
                       AND other.agent_id = thread.agent_id AND other.id <> thread.id
                       AND other.container_kind = 'conversation' AND other.status IN ('active', 'session_reset')) AS newer
       FROM host_threads thread
       JOIN sessions conversation ON conversation.id = thread.session_id AND conversation.space_id = thread.space_id
       JOIN hosts host ON host.id = thread.execution_host_id
      WHERE thread.space_id = $1 AND thread.id = $2`,
    [spaceId, threadId, hostId, agentId, conversationId, roomId, userId],
  )).rows[0];
  const notice = (content: string, error: string | null, kind: "outcome" | "overdue" = "outcome", restored: "partial" | null = null) =>
    noticeRestoreUnavailable(pool, { spaceId, userId, roomId, conversationId, agentId, content, error, kind, restored, key: job.job_id ?? null });
  const name = async () => (await pool.query<{ name: string }>(
    "SELECT name FROM agents WHERE space_id = $1 AND id = $2", [spaceId, agentId])).rows[0]?.name ?? "The Agent";
  if (!binding?.ok) return { outcome: "withdrawn" };
  if (binding.newer) {
    // The Agent already started again in this conversation; its archived state stays archived.
    await notice(`${await name()} was added and already started again, so its previous host state was not restored.`, "superseded");
    return { outcome: "superseded" };
  }
  const unavailable = async (error: string) => {
    await notice(`${await name()} was added, but its previous host state could not be restored (${error}).`, error);
    return { outcome: "unavailable" as const, error };
  };
  if (!await hostJournalsManagedWorkspaceOperations(pool, hostId)) return unavailable(HOST_UPDATE_REQUIRED);
  // A reset of this Agent's profiles on this Host goes first: nothing is restored while the Host has not
  // settled it, so the two never interleave there (a reset is refused while this restore is unfinished).
  if (await withQueryableTransaction(pool, (db) => agentHostResetFence(db, hostId, agentId))) {
    throw new JobDeferredError("Host restore waits for this Agent's unsettled Host reset", HOST_UNCERTAIN_RETRY_MS);
  }
  // Temporary or unknown: the same operation is repeated until the Host settles it or the request is
  // withdrawn. Past the deadline the person is told once and the reconciliation continues, slower.
  const retryLater = async (error: string | null): Promise<never> => {
    const requestedAt = Date.parse(optionalString(job.payload.requested_at) ?? "");
    const overdue = Number.isFinite(requestedAt) && Date.now() - requestedAt >= RESTORE_OVERDUE_MS;
    if (overdue) {
      await notice(error === "host_offline"
        ? `${await name()} was added, but its host has been offline, so its previous host state is not restored yet. Rainver keeps trying.`
        : `${await name()} was added, but whether its previous host state was restored is not confirmed yet (${error ?? "unknown"}). Rainver keeps checking.`,
      error, "overdue");
    }
    throw new JobDeferredError(`Host restore not settled (${error ?? "unknown"}); the same operation is repeated`,
      overdue ? RESTORE_OVERDUE_RETRY_MS : error === "host_offline" ? HOST_OFFLINE_RETRY_MS : HOST_UNCERTAIN_RETRY_MS);
  };
  const target = { hostId, agentId, containerKind: "conversation" as const, containerId: conversationId };
  // An archive in this conversation once sent without an identity may still be running on the Host
  // and would move the restored state away again: the Host drains it first, or nothing is restored.
  const unfenced = await pool.query<{ id: string }>(
    `SELECT id FROM host_threads WHERE session_id = $1 AND execution_host_id = $2 AND container_kind = 'conversation'
        AND status = 'closed' AND archive_unfenced_at IS NOT NULL`, [conversationId, hostId]);
  const drained = await releaseUnfencedArchives(pool, hostId, unfenced.rows.map((row) => row.id));
  if (!drained.ok) {
    return classifyManagedWorkspaceResult(drained) === "refused" ? unavailable(drained.error ?? HOST_UPDATE_REQUIRED) : retryLater(drained.error);
  }
  // An archive of this thread still unsettled goes first, as its own operation with the scope it
  // committed with: on the Host the restore then follows it, and a late copy of it is refused.
  const archived = await sendPendingManagedWorkspaceArchive(pool, threadId, target);
  if (!archived.settled && classifyManagedWorkspaceResult(archived) === "retry") return retryLater(archived.error);
  const identity = await restoreIdentity(pool, job, threadId);
  const main = await requestManagedWorkspaceRestore(pool, { ...target, ...identity });
  // The operation's parameters stay as first sent (the Host may hold them); what its receipt shows it did
  // is reconciled with the scope the Host confirmed for the archive, by a second operation if needed.
  const followUp = await restoreFollowUp(pool, job, threadId, identity.includeWorkspace, main);
  const restored = followUp
    ? await requestManagedWorkspaceRestore(pool, { ...target, ...followUp })
    : main;
  // The first operation brought the profile back; only the follow-up's own receipt says what happened to the
  // rest: refused, or — a cwd restore that moved nothing — no earlier cwd left in the Host's archive.
  const followUpOutcome = followUp ? classifyManagedWorkspaceResult(restored) : null;
  if (followUp && main.ok && main.changed
    && (followUpOutcome === "refused" || (followUpOutcome === "done" && followUp.includeWorkspace && !restored.changed))) {
    const error = followUpOutcome === "done" ? "workspace_archive_missing" : restored.error_code ?? restored.error ?? "restore_refused";
    await notice(error === "live_conflict"
      ? `${await name()} was added and its own host state was restored, but the conversation's earlier shared workspace was not: another Agent's workspace is there now and was left as it is. The earlier workspace stays archived on the host.`
      : `${await name()} was added and its own host state was restored, but the conversation's earlier shared workspace could not be restored (${error}).`,
    error, "outcome", "partial");
    return { outcome: "partially_restored", error };
  }
  if (followUpOutcome === "done") restored.changed ||= main.changed;
  switch (classifyManagedWorkspaceResult(restored)) {
    case "done":
      // The Host's receipt answers a repeat with the original result, so `changed` is what this operation did.
      if (restored.changed) return { outcome: "restored" };
      // The Agent is in the Room either way; a restore that brought nothing back is
      // the one outcome the person would otherwise never learn of.
      await notice(`${await name()} was added, but its previous host state could not be restored.`, null);
      return { outcome: "nothing_restored", error: null };
    case "refused":
      return unavailable(restored.error_code ?? restored.error ?? "restore_refused");
    case "retry":
      return retryLater(restored.error);
  }
}

/**
 * The Host operation this Job is: identity, generation and cwd scope, fixed
 * once and before it is first sent, after this thread's archive settled. An
 * enqueued restore carries all three, except a cwd scope that follows an
 * archive whose own scope was only inferred: that is fixed here from what the
 * Host confirmed the archive did. One committed before operations were
 * journaled takes all three on its first attempt — ordered after its thread's
 * archive intent — and keeps them for every later attempt.
 */
async function restoreIdentity(pool: Pool, job: { job_id?: string; payload: Record<string, unknown> }, threadId: string) {
  const operationId = optionalString(job.payload.operation_id);
  const generation = Number(job.payload.generation);
  const identified = operationId && Number.isSafeInteger(generation) && generation > 0;
  if (identified && (job.payload.include_workspace_after_archive !== true || job.payload.include_workspace_resolved === true)) {
    return { operationId, generation, includeWorkspace: job.payload.include_workspace === true };
  }
  if (!job.job_id) throw new Error(`${ROOM_AGENT_WORKSPACE_RESTORE_JOB} without a fixed operation needs its job id`);
  const tookCwd = await archiveTookConversationCwd(pool, threadId);
  const assigned = identified ? null : { operationId: `restore:${randomUUID()}`, generation: await nextManagedWorkspaceGeneration(pool) };
  const saved = (await pool.query<{ payload_json: Record<string, unknown> }>(
    `UPDATE jobs SET payload_json = payload_json || jsonb_build_object(
                       'operation_id', COALESCE(payload_json->>'operation_id', $2::text),
                       'generation', COALESCE((payload_json->>'generation')::bigint, $3::bigint),
                       'include_workspace', COALESCE((payload_json->>'include_workspace')::boolean, false) OR $4::boolean,
                       'include_workspace_resolved', true)
      WHERE id = $1 AND NOT (payload_json ? 'include_workspace_resolved') RETURNING payload_json`,
    [job.job_id, assigned?.operationId ?? null, assigned?.generation ?? null, tookCwd])).rows[0]
    ?? (await pool.query<{ payload_json: Record<string, unknown> }>(`SELECT payload_json FROM jobs WHERE id = $1`, [job.job_id])).rows[0];
  const operation = optionalString(saved?.payload_json.operation_id), saved_generation = Number(saved?.payload_json.generation);
  if (!operation || !Number.isSafeInteger(saved_generation)) throw new Error(`${ROOM_AGENT_WORKSPACE_RESTORE_JOB} could not record its operation identity`);
  return { operationId: operation, generation: saved_generation, includeWorkspace: saved?.payload_json.include_workspace === true };
}

/**
 * The Room restore Job's one corrective operation, fixed once in its payload
 * before it is first sent. A Job enqueued before an archive's scope was
 * confirmed carries the cwd scope inferred then, and its operation may already
 * be on the Host with it, so that operation is never resent with another
 * value. Once its receipt settled: a profile-only restore that followed an
 * archive the Host confirmed took the cwd restores the cwd next; a cwd restore
 * refused on a live cwd the archive did not take restores the profile alone.
 * A later generation, taken only after the first operation settled, so
 * nothing still in flight is overtaken by it.
 */
async function restoreFollowUp(pool: Pool, job: { job_id?: string; payload: Record<string, unknown> }, threadId: string,
  includeWorkspace: boolean, main: Awaited<ReturnType<typeof requestManagedWorkspaceRestore>>) {
  const stored = job.payload.follow_up as Record<string, unknown> | undefined;
  const fixed = () => {
    const generation = Number(stored?.generation);
    return typeof stored?.operation_id === "string" && Number.isSafeInteger(generation)
      ? { operationId: stored.operation_id, generation, includeWorkspace: stored.include_workspace === true } : null;
  };
  if (stored) return fixed();
  if (classifyManagedWorkspaceResult(main) === "retry") return null;
  const tookCwd = await archiveTookConversationCwd(pool, threadId);
  const scope = main.ok && !includeWorkspace && tookCwd ? true
    : main.error_code === "live_conflict" && includeWorkspace && !tookCwd ? false : null;
  if (scope === null || !job.job_id) return null;
  const candidate = { operation_id: `restore:${randomUUID()}`, generation: await nextManagedWorkspaceGeneration(pool), include_workspace: scope };
  const saved = (await pool.query<{ follow_up: Record<string, unknown> }>(
    `UPDATE jobs SET payload_json = payload_json || jsonb_build_object('follow_up', COALESCE(payload_json->'follow_up', $2::jsonb))
      WHERE id = $1 RETURNING payload_json->'follow_up' AS follow_up`, [job.job_id, JSON.stringify(candidate)])).rows[0];
  const generation = Number(saved?.follow_up?.generation);
  if (typeof saved?.follow_up?.operation_id !== "string" || !Number.isSafeInteger(generation)) {
    throw new Error(`${ROOM_AGENT_WORKSPACE_RESTORE_JOB} could not record its follow-up operation`);
  }
  return { operationId: saved.follow_up.operation_id, generation, includeWorkspace: saved.follow_up.include_workspace === true };
}

/**
 * At most one outcome notice and one overdue warning per restore Job: a repeat
 * after a crash that followed a notice adds none, and an overdue Job that
 * settles later still reports how it settled.
 */
async function noticeRestoreUnavailable(pool: Pool, input: {
  spaceId: string; userId: string; roomId: string; conversationId: string; agentId: string; content: string; error: string | null;
  kind: "outcome" | "overdue"; key: string | null; restored?: "partial" | null;
}): Promise<void> {
  if (input.key && (await pool.query(
    `SELECT 1 FROM messages WHERE session_id = $1 AND metadata_json->'execution_details'->>'restore_job_id' = $2
        AND COALESCE(metadata_json->'execution_details'->>'restore_notice', 'outcome') = $3 LIMIT 1`,
    [input.conversationId, input.key, input.kind])).rows[0]) return;
  await new PgSessionRepository(pool).addRoomSystemNotice(input.spaceId, input.userId, input.roomId, input.conversationId, {
    content: input.content,
    metadata: {
      room_id: input.roomId,
      host_thread_event: input.kind === "overdue" ? "managed_workspace_restore_overdue" : "managed_workspace_restore_unavailable",
      execution_details: { agent_id: input.agentId, error: input.error, restore_notice: input.kind,
        ...(input.restored ? { restored: input.restored } : {}), ...(input.key ? { restore_job_id: input.key } : {}) },
    },
  });
}

export function registerRoomAgentWorkspaceRestoreHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  registry.register(ROOM_AGENT_WORKSPACE_RESTORE_JOB, async (job): Promise<JobHandlerResult> =>
    processRoomAgentWorkspaceRestore(pool, job));
}

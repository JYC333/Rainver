import { randomUUID } from "node:crypto";
import type { InvocationDelivery } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool, type Pool } from "../../db/pool.js";
import { resolveUserActorId } from "../../db/actorResolver.js";
import { HttpError, optionalString, withDbTransaction, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { JobDeferredError, type JobHandlerRegistry, type JobHandlerResult } from "../jobs/handlerRegistry.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { createProductionRuntimeContextInvocationGateway, InvocationSnapshotService } from "../runtimeContext/index.js";
import { PgRunRepository } from "./repository.js";
import { authorizeRunCommand } from "./runCommandAuthority.js";
import { acpRuntimeContextPromptBlocks } from "./acpRuntimeContextPrompt.js";
import { liveInputChannel } from "./liveInput.js";
import { promptInputLimitFailure } from "./promptInputLimit.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

/** Thrown only when this Run's live channel can no longer take input; a deterministic conflict. */
export class LiveInputRefusal extends HttpError {
  constructor(message: string) { super(409, message); this.name = "LiveInputRefusal"; }
}

export const RUN_LIVE_INPUT_DELIVERY_JOB = "run_live_input_deliver";
/** A delivery waiting for the channel's owner, or for another input ahead of it, retries at this pace. */
const DELIVERY_RETRY_MS = 2_000;
const ACTION = "run.live_input";
type Settled = "injected" | "not_injected" | "unconfirmed";
export type LiveInputDeliveryState = "pending" | Settled;

/** Inputs this process is delivering now, and outcomes it knows but has not yet recorded. */
const inFlight = new Set<string>();
const knownOutcome = new Map<string, { state: Settled; deliveryId: string | null; summary: string }>();

/**
 * The person's additional input, persisted in the caller's transaction with its
 * pending event and its delivery Job. Delivery into the live process is that
 * Job's (after commit, with an immediate first attempt), never this transaction's.
 */
export async function recordRunLiveInput(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, runId: string, bindingId: string, content: string): Promise<{ message_id: string }> {
  const runs = new PgRunRepository(db, config);
  const run = await authorizeRunCommand(runs, identity, runId, "steer");
  const channel = liveInputChannel(runId);
  if (run.status !== "running" || !run.session_id || !channel?.available() || channel.delivery.id !== bindingId) {
    throw new LiveInputRefusal("This Run is no longer accepting additional input; send a new message instead");
  }
  const snapshot = await new InvocationSnapshotService(db as never).getSafe(identity.spaceId, channel.delivery.audit_refs.invocation_snapshot_id);
  if (!snapshot?.work_context_scope_id || !snapshot.setup_ref?.version) throw new LiveInputRefusal("Run has no live Runtime Context authority");
  const actorId = await resolveUserActorId(db as never, identity.spaceId, identity.userId);
  const sessions = new PgSessionRepository(db as never);
  const room = await sessions.getRoomConversation(identity.spaceId, identity.userId, run.session_id);
  const input = { content, run_id: runId };
  const saved = room?.room_id
    ? await sessions.addRoomUserMessage(identity.spaceId, identity.userId, room.room_id, run.session_id, input)
    : await sessions.addMessage(identity.spaceId, identity.userId, run.session_id, { ...input, role: "user" });
  if (!saved) throw new HttpError(404, "Conversation not found");
  await runs.appendRunEvent({ run_id: runId, space_id: identity.spaceId,
    actor_id: actorId, event_type: "action_invoked", status: "pending", summary: "Additional input awaiting Runtime Context authorization",
    metadata_json: { action_name: ACTION, message_id: saved.id, binding_id: bindingId, user_id: identity.userId } });
  await new PgJobQueueRepository(db).enqueue({ job_type: RUN_LIVE_INPUT_DELIVERY_JOB, space_id: identity.spaceId, user_id: identity.userId,
    agent_id: run.agent_id, max_attempts: 5, payload: { run_id: runId, binding_id: bindingId, message_id: saved.id } });
  return { message_id: saved.id };
}

interface InputRecord { claimed: boolean; settled: Settled | null; }

async function readInput(db: Queryable, spaceId: string, runId: string, messageId: string): Promise<InputRecord | null> {
  const rows = await db.query<{ event_type: string; status: string; state: string | null }>(
    `SELECT event_type, status, metadata_json->>'state' AS state FROM run_events
      WHERE space_id = $1 AND run_id = $2 AND metadata_json->>'action_name' = $3 AND metadata_json->>'message_id' = $4`,
    [spaceId, runId, ACTION, messageId]);
  if (!rows.rows.length) return null;
  const done = rows.rows.find(row => row.event_type === "action_completed");
  return {
    claimed: rows.rows.some(row => row.event_type === "action_invoked" && row.status === "running"),
    settled: done ? (done.state === "injected" || done.state === "unconfirmed" ? done.state : "not_injected") : null,
  };
}

/** Writes the one terminal outcome of an input; a second writer finds the first's and keeps it. */
async function settleInput(pool: Pool, config: ServerConfig, input: { spaceId: string; runId: string; messageId: string; bindingId: string; actorId: string | null },
  state: Settled, summary: string, deliveryId: string | null = null): Promise<Settled> {
  return withDbTransaction(pool, async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('run_events:' || $1::text, 0))`, [input.runId]);
    const current = await readInput(client, input.spaceId, input.runId, input.messageId);
    if (current?.settled) return current.settled;
    await new PgRunRepository(client, config).appendRunEvent({ run_id: input.runId, space_id: input.spaceId, actor_id: input.actorId,
      event_type: "action_completed", status: state === "injected" ? "succeeded" : "warning", summary,
      metadata_json: { action_name: ACTION, message_id: input.messageId, binding_id: input.bindingId, delivery_id: deliveryId, state } });
    return state;
  });
}

/** Marks an input as handed to the live process; written before any injection, so a lost outcome is never re-injected. */
async function claimInput(pool: Pool, config: ServerConfig, input: { spaceId: string; runId: string; messageId: string; bindingId: string; actorId: string | null }): Promise<boolean> {
  return withDbTransaction(pool, async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('run_events:' || $1::text, 0))`, [input.runId]);
    const current = await readInput(client, input.spaceId, input.runId, input.messageId);
    if (!current || current.claimed || current.settled) return false;
    await new PgRunRepository(client, config).appendRunEvent({ run_id: input.runId, space_id: input.spaceId, actor_id: input.actorId,
      event_type: "action_invoked", status: "running", summary: "Additional input is being delivered to the running turn",
      metadata_json: { action_name: ACTION, message_id: input.messageId, binding_id: input.bindingId, state: "delivering" } });
    return true;
  });
}

/**
 * One delivery attempt of a recorded input, outside any transaction; safe to
 * repeat. The input goes only into the exact binding it was recorded for, by
 * the process that owns that live channel. Before injection a failure leaves
 * nothing delivered (`not_injected`). Once claimed, the input is never
 * injected again: an outcome lost after the claim is `unconfirmed`, and an
 * acknowledgement failure after injection never rewrites what happened.
 * `pending` means the owning channel is busy or elsewhere; the Job retries.
 */
export async function deliverRunLiveInput(db: Pool, config: ServerConfig, identity: SpaceUserIdentity, runId: string, bindingId: string, messageId: string): Promise<LiveInputDeliveryState> {
  const runs = new PgRunRepository(db, config);
  const actorId = await resolveUserActorId(db, identity.spaceId, identity.userId);
  const ref = { spaceId: identity.spaceId, runId, messageId, bindingId, actorId };
  const current = await readInput(db, identity.spaceId, runId, messageId);
  if (!current) return "not_injected";
  if (current.settled) return current.settled;
  if (inFlight.has(messageId)) return "pending";
  const known = knownOutcome.get(messageId);
  if (known) {
    const state = await settleInput(db, config, ref, known.state, known.summary, known.deliveryId);
    knownOutcome.delete(messageId);
    return state;
  }
  // Claimed by an attempt that is no longer running: it may have injected, so it is never repeated.
  if (current.claimed) return settleInput(db, config, ref, "unconfirmed", "Additional input delivery was interrupted; it may have reached the running turn");
  const notDelivered = (summary: string) => settleInput(db, config, ref, "not_injected", summary);
  const channel = liveInputChannel(runId);
  if (!channel || channel.delivery.id !== bindingId) {
    const run = await runs.getRun(identity.spaceId, runId);
    // The binding is gone for good once its Run left execution or another attempt owns the channel here.
    if (!run || run.status !== "running" || channel) return notDelivered("The Run ended before additional input could be delivered");
    return "pending";
  }
  if (!channel.available()) return notDelivered("The Run ended before additional input could be delivered");
  try { await authorizeRunCommand(runs, identity, runId, "steer"); }
  catch { return notDelivered("Additional input was not authorized for delivery"); }
  const run = await runs.getRun(identity.spaceId, runId);
  const snapshot = await new InvocationSnapshotService(db).getSafe(identity.spaceId, channel.delivery.audit_refs.invocation_snapshot_id);
  const scopeId = snapshot?.work_context_scope_id, setupVersion = snapshot?.setup_ref?.version;
  if (!run || !snapshot || !scopeId || !setupVersion) return notDelivered("Run has no live Runtime Context authority");
  inFlight.add(messageId);
  try {
    let entered = false;
    const outcome = await channel.during(async (): Promise<LiveInputDeliveryState> => {
      entered = true;
      if (!await claimInput(db, config, ref)) return "pending";
      const gateway = createProductionRuntimeContextInvocationGateway(db, config);
      let delivery: InvocationDelivery;
      try {
        delivery = await gateway.prepareInvocation({
          identity, invocationId: runId, executionControlSnapshotId: channel.delivery.audit_refs.execution_control_snapshot_id,
          runtimeKey: run.runtime_key!, providerId: channel.delivery.provider_id, model: channel.delivery.model,
          usageSourceId: `runtime-context:${runId}:steer:${randomUUID()}`,
          runtimeSessionBindingRef: snapshot.runtime_session_binding_ref,
          turn: { work_context_scope_id: scopeId, expected_setup_version: Number(setupVersion),
            current_message_ref: { type: "message", id: messageId }, one_off_refs: [], invocation_purpose: "agent_task", retrieval_intent: null },
        });
      } catch {
        return remember(messageId, "not_injected", null, "Additional input was not authorized for delivery");
      }
      let state: Settled = "not_injected", acknowledged = false;
      const acknowledge = () => gateway.acknowledgeDelivery({ spaceId: identity.spaceId, deliveryId: delivery.id,
        status: state === "injected" ? "accepted" : state === "unconfirmed" ? "failed" : "rejected",
        adapterReceiptRef: { type: "runtime_live_input", id: bindingId },
        errorCode: state === "injected" ? null : `runtime_input_${state}` }).then(() => { acknowledged = true; });
      // A delivery is finalized only once acknowledged: an acknowledgement that failed is retried
      // here, with the outcome already fixed, before the channel's close finalizes it.
      channel.onClose(async () => {
        if (!acknowledged) await acknowledge().catch(() => undefined);
        await gateway.finalizeInvocation({ spaceId: identity.spaceId, invocationId: runId, deliveryId: delivery.id,
          errorCode: state === "injected" ? null : `runtime_input_${state}` });
      });
      // A live process has only the original mounted Skill files and tool grants.
      const originalSkills = new Set((channel.delivery.skill_packages ?? []).map(skill => `${skill.content.skill_package_id}:${skill.content.package_hash}`));
      const unchangedSkills = (delivery.skill_packages ?? []).every(skill => originalSkills.has(`${skill.content.skill_package_id}:${skill.content.package_hash}`));
      const blocks = acpRuntimeContextPromptBlocks(delivery);
      const spec = getRuntimeAdapterSpec(run.runtime_key);
      if (unchangedSkills && !promptInputLimitFailure({ runtimeName: spec?.display_name ?? run.runtime_key!,
        limit: spec?.invocation?.max_prompt_chars, prompts: [], promptBlocks: [blocks] })) {
        try { state = await channel.inject(blocks) === "injected" ? "injected" : "not_injected"; }
        catch { state = "unconfirmed"; }
      }
      // From here the outcome is a fact: acknowledgement is bookkeeping and cannot change it.
      remember(messageId, state, delivery.id, state === "injected" ? "Additional input delivered to the running turn" : "Additional input was not confirmed delivered");
      await acknowledge().catch(() => undefined);
      return state;
    }).catch(error => {
      // Another input holds the channel: nothing was claimed, so this one simply waits its turn.
      if (!entered && channel.available()) return "pending" as const;
      if (!entered) return "not_injected" as const;
      throw error;
    });
    const recorded = knownOutcome.get(messageId);
    if (recorded) {
      const state = await settleInput(db, config, ref, recorded.state, recorded.summary, recorded.deliveryId);
      knownOutcome.delete(messageId);
      return state;
    }
    if (outcome === "not_injected") return notDelivered("The Run ended before additional input could be delivered");
    return outcome;
  } finally {
    inFlight.delete(messageId);
  }
}

function remember(messageId: string, state: Settled, deliveryId: string | null, summary: string): Settled {
  knownOutcome.set(messageId, { state, deliveryId, summary });
  return state;
}

/**
 * Recovery for inputs whose live binding is gone without an outcome: the Run
 * left execution (its process ended or crashed). An unclaimed input was never
 * handed over (`not_injected`); a claimed one may have been (`unconfirmed`).
 */
export async function settleOrphanedRunLiveInputs(pool: Pool, config: ServerConfig): Promise<number> {
  const orphaned = await pool.query<{ space_id: string; run_id: string; message_id: string; binding_id: string; claimed: boolean }>(
    `SELECT pending.space_id, pending.run_id, pending.metadata_json->>'message_id' AS message_id,
            COALESCE(pending.metadata_json->>'binding_id', '') AS binding_id,
            EXISTS (SELECT 1 FROM run_events claim
                     WHERE claim.space_id = pending.space_id AND claim.run_id = pending.run_id
                       AND claim.event_type = 'action_invoked' AND claim.status = 'running'
                       AND claim.metadata_json->>'action_name' = '${ACTION}'
                       AND claim.metadata_json->>'message_id' = pending.metadata_json->>'message_id') AS claimed
       FROM run_events pending
       JOIN runs run ON run.id = pending.run_id AND run.space_id = pending.space_id
      WHERE pending.event_type = 'action_invoked' AND pending.status = 'pending'
        AND pending.metadata_json->>'action_name' = '${ACTION}'
        AND run.status NOT IN ('running', 'cancelling')
        AND NOT EXISTS (SELECT 1 FROM run_events done
                         WHERE done.space_id = pending.space_id AND done.run_id = pending.run_id
                           AND done.event_type = 'action_completed'
                           AND done.metadata_json->>'action_name' = '${ACTION}'
                           AND done.metadata_json->>'message_id' = pending.metadata_json->>'message_id')
      LIMIT 200`);
  for (const row of orphaned.rows) {
    const ref = { spaceId: row.space_id, runId: row.run_id, messageId: row.message_id, bindingId: row.binding_id, actorId: null };
    await (row.claimed
      ? settleInput(pool, config, ref, "unconfirmed", "Additional input delivery was interrupted; it may have reached the running turn")
      : settleInput(pool, config, ref, "not_injected", "The Run ended before additional input could be delivered"));
  }
  return orphaned.rows.length;
}

export function registerRunLiveInputDeliveryHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  registry.register(RUN_LIVE_INPUT_DELIVERY_JOB, async (job): Promise<JobHandlerResult> => {
    const runId = optionalString(job.payload.run_id), bindingId = optionalString(job.payload.binding_id), messageId = optionalString(job.payload.message_id);
    if (!runId || !bindingId || !messageId || !job.user_id) throw new Error(`${RUN_LIVE_INPUT_DELIVERY_JOB} requires run, binding, message and user`);
    const state = await deliverRunLiveInput(pool, config, { spaceId: job.space_id, userId: job.user_id }, runId, bindingId, messageId);
    if (state === "pending") throw new JobDeferredError("Additional input waits for its live channel", DELIVERY_RETRY_MS);
    return { run_id: runId, message_id: messageId, state };
  });
}

/** What happened to one recorded input, from the Run's own events. */
export async function liveInputDeliveryState(db: Queryable, spaceId: string, runId: string, messageId: string): Promise<LiveInputDeliveryState | null> {
  const record = await readInput(db, spaceId, runId, messageId);
  return record ? record.settled ?? "pending" : null;
}

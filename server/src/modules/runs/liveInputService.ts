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
import { waitAcceptsPersonInput } from "../agentGroups/waitInput.js";
import { lockProjectAudience } from "../projects/access.js";

/** Thrown only when this Run's live channel can no longer take input; a deterministic conflict. */
export class LiveInputRefusal extends HttpError {
  constructor(message: string) { super(409, message); this.name = "LiveInputRefusal"; }
}

export const RUN_LIVE_INPUT_DELIVERY_JOB = "run_live_input_deliver";
/** A delivery waiting for the channel's owner, or for another input ahead of it, retries at this pace. */
const DELIVERY_RETRY_MS = 2_000;
const ACTION = "run.live_input";
/** An input saved for a Run parked on `agent.wait_for_results`; its resume hands it over with the results. */
const WITH_RESULTS = "with_results";
type Settled = "injected" | "not_injected" | "unconfirmed" | "delivered_with_results";
const SETTLED_STATES = new Set<string>(["injected", "not_injected", "unconfirmed", "delivered_with_results"]);
/** `deferred`: saved, owed to the Run's resume together with the results it waits for. */
export type LiveInputDeliveryState = "pending" | "deferred" | Settled;

/** Inputs this process is delivering now, and outcomes it knows but has not yet recorded. */
const inFlight = new Set<string>();
const knownOutcome = new Map<string, { state: Settled; deliveryId: string | null; summary: string }>();

/**
 * The person's additional input, persisted in the caller's transaction with its
 * pending event and its delivery Job. Delivery into the live process is that
 * Job's (after commit, with an immediate first attempt), never this transaction's.
 *
 * The Run is read `running` under its row lock (`lockRunForLiveInput`), held
 * until the caller commits: parking the Run updates that row, so it waits for
 * this input to be durable, and the resume that follows reads it as owed. An
 * input is never accepted for a turn whose resume has already read its inputs.
 */
export async function recordRunLiveInput(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, runId: string, bindingId: string, content: string): Promise<{ message_id: string }> {
  const runs = new PgRunRepository(db, config);
  const run = await authorizeRunCommand(runs, identity, runId, "steer");
  const locked = await lockRunForLiveInput(db, identity.spaceId, runId);
  const channel = liveInputChannel(runId);
  if (locked?.status !== "running" || !run.session_id || locked.session_id !== run.session_id || !channel?.available() || channel.delivery.id !== bindingId) {
    throw new LiveInputRefusal("This Run is no longer accepting additional input; send a new message instead");
  }
  const snapshot = await new InvocationSnapshotService(db as never).getSafe(identity.spaceId, channel.delivery.audit_refs.invocation_snapshot_id);
  if (!snapshot?.work_context_scope_id || !snapshot.setup_ref?.version) throw new LiveInputRefusal("Run has no live Runtime Context authority");
  const actorId = await resolveUserActorId(db as never, identity.spaceId, identity.userId);
  const saved = await saveInputMessage(db, identity, run.session_id, runId, content);
  await runs.appendRunEvent({ run_id: runId, space_id: identity.spaceId,
    actor_id: actorId, event_type: "action_invoked", status: "pending", summary: "Additional input awaiting Runtime Context authorization",
    metadata_json: { action_name: ACTION, message_id: saved.id, binding_id: bindingId, user_id: identity.userId } });
  await new PgJobQueueRepository(db).enqueue({ job_type: RUN_LIVE_INPUT_DELIVERY_JOB, space_id: identity.spaceId, user_id: identity.userId,
    agent_id: run.agent_id, max_attempts: 5, payload: { run_id: runId, binding_id: bindingId, message_id: saved.id } });
  return { message_id: saved.id };
}

/** The person's input as a canonical message of the Run's conversation, linked to that Run. */
async function saveInputMessage(db: Queryable, identity: SpaceUserIdentity, sessionId: string, runId: string, content: string): Promise<{ id: string }> {
  const sessions = new PgSessionRepository(db as never);
  const room = await sessions.getRoomConversation(identity.spaceId, identity.userId, sessionId);
  const input = { content, run_id: runId };
  const saved = room?.room_id
    ? await sessions.addRoomUserMessage(identity.spaceId, identity.userId, room.room_id, sessionId, input)
    : await sessions.addMessage(identity.spaceId, identity.userId, sessionId, { ...input, role: "user" });
  if (!saved) throw new HttpError(404, "Conversation not found");
  return saved;
}

/**
 * The one lock order for a Run's live inputs, shared by every path that
 * decides one (`modules/rooms.md`, "Ordinary send into an active turn"):
 *
 * 1. the Run row, `FOR NO KEY UPDATE` — never `FOR UPDATE`. Every event insert
 *    checks `run_events_run_id_fkey`, which takes `FOR KEY SHARE` on this row
 *    while its writer already holds step 2; `FOR UPDATE` would block that check
 *    and deadlock against a writer of step 2 waiting for it. `NO KEY UPDATE`
 *    still excludes another decider and the Run's own status update.
 * 2. the Run's `run_events` advisory lock, the one `appendRunEvent` takes.
 *
 * A writer that needs only step 2 (the runtime event sink)
 * never waits on step 1, so no cycle can form.
 */
async function lockRunForLiveInput(db: Queryable, spaceId: string, runId: string): Promise<RunLockRow | null> {
  const row = await db.query<RunLockRow>(
    `SELECT status, session_id, output_json, model_override_json FROM runs WHERE space_id = $1 AND id = $2 FOR NO KEY UPDATE`, [spaceId, runId]);
  return row.rows[0] ?? null;
}
interface RunLockRow { status: string; session_id: string | null; output_json: unknown; model_override_json: unknown }

async function lockRunEvents(db: Queryable, runId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('run_events:' || $1::text, 0))`, [runId]);
}

async function lockWaitingRun(db: Queryable, spaceId: string, runId: string): Promise<boolean> {
  const row = await lockRunForLiveInput(db, spaceId, runId);
  return Boolean(row && waitAcceptsPersonInput(row));
}

/**
 * The person's input to a Run parked on `agent.wait_for_results`, in the
 * caller's transaction. Nothing is injected: the Run's row lock orders this
 * against its resume, which either reads the input into the continuation
 * with the waited results or has already moved the Run on (a refusal here).
 */
export async function recordDeferredRunLiveInput(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, runId: string, content: string): Promise<{ message_id: string }> {
  const runs = new PgRunRepository(db, config);
  const run = await authorizeRunCommand(runs, identity, runId, "steer");
  if (!run.session_id || !await lockWaitingRun(db, identity.spaceId, runId)) {
    throw new LiveInputRefusal("This Run is no longer waiting for results; send a new message instead");
  }
  const actorId = await resolveUserActorId(db as never, identity.spaceId, identity.userId);
  const saved = await saveInputMessage(db, identity, run.session_id, runId, content);
  await runs.appendRunEvent({ run_id: runId, space_id: identity.spaceId, actor_id: actorId, event_type: "action_invoked", status: "pending",
    summary: "Additional input saved; it is delivered with the waited results when this Run resumes",
    metadata_json: { action_name: ACTION, message_id: saved.id, binding_id: null, user_id: identity.userId, mode: WITH_RESULTS } });
  return { message_id: saved.id };
}

interface InputRecord { claimed: boolean; deferred: boolean; settled: Settled | null; }

async function readInput(db: Queryable, spaceId: string, runId: string, messageId: string): Promise<InputRecord | null> {
  const rows = await db.query<{ event_type: string; status: string; state: string | null; mode: string | null }>(
    `SELECT event_type, status, metadata_json->>'state' AS state, metadata_json->>'mode' AS mode FROM run_events
      WHERE space_id = $1 AND run_id = $2 AND metadata_json->>'action_name' = $3 AND metadata_json->>'message_id' = $4`,
    [spaceId, runId, ACTION, messageId]);
  if (!rows.rows.length) return null;
  const done = rows.rows.find(row => row.event_type === "action_completed");
  return {
    claimed: rows.rows.some(row => row.event_type === "action_invoked" && row.status === "running"),
    deferred: rows.rows.some(row => row.event_type === "action_invoked" && row.status === "pending" && row.mode === WITH_RESULTS),
    settled: done ? (done.state && SETTLED_STATES.has(done.state) ? done.state as Settled : "not_injected") : null,
  };
}

/** What a parked Run's resume does with the inputs owed to it. */
export interface DeferredRunLiveInputs {
  /** Handed to the continuation, in the order the person sent them. */
  carried: Array<{ message_id: string; content: string }>;
  /** Not handed over: the sender may no longer steer this Run or read its conversation. */
  refused: string[];
}

/** The one wait a resume was decided for (`waiting_for_results` at park time). */
export interface WaitRound { round_id: string | null; depends_on_run_ids: string[] }

/** Whether the Run row still parks on exactly this round: same id, same dependencies. */
function parksOnRound(row: RunLockRow, round: WaitRound): boolean {
  if (row.status !== "waiting_for_dependency") return false;
  const waiting = (row.output_json as { waiting_for_results?: { status?: unknown; round_id?: unknown; depends_on_run_ids?: unknown } } | null)?.waiting_for_results;
  if (waiting?.status !== "waiting") return false;
  const roundId = typeof waiting.round_id === "string" ? waiting.round_id : null;
  const deps = Array.isArray(waiting.depends_on_run_ids) ? waiting.depends_on_run_ids : [];
  return roundId === round.round_id && deps.length === round.depends_on_run_ids.length
    && deps.every((id, index) => id === round.depends_on_run_ids[index]);
}

/**
 * Inputs owed to this parked Run's resume, in the resume's transaction. Owed
 * are every unclaimed, unsettled input of the Run, not only the ones already
 * marked `with_results` — an input sent while the Run was still running and
 * not yet taken by its delivery Job belongs to this turn as much. A claimed one
 * may have been injected and is left to its own outcome; nothing can be
 * claimed or recorded between this read and the requeue.
 *
 * Locks, in the order every permission decision takes them before a Run
 * (`lockEnvelopeRooms` in the Runtime Context gateway): the Run's Project
 * audience (`lockProjectAudience`, which every Project membership change
 * conflicts with), then its Room `FOR SHARE` (every Room roster writer — a
 * member's removal included — takes the Room `FOR UPDATE` first), then the
 * Run row (`lockRunForLiveInput`). All live-input outcome writers take this
 * row, so the resume can append its events after acquiring all domain locks. A revocation
 * commits before this check reads it, or waits until the resume committed.
 *
 * Null when the Run no longer parks on `round`: the snapshot the resume was
 * decided from is stale (another path resumed it, and it may wait again), so
 * nothing is read or consumed and the caller resumes nothing.
 *
 * Saving an input checked its sender; handing it over checks again. A sender
 * who no longer may steer the Run (`authorizeRunCommand`) or read its
 * conversation is refused, so their words never enter the continuation.
 */
export async function takeDeferredRunLiveInputs(db: Queryable, input: {
  spaceId: string; runId: string; round: WaitRound; projectId: string | null; roomId: string | null;
}): Promise<DeferredRunLiveInputs | null> {
  const { spaceId, runId } = input;
  if (input.projectId) await lockProjectAudience(db, spaceId, input.projectId);
  if (input.roomId) await db.query(`SELECT id FROM rooms WHERE space_id = $1 AND id = $2 FOR SHARE`, [spaceId, input.roomId]);
  const run = await lockRunForLiveInput(db, spaceId, runId);
  if (!run || !parksOnRound(run, input.round)) return null;
  const taken: DeferredRunLiveInputs = { carried: [], refused: [] };
  if (!run.session_id) return taken;
  const rows = await db.query<{ message_id: string; content: string; user_id: string | null; session_id: string; message_run_id: string | null }>(
    `SELECT message.id AS message_id, message.content, message.user_id, message.session_id, message.run_id AS message_run_id
       FROM run_events pending
       JOIN messages message ON message.space_id = pending.space_id AND message.id = pending.metadata_json->>'message_id'
      WHERE pending.space_id = $1 AND pending.run_id = $2 AND pending.event_type = 'action_invoked' AND pending.status = 'pending'
        AND pending.metadata_json->>'action_name' = $3
        AND NOT EXISTS (SELECT 1 FROM run_events other
                         WHERE other.space_id = pending.space_id AND other.run_id = pending.run_id
                           AND other.metadata_json->>'action_name' = $3 AND other.metadata_json->>'message_id' = pending.metadata_json->>'message_id'
                           AND (other.event_type = 'action_completed' OR (other.event_type = 'action_invoked' AND other.status = 'running')))
      GROUP BY message.id, message.content, message.user_id, message.session_id, message.run_id
      ORDER BY MIN(pending.event_index)`,
    [spaceId, runId, ACTION]);
  const runs = new PgRunRepository(db);
  const sessions = new PgSessionRepository(db as never);
  for (const row of rows.rows) {
    const sender = row.user_id;
    const own = Boolean(sender) && row.session_id === run.session_id && row.message_run_id === runId;
    const mayStillSteer = own && await authorizeRunCommand(runs, { spaceId, userId: sender! }, runId, "steer").then(() => true, () => false);
    const mayStillRead = mayStillSteer && Boolean(input.roomId
      ? await sessions.getRoomConversation(spaceId, sender!, row.session_id, input.roomId)
      : await sessions.getSession(spaceId, sender!, row.session_id));
    if (mayStillRead) taken.carried.push({ message_id: row.message_id, content: row.content });
    else taken.refused.push(row.message_id);
  }
  return taken;
}

/** The resume that carried or refused these inputs committed with them: their one outcome, in the same transaction. */
export async function settleDeferredRunLiveInputs(runs: Pick<PgRunRepository, "appendRunEvent">, spaceId: string, runId: string, taken: DeferredRunLiveInputs): Promise<void> {
  const outcomes = [
    ...taken.carried.map(item => ({ messageId: item.message_id, state: "delivered_with_results" as const, status: "succeeded" as const,
      summary: "Additional input delivered to the resumed Run with its waited results" })),
    ...taken.refused.map(messageId => ({ messageId, state: "not_injected" as const, status: "warning" as const,
      summary: "Additional input was not delivered: its sender may no longer steer this Run" })),
  ];
  for (const outcome of outcomes) {
    await runs.appendRunEvent({ run_id: runId, space_id: spaceId, actor_id: null, event_type: "action_completed", status: outcome.status,
      summary: outcome.summary,
      metadata_json: { action_name: ACTION, message_id: outcome.messageId, binding_id: null, delivery_id: null, state: outcome.state } });
  }
}

type InputRef = { spaceId: string; runId: string; messageId: string; bindingId: string; actorId: string | null };

async function appendInputOutcome(db: Queryable, config: ServerConfig, input: InputRef,
  state: Settled, summary: string, deliveryId: string | null = null): Promise<Settled> {
  await new PgRunRepository(db, config).appendRunEvent({ run_id: input.runId, space_id: input.spaceId, actor_id: input.actorId,
    event_type: "action_completed", status: state === "injected" ? "succeeded" : "warning", summary,
    metadata_json: { action_name: ACTION, message_id: input.messageId, binding_id: input.bindingId, delivery_id: deliveryId, state } });
  return state;
}

/** Writes the one terminal outcome of an input; a second writer finds and keeps it. */
async function settleInput(pool: Pool, config: ServerConfig, input: InputRef,
  state: Settled, summary: string, deliveryId: string | null = null): Promise<Settled> {
  return withDbTransaction(pool, async client => {
    await lockRunForLiveInput(client, input.spaceId, input.runId);
    await lockRunEvents(client, input.runId);
    const current = await readInput(client, input.spaceId, input.runId, input.messageId);
    return current?.settled ?? appendInputOutcome(client, config, input, state, summary, deliveryId);
  });
}

/** Recheck both the Run and the input before recovery changes either outcome. */
async function recoverInput(pool: Pool, config: ServerConfig, input: InputRef, summary: string,
  onlyInactive = false): Promise<{ state: LiveInputDeliveryState; settled: boolean }> {
  return withDbTransaction(pool, async client => {
    const run = await lockRunForLiveInput(client, input.spaceId, input.runId);
    await lockRunEvents(client, input.runId);
    const current = await readInput(client, input.spaceId, input.runId, input.messageId);
    if (!run || !current || current.settled) return { state: current?.settled ?? "not_injected", settled: false };
    const known = knownOutcome.get(input.messageId);
    if (inFlight.has(input.messageId) || (onlyInactive && (run.status === "running" || run.status === "cancelling"))) {
      return { state: "pending", settled: false };
    }
    if (known) {
      const state = await appendInputOutcome(client, config, input, known.state, known.summary, known.deliveryId);
      return { state, settled: true };
    }
    if (!current.claimed && waitAcceptsPersonInput(run)) {
      if (!current.deferred) await new PgRunRepository(client, config).appendRunEvent({
        run_id: input.runId, space_id: input.spaceId, actor_id: input.actorId, event_type: "action_invoked", status: "pending",
        summary: "The Run paused for waited results; additional input is delivered with them when it resumes",
        metadata_json: { action_name: ACTION, message_id: input.messageId, binding_id: null, mode: WITH_RESULTS },
      });
      return { state: "deferred", settled: false };
    }
    const state = current.claimed ? "unconfirmed" : "not_injected";
    await appendInputOutcome(client, config, input, state, current.claimed
      ? "Additional input delivery was interrupted; it may have reached the running turn" : summary);
    return { state, settled: true };
  });
}

/** Marks an input as handed to the live process; written before any injection, so a lost outcome is never re-injected. */
async function claimInput(pool: Pool, config: ServerConfig, input: InputRef): Promise<boolean> {
  return withDbTransaction(pool, async client => {
    const run = await lockRunForLiveInput(client, input.spaceId, input.runId);
    if (run?.status !== "running") return false;
    await lockRunEvents(client, input.runId);
    const current = await readInput(client, input.spaceId, input.runId, input.messageId);
    if (!current || current.claimed || current.deferred || current.settled) return false;
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
  if (current.deferred) return "deferred";
  if (inFlight.has(messageId)) return "pending";
  const known = knownOutcome.get(messageId);
  if (known) {
    const state = await settleInput(db, config, ref, known.state, known.summary, known.deliveryId);
    knownOutcome.delete(messageId);
    return state;
  }
  // Claimed by an attempt that is no longer running: it may have injected, so it is never repeated.
  if (current.claimed) return (await recoverInput(db, config, ref, "Additional input delivery was interrupted")).state;
  const notDelivered = async (summary: string) => (await recoverInput(db, config, ref, summary)).state;
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
  if (run?.status === "waiting_for_dependency") {
    return (await recoverInput(db, config, ref, "The Run paused before additional input could be delivered", true)).state;
  }
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
    if (outcome === "not_injected") {
      inFlight.delete(messageId);
      return notDelivered("The Run ended before additional input could be delivered");
    }
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
  const orphaned = await pool.query<{ space_id: string; run_id: string; message_id: string; binding_id: string }>(
    `SELECT DISTINCT ON (pending.space_id, pending.run_id, pending.metadata_json->>'message_id')
            pending.space_id, pending.run_id, pending.metadata_json->>'message_id' AS message_id,
            COALESCE(pending.metadata_json->>'binding_id', '') AS binding_id
       FROM run_events pending
       JOIN runs run ON run.id = pending.run_id AND run.space_id = pending.space_id
      WHERE pending.event_type = 'action_invoked' AND pending.status = 'pending'
        AND pending.metadata_json->>'action_name' = '${ACTION}'
        AND run.status NOT IN ('running', 'cancelling')
        -- Owed to a resume that has not happened yet: excluded before the LIMIT,
        -- so however many inputs parked Runs keep, the rest are still settled.
        AND NOT (run.status = 'waiting_for_dependency'
                 AND EXISTS (SELECT 1 FROM run_events wait
                              WHERE wait.space_id = pending.space_id AND wait.run_id = pending.run_id
                                AND wait.event_type = 'action_invoked' AND wait.status = 'pending'
                                AND wait.metadata_json->>'action_name' = '${ACTION}' AND wait.metadata_json->>'mode' = '${WITH_RESULTS}'
                                AND wait.metadata_json->>'message_id' = pending.metadata_json->>'message_id')
                 AND NOT EXISTS (SELECT 1 FROM run_events claim
                                  WHERE claim.space_id = pending.space_id AND claim.run_id = pending.run_id
                                    AND claim.event_type = 'action_invoked' AND claim.status = 'running'
                                    AND claim.metadata_json->>'action_name' = '${ACTION}'
                                    AND claim.metadata_json->>'message_id' = pending.metadata_json->>'message_id'))
        AND NOT EXISTS (SELECT 1 FROM run_events done
                         WHERE done.space_id = pending.space_id AND done.run_id = pending.run_id
                           AND done.event_type = 'action_completed'
                           AND done.metadata_json->>'action_name' = '${ACTION}'
                           AND done.metadata_json->>'message_id' = pending.metadata_json->>'message_id')
      ORDER BY pending.space_id, pending.run_id, pending.metadata_json->>'message_id', pending.event_index
      LIMIT 200`);
  let settled = 0;
  for (const row of orphaned.rows) {
    const ref = { spaceId: row.space_id, runId: row.run_id, messageId: row.message_id, bindingId: row.binding_id, actorId: null };
    const outcome = await recoverInput(pool, config, ref, "The Run ended before additional input could be delivered", true);
    if (outcome.settled) {
      knownOutcome.delete(row.message_id);
      settled++;
    }
  }
  return settled;
}

export function registerRunLiveInputDeliveryHandler(registry: JobHandlerRegistry, config: ServerConfig): void {
  if (!config.databaseUrl) return;
  const pool = getDbPool(config.databaseUrl);
  registry.register(RUN_LIVE_INPUT_DELIVERY_JOB, async (job): Promise<JobHandlerResult> => {
    const runId = optionalString(job.payload.run_id), bindingId = optionalString(job.payload.binding_id), messageId = optionalString(job.payload.message_id);
    if (!runId || !bindingId || !messageId || !job.user_id) throw new Error(`${RUN_LIVE_INPUT_DELIVERY_JOB} requires run, binding, message and user`);
    const state = await deliverRunLiveInput(pool, config, { spaceId: job.space_id, userId: job.user_id }, runId, bindingId, messageId);
    if (state === "pending") throw new JobDeferredError("Additional input waits for its live channel", DELIVERY_RETRY_MS);
    // `deferred` is done here: the Run's resume, not this Job, delivers it.
    return { run_id: runId, message_id: messageId, state };
  });
}

/** What happened to one recorded input, from the Run's own events. */
export async function liveInputDeliveryState(db: Queryable, spaceId: string, runId: string, messageId: string): Promise<LiveInputDeliveryState | null> {
  const record = await readInput(db, spaceId, runId, messageId);
  return record ? record.settled ?? (record.deferred ? "deferred" : "pending") : null;
}

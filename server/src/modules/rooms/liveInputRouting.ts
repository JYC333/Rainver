import { ROOM_LIVE_INPUT_CHOICE_REQUIRED, ROOM_LIVE_INPUT_TARGET_UNAVAILABLE, type RoomLiveInputCandidate, type RoomLiveTarget } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Queryable, SpaceUserIdentity } from "../routeUtils/common.js";
import { PgRunRepository } from "../runs/repository.js";
import { authorizeRunCommand } from "../runs/runCommandAuthority.js";
import { liveInputChannel } from "../runs/liveInput.js";
import { recordDeferredRunLiveInput, recordRunLiveInput } from "../runs/liveInputService.js";
import { waitAcceptsPersonInput } from "../agentGroups/waitInput.js";
import { RoomMutationError } from "./roomMutationError.js";

/**
 * An ordinary Room send into an active Run (`modules/rooms.md`, "Ordinary
 * send into an active turn"). The message's own route picks the Agent; this
 * module only decides whether exactly one of that Agent's active Runs in the
 * conversation can take the text now, and records it through the existing
 * `run.live_input` channel. Anything it cannot carry stays an ordinary send.
 */

export interface LiveRouteInput {
  content: string;
  live_target?: RoomLiveTarget | null;
  input_parts?: readonly unknown[];
  discussion_id?: string | null;
  focus_refs?: readonly unknown[] | null;
  routing_mode?: "direct" | "agent_coordination";
  recipient_segments?: ReadonlyArray<{ recipient_agent_ids: readonly string[] }> | null;
  coordination_target_agent_ids?: readonly string[] | null;
}

export interface RoomLiveInputReceipt {
  run_id: string;
  message_id: string;
  binding_id: string | null;
  delivery_state: "pending" | "deferred";
}

/**
 * The one Agent the message's route reaches, when the message carries only
 * text a running turn can take. Attachments, task focus, a discussion, an
 * arrangement with other Agents or several recipients keep their ordinary
 * meaning, so they are never live input.
 */
export function liveInputRecipient(input: LiveRouteInput, managerAgentId: string | null): string | null {
  if (!input.live_target || !input.content.trim()) return null;
  if (input.input_parts?.length || input.discussion_id || input.focus_refs?.length) return null;
  if (input.routing_mode === "agent_coordination") return input.coordination_target_agent_ids?.length ? null : managerAgentId;
  const segments = input.recipient_segments ?? [];
  if (segments.length === 0) return managerAgentId;
  if (segments.length !== 1) return null;
  const agents = [...new Set(segments[0]!.recipient_agent_ids)];
  return agents.length === 1 ? agents[0]! : null;
}

/**
 * The Agent's active Runs in this conversation — its own turns and the ones
 * Rainver delegated to it — that this person may steer and that can take text:
 * a running turn whose live channel accepts input here, or a turn parked on
 * `agent.wait_for_results` whose resume will carry it.
 */
export async function roomLiveInputCandidates(db: Queryable, identity: SpaceUserIdentity, roomId: string, sessionId: string, agentId: string): Promise<RoomLiveInputCandidate[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT run.id FROM runs run
       JOIN agent_run_groups grp ON grp.id = run.run_group_id AND grp.space_id = run.space_id
      WHERE run.space_id = $1 AND grp.room_id = $2 AND run.session_id = $3 AND run.agent_id = $4
        AND run.execution_kind = 'agent' AND run.status IN ('running', 'waiting_for_dependency')
      ORDER BY run.created_at, run.id
      LIMIT 20`,
    [identity.spaceId, roomId, sessionId, agentId]);
  const runs = new PgRunRepository(db);
  const candidates: RoomLiveInputCandidate[] = [];
  for (const row of rows.rows) {
    const run = await authorizeRunCommand(runs, identity, row.id, "steer").catch(() => null);
    if (!run?.session_id || !run.agent_id) continue;
    const base = { run_id: run.id, agent_id: run.agent_id, agent_name: run.agent_name ?? null,
      delegated: Boolean(run.delegation_id), started_at: run.started_at ? new Date(run.started_at).toISOString() : null };
    const channel = run.status === "running" ? liveInputChannel(run.id) : undefined;
    if (channel?.available()) candidates.push({ ...base, status: "running", delivery: "live" });
    else if (waitAcceptsPersonInput(run)) candidates.push({ ...base, status: "waiting_for_dependency", delivery: "with_results" });
  }
  return candidates;
}

/** The person's explicit choice of a Run that cannot take this message now; nothing is recorded or sent. */
export function liveTargetUnavailable(candidates: readonly RoomLiveInputCandidate[] = []): RoomMutationError {
  return new RoomMutationError(409, "The run you chose can no longer take this message; choose again or send it as an ordinary message", {
    code: ROOM_LIVE_INPUT_TARGET_UNAVAILABLE, candidates,
  });
}

/**
 * Records the message into the chosen Run, in the caller's transaction, or
 * returns null for an ordinary send. Several candidates are never guessed
 * between: the person is asked to choose (a 409 naming them). A Run the
 * person chose explicitly is never replaced: if it is no longer a candidate,
 * or its channel refuses, the send is refused (`live_input_target_unavailable`,
 * naming the Runs that still can) and nothing falls to another Run or to an
 * ordinary send. Only for `auto` does a refusal from the live channel itself
 * (`LiveInputRefusal`) mean an ordinary send; the caller rolls back to its savepoint.
 */
export async function recordRoomLiveInput(db: Queryable, config: ServerConfig, identity: SpaceUserIdentity, input: {
  roomId: string; sessionId: string; agentId: string; target: RoomLiveTarget; content: string;
}): Promise<RoomLiveInputReceipt | null> {
  const candidates = await roomLiveInputCandidates(db, identity, input.roomId, input.sessionId, input.agentId);
  const target = input.target;
  const explicit = typeof target === "object";
  const chosen = explicit
    ? candidates.find(candidate => candidate.run_id === target.run_id)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!chosen) {
    if (explicit) throw liveTargetUnavailable(candidates);
    if (candidates.length === 0) return null;
    throw new RoomMutationError(409, "This message can go to more than one active run; choose one or send it as an ordinary message", {
      code: ROOM_LIVE_INPUT_CHOICE_REQUIRED, candidates,
    });
  }
  if (chosen.delivery === "with_results") {
    const out = await recordDeferredRunLiveInput(db, config, identity, chosen.run_id, input.content);
    return { run_id: chosen.run_id, message_id: out.message_id, binding_id: null, delivery_state: "deferred" };
  }
  const bindingId = liveInputChannel(chosen.run_id)?.delivery.id;
  if (!bindingId) {
    if (explicit) throw liveTargetUnavailable(candidates.filter(candidate => candidate.run_id !== chosen.run_id));
    return null;
  }
  const out = await recordRunLiveInput(db, config, identity, chosen.run_id, bindingId, input.content);
  return { run_id: chosen.run_id, message_id: out.message_id, binding_id: bindingId, delivery_state: "pending" };
}

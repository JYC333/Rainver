import { randomUUID } from "node:crypto";
import type { InvocationDelivery } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Pool } from "../../db/pool.js";
import { resolveUserActorId } from "../../db/actorResolver.js";
import { HttpError, withDbTransaction, type SpaceUserIdentity } from "../routeUtils/common.js";
import { PgSessionRepository } from "../sessions/repository.js";
import { createProductionRuntimeContextInvocationGateway, InvocationSnapshotService } from "../runtimeContext/index.js";
import { PgRunRepository } from "./repository.js";
import { authorizeRunCommand } from "./runCommandAuthority.js";
import { acpRuntimeContextPromptBlocks } from "./acpRuntimeContextPrompt.js";
import { liveInputChannel } from "./liveInput.js";
import { promptInputLimitFailure } from "./promptInputLimit.js";
import { getRuntimeAdapterSpec } from "../runtimeAdapters/specs.js";

export async function submitRunLiveInput(db: Pool, config: ServerConfig, identity: SpaceUserIdentity, runId: string, bindingId: string, content: string) {
  const run = await authorizeRunCommand(new PgRunRepository(db, config), identity, runId, "steer");
  const channel = liveInputChannel(runId);
  if (run.status !== "running" || !run.session_id || !channel?.available() || channel.delivery.id !== bindingId) {
    throw new HttpError(409, "This Run is no longer accepting additional input; send a new message instead");
  }
  return channel.during(async () => {
    const actorId = await resolveUserActorId(db, identity.spaceId, identity.userId);
    const snapshots = new InvocationSnapshotService(db);
    const snapshot = await snapshots.getSafe(identity.spaceId, channel.delivery.audit_refs.invocation_snapshot_id);
    if (!snapshot?.work_context_scope_id || !snapshot.setup_ref?.version) throw new HttpError(409, "Run has no live Runtime Context authority");
    const message = await withDbTransaction(db, async tx => {
      const current = await authorizeRunCommand(new PgRunRepository(tx, config), identity, runId, "steer");
      if (current.status !== "running" || !channel.available()) throw new HttpError(409, "Run has already ended");
      const sessions = new PgSessionRepository(tx);
      const room = await sessions.getRoomConversation(identity.spaceId, identity.userId, run.session_id!);
      const input = { content, run_id: runId };
      const saved = room?.room_id
        ? await sessions.addRoomUserMessage(identity.spaceId, identity.userId, room.room_id, run.session_id!, input)
        : await sessions.addMessage(identity.spaceId, identity.userId, run.session_id!, { ...input, role: "user" });
      if (!saved) throw new HttpError(404, "Conversation not found");
      await new PgRunRepository(tx, config).appendRunEvent({ run_id: runId, space_id: identity.spaceId,
        actor_id: actorId, event_type: "action_invoked", status: "pending", summary: "Additional input awaiting Runtime Context authorization",
        metadata_json: { action_name: "run.live_input", message_id: saved.id, binding_id: bindingId } });
      return saved;
    });
    const gateway = createProductionRuntimeContextInvocationGateway(db, config);
    let delivery: InvocationDelivery;
    try {
      delivery = await gateway.prepareInvocation({
        identity, invocationId: runId, executionControlSnapshotId: channel.delivery.audit_refs.execution_control_snapshot_id,
        runtimeKey: run.runtime_key!, providerId: channel.delivery.provider_id, model: channel.delivery.model,
        usageSourceId: `runtime-context:${runId}:steer:${randomUUID()}`,
        runtimeSessionBindingRef: snapshot.runtime_session_binding_ref,
        turn: { work_context_scope_id: snapshot.work_context_scope_id, expected_setup_version: Number(snapshot.setup_ref.version),
          current_message_ref: { type: "message", id: message.id }, one_off_refs: [], invocation_purpose: "agent_task", retrieval_intent: null },
      });
    } catch (error) {
      await new PgRunRepository(db, config).appendRunEvent({ run_id: runId, space_id: identity.spaceId,
        actor_id: actorId, event_type: "action_completed", status: "warning", summary: "Additional input was not authorized for delivery",
        metadata_json: { action_name: "run.live_input", message_id: message.id, binding_id: bindingId, state: "not_injected" } });
      if (error instanceof HttpError && (error.statusCode === 403 || error.statusCode === 404)) throw error;
      if (error instanceof HttpError) throw new HttpError(error.statusCode, error.message, { detail: error.message, message_id: message.id, state: "not_injected" });
      throw error;
    }
    let state: "injected" | "not_injected" | "unconfirmed" = "not_injected";
    channel.onClose(() => gateway.finalizeInvocation({ spaceId: identity.spaceId, invocationId: runId, deliveryId: delivery.id,
      errorCode: state === "injected" ? null : `runtime_input_${state}` }).then(() => undefined));
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
    await gateway.acknowledgeDelivery({ spaceId: identity.spaceId, deliveryId: delivery.id,
      status: state === "injected" ? "accepted" : state === "unconfirmed" ? "failed" : "rejected",
      adapterReceiptRef: { type: "runtime_live_input", id: bindingId },
      errorCode: state === "injected" ? null : `runtime_input_${state}` });
    await new PgRunRepository(db, config).appendRunEvent({ run_id: runId, space_id: identity.spaceId,
      event_type: "action_completed", status: state === "injected" ? "succeeded" : "warning", actor_id: actorId,
      summary: state === "injected" ? "Additional input delivered to the running turn" : "Additional input was not confirmed delivered",
      metadata_json: { action_name: "run.live_input", message_id: message.id, delivery_id: delivery.id, binding_id: bindingId, state } });
    return { state, message_id: message.id, delivery_id: delivery.id };
  });
}

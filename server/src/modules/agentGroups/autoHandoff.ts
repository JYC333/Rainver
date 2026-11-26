import { objectValue, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { PgRunRepository, type RunRecord } from "../runs/repository.js";
import { PgHostThreadRepository, type HostThread } from "../hosts/threadRepository.js";
import { PgJobQueueRepository } from "../jobs/repository.js";
import { isHardTerminalRunStatus } from "../runs/orchestrationResults.js";
import { modelSpec } from "../providers/modelSpecs.js";
import { estimateModelTokens } from "../usage/modelCatalog.js";
import { roomAudience } from "../rooms/threadReferences.js";
import { runReadSql } from "../access/contentAccessSql.js";
import { renderRoomStandingContext } from "./roomStandingContext.js";
import {
  HANDOFF_TOOL_ALLOWANCE, handoffArtifactIdForRun, handoffPromptBlock, loadHandoffText,
  renderHandoffPrompt,
} from "./sessionHandoff.js";

export const AUTOMATIC_HANDOFF_WAIT_SCOPE = "automatic_model_handoff";

export function pendingAutomaticSummaryId(run: RunRecord): string | null {
  const wait = objectValue(objectValue(run.output_json).waiting_for_results);
  if (wait.scope !== AUTOMATIC_HANDOFF_WAIT_SCOPE || !Array.isArray(wait.depends_on_run_ids) || wait.depends_on_run_ids.length !== 1) return null;
  const id = wait.depends_on_run_ids[0];
  return typeof id === "string" ? id : null;
}

export async function prepareAutomaticHandoff(
  db: Queryable,
  thread: HostThread,
  targetModel: string,
  audience: readonly string[],
  unstartedRunId?: string,
): Promise<{ source_model: string; source_run_id: string; budget_tokens: number; context_tokens: number } | null> {
  const target = modelSpec(targetModel);
  if (!target || thread.status !== "active" || !thread.last_run_id || !thread.vendor_session_id
    || thread.context_tokens === null || thread.context_window_tokens === null
    || thread.context_tokens <= Math.min(4096, thread.context_window_tokens / 4)
    || thread.context_tokens > Math.min(65_536, thread.context_window_tokens / 2)) return null;
  const latest = (await db.query<{ source_model: string | null; is_mainline: boolean }>(
    `SELECT run.model_override_json->>'runtime_reported_model' AS source_model, room.is_mainline
       FROM runs run JOIN sessions session ON session.id = run.session_id AND session.space_id = run.space_id
       JOIN rooms room ON room.id = session.room_id AND room.space_id = session.space_id
      WHERE run.space_id = $1 AND run.id = $2 AND run.status = 'succeeded' AND run.host_task_thread_id = $4
        AND NOT EXISTS (
          SELECT 1 FROM runs history CROSS JOIN unnest($3::text[]) reader(user_id)
           WHERE history.space_id = run.space_id AND history.host_task_thread_id = $4
             AND history.id IS DISTINCT FROM $5
             AND NOT COALESCE((${runReadSql("reader.user_id", "history", { includeOversight: false })}), false)
        )`,
    [thread.space_id, thread.last_run_id, audience, thread.id, unstartedRunId ?? null],
  )).rows[0];
  const model = latest?.source_model;
  if (!model || latest.is_mainline || !/^claude-(?:opus|sonnet|haiku|fable|mythos)-\d{1,2}-\d{1,2}$/.test(model)
    || !/^claude-(?:opus|sonnet|haiku|fable|mythos)-\d{1,2}-\d{1,2}$/.test(targetModel)
    || model === targetModel || !modelSpec(model)) return null;
  const budget = Math.min(4096, Math.floor(
    (target.contextWindowTokens - target.defaultOutputReserveTokens - target.providerOverheadTokens) / 4,
  ));
  return { source_model: model, source_run_id: thread.last_run_id, budget_tokens: budget, context_tokens: thread.context_tokens };
}

/** Atomically replace the first dispatch with a tool-limited summary Run. */
export async function enqueueAutomaticHandoff(
  db: Queryable,
  original: RunRecord,
  userId: string,
  audience: readonly string[],
  runtimeProfileId: string | null | undefined,
  jobPayload: Record<string, unknown>,
): Promise<boolean> {
  const override = objectValue(original.model_override_json);
  const host = objectValue(override.host_thread);
  const plan = objectValue(host.automatic_handoff);
  if (!original.agent_id || typeof host.thread_id !== "string" || !original.session_id || !runtimeProfileId
    || typeof host.runtime_session_id !== "string" || typeof plan.source_model !== "string"
    || typeof plan.budget_tokens !== "number" || typeof plan.context_tokens !== "number"
    || estimateModelTokens(original.prompt ?? "") > plan.budget_tokens) return false;
  const roomId = objectValue(override.chat_turn).room_id;
  if (typeof roomId !== "string") return false;
  const standing = await renderRoomStandingContext(db, { spaceId: original.space_id, roomId, sessionId: original.session_id, agentId: original.agent_id });
  const seedOverhead = estimateModelTokens([standing.text, handoffPromptBlock(""), original.prompt].join("\n\n"));
  if (seedOverhead > plan.budget_tokens) return false;
  const summaryPrompt = await renderHandoffPrompt(db, {
    spaceId: original.space_id, userId, agentId: original.agent_id, budgetTokens: plan.budget_tokens,
  });
  if (!summaryPrompt) return false;
  const sourceModel = { id: "model", type: "select", category: "model", value: plan.source_model };
  const runs = new PgRunRepository(db);
  const summary = await runs.createQueuedRun({
    execution_kind: "agent", mode: "live", run_type: "agent",
    trigger_origin: original.trigger_origin === "delegation" ? "continuation" : original.trigger_origin,
    agent_id: original.agent_id, space_id: original.space_id, user_id: userId,
    session_id: original.session_id, project_id: original.project_id,
    project_folder_id: original.project_folder_id, workspace_location_id: original.workspace_location_id,
    host_task_thread_id: host.thread_id, runtime_profile_id: runtimeProfileId,
    runtime_profile_selection_source: "explicit", allow_system_assistant: true,
    visibility: "selected_users", grantee_user_ids: [...audience],
    prompt: summaryPrompt, capabilities_json: [...HANDOFF_TOOL_ALLOWANCE], scenario_tool_allowance: HANDOFF_TOOL_ALLOWANCE,
    contract_snapshot: { source: { kind: "direct", id: null }, workspace_access: "read", max_attempts: 1 },
    model_override_json: {
      workspace: override.workspace,
      host_thread: { ...host, automatic_handoff: null, identity_sent: false, standing_sent: false },
      acp_session_config: [sourceModel],
      chat_turn: { kind: "handoff" },
      handoff: { thread_id: host.thread_id, context_tokens: plan.context_tokens, budget_tokens: plan.budget_tokens },
      automatic_handoff_for: original.id,
    },
  });
  const moved = await db.query(
    `UPDATE host_threads SET dispatch_lock_id = $2, last_run_id = $2, updated_at = now()
      WHERE id = $1 AND dispatch_lock_id = $3 AND vendor_session_id = $4`,
    [host.thread_id, summary.id, original.id, host.runtime_session_id],
  );
  if (moved.rowCount !== 1) throw new Error("Automatic summary lost its source session claim");
  const parked = await db.query(
    `UPDATE runs SET status = 'waiting_for_dependency',
        output_json = jsonb_build_object('waiting_for_results', $3::jsonb), updated_at = now()
      WHERE space_id = $1 AND id = $2 AND status = 'queued'`,
    [original.space_id, original.id, JSON.stringify({
      status: "waiting", scope: AUTOMATIC_HANDOFF_WAIT_SCOPE, depends_on_run_ids: [summary.id], job: jobPayload,
    })],
  );
  if (parked.rowCount !== 1) throw new Error("Cannot park the original Room request");
  await new PgJobQueueRepository(db).enqueue({
    job_type: "agent_run", space_id: original.space_id, user_id: userId,
    agent_id: original.agent_id, project_folder_id: original.project_folder_id, payload: { run_id: summary.id },
  });
  return true;
}

/** Called only after the delegated child passes the existing quota and turn gates. */
export async function enqueueDelegatedAutomaticHandoff(
  db: Queryable, spaceId: string, runId: string, jobPayload: Record<string, unknown>,
): Promise<boolean> {
  const original = (await db.query<RunRecord>(
    `SELECT * FROM runs WHERE space_id = $1 AND id = $2 AND status = 'queued' AND delegation_id IS NOT NULL
       AND model_override_json->'host_thread'->'automatic_handoff' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM run_attempts WHERE space_id = $1 AND run_id = $2
         AND (attempt_number <> 1 OR status <> 'queued' OR started_at IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM jobs WHERE space_id = $1 AND job_type = 'agent_run' AND payload_json->>'run_id' = $2)
       FOR NO KEY UPDATE`, [spaceId, runId],
  )).rows[0];
  if (!original?.host_task_thread_id) return false;
  const override = objectValue(original.model_override_json);
  const host = objectValue(override.host_thread);
  const plan = objectValue(host.automatic_handoff);
  const backend = objectValue(override.conversation_backend);
  const target = Array.isArray(override.acp_session_config)
    ? override.acp_session_config.map(objectValue).find(option => option.category === "model")?.value : null;
  const actor = original.instructed_by_user_id ?? original.owner_user_id;
  if (!actor || typeof target !== "string" || typeof plan.source_run_id !== "string"
    || typeof backend.runtime_profile_id !== "string") return false;
  const thread = await new PgHostThreadRepository(db).getById(original.host_task_thread_id);
  if (thread?.dispatch_lock_id !== runId || thread.last_run_id !== runId
    || thread.vendor_session_id !== host.runtime_session_id) return false;
  const room = (await db.query<{ id: string; project_id: string; is_mainline: boolean }>(
    `SELECT room.id, room.project_id, room.is_mainline
       FROM sessions session JOIN rooms room ON room.id = session.room_id AND room.space_id = session.space_id
      WHERE session.space_id = $1 AND session.id = $2 AND room.status = 'active'`,
    [spaceId, original.session_id],
  )).rows[0];
  if (!room) return false;
  const audience = await roomAudience(db, spaceId, room);
  if (!audience.includes(actor)) return false;
  const livePlan = await prepareAutomaticHandoff(db, { ...thread, last_run_id: plan.source_run_id }, target, audience, runId);
  if (!livePlan || livePlan.source_model !== plan.source_model || livePlan.context_tokens !== plan.context_tokens) return false;
  return enqueueAutomaticHandoff(db, original, actor, audience, backend.runtime_profile_id, jobPayload);
}

/** Durable settlement owns both adoption and enqueue. Replaying it observes the already advanced original Run. */
export async function settleAutomaticHandoff(db: Queryable, summary: RunRecord): Promise<RunRecord | null | undefined> {
  const override = objectValue(summary.model_override_json);
  const originalId = override.automatic_handoff_for;
  if (typeof originalId !== "string" || !isHardTerminalRunStatus(summary.status) || !summary.host_task_thread_id) return;
  return withQueryableTransaction(db, async tx => {
    const group = (await tx.query<{ status: string }>(
      `SELECT task_group.status FROM agent_run_groups task_group
        JOIN runs original ON original.run_group_id = task_group.id AND original.space_id = task_group.space_id
        WHERE original.space_id = $1 AND original.id = $2 FOR UPDATE OF task_group`,
      [summary.space_id, originalId],
    )).rows[0];
    const original = (await tx.query<RunRecord>(
      "SELECT * FROM runs WHERE space_id = $1 AND id = $2 FOR UPDATE",
      [summary.space_id, originalId],
    )).rows[0];
    const output = objectValue(original?.output_json);
    if (original && isHardTerminalRunStatus(original.status) && output.automatic_handoff_ended_by === summary.id) return original;
    const wait = objectValue(output.waiting_for_results);
    if (!original || pendingAutomaticSummaryId(original) !== summary.id
      || (original.status !== "waiting_for_dependency" && original.status !== "cancelling")) return;
    if (original.status === "cancelling") {
      if (await new PgHostThreadRepository(tx).holdsDispatchClaim(summary.host_task_thread_id!, summary.id)) {
        throw new Error("Summary thread settlement is still owed");
      }
      return new PgRunRepository(tx).markRunTerminal({
        space_id: original.space_id, run_id: original.id, status: "cancelled", completed_at: new Date().toISOString(),
        output_json: { automatic_handoff_ended_by: summary.id },
      });
    }
    if (group?.status === "paused") throw new Error("Automatic model handoff waits for its Room task to resume");
    if (group?.status !== "active") {
      return new PgRunRepository(tx).markRunTerminal({
        space_id: original.space_id, run_id: original.id, status: "cancelled", completed_at: new Date().toISOString(),
        output_json: { automatic_handoff_ended_by: summary.id },
      });
    }
    const threads = new PgHostThreadRepository(tx);
    if (await threads.holdsDispatchClaim(summary.host_task_thread_id!, summary.id)) {
      throw new Error("Summary thread settlement is still owed");
    }
    const thread = await threads.getById(summary.host_task_thread_id!);
    const room = (await tx.query<{ id: string; project_id: string; is_mainline: boolean }>(
      `SELECT room.id, room.project_id, room.is_mainline
         FROM sessions session JOIN rooms room ON room.id = session.room_id AND room.space_id = session.space_id
        WHERE session.space_id = $1 AND session.id = $2 AND room.status = 'active'`,
      [summary.space_id, summary.session_id],
    )).rows[0];
    const actor = original.instructed_by_user_id ?? original.owner_user_id ?? null;
    const originalOverride = objectValue(original.model_override_json);
    const host = objectValue(originalOverride.host_thread);
    const plan = objectValue(host.automatic_handoff);
    const artifact = summary.status === "succeeded" ? await handoffArtifactIdForRun(tx, summary) : null;
    const audience = room && actor ? await roomAudience(tx, summary.space_id, room) : [];
    const text = artifact && actor && audience.includes(actor)
      ? await loadHandoffText(tx, summary.space_id, artifact, audience) : null;
    const standing = text && room && original.agent_id ? await renderRoomStandingContext(tx, {
      spaceId: original.space_id, roomId: room.id, sessionId: summary.session_id ?? null, agentId: original.agent_id,
    }) : null;
    const prompt = text ? [standing?.text, handoffPromptBlock(text), original.prompt].filter(Boolean).join("\n\n") : null;
    const runs = new PgRunRepository(tx);
    const now = new Date().toISOString();
    if (!artifact || !prompt || typeof plan.budget_tokens !== "number"
      || estimateModelTokens(prompt) > 2 * plan.budget_tokens
      || thread?.last_run_id !== summary.id || thread?.vendor_session_id !== host.runtime_session_id
      || !thread?.vendor_session_id
      || !await threads.stageHandoff(thread.id, artifact, thread.vendor_session_id, null, original.id)) {
      return runs.markRunTerminal({
        space_id: original.space_id, run_id: original.id, status: "failed", completed_at: now,
        output_json: { automatic_handoff_ended_by: summary.id },
        error_json: { error_code: "model_handoff_unavailable", error_text: "Model not switched. The original session and request are preserved." },
      });
    }
    if (!await threads.claimConversationDispatch(thread.id, original.id)) throw new Error("Cannot claim the staged replacement");
    await threads.recordConversationDispatch(thread.id, {
      dispatchLockId: original.id, lastRunId: original.id, sessionId: original.session_id!,
    });
    const queued = await runs.requeueWaitingDependencyRun({
      space_id: original.space_id, run_id: original.id, prompt, resumed_at: now,
      model_override_json: {
        ...originalOverride,
        host_thread: {
          ...host, automatic_handoff: null, runtime_session_id: null, fresh: true, handoff_candidate: artifact,
          identity_digest: standing?.digest ?? null, identity_sent: Boolean(standing),
        },
      },
    });
    if (!queued) throw new Error("Cannot resume the staged Room request");
    const jobs = new PgJobQueueRepository(tx);
    await jobs.supersedeAgentRunJobs(original.space_id, original.id);
    await jobs.ensureAgentRunJob({
      job_type: "agent_run", space_id: original.space_id, user_id: actor,
      agent_id: original.agent_id, project_folder_id: original.project_folder_id ?? null, payload: objectValue(wait.job),
    });
  });
}

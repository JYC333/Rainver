import { AgentCancelRunInputSchema, AgentListRunsInputSchema, type CanonicalToolCall } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import type { Pool } from "../../db/pool.js";
import { HttpError } from "../routeUtils/common.js";
import type { SystemActionDispatchResult } from "../systemActions/toolResult.js";
import { PgRunRepository, type AgentRunRecord } from "./repository.js";
import { authorizeRunCommand } from "./runCommandAuthority.js";
import { readDelegationScheduling } from "../agentGroups/delegationScheduling.js";

/** Room commands deliberately cross user turns, never conversations or people. */
export class RoomRunControl {
  constructor(private readonly config: ServerConfig, private readonly pool: () => Pool) {}

  async dispatch(call: CanonicalToolCall, caller: AgentRunRecord): Promise<SystemActionDispatchResult> {
    try {
      const input: unknown = JSON.parse(call.arguments_json);
      const cancel = call.name === "agent.cancel_run" ? AgentCancelRunInputSchema.parse(input) : null;
      if (!cancel) AgentListRunsInputSchema.parse(input);
      if (!caller.run_group_id || !caller.instructed_by_user_id) throw new HttpError(403, "Room run control requires a person-instructed Room run");
      const identity = { spaceId: caller.space_id, userId: caller.instructed_by_user_id };
      const repository = new PgRunRepository(this.pool());
      await authorizeRunCommand(repository, identity, caller.id, "stop");
      // Room task groups can differ between messages. Match the durable Room
      // conversation, not the latest root, and retain the instructing person.
      const candidates = await this.pool().query<{ id: string }>(
        `SELECT r.id FROM runs r
           JOIN agent_run_groups target ON target.id=r.run_group_id AND target.space_id=r.space_id
           JOIN agent_run_groups current_group ON current_group.id=$2 AND current_group.space_id=r.space_id
          WHERE r.space_id=$1 AND r.instructed_by_user_id=$3 AND r.id<>$4
            AND (target.id=current_group.id OR
              (current_group.room_id IS NOT NULL AND target.room_id=current_group.room_id
               AND target.session_id=current_group.session_id))
            AND ($5::varchar IS NOT NULL OR r.status IN ('queued','running','cancelling','waiting_for_review','waiting_for_dependency'))
            AND ($5::varchar IS NULL OR r.id=$5)
          ORDER BY r.created_at DESC, r.id DESC LIMIT 100`,
        [caller.space_id, caller.run_group_id, identity.userId, caller.id, cancel?.run_id ?? null],
      );
      if (cancel) {
        if (!candidates.rows.length) throw new HttpError(404, "Run not found in this Room conversation");
        await authorizeRunCommand(repository, identity, cancel.run_id, "stop");
        // Lazy import avoids the dispatcher/orchestrator import cycle. Use the
        // fully wired canonical stop, including process termination/finalizers.
        const { buildRunOrchestration } = await import("./orchestrationFactory.js");
        const result = await buildRunOrchestration(this.config).orchestration.cancelRun({
          run_id: cancel.run_id, space_id: caller.space_id,
          requested_by_user_id: identity.userId, reason: cancel.reason,
        });
        return { modelResult: { ok: result.status === "cancelled", ...result }, summary: { tool_name: call.name, run_id: cancel.run_id, status: result.status } };
      }
      const runs = [];
      for (const { id } of candidates.rows) {
        const run = await repository.getVisibleRun(caller.space_id, identity.userId, id);
        if (run) runs.push({ run_id: run.id, agent_id: run.agent_id, status: run.status, created_at: run.created_at,
          parent_run_id: run.parent_run_id, root_run_id: run.root_run_id,
          scheduling: await readDelegationScheduling(this.pool(), run) });
      }
      return { modelResult: { ok: true, runs, limit: 100 }, summary: { tool_name: call.name, count: runs.length } };
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof SyntaxError) && !(error instanceof Error && error.name === "ZodError")) throw error;
      return { modelResult: { ok: false, error: error.message }, summary: { tool_name: call.name, ok: false } };
    }
  }
}

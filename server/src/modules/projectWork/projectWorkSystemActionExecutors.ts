import type { SystemActionId, WorkLoopStageKey } from "@rainver/protocol";
import type { ServerConfig } from "../../config.js";
import { getDbPool } from "../../db/pool.js";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { resolveAgentActorId } from "../../db/actorResolver.js";
import type { SystemActionExecutor } from "../systemActions/gateway.js";
import type { RunRecord } from "../runs/repository.js";
import { PgTaskRepository } from "../tasks/repository.js";
import { PgRunRepository } from "../runs/repository.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access.js";
import {
  advanceTaskStage,
  handoffTask,
  linkTaskEntities,
  reportOnTask,
  requestTaskReview,
  type AgentActionContext,
} from "./taskActions.js";

/**
 * The Project write surface, as System Actions.
 *
 * The gate for the two structural writes is not here: `decisionCore.ts` decides
 * by trigger origin, so the same definition serves a person asking in a
 * conversation and an unattended wake-up, and only the second needs approval.
 * Putting that distinction in two action definitions would have meant two
 * schemas, two executors, and two places to forget one of them.
 */
/** Enough for an Agent to find the Task meant without flooding the turn. */
const MAX_LISTED_TASKS = 50;

export function registerProjectWorkSystemActionExecutors(
  executors: Map<SystemActionId, SystemActionExecutor>,
  config: ServerConfig,
  run: RunRecord,
): void {
  const pool = getDbPool(config.databaseUrl!);
  const identity = { spaceId: run.space_id, userId: run.instructed_by_user_id! };

  /**
   * Scoped to one physical attempt of one Run.
   *
   * The tool-call id is a per-connection JSON-RPC counter, and the event table
   * dedupes on `(space_id, idempotency_key)` — so the id alone collides across
   * every Run in the Space, and the Run id alone still collides across a
   * Supervisor retry, which re-executes the *same* run id in a fresh process
   * whose counter restarts at 1. Without the attempt, attempt 2's first call
   * resolves to attempt 1's event: the row is written and the event is
   * swallowed, which is the divergence the single writer exists to prevent.
   */
  async function contextFor(db: Queryable, idempotencyKey: string | null): Promise<AgentActionContext> {
    if (!run.agent_id) throw new HttpError(422, "This action requires an Agent identity");
    const attempt = await new PgRunRepository(db).getLatestRunAttempt(run.space_id, run.id);
    return {
      spaceId: run.space_id,
      actorId: await resolveAgentActorId(db, run.space_id, run.agent_id),
      agentId: run.agent_id,
      runId: run.id,
      instructedByUserId: run.instructed_by_user_id!,
      idempotencyKey: `${run.id}:${attempt?.attempt_number ?? 1}:${idempotencyKey ?? "run"}`,
    };
  }

  executors.set("task.create" as SystemActionId, async (input, dispatch) => {
    const body = input as {
      project_id?: string; title: string; description?: string | null;
      acceptance_criteria_json?: Record<string, unknown> | null;
      definition_of_done?: string | null; required_outputs?: string[];
      priority?: string; risk_level?: string;
      links?: { entity_type: string; entity_id: string; role: string }[];
    };
    // The Project is the Run's own, not the model's. A `project_id` taken from
    // the input lets an Agent write into a Project the person it acts for is
    // not a member of, and every other Project-scoped agent action refuses to
    // take one for exactly that reason.
    if (!run.project_id) {
      throw new HttpError(422, "This Run is not scoped to a Project, so it cannot create Tasks");
    }
    if (body.project_id && body.project_id !== run.project_id) {
      throw new HttpError(422, "A Task can only be created in this Run's own Project");
    }
    const projectId = run.project_id;

    const task = await withQueryableTransaction(pool, async (tx) => {
      const context = await contextFor(tx, dispatch.idempotency_key ?? null);
      // Authority is re-checked while holding the Project aggregate lock, the
      // same pairing the durable Task+Run write uses: an archived Project or a
      // membership revoked mid-turn must lose, deterministically.
      await lockActiveProjectForMutation(tx, run.space_id, projectId);
      await assertProjectWriterForMutation(tx, run.space_id, projectId, identity.userId);
      // The Task is created under the person who asked — they own it and it
      // inherits their access — but `task.created` is attributed to the Agent,
      // because the Agent is what made it. The timeline is the record of who
      // did what, and a Task the Agent decomposed out of a request did not
      // appear because the person typed it.
      const created = await new PgTaskRepository(pool).createTask(
        identity,
        {
          project_id: projectId,
          title: body.title,
          description: body.description ?? null,
          acceptance_criteria_json: body.acceptance_criteria_json ?? null,
          definition_of_done: body.definition_of_done ?? null,
          required_outputs_json: body.required_outputs ?? null,
          priority: body.priority,
          risk_level: body.risk_level,
          visibility: "space_shared",
        },
        tx,
        context.actorId,
      );
      if (body.links?.length) await linkTaskEntities(tx, context, created.id, body.links);
      return created;
    });
    return {
      modelResult: { ok: true, task_id: task.id, title: task.title, status: task.status },
      summary: { tool_name: "task.create", ok: true, task_id: task.id },
    };
  });

  /** This Project's Tasks as an Agent may address them: id first. */
  const listProjectTasks = async (status?: string): Promise<Array<{ task_id: string; title: string; status: string }>> => {
    const page = await new PgTaskRepository(pool).listTasks(identity, {
      boardId: null, projectFolderId: null, projectId: run.project_id!, status: status ?? null,
      assignedToMe: false, q: null, limit: MAX_LISTED_TASKS, offset: 0,
    });
    return (page.items as Array<{ id: string; title: string; status: string }>)
      .map((task) => ({ task_id: task.id, title: task.title, status: task.status }));
  };

  /**
   * A task_id nothing matches is almost always a composed one, so the failure
   * answers with the ids that exist rather than a bare "Task not found".
   */
  const withTaskIdHelp = async <T>(taskId: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) throw error;
      const tasks = await listProjectTasks();
      throw new HttpError(404, tasks.length === 0
        ? `No Task in this Project has id '${taskId}', and this Project has no Task yet — create one with task.create.`
        : `No Task in this Project has id '${taskId}'. Use one of these ids exactly: ${tasks.map((task) => `${task.task_id} — ${task.title}`).join("; ")}`);
    }
  };

  executors.set("task.list" as SystemActionId, async (input) => {
    if (!run.project_id) throw new Error("task.list requires a project-scoped run");
    const tasks = await listProjectTasks((input as { status?: string }).status);
    return {
      modelResult: { ok: true, tool: "task.list", tasks },
      summary: { tool_name: "task.list", ok: true, count: tasks.length },
    };
  });

  executors.set("task.report" as SystemActionId, async (input, dispatch) => {
    const body = input as { task_id: string; summary: string; outcome?: string; refs?: { type: string; id: string }[] };
    const result = await withTaskIdHelp(body.task_id, () => withQueryableTransaction(pool, async (tx) =>
      reportOnTask(tx, await contextFor(tx, dispatch.idempotency_key ?? null), body)));
    return {
      modelResult: { ok: true, ...result },
      summary: { tool_name: "task.report", ok: true, task_id: result.task_id },
    };
  });

  executors.set("task.handoff" as SystemActionId, async (input, dispatch) => {
    const body = input as { task_id: string; to: { kind: "user" | "agent"; id: string } | null; note?: string | null };
    const result = await withTaskIdHelp(body.task_id, () => withQueryableTransaction(pool, async (tx) =>
      handoffTask(tx, await contextFor(tx, dispatch.idempotency_key ?? null), body)));
    return {
      modelResult: { ok: true, ...result, released: body.to === null },
      summary: { tool_name: "task.handoff", ok: true, task_id: result.task_id },
    };
  });

  executors.set("task.advance_stage" as SystemActionId, async (input, dispatch) => {
    const body = input as { task_id: string; to_stage: WorkLoopStageKey; reason: string };
    const result = await withTaskIdHelp(body.task_id, () => withQueryableTransaction(pool, async (tx) =>
      advanceTaskStage(tx, await contextFor(tx, dispatch.idempotency_key ?? null), body)));
    return {
      modelResult: { ok: true, ...result },
      summary: { tool_name: "task.advance_stage", ok: true, task_id: result.task_id, stage: result.stage },
    };
  });

  executors.set("task.request_review" as SystemActionId, async (input, dispatch) => {
    const body = input as { task_id: string; reason: string; options?: string[] };
    const result = await withTaskIdHelp(body.task_id, async () =>
      requestTaskReview(pool, await contextFor(pool, dispatch.idempotency_key ?? null), body));
    return {
      modelResult: { ok: true, ...result },
      summary: { tool_name: "task.request_review", ok: true, task_id: result.task_id },
    };
  });
}

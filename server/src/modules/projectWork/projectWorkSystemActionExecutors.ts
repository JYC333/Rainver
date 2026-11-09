import { getProjectBoard } from "./boardReadModel.js";
import { columnForTask, readProjectColumns } from "../tasks/boardColumns.js";
import { contentReadSql } from "../access/contentAccessSql.js";
import { z } from "zod";
import { effectiveRunTrigger } from "../systemActions/effectiveRunTrigger.js";
import { countTasksCreatedInTurn, lockTurnFanOutForTransaction, TASK_FAN_OUT_PER_TURN } from "../tasks/turnFanOut.js";
import { TASK_CREATE_BATCH_MAX_ITEMS, TaskCreateInputSchema, type SystemActionId } from "@rainver/protocol";
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
  linkTaskEntities,
  requireProjectTask,
  type AgentActionContext,
} from "./taskActions.js";
import { declareRunArtifact, type RunArtifactRole } from "./artifactDeclarations.js";

/**
 * The Project write surface, as System Actions.
 *
 * The gate for the two structural writes is not here: `decisionCore.ts` decides
 * by trigger origin, so the same definition serves a person asking in a
 * conversation and an unattended wake-up, and only the second needs approval.
 * Do not split that into two action definitions. That would be two schemas,
 * two executors, and two places to forget one of them.
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
   * whose counter restarts at 1. Do not omit the attempt. Attempt 2's first
   * call would resolve to attempt 1's event: the row is written and the event
   * is swallowed.
   */
  async function contextFor(db: Queryable, idempotencyKey: string | null): Promise<AgentActionContext> {
    if (!run.agent_id) throw new HttpError(422, "This action requires an Agent identity");
    if (!run.project_id) throw new HttpError(422, "This Run is not scoped to a Project, so it has no Tasks to act on");
    const attempt = await new PgRunRepository(db).getLatestRunAttempt(run.space_id, run.id);
    return {
      spaceId: run.space_id,
      actorId: await resolveAgentActorId(db, run.space_id, run.agent_id),
      agentId: run.agent_id,
      runId: run.id,
      instructedByUserId: run.instructed_by_user_id!,
      projectId: run.project_id,
      idempotencyKey: `${run.id}:${attempt?.attempt_number ?? 1}:${idempotencyKey ?? "run"}`,
    };
  }

  async function createTaskInTransaction(tx: Queryable, body: z.infer<typeof TaskCreateInputSchema>, key: string | null) {
    const projectId = run.project_id!;
    const context = await contextFor(tx, key);
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
        due_at: body.due_at ?? null,
        start_after: body.start_after ?? null,
        visibility: "space_shared",
        // The Run that made it, so what becomes of the Task — its merge
        // above all — can be told in the conversation it came from.
        source_run_id: run.id,
        links:body.links,
        board_column:body.board_column,
      },
      tx,
      context.actorId,
    );
    return created;
  }

  executors.set("task.create" as SystemActionId, async (input, dispatch) => {
    const body = input as z.infer<typeof TaskCreateInputSchema>;
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
      // Authority is re-checked while holding the Project aggregate lock, the
      // same pairing the durable Task+Run write uses: an archived Project or a
      // membership revoked mid-turn must lose, deterministically.
      await lockActiveProjectForMutation(tx, run.space_id, projectId);
      await assertProjectWriterForMutation(tx, run.space_id, projectId, identity.userId);
      // Counted under the turn's fan-out lock, the one the follow-up
      // reconciler holds too, so neither route sees room the other took.
      await lockTurnFanOutForTransaction(tx, run.id);
      if (await countTasksCreatedInTurn(tx, run.space_id, run.id) >= TASK_FAN_OUT_PER_TURN) {
        throw new HttpError(
          429,
          `This turn already created ${TASK_FAN_OUT_PER_TURN} Tasks. Continue in the next turn, or tell the user what is left to create.`,
        );
      }
      // The Task is created under the person who asked — they own it and it
      // inherits their access — but `task.created` is attributed to the Agent,
      // because the Agent is what made it. The timeline is the record of who
      // did what, and a Task the Agent decomposed out of a request did not
      // appear because the person typed it.
      return createTaskInTransaction(tx, body, dispatch.idempotency_key ?? null);
    });
    return {
      modelResult: { ok: true, task_id: task.id, title: task.title, status: task.status },
      summary: { tool_name: "task.create", ok: true, task_id: task.id },
    };
  });

  executors.set("task.create_batch" as SystemActionId, async (input, dispatch) => {
    const body = input as { request_summary: string; tasks: z.infer<typeof TaskCreateInputSchema>[] };
    if (!run.project_id) throw new HttpError(422, "A batch requires this Run's Project");
    const trigger = await effectiveRunTrigger(pool, run);
    if (trigger.origin !== "manual" || trigger.instructedByUserId !== identity.userId) {
      throw new HttpError(403, "Batch creation requires a verified user-requested turn");
    }
    if (!body.request_summary?.trim() || !body.tasks?.length || body.tasks.length > TASK_CREATE_BATCH_MAX_ITEMS) {
      throw new HttpError(422, "A requested batch must contain between 1 and 100 Tasks");
    }
    const tasks = body.tasks.map(item => TaskCreateInputSchema.parse(item));
    if (tasks.some(item => item.project_id && item.project_id !== run.project_id)) {
      throw new HttpError(422, "Every Task must belong to this Run's Project");
    }
    const results = await withQueryableTransaction(pool, async tx => {
      await lockActiveProjectForMutation(tx, run.space_id, run.project_id!);
      await assertProjectWriterForMutation(tx, run.space_id, run.project_id!, identity.userId);
      await lockTurnFanOutForTransaction(tx, run.id);
      const results: Array<{ task_id: string; title: string; status: string; created: boolean }> = [];
      for (const [index, item] of tasks.entries()) {
        // The Project lock serializes ordinary creates and other batches.
        // Retrying a call, or repeating a title within it, returns the existing
        // authorized Task rather than multiplying work.
        const existing = await tx.query<{ id: string; title: string; status: string }>(
          `SELECT t.id, t.title, t.status FROM tasks t WHERE t.space_id = $1 AND t.project_id = $2
            AND t.deleted_at IS NULL AND ${contentReadSql("task", "t", "$4")}
            AND lower(btrim(t.title)) = lower(btrim($3)) ORDER BY t.created_at, t.id LIMIT 1`,
          [run.space_id, run.project_id, item.title, identity.userId],
        );
        const found = existing.rows[0];
        if (found) {
          if(item.links?.length)await linkTaskEntities(tx,await contextFor(tx,`${dispatch.idempotency_key??"batch"}:${index}`),found.id,item.links);
          results.push({ task_id: found.id, title: found.title, status: found.status, created: false });
          continue;
        }
        const created = await createTaskInTransaction(tx, item, `${dispatch.idempotency_key ?? "batch"}:${index}`);
        results.push({ task_id: created.id, title: created.title, status: created.status, created: true });
      }
      return results;
    });
    const createdCount = results.filter(item => item.created).length;
    return {
      modelResult: { ok: true, created_count: createdCount, existing_count: results.length - createdCount, items: results },
      summary: { tool_name: "task.create_batch", ok: true, created_count: createdCount, existing_count: results.length - createdCount },
    };
  });

  /**
   * This Project's Tasks as an Agent may address them: id first, then the
   * state a recommendation is grounded in. An id-only read left "what should
   * I do next?" answerable only by restating titles.
   */
  const listProjectTasks = async (status?: string): Promise<Array<{
    task_id: string; title: string; status: string; column_key:string; priority: string | null;
    due_at: string | null; start_after: string | null; blocked_reason: string | null;
  }>> => {
    const page = await new PgTaskRepository(pool).listTasks(identity, {
      boardId: null, projectFolderId: null, projectId: run.project_id!, status: status ?? null,
      assignedToMe: false, q: null, limit: MAX_LISTED_TASKS, offset: 0,
    });
    const layout=await readProjectColumns(pool,identity.spaceId,run.project_id!);
    return (page.items as Array<{
      id: string; title: string; status: string; column_id?:string|null; priority?: string | null;
      due_at?: string | null; start_after?: string | null; blocked_reason?: string | null;
    }>).map((task) => ({
      task_id: task.id,
      title: task.title,
      status: task.status,
      column_key:columnForTask({status:task.status,column_id:task.column_id??null},layout.columns),
      priority: task.priority ?? null,
      due_at: task.due_at ?? null,
      start_after: task.start_after ?? null,
      blocked_reason: task.blocked_reason ?? null,
    }));
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

  executors.set("artifact.submit" as SystemActionId, async (input, dispatch) => {
    const body = input as {
      task_id: string; path: string; artifact_type: string;
      role?: RunArtifactRole; note?: string | null;
    };
    const declaration = await withTaskIdHelp(body.task_id, () => withQueryableTransaction(pool, async (tx) => {
      const context = await contextFor(tx, dispatch.idempotency_key ?? null);
      const task = await requireProjectTask(tx, run.space_id, body.task_id, identity.userId, context.projectId);
      return declareRunArtifact(tx, context, task, body);
    }));
    return {
      // The agent is told what the declaration will and will not do, because
      // "declared" and "collected" are different facts and only the second
      // closes a Task.
      modelResult: {
        ok: true,
        task_id: body.task_id,
        path: declaration.path,
        artifact_type: declaration.artifact_type,
        role: declaration.role,
        note: "Recorded. The file is collected from disk after this run finishes; leave it in place.",
      },
      summary: {
        tool_name: "artifact.submit",
        ok: true,
        task_id: body.task_id,
        artifact_type: declaration.artifact_type,
        artifact_role: declaration.role,
      },
    };
  });

  executors.set("board.read" as SystemActionId,async()=>{
    if(!run.project_id)throw new HttpError(422,"This Run requires a Project");
    const board=await getProjectBoard(pool,identity,run.project_id);
    return {modelResult:{ok:true,project:board.project,columns:board.columns,columns_revision:board.columns_revision},summary:{tool_name:"board.read",ok:true}};
  });

}

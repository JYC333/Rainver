import { randomUUID } from "node:crypto";
import type { WorkLoopStageKey } from "@rainver/protocol";
import { HttpError, withQueryableTransaction, type Queryable } from "../routeUtils/common.js";
import { entityDefinition, resolveContentAccessible, resolveContentResourceType } from "../ontology/entities.js";
import { assertSqlIdentifier, contentReadSql } from "../access/contentAccessSql.js";
import { assertProjectWriterForMutation } from "../projects/access.js";
import { appendProjectWorkEvent } from "./eventWriter.js";
import { recordStageChange } from "./loopState.js";

/**
 * What an Agent may do to a Project's work.
 *
 * Five verbs, chosen because they are what an Agent needs in order to advance
 * work at all: name a piece of it, say what happened, give it to someone else,
 * move it through its Loop, and stop to ask. Anything the Agent decides that a
 * person should see instead goes through `task.request_review`, which is the
 * only one that cannot be undone by doing more work.
 *
 * Every write records its event in the same transaction as the row, for the
 * reason `PROJECT_WORK.md` §3 gives: a fold that can be written without its
 * event is a fold that can disagree with the record it claims to summarise.
 */

export interface AgentActionContext {
  spaceId: string;
  actorId: string;
  agentId: string | null;
  runId: string;
  /** The person this Run acts for. The Agent's reach is theirs, never wider. */
  instructedByUserId: string;
  /**
   * The Project this Run was opened in. A Task-addressed action reaches only
   * its Tasks: a Room is one Project's conversation (ADR 0018, 0019), and an
   * id from another Project the person can read is still not this
   * conversation's to move.
   */
  projectId: string;
  /** The tool call, so a retried dispatch records one advancement. */
  idempotencyKey: string;
}

interface TaskRow {
  id: string;
  project_id: string | null;
  status: string;
  title: string;
}

/**
 * The Task, if the person this Run is acting for may see it.
 *
 * An Agent runs on someone's behalf and inherits their reach, never more: the
 * same content predicate every other Task surface applies. Without it an Agent
 * in any Room could name a private Task's id and report on it, move its Loop,
 * or reassign it — reading its title back in the process.
 */
export async function requireProjectTask(
  db: Queryable,
  spaceId: string,
  taskId: string,
  instructedByUserId: string,
  projectId: string,
): Promise<TaskRow & { project_id: string }> {
  const result = await db.query<TaskRow>(
    `SELECT t.id, t.project_id, t.status, t.title
       FROM tasks t
      WHERE t.space_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
        AND ${contentReadSql("task", "t", "$3")}`,
    [spaceId, taskId, instructedByUserId],
  );
  const task = result.rows[0];
  // Another Project's Task answers as not found, the same as an invented id:
  // the executor then replies with the ids this Project actually has.
  if (!task || task.project_id !== projectId) throw new HttpError(404, "Task not found");
  if (!task.project_id) {
    throw new HttpError(422, "This Task is not in a Project, so it has no work stream to write to");
  }
  // An Agent's reach is the instructing person's, and that person's reach
  // over a Project's work is bounded by their Project role: a viewer can read
  // every shared Task and change none of them, through an Agent or otherwise.
  await assertProjectWriterForMutation(db, spaceId, task.project_id, instructedByUserId);
  return { ...task, project_id: task.project_id };
}

/** Kept identical to `ck_task_entity_links_role`. */
const TASK_LINK_ROLES = new Set(["executes", "investigates", "prepares", "references"]);

export interface TaskLinkInput {
  entity_type: string;
  entity_id: string;
  role: string;
}

/**
 * Bind a Task to what it is advancing.
 *
 * The entity type is checked against the Entity registry rather than a list
 * here, so a domain joins by registering — the column carries a format check
 * only, and a demoted constraint with nothing asking the registry would be
 * worse than the constraint it replaced.
 */
export async function linkTaskEntities(
  db: Queryable,
  context: Pick<AgentActionContext, "spaceId" | "actorId" | "instructedByUserId">,
  taskId: string,
  links: readonly TaskLinkInput[],
): Promise<void> {
  for (const link of links) {
    if (!entityDefinition(link.entity_type)) {
      throw new HttpError(422, `${link.entity_type} is not a registered entity`);
    }
    // The agent path is schema-checked before it gets here; the HTTP path is
    // not, and an unknown role would reach the CHECK constraint and abort the
    // caller's whole transaction as a 500 rather than telling them what was
    // wrong.
    if (!TASK_LINK_ROLES.has(link.role)) {
      throw new HttpError(422, `${link.role} is not a Task link role`);
    }
    // The row carries no FK on `entity_id` — it is polymorphic — so the
    // binding's truth is checked here or nowhere. An unchecked id asserts a
    // link to something this Space may not contain, and the first consumer
    // that joins through it to resolve a title turns that into a cross-Space
    // read.
    const declaration = resolveContentAccessible(link.entity_type);
    const resourceType = resolveContentResourceType(link.entity_type);
    if (!declaration || !resourceType) {
      throw new HttpError(422, `${link.entity_type} cannot be linked: it declares no content access`);
    }
    // The ontology root is registered but nothing is stored *as* one, so the
    // subtype check below could only ever fail. Saying so beats a "not found"
    // that sends the caller looking for a row.
    if (link.entity_type === "space_object") {
      throw new HttpError(422, "Link the object's own type, not the ontology root");
    }
    assertSqlIdentifier(declaration.tableName, "tableName");
    // Ontology subtypes all live in one table, so an id alone proves only that
    // *something* exists: a Decision's id passed as an `experiment` would be
    // accepted and then rendered as an experiment on the Work tab. The subtype
    // column is what makes the declared type true rather than asserted.
    const subtypeClause = declaration.tableName === "space_objects"
      ? " AND e.object_type = $4"
      : "";
    const exists = await db.query(
      `SELECT 1 FROM ${declaration.tableName} e
        WHERE e.id = $1 AND e.space_id = $2
          AND ${contentReadSql(resourceType, "e", "$3")}${subtypeClause}`,
      subtypeClause
        ? [link.entity_id, context.spaceId, context.instructedByUserId, link.entity_type]
        : [link.entity_id, context.spaceId, context.instructedByUserId],
    );
    if (exists.rowCount === 0) {
      throw new HttpError(404, `That ${link.entity_type} was not found in this Space`);
    }
    await db.query(
      `INSERT INTO task_entity_links (
         id, space_id, task_id, entity_type, entity_id, role, created_by_actor_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT DO NOTHING`,
      [randomUUID(), context.spaceId, taskId, link.entity_type, link.entity_id, link.role, context.actorId],
    );
  }
}

export async function reportOnTask(
  db: Queryable,
  context: AgentActionContext,
  input: { task_id: string; summary: string; outcome?: string; refs?: readonly { type: string; id: string }[] },
): Promise<{ task_id: string; event_id: string }> {
  const task = await requireProjectTask(db, context.spaceId, input.task_id, context.instructedByUserId, context.projectId);
  const event = await appendProjectWorkEvent(db, {
    spaceId: context.spaceId,
    projectId: task.project_id,
    eventKind: "task.reported",
    subjectType: "task",
    subjectId: task.id,
    actorId: context.actorId,
    correlationId: context.runId,
    idempotencyKey: `task.reported:${context.idempotencyKey}`,
    data: {
      summary: input.summary,
      outcome: input.outcome ?? "progress",
      refs: input.refs ?? [],
      run_id: context.runId,
    },
  });
  return { task_id: task.id, event_id: event.id };
}

/**
 * Move responsibility, or release it.
 *
 * The recipient must already be able to see the Task's Project: an Agent that
 * could hand work to anyone would be a way to disclose it. Releasing (`to:
 * null`) clears the claim and lets the assignment chain answer again.
 */
export async function handoffTask(
  db: Queryable,
  context: AgentActionContext,
  input: { task_id: string; to: { kind: "user" | "agent"; id: string } | null; note?: string | null },
): Promise<{ task_id: string }> {
  const task = await requireProjectTask(db, context.spaceId, input.task_id, context.instructedByUserId, context.projectId);
  if (task.status === "done" || task.status === "cancelled") {
    throw new HttpError(409, `Task is ${task.status}; there is no work left to hand off`);
  }

  if (input.to?.kind === "user") {
    // Still in the Space, in the Project, and able to read the Task itself —
    // handing a private Task to a Project member who cannot see it names a
    // responsible person for whom the Task does not exist.
    const member = await db.query(
      `SELECT 1
         FROM tasks t
         JOIN space_memberships sm ON sm.space_id = t.space_id AND sm.user_id = $3 AND sm.status = 'active'
        WHERE t.space_id = $1 AND t.id = $4
          AND ${contentReadSql("task", "t", "$3")}
          AND (
            EXISTS (SELECT 1 FROM project_members pm
                     WHERE pm.space_id = $1 AND pm.project_id = $2
                       AND pm.user_id = $3 AND pm.status = 'active')
            OR EXISTS (SELECT 1 FROM projects p
                        WHERE p.space_id = $1 AND p.id = $2 AND p.owner_user_id = $3)
          )`,
      [context.spaceId, task.project_id, input.to.id, task.id],
    );
    if (member.rowCount === 0) {
      throw new HttpError(422, "That person cannot take this Task on in this Project");
    }
  }
  if (input.to?.kind === "agent") {
    // `system_assistant` is excluded for the same reason a Task cannot be
    // dispatched to it: it can never be run, so handing work to it parks the
    // Task with an Agent holding it and nobody interrupted.
    const agent = await db.query(
      `SELECT 1 FROM agents
        WHERE space_id = $1 AND id = $2 AND status = 'active'
          AND agent_kind <> 'system_assistant'
          AND (project_id IS NULL OR project_id = $3)`,
      [context.spaceId, input.to.id, task.project_id],
    );
    if (agent.rowCount === 0) throw new HttpError(422, "That Agent is not available to this Task's Project");
  }

  await db.query(
    `UPDATE tasks
        SET claimed_by_user_id = $3, claimed_by_agent_id = $4, updated_at = now()
      WHERE space_id = $1 AND id = $2`,
    [
      context.spaceId,
      task.id,
      input.to?.kind === "user" ? input.to.id : null,
      input.to?.kind === "agent" ? input.to.id : null,
    ],
  );
  await appendProjectWorkEvent(db, {
    spaceId: context.spaceId,
    projectId: task.project_id,
    eventKind: "task.responsibility_changed",
    subjectType: "task",
    subjectId: task.id,
    actorId: context.actorId,
    correlationId: context.runId,
    idempotencyKey: `task.responsibility_changed:${context.idempotencyKey}`,
    data: {
      via: "agent",
      to: input.to,
      note: input.note ?? null,
      released: input.to === null,
      run_id: context.runId,
    },
  });
  return { task_id: task.id };
}

export async function advanceTaskStage(
  db: Queryable,
  context: AgentActionContext,
  input: { task_id: string; to_stage: WorkLoopStageKey; reason: string },
): Promise<{ task_id: string; stage: WorkLoopStageKey }> {
  const task = await requireProjectTask(db, context.spaceId, input.task_id, context.instructedByUserId, context.projectId);
  await recordStageChange(db, {
    spaceId: context.spaceId,
    projectId: task.project_id,
    taskId: task.id,
    toStage: input.to_stage,
    actorId: context.actorId,
    reason: input.reason,
    correlationId: context.runId,
    idempotencyKey: `task.stage_changed:${context.idempotencyKey}`,
    data: { via: "agent", run_id: context.runId },
  });
  return { task_id: task.id, stage: input.to_stage };
}

/**
 * Stop and ask.
 *
 * This is what makes "the person is only involved at the points that are
 * theirs" true rather than aspirational: without a way for an Agent to hand
 * the decision back deliberately, the only signals a person gets are failures.
 */
export async function requestTaskReview(
  db: Queryable,
  context: AgentActionContext,
  input: { task_id: string; reason: string; options?: readonly string[] },
): Promise<{ task_id: string; status: string }> {
  return withQueryableTransaction(db, async (tx) => {
    const task = await requireProjectTask(tx, context.spaceId, input.task_id, context.instructedByUserId, context.projectId);
    if (task.status === "done" || task.status === "cancelled") {
      throw new HttpError(409, `Task is ${task.status} and cannot be sent for review`);
    }
    // Asking twice is one ask. A second request while the first is pending
    // would write a `waiting_for_review → waiting_for_review` flow event and
    // a second report, and re-issue a decision the person already has.
    if (task.status === "waiting_for_review") {
      throw new HttpError(409, "Task is already waiting for a decision");
    }
    await tx.query(
      `UPDATE tasks SET status = 'waiting_for_review', updated_at = now()
        WHERE space_id = $1 AND id = $2`,
      [context.spaceId, task.id],
    );

    const event = await appendProjectWorkEvent(tx, {
      spaceId: context.spaceId,
      projectId: task.project_id,
      eventKind: "task.flow_changed",
      subjectType: "task",
      subjectId: task.id,
      actorId: context.actorId,
      correlationId: context.runId,
      idempotencyKey: `task.flow_changed:${context.idempotencyKey}`,
      data: { from: task.status, to: "waiting_for_review", via: "agent", reason: input.reason },
    });
    await appendProjectWorkEvent(tx, {
      spaceId: context.spaceId,
      projectId: task.project_id,
      eventKind: "task.reported",
      subjectType: "task",
      subjectId: task.id,
      actorId: context.actorId,
      correlationId: context.runId,
      causationId: event.id,
      idempotencyKey: `task.reported:review:${context.idempotencyKey}`,
      data: {
        summary: input.reason,
        outcome: "stuck",
        options: input.options ?? [],
        run_id: context.runId,
      },
    });
    return { task_id: task.id, status: "waiting_for_review" };
  });
}

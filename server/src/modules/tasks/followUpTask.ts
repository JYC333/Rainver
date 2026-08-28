import type { Pool } from "../../db/pool.js";
import { HttpError, optionalString, objectValue, type Queryable, type SpaceUserIdentity } from "../routeUtils/common.js";
import { assertProjectWriterForMutation, lockActiveProjectForMutation } from "../projects/access.js";
import { PgTaskRepository } from "./repository.js";

/**
 * The follow-up Task an Agent proposes at the end of a Run.
 *
 * One parser and one writer for both ways the proposal is applied
 * ([ADR 0017](../../../../.agent/decisions/0017-authorization-by-cost-not-authorship.md)):
 * a person clicking Accept, or the finalization reconciler applying it for
 * them after a Run they asked for succeeded. The two differ in who authorised
 * it and in nothing else, so the validation, the Project authority check and
 * the write live here rather than once per route.
 */

const VALID_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const VALID_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

/**
 * What the model may put at the top level. The strictness is aimed at the
 * model: an unknown field there is an invented capability, and accepting it
 * silently makes a Task that is missing what the field asked for.
 *
 * The second group is the envelope the server itself adds on the way to a
 * proposal (`proposalPayload`, `insertProposal`). Rejecting those made every
 * materialized `follow_up_task` proposal unappliable — accept failed on the
 * first one, so the queue could only ever grow.
 */
const ALLOWED_TOPLEVEL = new Set([
  "task",
  "reflection_id",
  "provenance_entries",
  "source_run_id",
  "created_by_run_id",
  "proposal_type",
  "project_id",
  "project_folder_id",
  "context_taint",
  "requested_output_visibility",
  "requires_approval_type",
  "required_egress_approver_user_ids",
]);
const ALLOWED_TASK_FIELDS = new Set([
  "title",
  "description",
  "task_type",
  "priority",
  "risk_level",
  "acceptance_criteria_json",
  "required_outputs_json",
  "tags",
  "metadata_json",
]);

export interface FollowUpTaskFields {
  title: string;
  description: string | null;
  taskType: string;
  priority: string;
  riskLevel: string;
  acceptanceCriteria: Record<string, unknown> | null;
  requiredOutputs: unknown[] | null;
  tags: string[] | null;
  metadata: Record<string, unknown>;
  reflectionId: string | null;
}

/**
 * Strict on purpose: an unknown field is a model inventing a capability, and
 * accepting it silently would create a Task missing what the field asked for.
 */
export function parseFollowUpTaskPayload(value: unknown): FollowUpTaskFields {
  const payload = objectValue(value);
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_TOPLEVEL.has(key)) {
      throw new HttpError(422, `follow_up_task payload has unknown top-level field: ${JSON.stringify(key)}`);
    }
  }

  const taskData = payload.task;
  if (taskData === undefined || taskData === null) {
    throw new HttpError(422, "follow_up_task payload_json is missing required 'task' field");
  }
  if (typeof taskData !== "object" || Array.isArray(taskData)) {
    throw new HttpError(422, "follow_up_task payload_json['task'] must be a dict");
  }
  const task = taskData as Record<string, unknown>;
  for (const key of Object.keys(task)) {
    if (!ALLOWED_TASK_FIELDS.has(key)) {
      throw new HttpError(422, `follow_up_task task has unknown field: ${JSON.stringify(key)}`);
    }
  }

  const rawTitle = task.title;
  if (rawTitle === undefined || rawTitle === null) {
    throw new HttpError(422, "follow_up_task task.title is required");
  }
  if (typeof rawTitle !== "string") {
    throw new HttpError(422, "follow_up_task task.title must be a string");
  }
  const title = rawTitle.trim();
  if (!title) throw new HttpError(422, "follow_up_task task.title must not be blank");

  const description = task.description;
  if (description !== undefined && description !== null && typeof description !== "string") {
    throw new HttpError(422, "follow_up_task task.description must be a string if provided");
  }

  const priority = optionalString(task.priority) ?? "normal";
  if (!VALID_PRIORITIES.has(priority)) {
    throw new HttpError(
      422,
      `follow_up_task task.priority must be one of ${[...VALID_PRIORITIES].sort().join(", ")}`,
    );
  }

  const riskLevel = optionalString(task.risk_level) ?? "low";
  if (!VALID_RISK_LEVELS.has(riskLevel)) {
    throw new HttpError(
      422,
      `follow_up_task task.risk_level must be one of ${[...VALID_RISK_LEVELS].sort().join(", ")}`,
    );
  }

  const acceptanceCriteria = task.acceptance_criteria_json;
  if (
    acceptanceCriteria !== undefined
    && acceptanceCriteria !== null
    && (typeof acceptanceCriteria !== "object" || Array.isArray(acceptanceCriteria))
  ) {
    throw new HttpError(422, "follow_up_task task.acceptance_criteria_json must be a dict if provided");
  }

  const requiredOutputs = task.required_outputs_json;
  if (requiredOutputs !== undefined && requiredOutputs !== null && !Array.isArray(requiredOutputs)) {
    throw new HttpError(422, "follow_up_task task.required_outputs_json must be a list if provided");
  }

  const tags = task.tags;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) {
      throw new HttpError(422, "follow_up_task task.tags must be a list if provided");
    }
    if (!tags.every((tag) => typeof tag === "string")) {
      throw new HttpError(422, "follow_up_task task.tags must be a list of strings");
    }
  }

  const extraMetadata = task.metadata_json;
  if (
    extraMetadata !== undefined
    && extraMetadata !== null
    && (typeof extraMetadata !== "object" || Array.isArray(extraMetadata))
  ) {
    throw new HttpError(422, "follow_up_task task.metadata_json must be a dict if provided");
  }

  return {
    title,
    description: typeof description === "string" ? description : null,
    taskType: optionalString(task.task_type) ?? "general",
    priority,
    riskLevel,
    acceptanceCriteria: acceptanceCriteria as Record<string, unknown> | null ?? null,
    requiredOutputs: Array.isArray(requiredOutputs) ? requiredOutputs : null,
    tags: Array.isArray(tags) ? tags as string[] : null,
    metadata: (extraMetadata as Record<string, unknown> | null) ?? {},
    reflectionId: optionalString(payload.reflection_id),
  };
}

export interface FollowUpTaskOrigin {
  /** The Run whose output asked for it. */
  runId: string | null;
  /** Set only when the write went through the proposal route. */
  proposalId?: string | null;
  /**
   * The Agent, for `task.created`. The Task belongs to the person — they own
   * it and it inherits their access — but the stream says who made it, and a
   * Task the Agent decided on did not appear because the person typed it.
   */
  agentActorId?: string | undefined;
}

/** Verifies a Project Folder belongs to this Space before anything is written. */
async function assertProjectFolderInSpace(
  db: Queryable,
  spaceId: string,
  projectFolderId: string | null,
): Promise<void> {
  if (!projectFolderId) return;
  const folder = await db.query<{ id: string }>(
    `SELECT id FROM project_folders WHERE id = $1 AND space_id = $2 LIMIT 1`,
    [projectFolderId, spaceId],
  );
  if (!folder.rows[0]) {
    throw new HttpError(
      422,
      `project_folder ${JSON.stringify(projectFolderId)} not found in space ${JSON.stringify(spaceId)}`,
    );
  }
}

export async function createFollowUpTask(
  db: Queryable,
  identity: SpaceUserIdentity,
  input: {
    /**
     * For constructing the repository only. Every write goes through `db`,
     * the caller's transaction: the Task and its `task.created` event have to
     * commit together.
     */
    pool: Pool;
    fields: FollowUpTaskFields;
    projectId: string | null;
    projectFolderId: string | null;
    origin: FollowUpTaskOrigin;
    /** How the Task got here, for anyone reading its metadata later. */
    source: string;
  },
): Promise<{ id: string; space_id: string; title: string; status: string }> {
  await assertProjectFolderInSpace(db, identity.spaceId, input.projectFolderId);
  if (input.projectId) {
    // The same pairing every Project write uses, and it belongs here rather
    // than in either caller: accepting the proposal is a Project write too,
    // and the space role that authorises the accept says nothing about
    // whether that person may write into this Project — nor whether the
    // Project is still active.
    await lockActiveProjectForMutation(db, identity.spaceId, input.projectId);
    await assertProjectWriterForMutation(db, identity.spaceId, input.projectId, identity.userId);
  }
  const created = await new PgTaskRepository(input.pool).createTask(
    identity,
    {
      title: input.fields.title,
      description: input.fields.description,
      task_type: input.fields.taskType,
      priority: input.fields.priority,
      risk_level: input.fields.riskLevel,
      acceptance_criteria_json: input.fields.acceptanceCriteria,
      required_outputs_json: input.fields.requiredOutputs,
      tags: input.fields.tags,
      // Shared, like every Task on a Project's Board: a follow-up only the
      // person who ran the Agent can see is not follow-up work, it is a note.
      visibility: "space_shared",
      project_id: input.projectId,
      project_folder_id: input.projectFolderId,
      source_run_id: input.origin.runId,
      source_proposal_id: input.origin.proposalId ?? null,
      metadata_json: {
        ...input.fields.metadata,
        source: input.source,
        ...(input.origin.proposalId
          ? { proposal_id: input.origin.proposalId, created_from_proposal_type: "follow_up_task" }
          : {}),
        ...(input.fields.reflectionId ? { reflection_id: input.fields.reflectionId } : {}),
      },
    },
    db,
    input.origin.agentActorId,
  );
  return {
    id: created.id as string,
    space_id: identity.spaceId,
    title: created.title as string,
    status: created.status as string,
  };
}

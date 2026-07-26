import { randomUUID } from "node:crypto";
import type { ProposalApplierRegistry, ProposalApplyContext, ProposalApplyResult } from "../proposals/applierRegistry";
import { HttpError, optionalString, objectValue } from "../routeUtils/common";

const VALID_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const VALID_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

const ALLOWED_TOPLEVEL = new Set(["task", "reflection_id", "provenance_entries"]);
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

async function applyFollowUpTaskProposal(ctx: ProposalApplyContext): Promise<ProposalApplyResult> {
  const payload = objectValue(ctx.proposal.payload_json);

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

  const taskType = optionalString(task.task_type) ?? "general";

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
    acceptanceCriteria !== undefined &&
    acceptanceCriteria !== null &&
    (typeof acceptanceCriteria !== "object" || Array.isArray(acceptanceCriteria))
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
    if (!tags.every((t) => typeof t === "string")) {
      throw new HttpError(422, "follow_up_task task.tags must be a list of strings");
    }
  }

  const extraMetadata = task.metadata_json;
  if (
    extraMetadata !== undefined &&
    extraMetadata !== null &&
    (typeof extraMetadata !== "object" || Array.isArray(extraMetadata))
  ) {
    throw new HttpError(422, "follow_up_task task.metadata_json must be a dict if provided");
  }

  // Project Folder cross-space safety: verify the Folder belongs to this space.
  const projectFolderId = optionalString(ctx.proposal.project_folder_id);
  if (projectFolderId) {
    const folder = await ctx.db.query<{ id: string }>(
      `SELECT id FROM project_folders WHERE id = $1 AND space_id = $2 LIMIT 1`,
      [projectFolderId, ctx.proposal.space_id],
    );
    if (!folder.rows[0]) {
      throw new HttpError(
        422,
        `project_folder ${JSON.stringify(projectFolderId)} not found in space ${JSON.stringify(ctx.proposal.space_id)}`,
      );
    }
  }

  const visibility = "space_shared";

  const reflectionId = optionalString(payload.reflection_id);
  const mergedMeta: Record<string, unknown> = {
    ...(typeof extraMetadata === "object" && extraMetadata !== null
      ? (extraMetadata as Record<string, unknown>)
      : {}),
    source: "follow_up_task_proposal",
    proposal_id: ctx.proposal.id,
    created_from_proposal_type: "follow_up_task",
  };
  if (reflectionId) mergedMeta.reflection_id = reflectionId;

  const now = new Date().toISOString();
  const inserted = await ctx.db.query<{ id: string; space_id: string; title: string; status: string }>(
    `INSERT INTO tasks (
       id, space_id, project_folder_id, title, description, task_type, status, priority,
       risk_level, visibility, owner_user_id, created_by_user_id, source_proposal_id, source_run_id,
       acceptance_criteria_json, required_outputs_json, tags, metadata_json,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'inbox', $7,
       $8, $9, $10, $10, $11, $12,
       $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
       $17, $17
     ) RETURNING id, space_id, title, status`,
    [
      randomUUID(),
      ctx.proposal.space_id,
      projectFolderId,
      title,
      typeof description === "string" ? description : null,
      taskType,
      priority,
      riskLevel,
      visibility,
      ctx.userId,
      ctx.proposal.id,
      optionalString(ctx.proposal.created_by_run_id ?? null),
      JSON.stringify(
        typeof acceptanceCriteria === "object" && acceptanceCriteria !== null
          ? acceptanceCriteria
          : null,
      ),
      JSON.stringify(Array.isArray(requiredOutputs) ? requiredOutputs : null),
      JSON.stringify(Array.isArray(tags) ? tags : null),
      JSON.stringify(mergedMeta),
      now,
    ],
  );

  const row = inserted.rows[0]!;
  return {
    result_type: "follow_up_task",
    result: { task: { id: row.id, space_id: row.space_id, title: row.title, status: row.status } },
  };
}

export function registerTaskProposalAppliers(registry: ProposalApplierRegistry): void {
  registry.register("follow_up_task", applyFollowUpTaskProposal);
}

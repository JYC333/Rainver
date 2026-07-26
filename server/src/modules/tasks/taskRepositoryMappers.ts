import {
  HttpError,
  dateIso,
  numberValue,
} from "../routeUtils/common";
import type {
  BoardColumnRow,
  BoardRow,
  TaskArtifactRow,
  TaskEvaluationRow,
  TaskProposalRow,
  TaskRow,
  TaskRunListRow,
} from "./taskRepositoryRows";

export function boardOut(row: BoardRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    project_folder_id: row.project_folder_id,
    project_id: row.project_id ?? null,
    name: row.name,
    description: row.description,
    board_type: row.board_type,
    status: row.status,
    default_view: row.default_view,
    sort_order: row.sort_order,
    metadata_json: row.metadata_json ?? null,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    deleted_at: dateIso(row.deleted_at),
  };
}

export function boardColumnOut(row: BoardColumnRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    board_id: row.board_id,
    name: row.name,
    description: row.description,
    status_key: row.status_key,
    position: row.position,
    wip_limit: row.wip_limit,
    is_done_column: Boolean(row.is_done_column),
    is_default_column: Boolean(row.is_default_column),
    metadata_json: row.metadata_json ?? null,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    deleted_at: dateIso(row.deleted_at),
  };
}

export function taskOut(row: TaskRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    project_folder_id: row.project_folder_id,
    project_id: row.project_id ?? null,
    board_id: row.board_id,
    column_id: row.column_id,
    parent_task_id: row.parent_task_id,
    task_role: row.task_role,
    title: row.title,
    description: row.description,
    task_type: row.task_type,
    status: row.status,
    priority: row.priority,
    risk_level: row.risk_level,
    visibility: row.visibility,
    created_by_user_id: row.created_by_user_id,
    created_by_agent_id: row.created_by_agent_id,
    assigned_user_id: row.assigned_user_id,
    assigned_agent_id: row.assigned_agent_id,
    claimed_by_user_id: row.claimed_by_user_id,
    claimed_by_agent_id: row.claimed_by_agent_id,
    source_activity_id: row.source_activity_id,
    source_run_id: row.source_run_id,
    source_proposal_id: row.source_proposal_id,
    source_artifact_id: row.source_artifact_id,
    acceptance_criteria_json: row.acceptance_criteria_json ?? null,
    definition_of_done: row.definition_of_done,
    required_outputs_json: row.required_outputs_json ?? null,
    max_runs: row.max_runs,
    max_cost: row.max_cost,
    max_duration_seconds: row.max_duration_seconds,
    policy_json: row.policy_json ?? null,
    metadata_json: row.metadata_json ?? null,
    tags: Array.isArray(row.tags) ? row.tags : null,
    due_at: dateIso(row.due_at),
    start_after: dateIso(row.start_after),
    completed_at: dateIso(row.completed_at),
    cancelled_at: dateIso(row.cancelled_at),
    blocked_reason: row.blocked_reason,
    created_at: dateIso(row.created_at),
    updated_at: dateIso(row.updated_at),
    deleted_at: dateIso(row.deleted_at),
  };
}

export function taskRunOutFromList(row: TaskRunListRow) {
  return {
    id: row.task_run_id,
    space_id: row.task_run_space_id,
    task_id: row.task_run_task_id,
    run_id: row.task_run_run_id,
    role: row.task_run_role,
    created_at: dateIso(row.task_run_created_at),
  };
}

export function taskArtifactOut(row: TaskArtifactRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    task_id: row.task_id,
    artifact_id: row.artifact_id,
    run_id: row.task_artifact_run_id,
    role: row.role,
    created_at: dateIso(row.created_at),
    artifact: {
      id: row.artifact_id,
      space_id: row.artifact_space_id,
      run_id: row.artifact_run_id,
      proposal_id: row.proposal_id,
      artifact_type: row.artifact_type,
      title: row.title,
      mime_type: row.mime_type,
      visibility: row.visibility,
      created_at: dateIso(row.artifact_created_at),
    },
  };
}

export function taskProposalOut(row: TaskProposalRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    task_id: row.task_id,
    proposal_id: row.proposal_id,
    role: row.role,
    created_at: dateIso(row.created_at),
    proposal: {
      id: row.proposal_id,
      space_id: row.proposal_space_id,
      proposal_type: row.proposal_type,
      status: row.status,
      title: row.title,
      visibility: row.visibility,
      created_at: dateIso(row.proposal_created_at),
      preview: Boolean(row.preview),
      urgency: row.urgency,
      review_deadline: dateIso(row.review_deadline),
      expires_at: dateIso(row.expires_at),
      expired: Boolean(row.expires_at && new Date(row.expires_at as string).getTime() < Date.now() && row.status === "pending"),
      created_by_run_id: row.created_by_run_id,
    },
  };
}

export function taskEvaluationOut(row: TaskEvaluationRow) {
  return {
    id: row.id,
    space_id: row.space_id,
    task_id: row.task_id,
    run_id: row.run_id,
    run_evaluation_id: row.run_evaluation_id,
    evaluator_type: row.evaluator_type,
    evaluator_user_id: row.evaluator_user_id,
    evaluator_agent_id: row.evaluator_agent_id,
    score: row.score,
    confidence: row.confidence,
    summary: row.summary,
    checklist_json: row.checklist_json ?? null,
    known_issues_json: row.known_issues_json ?? null,
    evidence_artifact_ids: row.evidence_artifact_ids ?? null,
    recommendation: row.recommendation,
    created_at: dateIso(row.created_at),
  };
}

export function defaultTaskInstruction(task: TaskRow): string {
  const details = [task.description, task.blocked_reason ? `Blocked: ${task.blocked_reason}` : null].filter(Boolean).join("\n\n");
  return details ? `Task: ${task.title}\n\n${details}` : `Task: ${task.title}`;
}

export function bounded01(value: unknown, field: string): number | null {
  const parsed = numberValue(value);
  if (parsed === null) return null;
  if (parsed < 0 || parsed > 1) throw new HttpError(422, `${field} must be between 0 and 1`);
  return parsed;
}

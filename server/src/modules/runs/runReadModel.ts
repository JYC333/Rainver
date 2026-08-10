import { getRuntimeAdapterSpec } from "../runtimeAdapters";
import type {
  ArtifactSummaryRecord,
  ModelProviderSummaryRecord,
  ProposalSummaryRecord,
  RunEventDetailRecord,
  RunEvaluationRecord,
  RunFinalizationRecord,
  RunRecord,
  RunStepDetailRecord,
} from "./repository";
import type { VerificationResultRecord } from "./verification";

export function runToOut(
  run: RunRecord,
  provider: ModelProviderSummaryRecord | null = null,
): Record<string, unknown> {
  return {
    id: run.id,
    space_id: run.space_id,
    agent_id: run.agent_id,
    agent_version_id: run.agent_version_id,
    run_role: run.run_role ?? "execution",
    requested_runtime_profile_id: run.requested_runtime_profile_id ?? null,
    selected_runtime_profile_id: run.runtime_profile_id ?? null,
    runtime_profile_selection_source: run.runtime_profile_selection_source ?? null,
    project_folder_id: run.project_folder_id ?? null,
    session_id: run.session_id ?? null,
    parent_run_id: run.parent_run_id ?? null,
    root_run_id: run.root_run_id ?? null,
    run_group_id: run.run_group_id ?? null,
    delegation_id: run.delegation_id ?? null,
    instructed_by_user_id: run.instructed_by_user_id ?? null,
    instructed_by_agent_id: run.instructed_by_agent_id ?? null,
    run_type: run.run_type ?? "agent",
    trigger_origin: run.trigger_origin,
    status: run.status,
    mode: run.mode,
    // Canonical input remains in its owning Message/Run records. Normal Run
    // reads expose references and safe Invocation Snapshot metadata, never the
    // raw task or rendered context body.
    prompt: null,
    instruction: null,
    scheduled_at: run.scheduled_at ?? null,
    started_at: run.started_at ?? null,
    ended_at: run.ended_at ?? null,
    created_at: run.created_at ?? null,
    updated_at: run.updated_at ?? null,
    error_message: run.error_message ?? null,
    error_json: run.error_json ?? null,
    output_json: run.output_json ?? null,
    usage: runUsageToOut(run.usage),
    selected_adapter_type: run.adapter_type ?? null,
    capability_id: run.capability_id ?? null,
    capabilities_json: Array.isArray(run.capabilities_json) ? run.capabilities_json : [],
    selected_model_provider_id: run.model_provider_id ?? null,
    resolved_model: buildResolvedModel(run, provider),
    required_sandbox_level: run.required_sandbox_level,
    owner_user_id: run.owner_user_id ?? null,
    visibility: run.visibility ?? "space_shared",
    access_level: run.access_level ?? "full",
    project_id: run.project_id ?? null,
    contract_snapshot_json: run.contract_snapshot_json ?? {},
    workflow_version_id: run.workflow_version_id ?? null,
    active_route_decision_id: run.route_decision_id ?? null,
  };
}

function runUsageToOut(usage: RunRecord["usage"]): Record<string, unknown> | null {
  if (!usage) return null;
  return {
    agent_run_count: numberOrNull(usage.agent_run_count) ?? 0,
    completed_agent_run_count: numberOrNull(usage.completed_agent_run_count) ?? 0,
    input_tokens: numberOrNull(usage.input_tokens),
    output_tokens: numberOrNull(usage.output_tokens),
    total_tokens: numberOrNull(usage.total_tokens),
    estimated_cost_usd: numberOrNull(usage.estimated_cost_usd),
    cost_known: numberOrNull(usage.estimated_cost_usd) !== null,
    model_names: usage.model_names ?? [],
  };
}

export function runStatusToOut(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    run_type: run.run_type ?? "agent",
    trigger_origin: run.trigger_origin,
    started_at: run.started_at ?? null,
    ended_at: run.ended_at ?? null,
    error_message: run.error_message ?? null,
  };
}

export function runEvaluationToOut(row: RunEvaluationRecord): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    run_id: row.run_id,
    evaluator_type: row.evaluator_type,
    evaluator_version: row.evaluator_version,
    outcome_status: row.outcome_status,
    failure_layer: row.failure_layer,
    failure_reason_code: row.failure_reason_code,
    trajectory_status: row.trajectory_status,
    evidence_json: row.evidence_json ?? null,
    rule_trace_json: row.rule_trace_json ?? null,
    notes: row.notes,
    evaluated_at: row.evaluated_at,
  };
}

export function verificationResultToOut(row: VerificationResultRecord): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    run_id: row.run_id,
    attempt_number: row.attempt_number,
    verifier_type: row.verifier_type,
    verifier_version: row.verifier_version,
    status: row.status,
    summary: row.summary,
    evidence_refs_json: row.evidence_refs_json ?? null,
    details_json: row.details_json ?? null,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

export function runFinalizationToOut(row: RunFinalizationRecord): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    run_id: row.run_id,
    attempt_number: row.attempt_number,
    finalizer_version: row.finalizer_version,
    status: row.status,
    run_evaluation_id: row.run_evaluation_id,
    task_evaluation_id: row.task_evaluation_id,
    outcome_status: row.outcome_status,
    failure_layer: row.failure_layer,
    failure_reason_code: row.failure_reason_code,
    trajectory_status: row.trajectory_status,
    skipped_reasons_json: row.skipped_reasons_json ?? null,
    error_json: row.error_json ?? null,
    metadata_json: row.metadata_json ?? null,
    finalized_at: row.finalized_at,
    created_at: row.created_at,
  };
}


export function runStepToOut(row: RunStepDetailRecord): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    run_id: row.run_id,
    attempt_number: row.attempt_number,
    parent_step_id: row.parent_step_id,
    actor_id: row.actor_id,
    step_index: row.step_index,
    step_type: row.step_type,
    status: row.status,
    title: row.title,
    project_folder_id: row.project_folder_id,
    session_id: row.session_id,
    task_id: row.task_id,
    artifact_id: row.artifact_id,
    proposal_id: row.proposal_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    input_summary: row.input_summary,
    output_summary: row.output_summary,
    error_type: row.error_type,
    error_message: row.error_message,
    metadata_json: row.metadata_json ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function runEventToOut(row: RunEventDetailRecord): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    run_id: row.run_id,
    attempt_number: row.attempt_number,
    step_id: row.step_id,
    actor_id: row.actor_id,
    event_index: row.event_index,
    event_type: row.event_type,
    status: row.status,
    summary: row.summary,
    error_code: row.error_code,
    error_message: row.error_message,
    project_folder_id: row.project_folder_id,
    artifact_id: row.artifact_id,
    proposal_id: row.proposal_id,
    data_exposure_level: row.data_exposure_level,
    trust_level: row.trust_level,
    metadata_json: row.metadata_json ?? null,
    created_at: row.created_at,
  };
}

export function artifactSummaryToOut(row: ArtifactSummaryRecord): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    run_id: row.run_id,
    proposal_id: row.proposal_id,
    artifact_type: row.artifact_type,
    title: row.title,
    mime_type: row.mime_type,
    visibility: row.visibility,
    created_at: row.created_at,
  };
}

export function proposalSummaryToOut(
  row: ProposalSummaryRecord,
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    id: row.id,
    space_id: row.space_id,
    proposal_type: row.proposal_type,
    status: row.status,
    title: row.title,
    visibility: row.visibility,
    created_at: row.created_at,
    preview: row.preview,
    urgency: row.urgency,
    review_deadline: row.review_deadline,
    expires_at: row.expires_at,
    expired: computeExpired(row.expires_at, row.status, now),
    created_by_run_id: row.created_by_run_id,
  };
}

export function runLineageToOut(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    space_id: run.space_id,
    agent_id: run.agent_id,
    agent_version_id: run.agent_version_id,
    parent_run_id: run.parent_run_id ?? null,
    status: run.status,
    run_type: run.run_type ?? "agent",
    trigger_origin: run.trigger_origin,
    mode: run.mode,
    created_at: run.created_at ?? null,
    started_at: run.started_at ?? null,
    ended_at: run.ended_at ?? null,
  };
}

function buildResolvedModel(
  run: RunRecord,
  provider: ModelProviderSummaryRecord | null,
): Record<string, unknown> {
  const override = recordValue(run.model_override_json);
  const source = normalizeSource(stringValue(override.source));
  const model = stringValue(override.model);
  const hasRecordedModel = Boolean(run.model_provider_id || model);
  const spec = getRuntimeAdapterSpec(run.adapter_type);
  const behavior = spec?.model.model_config_behavior ?? "unknown";
  const usedByAdapter = behavior === "uses_model" && hasRecordedModel;
  return {
    provider_id: run.model_provider_id ?? null,
    provider_name: provider?.name ?? null,
    provider_type: provider?.provider_type ?? null,
    model,
    source,
    used_by_adapter: usedByAdapter,
    adapter_model_support: behavior,
    disclosure_note:
      hasRecordedModel && !usedByAdapter
        ? "Recorded model configuration is not used by this runtime adapter."
        : null,
  };
}

function computeExpired(
  expiresAt: string | null,
  status: string,
  now: Date,
): boolean {
  if (status !== "pending" || !expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed < now.getTime();
}

function normalizeSource(value: string | null): string {
  return value === "request" ||
    value === "runtime_profile" ||
    value === "agent_default" ||
    value === "runtime_default" ||
    value === "space_default"
    ? value
    : "none";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

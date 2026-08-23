import type { UsageRunSummaryRecord } from "../usage/repository";

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface RunRecord {
  id: string;
  space_id: string;
  agent_id: string;
  agent_name?: string | null;
  agent_version_id: string;
  run_role?: "execution" | "coordinator";
  requested_runtime_profile_id?: string | null;
  runtime_profile_id?: string | null;
  runtime_profile_selection_source?: RuntimeProfileSelectionSource | null;
  system_prompt?: string | null;
  run_type?: string;
  status: string;
  mode: string;
  prompt: string | null;
  instruction: string | null;
  project_folder_id: string | null;
  host_task_thread_id?: string | null;
  session_id: string | null;
  parent_run_id?: string | null;
  root_run_id?: string | null;
  run_group_id?: string | null;
  delegation_id?: string | null;
  project_id: string | null;
  contract_snapshot_json?: unknown;
  workflow_version_id?: string | null;
  route_decision_id?: string | null;
  scheduled_at?: string | null;
  adapter_type: string | null;
  capability_id?: string | null;
  capabilities_json?: unknown;
  model_provider_id: string | null;
  runtime_config_json?: unknown;
  model_override_json?: unknown;
  runtime_profile_snapshot_json?: unknown;
  permission_snapshot_json?: unknown;
  required_sandbox_level: string;
  trigger_origin: string;
  instructed_by_user_id?: string | null;
  instructed_by_agent_id?: string | null;
  error_message?: string | null;
  error_json?: unknown;
  output_json?: unknown;
  usage?: UsageRunSummaryRecord | null;
  started_at: string | null;
  ended_at: string | null;
  created_at?: string;
  updated_at?: string;
  owner_user_id?: string | null;
  visibility?: string;
  access_level?: string;
  has_context_taint?: boolean;
  context_taint_json?: unknown;
}

export type RuntimeProfileSelectionSource = "explicit" | "default";

export interface RunListFilters {
  space_id: string;
  user_id: string;
  status?: string | null;
  mode?: string | null;
  agent_id?: string | null;
  project_folder_id?: string | null;
  project_id?: string | null;
  workflow_version_id?: string | null;
  capability_id?: string | null;
  run_role?: "execution" | "coordinator" | null;
  exclude_system_assistants?: boolean;
  limit: number;
  offset: number;
}

export interface ModelProviderSummaryRecord {
  id: string;
  name: string;
  provider_type: string;
  default_model: string | null;
  enabled: boolean;
  credential_id?: string | null;
}


export interface RunEvaluationRecord {
  id: string;
  space_id: string;
  run_id: string;
  evaluator_type: string;
  evaluator_version: string;
  outcome_status: string;
  failure_layer: string | null;
  failure_reason_code: string | null;
  trajectory_status: string;
  evidence_json: unknown;
  rule_trace_json: unknown;
  notes: string | null;
  evaluated_at: string;
}

export interface RunFinalizationRecord {
  id: string;
  space_id: string;
  run_id: string;
  attempt_number: number;
  finalizer_version: string;
  status: string;
  run_evaluation_id: string | null;
  task_evaluation_id: string | null;
  outcome_status: string | null;
  failure_layer: string | null;
  failure_reason_code: string | null;
  trajectory_status: string | null;
  skipped_reasons_json: unknown;
  error_json: unknown;
  metadata_json: unknown;
  finalized_at: string;
  created_at: string;
}

export interface RunStepDetailRecord {
  id: string;
  space_id: string;
  run_id: string;
  attempt_number: number | null;
  parent_step_id: string | null;
  actor_id: string;
  step_index: number;
  step_type: string;
  status: string;
  title: string | null;
  project_folder_id: string | null;
  session_id: string | null;
  task_id: string | null;
  artifact_id: string | null;
  proposal_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  input_summary: string | null;
  output_summary: string | null;
  error_type: string | null;
  error_message: string | null;
  metadata_json: unknown;
  created_at: string;
  updated_at: string;
}

export interface RunEventDetailRecord {
  id: string;
  space_id: string;
  run_id: string;
  attempt_number: number | null;
  step_id: string | null;
  actor_id: string | null;
  event_index: number;
  event_type: string;
  status: string;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  project_folder_id: string | null;
  artifact_id: string | null;
  proposal_id: string | null;
  data_exposure_level: string | null;
  trust_level: string | null;
  metadata_json: unknown;
  created_at: string;
}

export interface RunEventPageFilters {
  from_event_index: number;
  limit: number;
  event_type?: string | null;
  status?: string | null;
}

export interface RunEventPage {
  items: RunEventDetailRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface ArtifactSummaryRecord {
  id: string;
  space_id: string;
  run_id: string | null;
  proposal_id: string | null;
  artifact_type: string;
  title: string;
  mime_type: string | null;
  visibility: string;
  created_at: string;
}

export interface ProposalSummaryRecord {
  id: string;
  space_id: string;
  proposal_type: string;
  status: string;
  title: string;
  visibility: string;
  created_at: string;
  preview: boolean;
  urgency: string;
  review_deadline: string | null;
  expires_at: string | null;
  created_by_run_id: string | null;
}

export interface RunCreateInput {
  agent_id: string;
  space_id: string;
  user_id: string;
  mode: string;
  run_type: string;
  trigger_origin: string;
  session_id?: string | null;
  project_folder_id?: string | null;
  project_id?: string | null;
  prompt?: string | null;
  instruction?: string | null;
  scheduled_at?: string | null;
  parent_run_id?: string | null;
  root_run_id?: string | null;
  runtime_profile_id?: string | null;
  runtime_profile_selection_source?: RuntimeProfileSelectionSource;
  capability_id?: string | null;
  capabilities_json?: unknown[] | null;
  model_override_json?: Record<string, unknown> | null;
  contract_snapshot?: import("./contractSnapshot").RunContractSnapshotInput;
  workflow_version_id?: string | null;
  visibility?: "private" | "space_shared" | "selected_users";
  grantee_user_ids?: string[];
  /**
   * Tool allowance for a Run whose permission comes from the scenario it was
   * opened in rather than from the Agent's own standing permissions — see
   * `modules/systemActions/scenarioToolAllowance.ts`. When present it
   * replaces the AgentVersion's `tool_permissions_json` as the allowance
   * side of the grant intersection; the intersection itself, and its
   * fail-closed behaviour, are unchanged.
   */
  scenario_tool_allowance?: readonly string[] | null;
  /** Internal-only authority marker. Only Room dispatch may run the managed Assistant. */
  allow_system_assistant?: boolean;
}

export interface DelegatedChildRunCreateInput {
  agent_id: string;
  space_id: string;
  user_id: string;
  parent_run_id: string;
  root_run_id: string;
  run_group_id: string;
  delegation_id: string;
  instructed_by_agent_id: string;
  session_id?: string | null;
  project_folder_id?: string | null;
  project_id?: string | null;
  prompt?: string | null;
  instruction?: string | null;
  scheduled_at?: string | null;
  runtime_profile_id?: string | null;
  runtime_profile_selection_source?: RuntimeProfileSelectionSource;
  capability_id?: string | null;
  capabilities_json?: unknown[] | null;
  model_override_json?: Record<string, unknown> | null;
  budget_json?: Record<string, unknown> | null;
  context_policy_json?: Record<string, unknown> | null;
  contract_snapshot?: import("./contractSnapshot").RunContractSnapshotInput;
  visibility?: "private" | "space_shared" | "selected_users";
  grantee_user_ids?: string[];
  /** Internal-only authority marker propagated from a Room-backed group. */
  allow_system_assistant?: boolean;
}

export class RunCreateValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 422,
  ) {
    super(message);
    this.name = "RunCreateValidationError";
  }
}

export interface RunTerminalUpdate {
  run_id: string;
  space_id: string;
  status: "succeeded" | "failed" | "degraded" | "cancelled" | "orphaned";
  output_text?: string | null;
  output_json?: unknown;
  error_json?: unknown;
  exit_code?: number | null;
  completed_at: string;
}

export interface ConversationRuntimeTerminalSync {
  binding_id: string;
  runtime_state_key: string;
  keep_session: boolean;
  runtime_session_id: string | null;
  context_fingerprint: string | null;
  message_cursor_id?: string | null;
}

export interface RunAttemptRecord {
  id: string;
  space_id: string;
  run_id: string;
  attempt_number: number;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  last_activity_at: string | null;
  cancel_requested_at: string | null;
  cancel_confirmed_at: string | null;
  exit_code: number | null;
  error_code: string | null;
  error_json: unknown;
  created_at: string;
  updated_at: string;
}

export interface RunEventRecord {
  id: string;
  space_id: string;
  run_id: string;
  event_index: number;
  event_type: string;
  status: string;
}

export interface RunChatResultRecord {
  id: string;
  space_id: string;
  status: string;
  output_json: unknown;
  error_json: unknown;
}

export interface RunEventInput {
  run_id: string;
  space_id: string;
  event_type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "warning" | "cancelled";
  step_id?: string | null;
  actor_id?: string | null;
  summary?: string | null;
  metadata_json?: unknown;
  error_code?: string | null;
  error_message?: string | null;
  project_folder_id?: string | null;
  artifact_id?: string | null;
  proposal_id?: string | null;
  data_exposure_level?: string | null;
  trust_level?: string | null;
}

export interface RunStepRecord {
  id: string;
  space_id: string;
  run_id: string;
  step_index: number;
  step_type: string;
  status: string;
}

export interface RunStepInput {
  run_id: string;
  space_id: string;
  actor_id: string;
  step_type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  title?: string | null;
  parent_step_id?: string | null;
  project_folder_id?: string | null;
  session_id?: string | null;
  task_id?: string | null;
  artifact_id?: string | null;
  proposal_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  input_summary?: string | null;
  output_summary?: string | null;
  error_type?: string | null;
  error_message?: string | null;
  metadata_json?: unknown;
}

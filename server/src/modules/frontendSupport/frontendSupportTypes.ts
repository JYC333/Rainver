export interface HomeSummaryOut {
  operations_in_progress:Array<{id:string;project_id:string;project_name:string;kind:string;title:string;status:string;progress_json:Record<string,unknown>;updated_at:string}>;
  recent_runs: HomeRunSummaryItem[];
  active_runs: HomeRunSummaryItem[];
  pending_proposals: {
    count: number;
    items: HomePendingProposalItem[];
  };
  recent_artifacts: HomeArtifactSummaryItem[];
  task_summary: {
    by_status: Record<string, number>;
    total_open: number;
    needs_review_count: number;
    blocked_count: number;
    done_count: number;
  };
  active_tasks: HomeActiveTaskItem[];
  activity_summary: {
    recent_count: number;
    raw_count: number;
    today_count: number;
  };
  run_stats_today: {
    created: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    dry_run_count: number;
  };
  job_queue_status: {
    queued: number;
    running: number;
    failed: number;
    retryable: number;
    recent_error_preview: string | null;
  };
  runtime_status: {
    real_adapters_configured_count: number;
    configured_runtime_keys: string[];
    message: string;
  };
  model_provider_status: {
    model_providers_count: number;
    enabled_model_providers_count: number;
    missing_model_provider_config: boolean;
    message: string;
  };
  suggested_actions: Array<{
    id: string;
    label: string;
    reason: string;
    target_path: string;
    priority: "high" | "normal" | "low";
  }>;
  source_summary: {
    open_items: number;
    new_items_today: number;
    pending_extraction_jobs: number;
    failed_extraction_jobs: number;
    candidate_evidence: number;
    active_evidence: number;
    due_connections: number;
  };
}

export interface MeSummaryOut {
  pending_proposals_count: number;
  assigned_tasks_count: number;
  recent_runs: MeRecentRunItem[];
  recent_participation: MeRecentParticipationItem[];
  accessible_spaces_count: number;
  spaces: MeSpaceRollup[];
}

export interface MeTimelineEntry {
  id: string;
  entry_type: string;
  source_space_id: string | null;
  source_object_type: string | null;
  source_object_id: string | null;
  role: string | null;
  occurred_at: string;
  created_at: string;
}

export interface MePendingProposalItem {
  id: string;
  space_id: string;
  proposal_type: string;
  status: string;
  urgency: string;
  title: string;
  visibility: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface HomeRunSummaryItem {
  id: string;
  status: string;
  mode: string;
  run_type: string;
  agent_id: string;
  task_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_text: string | null;
  visibility: string;
}

export interface HomePendingProposalItem {
  id: string;
  title: string;
  proposal_type: string;
  status: string;
  risk_level: string;
  urgency: string;
  review_deadline: string | null;
  expires_at: string | null;
  expired: boolean;
  preview: boolean;
  created_by_run_id: string | null;
  visibility: string;
}

export interface HomeArtifactSummaryItem {
  id: string;
  title: string;
  artifact_type: string;
  preview: boolean;
  run_id: string | null;
  created_at: string;
  visibility: string;
}

export interface HomeActiveTaskItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  risk_level: string;
  task_type: string;
  assigned_user_id: string | null;
  assigned_agent_id: string | null;
  due_at: string | null;
  updated_at: string;
  visibility: string;
}

export interface MeRecentRunItem {
  id: string;
  space_id: string;
  agent_id: string;
  status: string;
  mode: string;
  run_type: string;
  created_at: string;
  updated_at: string;
}

export interface MeRecentParticipationItem {
  id: string;
  user_id: string;
  personal_space_id: string;
  source_space_id: string;
  source_object_type: string;
  source_object_id: string;
  role: string;
  occurred_at: string;
  created_at: string;
}

export interface MeSpaceRollup {
  space_id: string;
  name: string;
  type: string;
  pending_proposals_count: number;
  assigned_tasks_count: number;
  recent_failed_runs_count: number;
}

export type QueryParams = Record<string, string | undefined>;

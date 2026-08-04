export interface EvolutionTargetRow {
  id: string;
  space_id: string | null;
  target_type: string;
  target_ref_type: string | null;
  target_ref_id: string | null;
  capability_key: string | null;
  current_version_id: string | null;
  risk_level: string;
  status: string;
  enabled: boolean;
  engine_policy_json: unknown;
  metadata_json: unknown;
  created_at: unknown;
  updated_at: unknown;
  recent_signal_count?: string | number;
  last_run_at?: unknown;
}

export interface EvolutionSignalRow {
  id: string;
  space_id: string | null;
  target_id: string;
  target_name: string | null;
  target_type: string | null;
  capability_key: string | null;
  signal_type: string;
  source_type: string;
  source_id: string | null;
  severity: string;
  summary: string | null;
  payload_json: unknown;
  triage_status?: string;
  triaged_at?: unknown;
  triaged_by_user_id?: string | null;
  triage_note?: string | null;
  created_at: unknown;
}

export interface EvolutionStrategyAssetRow {
  id: string;
  space_id: string | null;
  strategy_key: string;
  name: string;
  description: string | null;
  category: string;
  target_type: string;
  status: string;
  risk_level: string;
  signals_match_json: unknown;
  preconditions_json: unknown;
  strategy_steps_json: unknown;
  constraints_json: unknown;
  validation_policy_json: unknown;
  tool_policy_json: unknown;
  routing_hint_json: unknown;
  provenance_type: string;
  source_ref_json: unknown;
  success_count: string | number;
  failure_count: string | number;
  confidence_score: string | number;
  last_selected_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface EvolutionSelectorDecisionRow {
  id: string;
  space_id: string;
  target_id: string;
  target_name: string | null;
  target_type: string | null;
  run_id: string | null;
  selected_strategy_asset_id: string | null;
  selected_strategy_key: string | null;
  selected_strategy_name: string | null;
  candidate_strategy_ids_json: unknown;
  input_signal_ids_json: unknown;
  decision_reason: string | null;
  score_trace_json: unknown;
  rejected_reasons_json: unknown;
  created_at: unknown;
}

export interface EvolutionExperienceRow {
  id: string;
  space_id: string;
  strategy_asset_id: string | null;
  strategy_key: string | null;
  strategy_name: string | null;
  target_id: string | null;
  target_name: string | null;
  source_run_id: string | null;
  source_proposal_id: string | null;
  experience_key: string;
  summary: string;
  trigger_signals_json: unknown;
  outcome_status: string;
  confidence_score: string | number;
  blast_radius_json: unknown;
  validation_trace_json: unknown;
  execution_trace_json: unknown;
  lessons_json: unknown;
  anti_patterns_json: unknown;
  environment_fingerprint_json: unknown;
  provenance_type: string;
  created_at: unknown;
}

export interface EvolutionValidationResultRow {
  metric_id: string;
  label: string;
  evaluator: string;
  target_id: string;
  target_name: string | null;
  value: unknown | null;
  status: string;
  window: string | null;
  goal: Record<string, unknown>;
  sample_size: number;
  numerator_count: number | null;
  denominator_count: number | null;
  updated_at: string | null;
  metadata_json: Record<string, unknown>;
}

export interface EvolutionRunExperienceContext {
  spaceId: string;
  runId: string;
  targetId: string | null;
  targetName: string | null;
  strategyAssetId: string | null;
  strategyKey: string | null;
  strategyName: string | null;
  inputSignalIds: unknown[];
  decisionReason: string | null;
}

export interface EvolutionRunSetupRecord {
  runId: string;
  targetId: string;
  agentId: string;
  selectorDecisionId: string;
  selectedStrategyAssetId: string | null;
  selectedStrategyKey: string | null;
  signalId: string | null;
}

export interface EvolutionSelection {
  selectedStrategy: EvolutionStrategyAssetRow | null;
  candidateStrategyIds: string[];
  inputSignalIds: string[];
  decisionReason: string;
  scoreTrace: Record<string, unknown>;
  rejectedReasons: Array<Record<string, unknown>>;
}

export interface EvolutionExperienceCreateInput {
  spaceId: string;
  strategyAssetId?: string | null;
  targetId?: string | null;
  sourceRunId?: string | null;
  sourceProposalId?: string | null;
  experienceKey: string;
  summary: string;
  triggerSignals?: unknown[];
  outcomeStatus: "success" | "failed" | "partial" | "unknown";
  confidenceScore?: number;
  blastRadius?: Record<string, unknown>;
  validationTrace?: Record<string, unknown>;
  executionTrace?: Record<string, unknown>;
  lessons?: unknown[];
  antiPatterns?: unknown[];
  environmentFingerprint?: Record<string, unknown>;
  provenanceType: "run_observed" | "proposal_accepted" | "imported" | "user_authored";
}

export const TARGET_COLUMNS = `
  id, space_id, target_type, target_ref_type, target_ref_id, capability_key,
  current_version_id, risk_level, status, enabled, engine_policy_json,
  metadata_json, created_at, updated_at
`;

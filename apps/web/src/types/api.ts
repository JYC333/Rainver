// API response shapes shared with the server HTTP contracts.
export type {
  InquiryAttentionState,
  InquiryCandidate,
  InquiryCandidateDecision,
  InquiryCandidateStatus,
  InquiryDeltaBriefContent,
  InquiryDeltaGapChange,
  InquiryDeltaPositionChange,
  InquiryEvidenceSignal,
  InquiryIteration,
  InquiryLifecycleStatus,
  InquiryNextFocusKind,
  InquiryReviewPacket,
  InquiryThread,
  InquiryThreadAdvice,
  InquiryThreadKind,
} from '@agent-space/protocol'
import type {
  InquiryThread,
} from '@agent-space/protocol'

export type SpaceType      = 'personal' | 'household' | 'team'

export interface CustomSourceCredentialDTO {
  id: string
  space_id: string
  owner_user_id?: string | null
  name: string
  header_name: string
  header_value_prefix: string
  created_at: string
  updated_at: string
}

export interface ResearchChecklistItem { id: string; text: string; status: 'open' | 'done' | 'dismissed'; sort_order: number; origin: 'user' | 'agent'; origin_run_id: string | null; created_at: string; updated_at: string }
export interface ResearchPaperCard { id: string; source_item_id: string; object_id: string | null; why_md: string; how_md: string; what_md: string; edited_by_user: boolean; stance: 'supports' | 'contradicts' | 'new_direction' | null; comparison_detail: string | null }
/**
 * A project's "notebook" is ordinary Notes filed under its auto-created
 * Knowledge Notes folder (see notebookNotes.ts / areaService.ts on the
 * server) — free-form, not a fixed set of sections. `notes` here is the
 * light listing shape used for the Area overview and AI prompt
 * grounding; the Notebook tab fetches full `Note` objects via `notesApi`
 * for editing.
 */
export interface ResearchArea {
  notes_collection_id: string
  notes: Array<{ id: string; title: string; version: number; content_json: Record<string, unknown> }>
  checklist: ResearchChecklistItem[]
  reports: Array<{ id: string; research_question: string; research_question_version: number; status: string; run_kind: string; created_at: string }>
}
export interface ResearchReadingList { items: Array<ProjectCorpusItem & { paper_card: ResearchPaperCard | null }>; total: number; limit: number; offset: number }
export type MemberRole     = 'owner' | 'admin' | 'reviewer' | 'member' | 'guest' | 'viewer'
export type InviteStatus   = 'pending' | 'accepted' | 'revoked' | 'expired'
/** Immutable after Space creation; personal Spaces are always 'none'. */
export type SpaceOversightMode = 'none' | 'summary' | 'content' | 'full'

export interface CurrentUser {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  is_instance_admin?: boolean
  default_space_id: string | null
  created_at: string
  last_login_at: string | null
}

export interface SpaceWithMembership {
  id: string
  name: string
  type: SpaceType
  role: MemberRole
  oversight_mode: SpaceOversightMode
  created_at: string
  updated_at: string
}

export interface SpaceSnapshotDefaults {
  snapshot_retention_days_default: number | null
  snapshot_max_count_default: number | null
}

export interface SpaceMember {
  user_id: string
  email: string
  display_name: string
  avatar_url: string | null
  role: MemberRole
  joined_at: string
}

export interface SpaceInvitationOut {
  id: string
  space_id: string
  invited_email: string
  role: MemberRole
  token: string
  status: InviteStatus
  expires_at: string
}

export type MemoryType       = 'preference' | 'semantic' | 'episodic' | 'procedural' | 'project'
export type MemoryScope      = 'user' | 'project_folder' | 'capability' | 'agent' | 'system' | 'space'
export type MemoryStatus     = 'active' | 'archived' | 'proposed' | 'rejected' | 'superseded'
export type ContentVisibility = 'private' | 'space_shared' | 'selected_users'
export type ContentAccessLevel = 'full' | 'summary'
export interface ContentAccessGrantOut {
  user_id: string
  access_level: ContentAccessLevel
  created_at: string
  updated_at: string
}
export interface ContentAccessPolicy {
  resource_type: string
  resource_id: string
  space_id: string
  owner_user_id: string | null
  visibility: ContentVisibility
  access_level: ContentAccessLevel
  project_folder_id: string | null
  project_id: string | null
  grants: ContentAccessGrantOut[]
}
export interface ContentAccessUpdate {
  visibility: ContentVisibility
  access_level: ContentAccessLevel
  grants: Array<{ user_id: string; access_level: ContentAccessLevel }>
}
export type MemoryVisibility = ContentVisibility
export type ObjectVisibility = ContentVisibility
export type ProposalStatus   = 'pending' | 'accepted' | 'rejected'
export type KnowledgeItemKind =
  | 'concept'
  | 'lesson'
  | 'procedure'
  | 'decision'
  | 'question'
  | 'answer'
  | 'summary'
export type KnowledgeContentFormat = 'markdown' | 'plain' | 'prosemirror_json'
export type KnowledgeItemStatus = 'draft' | 'active' | 'superseded' | 'archived'
export type KnowledgeVisibility = ContentVisibility
export type KnowledgeVerificationStatus = 'unverified' | 'needs_review' | 'verified'
export type KnowledgeReflectionStatus = 'unreviewed' | 'reviewed' | 'distilled'
export type KnowledgeRelationType =
  | 'related_to'
  | 'explains'
  | 'depends_on'
  | 'prerequisite_of'
  | 'part_of'
  | 'example_of'
  | 'applies_to'
  | 'supports'
  | 'contradicts'
  | 'derived_from'
  | 'summarizes'
  | 'updates'
export type KnowledgeRelationStatus = 'candidate' | 'active' | 'rejected' | 'archived'
export type RetrievalObjectType =
  | 'knowledge_item'
  | 'note'
  | 'source'
  | 'claim'
  | 'memory_entry'
  | 'project_public_summary'
  | 'source_item'
  | 'extracted_evidence'
export const SPACE_OBJECT_KIND_KEYS_BY_BASE_OBJECT_TYPE = {
  knowledge_item: ['concept', 'lesson', 'procedure', 'decision', 'question', 'answer', 'summary'],
  note: ['note'],
  source: ['activity_record', 'chat_capture', 'webpage', 'article', 'paper', 'pdf', 'file', 'email', 'manual_reference', 'external_note'],
  claim: ['fact', 'hypothesis', 'belief', 'preference', 'commitment', 'question', 'interpretation', 'instruction', 'metric', 'relationship', 'event'],
  memory_entry: ['preference', 'semantic', 'episodic', 'procedural', 'project'],
  project_public_summary: ['project_public_summary'],
  source_item: ['external_url', 'feed_entry', 'activity_record', 'artifact', 'run_event', 'file', 'document', 'log'],
  extracted_evidence: ['document', 'excerpt', 'event', 'log', 'artifact', 'claim', 'summary'],
} as const satisfies Record<RetrievalObjectType, readonly string[]>
export type SpaceObjectKindStatus = 'draft' | 'active' | 'deprecated' | 'archived'
export type SpaceObjectKindRelationHintDirection = 'from' | 'to' | 'either'
export type SpaceObjectKindRelationHintRelationType =
  | 'related_to'
  | 'explains'
  | 'depends_on'
  | 'prerequisite_of'
  | 'part_of'
  | 'example_of'
  | 'applies_to'
  | 'supports'
  | 'contradicts'
  | 'derived_from'
  | 'summarizes'
  | 'updates'
  | 'references'
  | 'source_for'
  | 'about'
  | 'supersedes'
  | 'refines'
  | 'same_as'
export type RetrievalSearchMode = 'exact' | 'lexical' | 'hybrid' | 'hybrid_rerank'
export type RetrievalEvidenceKind =
  | 'alias_hit'
  | 'exact_title_match'
  | 'slug_match'
  | 'source_url_match'
  | 'lexical_match'
  | 'vector_match'
  | 'graph_neighbor'
  | 'weak_match'
export interface RetrievalEvidence {
  kind: RetrievalEvidenceKind
  field?: string
  matched_text?: string
  source?: string
  confidence?: number
  [key: string]: unknown
}
export interface RetrievalSearchRequest {
  query: string
  object_types?: RetrievalObjectType[]
  object_kinds?: string[]
  max_results?: number
  include_trace?: boolean
  mode?: RetrievalSearchMode
  rewrite?: boolean
  use_cache?: boolean
  adaptive_return?: boolean
}
export interface RetrievalSearchResult {
  object_type: RetrievalObjectType
  object_id: string
  object_kind?: string | null
  object_kind_label?: string | null
  title: string
  snippet: string | null
  score: number
  evidence: RetrievalEvidence
  create_safety?: 'exists' | 'probable_duplicate' | 'unknown'
  matched_fields: string[]
  source_refs?: Array<Record<string, unknown>>
  trace?: Record<string, unknown>
}
export interface RetrievalSearchResponse {
  items: RetrievalSearchResult[]
  total: number
  rewrite_items?: RetrievalSearchResult[]
  rewrite_total?: number
  trace?: Record<string, unknown>
}
export interface RetrievalCitation {
  object_type: RetrievalObjectType
  object_id: string
  object_kind?: string | null
  object_kind_label?: string | null
  title: string
  [key: string]: unknown
}
export interface RetrievalGapItem {
  object_type: RetrievalObjectType
  object_id: string
  object_kind?: string | null
  object_kind_label?: string | null
  title: string
  reason: string
  [key: string]: unknown
}
export interface RetrievalGapAnalysis {
  stale: RetrievalGapItem[]
  thin: RetrievalGapItem[]
  low_coverage: boolean
  uncited_claims: string[]
  contradictions: string[]
  missing_topics: string[]
  [key: string]: unknown
}
export interface RetrievalBrief {
  answer: string | null
  synthesized: boolean
  citations: RetrievalCitation[]
  gap_analysis: RetrievalGapAnalysis
  [key: string]: unknown
}
export interface RetrievalBriefRequest {
  query: string
  object_types?: RetrievalObjectType[]
  object_kinds?: string[]
  max_results?: number
  include_trace?: boolean
  mode?: RetrievalSearchMode
  adaptive_return?: boolean
  persist_artifact?: boolean
}

export interface SpaceObjectKindOut {
  id: string
  space_id: string
  key: string
  label: string
  description: string | null
  base_object_type: RetrievalObjectType
  status: SpaceObjectKindStatus
  version: number
  field_schema: Record<string, unknown>
  extraction_policy: Record<string, unknown>
  retrieval_policy: Record<string, unknown>
  ui_config: Record<string, unknown>
  relation_hints?: Array<SpaceObjectKindRelationHintRequest & { id: string }>
  created_by_user_id?: string | null
  created_from_proposal_id?: string | null
  updated_from_proposal_id?: string | null
  created_at: string
  updated_at: string
}

export interface SpaceObjectKindRelationHintRequest {
  endpoint_object_type: RetrievalObjectType
  endpoint_object_kind_id?: string | null
  relation_type: SpaceObjectKindRelationHintRelationType
  direction?: SpaceObjectKindRelationHintDirection
  confidence_default?: number
  required?: boolean
}

export interface ObjectSchemaManifestRelationHint {
  endpoint_object_type: RetrievalObjectType
  endpoint_object_kind_key?: string | null
  relation_type: SpaceObjectKindRelationHintRelationType
  direction?: SpaceObjectKindRelationHintDirection
  confidence_default?: number
  required?: boolean
}

export interface ObjectSchemaManifestKind {
  key: string
  label: string
  description?: string | null
  base_object_type: RetrievalObjectType
  status?: SpaceObjectKindStatus
  version?: number
  field_schema?: Record<string, unknown>
  extraction_policy?: Record<string, unknown>
  retrieval_policy?: Record<string, unknown>
  ui_config?: Record<string, unknown>
  relation_hints?: ObjectSchemaManifestRelationHint[]
}

export interface ObjectSchemaExportManifest {
  format: 'agent_space.object_schema.v1'
  exported_at: string
  object_schema_version: number
  object_kinds: ObjectSchemaManifestKind[]
  metadata?: Record<string, unknown>
}

export interface ObjectSchemaImportRequest {
  manifest: ObjectSchemaExportManifest
  rationale?: string
}

export interface ObjectSchemaImportResponse {
  created_proposal_count: number
  skipped_count: number
  proposal_ids: string[]
  skipped: Array<Record<string, unknown>>
  warnings: string[]
}

export interface ObjectSchemaSuggestionScanRequest {
  base_object_types?: RetrievalObjectType[]
  limit?: number
  persist_artifact?: boolean
  review_scope?: 'private' | 'space_ops'
}

export interface ObjectSchemaSuggestionFinding {
  id: string
  kind: 'missing_object_kind' | 'deprecated_kind_usage' | 'unused_active_kind'
  base_object_type: RetrievalObjectType
  object_kind: string
  title: string
  reason: string
  confidence_tier: 'high' | 'medium' | 'low'
  visible_usage_count: number
  proposed_action: Record<string, unknown> | null
  evidence_refs: Array<Record<string, unknown>>
  markers: Record<string, unknown>
}

export interface ObjectSchemaSuggestionReport {
  findings: ObjectSchemaSuggestionFinding[]
  counts: Record<string, number>
  scanned: {
    visible_usage_rows: number
    registry_rows: number
  }
  truncated: boolean
  access_safety: Record<string, unknown>
}

export interface ObjectSchemaSuggestionScanResponse {
  report: ObjectSchemaSuggestionReport
  finding_count: number
  artifact_id?: string
}

export interface SpaceObjectKindPage {
  items: SpaceObjectKindOut[]
  total: number
  limit: number
  offset: number
}

export interface SpaceObjectKindCreateProposalRequest {
  key: string
  label: string
  description?: string | null
  base_object_type: RetrievalObjectType
  status?: 'draft' | 'active'
  field_schema?: Record<string, unknown>
  extraction_policy?: Record<string, unknown>
  retrieval_policy?: Record<string, unknown>
  ui_config?: Record<string, unknown>
  relation_hints?: SpaceObjectKindRelationHintRequest[]
  rationale?: string
}

export interface SpaceObjectKindUpdateProposalRequest {
  label?: string
  description?: string | null
  status?: 'active'
  field_schema?: Record<string, unknown>
  extraction_policy?: Record<string, unknown>
  retrieval_policy?: Record<string, unknown>
  ui_config?: Record<string, unknown>
  relation_hints?: SpaceObjectKindRelationHintRequest[]
  rationale?: string
}
export interface RetrievalBriefResponse {
  brief: RetrievalBrief
  items: RetrievalSearchResult[]
  total: number
  trace?: Record<string, unknown>
  artifact_id?: string
  artifact_error?: string
}
// ── Ask Space (Slice A) ─────────────────────────────────────────────────
export type AskSpaceDomain = 'knowledge' | 'memory' | 'project' | 'source' | 'inquiry'
export interface AskSpaceRequest {
  query: string
  domains?: AskSpaceDomain[]
  max_results_per_domain?: number
  mode?: RetrievalSearchMode
  include_trace?: boolean
  adaptive_return?: boolean
  persist?: boolean
  combine?: boolean
  combine_include_memory?: boolean
  include_claim_trajectory?: boolean
}
export interface AskSpaceClaimTrajectorySignal {
  kind: string
  from_claim_id: string
  to_claim_id: string
  summary: string
  confidence_tier: 'high' | 'medium' | 'low'
}
export interface AskSpaceClaimTrajectory {
  claim_id: string
  subject_object_id: string | null
  subject_text: string | null
  signals: AskSpaceClaimTrajectorySignal[]
}
export interface AskSpaceDomainSection {
  domain: AskSpaceDomain
  object_types: RetrievalObjectType[]
  brief: RetrievalBrief | null
  items: RetrievalSearchResult[]
  total: number
  artifact_id?: string
  artifact_error?: string
  error_code?: string
}
export interface AskSpaceGapSummary {
  stale_count: number
  thin_count: number
  low_coverage_domains: AskSpaceDomain[]
  uncited_claim_count: number
  contradiction_count: number
  missing_topic_count: number
}
export interface AskSpaceProvenanceItem {
  domain: AskSpaceDomain
  object_type: RetrievalObjectType
  object_id: string
  title: string
}
export type AskSpaceFollowUpKind = 'claim_candidate_packet' | 'maintenance_scan'
export interface AskSpaceFollowUp {
  kind: AskSpaceFollowUpKind
  label: string
  reason?: string
  source_artifact_ids: string[]
}
export interface AskSpaceResponse {
  generated_at: string
  space_id: string
  query: string
  requested_domains: AskSpaceDomain[]
  domains: AskSpaceDomainSection[]
  synthesized: boolean
  combined_answer: string | null
  gap_summary: AskSpaceGapSummary
  provenance: AskSpaceProvenanceItem[]
  claim_trajectories: AskSpaceClaimTrajectory[]
  follow_ups: AskSpaceFollowUp[]
  session_artifact_id?: string
  session_artifact_error?: string
  canonical_write_performed: false
}

export interface RetrievalDiagnosticsReportRequest {
  window_days?: number
  limit?: number
  report_label?: string
  include_maintenance_reports?: boolean
  compare_previous_window?: boolean
  create_packet?: boolean
  review_scope?: 'private' | 'space_ops'
}
export interface RetrievalDiagnosticsReportResponse {
  artifact_id: string
  counts: Record<string, number>
  diagnostic_codes: string[]
  proposal_id?: string
}
export type RetrievalCalibrationMechanic =
  | 'visible_edge_backlink'
  | 'candidate_owned_salience'
  | 'richer_dedup'
  | 'autocut'
  | 'semantic_results_cache'
export type RetrievalCalibrationDecisionValue = 'adopt' | 'defer' | 'reject'
export type RetrievalRankingMechanicState = 'disabled' | 'adopted' | 'shipped'
export interface RetrievalRuntimeMechanicConfig {
  state: RetrievalRankingMechanicState
  calibration_artifact_id?: string | null
  shipped_at?: string | null
  eval_gate: {
    status: 'not_run' | 'passed' | 'failed'
    metric?: string | null
    value?: number | null
    threshold: number
    checked_at?: string | null
  }
}
export interface RetrievalRuntimeRankingConfig {
  version: 1
  eval_gate: {
    min_primary_metric_delta: number
    required_evidence_artifacts: number
  }
  mechanics: Record<RetrievalCalibrationMechanic, RetrievalRuntimeMechanicConfig>
}
export interface RetrievalCalibrationDecision {
  mechanic: RetrievalCalibrationMechanic
  decision: RetrievalCalibrationDecisionValue
  access_safety_proof: string
  eval_delta?: Record<string, number>
  evidence_artifact_ids?: string[]
  rationale?: string
  guardrails?: string[]
}
export interface RetrievalCalibrationDecisionRequest {
  report_label?: string
  suite?: string
  decisions: RetrievalCalibrationDecision[]
  review_scope?: 'private' | 'space_ops'
}
export interface RetrievalCalibrationDecisionResponse {
  artifact_id: string
  decision_count: number
}
export interface RetrievalMaintenanceScanRequest {
  persist_report?: boolean
  create_packet?: boolean
  review_scope?: 'private' | 'space_ops'
}
export interface RetrievalMaintenanceScanResponse {
  counts: Record<string, number>
  scanned: number
  truncated: boolean
  artifact_id?: string
  proposal_id?: string
}
// Slice E — claim contradiction discovery scan.
export interface ClaimContradictionScanRequest {
  subject_object_id?: string
  limit?: number
  max_findings?: number
  review_scope?: 'private' | 'space_ops'
  create_packet?: boolean
  llm_judge_enabled?: boolean
}
export interface ClaimContradictionScanResponse {
  report: { findings: unknown[]; counts: Record<string, number>; truncated: boolean }
  artifact_id?: string
  candidate_packet_proposal_id?: string
  candidate_packet_artifact_id?: string
  candidate_count?: number
}

// Slice F — candidate-relation discovery scan.
export interface RelationDiscoveryScanRequest {
  source_object_types?: ('knowledge_item' | 'note' | 'activity' | 'artifact')[]
  limit?: number
  max_candidates?: number
  review_scope?: 'private' | 'space_ops'
  include_unresolved_item_candidates?: boolean
  llm_extraction_enabled?: boolean
  llm_max_sources?: number
  create_packet?: boolean
}
export interface RelationDiscoveryScanResponse {
  report: { candidates: unknown[]; counts: Record<string, number>; sources_scanned: number; truncated: boolean }
  artifact_id?: string
  proposal_id?: string
  candidate_count: number
  proposal_candidate_count: number
  review_only_candidate_count: number
}

export interface RetrievalExplainRequest {
  query: string
  object_type: RetrievalObjectType
  object_id: string
  object_types?: RetrievalObjectType[]
  max_results?: number
  mode?: RetrievalSearchMode
  rewrite?: boolean
  use_cache?: boolean
  adaptive_return?: boolean
  persist_artifact?: boolean
}
export interface RetrievalExplainResponse {
  target: {
    object_type: RetrievalObjectType
    object_id: string
    title: string
    visible: true
    returned: boolean
    rank?: number
    score?: number
    score_bucket?: string
  }
  match: {
    matched_fields: string[]
    evidence_kind?: RetrievalEvidenceKind
    evidence_field?: string
    evidence_source?: string
    evidence_confidence?: number
    create_safety?: 'exists' | 'probable_duplicate' | 'unknown'
  }
  trace: {
    arms: Record<string, number>
    dropped: number
    dropped_reasons: Record<string, number>
    mode?: RetrievalSearchMode
    intent?: string
    rerank?: Record<string, unknown>
    rewrite?: Record<string, unknown>
    graph?: Record<string, unknown>
    relational?: Record<string, unknown>
    synthesis?: Record<string, unknown>
  }
  diagnostic_codes: string[]
  artifact_id?: string
}
export interface SpaceRetrievalSettings {
  space_id: string
  default_search_mode: RetrievalSearchMode
  rerank_enabled: boolean
  query_rewrite_enabled: boolean
  query_rewrite_default: boolean
  use_query_cache: boolean
  include_trace: boolean
  external_egress_enabled: boolean
  retrieval_tool_mode: RetrievalToolMode
  context_ops_review_mode: ContextOpsReviewMode
  context_ops_scan_mode: ContextOpsScanMode
  embedding_dimensions: number
  max_results_default: number
  ranking_config: RetrievalRuntimeRankingConfig
  created_at: string
  updated_at: string
}
export type RetrievalToolMode = 'off' | 'manual_tool_only' | 'preflight_search' | 'preflight_brief'
export type ContextOpsReviewMode = 'private_only' | 'admins' | 'members'
export type ContextOpsScanMode = 'admins' | 'members'
export type SpaceRetrievalSettingsUpdate = Partial<Pick<
  SpaceRetrievalSettings,
  | 'default_search_mode'
  | 'rerank_enabled'
  | 'query_rewrite_enabled'
  | 'query_rewrite_default'
  | 'use_query_cache'
  | 'include_trace'
  | 'external_egress_enabled'
  | 'retrieval_tool_mode'
  | 'context_ops_review_mode'
  | 'context_ops_scan_mode'
  | 'embedding_dimensions'
  | 'max_results_default'
  | 'ranking_config'
>>
export type RetrievalFeedbackSignal = 'opened' | 'dwell' | 'used' | 'explicit_relevant' | 'accepted' | 'pinned'
export interface RetrievalFeedbackRequest {
  query: string
  object_type: RetrievalObjectType
  object_id: string
  signal_type: RetrievalFeedbackSignal
  dwell_ms?: number
  metadata?: {
    source?: 'result_open' | 'dwell_timer' | 'explicit_action'
  }
}
export interface RetrievalFeedbackResponse {
  ok: true
}
export type ActivityStatus     = 'raw' | 'processed' | 'proposals_generated' | 'failed' | 'archived'
export type ActivitySourceType =
  | 'user_capture'
  | 'chat_message'
  | 'external_chat'
  | 'file_import'
  | 'web_capture'
  | 'run_event'
  | 'project_folder_event'
  | 'system_event'
  | 'external_source'
  | 'source'
export type SessionStatus    = 'active' | 'closed'
/** Canonical run lifecycle (Run API). */
export type RunLifecycleStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'degraded'
  | 'waiting_for_review'
  | 'waiting_for_dependency'

export interface AuthorizationRequest {
  id: string
  space_id: string
  run_id: string
  agent_id: string
  instructed_by_user_id: string
  policy_decision_record_id: string
  action_id: string
  policy_action: string
  project_id: string | null
  resource_kind: string | null
  resource_id: string | null
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  resulting_action_grant_id: string | null
  decided_by_user_id: string | null
  requested_at: string
  decided_at: string | null
}

export type MessageRole      = 'user' | 'assistant' | 'system' | 'tool'

export type ModelSelectionMode = 'cli_default' | 'cli_model_override' | 'agent_space_provider'

export interface RuntimeToolManifest {
  schema_version: 1
  runtime: string
  source: 'npm'
  package_name: string
  requested_version: string
  version: string
  bin_name: string
  bin_relative_path: string
  installed_at: string
}

export interface RuntimeToolDefinition {
  runtime: string
  label: string
  source: 'npm'
  package_name: string
  bin_name: string
  bin_relative_path: string
  package_json_relative_path: string
  default_version: string
}

export interface RuntimeToolStatus {
  runtime: string
  label: string
  source: 'npm'
  package_name: string
  bin_name: string
  installed: boolean
  active_version: string | null
  executable_path: string | null
  executable_exists: boolean
  manifest: RuntimeToolManifest | null
  installed_versions: RuntimeToolInstalledVersion[]
  warnings: string[]
}

export interface RuntimeToolInstalledVersion {
  version: string
  installed: boolean
  executable_path: string | null
  executable_exists: boolean
  manifest: RuntimeToolManifest | null
  warnings: string[]
}

export interface RuntimeToolInstallResult extends RuntimeToolStatus {
  installed_version: string
  activated: boolean
}

export interface RuntimeToolLatest {
  runtime: string
  package_name: string
  latest_version: string | null
}

export interface SpaceRuntimeToolPolicyOut {
  runtime: string
  label: string
  enabled: boolean
  default_version: string | null
  allowed_versions: string[]
  policy_id: string | null
  active_version: string | null
  installed_versions: RuntimeToolInstalledVersion[]
  warnings: string[]
  updated_by_user_id: string | null
  updated_at: string | null
}

// CLI Credentials / Login

export type LoginMethod = 'cli'

export interface CredentialLoginMethod {
  runtime: string
  method: LoginMethod
  label: string
  hint_cli: string
  supports_cli: boolean
}

export interface CredentialStatus {
  runtime: string
  label: string
  method: LoginMethod
  profile_id: string | null
  network_profile_id: string | null
  logged_in: boolean
  file_count: number
}

export type NetworkProfileMode = 'direct' | 'http_proxy'

export interface NetworkProfileOut {
  id: string
  space_id: string
  name: string
  mode: NetworkProfileMode
  proxy_url: string | null
  no_proxy: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface NetworkProfileCreateBody {
  name: string
  mode: NetworkProfileMode
  proxy_url?: string | null
  no_proxy?: string | null
  enabled?: boolean
}

export type NetworkProfileUpdateBody = Partial<NetworkProfileCreateBody>

export interface CliCredentialProfileOut {
  id: string
  owner_user_id?: string | null
  runtime: string
  name: string
  source_path: string
  target_path: string
  readonly: boolean
  notes: string
  network_profile_id: string | null
  source_exists: boolean
  logged_in: boolean
  file_count: number
  manageable?: boolean
  grant_id?: string | null
  grant_enabled?: boolean
  is_default?: boolean
}

export interface CliCredentialAvailableProfileOut {
  id: string
  owner_user_id?: string | null
  runtime: string
  name: string
  target_path: string
  readonly: boolean
  notes: string
  network_profile_id: string | null
  source_exists: boolean
  logged_in: boolean
  file_count: number
  manageable: boolean
  grant_id: string
  is_default: boolean
}

export interface TokenUsage {
  available: boolean
  source: 'transcripts' | 'codex_sessions' | 'unsupported'
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_usd: number
  message_count: number
  session_count: number
}

export interface QuotaUsage {
  available: boolean
  session_pct: number | null
  session_resets: string | null
  week_pct: number | null
  week_resets: string | null
  checked_at: string | null
  error: string | null
}

export interface CliUsageEntry {
  runtime: string
  label: string
  tokens: TokenUsage
  quota: QuotaUsage | null
}

export interface CliUsageAutoRefreshSettings {
  enabled: boolean
  interval_ms: number
  updated_at: string | null
}

export type LoginEventType = 'output' | 'error' | 'warning' | 'hint' | 'profile' | 'synced' | 'done' | 'needs_input' | 'device_auth'

export interface LoginEvent {
  type: LoginEventType
  text?: string
  exit_code?: number
  profile_id?: string
  prompt?: string
  step?: string
  url?: string
  code?: string
  expires_in_minutes?: number
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export interface SourceConnector {
  id: string
  connector_key: string
  display_name: string
  connector_type: string
  ingestion_mode: string
  status: string
  capabilities_json: Record<string, unknown>
  config_schema_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface SourceProvider {
  id: string
  provider_key: string
  display_name: string
  provider_kind: 'named' | 'generic'
  category: string
  status: 'active' | 'disabled'
  capabilities: Record<string, unknown>
  config_schema: Record<string, unknown> | null
  setup_schema?: SourceProviderSetupSchema | null
}

export interface SourceQueryPreview {
  provider_key: string
  compiled_query: string
  approximate_hit_count: number
  samples: Array<{ title: string; source_uri: string | null; occurred_at: string | null }>
}

export interface SourceProviderCategoryOption {
  value: string
  label: string
}

export interface SourceProviderCategoryGroup {
  group: string
  options: SourceProviderCategoryOption[]
}

export interface SourceProviderSetupSchema {
  category_groups?: SourceProviderCategoryGroup[]
}

export interface SourceCatalogProvider extends SourceProvider {
  connector_mapping: {
    id: string
    connector_key: string
    priority: number
    status: 'active' | 'disabled'
    capabilities: Record<string, unknown>
  } | null
}

export interface SourceCatalogMapping {
  id: string
  provider_id: string
  provider_key: string
  connector_id: string
  connector_key: string
  status: 'active' | 'disabled'
  priority: number
  capabilities_json: Record<string, unknown>
  config_schema_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface SourceCatalog {
  providers: SourceCatalogProvider[]
  connectors: SourceConnector[]
  mappings: SourceCatalogMapping[]
}

export interface SourceChannel {
  id: string
  space_id: string
  source_connection_id: string
  source_name: string
  name: string
  channel_type: 'search' | 'feed' | 'web_page' | 'custom_source'
  endpoint_url: string | null
  query: Record<string, unknown>
  provider_query: Record<string, unknown>
  query_fingerprint: string | null
  research_query_attempt_id?: string | null
  status: 'active' | 'paused' | 'archived'
  fetch_frequency: 'manual' | 'hourly' | 'daily' | 'weekly'
  schedule_rule: SourceScheduleRule | Record<string, unknown> | null
  provider: { key: string | null; display_name: string | null }
  connection_status: string | null
  capture_policy: SourceCapturePolicy | null
  scan_state: {
    status: string | null
    cursor: Record<string, unknown>
    watermark: Record<string, unknown>
    next_run_at: string | null
    last_run_at: string | null
  }
  created_by_user_id?: string
  created_at?: string
  updated_at?: string
}

export interface ProjectResearchInitialIntakeInput {
  workflow_id?: string
  thread_id?: string
  research_context_version_id?: string
  query_strategy_id?: string
  research_question: string
  history_mode: 'bounded_range' | 'all_available'
  from?: string
  to?: string
  max_items: number
  monitoring_field: 'submittedDate' | 'lastUpdatedDate'
  report_depth: 'quick' | 'full'
  question_refine_skipped: boolean
  question_refinement?: ProjectResearchQuestionRefinement | null
  execution: {
    model_provider_id?: string
    model_name?: string
  }
}

export type ResearchProviderKey = 'arxiv' | 'openalex' | 'semantic_scholar' | 'web_search'

export interface ResearchSemanticConcept {
  value: string
  synonyms: string[]
  weight: number
}

export interface ResearchQueryAttempt {
  id: string
  provider_plan_id: string
  round: number
  sequence: number
  direction: 'initial' | 'broaden' | 'narrow'
  semantic_query: {
    schema_version: 'research_semantic_query.v1'
    core: ResearchSemanticConcept[]
    expansions: ResearchSemanticConcept[]
    qualifiers: ResearchSemanticConcept[]
    exclusions: ResearchSemanticConcept[]
    time_window: { from: string | null; to: string | null } | null
  }
  compiled_query: { schema_version: 'research_compiled_query.v1'; provider_key: ResearchProviderKey; query: Record<string, unknown>; fingerprint: string }
  observation: null | {
    provider_hit_count: number
    accessible_hit_count: number
    relevance_rate: number
    relevance_lower_bound: number
    diversity_score: number
    duplicate_rate: number
    samples: Array<{ sample_id: string; title: string; source_uri: string | null; occurred_at: string | null; excerpt: string | null; relevance: 'relevant' | 'maybe' | 'not_relevant'; matched_core_concepts: string[] }>
  }
  score: number | null
  decision: 'accept' | 'broaden' | 'narrow' | 'stop' | null
  decision_reason: string | null
  error_class: string | null
}

export interface ResearchQueryStrategy {
  id: string
  project_id: string
  research_context_version_id: string
  question_snapshot: string
  status: 'planning' | 'evaluating' | 'selected' | 'materialized' | 'failed'
  version: number
  parent_strategy_id: string | null
  adaptation_direction: 'broaden' | 'narrow' | 'rollback' | null
  provider_plans: Array<{
    id: string
    provider_key: ResearchProviderKey
    status: 'pending' | 'evaluating' | 'selected' | 'unavailable' | 'failed'
    attempts: ResearchQueryAttempt[]
    selected_attempt_id: string | null
    terminal_decision: 'accept' | 'broaden' | 'narrow' | 'stop' | null
    decision_reason: string | null
    coverage_warning: string | null
  }>
}

export interface MaterializedResearchStrategy {
  query_strategy_id: string
  project_id: string
  status: 'materialized'
  sources: Array<{ provider_key: ResearchProviderKey; research_query_attempt_id: string; source_channel_id: string; project_source_binding_id: string; query_fingerprint: string }>
}

export interface ProjectResearchQuestionRefinement {
  research_context_version_id: string
  /** Natural-language turn shown in the assessment conversation. */
  reply?: string
  /** The framework's current recommended wording after this turn. */
  recommended_question?: string
  assessment: {
    answerable: boolean
    finer: { feasible: number; interesting: number; novel: number; ethical: number; relevant: number }
    issues: string[]
  }
  suggested_questions: string[]
  sub_questions: string[]
  scope: { in: string[]; out: string[] }
  clarifying_questions: Array<{ question: string; options: string[]; allow_multiple: boolean }>
}

export interface ProjectResearchQuestionAssessmentMessage {
  id: string
  turn_index: number
  role: 'user' | 'assistant'
  content: string
  status: 'pending' | 'complete' | 'failed'
  processing_events?: Array<{
    stage: 'subquestion_repair'
    status: 'detected' | 'running' | 'completed' | 'failed'
    message: string
    created_at: string
  }>
  created_by_user_id: string | null
  created_at: string
}

export interface ProjectResearchQuestionAssessmentSession {
  id: string
  thread_id: string
  recommended_question: string | null
  latest_refinement: ProjectResearchQuestionRefinement | null
  assessment_baseline: ProjectResearchQuestionRefinement | null
  research_context_version_id: string | null
  messages: ProjectResearchQuestionAssessmentMessage[]
  created_at: string
  updated_at: string
}

export interface ProjectResearchQuestionRefinementResponse extends ProjectResearchQuestionRefinement {
  assessment_session: ProjectResearchQuestionAssessmentSession
}

export interface ProjectResearchQuestionAssessmentConfirmation {
  id: string
  version: number
  question: string
  assessment: ProjectResearchQuestionRefinement['assessment']
  scope: { in: string[]; out: string[] }
  sub_questions: string[]
  manually_adjusted: boolean
  created_at: string
}

export interface ProjectResearchQuestionAssessmentConfirmationResponse extends ProjectResearchQuestionRefinement {
  confirmation: ProjectResearchQuestionAssessmentConfirmation
}

export type SourceCapturePolicy =
  | 'reference_only'
  | 'extract_text'
  | 'archive_original'

export type SourceScheduleRule =
  | { frequency: 'hourly'; minute: number }
  | { frequency: 'daily'; hour: number; minute: number }
  | { frequency: 'weekly'; weekday: number; hour: number; minute: number }

export interface SourceItem {
  id: string
  space_id: string
  connection_id: string | null
  item_type: string
  source_object_type: string | null
  source_object_id: string | null
  created_by_user_id: string | null
  title: string
  source_uri: string | null
  canonical_uri: string | null
  source_domain: string | null
  source_external_id: string | null
  author: string | null
  occurred_at: string | null
  first_seen_at: string
  last_seen_at: string
  content_hash: string | null
  excerpt: string | null
  library_status: 'new' | 'triaged' | 'selected' | 'ignored' | 'archived'
  read_status: 'unread' | 'skimmed' | 'read' | 'discussed'
  first_opened_at?: string | null
  last_opened_at?: string | null
  progress_json?: Record<string, unknown>
  content_state: string
  retention_policy: string
  relevance_score: number | null
  novelty_score: number | null
  raw_artifact_id: string | null
  extracted_artifact_id: string | null
  summary_artifact_id: string | null
  search_index_ref: string | null
  embedding_index_ref: string | null
  metadata_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface ExtractionJob {
  id: string
  space_id: string
  connection_id: string | null
  source_item_id: string | null
  source_snapshot_id: string | null
  source_object_type: string | null
  source_object_id: string | null
  job_type: string
  status: string
  started_at: string | null
  completed_at: string | null
  items_seen: number | null
  items_created: number | null
  items_updated: number | null
  error_code: string | null
  error_message: string | null
  metadata_json: Record<string, unknown> | null
  created_at: string
}

export interface CustomSourcePolicyLimits {
  timeout_ms: number
  max_download_bytes: number
  max_output_bytes: number
  max_files: number
  max_items: number
  max_evidence_items: number
  log_max_bytes: number
  [key: string]: unknown
}

export interface CustomSourcePolicyEnvelope {
  allowed_network_origins: string[]
  capture_policy: SourceCapturePolicy
  retention_policy: string
  credential_ref?: string | null
  language: 'typescript_node' | string
  browser_automation_enabled: boolean
  shell_enabled: boolean
  dependency_installation_enabled: boolean
  log_redaction_enabled: boolean
  limits: CustomSourcePolicyLimits
  [key: string]: unknown
}

export interface CustomSourceHandlerVersion {
  id: string
  space_id: string
  source_connection_id: string
  version_number: number
  language: string
  entrypoint: string
  handler_artifact_id: string | null
  manifest_json: Record<string, unknown>
  input_schema_json: Record<string, unknown> | null
  output_schema_json: Record<string, unknown> | null
  policy_envelope_json: CustomSourcePolicyEnvelope
  requested_capabilities_json: Record<string, unknown> | null
  checksum: string
  status: 'draft' | 'test_failed' | 'pending_approval' | 'active' | 'superseded' | 'disabled'
  created_by_user_id: string | null
  created_by_run_id: string | null
  proposal_id: string | null
  test_result_json: Record<string, unknown> | null
  created_at: string
  activated_at: string | null
  superseded_at: string | null
}

export interface CustomSourceHandlerRun {
  id: string
  space_id: string
  source_connection_id: string
  handler_version_id: string
  extraction_job_id: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'validation_failed' | 'blocked'
  input_artifact_id: string | null
  output_artifact_id: string | null
  logs_artifact_id: string | null
  failure_class: string | null
  failure_detail_json: Record<string, unknown> | null
  validation_result_json: Record<string, unknown> | null
  resource_usage_json: Record<string, unknown> | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface CustomSourcePendingProposal {
  proposal_id: string
  proposal_type: string
  created_at: string
}

export interface CustomSourceHandlerSummary {
  active_handler_version: CustomSourceHandlerVersion | null
  latest_handler_run: CustomSourceHandlerRun | null
  repair_status: 'ok' | 'repair_required' | 'repair_pending' | 'disabled'
  recent_run_status_counts: Record<string, number>
  pending_proposals: CustomSourcePendingProposal[]
}

export interface CustomSourceTestOutcome {
  run: CustomSourceHandlerRun
  version: CustomSourceHandlerVersion
  test_result: Record<string, unknown>
}

export interface CustomSourceActivationResult {
  status: 'active' | 'pending_approval'
  deltas: string[]
  proposal_id: string | null
  handler_version: CustomSourceHandlerVersion
}

export interface CustomSourceCreateDraftRequest {
  name: string
  endpoint_url: string
  fetch_frequency?: 'manual' | 'hourly' | 'daily' | 'weekly'
  next_check_at?: string | null
  schedule_rule?: SourceScheduleRule | null
  config?: Record<string, unknown>
}

export type CustomSourceCreatorRole = 'owner' | 'admin' | 'reviewer' | 'member'
export type CustomSourceCapturePolicy = SourceCapturePolicy
export type CustomSourceRetentionPolicy =
  | 'metadata_only'
  | 'summary_only'
  | 'full_text'
  | 'full_snapshot'
  | 'archived'

export interface CustomSourceSpacePolicy {
  space_id: string
  creator_roles: CustomSourceCreatorRole[]
  default_capture_policy: CustomSourceCapturePolicy
  default_retention_policy: CustomSourceRetentionPolicy
  allowed_domains: string[]
  download_bytes_max: number
  credentialed_sources_allowed: boolean
  same_envelope_repair_auto_apply: boolean
  created_at: string | null
  updated_at: string | null
}

export interface CustomSourceInstanceRunnerSettings {
  runner_enabled: boolean
  allowed_languages: string[]
  network_hard_deny_rules: string[]
  timeout_ms_max: number
  output_bytes_max: number
  log_bytes_max: number
  max_files: number
  browser_automation_available: boolean
  shell_available: boolean
  dependency_installation_available: boolean
  generate_rate_limit_per_hour: number
  artifact_retention_enabled: boolean
  artifact_retention_days: number
}

export interface CustomSourceInstanceRunnerSettingsUpdate {
  runner_enabled?: boolean
}

export interface CustomSourceSpacePolicyUpdate {
  creator_roles?: CustomSourceCreatorRole[]
  default_capture_policy?: CustomSourceCapturePolicy
  default_retention_policy?: CustomSourceRetentionPolicy
  allowed_domains?: string[]
  download_bytes_max?: number
  credentialed_sources_allowed?: boolean
  same_envelope_repair_auto_apply?: boolean
}

export type SourceRecipePrimitiveName =
  | 'fetch_page'
  | 'parse_rss'
  | 'parse_atom'
  | 'extract_list'
  | 'extract_single'
  | 'follow_link'
  | 'download_asset'
  | 'paginate'
  | 'dedupe'

export type SourceRecipeSourceType = 'rss' | 'atom' | 'web_list' | 'web_page'
export type SourceRecipeVersionStatus = 'draft' | 'test_failed' | 'pending_approval' | 'active' | 'superseded' | 'disabled'
export type SourceRecipeDryRunStatus = 'succeeded' | 'failed' | 'validation_failed'
export type SourceRecipeStepTraceStatus = 'succeeded' | 'failed' | 'skipped'

export interface SourcePolicyEnvelope {
  allowed_network_origins: string[]
  capture_policy: SourceCapturePolicy
  retention_policy: string
  credential_ref?: string | null
  log_redaction_enabled: boolean
  limits: CustomSourcePolicyLimits
  [key: string]: unknown
}

export interface SourceRecipeStepTrace {
  step_path: string
  primitive: SourceRecipePrimitiveName
  status: SourceRecipeStepTraceStatus
  detail?: string | null
  item_count?: number | null
  fetched_url?: string | null
  duration_ms: number
  [key: string]: unknown
}

export interface SourceRecipeOutputItem {
  external_id: string
  title: string
  source_uri: string
  excerpt?: string | null
  author?: string | null
  published_at?: string | null
  snapshots?: Array<Record<string, unknown>>
  evidence?: Array<Record<string, unknown>>
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface SourceRecipeDefinition {
  recipe_version: 'source.recipe.v1'
  steps: Array<Record<string, unknown> & { type: SourceRecipePrimitiveName }>
  output: { items_var: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface SourceRecipeAnalysis {
  primitives: SourceRecipePrimitiveName[]
  primitive_versions: Record<string, number>
  network_access: 'none' | 'primary_endpoint' | 'live_fetch'
  live_fetch_urls: string[]
  writes_files: boolean
  [key: string]: unknown
}

export interface SourceRecipePreview {
  status: 'succeeded' | 'failed' | 'blocked'
  item_count: number
  sample_items: SourceRecipeOutputItem[]
  warnings: string[]
  step_traces: SourceRecipeStepTrace[]
  error?: string | null
}

export interface SourceRecipePlanRequest {
  endpoint_url: string
  name?: string
  source_type?: SourceRecipeSourceType | 'auto'
  fetch_frequency?: 'manual' | 'hourly' | 'daily' | 'weekly'
  next_check_at?: string | null
  schedule_rule?: SourceScheduleRule | null
  capture_policy?: SourceCapturePolicy
  retention_policy?: string
  list_selector?: string
  credential_id?: string | null
  fixture_content?: string
  config?: Record<string, unknown>
}

export interface SourceRecipePlanResponse {
  source_type: SourceRecipeSourceType
  recipe: SourceRecipeDefinition
  policy_envelope: SourcePolicyEnvelope
  analysis: SourceRecipeAnalysis
  preview: SourceRecipePreview
  defaults: {
    fetch_frequency: 'manual' | 'hourly' | 'daily' | 'weekly'
    capture_policy: SourceCapturePolicy
    retention_policy: string
  }
}

export interface SourceRecipeVersion {
  id: string
  space_id: string
  source_connection_id: string
  version_number: number
  recipe_json: SourceRecipeDefinition
  policy_envelope_json: SourcePolicyEnvelope
  primitive_versions_json: Record<string, number> | null
  status: SourceRecipeVersionStatus
  created_by_user_id: string | null
  proposal_id: string | null
  test_result_json: SourceRecipeDryRunResult | Record<string, unknown> | null
  created_at: string
  activated_at: string | null
  superseded_at: string | null
}

export interface SourceRecipeCreateRequest extends SourceRecipePlanRequest {
  name: string
  recipe?: SourceRecipeDefinition
}

export interface SourceRecipeCreateResponse {
  connection: SourceChannel
  recipe_version: SourceRecipeVersion
}

export interface SourceRecipePipelineBridgeRequest {
  handler_version_id?: string
  name?: string
  fetch_frequency?: string
}

export interface SourceRecipePipelineBridgeResponse {
  connection: SourceChannel
  recipe_version: SourceRecipeVersion
  bridged_from_connection_id: string
  bridged_from_handler_version_id: string
}

export interface SourceRecipeDryRunResult {
  status: SourceRecipeDryRunStatus
  item_count: number
  sample_items: SourceRecipeOutputItem[]
  followed_urls: string[]
  skipped_urls: string[]
  warnings: string[]
  errors: string[]
  step_traces: SourceRecipeStepTrace[]
  policy_envelope: SourcePolicyEnvelope
  started_at: string
  completed_at: string
  failure_fixture?: Record<string, unknown>
  [key: string]: unknown
}

export interface SourceRecipeDryRunResponse {
  recipe_version: SourceRecipeVersion
  dry_run: SourceRecipeDryRunResult
}

export interface SourceRecipeActivationResult {
  status: 'active' | 'pending_approval'
  deltas: string[]
  proposal_id: string | null
  recipe_version: SourceRecipeVersion
}

export type SourceRunKind = 'scan' | 'dry_run' | 'test' | 'manual_url' | 'extract' | 'other'
export type SourceRunImplementation = 'built_in' | 'recipe' | 'generated_handler'
export type SourceRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'validation_failed' | 'blocked' | 'skipped'

export interface SourceRunSummary {
  id: string
  space_id: string
  source_connection_id: string
  run_kind: SourceRunKind
  implementation: SourceRunImplementation
  status: SourceRunStatus
  items_created?: number | null
  error?: string | null
  extraction_job_id?: string | null
  handler_run_id?: string | null
  recipe_version_id?: string | null
  created_at: string
  started_at?: string | null
  completed_at?: string | null
}

export interface ExtractedEvidence {
  id: string
  space_id: string
  source_item_id: string | null
  extraction_job_id: string | null
  source_snapshot_id: string | null
  source_object_type: string | null
  source_object_id: string | null
  evidence_type: string
  title: string
  content_excerpt: string | null
  content_hash: string | null
  artifact_id: string | null
  source_uri: string | null
  source_title: string | null
  source_author: string | null
  occurred_at: string | null
  trust_level: 'trusted' | 'normal' | 'untrusted'
  extraction_method: string
  confidence: number | null
  status: 'candidate' | 'active' | 'rejected' | 'archived'
  metadata_json: Record<string, unknown> | null
  created_by_user_id: string | null
  created_by_agent_id: string | null
  created_by_run_id: string | null
  created_at: string
  updated_at: string
}

export interface EvidenceLink {
  id: string
  space_id: string
  evidence_id: string
  target_type: string
  target_id: string | null
  link_type: string
  status: 'candidate' | 'active' | 'rejected' | 'archived'
  confidence: number | null
  reason: string | null
  created_by_user_id: string | null
  created_by_agent_id: string | null
  created_by_run_id: string | null
  created_at: string
  updated_at: string
}

export interface ProjectSourceBinding {
  id: string
  space_id: string
  project_id: string
  source_channel_id: string
  binding_key: string
  status: string
  priority: number
  delivery_scope: 'project_members' | 'source_subscribers'
  collection_notifications_enabled: boolean
  filters_json: Record<string, unknown>
  routing_policy_json: Record<string, unknown>
  extraction_policy_json: Record<string, unknown>
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  backfill_result?: ProjectSourceBindingBackfillResult
}

export interface ProjectSourceBindingBackfillResult {
  binding_id: string
  project_id: string
  source_connection_id: string
  created_links: number
  reactivated_links: number
  archived_links: number
  evidence_links: number
}

export interface ProjectSourceItem {
  id: string
  space_id: string
  project_id: string
  project_source_binding_id: string
  source_channel_id: string
  source_connection_id: string | null
  source_item_id: string
  status: 'active' | 'archived'
  matched_at: string
  match_reason: string | null
  created_at: string
  updated_at: string
  item: SourceItem
}

export interface SourceHealth {
  binding_id?: string
  project_id?: string
  source_connection_id: string
  source_channel_id?: string
  source_name: string
  status: 'healthy' | 'running' | 'attention' | 'failing' | 'paused'
  last_success_at: string | null
  last_failure_at: string | null
  last_error: string | null
  next_run_at: string | null
  queued_jobs: number
  running_jobs: number
  recent_new_items: number
  consecutive_failures: number
}

export interface SourceBackfillStrategy {
  window_unit: 'date_window' | 'page_cursor' | 'id_cursor'
  history_mode?: 'bounded_range' | 'all_available'
  from: string | null
  to: string | null
  window_size: number
  max_items: number
  direction: 'backward' | 'forward'
}

export interface SourceBackfillQuotaPolicy {
  window: 'minute' | 'hour' | 'day'
  limit_count: number
}

export interface SourceBackfillSegment {
  id: string
  seq: number
  window_json: Record<string, unknown>
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  items_ingested: number
}

export interface SourceBackfillPreview {
  strategy: SourceBackfillStrategy
  segments: Array<Record<string, unknown>>
  quota_policy: SourceBackfillQuotaPolicy
}

export interface SourceBackfillPlan {
  id: string
  source_channel_id: string
  project_source_binding_id: string | null
  project_operation_id: string | null
  proposal_id: string | null
  strategy_json: SourceBackfillStrategy
  quota_policy_json: SourceBackfillQuotaPolicy
  status: 'draft' | 'proposed' | 'approved' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  segments_total: number
  segments_completed: number
  segments_failed: number
  items_ingested: number
  next_eligible_at: string | null
  created_at: string
  updated_at: string
  segments?: SourceBackfillSegment[]
}

export interface ProjectOperation {
  id: string
  project_id: string
  kind: 'source_setup' | 'source_backfill' | 'research' | 'custom'
  title: string
  status: 'draft' | 'active' | 'waiting_review' | 'completed' | 'failed' | 'cancelled'
  progress_json: Record<string, unknown> & { total?: number; completed?: number; failed?: number; pending?: number }
  created_at: string
  updated_at: string
  steps?: Array<{
    id: string
    operation_id: string
    seq: number
    title: string
    status: 'pending' | 'active' | 'blocked' | 'done' | 'skipped'
    detail_json?: Record<string, unknown> | null
  }>
  links?: Array<{ target_type: string; target_id: string; role: string }>
}

export interface ProjectSourceSummary {
  project_id: string
  bound_source_count: number
  today_new_items: number
  health_counts: Record<string, number>
  recent_items: ProjectSourceItem[]
}

export interface ProjectCorpusObjectSummary {
  id: string
  object_type: string | null
  title: string | null
  summary: string | null
  status: string | null
}

export interface ProjectCorpusSourceItemSummary {
  id: string
  item_type: string | null
  title: string | null
  source_uri: string | null
  source_domain: string | null
  excerpt: string | null
}

export interface ProjectCorpusEvidenceSummary {
  id: string
  evidence_type: string | null
  title: string | null
  content_excerpt: string | null
}

export interface ProjectCorpusItem {
  id: string
  space_id: string
  project_id: string
  object_id: string | null
  source_item_id: string | null
  evidence_id: string | null
  source_connection_id: string | null
  source_decision_id: string | null
  role: 'candidate' | 'reference' | 'primary' | 'related' | 'background'
  status: 'active' | 'archived'
  triage_status: 'new' | 'relevant' | 'maybe' | 'excluded' | 'included'
  read_status: 'unread' | 'skimmed' | 'read' | 'discussed'
  relevance: 'relevant' | 'maybe' | 'not_relevant' | null
  confidence: number | null
  reason: string | null
  added_by_user_id: string | null
  metadata_json: Record<string, unknown>
  created_at: string
  updated_at: string
  last_reviewed_at: string | null
  last_read_at: string | null
  object: ProjectCorpusObjectSummary | null
  source_item: ProjectCorpusSourceItemSummary | null
  evidence: ProjectCorpusEvidenceSummary | null
}

export interface ProjectCorpusBackfillResult {
  project_id: string
  source_items: number
  source_objects: number
  evidence_items: number
  evidence_objects: number
  source_decisions: number
  archived_source_items: number
}

export type JobStatus    = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled'
export type JobEventType = 'log' | 'status_change' | 'artifact' | 'error'

export interface Job {
  id: string
  space_id: string
  user_id: string
  project_folder_id: string | null
  agent_id: string | null
  job_type: string
  status: JobStatus
  priority: number
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  error: string | null
  attempts: number
  max_attempts: number
  claimed_by: string | null
  claimed_at: string | null
  scheduled_at: string
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface JobEvent {
  id: string
  job_id: string
  event_type: JobEventType
  message: string
  data: Record<string, unknown> | null
  created_at: string
}

export interface Memory {
  id: string
  space_id: string
  subject_user_id?: string | null
  owner_user_id: string | null
  project_folder_id: string | null
  title: string | null
  content: string | null
  type: MemoryType
  scope: MemoryScope
  namespace: string | null
  status: MemoryStatus
  visibility: MemoryVisibility
  access_level: ContentAccessLevel
  sensitivity_level?: string
  last_confirmed_at?: string | null
  confidence: number
  importance: number
  created_by: string | null
  version: number
  access_count?: number
  last_accessed_at?: string | null
  tags: string[] | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  agent_id?: string | null
  capability_id?: string | null
  approved_by?: string | null
  memory_layer?: string | null
  source_trust?: string | null
  created_from_proposal_id?: string | null
  root_memory_id?: string | null
  supersedes_memory_id?: string | null
  project_id?: string | null
}

export type MemoryMaintenanceFindingKind =
  | 'duplicate'
  | 'stale'
  | 'thin'
  | 'lifecycle_drift'
  | 'archived_state_drift'
  | 'project_drift'
  | 'source_policy_drift'
  | 'contradiction'

export interface MemoryMaintenanceObject {
  object_type: 'memory_entry'
  object_id: string
  title: string | null
}

export interface MemoryMaintenanceFinding {
  kind: MemoryMaintenanceFindingKind
  objects: MemoryMaintenanceObject[]
  reason: string
  cluster_key?: string
  cluster_label?: string
  confidence_tier?: 'high' | 'medium' | 'low'
  proposed_action?: Record<string, unknown> | null
}

export interface MemoryMaintenanceScanRequest {
  persist_report?: boolean
  create_packet?: boolean
  limit?: number
  stale_after_days?: number
  thin_content_chars?: number
  max_findings?: number
  review_scope?: 'private' | 'space_ops'
  project_id?: string | null
  scan_mode?: 'recent' | 'full'
  cursor?: string
  job_id?: string
}

export interface MemoryMaintenanceReport {
  findings: MemoryMaintenanceFinding[]
  counts: Record<string, number>
  candidate_limit: number
  candidates_examined: number
  scanned: number
  truncated: boolean
  scan_mode?: 'recent' | 'full'
  next_cursor?: string | null
  job_id?: string
  job_status?: 'pending' | 'running' | 'completed' | 'failed'
  artifact_id?: string
  proposal_id?: string
  access_safety?: Record<string, unknown>
}

export interface MemoryMaintenanceJob {
  id: string
  space_id: string
  owner_user_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  review_scope: 'private' | 'space_ops'
  scan_options: Record<string, unknown>
  cursor: string | null
  total_scanned: number
  total_findings: number
  last_report_artifact_id?: string | null
  last_packet_proposal_id?: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at?: string | null
}

export interface MemoryMaintenanceJobRunResponse {
  job: MemoryMaintenanceJob
  report: MemoryMaintenanceReport | null
}

export interface MemoryAccessLogEntry {
  id: string
  space_id: string
  memory_id: string
  user_id?: string | null
  agent_id?: string | null
  run_id?: string | null
  access_type: string
  reason?: string | null
  accessed_at: string
  memory_title: string | null
  memory_scope: string | null
  memory_visibility: string | null
  project_id?: string | null
}

export interface MemoryAccessLogListResponse {
  items: MemoryAccessLogEntry[]
  limit: number
  offset: number
  returned: number
  has_more: boolean
}

export interface KnowledgeItemSummary {
  id: string
  space_id: string
  project_id: string | null
  project_folder_id: string | null
  knowledge_kind: KnowledgeItemKind
  slug: string | null
  title: string
  content_preview: string
  excerpt: string | null
  status: KnowledgeItemStatus
  visibility: KnowledgeVisibility
  verification_status: KnowledgeVerificationStatus
  reflection_status: KnowledgeReflectionStatus
  tags: string[]
  confidence: number | null
  version: number
  updated_at: string
}

export interface KnowledgeItem extends KnowledgeItemSummary {
  root_item_id: string | null
  supersedes_item_id: string | null
  redirect_to_item_id: string | null
  aliases: string[]
  content: string
  content_json: Record<string, unknown> | null
  content_format: KnowledgeContentFormat
  content_schema_version: number
  plain_text: string | null
  source_refs: Record<string, unknown>[]
  owner_user_id: string | null
  created_by_user_id: string | null
  created_by_agent_id: string | null
  created_by_run_id: string | null
  created_from_proposal_id: string | null
  approved_by_user_id: string | null
  created_at: string
  archived_at: string | null
  deprecated_at: string | null
}

export interface KnowledgeRelation {
  id: string
  space_id: string
  from_object_id: string
  to_object_id: string
  relation_type: KnowledgeRelationType
  status: KnowledgeRelationStatus
  confidence: number | null
  evidence_summary: string | null
  source_proposal_id: string | null
  created_by_user_id: string | null
  created_by_agent_id: string | null
  created_from_assessment_id: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeCreateProposalBody {
  knowledge_kind: KnowledgeItemKind
  title: string
  slug?: string | null
  aliases?: string[]
  content: string
  content_json?: Record<string, unknown> | null
  content_format: KnowledgeContentFormat
  content_schema_version?: number
  visibility: KnowledgeVisibility
  project_id?: string | null
  project_folder_id?: string | null
  tags: string[]
  confidence?: number | null
  source_refs?: Record<string, unknown>[]
  source_run_id?: string | null
  object_kind_fields?: Record<string, unknown>
  rationale?: string | null
}

export interface KnowledgeUpdateProposalBody {
  title: string
  slug?: string | null
  aliases?: string[]
  content: string
  content_json?: Record<string, unknown> | null
  content_format: KnowledgeContentFormat
  content_schema_version?: number
  tags: string[]
  confidence?: number | null
  object_kind_fields?: Record<string, unknown>
  rationale?: string | null
  verification_status?: KnowledgeVerificationStatus
  reflection_status?: KnowledgeReflectionStatus
}

export interface KnowledgeRelationProposalBody {
  from_object_id: string
  to_object_id: string
  relation_type: KnowledgeRelationType
  status: Extract<KnowledgeRelationStatus, 'candidate' | 'active'>
  confidence?: number | null
  evidence_summary?: string | null
  rationale?: string | null
}

// ── Notes (working knowledge; direct CRUD) ─────────────────────────────────
export type NoteStatus = 'active' | 'archived' | 'deleted'
export type NoteContentFormat = 'markdown' | 'plain' | 'prosemirror_json'
export type NoteCollectionSystemRole = 'normal' | 'inbox' | 'archive' | 'project' | 'projects_root'

export interface NoteCollection {
  id: string
  space_id: string
  parent_id: string | null
  name: string
  system_role: NoteCollectionSystemRole
  sort_order: number
  is_system: boolean
  is_hidden: boolean
  /** Set only for the one auto-created folder backing a Project's notes (system_role='project'). */
  project_id?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

export interface NoteCollectionCreateBody {
  /** Client-generated so optimistic tree mutations can reference the folder
   * before the create request has finished. */
  id?: string
  name: string
  parent_id?: string | null
  sort_order?: number | null
}

export interface NoteCollectionUpdateBody {
  name?: string
  parent_id?: string | null
  sort_order?: number | null
  is_hidden?: boolean
}

export interface NoteSummary {
  id: string
  space_id: string
  title: string
  excerpt: string | null
  status: NoteStatus
  content_format: NoteContentFormat
  primary_project_id: string | null
  /** Folder this note belongs to (first membership); null/absent if uncategorized. */
  collection_id?: string | null
  /** Position within collection_id's folder; null if uncategorized. */
  sort_order?: number | null
  /** Optimistic-concurrency version; bumped by every save (user or AI). */
  version: number
  content_hash: string | null
  updated_by_user_id: string | null
  updated_by_run_id: string | null
  created_at: string
  updated_at: string
}

export interface Note extends NoteSummary {
  content_json: Record<string, unknown> | null
  content_schema_version: number
  plain_text: string | null
  created_from_activity_id: string | null
  created_by_user_id: string | null
  archived_at: string | null
  deleted_at: string | null
}

export interface NoteCreateBody {
  title: string
  plain_text?: string | null
  content_json?: Record<string, unknown> | null
  content_format?: NoteContentFormat
  content_schema_version?: number
  status?: 'active'
  primary_project_id?: string | null
  created_from_activity_id?: string | null
  collection_id?: string | null
}

export interface NoteUpdateBody {
  title?: string
  plain_text?: string | null
  content_json?: Record<string, unknown> | null
  content_format?: NoteContentFormat
  content_schema_version?: number
  status?: NoteStatus
  primary_project_id?: string | null
  /** Moves the note into this folder (replaces its current folder). */
  collection_id?: string
  /** Optimistic-concurrency check for content_json writes; omit to skip the check. */
  expect_version?: number
}

export interface NotesTreeNoteOrderUpdate {
  id: string
  collection_id: string
  sort_order: number
}

export interface NotesTreeCollectionOrderUpdate {
  id: string
  parent_id: string | null
  sort_order: number
}

export type NotesTreeReorderBody =
  | { kind: 'notes'; updates: NotesTreeNoteOrderUpdate[] }
  | { kind: 'collections'; updates: NotesTreeCollectionOrderUpdate[] }

export interface NotesTreeReorderResult {
  kind: NotesTreeReorderBody['kind']
  updated: number
}

export type NoteRevisionSource = 'user_edit' | 'ai_monitoring' | 'ai_adhoc' | 'seed' | 'rollback'

export interface NoteRevision {
  id: string
  version: number
  content_json: Record<string, unknown>
  normalized_text: string
  refs_json: string[]
  source: NoteRevisionSource
  diff_json: { ops?: Array<{ op: string; index?: number; count?: number; markdown?: string | null }>; rolled_back_to_version?: number; conflict?: boolean; run_id?: string } | null
  created_by_user_id: string | null
  created_by_run_id: string | null
  created_at: string
}

// ── Entity links (generic cross-object relation layer) ─────────────────────
export type EntityType =
  | 'note' | 'knowledge_item' | 'source' | 'project'
  | 'project_folder' | 'activity' | 'run' | 'proposal'
export type EntityLinkType =
  | 'references' | 'related_to' | 'belongs_to'
  | 'captured_from' | 'source_for' | 'derived_from'
export type EntityLinkStatus = 'suggested' | 'accepted' | 'rejected'

export interface EntityLink {
  id: string
  space_id: string
  source_type: EntityType
  source_id: string
  target_type: EntityType
  target_id: string
  link_type: EntityLinkType
  confidence: number | null
  status: EntityLinkStatus
  created_by_user_id: string | null
  created_at: string
}

export interface NoteLinkCreateBody {
  target_type: EntityType
  target_id: string
  link_type?: EntityLinkType
  confidence?: number | null
  direction?: 'outgoing' | 'incoming'
}

export interface KnowledgeSummary {
  notes: { active: number; archived: number; deleted: number; total: number }
  wiki: { active: number }
  sources: { total: number }
}

// ── Sources (provenance / evidence layer) ──────────────────────────────────
export interface KnowledgeSourceSummary {
  id: string
  space_id: string
  source_type: string
  title: string
  uri: string | null
  status: string
  source_activity_id: string | null
  created_at: string
  updated_at: string
}

/** Activity inbox (`GET /activity`) — distinct from run-scoped activity records. */
export interface ActivityInboxRecord {
  id: string
  space_id: string
  user_id: string | null
  project_folder_id: string | null
  agent_id: string | null
  source_type: ActivitySourceType
  title: string | null
  content: string
  source_run_id: string | null
  source_task_id: string | null
  source_session_id: string | null
  source_url: string | null
  status: ActivityStatus
  metadata_json: Record<string, unknown> | null
  aggregate_key?: string | null
  visibility?: ObjectVisibility
  access_level?: ContentAccessLevel
  owner_user_id?: string | null
  created_at: string
  updated_at: string
}

/** Run timeline row (`GET /runs/{id}/activities`). */
export interface ActivityRecord {
  id: string
  space_id: string
  source_run_id: string | null
  session_id: string | null
  user_id: string | null
  activity_type: string
  title: string | null
  content: string | null
  payload_json: Record<string, unknown>
  visibility?: ObjectVisibility
  access_level?: ContentAccessLevel
  owner_user_id?: string | null
  occurred_at: string
  created_at: string
}

export interface Session {
  id: string
  space_id: string
  user_id: string
  title: string | null
  status: SessionStatus
  project_folder_id: string | null
  project_id:string|null
  created_at: string
  updated_at: string
}

export interface Message {
  id: string
  session_id: string
  space_id: string
  user_id: string
  role: MessageRole
  content: string
  metadata_json: Record<string, unknown> | null
  created_at: string
}

export interface ChatTurnAccepted {
  schema_version: 'chat_turn_accepted.v1'
  session_id: string
  run_id: string
  user_message_id: string
  status: 'queued'
  event_stream_url: string
  backend: ConversationBackendBinding
}

export interface ConversationBackendBinding {
  runtime_profile_id: string
  adapter_type: string
  credential_profile_id?: string | null
}

export interface ConversationBackendOption {
  runtime_profile_id: string
  name: string
  adapter_type: string
  model_name?: string | null
  requires_cli_credential: boolean
  credential_profiles: Array<{
    id: string
    name: string
    is_default: boolean
  }>
}

export interface ConversationBackendCatalog {
  options: ConversationBackendOption[]
  binding: ConversationBackendBinding | null
}

/** Durable completion projected from the Run's `chat_completed` event. */
export interface ChatTurnOut {
  schema_version: 'chat_turn_completion.v1'
  session_id: string
  run_id: string
  ok: boolean
  reply?: string | null
  error?: string | null
  error_code?: string | null
  action_previews?: ChatActionPreview[]
  assistant_message?: {
    schema_version: 'assistant_message.v1'
    id: string
    session_id: string
    run_id: string
    content: string
    artifact_refs: string[]
    tool_call_refs: string[]
    created_at: string
  } | null
}

export interface ChatActionPreview {
  action_id: string
  tool_call_id?: string | null
  status: 'proposed' | 'auto_applied' | 'completed' | 'failed'
  proposal_id?: string | null
  proposal_type?: string | null
  title?: string | null
  summary?: string | null
  risk_level?: string | null
  scope?: Record<string, unknown> | null
}

/** Product task board item (`TaskOut`). */
export interface Task {
  id: string
  space_id: string
  task_role: 'source' | 'subtask' | string
  owner_user_id: string | null
  project_folder_id: string | null
  board_id: string | null
  column_id: string | null
  parent_task_id: string | null
  title: string
  description: string | null
  task_type: string
  status: string
  priority: string
  risk_level: string
  visibility: ObjectVisibility
  access_level: ContentAccessLevel
  created_by_user_id: string | null
  created_by_agent_id: string | null
  assigned_user_id: string | null
  assigned_agent_id: string | null
  claimed_by_user_id: string | null
  claimed_by_agent_id: string | null
  source_activity_id: string | null
  source_run_id: string | null
  source_proposal_id: string | null
  source_artifact_id: string | null
  due_at: string | null
  start_after: string | null
  completed_at: string | null
  cancelled_at: string | null
  blocked_reason: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** Present when API expands TaskOut; optional on wire today. */
  acceptance_criteria_json?: Record<string, unknown> | null
  definition_of_done?: string | null
  required_outputs_json?: unknown[] | null
  max_runs?: number | null
  max_cost?: number | null
  max_duration_seconds?: number | null
  policy_json?: Record<string, unknown> | null
  tags?: string[] | null
  metadata_json?: Record<string, unknown> | null
}

export interface BoardColumn {
  id: string
  space_id: string
  board_id: string
  name: string
  description: string | null
  status_key: string
  position: number
  wip_limit: number | null
  is_done_column: boolean
  is_default_column: boolean
  metadata_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface Board {
  id: string
  space_id: string
  project_folder_id: string | null
  name: string
  description: string | null
  board_type: string
  status: string
  default_view: string | null
  sort_order: number | null
  metadata_json: Record<string, unknown> | null
  created_by_user_id: string | null
  created_by_agent_id: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface TaskRunCreateBody {
  agent_id?: string | null
  mode?: string
  run_type?: string
  trigger_origin?: string
  session_id?: string | null
  project_folder_id?: string | null
  prompt?: string | null
  instruction?: string | null
  context_artifact_ids?: string[]
  set_task_in_progress?: boolean
}

export interface TaskRunOut {
  id: string
  space_id: string
  task_id: string
  run_id: string
  role: string
  created_at: string
}

export interface RunResolvedModel {
  provider_id: string | null
  provider_name: string | null
  provider_type: string | null
  model: string | null
  source: 'request' | 'runtime_profile' | 'agent_default' | 'runtime_default' | 'space_default' | 'none'
  used_by_adapter: boolean
  adapter_model_support: 'uses_model' | 'not_applicable' | 'unsupported' | 'unknown'
  disclosure_note?: string | null
}

export interface RunUsage {
  agent_run_count: number
  completed_agent_run_count: number
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  estimated_cost_usd: number | null
  cost_known: boolean
  model_names: string[]
}

export interface Run {
  id: string
  space_id: string
  agent_id: string
  agent_version_id: string
  run_role: 'execution' | 'coordinator'
  requested_runtime_profile_id?: string | null
  selected_runtime_profile_id?: string | null
  runtime_profile_selection_source?: 'explicit' | 'default' | null
  active_route_decision_id?: string | null
  context_snapshot_id: string | null
  project_folder_id: string | null
  session_id: string | null
  parent_run_id: string | null
  instructed_by_user_id?: string | null
  instructed_by_agent_id?: string | null
  run_type: string
  trigger_origin: string
  status: string
  mode: string
  prompt: string | null
  instruction: string | null
  prompt_asset_key?: string | null
  prompt_version_id?: string | null
  prompt_content_hash?: string | null
  scheduled_at: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
  error_message: string | null
  error_json: Record<string, unknown> | null
  output_json: Record<string, unknown> | null
  usage: RunUsage | null
  selected_adapter_type?: string | null
  capability_id?: string | null
  capabilities_json?: string[]
  selected_model_provider_id?: string | null
  resolved_model?: RunResolvedModel | null
  visibility?: ObjectVisibility
  access_level?: ContentAccessLevel
  owner_user_id?: string | null
  task_id?: string | null
  required_sandbox_level?: string | null
  contract_snapshot_json?: Record<string, unknown>
  workflow_version_id?: string | null
}

export interface RunLogicalIO {
  schema_version: 'run_io.v1'
  run_id: string
  input: Record<string, unknown>
  output: Record<string, unknown> | null
  events: Array<Record<string, unknown>>
  artifact_refs: Array<{ id: string; artifact_type: string; title: string }>
}

export interface RunAttempt {
  id: string
  space_id: string
  run_id: string
  attempt_number: number
  status: string
  started_at: string | null
  ended_at: string | null
  last_activity_at: string | null
  cancel_requested_at: string | null
  cancel_confirmed_at: string | null
  exit_code: number | null
  error_code: string | null
  error_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface RunSupervisorDecision {
  id: string
  space_id: string
  run_id: string
  attempt_id: string
  decision: string
  reason_code: string
  next_attempt_number: number | null
  total_estimated_cost_usd: number | null
  max_cost_usd: number | null
  metadata_json: Record<string, unknown>
  created_at: string
}

export interface RunEvaluation {
  id: string
  space_id: string
  run_id: string
  evaluator_type: string
  evaluator_version: string
  outcome_status: string
  failure_layer: string | null
  failure_reason_code: string | null
  trajectory_status: string | null
  evidence_json: Record<string, unknown> | null
  rule_trace_json: Record<string, unknown> | null
  notes: string | null
  evaluated_at: string
}

export interface RunVerificationResult {
  id: string
  space_id: string
  run_id: string
  verifier_type: string
  verifier_version: string
  status: string
  summary: string | null
  evidence_refs_json: Record<string, unknown> | null
  details_json: Record<string, unknown> | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface RunFinalization {
  id: string
  space_id: string
  run_id: string
  attempt_number: number
  finalizer_version: string
  status: string
  run_evaluation_id: string | null
  task_evaluation_id: string | null
  outcome_status: string
  failure_layer: string | null
  failure_reason_code: string | null
  trajectory_status: string | null
  skipped_reasons_json: unknown
  error_json: Record<string, unknown> | null
  metadata_json: Record<string, unknown> | null
}

export interface PlanVersionSummary {
  id: string
  version: number | null
  status: string | null
  node_count: number | null
  depth: number | null
  pending_node_count: number
}

export interface PlanSummary {
  id: string
  space_id: string
  project_folder_id: string | null
  project_id: string | null
  source_task_id: string
  root_run_id: string | null
  name: string
  description: string | null
  status: string
  created_by_user_id: string | null
  created_by_agent_id: string | null
  created_at: string
  updated_at: string
  current_version: PlanVersionSummary | null
}

export interface PlanBudgetSource {
  source: {
    kind: string
    id?: string | null
  }
  precedence?: number
  max_runs?: number
  max_attempts?: number
  max_cost?: number
  max_duration_seconds?: number
}

export interface PlanExecuteBody {
  agent_id?: string | null
  prompt?: string | null
  instruction?: string | null
  runtime_profile_id?: string | null
}

export interface PlanExecutionResult {
  plan_id: string
  root_run_id?: string | null
  scheduled_node_ids: string[]
  status?: string
  root_status?: string
  idempotent?: boolean
}

export interface PlanDetail extends PlanSummary {
  current_version: PlanVersionSummary & {
    reference_workflow_version_id: string | null
    planner_mode: string
    approval_proposal_id: string | null
    planning_run_id: string | null
    planning_tool_call_id: string | null
    budget_json: Record<string, unknown>
    definition_json: unknown
    nodes: Array<{
      id: string
      node_key: string
      title: string
      description: string | null
      node_kind: string
      status: string
      assigned_agent_id: string | null
      runtime_profile_id: string | null
      capability_id: string | null
      risk_level: string
      blocked_reason: string | null
      approval_proposal_id: string | null
      latest_run: { run_id: string; status: string; outcome_status: string | null } | null
    }>
    created_at: string
    updated_at: string
  }
}

export interface WorkflowExecutionSummary {
  workflow_execution_id: string
  automation_id: string
  workflow_version_id: string
  status: string
  trigger_type: string
  root_run_id: string | null
  created_at: string
  updated_at: string
  node_count: number
  completed_node_count: number
  waiting_node_count: number
}

export interface EvolutionBundleMember {
  id: string
  bundle_id: string
  proposal_id: string
  position: number
  status: string
  decision_note: string | null
  decided_by_user_id: string | null
  decided_at: string | null
  created_at: string | null
  before_snapshot_available: boolean
  after_snapshot_available: boolean
  rollback_supported?: boolean | null
  rollback_blocker?: string | null
  proposal: {
    id: string
    proposal_type: string
    status: string
    risk_level: string
    title: string
    summary: string | null
    created_at: string | null
  }
}

export interface EvolutionBundle {
  id: string
  space_id: string
  title: string
  description: string | null
  status: string
  risk_level: string
  created_by_user_id: string
  created_at: string | null
  updated_at: string | null
  decided_at: string | null
  rolled_back_at: string | null
  rollback_error: string | null
  member_count: number
  pending_count: number
  approved_count: number
  rollbackable: boolean
  rollback_blockers: string[]
  members?: EvolutionBundleMember[]
}

export interface RunStatusOut {
  id: string
  status: string
  mode: string
  run_type: string
  trigger_origin: string
  started_at: string | null
  ended_at: string | null
  error_message: string | null
}

export interface AgentRunMention {
  agent_id: string
  handle?: string | null
  display_name?: string | null
}

export interface AgentRunGroup {
  id: string
  space_id: string
  root_run_id: string | null
  manager_user_id: string
  manager_agent_id: string | null
  room_id: string | null
  session_id: string | null
  trigger_message_id: string | null
  project_id: string | null
  project_folder_id: string | null
  title: string
  goal: string
  status: string
  budget_json: Record<string, unknown> | null
  policy_snapshot_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
  ended_at: string | null
}

export interface Room {
  id: string
  space_id: string
  project_id: string
  project_folder_id: string | null
  created_by_user_id: string
  title: string
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface RoomUserMember {
  id: string
  space_id: string
  room_id: string
  user_id: string
  role: 'owner' | 'member'
  status: 'active' | 'removed'
  created_at: string
  updated_at: string
}

export interface RoomAgentMember {
  id: string
  space_id: string
  room_id: string
  agent_id: string
  role: 'manager' | 'member'
  status: 'active' | 'removed'
  created_at: string
  updated_at: string
}

export interface RoomDetail {
  room: Room
  user_members: RoomUserMember[]
  agent_members: RoomAgentMember[]
}

export interface RoomConversation {
  id: string
  space_id: string
  room_id: string
  project_id: string
  user_id: null
  project_folder_id: string | null
  title: string | null
  status: string
  created_at: string
  updated_at: string
}

export interface RoomMessage {
  id: string
  space_id: string
  session_id: string
  user_id: string | null
  sender_agent_id: string | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  metadata_json: Record<string, unknown> | null
  created_at: string
}

export interface CreateRoomRequest {
  project_id: string
  project_folder_id?: string | null
  title: string
  manager_agent_id: string
  agent_ids: string[]
  user_ids: string[]
}

export interface SendRoomMessageRequest {
  content: string
  routing_mode?: 'direct' | 'agent_coordination'
  recipient_segments?: Array<{
    recipient_agent_ids: string[]
    content: string
  }> | null
  backends?: Array<{
    agent_id: string
    runtime_profile_id: string
    credential_profile_id?: string | null
  }>
}

export interface AgentRunGroupMember {
  id: string
  space_id: string
  group_id: string
  agent_id: string
  role: string
  status: string
  capabilities_json: Record<string, unknown> | null
  context_policy_json: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface AgentRunMessage {
  id: string
  space_id: string
  group_id: string
  run_id: string | null
  parent_message_id: string | null
  sender_actor_ref_json: Record<string, unknown>
  sender_user_id: string | null
  sender_agent_id: string | null
  message_type: string
  content: string
  mentions_json: AgentRunMention[]
  metadata_json: Record<string, unknown> | null
  created_at: string
}

export interface RunDelegation {
  id: string
  space_id: string
  group_id: string
  parent_run_id: string
  child_run_id: string | null
  request_message_id: string | null
  requesting_agent_id: string
  target_agent_id: string
  requested_by_user_id: string | null
  policy_decision_record_id: string | null
  status: string
  instruction: string
  reason: string | null
  budget_json: Record<string, unknown> | null
  context_policy_json: Record<string, unknown> | null
  result_summary: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface CreateAgentRunGroupRequest {
  space_id: string
  title: string
  goal?: string
  manager_agent_id: string
  member_agent_ids: string[]
  budget_json?: Record<string, unknown> | null
  context_policy_json?: Record<string, unknown> | null
}

export interface CreateAgentRunGroupResponse {
  group: AgentRunGroup
  members: AgentRunGroupMember[]
}

export interface UpdateAgentRunGroupRequest {
  space_id: string
  title?: string
  goal?: string
}

export interface UpdateAgentRunGroupResponse {
  group: AgentRunGroup
}

export type AgentRunMessageRoutingMode = 'direct' | 'agent_coordination'

export interface AgentRunMessageRecipientSegment {
  recipient_agent_ids: string[]
  content: string
}

export interface SendAgentRunGroupMessageRequest {
  space_id: string
  group_id: string
  content: string
  parent_message_id?: string | null
  routing_mode?: AgentRunMessageRoutingMode
  recipient_segments?: AgentRunMessageRecipientSegment[] | null
  metadata_json?: Record<string, unknown> | null
}

export interface SendAgentRunGroupMessageResponse {
  message: AgentRunMessage
}

export interface AgentRunGroupTimeline {
  group: AgentRunGroup
  members: AgentRunGroupMember[]
  messages: AgentRunMessage[]
  delegations: RunDelegation[]
}

export interface AgentRunGroupTrace {
  group: AgentRunGroup
  members: AgentRunGroupMember[]
  root_run_id: string | null
  timeline: AgentRunGroupTimeline
  child_run_ids: string[]
  artifact_ids: string[]
  proposal_ids: string[]
  policy_decision_record_ids: string[]
}

export interface ArtifactSummary {
  id: string
  space_id: string
  run_id: string | null
  proposal_id: string | null
  artifact_type: string
  title: string
  mime_type: string | null
  visibility?: ObjectVisibility
  created_at: string
}

export interface ProposalSummary {
  id: string
  space_id: string
  proposal_type: string
  status: string
  title: string
  visibility?: ObjectVisibility
  created_at: string
}

export interface TaskRunListItem {
  link: TaskRunOut
  run: Run
}

export interface TaskArtifact {
  id: string
  space_id: string
  task_id: string
  artifact_id: string
  run_id: string | null
  role: string
  created_at: string
  artifact: ArtifactSummary & { preview?: boolean }
}

export interface TaskProposal {
  id: string
  space_id: string
  task_id: string
  proposal_id: string
  role: string
  created_at: string
  proposal: ProposalSummary & {
    preview?: boolean
    urgency?: string
    expired?: boolean
  }
}

export interface Artifact {
  id: string
  space_id: string
  run_id: string | null
  proposal_id: string | null
  artifact_type: string
  surface_role: 'user_output' | 'operational' | 'system_archive'
  title: string
  mime_type: string | null
  exportable: boolean
  preview: boolean
  storage_ref: string | null
  storage_path: string | null
  metadata_json?: Record<string, unknown> | null
  has_inline_content: boolean
  visibility?: ObjectVisibility
  owner_user_id?: string | null
  content?: string | null
  project_id?: string | null
  project_folder_id?: string | null
  created_at: string
  updated_at: string
}

/** Canonical proposal (`GET /proposals`, `ProposalOut`). */
export interface Proposal {
  id: string
  space_id: string
  user_id: string
  project_folder_id: string | null
  source_session_id: string | null
  source_task_id: string | null
  source_run_id: string | null
  created_by_run_id: string | null
  proposal_type: string
  target_scope: string
  target_namespace: string
  memory_type: string
  proposed_title: string
  proposed_content: string
  rationale: string
  status: string
  risk_level: string
  urgency: string
  visibility?: ObjectVisibility
  preview: boolean
  review_deadline: string | null
  expires_at: string | null
  expired: boolean
  created_at: string
  decided_at: string | null
  resulting_memory_id: string | null
  owner_user_id?: string | null
  subject_user_id?: string | null
  sensitivity_level?: string | null
  access_level?: ContentAccessLevel | null
  grant_id?: string | null
  required_approver_user_id?: string | null
  requires_approval_type?: string | null
  egress_approval_status?: string | null
  egress_approval_id?: string | null
  incomplete_patch?: boolean
  skipped_changes?: Array<Record<string, unknown>>
  skipped_count?: number
}

/** `POST /proposals/{id}/accept` — result depends on `proposal_type`. */
export type ProposalAcceptOut = {
  proposal: Proposal
  result_type: 'memory_entry'
  result: { memory: Memory }
} | {
  proposal: Proposal
  result_type: 'code_patch_apply'
  result: { updated_paths: string[] }
} | {
  proposal: Proposal
  result_type: 'policy_version'
  result: { policy_id: string; policy_version: number }
} | {
  proposal: Proposal
  result_type: 'egress_review'
  result: { approved_egress_review: boolean }
} | {
  proposal: Proposal
  result_type: 'follow_up_task'
  result: { task_id: string; title: string }
} | {
  proposal: Proposal
  result_type: 'agent_version'
  result: { agent_id: string; agent_version_id: string }
} | {
  proposal: Proposal
  result_type: 'knowledge_item'
  result: { knowledge_item: KnowledgeItem }
} | {
  proposal: Proposal
  result_type: 'claim'
  result: { claim: Record<string, unknown> }
} | {
  proposal: Proposal
  result_type: 'object_relation'
  result: { object_relation: Record<string, unknown> }
} | {
  proposal: Proposal
  result_type: 'capability_overlay'
  result: Record<string, unknown>
} | {
  proposal: Proposal
  result_type: 'retrieval_maintenance_packet'
  result: {
    report_artifact_id?: string | null
    generated_child_proposal_ids?: string[]
    generated_child_proposal_count?: number
  }
} | {
  proposal: Proposal
  result_type: 'claim_candidate_packet'
  result: {
    packet_artifact_id?: string | null
    generated_child_proposal_ids?: string[]
    generated_child_proposal_count?: number
    skipped_child_proposal_count?: number
    skipped_child_proposals?: Record<string, unknown>[]
    canonical_write_performed?: boolean
  }
} | {
  proposal: Proposal
  result_type: 'object_kind'
  result: Record<string, unknown>
} | {
  proposal: Proposal
  result_type: 'memory_maintenance_packet'
  result: {
    report_artifact_id?: string | null
    generated_child_proposal_ids?: string[]
    generated_child_proposal_count?: number
  }
} | {
  proposal: Proposal
  result_type: 'retrieval_diagnostics_packet'
  result: {
    report_artifact_id?: string | null
    generated_child_proposal_ids?: string[]
    generated_child_proposal_count?: number
  }
} | {
  proposal: Proposal
  result_type: 'relation_discovery_packet'
  result: {
    generated_child_proposal_ids?: string[]
    generated_child_proposal_count?: number
  }
} | {
  proposal: Proposal
  result_type: 'custom_source_handler_version'
  result: {
    source_connection_id: string
    handler_version_id: string
    previous_handler_version_id?: string | null
    status: 'active'
    handler_version?: Record<string, unknown>
  }
}

export interface PersonalMemoryGrantSafeMemoryFilter {
  max_items?: number
}

export interface PersonalMemoryGrantPreviewRequest {
  target_space_id: string
  target_run_id: string
  access_mode: 'summary_only'
  read_expires_in_seconds?: number
  memory_filter?: PersonalMemoryGrantSafeMemoryFilter | null
}

export interface PersonalMemoryGrantPreviewResponse {
  eligible: boolean
  target_space_id: string
  target_run_id: string
  access_mode: 'summary_only'
  proposed_read_expires_at: string | null
  warnings: string[]
  excluded_sensitivity_levels: string[]
  max_items: number | null
}

export interface PersonalMemoryGrantCreateRequest {
  target_space_id: string
  target_run_id: string
  access_mode: 'summary_only'
  read_expires_in_seconds: number
  memory_filter?: PersonalMemoryGrantSafeMemoryFilter | null
}

export type PersonalMemoryGrantStatus =
  | 'active'
  | 'consuming'
  | 'used'
  | 'revoked'
  | 'expired'
  | 'failed'

export interface PersonalMemoryGrantResponse {
  id: string
  granting_user_id: string
  personal_space_id: string
  target_space_id: string
  target_run_id: string
  target_agent_id: string | null
  grant_scope: 'run' | string
  access_mode: 'summary_only' | string
  status: PersonalMemoryGrantStatus | string
  memory_filter_json: PersonalMemoryGrantSafeMemoryFilter | Record<string, unknown> | null
  read_expires_at: string
  revoked_at: string | null
  used_at: string | null
  created_at: string
  updated_at: string
}

export interface PersonalMemoryGrantEvent {
  id: string
  grant_id: string
  event_type: string
  actor_user_id: string | null
  run_id: string | null
  metadata_json: Record<string, unknown> | null
  created_at: string
}

export interface PersonalMemoryGrantAuditResponse {
  grant: PersonalMemoryGrantResponse
  events: PersonalMemoryGrantEvent[]
}

export interface EgressApprovalRequest {
  grant_id?: string | null
}

export interface ProposalApprovalResponse {
  id: string
  proposal_id: string
  approval_type: 'egress_granting_user' | string
  approver_user_id: string
  grant_id: string | null
  target_space_id: string | null
  status: 'approved' | 'revoked' | string
  metadata_json: Record<string, unknown> | null
  created_at: string
  revoked_at: string | null
}

export interface EvolutionSummaryOut {
  active_targets: number
  signals_collected: number
  pending_proposals: number
  recent_runs: number
}

export interface EvolutionTarget {
  id: string
  space_id: string | null
  target_name: string | null
  target_type: string
  target_ref_type: string | null
  target_ref_id: string | null
  capability_key: string | null
  current_version_id: string | null
  current_version: string | null
  scope: string | null
  purpose: string | null
  risk_level: string
  status: string
  enabled: boolean
  recent_signal_count: number
  last_run_at: string | null
  engine_policy_json: Record<string, unknown>
  metadata_json: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface EvolutionTargetCreateBody {
  target_type: string
  target_ref_type?: string | null
  target_ref_id?: string | null
  capability_key?: string | null
  current_version_id?: string | null
  risk_level?: string
  enabled?: boolean
  status?: string
  target_name?: string | null
  purpose?: string | null
  engine_policy_json?: Record<string, unknown>
  metadata_json?: Record<string, unknown>
}

export interface EvolutionTargetUpdateBody {
  target_type?: string | null
  target_ref_type?: string | null
  target_ref_id?: string | null
  capability_key?: string | null
  current_version_id?: string | null
  risk_level?: string | null
  enabled?: boolean | null
  status?: string | null
  target_name?: string | null
  purpose?: string | null
  engine_policy_json?: Record<string, unknown> | null
  metadata_json?: Record<string, unknown> | null
}

export interface EvolutionSignal {
  id: string
  space_id: string | null
  target_id: string
  target_name: string | null
  target_type: string | null
  capability_key: string | null
  signal_type: string
  source_type: string
  source_id: string | null
  severity: string
  summary: string | null
  payload_json: Record<string, unknown>
  triage_status?: 'new' | 'acknowledged' | 'dismissed' | 'actioned'
  triaged_at?: string | null
  triage_note?: string | null
  created_at: string
}

export interface EvolutionSignalCreateBody {
  signal_type: string
  source_type: string
  source_id?: string | null
  severity?: string
  summary?: string | null
  payload_json?: Record<string, unknown>
}

export interface EvolutionRunListItem {
  run_id: string
  target_id: string | null
  target_name: string | null
  target_type: string | null
  capability_key: string | null
  strategy_key?: string | null
  engine: string | null
  status: string
  created_at: string
  started_at: string | null
  artifact_count: number
}

export interface EvolutionRunResult {
  run_id: string
  target_id: string
  selector_decision_id: string
  selected_strategy_key: string | null
  run_status: string
  proposal_ids: string[]
}

export interface EvolutionProposal {
  id: string
  proposal_type: string
  target_id: string | null
  target_name: string | null
  target_type: string | null
  capability_key: string | null
  status: string
  summary: string | null
  created_at: string
  created_by_run_id: string | null
  incomplete_patch?: boolean
  skipped_count?: number
  grant_id?: string | null
  required_approver_user_id?: string | null
  requires_approval_type?: string | null
  egress_approval_status?: string | null
  bundle_id?: string | null
  bundle_member_status?: string | null
}

export interface EvolutionStrategy {
  id: string
  space_id: string | null
  strategy_key: string
  name: string
  description: string | null
  category: string
  target_type: string
  status: string
  risk_level: string
  signals_match: string[]
  preconditions_json: Record<string, unknown>
  strategy_steps: string[]
  constraints: string[]
  validation_policy_json: Record<string, unknown>
  tool_policy_json: Record<string, unknown>
  routing_hint_json: Record<string, unknown>
  provenance_type: string
  source_ref_json: Record<string, unknown>
  success_count: number
  failure_count: number
  confidence_score: number
  last_selected_at: string | null
  created_at: string
  updated_at: string
}

export interface EvolutionSelectorDecision {
  id: string
  space_id: string
  target_id: string
  target_name: string | null
  target_type: string | null
  run_id: string | null
  selected_strategy_asset_id: string | null
  selected_strategy_key: string | null
  selected_strategy_name: string | null
  candidate_strategy_ids: unknown[]
  input_signal_ids: unknown[]
  decision_reason: string | null
  score_trace_json: Record<string, unknown>
  rejected_reasons_json: unknown[]
  created_at: string
}

export interface EvolutionExperience {
  id: string
  space_id: string
  strategy_asset_id: string | null
  strategy_key: string | null
  strategy_name: string | null
  target_id: string | null
  target_name: string | null
  source_run_id: string | null
  source_proposal_id: string | null
  experience_key: string
  summary: string
  trigger_signals: unknown[]
  outcome_status: string
  confidence_score: number
  blast_radius_json: Record<string, unknown>
  validation_trace_json: Record<string, unknown>
  execution_trace_json: Record<string, unknown>
  lessons: unknown[]
  anti_patterns: unknown[]
  environment_fingerprint_json: Record<string, unknown>
  provenance_type: string
  created_at: string
}

export interface EvolutionValidationResult {
  metric_id: string
  label: string
  evaluator: string
  target_id: string
  target_name: string | null
  value: unknown | null
  status: string
  window: string | null
  goal: Record<string, unknown>
  sample_size: number
  numerator_count: number | null
  denominator_count: number | null
  updated_at: string | null
  metadata_json: Record<string, unknown>
}

export interface EvolvableAsset {
  id: string
  space_id: string | null
  asset_type: string
  asset_key: string
  display_name: string
  description: string | null
  owner_scope_type: string
  owner_scope_id: string | null
  status: string
  current_system_version_id: string | null
  default_eval_suite_ref: Record<string, unknown> | null
  metadata_json: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface EvolvableAssetVersion {
  id: string
  asset_id: string
  scope_type: string
  scope_id: string | null
  parent_version_id: string | null
  version: number
  status: string
  source: string
  content_ref: string | null
  content_hash: string | null
  content_json: unknown | null
  eval_summary_json: unknown | null
  promotion_proposal_id: string | null
  created_by_user_id: string | null
  approved_by_user_id: string | null
  created_at: string
  updated_at: string
  stale_parent: boolean
}

export interface EvolvableAssetPin {
  id: string
  asset_id: string
  scope_type: string
  scope_id: string
  version_id: string
  status: string
  pinned_by_user_id: string | null
  reason: string | null
  created_at: string
  updated_at: string
}

export interface EvolvableAssetEvaluationRun {
  id: string
  asset_id: string
  candidate_version_id: string
  baseline_version_id: string | null
  evolution_target_id: string | null
  run_id: string | null
  eval_suite_ref: Record<string, unknown>
  evaluator_version: string
  model_provider_ref: Record<string, unknown> | null
  status: string
  metrics: Record<string, unknown>
  blockers: unknown[]
  output_artifact_id: string | null
  report_artifact_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface EvolvableAssetEvaluationCase {
  id: string
  space_id: string
  asset_id: string
  name: string
  description: string | null
  input_json: Record<string, unknown>
  expectation_json: Record<string, unknown>
  verification_recipe_json: Record<string, unknown>
  baseline_output_json?: unknown
  baseline_version_id: string
  source_run_id: string | null
  status: string
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface ResolvedEvolvableAssetVersion {
  assetId: string
  versionId: string
  contentRef: string | null
  contentHash: string | null
  contentJson: unknown | null
  resolutionTrace: string[]
  fallbackReason: string | null
}

export type PromptType =
  | 'chat'
  | 'text'
  | 'workflow'
  | 'retrieval_query'
  | 'retrieval_rerank'
  | 'retrieval_synthesis'
  | 'condenser'
  | 'agent_system'

export type PromptAssetScopeType = 'system' | 'space' | 'project' | 'user' | 'agent'

export type PromptVersionStatus =
  | 'draft'
  | 'candidate'
  | 'testing'
  | 'approved'
  | 'deprecated'
  | 'archived'

export type PromptVersionSource =
  | 'built_in'
  | 'user_authored'
  | 'evolved'
  | 'imported'
  | 'generated'

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface PromptAssetContent {
  schema_version?: 'prompt_asset.v1'
  prompt_type?: PromptType
  messages?: PromptMessage[] | null
  template?: string | null
  variables_schema?: Record<string, unknown>
  output_schema?: Record<string, unknown>
  model_config?: Record<string, unknown>
  rendering?: Record<string, unknown>
  safety?: Record<string, unknown>
  [key: string]: unknown
}

export interface PromptAssetSummary {
  id: string
  space_id: string | null
  asset_key: string
  display_name: string
  description: string | null
  prompt_type: PromptType | null
  status: 'active' | 'disabled' | 'archived'
  owner_scope_type: PromptAssetScopeType
  owner_scope_id: string | null
  current_system_version_id: string | null
  created_at: string
  updated_at: string
}

export interface PromptAssetDetail extends PromptAssetSummary {
  metadata_json: Record<string, unknown>
}

export interface PromptVersion {
  id: string
  asset_id: string
  space_id: string | null
  scope_type: PromptAssetScopeType
  scope_id: string | null
  parent_version_id: string | null
  version: number
  status: PromptVersionStatus
  source: PromptVersionSource
  content: PromptAssetContent | null
  content_hash: string | null
  eval_summary_json: Record<string, unknown> | null
  promotion_proposal_id: string | null
  created_by_user_id: string | null
  approved_by_user_id: string | null
  created_at: string
  updated_at: string
  stale_parent: boolean
}

export interface PromptVersionCreateRequest {
  scope_type?: PromptAssetScopeType
  scope_id?: string | null
  parent_version_id?: string | null
  source?: PromptVersionSource
  content_ref?: string | null
  content_hash?: string | null
  content_json: PromptAssetContent
}

export interface PromptDeploymentRef {
  id: string
  space_id: string | null
  asset_id: string
  scope_type: PromptAssetScopeType
  scope_id: string | null
  label: string
  version_id: string
  status: 'active' | 'archived'
  promoted_by_user_id: string | null
  promoted_from_proposal_id: string | null
  created_at: string
  updated_at: string
}

export interface PromptRenderPreviewRequest {
  version_id?: string | null
  content_json?: PromptAssetContent
  variables?: Record<string, unknown>
}

export interface PromptRenderPreviewResult {
  asset_key: string
  version_id: string | null
  rendered_messages: PromptMessage[] | null
  rendered_text: string | null
  validation_warnings: string[]
  validation_errors: string[]
}

export interface PromptEvaluationRequest {
  version_id: string
  eval_suite_ref: Record<string, unknown>
  evaluator_version: string
  status?: 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled'
  baseline_version_id?: string | null
  run_id?: string | null
  model_provider_ref?: Record<string, unknown> | null
  metrics?: Record<string, unknown>
  blockers?: unknown[]
  output_artifact_id?: string | null
  report_artifact_id?: string | null
}

export interface PromptEvaluationResult {
  id: string
  asset_id: string
  candidate_version_id: string
  baseline_version_id: string | null
  run_id: string | null
  eval_suite_ref: Record<string, unknown>
  evaluator_version: string
  status: string
  metrics: Record<string, unknown>
  blockers: unknown[]
  output_artifact_id: string | null
  report_artifact_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface PromptPromotionRequest {
  version_id: string
  label?: string
  scope_type?: PromptAssetScopeType
  scope_id?: string | null
  deprecate_previous?: boolean
  evaluation_run_ids?: string[]
  reason?: string | null
}

export interface PromptRollbackRequest {
  label?: string
  scope_type?: PromptAssetScopeType
  scope_id?: string | null
  version_id?: string | null
}

export interface AgentModelSummary {
  provider_id: string | null
  provider_name: string | null
  provider_type: string | null
  model: string | null
}

export interface AgentOut {
  id: string
  space_id: string
  created_by_user_id: string
  name: string
  description: string | null
  visibility: string
  access_level: ContentAccessLevel
  role_instruction: string | null
  status: string
  // 'standard' | 'system_assistant' (the space's system-managed default Assistant)
  agent_kind: string
  current_version_id: string | null
  // Provenance only — never used to assemble runtime config.
  source_template_id: string | null
  source_template_version_id: string | null
  model: AgentModelSummary | null
  // Effective runtime adapter and whether it needs a space model provider.
  // CLI runtimes manage their own model/login and require no provider.
  adapter_type: string | null
  requires_model_provider: boolean
  system_prompt: string | null
  created_at: string
  updated_at: string
}

export interface AgentVersionOut {
  id: string
  agent_id: string
  space_id: string
  version_label: string
  model_provider_id: string | null
  model_name: string | null
  system_prompt: string | null
  prompt_provenance_json: Record<string, unknown> | null
  model_config_json: Record<string, unknown>
  runtime_config_json: Record<string, unknown>
  context_policy_json: Record<string, unknown>
  memory_policy_json: Record<string, unknown>
  capabilities_json: unknown[]
  tool_permissions_json: Record<string, unknown>
  runtime_policy_json: Record<string, unknown>
  tool_policy_json: Record<string, unknown>
  output_policy_json: Record<string, unknown>
  schedule_config_json: Record<string, unknown>
  output_schema_json: Record<string, unknown>
  source_proposal_id: string | null
  source_activity_id: string | null
  created_at: string
  published_at: string | null
  archived_at: string | null
}

export interface AgentRuntimeProfileOut {
  id: string
  space_id: string
  agent_id: string
  name: string
  adapter_type: string
  model: AgentModelSummary | null
  runtime_config_json: Record<string, unknown>
  runtime_policy_json: Record<string, unknown>
  enabled: boolean
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface AgentRuntimeProfileCreateBody {
  name: string
  adapter_type: string
  model_provider_id?: string | null
  model_name?: string | null
  runtime_config_json?: Record<string, unknown> | null
  runtime_policy_json?: Record<string, unknown> | null
  enabled?: boolean
  is_default?: boolean
}

export type AgentRuntimeProfileUpdateBody = Partial<AgentRuntimeProfileCreateBody>

export interface AgentTemplateOut {
  id: string
  key: string
  name: string
  description: string | null
  category: string | null
  scope: 'system' | 'space' | 'user'
  space_id: string | null
  owner_user_id: string | null
  visibility: 'private' | 'space_shared' | 'system_public' | 'system_internal'
  status: 'draft' | 'published' | 'archived'
  current_version_id: string | null
  created_at: string
  updated_at: string
}

export type AssistantResponseStyle = 'neutral' | 'friendly' | 'direct' | 'formal'
export type AssistantVerbosity = 'concise' | 'balanced' | 'detailed'
export type AssistantProposalStyle = 'proactive' | 'balanced' | 'conservative'

export interface SpaceAssistantSettingsOut {
  id: string
  space_id: string
  assistant_agent_id: string | null
  response_style: AssistantResponseStyle | null
  verbosity: AssistantVerbosity | null
  default_context_toggles_json: Record<string, boolean>
  default_project_id: string | null
  proposal_style: AssistantProposalStyle | null
  model_preferences_json: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface SpaceAssistantSettingsUpdate {
  response_style?: AssistantResponseStyle | null
  verbosity?: AssistantVerbosity | null
  default_context_toggles_json?: Record<string, boolean>
  default_project_id?: string | null
  proposal_style?: AssistantProposalStyle | null
  model_preferences_json?: Record<string, unknown>
}

export interface AgentTemplateVersionOut {
  id: string
  template_id: string
  version: string
  system_prompt: string | null
  model_config_json: Record<string, unknown>
  context_policy_json: Record<string, unknown>
  memory_policy_json: Record<string, unknown>
  tool_policy_json: Record<string, unknown>
  runtime_policy_json: Record<string, unknown>
  output_policy_json: Record<string, unknown>
  schedule_defaults_json: Record<string, unknown>
  output_schema_json: Record<string, unknown>
  created_by_user_id: string | null
  created_at: string
  published_at: string | null
}

/** Editable areas for the agent config UI (`POST /agents/{id}/config`). */
export interface AgentConfigUpdateBody {
  name?: string | null
  description?: string | null
  system_prompt?: string | null
  model_provider_id?: string | null
  model_name?: string | null
  model_config_json?: Record<string, unknown> | null
  runtime_config_json?: Record<string, unknown> | null
  context_policy_json?: Record<string, unknown> | null
  memory_policy_json?: Record<string, unknown> | null
  output_policy_json?: Record<string, unknown> | null
  schedule_config_json?: Record<string, unknown> | null
  output_schema_json?: Record<string, unknown> | null
}

export interface CreateAgentFromTemplateBody {
  template_version_id?: string | null
  space_id?: string | null
  name?: string | null
  description?: string | null
  default_model_provider_id?: string | null
  default_model?: string | null
  adapter_type?: string | null
  runtime_config_json?: Record<string, unknown> | null
  model_config_json?: Record<string, unknown> | null
  schedule_config_json?: Record<string, unknown> | null
  system_prompt?: string | null
  context_policy_json?: Record<string, unknown> | null
  memory_policy_json?: Record<string, unknown> | null
  output_policy_json?: Record<string, unknown> | null
  output_schema_json?: Record<string, unknown> | null
}

export interface AgentCreateBody {
  name: string
  description?: string | null
  visibility?: string
  role_instruction?: string | null
  system_prompt?: string | null
  default_model_provider_id?: string | null
  default_model?: string | null
  adapter_type?: string | null
  model_config_json?: Record<string, unknown> | null
  runtime_config_json?: Record<string, unknown> | null
  context_policy_json?: Record<string, unknown> | null
  memory_policy_json?: Record<string, unknown> | null
  capabilities_json?: unknown[] | null
  tool_permissions_json?: Record<string, unknown> | null
  runtime_policy_json?: Record<string, unknown> | null
  tool_policy_json?: Record<string, unknown> | null
  output_policy_json?: Record<string, unknown> | null
  schedule_config_json?: Record<string, unknown> | null
  output_schema_json?: Record<string, unknown> | null
}

export interface AgentUpdateBody {
  name?: string
  description?: string | null
  visibility?: string
  role_instruction?: string | null
  status?: string
  system_prompt?: string | null
  default_model_provider_id?: string | null
  default_model?: string | null
}

export interface RunCreateBody {
  mode?: string
  run_type?: string
  trigger_origin?: string
  session_id?: string | null
  project_folder_id?: string | null
  project_id?: string | null
  prompt?: string | null
  instruction?: string | null
  scheduled_at?: string | null
  parent_run_id?: string | null
  runtime_profile_id?: string | null
  adapter_type?: string | null
  capability_id?: string | null
  capabilities_json?: string[]
  model_provider_id?: string | null
  model?: string | null
  prompt_asset_key?: string | null
  prompt_version_id?: string | null
  prompt_content_hash?: string | null
  context_artifact_ids?: string[]
}

export type ProjectFolderKind = 'code' | 'data' | 'docs'
export type ProjectFolderStatus = 'active' | 'archived'

export interface ProjectFolder {
  id: string
  space_id: string
  project_id: string
  created_by_user_id: string
  name: string
  slug: string | null
  description: string | null
  kind: ProjectFolderKind
  is_primary: boolean
  execution_enabled: boolean
  repo_url: string | null
  root_path: string | null
  default_branch: string | null
  status: ProjectFolderStatus
  protected: boolean
  system_managed: boolean
  registered_from: string | null
  metadata_json: Record<string, unknown> | null
  snapshot_retention_days: number | null
  snapshot_max_count: number | null
  created_at: string
  updated_at: string
}

export interface ProjectFolderCreateBody {
  name: string
  description?: string
  kind?: ProjectFolderKind
  is_primary?: boolean
  repo_url?: string | null
  root_path?: string | null
  default_branch?: string | null
  metadata_json?: Record<string, unknown> | null
}

export type ProjectFolderUpdateBody = Partial<Omit<ProjectFolderCreateBody, 'repo_url'>> & {
  status?: ProjectFolderStatus
  execution_enabled?: boolean
  snapshot_retention_days?: number | null
  snapshot_max_count?: number | null
}

export interface ProjectFolderScanCandidate {
  name: string
  path: string
}

export interface ProjectFolderExecutionConfig {
  id: string
  space_id: string
  project_folder_id: string
  repo_type: string | null
  tech_stack_json: Record<string, unknown>
  important_paths_json: unknown[]
  forbidden_paths_json: unknown[]
  test_commands_json: unknown[]
  build_commands_json: unknown[]
  architecture_boundaries_json: Record<string, unknown>
  validation_recipe_id: string | null
  cloud_allowed: boolean
  max_data_exposure_level: string | null
  min_observability_level: string | null
  created_at: string
  updated_at: string
}

export type ProjectFolderExecutionConfigUpdate = Partial<Omit<ProjectFolderExecutionConfig,
  'id' | 'space_id' | 'project_folder_id' | 'created_at' | 'updated_at'
>>

export type CapabilitySourceKind = 'builtin' | 'imported_skill' | 'generated' | 'official'
export type CapabilityStatus = 'draft' | 'proposed' | 'testing' | 'available' | 'enabled' | 'disabled' | 'archived'
export type SkillRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type SkillPackageStatus = 'imported' | 'reviewed' | 'rejected' | 'converted' | 'archived' | 'superseded'
export type RuntimeRenderMode = 'render_skill' | 'inline_prompt' | 'native_executor' | 'mcp_tool'

export interface CapabilityRuntimeBinding {
  id: string
  capability_id: string
  runtime_adapter_type: string
  render_mode: RuntimeRenderMode
  binding_json: Record<string, unknown>
  enabled: boolean
}

export interface CapabilityDefinition {
  id: string
  namespace: string
  name: string
  description: string
  version: string
  source_kind: CapabilitySourceKind
  input_schema_json: Record<string, unknown>
  output_artifact_types: string[]
  permissions: Record<string, unknown>
  supported_execution_modes: string[]
  default_runtime_bindings: CapabilityRuntimeBinding[]
  status: CapabilityStatus
}

export interface CapabilityPackDescriptor {
  id: string
  name: string
  description: string
  version: string
  capability_ids: string[]
  workflow_template_ids: string[]
  artifact_types: string[]
  source_kind: CapabilitySourceKind
  status: CapabilityStatus
}

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  category: string
  capability_ids: string[]
  input_schema_json: Record<string, unknown>
  default_config_json: Record<string, unknown>
  output_artifact_types: string[]
  proposal_policy: Record<string, unknown>
  recommended_runtime_adapters: string[]
  prompt_asset_keys: string[]
}

export interface ProjectWorkflowProfile {
  id: string
  space_id: string
  project_id: string
  workflow_template_id: string
  name: string
  enabled: boolean
  config_json: Record<string, unknown>
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface ProjectTemplateDescriptor {
  key: string
  name: string
  description: string
  sections: string[]
  extraction_profile_key: string | null
  graph_lens_id: string | null
  initial_primary_mode: ProjectPrimaryMode
  starter_workflow_template_keys: string[]
}

export interface ProjectOverview {
  project: Pick<Project, 'id' | 'name' | 'primary_mode' | 'template_key' | 'status'>
  brief: {
    version: string
    goal: string | null
    scope_included: string | null
    success_definition: string | null
  } | null
  mode_projection: {
    mode: ProjectPrimaryMode
    current_state_summary: string
    progress_indicators: Array<{ metric: string; value: number; trend?: string }>
    focus_set: Array<{ id: string; label: string; href: string }>
    next_actions: Array<{ id: string; label: string; href: string; kind: string }>
  }
  available_modes: ProjectPrimaryMode[]
  attention: Array<{
    id: string
    title: string
    summary: string | null
    href: string
    source_type?: string
    source_id?: string
    reason?: string
    action_descriptors?: Array<{ label: string; href: string }>
  }>
  template?: {
    key: string
    name: string
    description: string
    starter_workflow_template_keys: string[]
  } | null
  setup_checklist?: Array<{
    id: string
    label: string
    status: 'ready' | 'missing'
    required: boolean
    href: string
    detail: string
  }>
  area_summaries: Array<{ mode: ProjectPrimaryMode; summary: { count: number; status: string } }>
}

// ---------------------------------------------------------------------------
// Inquiry Domain. See .agent/architecture/PROJECTS.md.
// ---------------------------------------------------------------------------

export interface InquiryQuestionState {
  current_answer_summary: string | null
  answer_state: 'open' | 'partial' | 'answered' | 'unanswerable'
  known_gaps: string | null
  answerability: string | null
  resolution_criteria: string | null
}

export interface InquiryHypothesisState {
  proposed_claim: string | null
  predictions: string | null
  falsification_criteria: string | null
  evaluation_state: 'untested' | 'supported' | 'challenged' | 'contradicted' | 'inconclusive'
  confidence: number | null
  confidence_method: string | null
}

export interface InquiryThreadRelation {
  id: string
  from_thread_id: string
  to_thread_id: string
  relation_kind: string
  created_at: string
}

export interface InquiryThreadNoteLink {
  id: string
  note_object_id: string
  link_kind: 'primary_working_note' | 'linked_note'
  created_at: string
}

export interface InquiryThreadDetail extends InquiryThread {
  question_state: InquiryQuestionState | null
  hypothesis_state: InquiryHypothesisState | null
  relations: InquiryThreadRelation[]
  note_links: InquiryThreadNoteLink[]
  decision_cases?: Array<{ id: string; title: string; status: string }>
  in_personal_focus: boolean
}

export interface InquiryThreadRevision {
  id: string
  thread_id: string
  version: number
  kind: 'question' | 'hypothesis'
  statement: string
  answer_state: InquiryQuestionState['answer_state'] | null
  evaluation_state: InquiryHypothesisState['evaluation_state'] | null
  confidence: number | null
  state_snapshot_json: Record<string, unknown>
  change_significance: 'trivial' | 'material'
  created_by_user_id: string | null
  created_at: string
}

export type ExperimentExecutorType = 'manual' | 'managed_code_comparison'
export type ExperimentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ExperimentVersion {
  id: string
  definition_id: string
  version: number
  executor_type: ExperimentExecutorType
  config: Record<string, unknown>
  planned_summary: string | null
  status: 'draft' | 'approved' | 'archived'
  created_at: string
  updated_at: string
}

export interface ExperimentDefinition {
  id: string
  project_id: string
  name: string
  objective: string | null
  primary_hypothesis_thread_id: string | null
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
  baseline_run_id: string | null
  best_run_id: string | null
  created_at: string
  updated_at: string
  versions?: ExperimentVersion[]
}

export interface ExperimentRun {
  id: string
  version_id: string
  run_id: string | null
  is_baseline: boolean
  hypothesis: string | null
  patch_summary: string | null
  commit_ref: string | null
  status: ExperimentRunStatus
  config_snapshot: Record<string, unknown>
  artifact_ids: string[]
  created_at: string
  updated_at: string
}

export interface ExperimentObservation {
  id: string
  run_id: string
  metric_name: string
  value_number: number | null
  value_text: string | null
  value_json: unknown
  is_primary: boolean
  source: 'manual' | 'parsed' | 'agent'
  created_at: string
}

export interface ExperimentInterpretation {
  id: string
  project_id: string
  definition_id: string
  run_ids: string[]
  verdict: 'supports' | 'contradicts' | 'inconclusive'
  conclusion: string | null
  negative_results: string | null
  limitations: string | null
  repro_lock: Record<string, unknown>
  status: 'draft' | 'reviewed' | 'converted'
  resulting_signal_id: string | null
  created_at: string
  updated_at: string
}

export interface ProjectResearchProfile {
  id: string
  project_id: string
  preset_key: string
  research_question: string | null
  working_title: string | null
  domain: string | null
  output_type: string | null
  paper_type: string | null
  citation_style: string | null
  target_venue: string | null
  language: string
  experiment_intake_declaration: string
  status: string
  approved_by_user_id: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
}

export interface ProjectResearchWorkflow {
  id: string
  project_id: string
  workflow_type: string
  current_stage: string | null
  status: string
  mode: string
  state_json: Record<string, unknown>
  primary_thread_id: string | null
  started_by_user_id: string | null
  started_run_id: string | null
  created_at: string
  updated_at: string
}

/** One aggregated monitoring outcome per (workflow, UTC day); a missing day means no scan was recorded. */
export interface ProjectResearchScanSummary {
  workflow_id: string
  scan_date: string
  scanned_at: string
  new_item_count: number
  relevant_count: number
  maybe_count: number
  excluded_count: number
  supports_count: number
  contradicts_count: number
  new_direction_count: number
  comparisons: Array<{ source_item_id: string; stance: 'supports' | 'contradicts' | 'new_direction'; detail: string; affected_sections: string[] }>
  integrity_alerts: Array<{ id: string; doi: string; event_type: 'retraction' | 'correction' | 'expression_of_concern' | 'reinstatement'; source: string; notice_doi: string | null; detected_at: string }>
  scan_count: number
}

export interface ProjectResearchQuestionImpact {
  workflow_id: string
  previous_question: string | null
  current_question: string | null
  previous_version: number
  screened_papers: number
  reports: number
}

export type ProjectResearchQuestionResolutionStrategy = 'rescreen' | 'synthesis_only' | 'apply_forward'

export interface ProjectResearchInitialIntakeResponse {
  workflow: ProjectResearchWorkflow | null
  operation: ProjectOperation
  source_channel: SourceChannel | null
  source_channels: SourceChannel[]
  source_binding: ProjectSourceBinding | null
  source_bindings: ProjectSourceBinding[]
  status: string
}

export interface ProjectResearchCheckpoint {
  id: string
  project_id: string
  workflow_id: string
  stage_key: string
  checkpoint_type: string
  status: string
  machine_result_json: Record<string, unknown> | null
  review: ProjectResearchCheckpointReview | null
  user_decision: string | null
  decision_reason: string | null
  decided_by_user_id: string | null
  decided_at: string | null
  created_at: string
  updated_at: string
}

export interface ProjectResearchCheckpointReview {
  type: 'screening' | 'ideas'
  title: string
  description: string
  decision_scope: 'batch'
  decision_help: string
  summary: {
    total?: number
    classified?: number
    unclassified?: number
    relevant?: number
    maybe?: number
    excluded?: number
    missing_full_text?: number
    evidence_count?: number
    failed_items?: number
    processing_status?: 'complete' | 'incomplete' | 'empty'
    partial?: boolean
    coverage_degraded?: boolean
    deferred_source_count?: number
  }
  usage?: {
    agent_run_count: number
    completed_agent_run_count: number
    input_tokens: number | null
    output_tokens: number | null
    total_tokens: number | null
    estimated_cost_usd: number | null
    cost_known: boolean
    model_names: string[]
  }
  next_step?: {
    key: string
    label: string
    description: string
  }
  items: Array<{
    source_item_id?: string
    title: string
    source_uri?: string | null
    external_id?: string | null
    author?: string | null
    occurred_at?: string | null
    recommendation?: 'relevant' | 'maybe' | 'not_relevant' | 'unreviewed'
    confidence?: number | null
    reason?: string | null
    full_text_status?: string
    evidence_available?: boolean
    human_triage?: string
    problem?: string | null
    novelty?: string | null
    testability?: string | null
    reference_count?: number
  }>
  item_count: number
  displayed_item_count: number
  truncated: boolean
}

export interface ProjectResearchReport {
  id: string
  project_id: string
  workflow_id: string
  operation_id: string
  synthesis_run_id: string
  run_kind: 'baseline' | 'historical_backfill' | 'incremental' | 'question_rescreen' | 'synthesis_only'
  research_question: string
  research_question_version: number
  status: 'awaiting_review' | 'complete' | 'rejected'
  current_research_question?: string | null
  created_at: string
  updated_at: string
  content?: ResearchReportV1
  reader_document?: Record<string, unknown>
  normalized_text?: string
  content_hash?: string
  integrity?: { artifact_id: string | null; status: 'available' | 'not_run' }
  provenance?: { workflow_id: string; operation_id: string; synthesis_run_id: string }
  archive_descriptors?: Array<{ kind: 'archive' | 'literature_matrix' | 'integrity'; artifact_id: string }>
  resolved_references?: Array<{ id: string; availability: 'available' | 'unavailable'; title?: string; authors?: string[]; year?: number | null; library_path?: string; academic_path?: string; external_url?: string; excerpts?: Array<{ id: string; title?: string }> }>
}

export interface ResearchReportV1 {
  schema_version: 'research_report.v1'
  research_question: string
  summary: string
  findings: Array<{ claim: string; support: string; references: Array<Record<string, string>> }>
  sources: Array<{ title: string; authors: string[]; year?: number | null; relevance: 'relevant' | 'maybe' | 'not_relevant'; summary?: string; references: Array<Record<string, string>> }>
  limitations: string[]
  ideas: Array<{ title: string; problem: string; novelty: string; testability: string; references: Array<Record<string, string>> }>
}

export interface ProjectResearchScreeningCriteria {
  id: string | null
  project_id: string
  include_keywords: string[]
  exclude_keywords: string[]
  methods: string[]
  date_range_start: string | null
  date_range_end: string | null
  venues: string[]
  required_evidence_fields: string[]
  created_at: string | null
  updated_at: string | null
}

export interface ProjectResearchLiteratureMatrixItem {
  corpus_item_id: string
  object_id: string | null
  title: string | null
  summary: string | null
  triage_status: string
  relevance: string | null
  confidence: number | null
  reason: string | null
  evidence_count: number
  annotation_count: number
  academic: {
    arxiv_id: string | null
    doi: string | null
    publication_date: string | null
    venue: string | null
    paper_type: string | null
    cited_by_count: number | null
    reference_count: number | null
    source_uri: string | null
    authors: unknown[]
    categories: unknown[]
  } | null
}

export type AcademicPaperType =
  | 'article'
  | 'preprint'
  | 'conference_paper'
  | 'book_chapter'
  | 'thesis'
  | 'report'
  | 'other'

export interface AcademicPaper {
  object_id: string
  title: string
  summary: string | null
  status: string
  doi: string | null
  arxiv_id: string | null
  pmid: string | null
  openalex_id: string | null
  publication_date: string | null
  venue: string | null
  paper_type: AcademicPaperType
  cited_by_count: number | null
  reference_count: number | null
  created_at: string
  updated_at: string
}

export interface AcademicPaperCreate {
  title: string
  summary?: string | null
  doi?: string | null
  arxiv_id?: string | null
  pmid?: string | null
  openalex_id?: string | null
  publication_date?: string | null
  venue?: string | null
  paper_type?: AcademicPaperType
  source_uri?: string | null
}

export interface AcademicPaperUpdate {
  title?: string
  summary?: string | null
  venue?: string | null
  cited_by_count?: number | null
  reference_count?: number | null
}

export interface AcademicPaperAuthor {
  person_object_id: string
  title: string
  author_position: number | null
  is_corresponding: boolean
}

export interface AcademicPaperCitation {
  paper_object_id: string
  title: string
  doi: string | null
  arxiv_id: string | null
}

export interface WorkflowRunDraftRequest {
  agent_id?: string | null
  runtime_profile_id?: string | null
  prompt?: string | null
  instruction?: string | null
  project_folder_id?: string | null
  session_id?: string | null
  adapter_type?: string | null
  model_provider_id?: string | null
  model?: string | null
  config_json?: Record<string, unknown>
}

export interface WorkflowRunDraftResponse {
  workflow_template: WorkflowTemplate
  workflow_profile: ProjectWorkflowProfile | null
  capability_ids: string[]
  output_artifact_types: string[]
  config_json: Record<string, unknown>
  run_create_body: RunCreateBody & { agent_id: string | null }
  warnings: string[]
}

export interface NormalizedSkill {
  spec_kind?: string | null
  spec_version?: string | null
  skill_root?: string | null
  package_hash?: string | null
  diagnostics?: string[]
  name: string
  description: string
  version: string
  license: string | null
  instructions_markdown: string
  resources: Record<string, unknown>[]
  requested_permissions: string[]
  execution_profile: Record<string, unknown>
  vendor_extensions: Record<string, unknown>
  trust_analysis: Record<string, unknown>
}

export interface SkillSource {
  id: string
  source_type: 'github' | 'registry' | 'local_workspace' | 'upload' | 'builtin'
  url: string | null
  repo: string | null
  path: string | null
  ref: string | null
  commit_sha: string | null
  content_hash: string
  fetched_at: string
  metadata_json: Record<string, unknown>
}

export interface SkillPackageFilePreview {
  path: string
  kind: string
  content_hash?: string | null
  content_type?: string | null
  byte_length?: number | null
  included: boolean
  executable: boolean
  risk_flags_json: Record<string, unknown>
}

export interface SkillPackageFile extends SkillPackageFilePreview {
  id: string
  skill_package_id: string
  storage_ref: string | null
  created_at: string
}

export interface SkillPackage {
  id: string
  source_id: string
  package_name: string
  version: string | null
  license: string | null
  raw_storage_ref: string | null
  manifest_json: Record<string, unknown>
  normalized_json: Record<string, unknown>
  risk_level: SkillRiskLevel
  status: SkillPackageStatus
  created_at: string
  updated_at: string
  source?: SkillSource
  package_files?: SkillPackageFile[]
}

export type SkillLocalOverlayScope = 'space' | 'project' | 'project_folder' | 'agent' | 'user'
export type SkillLocalOverlayStatus = 'active' | 'archived'

export interface SkillLocalOverlayConfig {
  alias?: string | null
  display_name?: string | null
  endpoint_defaults?: Record<string, unknown>
  credential_ref?: string | null
  default_scope?: string | null
  runtime_preference?: string | null
  user_preferences?: Record<string, unknown>
}

export interface SkillLocalOverlay {
  id: string
  space_id: string
  skill_package_id: string
  scope_type: SkillLocalOverlayScope
  scope_id: string | null
  overlay_json: SkillLocalOverlayConfig
  status: SkillLocalOverlayStatus
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface SkillLocalOverlayUpsertRequest {
  scope_type: SkillLocalOverlayScope
  scope_id?: string | null
  status?: SkillLocalOverlayStatus
  overlay_json?: SkillLocalOverlayConfig
}

export interface SkillLibraryIndexItem {
  skill_package: SkillPackage
  overlay: SkillLocalOverlay | null
  effective_name: string
  effective_alias: string | null
  requested_permissions: string[]
}

export interface SkillLibraryIndexResponse {
  items: SkillLibraryIndexItem[]
}

export interface SkillImportPreviewResponse {
  source: Partial<Omit<SkillSource, 'id' | 'fetched_at'>>
  normalized_skill: NormalizedSkill
  package_root: string
  package_hash: string
  package_files: SkillPackageFilePreview[]
  risk_level: SkillRiskLevel
  requested_permissions: string[]
  files_detected: string[]
  warnings: string[]
  persistable: boolean
}

export type SkillImportApprovalProposalResponse = Proposal
export type SkillConvertToCapabilityResponse = Proposal

export interface ContextPackage {
  user_memory: Memory[]
  project_folder_memory: Memory[]
  capability_memory: Memory[]
  agent_memory: Memory[]
  system_policy: Memory[]
  relevant_episodes: Memory[]
  recent_session_summary: Record<string, unknown>[]
  attachments: Record<string, unknown>[]
}

export type ContextProfileScope = 'space' | 'project' | 'project_folder' | 'agent' | 'user'
export type ContextProfileStatus = 'active' | 'archived'

export interface ContextRoutingRule {
  id?: string
  path_glob: string
  module_id?: string
  agent_doc_paths?: string[]
  context_bundle_id?: string
  priority?: number
}

export interface ContextRoutingManifest {
  version?: number
  rules?: ContextRoutingRule[]
  default_agent_doc_paths?: string[]
}

export interface ContextPackConfig {
  title?: string
  startup_protocol?: string
  skill_index_enabled?: boolean
  observation_policy?: 'disabled' | 'manual' | 'scheduled'
  notes?: string
  [key: string]: unknown
}

export interface ContextProfile {
  id: string
  space_id: string
  scope_type: ContextProfileScope
  scope_id: string | null
  status: ContextProfileStatus
  version: number
  context_pack_json: ContextPackConfig
  routing_manifest_json: ContextRoutingManifest
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface ContextProfileListResponse {
  items: ContextProfile[]
}

export interface ContextProfileUpsertRequest {
  scope_type: ContextProfileScope
  scope_id?: string | null
  status?: ContextProfileStatus
  version?: number
  context_pack_json?: ContextPackConfig
  routing_manifest_json?: ContextRoutingManifest
}

export interface ContextRoutingUpdateRequest {
  context_pack_json?: ContextPackConfig
  routing_manifest_json: ContextRoutingManifest
}

export interface ContextEffectiveRoutingResponse {
  project_folder_id: string
  profiles: ContextProfile[]
  effective_manifest: ContextRoutingManifest
  selected_agent_doc_paths: string[]
}

export type ContextArtifactRevocationScope = 'project_folder' | 'project'

export interface ContextArtifactRevocation {
  id: string
  space_id: string
  artifact_id: string
  scope_type: ContextArtifactRevocationScope
  scope_id: string
  reason: string | null
  created_by_user_id: string | null
  created_at: string
}

export interface ContextArtifactRevocationCreateRequest {
  artifact_id: string
  scope_type: ContextArtifactRevocationScope
  scope_id: string
  reason?: string | null
}

export interface ContextArtifactRevocationListResponse {
  items: ContextArtifactRevocation[]
}

export type ContextOpsCountMap = Record<string, number>

export interface ContextOpsArtifactSummary {
  artifact_id: string
  artifact_type: string
  title: string
  created_at: string
  surface: string | null
  diagnostic_codes: string[]
  finding_count: number | null
}

export interface ContextOpsPacketSummary {
  proposal_id: string
  proposal_type: string
  status: string
  title: string
  created_at: string
  report_artifact_id: string | null
}

export interface ContextOpsSummary {
  generated_at: string
  space_id: string
  owner_user_id: string
  window_days: number
  index_freshness: {
    object_counts: ContextOpsCountMap
    stale_projection_count: number
    source_connected_object_count: number
    oldest_indexed_at: string | null
    newest_indexed_at: string | null
    newest_source_updated_at: string | null
  }
  embedding_backlog: {
    total_chunks: number
    embedded_chunks: number
    missing_embedding_chunks: number
    claimed_chunks: number
    attempted_chunks: number
    missing_by_object_type: ContextOpsCountMap
  }
  source_policy_warnings: {
    active_source_connections: number
    missing_consent_version_count: number
    reader_restricted_source_count: number
    external_egress_disabled_source_count: number
    derived_writes_disabled_source_count: number
    warning_counts: ContextOpsCountMap
  }
  maintenance: {
    recent_report_count: number
    finding_counts: ContextOpsCountMap
    pending_packet_count: number
    recent_packets: ContextOpsPacketSummary[]
  }
  diagnostics: {
    recent_report_count: number
    diagnostic_code_counts: ContextOpsCountMap
    latest_report_artifact_id: string | null
    latest_generated_at: string | null
    trend_metric_deltas: Record<string, number>
    insufficient_trend_sample: boolean
  }
  recent_context_briefs: ContextOpsArtifactSummary[]
  retrieval_feedback: {
    recent_event_count: number
    signal_counts: ContextOpsCountMap
    surface_counts: ContextOpsCountMap
    window_days: number
  }
  memory_provenance: {
    recent_access_count: number
    context_injection_count: number
    maintenance_scan_count: number
    inspector_available: boolean
  }
}

export type ContextOpsDrilldownSection =
  | 'index_freshness'
  | 'embedding_backlog'
  | 'source_warnings'
  | 'maintenance_reports'
  | 'diagnostics_reports'
  | 'explain_reports'
  | 'recent_briefs'

export interface ContextOpsDrilldownObject {
  object_type: string
  object_id: string
  title: string
  indexed_at: string | null
  source_updated_at: string | null
  missing_chunk_count: number | null
}

export interface ContextOpsSourceWarningDetail {
  source_connection_id: string
  name: string
  owner_user_id: string
  status: string
  warnings: string[]
}

export interface ContextOpsDrilldown {
  generated_at: string
  space_id: string
  section: ContextOpsDrilldownSection
  limit: number
  truncated: boolean
  objects: ContextOpsDrilldownObject[]
  sources: ContextOpsSourceWarningDetail[]
  artifacts: ContextOpsArtifactSummary[]
  packets: ContextOpsPacketSummary[]
}

export interface ContextOpsContextObservationScanRequest {
  window_days?: number
  limit?: number
  persist_report?: boolean
}

export type ContextObservationSeverity = 'red' | 'yellow' | 'green'

export interface ContextObservationItem {
  severity: ContextObservationSeverity
  title: string
  summary: string
  source_refs: Record<string, unknown>[]
  suggested_target: 'memory' | 'knowledge' | 'capability' | 'assistant_preference' | 'review_only'
}

export interface ContextOpsContextObservationReport {
  kind: 'context_observation_report'
  version: 1
  generated_at: string
  space_id: string
  owner_user_id: string
  window_days: number
  observations: ContextObservationItem[]
  counts: ContextOpsCountMap
  source_refs: Record<string, unknown>[]
  access_safety: {
    aggregate_or_review_refs_only: true
    raw_private_content_included: false
    canonical_write_performed: false
  }
  canonical_write_performed: false
}

export interface ContextOpsContextObservationScanResponse {
  report: ContextOpsContextObservationReport
  artifact_id: string | null
  canonical_write_performed: false
}

export interface Feature {
  id: string
  name: string
  always_on: boolean
  enabled: boolean
}

export interface ReflectResult {
  session_id: string
  proposals_created: number
  proposals: Proposal[]
}

export interface ApiError {
  error: string
  message?: string | Record<string, unknown>
  detail?: unknown
  request_id?: string
}

// ── Project Folder Files & Code ─────────────────────────────────────────────

export interface FileNode {
  name: string
  path: string          // relative to the Folder root; "." for root
  type: 'file' | 'dir'
  size?: number
  children?: FileNode[]
}

export interface FileContent {
  path: string
  content: string
  size: number
  line_count: number
}

export interface GitChangedFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
}

export interface GitStatus {
  is_repo: boolean
  branch: string | null
  files: GitChangedFile[]
}

// ── Home summary (`GET /api/v1/home/summary`) ──────────────────────────────

export type HomeSuggestedActionPriority = 'high' | 'normal' | 'low'

export interface HomeRunSummaryItem {
  id: string
  status: string
  mode: string
  run_type: string
  agent_id: string
  task_id: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  error_text: string | null
  visibility?: ObjectVisibility
}

export interface HomePendingProposalItem {
  id: string
  title: string
  proposal_type: string
  status: string
  risk_level: string
  urgency: string
  review_deadline: string | null
  expires_at: string | null
  expired: boolean
  preview: boolean
  created_by_run_id: string | null
  visibility?: ObjectVisibility
}

export interface HomePendingProposalsSection {
  count: number
  items: HomePendingProposalItem[]
}

export interface HomeArtifactSummaryItem {
  id: string
  title: string
  artifact_type: string
  preview: boolean
  run_id: string | null
  created_at: string
  visibility?: ObjectVisibility
}

export interface HomeTaskSummarySection {
  by_status: Record<string, number>
  total_open: number
  needs_review_count: number
  blocked_count: number
  done_count: number
}

export interface HomeActiveTaskItem {
  id: string
  title: string
  status: string
  priority: string
  risk_level: string
  task_type: string
  assigned_user_id: string | null
  assigned_agent_id: string | null
  due_at: string | null
  updated_at: string
  visibility?: ObjectVisibility
}

export interface HomeActivitySummarySection {
  recent_count: number
  raw_count: number
  today_count: number
}

export interface HomeRunStatsTodaySection {
  created: number
  queued: number
  running: number
  succeeded: number
  failed: number
  cancelled: number
  dry_run_count: number
}

export interface HomeJobQueueStatusSection {
  queued: number
  running: number
  failed: number
  retryable: number
  recent_error_preview: string | null
}

export interface HomeRuntimeStatusSection {
  real_adapters_configured_count: number
  configured_adapter_types: string[]
  message: string
}

export interface HomeModelProviderStatusSection {
  model_providers_count: number
  enabled_model_providers_count: number
  missing_model_provider_config: boolean
  message: string
}

export interface HomeSuggestedActionItem {
  id: string
  label: string
  reason: string
  target_path: string
  priority: HomeSuggestedActionPriority
}

export interface HomeSourceSummarySection {
  open_items: number
  new_items_today: number
  pending_extraction_jobs: number
  failed_extraction_jobs: number
  candidate_evidence: number
  active_evidence: number
  due_connections: number
}

export interface HomeSummaryOut {
  operations_in_progress: Array<{id:string;project_id:string;project_name:string;kind:string;title:string;status:string;progress_json:Record<string,unknown>;updated_at:string}>
  recent_runs: HomeRunSummaryItem[]
  active_runs: HomeRunSummaryItem[]
  pending_proposals: HomePendingProposalsSection
  recent_artifacts: HomeArtifactSummaryItem[]
  task_summary: HomeTaskSummarySection
  active_tasks: HomeActiveTaskItem[]
  activity_summary: HomeActivitySummarySection
  run_stats_today: HomeRunStatsTodaySection
  job_queue_status: HomeJobQueueStatusSection
  runtime_status: HomeRuntimeStatusSection
  model_provider_status: HomeModelProviderStatusSection
  suggested_actions: HomeSuggestedActionItem[]
  source_summary: HomeSourceSummarySection
}

// ── Daily Capture Report ──────────────────────────────────────────────────

export interface DailyCaptureReportSettingOut {
  id: string
  space_id: string
  user_id: string
  enabled: boolean
  local_time: string
  timezone: string
  include_source_types: string[]
  create_experience_proposals: boolean
  create_memory_proposals: boolean
  experience_confidence_threshold: number
  memory_confidence_threshold: number
  max_experience_proposals_per_day: number
  max_memory_proposals_per_day: number
  last_report_date: string | null
  next_run_at: string | null
  created_at: string
  updated_at: string
}

export interface DailyCaptureReportSettingUpdate {
  enabled?: boolean | null
  local_time?: string | null
  timezone?: string | null
  include_source_types?: string[] | null
  create_experience_proposals?: boolean | null
  create_memory_proposals?: boolean | null
  experience_confidence_threshold?: number | null
  memory_confidence_threshold?: number | null
  max_experience_proposals_per_day?: number | null
  max_memory_proposals_per_day?: number | null
}

export interface DailyReportRunRequest {
  local_date?: string | null
  force?: boolean
  create_experience_proposals?: boolean | null
  create_memory_proposals?: boolean | null
}

export interface DailyReportRunResponse {
  run_id: string
  artifact_id: string | null
  proposal_ids: string[]
  experience_proposal_ids: string[]
  memory_proposal_ids: string[]
  capture_count: number
  status: string
  summary_preview: string
}

export interface DailyReportArtifactItem {
  id: string
  title: string
  artifact_type: string
  run_id: string | null
  created_at: string
  report_date: string | null
  capture_count: number
}

// ── Input Summary (POST /activity/summary-runs, POST /sources/post-processing/run-once) ──

export interface SummaryRunRequest {
  activity_ids?: string[]
  evidence_ids?: string[]
  source_item_ids?: string[]
  summary_goal?: string | null
  create_memory_proposal?: boolean
  create_knowledge_proposal?: boolean
}

export interface SummaryRunOut {
  run_id: string
  artifact_id: string | null
  proposal_ids: string[]
  status: string
  summary_preview: string
}

// ── Source Source Post-Processing ─────────────────────────────────────────

export type SourcePostProcessingTriggerType = 'items_materialized' | 'schedule' | 'manual'
export type SourcePostProcessingRuleStatus = 'active' | 'paused' | 'archived'
export type SourcePostProcessingRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type SourcePostProcessingStrategy = 'batch_digest' | 'screen_then_digest' | 'screen_extract_digest'
export type SourcePostProcessingContentSource =
  | 'excerpt_only'
  | 'prefer_extracted_text_for_candidates'
  | 'require_extracted_text_for_candidates'
export type SourcePostProcessingDecisionReviewStatus =
  | 'pending'
  | 'accepted'
  | 'ignored'
  | 'queued'
  | 'proposed'
  | 'rerun'
  | 'dismissed'
export type SourcePostProcessingItemRelevance = 'relevant' | 'maybe' | 'not_relevant'

export interface SourcePostProcessingActions {
  batch_digest: boolean
  per_item_summary: boolean
  extract_evidence: boolean
  create_proposals: boolean
  mark_items: boolean
}

export type SourcePostProcessingRetrievalDomain = 'knowledge' | 'project' | 'memory' | 'source'
export type SourcePostProcessingRetrievalMode = 'exact' | 'lexical' | 'hybrid' | 'hybrid_rerank'
export type SourcePostProcessingDeepAnalysisContentSource = 'prefer_extracted_text' | 'require_extracted_text'
export type SourcePostProcessingDeepAnalysisOutput = 'deep_report' | 'per_item_deep_summary'

export interface SourcePostProcessingRetrievalContextConfig {
  enabled: boolean
  domains: SourcePostProcessingRetrievalDomain[]
  query?: string
  max_results_per_domain: number
  mode: SourcePostProcessingRetrievalMode
}

export interface SourcePostProcessingCandidatePrefilterConfig {
  enabled: boolean
  mode: SourcePostProcessingRetrievalMode
  max_candidates: number
  min_score?: number
}

export interface SourcePostProcessingDeepAnalysisConfig {
  enabled: boolean
  trigger_relevance: Array<'relevant' | 'maybe'>
  min_confidence: number
  max_candidates_per_run: number
  content_source: SourcePostProcessingDeepAnalysisContentSource
  output: SourcePostProcessingDeepAnalysisOutput
}

export interface SourcePostProcessingRelevanceDecisionPolicy {
  relevant?: string
  maybe?: string
  not_relevant?: string
}

export interface SourcePostProcessingRelevanceProfile {
  enabled: boolean
  objective?: string
  include_criteria: string[]
  exclude_criteria: string[]
  must_have: string[]
  nice_to_have: string[]
  decision_policy?: SourcePostProcessingRelevanceDecisionPolicy
}

export interface SourcePostProcessingInputConfig {
  window: 'new_since_last_success' | 'local_day' | 'last_24h' | 'explicit'
  item_limit: number
  max_batches_per_event: number
  processing_strategy: SourcePostProcessingStrategy
  content_source: SourcePostProcessingContentSource
  include_excerpts: boolean
  include_evidence: boolean
  timezone: string
  content_profile?: 'generic' | 'arxiv_new_papers'
  summary_goal?: string
  output_instructions?: string
  retrieval_context: SourcePostProcessingRetrievalContextConfig
  candidate_prefilter: SourcePostProcessingCandidatePrefilterConfig
  deep_analysis: SourcePostProcessingDeepAnalysisConfig
  relevance_profile?: SourcePostProcessingRelevanceProfile
}

export interface SourcePostProcessingTriggerConfig {
  min_new_items: number
  cooldown_seconds: number
  cron?: string
  timezone: string
  skip_when_no_new_items: boolean
}

export interface SourcePostProcessingRule {
  id: string
  space_id: string
  source_channel_id: string
  agent_id: string
  project_id: string | null
  name: string
  status: SourcePostProcessingRuleStatus
  trigger_type: SourcePostProcessingTriggerType
  trigger_config_json: SourcePostProcessingTriggerConfig
  input_config_json: SourcePostProcessingInputConfig
  actions_json: SourcePostProcessingActions
  cursor_json: Record<string, unknown> | null
  last_fired_at: string | null
  next_run_at: string | null
  created_by_user_id: string
  created_at: string
  updated_at: string
}

export interface SourcePostProcessingRun {
  id: string
  space_id: string
  rule_id: string | null
  source_channel_id: string
  agent_id: string
  project_id: string | null
  agent_run_id: string | null
  triggered_by_user_id: string | null
  trigger_type: SourcePostProcessingTriggerType
  status: SourcePostProcessingRunStatus
  input_item_ids: string[]
  input_evidence_ids: string[]
  output_artifact_ids: string[]
  output_proposal_ids: string[]
  output_job_ids: string[]
  cursor_before_json: Record<string, unknown> | null
  cursor_after_json: Record<string, unknown> | null
  retrieval_context_json: Record<string, unknown>
  item_decisions_json: Array<Record<string, unknown>>
  summary: string | null
  error_json: Record<string, unknown> | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

export interface SourcePostProcessingItemDecision {
  id: string
  space_id: string
  source_channel_id: string
  rule_id: string | null
  run_id: string
  project_id: string | null
  source_item_id: string
  relevance: SourcePostProcessingItemRelevance
  confidence: number | null
  reason: string | null
  matched_context_refs: Array<Record<string, unknown>>
  review_status: SourcePostProcessingDecisionReviewStatus
  action_json: Record<string, unknown>
  item: {
    title: string | null
    source_uri: string | null
    source_domain: string | null
    author: string | null
    library_status: 'new' | 'triaged' | 'selected' | 'ignored' | 'archived'
    read_status: 'unread' | 'skimmed' | 'read' | 'discussed'
    content_state: string | null
  }
  rule_name: string | null
  run_status: string | null
  run_created_at: string | null
  created_at: string
  updated_at: string
}

export interface SourcePostProcessingBacklogRule {
  rule_id: string
  rule_name: string
  status: SourcePostProcessingRuleStatus
  trigger_type: SourcePostProcessingTriggerType
  pending_item_count: number
  batch_size: number
  max_batches_per_event: number
  cursor_json: Record<string, unknown> | null
  last_fired_at: string | null
  last_run: SourcePostProcessingRun | null
  last_success_run: SourcePostProcessingRun | null
  last_failed_run: SourcePostProcessingRun | null
}

export interface SourcePostProcessingBacklog {
  source_channel_id: string
  rules: SourcePostProcessingBacklogRule[]
}

/** One Library brief entry: a source's aggregated output for one local day.
 *  Documented in .agent/modules/library.md. */
export interface SourcePostProcessingBriefingDaySummary {
  source_channel_id: string
  connection_name: string
  project_id: string | null
  date: string
  run_ids: string[]
  run_count: number
  item_decision_counts: { relevant: number; maybe: number; not_relevant: number }
  digest_artifact_id: string | null
  digest_preview: string | null
  latest_run_created_at: string
}

export interface SourcePostProcessingBriefingDetail {
  source_channel_id: string
  connection_name: string
  project_id: string | null
  date: string
  runs: Array<{ run_id: string; status: SourcePostProcessingRunStatus; created_at: string; summary: string | null }>
  digests: Array<{ run_id: string; artifact_id: string; title: string; content: string }>
  item_summaries: Array<{ source_item_id: string; artifact_id: string; title: string; content: string }>
  item_decisions: SourcePostProcessingItemDecision[]
}

export interface SourcePostProcessingDrainResult {
  runs: SourcePostProcessingRun[]
  stopped_reason: string
  pending_item_count: number
}

export interface SourcePostProcessingDecisionActionResult {
  decision: SourcePostProcessingItemDecision
  proposal_id?: string
  job_ids?: string[]
  run?: SourcePostProcessingRun
}

export interface SourcePostProcessingRuleCreate {
  name?: string
  agent_id?: string | null
  project_id?: string | null
  trigger_type?: SourcePostProcessingTriggerType
  trigger_config_json?: Partial<SourcePostProcessingTriggerConfig>
  input_config_json?: Partial<SourcePostProcessingInputConfig>
  actions_json?: Partial<SourcePostProcessingActions>
}

export interface SourcePostProcessingRuleUpdate {
  name?: string | null
  agent_id?: string | null
  project_id?: string | null
  status?: SourcePostProcessingRuleStatus | null
  trigger_type?: SourcePostProcessingTriggerType
  trigger_config_json?: Partial<SourcePostProcessingTriggerConfig>
  input_config_json?: Partial<SourcePostProcessingInputConfig>
  actions_json?: Partial<SourcePostProcessingActions>
}

// ── Reader ─────────────────────────────────────────────────────────────────────

export interface ReaderDocumentRef {
  document_type: string
  document_id: string
}

export interface ReaderDocumentPayload {
  document_type: string
  document_id: string
  space_id: string
  title: string
  plain_text: string
  /** Canonical normalized form used for content_hash, text_range offsets, and context slicing. */
  normalized_text: string
  content_hash: string
  content_format: 'tiptap_json'
  content_schema_version: 1
  content_json: Record<string, unknown>
  source_item_id: string | null
  artifact_id: string | null
  source_snapshot_id: string | null
  raw_artifact_id: string | null
  extracted_artifact_id: string | null
  source_uri: string | null
  content_state: string | null
  retention_policy: string | null
  can_annotate: true
}

export interface ReaderAnnotation {
  id: string
  space_id: string
  document_type: 'source_item' | 'source_snapshot' | 'research_report'
  document_id: string
  annotation_type: 'highlight' | 'comment' | 'excerpt' | 'bookmark'
  quote_text: string
  anchor_json: ReaderAnchorJson
  color: string | null
  label: string | null
  visibility: 'private' | 'space_shared'
  status: 'active' | 'archived'
  anchor_state: 'verified' | 'unverified'
  created_by_user_id: string
  created_at: string
  updated_at: string
}

export interface ReaderAnchorJson {
  schema_version: 1
  normalizer: string
  quote_text: string
  text_range: { start: number; end: number; unit: 'utf16' }
  before_context: string
  after_context: string
  tiptap_range?: { from: number; to: number }
  block_ref?: { index: number; node_type: string; from: number; to: number }
  content_hash?: string
  document_ref?: ReaderDocumentRef
  [key: string]: unknown
}

export interface ReaderAnnotationsResponse {
  items: ReaderAnnotation[]
}

export interface ReaderAnnotationCreate {
  document_type: 'source_item' | 'source_snapshot' | 'research_report'
  document_id: string
  annotation_type: 'highlight' | 'comment' | 'excerpt' | 'bookmark'
  quote_text: string
  anchor_json: ReaderAnchorJson
  color?: string
  label?: string
  visibility?: 'private' | 'space_shared'
}

export interface ReaderAnnotationUpdate {
  color?: string | null
  label?: string | null
  visibility?: 'private' | 'space_shared'
  status?: 'active' | 'archived'
}

export interface ReaderComment {
  id: string
  space_id: string
  thread_id: string
  body: string
  status: 'active' | 'archived'
  created_by_user_id: string
  created_at: string
  updated_at: string
}

export interface ReaderCommentThread {
  id: string
  space_id: string
  annotation_id: string
  status: 'open' | 'resolved' | 'archived'
  created_by_user_id: string
  created_at: string
  updated_at: string
  comments: ReaderComment[]
}

export interface ReaderCommentCreate {
  body: string
}

export interface ReaderCommentUpdate {
  body?: string
  status?: 'active' | 'archived'
}

export interface ReaderThreadUpdate {
  status: 'open' | 'resolved' | 'archived'
}

export interface ReaderCreateEvidenceRequest {
  title?: string
}

export interface ReaderCreatedEvidence {
  id: string
  title: string
  status: string
  evidence_type: string
  source_item_id: string | null
  source_object_type: string
  source_object_id: string
}

export interface ReaderCreateProposalRequest {
  proposal_type: 'memory_create' | 'knowledge_create'
  title?: string
  rationale?: string
}

export interface ReaderCreatedProposal {
  id: string
  proposal_type: string
  status: string
  title: string
}

// ── Personal perspective (`GET /api/v1/me/*`) ─────────────────────────────

export interface MeRecentRunItem {
  id: string
  space_id: string
  agent_id: string
  status: string
  mode: string
  run_type: string
  created_at: string
  updated_at: string
}

export interface MeRecentParticipationItem {
  id: string
  user_id: string
  personal_space_id: string
  source_space_id: string
  source_object_type: string
  source_object_id: string
  role: string
  occurred_at: string
  created_at: string
}

export interface MeSpaceRollup {
  space_id: string
  name: string
  type: string
  pending_proposals_count: number
  assigned_tasks_count: number
  recent_failed_runs_count: number
}

export interface MeSummaryOut {
  pending_proposals_count: number
  assigned_tasks_count: number
  recent_runs: MeRecentRunItem[]
  recent_participation: MeRecentParticipationItem[]
  accessible_spaces_count: number
  spaces: MeSpaceRollup[]
}

export interface MeTimelineEntry {
  id: string
  entry_type: 'participation' | string
  source_space_id: string | null
  source_object_type: string | null
  source_object_id: string | null
  role: string | null
  occurred_at: string
  created_at: string
}

export interface MeTaskItem {
  id: string
  space_id: string
  title: string
  status: string
  priority: string
  visibility: ObjectVisibility
  created_by_user_id: string | null
  assigned_user_id: string | null
  created_at: string
  updated_at: string
}

export interface MePendingProposalItem {
  id: string
  space_id: string
  proposal_type: string
  status: string
  urgency: string
  title: string
  visibility: ObjectVisibility
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

// ── Projects ───────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'archived'

export type ProjectPrimaryMode = 'inquiry' | 'decision' | 'delivery' | 'operations' | 'learning'

export interface Project {
  id: string
  space_id: string
  owner_user_id: string | null
  name: string
  description: string | null
  status: ProjectStatus
  current_focus: string | null
  settings_json: Record<string, unknown> | null
  template_key: string
  primary_mode: ProjectPrimaryMode
  active_brief_version_id: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface ProjectCreate {
  name: string
  description?: string | null
  current_focus?: string | null
  settings_json?: Record<string, unknown> | null
  template_key?: string
  goal?: string | null
  scope_included?: string | null
  success_definition?: string | null
}

export interface ProjectUpdate {
  name?: string | null
  description?: string | null
  current_focus?: string | null
  status?: ProjectStatus | null
  settings_json?: Record<string, unknown> | null
}

export interface ProjectBriefVersion {
  id: string
  space_id: string
  project_id: string
  version: string
  goal: string | null
  scope_included: string | null
  scope_excluded: string | null
  success_definition: string | null
  constraints: string | null
  assumptions: string | null
  created_by_user_id: string | null
  created_at: string
}

export interface ProjectSummary {
  project_id: string
  activity_count: number
  artifact_count: number
  pending_proposal_count: number
  project_folder_count: number
  active_run_count: number
  memory_entry_count: number
}

// ── Automations ─────────────────────────────────────────────────────────────
export type AutomationTriggerType = 'manual' | 'schedule'
export type AutomationTargetType = 'agent_run' | 'knowledge_retrieval_maintenance' | 'context_ops_review_cycle' | 'workflow'

export interface AutomationOut {
  id: string
  space_id: string
  owner_user_id: string
  agent_id: string
  project_folder_id: string | null
  project_id: string | null
  name: string
  description: string | null
  trigger_type: string
  status: string
  preflight_snapshot_json: Record<string, unknown> | null
  config_json: Record<string, unknown> | null
  next_run_at: string | null
  last_fired_at: string | null
  created_at: string
  updated_at: string
}

export interface AutomationCreateBody {
  name: string
  agent_id: string
  project_folder_id?: string | null
  project_id?: string | null
  description?: string | null
  trigger_type?: AutomationTriggerType
  config_json?: Record<string, unknown> | null
}

export interface AutomationUpdateBody {
  name?: string | null
  description?: string | null
  status?: string | null
  config_json?: Record<string, unknown> | null
  project_id?: string | null
}

export interface AutomationFireResult {
  run_id?: string
  automation_run_id?: string
  trigger_origin: string
  preflight_executable: boolean
  skipped?: boolean
  skip_reason?: string
  target_type?: AutomationTargetType
  artifact_id?: string | null
  proposal_id?: string | null
  artifact_ids?: Record<string, string | null>
  proposal_ids?: Record<string, string | null>
  finding_count?: number
  scanned?: number
  truncated?: boolean
  degraded?: boolean
  warnings?: Array<{ stage: string; error_code: string; message: string }>
}

export interface ContextReviewCycleRequest {
  window_days?: number
  artifact_limit?: number
  create_packets?: boolean
  review_scope?: 'private' | 'space_ops'
  include_memory_maintenance?: boolean
  memory_limit?: number
  memory_stale_after_days?: number
  memory_thin_content_chars?: number
  memory_max_findings?: number
  max_claim_candidates?: number
}

export interface ContextReviewCycleResponse {
  artifact_id: string
  review_scope: 'private' | 'space_ops'
  retrieval_maintenance: Record<string, unknown>
  diagnostics: Record<string, unknown>
  memory_maintenance: Record<string, unknown>
  claim_candidates: Record<string, unknown>
  source_health: Record<string, unknown>
  projection_freshness: Record<string, unknown>
  embedding_backlog: Record<string, unknown>
  degraded: boolean
  warnings: Array<{ stage: string; error_code: string; message: string }>
  canonical_write_performed: false
}

export interface ClaimCandidatePacketCreateRequest {
  source_artifact_ids: string[]
  max_candidates?: number
  review_scope?: 'private' | 'space_ops'
  promote_private_sources_to_space_ops?: boolean
  private_source_promotion_confirmed?: boolean
}

export interface ClaimCandidatePacketCreateResponse {
  artifact_id: string
  proposal_id: string
  candidate_count: number
  source_artifact_count: number
  generated_child_proposal_count: number
}

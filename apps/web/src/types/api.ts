// API response shapes shared with the server HTTP contracts.
import type {
  AgentRunGroup,
  AgentRunGroupMember,
  AgentRunGroupTimeline,
  AgentRunGroupTrace,
  AgentRunMention,
  AgentRunMessage,
  AgentRunMessageRecipientSegment,
  AgentRunMessageRoutingMode,
  AskSpaceClaimTrajectory,
  AskSpaceDomain,
  AskSpaceDomainSection,
  AskSpaceFollowUp,
  AskSpaceFollowUpKind,
  AskSpaceGapSummary,
  AskSpaceProvenanceItem,
  AskSpaceRequest,
  AskSpaceResponse,
  AutomationTargetType,
  CapabilityDefinition,
  CapabilityPackDescriptor,
  CapabilityRuntimeBinding,
  CapabilitySourceKind,
  CapabilityStatus,
  CaptureDestination,
  CaptureRequest,
  CaptureResponse,
  ChatTurnAccepted,
  ContinueRoomAfterProposalRequest,
  ClaimCandidatePacketCreateRequest,
  ClaimCandidatePacketCreateRequestInput,
  ClaimCandidatePacketCreateResponse,
  ClaimContradictionScanRequest,
  ClaimContradictionScanRequestInput,
  ClaimContradictionScanResponse,
  CliUsageAutoRefreshSettings,
  ContextObservationItem,
  ContextObservationSeverity,
  ContextOpsArtifactSummary,
  ContextOpsContextObservationReport,
  ContextOpsContextObservationScanRequest,
  ContextOpsContextObservationScanRequestInput,
  ContextOpsContextObservationScanResponse,
  ContextOpsCountMap,
  ContextOpsDrilldown,
  ContextOpsDrilldownObject,
  ContextOpsDrilldownSection,
  ContextOpsPacketSummary,
  ContextOpsReviewMode,
  ContextOpsScanMode,
  ContextOpsSourceWarningDetail,
  ContextOpsSummary,
  ContextReviewCycleRequest,
  ContextReviewCycleRequestInput,
  ContextReviewCycleResponse,
  ConversationBackendBinding,
  ConversationBackendCatalog,
  ConversationBackendOption,
  CreateAgentRunGroupRequest,
  CreateAgentRunGroupResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  RoomAgentAddRequest,
  RoomAgentCandidate,
  RoomAgentCandidatesResponse,
  RoomAgentMember,
  RoomAgentMutationResponse,
  RoomAgentPreset,
  RoomAgentPresetRequest,
  CrossSpacePointer,
  CrossSpaceResolvedItem,
  CrossSpaceRetrievalRequest,
  CrossSpaceRetrievalResponse,
  CustomSourceCapturePolicy,
  CustomSourceCreatorRole,
  CustomSourceCredentialDTO,
  CustomSourceInstanceRunnerSettingsUpdate,
  CustomSourcePolicyEnvelope,
  CustomSourcePolicyLimits,
  CustomSourceRetentionPolicy,
  CustomSourceSpacePolicyUpdate,
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
  InquiryOpenStep,
  InquiryReviewPacket,
  InquiryThread,
  InquiryThreadAdvice,
  InquiryThreadKind,
  InquiryThreadStep,
  MemoryMaintenanceFinding,
  MemoryMaintenanceFindingKind,
  MemoryMaintenanceJob,
  MemoryMaintenanceJobRunResponse,
  MemoryMaintenanceObject,
  MemoryMaintenanceReport,
  MemoryMaintenanceScanRequest,
  MemoryMaintenanceScanRequestInput,
  MemoryScope,
  NormalizedSkill,
  NoteProjectRole,
  ObjectSchemaExportManifest,
  ObjectSchemaImportRequest,
  ObjectSchemaImportRequestInput,
  ObjectSchemaImportResponse,
  ObjectSchemaManifestKind,
  ObjectSchemaManifestRelationHint,
  ObjectSchemaSuggestionFinding,
  ObjectSchemaSuggestionReport,
  ObjectSchemaSuggestionScanRequest,
  ObjectSchemaSuggestionScanRequestInput,
  ObjectSchemaSuggestionScanResponse,
  ProjectBriefVersion,
  ProjectInstructionVersion,
  ProjectPrimaryMode,
  ProjectResearchQuestionAssessmentConfirmation,
  ProjectResearchQuestionAssessmentConfirmationResponse,
  ProjectResearchQuestionAssessmentMessage,
  ProjectResearchQuestionAssessmentSession,
  ProjectResearchQuestionRefinement,
  ProjectResearchQuestionRefinementResponse,
  ProjectResearchQuestionRefinementResult,
  PromptAssetContent,
  PromptAssetDetail,
  PromptAssetScopeType,
  PromptAssetSummary,
  PromptDeploymentRef,
  PromptEvaluationRequest,
  PromptEvaluationResult,
  PromptMessage,
  PromptPromotionRequest,
  PromptPromotionRequestInput,
  PromptRenderPreviewRequest,
  PromptRenderPreviewResult,
  PromptRollbackRequest,
  PromptType,
  PromptVersion,
  PromptVersionCreateRequest,
  PromptVersionSource,
  PromptVersionStatus,
  ProposalAcceptOut,
  ReaderAnnotationCreate,
  RelationDiscoveryScanRequest,
  RelationDiscoveryScanRequestInput,
  RelationDiscoveryScanResponse,
  RelocationMode,
  RelocationPreview,
  RelocationRequest,
  RelocationResponse,
  ResearchProviderKey,
  ResearchQueryAttempt,
  ResearchQueryStrategy,
  ResearchReportV1,
  ResearchSemanticConcept,
  RetrievalBrief,
  RetrievalBriefRequest,
  RetrievalBriefResponse,
  RetrievalCalibrationDecision,
  RetrievalCalibrationDecisionRequest,
  RetrievalCalibrationDecisionResponse,
  RetrievalCalibrationMechanic,
  RetrievalCitation,
  RetrievalExplainRequest,
  RetrievalExplainResponse,
  RetrievalFeedbackRequest,
  RetrievalFeedbackResponse,
  RetrievalFeedbackSignal,
  RetrievalGapAnalysis,
  RetrievalGapItem,
  RetrievalMaintenanceScanRequest,
  RetrievalMaintenanceScanRequestInput,
  RetrievalObjectType,
  RetrievalRankingMechanicState,
  RetrievalRuntimeRankingConfig,
  RetrievalSearchMode,
  RetrievalSearchRequest,
  RetrievalSearchResponse,
  RetrievalSearchResult,
  RetrievalToolMode,
  Room,
  RoomConversation,
  RoomConversationSummary,
  RoomConversationSummaryResponse,
  RoomDetail,
  RoomInvitation,
  RoomInvitationCreateRequest,
  RoomInvitationDecisionRequest,
  RoomInvitationListResponse,
  RoomPendingApproval,
  RoomPendingApprovalListResponse,
  RoomMessage,
  RoomOwnerTransferRequest,
  RoomUserMember,
  RunDelegation,
  RuntimeRenderMode,
  SendAgentRunGroupMessageRequest,
  SendAgentRunGroupMessageResponse,
  SendRoomMessageRequest,
  SkillConvertToCapabilityResponse,
  SkillImportApprovalProposalResponse,
  SkillImportPreviewResponse,
  SkillLibraryIndexItem,
  SkillLibraryIndexResponse,
  SkillLocalOverlay,
  SkillLocalOverlayConfig,
  SkillLocalOverlayScope,
  SkillLocalOverlayStatus,
  SkillLocalOverlayUpsertRequest,
  SkillPackage,
  SkillPackageFile,
  SkillPackageFilePreview,
  SkillPackageStatus,
  SkillRiskLevel,
  SkillSource,
  SourceChannel,
  SourceConnector,
  SourcePolicyEnvelope,
  SourceProvider,
  SourceProviderCategoryGroup,
  SourceProviderCategoryOption,
  SourceProviderSetupSchema,
  SourceRecipeDefinition,
  SourceRecipeDryRunResult,
  SourceRecipeDryRunStatus,
  SourceRecipePrimitiveName,
  SourceRecipeStepTrace,
  SourceRecipeStepTraceStatus,
  SourceRecipeVersionStatus,
  SourceRunImplementation,
  SourceRunKind,
  SourceRunStatus,
  SpaceObjectProfileCreateProposalRequest,
  SpaceObjectProfileCreateProposalRequestInput,
  SpaceObjectProfileOut,
  SpaceObjectProfilePage,
  SpaceObjectProfileRelationHintDirection,
  SpaceObjectProfileRelationHintLinkType,
  SpaceObjectProfileRelationHintRequest,
  SpaceObjectProfileStatus,
  SpaceObjectProfileUpdateProposalRequest,
  MemoryVersion,
  SpaceObjectProfileUpdateProposalRequestInput,
  SpaceOversightMode,
  SpaceRetrievalSettings,
  SpaceRetrievalSettingsUpdate,
  UpdateAgentRunGroupRequest,
  UpdateAgentRunGroupResponse,
} from '@rainver/protocol'
export type {
  MemoryVersion,
  AgentRunGroup,
  AgentRunGroupMember,
  AgentRunGroupTimeline,
  AgentRunGroupTrace,
  AgentRunMention,
  AgentRunMessage,
  AgentRunMessageRecipientSegment,
  AgentRunMessageRoutingMode,
  AskSpaceClaimTrajectory,
  AskSpaceDomain,
  AskSpaceDomainSection,
  AskSpaceFollowUp,
  AskSpaceFollowUpKind,
  AskSpaceGapSummary,
  AskSpaceProvenanceItem,
  AskSpaceRequest,
  AskSpaceResponse,
  AutomationTargetType,
  CapabilityDefinition,
  CapabilityPackDescriptor,
  CapabilityRuntimeBinding,
  CapabilitySourceKind,
  CapabilityStatus,
  CaptureDestination,
  CaptureRequest,
  CaptureResponse,
  ChatTurnAccepted,
  ContinueRoomAfterProposalRequest,
  ClaimCandidatePacketCreateRequest,
  ClaimCandidatePacketCreateRequestInput,
  ClaimCandidatePacketCreateResponse,
  ClaimContradictionScanRequest,
  ClaimContradictionScanRequestInput,
  ClaimContradictionScanResponse,
  CliUsageAutoRefreshSettings,
  ContextObservationItem,
  ContextObservationSeverity,
  ContextOpsArtifactSummary,
  ContextOpsContextObservationReport,
  ContextOpsContextObservationScanRequest,
  ContextOpsContextObservationScanRequestInput,
  ContextOpsContextObservationScanResponse,
  ContextOpsCountMap,
  ContextOpsDrilldown,
  ContextOpsDrilldownObject,
  ContextOpsDrilldownSection,
  ContextOpsPacketSummary,
  ContextOpsReviewMode,
  ContextOpsScanMode,
  ContextOpsSourceWarningDetail,
  ContextOpsSummary,
  ContextReviewCycleRequest,
  ContextReviewCycleRequestInput,
  ContextReviewCycleResponse,
  ConversationBackendBinding,
  ConversationBackendCatalog,
  ConversationBackendOption,
  CreateAgentRunGroupRequest,
  CreateAgentRunGroupResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  CrossSpacePointer,
  CrossSpaceResolvedItem,
  CrossSpaceRetrievalRequest,
  CrossSpaceRetrievalResponse,
  CustomSourceCapturePolicy,
  CustomSourceCreatorRole,
  CustomSourceCredentialDTO,
  CustomSourceInstanceRunnerSettingsUpdate,
  CustomSourcePolicyEnvelope,
  CustomSourcePolicyLimits,
  CustomSourceRetentionPolicy,
  CustomSourceSpacePolicyUpdate,
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
  InquiryOpenStep,
  InquiryReviewPacket,
  InquiryThread,
  InquiryThreadAdvice,
  InquiryThreadKind,
  InquiryThreadStep,
  MemoryMaintenanceFinding,
  MemoryMaintenanceFindingKind,
  MemoryMaintenanceJob,
  MemoryMaintenanceJobRunResponse,
  MemoryMaintenanceObject,
  MemoryMaintenanceReport,
  MemoryMaintenanceScanRequest,
  MemoryMaintenanceScanRequestInput,
  MemoryScope,
  NormalizedSkill,
  NoteProjectRole,
  ObjectSchemaExportManifest,
  ObjectSchemaImportRequest,
  ObjectSchemaImportRequestInput,
  ObjectSchemaImportResponse,
  ObjectSchemaManifestKind,
  ObjectSchemaManifestRelationHint,
  ObjectSchemaSuggestionFinding,
  ObjectSchemaSuggestionReport,
  ObjectSchemaSuggestionScanRequest,
  ObjectSchemaSuggestionScanRequestInput,
  ObjectSchemaSuggestionScanResponse,
  ProjectBriefVersion,
  ProjectInstructionVersion,
  ProjectPrimaryMode,
  ProjectResearchQuestionAssessmentConfirmation,
  ProjectResearchQuestionAssessmentConfirmationResponse,
  ProjectResearchQuestionAssessmentMessage,
  ProjectResearchQuestionAssessmentSession,
  ProjectResearchQuestionRefinement,
  ProjectResearchQuestionRefinementResponse,
  ProjectResearchQuestionRefinementResult,
  PromptAssetContent,
  PromptAssetDetail,
  PromptAssetScopeType,
  PromptAssetSummary,
  PromptDeploymentRef,
  PromptEvaluationRequest,
  PromptEvaluationResult,
  PromptMessage,
  PromptPromotionRequest,
  PromptPromotionRequestInput,
  PromptRenderPreviewRequest,
  PromptRenderPreviewResult,
  PromptRollbackRequest,
  PromptType,
  PromptVersion,
  PromptVersionCreateRequest,
  PromptVersionSource,
  PromptVersionStatus,
  ProposalAcceptOut,
  ReaderAnnotationCreate,
  RelationDiscoveryScanRequest,
  RelationDiscoveryScanRequestInput,
  RelationDiscoveryScanResponse,
  RelocationMode,
  RelocationPreview,
  RelocationRequest,
  RelocationResponse,
  ResearchProviderKey,
  ResearchQueryAttempt,
  ResearchQueryStrategy,
  ResearchReportV1,
  ResearchSemanticConcept,
  RetrievalBrief,
  RetrievalBriefRequest,
  RetrievalBriefResponse,
  RetrievalCalibrationDecision,
  RetrievalCalibrationDecisionRequest,
  RetrievalCalibrationDecisionResponse,
  RetrievalCalibrationMechanic,
  RetrievalCitation,
  RetrievalExplainRequest,
  RetrievalExplainResponse,
  RetrievalFeedbackRequest,
  RetrievalFeedbackResponse,
  RetrievalFeedbackSignal,
  RetrievalGapAnalysis,
  RetrievalGapItem,
  RetrievalMaintenanceScanRequest,
  RetrievalMaintenanceScanRequestInput,
  RetrievalObjectType,
  RetrievalRankingMechanicState,
  RetrievalRuntimeRankingConfig,
  RetrievalSearchMode,
  RetrievalSearchRequest,
  RetrievalSearchResponse,
  RetrievalSearchResult,
  RetrievalToolMode,
  Room,
  RoomAgentAddRequest,
  RoomAgentCandidate,
  RoomAgentCandidatesResponse,
  RoomAgentMember,
  RoomAgentMutationResponse,
  RoomAgentPreset,
  RoomAgentPresetRequest,
  RoomConversation,
  RoomConversationSummary,
  RoomConversationSummaryResponse,
  RoomDetail,
  RoomInvitation,
  RoomInvitationCreateRequest,
  RoomInvitationDecisionRequest,
  RoomInvitationListResponse,
  RoomPendingApproval,
  RoomPendingApprovalListResponse,
  RoomMessage,
  RoomOwnerTransferRequest,
  RoomUserMember,
  RunDelegation,
  RuntimeRenderMode,
  SendAgentRunGroupMessageRequest,
  SendAgentRunGroupMessageResponse,
  SendRoomMessageRequest,
  SkillConvertToCapabilityResponse,
  SkillImportApprovalProposalResponse,
  SkillImportPreviewResponse,
  SkillLibraryIndexItem,
  SkillLibraryIndexResponse,
  SkillLocalOverlay,
  SkillLocalOverlayConfig,
  SkillLocalOverlayScope,
  SkillLocalOverlayStatus,
  SkillLocalOverlayUpsertRequest,
  SkillPackage,
  SkillPackageFile,
  SkillPackageFilePreview,
  SkillPackageStatus,
  SkillRiskLevel,
  SkillSource,
  SourceChannel,
  SourceConnector,
  SourcePolicyEnvelope,
  SourceProvider,
  SourceProviderCategoryGroup,
  SourceProviderCategoryOption,
  SourceProviderSetupSchema,
  SourceRecipeDefinition,
  SourceRecipeDryRunResult,
  SourceRecipeDryRunStatus,
  SourceRecipePrimitiveName,
  SourceRecipeStepTrace,
  SourceRecipeStepTraceStatus,
  SourceRecipeVersionStatus,
  SourceRunImplementation,
  SourceRunKind,
  SourceRunStatus,
  SpaceObjectProfileCreateProposalRequest,
  SpaceObjectProfileCreateProposalRequestInput,
  SpaceObjectProfileOut,
  SpaceObjectProfilePage,
  SpaceObjectProfileRelationHintDirection,
  SpaceObjectProfileRelationHintLinkType,
  SpaceObjectProfileRelationHintRequest,
  SpaceObjectProfileStatus,
  SpaceObjectProfileUpdateProposalRequest,
  SpaceObjectProfileUpdateProposalRequestInput,
  SpaceOversightMode,
  SpaceRetrievalSettings,
  SpaceRetrievalSettingsUpdate,
  UpdateAgentRunGroupRequest,
  UpdateAgentRunGroupResponse,
}
import { OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE } from '@rainver/protocol'

export type SpaceType      = 'personal' | 'household' | 'team'

export interface ResearchChecklistItem { id: string; text: string; status: 'open' | 'done' | 'dismissed'; sort_order: number; origin: 'user' | 'agent'; origin_run_id: string | null; created_at: string; updated_at: string }
export interface ResearchEvidenceCard { id: string; source_item_id: string; object_id: string | null; why_md: string; how_md: string; what_md: string; edited_by_user: boolean; stance: 'supports' | 'contradicts' | 'new_direction' | null; comparison_detail: string | null }
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
export interface ResearchReadingList { items: Array<ProjectCorpusItem & { evidence_card: ResearchEvidenceCard | null }>; total: number; limit: number; offset: number }
export type MemberRole     = 'owner' | 'admin' | 'reviewer' | 'member' | 'guest' | 'viewer'
export type InviteStatus   = 'pending' | 'accepted' | 'revoked' | 'expired'

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
  egress_notifications_enabled: boolean
  /**
   * Active members. A single-member Space has no team to divide from, so the
   * capture composer drops the "only you / team visible" wording there — the
   * destinations and what they store are unchanged.
   */
  member_count: number
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
  workspace_location_id?: string | null
  trust_mode?: 'sandboxed' | 'trusted_host' | null
  project_id: string | null
  grants: ContentAccessGrantOut[]
}
export interface ContentAccessUpdate {
  visibility: ContentVisibility
  access_level: ContentAccessLevel
  project_id: string | null
  grants: Array<{ user_id: string; access_level: ContentAccessLevel }>
  demotion_confirmation_id?: string
}
export interface ContentAccessLogEntry {
  id: string
  space_id: string
  resource_type: string
  resource_id: string
  owner_user_id: string
  viewer_user_id: string
  viewer_display_name: string
  agent_id: string | null
  run_id: string | null
  access_type: string
  reason: string | null
  accessed_at: string
}
export interface ContentAccessLogList {
  items: ContentAccessLogEntry[]
  limit: number
  offset: number
  returned: number
  has_more: boolean
}
export interface ContentDemotionDisclosure {
  confirmation_id: string
  expires_at: string
  resource_type: string
  resource_id: string
  target_visibility: Exclude<ContentVisibility, 'space_shared'>
  exposure: {
    readers: Array<{ user_id: string; display_name: string; access_count: number; last_accessed_at: string; link: string }>
    consuming_runs: Array<{ run_id: string; title: string; status: string; link: string }>
    shared_derived_outputs: Array<{ resource_type: 'artifact' | 'proposal'; id: string; title: string; visibility: string; link: string }>
  }
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
export type KnowledgeLinkType =
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
/**
 * Also re-exported rather than restated, and for the same reason: the local
 * copy had gone stale in exactly the same place, missing `inquiry_thread`.
 */
export const SPACE_OBJECT_PROFILE_KEYS_BY_BASE_OBJECT_TYPE: Record<RetrievalObjectType, readonly string[]> =
  OBJECT_PROFILE_KEY_VALUES_BY_BASE_OBJECT_TYPE
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

export interface AskSpaceClaimTrajectorySignal {
  kind: string
  from_claim_id: string
  to_claim_id: string
  summary: string
  confidence_tier: 'high' | 'medium' | 'low'
}

export interface CrossSpaceResolveResponse {
  items: CrossSpaceResolvedItem[]
  unresolved_pointer_ids: string[]
}
export interface CrossSpaceEgressDisclosure {
  disclosure_id: string
  expires_at: string
  source_spaces: Array<{
    space_id: string
    space_name: string
    egress_notifications_enabled: boolean
    pointers: Array<{ resource_type: RetrievalObjectType; id: string }>
  }>
}
export interface CrossSpaceFusedStoreResponse {
  artifact_id: string
  egress_record_ids: string[]
}
export interface SpaceMemberNotification {
  id: string
  space_id: string
  event_type: 'egress_notification_setting_changed' | 'content_egress'
  pointer_metadata: Record<string, unknown>
  created_at: string
  read_at: string | null
}
export interface SpaceEgressNotificationSetting {
  space_id: string
  egress_notifications_enabled: boolean
  updated_at: string
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
export type RetrievalCalibrationDecisionValue = 'adopt' | 'defer' | 'reject'
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
export interface RetrievalMaintenanceScanResponse {
  counts: Record<string, number>
  scanned: number
  truncated: boolean
  artifact_id?: string
  proposal_id?: string
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

export type ModelSelectionMode = 'cli_default' | 'cli_model_override' | 'rainver_provider'

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

export interface SourceQueryPreview {
  provider_key: string
  compiled_query: string
  approximate_hit_count: number
  samples: Array<{ title: string; source_uri: string | null; occurred_at: string | null }>
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

export interface SourceRecommendation extends SourceChannel {
  subscription_status: 'pending'
  recommendation_message: string | null
  last_notified_at: string | null
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
  question_refinement?: ProjectResearchQuestionRefinementResult | null
  execution: {
    model_provider_id?: string
    model_name?: string
  }
}

export interface MaterializedResearchStrategy {
  query_strategy_id: string
  project_id: string
  status: 'materialized'
  sources: Array<{ provider_key: ResearchProviderKey; research_query_attempt_id: string; source_channel_id: string; project_source_binding_id: string; query_fingerprint: string }>
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

export type SourceRecipeSourceType = 'rss' | 'atom' | 'web_list' | 'web_page'

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
  standing_comparison_enabled: boolean
  filters_json: Record<string, unknown>
  routing_policy_json: Record<string, unknown>
  extraction_policy_json: Record<string, unknown>
  extraction_profile?: {
    key: string
    display_name: string
    entity_type: string
    graph_lens_id: string | null
  } | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  backfill_result?: ProjectSourceBindingBackfillResult
}

export interface ProjectExtractionProfile {
  key: string
  display_name: string
  entity_type: string
  domain_criteria_keys: string[]
  graph_lens_id: string | null
  is_default: boolean
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
  link_type: KnowledgeLinkType
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
  project_id?: string | null
  project_folder_id?: string | null
  tags: string[]
  confidence?: number | null
  source_refs?: Record<string, unknown>[]
  source_run_id?: string | null
  object_profile_fields?: Record<string, unknown>
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
  object_profile_fields?: Record<string, unknown>
  rationale?: string | null
  verification_status?: KnowledgeVerificationStatus
  reflection_status?: KnowledgeReflectionStatus
}

export interface KnowledgeRelationProposalBody {
  from_object_id: string
  to_object_id: string
  link_type: KnowledgeLinkType
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
  /**
   * The system-reserved role this note holds in its project's notebook, or null.
   * One note per role per project — assigning a role another note holds moves it.
   */
  project_role: NoteProjectRole | null
  /** The project `project_role` is scoped to; null exactly when the role is. */
  role_project_id: string | null
  /**
   * Every folder this note is placed in, in placement order. A note may sit in
   * several at once (`note_collection_items` is unique on
   * `(collection_id, note_id, space_id)`), so there is no single "the folder" —
   * a scalar here was what made a second placement invisible.
   */
  placements: NotePlacement[]
  /** Optimistic-concurrency version; bumped by every save (user or AI). */
  version: number
  content_hash: string | null
  updated_by_user_id: string | null
  updated_by_run_id: string | null
  created_at: string
  updated_at: string
}

/**
 * A Project this note is readable in beyond the one that owns it (U8).
 * Read-only by construction: a share widens Project scope and nothing else, so
 * it carries no access level.
 */
export interface NoteProjectShare {
  project_id: string
  project_name: string | null
  shared_by_user_id: string
  created_at: string | null
}

/** One folder a note is filed in, and its position within that folder. */
export interface NotePlacement {
  collection_id: string
  sort_order: number
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
  /**
   * Assigns this notebook role to the note, or clears it with null. Assigning a
   * role another note in the same project holds moves it off that note.
   */
  project_role?: NoteProjectRole | null
  /** Moves the note into this folder (replaces its current folder). */
  collection_id?: string
  /** Optimistic-concurrency check for content_json writes; omit to skip the check. */
  expect_version?: number
}

export interface NoteJotBody {
  /**
   * The `space_objects` row the jot is about — a Source, Claim, Question, …
   * Optional (U11): without one the text appends to the Project's `inbox` note,
   * which is what makes capture possible when nothing is on screen to hang it
   * on. `project_id` is then required.
   */
  target_id?: string
  text: string
  /** Appends to this note when given; otherwise a new note is created. */
  note_id?: string
  project_id?: string
  collection_id?: string
  /** Defaults to `references`. */
  link_type?: EntityLinkType
}

export interface NotePromoteBody {
  /** The selected passage. Not the note's whole text — a note holds several ideas. */
  content: string
  /** Defaults to the note's own title. */
  title?: string
  knowledge_kind?: string
  content_format?: NoteContentFormat
  /** Defaults to the note's project. */
  project_id?: string
  rationale?: string
}

/**
 * One note placement's new position. `from_collection_id` is what identifies
 * the row: a note may be placed in several folders, and addressing a move by
 * note id alone rewrote every placement of that note to one folder.
 */
export interface NotesTreeNoteOrderUpdate {
  note_id: string
  from_collection_id: string
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
  project_id?: string | null
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
  status: 'proposed' | 'auto_applied' | 'completed' | 'failed' | 'rejected'
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
  workspace_location_id?: string | null
  project_id?: string | null
  project_folder_id?: string | null
  adapter_type?: string
  /** Remote dispatch only: which copy of the runtime on the host (`own` or `managed:<version>`); a thread keeps its first. */
  installation?: string
  thread_id?: string | null
  /**
   * Remote dispatch only. Absent means the thread's own backend (or the Host ×
   * adapter default on its first message); an explicit `null` means the
   * machine's own login for this dispatch. The two are read by key presence,
   * not truthiness — omitting the field is not the same as sending null.
   */
  model_provider_id?: string | null
  model?: string | null
  timeout_ms?: number | null
  task_title?: string | null
  prompt?: string | null
  instruction?: string | null
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
  source: 'request' | 'runtime_profile' | 'agent_default' | 'runtime_default' | 'space_default' | 'host_binding' | 'none'
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
  project_folder_id: string | null
  workspace_location_id?: string | null
  trust_mode?: 'sandboxed' | 'trusted_host' | null
  /** ADR 0016 D14: set only for a run dispatched to a remote host. */
  host_task_thread_id?: string | null
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
  project_id?: string | null
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
  required_approver_user_ids?: string[] | null
  requires_approval_type?: string | null
  egress_approval_status?: string | null
  egress_approval_id?: string | null
  incomplete_patch?: boolean
  skipped_changes?: Array<Record<string, unknown>>
  skipped_count?: number
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
  required_approver_user_ids?: string[] | null
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

export interface AgentModelSummary {
  provider_id: string | null
  provider_name: string | null
  provider_type: string | null
  model: string | null
}

export interface AgentOut {
  id: string
  space_id: string
  project_id: string | null
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
  project_id?: string | null
  description?: string | null
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
  repo_url: string | null
  /** Deprecated compatibility field; use WorkspaceLocation.root_path. */
  root_path?: string | null
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

export interface WorkspaceLocation {
  id: string
  project_folder_id: string
  execution_host_id: string
  execution_host_kind: 'server' | 'remote'
  display_path: string | null
  /** Deprecated compatibility field; physical paths now live on locations. */
  root_path?: string | null
  branch: string | null
  git_head: string | null
  dirty: boolean | null
  status: 'active' | 'archived' | 'stale'
  preferred: boolean
  execution_ready: boolean
  last_seen_at: string | null
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
  snapshot_retention_days?: number | null
  snapshot_max_count?: number | null
}

export interface ProjectFolderScanCandidate {
  name: string
  path: string
}

// --- ADR 0016: multi-host control center -----------------------------------

/** One choice as the runtime describes it: its own name, and what it means. */
// The host/dispatch contract is the protocol's; one shape for server and web.
import type { HostCapabilities } from '@rainver/protocol'
export type { DispatchBackend, DispatchOptions, HostCapabilities, RuntimeInstallation, RuntimeOptionChoice, RuntimeOptions } from '@rainver/protocol'

export interface Host {
  id: string
  owner_user_id: string | null
  machine_id?: string
  machine_name?: string | null
  environment_kind?: string
  name: string
  kind: 'server' | 'remote'
  status: 'pending_pairing' | 'online' | 'offline' | 'revoked'
  last_heartbeat_at: string | null
  platform: string | null
  arch: string | null
  daemon_version: string | null
  /** The control-plane address this daemon reports it reaches. */
  daemon_server_url?: string | null
  /** Explicit proxy address for this host; null means it is derived. */
  provider_proxy_base_url?: string | null
  /** What a dispatched run will actually use, resolved server-side. */
  provider_proxy_effective_url?: string | null
  capabilities_json: HostCapabilities | null
  created_at: string
  updated_at: string
}

export interface HostPairingCode {
  host_id: string
  pairing_code: string
  expires_at: string
}

export interface HostTaskThread {
  id: string
  workspace_location_id?: string
  project_folder_id: string
  host_id: string
  adapter_type: string
  runtime_installation?: string
  vendor_session_id: string | null
  last_run_id: string | null
  status: 'active' | 'session_reset'
  created_by_user_id: string
  created_at: string
  updated_at: string
  /** control-center-phase2-plan.md P2 (C4): non-null while the message queue is paused. */
  queue_paused_at: string | null
}

/** control-center-phase2-plan.md P3 (C10): a `GET /hosts/threads/recent` row — cross-project, joined summary fields included. */
export interface HostRecentThread extends HostTaskThread {
  project_id: string
  project_name: string
  folder_name: string
}

export type HostThreadMessageStatus = 'queued' | 'dispatched' | 'withdrawn'

export interface HostThreadMessage {
  id: string
  host_task_thread_id: string
  task_id?: string
  prompt: string
  status: HostThreadMessageStatus
  /** The backend this message resolved to. Null means the machine's own login. */
  model_provider_id: string | null
  model: string | null
  run_id: string | null
  created_by_user_id: string
  created_at: string
  updated_at: string
}

export type HostThreadEventType =
  | 'assistant_text'
  | 'assistant_thought'
  | 'tool_activity_started'
  | 'tool_activity_finished'
  | 'status'
  | 'diagnostic'
  | 'plan_updated'

export interface HostThreadEvent {
  id: string
  host_task_thread_id: string
  run_id: string
  event_index: number
  event_type: HostThreadEventType
  text: string | null
  tool_call_id: string | null
  tool_name: string | null
  tool_input_summary: string | null
  /** ACP runtime replatform P3 (A9): set on tool_activity_started only. */
  tool_kind: string | null
  /** ACP runtime replatform P3 (A9): set on tool_activity_finished only; absent for codex (adapter asymmetry, not a bug). */
  tool_result_summary: string | null
  status: string | null
  created_at: string
}

/** control-center-phase2-plan.md P3 (C6): a `GET /hosts/runtime-adapters` row. */
export interface HostRuntimeAdapterOption {
  adapter_type: string
  display_name: string
  command: string
  /** ACP runtime replatform P3: the vendor binary a host's capability probe actually reports (may differ from `command`). */
  capability_probe: string
  remote_eligible: boolean
  /** The ACP registry entry this adapter's managed copy is installed from, when it has one. */
  registry_id?: string | null
  /** Whether a ModelProvider can be bound to it; false for a registry agent, which runs on the copy's own login only. */
  provider_binding?: boolean
  /** Which ModelProvider endpoint it speaks — the `<provider_api>_base_url` a binding needs. */
  provider_api?: 'claude_compatible' | 'openai_compatible' | null
}

/**
 * Which model backend a host's runtime adapter runs against by default. No
 * binding for an (host, adapter) pair means runs use the machine's own login
 * state, which stays the default.
 */
export interface HostRuntimeProviderBinding {
  host_id: string
  adapter_type: string
  model_provider_id: string
  /** null = the provider's own default model. */
  model: string | null
  updated_at: string
}

export interface HostDispatchResponse {
  // control-center-phase2-plan.md P2 (C4): every send goes through the
  // per-thread message queue — `message_id` always identifies the sent
  // message; `run_id` is only set once something actually dispatched
  // (`status: "dispatched"`), null while the message is still `"queued"`
  // behind an active run or a paused thread.
  message_id: string
  thread_id: string
  run_id: string | null
  status: 'dispatched' | 'queued'
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
  created_at: string
  updated_at: string
}

export type ProjectFolderExecutionConfigUpdate = Partial<Omit<ProjectFolderExecutionConfig,
  'id' | 'space_id' | 'project_folder_id' | 'created_at' | 'updated_at'
>>

export interface ProjectOverview {
  project: Pick<Project, 'id' | 'name' | 'primary_mode' | 'status'>
  brief: ProjectBriefVersion | null
  definition_status?: {
    status: 'initialized' | 'needs_definition'
    basis: 'published_brief_goal' | 'missing_published_brief_goal'
    goal_or_problem: string | null
  }
  available_modes: ProjectPrimaryMode[]
  attention: Array<{
    id: string
    title: string
    summary: string | null
    href: string
    severity: 'low' | 'normal' | 'high' | 'critical'
    source_type?: string
    source_id?: string
    reason?: string
    action_descriptors?: Array<{ label: string; href: string }>
    /** Why this needs a person — see ADR 0017 §4. */
    attention_class: 'gate' | 'remainder' | 'next_step' | 'uncertain'
  }>
  /** Unfinished Operations — what is running, for the front page. */
  in_progress?: Array<Pick<ProjectOperation, 'id' | 'project_id' | 'kind' | 'title' | 'status' | 'progress_json' | 'created_at' | 'updated_at'>>
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
  current_stage: string | null
  status: string
  state_json: Record<string, unknown>
  primary_thread_id: string | null
  started_by_user_id: string | null
  started_run_id: string | null
  created_at: string
  updated_at: string
}

export interface ProjectResearchStandingBatch {
  id: string
  status: 'pending' | 'running' | 'completed' | 'blocked_baseline' | 'budget_exhausted' | 'failed'
  source_item_ids: string[]
  ready_at: string
  run_id: string | null
  missing_baseline_role: string | null
  error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface ProjectResearchStandingAdvice {
  id: string
  source_item_id: string
  batch_id: string
  source_title: string
  detail: string
  affected_sections_json: string[]
  status: 'open' | 'actioned' | 'dismissed'
  action_id: 'source.raise_as_question'
  action_input_json: { kind: 'question'; statement: string; producer_idempotency_key: string }
  idempotency_key: string
  created_at: string
  updated_at: string
}

export interface ProjectResearchStandingStatus {
  enabled: boolean
  enabled_binding_count: number
  budget: { daily_limit: number; daily_used: number }
  batches: ProjectResearchStandingBatch[]
  advice: ProjectResearchStandingAdvice[]
  recent_inflow: Array<{ source_item_id: string; title: string; excerpt: string | null; matched_at: string }>
}

/** One aggregated monitoring outcome per focused workflow or standing Project window; a missing day means no scan was recorded. */
export interface ProjectResearchScanSummary {
  workflow_id: string | null
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
  screened_items: number
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
  archive_descriptors?: Array<{ kind: 'archive' | 'evidence_matrix' | 'integrity'; artifact_id: string }>
  resolved_references?: Array<{ id: string; availability: 'available' | 'unavailable'; title?: string; authors?: string[]; year?: number | null; library_path?: string; academic_path?: string; external_url?: string; excerpts?: Array<{ id: string; title?: string }> }>
}

export interface ProjectResearchScreeningCriteria {
  id: string | null
  project_id: string
  include_keywords: string[]
  exclude_keywords: string[]
  /** Domain-specific axes, keyed by what the Project's bound extraction
   * profiles declare. Empty when no bound source declares any. */
  domain_criteria: Record<string, string[]>
  available_domain_criteria: string[]
  date_range_start: string | null
  date_range_end: string | null
  /** Where material may come from — journals, outlets and sites alike. */
  source_restrictions: string[]
  required_evidence_fields: string[]
  created_at: string | null
  updated_at: string | null
}

export interface ProjectResearchEvidenceMatrixItem {
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

export interface InformationDigestItem {
  id: string
  source_item_id: string
  section: 'interest' | 'serendipity'
  position: number
  quota_slot: string
  matched_topic_id: string | null
  serendipity_pool_item_id: string | null
  target_domain_key: string | null
  discovery_origin: string | null
  score: number
  component_scores: Record<string, number>
  rationale: string | null
  title: string
  source_uri: string | null
  source_domain: string | null
  author: string | null
  excerpt: string | null
  occurred_at: string | null
  domain_key: string
  depth: string
  genre: string
  summary: string | null
  stance_target: string | null
  stance_target_key: string | null
  stance_polarity: 'supports' | 'opposes' | 'mixed' | 'neutral'
  stance_confidence: number
  read_status: string
  serendipity_feedback: 'interesting' | 'neutral' | 'never' | null
  anonymous_read_count: number | null
}

export interface SerendipityFeedbackResult {
  digest_item_id: string
  domain_key: string
  feedback: 'interesting' | 'neutral' | 'never'
  cooldown_until: string | null
  blocked: boolean
  created_at: string
}

export interface InformationDigest {
  id: string
  digest_type: 'personal' | 'project'
  owner_user_id: string | null
  project_id: string | null
  digest_date: string
  profile_maturity: 'cold' | 'warming' | 'warm' | null
  status: 'ready' | 'empty' | 'failed'
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
  items: InformationDigestItem[]
  team_aggregates_available: boolean
  team_blind_spot_domains: string[]
}

export interface InterestProfileSnapshot {
  profile_id: string
  maturity: 'cold' | 'warming' | 'warm'
  read_item_count: number
  covered_domain_count: number
  skeleton_size: number
  exploration_share: number
  gaps_are_meaningful: boolean
  coverage: Array<{ domain_key: string; item_count: number; weighted_count: number }>
  topics: Array<{ id: string; topic_key: string; label: string; domain_key: string; weight: number }>
  ready_candidates: Array<{ id: string; phrase_key: string; display_phrase: string; domain_key: string | null; occurrence_count: number; read_count: number }>
  domains: Array<{ key: string; label: string; group: string }>
  settings: InterestProfileSettings
  starter_packs: Array<{ key: string; label: string; topics: Array<{ label: string; domainKey: string }> }>
}

export interface InterestProfileSettings {
  coverage_half_life_days: number
  new_topic_occurrence_threshold: number
  new_topic_read_threshold: number
  warming_min_read_items: number
  warm_min_read_items: number
  warm_min_covered_domains: number
  interest_slots: number
  serendipity_slots: number
  interesting_cooldown_days: number
  neutral_cooldown_days: number
  probe_domain_budget: number
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
  project_id: string | null
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
  project_id: string | null
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

export interface ReaderAnnotationUpdate {
  color?: string | null
  label?: string | null
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

export interface Project {
  id: string
  space_id: string
  owner_user_id: string | null
  name: string
  description: string | null
  status: ProjectStatus
  current_focus: string | null
  settings_json: Record<string, unknown> | null
  primary_mode: ProjectPrimaryMode
  active_brief_version_id: string | null
  current_user_can_approve_context?: boolean
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface ProjectCreate {
  name: string
  description?: string | null
  current_focus?: string | null
  settings_json?: Record<string, unknown> | null
  /** How the Project advances. Defaults to `research` when omitted. */
  primary_mode?: ProjectPrimaryMode
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

// ── Automations ─────────────────────────────────────────────────────────────
export type AutomationTriggerType = 'manual' | 'schedule'

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

export interface RelocationBlock {
  block_id: string
  text: string
  /** The capture's own block. Preselected; the rest are offered unchecked. */
  anchored: boolean
}

/** A user-created durable focus area. Classifies content; decides no access (ADR 0015). */
export interface FocusArea {
  id: string
  space_id: string
  owner_user_id: string | null
  name: string
  description: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface FocusAreaContents {
  projects: Array<{ id: string; name: string; status: string }>
  objects: Array<{ id: string; object_type: string; title: string | null }>
}


// --- Project work (Board, Loop, work events) -------------------------------
//
// Re-exported from the protocol package rather than copied: the package is
// already a web dependency, and a copy had already drifted (`severity` went
// optional here while the server sorts on it).
export type {
  WorkLoopStageKey,
  ResponsibleActor,
  TaskCompletion,
  ProjectBoardCard,
  ProjectBoardColumn,
  TaskWorkEvent,
  ProjectWorkUpdate,
  ProjectWorkUpdatesResponse,
  ProjectMainlineRoomResponse,
  ProjectConversation,
  ProjectConversationsResponse,
} from '@rainver/protocol'
export type { ProjectBoardResponse as ProjectBoard, TaskWorkViewResponse as TaskWorkView } from '@rainver/protocol'

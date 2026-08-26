import type {
  AcademicPaper,
  AcademicPaperAuthor,
  AcademicPaperCitation,
  AcademicPaperCreate,
  AcademicPaperUpdate,
  ActivityInboxRecord,
  ActivityRecord,
  ActivitySourceType,
  AgentConfigUpdateBody,
  AgentCreateBody,
  AgentOut,
  AgentRunGroup,
  AgentRunGroupTimeline,
  AgentRunGroupTrace,
  AgentRuntimeProfileCreateBody,
  AgentRuntimeProfileOut,
  AgentRuntimeProfileUpdateBody,
  AgentTemplateOut,
  AgentTemplateVersionOut,
  AgentUpdateBody,
  AgentVersionOut,
  ApiError,
  Artifact,
  AskSpaceRequest,
  AskSpaceResponse,
  AuthorizationRequest,
  AutomationCreateBody,
  AutomationFireResult,
  AutomationOut,
  AutomationUpdateBody,
  Board,
  CapabilityDefinition,
  CapabilityPackDescriptor,
  CaptureRequest,
  CaptureResponse,
  ChatTurnAccepted,
  ChatTurnOut,
  ClaimCandidatePacketCreateRequestInput,
  ClaimCandidatePacketCreateResponse,
  ClaimContradictionScanRequestInput,
  ClaimContradictionScanResponse,
  CliCredentialAvailableProfileOut,
  CliCredentialProfileOut,
  CliUsageAutoRefreshSettings,
  CliUsageEntry,
  ContentAccessLogList,
  ContentAccessPolicy,
  ContentAccessUpdate,
  ContentDemotionDisclosure,
  ContentVisibility,
  ContextOpsContextObservationScanRequestInput,
  ContextOpsContextObservationScanResponse,
  ContextOpsDrilldown,
  ContextOpsDrilldownSection,
  ContextOpsSummary,
  ContextReviewCycleRequestInput,
  ContextReviewCycleResponse,
  ConversationBackendBinding,
  ConversationBackendCatalog,
  CreateAgentFromTemplateBody,
  CreateAgentRunGroupRequest,
  CreateAgentRunGroupResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  RoomAgentAddRequest,
  RoomAgentCandidatesResponse,
  RoomAgentMutationResponse,
  RoomAgentPresetRequest,
  CredentialLoginMethod,
  CredentialStatus,
  CrossSpaceEgressDisclosure,
  CrossSpaceFusedStoreResponse,
  CrossSpaceResolveResponse,
  CrossSpaceRetrievalRequest,
  CrossSpaceRetrievalResponse,
  CurrentUser,
  CustomSourceActivationResult,
  CustomSourceCreateDraftRequest,
  CustomSourceCredentialDTO,
  CustomSourceHandlerRun,
  CustomSourceHandlerSummary,
  CustomSourceHandlerVersion,
  CustomSourceInstanceRunnerSettings,
  CustomSourceInstanceRunnerSettingsUpdate,
  CustomSourceSpacePolicy,
  CustomSourceSpacePolicyUpdate,
  CustomSourceTestOutcome,
  DailyCaptureReportSettingOut,
  DailyCaptureReportSettingUpdate,
  DailyReportArtifactItem,
  DailyReportRunRequest,
  DailyReportRunResponse,
  EgressApprovalRequest,
  EntityLink,
  EvidenceLink,
  EvolutionBundle,
  EvolutionExperience,
  EvolutionProposal,
  EvolutionRunListItem,
  EvolutionRunResult,
  EvolutionSelectorDecision,
  EvolutionSignal,
  EvolutionSignalCreateBody,
  EvolutionStrategy,
  EvolutionSummaryOut,
  EvolutionTarget,
  EvolutionTargetCreateBody,
  EvolutionTargetUpdateBody,
  EvolutionValidationResult,
  EvolvableAsset,
  EvolvableAssetEvaluationCase,
  EvolvableAssetEvaluationRun,
  EvolvableAssetPin,
  EvolvableAssetVersion,
  ExperimentDefinition,
  ExperimentInterpretation,
  ExperimentObservation,
  ExperimentRun,
  ExperimentVersion,
  ExtractedEvidence,
  ExtractionJob,
  Feature,
  FileContent,
  FileNode,
  GitStatus,
  Host,
  HostDispatchResponse,
  HostPairingCode,
  HostRecentThread,
  HostRuntimeAdapterOption,
  HostRuntimeProviderBinding,
  HostTaskThread,
  HostThreadEvent,
  HostThreadMessage,
  WorkspaceLocation,
  HomeSummaryOut,
  InformationDigest,
  InquiryCandidate,
  InquiryDeltaBriefContent,
  InquiryEvidenceSignal,
  InquiryIteration,
  InquiryOpenStep,
  InquiryReviewPacket,
  InquiryThread,
  InquiryThreadAdvice,
  InquiryThreadDetail,
  InquiryThreadNoteLink,
  InquiryThreadRelation,
  InquiryThreadRevision,
  InquiryThreadStep,
  InterestProfileSnapshot,
  Job,
  JobEvent,
  KnowledgeCreateProposalBody,
  KnowledgeItem,
  KnowledgeItemSummary,
  KnowledgeRelation,
  KnowledgeRelationProposalBody,
  KnowledgeSourceSummary,
  KnowledgeSummary,
  KnowledgeUpdateProposalBody,
  LoginEvent,
  MaterializedResearchStrategy,
  Memory,
  MemoryMaintenanceJob,
  MemoryMaintenanceJobRunResponse,
  MemoryMaintenanceReport,
  MemoryMaintenanceScanRequestInput,
  MePendingProposalItem,
  Message,
  MeSummaryOut,
  MeTaskItem,
  MeTimelineEntry,
  NetworkProfileCreateBody,
  NetworkProfileOut,
  NetworkProfileUpdateBody,
  Note,
  NoteCollection,
  NoteCollectionCreateBody,
  NoteCollectionUpdateBody,
  NoteCreateBody,
  NoteJotBody,
  NoteLinkCreateBody,
  NoteProjectShare,
  NotePromoteBody,
  NoteRevision,
  NotesTreeReorderBody,
  NotesTreeReorderResult,
  NoteSummary,
  NoteUpdateBody,
  ObjectSchemaExportManifest,
  ObjectSchemaImportRequestInput,
  ObjectSchemaImportResponse,
  ObjectSchemaSuggestionScanRequestInput,
  ObjectSchemaSuggestionScanResponse,
  Page,
  PersonalMemoryGrantAuditResponse,
  PersonalMemoryGrantCreateRequest,
  PersonalMemoryGrantPreviewRequest,
  PersonalMemoryGrantPreviewResponse,
  PersonalMemoryGrantResponse,
  PlanBudgetSource,
  PlanDetail,
  PlanExecuteBody,
  PlanExecutionResult,
  PlanSummary,
  Project,
  ProjectBriefVersion,
  ProjectCorpusBackfillResult,
  ProjectCorpusItem,
  ProjectCreate,
  ProjectExtractionProfile,
  ProjectFolder,
  ProjectFolderCreateBody,
  ProjectFolderExecutionConfig,
  ProjectFolderExecutionConfigUpdate,
  ProjectFolderScanCandidate,
  ProjectFolderUpdateBody,
  ProjectInstructionVersion,
  ProjectOperation,
  ProjectOverview,
  ProjectResearchCheckpoint,
  ProjectResearchEvidenceMatrixItem,
  ProjectResearchInitialIntakeInput,
  ProjectResearchInitialIntakeResponse,
  ProjectResearchQuestionAssessmentConfirmation,
  ProjectResearchQuestionAssessmentConfirmationResponse,
  ProjectResearchQuestionAssessmentSession,
  ProjectResearchQuestionRefinement,
  ProjectResearchQuestionRefinementResponse,
  ProjectResearchReport,
  ProjectResearchScreeningCriteria,
  FocusArea,
  FocusAreaContents,
  ProjectResearchWorkflow,
  ProjectSourceBinding,
  ProjectSourceBindingBackfillResult,
  ProjectSourceItem,
  ProjectSourceSummary,
  ProjectUpdate,
  PromptAssetDetail,
  PromptAssetSummary,
  PromptDeploymentRef,
  PromptEvaluationRequest,
  PromptEvaluationResult,
  PromptPromotionRequestInput,
  PromptRenderPreviewRequest,
  PromptRenderPreviewResult,
  PromptRollbackRequest,
  PromptType,
  PromptVersion,
  PromptVersionCreateRequest,
  Proposal,
  ProposalAcceptOut,
  ProposalApprovalResponse,
  ReaderAnnotation,
  ReaderAnnotationCreate,
  ReaderAnnotationsResponse,
  ReaderAnnotationUpdate,
  ReaderComment,
  ReaderCommentCreate,
  ReaderCommentThread,
  ReaderCommentUpdate,
  ReaderCreatedEvidence,
  ReaderCreatedProposal,
  ReaderCreateEvidenceRequest,
  ReaderCreateProposalRequest,
  ReaderDocumentPayload,
  ReaderThreadUpdate,
  ReflectResult,
  RelationDiscoveryScanRequestInput,
  RelationDiscoveryScanResponse,
  RelocationPreview,
  RelocationRequest,
  RelocationResponse,
  ResearchArea,
  ResearchChecklistItem,
  ResearchEvidenceCard,
  ResearchProviderKey,
  ResearchQueryStrategy,
  ResearchReadingList,
  ResolvedEvolvableAssetVersion,
  RetrievalBriefRequest,
  RetrievalBriefResponse,
  RetrievalCalibrationDecisionRequest,
  RetrievalCalibrationDecisionResponse,
  RetrievalDiagnosticsReportRequest,
  RetrievalDiagnosticsReportResponse,
  RetrievalExplainRequest,
  RetrievalExplainResponse,
  RetrievalFeedbackRequest,
  RetrievalFeedbackResponse,
  RetrievalMaintenanceScanRequestInput,
  RetrievalMaintenanceScanResponse,
  RetrievalObjectType,
  RetrievalSearchRequest,
  RetrievalSearchResponse,
  Room,
  RoomConversation,
  RoomConversationSummaryResponse,
  RoomDetail,
  RoomInvitation,
  RoomInvitationCreateRequest,
  RoomInvitationDecisionRequest,
  RoomInvitationListResponse,
  RoomPendingApprovalListResponse,
  RoomOwnerTransferRequest,
  RoomMessage,
  ContinueRoomAfterProposalRequest,
  Run,
  RunAttempt,
  RunCreateBody,
  RunEvaluation,
  RunFinalization,
  RunLogicalIO,
  RunStatusOut,
  RunSupervisorDecision,
  RuntimeToolDefinition,
  RuntimeToolInstallResult,
  RuntimeToolLatest,
  RuntimeToolStatus,
  RunVerificationResult,
  SendAgentRunGroupMessageRequest,
  SendAgentRunGroupMessageResponse,
  SendRoomMessageRequest,
  SerendipityFeedbackResult,
  Session,
  SkillConvertToCapabilityResponse,
  SkillImportApprovalProposalResponse,
  SkillImportPreviewResponse,
  SkillLibraryIndexResponse,
  SkillLocalOverlay,
  SkillLocalOverlayUpsertRequest,
  SkillPackage,
  SourceBackfillPlan,
  SourceBackfillPreview,
  SourceBackfillQuotaPolicy,
  SourceBackfillStrategy,
  SourceCapturePolicy,
  SourceCatalog,
  SourceCatalogMapping,
  SourceCatalogProvider,
  SourceChannel,
  SourceConnector,
  SourceHealth,
  SourceItem,
  SourcePostProcessingBacklog,
  SourcePostProcessingBriefingDaySummary,
  SourcePostProcessingBriefingDetail,
  SourcePostProcessingDecisionActionResult,
  SourcePostProcessingDecisionReviewStatus,
  SourcePostProcessingDrainResult,
  SourcePostProcessingItemDecision,
  SourcePostProcessingItemRelevance,
  SourcePostProcessingRule,
  SourcePostProcessingRuleCreate,
  SourcePostProcessingRuleUpdate,
  SourcePostProcessingRun,
  SourceProvider,
  SourceQueryPreview,
  SourceRecipeActivationResult,
  SourceRecipeCreateRequest,
  SourceRecipeCreateResponse,
  SourceRecipeDryRunResponse,
  SourceRecipePipelineBridgeRequest,
  SourceRecipePipelineBridgeResponse,
  SourceRecipePlanRequest,
  SourceRecipePlanResponse,
  SourceRecipeVersion,
  SourceRecommendation,
  SourceScheduleRule,
  SpaceAssistantSettingsOut,
  SpaceAssistantSettingsUpdate,
  SpaceEgressNotificationSetting,
  SpaceInvitationOut,
  SpaceMember,
  SpaceMemberNotification,
  SpaceObjectProfileCreateProposalRequestInput,
  SpaceObjectProfilePage,
  SpaceObjectProfileStatus,
  SpaceObjectProfileUpdateProposalRequestInput,
  SpaceOversightMode,
  SpaceRetrievalSettings,
  SpaceRetrievalSettingsUpdate,
  SpaceRuntimeToolPolicyOut,
  SpaceSnapshotDefaults,
  SpaceWithMembership,
  SummaryRunOut,
  SummaryRunRequest,
  Task,
  TaskArtifact,
  TaskProposal,
  TaskRunCreateBody,
  TaskRunListItem,
  UpdateAgentRunGroupRequest,
  UpdateAgentRunGroupResponse,
  WorkflowExecutionSummary,
} from '../types/api'
import type {
  ContentPublication,
  ContentPublicationList,
  CreatePublicationRequest,
  PublicationImport,
  GraphProjection,
  GraphProjectionViewMode,
  UsageAccuracy,
  UsageBudgetPreviewResponse,
  UsageCliHistoryCommitRequest,
  UsageCliHistoryImportResponse,
  UsageCliHistoryPreviewRequest,
  UsageDimensionsResponse,
  UsageEventsResponse,
  UsageExecutionChannel,
  UsageView,
  UsageOperationalTotalsResponse,
  UsageSessionsResponse,
  UsageSubjectsResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
} from '@rainver/protocol'

const BASE = '/api/v1'

let _spaceId = 'personal'
let _apiKey: string | null = null

export function setSpaceContext(spaceId: string): void {
  _spaceId = spaceId
}

export function setAuth(key: string | null): void {
  _apiKey = key
}

function formatApiErrorMessage(err: ApiError, fallback: string): string {
  const requestId = typeof err.request_id === 'string' && err.request_id.trim()
    ? ` (request id: ${err.request_id})`
    : ''
  const withRequestId = (message: string) => `${message}${requestId}`
  if (typeof err.detail === 'string') return withRequestId(err.detail)
  if (err.detail && typeof err.detail === 'object') return withRequestId(JSON.stringify(err.detail))
  const m = err.message
  if (typeof m === 'string') return withRequestId(m)
  if (m && typeof m === 'object') {
    const rec = m as Record<string, unknown>
    const code = rec.code
    if (typeof code === 'string') return withRequestId(code)
    return withRequestId(JSON.stringify(m))
  }
  return withRequestId(fallback)
}

interface RequestOptions {
  includeSpaceContext?: boolean
  spaceId?: string
  idempotencyKey?: string
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The server's machine-readable `code`, when it sent one. Present exactly
     * where the client is expected to *do* something specific rather than
     * surface the message — matching on prose is how error handling rots.
     */
    readonly code?: string,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

async function request<T = unknown>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  // FormData (file/voice upload) must keep the browser-set multipart boundary, so
  // we do not force a Content-Type for it and pass the body through unserialized.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData
  const headers: Record<string, string> = isForm ? {} : { 'Content-Type': 'application/json' }
  if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
  if (options.includeSpaceContext ?? true) headers['X-Rainver-Space-Id'] = options.spaceId ?? _spaceId
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

  const url = BASE + path

  const opts: RequestInit = { method, headers }
  if (body !== undefined) opts.body = isForm ? (body as FormData) : JSON.stringify(body)

  const r = await fetch(url, opts)

  if (r.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:required'))
  }

  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    let code: string | undefined
    let payload: Record<string, unknown> | undefined
    try {
      const err = await r.json() as ApiError & { code?: unknown }
      if (err && typeof err === 'object') payload = err as unknown as Record<string, unknown>
      msg = formatApiErrorMessage(err, msg)
      if (typeof err.code === 'string') code = err.code
    } catch {
      const text = await r.text().catch(() => '')
      if (text) msg = text
    }
    throw new ApiRequestError(msg, r.status, code, payload)
  }

  if (r.status === 204) return null as T
  return r.json() as Promise<T>
}

const get   = <T>(path: string, options?: RequestOptions)                => request<T>('GET',    path, undefined, options)
const post  = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST',   path, body, options)
const put   = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT',    path, body, options)
const patch = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH',  path, body, options)
const del   = <T>(path: string, options?: RequestOptions)                => request<T>('DELETE', path, undefined, options)

async function postChatTurn(
  path: string,
  body: unknown,
  options: RequestOptions & {
    onAccepted?: (accepted: ChatTurnAccepted) => void
    onLifecycle?: (event: {
      event_type: string
      status: string
      summary?: string | null
    }) => void
    onTextDelta?: (delta: string) => void
  } = {},
): Promise<ChatTurnOut> {
  const accepted = await post<ChatTurnAccepted>(path, body, options)
  options.onAccepted?.(accepted)
  const headers: Record<string, string> = {}
  if (_apiKey) headers.Authorization = `Bearer ${_apiKey}`
  headers['X-Rainver-Space-Id'] = options.spaceId ?? _spaceId
  const response = await fetch(accepted.event_stream_url, { headers })
  if (!response.ok || !response.body) {
    throw new ApiRequestError(`Run event stream failed (${response.status})`, response.status)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = frame.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim()
      const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim()
      if (!data) continue
      const payload = JSON.parse(data) as {
        delta?: string
        error?: string
        message?: string
        payload?: {
          event?: {
            event_type?: string
            status?: string
            summary?: string | null
            error_code?: string | null
            error_message?: string | null
            metadata_json?: {
              session_id?: string
              assistant_message_id?: string | null
            }
          }
        }
      }
      if (event === 'server.error') {
        throw new ApiRequestError(payload.message ?? payload.error ?? 'Run event stream failed', 502)
      }
      if (event === 'chat.text_delta') {
        if (typeof payload.delta === 'string' && payload.delta) {
          options.onTextDelta?.(payload.delta)
        }
        continue
      }
      if (event !== 'run.event_appended') continue
      const runEvent = payload.payload?.event
      if (!runEvent?.event_type || !runEvent.status) continue
      options.onLifecycle?.({
        event_type: runEvent.event_type,
        status: runEvent.status,
        summary: runEvent.summary,
      })
      if (runEvent.event_type === 'chat_completed') {
        await reader.cancel()
        if (runEvent.status !== 'succeeded') {
          return {
            schema_version: 'chat_turn_completion.v1',
            session_id: accepted.session_id,
            run_id: accepted.run_id,
            ok: false,
            error: runEvent.error_message ?? 'The assistant could not complete this turn.',
            error_code: runEvent.error_code ?? 'run_failed',
            assistant_message: null,
          }
        }
        const messages = await get<Message[]>(
          `/sessions/${encodeURIComponent(accepted.session_id)}/messages`,
          { spaceId: options.spaceId },
        )
        const assistant = messages.find(message =>
          message.role === 'assistant' &&
          (
            message.id === runEvent.metadata_json?.assistant_message_id ||
            message.metadata_json?.run_id === accepted.run_id
          ))
        if (!assistant) {
          throw new ApiRequestError('Chat completion message is unavailable', 502)
        }
        const artifactRefs = Array.isArray(assistant.metadata_json?.artifact_refs)
          ? assistant.metadata_json.artifact_refs.filter((value): value is string => typeof value === 'string')
          : []
        const actionPreviews = Array.isArray(assistant.metadata_json?.action_previews)
          ? assistant.metadata_json.action_previews as ChatTurnOut['action_previews']
          : undefined
        return {
          schema_version: 'chat_turn_completion.v1',
          session_id: accepted.session_id,
          run_id: accepted.run_id,
          ok: true,
          reply: assistant.content,
          assistant_message: {
            schema_version: 'assistant_message.v1',
            id: assistant.id,
            session_id: accepted.session_id,
            run_id: accepted.run_id,
            content: assistant.content,
            artifact_refs: artifactRefs,
            tool_call_refs: actionPreviews?.flatMap(preview =>
              preview.tool_call_id ? [preview.tool_call_id] : []) ?? [],
            created_at: assistant.created_at,
          },
          ...(actionPreviews ? { action_previews: actionPreviews } : {}),
        }
      }
    }
    if (done) break
  }
  throw new ApiRequestError('Run event stream ended without chat completion', 502)
}

// ── Content access and targeted publication ───────────────────────────────
export const contentAccessApi = {
  get: (resourceType: string, resourceId: string) =>
    get<ContentAccessPolicy>(`/content-access/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`),
  update: (resourceType: string, resourceId: string, body: ContentAccessUpdate) =>
    put<ContentAccessPolicy>(`/content-access/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, body),
  accessLogs: (resourceType: string, resourceId: string, limit = 50, offset = 0) =>
    get<ContentAccessLogList>(`/content-access/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/access-logs?limit=${limit}&offset=${offset}`),
  discloseDemotion: (resourceType: string, resourceId: string, targetVisibility: Exclude<ContentVisibility, 'space_shared'>) =>
    post<ContentDemotionDisclosure>(`/content-access/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/demotion-disclosures`, {
      target_visibility: targetVisibility,
    }),
}

export const focusAreasApi = {
  list: (includeArchived = false) =>
    get<FocusArea[]>(`/focus-areas${includeArchived ? '?include_archived=true' : ''}`),
  get: (id: string) =>
    get<FocusArea>(`/focus-areas/${encodeURIComponent(id)}`),
  create: (body: { name: string; description?: string | null }) =>
    post<FocusArea>('/focus-areas', body),
  update: (id: string, body: { name?: string; description?: string | null }) =>
    patch<FocusArea>(`/focus-areas/${encodeURIComponent(id)}`, body),
  contents: (id: string) =>
    get<FocusAreaContents>(`/focus-areas/${encodeURIComponent(id)}/contents`),
  setForObject: (objectId: string, focusAreaId: string | null) =>
    put<void>(`/space-objects/${encodeURIComponent(objectId)}/focus-area`, { focus_area_id: focusAreaId }),
  setForProject: (projectId: string, focusAreaId: string | null) =>
    put<void>(`/projects/${encodeURIComponent(projectId)}/focus-area`, { focus_area_id: focusAreaId }),
}

export const publicationsApi = {
  list: (view: 'received' | 'published' = 'received') =>
    get<ContentPublicationList>(`/publications?view=${view}`),
  get: (publicationId: string) =>
    get<ContentPublication>(`/publications/${encodeURIComponent(publicationId)}`),
  create: (body: CreatePublicationRequest) =>
    post<ContentPublication>('/publications', body),
  import: (publicationId: string) =>
    post<PublicationImport>(`/publications/${encodeURIComponent(publicationId)}/import`, {}),
  revoke: (publicationId: string) =>
    post<ContentPublication>(`/publications/${encodeURIComponent(publicationId)}/revoke`, {}),
}

// ── Memory ────────────────────────────────────────────────────────────────
export const memoryApi = {
  list: (params: {
    scope?: string
    namespace?: string
    type?: string
    status?: string
    project_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.scope !== undefined) q.scope = params.scope
    if (params.namespace !== undefined) q.namespace = params.namespace
    if (params.type !== undefined) q.type = params.type
    if (params.status !== undefined) q.status = params.status
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Memory>>('/memory?' + new URLSearchParams(q))
  },
  get: (id: string) => get<Memory>(`/memory/${id}`),
  create: (data: Partial<Memory>) =>
    post<Proposal>('/memory', data),
  update: (id: string, data: Partial<Memory>) =>
    patch<Proposal>(`/memory/${id}`, data),
  delete: (id: string) =>
    del<Proposal>(`/memory/${id}`),
  search: (data: { query: string; scope?: string; namespace?: string; type?: string; limit?: number }) =>
    // Memory search is identity-scoped server-side; do not send space_id/user_id.
    post<Memory[]>('/memory/search', data),
  retrievalSearch: (data: RetrievalSearchRequest) =>
    post<RetrievalSearchResponse>('/memory/retrieval/search', data),
  retrievalBrief: (data: RetrievalBriefRequest) =>
    post<RetrievalBriefResponse>('/memory/retrieval/brief', data),
  feedback: (data: RetrievalFeedbackRequest) =>
    post<RetrievalFeedbackResponse>('/memory/retrieval/feedback', data),
  maintenanceScan: (data: MemoryMaintenanceScanRequestInput = {}) =>
    post<MemoryMaintenanceReport>('/memory/maintenance/scan', data),
  createMaintenanceJob: (data: MemoryMaintenanceScanRequestInput = {}) =>
    post<MemoryMaintenanceJob>('/memory/maintenance/jobs', data),
  getMaintenanceJob: (jobId: string) =>
    get<MemoryMaintenanceJob>(`/memory/maintenance/jobs/${jobId}`),
  runMaintenanceJob: (jobId: string) =>
    post<MemoryMaintenanceJobRunResponse>(`/memory/maintenance/jobs/${jobId}/run`, {}),
}

// ── Knowledge ─────────────────────────────────────────────────────────────
export const knowledgeApi = {
  list: (params: {
    knowledge_kind?: string
    status?: string
    visibility?: string
    q?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.knowledge_kind !== undefined) q.knowledge_kind = params.knowledge_kind
    if (params.status !== undefined) q.status = params.status
    if (params.visibility !== undefined) q.visibility = params.visibility
    if (params.q !== undefined) q.q = params.q
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<KnowledgeItemSummary>>('/knowledge/items?' + new URLSearchParams(q))
  },
  get: (id: string) => get<KnowledgeItem>(`/knowledge/items/${id}`),
  relations: (id: string) => get<KnowledgeRelation[]>(`/knowledge/items/${id}/relations`),
  backlinks: (id: string) => get<EntityLink[]>(`/knowledge/items/${id}/backlinks`),
  proposeCreate: (body: KnowledgeCreateProposalBody) =>
    post<Proposal>('/knowledge/items/proposals', body),
  proposeUpdate: (id: string, body: KnowledgeUpdateProposalBody) =>
    patch<Proposal>(`/knowledge/items/${id}/proposals`, body),
  proposeArchive: (id: string) =>
    del<Proposal>(`/knowledge/items/${id}`),
  proposeRelation: (body: KnowledgeRelationProposalBody) =>
    post<Proposal>('/knowledge/object-relations/proposals', {
      from_object_id: body.from_object_id,
      to_object_id: body.to_object_id,
      link_type: body.link_type,
      status: body.status,
      confidence: body.confidence,
      evidence_summary: body.evidence_summary,
      rationale: body.rationale,
      metadata: { endpoint_type: 'knowledge_item', requested_link_type: body.link_type },
    }),
  proposeRelationArchive: (id: string) =>
    del<Proposal>(`/knowledge/object-relations/${id}`),
  summary: () => get<KnowledgeSummary>('/knowledge/summary'),
  search: (data: RetrievalSearchRequest) =>
    post<RetrievalSearchResponse>('/knowledge/search', data),
  brief: (data: RetrievalBriefRequest) =>
    post<RetrievalBriefResponse>('/knowledge/retrieval/brief', data),
  diagnosticsReport: (data: RetrievalDiagnosticsReportRequest) =>
    post<RetrievalDiagnosticsReportResponse>('/knowledge/retrieval/eval/diagnostics/report', data),
  calibrationDecision: (data: RetrievalCalibrationDecisionRequest) =>
    post<RetrievalCalibrationDecisionResponse>('/knowledge/retrieval/eval/calibration-decisions', data),
  maintenanceScan: (data: RetrievalMaintenanceScanRequestInput = {}) =>
    post<RetrievalMaintenanceScanResponse>('/knowledge/retrieval/maintenance/scan', data),
  claimCandidatePacket: (data: ClaimCandidatePacketCreateRequestInput) =>
    post<ClaimCandidatePacketCreateResponse>('/knowledge/claims/candidate-packets', data),
  contradictionScan: (data: ClaimContradictionScanRequestInput = {}) =>
    post<ClaimContradictionScanResponse>('/knowledge/claims/contradiction-scan', data),
  relationDiscoveryScan: (data: RelationDiscoveryScanRequestInput = {}) =>
    post<RelationDiscoveryScanResponse>('/knowledge/relations/discovery-scan', data),
  explain: (data: RetrievalExplainRequest) =>
    post<RetrievalExplainResponse>('/knowledge/retrieval/explain', data),
  feedback: (data: RetrievalFeedbackRequest) =>
    post<RetrievalFeedbackResponse>('/knowledge/retrieval/feedback', data),
}

export interface GraphProjectionQuery {
  mode?: Exclude<GraphProjectionViewMode, 'debug'>
  root_id?: string
  depth?: number
  node_kinds?: string[]
  edge_kinds?: string[]
  q?: string
  project_id?: string
  lens_id?: string
  limit?: number
  include_clusters?: boolean
}

export interface GraphViewStateRecord {
  scope_key: string
  state_json: Record<string, unknown>
  updated_at: string | null
}

export const graphApi = {
  projection: (params: GraphProjectionQuery = {}) => {
    const q = new URLSearchParams()
    if (params.mode) q.set('mode', params.mode)
    if (params.root_id) q.set('root_id', params.root_id)
    if (params.depth !== undefined) q.set('depth', String(params.depth))
    if (params.node_kinds?.length) q.set('node_kinds', params.node_kinds.join(','))
    if (params.edge_kinds?.length) q.set('edge_kinds', params.edge_kinds.join(','))
    if (params.q) q.set('q', params.q)
    if (params.project_id) q.set('project_id', params.project_id)
    if (params.lens_id) q.set('lens_id', params.lens_id)
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.include_clusters !== undefined) q.set('include_clusters', String(params.include_clusters))
    return get<GraphProjection>(`/graph/projection${q.size ? '?' + q : ''}`)
  },
  getViewState: (scopeKey: string) =>
    get<GraphViewStateRecord>(`/graph/view-state?scope_key=${encodeURIComponent(scopeKey)}`),
  saveViewState: (scopeKey: string, stateJson: Record<string, unknown>) =>
    put<GraphViewStateRecord>('/graph/view-state', {
      scope_key: scopeKey,
      state_json: stateJson,
    }),
}

export const objectSchemaApi = {
  exportSchema: () =>
    get<ObjectSchemaExportManifest>('/knowledge/object-schema/export'),
  importSchema: (body: ObjectSchemaImportRequestInput) =>
    post<ObjectSchemaImportResponse>('/knowledge/object-schema/imports/proposals', body),
  suggestionScan: (body: ObjectSchemaSuggestionScanRequestInput = {}) =>
    post<ObjectSchemaSuggestionScanResponse>('/knowledge/object-schema/suggestions/scan', body),
  listKinds: (params: {
    base_object_type?: RetrievalObjectType
    status?: SpaceObjectProfileStatus
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.base_object_type !== undefined) q.base_object_type = params.base_object_type
    if (params.status !== undefined) q.status = params.status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<SpaceObjectProfilePage>('/knowledge/object-schema/profiles?' + new URLSearchParams(q))
  },
  proposeCreateKind: (body: SpaceObjectProfileCreateProposalRequestInput) =>
    post<Proposal>('/knowledge/object-schema/profiles/proposals', body),
  proposeUpdateKind: (id: string, body: SpaceObjectProfileUpdateProposalRequestInput) =>
    patch<Proposal>(`/knowledge/object-schema/profiles/${encodeURIComponent(id)}/proposals`, body),
  proposeDeprecateKind: (id: string, body: { rationale?: string } = {}) =>
    post<Proposal>(`/knowledge/object-schema/profiles/${encodeURIComponent(id)}/deprecate-proposals`, body),
  proposeArchiveKind: (id: string) =>
    del<Proposal>(`/knowledge/object-schema/profiles/${encodeURIComponent(id)}`),
}

// ── Notes (working knowledge; direct CRUD) ─────────────────────────────────
export const notesCollectionsApi = {
  list: () => get<NoteCollection[]>('/notes/collections'),
  /**
   * The Project's notes folder, created on first use. The Project notes surface
   * is hoisted to it, so it has to exist before the surface can show anything.
   */
  ensureForProject: (projectId: string) =>
    post<NoteCollection>(`/notes/collections/project/${encodeURIComponent(projectId)}`, {}),
  create: (body: NoteCollectionCreateBody) => post<NoteCollection>('/notes/collections', body),
  update: (id: string, body: NoteCollectionUpdateBody) => patch<NoteCollection>(`/notes/collections/${id}`, body),
  delete: (id: string) => del<void>(`/notes/collections/${id}`),
}

/**
 * Discuss and edit the Project's notes. Project-level, not research-level —
 * it moved off `.../research/` when the notes surface did.
 */
export const projectNotebookChatApi = {
  send: (projectId: string, body: { message: string; session_id?: string; source_item_ids?: string[]; execution: { model_provider_id: string; model_name?: string } }) =>
    post<{ session_id: string; run_id: string; ok: boolean; reply?: string; error?: string; notebook_edit?: { note_id: string; version: number; conflict: boolean } | null; daily_limit: number; daily_used: number }>(
      `/projects/${encodeURIComponent(projectId)}/notebook-chat`, body),
}

export const notesTreeApi = {
  reorder: (body: NotesTreeReorderBody) =>
    patch<NotesTreeReorderResult>('/knowledge/notes/tree/reorder', body),
}

export const notesApi = {
  /**
   * `collection_id` selects one folder's contents in the user's manual order;
   * `collection_ids` restricts the result to a *set* of folders — the hoisted
   * subtree a notes surface is focused on — ordered by recency.
   */
  list: (params: { status?: string; project_id?: string; collection_id?: string; collection_ids?: string[]; q?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.collection_id !== undefined) q.collection_id = params.collection_id
    if (params.collection_ids !== undefined) q.collection_ids = params.collection_ids.join(',')
    if (params.q !== undefined) q.q = params.q
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<NoteSummary>>('/knowledge/notes?' + new URLSearchParams(q))
  },
  get: (id: string) => get<Note>(`/knowledge/notes/${id}`),
  create: (body: NoteCreateBody) => post<Note>('/knowledge/notes', body),
  update: (id: string, body: NoteUpdateBody) => patch<Note>(`/knowledge/notes/${id}`, body),
  delete: (id: string) => del<Note>(`/knowledge/notes/${id}`),
  purgeDeleted: () => post<{ deleted: number; retention_days: number }>('/knowledge/notes/deleted/purge'),
  /**
   * Place a note in a further folder, keeping the ones it is already in (U5) —
   * distinct from moving it, which the tree reorder does.
   */
  addPlacement: (id: string, collectionId: string, shareWithProject = false) =>
    post<Note>(`/knowledge/notes/${id}/placements`, {
      collection_id: collectionId,
      ...(shareWithProject ? { share_with_project: true } : {}),
    }),
  /** Which other Projects this note is readable in, and who opened it (U8). */
  shares: (id: string) => get<NoteProjectShare[]>(`/knowledge/notes/${id}/shares`),
  /** Withdraw a share. Takes the note's placements in that Project with it. */
  revokeShare: (id: string, projectId: string) =>
    del<Note>(`/knowledge/notes/${id}/shares/${encodeURIComponent(projectId)}`),
  /** Take a note out of one folder. Refused on its last one. */
  removePlacement: (id: string, collectionId: string) =>
    del<Note>(`/knowledge/notes/${id}/placements/${collectionId}`),
  links: (id: string) => get<EntityLink[]>(`/knowledge/notes/${id}/links`),
  backlinks: (id: string) => get<EntityLink[]>(`/knowledge/notes/${id}/backlinks`),
  createLink: (id: string, body: NoteLinkCreateBody) =>
    post<EntityLink>(`/knowledge/notes/${id}/links`, body),
  deleteLink: (id: string, linkId: string) =>
    del<void>(`/knowledge/notes/${id}/links/${linkId}`),
  revisions: (id: string, limit?: number) =>
    get<NoteRevision[]>(`/knowledge/notes/${id}/revisions` + (limit ? `?limit=${limit}` : '')),
  rollback: (id: string, toVersion: number) =>
    post<Note>(`/knowledge/notes/${id}/rollback`, { to_version: toVersion }),
  /**
   * Jot a note against an object and link it in one call (N7). Two calls would
   * strand a note whenever the link failed, and the round trip for a note id
   * is why the connection was never made by hand.
   */
  jot: (body: NoteJotBody) => post<Note>('/knowledge/notes/jot', body),
  /** Notes citing a non-note object — the reverse of a jot. */
  linkingTo: (objectId: string) => get<EntityLink[]>(`/knowledge/objects/${objectId}/note-links`),
  /**
   * Promote a selected passage into a Knowledge Item (ND). Returns the
   * proposal — the review gate is unchanged — with the note recorded as
   * provenance.
   */
  promote: (id: string, body: NotePromoteBody) =>
    post<Proposal>(`/knowledge/notes/${id}/promote`, body),
  /** Knowledge items this note produced. */
  promoted: (id: string) => get<KnowledgeItemSummary[]>(`/knowledge/notes/${id}/promoted`),
}

// ── Sources (provenance / evidence layer) ──────────────────────────────────
export const knowledgeSourcesApi = {
  list: (params: { source_type?: string; status?: string; q?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.source_type !== undefined) q.source_type = params.source_type
    if (params.status !== undefined) q.status = params.status
    if (params.q !== undefined) q.q = params.q
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<KnowledgeSourceSummary>>('/knowledge/sources?' + new URLSearchParams(q))
  },
}

// ── Sessions ──────────────────────────────────────────────────────────────
export const sessionsApi = {
  list:       (params: Record<string, string> = {}) =>
    get<Page<Session>>('/sessions?' + new URLSearchParams(params)),
  create:     (data: Partial<Session>)              => post<Session>('/sessions', data),
  get:        (id: string)                          => get<Session>(`/sessions/${id}`),
  messages:   (id: string)                          => get<Message[]>(`/sessions/${id}/messages`),
  addMessage: (id: string, data: { content: string }) =>
    post<Message>(`/sessions/${id}/messages`, data),
  reflect:    (id: string)                          => post<ReflectResult>(`/sessions/${id}/reflect`),
}

// ── Prompt Registry ──────────────────────────────────────────────────────
export const promptsApi = {
  listAssets: (params: { prompt_type?: PromptType | '' } = {}) => {
    const q: Record<string, string> = {}
    if (params.prompt_type) q.prompt_type = params.prompt_type
    const query = new URLSearchParams(q).toString()
    return get<PromptAssetSummary[]>(query ? `/prompts/assets?${query}` : '/prompts/assets')
  },
  getAsset: (assetKey: string) =>
    get<PromptAssetDetail>(`/prompts/assets/${encodeURIComponent(assetKey)}`),
  listVersions: (assetKey: string) =>
    get<PromptVersion[]>(`/prompts/assets/${encodeURIComponent(assetKey)}/versions`),
  createVersion: (assetKey: string, body: PromptVersionCreateRequest) =>
    post<PromptVersion>(`/prompts/assets/${encodeURIComponent(assetKey)}/versions`, body),
  renderPreview: (assetKey: string, body: PromptRenderPreviewRequest) =>
    post<PromptRenderPreviewResult>(`/prompts/assets/${encodeURIComponent(assetKey)}/render-preview`, body),
  evaluate: (assetKey: string, body: PromptEvaluationRequest) =>
    post<PromptEvaluationResult>(`/prompts/assets/${encodeURIComponent(assetKey)}/evaluate`, body),
  promote: (assetKey: string, body: PromptPromotionRequestInput) =>
    post<Proposal>(`/prompts/assets/${encodeURIComponent(assetKey)}/promote`, body),
  listDeployments: (assetKey: string, params: { include_history?: boolean } = {}) => {
    const q: Record<string, string> = {}
    if (params.include_history !== undefined) q.include_history = String(params.include_history)
    const query = new URLSearchParams(q).toString()
    return get<PromptDeploymentRef[]>(`/prompts/assets/${encodeURIComponent(assetKey)}/deployments${query ? `?${query}` : ''}`)
  },
  setDeployment: (assetKey: string, label: string, body: PromptPromotionRequestInput) =>
    put<PromptDeploymentRef>(`/prompts/assets/${encodeURIComponent(assetKey)}/deployments/${encodeURIComponent(label)}`, body),
  rollback: (assetKey: string, body: PromptRollbackRequest) =>
    post<PromptDeploymentRef>(`/prompts/assets/${encodeURIComponent(assetKey)}/rollback`, body),
}

// ── Boards (task surfaces) ────────────────────────────────────────────────
export const boardsApi = {
  list:   (params: Record<string, string> = {}) =>
    get<Page<Board>>('/boards?' + new URLSearchParams(params)),
  create: (body: Partial<Board> & { name: string }) =>
    post<Board>('/boards', body),
  get:    (id: string) => get<Board>(`/boards/${id}`),
  update: (id: string, body: Record<string, unknown>) =>
    patch<Board>(`/boards/${id}`, body),
  tasks:  (boardId: string, params: Record<string, string> = {}) =>
    get<Page<Task>>(`/boards/${boardId}/tasks?` + new URLSearchParams(params)),
}

// ── Tasks (product work items) ─────────────────────────────────────────────
export const tasksApi = {
  list:   (params: Record<string, string> = {}) =>
    get<Page<Task>>('/tasks?' + new URLSearchParams(params)),
  create: (data: Record<string, unknown>, options: { spaceId?: string } = {}) =>
    post<Task>('/tasks', data, { spaceId: options.spaceId }),
  get:    (id: string) => get<Task>(`/tasks/${id}`),
  update: (id: string, data: Record<string, unknown>) =>
    patch<Task>(`/tasks/${id}`, data),
  createRun: (taskId: string, body: TaskRunCreateBody = {}) =>
    post<Run | HostDispatchResponse>(`/tasks/${taskId}/runs`, body),
  createRunWithoutTask: (body: TaskRunCreateBody) =>
    post<Run | HostDispatchResponse>('/tasks/runs', body),
  runs:   (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskRunListItem>>(`/tasks/${taskId}/runs?` + new URLSearchParams(params)),
  artifacts: (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskArtifact>>(`/tasks/${taskId}/artifacts?` + new URLSearchParams(params)),
  proposals: (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskProposal>>(`/tasks/${taskId}/proposals?` + new URLSearchParams(params)),
  requestPlan: (taskId: string, body: { agent_id?: string; prompt?: string; instruction?: string; reference_workflow_version_id?: string | null; budget_sources?: PlanBudgetSource[] } = {}) =>
    post<Run>(`/tasks/${encodeURIComponent(taskId)}/plan-requests`, body),
  plan: (taskId: string) => get<PlanDetail | null>(`/tasks/${encodeURIComponent(taskId)}/plan`),
}

// ── Home (Today Command Center summary) ───────────────────────────────────
export const homeApi = {
  summary: (params: Record<string, string> = {}) =>
    get<HomeSummaryOut>('/home/summary?' + new URLSearchParams(params)),
}

// ── Personal perspective (/me aggregation) ─────────────────────────────────
export const meApi = {
  summary: (params: Record<string, string> = {}) =>
    get<MeSummaryOut>('/me/summary?' + new URLSearchParams(params), { includeSpaceContext: false }),
  timeline: (params: Record<string, string> = {}) =>
    get<MeTimelineEntry[]>('/me/timeline?' + new URLSearchParams(params), { includeSpaceContext: false }),
  tasks: (params: Record<string, string> = {}) =>
    get<Page<MeTaskItem>>('/me/tasks?' + new URLSearchParams(params), { includeSpaceContext: false }),
  pending: (params: Record<string, string> = {}) =>
    get<MePendingProposalItem[]>('/me/pending?' + new URLSearchParams(params), { includeSpaceContext: false }),
  retrievalSearch: (data: CrossSpaceRetrievalRequest) =>
    post<CrossSpaceRetrievalResponse>('/me/retrieval/search', data, { includeSpaceContext: false }),
  resolveRetrievalPointers: (pointerIds: string[]) =>
    post<CrossSpaceResolveResponse>('/me/retrieval/pointers/resolve', { pointer_ids: pointerIds }, { includeSpaceContext: false }),
  storeSourceSummary: (pointerIds: string[], summary: string) =>
    post<{ artifact_id: string; source_space_id: string }>('/me/retrieval/summaries', { pointer_ids: pointerIds, summary }, { includeSpaceContext: false }),
  discloseFusedStore: (pointerIds: string[]) =>
    post<CrossSpaceEgressDisclosure>('/me/retrieval/egress/disclose', { pointer_ids: pointerIds }, { includeSpaceContext: false }),
  storeFusedConclusion: (disclosureId: string, pointerIds: string[], conclusion: string) =>
    post<CrossSpaceFusedStoreResponse>('/me/retrieval/fused-conclusions', {
      disclosure_id: disclosureId,
      pointer_ids: pointerIds,
      conclusion,
    }, { includeSpaceContext: false }),
  notifications: () =>
    get<{ items: SpaceMemberNotification[] }>('/me/notifications', { includeSpaceContext: false }),
}

export const spaceEgressApi = {
  updateNotifications: (spaceId: string, enabled: boolean) =>
    patch<SpaceEgressNotificationSetting>(`/spaces/${encodeURIComponent(spaceId)}/egress-notifications`, {
      egress_notifications_enabled: enabled,
    }),
}

// ── Runs (canonical API) ──────────────────────────────────────────────────
export const runsApi = {
  list: (params: {
    status?: string
    mode?: string
    agent_id?: string
    project_folder_id?: string
    project_id?: string
    workflow_version_id?: string
    capability_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.mode !== undefined) q.mode = params.mode
    if (params.agent_id !== undefined) q.agent_id = params.agent_id
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.workflow_version_id !== undefined) q.workflow_version_id = params.workflow_version_id
    if (params.capability_id !== undefined) q.capability_id = params.capability_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Run[]>('/runs?' + new URLSearchParams(q))
  },
  get:    (id: string) => get<Run>(`/runs/${id}`),
  logicalIO: (id: string) => get<RunLogicalIO>(`/runs/${id}/io`),
  status: (id: string) => get<RunStatusOut>(`/runs/${id}/status`),
  stop:   (id: string) => patch<Record<string, unknown>>(`/runs/${id}/stop`),
  executeQueuedRun: (id: string) => post<Run>(`/runs/${id}/execute`),
  resume: (id: string) => post<{ id: string; status: string; resumed_at: string; resume_kind: string }>(`/runs/${id}/resume`, {}),
  abandon: (id: string, body: { reason?: string | null } = {}) => post<{ id: string; status: string; abandoned_at: string }>(`/runs/${id}/abandon`, body),
  activities: (id: string, params: Record<string, string> = {}) =>
    get<Page<ActivityRecord>>(`/runs/${id}/activities?` + new URLSearchParams(params)),
  artifacts: (id: string, params: Record<string, string> = {}) =>
    get<Page<Artifact>>(`/runs/${id}/artifacts?` + new URLSearchParams(params)),
  proposals: (id: string, params: Record<string, string> = {}) =>
    get<Page<Proposal>>(`/runs/${id}/proposals?` + new URLSearchParams(params)),
  authorizationRequests: (id: string) =>
    get<AuthorizationRequest[]>(`/runs/${id}/authorization-requests`),
  attempts: (id: string) => get<{ attempts: RunAttempt[]; supervisor_decisions: RunSupervisorDecision[] }>(`/runs/${id}/attempts`),
  evaluations: (id: string) => get<RunEvaluation[]>(`/runs/${id}/evaluations`),
  verifications: (id: string) => get<RunVerificationResult[]>(`/runs/${id}/verifications`),
  finalizations: (id: string) => get<RunFinalization[]>(`/runs/${id}/finalizations`),
  routeDecision: (id: string) => get<Record<string, unknown>>(`/runs/${id}/route-decision`),
  streamEvents: (
    id: string,
    options: {
      spaceId?: string
      signal?: AbortSignal
      onLifecycle: (event: {
        event_type: string
        status: string
        summary?: string | null
      }) => void
      onTextDelta?: (delta: string) => void
    },
  ) => streamRunLifecycle(id, options),
}

export const authorizationRequestsApi = {
  approve: (id: string) => post<AuthorizationRequest>(`/authorization-requests/${id}/approve`, {}),
  reject: (id: string) => post<AuthorizationRequest>(`/authorization-requests/${id}/reject`, {}),
}

async function streamRunLifecycle(
  runId: string,
  options: {
    spaceId?: string
    signal?: AbortSignal
    onLifecycle: (event: {
      event_type: string
      status: string
      summary?: string | null
    }) => void
    onTextDelta?: (delta: string) => void
  },
): Promise<void> {
  const headers: Record<string, string> = {}
  if (_apiKey) headers.Authorization = `Bearer ${_apiKey}`
  headers['X-Rainver-Space-Id'] = options.spaceId ?? _spaceId
  const response = await fetch(
    `${BASE}/runs/${encodeURIComponent(runId)}/events/stream`,
    { headers, signal: options.signal },
  )
  if (!response.ok || !response.body) {
    throw new ApiRequestError(`Run event stream failed (${response.status})`, response.status)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const eventType = frame.split(/\r?\n/).find(line => line.startsWith('event:'))?.slice(6).trim()
        const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim()
        if (!data) continue
        const payload = JSON.parse(data) as {
          delta?: string
          error?: string
          message?: string
          payload?: {
            event?: {
              event_type?: string
              status?: string
              summary?: string | null
            }
          }
        }
        if (eventType === 'server.error') {
          throw new ApiRequestError(
            payload.message ?? payload.error ?? 'Run event stream failed',
            502,
          )
        }
        if (eventType === 'chat.text_delta') {
          if (payload.delta) options.onTextDelta?.(payload.delta)
          continue
        }
        if (eventType !== 'run.event_appended') continue
        const event = payload.payload?.event
        if (!event?.event_type || !event.status) continue
        options.onLifecycle({
          event_type: event.event_type,
          status: event.status,
          summary: event.summary,
        })
        if (event.event_type === 'run_finalized') {
          await reader.cancel()
          return
        }
      }
      if (done) return
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Plans / structured workflow execution ────────────────────────────────
export const plansApi = {
  list: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<PlanSummary[]>(`/plans?${new URLSearchParams(q)}`)
  },
  get: (id: string) => get<PlanDetail>(`/plans/${encodeURIComponent(id)}`),
  execute: (id: string, body: PlanExecuteBody) =>
    post<PlanExecutionResult>(`/plans/${encodeURIComponent(id)}/execute`, body),
  reconcile: (id: string) => post<PlanExecutionResult>(`/plans/${encodeURIComponent(id)}/reconcile`, {}),
}

// ── Collaboration task groups (advanced audit/control) ────────────────────
export const agentGroupsApi = {
  list: (params: { status?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<AgentRunGroup>>('/agent-groups?' + new URLSearchParams(q))
  },
  create: (body: CreateAgentRunGroupRequest) =>
    post<CreateAgentRunGroupResponse>('/agent-groups', body),
  update: (groupId: string, body: UpdateAgentRunGroupRequest) =>
    patch<UpdateAgentRunGroupResponse>(`/agent-groups/${groupId}`, body),
  timeline: (groupId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<AgentRunGroupTimeline>(`/agent-groups/${groupId}/timeline?` + new URLSearchParams(q))
  },
  trace: (groupId: string) =>
    get<AgentRunGroupTrace>(`/agent-groups/${groupId}/trace`),
  sendMessage: (groupId: string, body: SendAgentRunGroupMessageRequest) =>
    post<SendAgentRunGroupMessageResponse>(`/agent-groups/${groupId}/messages`, body),
  pause: (groupId: string) => post<AgentRunGroup>(`/agent-groups/${groupId}/pause`, {}),
  resume: (groupId: string) => post<AgentRunGroup>(`/agent-groups/${groupId}/resume`, {}),
  cancel: (groupId: string) => post<AgentRunGroup>(`/agent-groups/${groupId}/cancel`, {}),
}

export const roomsApi = {
  list: (params: { project_id?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.project_id) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Room>>('/rooms?' + new URLSearchParams(q))
  },
  pendingApprovals: (params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<RoomPendingApprovalListResponse>(`/rooms/pending-approvals?${q}`)
  },
  create: (body: CreateRoomRequest, idempotencyKey?: string) =>
    post<CreateRoomResponse>('/rooms', body, { idempotencyKey }),
  get: (roomId: string) => get<RoomDetail>(`/rooms/${roomId}`),
  agentCandidates: (roomId: string, params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<RoomAgentCandidatesResponse>(`/rooms/${roomId}/agent-candidates?${q}`)
  },
  addAgent: (roomId: string, body: RoomAgentAddRequest) =>
    post<RoomAgentMutationResponse>(`/rooms/${roomId}/agents`, body),
  addAgentPreset: (roomId: string, body: RoomAgentPresetRequest, idempotencyKey?: string) =>
    post<RoomAgentMutationResponse>(`/rooms/${roomId}/agent-presets`, body, { idempotencyKey }),
  removeAgent: (roomId: string, agentId: string) =>
    del<RoomAgentMutationResponse>(`/rooms/${roomId}/agents/${agentId}`),
  invitations: (roomId: string, params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<RoomInvitationListResponse>(`/rooms/${roomId}/invitations?${q}`)
  },
  inviteUser: (roomId: string, body: RoomInvitationCreateRequest) =>
    post<RoomInvitation>(`/rooms/${roomId}/invitations`, body),
  decideInvitation: (roomId: string, invitationId: string, body: RoomInvitationDecisionRequest) =>
    post<RoomInvitation>(`/rooms/${roomId}/invitations/${invitationId}/decision`, body),
  removeUser: (roomId: string, userId: string) =>
    del<RoomAgentMutationResponse>(`/rooms/${roomId}/members/${userId}`),
  transferOwner: (roomId: string, body: RoomOwnerTransferRequest) =>
    post<RoomAgentMutationResponse>(`/rooms/${roomId}/owner-transfer`, body),
  claimOwner: (roomId: string) =>
    post<RoomAgentMutationResponse>(`/rooms/${roomId}/owner-claim`, {}),
  conversations: (roomId: string, params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<Page<RoomConversation>>(`/rooms/${roomId}/conversations?${q}`)
  },
  createConversation: (roomId: string, body: { title?: string | null }) =>
    post<RoomConversation>(`/rooms/${roomId}/conversations`, body),
  summary: (roomId: string, sessionId: string) =>
    get<RoomConversationSummaryResponse>(`/rooms/${roomId}/conversations/${sessionId}/summary`),
  messages: (
    roomId: string,
    sessionId: string,
    params: { limit?: number; offset?: number } = {},
  ) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return (
    get<{
      items: RoomMessage[]
      conversation?: RoomConversation
      task_group_ids: string[]
      limit: number
      offset: number
    }>(`/rooms/${roomId}/conversations/${sessionId}/messages?${q}`)
    )
  },
  sendMessage: (roomId: string, sessionId: string, body: SendRoomMessageRequest) =>
    post<{
      message: RoomMessage
      conversation: RoomConversation
      task_group_ids: string[]
      run_ids: string[]
    }>(`/rooms/${roomId}/conversations/${sessionId}/messages`, body),
  continueAfterProposal: (
    roomId: string,
    sessionId: string,
    body: ContinueRoomAfterProposalRequest,
  ) => post<{
    message: RoomMessage
    conversation: RoomConversation
    task_group_ids: string[]
    run_ids: string[]
  }>(`/rooms/${roomId}/conversations/${sessionId}/proposal-continuations`, body),
}

// ── Personal Memory Grants ─────────────────────────────────────────────────
export const personalMemoryGrantsApi = {
  previewPersonalMemoryGrant: (input: PersonalMemoryGrantPreviewRequest) =>
    post<PersonalMemoryGrantPreviewResponse>('/personal-memory-grants/preview', input),
  createPersonalMemoryGrant: (input: PersonalMemoryGrantCreateRequest) =>
    post<PersonalMemoryGrantResponse>('/personal-memory-grants', input),
  listPersonalMemoryGrants: (filters: { status?: string; target_space_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (filters.status !== undefined) q.status = filters.status
    if (filters.target_space_id !== undefined) q.target_space_id = filters.target_space_id
    return get<PersonalMemoryGrantResponse[]>('/personal-memory-grants?' + new URLSearchParams(q))
  },
  revokePersonalMemoryGrant: (grantId: string) =>
    post<PersonalMemoryGrantResponse>(`/personal-memory-grants/${grantId}/revoke`),
  getPersonalMemoryGrantAudit: (grantId: string) =>
    get<PersonalMemoryGrantAuditResponse>(`/personal-memory-grants/${grantId}/audit`),
}

// ── Artifacts ─────────────────────────────────────────────────────────────
export const artifactsApi = {
  list: (params: {
    artifact_type?: string
    project_id?: string
    project_folder_id?: string
    run_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.artifact_type !== undefined) q.artifact_type = params.artifact_type
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    if (params.run_id !== undefined) q.run_id = params.run_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Artifact>>('/artifacts?' + new URLSearchParams(q))
  },
  get: (id: string, params: { project_folder_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    const suffix = new URLSearchParams(q).toString()
    return get<Artifact>(`/artifacts/${id}${suffix ? `?${suffix}` : ''}`)
  },
  export: (id: string, params: { project_folder_id?: string } = {}) => downloadArtifactExport(id, params),
}

async function downloadArtifactExport(
  artifactId: string,
  params: { project_folder_id?: string } = {},
): Promise<void> {
  const headers: Record<string, string> = {}
  if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
  headers['X-Rainver-Space-Id'] = _spaceId
  const sep = '/artifacts/' + artifactId + '/export'
  const query = new URLSearchParams()
  if (params.project_folder_id !== undefined) query.set('project_folder_id', params.project_folder_id)
  const artifactParams = query.toString()
  const url = BASE + sep + (artifactParams ? `?${artifactParams}` : '')
  const r = await fetch(url, { method: 'GET', headers })
  if (r.status === 401) window.dispatchEvent(new CustomEvent('auth:required'))
  if (r.status === 404) throw new Error('Artifact not found or not exportable')
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try {
      const err = await r.json() as ApiError
      msg = formatApiErrorMessage(err, msg)
    } catch {
      const text = await r.text().catch(() => '')
      if (text) msg = text
    }
    throw new Error(msg)
  }
  const cd = r.headers.get('Content-Disposition')
  let filename = 'artifact'
  if (cd) {
    const m = /filename="([^"]+)"/.exec(cd) ?? /filename=([^;]+)/.exec(cd)
    if (m) filename = m[1].trim()
  }
  const blob = await r.blob()
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(href)
}

// ── Proposals (canonical list) ────────────────────────────────────────────
export const proposalsApi = {
  list: (params: {
    status?: string
    type?: string
    proposal_type?: string
    urgency?: string
    expired?: boolean
    project_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.type !== undefined) q.type = params.type
    if (params.proposal_type !== undefined) q.type = params.proposal_type
    if (params.urgency !== undefined) q.urgency = params.urgency
    if (params.expired !== undefined) q.expired = String(params.expired)
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Proposal>>('/proposals?' + new URLSearchParams(q))
  },
  get: (id: string) => get<Proposal>(`/proposals/${id}`),
  accept: (id: string, options: { confirmIncompletePatch?: boolean } = {}) => {
    const suffix = options.confirmIncompletePatch ? '?confirm_incomplete_patch=true' : ''
    return post<ProposalAcceptOut>(`/proposals/${id}/accept${suffix}`)
  },
  reject: (id: string) => post<Proposal>(`/proposals/${id}/reject`),
  approveEgressGrantingUserProposal: (id: string, input: EgressApprovalRequest = {}) =>
    post<ProposalApprovalResponse>(`/proposals/${id}/approvals/egress-granting-user`, input),
}

// ── Evolution ─────────────────────────────────────────────────────────────
export const evolutionApi = {
  summary: () => get<EvolutionSummaryOut>('/evolution/summary'),
  targets: (params: { status?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    const query = new URLSearchParams(q).toString()
    return get<EvolutionTarget[]>(query ? `/evolution/targets?${query}` : '/evolution/targets')
  },
  createTarget: (body: EvolutionTargetCreateBody) =>
    post<EvolutionTarget>('/evolution/targets', body),
  target: (id: string) => get<EvolutionTarget>(`/evolution/targets/${id}`),
  updateTarget: (id: string, body: EvolutionTargetUpdateBody) =>
    patch<EvolutionTarget>(`/evolution/targets/${id}`, body),
  signals: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionSignal[]>('/evolution/signals?' + new URLSearchParams(q))
  },
  targetSignals: (targetId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionSignal[]>(`/evolution/targets/${targetId}/signals?` + new URLSearchParams(q))
  },
  updateSignal: (signalId: string, body: { triage_status: 'new' | 'acknowledged' | 'dismissed' | 'actioned'; triage_note?: string | null }) =>
    patch<EvolutionSignal>(`/evolution/signals/${encodeURIComponent(signalId)}`, body),
  dismissSignal: (signalId: string, body: { triage_note?: string | null } = {}) =>
    post<EvolutionSignal>(`/evolution/signals/${encodeURIComponent(signalId)}/dismiss`, body),
  createSignal: (targetId: string, body: EvolutionSignalCreateBody) =>
    post<EvolutionSignal>(`/evolution/targets/${targetId}/signals`, body),
  runs: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionRunListItem[]>('/evolution/runs?' + new URLSearchParams(q))
  },
  runTarget: (targetId: string, body: {
    agent_id: string
    mode?: 'dry_run'
    runtime_profile_id?: string | null
    project_folder_id?: string | null
    project_id?: string | null
  }) =>
    post<EvolutionRunResult>(`/evolution/targets/${targetId}/run`, body),
  strategies: (params: { status?: string; target_type?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.target_type !== undefined) q.target_type = params.target_type
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionStrategy[]>('/evolution/strategies?' + new URLSearchParams(q))
  },
  selectorDecisions: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionSelectorDecision[]>('/evolution/selector-decisions?' + new URLSearchParams(q))
  },
  experiences: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionExperience[]>('/evolution/experiences?' + new URLSearchParams(q))
  },
  proposals: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionProposal[]>('/evolution/proposals?' + new URLSearchParams(q))
  },
  validation: () => get<EvolutionValidationResult[]>('/evolution/validation'),
  assets: (params: { asset_type?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.asset_type !== undefined) q.asset_type = params.asset_type
    const query = new URLSearchParams(q).toString()
    return get<EvolvableAsset[]>(query ? `/evolution/assets?${query}` : '/evolution/assets')
  },
  createAsset: (body: {
    asset_type: string
    asset_key: string
    display_name: string
    description?: string | null
    owner_scope_type?: string
    owner_scope_id?: string | null
    default_eval_suite_ref?: Record<string, unknown> | null
    metadata_json?: Record<string, unknown>
  }) => post<EvolvableAsset>('/evolution/assets', body),
  asset: (assetId: string) =>
    get<EvolvableAsset>(`/evolution/assets/${encodeURIComponent(assetId)}`),
  assetVersions: (assetId: string) =>
    get<EvolvableAssetVersion[]>(`/evolution/assets/${encodeURIComponent(assetId)}/versions`),
  createAssetVersion: (assetId: string, body: {
    scope_type?: string
    scope_id?: string | null
    parent_version_id?: string | null
    source?: string
    content_ref?: string | null
    content_hash?: string | null
    content_json?: Record<string, unknown>
  }) => post<EvolvableAssetVersion>(`/evolution/assets/${encodeURIComponent(assetId)}/versions`, body),
  transitionAssetVersion: (assetId: string, versionId: string, body: { status: string }) =>
    post<EvolvableAssetVersion>(
      `/evolution/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/transition`,
      body,
    ),
  assetPins: (assetId: string) =>
    get<EvolvableAssetPin[]>(`/evolution/assets/${encodeURIComponent(assetId)}/pins`),
  setAssetPin: (assetId: string, scopeType: string, scopeId: string, body: { version_id: string; reason?: string | null }) =>
    put<EvolvableAssetPin>(
      `/evolution/assets/${encodeURIComponent(assetId)}/pins/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`,
      body,
    ),
  deleteAssetPin: (assetId: string, scopeType: string, scopeId: string) =>
    del<null>(`/evolution/assets/${encodeURIComponent(assetId)}/pins/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`),
  resolveAsset: (assetId: string, body: {
    project_id?: string | null
    agent_id?: string | null
    explicit_version_id?: string | null
    allow_user_pin?: boolean
  } = {}) =>
    post<ResolvedEvolvableAssetVersion>(`/evolution/assets/${encodeURIComponent(assetId)}/resolve`, body),
  assetEvaluationRuns: (assetId: string) =>
    get<EvolvableAssetEvaluationRun[]>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-runs`),
  evaluationCases: (assetId: string) =>
    get<EvolvableAssetEvaluationCase[]>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-cases`),
  createEvaluationCase: (assetId: string, body: {
    name: string
    description?: string | null
    input_json?: Record<string, unknown>
    expectation_json?: Record<string, unknown>
    verification_recipe_json: Record<string, unknown>
    baseline_version_id: string
    baseline_output_json: unknown
  }) => post<EvolvableAssetEvaluationCase>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-cases`, body),
  createEvaluationCaseFromRun: (assetId: string, body: {
    name: string
    description?: string | null
    input_json?: Record<string, unknown>
    expectation_json?: Record<string, unknown>
    verification_recipe_json: Record<string, unknown>
    baseline_version_id: string
    source_run_id: string
  }) => post<EvolvableAssetEvaluationCase>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-cases/from-run`, body),
  executeEvaluation: (assetId: string, versionId: string, caseId: string, body: { candidate_run_id: string }) =>
    post<{ evaluation_run: EvolvableAssetEvaluationRun; job_id: string; connector_mode: string }>(
      `/evolution/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/evaluation-cases/${encodeURIComponent(caseId)}/execute`,
      body,
    ),
  updateAssetVersion: (assetId: string, versionId: string, body: { content_json?: Record<string, unknown>; content_ref?: string | null; content_hash?: string | null }) =>
    patch<EvolvableAssetVersion>(`/evolution/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}`, body),
  recordAssetEvaluation: (assetId: string, versionId: string, body: {
    eval_suite_ref: Record<string, unknown>
    evaluator_version: string
    status?: string
    baseline_version_id?: string | null
    run_id?: string | null
    model_provider_ref?: Record<string, unknown> | null
    metrics?: Record<string, unknown>
    blockers?: unknown[]
    output_artifact_id?: string | null
    report_artifact_id?: string | null
  }) => post<EvolvableAssetEvaluationRun>(
    `/evolution/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/evaluate`,
    body,
  ),
  createAssetPromotionProposal: (assetId: string, versionId: string, body: {
    target_scope_type: 'project' | 'space' | 'system'
    target_scope_id?: string | null
    pin_after_approval?: boolean
    deprecate_previous?: boolean
    evaluation_run_ids?: string[]
    reason?: string | null
  }) => post<{ proposal_id: string; status: string; proposal_type: string }>(
    `/evolution/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/promote-proposal`,
    body,
  ),
  bundles: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionBundle[]>(`/evolution/bundles?${new URLSearchParams(q)}`)
  },
  createBundle: (body: { title: string; description?: string | null; proposal_ids: string[] }) =>
    post<EvolutionBundle>('/evolution/bundles', body),
  bundle: (id: string) => get<EvolutionBundle>(`/evolution/bundles/${encodeURIComponent(id)}`),
  decideBundle: (id: string, decisions: Array<{ proposal_id: string; decision: 'approve' | 'reject'; note?: string | null }>) =>
    post<EvolutionBundle>(`/evolution/bundles/${encodeURIComponent(id)}/decide`, { decisions }),
  rollbackBundle: (id: string) => post<EvolutionBundle>(`/evolution/bundles/${encodeURIComponent(id)}/rollback`, {}),
  previewWorkflowFromRun: (body: { run_id: string; asset_key?: string | null; display_name?: string | null; description?: string | null; input_schema_json?: Record<string, unknown> | null }) =>
    post<Record<string, unknown>>('/evolution/workflows/from-run/preview', body),
  saveWorkflowFromRun: (body: { run_id: string; asset_key?: string | null; display_name?: string | null; description?: string | null; input_schema_json?: Record<string, unknown> | null }) =>
    post<Record<string, unknown>>('/evolution/workflows/from-run/save', body),
}

// ── Agents ────────────────────────────────────────────────────────────────
export const agentsApi = {
  list: (params: Record<string, string> = {}) =>
    get<AgentOut[]>('/agents?' + new URLSearchParams(params)),
  get: (agentId: string) => get<AgentOut>(`/agents/${agentId}`),
  create: (data: AgentCreateBody) => post<AgentOut>('/agents', data),
  update: (agentId: string, data: AgentUpdateBody) => patch<AgentOut>(`/agents/${agentId}`, data),
  // Config edit: appends a new immutable AgentVersion and repoints current_version_id.
  updateConfig: (agentId: string, data: AgentConfigUpdateBody) =>
    post<AgentOut>(`/agents/${agentId}/config`, data),
  listRuntimeProfiles: (agentId: string) =>
    get<AgentRuntimeProfileOut[]>(`/agents/${agentId}/runtime-profiles`),
  createRuntimeProfile: (agentId: string, data: AgentRuntimeProfileCreateBody) =>
    post<AgentRuntimeProfileOut>(`/agents/${agentId}/runtime-profiles`, data),
  updateRuntimeProfile: (agentId: string, profileId: string, data: AgentRuntimeProfileUpdateBody) =>
    patch<AgentRuntimeProfileOut>(`/agents/${agentId}/runtime-profiles/${profileId}`, data),
  currentVersion: (agentId: string) => get<AgentVersionOut>(`/agents/${agentId}/current-version`),
  conversationBackends: (
    agentId: string,
    options: { spaceId?: string; sessionId?: string } = {},
  ) =>
    get<ConversationBackendCatalog>(
      `/agents/${agentId}/conversation-backends${options.sessionId
        ? `?session_id=${encodeURIComponent(options.sessionId)}`
        : ''}`,
      { spaceId: options.spaceId },
    ),
  // Assistant preferences (soft UI/context layer — never edits prompt or hard policy).
  getAssistantSettings: () => get<SpaceAssistantSettingsOut>('/agents/default-assistant/settings'),
  updateAssistantSettings: (data: SpaceAssistantSettingsUpdate) =>
    patch<SpaceAssistantSettingsOut>('/agents/default-assistant/settings', data),
  listVersions: (agentId: string) => get<AgentVersionOut[]>(`/agents/${agentId}/versions`),
  getVersion: (agentId: string, versionId: string) =>
    get<AgentVersionOut>(`/agents/${agentId}/versions/${versionId}`),
  restoreVersion: (agentId: string, versionId: string) =>
    post<AgentOut>(`/agents/${agentId}/versions/${versionId}/restore`),
  listProposals: (agentId: string, status = 'pending') =>
    get<Proposal[]>(`/agents/${agentId}/proposals?status=${encodeURIComponent(status)}`),
  createRun: (agentId: string, body: RunCreateBody = {}) =>
    post<Run>(`/agents/${agentId}/runs`, body),
  // Queue the Chat Run, then subscribe to its canonical lifecycle stream.
  chat: (
    agentId: string,
    body: {
      message: string
      session_id?: string
      project_id?: string
      backend?: Pick<
        ConversationBackendBinding,
        'runtime_profile_id' | 'credential_profile_id'
      >
    },
    options: {
      spaceId?: string
      onAccepted?: (accepted: ChatTurnAccepted) => void
      onLifecycle?: (event: { event_type: string; status: string; summary?: string | null }) => void
      onTextDelta?: (delta: string) => void
    } = {},
  ) => postChatTurn(`/agents/${agentId}/chat`, body, options),
  listRuns:       (limit = 50)        => get<Run[]>(`/agents/runs?limit=${limit}`),
  getRun:         (runId: string)     => get<Run>(`/runs/${runId}`),
  listRunsForAgent:  (agentId: string)   => get<Run[]>(`/agents/${agentId}/runs`),
}

// ── Agent Templates (reusable factories) ────────────────────────────────────
export const agentTemplatesApi = {
  list: (params: Record<string, string> = {}) =>
    get<AgentTemplateOut[]>('/agent-templates?' + new URLSearchParams(params)),
  get: (templateId: string) => get<AgentTemplateOut>(`/agent-templates/${templateId}`),
  listVersions: (templateId: string) =>
    get<AgentTemplateVersionOut[]>(`/agent-templates/${templateId}/versions`),
  getVersion: (templateId: string, versionId: string) =>
    get<AgentTemplateVersionOut>(`/agent-templates/${templateId}/versions/${versionId}`),
  createAgent: (templateId: string, body: CreateAgentFromTemplateBody = {}) =>
    post<AgentOut>(`/agent-templates/${templateId}/agents`, body),
}

// ── Automations ───────────────────────────────────────────────────────────
// Space-scoped paths (/spaces/{space_id}/automations); identity via session/bearer.
export const automationsApi = {
  list:   (params: { project_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.project_id !== undefined) q.project_id = params.project_id
    const suffix = new URLSearchParams(q).toString()
    return get<AutomationOut[]>(`/spaces/${_spaceId}/automations${suffix ? `?${suffix}` : ''}`)
  },
  get:    (id: string)                        => get<AutomationOut>(`/spaces/${_spaceId}/automations/${id}`),
  create: (data: AutomationCreateBody)        => post<AutomationOut>(`/spaces/${_spaceId}/automations`, data),
  update: (id: string, data: AutomationUpdateBody) => patch<AutomationOut>(`/spaces/${_spaceId}/automations/${id}`, data),
  fire:   (id: string, body: { prompt?: string; instruction?: string } = {}) =>
    post<AutomationFireResult>(`/spaces/${_spaceId}/automations/${id}/fire`, body),
  workflowExecutions: (id: string) =>
    get<WorkflowExecutionSummary[]>(`/spaces/${_spaceId}/automations/${encodeURIComponent(id)}/workflow-executions`),
}

// ── Project Folders ──────────────────────────────────────────────────────
export const projectFoldersApi = {
  list:    (projectId: string, params: Record<string, string> = {}) =>
    get<Page<ProjectFolder>>(`/projects/${projectId}/folders?` + new URLSearchParams(params)),
  listExecutionReady: async (projectId: string, params: Record<string, string> = {}) => {
    const page = await get<Page<ProjectFolder>>(`/projects/${projectId}/folders?` + new URLSearchParams(params))
    const ready = (await Promise.all(page.items.map(async folder => {
      const locations = await get<WorkspaceLocation[]>(`/projects/${projectId}/folders/${folder.id}/locations`)
      return locations.some(location => location.execution_ready) ? folder : null
    }))).filter((folder): folder is ProjectFolder => folder !== null)
    return { ...page, items: ready, total: ready.length }
  },
  create:  (projectId: string, data: ProjectFolderCreateBody) =>
    post<ProjectFolder>(`/projects/${projectId}/folders`, data),
  scan:    (projectId: string) =>
    post<{ items: ProjectFolderScanCandidate[] }>(`/projects/${projectId}/folders/scan`),
  get:     (projectId: string, folderId: string) =>
    get<ProjectFolder>(`/projects/${projectId}/folders/${folderId}`),
  locations: (projectId: string, folderId: string) =>
    get<WorkspaceLocation[]>(`/projects/${projectId}/folders/${folderId}/locations`),
  update:  (projectId: string, folderId: string, data: ProjectFolderUpdateBody) =>
    patch<ProjectFolder>(`/projects/${projectId}/folders/${folderId}`, data),
  archive: (projectId: string, folderId: string) =>
    del<null>(`/projects/${projectId}/folders/${folderId}`),
  unregister: (projectId: string, folderId: string) =>
    post<null>(`/projects/${projectId}/folders/${folderId}/unregister`),
  tree:    (projectId: string, folderId: string) =>
    get<FileNode>(`/projects/${projectId}/folders/${folderId}/tree`),
  file:    (projectId: string, folderId: string, path: string) =>
    get<FileContent>(`/projects/${projectId}/folders/${folderId}/file?path=${encodeURIComponent(path)}`),
  gitStatus: (projectId: string, folderId: string) =>
    get<GitStatus>(`/projects/${projectId}/folders/${folderId}/git/status`),
  gitDiff: (projectId: string, folderId: string, path?: string) =>
    get<{ diff: string; path: string | null; truncated: boolean; redacted: boolean }>(
      `/projects/${projectId}/folders/${folderId}/git/diff` + (path ? `?path=${encodeURIComponent(path)}` : ''),
    ),
}

// ADR 0016: multi-host control center — pairing, dispatch, and the
// work-stream read side (task threads). See .agent/modules/hosts.md.
export const hostsApi = {
  list: () => get<{ items: Host[] }>('/hosts'),
  pairingCode: (name: string) => post<HostPairingCode>('/hosts/pairing-codes', { name }),
  revoke: (hostId: string) => post<null>(`/hosts/${hostId}/revoke`),
  listThreads: (projectId: string) =>
    get<{ items: HostTaskThread[] }>(`/hosts/threads?project_id=${encodeURIComponent(projectId)}`),
  /** Cross-project landing read (C10) — Project is a filter the caller applies via `listThreads`, not a precondition. */
  listRecentThreads: (limit = 20) =>
    get<{ items: HostRecentThread[] }>(`/hosts/threads/recent?limit=${limit}`),
  listRuntimeAdapters: () => get<{ items: HostRuntimeAdapterOption[] }>('/hosts/runtime-adapters'),
  listProviderBindings: (hostId: string) =>
    get<{ items: HostRuntimeProviderBinding[] }>(`/hosts/${encodeURIComponent(hostId)}/runtime-provider-bindings`),
  setProviderBinding: (hostId: string, adapterType: string, modelProviderId: string, model: string | null = null) =>
    put<HostRuntimeProviderBinding>(
      `/hosts/${encodeURIComponent(hostId)}/runtime-provider-bindings/${encodeURIComponent(adapterType)}`,
      { model_provider_id: modelProviderId, model },
    ),
  /** Clearing returns that host×adapter to the machine's own login state. */
  clearProviderBinding: (hostId: string, adapterType: string) =>
    del<null>(`/hosts/${encodeURIComponent(hostId)}/runtime-provider-bindings/${encodeURIComponent(adapterType)}`),
  /** Empty string clears the override and returns this host to the derived address. */
  setProviderProxyUrl: (hostId: string, baseUrl: string) =>
    put<{ host_id: string; provider_proxy_base_url: string | null }>(
      `/hosts/${encodeURIComponent(hostId)}/provider-proxy-url`,
      { base_url: baseUrl },
    ),
  listMessages: (threadId: string) =>
    get<{ items: HostThreadMessage[] }>(`/hosts/threads/${encodeURIComponent(threadId)}/messages`),
  listEvents: (threadId: string, after: number) =>
    get<{ items: HostThreadEvent[] }>(`/hosts/threads/${encodeURIComponent(threadId)}/events?after=${after}`),
  withdrawMessage: (threadId: string, messageId: string) =>
    post<HostThreadMessage>(`/hosts/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/withdraw`),
  resumeQueue: (threadId: string) =>
    post<{ thread_id: string; run_id: string | null; status: 'dispatched' | 'idle' }>(`/hosts/threads/${encodeURIComponent(threadId)}/resume-queue`),
  cancel: (threadId: string) =>
    post<{ run_id: string; status: string }>(`/hosts/threads/${encodeURIComponent(threadId)}/cancel`),
}

export const projectFolderExecutionConfigsApi = {
  get:    (projectId: string, folderId: string) =>
    get<ProjectFolderExecutionConfig>(`/projects/${projectId}/folders/${folderId}/execution-config`),
  create: (projectId: string, folderId: string, data: ProjectFolderExecutionConfigUpdate) =>
    post<ProjectFolderExecutionConfig>(`/projects/${projectId}/folders/${folderId}/execution-config`, data),
  update: (projectId: string, folderId: string, data: ProjectFolderExecutionConfigUpdate) =>
    patch<ProjectFolderExecutionConfig>(`/projects/${projectId}/folders/${folderId}/execution-config`, data),
}

export const capabilitiesFrameworkApi = {
  listCapabilityDefinitions: () =>
    get<CapabilityDefinition[]>('/capability-definitions'),
  getCapabilityDefinition: (id: string) =>
    get<CapabilityDefinition>(`/capability-definitions/${encodeURIComponent(id)}`),
  listCapabilityPacks: () =>
    get<CapabilityPackDescriptor[]>('/capability-packs'),
  getCapabilityPack: (id: string) =>
    get<CapabilityPackDescriptor>(`/capability-packs/${encodeURIComponent(id)}`),
  previewSkillImport: (data: { url: string }) =>
    post<SkillImportPreviewResponse>('/skill-sources/import-preview', data),
  importSkill: (data: { url: string }) =>
    post<SkillPackage>('/skill-sources/import', data),
  listSkillPackages: () =>
    get<Page<SkillPackage>>('/skill-packages'),
  getSkillPackage: (id: string) =>
    get<SkillPackage>(`/skill-packages/${encodeURIComponent(id)}`),
  listSkillLibraryIndex: () =>
    get<SkillLibraryIndexResponse>('/capabilities/skills/index'),
  getSkillLocalOverlay: (skillPackageId: string, params: { scope_type?: string; scope_id?: string | null } = {}) => {
    const q: Record<string, string> = {}
    if (params.scope_type !== undefined) q.scope_type = params.scope_type
    if (params.scope_id !== undefined && params.scope_id !== null) q.scope_id = params.scope_id
    const suffix = new URLSearchParams(q).toString()
    return get<SkillLocalOverlay>(`/capabilities/skills/${encodeURIComponent(skillPackageId)}/local-overlay${suffix ? `?${suffix}` : ''}`)
  },
  updateSkillLocalOverlay: (skillPackageId: string, data: SkillLocalOverlayUpsertRequest) =>
    put<SkillLocalOverlay>(`/capabilities/skills/${encodeURIComponent(skillPackageId)}/local-overlay`, data),
  createSkillReviewProposal: (skillPackageId: string) =>
    post<SkillImportApprovalProposalResponse>(`/skill-packages/${encodeURIComponent(skillPackageId)}/review-proposal`),
  convertSkillToCapability: (skillPackageId: string, data: { capability_id?: string; namespace?: string; enable_for_project_id?: string | null; create_runtime_bindings?: boolean } = {}) =>
    post<SkillConvertToCapabilityResponse>(`/skill-packages/${encodeURIComponent(skillPackageId)}/convert-to-capability`, data),
  createCapabilityEnableProposal: (capabilityId: string, data: { capability_version_id?: string; project_id?: string; agent_id?: string; user_id?: string; config_json?: Record<string, unknown> } = {}) =>
    post<Proposal>(`/capability-definitions/${encodeURIComponent(capabilityId)}/enable-proposal`, data),
  createCapabilityDisableProposal: (capabilityId: string, data: { capability_version_id?: string; project_id?: string; agent_id?: string; user_id?: string } = {}) =>
    post<Proposal>(`/capability-definitions/${encodeURIComponent(capabilityId)}/disable-proposal`, data),
}

export const contextOpsApi = {
  summary: (params: { window_days?: number; limit?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.window_days !== undefined) q.window_days = String(params.window_days)
    if (params.limit !== undefined) q.limit = String(params.limit)
    const suffix = new URLSearchParams(q).toString()
    return get<ContextOpsSummary>(`/context-ops/summary${suffix ? `?${suffix}` : ''}`)
  },
  drilldown: (section: ContextOpsDrilldownSection, params: { limit?: number } = {}) => {
    const q: Record<string, string> = { section }
    if (params.limit !== undefined) q.limit = String(params.limit)
    return get<ContextOpsDrilldown>(`/context-ops/drilldown?${new URLSearchParams(q).toString()}`)
  },
  reviewCycleRun: (data: ContextReviewCycleRequestInput = {}) =>
    post<ContextReviewCycleResponse>('/context-ops/review-cycle/run', data),
  contextObservationScan: (data: ContextOpsContextObservationScanRequestInput = {}) =>
    post<ContextOpsContextObservationScanResponse>('/context-ops/context-observations/scan', data),
}

export const askSpaceApi = {
  think: (data: AskSpaceRequest) => post<AskSpaceResponse>('/ask-space/think', data),
}

export interface UsageApiQuery {
  view?: UsageView
  from?: string
  to?: string
  group_by?: string
  granularity?: 'day' | 'week' | 'month'
  accuracy?: UsageAccuracy
  execution_channel?: UsageExecutionChannel
  provider_id?: string
  model?: string
  task?: string
  subject_type?: string
  subject_id?: string
  session_id?: string
  external_session_id?: string
  session_path?: string
  dimension_key?: string
  dimension_value?: string
  include_imported?: boolean
  limit?: number
  offset?: number
  projection_window_days?: number
}

function usageQuery(params: UsageApiQuery = {}): string {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    q.set(key, String(value))
  }
  const queryString = q.toString()
  return queryString ? `?${queryString}` : ''
}

export const usageApi = {
  summary: (params: UsageApiQuery = {}) =>
    get<UsageSummaryResponse>(`/usage/summary${usageQuery(params)}`),
  timeseries: (params: UsageApiQuery = {}) =>
    get<UsageTimeseriesResponse>(`/usage/timeseries${usageQuery(params)}`),
  events: (params: UsageApiQuery = {}) =>
    get<UsageEventsResponse>(`/usage/events${usageQuery(params)}`),
  dimensions: (params: UsageApiQuery = {}) =>
    get<UsageDimensionsResponse>(`/usage/dimensions${usageQuery(params)}`),
  subjects: (params: UsageApiQuery = {}) =>
    get<UsageSubjectsResponse>(`/usage/subjects${usageQuery(params)}`),
  sessions: (params: UsageApiQuery = {}) =>
    get<UsageSessionsResponse>(`/usage/sessions${usageQuery(params)}`),
  budgetPreview: (params: UsageApiQuery = {}) =>
    get<UsageBudgetPreviewResponse>(`/usage/budget-preview${usageQuery(params)}`),
  operationalTotals: (params: Pick<UsageApiQuery, 'from' | 'to'> = {}) =>
    get<UsageOperationalTotalsResponse>(`/usage/operations/totals${usageQuery(params)}`),
  previewCliHistory: (body: UsageCliHistoryPreviewRequest) =>
    post<UsageCliHistoryImportResponse>('/usage/imports/cli-history/preview', body),
  commitCliHistory: (body: UsageCliHistoryCommitRequest) =>
    post<UsageCliHistoryImportResponse>('/usage/imports/cli-history/commit', body),
}

export const runtimeToolsApi = {
  catalog: () => get<RuntimeToolDefinition[]>('/runtime-tools/catalog'),
  list: () => get<RuntimeToolStatus[]>('/runtime-tools'),
  get: (runtime: string) => get<RuntimeToolStatus>(`/runtime-tools/${encodeURIComponent(runtime)}`),
  latest: (runtime: string) => get<RuntimeToolLatest>(`/runtime-tools/${encodeURIComponent(runtime)}/latest`),
  spacePolicies: () => get<SpaceRuntimeToolPolicyOut[]>('/runtime-tools/space-policy'),
  spacePolicy: (runtime: string) =>
    get<SpaceRuntimeToolPolicyOut>(`/runtime-tools/space-policy/${encodeURIComponent(runtime)}`),
  updateSpacePolicy: (runtime: string, data: { enabled?: boolean; default_version?: string | null; allowed_versions?: string[] }) =>
    put<SpaceRuntimeToolPolicyOut>(`/runtime-tools/space-policy/${encodeURIComponent(runtime)}`, data),
  install: (runtime: string, data: { version?: string | null; activate?: boolean; force?: boolean } = {}) =>
    post<RuntimeToolInstallResult>(`/runtime-tools/${encodeURIComponent(runtime)}/install`, data),
  activate: (runtime: string, version: string) =>
    post<RuntimeToolStatus>(`/runtime-tools/${encodeURIComponent(runtime)}/activate`, { version }),
}

// ── Credentials / Login ───────────────────────────────────────────────────
export const credentialsApi = {
  profiles: (runtime?: string, spaceId?: string | null) =>
    get<CliCredentialProfileOut[]>(
      '/credentials/cli/profiles' + (runtime ? `?runtime=${encodeURIComponent(runtime)}` : ''),
      spaceId ? { spaceId } : undefined,
    ),
  available: (runtime?: string, spaceId?: string | null) =>
    get<CliCredentialAvailableProfileOut[]>(
      '/credentials/cli/available' + (runtime ? `?runtime=${encodeURIComponent(runtime)}` : ''),
      spaceId ? { spaceId } : undefined,
    ),
  createProfile: (body: {
    runtime: string
    name: string
    readonly?: boolean
    notes?: string
    network_profile_id?: string | null
    is_default?: boolean
  }, spaceId?: string | null) => post<CliCredentialProfileOut>(
    '/credentials/cli/profiles',
    body,
    spaceId ? { spaceId } : undefined,
  ),
  grantProfile: (profileId: string, body: {
    space_id: string
    enabled?: boolean
    is_default?: boolean
    network_profile_id?: string | null
  }, spaceId?: string | null) => put(
    `/credentials/cli/profiles/${encodeURIComponent(profileId)}/grants`,
    body,
    spaceId ? { spaceId } : undefined,
  ),
  updateProfile: (profileId: string, body: { network_profile_id?: string | null }, spaceId?: string | null) =>
    patch<CliCredentialProfileOut>(
      `/credentials/cli/profiles/${encodeURIComponent(profileId)}`,
      body,
      spaceId ? { spaceId } : undefined,
    ),
  methods: (spaceId?: string | null) =>
    get<CredentialLoginMethod[]>('/credentials/cli/methods', spaceId ? { spaceId } : undefined),
  status: (spaceId?: string | null) =>
    get<CredentialStatus[]>('/credentials/cli/status', spaceId ? { spaceId } : undefined),
  usage: (spaceId?: string | null) =>
    get<CliUsageEntry[]>('/credentials/cli/usage', spaceId ? { spaceId } : undefined),
  usageAutoRefresh: (spaceId?: string | null) =>
    get<CliUsageAutoRefreshSettings>('/credentials/cli/usage/auto-refresh', spaceId ? { spaceId } : undefined),
  setUsageAutoRefresh: (enabled: boolean, spaceId?: string | null) =>
    put<CliUsageAutoRefreshSettings>(
      '/credentials/cli/usage/auto-refresh',
      { enabled },
      spaceId ? { spaceId } : undefined,
    ),
  refreshUsage: (runtime: string, profileId?: string | null, spaceId?: string | null) =>
    post<CliUsageEntry>(
      `/credentials/cli/usage/refresh?runtime=${encodeURIComponent(runtime)}${profileId ? `&profile_id=${encodeURIComponent(profileId)}` : ''}`,
      {},
      spaceId ? { spaceId } : undefined,
    ),

  sendLoginInput: (runtime: string, input: string, profileId?: string | null, spaceId?: string | null) =>
    post<{ status: string }>(
      `/credentials/cli/login/input?runtime=${encodeURIComponent(runtime)}`,
      profileId ? { input, profile_id: profileId } : { input },
      spaceId ? { spaceId } : undefined,
    ),

  async *loginStream(runtime: string, profileId?: string | null, spaceId?: string | null): AsyncGenerator<LoginEvent> {
    const profileParam = profileId ? `&profile_id=${encodeURIComponent(profileId)}` : ''
    const url = `${BASE}/credentials/cli/login/stream?runtime=${encodeURIComponent(runtime)}${profileParam}`
    const headers: Record<string, string> = {}
    if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
    headers['X-Rainver-Space-Id'] = spaceId ?? _spaceId

    const r = await fetch(url, { headers })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
    if (!r.body) throw new Error('No response body')

    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const block of parts) {
        const line = block.trim()
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)) as LoginEvent } catch { /* skip malformed */ }
        }
      }
    }
  },
}

export const networkProfilesApi = {
  list: () => get<NetworkProfileOut[]>('/network-profiles'),
  get: (id: string) => get<NetworkProfileOut>(`/network-profiles/${encodeURIComponent(id)}`),
  create: (body: NetworkProfileCreateBody) => post<NetworkProfileOut>('/network-profiles', body),
  patch: (id: string, body: NetworkProfileUpdateBody) =>
    patch<NetworkProfileOut>(`/network-profiles/${encodeURIComponent(id)}`, body),
  delete: (id: string) => del<void>(`/network-profiles/${encodeURIComponent(id)}`),
}

// ── Jobs ──────────────────────────────────────────────────────────────────
export const jobsApi = {
  list:   (params: Record<string, string> = {}) =>
    get<Page<Job>>('/jobs?' + new URLSearchParams(params)),
  get:    (id: string)    => get<Job>(`/jobs/${id}`),
  events: (id: string)    => get<JobEvent[]>(`/jobs/${id}/events`),
  cancel: (id: string)    => post<Job>(`/jobs/${id}/cancel`),
}

// ── Capture ───────────────────────────────────────────────────────────────
/**
 * The single capture entry. Destination is chosen by the client and sent
 * explicitly; the server never re-infers one, because the signal the default
 * reads (a paste event) exists only in the browser.
 */
export const captureApi = {
  create: (body: CaptureRequest) => post<CaptureResponse>('/captures', body),
  /** What a relocation would carry — the anchored block plus the orphans after it. */
  relocationPreview: (activityId: string) =>
    get<RelocationPreview>(`/captures/${activityId}/relocation`),
  relocate: (activityId: string, body: RelocationRequest) =>
    post<RelocationResponse>(`/captures/${activityId}/relocation`, body),
}

// ── Activity ──────────────────────────────────────────────────────────────
export const activityApi = {
  list: (params: {
    status?: string
    source_type?: string
    project_folder_id?: string
    project_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.source_type !== undefined) q.source_type = params.source_type
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<ActivityInboxRecord[]>('/activity?' + new URLSearchParams(q))
  },
  create: (
    data: { source_type: ActivitySourceType; content: string; title?: string; source_url?: string; project_folder_id?: string; metadata_json?: Record<string, unknown> },
    options: { spaceId?: string } = {},
  ) =>
    post<ActivityInboxRecord>('/activity', data, { spaceId: options.spaceId }),
  // File / voice capture (store-only). Sends multipart; lands in the Activity Inbox.
  upload: (
    file: File,
    options: { kind?: 'file' | 'voice'; title?: string; note?: string; project_folder_id?: string; spaceId?: string } = {},
  ) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', options.kind ?? 'file')
    if (options.title) fd.append('title', options.title)
    if (options.note) fd.append('note', options.note)
    if (options.project_folder_id) fd.append('project_folder_id', options.project_folder_id)
    return post<ActivityInboxRecord>('/activity/upload', fd, { spaceId: options.spaceId })
  },
  get:    (id: string) => get<ActivityInboxRecord>(`/activity/${id}`),
  review: (id: string) => patch<ActivityInboxRecord>(`/activity/${id}/review`),
  archive:(id: string) => patch<ActivityInboxRecord>(`/activity/${id}/archive`),
  consolidate: (id: string) =>
    post<Proposal[]>(`/activity/${id}/consolidate`),
  summarize: (body: SummaryRunRequest) =>
    post<SummaryRunOut>('/activity/summary-runs', body),
}

// ── Source / Evidence ────────────────────────────────────────────────────
export const informationDigestsApi = {
  personal: (spaceId: string, date?: string) => {
    const q = date ? `?date=${encodeURIComponent(date)}` : ''
    return get<InformationDigest>(`/spaces/${encodeURIComponent(spaceId)}/information-digests/personal${q}`)
  },
  project: (spaceId: string, projectId: string, date?: string) => {
    const q = date ? `?date=${encodeURIComponent(date)}` : ''
    return get<InformationDigest>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/information-digests${q}`)
  },
  profile: (spaceId: string) =>
    get<InterestProfileSnapshot>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile`),
  acceptCandidate: (spaceId: string, phraseKey: string, body: { label?: string; domain_key?: string }) =>
    post(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/candidates/${encodeURIComponent(phraseKey)}/accept`, body),
  dismissCandidate: (spaceId: string, phraseKey: string) =>
    post(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/candidates/${encodeURIComponent(phraseKey)}/dismiss`, {}),
  updateProfileSettings: (spaceId: string, body: Partial<InterestProfileSnapshot['settings']>) =>
    patch<{ settings: InterestProfileSnapshot['settings'] }>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/settings`, body),
  createTopic: (spaceId: string, body: { label: string; domain_key: string; weight: number }) =>
    post<InterestProfileSnapshot['topics'][number]>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/topics`, body),
  updateTopic: (spaceId: string, topicKey: string, body: { label: string; domain_key: string; weight: number }) =>
    patch<InterestProfileSnapshot['topics'][number]>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/topics/${encodeURIComponent(topicKey)}`, body),
  archiveTopic: (spaceId: string, topicKey: string) =>
    post<{ archived: boolean }>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/topics/${encodeURIComponent(topicKey)}/archive`, {}),
  applyStarterPack: (spaceId: string, key: string) =>
    post<{ topics: number; source_recommendations: number }>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/starter-pack`, { key }),
  backfillProfileHistory: (spaceId: string, limit = 500) =>
    post<{ queued: number; limit: number }>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile/history-backfill`, { limit }),
  serendipityFeedback: (spaceId: string, itemId: string, feedback: 'interesting' | 'neutral' | 'never') =>
    post<SerendipityFeedbackResult>(`/spaces/${encodeURIComponent(spaceId)}/information-digests/items/${encodeURIComponent(itemId)}/serendipity-feedback`, { feedback }),
}

export const sourcesApi = {
  providers: () => get<SourceProvider[]>('/sources/providers'),
  sourceCatalog: () => get<SourceCatalog>('/instance/source-catalog'),
  updateCatalogProvider: (id: string, body: { status?: 'active' | 'disabled' }) =>
    patch<SourceCatalogProvider>(`/instance/source-catalog/providers/${id}`, body),
  updateCatalogConnector: (id: string, body: { status?: 'active' | 'disabled' }) =>
    patch<SourceConnector>(`/instance/source-catalog/connectors/${id}`, body),
  updateCatalogMapping: (id: string, body: { status?: 'active' | 'disabled'; priority?: number }) =>
    patch<SourceCatalogMapping>(`/instance/source-catalog/mappings/${id}`, body),
  channels: (params: { status?: string; provider_key?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.provider_key) q.set('provider_key', params.provider_key)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return get<SourceChannel[]>(`/sources/channels${suffix}`)
  },
  recommendations: () => get<SourceRecommendation[]>('/sources/recommendations'),
  decideRecommendation: (channelId: string, decision: 'subscribed' | 'dismissed' | 'muted') =>
    post<{ source_channel_id: string; status: string; updated_at: string }>(`/sources/recommendations/${encodeURIComponent(channelId)}/decision`, { decision }),
  customSourceCredentials: () => get<CustomSourceCredentialDTO[]>('/sources/custom-source-credentials'),
  getChannel: (id: string) => get<SourceChannel>(`/sources/channels/${id}`),
  createChannel: (body: {
    provider_key: string
    source_name?: string
    name?: string
    query: Record<string, unknown>
    endpoint_url?: string
    fetch_frequency?: 'manual' | 'hourly' | 'daily' | 'weekly'
    schedule_rule?: Record<string, unknown>
    capture_policy?: SourceCapturePolicy
  }) => post<SourceChannel>('/sources/channels', body),
  previewQuery: (body: { provider_key: string; query: Record<string, unknown>; source_channel_id?: string }) =>
    post<SourceQueryPreview>('/sources/query-preview', body),
  updateChannel: (id: string, body: Partial<Pick<SourceChannel, 'source_name' | 'name' | 'status' | 'fetch_frequency' | 'schedule_rule'>> & { query?: Record<string, unknown>; endpoint_url?: string | null }) =>
    patch<SourceChannel>(`/sources/channels/${id}`, body),
  scanChannel: (id: string) => post<ExtractionJob>(`/sources/channels/${id}/scan`),
  previewChannelBackfill: (channelId: string, body: { strategy: Partial<SourceBackfillStrategy>; quota_policy?: Partial<SourceBackfillQuotaPolicy> }) =>
    post<SourceBackfillPreview>(`/sources/channels/${channelId}/backfill/plans/preview`, body),
  createChannelBackfillPlan: (channelId: string, body: { idempotency_key: string; strategy: Partial<SourceBackfillStrategy>; quota_policy?: Partial<SourceBackfillQuotaPolicy>; project_source_binding_id?: string; project_operation_id?: string }) =>
    post<SourceBackfillPlan>(`/sources/channels/${channelId}/backfill/plans`, body),
  channelBackfillPlans: (channelId: string) => get<SourceBackfillPlan[]>(`/sources/channels/${channelId}/backfill/plans`),
  createCustomSourceDraft: (body: CustomSourceCreateDraftRequest) =>
    post<SourceChannel>('/sources/custom-sources/drafts', body),
  customSourceSummary: (connectionId: string) =>
    get<CustomSourceHandlerSummary>(`/sources/connections/${connectionId}/custom-source`),
  customSourceVersions: (connectionId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<CustomSourceHandlerVersion>>(`/sources/connections/${connectionId}/handler-versions?` + new URLSearchParams(q))
  },
  customSourceRuns: (connectionId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<CustomSourceHandlerRun>>(`/sources/connections/${connectionId}/handler-runs?` + new URLSearchParams(q))
  },
  generateCustomSourceHandler: (connectionId: string, body: { capture_policy?: SourceCapturePolicy; retention_policy?: string } = {}) =>
    post<CustomSourceHandlerVersion>(`/sources/custom-sources/${connectionId}/generate-handler`, body),
  testCustomSourceHandler: (connectionId: string, body: { handler_version_id: string; fixture_html?: string }) =>
    post<CustomSourceTestOutcome>(`/sources/custom-sources/${connectionId}/test-handler`, body),
  activateCustomSourceHandler: (connectionId: string, body: { handler_version_id: string; next_check_at?: string | null; schedule_rule?: SourceScheduleRule | null }) =>
    post<CustomSourceActivationResult>(`/sources/custom-sources/${connectionId}/activate`, body),
  customSourceSpacePolicy: () =>
    get<CustomSourceSpacePolicy>('/sources/custom-source-settings/space'),
  customSourceInstanceRunnerSettings: () =>
    get<CustomSourceInstanceRunnerSettings>('/sources/custom-source-settings/instance'),
  updateCustomSourceInstanceRunnerSettings: (body: CustomSourceInstanceRunnerSettingsUpdate) =>
    put<CustomSourceInstanceRunnerSettings>('/sources/custom-source-settings/instance', body),
  updateCustomSourceSpacePolicy: (body: CustomSourceSpacePolicyUpdate) =>
    put<CustomSourceSpacePolicy>('/sources/custom-source-settings/space', body),
  planSourceRecipe: (body: SourceRecipePlanRequest) =>
    post<SourceRecipePlanResponse>('/sources/source-recipes/plan', body),
  createSourceRecipe: (body: SourceRecipeCreateRequest) =>
    post<SourceRecipeCreateResponse>('/sources/source-recipes', body),
  dryRunSourceRecipe: (connectionId: string, body: { recipe_version_id: string; fixture_content?: string }) =>
    post<SourceRecipeDryRunResponse>(`/sources/source-recipes/${connectionId}/dry-run`, body),
  activateSourceRecipe: (connectionId: string, body: { recipe_version_id: string; next_check_at?: string | null; schedule_rule?: SourceScheduleRule | null }) =>
    post<SourceRecipeActivationResult>(`/sources/source-recipes/${connectionId}/activate`, body),
  bridgePipelineSourceRecipe: (connectionId: string, body: SourceRecipePipelineBridgeRequest = {}) =>
    post<SourceRecipePipelineBridgeResponse>(`/sources/custom-sources/${connectionId}/bridge-pipeline`, body),
  sourceRecipeVersions: (connectionId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourceRecipeVersion>>(`/sources/connections/${connectionId}/recipe-versions?` + new URLSearchParams(q))
  },

  items: (params: {
    library_status?: string
    read_status?: string
    connection_id?: string
    content_state?: string
    q?: string
    library_type?: string
    created_after?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.library_status !== undefined) q.library_status = params.library_status
    if (params.read_status !== undefined) q.read_status = params.read_status
    if (params.connection_id !== undefined) q.connection_id = params.connection_id
    if (params.content_state !== undefined) q.content_state = params.content_state
    if (params.q !== undefined) q.q = params.q
    if (params.library_type !== undefined) q.library_type = params.library_type
    if (params.created_after !== undefined) q.created_after = params.created_after
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourceItem>>('/sources/items?' + new URLSearchParams(q))
  },
  getItem: (id: string) =>
    get<SourceItem>(`/sources/items/${id}`),
  updateItem: (id: string, body: { connection_id?: string | null }) =>
    patch<SourceItem>(`/sources/items/${id}`, body),
  createManualUrl: (body: { url: string; title?: string; connection_id?: string | null; queue_content?: boolean }) =>
    post<SourceItem>('/sources/items/manual-url', body),
  itemAction: (id: string, action: string) =>
    post<SourceItem>(`/sources/items/${id}/actions`, { action }),
  jobs: (params: {
    status?: string
    source_item_id?: string
    connection_id?: string
    job_type?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.source_item_id !== undefined) q.source_item_id = params.source_item_id
    if (params.connection_id !== undefined) q.connection_id = params.connection_id
    if (params.job_type !== undefined) q.job_type = params.job_type
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ExtractionJob>>('/sources/jobs?' + new URLSearchParams(q))
  },
  runJob: (id: string) =>
    post<ExtractionJob>(`/sources/jobs/${id}/run`),

  evidence: (params: { status?: string; evidence_type?: string; source_item_id?: string; project_id?: string; connection_id?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.evidence_type !== undefined) q.evidence_type = params.evidence_type
    if (params.source_item_id !== undefined) q.source_item_id = params.source_item_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.connection_id !== undefined) q.connection_id = params.connection_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ExtractedEvidence>>('/sources/evidence?' + new URLSearchParams(q))
  },
  updateEvidence: (id: string, body: { status?: string; confidence?: number; metadata?: Record<string, unknown> }) =>
    patch<ExtractedEvidence>(`/sources/evidence/${id}`, body),
  createEvidenceLink: (body: {
    evidence_id: string
    target_type: string
    target_id?: string | null
    link_type?: string
    status?: string
    confidence?: number
    reason?: string
  }) => post<EvidenceLink>('/sources/evidence-links', body),
  evidenceLinks: (params: { evidence_id?: string; target_type?: string; target_id?: string; status?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.evidence_id !== undefined) q.evidence_id = params.evidence_id
    if (params.target_type !== undefined) q.target_type = params.target_type
    if (params.target_id !== undefined) q.target_id = params.target_id
    if (params.status !== undefined) q.status = params.status
    return get<Page<EvidenceLink>>('/sources/evidence-links?' + new URLSearchParams(q))
  },

  projectSourceBindings: (params: { project_id: string; source_channel_id?: string }) => {
    const q: Record<string, string> = {}
    if (params.source_channel_id !== undefined) q.source_channel_id = params.source_channel_id
    return get<ProjectSourceBinding[]>(`/projects/${params.project_id}/sources/bindings?` + new URLSearchParams(q))
  },
  createProjectSourceBinding: (body: {
    source_channel_id: string
    project_id: string
    backfill_history?: boolean
    binding_key?: string
    priority?: number
    delivery_scope?: 'project_members' | 'source_subscribers'
    collection_notifications_enabled?: boolean
    standing_comparison_enabled?: boolean
    filters?: Record<string, unknown>
    routing_policy?: Record<string, unknown>
    extraction_policy?: Record<string, unknown>
  }) => post<ProjectSourceBinding>(`/projects/${body.project_id}/sources/bindings`, body),
  updateProjectSourceBinding: (projectId: string, bindingId: string, body: Partial<{
    status: string
    binding_key: string
    priority: number
    delivery_scope: 'project_members' | 'source_subscribers'
    collection_notifications_enabled: boolean
    standing_comparison_enabled: boolean
    filters: Record<string, unknown>
    routing_policy: Record<string, unknown>
    extraction_policy: Record<string, unknown>
  }>) => patch<ProjectSourceBinding>(`/projects/${projectId}/sources/bindings/${bindingId}`, body),
  deleteProjectSourceBinding: (projectId: string, bindingId: string) =>
    del<{ id: string; status: string }>(`/projects/${projectId}/sources/bindings/${bindingId}`),
  backfillProjectSourceBinding: (projectId: string, bindingId: string) =>
    post<ProjectSourceBindingBackfillResult>(`/projects/${projectId}/sources/bindings/${bindingId}/backfill`),
  projectItems: (params: {
    project_id: string
    source_channel_id?: string
    item_type?: string
    source_domain?: string
    matched_date?: string
    created_after?: string
    occurred_after?: string
    q?: string
    limit?: number
    offset?: number
  }) => {
    const q: Record<string, string> = { project_id: params.project_id }
    if (params.source_channel_id !== undefined) q.source_channel_id = params.source_channel_id
    if (params.item_type !== undefined) q.item_type = params.item_type
    if (params.source_domain !== undefined) q.source_domain = params.source_domain
    if (params.matched_date !== undefined) q.matched_date = params.matched_date
    if (params.created_after !== undefined) q.created_after = params.created_after
    if (params.occurred_after !== undefined) q.occurred_after = params.occurred_after
    if (params.q !== undefined) q.q = params.q
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ProjectSourceItem>>('/sources/project-items?' + new URLSearchParams(q))
  },
  projectSourceSummary: (projectId: string) =>
    get<ProjectSourceSummary>(`/sources/project-source-summary?project_id=${encodeURIComponent(projectId)}`),
  projectSourceHealth: (projectId: string) =>
    get<SourceHealth[]>(`/projects/${encodeURIComponent(projectId)}/sources/health`),
  sourceHealth: (params: { channel_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.channel_id !== undefined) q.channel_id = params.channel_id
    const suffix = new URLSearchParams(q).toString()
    return get<SourceHealth[]>(`/sources/source-health${suffix ? `?${suffix}` : ''}`)
  },
  summarize: (body: SummaryRunRequest) =>
    post<SummaryRunOut>('/sources/post-processing/run-once', body),
  postProcessingRules: (channelId: string) =>
    get<SourcePostProcessingRule[]>(`/sources/channels/${channelId}/post-processing/rules`),
  createPostProcessingRule: (channelId: string, body: SourcePostProcessingRuleCreate) =>
    post<SourcePostProcessingRule>(`/sources/channels/${channelId}/post-processing/rules`, body),
  updatePostProcessingRule: (channelId: string, ruleId: string, body: SourcePostProcessingRuleUpdate) =>
    patch<SourcePostProcessingRule>(`/sources/channels/${channelId}/post-processing/rules/${ruleId}`, body),
  runPostProcessingRule: (channelId: string, ruleId: string) =>
    post<SourcePostProcessingRun>(`/sources/channels/${channelId}/post-processing/rules/${ruleId}/run`),
  drainPostProcessingRule: (channelId: string, ruleId: string) =>
    post<SourcePostProcessingDrainResult>(`/sources/channels/${channelId}/post-processing/rules/${ruleId}/drain`),
  postProcessingRuns: (channelId: string, params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingRun>>(`/sources/channels/${channelId}/post-processing/runs?` + new URLSearchParams(q))
  },
  postProcessingBacklog: (channelId: string) =>
    get<SourcePostProcessingBacklog>(`/sources/channels/${channelId}/post-processing/backlog`),
  postProcessingDecisions: (params: {
    channel_id?: string
    project_id?: string
    rule_id?: string
    relevance?: SourcePostProcessingItemRelevance
    review_status?: SourcePostProcessingDecisionReviewStatus
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.channel_id !== undefined) q.channel_id = params.channel_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.rule_id !== undefined) q.rule_id = params.rule_id
    if (params.relevance !== undefined) q.relevance = params.relevance
    if (params.review_status !== undefined) q.review_status = params.review_status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingItemDecision>>('/sources/post-processing/decisions?' + new URLSearchParams(q))
  },
  postProcessingChannelDecisions: (channelId: string, params: {
    rule_id?: string
    relevance?: SourcePostProcessingItemRelevance
    review_status?: SourcePostProcessingDecisionReviewStatus
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.rule_id !== undefined) q.rule_id = params.rule_id
    if (params.relevance !== undefined) q.relevance = params.relevance
    if (params.review_status !== undefined) q.review_status = params.review_status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingItemDecision>>(`/sources/channels/${channelId}/post-processing/decisions?` + new URLSearchParams(q))
  },
  postProcessingDecisionAction: (decisionId: string, action: string) =>
    post<SourcePostProcessingDecisionActionResult>(`/sources/post-processing/decisions/${decisionId}/actions`, { action }),
  briefings: (params: {
    channel_id?: string
    project_id?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.channel_id !== undefined) q.channel_id = params.channel_id
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<SourcePostProcessingBriefingDaySummary>>('/sources/briefings?' + new URLSearchParams(q))
  },
  briefing: (channelId: string, date: string) =>
    get<SourcePostProcessingBriefingDetail>(`/sources/briefings/${channelId}/${date}`),
}

// ── Reader ────────────────────────────────────────────────────────────────
export const readerApi = {
  getDocument: (documentType: string, documentId: string) =>
    get<ReaderDocumentPayload>(`/reader/documents/${documentType}/${documentId}`),

  listAnnotations: (documentType: string, documentId: string) =>
    get<ReaderAnnotationsResponse>(`/reader/documents/${documentType}/${documentId}/annotations`),

  createAnnotation: (body: ReaderAnnotationCreate) =>
    post<ReaderAnnotation>('/reader/annotations', body),

  updateAnnotation: (annotationId: string, body: ReaderAnnotationUpdate) =>
    patch<ReaderAnnotation>(`/reader/annotations/${annotationId}`, body),

  deleteAnnotation: (annotationId: string) =>
    del(`/reader/annotations/${annotationId}`),

  listThreads: (annotationId: string) =>
    get<{ items: ReaderCommentThread[] }>(`/reader/annotations/${annotationId}/threads`),

  createComment: (annotationId: string, body: ReaderCommentCreate) =>
    post<{ thread: ReaderCommentThread }>(`/reader/annotations/${annotationId}/comments`, body),

  updateComment: (commentId: string, body: ReaderCommentUpdate) =>
    patch<ReaderComment>(`/reader/comments/${commentId}`, body),

  updateThread: (threadId: string, body: ReaderThreadUpdate) =>
    patch<ReaderCommentThread>(`/reader/comment-threads/${threadId}`, body),

  createEvidence: (annotationId: string, body: ReaderCreateEvidenceRequest) =>
    post<ReaderCreatedEvidence>(`/reader/annotations/${annotationId}/evidence`, body),

  createProposal: (annotationId: string, body: ReaderCreateProposalRequest) =>
    post<ReaderCreatedProposal>(`/reader/annotations/${annotationId}/proposals`, body),

  listByProject: (projectId: string, limit?: number) =>
    get<{ items: ReaderAnnotation[] }>(
      `/reader/annotations?project_id=${encodeURIComponent(projectId)}${limit != null ? `&limit=${limit}` : ''}`,
    ),
}

// ── Projects ──────────────────────────────────────────────────────────────
export const projectsApi = {
  list: (params: { status?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Project>>('/projects?' + new URLSearchParams(q))
  },
  create: (data: ProjectCreate) => post<Project>('/projects', data),
  get: (id: string) => get<Project>(`/projects/${id}`),
  update: (id: string, data: ProjectUpdate) => patch<Project>(`/projects/${id}`, data),
  archive: (id: string) => post<Project>(`/projects/${id}/archive`),
  getOverview: (id: string) => get<ProjectOverview>(`/projects/${id}/overview`),
  transitionMode: (id: string, toMode: string, reason?: string) =>
    post(`/projects/${id}/mode-transitions`, { to_mode: toMode, reason }),
  operations: (id: string) => get<ProjectOperation[]>(`/projects/${id}/operations`),
  getOperation: (id: string, operationId: string) => get<ProjectOperation>(`/projects/${id}/operations/${operationId}`),
  createOperation: (id: string, body: { kind: ProjectOperation['kind']; title: string; intent_text?: string; steps?: Array<{ title: string; detail?: Record<string, unknown> }> }) =>
    post<ProjectOperation>(`/projects/${id}/operations`, body),
  cancelOperation: (id: string, operationId: string) => post<ProjectOperation>(`/projects/${id}/operations/${operationId}/cancel`, {}),
  sourceBindings: (id: string, sourceChannelId?: string) => {
    const q = sourceChannelId ? `?source_channel_id=${encodeURIComponent(sourceChannelId)}` : ''
    return get<ProjectSourceBinding[]>(`/projects/${id}/sources/bindings${q}`)
  },
  sourceExtractionProfiles: (id: string) => get<ProjectExtractionProfile[]>(`/projects/${id}/sources/extraction-profiles`),
  sourceHealth: (id: string) => get<SourceHealth[]>(`/projects/${id}/sources/health`),
  createSourceBinding: (id: string, body: Omit<Parameters<typeof sourcesApi.createProjectSourceBinding>[0], 'project_id'>) =>
    post<ProjectSourceBinding>(`/projects/${id}/sources/bindings`, body),
  proposeSourceBinding: (id: string, body: Record<string, unknown>) =>
    post<{ proposal: Proposal; auto_applied: boolean }>(`/projects/${id}/sources/propose-bind`, body),
  proposeSourceSetup: (id:string,body:Record<string,unknown>) => post<{operation:ProjectOperation;channel_draft:SourceChannel;source_proposal:Proposal;binding_proposal:Proposal}>(`/projects/${id}/sources/propose-setup`,body),
  updateSourceBinding: (id: string, bindingId: string, body: Record<string, unknown>) =>
    patch<ProjectSourceBinding>(`/projects/${id}/sources/bindings/${bindingId}`, body),
  deleteSourceBinding: (id: string, bindingId: string) =>
    del<{ id: string; status: string }>(`/projects/${id}/sources/bindings/${bindingId}`),
  backfillSourceBinding: (id: string, bindingId: string) =>
    post<ProjectSourceBindingBackfillResult>(`/projects/${id}/sources/bindings/${bindingId}/backfill`, {}),
  proposeBindingBackfill:(id:string,bindingId:string,body:Record<string,unknown>)=>post<{operation:ProjectOperation;plan:SourceBackfillPlan;proposal:Proposal}>(`/projects/${id}/sources/bindings/${bindingId}/propose-backfill`,body),
  corpus: (id: string, params: {
    status?: string
    triage_status?: string
    read_status?: string
    role?: string
    q?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.triage_status !== undefined) q.triage_status = params.triage_status
    if (params.read_status !== undefined) q.read_status = params.read_status
    if (params.role !== undefined) q.role = params.role
    if (params.q !== undefined) q.q = params.q
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ProjectCorpusItem>>(`/projects/${id}/corpus?` + new URLSearchParams(q))
  },
  addCorpusItem: (projectId: string, data: {
    source_item_id: string
    role?: ProjectCorpusItem['role']
    triage_status?: ProjectCorpusItem['triage_status']
    metadata_json?: Record<string, unknown>
  }) => post<ProjectCorpusItem>(`/projects/${projectId}/corpus`, data),
  updateCorpusItem: (projectId: string, corpusItemId: string, data: Partial<{
    role: ProjectCorpusItem['role']
    status: ProjectCorpusItem['status']
    triage_status: ProjectCorpusItem['triage_status']
    read_status: ProjectCorpusItem['read_status']
    relevance: ProjectCorpusItem['relevance']
    confidence: number | null
    reason: string | null
    metadata_json: Record<string, unknown>
  }>) => patch<ProjectCorpusItem>(`/projects/${projectId}/corpus/${corpusItemId}`, data),
  backfillCorpusFromSources: (id: string) =>
    post<ProjectCorpusBackfillResult>(`/projects/${id}/corpus/backfill-source-items`),
  publicSummaryFeedback: (data: RetrievalFeedbackRequest) =>
    post<RetrievalFeedbackResponse>('/projects/public-summaries/feedback', data),
  publicSummaryBrief: (data: RetrievalBriefRequest) =>
    post<RetrievalBriefResponse>('/projects/retrieval/brief', data),
  getActiveBriefVersion: (id: string) => get<ProjectBriefVersion | null>(`/projects/${id}/brief-versions/active`),
  listBriefVersions: (id: string) => get<ProjectBriefVersion[]>(`/projects/${id}/brief-versions`),
  createBriefVersion: (id: string, data: Partial<Pick<ProjectBriefVersion,
    'goal' | 'scope_included' | 'scope_excluded' | 'success_definition' | 'constraints' | 'assumptions' |
    'confirmed_decisions' | 'workspace_identity' | 'workspace_boundary' | 'source_refs'
  >>) => post<ProjectBriefVersion>(`/projects/${id}/brief-versions`, data),
  submitBriefForReview: (id: string, versionId: string) => post<ProjectBriefVersion>(`/projects/${id}/brief-versions/${versionId}/submit-review`),
  publishBrief: (id: string, versionId: string) => post<ProjectBriefVersion>(`/projects/${id}/brief-versions/${versionId}/publish`),
  getActiveInstructionVersion: (id: string) => get<ProjectInstructionVersion | null>(`/projects/${id}/instruction-versions/active`),
  listInstructionVersions: (id: string) => get<ProjectInstructionVersion[]>(`/projects/${id}/instruction-versions`),
  createInstructionVersion: (id: string, data: Pick<ProjectInstructionVersion, 'title' | 'instruction_text'>) => post<ProjectInstructionVersion>(`/projects/${id}/instruction-versions`, data),
  submitInstructionForReview: (id: string, versionId: string) => post<ProjectInstructionVersion>(`/projects/${id}/instruction-versions/${versionId}/submit-review`),
  publishInstruction: (id: string, versionId: string) => post<ProjectInstructionVersion>(`/projects/${id}/instruction-versions/${versionId}/publish`),
}

export const inquiryApi = {
  listThreads: (projectId: string) =>
    get<InquiryThread[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads`),
  getThread: (projectId: string, threadId: string) =>
    get<InquiryThreadDetail>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}`),
  createThread: (projectId: string, data: Record<string, unknown>) =>
    post<InquiryThread>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads`, data),
  /**
   * NE: raise a note passage as a Question. Creates the Thread and the link
   * back to the note, so the Question keeps a route to its reasoning.
   */
  raiseFromNote: (projectId: string, data: { note_object_id: string; statement: string; kind?: 'question' | 'hypothesis' }) =>
    post<InquiryThread>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/from-note`, data),
  recordIteration: (projectId: string, threadId: string, data: Record<string, unknown>) =>
    post<InquiryIteration & { thread: InquiryThread }>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/iterations`, data,
    ),
  listOpenSteps: (projectId: string) =>
    get<InquiryOpenStep[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/open-steps`),
  listSteps: (projectId: string, threadId: string) =>
    get<InquiryThreadStep[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/steps`),
  listIterations: (projectId: string, threadId: string) =>
    get<InquiryIteration[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/iterations`),
  listRevisions: (projectId: string, threadId: string) =>
    get<InquiryThreadRevision[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/revisions`),
  reviseDefinition: (projectId: string, threadId: string, data: Record<string, unknown>) =>
    post<{ thread: InquiryThread; superseded_by_thread_id: string | null }>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/definition-revisions`, data,
    ),
  updateWork: (projectId: string, threadId: string, data: Record<string, unknown>) =>
    patch<InquiryThread & { wip_limit_exceeded: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/work-state`, data,
    ),
  transitionLifecycle: (projectId: string, threadId: string, lifecycleStatus: string, reason?: string) =>
    post<InquiryThread>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/lifecycle-transitions`,
      { lifecycle_status: lifecycleStatus, reason },
    ),
  addRelation: (projectId: string, data: Record<string, unknown>) =>
    post<InquiryThreadRelation>(`/projects/${encodeURIComponent(projectId)}/inquiry/relations`, data),
  removeRelation: (projectId: string, relationId: string) =>
    del<null>(`/projects/${encodeURIComponent(projectId)}/inquiry/relations/${encodeURIComponent(relationId)}`),
  setPrimaryParent: (projectId: string, threadId: string, parentThreadId: string | null) =>
    put<InquiryThread>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/primary-parent`, { parent_thread_id: parentThreadId }),
  linkNote: (projectId: string, threadId: string, noteObjectId: string, linkKind?: string) =>
    post<InquiryThreadNoteLink>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/notes`, { note_object_id: noteObjectId, link_kind: linkKind }),
  unlinkNote: (projectId: string, threadId: string, noteObjectId: string) =>
    del<null>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/notes/${encodeURIComponent(noteObjectId)}`),
  setPersonalFocus: (projectId: string, threadId: string, inFocus: boolean) =>
    put<null>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/personal-focus`, { in_focus: inFocus }),
  getFocus: (projectId: string) =>
    get<{ personal_focus: InquiryThread[]; shared_focus_wip_limit: number }>(`/projects/${encodeURIComponent(projectId)}/inquiry/focus`),
  listCandidates: (projectId: string, status = 'pending') =>
    get<InquiryCandidate[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/candidates?status=${encodeURIComponent(status)}`),
  getCandidate: (projectId: string, candidateId: string) =>
    get<InquiryCandidate>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/candidates/${encodeURIComponent(candidateId)}`,
    ),
  openReviewPacket: (projectId: string, limit = 5) =>
    post<InquiryReviewPacket>(`/projects/${encodeURIComponent(projectId)}/inquiry/review-packets`, { limit }),
  closeReviewPacket: (projectId: string, packetId: string) =>
    post<{ id: string; status: 'closed'; closed_at: string }>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/review-packets/${encodeURIComponent(packetId)}/close`,
      {},
    ),
  decideCandidate: (projectId: string, candidateId: string, data: Record<string, unknown>) =>
    post<InquiryCandidate>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/candidates/${encodeURIComponent(candidateId)}/decision`,
      data,
    ),
  reopenCandidate: (projectId: string, candidateId: string) =>
    post<InquiryCandidate>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/candidates/${encodeURIComponent(candidateId)}/reopen`,
      {},
    ),
  getAdvice: (projectId: string, threadId: string) =>
    get<InquiryThreadAdvice | null>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/advice`,
    ),
  // Adopting applies the recommended Next Focus through the ordinary
  // work-state command server-side, so the invariant has one enforcement point.
  adoptAdvice: (projectId: string, threadId: string) =>
    post<{ thread: InquiryThread & { wip_limit_exceeded?: boolean }; advice: InquiryThreadAdvice | null }>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/advice/adopt`, {},
    ),
  dismissAdvice: (projectId: string, threadId: string) =>
    post<InquiryThreadAdvice>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/advice/dismiss`, {},
    ),
  listSignals: (projectId: string, threadId?: string) => {
    const q = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : ''
    return get<InquiryEvidenceSignal[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/signals${q}`)
  },
  graph: (projectId: string, limit = 200) =>
    get<GraphProjection>(`/projects/${encodeURIComponent(projectId)}/inquiry/graph?limit=${limit}`),
  latestDeltaBrief: (projectId: string) =>
    get<InquiryDeltaBrief | null>(`/projects/${encodeURIComponent(projectId)}/inquiry/delta-briefs/latest`),
  // `coverage_start` is what makes this a delta rather than a re-summary of
  // the whole Project: callers pass the previous Brief's `coverage_end`.
  generateDeltaBrief: (projectId: string, coverageStart?: string | null) =>
    post<InquiryDeltaBrief>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/delta-briefs`,
      coverageStart ? { coverage_start: coverageStart } : {},
    ),
}

export interface InquiryDeltaBrief {
  id: string
  project_id: string
  coverage_start: string | null
  coverage_end: string
  content: InquiryDeltaBriefContent
  created_at: string
}

export const experimentsApi = {
  listDefinitions: (projectId: string) =>
    get<ExperimentDefinition[]>(`/projects/${encodeURIComponent(projectId)}/experiments/definitions`),
  createDefinition: (projectId: string, data: Record<string, unknown>) =>
    post<ExperimentDefinition>(`/projects/${encodeURIComponent(projectId)}/experiments/definitions`, data),
  getDefinition: (projectId: string, definitionId: string) =>
    get<ExperimentDefinition & { versions: ExperimentVersion[] }>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}`,
    ),
  updateDefinition: (projectId: string, definitionId: string, data: Record<string, unknown>) =>
    patch<ExperimentDefinition>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}`,
      data,
    ),
  createVersion: (projectId: string, definitionId: string, data: Record<string, unknown>) =>
    post<ExperimentVersion>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/versions`,
      data,
    ),
  approveVersion: (projectId: string, definitionId: string, versionId: string) =>
    post<ExperimentVersion>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/approve`,
      {},
    ),
  listRuns: (projectId: string, definitionId: string) =>
    get<ExperimentRun[]>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/runs`,
    ),
  createRun: (projectId: string, definitionId: string, versionId: string, data: Record<string, unknown>) =>
    post<ExperimentRun>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/runs`,
      data,
    ),
  launchRun: (projectId: string, definitionId: string, versionId: string, data: {
    agent_id: string
    runtime_profile_id?: string
    is_baseline?: boolean
    hypothesis?: string
  }) => post<ExperimentRun>(
    `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/versions/${encodeURIComponent(versionId)}/runs/launch`,
    data,
  ),
  completeRun: (projectId: string, definitionId: string, runId: string, data: Record<string, unknown>) =>
    post<ExperimentRun & { observations: ExperimentObservation[] }>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/runs/${encodeURIComponent(runId)}/complete`,
      data,
    ),
  listInterpretations: (projectId: string, definitionId: string) =>
    get<ExperimentInterpretation[]>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/interpretations`,
    ),
  createInterpretation: (projectId: string, definitionId: string, data: Record<string, unknown>) =>
    post<ExperimentInterpretation>(
      `/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/interpretations`,
      data,
    ),
  reviewInterpretation: (projectId: string, interpretationId: string) =>
    post<ExperimentInterpretation>(
      `/projects/${encodeURIComponent(projectId)}/experiments/interpretations/${encodeURIComponent(interpretationId)}/review`,
      {},
    ),
  convertInterpretation: (projectId: string, interpretationId: string, confidence?: number) =>
    post<ExperimentInterpretation & { signal: Record<string, unknown> }>(
      `/projects/${encodeURIComponent(projectId)}/experiments/interpretations/${encodeURIComponent(interpretationId)}/convert-to-signal`,
      confidence === undefined ? {} : { confidence },
    ),
}

export interface KnowledgePromotionCandidate {
  id: string
  project_id: string
  trigger: 'promotion' | 'revalidation'
  source_kind: string
  source_id: string
  source_ref: Record<string, unknown>
  candidate_kind: string
  proposed_title: string
  proposed_content: string
  visibility: 'private' | 'space_shared'
  owner_user_id: string | null
  supersedes_knowledge_item_id: string | null
  status: 'pending' | 'deferred' | 'promoted' | 'dismissed'
  created_proposal_id: string | null
  review_packet_id: string | null
}

export const knowledgePromotionApi = {
  extract: (projectId: string, body: {
    source_kind: 'note' | 'inquiry_thread' | 'experiment_interpretation'
    source_id: string
    agent_id: string
    runtime_profile_id?: string
  }) => post<{ run_id: string; status: string; source_ref: Record<string, unknown> }>(
    `/projects/${encodeURIComponent(projectId)}/knowledge-candidate-extractions`,
    body,
  ),
  list: (projectId: string, status?: string) =>
    get<KnowledgePromotionCandidate[]>(
      `/projects/${encodeURIComponent(projectId)}/knowledge-candidates${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  summary: (projectId: string) =>
    get<{ pending: number; promotion: number; revalidation: number; no_impact: number; summary: string }>(
      `/projects/${encodeURIComponent(projectId)}/knowledge-candidates-review-summary`,
    ),
  decide: (
    projectId: string,
    candidateId: string,
    body: { decision: 'promote' | 'dismiss' | 'defer'; proposed_title?: string; proposed_content?: string },
  ) => post<KnowledgePromotionCandidate>(
    `/projects/${encodeURIComponent(projectId)}/knowledge-candidates/${encodeURIComponent(candidateId)}/decision`,
    body,
  ),
  reopen: (projectId: string, candidateId: string) =>
    post<KnowledgePromotionCandidate>(
      `/projects/${encodeURIComponent(projectId)}/knowledge-candidates/${encodeURIComponent(candidateId)}/reopen`,
      {},
    ),
  openPacket: (projectId: string, limit = 10) =>
    post<{ id: string; status: string; created_at: string; candidates: KnowledgePromotionCandidate[] }>(
      `/projects/${encodeURIComponent(projectId)}/knowledge-candidate-review-packets`,
      { limit },
    ),
  closePacket: (projectId: string, packetId: string) =>
    post<Record<string, unknown>>(
      `/projects/${encodeURIComponent(projectId)}/knowledge-candidate-review-packets/${encodeURIComponent(packetId)}/close`,
      {},
    ),
}

export interface ProjectReviewSession {
  project_id: string
  created_at: string
  summary: string
  sections: {
    inquiry: { packet: { id: string | null; candidates: unknown[] }; decision_href: string }
    knowledge: { packet: { id: string | null; candidates: KnowledgePromotionCandidate[] }; decision_href: string }
  }
}

export const projectReviewApi = {
  open: (projectId: string, limit = 5) =>
    post<ProjectReviewSession>(`/projects/${encodeURIComponent(projectId)}/review-sessions`, { limit }),
}

export interface DecisionCase {
  id: string
  project_id: string
  title: string
  framing: string | null
  status: 'open' | 'decided' | 'archived'
  decided_option_id: string | null
  source_thread_ids?: string[]
  options?: Array<{ id: string; title: string; description: string | null; status: string }>
  criteria?: Array<{ id: string; name: string; weight: number }>
  scores?: Array<{ id: string; option_id: string; criterion_id: string; score: number; rationale: string | null }>
  commitments?: Array<{ id: string; statement: string; created_delivery_task_id: string | null }>
}

export const decisionCasesApi = {
  list: (projectId: string) => get<DecisionCase[]>(`/projects/${encodeURIComponent(projectId)}/decision-cases`),
  get: (projectId: string, caseId: string) => get<DecisionCase>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}`),
  create: (projectId: string, body: { title: string; framing?: string; source_thread_ids?: string[] }) => post<DecisionCase>(`/projects/${encodeURIComponent(projectId)}/decision-cases`, body),
  addOption: (projectId: string, caseId: string, body: { title: string; description?: string }) => post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}/options`, body),
  addCriterion: (projectId: string, caseId: string, body: { name: string; weight: number }) => post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}/criteria`, body),
  score: (projectId: string, caseId: string, body: { option_id: string; criterion_id: string; score: number; rationale?: string }) => post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}/scores`, body),
  decide: (projectId: string, caseId: string, optionId: string) => post<DecisionCase>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}/decide`, { option_id: optionId }),
  addCommitment: (projectId: string, caseId: string, statement: string) => post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}/commitments`, { statement }),
  createDelivery: (projectId: string, caseId: string, commitmentId: string) => post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}/commitments/${encodeURIComponent(commitmentId)}/deliver`, {}),
}

export interface LearningObjective {
  id: string
  project_id: string | null
  title: string
  description: string | null
  status: string
}

export interface LearningItem {
  id: string
  project_id: string | null
  objective_id: string | null
  knowledge_item_id: string
  knowledge_item_version: number
  item_kind: 'card' | 'exercise'
  prompt: string
  answer: string
}

export const learningApi = {
  objectives: (projectId: string) => get<LearningObjective[]>(`/projects/${encodeURIComponent(projectId)}/learning-objectives`),
  items: (projectId: string) => get<LearningItem[]>(`/projects/${encodeURIComponent(projectId)}/learning-items`),
  createObjective: (body: { project_id: string; title: string; description?: string }) => post<LearningObjective>('/learning/objectives', body),
  createItem: (body: { project_id: string; objective_id?: string; knowledge_item_id: string; item_kind: 'card' | 'exercise'; prompt: string; answer: string }) => post<LearningItem>('/learning/items', body),
  review: (itemId: string, outcome: 'correct' | 'incorrect') => post<Record<string, unknown>>(`/learning/items/${encodeURIComponent(itemId)}/review`, { outcome }),
}

export const projectResearchApi = {
  standing: (projectId: string) =>
    get<import('../types/api').ProjectResearchStandingStatus>(`/projects/${encodeURIComponent(projectId)}/research/standing`),
  actionStandingAdvice: (projectId: string, adviceId: string) =>
    post<{ advice: import('../types/api').ProjectResearchStandingAdvice; thread: InquiryThread }>(
      `/projects/${encodeURIComponent(projectId)}/research/standing/advice/${encodeURIComponent(adviceId)}/action`, {},
    ),
  dismissStandingAdvice: (projectId: string, adviceId: string) =>
    post<import('../types/api').ProjectResearchStandingAdvice>(
      `/projects/${encodeURIComponent(projectId)}/research/standing/advice/${encodeURIComponent(adviceId)}/dismiss`, {},
    ),
  retryStandingBatch: (projectId: string, batchId: string) =>
    post<import('../types/api').ProjectResearchStandingBatch>(
      `/projects/${encodeURIComponent(projectId)}/research/standing/batches/${encodeURIComponent(batchId)}/retry`, {},
    ),
  area: (projectId: string) => get<ResearchArea>(`/projects/${encodeURIComponent(projectId)}/research/area`),
  initializeArea: (projectId: string) => post<ResearchArea>(`/projects/${encodeURIComponent(projectId)}/research/area`, {}),
  readingList: (projectId: string, params: { triage_status?: string; read_status?: string; q?: string } = {}) => get<ResearchReadingList>(`/projects/${encodeURIComponent(projectId)}/research/reading-list?${new URLSearchParams(params)}`),
  // Per-note editing/revisions/rollback go through the generic notesApi —
  // a project's notebook is just Notes filed under its auto-created folder.
  updateEvidenceCard: (projectId: string, sourceItemId: string, body: { why_md: string; how_md: string; what_md: string }) => put<ResearchEvidenceCard>(`/projects/${encodeURIComponent(projectId)}/research/reading-list/${encodeURIComponent(sourceItemId)}/card`, body),
  createChecklistItem: (projectId: string, text: string) => post<ResearchChecklistItem>(`/projects/${encodeURIComponent(projectId)}/research/checklist`, { text }),
  updateChecklistItem: (projectId: string, itemId: string, body: Partial<Pick<ResearchChecklistItem, 'text' | 'status' | 'sort_order'>>) => patch<ResearchChecklistItem>(`/projects/${encodeURIComponent(projectId)}/research/checklist/${encodeURIComponent(itemId)}`, body),
  deleteChecklistItem: (projectId: string, itemId: string) => del<{ id: string }>(`/projects/${encodeURIComponent(projectId)}/research/checklist/${encodeURIComponent(itemId)}`),
  // `section_key` is a legacy field name accepted for backward compatibility
  // (see areaService.ts askAi): a known starter-note key maps to its
  // title; any other value is used as a literal note title.
  askAi: (projectId: string, body: { prompt: string; section_key: string; source_item_ids?: string[]; execution: { model_provider_id: string; model_name?: string } }) => post<{ run_id: string; job_id: string; status: string; daily_limit: number; daily_used: number }>(`/projects/${encodeURIComponent(projectId)}/research/ask-ai`, body),
  generateReportSnapshot: (projectId: string) => post<ProjectOperation>(`/projects/${encodeURIComponent(projectId)}/research/reports`, {}),
  refineQuestion: (projectId: string, body: {
    thread_id: string
    research_question: string
    message: string
    establish_assessment_baseline?: boolean
    execution: { model_provider_id?: string; model_name?: string }
  }) => post<ProjectResearchQuestionRefinementResponse>(`/projects/${encodeURIComponent(projectId)}/research/question/refine`, body),
  questionAssessment: (projectId: string, threadId: string) =>
    get<ProjectResearchQuestionAssessmentSession | null>(
      `/projects/${encodeURIComponent(projectId)}/research/question/assessment?thread_id=${encodeURIComponent(threadId)}`,
    ),
  questionAssessmentConfirmations: (projectId: string, threadId: string) =>
    get<ProjectResearchQuestionAssessmentConfirmation[]>(
      `/projects/${encodeURIComponent(projectId)}/research/question/assessment/confirmations?thread_id=${encodeURIComponent(threadId)}`,
    ),
  confirmQuestionAssessment: (projectId: string, body: {
    thread_id: string
    refinement: ProjectResearchQuestionRefinement
    manually_adjusted: boolean
  }) => post<ProjectResearchQuestionAssessmentConfirmationResponse>(
    `/projects/${encodeURIComponent(projectId)}/research/question/assessment/confirm`,
    body,
  ),
  saveInitialIntakeDraft: (projectId: string, body: ProjectResearchInitialIntakeInput) =>
    put<ProjectResearchWorkflow>(`/projects/${encodeURIComponent(projectId)}/research/initial-intake`, body),
  startInitialIntake: (projectId: string, body: ProjectResearchInitialIntakeInput) =>
    post<ProjectResearchInitialIntakeResponse>(`/projects/${encodeURIComponent(projectId)}/research/initial-intake/start`, body),
  workflows: (projectId: string) =>
    get<ProjectResearchWorkflow[]>(`/projects/${encodeURIComponent(projectId)}/research/workflow`),
  scanSummaries: (projectId: string, limit = 30) =>
    get<import('../types/api').ProjectResearchScanSummary[]>(
      `/projects/${encodeURIComponent(projectId)}/research/scan-summaries?limit=${limit}`,
    ),
  runStage: (projectId: string, workflowId: string, stageKey: string, body: { run_id?: string } = {}) =>
    post<ProjectResearchWorkflow>(
      `/projects/${encodeURIComponent(projectId)}/research/workflow/${encodeURIComponent(workflowId)}/stages/${encodeURIComponent(stageKey)}/run`,
      body,
    ),
  triggerIncremental: (projectId: string, workflowId: string, body: { source_item_ids?: string[]; idempotency_key?: string } = {}) =>
    post<Record<string, unknown>>(
      `/projects/${encodeURIComponent(projectId)}/research/workflow/${encodeURIComponent(workflowId)}/trigger`,
      { run_kind: 'incremental', ...body },
    ),
  historyBackfill: (projectId: string, workflowId: string, body: { from: string; to?: string; max_items?: number; idempotency_key?: string }) =>
    post<Record<string, unknown>>(
      `/projects/${encodeURIComponent(projectId)}/research/workflow/${encodeURIComponent(workflowId)}/history-backfill`,
      body,
    ),
  updateInitialItemLimit: (projectId: string, max_items: number, workflowId?: string | null) =>
    put<ProjectResearchWorkflow>(
      `/projects/${encodeURIComponent(projectId)}/research/item-limit`,
      { max_items, ...(workflowId ? { workflow_id: workflowId } : {}) },
    ),
  applyQuestionForward: (projectId: string, workflowId: string) =>
    post<ProjectResearchWorkflow>(
      `/projects/${encodeURIComponent(projectId)}/research/question/apply-forward`,
      { workflow_id: workflowId },
    ),
  questionChangeImpact: (projectId: string, workflowId: string) =>
    get<import('../types/api').ProjectResearchQuestionImpact>(
      `/projects/${encodeURIComponent(projectId)}/research/question/impact?workflow_id=${encodeURIComponent(workflowId)}`,
    ),
  resolveQuestionChange: (projectId: string, workflowId: string, strategy: import('../types/api').ProjectResearchQuestionResolutionStrategy) =>
    post<{ workflow: import('../types/api').ProjectResearchWorkflow; operation?: ProjectOperation } | import('../types/api').ProjectResearchWorkflow>(
      `/projects/${encodeURIComponent(projectId)}/research/question/resolve`,
      { strategy, workflow_id: workflowId },
    ),
  retryOperation: (projectId: string, operationId: string) =>
    post<Record<string, unknown>>(
      `/projects/${encodeURIComponent(projectId)}/research/operations/${encodeURIComponent(operationId)}/retry`,
      {},
    ),
  cancelOperation: (projectId: string, operationId: string, reason?: string) =>
    post<{ operation_id: string; status: 'cancelled'; already_terminal: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/research/operations/${encodeURIComponent(operationId)}/cancel`,
      reason ? { reason } : {},
    ),
  reconcileOperation: (projectId: string, operationId: string) =>
    post<ProjectOperation & { reconcile_diagnostic?: {
      operation_id: string
      bound_run_id: string | null
      bound_run_status: string | null
      before_status: string
      after_status: string
      after_stage: string
    } }>(
      `/projects/${encodeURIComponent(projectId)}/research/operations/${encodeURIComponent(operationId)}/reconcile`,
      {},
    ),
  updateItemLimit: (projectId: string, operationId: string, max_items: number) =>
    put<Record<string, unknown>>(
      `/projects/${encodeURIComponent(projectId)}/research/operations/${encodeURIComponent(operationId)}/item-limit`,
      { max_items },
    ),
  rescanBackfill: (projectId: string, operationId: string) =>
    post<Record<string, unknown>>(
      `/projects/${encodeURIComponent(projectId)}/research/operations/${encodeURIComponent(operationId)}/rescan`,
      {},
    ),
  checkpoints: (projectId: string, workflowId: string) =>
    get<ProjectResearchCheckpoint[]>(
      `/projects/${encodeURIComponent(projectId)}/research/workflow/${encodeURIComponent(workflowId)}/checkpoints`,
    ),
  decideCheckpoint: (projectId: string, workflowId: string, checkpointId: string, body: { decision: string; reason?: string | null }) =>
    post<ProjectResearchCheckpoint>(
      `/projects/${encodeURIComponent(projectId)}/research/workflow/${encodeURIComponent(workflowId)}/checkpoints/${encodeURIComponent(checkpointId)}/decide`,
      body,
    ),
  screeningCriteria: (projectId: string) =>
    get<ProjectResearchScreeningCriteria>(`/projects/${encodeURIComponent(projectId)}/research/screening-criteria`),
  upsertScreeningCriteria: (projectId: string, body: Partial<Pick<
    ProjectResearchScreeningCriteria,
    'include_keywords' | 'exclude_keywords' | 'domain_criteria' | 'date_range_start' | 'date_range_end' | 'source_restrictions' | 'required_evidence_fields'
  >>) =>
    put<ProjectResearchScreeningCriteria>(`/projects/${encodeURIComponent(projectId)}/research/screening-criteria`, body),
  evidenceMatrix: (projectId: string) =>
    get<ProjectResearchEvidenceMatrixItem[]>(`/projects/${encodeURIComponent(projectId)}/research/evidence-matrix`),
  rebuildEvidenceMatrix: (projectId: string) =>
    post<ProjectResearchEvidenceMatrixItem[]>(`/projects/${encodeURIComponent(projectId)}/research/evidence-matrix/rebuild`, {}),
  reports: (projectId: string) =>
    get<ProjectResearchReport[]>(`/projects/${encodeURIComponent(projectId)}/research/reports`),
  report: (projectId: string, reportId: string) =>
    get<ProjectResearchReport>(`/projects/${encodeURIComponent(projectId)}/research/reports/${encodeURIComponent(reportId)}`),
  runReportIntegrity: (projectId: string, reportId: string) =>
    post<Record<string, unknown>>(`/projects/${encodeURIComponent(projectId)}/research/reports/${encodeURIComponent(reportId)}/integrity`, {}),
}

export const researchDiscoveryApi = {
  evaluate: (body: { project_id: string; research_context_version_id: string; providers: ResearchProviderKey[]; candidate_budget: number; execution?: { model_provider_id?: string; model_name?: string }; credentials?: Record<string, string> }) =>
    post<{ strategy: ResearchQueryStrategy }>('/research/query-strategies/evaluate', body),
  materialize: (strategyId: string, body: { provider_keys: ResearchProviderKey[]; credentials?: Record<string, string> }) =>
    post<MaterializedResearchStrategy>(`/research/query-strategies/${encodeURIComponent(strategyId)}/materialize`, body),
  retryProvider: (strategyId: string, providerKey: ResearchProviderKey, body: { project_id: string; execution?: { model_provider_id?: string; model_name?: string }; credentials?: Record<string, string> }) =>
    post<{ strategy: ResearchQueryStrategy }>(`/research/query-strategies/${encodeURIComponent(strategyId)}/providers/${encodeURIComponent(providerKey)}/retry`, body),
}

export const academicApi = {
  listPapers: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.q !== undefined) q.q = params.q
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<AcademicPaper>>('/academic/papers?' + new URLSearchParams(q))
  },
  createPaper: (body: AcademicPaperCreate) =>
    post<AcademicPaper>('/academic/papers', body),
  getPaper: (objectId: string) =>
    get<AcademicPaper>(`/academic/papers/${encodeURIComponent(objectId)}`),
  updatePaper: (objectId: string, body: AcademicPaperUpdate) =>
    patch<AcademicPaper>(`/academic/papers/${encodeURIComponent(objectId)}`, body),
  linkAuthor: (objectId: string, body: { person_object_id: string; author_position?: number | null; is_corresponding?: boolean }) =>
    post<{ object_relation_id: string }>(`/academic/papers/${encodeURIComponent(objectId)}/authors`, body),
  listAuthors: (objectId: string) =>
    get<AcademicPaperAuthor[]>(`/academic/papers/${encodeURIComponent(objectId)}/authors`),
  linkCitation: (objectId: string, body: { cited_paper_object_id: string }) =>
    post<{ object_relation_id: string }>(`/academic/papers/${encodeURIComponent(objectId)}/citations`, body),
  listCitations: (objectId: string) =>
    get<AcademicPaperCitation[]>(`/academic/papers/${encodeURIComponent(objectId)}/citations`),
  listCitedBy: (objectId: string) =>
    get<AcademicPaperCitation[]>(`/academic/papers/${encodeURIComponent(objectId)}/cited-by`),
}

// ── Features ──────────────────────────────────────────────────────────────
export const featuresApi = {
  list: () => get<Feature[]>('/features'),
}

// ── Auth / Identity ───────────────────────────────────────────────────────
export const authApi = {
  me:          ()                  => get<CurrentUser>('/me'),
  mySpaces:    ()                  => get<SpaceWithMembership[]>('/me/spaces'),
  googleConfigured: ()            => get<{google_auth_available: boolean}>('/auth/google-configured'),
  logout:      ()                  => post<null>('/auth/logout'),
  googleLogin: (next?: string)     => {
    const url = next
      ? `/api/v1/auth/google?next=${encodeURIComponent(next)}`
      : '/api/v1/auth/google'
    window.location.href = url
  },
}

// ── Spaces ────────────────────────────────────────────────────────────────
export const spacesApi = {
  create:               (data: { name: string; type: Exclude<SpaceWithMembership['type'], 'personal'>; oversight_mode?: SpaceOversightMode }) => post<SpaceWithMembership>('/spaces', data),
  get:                  (spaceId: string)                              => get<SpaceWithMembership>(`/spaces/${spaceId}`),
  members:              (spaceId: string)                              => get<SpaceMember[]>(`/spaces/${spaceId}/members`),
  invite:               (spaceId: string, data: { email: string; role: string }) =>
    post<SpaceInvitationOut>(`/spaces/${spaceId}/invitations`, data),
  acceptInvite:         (token: string)                                => post<{ space_id: string; role: string; space_name: string }>(`/invitations/${token}/accept`),
  getSnapshotDefaults:  (spaceId: string)                              => get<SpaceSnapshotDefaults>(`/spaces/${spaceId}/snapshot-defaults`),
  updateSnapshotDefaults: (spaceId: string, data: SpaceSnapshotDefaults) => patch<SpaceSnapshotDefaults>(`/spaces/${spaceId}/snapshot-defaults`, data),
  getRetrievalSettings: (spaceId: string) =>
    get<SpaceRetrievalSettings>(`/spaces/${spaceId}/retrieval-settings`),
  updateRetrievalSettings: (spaceId: string, data: SpaceRetrievalSettingsUpdate) =>
    patch<SpaceRetrievalSettings>(`/spaces/${spaceId}/retrieval-settings`, data),
}

// ── Providers ─────────────────────────────────────────────────────────────
export type ProviderType =
  | 'openai'
  | 'openai_codex'
  | 'anthropic'
  | 'minimax'
  | 'openrouter'
  | 'deepseek'
  | 'ollama'
  | 'zeroentropy'
  | 'cohere'
  | 'openai_compatible'

export interface ModelProviderOut {
  id: string
  space_id: string
  home_space_id?: string
  owner_user_id?: string | null
  grant_id?: string | null
  name: string
  provider_type: ProviderType | string
  base_url: string
  network_profile_id: string | null
  claude_compatible_base_url: string | null
  openai_compatible_base_url: string | null
  default_model: string | null
  available_models: string[]
  enabled: boolean
  is_default: boolean
  has_api_key: boolean
  has_subscription?: boolean
  subscription_type?: 'anthropic' | 'openai_codex' | null
  subscription_quota?: ManagedSubscriptionQuota | null
  manageable?: boolean
  grant_enabled?: boolean
  created_at: string
  updated_at: string
}

export interface ModelProviderModelsOut {
  models: string[]
  source: 'configured' | 'live'
}

export type ProviderPresetMode = 'chat' | 'embedding' | 'rerank'

export interface ProviderPresetOut {
  id: string
  mode: ProviderPresetMode
  label: string
  description?: string | null
  name: string
  provider_type: ProviderType
  base_url: string
  claude_compatible_base_url?: string | null
  openai_compatible_base_url?: string | null
  default_model?: string | null
  available_models: string[]
  embedding_dimensions?: number | null
  embedding_dimension_options?: number[]
  api_key_required: boolean
  task?: string | null
}

export interface ProviderFromPresetCreateRequest {
  preset_id: string
  api_key?: string | null
  name?: string
  network_profile_id?: string | null
  default_model?: string | null
  available_models?: string[]
  embedding_dimensions?: number
  is_default?: boolean
}

export interface ProviderFromPresetCreateResponse {
  provider: ModelProviderOut
}

export interface ProviderTaskChainEntry {
  provider_id: string
  model?: string | null
}

export interface ProviderTaskPolicyOut {
  task: string
  chain: ProviderTaskChainEntry[]
  enabled: boolean
  updated_at: string
}

export interface ProviderTaskPolicyPutRequest {
  chain: ProviderTaskChainEntry[]
  enabled?: boolean
}

/**
 * The server-owned vendor registry. The client reads these facts rather than
 * keeping its own copy of them — the two used to be maintained by hand on both
 * sides, and had already drifted.
 */
export interface ProviderVendorOut {
  id: ProviderType
  display_name: string
  protocol: string
  supports_chat: boolean
  supports_runtime_tools: boolean
  supports_structured_output: boolean
  supports_embedding: boolean
  supports_rerank: boolean
  default_base_url: string | null
  api_key_required: boolean
  subscription_only: boolean
}

export interface TestConnectionOut {
  success: boolean
  message: string
  model?: string
}

export interface ManagedSubscriptionQuota {
  available: boolean
  session_pct: number | null
  session_resets: string | null
  week_pct: number | null
  week_resets: string | null
  checked_at: string | null
  error: string | null
}

export type ManagedSubscriptionType = 'anthropic' | 'openai_codex'

export type ManagedSubscriptionLoginEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'prompt'; promptType: string; message: string; placeholder?: string }
  | { type: 'progress' | 'info'; message: string }
  | { type: 'connected'; provider: ModelProviderOut }
  | { type: 'error'; message: string }

export const providersApi = {
  list: () => get<ModelProviderOut[]>('/providers'),

  presets: () => get<ProviderPresetOut[]>('/providers/presets'),

  create: (data: {
    name: string
    provider_type: ProviderType | string
    api_key?: string
    default_model?: string
    available_models?: string[]
    base_url: string
    network_profile_id?: string | null
    claude_compatible_base_url?: string
    openai_compatible_base_url?: string
    enabled?: boolean
    is_default?: boolean
  }) => post<ModelProviderOut>('/providers', data),

  createFromPreset: (data: ProviderFromPresetCreateRequest) =>
    post<ProviderFromPresetCreateResponse>('/providers/from-preset', data),

  patch: (id: string, data: Partial<{
    name: string
    provider_type: ProviderType | string
    api_key: string
    default_model: string
    available_models: string[]
    base_url: string
    network_profile_id: string | null
    claude_compatible_base_url: string | null
    openai_compatible_base_url: string | null
    enabled: boolean
    is_default: boolean
  }>) => patch<ModelProviderOut>(`/providers/${id}`, data),

  delete: (id: string) => del<void>(`/providers/${id}`),

  models: (id: string) => get<ModelProviderModelsOut>(`/providers/${id}/models`),

  test: (id: string) => post<TestConnectionOut>(`/providers/${id}/test`, {}),

  refreshSubscriptionQuota: (id: string) =>
    post<ModelProviderOut>(`/providers/${id}/subscription/quota`, {}),

  disconnectSubscription: (id: string) =>
    del<ModelProviderOut>(`/providers/${id}/subscription`),

  sendSubscriptionLoginInput: (type: ManagedSubscriptionType, input: string) =>
    post<{ status: string }>(`/providers/subscriptions/login/input?type=${encodeURIComponent(type)}`, { input }),

  async *subscriptionLoginStream(type: ManagedSubscriptionType): AsyncGenerator<ManagedSubscriptionLoginEvent> {
    const url = `${BASE}/providers/subscriptions/login/stream?type=${encodeURIComponent(type)}`
    const headers: Record<string, string> = {}
    if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
    headers['X-Rainver-Space-Id'] = _spaceId
    const response = await fetch(url, { headers })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    if (!response.body) throw new Error('No response body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''
      for (const block of blocks) {
        const line = block.trim()
        if (!line.startsWith('data: ')) continue
        try { yield JSON.parse(line.slice(6)) as ManagedSubscriptionLoginEvent } catch { /* ignore malformed SSE */ }
      }
    }
  },

  taskPolicies: () => get<ProviderTaskPolicyOut[]>('/providers/task-policies'),

  putTaskPolicy: (task: string, data: ProviderTaskPolicyPutRequest) =>
    put<ProviderTaskPolicyOut>(`/providers/task-policies/${encodeURIComponent(task)}`, data),

  deleteTaskPolicy: (task: string) =>
    del<void>(`/providers/task-policies/${encodeURIComponent(task)}`),

  grant: (id: string, data: {
    space_id: string
    enabled?: boolean
    is_default?: boolean
    network_profile_id?: string | null
  }) => put(`/providers/${encodeURIComponent(id)}/grants`, data),

  vendors: () => get<ProviderVendorOut[]>('/providers/vendors'),

}

// ── Official Optional Modules (plugins) ───────────────────────────────────
// GET /api/v1/plugins       — list all descriptors + effective state
// GET /api/v1/plugins/effective — effective map for frontend overlay
// GET /api/v1/plugins/:id   — single plugin
// POST /api/v1/plugins/:id/install  — install package + migrations
// POST /api/v1/plugins/:id/enable   — enable
// POST /api/v1/plugins/:id/disable  — disable
// PATCH /api/v1/plugins/:id/settings — patch settings
export const pluginsApi = {
  list: () => get<{ items: unknown[] }>('/plugins'),
  effective: () => get<{ plugins: Record<string, unknown> }>('/plugins/effective'),
  get: (pluginId: string) => get<unknown>(`/plugins/${encodeURIComponent(pluginId)}`),
  install: (pluginId: string) =>
    post<unknown>(`/plugins/${encodeURIComponent(pluginId)}/install`, {}),
  enable: (pluginId: string, body: { settings?: Record<string, unknown> } = {}) =>
    post<unknown>(`/plugins/${encodeURIComponent(pluginId)}/enable`, body),
  disable: (pluginId: string, body: Record<string, never> = {}) =>
    post<unknown>(`/plugins/${encodeURIComponent(pluginId)}/disable`, body),
  patchSettings: (pluginId: string, settings: Record<string, unknown>) =>
    patch<unknown>(`/plugins/${encodeURIComponent(pluginId)}/settings`, { settings }),
}

export const dailyReportApi = {
  getSettings: () =>
    get<DailyCaptureReportSettingOut>('/daily-capture-report/settings'),

  updateSettings: (data: DailyCaptureReportSettingUpdate) =>
    patch<DailyCaptureReportSettingOut>('/daily-capture-report/settings', data),

  run: (data: DailyReportRunRequest) =>
    post<DailyReportRunResponse>('/daily-capture-report/run', data),

  listReports: (limit = 10) =>
    get<DailyReportArtifactItem[]>(`/daily-capture-report/reports?limit=${limit}`),
}

// ── diary ─────────────────────────────────────────────────────────────────
export interface DiaryEntry {
  id: string
  user_id: string
  entry_date: string
  content: string
  created_at: string
  updated_at: string
}

export interface DiaryReflection {
  id: string
  entry_id: string
  reflection_date: string
  content: string
  ai_model: string | null
  created_at: string
}

// ── finance ledger ────────────────────────────────────────────────────────
export interface FinanceBook {
  id: string
  space_id: string
  name: string
  base_currency: string
  operating_currency: string
  status: string
  created_at: string
  updated_at: string
}

export interface FinanceAccount {
  id: string
  name: string
  display_name: string | null
  root_type: string
  parent_account_id: string | null
  commodity_constraints: string[] | null
  opened_at: string
  closed_at: string | null
  booking_method: string | null
  default_commodity: string | null
  owner_user_id: string | null
  visibility: 'space' | 'private'
}

export type FinanceBalanceScope = 'all' | 'shared' | 'personal'

export interface CreateFinanceAccountInput {
  root_type: string
  group: string
  leaf: string
  display_name?: string
  opened_at: string
  currencies?: string[]
  default_currency?: string
  owner?: 'shared' | 'personal'
  visible_to_space?: boolean
}

export interface FinanceCommodity {
  id: string
  symbol: string
  commodity_type: string
  name: string | null
}

export interface FinanceDirective {
  id: string
  directive_type: string
  date: string
  sequence: number
  status: string
}

export interface FinanceTransaction {
  directive_id: string
  flag: string
  payee: string | null
  narration: string | null
  tags: string[]
  links: string[]
  directive: FinanceDirective
}

export interface FinancePosting {
  id: string
  transaction_directive_id: string
  account_id: string
  account_name: string
  amount_text: string | null
  commodity_symbol: string | null
  price_number_text: string | null
  price_commodity_symbol: string | null
  price_is_total: boolean
  flag: string | null
  sort_order: number
}

export interface FinanceBalancePosition {
  accountId: string
  accountName: string
  positions: string[]
}

export interface FinanceValidationError {
  code: string
  message: string
  directiveId?: string
}

export interface FinanceLedgerError {
  code: string
  message: string
  source?: { filename: string; lineno: number }
}

export interface FinanceTransactionInput {
  date: string
  payee?: string | null
  narration?: string | null
  post?: boolean
  postings: Array<{
    account_id: string
    amount?: { number: string; commodity: string } | null
  }>
}

export interface FinanceImportResult {
  import_source_id: string | null
  deduplicated: boolean
  created_directives: number
  errors: FinanceLedgerError[]
}

export interface FinanceExportResult {
  export_id: string
  content: string
  content_hash: string
  errors: FinanceLedgerError[]
}

export const financeApi = {
  listBooks: () => get<{ books: FinanceBook[] }>('/finance/books'),
  createBook: (input: { name: string; base_currency: string; operating_currency?: string }) =>
    post<{ book: FinanceBook }>('/finance/books', input),
  listAccounts: (bookId: string) =>
    get<{ accounts: FinanceAccount[] }>(`/finance/books/${encodeURIComponent(bookId)}/accounts`),
  createAccount: (bookId: string, input: CreateFinanceAccountInput) =>
    post<{ account: FinanceAccount }>(`/finance/books/${encodeURIComponent(bookId)}/accounts`, input),
  closeAccount: (bookId: string, accountId: string, date: string) =>
    post<{ account: FinanceAccount }>(
      `/finance/books/${encodeURIComponent(bookId)}/accounts/${encodeURIComponent(accountId)}/close`,
      { date },
    ),
  setAccountVisibility: (bookId: string, accountId: string, visibility: 'space' | 'private') =>
    post<{ account: FinanceAccount }>(
      `/finance/books/${encodeURIComponent(bookId)}/accounts/${encodeURIComponent(accountId)}/visibility`,
      { visibility },
    ),
  listCommodities: (bookId: string) =>
    get<{ commodities: FinanceCommodity[] }>(`/finance/books/${encodeURIComponent(bookId)}/commodities`),
  createCommodity: (bookId: string, input: { symbol: string; commodity_type?: string }) =>
    post<{ commodity: FinanceCommodity }>(`/finance/books/${encodeURIComponent(bookId)}/commodities`, input),
  listTransactions: (bookId: string) =>
    get<{ transactions: FinanceTransaction[] }>(`/finance/books/${encodeURIComponent(bookId)}/transactions`),
  createTransaction: (bookId: string, input: FinanceTransactionInput) =>
    post<{ directive: FinanceDirective }>(`/finance/books/${encodeURIComponent(bookId)}/transactions`, input),
  getAccountLedger: (bookId: string, accountId: string) =>
    get<{ postings: FinancePosting[] }>(
      `/finance/books/${encodeURIComponent(bookId)}/accounts/${encodeURIComponent(accountId)}/ledger`,
    ),
  getBalances: (bookId: string, scope: FinanceBalanceScope = 'all') =>
    get<{ balances: FinanceBalancePosition[] }>(
      `/finance/books/${encodeURIComponent(bookId)}/balances?scope=${scope}`,
    ),
  validateBook: (bookId: string) =>
    post<{ errors: FinanceValidationError[] }>(`/finance/books/${encodeURIComponent(bookId)}/validate`),
  importBeancount: (bookId: string, input: { text: string; filename?: string; post_directly?: boolean }) =>
    post<FinanceImportResult>(`/finance/books/${encodeURIComponent(bookId)}/import/beancount`, input),
  exportBeancount: (bookId: string) =>
    post<FinanceExportResult>(`/finance/books/${encodeURIComponent(bookId)}/export/beancount`),
}

export const diaryApi = {
  today: () => get<{ date: string; entry: DiaryEntry | null }>('/diary/today'),
  listEntries: (params: { limit?: number; before?: string } = {}) => {
    const q = new URLSearchParams()
    if (params.limit) q.set('limit', String(params.limit))
    if (params.before) q.set('before', params.before)
    return get<{ entries: DiaryEntry[] }>(`/diary/entries${q.size ? '?' + q : ''}`)
  },
  saveEntry: (date: string, content: string) =>
    put<{ entry: DiaryEntry }>(`/diary/entries/${encodeURIComponent(date)}`, { content }),
  deleteEntry: (date: string) =>
    del<{ deleted: boolean }>(`/diary/entries/${encodeURIComponent(date)}`),
  onThisDay: (date: string) =>
    get<{ date: string; entries: DiaryEntry[] }>(`/diary/on-this-day?date=${encodeURIComponent(date)}`),
  reflections: (date: string) =>
    get<{ entry_date: string; reflections: DiaryReflection[] }>(`/diary/entries/${encodeURIComponent(date)}/reflections`),
}

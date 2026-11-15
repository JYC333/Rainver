import type {ResearchQueryEvaluationResult,ResearchQueryEvaluationAcceptedJob} from '@rainver/protocol'
import {ProjectUpdateFrameSchema} from '@rainver/protocol'
import type { ApiPlanUsageProvider, ApiPlanUsageSnapshot } from '@rainver/protocol'
import {INQUIRY_OPERATION_SCHEMAS} from '@rainver/protocol';
import type { RunLiveInputAvailability, RunLiveInputRequest, RunLiveInputResult } from "@rainver/protocol"
import type {OperationId,OperationInput,OperationOutput,OperationOutcome} from "@rainver/protocol"
import type { ProjectMember, ProjectMemberInput } from "@rainver/protocol"
import type { ProjectAgent, ProjectAgentCandidatesResponse, ProjectAgentListResponse, ProjectRoomsResponse } from "@rainver/protocol"

/** `limit`/`offset`/`q` as a query string, omitting what was not given. */
function pageQuery(params: Record<string, string | number | undefined>): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    query.set(key, String(value))
  }
  return query
}
import type { InstanceInvitationResponse } from "@rainver/protocol"
import type {ProblemProjectionSchema,ProblemWorkRequest,ProblemCloseRoundRequest,ResearchResultSchema} from "@rainver/protocol"
import type {ProblemLinkedTasksPage,TaskInquiryThreadsPage,ProblemTaskResult,TaskWorkHistoryPage} from "@rainver/protocol"
import type { ReaderDocumentNoteResponse, ReaderAnnotationRangeUpdate } from "@rainver/protocol"
import type { Briefing, BriefingAdoptionPreview, BriefingFollowUpPreview, BriefingOverviewResponse, ReaderAppearance, ReaderPositionResult, ReaderPositionWrite, ReadingPage, ReadingQuery, ReadingStateRequest } from '@rainver/protocol'
import type { RunFilePreview } from "@rainver/protocol"
import type { ProjectMonitoringState,ProjectMonitoringConfig,MonitoringVersion } from "@rainver/protocol";
import { mergeAbortSignals } from '../lib/mergeAbortSignals'
import type {
  AuthAccount,
  AuthConfiguration,
  AuthSession,
  AdminAuthUser,
  RegistrationIntentAdmin,
  AmbientImportPolicy,
  AmbientSessionCount,
  AmbientSyncReport,
  ExtractionOutcome,
  ImportedSession,
  ImportedSessionRecord,
  ProjectBoard,
  ProjectMainlineRoomResponse,
  ProjectReadersResponse,
  ProjectConversationsResponse,
  ProjectWorkUpdatesResponse,
  TaskWorkView,
  ActivityInboxRecord,
  AgentConfigUpdateBody,
  AgentCreateBody,
  AgentOut,
  AgentRuntimeProfileCreateBody,
  AgentRuntimeProfileOut,
  AgentRuntimeProfileUpdateBody,
  SpaceAgentRuntimeDefaultOut,
  SpaceAgentRuntimeDefaultWrite,
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
  CaptureRequest,
  ChatTurnAccepted,
  ChatTurnRequest,
  DeploymentJob,
  DeploymentJobDetail,
  DeploymentJobType,
  DeploymentStatus,
  DiagnosticTurnPart,
  RunTurn,
  TurnPart,
  TurnStreamFrame,
  ChatTurnOut,
  ClaimCandidatePacketCreateRequestInput,
  ClaimCandidatePacketCreateResponse,
  ClaimContradictionScanRequestInput,
  ClaimContradictionScanResponse,
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
  ConversationAttachmentMutation,
  ConversationAttachmentMutationResponse,
  ConversationExecutionPreflightRequest,
  ConversationExecutionPreflightResponse,
  ConversationExecutionInitializeRequest,
  ConversationRetryResponse,
  ConversationExecutionSummary,
  CreateAgentFromTemplateBody,
  CreateRoomRequest,
  CreateRoomResponse,
  RoomAgentAddRequest,
  RoomAgentCandidatesResponse,
  RoomAgentMutationResponse,
  RoomAgentPresetRequest,
  CrossSpaceRetrievalRequest,
  CurrentUser,
  CustomSourceActivationResult,
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
  InstanceOperationsSettings,
  InstanceOperationsSettingsUpdate,
  FileContent,
  ProjectFileRevision,
  ProjectFileDraft,
  ProjectFileDraftQuota,
  ProjectFileDraftSave,
  FileNode,
  GitStatus,
  Host,
  HostRuntimeProvisioningStatus,
  HostPairingCode,
  HostRuntimeDefinitionOption,
  HostRuntimeChange,
  HostRuntimeUsage,
  HostExecutionTargetsResponse,
  WorkspaceLocation,
  HomeSummaryOut,
  InformationDigestBackfillResult,
  InformationDigestLookup,
  SourceAnnotationEpisode,
  InquiryCandidate,
  InquiryDeltaBriefContent,
  InquiryEvidenceSignal,
  InquiryIteration,
  InquiryOpenStep,
  InquiryReviewPacket,
  InquiryThread,
  InquiryThreadDetail,
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
  Memory,
  MemoryMaintenanceJob,
  MemoryMaintenanceJobRunResponse,
  MemoryMaintenanceReport,
  MemoryVersion,
  MemoryMaintenanceScanRequestInput,
  MemoryProposalRevisionRequest,
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
  PersonalMemoryGrantResponse,
  PlanDetail,
  PlanExecuteBody,
  PlanSummary,
  Project,
  ProjectBriefVersion,
  ProjectCorpusBackfillResult,
  ProjectCorpusItem,
  ProjectCreate,
  ProjectPublicSummary,
  ProjectPublicSummaryDraft,
  ProjectPublicSummaryEditorState,
  ProjectPublicSummaryUpsertBody,
  ProjectExtractionProfile,
  ProjectFolder,
  ProjectFolderCreateBody,
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
  ProjectSourceItem,
  ProjectSourceSummary,
  ProjectUpdate,
  PromptAssetDetail,
  PromptAssetSummary,
  PromptDeploymentRef,
  PromptEvaluationRequest,
  PromptAssetScopeType,
  PromptPromotionRequestInput,
  PromptPromotionResult,
  PromptRenderPreviewRequest,
  PromptRenderPreviewResult,
  PromptRollbackRequest,
  PromptType,
  PromptVersion,
  PromptVersionCreateRequest,
  Proposal,
  ReaderAnnotation,
  ReaderAnnotationCreate,
  ReaderAnnotationsResponse,
  ReaderAnnotationUpdate,
  ReaderCommentCreate,
  ReaderCommentThread,
  ReaderCommentUpdate,
  ReaderCreateEvidenceRequest,
  ReaderCreateProposalRequest,
  ReaderDocumentPayload,
  ReaderThreadUpdate,
  ReflectResult,
  RelationDiscoveryScanRequestInput,
  RelationDiscoveryScanResponse,
  RelocationPreview,
  RelocationRequest,
  ResearchArea,
  ResearchChecklistItem,
  ResearchEvidenceCard,
  ResearchProviderKey,

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
  RoomDetail,
  RoomInvitation,
  RoomInvitationCreateRequest,
  RoomInvitationDecisionRequest,
  RoomInvitationListResponse,
  RoomPendingApprovalListResponse,
  RoomOwnerTransferRequest,
  RoomMessage,
  ThreadReferencePick,
  ContinueRoomAfterProposalRequest,
  ExtendRoomDiscussionRequest,
  OpenRoomDiscussionRequest,
  OpenRoomDiscussionResponse,
  QueuedRoomMessage,
  QueuedRoomMessageResponse,
  RoomConversationQuota,
  RoomDiscussion,
  RoomDiscussionDetail,
  RoomDiscussionListResponse,
  SubscriptionQuotaPolicy,
  SubscriptionQuotaPolicyUpdate,
  Run,
  RunAttempt,
  RunCreateBody,
  RunEvaluation,
  RunFinalization,
  RunLogicalIO,
  RunStatusOut,
  RunSupervisorDecision,
  RunVerificationResult,
  SendRoomMessageRequest,
  SerendipityFeedbackResult,
  Session,
  SkillImportApprovalProposalResponse,
  SkillImportPreviewResponse,
  SkillPackage,
  SourceBackfillPlan,
  SourceBackfillPreview,
  SourceBackfillQuotaPolicy,
  SourceBackfillStrategy,
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
  SourcePostProcessingDecisionReviewStatus,
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
  SourceRecipePlanResponse,
  SourceRecipeVersion,
  SourceRecommendation,
  FollowedSourceChannel,
  SourceScheduleRule,
  SpaceAssistantSettingsOut,
  SpaceAssistantSettingsUpdate,
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
  SpaceSnapshotDefaults,
  SpaceWithMembership,
  Task,
  TaskArtifact,
  TaskProposal,
  TaskRunCreateBody,
  TaskRunListItem,
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
  UsageDimensionsResponse,
  UsageEventsResponse,
  UsageExecutionChannel,
  UsageView,
  UsageOperationalTotalsResponse,
  UsageSessionsResponse,
  UsageSubjectsResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
  ConversationInputMediaOut,
  ConversationInputPart,
  ConversationInputFileSearchResponse,
  OfficialPluginEffectiveResponse,
  ListResearchQueryAttemptsResponse,
  WorkRetrievalSwitch,
  WorkRetrievalSwitchRequest,
} from '@rainver/protocol'
import { AgentAttentionStreamFrameSchema, ConversationInputMediaOutSchema, AgentAttentionQuerySchema, AgentAttentionReadRequestSchema, AgentAttentionViewRequestSchema } from '@rainver/protocol'
import type { AgentAttentionQueryInput, AgentAttentionPage, AgentWorkIdentity, AgentWorkItem, AgentAttentionReadRequest, AgentAttentionReadState, AgentAttentionViewRequest, AgentAttentionViewResult } from '@rainver/protocol'

const BASE = '/api/v1'

let _spaceId = 'personal'
let _apiKey: string | null = null
let _authContextGeneration = 0

export function setSpaceContext(spaceId: string): void {
  _spaceId = spaceId
}

export function setAuth(key: string | null): void {
  // Cookie logout also calls setAuth(null) when no bearer key was present.
  _authContextGeneration += 1
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

export interface RequestOptions {
  includeSpaceContext?: boolean
  spaceId?: string
  idempotencyKey?: string
  signal?: AbortSignal
  /** Lets a small write finish while the page is being left (the Reader's last position). */
  keepalive?: boolean
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
  if (options.signal) opts.signal = options.signal
  if (options.keepalive) opts.keepalive = true
  if (body !== undefined) opts.body = isForm ? (body as FormData) : JSON.stringify(body)

  const r = await fetch(url, opts)

  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    let code: string | undefined
    let payload: Record<string, unknown> | undefined
    try {
      const err = await r.json() as ApiError & { code?: unknown }
      if (err && typeof err === 'object') payload = err as unknown as Record<string, unknown>
      msg = formatApiErrorMessage(err, msg)
      if (typeof err.code === 'string') code = err.code
      const operationError=(err as unknown as {error?:{code?:unknown;message?:unknown}}).error
      if(operationError && typeof operationError==='object'){
        if(typeof operationError.code==='string')code=operationError.code
        if(typeof operationError.message==='string')msg=operationError.message
      }
    } catch {
      const text = await r.text().catch(() => '')
      if (text) msg = text
    }
    // A missing session signs the browser out. `operation_unavailable` is an
    // authentication step that failed (a mistyped password at
    // re-authentication) while the session stays valid.
    if (r.status === 401 && code !== 'operation_unavailable') {
      window.dispatchEvent(new CustomEvent('auth:required'))
    }
    throw new ApiRequestError(msg, r.status, code, payload)
  }

  if (r.status === 204) return null as T
  return r.json() as Promise<T>
}

const get   = <T>(path: string, options?: RequestOptions)                => request<T>('GET',    path, undefined, options)
const post  = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST',   path, body, options)
const put   = <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT',    path, body, options)
const del   = <T>(path: string, options?: RequestOptions)                => request<T>('DELETE', path, undefined, options)

/** User-level aggregate: active Space never supplies authority or filters. */
export const agentAttentionApi = {
  snapshot: (options: RequestOptions = {}) => get<import('@rainver/protocol').AgentAttentionStreamFrame>('/me/agent-attention/snapshot', { ...options, includeSpaceContext: false }),
  stream: async (onFrame: (frame: import('@rainver/protocol').AgentAttentionStreamFrame) => void, options: RequestOptions = {}) => {
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (_apiKey) headers.Authorization = `Bearer ${_apiKey}`
    const response = await fetch(`${BASE}/me/agent-attention/stream`, { headers, signal: options.signal })
    if (options.signal?.aborted) { await response.body?.cancel().catch(() => {}); return }
    if (response.status === 401) window.dispatchEvent(new Event('auth:required'))
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ApiRequestError(`Attention stream failed (${response.status})`, response.status)
    }
    for await (const event of readServerSentEvents(response)) {
      if (options.signal?.aborted) return
      onFrame(AgentAttentionStreamFrameSchema.parse(JSON.parse(event.data)))
    }
    if (!options.signal?.aborted) throw new ApiRequestError('Attention stream disconnected', 502)
  },
  list(query: AgentAttentionQueryInput = {}, options: RequestOptions = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(AgentAttentionQuerySchema.parse(query))) {
      if (value !== undefined) params.set(key, String(value))
    }
    return get<AgentAttentionPage>(`/me/agent-attention?${params}`, { ...options, includeSpaceContext: false })
  },
  item(identity: AgentWorkIdentity & { space_id: string; runs_cursor?: string }, options: RequestOptions = {}) {
    const params = new URLSearchParams(Object.entries(identity).filter((entry): entry is [string, string] => entry[1] !== undefined))
    return get<AgentWorkItem>(`/me/agent-attention/item?${params}`, { ...options, includeSpaceContext: false })
  },
  async setReadState(body: AgentAttentionReadRequest, options: RequestOptions = {}):Promise<AgentAttentionReadState> {
    const receipt=await operationAt<OperationOutput<'attention.read_state.change'>>('PATCH','/me/agent-attention/read-state',AgentAttentionReadRequestSchema.parse(body),options.idempotencyKey??crypto.randomUUID(),{...options,includeSpaceContext:false})
    return receipt.state
  },
  /** A conversation surface displayed these messages; the server decides what that reads. */
  recordViews(body: AgentAttentionViewRequest, options: RequestOptions = {}) {
    return operationAt<OperationOutput<'attention.views.record'>>('POST','/me/agent-attention/views',AgentAttentionViewRequestSchema.parse(body),options.idempotencyKey??crypto.randomUUID(),{...options,includeSpaceContext:false}).then(({read_count,read_states}):AgentAttentionViewResult=>({read_count,read_states}))
  },
}

export const conversationInputApi = {
  uploadImage: (file: File, onProgress?: (progress: number) => void, options: RequestOptions = {}): Promise<ConversationInputMediaOut> => {
    const form = new FormData()
    form.append('file', file, file.name)
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${BASE}/conversation-inputs/media`)
      xhr.withCredentials = true
      if (_apiKey) xhr.setRequestHeader('Authorization', `Bearer ${_apiKey}`)
      xhr.setRequestHeader('X-Rainver-Space-Id', options.spaceId ?? _spaceId)
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100))
      }
      xhr.onerror = () => reject(new ApiRequestError('Image upload failed', 0))
      xhr.onabort = () => reject(new ApiRequestError('Image upload cancelled', 0))
      xhr.onload = () => {
        if (xhr.status === 401) window.dispatchEvent(new CustomEvent('auth:required'))
        let payload: unknown = null
        try { payload = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { /* use status text */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = payload && typeof payload === 'object'
            ? payload as ApiError & { code?: unknown }
            : { error: `${xhr.status} ${xhr.statusText}` }
          const message = formatApiErrorMessage(error, `${xhr.status} ${xhr.statusText}`)
          reject(new ApiRequestError(message, xhr.status, typeof error.code === 'string' ? error.code : undefined, error as unknown as Record<string, unknown>))
          return
        }
        try {
          resolve(ConversationInputMediaOutSchema.parse(payload))
        } catch {
          reject(new ApiRequestError('Image upload returned an invalid response', xhr.status))
        }
      }
      const abort = () => xhr.abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      xhr.addEventListener('loadend', () => options.signal?.removeEventListener('abort', abort), { once: true })
      if (options.signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
      xhr.send(form)
    })
  },
  deletePendingImage: (mediaId: string, options: RequestOptions = {}) => del<null>(`/conversation-inputs/media/${encodeURIComponent(mediaId)}`, options),
  imageBlob: async (mediaId: string, options: RequestOptions = {}): Promise<Blob> => {
    const headers: Record<string, string> = { 'X-Rainver-Space-Id': options.spaceId ?? _spaceId }
    if (_apiKey) headers.Authorization = `Bearer ${_apiKey}`
    const response = await fetch(`${BASE}/conversation-inputs/media/${encodeURIComponent(mediaId)}`, { headers, signal: options.signal })
    if (response.status === 401) window.dispatchEvent(new CustomEvent('auth:required'))
    if (!response.ok) throw new ApiRequestError(`Could not load image (${response.status})`, response.status)
    return response.blob()
  },
  searchFiles: (sessionId: string, query: string, signal?: AbortSignal, options: RequestOptions = {}) =>
    get<ConversationInputFileSearchResponse>(`/sessions/${encodeURIComponent(sessionId)}/input-files?q=${encodeURIComponent(query)}&limit=20`, { ...options, signal: mergeAbortSignals(signal, options.signal) }),
}

/**
 * Reads an SSE body, yielding one `{ event, data }` per frame.
 *
 * Shared by the two turn readers below: the chat turn, which waits for the
 * whole thing, and `streamTurnParts`, which hands parts to a renderer as they
 * arrive.
 */
async function* readServerSentEvents(
  response: Response,
): AsyncGenerator<{ event: string | undefined; data: string }> {
  if (!response.ok || !response.body) {
    throw new ApiRequestError(`Run turn stream failed (${response.status})`, response.status)
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
        const lines = frame.split(/\r?\n/)
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        yield { event: lines.find(line => line.startsWith('event:'))?.slice(6).trim(), data }
      }
      if (done) return
    }
  } finally {
    // Cancel rather than just release: a caller that returns from inside the
    // loop (a finished turn) or throws on `server.error` would otherwise
    // leave the body undrained and the connection open.
    await reader.cancel().catch(() => {})
  }
}

function turnStreamUrl(runId: string): string {
  return `${BASE}/runs/${encodeURIComponent(runId)}/turn/stream`
}

function streamHeaders(spaceId?: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (_apiKey) headers.Authorization = `Bearer ${_apiKey}`
  headers['X-Rainver-Space-Id'] = spaceId ?? _spaceId
  return headers
}

/**
 * Folds one stream frame into the turn so far.
 *
 * A snapshot replaces; a state change replaces the state; an appended or
 * updated part lands at its own index. Both are one case: a
 * tool call finishing writes over the part it started as.
 *
 * A `streamed` text part is the exception: it is live prose the projection
 * does not hold, so it is kept at the end of the list rather than at an index
 * the next projected part would claim. It survives only until the projection
 * has prose of its own — the persisted reply says the same thing, and showing
 * both reads the answer out twice.
 */
function applyTurnFrame(turn: RunTurn | null, frame: TurnStreamFrame): RunTurn | null {
  if (frame.type === 'turn.snapshot') {
    // The snapshot is the projection; anything streamed is superseded by it.
    return frame.turn
  }
  if (!turn) return null
  if (frame.type === 'turn.model_changed') {
    return { ...turn, model_selection: frame.model_selection }
  }
  if (frame.type === 'turn.state_changed') {
    return { ...turn, state: frame.state, blocked_on: frame.blocked_on,
      ...(frame.queue_wait_reason !== undefined ? {queue_wait_reason:frame.queue_wait_reason} : {}) }
  }

  const projected = turn.parts.filter(part => !(part.type === 'text' && part.streamed))
  const held = turn.parts.find(part => part.type === 'text' && part.streamed)

  if (frame.part.type === 'text' && frame.part.streamed) {
    const live = frame.part.text ? frame.part : null
    return { ...turn, parts: withLiveProse(projected, live), cursor: frame.cursor }
  }
  // At or one past the end. Anything further would leave a hole, and the
  // consumers that scan backwards for the newest part dereference holes.
  if (frame.part.index > projected.length) return turn
  const parts = [...projected]
  parts[frame.part.index] = frame.part
  return { ...turn, parts: withLiveProse(parts, held ?? null), cursor: frame.cursor }
}

/**
 * Puts the live prose back on the end of a projected list, unless the
 * projection now has prose of its own.
 *
 * The retraction frame the server sends is a frame behind the projected reply
 * it replaces, so a client that waited for it would show the answer twice in
 * between. This condition is local and needs no such coordination.
 */
function withLiveProse(projected: TurnPart[], live: TurnPart | null): TurnPart[] {
  if (!live || projected.some(part => part.type === 'text')) return projected
  return [...projected, { ...live, index: projected.length }]
}

/**
 * The live turn, as parts.
 *
 * `onTurn` receives the whole turn on every change rather than a patch: a
 * turn is small, and handing a renderer the current state is simpler to hold
 * correctly than replaying appends and updates into a local copy.
 */
export async function streamTurnParts(
  runId: string,
  options: {
    spaceId?: string
    signal?: AbortSignal
    onTurn: (turn: RunTurn) => void
  },
): Promise<void> {
  const response = await fetch(turnStreamUrl(runId), {
    headers: streamHeaders(options.spaceId),
    signal: options.signal,
  })
  let turn: RunTurn | null = null
  for await (const { event, data } of readServerSentEvents(response)) {
    const frame = JSON.parse(data) as TurnStreamFrame | { error?: string; message?: string }
    if (event === 'server.error') {
      const failure = frame as { error?: string; message?: string }
      throw new ApiRequestError(failure.message ?? failure.error ?? 'Run turn stream failed', 502)
    }
    if (!('type' in frame)) continue
    turn = applyTurnFrame(turn, frame)
    if (!options.signal?.aborted && turn) options.onTurn(turn)
  }
  // The server sends the settled state before it closes, so a stream that
  // ends on `working` ended for some other reason — the poll hit a database
  // error, the connection dropped, a proxy timed out. Resolving quietly here
  // would leave the caller holding a turn that says the Agent is still
  // working, on a reply that is finished, with nothing to correct it: the
  // stream is gone and every read-back guard treats a held turn as current.
  // Reported so the caller can go and read the turn again.
  //
  // `blocked` is deliberately not included. The server keeps that stream
  // open on purpose — the turn resumes where it stopped once somebody
  // decides — so it waits at human pace, and an idle timeout on that
  // connection is the ordinary ending rather than a fault. Reporting it
  // would make the caller drop the one turn that carries the approval link.
  if (turn && turn.state === 'working') {
    throw new ApiRequestError('Run turn stream ended before the turn settled', 502)
  }
}

async function postChatTurn(
  agentId: string,
  body: Omit<OperationInput<'agent.chat.send'>, 'agent_id'>,
  options: RequestOptions & {
    onAccepted?: (accepted: ChatTurnAccepted) => void
    onTurn?: (turn: RunTurn) => void
  } = {},
): Promise<ChatTurnOut> {
  // One keyed turn command, never retried automatically; the stream is a read.
  const { space_id: _space, ...accepted } = await commandReceipt('agent.chat.send', { ...body, agent_id: agentId }, options.idempotencyKey ?? crypto.randomUUID(), options)
  if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
  options.onAccepted?.(accepted)
  const response = await fetch(accepted.event_stream_url, { headers: streamHeaders(options.spaceId), signal: options.signal })

  let turn: RunTurn | null = null
  for await (const { event, data } of readServerSentEvents(response)) {
    const frame = JSON.parse(data) as TurnStreamFrame | { error?: string; message?: string }
    if (event === 'server.error') {
      const failure = frame as { error?: string; message?: string }
      throw new ApiRequestError(failure.message ?? failure.error ?? 'Run turn stream failed', 502)
    }
    if (!('type' in frame)) continue
    turn = applyTurnFrame(turn, frame)
    if (!turn) continue
    if (options.signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
    options.onTurn?.(turn)
    // A blocked turn has stopped, but it is not over: it resumes when the
    // person decides, so the caller keeps watching rather than going to read
    // a reply that has not been written.
    if (turn.state === 'working' || turn.state === 'blocked') continue

    // The turn is over. Its durable form is the assistant message the Run
    // finalized into — the stream is what the person watched, the message is
    // what the conversation keeps.
    if (turn.state === 'failed') {
      const failure = turn.parts.find(
        (part): part is DiagnosticTurnPart => part.type === 'diagnostic' && part.level === 'error')
      return {
        schema_version: 'chat_turn_completion.v1',
        session_id: accepted.session_id,
        run_id: accepted.run_id,
        ok: false,
        error: failure?.text ?? 'The assistant could not complete this turn.',
        error_code: failure?.error_code ?? 'run_failed',
        assistant_message: null,
      }
    }
    const messages = await get<Message[]>(
      `/sessions/${encodeURIComponent(accepted.session_id)}/messages`,
      { spaceId: options.spaceId, signal: options.signal },
    )
    const assistant = messages.find(message =>
      message.role === 'assistant' && message.run_id === accepted.run_id)
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
  throw new ApiRequestError('Run turn stream ended without a finished turn', 502)
}

// ── Content access and targeted publication ───────────────────────────────
export const contentAccessApi = {
  get: (resourceType: string, resourceId: string) =>
    get<ContentAccessPolicy>(`/content-access/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`),
  /** Keyed command, then the policy reread under current access (Memory answers with its new version's id). */
  update: async (resourceType: string, resourceId: string, body: ContentAccessUpdate, idempotencyKey: string = crypto.randomUUID()): Promise<ContentAccessPolicy> => {
    const receipt = await commandReceipt('content.access.update', { ...body, resource_type: resourceType, resource_id: resourceId }, idempotencyKey)
    return contentAccessApi.get(receipt.resource_type, receipt.resource_id)
  },
  accessLogs: (resourceType: string, resourceId: string, limit = 50, offset = 0) =>
    get<ContentAccessLogList>(`/content-access/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}/access-logs?limit=${limit}&offset=${offset}`),
  /** Keyed disclosure command; the recorded exposure is read back by its owner-only reader. */
  discloseDemotion: async (resourceType: string, resourceId: string, targetVisibility: Exclude<ContentVisibility, 'space_shared'>, idempotencyKey: string = crypto.randomUUID()): Promise<ContentDemotionDisclosure> => {
    const receipt = await commandReceipt('content.demotion.disclose', { resource_type: resourceType, resource_id: resourceId, target_visibility: targetVisibility }, idempotencyKey)
    return get<ContentDemotionDisclosure>(`/content-access/${encodeURIComponent(receipt.resource_type)}/${encodeURIComponent(receipt.resource_id)}/demotion-disclosures/${encodeURIComponent(receipt.confirmation_id)}`)
  },
}

export const focusAreasApi = {
  list: (includeArchived = false) =>
    get<FocusArea[]>(`/focus-areas${includeArchived ? '?include_archived=true' : ''}`),
  get: (id: string) =>
    get<FocusArea>(`/focus-areas/${encodeURIComponent(id)}`),
  create: (body: { name: string; description?: string | null }, key:string=crypto.randomUUID()) =>
    commandReceipt('focus_area.create', body, key),
  update: (id: string, body: { name?: string; description?: string | null }, key:string=crypto.randomUUID()) =>
    commandReceipt('focus_area.update', {...body,focus_area_id:id}, key),
  /** Each list continues from its own cursor; an omitted cursor reads that list's first page. */
  contents: (id: string, params: { projects_cursor?: string; objects_cursor?: string; limit?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.projects_cursor !== undefined) q.projects_cursor = params.projects_cursor
    if (params.objects_cursor !== undefined) q.objects_cursor = params.objects_cursor
    if (params.limit !== undefined) q.limit = String(params.limit)
    const search = new URLSearchParams(q).toString()
    return get<FocusAreaContents>(`/focus-areas/${encodeURIComponent(id)}/contents${search ? `?${search}` : ''}`)
  },
  setForObject: async (objectId: string, focusAreaId: string | null, key:string=crypto.randomUUID()):Promise<void> => {
    await commandReceipt('focus_area.object.set', {object_id:objectId,focus_area_id:focusAreaId}, key)
  },
  setForProject: async (projectId:string,focusAreaId:string|null,key:string=crypto.randomUUID()) => {await projectManagementCall('project.focus_area.set',{project_id:projectId,focus_area_id:focusAreaId},key);},
}

export const publicationsApi = {
  list: (view: 'received' | 'published' = 'received') =>
    get<ContentPublicationList>(`/publications?view=${view}`),
  get: (publicationId: string) =>
    get<ContentPublication>(`/publications/${encodeURIComponent(publicationId)}`),
  create: (body: CreatePublicationRequest, key:string = crypto.randomUUID()) =>
    operationAt<ContentPublication>('POST', '/publications', body, key),
  import: (publicationId: string, key:string = crypto.randomUUID()) =>
    operationAt<PublicationImport>('POST', `/publications/${encodeURIComponent(publicationId)}/import`, {}, key),
  revoke: (publicationId: string, key:string = crypto.randomUUID()) =>
    operationAt<ContentPublication>('POST', `/publications/${encodeURIComponent(publicationId)}/revoke`, {}, key),
}

// ── Memory ────────────────────────────────────────────────────────────────
export const memoryApi = {
  list: (params: {
    scope?: string
    namespace?: string
    type?: string
    status?: string
    project_id?: string
    agent_id?: string
    /** `agent` = what the Agents have written on their own (ADR 0003 §2). */
    created_by?: 'agent' | 'user'
    since?: string
    session?: string
    run?: string
    limit?: number
    offset?: number
  } = {}) => {
    const q: Record<string, string> = {}
    if (params.scope !== undefined) q.scope = params.scope
    if (params.namespace !== undefined) q.namespace = params.namespace
    if (params.type !== undefined) q.type = params.type
    if (params.status !== undefined) q.status = params.status
    if (params.project_id !== undefined) q.project_id = params.project_id
    if (params.agent_id !== undefined) q.agent_id = params.agent_id
    if (params.created_by !== undefined) q.created_by = params.created_by
    if (params.since !== undefined) q.since = params.since
    if (params.session !== undefined) q.session = params.session
    if (params.run !== undefined) q.run = params.run
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Memory>>('/memory?' + new URLSearchParams(q))
  },
  get: (id: string) => get<Memory>(`/memory/${id}`),
  create: async (data: OperationInput<'memory.propose_create'>, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('memory.propose_create', data, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  update: async (id: string, data: Omit<OperationInput<'memory.propose_update'>, 'memory_id'>, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('memory.propose_update', {...data, memory_id: id}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  // 200 with the archived entry when it is the caller's own; 202 with a
  // proposal when it is someone else's (ADR 0003 §3).
  delete: async (id: string, key: string = crypto.randomUUID()): Promise<Memory | Proposal> => {
    const receipt = await commandReceipt('memory.archive', {memory_id: id}, key)
    return receipt.outcome === 'archived' ? memoryApi.get(receipt.id) : proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  restore: async (id: string, key: string = crypto.randomUUID()): Promise<Memory> => {
    const receipt = await commandReceipt('memory.restore', {memory_id: id}, key)
    return memoryApi.get(receipt.id)
  },
  // Undo one revision in a single action — archive what is there, bring back
  // what it replaced. An Agent's persona has to be reversed this way: it must
  // always have one, so archiving the head alone would leave it with none.
  revert: async (id: string, key: string = crypto.randomUUID()): Promise<Memory> => {
    const receipt = await commandReceipt('memory.revert', {memory_id: id}, key)
    return memoryApi.get(receipt.id)
  },
  versions: (id: string) =>
    get<{ items: MemoryVersion[] }>(`/memory/${id}/versions`),
  // The revision a maintenance finding asked for, written into its pending
  // update; accepting the proposal is still a separate decision.
  reviseProposal: async (proposalId: string, body: MemoryProposalRevisionRequest, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('memory.proposal.revise', {...body, proposal_id: proposalId}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  search: (data: { query: string; scope?: string; namespace?: string; type?: string; limit?: number }) =>
    // Memory search is identity-scoped server-side; do not send space_id/user_id.
    contentRequest<Memory[]>('memory.search.request', data),
  retrievalSearch: (data: RetrievalSearchRequest) =>
    contentRequest<RetrievalSearchResponse>('memory.retrieval.search.request', data),
  retrievalBrief: (data: RetrievalBriefRequest) =>
    contentRequest<RetrievalBriefResponse>('memory.retrieval.brief.request', data),
  feedback: async (data: RetrievalFeedbackRequest, key: string = crypto.randomUUID()): Promise<RetrievalFeedbackResponse> => {
    await commandReceipt('memory.retrieval.feedback', data, key)
    return { ok: true }
  },
  maintenanceScan: (data: MemoryMaintenanceScanRequestInput = {}) =>
    contentRequest<MemoryMaintenanceReport>('memory.maintenance.scan', data),
  createMaintenanceJob: (data: MemoryMaintenanceScanRequestInput = {}) =>
    contentRequest<MemoryMaintenanceJob>('memory.maintenance.job.create', data),
  getMaintenanceJob: (jobId: string) =>
    get<MemoryMaintenanceJob>(`/memory/maintenance/jobs/${jobId}`),
  runMaintenanceJob: (jobId: string) =>
    contentRequest<MemoryMaintenanceJobRunResponse>('memory.maintenance.job.run', {job_id:jobId}),
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
  proposeCreate: async (body: KnowledgeCreateProposalBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.item.propose_create', body, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  proposeUpdate: async (id: string, body: KnowledgeUpdateProposalBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.item.propose_update', {...body, item_id:id}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  proposeArchive: async (id: string, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.item.propose_archive', {item_id:id}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  proposeRelation: async (body: KnowledgeRelationProposalBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.relation.propose_create', {
      from_object_id: body.from_object_id,
      to_object_id: body.to_object_id,
      link_type: body.link_type,
      status: body.status,
      confidence: body.confidence,
      evidence_summary: body.evidence_summary,
      rationale: body.rationale,
      metadata: { endpoint_type: 'knowledge_item', requested_link_type: body.link_type },
    }, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  proposeRelationArchive: async (id: string, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.relation.propose_archive', {relation_id:id}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  summary: () => get<KnowledgeSummary>('/knowledge/summary'),
  search: (data: RetrievalSearchRequest) =>
    contentRequest<RetrievalSearchResponse>('knowledge.retrieval.search.request', data),
  brief: (data: RetrievalBriefRequest) =>
    contentRequest<RetrievalBriefResponse>('knowledge.retrieval.brief.request', data),
  diagnosticsReport: (data: RetrievalDiagnosticsReportRequest) =>
    contentRequest<RetrievalDiagnosticsReportResponse>('knowledge.eval.diagnostics.report', data),
  calibrationDecision: (data: RetrievalCalibrationDecisionRequest) =>
    contentRequest<RetrievalCalibrationDecisionResponse>('knowledge.eval.calibration.record', data),
  maintenanceScan: (data: RetrievalMaintenanceScanRequestInput = {}) =>
    contentRequest<RetrievalMaintenanceScanResponse>('knowledge.maintenance.scan', data),
  claimCandidatePacket: (data: ClaimCandidatePacketCreateRequestInput) =>
    contentRequest<ClaimCandidatePacketCreateResponse>('knowledge.claim.candidate_packet.create', data),
  contradictionScan: (data: ClaimContradictionScanRequestInput = {}) =>
    contentRequest<ClaimContradictionScanResponse>('knowledge.claim.contradictions.scan', data),
  relationDiscoveryScan: (data: RelationDiscoveryScanRequestInput = {}) =>
    contentRequest<RelationDiscoveryScanResponse>('knowledge.relation.discovery.scan', data),
  explain: (data: RetrievalExplainRequest) =>
    contentRequest<RetrievalExplainResponse>('knowledge.retrieval.explain.request', data),
  feedback: async (data: RetrievalFeedbackRequest, key: string = crypto.randomUUID()): Promise<RetrievalFeedbackResponse> => {
    await commandReceipt('knowledge.retrieval.feedback', data, key)
    return { ok: true }
  },
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

interface GraphViewStateRecord {
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
  saveViewState: async (scopeKey: string, stateJson: Record<string, unknown>, key: string = crypto.randomUUID()): Promise<GraphViewStateRecord> => {
    const {space_id: _space, user_id: _user, ...state} = await commandReceipt('graph.view_state.save', {scope_key:scopeKey,state_json:stateJson}, key)
    return state
  },
}

export const objectSchemaApi = {
  exportSchema: () =>
    get<ObjectSchemaExportManifest>('/knowledge/object-schema/export'),
  importSchema: async (body: ObjectSchemaImportRequestInput, key: string = crypto.randomUUID()): Promise<ObjectSchemaImportResponse> => {
    const {space_id: _space, ...result} = await commandReceipt('knowledge.object_schema.propose_import', body, key)
    return result
  },
  suggestionScan: (body: ObjectSchemaSuggestionScanRequestInput = {}) =>
    contentRequest<ObjectSchemaSuggestionScanResponse>('knowledge.object_schema.suggestions.scan', body),
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
  proposeCreateKind: async (body: SpaceObjectProfileCreateProposalRequestInput, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.object_kind.propose_create', body, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  proposeUpdateKind: async (id: string, body: SpaceObjectProfileUpdateProposalRequestInput, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.object_kind.propose_update', {...body, profile_id: id}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  proposeDeprecateKind: async (id: string, body: { rationale?: string } = {}, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.object_kind.propose_deprecate', {...body, profile_id: id}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
  proposeArchiveKind: async (id: string, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('knowledge.object_kind.propose_archive', {profile_id: id}, key)
    return proposalsApi.get(receipt.id, {spaceId: receipt.space_id})
  },
}

// ── Notes (working knowledge; direct CRUD) ─────────────────────────────────
/** User mutation keys belong to the event; a caller can explicitly retry the same input/key.
 * No write retry is performed here. Receipts never cache Note content. */
async function noteObjectCall<Id extends import('@rainver/protocol').OperationId>(id:Id,input:import('@rainver/protocol').OperationInput<Id>,key:string){
 try{const result=await callOperation(id,input,key);if(!('status' in result)||result.status!=='succeeded')throw new Error('Note action did not complete');return result.data;}
 catch(e){if(e instanceof ApiRequestError){const metadata=(e.payload?.error as {metadata?:Record<string,unknown>}|undefined)?.metadata;if(metadata&&['note_owning_entry_required','note_cross_project_share_required'].includes(String(metadata.code)))throw new ApiRequestError(e.message,e.status,String(metadata.code),metadata);}throw e;}
}
/** One explicit-key Source command. A structured refusal code (for example
 * `source_retention_policy` or `reading_version_changed`) becomes the error's
 * `code`, so callers act on it rather than on prose. */
async function sourceObjectCall<Id extends import('@rainver/protocol').OperationId>(id:Id,input:import('@rainver/protocol').OperationInput<Id>,key:string,options:RequestOptions={}){
 try{const result=await callOperation(id,input,key,options);if(!('status' in result)||result.status!=='succeeded')throw new Error('Source action did not complete');return result.data;}
 catch(e){if(e instanceof ApiRequestError){const metadata=(e.payload?.error as {metadata?:Record<string,unknown>}|undefined)?.metadata;if(metadata&&typeof metadata.code==='string')throw new ApiRequestError(e.message,e.status,metadata.code,metadata);}throw e;}
}
const receiptState=<T extends {id:string;space_id:string}>({id:_id,space_id:_space,...state}:T)=>state;
async function currentSourceItem(receipt:{id:string;space_id:string}){return get<SourceItem>(`/sources/items/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});}
async function currentNote(receipt:{id:string;space_id:string}){return get<Note>(`/knowledge/notes/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});}
async function currentCollection(receipt:{id:string;space_id:string}){const rows=await get<NoteCollection[]>('/notes/collections',{spaceId:receipt.space_id});const row=rows.find(r=>r.id===receipt.id);if(!row)throw new Error('Collection no longer available');return row;}
export const notesCollectionsApi = {
  list: () => get<NoteCollection[]>('/notes/collections'),
  /**
   * The Project's notes folder, created on first use. The Project notes surface
   * is hoisted to it, so it has to exist before the surface can show anything.
   */
  ensureForProject: async (projectId:string,key:string=crypto.randomUUID()) => currentCollection(await noteObjectCall('knowledge.collection.ensure_project',{project_id:projectId},key)),
  create: async (body:NoteCollectionCreateBody,key:string=crypto.randomUUID()) => currentCollection(await noteObjectCall('knowledge.collection.create',body,key)),
  update: async (id:string,body:NoteCollectionUpdateBody,key:string=crypto.randomUUID()) => currentCollection(await noteObjectCall('knowledge.collection.update',{collection_id:id,changes:body},key)),
  delete: async (id:string,key:string=crypto.randomUUID()) => {await noteObjectCall('knowledge.collection.delete',{collection_id:id},key)},
}

/**
 * Discuss and edit the Project's notes. The routes are Project-level.
 * Do not put them under `.../research/`.
 */
type NotebookChatReply={session_id:string;run_id:string;ok:boolean;reply?:string;error?:string;notebook_edit?:{note_id:string;version:number;conflict:boolean}|null;daily_limit:number;daily_used:number};
export const projectNotebookChatApi = {
  send: async(projectId:string,body:{message:string;session_id?:string;source_item_ids?:string[];execution:{model_provider_id:string;model_name?:string}},key:string=crypto.randomUUID()):Promise<NotebookChatReply> => {
    const receipt=await projectManagementCall('project.notebook.chat',{project_id:projectId,...body},key);
    // Only the original command writes. Waiting for the same durable answer uses read-only requests.
    for(let read=0;read<240;read++){
      const result=await get<NotebookChatReply&{pending:boolean}>(`/projects/${encodeURIComponent(receipt.project_id)}/notebook-chat/${encodeURIComponent(receipt.run_id)}`,{spaceId:receipt.space_id});
      if(!result.pending)return result;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('The reply is still being prepared. Reopen this conversation shortly.');
  },
}

export const notesTreeApi = {
  reorder: (body:NotesTreeReorderBody,key:string=crypto.randomUUID()) => noteObjectCall('knowledge.note.tree.reorder',body,key),
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
  create: async (body:NoteCreateBody,key:string=crypto.randomUUID()) => currentNote(await noteObjectCall('knowledge.note.create',body,key)),
  update: async (id:string,body:NoteUpdateBody,key:string=crypto.randomUUID()) => currentNote(await noteObjectCall('knowledge.note.update',{note_id:id,changes:body},key)),
  delete: async (id:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('knowledge.note.delete',{note_id:id},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Note trash action did not complete');
    return get<Note>(`/knowledge/notes/${encodeURIComponent(result.data.id)}`,{spaceId:result.data.space_id});
  },
  /** One explicit-key purge; a retry with the same key replays its count and never deletes another batch. */
  purgeDeleted: async (key: string = crypto.randomUUID()) => {
    const { deleted, retention_days } = await noteObjectCall('knowledge.note.trash.purge', {}, key)
    return { deleted, retention_days }
  },
  /**
   * Place a note in a further folder, keeping the ones it is already in —
   * distinct from moving it, which the tree reorder does.
   */
  addPlacement: async (id:string,collectionId:string,shareWithProject=false,key:string=crypto.randomUUID()) => currentNote(await noteObjectCall('knowledge.note.placement.add',{note_id:id,collection_id:collectionId,share_with_project:shareWithProject},key)),
  shares: (id:string) => get<NoteProjectShare[]>(`/knowledge/notes/${id}/shares`),
  revokeShare: async (id:string,projectId:string,key:string=crypto.randomUUID()) => currentNote(await noteObjectCall('knowledge.note.share.revoke',{note_id:id,project_id:projectId},key)),
  removePlacement: async (id:string,collectionId:string,key:string=crypto.randomUUID()) => currentNote(await noteObjectCall('knowledge.note.placement.remove',{note_id:id,collection_id:collectionId},key)),
  links: (id: string) => get<EntityLink[]>(`/knowledge/notes/${id}/links`),
  backlinks: (id: string) => get<EntityLink[]>(`/knowledge/notes/${id}/backlinks`),
  /** Link receipts carry identity only; current links are reread through links/backlinks. */
  createLink: (id: string, body: NoteLinkCreateBody, key: string = crypto.randomUUID()) =>
    noteObjectCall('knowledge.note.link.create', { ...body, note_id: id }, key),
  deleteLink: async (id: string, linkId: string, key: string = crypto.randomUUID()) => {
    await noteObjectCall('knowledge.note.link.delete', { note_id: id, link_id: linkId }, key)
  },
  revisions: (id: string, limit?: number) =>
    get<NoteRevision[]>(`/knowledge/notes/${id}/revisions` + (limit ? `?limit=${limit}` : '')),
  /** With `expectVersion`, refused (409) unless the note is still at that version. */
  rollback: async (id:string,toVersion:number,expectVersion?:number,key:string=crypto.randomUUID()) => {
    const result=await callOperation('knowledge.note.rollback',{note_id:id,to_version:toVersion,expect_version:expectVersion??null},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Note revision restore did not complete');
    return get<Note>(`/knowledge/notes/${encodeURIComponent(result.data.id)}`,{spaceId:result.data.space_id});
  },
  /**
   * Jot a note against an object and link it in one call. Two calls would
   * strand a note whenever the link failed. Do not make the connection by
   * hand across a round trip.
   */
  jot: async (body: NoteJotBody, key: string = crypto.randomUUID()) => currentNote(await noteObjectCall('knowledge.note.jot', body, key)),
  /** Notes citing a non-note object — the reverse of a jot. */
  linkingTo: (objectId: string) => get<EntityLink[]>(`/knowledge/objects/${objectId}/note-links`),
  /**
   * Promote a selected passage into a Knowledge Item. Returns the
   * proposal — the review gate still applies — with the note recorded as
   * provenance.
   */
  promote: async (id: string, body: NotePromoteBody, key:string=crypto.randomUUID()) => {
    const receipt=await noteObjectCall('note.promote_to_knowledge',{...body,note_id:id},key);
    return get<Proposal>(`/proposals/${receipt.id}`,{spaceId:receipt.space_id});
  },
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
  create:     async (data: { title?: string | null; project_id?: string | null; project_folder_id?: string | null; metadata?: Record<string, unknown> | null }, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('session.create', data, key)
    return get<Session>(`/sessions/${encodeURIComponent(receipt.session_id)}`, { spaceId: receipt.space_id })
  },
  get:        (id: string, options: RequestOptions = {})                          => get<Session>(`/sessions/${id}`, options),
  messages:   (id: string, options: RequestOptions = {})                          => get<Message[]>(`/sessions/${id}/messages`, options),
  addMessage: async (id: string, data: { content: string }, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('session.message.add', { ...data, session_id: id }, key)
    const messages = await get<Message[]>(`/sessions/${encodeURIComponent(receipt.session_id)}/messages`, { spaceId: receipt.space_id })
    const message = messages.find(item => item.id === receipt.message_id)
    if (!message) throw new Error('Message no longer available')
    return message
  },
  reflect:    async (id: string, key: string = crypto.randomUUID()): Promise<ReflectResult> => {
    const receipt = await commandReceipt('session.reflect', { session_id: id }, key)
    return { session_id: receipt.session_id, proposals_created: receipt.proposals_created }
  },
  executionContext: (id: string, options: RequestOptions = {}) => get<ConversationExecutionPreflightResponse>(`/sessions/${encodeURIComponent(id)}/execution-context`, options),
  // A read-only query: no key, nothing written.
  preflightExecution: async (id: string, body: ConversationExecutionPreflightRequest, options: RequestOptions = {}): Promise<ConversationExecutionPreflightResponse> => {
    const result = await queryOperation('conversation.execution.preflight', { ...body, session_id: id }, options)
    if (!('status' in result) || result.status !== 'succeeded') throw new Error('Preview did not complete')
    return result.data
  },
  initializeExecution: async (id: string, body: ConversationExecutionInitializeRequest, options: RequestOptions = {}): Promise<ConversationExecutionSummary> => {
    const receipt = await commandReceipt('conversation.execution.initialize', { ...body, session_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return (await sessionsApi.executionContext(receipt.session_id, { ...options, spaceId: receipt.space_id })).summary
  },
  mutateExecutionAttachments: async (id: string, body: ConversationAttachmentMutation, options: RequestOptions = {}): Promise<ConversationAttachmentMutationResponse> => {
    const receipt = await commandReceipt('conversation.execution.attachment.mutate', { ...body, session_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    const context = await sessionsApi.executionContext(receipt.session_id, { ...options, spaceId: receipt.space_id })
    const attachment = context.summary.attachments.find(item => item.id === receipt.attachment_id)
    if (!attachment) throw new Error('Folder attachment no longer available')
    return { attachment, effective_after_run_id: receipt.effective_after_run_id }
  },
  remove:     async (id: string, key: string = crypto.randomUUID()) => { await commandReceipt('session.delete', { session_id: id }, key) },
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
  /** Keyed command; the version is read back through the versions reader. */
  createVersion: async (assetKey: string, body: PromptVersionCreateRequest, key: string = crypto.randomUUID()): Promise<PromptVersion> => {
    const receipt = await commandReceipt('prompt.version.create', { ...body, asset_key: assetKey } as OperationInput<'prompt.version.create'>, key)
    return found(await promptsApi.listVersions(receipt.asset_key), receipt.version_id, 'Prompt version')
  },
  /** Read-only query on the retained URL: no key, nothing written. */
  renderPreview: (assetKey: string, body: PromptRenderPreviewRequest): Promise<PromptRenderPreviewResult> =>
    queryAt<PromptRenderPreviewResult>(`/prompts/assets/${encodeURIComponent(assetKey)}/render-preview`, body),
  /** Keyed command; the receipt names the recorded evaluation run. */
  evaluate: (assetKey: string, body: PromptEvaluationRequest, key: string = crypto.randomUUID()) =>
    commandReceipt('prompt.evaluation.record', { ...body, asset_key: assetKey } as OperationInput<'prompt.evaluation.record'>, key),
  /** Keyed command filing the production promotion Proposal; review stays in Proposals. */
  promote: async (assetKey: string, body: PromptPromotionRequestInput, key: string = crypto.randomUUID()): Promise<PromptPromotionResult> => {
    const { space_id: _space, ...receipt } = await commandReceipt('prompt.promotion.propose', { ...body, asset_key: assetKey } as OperationInput<'prompt.promotion.propose'>, key)
    return receipt
  },
  listDeployments: (assetKey: string, params: { include_history?: boolean } = {}) => {
    const q: Record<string, string> = {}
    if (params.include_history !== undefined) q.include_history = String(params.include_history)
    const query = new URLSearchParams(q).toString()
    return get<PromptDeploymentRef[]>(`/prompts/assets/${encodeURIComponent(assetKey)}/deployments${query ? `?${query}` : ''}`)
  },
  /** Keyed command; the ref is read back through the deployments reader. */
  setDeployment: async (assetKey: string, label: string, body: { version_id: string; scope_type?: PromptAssetScopeType; scope_id?: string | null; promoted_from_proposal_id?: string | null }, key: string = crypto.randomUUID()): Promise<PromptDeploymentRef> => {
    const receipt = await commandReceipt('prompt.deployment.set', { ...body, asset_key: assetKey, label }, key)
    return found(await promptsApi.listDeployments(receipt.asset_key), receipt.deployment_id, 'Prompt deployment')
  },
  rollback: async (assetKey: string, body: PromptRollbackRequest, key: string = crypto.randomUUID()): Promise<PromptDeploymentRef> => {
    const receipt = await commandReceipt('prompt.deployment.rollback', { ...body, asset_key: assetKey } as OperationInput<'prompt.deployment.rollback'>, key)
    return found(await promptsApi.listDeployments(receipt.asset_key), receipt.deployment_id, 'Prompt deployment')
  },
}

// ── Boards (task surfaces) ────────────────────────────────────────────────
export const boardsApi = {
  list:   (params: Record<string, string> = {}, options: { spaceId?: string } = {}) =>
    get<Page<Board>>('/boards?' + new URLSearchParams(params), { spaceId: options.spaceId }),
  // Explicit-key core commands; the Board is read back through its GET.
  create: async (body: OperationInput<'board.create'>, key: string = crypto.randomUUID()) => {
    const receipt = await operationAt<OperationOutput<'board.create'>>('POST', '/boards', body, key)
    return get<Board>(`/boards/${encodeURIComponent(receipt.board_id)}`)
  },
  get:    (id: string) => get<Board>(`/boards/${id}`),
  update: (id: string, body: Omit<OperationInput<'board.update'>, 'board_id'>, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'board.update'>>('PATCH', `/boards/${encodeURIComponent(id)}`, body, key),
  tasks:  (boardId: string, params: Record<string, string> = {}) =>
    get<Page<Task>>(`/boards/${boardId}/tasks?` + new URLSearchParams(params)),
}

// ── Tasks (product work items) ─────────────────────────────────────────────
export const tasksApi = {
  moveToColumn: (id:string, body:Omit<OperationInput<'task.move_to_column'>,'task_id'>, key:string) =>
    callOperation('task.move_to_column',{...body,task_id:id},key),
  delete: (id:string, key:string) => callOperation('task.delete',{task_id:id},key),
  setStatus: (id:string, body:Omit<OperationInput<'task.set_status'>,'task_id'>, key:string) =>
    callOperation('task.set_status',{...body,task_id:id},key),
  linkedThreads:(id:string,after?:string)=>get<TaskInquiryThreadsPage>(`/tasks/${encodeURIComponent(id)}/inquiry-threads${after?`?after_thread_id=${encodeURIComponent(after)}`:''}`),
  workHistory:(id:string,before?:string)=>get<TaskWorkHistoryPage>(`/tasks/${encodeURIComponent(id)}/work-history${before?`?before_seq=${encodeURIComponent(before)}`:''}`),
  work:  (id: string) => get<TaskWorkView>(`/tasks/${id}/work`),
  list:   (params: Record<string, string> = {}) =>
    get<Page<Task>>('/tasks?' + new URLSearchParams(params)),
  // One explicit key per person's create; never retried automatically.
  create: (data: OperationInput<'task.create'>, options: { spaceId?: string } = {}, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'task.create'>>('POST', '/tasks', data, key, { spaceId: options.spaceId }),
  get:    (id: string) => get<Task>(`/tasks/${id}`),
  update: async (id: string, data: Record<string, unknown>, key?:string) => {
    if(Object.prototype.hasOwnProperty.call(data,'board_id')||Object.prototype.hasOwnProperty.call(data,'column_id')){
      // Placement and the accompanying contract edits commit together.
      await callOperation('task.place_in_space_board',{task_id:id,changes:data as OperationInput<'task.place_in_space_board'>['changes']},key??crypto.randomUUID());
      return get<Task>(`/tasks/${id}`);
    }
    await operationAt<OperationOutput<'task.update'>>('PATCH', `/tasks/${encodeURIComponent(id)}`, data, key??crypto.randomUUID())
    return get<Task>(`/tasks/${id}`)
  },
  createRun: (taskId: string, body: TaskRunCreateBody = {}, key: string = crypto.randomUUID()) =>
    // One Run, whichever branch admits it: the remote path creates its Run
    // synchronously, exactly as the server path does.
    operationAt<OperationOutput<'task.run.create'>>('POST', `/tasks/${encodeURIComponent(taskId)}/runs`, body, key),
  runs:   (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskRunListItem>>(`/tasks/${taskId}/runs?` + new URLSearchParams(params)),
  artifacts: (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskArtifact>>(`/tasks/${taskId}/artifacts?` + new URLSearchParams(params)),
  proposals: (taskId: string, params: Record<string, string> = {}) =>
    get<Page<TaskProposal>>(`/tasks/${taskId}/proposals?` + new URLSearchParams(params)),
  requestPlan: (taskId: string, body: Omit<OperationInput<'task.plan.request'>, 'task_id'> = {}, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'task.plan.request'>>('POST', `/tasks/${encodeURIComponent(taskId)}/plan-requests`, body, key),
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
  retrievalSearch: (data: CrossSpaceRetrievalRequest, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.search'>>('POST','/me/retrieval/search',data,key,{includeSpaceContext:false}),
  resolveRetrievalPointers: (pointerIds: string[], key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.resolve'>>('POST','/me/retrieval/pointers/resolve',{pointer_ids:pointerIds},key,{includeSpaceContext:false}),
  storeSourceSummary: (pointerIds: string[], summary: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.summary.store'>>('POST','/me/retrieval/summaries',{pointer_ids:pointerIds,summary},key,{includeSpaceContext:false}),
  discloseFusedStore: (pointerIds: string[], key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.egress.disclose'>>('POST','/me/retrieval/egress/disclose',{pointer_ids:pointerIds},key,{includeSpaceContext:false}),
  storeFusedConclusion: (disclosureId: string, pointerIds: string[], conclusion: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal.retrieval.fused.store'>>('POST','/me/retrieval/fused-conclusions',{disclosure_id:disclosureId,pointer_ids:pointerIds,conclusion},key,{includeSpaceContext:false}),
  notifications: () =>
    get<{ items: SpaceMemberNotification[] }>('/me/notifications', { includeSpaceContext: false }),
}

export const spaceEgressApi = {
  updateNotifications: (spaceId: string, enabled: boolean, idempotencyKey: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'space.egress_notifications.update'>>('PATCH',`/spaces/${encodeURIComponent(spaceId)}/egress-notifications`, {
      egress_notifications_enabled: enabled,
    }, idempotencyKey),
}

// ── Runs (canonical API) ──────────────────────────────────────────────────
export const runsApi = {
  filePreview: (id: string, path: string, options?: RequestOptions) => request<RunFilePreview>("GET", `/runs/${id}/file-preview?path=${encodeURIComponent(path)}`, undefined, options),
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
  get:    (id: string, options: RequestOptions = {}) => get<Run>(`/runs/${id}`, options),
  logicalIO: (id: string, options: RequestOptions = {}) => get<RunLogicalIO>(`/runs/${id}/io`, options),
  status: (id: string, options: RequestOptions = {}) => get<RunStatusOut>(`/runs/${id}/status`, options),
  // One keyed command; the process stop completes before the reply, then the Run is re-read.
  stop:   async (id: string, options: RequestOptions = {}) => {
    const receipt = await commandReceipt('run.stop', { run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`, { ...options, spaceId: receipt.space_id })
  },
  liveInput: (id: string, options: RequestOptions = {}) => get<RunLiveInputAvailability>(`/runs/${id}/live-input`, options),
  sendLiveInput: async (id: string, body: RunLiveInputRequest, options: RequestOptions = {}): Promise<RunLiveInputResult> => {
    const receipt = await commandReceipt('run.live_input.submit', { ...body, run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    // Delivery is the server's committed obligation after commit; its outcome is read back for this
    // message. An outcome not yet recorded stays `pending` — never reported as not delivered.
    const path = `/runs/${encodeURIComponent(receipt.run_id)}/live-input?message_id=${encodeURIComponent(receipt.message_id)}`
    let state: RunLiveInputResult['state'] = 'pending'
    for (let attempt = 0; attempt < LIVE_INPUT_READBACK_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, LIVE_INPUT_READBACK_DELAY_MS))
      const read = await get<RunLiveInputAvailability & { delivery_state?: string | null }>(path, { ...options, spaceId: receipt.space_id })
      const known = read.delivery_state === 'injected' || read.delivery_state === 'unconfirmed' || read.delivery_state === 'not_injected' ? read.delivery_state : null
      if (known) { state = known; break }
      if (options.signal?.aborted) break
    }
    return { state, message_id: receipt.message_id, delivery_id: null }
  },
  // The new recovery choice is read back with the Run's turn; the command returns identities only.
  quotaRecovery: async (id: string, autoContinue: boolean, options: RequestOptions = {}, switchModel = false): Promise<void> => {
    await commandReceipt('run.quota_recovery.update', { run_id: id, auto_continue: autoContinue, ...(switchModel ? { switch_model: true } : {}) }, options.idempotencyKey ?? crypto.randomUUID(), options)
  },
  // Queues the Run's Job; execution happens in the worker, not in this request.
  executeQueuedRun: async (id: string, options: RequestOptions = {}) => {
    const receipt = await commandReceipt('run.execute', { run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`, { ...options, spaceId: receipt.space_id })
  },
  resume: async (id: string, options: RequestOptions = {}) => {
    const { space_id: _space, run_id: _run, ...receipt } = await commandReceipt('run.resume', { run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return receipt
  },
  abandon: async (id: string, body: { reason?: string | null } = {}, options: RequestOptions = {}) => {
    const { space_id: _space, run_id: _run, ...receipt } = await commandReceipt('run.abandon', { ...body, run_id: id }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return receipt
  },
  activities: (id: string, params: Record<string, string> = {}, options: RequestOptions = {}) =>
    get<Page<ActivityInboxRecord>>(`/runs/${id}/activities?` + new URLSearchParams(params), options),
  artifacts: (id: string, params: Record<string, string> = {}, options: RequestOptions = {}) =>
    get<Page<Artifact>>(`/runs/${id}/artifacts?` + new URLSearchParams(params), options),
  proposals: (id: string, params: Record<string, string> = {}, options: RequestOptions = {}) =>
    get<Page<Proposal>>(`/runs/${id}/proposals?` + new URLSearchParams(params), options),
  authorizationRequests: (id: string, options: RequestOptions = {}) =>
    get<AuthorizationRequest[]>(`/runs/${id}/authorization-requests`, options),
  attempts: (id: string, options: RequestOptions = {}) => get<{ attempts: RunAttempt[]; supervisor_decisions: RunSupervisorDecision[] }>(`/runs/${id}/attempts`, options),
  evaluations: (id: string, options: RequestOptions = {}) => get<RunEvaluation[]>(`/runs/${id}/evaluations`, options),
  verifications: (id: string, options: RequestOptions = {}) => get<RunVerificationResult[]>(`/runs/${id}/verifications`, options),
  finalizations: (id: string, options: RequestOptions = {}) => get<RunFinalization[]>(`/runs/${id}/finalizations`, options),
  routeDecision: (id: string, options: RequestOptions = {}) => get<Record<string, unknown>>(`/runs/${id}/route-decision`, options),
  /**
   * The turn as it stands. For a surface showing a turn that has stopped —
   * one waiting on a person, say — where streaming would poll forever.
   */
  turn: (id: string, options: RequestOptions = {}) => get<RunTurn>(`/runs/${encodeURIComponent(id)}/turn`, options),
  /** The live turn, as parts. See `streamTurnParts`. */
  streamTurn: (
    id: string,
    options: { spaceId?: string; signal?: AbortSignal; onTurn: (turn: RunTurn) => void },
  ) => streamTurnParts(id, options),
}

async function decideAuthorizationRequest(id:string,decision:'approve'|'reject',options:RequestOptions):Promise<AuthorizationRequest>{
  const receipt=await operationAt<{run_id:string;request_id:string}>('POST',`/authorization-requests/${encodeURIComponent(id)}/${decision}`,{},options.idempotencyKey??crypto.randomUUID(),options)
  const rows=await get<AuthorizationRequest[]>(`/runs/${encodeURIComponent(receipt.run_id)}/authorization-requests`,options)
  const request=rows.find(row=>row.id===receipt.request_id)
  if(!request)throw new Error('Authorization request no longer available')
  return request
}
export const authorizationRequestsApi = {
  approve: (id: string, options: RequestOptions = {}) => decideAuthorizationRequest(id,'approve',options),
  reject: (id: string, options: RequestOptions = {}) => decideAuthorizationRequest(id,'reject',options),
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
  execute: (id: string, body: PlanExecuteBody, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'plan.execute'>>('POST', `/plans/${encodeURIComponent(id)}/execute`, body, key),
  reconcile: (id: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'plan.reconcile'>>('POST', `/plans/${encodeURIComponent(id)}/reconcile`, {}, key),
}

/** A live input's recorded outcome is read back briefly; past that it is reported as still pending. */
const LIVE_INPUT_READBACK_ATTEMPTS = 6
const LIVE_INPUT_READBACK_DELAY_MS = 500
/** Current Room roster after a roster command; the receipt names only the Room. */
async function roomDetailAfter(receipt:{room_id:string;space_id:string},options:RequestOptions={}):Promise<RoomDetail>{
  return get<RoomDetail>(`/rooms/${encodeURIComponent(receipt.room_id)}`,{...options,spaceId:receipt.space_id})
}
async function roomMutationAfter(receipt:{room_id:string;space_id:string},options:RequestOptions={},revoked=0):Promise<RoomAgentMutationResponse>{
  return {...await roomDetailAfter(receipt,options),revoked_grant_count:revoked}
}
async function roomInvitationAfter(receipt:{room_id:string;space_id:string;invitation_id:string}):Promise<RoomInvitation>{
  // The exact invitation, however many newer ones exist; access is the page's.
  const page=await get<RoomInvitationListResponse>(`/rooms/${encodeURIComponent(receipt.room_id)}/invitations?limit=1&invitation_id=${encodeURIComponent(receipt.invitation_id)}`,{spaceId:receipt.space_id})
  const invitation=page.items.find(item=>item.id===receipt.invitation_id);if(!invitation)throw new Error('Room invitation no longer available');return invitation
}
/** The receipt's exact message (an old one on replay, too) with the conversation it belongs to. */
async function turnAfter(receipt:{room_id:string;session_id:string;space_id:string;message_id:string},options:RequestOptions={}){
  const q=new URLSearchParams({limit:'1',message_id:receipt.message_id})
  const page=await get<{items:RoomMessage[];conversation?:RoomConversation}>(`/rooms/${encodeURIComponent(receipt.room_id)}/conversations/${encodeURIComponent(receipt.session_id)}/messages?${q}`,{...options,spaceId:receipt.space_id})
  return turnFrom(page,receipt.message_id)
}
/** The posted turn's message and conversation, read back from the conversation page. */
function turnFrom(page:{items:RoomMessage[];conversation?:RoomConversation},messageId:string):{message:RoomMessage;conversation:RoomConversation}{
  const message=page.items.find(item=>item.id===messageId)
  if(!message||!page.conversation)throw new Error('Room message no longer available')
  return {message,conversation:page.conversation}
}
/** A keyed command at a retained URL whose adapter owns a pre-transaction step; never retried. */
async function operationAt<T>(method:'POST'|'PUT'|'PATCH'|'DELETE',path:string,body:unknown,key:string,options:RequestOptions={}):Promise<T>{
  const result=await request<OperationOutcome<T>>(method,path,body,{...options,idempotencyKey:key})
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Command did not complete')
  return result.data
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
  create: async (body: CreateRoomRequest, idempotencyKey: string = crypto.randomUUID()): Promise<CreateRoomResponse> =>
    roomDetailAfter(await commandReceipt('room.create', body, idempotencyKey)),
  get: (roomId: string, options: RequestOptions = {}) => get<RoomDetail>(`/rooms/${roomId}`, options),
  /** Copy picked content into a conversation that already exists. */
  attachReferences: async (
    roomId: string,
    sessionId: string,
    body: { references: ThreadReferencePick[]; confirm_disclosure?: boolean | string[] }, options: RequestOptions = {},
  ) => {
    // The retained URL, not the generic entry: it prepares owner-funded imported-session summaries before the command.
    const receipt = await operationAt<OperationOutput<'room.conversation.attach_references'>>('POST', `/rooms/${encodeURIComponent(roomId)}/conversations/${encodeURIComponent(sessionId)}/references`, body, options.idempotencyKey ?? crypto.randomUUID(), options)
    const page = await roomsApi.messages(receipt.room_id, receipt.session_id, { limit: 50 }, { ...options, spaceId: receipt.space_id })
    return { items: page.items, task_group_ids: page.task_group_ids, conversation: page.conversation ?? null, limit: page.limit, offset: page.offset }
  },
  agentCandidates: (roomId: string, params: { q?: string; limit?: number; offset?: number } = {}) =>
    get<RoomAgentCandidatesResponse>(`/rooms/${roomId}/agent-candidates?${pageQuery(params)}`),
  // Host restore/archive happen after the roster commits; the receipt says whether a restore was requested.
  addAgent: async (roomId: string, body: RoomAgentAddRequest, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.add', { ...body, room_id: roomId }, key)),
  addAgentPreset: async (roomId: string, body: RoomAgentPresetRequest, idempotencyKey: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.add_preset', { ...body, room_id: roomId }, idempotencyKey)),
  removeAgent: async (roomId: string, agentId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> => {
    const receipt = await commandReceipt('room.agent.remove', { room_id: roomId, agent_id: agentId }, key)
    return roomMutationAfter(receipt, {}, receipt.revoked_grant_count)
  },
  invitations: (roomId: string, params: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<RoomInvitationListResponse>(`/rooms/${roomId}/invitations?${q}`)
  },
  inviteUser: async (roomId: string, body: RoomInvitationCreateRequest, key: string = crypto.randomUUID()) =>
    roomInvitationAfter(await commandReceipt('room.invitation.create', { ...body, room_id: roomId }, key)),
  decideInvitation: async (roomId: string, invitationId: string, body: RoomInvitationDecisionRequest, key: string = crypto.randomUUID()) =>
    roomInvitationAfter(await commandReceipt('room.invitation.decide', { ...body, room_id: roomId, invitation_id: invitationId }, key)),
  removeUser: async (roomId: string, userId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse | null> => {
    const receipt = await commandReceipt('room.member.remove', { room_id: roomId, user_id: userId }, key)
    // Leaving may end the person's own access; the roster is then simply no longer theirs to read.
    return roomMutationAfter(receipt).catch(() => null)
  },
  transferOwner: async (roomId: string, body: RoomOwnerTransferRequest, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.owner.transfer', { ...body, room_id: roomId }, key)),
  claimOwner: async (roomId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.owner.claim', { room_id: roomId }, key)),
  resetAgentContext: async (roomId: string, agentId: string, sessionId?: string, options: RequestOptions = {}): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.reset_context', { room_id: roomId, agent_id: agentId, ...(sessionId ? { session_id: sessionId } : {}) }, options.idempotencyKey ?? crypto.randomUUID(), options), options),
  summarizeAgentContext: async (roomId: string, agentId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.summarize_context', { room_id: roomId, agent_id: agentId }, key)),
  restartFromSummary: async (roomId: string, agentId: string, key: string = crypto.randomUUID()): Promise<RoomAgentMutationResponse> =>
    roomMutationAfter(await commandReceipt('room.agent.restart_from_summary', { room_id: roomId, agent_id: agentId }, key)),
  conversations: (roomId: string, params: { limit?: number; offset?: number } = {}, options: RequestOptions = {}) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return get<Page<RoomConversation>>(`/rooms/${roomId}/conversations?${q}`, options)
  },
  conversationDefaults: async (roomId: string, options: RequestOptions = {}) => {
    const result = await queryOperation('room.settings.read', {room_id:roomId}, options)
    if (!('status' in result) || result.status !== 'succeeded') throw new Error('Room settings unavailable')
    return result.data
  },
  saveConversationDefaults: async (roomId: string, defaults: import('@rainver/protocol').RoomConversationDefault[], expectedRevision: number, options: RequestOptions = {}) => {
    await commandReceipt('room.defaults.save', {room_id:roomId,defaults,expected_revision:expectedRevision}, options.idempotencyKey ?? crypto.randomUUID(),options)
  },
  createConversation: async (roomId: string, options: RequestOptions = {}): Promise<RoomConversation> => {
    const receipt = await commandReceipt('room.conversation.create', { room_id: roomId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    const page = await roomsApi.messages(receipt.room_id, receipt.session_id, { limit: 1 }, { ...options, spaceId: receipt.space_id })
    if (!page.conversation) throw new Error('Room conversation no longer available')
    return page.conversation
  },
  messages: (
    roomId: string,
    sessionId: string,
    params: { limit?: number; offset?: number } = {}, options: RequestOptions = {},
  ) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set('limit', String(params.limit))
    if (params.offset !== undefined) q.set('offset', String(params.offset))
    return (
    get<{
      items: RoomMessage[]
      /** What people said while the turn was taken, not yet posted. */
      queued?: QueuedRoomMessage[]
      conversation?: RoomConversation
      task_group_ids: string[]
      limit: number
      offset: number
    }>(`/rooms/${roomId}/conversations/${sessionId}/messages?${q}`, options)
    )
  },
  sendMessage: async (
    roomId: string,
    sessionId: string,
    body: Omit<SendRoomMessageRequest, 'input_parts' | 'queue'> & { input_parts?: ConversationInputPart[]; queue?: boolean }, options: RequestOptions = {},
  ): Promise<{ message: RoomMessage; conversation: RoomConversation; task_group_ids: string[]; run_ids: string[] } | QueuedRoomMessageResponse> => {
    const receipt = await commandReceipt('room.message.send', { ...body, room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    if (receipt.status === 'queued') {
      // Queued messages are listed whole with any page; only one item is needed.
      const page = await roomsApi.messages(receipt.room_id, receipt.session_id, { limit: 1 }, { ...options, spaceId: receipt.space_id })
      const queued = page.queued?.find(item => item.id === receipt.queued_id)
      if (!queued) throw new Error('Queued message no longer available')
      return { queued }
    }
    return { ...await turnAfter(receipt, options), task_group_ids: receipt.task_group_ids, run_ids: receipt.run_ids }
  },
  /** Takes back one's own message that is still waiting for the turn. */
  withdrawQueuedMessage: async (roomId: string, sessionId: string, queuedId: string, options: RequestOptions = {}) => {
    const receipt = await commandReceipt('room.message.withdraw_queued', { room_id: roomId, session_id: sessionId, queued_id: queuedId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return { id: receipt.queued_id }
  },
  retryMessage: async (roomId: string, sessionId: string, runId: string, options: RequestOptions = {}): Promise<Omit<ConversationRetryResponse, 'reused'>> => {
    const { space_id: _space, room_id: _room, ...retry } = await commandReceipt('room.message.retry', { room_id: roomId, session_id: sessionId, run_id: runId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return retry
  },
  continueAfterProposal: async (
    roomId: string,
    sessionId: string,
    body: ContinueRoomAfterProposalRequest, options: RequestOptions = {},
  ): Promise<{ message: RoomMessage; conversation: RoomConversation; task_group_ids: string[]; run_ids: string[] }> => {
    const receipt = await commandReceipt('room.message.continue_after_proposal', { ...body, room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return { ...await turnAfter(receipt, options), task_group_ids: receipt.task_group_ids, run_ids: receipt.run_ids }
  },
  /** Posts the topic as the person's message and dispatches the first wave; 409 while another discussion is active. */
  openDiscussion: async (roomId: string, sessionId: string, body: OpenRoomDiscussionRequest, options: RequestOptions = {}): Promise<OpenRoomDiscussionResponse> => {
    const receipt = await commandReceipt('room.discussion.start', { ...body, room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    const scoped = { ...options, spaceId: receipt.space_id }
    const [turn, detail] = await Promise.all([turnAfter(receipt, options), roomsApi.discussion(receipt.room_id, receipt.session_id, receipt.discussion_id, scoped)])
    return { ...turn, task_group_ids: receipt.task_group_ids, run_ids: receipt.run_ids, discussion: detail.discussion }
  },
  /** Newest first. */
  discussions: (roomId: string, sessionId: string, options: RequestOptions = {}) =>
    get<RoomDiscussionListResponse>(`/rooms/${roomId}/conversations/${sessionId}/discussions`, options),
  discussion: (roomId: string, sessionId: string, discussionId: string, options: RequestOptions = {}) =>
    get<RoomDiscussionDetail>(`/rooms/${roomId}/conversations/${sessionId}/discussions/${discussionId}`, options),
  /** No further waves; the Manager then writes the conclusion. */
  stopDiscussion: async (roomId: string, sessionId: string, discussionId: string, options: RequestOptions = {}): Promise<RoomDiscussion> => {
    const receipt = await commandReceipt('room.discussion.stop', { room_id: roomId, session_id: sessionId, discussion_id: discussionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return (await roomsApi.discussion(receipt.room_id, receipt.session_id, receipt.discussion_id, { ...options, spaceId: receipt.space_id })).discussion
  },
  /** Adds rounds; on an emergent discussion held at its cap this also opens it. */
  extendDiscussion: async (roomId: string, sessionId: string, discussionId: string, body: ExtendRoomDiscussionRequest, options: RequestOptions = {}): Promise<RoomDiscussion> => {
    const receipt = await commandReceipt('room.discussion.extend', { ...body, room_id: roomId, session_id: sessionId, discussion_id: discussionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return (await roomsApi.discussion(receipt.room_id, receipt.session_id, receipt.discussion_id, { ...options, spaceId: receipt.space_id })).discussion
  },
  /** The Space's quota lines, the windows of the logins this conversation's Agents use, and what is held. */
  conversationQuota: (roomId: string, sessionId: string, options: RequestOptions = {}) =>
    get<RoomConversationQuota>(`/rooms/${roomId}/conversations/${sessionId}/quota`, options),
  /** "Continue anyway": admits the Agent-triggered turns held at the reserve line (Project writer). */
  continuePastQuota: async (roomId: string, sessionId: string, options: RequestOptions = {}): Promise<RoomConversationQuota> => {
    const receipt = await commandReceipt('room.quota.continue', { room_id: roomId, session_id: sessionId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return roomsApi.conversationQuota(receipt.room_id, receipt.session_id, { ...options, spaceId: receipt.space_id })
  },
}

// ── Personal Memory Grants ─────────────────────────────────────────────────
export const personalMemoryGrantsApi = {
  previewPersonalMemoryGrant: (input: PersonalMemoryGrantPreviewRequest, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal_memory_grant.preview'>>('POST','/personal-memory-grants/preview',input,key),
  createPersonalMemoryGrant: (input: PersonalMemoryGrantCreateRequest, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal_memory_grant.create'>>('POST','/personal-memory-grants',input,key),
  listPersonalMemoryGrants: (filters: { status?: string; target_space_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (filters.status !== undefined) q.status = filters.status
    if (filters.target_space_id !== undefined) q.target_space_id = filters.target_space_id
    return get<PersonalMemoryGrantResponse[]>('/personal-memory-grants?' + new URLSearchParams(q))
  },
  revokePersonalMemoryGrant: (grantId: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'personal_memory_grant.revoke'>>('POST',`/personal-memory-grants/${grantId}/revoke`,{},key),
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
  get: (id: string, params: { project_folder_id?: string } = {}, options: RequestOptions = {}) => {
    const q: Record<string, string> = {}
    if (params.project_folder_id !== undefined) q.project_folder_id = params.project_folder_id
    const suffix = new URLSearchParams(q).toString()
    return get<Artifact>(`/artifacts/${id}${suffix ? `?${suffix}` : ''}`, options)
  },
  export: (id: string, params: { project_folder_id?: string } = {}, options: RequestOptions = {}) => downloadArtifactExport(id, params, options),
}

async function downloadArtifactExport(
  artifactId: string,
  params: { project_folder_id?: string } = {},
  options: RequestOptions = {},
): Promise<void> {
  const authGeneration = _authContextGeneration
  const assertCurrent = () => {
    if (authGeneration !== _authContextGeneration || options.signal?.aborted) {
      throw new DOMException('Download cancelled', 'AbortError')
    }
  }
  const headers: Record<string, string> = {}
  if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
  headers['X-Rainver-Space-Id'] = options.spaceId ?? _spaceId
  const sep = '/artifacts/' + artifactId + '/export'
  const query = new URLSearchParams()
  if (params.project_folder_id !== undefined) query.set('project_folder_id', params.project_folder_id)
  const artifactParams = query.toString()
  const url = BASE + sep + (artifactParams ? `?${artifactParams}` : '')
  const r = await fetch(url, { method: 'GET', headers, signal: options.signal })
  assertCurrent()
  if (r.status === 401) window.dispatchEvent(new CustomEvent('auth:required'))
  if (r.status === 404) throw new ApiRequestError('Artifact not found or not exportable', 404)
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try {
      const err = await r.json() as ApiError
      msg = formatApiErrorMessage(err, msg)
    } catch {
      const text = await r.text().catch(() => '')
      if (text) msg = text
    }
    throw new ApiRequestError(msg, r.status)
  }
  const cd = r.headers.get('Content-Disposition')
  let filename = 'artifact'
  if (cd) {
    const m = /filename="([^"]+)"/.exec(cd) ?? /filename=([^;]+)/.exec(cd)
    if (m) filename = m[1].trim()
  }
  const blob = await r.blob()
  assertCurrent()
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
  get: (id: string, options: RequestOptions = {}) => get<Proposal>(`/proposals/${id}`, options),
  accept: (id: string, options: RequestOptions & { confirmIncompletePatch?: boolean } = {}) => {
    return operationAt<OperationOutput<'proposal.accept'>>('POST', `/proposals/${encodeURIComponent(id)}/accept`, {confirm_incomplete_patch:options.confirmIncompletePatch??false}, options.idempotencyKey ?? crypto.randomUUID(), options)
  },
  rollback: (id: string, options: RequestOptions = {}) => operationAt<OperationOutput<'proposal.rollback'>>('POST', `/proposals/${encodeURIComponent(id)}/rollback`, {}, options.idempotencyKey ?? crypto.randomUUID(), options),
  reject: (id: string, options: RequestOptions = {}) => operationAt<OperationOutput<'proposal.reject'>>('POST', `/proposals/${encodeURIComponent(id)}/reject`, {}, options.idempotencyKey ?? crypto.randomUUID(), options),
  approveEgressGrantingUserProposal: (id: string, input: EgressApprovalRequest = {}, options: RequestOptions = {}) =>
    operationAt<OperationOutput<'proposal.egress.approve'>>('POST', `/proposals/${encodeURIComponent(id)}/approvals/egress-granting-user`, input, options.idempotencyKey ?? crypto.randomUUID(), options),
}

// ── Evolution ─────────────────────────────────────────────────────────────
/** A Run start the selector declined: its decision is recorded, no Run or Job exists. */
export class EvolutionRunNotSelected extends Error {
  constructor(message: string, readonly selectorDecisionId: string) {
    super(message)
    this.name = 'EvolutionRunNotSelected'
  }
}

export const evolutionApi = {
  summary: () => get<EvolutionSummaryOut>('/evolution/summary'),
  targets: (params: { status?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    const query = new URLSearchParams(q).toString()
    return get<EvolutionTarget[]>(query ? `/evolution/targets?${query}` : '/evolution/targets')
  },
  /** Keyed command; the target is read back through its authorized reader. */
  createTarget: async (body: EvolutionTargetCreateBody, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionTarget> => {
    const receipt = await commandReceipt('evolution.target.create', body as OperationInput<'evolution.target.create'>, idempotencyKey)
    return get<EvolutionTarget>(`/evolution/targets/${encodeURIComponent(receipt.target_id)}`, { spaceId: receipt.space_id })
  },
  target: (id: string) => get<EvolutionTarget>(`/evolution/targets/${id}`),
  updateTarget: async (id: string, body: EvolutionTargetUpdateBody, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionTarget> => {
    const receipt = await commandReceipt('evolution.target.update', { ...body, target_id: id } as OperationInput<'evolution.target.update'>, idempotencyKey)
    return get<EvolutionTarget>(`/evolution/targets/${encodeURIComponent(receipt.target_id)}`, { spaceId: receipt.space_id })
  },
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
  signal: (signalId: string, options?: RequestOptions) => get<EvolutionSignal>(`/evolution/signals/${encodeURIComponent(signalId)}`, options),
  /** Keyed triage; the signal is read back through its authorized reader. */
  updateSignal: async (signalId: string, body: { triage_status: 'new' | 'acknowledged' | 'dismissed' | 'actioned'; triage_note?: string | null }, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionSignal> => {
    const receipt = await commandReceipt('evolution.signal.triage', { ...body, signal_id: signalId }, idempotencyKey)
    return evolutionApi.signal(receipt.signal_id, { spaceId: receipt.space_id })
  },
  dismissSignal: (signalId: string, body: { triage_note?: string | null } = {}, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionSignal> =>
    evolutionApi.updateSignal(signalId, { ...body, triage_status: 'dismissed' }, idempotencyKey),
  createSignal: async (targetId: string, body: EvolutionSignalCreateBody, idempotencyKey: string = crypto.randomUUID()): Promise<EvolutionSignal> => {
    const receipt = await commandReceipt('evolution.signal.create', { ...body, target_id: targetId } as OperationInput<'evolution.signal.create'>, idempotencyKey)
    return evolutionApi.signal(receipt.signal_id, { spaceId: receipt.space_id })
  },
  runs: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionRunListItem[]>('/evolution/runs?' + new URLSearchParams(q))
  },
  /** Keyed command queuing the dry-run Evolution Run with its Job; it executes in the background. */
  runTarget: async (targetId: string, body: Omit<OperationInput<'evolution.target.run'>, 'target_id'>, key: string = crypto.randomUUID()): Promise<EvolutionRunResult> => {
    const receipt = await commandReceipt('evolution.target.run', { ...body, target_id: targetId }, key)
    if (receipt.status === 'not_selected') throw new EvolutionRunNotSelected(receipt.reason, receipt.selector_decision_id)
    return { run_id: receipt.run_id, target_id: receipt.target_id, selector_decision_id: receipt.selector_decision_id, selected_strategy_key: receipt.selected_strategy_key, run_status: 'queued', proposal_ids: [] }
  },
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
  /** Keyed command; the asset is read back through its reader. */
  createAsset: async (body: OperationInput<'evolution.asset.create'>, key: string = crypto.randomUUID()): Promise<EvolvableAsset> => {
    const receipt = await commandReceipt('evolution.asset.create', body, key)
    return get<EvolvableAsset>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}`, { spaceId: receipt.space_id })
  },
  asset: (assetId: string) =>
    get<EvolvableAsset>(`/evolution/assets/${encodeURIComponent(assetId)}`),
  assetVersions: (assetId: string) =>
    get<EvolvableAssetVersion[]>(`/evolution/assets/${encodeURIComponent(assetId)}/versions`),
  createAssetVersion: async (assetId: string, body: Omit<OperationInput<'evolution.asset.version.create'>, 'asset_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetVersion> =>
    assetVersionOf(await commandReceipt('evolution.asset.version.create', { ...body, asset_id: assetId }, key)),
  /** The server's strict schema validates the status. */
  transitionAssetVersion: async (assetId: string, versionId: string, body: { status: string }, key: string = crypto.randomUUID()): Promise<EvolvableAssetVersion> =>
    assetVersionOf(await commandReceipt('evolution.asset.version.transition', { status: body.status as OperationInput<'evolution.asset.version.transition'>['status'], asset_id: assetId, version_id: versionId }, key)),
  assetPins: (assetId: string) =>
    get<EvolvableAssetPin[]>(`/evolution/assets/${encodeURIComponent(assetId)}/pins`),
  setAssetPin: async (assetId: string, scopeType: OperationInput<'evolution.asset.pin.set'>['scope_type'], scopeId: string, body: { version_id: string; reason?: string | null }, key: string = crypto.randomUUID()): Promise<EvolvableAssetPin> => {
    const receipt = await commandReceipt('evolution.asset.pin.set', { ...body, asset_id: assetId, scope_type: scopeType, scope_id: scopeId }, key)
    return found(await get<EvolvableAssetPin[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/pins`, { spaceId: receipt.space_id }), receipt.pin_id!, 'Asset pin')
  },
  deleteAssetPin: async (assetId: string, scopeType: OperationInput<'evolution.asset.pin.archive'>['scope_type'], scopeId: string, key: string = crypto.randomUUID()): Promise<null> => {
    await commandReceipt('evolution.asset.pin.archive', { asset_id: assetId, scope_type: scopeType, scope_id: scopeId }, key)
    return null
  },
  /** Read-only query on the retained URL. */
  resolveAsset: (assetId: string, body: Omit<OperationInput<'evolution.asset.resolve'>, 'asset_id'> = {}) =>
    queryAt<ResolvedEvolvableAssetVersion>(`/evolution/assets/${encodeURIComponent(assetId)}/resolve`, body),
  assetEvaluationRuns: (assetId: string) =>
    get<EvolvableAssetEvaluationRun[]>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-runs`),
  evaluationCases: (assetId: string) =>
    get<EvolvableAssetEvaluationCase[]>(`/evolution/assets/${encodeURIComponent(assetId)}/evaluation-cases`),
  /** Keyed commands; the case is read back through the cases reader. */
  createEvaluationCase: async (assetId: string, body: Omit<OperationInput<'evolution.asset.evaluation_case.create'>, 'asset_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetEvaluationCase> =>
    evaluationCaseOf(await commandReceipt('evolution.asset.evaluation_case.create', { ...body, asset_id: assetId }, key)),
  createEvaluationCaseFromRun: async (assetId: string, body: Omit<OperationInput<'evolution.asset.evaluation_case.create_from_run'>, 'asset_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetEvaluationCase> =>
    evaluationCaseOf(await commandReceipt('evolution.asset.evaluation_case.create_from_run', { ...body, asset_id: assetId }, key)),
  /** Queues the evaluation Job; the queued evaluation run is read back through its reader. */
  executeEvaluation: async (assetId: string, versionId: string, caseId: string, body: { candidate_run_id: string }, key: string = crypto.randomUUID()): Promise<{ evaluation_run: EvolvableAssetEvaluationRun; job_id: string; connector_mode: string }> => {
    const receipt = await commandReceipt('evolution.asset.evaluation.execute', { ...body, asset_id: assetId, version_id: versionId, case_id: caseId }, key)
    return { evaluation_run: await evaluationRunOf(receipt), job_id: receipt.job_id, connector_mode: receipt.connector_mode }
  },
  updateAssetVersion: async (assetId: string, versionId: string, body: { content_json?: Record<string, unknown>; content_ref?: string | null; content_hash?: string | null }, key: string = crypto.randomUUID()): Promise<EvolvableAssetVersion> =>
    assetVersionOf(await commandReceipt('evolution.asset.version.update', { ...body, asset_id: assetId, version_id: versionId }, key)),
  recordAssetEvaluation: async (assetId: string, versionId: string, body: Omit<OperationInput<'evolution.asset.evaluation.record'>, 'asset_id' | 'version_id'>, key: string = crypto.randomUUID()): Promise<EvolvableAssetEvaluationRun> =>
    evaluationRunOf(await commandReceipt('evolution.asset.evaluation.record', { ...body, asset_id: assetId, version_id: versionId }, key)),
  /** Keyed command filing the promotion Proposal; review and apply stay in Proposals. */
  createAssetPromotionProposal: async (assetId: string, versionId: string, body: Omit<OperationInput<'evolution.asset.promotion.propose'>, 'asset_id' | 'version_id'>, key: string = crypto.randomUUID()): Promise<{ proposal_id: string; status: string; proposal_type: string }> => {
    const { space_id: _space, ...receipt } = await commandReceipt('evolution.asset.promotion.propose', { ...body, asset_id: assetId, version_id: versionId }, key)
    return receipt
  },
  bundles: (params: { limit?: number; offset?: number } = {}) => {
    const q: Record<string, string> = {}
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<EvolutionBundle[]>(`/evolution/bundles?${new URLSearchParams(q)}`)
  },
  /** Keyed command; the bundle is read back through its reader. Deciding it stays on the Proposal decision path. */
  createBundle: async (body: { title: string; description?: string | null; proposal_ids: string[] }, key: string = crypto.randomUUID()): Promise<EvolutionBundle> => {
    const receipt = await commandReceipt('evolution.bundle.create', body, key)
    return get<EvolutionBundle>(`/evolution/bundles/${encodeURIComponent(receipt.bundle_id)}`, { spaceId: receipt.space_id })
  },
  bundle: (id: string) => get<EvolutionBundle>(`/evolution/bundles/${encodeURIComponent(id)}`),
  decideBundle: (id: string, decisions: Array<{ proposal_id: string; decision: 'approve' | 'reject'; note?: string | null }>) =>
    operationAt<OperationOutput<'evolution.bundle.decide'>>('POST', `/evolution/bundles/${encodeURIComponent(id)}/decide`, { decisions }, crypto.randomUUID()).then(() => evolutionApi.bundle(id)),
  rollbackBundle: (id: string) => operationAt<OperationOutput<'evolution.bundle.rollback'>>('POST', `/evolution/bundles/${encodeURIComponent(id)}/rollback`, {}, crypto.randomUUID()).then(() => evolutionApi.bundle(id)),
  /** Read-only query on the retained URL. */
  previewWorkflowFromRun: (body: OperationInput<'evolution.workflow.preview'>) =>
    queryAt<Record<string, unknown>>('/evolution/workflows/from-run/preview', body),
  /** Keyed command; the receipt says whether a draft was saved or a Proposal filed. */
  saveWorkflowFromRun: async (body: OperationInput<'evolution.workflow.save'>, key: string = crypto.randomUUID()): Promise<SaveWorkflowFromRunResult> => {
    const { space_id: _space, ...receipt } = await commandReceipt('evolution.workflow.save', body, key)
    return receipt
  },
}

/** What saving a Run as a Workflow created: a Proposal to review, or a draft asset version. */
export type SaveWorkflowFromRunResult =
  | { status: 'proposal_required'; proposal_id: string; proposal_type: string; risk_level: string }
  | { status: 'draft_saved'; asset_id: string; version_id: string; version_status: 'draft'; risk_level: string }

// ── Agents ────────────────────────────────────────────────────────────────
/** Current Profile view after a Profile command; the receipt carries only identities. */
async function runtimeProfile(receipt:{agent_id:string;profile_id:string;space_id:string}):Promise<AgentRuntimeProfileOut>{
  const profiles=await get<AgentRuntimeProfileOut[]>(`/agents/${encodeURIComponent(receipt.agent_id)}/runtime-profiles`,{spaceId:receipt.space_id})
  const profile=profiles.find(row=>row.id===receipt.profile_id);if(!profile)throw new Error('Runtime profile no longer available');return profile
}
export const agentsApi = {
  list: (params: Record<string, string> = {}, options: { spaceId?: string } = {}) =>
    get<AgentOut[]>('/agents?' + new URLSearchParams(params), { spaceId: options.spaceId }),
  get: (agentId: string, options: RequestOptions = {}) => get<AgentOut>(`/agents/${agentId}`, options),
  /** The managed Assistant instance for a scope: the Space's own, or a Project's (null before its first Room message). */
  getSystemAssistant: (projectId?: string | null) =>
    get<{ assistant: AgentOut | null }>(`/agents/system-assistant${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  // One keyed command per call (no retries); the receipt names the Agent, then the current view is read.
  create: async (data: AgentCreateBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.create', data, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  update: async (agentId: string, data: AgentUpdateBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.update', { ...data, agent_id: agentId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  // Config edit: appends a new immutable AgentVersion and repoints current_version_id.
  updateConfig: async (agentId: string, data: AgentConfigUpdateBody, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.config.update', { ...data, agent_id: agentId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  listRuntimeProfiles: (agentId: string, options: RequestOptions = {}) =>
    get<AgentRuntimeProfileOut[]>(`/agents/${agentId}/runtime-profiles`, options),
  getSpaceRuntimeDefault: () => get<SpaceAgentRuntimeDefaultOut | null>('/agents/runtime-default'),
  setSpaceRuntimeDefault: async (data: SpaceAgentRuntimeDefaultWrite, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.runtime_default.set', data, key)
    const value = await get<SpaceAgentRuntimeDefaultOut | null>('/agents/runtime-default', { spaceId: receipt.space_id })
    if (!value) throw new Error('Runtime default no longer available')
    return value
  },
  createRuntimeProfile: async (agentId: string, data: AgentRuntimeProfileCreateBody, key: string = crypto.randomUUID()) =>
    runtimeProfile(await commandReceipt('agent.runtime_profile.create', { ...data, agent_id: agentId }, key)),
  resolveHostRuntimeProfile: async (agentId: string, data: {
    execution_host_id: string
    workspace_location_id: string | null
    workspace_mode: 'location' | 'managed'
    runtime_key: string
    runtime_installation: string
  }, key: string = crypto.randomUUID()) => runtimeProfile(await commandReceipt('agent.runtime_profile.ensure_host', { ...data, agent_id: agentId }, key)),
  updateRuntimeProfile: async (agentId: string, profileId: string, data: AgentRuntimeProfileUpdateBody, key: string = crypto.randomUUID()) =>
    runtimeProfile(await commandReceipt('agent.runtime_profile.update', { ...data, agent_id: agentId, profile_id: profileId }, key)),
  currentVersion: (agentId: string) => get<AgentVersionOut>(`/agents/${agentId}/current-version`),
  conversationBackends: (
    agentId: string,
    options: RequestOptions & { sessionId?: string; projectId?: string } = {},
  ) =>
    get<ConversationBackendCatalog>(
      `/agents/${agentId}/conversation-backends${options.sessionId
        ? `?session_id=${encodeURIComponent(options.sessionId)}`
        : options.projectId ? `?project_id=${encodeURIComponent(options.projectId)}` : ''}`,
      { spaceId: options.spaceId, signal: options.signal },
    ),
  saveConversationSessionConfig: async (
    agentId: string,
    data: { session_id: string; runtime_profile_id: string; session_config: NonNullable<ConversationBackendCatalog['session_config']>; allow_quota_model_switch?: boolean },
    options: RequestOptions = {},
  ): Promise<{ session_config: NonNullable<ConversationBackendCatalog['session_config']>; allow_quota_model_switch?: boolean }> => {
    const receipt = await commandReceipt('conversation.session_config.save', { ...data, agent_id: agentId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    try {
      const catalog = await get<ConversationBackendCatalog>(`/agents/${encodeURIComponent(agentId)}/conversation-backends?session_id=${encodeURIComponent(receipt.session_id)}`, { spaceId: receipt.space_id, signal: options.signal })
      return { session_config: catalog.session_config ?? [], allow_quota_model_switch: catalog.allow_quota_model_switch ?? false }
    } catch (error) {
      // The command is already committed. Consumers must retry only readback.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { settingsSaved: true })
    }
  },
  // Assistant preferences (soft UI/context layer — never edits prompt or hard policy).
  getAssistantSettings: () => get<SpaceAssistantSettingsOut>('/agents/default-assistant/settings'),
  updateAssistantSettings: async (data: SpaceAssistantSettingsUpdate, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.assistant_settings.update', data, key)
    return get<SpaceAssistantSettingsOut>(`/agents/default-assistant/settings${receipt.project_id ? `?project_id=${encodeURIComponent(receipt.project_id)}` : ''}`, { spaceId: receipt.space_id })
  },
  listVersions: (agentId: string) => get<AgentVersionOut[]>(`/agents/${agentId}/versions`),
  getVersion: (agentId: string, versionId: string) =>
    get<AgentVersionOut>(`/agents/${agentId}/versions/${versionId}`),
  restoreVersion: async (agentId: string, versionId: string, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.version.restore', { agent_id: agentId, version_id: versionId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
  listProposals: (agentId: string, status = 'pending') =>
    get<Proposal[]>(`/agents/${agentId}/proposals?status=${encodeURIComponent(status)}`),
  createRun: async (agentId: string, body: RunCreateBody = {}, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.run.create', { ...body, agent_id: agentId }, key)
    return get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`, { spaceId: receipt.space_id })
  },
  // Queue the Chat Run, then subscribe to its canonical lifecycle stream.
  chat: (
    agentId: string,
    body: {
      message: string
      input_parts?: ConversationInputPart[]
      session_id?: string
      project_id?: string
      restore_workspace?: boolean
      backend?: Pick<ConversationBackendBinding, 'runtime_profile_id'>
      session_config?: NonNullable<ChatTurnRequest['session_config']>
    },
    options: RequestOptions & {
      onAccepted?: (accepted: ChatTurnAccepted) => void
      onTurn?: (turn: RunTurn) => void
    } = {},
  ) => postChatTurn(agentId, body, options),
  // A same-key replay returns the same receipt; the transport no longer reports a separate `reused` flag.
  retryConversation: async (agentId: string, runId: string, options: RequestOptions = {}): Promise<Omit<ConversationRetryResponse, 'reused'>> => {
    const { space_id: _space, ...retry } = await commandReceipt('agent.chat.retry', { agent_id: agentId, run_id: runId }, options.idempotencyKey ?? crypto.randomUUID(), options)
    return retry
  },
  /** `sessionId`: a direct conversation placed in a Project, which has its own Host container. */
  resetContext: async (agentId: string, options: RequestOptions & { sessionId?: string } = {}) => {
    const { sessionId, ...request } = options
    const receipt = await commandReceipt('agent.chat.reset_context', { agent_id: agentId, ...(sessionId ? { session_id: sessionId } : {}) }, request.idempotencyKey ?? crypto.randomUUID(), request)
    return { agent_id: receipt.agent_id, session_reset: receipt.session_reset, thread_id: receipt.thread_id, workspace_mode: receipt.workspace_mode }
  },
  listRuns:       (limit = 50)        => get<Run[]>(`/agents/runs?limit=${limit}`),
  getRun:         (runId: string, options: RequestOptions = {})     => get<Run>(`/runs/${runId}`, options),
  listRunsForAgent:  (agentId: string, options: RequestOptions = {})   => get<Run[]>(`/agents/${agentId}/runs`, options),
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
  createAgent: async (templateId: string, body: CreateAgentFromTemplateBody = {}, key: string = crypto.randomUUID()) => {
    const receipt = await commandReceipt('agent.template.instantiate', { ...body, template_id: templateId }, key)
    return get<AgentOut>(`/agents/${encodeURIComponent(receipt.agent_id)}`, { spaceId: receipt.space_id })
  },
}

// ── Automations ───────────────────────────────────────────────────────────
// Space-scoped paths (/spaces/{space_id}/automations); identity via session/bearer.
export const automationsApi = {
  configureAutonomy: (data: import('@rainver/protocol').AutomationAutonomyBody, key:string = crypto.randomUUID()) =>
    operationAt<AutomationOut>('PUT', `/spaces/${_spaceId}/automations/autonomy`, data, key),
  list:   (params: { project_id?: string } = {}) => {
    const q: Record<string, string> = {}
    if (params.project_id !== undefined) q.project_id = params.project_id
    const suffix = new URLSearchParams(q).toString()
    return get<AutomationOut[]>(`/spaces/${_spaceId}/automations${suffix ? `?${suffix}` : ''}`)
  },
  get:    (id: string)                        => get<AutomationOut>(`/spaces/${_spaceId}/automations/${id}`),
  create: (data: AutomationCreateBody, key:string = crypto.randomUUID())        => operationAt<AutomationOut>('POST', `/spaces/${_spaceId}/automations`, data, key),
  update: (id: string, data: AutomationUpdateBody, key:string = crypto.randomUUID()) => operationAt<AutomationOut>('PATCH', `/spaces/${_spaceId}/automations/${id}`, data, key),
  requestFire: (id:string, body:import('@rainver/protocol').AutomationFireBody={}, key:string=crypto.randomUUID()) =>
    operationAt<import('@rainver/protocol').AutomationFireReceipt>('POST', `/spaces/${_spaceId}/automations/${encodeURIComponent(id)}/fire`,body,key),
  fireRequest: (receipt:import('@rainver/protocol').AutomationFireReceipt) =>
    get<import('@rainver/protocol').AutomationFireRequest>(`/spaces/${receipt.space_id}/automations/${encodeURIComponent(receipt.automation_id)}/fire-requests/${encodeURIComponent(receipt.job_id)}`,{spaceId:receipt.space_id}),
  // Preserve the UI's completed-target semantics across the asynchronous HTTP contract.
  fire: async (id:string,body:import('@rainver/protocol').AutomationFireBody={},key:string=crypto.randomUUID()):Promise<AutomationFireResult> => {
    const receipt=await automationsApi.requestFire(id,body,key)
    for(;;){
      const request=await automationsApi.fireRequest(receipt)
      if(request.outcome==='completed'&&request.result)return request.result as unknown as AutomationFireResult
      if(request.outcome==='failed'||request.outcome==='unknown')throw new Error(request.error??'Automation fire did not complete')
      await new Promise(resolve=>setTimeout(resolve,500))
    }
  },
  workflowExecutions: (id: string) =>
    get<WorkflowExecutionSummary[]>(`/spaces/${_spaceId}/automations/${encodeURIComponent(id)}/workflow-executions`),
}

// ── Project Folders ──────────────────────────────────────────────────────
function folderRefusalMetadata(error:unknown):Record<string,unknown>|null{
  if(!(error instanceof ApiRequestError))return null;
  const failure=error.payload?.error as {metadata?:Record<string,unknown>}|undefined;
  return failure?.metadata??null;
}
async function hydrateDraftConflict(error:unknown,projectId:string,folderId:string,spaceId:string):Promise<void>{
  const metadata=folderRefusalMetadata(error);
  if(metadata?.code!=='draft_version_conflict')return;
  if(metadata.current_draft_id===null){Object.assign(error as object,{currentDraft:null});return;}
  if(typeof metadata.current_draft_id!=='string')return;
  try{
    const current=await get<ProjectFileDraft>(`/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/file/drafts/${encodeURIComponent(metadata.current_draft_id)}`,{spaceId});
    Object.assign(error as object,{currentDraft:current});
  }catch{/* Retain the canonical refusal if current authority or the supplementary read fails. */}
}
async function readPrivateFolderDraft(receipt:{id:string;space_id:string;project_id:string;folder_id:string},version:number):Promise<ProjectFileDraft>{
  const current=await get<ProjectFileDraft>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(receipt.folder_id)}/file/drafts/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  if(current.version!==version){const error=new ApiRequestError('The draft changed in another tab',409,'operation_conflict',{error:{code:'operation_conflict',metadata:{code:'draft_version_conflict',current_draft_id:current.id,current_version:current.version}}});throw Object.assign(error,{currentDraft:current});}
  return current;
}
/** Read-only polling of one requester-owned Job. Never resubmits its command. */
async function waitForJobResult<T>(receipt:{job_id:string;space_id:string},label:string):Promise<T>{
  const started=Date.now(),authGeneration=_authContextGeneration
  for(;;){
    if(authGeneration!==_authContextGeneration)throw new ApiRequestError(`The session changed while the ${label} was running`,401,'authentication_required')
    const job=await get<{status:string;result:T|null}>(`/jobs/${encodeURIComponent(receipt.job_id)}`,{spaceId:receipt.space_id})
    if(job.status==='completed'&&job.result)return job.result
    if(job.status==='failed'||job.status==='cancelled')throw new Error(`${label} did not complete`)
    if(Date.now()-started>180000)throw new Error(`${label} is still running; refresh later`)
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
}
/** One keyed command, followed only by current-authority result reads. */
async function contentRequest<T>(operation:keyof typeof import('@rainver/protocol').CONTENT_RETRIEVAL_OPERATION_SCHEMAS,input:unknown,key:string=crypto.randomUUID()):Promise<T>{
  const receipt=operation==='ask_space.think'?await operationAt<OperationOutput<'ask_space.think'>>('POST','/ask-space/think',input,key):await commandReceipt(operation,input as never,key),domain=operation.startsWith('memory.')?'memory':'knowledge'
  const started=Date.now(),authGeneration=_authContextGeneration
  for(;;){
    if(authGeneration!==_authContextGeneration)throw new ApiRequestError('The session changed while retrieval was running',401,'authentication_required')
    const path=operation==='ask_space.think'?`/ask-space/requests/${encodeURIComponent(receipt.job_id)}`:`/${domain}/retrieval/requests/${encodeURIComponent(receipt.job_id)}`
    const view=await get<{status:string;result:T|null;withheld:number}>(path,{spaceId:receipt.space_id})
    if(view.status==='completed'&&view.result!==null)return view.result
    if(view.status==='completed'&&view.withheld)throw new ApiRequestError('The content access changed. Search again.',404,'operation_not_found')
    if(['failed','cancelled','completed'].includes(view.status))throw new Error('Retrieval did not complete')
    if(Date.now()-started>180000)throw new Error('Retrieval is still running; refresh later')
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
}
/** Read-only polling of one queued Source retrieval/preview request through its current-access reader. */
async function waitForSourceRequest(receipt:{job_id:string;space_id:string},label:string):Promise<Record<string,unknown>>{
  const started=Date.now(),authGeneration=_authContextGeneration
  for(;;){
    if(authGeneration!==_authContextGeneration)throw new ApiRequestError(`The session changed while the ${label} was running`,401,'authentication_required')
    const view=await get<import('@rainver/protocol').SourceRetrievalRequestView>(`/sources/retrieval/requests/${encodeURIComponent(receipt.job_id)}`,{spaceId:receipt.space_id})
    if(view.status==='completed'&&view.result)return view.result
    if(view.status==='failed'||view.status==='cancelled'||view.status==='completed')throw new Error(`${label} did not complete`)
    if(Date.now()-started>180000)throw new Error(`${label} is still running; refresh later`)
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
}
/** Read-only polling of one queued provider Run. Never resubmits its command. */
async function waitForProviderRun(receipt:{run_id:string;space_id:string},label:string):Promise<void>{
  const started=Date.now(),authGeneration=_authContextGeneration
  for(;;){
    if(authGeneration!==_authContextGeneration)throw new ApiRequestError(`The session changed while the ${label} was running`,401,'authentication_required')
    const run=await get<Run>(`/runs/${encodeURIComponent(receipt.run_id)}`,{spaceId:receipt.space_id})
    if(run.status==='succeeded'||run.status==='degraded')return
    if(['failed','cancelled','orphaned'].includes(run.status))throw new Error(`${label} did not complete`)
    if(Date.now()-started>180000)throw new Error(`${label} is still running; refresh later`)
    await new Promise(resolve=>setTimeout(resolve,1000))
  }
}
/** Read-only polling of one durable Folder request. Never resubmits its command. */
async function waitForFolderIo(receipt:import('@rainver/protocol').OperationOutput<'project.folder.scan'>):Promise<import('@rainver/protocol').ProjectFolderIoStatus>{
  const started=Date.now(),authGeneration=_authContextGeneration;
  for(;;){
    if(authGeneration!==_authContextGeneration)throw new ApiRequestError('The session changed while the Folder request was running',401,'authentication_required');
    const current=await get<import('@rainver/protocol').ProjectFolderIoStatus>(`/projects/${encodeURIComponent(receipt.project_id)}/folder-io/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
    if(current.status==='succeeded')return current;
    if(current.status==='failed'||current.status==='needs_attention'){
      const code=current.error?.code??'folder_io_requires_attention';
      const invalid=['draft_quota_exceeded','draft_revision_too_large','mixed_line_endings_confirmation_required'].includes(code);
      const message=code==='mixed_line_endings_confirmation_required'?'Saving this draft requires confirmation to normalize mixed line endings':current.status==='needs_attention'?'The Folder request needs attention; open the Job Queue before trying another change':'The Folder request could not complete';
      const error=new ApiRequestError(message,invalid?422:409,invalid?'operation_invalid_input':'operation_conflict',{error:{code:invalid?'operation_invalid_input':'operation_conflict',metadata:{code,...current.error?.metadata,intent_id:receipt.id,job_id:receipt.job_id}}});
      if(receipt.folder_id)await hydrateDraftConflict(error,receipt.project_id,receipt.folder_id,receipt.space_id);throw error;
    }
    if(Date.now()-started>150000)throw new ApiRequestError('The Folder request is still running; check the Job Queue',503,'operation_temporarily_unavailable',{error:{code:'operation_temporarily_unavailable',metadata:{intent_id:receipt.id,job_id:receipt.job_id}}});
    await new Promise(resolve=>setTimeout(resolve,250));
  }
}
const hostPath=(hostId:string)=>`/hosts/${encodeURIComponent(hostId)}`
/**
 * One keyed Host command at its retained URL (`.agent/modules/hosts.md` "Host
 * commands"): the core answers a receipt, the Host acts after commit, and only
 * the owner-only status read releases the outcome. Read-only polling; the
 * command is never resubmitted. `needs_attention` means the Host may have
 * acted and is never reported as success.
 */
async function hostCommand<T>(method:'POST'|'PUT'|'PATCH'|'DELETE',path:string,body:unknown,label:string,key:string=crypto.randomUUID(),options:RequestOptions={}):Promise<T>{
  const receipt=await operationAt<import('@rainver/protocol').HostCommandReceipt>(method,path,body,key,options)
  const started=Date.now(),authGeneration=_authContextGeneration
  for(let delay=500;;delay=Math.min(delay*2,3000)){
    if(authGeneration!==_authContextGeneration)throw new ApiRequestError(`The session changed while the ${label} was running`,401,'authentication_required')
    let current:import('@rainver/protocol').HostCommandStatus
    try{
      current=await get<import('@rainver/protocol').HostCommandStatus>(`${hostPath(receipt.host_id)}/commands/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id})
    }catch(error){
      // A lost read is not the command's outcome: keep polling through a network blip or a 5xx; a
      // refused read (signed out, no longer the person's) ends it.
      if(error instanceof ApiRequestError&&error.status<500)throw error
      if(Date.now()-started>25*60*1000)throw error
      await new Promise(resolve=>setTimeout(resolve,delay))
      continue
    }
    if(current.status==='succeeded')return current.result as T
    if(current.status==='failed'||current.status==='needs_attention'){
      const attention=current.status==='needs_attention'
      const detail=current.error?.detail??current.error?.code??null
      const message=attention?`${label}: the Host may have acted, but its outcome is unknown${detail?` (${detail})`:''}. Check the Host's current state before repeating.`:`${label} did not complete${detail?`: ${detail}`:''}`
      // `result` is present only when the command committed part of its work (a history import that wrote some sessions).
      throw new ApiRequestError(message,409,'operation_conflict',{error:{code:'operation_conflict',metadata:{code:current.error?.code??null,command_id:receipt.id,job_id:receipt.job_id,status:current.status,result:current.result??null}}})
    }
    // A Host may take its full install timeout; past that the command is still durable and keeps running.
    if(Date.now()-started>25*60*1000)throw new ApiRequestError(`${label} is still running on the Host; check again later`,503,'operation_temporarily_unavailable',{error:{code:'operation_temporarily_unavailable',metadata:{command_id:receipt.id,job_id:receipt.job_id}}})
    await new Promise(resolve=>setTimeout(resolve,delay))
  }
}
/**
 * A system settings / tool configuration command whose effect runs after
 * commit (`provider.test`, plan usage and subscription quota reads, plugin
 * installation, a manual backup, a webhook send): submit once with its key,
 * then read exactly that command's status until it settles. Never resubmits;
 * an unknown outcome is reported as such, never as success.
 */
async function systemCommand<T>(method:'POST'|'PUT'|'PATCH'|'DELETE',path:string,body:unknown,label:string,key:string=crypto.randomUUID(),timeoutMs=10*60*1000):Promise<T>{
  const receipt=await operationAt<import('@rainver/protocol').SystemCommandReceipt>(method,path,body,key)
  const started=Date.now(),authGeneration=_authContextGeneration
  for(let delay=400;;delay=Math.min(delay*2,3000)){
    if(authGeneration!==_authContextGeneration)throw new ApiRequestError(`The session changed while the ${label} was running`,401,'authentication_required')
    let current:import('@rainver/protocol').SystemCommandStatus
    try{
      current=await get<import('@rainver/protocol').SystemCommandStatus>(`/system/commands/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id})
    }catch(error){
      // A lost read is not the command's outcome: keep reading through a network blip or a 5xx;
      // a refused read (signed out, no longer the person's) ends it.
      if(error instanceof ApiRequestError&&error.status<500)throw error
      if(Date.now()-started>timeoutMs)throw error
      await new Promise(resolve=>setTimeout(resolve,delay))
      continue
    }
    if(current.status==='succeeded')return current.result as T
    if(current.status==='failed'||current.status==='needs_attention'){
      const attention=current.status==='needs_attention'
      const detail=current.error?.detail??current.error?.code??null
      const message=attention?`${label}: it may have run, but its outcome is unknown${detail?` (${detail})`:''}. Check the current state before repeating.`:`${label} did not complete${detail?`: ${detail}`:''}`
      throw new ApiRequestError(message,409,'operation_conflict',{error:{code:'operation_conflict',metadata:{code:current.error?.code??null,command_id:receipt.id,job_id:receipt.job_id,status:current.status}}})
    }
    if(Date.now()-started>timeoutMs)throw new ApiRequestError(`${label} is still running; check again later`,503,'operation_temporarily_unavailable',{error:{code:'operation_temporarily_unavailable',metadata:{command_id:receipt.id,job_id:receipt.job_id}}})
    await new Promise(resolve=>setTimeout(resolve,delay))
  }
}
/** Isolated Agent workspace progress: read-only projections. Commands stay in Operation Core. */
export const agentWorkspacesApi = {
  conversationChanges: (sessionId: string, page: { cursor?: string | null } = {}, options?: RequestOptions) =>
    get<import('@rainver/protocol').ConversationWorkspaceChanges>(`/sessions/${encodeURIComponent(sessionId)}/workspace-changes${page.cursor ? `?${new URLSearchParams({ cursor: page.cursor })}` : ''}`, options),
  /** One entry per conversation × repository: state, latest result and open problems. */
  groups: (projectId: string, params: { view: 'current' | 'history'; cursor?: string | null; limit?: number }, options?: RequestOptions) =>
    get<import('@rainver/protocol').AgentWorkspaceGroupPage>(`/projects/${encodeURIComponent(projectId)}/agent-workspace-groups?` + new URLSearchParams({
      view: params.view, limit: String(params.limit ?? 20), ...(params.cursor ? { cursor: params.cursor } : {}),
    }), options),
  /** Per-generation rows; `view=all` with `group` is one entry's execution history. */
  list: (projectId: string, params: { view: 'current' | 'history' | 'all'; group?: string; cursor?: string | null; limit?: number }, options?: RequestOptions) =>
    get<import('@rainver/protocol').AgentWorkspacePage>(`/projects/${encodeURIComponent(projectId)}/agent-workspaces?` + new URLSearchParams({
      view: params.view, limit: String(params.limit ?? 20), ...(params.group ? { group: params.group } : {}), ...(params.cursor ? { cursor: params.cursor } : {}),
    }), options),
  detail: (projectId: string, workspaceId: string, page: { cursor?: string | null } = {}, options?: RequestOptions) =>
    get<import('@rainver/protocol').AgentWorkspaceDetail>(`/projects/${encodeURIComponent(projectId)}/agent-workspaces/${encodeURIComponent(workspaceId)}${page.cursor ? `?${new URLSearchParams({ cursor: page.cursor })}` : ''}`, options),
}

export const projectFoldersApi = {
  list:    (projectId: string, params: Record<string, string> = {}, options?: RequestOptions) =>
    get<Page<ProjectFolder>>(`/projects/${projectId}/folders?` + new URLSearchParams(params), options),
  listExecutionReady: async (projectId: string, params: Record<string, string> = {}) => {
    const page = await get<Page<ProjectFolder>>(`/projects/${projectId}/folders?` + new URLSearchParams(params))
    const ready = (await Promise.all(page.items.map(async folder => {
      const locations = await get<WorkspaceLocation[]>(`/projects/${projectId}/folders/${folder.id}/locations`)
      return locations.some(location => location.status === 'active' && location.execution_ready) ? folder : null
    }))).filter((folder): folder is ProjectFolder => folder !== null)
    return { ...page, items: ready, total: ready.length }
  },
  create:async(projectId:string,data:ProjectFolderCreateBody,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('project.folder.create',{...data,project_id:projectId},key),status=await waitForFolderIo(receipt);
    if(status.result?.kind!=='create')throw new Error('Folder creation receipt is unavailable');return get<ProjectFolder>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(status.result.folder_id)}`,{spaceId:receipt.space_id});
  },
  scan:async(projectId:string,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('project.folder.scan',{project_id:projectId},key),status=await waitForFolderIo(receipt);if(status.result?.kind!=='scan')throw new Error('Folder scan receipt is unavailable');return {items:status.result.items};
  },
  get:     (projectId: string, folderId: string) =>
    get<ProjectFolder>(`/projects/${projectId}/folders/${folderId}`),
  locations: (projectId: string, folderId: string, options: RequestOptions = {}) =>
    get<WorkspaceLocation[]>(`/projects/${projectId}/folders/${folderId}/locations`, options),
  activateLocation: async (projectId:string,folderId:string,locationId:string,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('project.folder.location.activate',{project_id:projectId,folder_id:folderId,location_id:locationId},key);
    const rows=await get<WorkspaceLocation[]>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(receipt.folder_id)}/locations`,{spaceId:receipt.space_id}),row=rows.find(location=>location.id===receipt.id);
    if(!row)throw new Error('Workspace Location no longer available');return row;
  },
  update:async(projectId:string,folderId:string,data:Omit<OperationInput<'project.folder.update'>,'project_id'|'folder_id'>,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('project.folder.update',{...data,project_id:projectId,folder_id:folderId},key);
    return get<ProjectFolder>(`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(receipt.folder_id)}`,{spaceId:receipt.space_id});
  },
  archive:async(projectId:string,folderId:string,key:string=crypto.randomUUID())=>{
    await noteObjectCall('project.folder.archive',{project_id:projectId,folder_id:folderId},key);return null;
  },
  unregister: async(projectId:string,folderId:string,confirm=false,key:string=crypto.randomUUID())=>{
    await noteObjectCall('project.folder.unregister',{project_id:projectId,folder_id:folderId,confirm},key);return null;
  },
  tree:    (projectId: string, folderId: string, path = '.', offset = 0, options: RequestOptions = {}) =>
    get<FileNode>(`/projects/${projectId}/folders/${folderId}/tree?path=${encodeURIComponent(path)}&offset=${offset}`, options),
  file:    (projectId: string, folderId: string, path: string, options: RequestOptions & { convertUtf8?: boolean } = {}) =>
    get<FileContent>(`/projects/${projectId}/folders/${folderId}/file?path=${encodeURIComponent(path)}${options.convertUtf8 ? '&convert=utf8' : ''}`, options),
  draft:   (projectId: string, folderId: string, path: string) =>
    get<ProjectFileDraft | null>(`/projects/${projectId}/folders/${folderId}/file/draft?path=${encodeURIComponent(path)}`),
  upsertDraft:async(projectId:string,folderId:string,data:Omit<OperationInput<'project.folder.draft.upsert'>,'project_id'|'folder_id'>,key:string=crypto.randomUUID())=>{
    const spaceId=_spaceId;
    try{
      const result=await callOperation('project.folder.draft.upsert',{...data,project_id:projectId,folder_id:folderId},key,{spaceId});
      if(!('status' in result)||result.status!=='succeeded')throw new Error('Draft action did not complete');
      return readPrivateFolderDraft(result.data,result.data.version);
    }catch(error){if(!(error&&typeof error==='object'&&'currentDraft' in error))await hydrateDraftConflict(error,projectId,folderId,spaceId);throw error;}
  },
  rebaseDraft:(projectId:string,folderId:string,data:Omit<OperationInput<'project.folder.draft.upsert'>,'project_id'|'folder_id'|'expected_version'>&{expected_version:number},key:string=crypto.randomUUID()):Promise<ProjectFileDraft>=>
    projectFoldersApi.upsertDraft(projectId,folderId,data,key),
  discardDraft:async(projectId:string,folderId:string,draftId:string,draftVersion:number,key:string=crypto.randomUUID()):Promise<{discarded:true}>=>{
    const spaceId=_spaceId;
    try{const result=await callOperation('project.folder.draft.discard',{project_id:projectId,folder_id:folderId,draft_id:draftId,draft_version:draftVersion},key,{spaceId});if(!('status' in result)||result.status!=='succeeded')throw new Error('Draft discard did not complete');return {discarded:true};}
    catch(error){await hydrateDraftConflict(error,projectId,folderId,spaceId);throw error;}
  },
  saveDraft:async(projectId:string,folderId:string,draftId:string,draftVersion:number,confirmMixedLineEndingNormalization=false,key:string=crypto.randomUUID()):Promise<ProjectFileDraftSave>=>{
    const receipt=await noteObjectCall('project.folder.draft.save',{project_id:projectId,folder_id:folderId,draft_id:draftId,draft_version:draftVersion,confirm_mixed_line_ending_normalization:confirmMixedLineEndingNormalization},key),status=await waitForFolderIo(receipt);
    if(status.result?.kind!=='save_draft')throw new Error('File save receipt is unavailable');
    const result=status.result,path=encodeURIComponent(result.path),location=encodeURIComponent(result.workspace_location_id),base=`/projects/${encodeURIComponent(receipt.project_id)}/folders/${encodeURIComponent(folderId)}`;
    const [file,currentDraft]=await Promise.all([get<FileContent>(`${base}/file?path=${path}&workspace_location_id=${location}`,{spaceId:receipt.space_id}),get<ProjectFileDraft|null>(`${base}/file/draft?path=${path}&workspace_location_id=${location}`,{spaceId:receipt.space_id})]);
    return {file,revision:result.revision,draft_deleted:result.draft_deleted,newer_draft_retained:currentDraft!==null,current_draft:currentDraft};
  },
  draftQuota: (projectId: string, folderId: string) =>
    get<ProjectFileDraftQuota>(`/projects/${projectId}/folders/${folderId}/drafts/quota`),
  fileRevisions: (projectId: string, folderId: string, path: string) =>
    get<ProjectFileRevision[]>(`/projects/${projectId}/folders/${folderId}/file/revisions?path=${encodeURIComponent(path)}`),
  restoreRevisionAsDraft:async(projectId:string,folderId:string,revisionId:string,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('project.folder.revision.restore',{project_id:projectId,folder_id:folderId,revision_id:revisionId},key),status=await waitForFolderIo(receipt);
    if(status.result?.kind!=='restore_revision')throw new Error('Revision restore receipt is unavailable');return readPrivateFolderDraft({id:status.result.draft_id,space_id:receipt.space_id,project_id:receipt.project_id,folder_id:folderId},status.result.version);
  },
  previewRevision: (projectId: string, folderId: string, revisionId: string) =>
    get<{ revision: ProjectFileRevision; content: string | null }>(`/projects/${projectId}/folders/${folderId}/file/revisions/${encodeURIComponent(revisionId)}/preview`),
  gitStatus: (projectId: string, folderId: string) =>
    get<GitStatus>(`/projects/${projectId}/folders/${folderId}/git/status`),
  gitDiff: (projectId: string, folderId: string, path?: string) =>
    get<{ diff: string; path: string | null; truncated: boolean; redacted: boolean }>(
      `/projects/${projectId}/folders/${folderId}/git/diff` + (path ? `?path=${encodeURIComponent(path)}` : ''),
    ),
}

/**
 * Ambient CLI history a paired host holds for a folder, and the consent that
 * governs importing it. Consent hangs off the Location because it is about
 * one folder on one machine; the sessions themselves belong to the Project.
 */
export const ambientSessionsApi = {
  offer: (locationId: string) =>
    get<{ policy: AmbientImportPolicy; counts: AmbientSessionCount[]; attention: import('@rainver/protocol').AmbientImportAttention }>(
      `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/offer`,
    ),
  setPolicy: async (locationId: string, body: { runtime_key: string; installation?: string; sync: boolean; default_visibility?: 'private' | 'space_shared'; auto_extract?: boolean }, key: string = crypto.randomUUID()): Promise<AmbientImportPolicy> =>
    (await operationAt<{ policy: AmbientImportPolicy }>('PUT', `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/policy`, body, key)).policy,
  setReminder: async (locationId: string, mode: 'later' | 'never' | 'enable', key: string = crypto.randomUUID()): Promise<AmbientImportPolicy> =>
    (await operationAt<{ policy: AmbientImportPolicy }>('POST', `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/reminder`, { mode }, key)).policy,
  list: (locationId: string) =>
    get<{ sessions: ImportedSession[] }>(`/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions`),
  /** Everything in the Project this viewer may read, gated by the content predicate rather than host ownership. */
  listForProject: (projectId: string) =>
    get<{ sessions: ImportedSession[] }>(`/projects/${encodeURIComponent(projectId)}/imported-sessions`),
  /**
   * A durable Host command: imports on the Host after commit; the report is released by its status read.
   * An import that ended in an error still answers its real report (its `error` set, and what it
   * committed counted), so what was written is never shown as not having happened.
   */
  sync: async (locationId: string, body: { runtime_key: string; installation?: string; session_ids?: string[] | null; visibility?: 'private' | 'space_shared' }, key?: string): Promise<AmbientSyncReport> => {
    try {
      return await hostCommand<AmbientSyncReport>('POST', `/workspace-locations/${encodeURIComponent(locationId)}/ambient-sessions/sync`, body, 'History import', key)
    } catch (error) {
      const report = error instanceof ApiRequestError
        ? ((error.payload?.error as { metadata?: { result?: unknown } } | undefined)?.metadata?.result as AmbientSyncReport | null | undefined)
        : null
      if (report && typeof report.error === 'string') return report
      throw error
    }
  },
  records: (sessionId: string) =>
    get<{ session: ImportedSession; records: ImportedSessionRecord[]; truncated: boolean }>(`/imported-sessions/${encodeURIComponent(sessionId)}`),
  setVisibility: async (sessionId: string, visibility: 'private' | 'space_shared', key: string = crypto.randomUUID()): Promise<ImportedSession> =>
    (await operationAt<{ session: ImportedSession }>('PATCH', `/imported-sessions/${encodeURIComponent(sessionId)}`, { visibility }, key)).session,
  remove: async (sessionIds: string[], key: string = crypto.randomUUID()): Promise<{ deleted: number }> =>
    ({ deleted: (await operationAt<{ deleted: number }>('POST', '/imported-sessions/delete', { session_ids: sessionIds }, key)).deleted }),
  /** What an extraction would read right now — the count behind the "Extract to Brief" button. */
  pendingExtraction: (projectId: string) =>
    get<{ records: number; sessions: number }>(`/projects/${encodeURIComponent(projectId)}/imported-sessions/extraction`),
  /** Claims one batch with an explicit key, then reads its Job until it settles; never resubmits. */
  extract: async (projectId: string, key:string=crypto.randomUUID()):Promise<ExtractionOutcome> => {
    const receipt=await commandReceipt('project.imported_sessions.extract',{project_id:projectId},key)
    if(!receipt.job_id)return {brief_proposal_id:null,memory_packet_proposal_id:null,records_covered:0,sessions_covered:0,decisions:0,facts:0,records_remaining:0}
    return waitForJobResult<ExtractionOutcome>({job_id:receipt.job_id,space_id:receipt.space_id},'History extraction')
  },
}

// ADR 0016: multi-host control center — pairing, dispatch, and the
// work-stream read side (task threads). See .agent/modules/hosts.md.
export const hostsApi = {
  subscriptionUsage: () => get<{ items: import('@rainver/protocol').SubscriptionQuotaPool[] }>('/hosts/subscription-usage'),
  toolOperations: (hostId: string) =>
    get<{ items: Array<{ runtime_key: string; action: string }> }>(`/hosts/${encodeURIComponent(hostId)}/tool-operations`),
  list: (options: RequestOptions = {}) => get<{ items: Host[] }>('/hosts', options),
  executionTargets: (projectId?: string | null) =>
    get<HostExecutionTargetsResponse>(`/hosts/execution-targets${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  pairingCode: (name: string) => post<HostPairingCode>('/hosts/pairing-codes', { name }),
  revoke: async (hostId: string, key: string = crypto.randomUUID()): Promise<null> => {
    await operationAt<{ revoked: true }>('POST', `${hostPath(hostId)}/revoke`, {}, key)
    return null
  },
  listRuntimeDefinitions: () => get<{ items: HostRuntimeDefinitionOption[] }>('/hosts/runtime-definitions'),
  /** Pinned Server OpenCode provisioning and ACP health state. */
  serverRuntimeProvisioning: (hostId: string) =>
    get<HostRuntimeProvisioningStatus>(`/hosts/${encodeURIComponent(hostId)}/runtime-provisioning/opencode`),
  /** Requeues a failed Server OpenCode install/health check; admins only. */
  retryServerRuntimeProvisioning: async (hostId: string, key: string = crypto.randomUUID()) => {
    const { space_id: _space, ...state } = await operationAt<{ host_id: string; space_id: string; runtime_key: 'opencode'; state: 'queued' | 'installing'; desired_version: string }>(
      'POST', `${hostPath(hostId)}/runtime-provisioning/opencode/retry`, {}, key)
    return state
  },
  /** One level of subdirectory names on an owned host — the daemon answers; lazy and bounded. */
  browseDirectories: (hostId: string, path?: string | null) =>
    post<{ path: string | null; parent: string | null; dirs: string[]; truncated: boolean }>(
      `/hosts/${encodeURIComponent(hostId)}/browse-directories`, { path: path ?? null }),
  /** Registers a directory on an owned host as a Project Location, exactly as the CLI's `workspace add` would. */
  registerWorkspace: (hostId: string, body: { path: string; project_id: string; name: string }, key?: string) =>
    hostCommand<{ workspace_id: string | null; display_path: string | null }>('POST', `${hostPath(hostId)}/workspaces`, body, 'Location registration', key),
  /** Asks the host's daemon to install a managed copy of a runtime (any ACP adapter with a distribution). */
  installRuntime: (hostId: string, runtimeKey: string, expectedVersion?: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}`, expectedVersion ? { expected_version: expectedVersion } : {}, 'Installation', key),
  updateManagedRuntime: (hostId: string, runtimeKey: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/managed/update`, {}, 'CLI update', key),
  updateOwnRuntime: (hostId: string, runtimeKey: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/own/update`, {}, 'Own CLI update', key),
  uninstallRuntime: (hostId: string, runtimeKey: string, installation: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('DELETE', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}`, undefined, 'Removal', key),
  /** Undoes the last upgrade of a managed copy, promoting the version the host kept behind it. */
  rollbackRuntime: (hostId: string, runtimeKey: string, key?: string) =>
    hostCommand<RuntimeInstallResult>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/rollback`, {}, 'Rollback', key),
  /** What has changed about every host's runtimes, newest first. */
  runtimeChanges: () => get<{ items: HostRuntimeChange[] }>('/hosts/runtime-changes'),
  /** The cached subscription quota for each copy on a host; a read, never a probe. */
  usage: (hostId: string) => get<{ items: HostRuntimeUsage[] }>(`/hosts/${encodeURIComponent(hostId)}/usage`),
  /** Asks one copy now, on the host that holds its login. */
  refreshUsage: (hostId: string, runtimeKey: string, installation: string, key?: string, options?: RequestOptions) =>
    hostCommand<HostRuntimeUsage>('POST', `${hostPath(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/usage`, {}, 'Quota check', key, options),
  /**
   * The login terminal for one copy of a runtime on a host: the daemon runs
   * the copy's login command on a PTY and this relays it, frame by frame,
   * until the command exits. Type through `loginInput`.
   */
  /**
   * The login event stream. Pass a signal and abort it when the panel goes
   * away: closing the response is what tells the server to end the daemon's
   * login session, so an abandoned panel does not leave a login program
   * waiting on the host.
   */
  async *loginStream(hostId: string, runtimeKey: string, installation: string, target?: HostLoginTarget | null, signal?: AbortSignal): AsyncGenerator<RuntimeLoginEvent> {
    const query = target?.kind === 'acp'
      ? `?auth_method_id=${encodeURIComponent(target.methodId)}`
      : target?.kind === 'cli' ? '?login_action=cli'
      : target?.kind === 'logout' ? '?login_action=logout' : ''
    const url = `${BASE}/hosts/${encodeURIComponent(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/login/stream${query}`
    const headers: Record<string, string> = {}
    if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
    headers['X-Rainver-Space-Id'] = _spaceId
    const response = await fetch(url, { headers, signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    if (!response.body) throw new Error('No response body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const line = block.trim()
          if (!line.startsWith('data: ')) continue
          try { yield JSON.parse(line.slice(6)) as RuntimeLoginEvent } catch { /* ignore malformed SSE */ }
        }
      }
    } catch (caught) {
      // An abort is the caller leaving, not a failure to report.
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) throw caught
    } finally {
      // A consumer that stops iterating lands here too; release the connection.
      void reader.cancel().catch(() => undefined)
    }
  },
  /** Delivers the `http://127.0.0.1:…` address a browser on another device landed on to the login on the host. */
  loginCallback: (hostId: string, runtimeKey: string, installation: string, url: string) =>
    post<null>(`/hosts/${encodeURIComponent(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/login/callback`, { url }),
  loginInput: (hostId: string, runtimeKey: string, installation: string, data: string) =>
    post<null>(`/hosts/${encodeURIComponent(hostId)}/installations/${encodeURIComponent(runtimeKey)}/${encodeURIComponent(installation)}/login/input`, { data }),
  /** Empty string clears the override and returns this host to the derived address. */
  setProviderProxyUrl: async (hostId: string, baseUrl: string, key: string = crypto.randomUUID()) => {
    const out = await operationAt<{ host_id: string; space_id: string; provider_proxy_base_url: string | null }>(
      'PUT', `${hostPath(hostId)}/provider-proxy-url`, { base_url: baseUrl.trim() ? baseUrl : null }, key)
    return { host_id: out.host_id, provider_proxy_base_url: out.provider_proxy_base_url }
  },
}

/** What the account session stream sends to the person who opened it. */
export type OrdinaryAccountStreamEvent =
  | { type: 'authorization'; url: string; user_code: string | null; expires_in: number | null }
  | { type: 'exit'; outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out'; error: string | null; status: import('@rainver/protocol').OrdinaryAccountStatus | null }

/**
 * Ordinary CLI tools on a Host and the signed-in person's own account for one
 * of them (`.agent/modules/hosts.md`). The server decides every permission;
 * the account is always the caller's, so nothing here names a user.
 */
export const ordinaryToolsApi = {
  list: (hostId: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').HostOrdinaryToolsResponse>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools`, options),
  install: (hostId: string, toolId: string, key?: string) =>
    hostCommand<unknown>('POST', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/install`, {}, 'Tool installation', key),
  register: (hostId: string, toolId: string, path: string | null, key?: string) =>
    hostCommand<unknown>('POST', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/register`, path ? { path } : {}, 'Tool registration', key),
  remove: (hostId: string, toolId: string, source: 'managed' | 'registered', key?: string) =>
    hostCommand<unknown>('DELETE', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}?source=${source}`, undefined, 'Tool removal', key),
  account: (hostId: string, toolId: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').HostOrdinaryAccountResponse>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account`, options),
  verify: (hostId: string, toolId: string) =>
    post<import('@rainver/protocol').HostOrdinaryAccountResponse>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/verify`),
  /** A durable Host command for the caller's own account; the account is then read back from the Host. */
  logout: async (hostId: string, toolId: string, key?: string): Promise<import('@rainver/protocol').HostOrdinaryAccountResponse & { logout?: { local_cleared: boolean; remote_revocation: 'attempted_unconfirmed' | 'not_applicable' } }> => {
    const done = await hostCommand<{ logout?: { local_cleared: boolean; remote_revocation: 'attempted_unconfirmed' | 'not_applicable' } }>('POST', `${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/logout`, {}, 'Logout', key)
    const account = await get<import('@rainver/protocol').HostOrdinaryAccountResponse>(`${hostPath(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account`)
    return { ...account, ...(done?.logout ? { logout: done.logout } : {}) }
  },
  cancelSession: (hostId: string, toolId: string) =>
    post<{ cancelled: boolean }>(`/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/session/cancel`),
  /**
   * The official setup (`init`) or personal login (`login`) for the caller's
   * own account, as server-sent events. Aborting the signal closes the
   * stream, which cancels the session on the Host.
   */
  async *sessionStream(hostId: string, toolId: string, flow: 'init' | 'login', signal?: AbortSignal): AsyncGenerator<OrdinaryAccountStreamEvent> {
    const url = `${BASE}/hosts/${encodeURIComponent(hostId)}/ordinary-tools/${encodeURIComponent(toolId)}/account/session/stream?flow=${flow}`
    const headers: Record<string, string> = {}
    if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
    headers['X-Rainver-Space-Id'] = _spaceId
    const response = await fetch(url, { headers, signal })
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const body = await response.json() as { detail?: unknown; reason?: unknown }
        if (typeof body.detail === 'string') detail = body.detail
        else if (typeof body.reason === 'string') detail = body.reason
      } catch { /* keep the status line */ }
      throw new ApiRequestError(detail, response.status)
    }
    if (!response.body) throw new Error('No response body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const line = block.trim()
          if (!line.startsWith('data: ')) continue
          try { yield JSON.parse(line.slice(6)) as OrdinaryAccountStreamEvent } catch { /* ignore malformed SSE */ }
        }
      }
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) throw caught
    } finally {
      void reader.cancel().catch(() => undefined)
    }
  },
}

/** A single source command followed only by authorized result reads. */
async function skillSourceRequest<T>(path:string,input:unknown,options:RequestOptions={}):Promise<T>{
  const receipt=await operationAt<{job_id:string;space_id:string}>('POST',path,input,options.idempotencyKey??crypto.randomUUID(),options)
  const started=Date.now(),generation=_authContextGeneration
  for(;;){
    if(options.signal?.aborted)throw new DOMException('Aborted','AbortError')
    if(generation!==_authContextGeneration)throw new ApiRequestError('The session changed while Skills were loading',401,'authentication_required')
    const job=await get<{status:string;result:T|null;error?:{code:string;message:string}|null}>(`/skill-sources/requests/${encodeURIComponent(receipt.job_id)}`,{...options,spaceId:receipt.space_id})
    if(job.status==='completed'&&job.result)return job.result
    if(job.status==='failed'||job.status==='cancelled'){
      if(job.error)throw new ApiRequestError(job.error.message,409,job.error.code)
      throw new Error('Skill source request did not complete')
    }
    if(Date.now()-started>180000)throw new Error('Skill source request is still running; refresh later')
    await new Promise(resolve=>setTimeout(resolve,500))
  }
}
export const skillsApi = {
  scanHostSkills: (hostId: string, options?: RequestOptions) =>
    skillSourceRequest<import('@rainver/protocol').HostSkillScan>(`/skill-sources/hosts/${encodeURIComponent(hostId)}/scan`, {}, options),
  /** Skills enabled for every addressed recipient; a Room menu names them in `recipient_agent_ids` (none means the manager). */
  availableSkills: (query: { session_id?: string | null; project_id?: string | null; agent_id?: string | null; recipient_agent_ids?: readonly string[] }, options?: RequestOptions) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      const text = typeof value === 'string' || value == null ? value : value.join(',')
      if (text) params.set(key, text)
    }
    return get<import('@rainver/protocol').ConversationInputSkillPart[]>(`/skills/available?${params}`, options)
  },
  previewSkillImport: (data: import('@rainver/protocol').SkillImportPreviewRequest, options?: RequestOptions) =>
    skillSourceRequest<SkillImportPreviewResponse>('/skill-sources/import-preview', data, options),
  /** Imports the previewed package; `package_hash` is the preview's, and a changed package answers 409 `skill_package_changed`. */
  importSkill: (data: import('@rainver/protocol').SkillImportRequest, options?: RequestOptions) =>
    skillSourceRequest<SkillPackage>('/skill-sources/import', data, options),
  listSkillPackages: (options?: RequestOptions, offset = 0) =>
    get<Page<SkillPackage>>(`/skill-packages?limit=100&offset=${offset}`, options),
  getSkillContent: (id: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').SkillPackageContent>(`/skill-packages/${encodeURIComponent(id)}/content`, options),
  listSkillBindings: (id: string, options?: RequestOptions) =>
    get<import('@rainver/protocol').SkillBinding[]>(`/skill-packages/${encodeURIComponent(id)}/bindings`, options),
  createSkillBindingProposal: (id: string, data: import('@rainver/protocol').SkillBindingRequest, options?: RequestOptions) =>
    operationAt<{proposal_id:string}>('POST',`/skill-packages/${encodeURIComponent(id)}/binding-proposal`,data,options?.idempotencyKey??crypto.randomUUID(),options).then(receipt=>get<Proposal>(`/proposals/${encodeURIComponent(receipt.proposal_id)}`,options)),
  getSkillPackage: (id: string, options?: RequestOptions) =>
    get<SkillPackage>(`/skill-packages/${encodeURIComponent(id)}`, options),
  /** Files the review; an enabling `binding` makes the same approval enable the package for that scope. */
  createSkillReviewProposal: (skillPackageId: string, data: import('@rainver/protocol').SkillReviewProposalRequest = {}, options?: RequestOptions) =>
    operationAt<{proposal_id:string}>('POST',`/skill-packages/${encodeURIComponent(skillPackageId)}/review-proposal`,data,options?.idempotencyKey??crypto.randomUUID(),options).then(receipt=>get<SkillImportApprovalProposalResponse>(`/proposals/${encodeURIComponent(receipt.proposal_id)}`,options)),

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
  reviewCycleRun: (data: ContextReviewCycleRequestInput = {},key:string=crypto.randomUUID()) =>
    operationAt<ContextReviewCycleResponse>('POST','/context-ops/review-cycle/run',data,key),
  contextObservationScan: (data: ContextOpsContextObservationScanRequestInput = {},key:string=crypto.randomUUID()) =>
    operationAt<ContextOpsContextObservationScanResponse>('POST','/context-ops/context-observations/scan',data,key),
}

export const askSpaceApi = {
  think: (data: AskSpaceRequest,key:string=crypto.randomUUID()) => contentRequest<AskSpaceResponse>('ask_space.think',data,key),
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
}

// ── ACP registry agents ───────────────────────────────────────────────────
export type AcpDistribution =
  | { kind: 'npx' | 'uvx'; package: string; args: string[]; env: Record<string, string> }
  | { kind: 'binary'; platforms: Record<string, { archive: string; cmd: string; args: string[]; sha256: string | null; env: Record<string, string> }> }

export interface AcpRegistryEntry {
  id: string
  name: string
  version: string
  description: string | null
  repository: string | null
  license: string | null
  icon: string | null
  distribution: AcpDistribution
}

/** An enabled registry agent, with the adapter type the server derived for it. */
export interface AcpAgentOut extends AcpRegistryEntry {
  enabled_at: string
  enabled_by_user_id: string | null
  runtime_key: string
  /** Hosts that still carry a managed copy; disabling is refused while any do. */
  installed_on: Array<{ host_id: string; name: string }>
}

export const acpAgentsApi = {
  registry: () => get<{ items: AcpRegistryEntry[] }>('/acp-agents/registry'),
  list: () => get<{ items: AcpAgentOut[] }>('/acp-agents'),
  enable: (registryId: string, key: string = crypto.randomUUID()) => operationAt<AcpAgentOut>('PUT', `/acp-agents/${encodeURIComponent(registryId)}`, {}, key),
  disable: async (registryId: string, key: string = crypto.randomUUID()): Promise<null> => {
    await operationAt('DELETE', `/acp-agents/${encodeURIComponent(registryId)}`, undefined, key)
    return null
  },
}

/** One frame of a runtime copy's login terminal. */
export type RuntimeLoginEvent =
  | { type: 'output'; data: string }
  | { type: 'hint'; text: string }
  /** The login waits for an OAuth redirect to a loopback port of the host; a browser elsewhere cannot reach it. */
  | { type: 'callback_wanted'; port: number; authorize_url: string }
  | { type: 'exit'; exit_code: number; logged_in: boolean | null }
  | { type: 'error'; message: string }

export type HostLoginTarget =
  | { kind: 'acp'; methodId: string }
  | { kind: 'cli' }
  | { kind: 'logout' }

/** The daemon's report for one install/uninstall of a managed runtime copy. */
interface RuntimeInstallResult {
  host_id: string
  runtime_key: string
  ok: boolean
  error: string | null
  installation: string | null
}

export const networkProfilesApi = {
  list: () => get<NetworkProfileOut[]>('/network-profiles'),
  get: (id: string) => get<NetworkProfileOut>(`/network-profiles/${encodeURIComponent(id)}`),
  create: (body: NetworkProfileCreateBody, key: string = crypto.randomUUID()) => operationAt<NetworkProfileOut>('POST', '/network-profiles', body, key),
  patch: (id: string, body: NetworkProfileUpdateBody, key: string = crypto.randomUUID()) =>
    operationAt<NetworkProfileOut>('PATCH', `/network-profiles/${encodeURIComponent(id)}`, body, key),
  delete: async (id: string, key: string = crypto.randomUUID()): Promise<void> => {
    await operationAt('DELETE', `/network-profiles/${encodeURIComponent(id)}`, undefined, key)
  },
}

// ── Jobs ──────────────────────────────────────────────────────────────────
export const jobsApi = {
  list:   (params: Record<string, string> = {}) =>
    get<Page<Job>>('/jobs?' + new URLSearchParams(params)),
  get:    (id: string)    => get<Job>(`/jobs/${id}`),
  events: (id: string)    => get<JobEvent[]>(`/jobs/${id}/events`),
  cancel: (id: string, key: string = crypto.randomUUID()) =>
    operationAt<OperationOutput<'job.cancel'>>('POST', `/jobs/${encodeURIComponent(id)}/cancel`, {}, key),
}

// ── Capture ───────────────────────────────────────────────────────────────
/**
 * The single capture entry. Destination is chosen by the client and sent
 * explicitly; the server never re-infers one, because the signal the default
 * reads (a paste event) exists only in the browser.
 */
export const captureApi = {
  create: (body: CaptureRequest,key:string=crypto.randomUUID()) => commandReceipt('capture.create',body,key),
  /** What a relocation would carry — the anchored block plus the orphans after it. */
  relocationPreview: (activityId: string) =>
    get<RelocationPreview>(`/captures/${activityId}/relocation`),
  relocate: (activityId: string, body: RelocationRequest,key:string=crypto.randomUUID()) =>
    commandReceipt('capture.relocate',{...body,activity_id:activityId},key),
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
    data: OperationInput<'activity.create'>,
    options: { spaceId?: string; key?:string } = {},
  ) =>
    operationAt<OperationOutput<'activity.create'>>('POST','/activity',data,options.key??crypto.randomUUID(),{spaceId:options.spaceId}),
  // File / voice capture (store-only). Sends multipart; lands in the Activity Inbox.
  upload: (
    file: File,
    options: { kind?: 'file' | 'voice'; title?: string; note?: string; project_folder_id?: string; project_id?: string; spaceId?: string; key?:string } = {},
  ) => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', options.kind ?? 'file')
    if (options.title) fd.append('title', options.title)
    if (options.note) fd.append('note', options.note)
    if (options.project_folder_id) fd.append('project_folder_id', options.project_folder_id)
    if (options.project_id) fd.append('project_id', options.project_id)
    return operationAt<OperationOutput<'activity.upload'>>('POST','/activity/upload',fd,options.key??crypto.randomUUID(),{spaceId:options.spaceId})
  },
  get:    (id: string) => get<ActivityInboxRecord>(`/activity/${id}`),
  review: (id: string,key:string=crypto.randomUUID()) => commandReceipt('activity.review',{activity_id:id},key),
  archive:(id: string,key:string=crypto.randomUUID()) => commandReceipt('activity.archive',{activity_id:id},key),
  consolidate: (id: string,key:string=crypto.randomUUID()) =>
    commandReceipt('activity.consolidate',{activity_id:id},key),
  summarize: (body: OperationInput<'activity.summary.request'>,key:string=crypto.randomUUID()) =>
    commandReceipt('activity.summary.request',body,key),
}

// ── Source / Evidence ────────────────────────────────────────────────────
/** Project briefings: reads never generate; generating, cancelling and the daily setting need Project write access. */
/** The caller's own personal briefing in this Space (never another person's). */
export const personalBriefingsApi = {
  overview: (spaceId: string, options: RequestOptions = {}) =>
    get<BriefingOverviewResponse>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal`, options),
  get: (spaceId: string, briefingId: string, options: RequestOptions = {}) =>
    get<Briefing>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal/${encodeURIComponent(briefingId)}`, options),
  generate: (spaceId: string, key: string = crypto.randomUUID()) =>
    commandReceipt('briefing.personal.request', {space_id:spaceId}, key, {spaceId}),
  cancel: (spaceId: string, briefingId: string, key: string = crypto.randomUUID()) =>
    commandReceipt('briefing.personal.cancel', {space_id:spaceId,briefing_id:briefingId}, key, {spaceId}),
  setDaily: async (spaceId: string, daily_enabled: boolean, key: string = crypto.randomUUID()) => {
    const result = await commandReceipt('briefing.personal.settings.set', { space_id: spaceId, daily_enabled }, key, { spaceId })
    return { daily_enabled: result.daily_enabled }
  },
  followUp: (spaceId: string, briefingId: string, index: number) =>
    queryAt<BriefingFollowUpPreview>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal/${encodeURIComponent(briefingId)}/highlights/${index}/follow-up`, {},{spaceId}),
  previewAdoption: (spaceId: string, briefingId: string, index: number) =>
    queryAt<BriefingAdoptionPreview>(`/spaces/${encodeURIComponent(spaceId)}/information-briefings/personal/${encodeURIComponent(briefingId)}/highlights/${index}/adoption/preview`, {},{spaceId}),
  adopt: (spaceId: string, briefingId: string, index: number, preview_hash: string, key:string=crypto.randomUUID()) =>
    commandReceipt('briefing.personal.adoption.confirm',{space_id:spaceId,briefing_id:briefingId,index,preview_hash},key,{spaceId}),
}

/** Retained historical Project highlights; every read reauthorizes the whole audience. */
export const projectBriefingHighlightsApi={
 followUp:(spaceId:string,projectId:string,briefingId:string,index:number)=>queryAt<BriefingFollowUpPreview>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/information-briefings/${encodeURIComponent(briefingId)}/highlights/${index}/follow-up`,{},{spaceId}),
 previewAdoption:(spaceId:string,projectId:string,briefingId:string,index:number)=>queryAt<BriefingAdoptionPreview>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/information-briefings/${encodeURIComponent(briefingId)}/highlights/${index}/adoption/preview`,{},{spaceId}),
 adopt:(spaceId:string,projectId:string,briefingId:string,index:number,preview_hash:string,key:string=crypto.randomUUID())=>commandReceipt('briefing.project.adoption.confirm',{space_id:spaceId,project_id:projectId,briefing_id:briefingId,index,preview_hash},key,{spaceId}),
};

export const informationDigestsApi = {
  reading: (spaceId: string, input: Partial<ReadingQuery> = {}, projectId?: string, options: RequestOptions = {}) => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(input)) if (value !== undefined) search.set(key, String(value))
    const scope = projectId ? `/projects/${encodeURIComponent(projectId)}` : ''
    return get<ReadingPage>(`/spaces/${encodeURIComponent(spaceId)}${scope}/reading?${search}`, { ...options, spaceId })
  },
  readingPreference: (spaceId: string, projectId: string) =>
    get<{ show_in_my_reading: boolean }>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/reading-preference`),
  setReadingPreference: async (spaceId: string, projectId: string, show_in_my_reading: boolean, key: string = crypto.randomUUID()) => {
    const result = await commandReceipt('reading.preference.set', { space_id: spaceId, project_id: projectId, show_in_my_reading }, key, { spaceId })
    return { show_in_my_reading: result.show_in_my_reading }
  },
  readingState: async (spaceId: string, itemId: string, body: ReadingStateRequest, projectId?: string, key: string = crypto.randomUUID()) => {
    const result = projectId
      ? await commandReceipt('reading.project_state.set', { ...body, space_id: spaceId, project_id: projectId, item_id: itemId }, key, { spaceId })
      : await commandReceipt('reading.personal_state.set', { ...body, space_id: spaceId, item_id: itemId }, key, { spaceId })
    return { updated: result.updated }
  },
  /** Read-only: the day's snapshot, or `missing`. Without a date, the latest complete day of the digest's timezone. */
  personal: (spaceId: string, date?: string) => {
    const q = date ? `?date=${encodeURIComponent(date)}` : ''
    return get<InformationDigestLookup>(`/spaces/${encodeURIComponent(spaceId)}/information-digests/personal${q}`)
  },
  project: (spaceId: string, projectId: string, date?: string, options: RequestOptions = {}) => {
    const q = date ? `?date=${encodeURIComponent(date)}` : ''
    return get<InformationDigestLookup>(`/spaces/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(projectId)}/information-digests${q}`, options)
  },
  /** Builds a missing complete day once; never rewrites an existing snapshot. */
  backfillPersonal: async (spaceId: string, date: string, key:string=crypto.randomUUID()):Promise<InformationDigestBackfillResult> => {
    const receipt=await commandReceipt('digest.personal.backfill',{space_id:spaceId,date},key,{spaceId});
    const result=await waitForJobResult<{digest_id:string;created:boolean}>(receipt,'Digest backfill');
    const current=await informationDigestsApi.personal(spaceId,date);
    if(current.status!=='available'||current.digest.id!==result.digest_id)throw new Error('Digest is unavailable');
    return {digest:current.digest,created:result.created};
  },
  backfillProject: async (spaceId: string, projectId: string, date: string, key:string=crypto.randomUUID()):Promise<InformationDigestBackfillResult> => {
    const receipt=await commandReceipt('digest.project.backfill',{space_id:spaceId,project_id:projectId,date},key,{spaceId});
    const result=await waitForJobResult<{digest_id:string;created:boolean}>(receipt,'Digest backfill');
    const current=await informationDigestsApi.project(spaceId,projectId,date);
    if(current.status!=='available'||current.digest.id!==result.digest_id)throw new Error('Digest is unavailable');
    return {digest:current.digest,created:result.created};
  },
  /** The caller's own Source annotation failure episodes. */
  annotationEpisodes: (spaceId: string) =>
    get<{ episodes: SourceAnnotationEpisode[] }>(`/spaces/${encodeURIComponent(spaceId)}/source-annotation/episodes`),
  retryAnnotation: (spaceId: string, body: { episode_id?: string; connection_id?: string } = {}, key:string=crypto.randomUUID()):Promise<{reopened:number}> =>
    commandReceipt('reading.annotation.retry',{...body,space_id:spaceId},key,{spaceId}),
  profile: (spaceId: string) =>
    get<InterestProfileSnapshot>(`/spaces/${encodeURIComponent(spaceId)}/interest-profile`),
  acceptCandidate: async (spaceId: string, phraseKey: string, body: { label?: string; domain_key?: string }, key: string = crypto.randomUUID()) =>
    (await commandReceipt('interest.candidate.accept',{space_id:spaceId,phrase_key:phraseKey,...body},key)).topic,
  dismissCandidate: async (spaceId: string, phraseKey: string, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.candidate.dismiss',{space_id:spaceId,phrase_key:phraseKey},key);return {dismissed:r.dismissed};
  },
  updateProfileSettings: async (spaceId: string, body: Partial<InterestProfileSnapshot['settings']>, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.settings.update',{space_id:spaceId,...body},key);return {settings:r.settings};
  },
  createTopic: async (spaceId: string, body: { label: string; domain_key: string; weight: number }, key: string = crypto.randomUUID()) =>
    (await commandReceipt('interest.topic.create',{space_id:spaceId,...body},key)).topic,
  updateTopic: async (spaceId: string, topicKey: string, body: { label: string; domain_key: string; weight: number }, key: string = crypto.randomUUID()) =>
    (await commandReceipt('interest.topic.update',{space_id:spaceId,topic_key:topicKey,...body},key)).topic,
  archiveTopic: async (spaceId: string, topicKey: string, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.topic.archive',{space_id:spaceId,topic_key:topicKey},key);return {archived:r.archived};
  },
  applyStarterPack: async (spaceId: string, pack: 'technology'|'science'|'world', key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.starter_pack.apply',{space_id:spaceId,key:pack},key);return {topics:r.topics,source_recommendations:r.source_recommendations};
  },
  backfillProfileHistory: async (spaceId: string, limit=500, key: string = crypto.randomUUID()) => {
    const r=await commandReceipt('interest.history.backfill',{space_id:spaceId,limit},key);return {queued:r.queued,limit:r.limit};
  },
  serendipityFeedback: async (spaceId: string, itemId: string, feedback: 'interesting' | 'neutral' | 'never', key: string = crypto.randomUUID()): Promise<SerendipityFeedbackResult> => {
    const {space_id: _space,user_id: _user,...result}=await commandReceipt('digest.serendipity.feedback',{space_id:spaceId,item_id:itemId,feedback},key);return result;
  },
}

export const sourcesApi = {
  materialProcessing: (itemId:string,options?:RequestOptions)=>get<import('@rainver/protocol').SourceMaterialProcessingState>(`/sources/items/${itemId}/processing`,options),
  /** Shows the named version of this material's literal Agent text as Markdown: a new version through the canonical writer (one material, on request; 409 if the shown version changed). */
  /** Material commands: one explicit key per attempt; the processing state is reread through materialProcessing. */
  showAgentTextAsMarkdown:async(itemId:string,shown:{artifact_id:string;source_snapshot_id:string|null},options:RequestOptions={},key:string=crypto.randomUUID())=>({artifact_id:(await sourceObjectCall('source.material.show_markdown',{source_item_id:itemId,syntax:'markdown',...shown},key,options)).artifact_id}),
  prepareMaterial:async(itemId:string,selection:Omit<OperationInput<'source.material.start'>,'source_item_id'>={},options:RequestOptions={},key:string=crypto.randomUUID()):Promise<import('@rainver/protocol').SourceMaterialProcessingState>=>receiptState(await sourceObjectCall('source.material.start',{...selection,source_item_id:itemId},key,options)),
  cancelMaterialProcessing:async(itemId:string,options:RequestOptions={},key:string=crypto.randomUUID()):Promise<import('@rainver/protocol').SourceMaterialProcessingState>=>receiptState(await sourceObjectCall('source.material.cancel',{source_item_id:itemId},key,options)),
  requestMaterialStorage:async(itemId:string,options:RequestOptions={},key:string=crypto.randomUUID()):Promise<{proposal_id?:string;source_name?:string;allowed?:boolean}>=>receiptState(await sourceObjectCall('source.material.request_storage',{source_item_id:itemId},key,options)),
  providers: (options?: RequestOptions) => get<SourceProvider[]>('/sources/providers', options),
  sourceCatalog: () => get<SourceCatalog>('/instance/source-catalog'),
  updateCatalogProvider: (id: string, body: { status?: 'active' | 'disabled' }, key: string = crypto.randomUUID()) =>
    operationAt<SourceCatalogProvider>('PATCH', `/instance/source-catalog/providers/${encodeURIComponent(id)}`, body, key),
  updateCatalogConnector: (id: string, body: { status?: 'active' | 'disabled' }, key: string = crypto.randomUUID()) =>
    operationAt<SourceConnector>('PATCH', `/instance/source-catalog/connectors/${encodeURIComponent(id)}`, body, key),
  updateCatalogMapping: (id: string, body: { status?: 'active' | 'disabled'; priority?: number }, key: string = crypto.randomUUID()) =>
    operationAt<SourceCatalogMapping>('PATCH', `/instance/source-catalog/mappings/${encodeURIComponent(id)}`, body, key),
  channels: (params: { status?: string; provider_key?: string } = {}, options?: RequestOptions) => {
    const q = new URLSearchParams()
    if (params.status) q.set('status', params.status)
    if (params.provider_key) q.set('provider_key', params.provider_key)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return get<SourceChannel[]>(`/sources/channels${suffix}`, options)
  },
  recommendations: () => get<SourceRecommendation[]>('/sources/recommendations'),
  followed: (options?: RequestOptions) => get<FollowedSourceChannel[]>('/sources/followed', options),
  decideRecommendation: async (channelId:string,decision:'subscribed'|'dismissed'|'muted',key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.recommendation.decide',{source_channel_id:channelId,decision},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source recommendation decision did not complete');
    return result.data;
  },
  /** Leave (`muted`) or rejoin (`subscribed`) a channel; what was delivered while subscribed stays readable. */
  setChannelSubscription: async (channelId:string,status:'subscribed'|'muted',key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.channel.set_subscription',{source_channel_id:channelId,status},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source subscription did not complete');
    return result.data;
  },
  customSourceCredentials: () => get<CustomSourceCredentialDTO[]>('/sources/custom-source-credentials'),
  getChannel: (id: string) => get<SourceChannel>(`/sources/channels/${id}`),
  createChannel: async (body:OperationInput<'source.channel.create'>,options:RequestOptions={},key:string=crypto.randomUUID()):Promise<SourceChannel> => {
    const result=await callOperation('source.channel.create',body,key,options);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source Monitor creation did not complete');
    return result.data;
  },
  /** Queues one provider preview (quota spent at admission), then reads its result through the Source request reader; never resubmits. */
  previewQuery: async (body: OperationInput<'source.query.preview'>, key: string = crypto.randomUUID()): Promise<SourceQueryPreview> =>
    (await waitForSourceRequest(await sourceObjectCall('source.query.preview', body, key), 'Query preview')) as unknown as SourceQueryPreview,
  updateChannel: async (id:string,body:OperationInput<'source.channel.update'>['changes'],key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.channel.update',{source_channel_id:id,changes:body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source Monitor update did not complete');
    return result.data;
  },
  scanChannel: async (id:string,options:RequestOptions={},key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.channel.scan',{source_channel_id:id},key,options);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source Monitor scan was not queued');
    return result.data;
  },
  previewChannelBackfill: async (channelId: string, body: { strategy: Partial<SourceBackfillStrategy>; quota_policy?: Partial<SourceBackfillQuotaPolicy> }):Promise<SourceBackfillPreview> => {
    const result=await queryOperation('source.backfill.preview',{...body,source_channel_id:channelId});
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Backfill preview unavailable');
    return result.data;
  },
  createChannelBackfillPlan: async (channelId: string, body: { idempotency_key: string; strategy: Partial<SourceBackfillStrategy>; quota_policy?: Partial<SourceBackfillQuotaPolicy>; project_source_binding_id?: string; project_operation_id?: string },key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.backfill.create_plan',{...body,source_channel_id:channelId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Backfill plan unavailable');
    return get<SourceBackfillPlan>(`/sources/channels/${encodeURIComponent(channelId)}/backfill/plans/${encodeURIComponent(result.data.plan_id)}`);
  },
  channelBackfillPlans: (channelId: string) => get<SourceBackfillPlan[]>(`/sources/channels/${channelId}/backfill/plans`),
  /** Draft creation through core (access-owner placement); the Monitor is reread through its authorized reader. */
  createCustomSourceDraft: async (body: OperationInput<'source.custom.draft.create'>, key: string = crypto.randomUUID()): Promise<SourceChannel> => {
    const receipt = await sourceObjectCall('source.custom.draft.create', body, key)
    return { ...(await get<SourceChannel>(`/sources/channels/${encodeURIComponent(receipt.source_channel_id!)}`, { spaceId: receipt.space_id })), id: receipt.id, source_channel_id: receipt.source_channel_id } as SourceChannel
  },
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
  /** Queues the handler test (it executes externally) and waits; the run is reread through the handler-run reader. */
  testCustomSourceHandler: async (connectionId: string, body: { handler_version_id: string; fixture_html?: string }, key: string = crypto.randomUUID()): Promise<CustomSourceTestOutcome> => {
    const done = await waitForSourceRequest(await sourceObjectCall('source.custom.handler.test.request', { ...body, source_connection_id: connectionId }, key), 'Handler test')
    return get<CustomSourceTestOutcome>(`/sources/connections/${encodeURIComponent(connectionId)}/handler-runs/${encodeURIComponent(String(done.run_id))}`)
  },
  activateCustomSourceHandler: async (connectionId: string, body: { handler_version_id: string; next_check_at?: string | null; schedule_rule?: SourceScheduleRule | null }, key: string = crypto.randomUUID()): Promise<CustomSourceActivationResult> => {
    const receipt = await sourceObjectCall('source.custom.handler.activate', { ...body, schedule_rule: body.schedule_rule as Record<string, unknown> | null | undefined, source_connection_id: connectionId }, key)
    const handler_version = await get<CustomSourceActivationResult['handler_version']>(`/sources/connections/${encodeURIComponent(connectionId)}/handler-versions/${encodeURIComponent(receipt.handler_version_id)}`)
    return { status: receipt.status, deltas: receipt.deltas, proposal_id: receipt.proposal_id, handler_version } as CustomSourceActivationResult
  },
  customSourceSpacePolicy: () =>
    get<CustomSourceSpacePolicy>('/sources/custom-source-settings/space'),
  customSourceInstanceRunnerSettings: () =>
    get<CustomSourceInstanceRunnerSettings>('/sources/custom-source-settings/instance'),
  updateCustomSourceInstanceRunnerSettings: async (body: CustomSourceInstanceRunnerSettingsUpdate, key: string = crypto.randomUUID()): Promise<CustomSourceInstanceRunnerSettings> =>
    (await sourceObjectCall('source.custom.settings.instance.update', body, key)) as CustomSourceInstanceRunnerSettings,
  updateCustomSourceSpacePolicy: async (body: CustomSourceSpacePolicyUpdate, key: string = crypto.randomUUID()): Promise<CustomSourceSpacePolicy> =>
    (await sourceObjectCall('source.custom.settings.space.update', body, key)) as CustomSourceSpacePolicy,
  /** Recipe planning fetches the endpoint, so it is queued; the plan is read through the Source request reader. */
  planSourceRecipe: async (body: OperationInput<'source.recipe.plan.request'>, key: string = crypto.randomUUID()): Promise<SourceRecipePlanResponse> =>
    (await waitForSourceRequest(await sourceObjectCall('source.recipe.plan.request', body, key), 'Recipe planning')) as unknown as SourceRecipePlanResponse,
  createSourceRecipe: async (body: SourceRecipeCreateRequest,key:string=crypto.randomUUID()):Promise<SourceRecipeCreateResponse> => {
    const result=await callOperation('source.recipe.create',body,key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source recipe draft did not complete');
    return result.data;
  },
  /** Queues the dry-run, waits for it, then rereads the version (its recorded result) through the authorized reader. */
  dryRunSourceRecipe: async (connectionId: string, body: { recipe_version_id: string; fixture_content?: string }, key: string = crypto.randomUUID()): Promise<SourceRecipeDryRunResponse> => {
    await waitForSourceRequest(await sourceObjectCall('source.recipe.dry_run.request', { ...body, source_connection_id: connectionId }, key), 'Recipe dry-run')
    const version = await get<SourceRecipeDryRunResponse['recipe_version']>(`/sources/connections/${encodeURIComponent(connectionId)}/recipe-versions/${encodeURIComponent(body.recipe_version_id)}`)
    return { recipe_version: version, dry_run: version.test_result_json } as SourceRecipeDryRunResponse
  },
  activateSourceRecipe: async (connectionId: string, body: { recipe_version_id: string; next_check_at?: string | null; schedule_rule?: SourceScheduleRule | null }, key: string = crypto.randomUUID()): Promise<SourceRecipeActivationResult> => {
    const receipt = await sourceObjectCall('source.recipe.activate', { ...body, schedule_rule: body.schedule_rule as Record<string, unknown> | null | undefined, source_connection_id: connectionId }, key)
    const version = await get<SourceRecipeActivationResult['recipe_version']>(`/sources/connections/${encodeURIComponent(connectionId)}/recipe-versions/${encodeURIComponent(receipt.recipe_version_id)}`)
    return { status: receipt.status, deltas: receipt.deltas, proposal_id: receipt.proposal_id, recipe_version: version } as SourceRecipeActivationResult
  },
  /** Bridge receipt; the new recipe Source and its version are reread through their authorized readers. */
  bridgePipelineSourceRecipe: async (connectionId: string, body: SourceRecipePipelineBridgeRequest = {}, key: string = crypto.randomUUID()) =>
    sourceObjectCall('source.custom.pipeline_bridge', { ...(body as Record<string, unknown>), source_connection_id: connectionId } as OperationInput<'source.custom.pipeline_bridge'>, key),
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
  getItem: (id: string, options?: RequestOptions) =>
    get<SourceItem>(`/sources/items/${id}`, options),
  /** Core commands return identity receipts; the item is reread through its authorized reader in the receipt Space. */
  updateItem: async (id: string, body: { connection_id: string | null }, key: string = crypto.randomUUID()) =>
    currentSourceItem(await sourceObjectCall('source.item.update', { source_item_id: id, connection_id: body.connection_id }, key)),
  createManualUrl: async (body: OperationInput<'source.item.save_url'>, options: RequestOptions = {}, key: string = crypto.randomUUID()) =>
    currentSourceItem(await sourceObjectCall('source.item.save_url', body, key, options)),
  itemAction: async (id: string, action: OperationInput<'source.item.queue'>['action'] | OperationInput<'source.item.triage'>['action'], options: RequestOptions = {}, key: string = crypto.randomUUID()) =>
    currentSourceItem(action === 'queue_content' || action === 'archive_snapshot'
      ? await sourceObjectCall('source.item.queue', { source_item_id: id, action }, key, options)
      : await sourceObjectCall('source.item.triage', { source_item_id: id, action }, key, options)),
  jobs: (params: {
    status?: string
    source_item_id?: string
    connection_id?: string
    job_type?: string
    limit?: number
    offset?: number
  } = {}, options?: RequestOptions) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.source_item_id !== undefined) q.source_item_id = params.source_item_id
    if (params.connection_id !== undefined) q.connection_id = params.connection_id
    if (params.job_type !== undefined) q.job_type = params.job_type
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<ExtractionJob>>('/sources/jobs?' + new URLSearchParams(q), options)
  },
  runJob: async(id:string,options:RequestOptions={},key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.extraction.dispatch',{extraction_job_id:id},key,options);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source dispatch did not enqueue');return result.data;
  },

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
  updateEvidence: async (id: string, body: Omit<OperationInput<'source.evidence.update'>, 'evidence_id'>, key: string = crypto.randomUUID()) => {
    const receipt = await sourceObjectCall('source.evidence.update', { ...body, evidence_id: id }, key)
    return get<ExtractedEvidence>(`/sources/evidence/${encodeURIComponent(receipt.id)}`, { spaceId: receipt.space_id })
  },
  /** Returns the link receipt; current links are listed through evidenceLinks. */
  createEvidenceLink: (body: OperationInput<'source.evidence.link'>, key: string = crypto.randomUUID()) =>
    sourceObjectCall('source.evidence.link', body, key),
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
  createProjectSourceBinding: async (body: OperationInput<'project.source.bind'>,key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.bind',body,key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source binding did not complete');
    return result.data;
  },
  updateProjectSourceBinding: async (projectId:string,bindingId:string,changes:OperationInput<'project.source.update'>['changes'],key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.update',{project_id:projectId,binding_id:bindingId,changes},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source binding update did not complete');
    return result.data;
  },
  deleteProjectSourceBinding: async (projectId:string,bindingId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.unbind',{project_id:projectId,binding_id:bindingId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source unbinding did not complete');
    return result.data;
  },
  backfillProjectSourceBinding: async (projectId:string,bindingId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.source.backfill',{project_id:projectId,binding_id:bindingId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source material routing did not complete');
    return result.data;
  },
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
  /** Queues a one-off processing run (a Job receipt); the run itself is read through the Source run reader. */
  summarize: (body: OperationInput<'source.processing.run_once'>, key: string = crypto.randomUUID()) =>
    sourceObjectCall('source.processing.run_once', body, key),
  postProcessingRules: (channelId: string) =>
    get<SourcePostProcessingRule[]>(`/sources/channels/${channelId}/post-processing/rules`),
  createPostProcessingRule: async(channelId:string,body:SourcePostProcessingRuleCreate,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.create',{source_channel_id:channelId,rule:body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source rule configuration did not complete');return result.data;
  },
  updatePostProcessingRule: async(channelId:string,ruleId:string,body:SourcePostProcessingRuleUpdate,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.update',{source_channel_id:channelId,rule_id:ruleId,changes:body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source rule configuration did not complete');return result.data;
  },
  runPostProcessingRule: async(channelId:string,ruleId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.dispatch',{source_channel_id:channelId,rule_id:ruleId,mode:'run'},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source dispatch did not enqueue');return result.data;
  },
  drainPostProcessingRule: async(channelId:string,ruleId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('source.processing.rule.dispatch',{source_channel_id:channelId,rule_id:ruleId,mode:'drain'},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source dispatch did not enqueue');return result.data;
  },
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
  /** Decision review through core: an identity receipt (review status, proposal / queued Job ids); decisions are reread through their list. */
  postProcessingDecisionAction: (decisionId: string, action: OperationInput<'source.processing.decision.queue'>['action'] | OperationInput<'source.processing.decision.review'>['action'], key: string = crypto.randomUUID()) =>
    action === 'queue_content' || action === 'extract_evidence'
      ? sourceObjectCall('source.processing.decision.queue', { decision_id: decisionId, action }, key)
      : sourceObjectCall('source.processing.decision.review', { decision_id: decisionId, action }, key),
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
type ReaderWriteReceipt = import('@rainver/protocol').ReaderWriteReceipt
/** One explicit-key Reader command, never retried; bodies come only from the authorized Reader readers. */
function readerWrite(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, options: RequestOptions = {}): Promise<ReaderWriteReceipt> {
  return operationAt<ReaderWriteReceipt>(method, `/reader${path}`, body ?? {}, crypto.randomUUID(), options)
}
function readerWriteRefusal(outcome: import('@rainver/protocol').ReaderWriteJobResult['outcome']): ApiRequestError {
  if (outcome === 'unavailable') return new ApiRequestError('This document or annotation is no longer available', 404, 'operation_not_found')
  if (outcome === 'conflict') return new ApiRequestError('The document changed. Reload before trying again.', 409, 'operation_conflict')
  return new ApiRequestError('The change could not be applied', 422, 'operation_invalid_input')
}
/** Read-only polling of one queued Reader write through its current-access reader. Never resubmits. */
async function waitForReaderWrite(receipt: ReaderWriteReceipt): Promise<import('@rainver/protocol').ReaderWriteJobResult> {
  const started = Date.now(), authGeneration = _authContextGeneration
  for (let attempt = 0; ; attempt++) {
    if (authGeneration !== _authContextGeneration) throw new ApiRequestError('The session changed while saving', 401, 'authentication_required')
    const view = await get<import('@rainver/protocol').ReaderWriteRequestView>(`/reader/write-requests/${encodeURIComponent(receipt.job_id ?? receipt.id)}`, { spaceId: receipt.space_id })
    if (view.status === 'completed' && view.result) return view.result
    if (view.status === 'failed' || view.status === 'cancelled' || view.status === 'completed') throw new Error('The Reader change did not complete')
    if (Date.now() - started > 60000) throw new Error('The Reader change is still being saved; refresh later')
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, 150 * 2 ** attempt)))
  }
}
async function readerAnnotationAfter(receipt: ReaderWriteReceipt): Promise<ReaderAnnotation> {
  const list = await get<ReaderAnnotationsResponse>(`/reader/documents/${receipt.document_type}/${receipt.document_id}/annotations`, { spaceId: receipt.space_id })
  const found = list.items.find(item => item.id === receipt.annotation_id)
  if (!found) throw readerWriteRefusal('unavailable')
  return found
}
async function readerThreadsAfter(receipt: ReaderWriteReceipt): Promise<ReaderCommentThread[]> {
  return (await get<{ items: ReaderCommentThread[] }>(`/reader/annotations/${receipt.annotation_id}/threads`, { spaceId: receipt.space_id })).items
}
export const readerApi = {
  sourceVersions: (itemId: string, offset = 0) =>
    get<import('@rainver/protocol').ReaderSourceVersions>(`/reader/source-items/${itemId}/versions?offset=${offset}`),
  sourceVersion: (itemId: string, snapshotId: string) =>
    get<ReaderDocumentPayload>(`/reader/source-items/${itemId}/versions/${encodeURIComponent(snapshotId)}`),
  /** `origin: 'serendipity'` marks an open that came from the digest's serendipity section; it is not interest evidence. */
  getDocument: (documentType: string, documentId: string, options: { origin?: 'library' | 'serendipity' | 'project' } = {}) =>
    get<ReaderDocumentPayload>(`/reader/documents/${documentType}/${documentId}${options.origin ? `?origin=${options.origin}` : ''}`),

  documentNote: (documentType: string, documentId: string) =>
    get<ReaderDocumentNoteResponse>(`/reader/documents/${documentType}/${documentId}/note`),
  createDocumentNote: async (documentType: string, documentId: string, title: string) => {
    const receipt = await readerWrite('POST', `/documents/${documentType}/${documentId}/note`, { title })
    return get<ReaderDocumentNoteResponse>(`/reader/documents/${documentType}/${documentId}/note`, { spaceId: receipt.space_id })
  },

  listAnnotations: (documentType: string, documentId: string) =>
    get<ReaderAnnotationsResponse>(`/reader/documents/${documentType}/${documentId}/annotations`),

  createAnnotation: async (body: ReaderAnnotationCreate) =>
    readerAnnotationAfter(await readerWrite('POST', '/annotations', body)),

  updateAnnotation: async (annotationId: string, body: ReaderAnnotationUpdate) =>
    readerAnnotationAfter(await readerWrite('PATCH', `/annotations/${annotationId}`, body)),

  /** Queued: the server reads the body outside its transaction, then the current annotation is reread. */
  updateAnnotationRange: async (annotationId: string, body: ReaderAnnotationRangeUpdate) => {
    const receipt = await readerWrite('PATCH', `/annotations/${annotationId}/range`, body)
    const result = await waitForReaderWrite(receipt)
    if (result.outcome !== 'applied') throw readerWriteRefusal(result.outcome)
    return readerAnnotationAfter(receipt)
  },

  deleteAnnotation: async (annotationId: string) => { await readerWrite('DELETE', `/annotations/${annotationId}`) },

  listThreads: (annotationId: string) =>
    get<{ items: ReaderCommentThread[] }>(`/reader/annotations/${annotationId}/threads`),

  createComment: async (annotationId: string, body: ReaderCommentCreate) => {
    const receipt = await readerWrite('POST', `/annotations/${annotationId}/comments`, body)
    const thread = (await readerThreadsAfter(receipt)).find(item => item.id === receipt.id)
    if (!thread) throw readerWriteRefusal('unavailable')
    return { thread }
  },

  updateComment: async (commentId: string, body: ReaderCommentUpdate) => {
    const receipt = await readerWrite('PATCH', `/comments/${commentId}`, body)
    const comment = (await readerThreadsAfter(receipt)).flatMap(thread => thread.comments).find(item => item.id === receipt.id)
    if (!comment) throw readerWriteRefusal('unavailable')
    return comment
  },

  updateThread: async (threadId: string, body: ReaderThreadUpdate) => {
    const receipt = await readerWrite('PATCH', `/comment-threads/${threadId}`, body)
    const thread = (await readerThreadsAfter(receipt)).find(item => item.id === receipt.id)
    if (!thread) throw readerWriteRefusal('unavailable')
    return thread
  },

  /** Identity-only receipt; the candidate Evidence is read through its own reader. */
  createEvidence: (annotationId: string, body: ReaderCreateEvidenceRequest) =>
    readerWrite('POST', `/annotations/${annotationId}/evidence`, body),

  /** Identity-only receipt of the pending proposal (memory_create or knowledge_create). */
  createProposal: (annotationId: string, body: ReaderCreateProposalRequest) =>
    readerWrite('POST', `/annotations/${annotationId}/proposals`, body),

  /** The person's own reading position in a document (private; not read status). */
  getPosition: (spaceId: string, documentType: string, documentId: string) =>
    get<ReaderPositionResult>(`/reader/documents/${documentType}/${documentId}/position`, { spaceId }),

  /** Queued, then reread. A keepalive report at page exit is sent once and not awaited. */
  putPosition: async (spaceId: string, documentType: string, documentId: string, body: ReaderPositionWrite, options: { keepalive?: boolean } = {}): Promise<ReaderPositionResult> => {
    const receipt = await readerWrite('PUT', `/documents/${documentType}/${documentId}/position`, body, { spaceId, ...options })
    if (options.keepalive) return { position: null, accepted: true }
    const result = await waitForReaderWrite(receipt)
    if (result.outcome !== 'applied' && result.outcome !== 'not_accepted') throw readerWriteRefusal(result.outcome)
    const current = await get<ReaderPositionResult>(`/reader/documents/${documentType}/${documentId}/position`, { spaceId })
    return { position: current.position, accepted: result.outcome === 'applied' }
  },

  getAppearance: () => get<ReaderAppearance>('/reader/preferences/appearance'),

  putAppearance: async (body: ReaderAppearance) => {
    await readerWrite('PUT', '/preferences/appearance', body)
    return get<ReaderAppearance>('/reader/preferences/appearance')
  },

  listByProject: (projectId: string, limit?: number) =>
    get<{ items: ReaderAnnotation[] }>(
      `/reader/annotations?project_id=${encodeURIComponent(projectId)}${limit != null ? `&limit=${limit}` : ''}`,
    ),
}

// ── Projects ──────────────────────────────────────────────────────────────
async function projectManagementCall<Id extends keyof typeof import('@rainver/protocol').PROJECT_MANAGEMENT_SCHEMAS>(id:Id,input:OperationInput<Id>,key:string){
  const result=await callOperation(id,input,key);
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Project command did not complete');
  return result.data;
}
async function currentProjectVersion<T extends {id:string}>(kind:'brief'|'instruction',receipt:{project_id:string;id:string;space_id:string}){
  const rows=await get<T[]>(`/projects/${encodeURIComponent(receipt.project_id)}/${kind}-versions`,{spaceId:receipt.space_id});
  const row=rows.find(r=>r.id===receipt.id);if(!row)throw new Error('Project version no longer available');return row;
}
export const projectsApi = {
  streamUpdates: async(id:string,onFrame:(frame:import('@rainver/protocol').ProjectUpdateFrame)=>void,options:RequestOptions={})=>{
    const headers:Record<string,string>={Accept:'text/event-stream','X-Rainver-Space-Id':options.spaceId??_spaceId}
    if(_apiKey)headers.Authorization=`Bearer ${_apiKey}`
    const response=await fetch(`${BASE}/projects/${encodeURIComponent(id)}/updates/stream`,{headers,signal:options.signal})
    if(response.status===401)window.dispatchEvent(new Event('auth:required'))
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new ApiRequestError('Project stream unavailable',response.status)}
    for await(const frame of readServerSentEvents(response)){
      if(options.signal?.aborted)return
      onFrame(ProjectUpdateFrameSchema.parse(JSON.parse(frame.data)))
    }
    if(!options.signal?.aborted)throw new ApiRequestError('Project stream disconnected',502)
  },
  members: (id: string) => get<ProjectMember[]>(`/projects/${encodeURIComponent(id)}/members`),
  addMember: async (id: string, body: ProjectMemberInput,key:string=crypto.randomUUID()) => {
    const receipt=await projectManagementCall('project.member.add',{...body,project_id:id},key);
    const members=await get<ProjectMember[]>(`/projects/${encodeURIComponent(id)}/members`,{spaceId:receipt.space_id});
    const row=members.find(member=>member.id===receipt.id);if(!row)throw new Error('Project member no longer available');return row;
  },
  removeMember: async (id: string, userId: string,key:string=crypto.randomUUID()) => {await projectManagementCall('project.member.remove',{project_id:id,user_id:userId},key);},
  list: (params: { status?: string; limit?: number; offset?: number } = {}, options?: RequestOptions) => {
    const q: Record<string, string> = {}
    if (params.status !== undefined) q.status = params.status
    if (params.limit !== undefined) q.limit = String(params.limit)
    if (params.offset !== undefined) q.offset = String(params.offset)
    return get<Page<Project>>('/projects?' + new URLSearchParams(q), options)
  },
  create: async (data: ProjectCreate,key:string=crypto.randomUUID()) => {
    const receipt=await projectManagementCall('project.create',data,key);return get<Project>(`/projects/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  },
  get: (id: string, options?: RequestOptions) => get<Project>(`/projects/${id}`,options),
  update: async(id:string,data:ProjectUpdate,key:string=crypto.randomUUID()) => {const receipt=await projectManagementCall('project.update',{project_id:id,...data},key);return get<Project>(`/projects/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});},
  archive: async(id:string,key:string=crypto.randomUUID()) => {const receipt=await projectManagementCall('project.archive',{project_id:id},key);return get<Project>(`/projects/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});},
  /** Draft and published snapshot side by side, for Project writers. */
  publicSummaryEditor: (id: string) =>
    get<ProjectPublicSummaryEditorState>(`/projects/${encodeURIComponent(id)}/public-summary/editor`),
  /** Saves the draft; every save bumps `draft_version`. Never changes what readers see. */
  savePublicSummaryDraft: async(id:string,body:ProjectPublicSummaryUpsertBody,key:string=crypto.randomUUID()) => {
    const receipt=await projectManagementCall('project.public_summary.save',{project_id:id,...body},key),state=await get<ProjectPublicSummaryEditorState>(`/projects/${encodeURIComponent(receipt.project_id)}/public-summary/editor`,{spaceId:receipt.space_id});
    if(!state.draft)throw new Error('Public summary draft is no longer available');return state.draft;
  },
  /** Queues one draft generation, then reads its Run until it settles; never resubmits the command. */
  generatePublicSummaryDraft: async (id: string, key:string=crypto.randomUUID()):Promise<ProjectPublicSummaryDraft> => {
    const receipt=await commandReceipt('project.public_summary.draft.generate',{project_id:id},key)
    await waitForProviderRun(receipt,'Public summary draft')
    const state=await get<ProjectPublicSummaryEditorState>(`/projects/${encodeURIComponent(receipt.project_id)}/public-summary/editor`,{spaceId:receipt.space_id})
    if(!state.draft||state.draft.generated_by_run_id!==receipt.run_id)throw new Error('The generated draft is no longer the current draft; refresh before publishing')
    return state.draft
  },
  /** Approves the named draft version as the space-public snapshot (owner-level). */
  publishPublicSummary: async(id:string,draftVersion:number,key:string=crypto.randomUUID()) => {
    const receipt=await projectManagementCall('project.public_summary.publish',{project_id:id,draft_version:draftVersion},key);return get<ProjectPublicSummary>(`/projects/${encodeURIComponent(receipt.project_id)}/public-summary`,{spaceId:receipt.space_id});
  },
  /** Takes the snapshot down; the draft stays (owner-level). */
  revokePublicSummary: async(id:string,key:string=crypto.randomUUID()) => {await projectManagementCall('project.public_summary.revoke',{project_id:id},key);},
  getOverview: (id: string) => get<ProjectOverview>(`/projects/${id}/overview`),
  hostExecutionTargets: (id: string) =>
    get<HostExecutionTargetsResponse>(`/projects/${encodeURIComponent(id)}/host-execution-targets`),
  getBoard: (id: string) => get<ProjectBoard>(`/projects/${id}/board`),
  configureBoard: async (id: string, body: Omit<OperationInput<'board.configure'>,'project_id'>, key: string) => {
    const result=await callOperation('board.configure',{...body,project_id:id},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Board command did not complete');
    return get<ProjectBoard>(`/projects/${id}/board`);
  },
  mainlineRoom: (id: string, options: RequestOptions = {}) => get<ProjectMainlineRoomResponse>(`/projects/${id}/mainline-room`, options),
  /**
   * Everyone who can read this Project.
   *
   * The roster picker's candidate source. Not `spacesApi.members`: a Space
   * member who cannot read the Project is someone the server refuses to invite,
   * so offering them produces a control that only ever fails.
   */
  readers: (id: string) => get<ProjectReadersResponse>(`/projects/${id}/readers`),
  /** The viewer's view of the Project's Rooms: only Rooms they are a member of; enrols them in the mainline. */
  rooms: (id: string, params: { limit?: number; offset?: number } = {}, options: RequestOptions = {}) =>
    get<ProjectRoomsResponse>(`/projects/${encodeURIComponent(id)}/rooms?${pageQuery(params)}`, options),
  /** The Project's Agent list, filtered by the viewer's own Agent read access. */
  agents: (id: string, params: { q?: string; limit?: number; offset?: number } = {}, options: RequestOptions = {}) =>
    get<ProjectAgentListResponse>(`/projects/${encodeURIComponent(id)}/agents?${pageQuery(params)}`, options),
  /** One Agent on the Project's list for the viewer; a 404 means it is not on it (or not readable by them). */
  agent: (id: string, agentId: string, options: RequestOptions = {}) =>
    get<ProjectAgent>(`/projects/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, options),
  /** Agents from the viewer's library they may add to this Project. */
  agentCandidates: (id: string, params: { q?: string; limit?: number; offset?: number } = {}, options: RequestOptions = {}) =>
    get<ProjectAgentCandidatesResponse>(`/projects/${encodeURIComponent(id)}/agent-candidates?${pageQuery(params)}`, options),
  // One keyed command; the caller re-reads the list. Joins no Room.
  addAgent: (id: string, agentId: string, key: string = crypto.randomUUID()) =>
    commandReceipt('project.agent.add', { project_id: id, agent_id: agentId }, key),
  // Leaves every Room roster as it is.
  removeAgent: (id: string, agentId: string, key: string = crypto.randomUUID()) =>
    commandReceipt('project.agent.remove', { project_id: id, agent_id: agentId }, key),
  conversations: (id: string, params: { limit?: number; offset?: number } = {}) =>
    get<ProjectConversationsResponse>(`/projects/${id}/conversations?` + new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    )),
  updates: (id: string, params: { cursor?: string; limit?: number } = {}) =>
    get<ProjectWorkUpdatesResponse>(`/projects/${id}/updates?` + new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    )),
  postUpdate: (id:string,body:{summary:string},key:string=crypto.randomUUID()) => projectManagementCall('project.update.report',{project_id:id,...body},key),
  operations: async (id: string) => {
    const all:ProjectOperation[]=[];let after:string|undefined;
    for(;;){const page=await get<ProjectOperation[]>(`/projects/${id}/operations?limit=100${after?`&after_id=${encodeURIComponent(after)}`:''}`);all.push(...page);if(page.length<100)break;after=page[page.length-1]!.id;}
    return all.sort((a,b)=>Date.parse(b.updated_at)-Date.parse(a.updated_at));
  },
  undoUpdate: (projectId:string,eventId:string,key:string=crypto.randomUUID()) => projectManagementCall('project.update.undo',{project_id:projectId,event_id:eventId},key),
  getOperation: (id: string, operationId: string) => get<ProjectOperation>(`/projects/${id}/operations/${operationId}`),
  createOperation: (id: string, body: Omit<OperationInput<'project.operation.create'>,'project_id'>, key: string) =>
    callOperation('project.operation.create', {...body, project_id:id}, key),
  cancelOperation: (id: string, operationId: string, key: string) =>
    callOperation('project.operation.cancel', {project_id:id, operation_id:operationId}, key),
  sourceBindings: (id: string, sourceChannelId?: string) => {
    const q = sourceChannelId ? `?source_channel_id=${encodeURIComponent(sourceChannelId)}` : ''
    return get<ProjectSourceBinding[]>(`/projects/${id}/sources/bindings${q}`)
  },
  sourceExtractionProfiles: (id: string) => get<ProjectExtractionProfile[]>(`/projects/${id}/sources/extraction-profiles`),
  sourceHealth: (id: string) => get<SourceHealth[]>(`/projects/${id}/sources/health`),
  createSourceBinding: (id:string,body:Omit<OperationInput<'project.source.bind'>,'project_id'>,key?:string) =>
    sourcesApi.createProjectSourceBinding({...body,project_id:id},key),
  proposeSourceBinding: async (id: string, body: Omit<OperationInput<'project.source.bind.propose'>,'project_id'>, key:string=crypto.randomUUID()) => {
    const receipt=await commandReceipt('project.source.bind.propose',{...body,project_id:id},key)
    return {proposal:await get<Proposal>(`/proposals/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id}),auto_applied:false}
  },
  proposeSourceSetup: (id:string,body:Omit<OperationInput<'project.source.setup.propose'>,'project_id'>,key:string=crypto.randomUUID()) =>
    commandReceipt('project.source.setup.propose',{...body,project_id:id},key),
  updateSourceBinding: (id:string,bindingId:string,body:OperationInput<'project.source.update'>['changes'],key?:string) =>
    sourcesApi.updateProjectSourceBinding(id,bindingId,body,key),
  deleteSourceBinding: (id:string,bindingId:string,key?:string) =>
    sourcesApi.deleteProjectSourceBinding(id,bindingId,key),
  backfillSourceBinding: (id:string,bindingId:string,key?:string) =>
    sourcesApi.backfillProjectSourceBinding(id,bindingId,key),
  proposeBindingBackfill:async(id:string,bindingId:string,body:Omit<OperationInput<'project.source.propose_backfill'>,'project_id'|'binding_id'>,key:string=crypto.randomUUID())=>{
    const result=await callOperation('project.source.propose_backfill',{project_id:id,binding_id:bindingId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Source history proposal command did not complete');return result.data;
  },
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
  addCorpusItem: async (projectId: string, data: {
    source_item_id: string
    role?: ProjectCorpusItem['role']
    triage_status?: ProjectCorpusItem['triage_status']
    metadata_json?: Record<string, unknown>
  },key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.corpus.upsert',{project_id:projectId,...data},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Corpus command did not complete');return {id:result.data.id};
  },
  updateCorpusItem: async (projectId: string, corpusItemId: string, data: Partial<{
    role: ProjectCorpusItem['role']
    status: ProjectCorpusItem['status']
    triage_status: ProjectCorpusItem['triage_status']
    read_status: ProjectCorpusItem['read_status']
    relevance: ProjectCorpusItem['relevance']
    confidence: number | null
    reason: string | null
    metadata_json: Record<string, unknown>
  }>,key:string=crypto.randomUUID()) => {
    const result=await callOperation('project.corpus.update',{project_id:projectId,corpus_item_id:corpusItemId,...data},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Corpus command did not complete');return {id:result.data.id};
  },
  backfillCorpusFromSources: async (id: string, key:string=crypto.randomUUID()):Promise<ProjectCorpusBackfillResult> => {
    const {space_id:_space,...result}=await commandReceipt('project.corpus.backfill_sources',{project_id:id},key);return result
  },
  publicSummaryFeedback: async (data: RetrievalFeedbackRequest, key:string=crypto.randomUUID()):Promise<RetrievalFeedbackResponse> => {
    if(data.object_type!=='project_public_summary')throw new Error('Project summary feedback only accepts public summaries')
    await commandReceipt('project.summary.feedback',{...data,object_type:'project_public_summary'},key);return {ok:true}
  },
  /** Queues one public-summary Context Brief, then reads its Job result; never resubmits. */
  publicSummaryBrief: async (data: RetrievalBriefRequest, key:string=crypto.randomUUID()):Promise<RetrievalBriefResponse> => {
    if(data.object_types?.some(type=>type!=='project_public_summary'))throw new Error('Project summary briefs only read public summaries')
    const receipt=await commandReceipt('project.summary.brief.request',{...data,object_types:data.object_types?['project_public_summary']:undefined},key)
    return waitForJobResult<RetrievalBriefResponse>(receipt,'Context Brief')
  },
  getActiveBriefVersion: (id: string) => get<ProjectBriefVersion | null>(`/projects/${id}/brief-versions/active`),
  listBriefVersions: (id: string) => get<ProjectBriefVersion[]>(`/projects/${id}/brief-versions`),
  createBriefVersion: async (id: string, data: Partial<Pick<ProjectBriefVersion,
    'goal' | 'scope_included' | 'scope_excluded' | 'success_definition' | 'constraints' | 'assumptions' |
    'confirmed_decisions' | 'workspace_identity' | 'workspace_boundary' | 'source_refs'
  >>,key:string=crypto.randomUUID()) => currentProjectVersion<ProjectBriefVersion>('brief',(await projectManagementCall('project.brief.create',{...data,project_id:id},key))),
  submitBriefForReview: async (id:string,versionId:string,key:string=crypto.randomUUID()) => currentProjectVersion<ProjectBriefVersion>('brief',(await projectManagementCall('project.brief.submit_review',{project_id:id,version_id:versionId},key))),
  publishBrief: async (id:string,versionId:string,key:string=crypto.randomUUID()) => currentProjectVersion<ProjectBriefVersion>('brief',(await projectManagementCall('project.brief.publish',{project_id:id,version_id:versionId},key))),
  getActiveInstructionVersion: (id: string) => get<ProjectInstructionVersion | null>(`/projects/${id}/instruction-versions/active`),
  listInstructionVersions: (id: string) => get<ProjectInstructionVersion[]>(`/projects/${id}/instruction-versions`),
  createInstructionVersion: async (id:string,data:Pick<ProjectInstructionVersion,'title'|'instruction_text'>,key:string=crypto.randomUUID()) => currentProjectVersion<ProjectInstructionVersion>('instruction',(await projectManagementCall('project.instruction.create',{...data,project_id:id},key))),
  submitInstructionForReview: async (id:string,versionId:string,key:string=crypto.randomUUID()) => currentProjectVersion<ProjectInstructionVersion>('instruction',(await projectManagementCall('project.instruction.submit_review',{project_id:id,version_id:versionId},key))),
  publishInstruction: async (id:string,versionId:string,key:string=crypto.randomUUID()) => currentProjectVersion<ProjectInstructionVersion>('instruction',(await projectManagementCall('project.instruction.publish',{project_id:id,version_id:versionId},key))),
}

async function inquiryCommand<Id extends keyof typeof INQUIRY_OPERATION_SCHEMAS>(id:Id,input:unknown,key:string){
  const normalized=INQUIRY_OPERATION_SCHEMAS[id].input.parse(input);
  const result=await callOperation(id,normalized as import('@rainver/protocol').OperationInput<Id>,key);
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Inquiry command did not complete');
  return result.data;
}
export const inquiryApi = {
  workspaceThreads:(project:string,filters:Record<string,string>={})=>get<{items:Array<{id:string;kind:string;statement:string;statement_truncated:boolean;lifecycle_status:string;attention_state:string;judgment:string|null;updated_at:string}>;next_cursor:string|null}>(`/projects/${encodeURIComponent(project)}/inquiry/workspace-threads?${new URLSearchParams(filters)}`),
  workspaceAccess:(project:string)=>get<{can_write:boolean}>(`/projects/${encodeURIComponent(project)}/inquiry/workspace-access`),
  problem:(project:string,thread:string,cursors:Record<string,string>={})=>get<typeof ProblemProjectionSchema._output>(`/projects/${encodeURIComponent(project)}/inquiry/threads/${encodeURIComponent(thread)}/problem?${new URLSearchParams(cursors)}`),
  recordProblemWork:async(project:string,thread:string,body:ProblemWorkRequest,key:string=crypto.randomUUID())=>{const out=await inquiryCommand('inquiry.problem.record_work',{...body,project_id:project,thread_id:thread},key);return get<typeof ProblemProjectionSchema._output>(`/projects/${encodeURIComponent(out.project_id)}/inquiry/threads/${encodeURIComponent(thread)}/problem`,{spaceId:out.space_id});},
  closeProblemRound:async(project:string,thread:string,body:ProblemCloseRoundRequest,key:string=crypto.randomUUID())=>{const out=await inquiryCommand('inquiry.problem.close_round',{...body,project_id:project,thread_id:thread},key);return {...out,projection:await get<typeof ProblemProjectionSchema._output>(`/projects/${encodeURIComponent(out.project_id)}/inquiry/threads/${encodeURIComponent(thread)}/problem`,{spaceId:out.space_id})};},
  linkedTasks:(project:string,thread:string,after?:string)=>get<ProblemLinkedTasksPage>(`/projects/${encodeURIComponent(project)}/inquiry/threads/${encodeURIComponent(thread)}/tasks${after?`?after_task_id=${encodeURIComponent(after)}`:''}`),
  linkTask:async(project:string,thread:string,body:Record<string,unknown>,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.task.link',{...body,project_id:project,thread_id:thread},key),
  taskResult:(project:string,thread:string,task:string)=>get<ProblemTaskResult>(`/projects/${encodeURIComponent(project)}/inquiry/threads/${encodeURIComponent(thread)}/tasks/${encodeURIComponent(task)}/result`),
  referenceTaskResult:async(project:string,thread:string,task:string,body:Record<string,unknown>,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.task.reference_result',{...body,project_id:project,thread_id:thread,task_id:task},key),
  listThreads: (projectId: string) =>
    get<InquiryThread[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads`),
  getThread: (projectId: string, threadId: string) =>
    get<InquiryThreadDetail>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}`),
  createThread: async (projectId: string, data: Omit<import('@rainver/protocol').OperationInput<'inquiry.thread.create'>,'project_id'>,key:string=crypto.randomUUID()) => {
    const result=await callOperation('inquiry.thread.create',{...data,project_id:projectId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Thread creation did not complete');
    return get<InquiryThread>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(result.data.thread_id)}`);
  },
  /**
   * Raise a note passage as a Question. Creates the Thread and the link
   * back to the note, so the Question keeps a route to its reasoning.
   */
  raiseFromNote: async (projectId: string, data: { note_object_id: string; statement: string; kind?: 'question' | 'hypothesis' },key:string=crypto.randomUUID()) => {
    const result=await callOperation('note.raise_as_question',{...data,project_id:projectId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Question creation did not complete');
    return get<InquiryThread>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(result.data.thread_id)}`);
  },
  recordIteration:async(projectId:string,threadId:string,data:Record<string,unknown>,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.iteration.record',{...data,project_id:projectId,thread_id:threadId},key),
  listOpenSteps: (projectId: string) =>
    get<InquiryOpenStep[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/open-steps`),
  listSteps: (projectId: string, threadId: string) =>
    get<InquiryThreadStep[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/steps`),
  listIterations: (projectId: string, threadId: string) =>
    get<InquiryIteration[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/iterations`),
  listRevisions: (projectId: string, threadId: string) =>
    get<InquiryThreadRevision[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/threads/${encodeURIComponent(threadId)}/revisions`),
  reviseDefinition:async(projectId:string,threadId:string,data:Record<string,unknown>,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.definition.revise',{...data,project_id:projectId,thread_id:threadId},key),
  updateWork:async(projectId:string,threadId:string,data:Record<string,unknown>,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.work.update',{...data,project_id:projectId,thread_id:threadId},key),
  transitionLifecycle:async(projectId:string,threadId:string,lifecycleStatus:string,reason?:string,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.lifecycle.transition',{project_id:projectId,thread_id:threadId,lifecycle_status:lifecycleStatus,reason},key),
  addRelation:async(projectId:string,data:Record<string,unknown>,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.relation.add',{...data,project_id:projectId},key),
  removeRelation:async(projectId:string,relationId:string,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.relation.remove',{project_id:projectId,relation_id:relationId},key),
  setPrimaryParent:async(projectId:string,threadId:string,parentThreadId:string|null,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.thread.set_primary_parent',{project_id:projectId,thread_id:threadId,parent_thread_id:parentThreadId},key),
  linkNote:async(projectId:string,threadId:string,noteObjectId:string,linkKind?:string,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.note.link',{project_id:projectId,thread_id:threadId,note_object_id:noteObjectId,link_kind:linkKind},key),
  unlinkNote:async(projectId:string,threadId:string,noteObjectId:string,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.note.unlink',{project_id:projectId,thread_id:threadId,note_object_id:noteObjectId},key),
  setPersonalFocus:async(projectId:string,threadId:string,inFocus:boolean,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.personal_focus.set',{project_id:projectId,thread_id:threadId,in_focus:inFocus},key),
  getFocus: (projectId: string) =>
    get<{ personal_focus: InquiryThread[]; shared_focus_wip_limit: number }>(`/projects/${encodeURIComponent(projectId)}/inquiry/focus`),
  listCandidates: (projectId: string, status = 'pending') =>
    get<InquiryCandidate[]>(`/projects/${encodeURIComponent(projectId)}/inquiry/candidates?status=${encodeURIComponent(status)}`),
  getCandidate: (projectId: string, candidateId: string) =>
    get<InquiryCandidate>(
      `/projects/${encodeURIComponent(projectId)}/inquiry/candidates/${encodeURIComponent(candidateId)}`,
    ),
  openReviewPacket:async(projectId:string,limit=5,key:string=crypto.randomUUID()):Promise<InquiryReviewPacket>=>{const out=await inquiryCommand('inquiry.review_packet.open',{project_id:projectId,limit},key);return out.id?get<InquiryReviewPacket>(`/projects/${encodeURIComponent(out.project_id)}/inquiry/review-packets/${encodeURIComponent(out.id)}`,{spaceId:out.space_id}):{id:null,project_id:out.project_id,status:'empty',created_at:new Date().toISOString(),candidates:[]};},
  closeReviewPacket:async(projectId:string,packetId:string,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.review_packet.close',{project_id:projectId,packet_id:packetId},key),
  decideCandidate:async(projectId:string,candidateId:string,data:Record<string,unknown>,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.candidate.decide',{...data,project_id:projectId,candidate_id:candidateId},key),
  reopenCandidate:async(projectId:string,candidateId:string,key:string=crypto.randomUUID())=>inquiryCommand('inquiry.candidate.reopen',{project_id:projectId,candidate_id:candidateId},key),
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
  generateDeltaBrief:async(projectId:string,coverageStart?:string|null,key:string=crypto.randomUUID())=>{const out=await inquiryCommand('inquiry.delta_brief.generate',{project_id:projectId,coverage_start:coverageStart??null},key);return get<InquiryDeltaBrief>(`/projects/${encodeURIComponent(out.project_id)}/inquiry/delta-briefs/${encodeURIComponent(out.id!)}`,{spaceId:out.space_id});},
}

export interface InquiryDeltaBrief {
  id: string
  project_id: string
  coverage_start: string | null
  coverage_end: string
  content: InquiryDeltaBriefContent
  created_at: string
}

type ExperimentReceipt = {id:string;space_id:string;project_id:string;definition_id:string}
type ExperimentVersionBody = OperationInput<'experiment.version.create'> extends infer Input ? Input extends unknown ? Omit<Input,'project_id'|'definition_id'> : never : never
async function currentExperimentDefinition(receipt:ExperimentReceipt){
  return get<ExperimentDefinition & {versions:ExperimentVersion[]}>(`/projects/${encodeURIComponent(receipt.project_id)}/experiments/definitions/${encodeURIComponent(receipt.definition_id)}`,{spaceId:receipt.space_id});
}
async function currentExperimentVersion(receipt:ExperimentReceipt){
  const definition=await currentExperimentDefinition(receipt),row=definition.versions.find(version=>version.id===receipt.id);
  if(!row)throw new Error('Experiment Version no longer available');return row;
}
async function currentExperimentRun(receipt:ExperimentReceipt){
  const rows=await get<ExperimentRun[]>(`/projects/${encodeURIComponent(receipt.project_id)}/experiments/definitions/${encodeURIComponent(receipt.definition_id)}/runs`,{spaceId:receipt.space_id}),row=rows.find(run=>run.id===receipt.id);
  if(!row)throw new Error('Experiment Run no longer available');return row;
}
async function currentExperimentInterpretation(receipt:ExperimentReceipt){
  const rows=await get<ExperimentInterpretation[]>(`/projects/${encodeURIComponent(receipt.project_id)}/experiments/definitions/${encodeURIComponent(receipt.definition_id)}/interpretations`,{spaceId:receipt.space_id}),row=rows.find(item=>item.id===receipt.id);
  if(!row)throw new Error('Experiment Interpretation no longer available');return row;
}
export const experimentsApi = {
  listDefinitions:(projectId:string)=>get<ExperimentDefinition[]>(`/projects/${encodeURIComponent(projectId)}/experiments/definitions`),
  getDefinition:(projectId:string,definitionId:string)=>get<ExperimentDefinition & {versions:ExperimentVersion[]}>(`/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}`),
  createDefinition:async(projectId:string,data:Omit<OperationInput<'experiment.definition.create'>,'project_id'>,key:string=crypto.randomUUID())=>
    currentExperimentDefinition(await noteObjectCall('experiment.definition.create',{...data,project_id:projectId},key)),
  updateDefinition:async(projectId:string,definitionId:string,data:Omit<OperationInput<'experiment.definition.update'>,'project_id'|'definition_id'>,key:string=crypto.randomUUID())=>
    currentExperimentDefinition(await noteObjectCall('experiment.definition.update',{...data,project_id:projectId,definition_id:definitionId},key)),
  createVersion:async(projectId:string,definitionId:string,data:ExperimentVersionBody,key:string=crypto.randomUUID())=>
    currentExperimentVersion(await noteObjectCall('experiment.version.create',{...data,project_id:projectId,definition_id:definitionId},key)),
  approveVersion:async(projectId:string,definitionId:string,versionId:string,key:string=crypto.randomUUID())=>
    currentExperimentVersion(await noteObjectCall('experiment.version.approve',{project_id:projectId,definition_id:definitionId,version_id:versionId},key)),
  listRuns:(projectId:string,definitionId:string)=>get<ExperimentRun[]>(`/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/runs`),
  createRun:async(projectId:string,definitionId:string,versionId:string,data:Omit<OperationInput<'experiment.run.create'>,'project_id'|'definition_id'|'version_id'>,key:string=crypto.randomUUID())=>
    currentExperimentRun(await noteObjectCall('experiment.run.create',{...data,project_id:projectId,definition_id:definitionId,version_id:versionId},key)),
  launchRun:async(projectId:string,definitionId:string,versionId:string,data:Omit<OperationInput<'experiment.run.launch'>,'project_id'|'definition_id'|'version_id'>,key:string=crypto.randomUUID())=>
    currentExperimentRun(await noteObjectCall('experiment.run.launch',{...data,project_id:projectId,definition_id:definitionId,version_id:versionId},key)),
  completeRun:async(projectId:string,definitionId:string,runId:string,data:Omit<OperationInput<'experiment.run.complete'>,'project_id'|'definition_id'|'experiment_run_id'>,key:string=crypto.randomUUID())=>{
    const receipt=await noteObjectCall('experiment.run.complete',{...data,project_id:projectId,definition_id:definitionId,experiment_run_id:runId},key);
    const run=await currentExperimentRun(receipt),observations=await get<ExperimentObservation[]>(`/projects/${encodeURIComponent(receipt.project_id)}/experiments/definitions/${encodeURIComponent(receipt.definition_id)}/runs/${encodeURIComponent(receipt.id)}/observations`,{spaceId:receipt.space_id});
    return {...run,observations};
  },
  listInterpretations:(projectId:string,definitionId:string)=>get<ExperimentInterpretation[]>(`/projects/${encodeURIComponent(projectId)}/experiments/definitions/${encodeURIComponent(definitionId)}/interpretations`),
  createInterpretation:async(projectId:string,definitionId:string,data:Omit<OperationInput<'experiment.interpretation.create'>,'project_id'|'definition_id'>,key:string=crypto.randomUUID())=>
    currentExperimentInterpretation(await noteObjectCall('experiment.interpretation.create',{...data,project_id:projectId,definition_id:definitionId},key)),
  reviewInterpretation:async(projectId:string,interpretationId:string,key:string=crypto.randomUUID())=>
    currentExperimentInterpretation(await noteObjectCall('experiment.interpretation.review',{project_id:projectId,interpretation_id:interpretationId},key)),
  convertInterpretation:async(projectId:string,interpretationId:string,confidence?:number,key:string=crypto.randomUUID())=>
    currentExperimentInterpretation(await noteObjectCall('experiment.interpretation.convert',{project_id:projectId,interpretation_id:interpretationId,confidence},key)),
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
  extract: async (projectId:string,body:{source_kind:'note'|'inquiry_thread'|'experiment_interpretation';source_id:string;agent_id:string;runtime_profile_id?:string},key:string=crypto.randomUUID()) => noteObjectCall('knowledge.candidate.extract',{...body,project_id:projectId},key),
  list: (projectId: string, status?: string) =>
    get<KnowledgePromotionCandidate[]>(
      `/projects/${encodeURIComponent(projectId)}/knowledge-candidates${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  summary: (projectId: string) =>
    get<{ pending: number; promotion: number; revalidation: number; no_impact: number; summary: string }>(
      `/projects/${encodeURIComponent(projectId)}/knowledge-candidates-review-summary`,
    ),
  decide: async (projectId:string,candidateId:string,body:{decision:'promote'|'dismiss'|'defer';proposed_title?:string;proposed_content?:string},key:string=crypto.randomUUID()) => {
    const receipt=await noteObjectCall('knowledge.candidate.decide',{...body,project_id:projectId,candidate_id:candidateId},key);
    return get<KnowledgePromotionCandidate>(`/projects/${encodeURIComponent(projectId)}/knowledge-candidates/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  },
  reopen: async (projectId:string,candidateId:string,key:string=crypto.randomUUID()) => {
    const receipt=await noteObjectCall('knowledge.candidate.reopen',{project_id:projectId,candidate_id:candidateId},key);
    return get<KnowledgePromotionCandidate>(`/projects/${encodeURIComponent(projectId)}/knowledge-candidates/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  },
  openPacket: async (projectId:string,limit=10,key:string=crypto.randomUUID()) => {
    const receipt=await noteObjectCall('knowledge.candidate.packet.open',{project_id:projectId,limit},key);
    return get<{id:string;status:string;created_at:string;candidates:KnowledgePromotionCandidate[]}>(`/projects/${encodeURIComponent(projectId)}/knowledge-candidate-review-packets/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  },
  closePacket: async (projectId:string,packetId:string,key:string=crypto.randomUUID()) => {
    const receipt=await noteObjectCall('knowledge.candidate.packet.close',{project_id:projectId,packet_id:packetId},key);
    return get<Record<string,unknown>>(`/projects/${encodeURIComponent(projectId)}/knowledge-candidate-review-packets/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  },
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
  open: async (projectId:string,limit=5,key:string=crypto.randomUUID()):Promise<ProjectReviewSession> => {
    const receipt=await projectManagementCall('project.review_session.open',{project_id:projectId,limit},key),base=`/projects/${encodeURIComponent(receipt.project_id)}`,options={spaceId:receipt.space_id};
    const [inquiry,knowledge]=await Promise.all([
      receipt.inquiry_packet_id?get<{id:string|null;candidates:unknown[]}>(`${base}/inquiry/review-packets/${encodeURIComponent(receipt.inquiry_packet_id)}`,options):Promise.resolve({id:null,candidates:[]}),
      get<{id:string;candidates:KnowledgePromotionCandidate[]}>(`${base}/knowledge-candidate-review-packets/${encodeURIComponent(receipt.knowledge_packet_id)}`,options),
    ]);
    const count=inquiry.candidates.length+knowledge.candidates.length;
    return {project_id:receipt.project_id,created_at:receipt.created_at,summary:count===0?'No material Inquiry or Knowledge changes need review.':`${inquiry.candidates.length} Inquiry change${inquiry.candidates.length===1?'':'s'} and ${knowledge.candidates.length} Knowledge change${knowledge.candidates.length===1?'':'s'} need review.`,sections:{inquiry:{packet:inquiry,decision_href:`/projects/${receipt.project_id}/inquiry`},knowledge:{packet:knowledge,decision_href:`/projects/${receipt.project_id}/inquiry?view=review&tab=candidates`}}};
  },
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
  create: async (projectId:string,body:{title:string;framing?:string;source_thread_ids?:string[]},key:string=crypto.randomUUID()) => {
    const receipt=await projectManagementCall('decision.case.create',{...body,project_id:projectId},key);return get<DecisionCase>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id});
  },
  addOption: (projectId:string,caseId:string,body:{title:string;description?:string},key:string=crypto.randomUUID()) => projectManagementCall('decision.option.add',{...body,project_id:projectId,case_id:caseId},key),
  addCriterion: (projectId:string,caseId:string,body:{name:string;weight:number},key:string=crypto.randomUUID()) => projectManagementCall('decision.criterion.add',{...body,project_id:projectId,case_id:caseId},key),
  score: (projectId:string,caseId:string,body:{option_id:string;criterion_id:string;score:number;rationale?:string},key:string=crypto.randomUUID()) => projectManagementCall('decision.option.score',{...body,project_id:projectId,case_id:caseId},key),
  decide: async (projectId:string,caseId:string,optionId:string,key:string=crypto.randomUUID()) => {
    const receipt=await projectManagementCall('decision.case.decide',{project_id:projectId,case_id:caseId,option_id:optionId},key);return get<DecisionCase>(`/projects/${encodeURIComponent(projectId)}/decision-cases/${encodeURIComponent(caseId)}`,{spaceId:receipt.space_id});
  },
  addCommitment: (projectId:string,caseId:string,statement:string,key:string=crypto.randomUUID()) => projectManagementCall('decision.commitment.add',{project_id:projectId,case_id:caseId,statement},key),
  createDelivery: (projectId:string,caseId:string,commitmentId:string,key:string=crypto.randomUUID()) => projectManagementCall('decision.commitment.deliver',{project_id:projectId,case_id:caseId,commitment_id:commitmentId},key),
}

interface LearningObjective {
  id: string
  project_id: string | null
  title: string
  description: string | null
  status: string
}

interface LearningItem {
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
  createObjective: async (body: { project_id: string; title: string; description?: string },key:string=crypto.randomUUID()) => (await commandReceipt('learning.objective.create',body,key)).objective,
  createItem: async (body: { project_id: string; objective_id?: string; knowledge_item_id: string; item_kind: 'card' | 'exercise'; prompt: string; answer: string },key:string=crypto.randomUUID()) => (await commandReceipt('learning.item.create',body,key)).item,
  review: async (itemId: string, outcome: 'correct' | 'incorrect',key:string=crypto.randomUUID()) => (await commandReceipt('learning.item.review',{item_id:itemId,outcome},key)).mastery,
}

export const projectResearchApi = {
  startAcquisition:async(project:string,body:{thread_id:string;idempotency_key:string;intent_note:string;max_items?:number;since?:string},key:string=crypto.randomUUID())=>{
    const receipt=await commandReceipt('research.acquisition.start',{project_id:project,...body},key);return {status:receipt.status,operation_id:receipt.id}
  },
  problemOperations:(project:string,thread:string,after?:string)=>get<{items:ProjectOperation[];next_cursor:string|null}>(`/projects/${encodeURIComponent(project)}/inquiry/threads/${encodeURIComponent(thread)}/research-operations${after?`?after_operation_id=${encodeURIComponent(after)}`:''}`),
  result:(project:string,operation:string)=>get<typeof ResearchResultSchema._output>(`/projects/${encodeURIComponent(project)}/research/operations/${encodeURIComponent(operation)}/result`),
  adoptResult:(project:string,operation:string,body:Omit<OperationInput<'research.result.adopt'>,'project_id'|'operation_id'>,key:string=crypto.randomUUID())=>
    commandReceipt('research.result.adopt',{project_id:project,operation_id:operation,...body},key),
  standing: (projectId: string) =>
    get<import('../types/api').ProjectResearchStandingStatus>(`/projects/${encodeURIComponent(projectId)}/research/standing`),
  actionStandingAdvice: (projectId: string, adviceId: string, key:string=crypto.randomUUID()) =>
    commandReceipt('research.standing.action',{project_id:projectId,advice_id:adviceId},key),
  dismissStandingAdvice: async (projectId:string,adviceId:string,key:string=crypto.randomUUID())=>{
    const result=await callOperation('research.standing.dismiss',{project_id:projectId,advice_id:adviceId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Standing advice command did not complete');return result.data;
  },
  retryStandingBatch: async (projectId:string,batchId:string,key:string=crypto.randomUUID())=>{
    const result=await callOperation('research.standing.retry',{project_id:projectId,batch_id:batchId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Standing retry command did not complete');return result.data;
  },
  area: (projectId: string) => get<ResearchArea>(`/projects/${encodeURIComponent(projectId)}/research/area`),
  initializeArea: async (projectId:string,key:string=crypto.randomUUID())=>{
    const result=await callOperation('research.area.initialize',{project_id:projectId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research area command did not complete');
    return get<ResearchArea>(`/projects/${encodeURIComponent(result.data.project_id)}/research/area`,{spaceId:result.data.space_id});
  },
  readingList: (projectId: string, params: { triage_status?: string; read_status?: string; q?: string;limit?:string;offset?:string } = {}) => get<ResearchReadingList>(`/projects/${encodeURIComponent(projectId)}/research/reading-list?${new URLSearchParams(params)}`),
  // Per-note editing/revisions/rollback go through the generic notesApi —
  // a project's notebook is just Notes filed under its auto-created folder.
  updateEvidenceCard: async (projectId:string,sourceItemId:string,body:{why_md:string;how_md:string;what_md:string},key:string=crypto.randomUUID())=>{
    const result=await callOperation('research.evidence_card.update',{project_id:projectId,source_item_id:sourceItemId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research evidence card command did not complete');
    return get<ResearchEvidenceCard>(`/projects/${encodeURIComponent(result.data.project_id)}/research/reading-list/${encodeURIComponent(sourceItemId)}/card`,{spaceId:result.data.space_id});
  },
  createChecklistItem: async (projectId:string,text:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.checklist.create',{project_id:projectId,text},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research checklist command did not complete');
    return get<ResearchChecklistItem>(`/projects/${encodeURIComponent(result.data.project_id)}/research/checklist/${encodeURIComponent(result.data.id)}`,{spaceId:result.data.space_id});
  },
  updateChecklistItem: async (projectId:string,itemId:string,body:Partial<Pick<ResearchChecklistItem,'text'|'status'|'sort_order'>>,key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.checklist.update',{project_id:projectId,item_id:itemId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research checklist command did not complete');
    return get<ResearchChecklistItem>(`/projects/${encodeURIComponent(result.data.project_id)}/research/checklist/${encodeURIComponent(result.data.id)}`,{spaceId:result.data.space_id});
  },
  deleteChecklistItem: async (projectId:string,itemId:string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.checklist.delete',{project_id:projectId,item_id:itemId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research checklist command did not complete');return {id:result.data.id};
  },

  // `section_key` is accepted (see areaService.ts askAi): a registered role
  // resolves to the note holding that role; any other value is a literal title.
  // Enqueues a bounded `provider_task` Run and answers 201 `queued`. The note is
  // NOT updated when this resolves: a `provider_task_run` job applies the block
  // ops and then marks the Run terminal, so a caller may only report that the
  // work was queued.
  askAi: async (projectId: string, body: { prompt: string; section_key: string; source_item_ids?: string[]; execution: { model_provider_id: string; model_name?: string } },key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.ask_ai',{project_id:projectId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research ad-hoc command did not complete');
    const {run_id,job_id,status,daily_limit,daily_used}=result.data;return {run_id,job_id,status,daily_limit,daily_used};
  },
  generateReportSnapshot: async (projectId: string,key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.report.snapshot',{project_id:projectId},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research snapshot command did not complete');
    return get<ProjectOperation>(`/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(result.data.id)}`,{spaceId:result.data.space_id});
  },
  /**
   * Admits one refinement turn with an explicit key, then reads the durable
   * session until that turn settles. The panel's own progress polling shows
   * repair events meanwhile; the command is never resubmitted.
   */
  refineQuestion: async (projectId: string, body: {
    thread_id: string
    research_question: string
    message: string
    establish_assessment_baseline?: boolean
    execution: { model_provider_id?: string; model_name?: string }
  }, key:string=crypto.randomUUID()):Promise<ProjectResearchQuestionRefinementResponse> => {
    const receipt=await commandReceipt('research.question.refine',{project_id:projectId,...body},key)
    const path=`/projects/${encodeURIComponent(receipt.project_id)}/research/question/assessment?thread_id=${encodeURIComponent(receipt.thread_id)}`
    const started=Date.now(),authGeneration=_authContextGeneration
    for(;;){
      if(authGeneration!==_authContextGeneration)throw new ApiRequestError('The session changed while the question was being assessed',401,'authentication_required')
      const session=await get<ProjectResearchQuestionAssessmentSession|null>(path,{spaceId:receipt.space_id})
      const turn=session?.messages.find(message=>message.id===receipt.id)
      // This receipt's own answer: another concurrent turn may own latest_refinement.
      const answer=turn?.status==='complete'?session?.messages.find(message=>message.role==='assistant'&&message.turn_index===turn.turn_index&&message.status==='complete')?.refinement:undefined
      if(session&&answer)return {...answer,assessment_session:session} as ProjectResearchQuestionRefinementResponse
      if(!turn||turn.status==='failed')throw new Error([...(turn?.processing_events??[])].reverse().find(event=>event.status==='failed')?.message??'Question assessment did not complete')
      if(Date.now()-started>180000)throw new Error('Question assessment is still running; refresh later')
      await new Promise(resolve=>setTimeout(resolve,700))
    }
  },
  questionAssessment: (projectId: string, threadId: string) =>
    get<ProjectResearchQuestionAssessmentSession | null>(
      `/projects/${encodeURIComponent(projectId)}/research/question/assessment?thread_id=${encodeURIComponent(threadId)}`,
    ),
  questionAssessmentConfirmations: (projectId: string, threadId: string) =>
    get<ProjectResearchQuestionAssessmentConfirmation[]>(
      `/projects/${encodeURIComponent(projectId)}/research/question/assessment/confirmations?thread_id=${encodeURIComponent(threadId)}`,
    ),
  confirmQuestionAssessment: async (projectId: string, body: {
    thread_id: string
    refinement: ProjectResearchQuestionRefinement
    manually_adjusted: boolean
  },key:string=crypto.randomUUID()):Promise<ProjectResearchQuestionAssessmentConfirmationResponse> => {
    const result=await callOperation('research.question.assessment.confirm',{project_id:projectId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research assessment confirmation did not complete');
    const path=`/projects/${encodeURIComponent(result.data.project_id)}/research/question/assessment`;
    const [session,history]=await Promise.all([
      get<ProjectResearchQuestionAssessmentSession|null>(`${path}?thread_id=${encodeURIComponent(result.data.thread_id)}`,{spaceId:result.data.space_id}),
      get<ProjectResearchQuestionAssessmentConfirmation[]>(`${path}/confirmations?thread_id=${encodeURIComponent(result.data.thread_id)}`,{spaceId:result.data.space_id}),
    ]);
    const confirmation=history.find(row=>row.id===result.data.id);
    if(!confirmation||session?.latest_refinement?.research_context_version_id!==result.data.id)throw new Error('Confirmed framework changed; refresh the current assessment before continuing');
    return {...session.latest_refinement,confirmation};
  },
  saveInitialIntakeDraft: async (projectId: string, body: ProjectResearchInitialIntakeInput, key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.intake.draft',{project_id:projectId,...body,thread_id:body.thread_id??''},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research draft command did not complete');
    const rows=await get<ProjectResearchWorkflow[]>(`/projects/${encodeURIComponent(result.data.project_id)}/research/workflow`,{spaceId:result.data.space_id});
    const row=rows.find(r=>r.id===result.data.id);if(!row)throw new Error('Research workflow no longer available');return row;
  },
  startInitialIntake: async (projectId: string, body: ProjectResearchInitialIntakeInput, key:string=crypto.randomUUID()):Promise<ProjectResearchInitialIntakeResponse> => {
    // The server validates query_strategy_id and the remaining intake fields; the draft type keeps them optional.
    const receipt=await commandReceipt('research.intake.start',{project_id:projectId,...body} as OperationInput<'research.intake.start'>,key)
    const scope={spaceId:receipt.space_id},project=encodeURIComponent(receipt.project_id)
    const [operation,workflows,channels,bindings]=await Promise.all([
      researchOperation(receipt),
      get<ProjectResearchWorkflow[]>(`/projects/${project}/research/workflow`,scope),
      receipt.source_channel_ids.length?get<SourceChannel[]>('/sources/channels',scope):Promise.resolve([] as SourceChannel[]),
      receipt.source_binding_ids.length?get<ProjectSourceBinding[]>(`/projects/${project}/sources/bindings`,scope):Promise.resolve([] as ProjectSourceBinding[]),
    ])
    const sourceChannels=channels.filter(c=>receipt.source_channel_ids.includes(c.id)),sourceBindings=bindings.filter(b=>receipt.source_binding_ids.includes(b.id))
    return {workflow:workflows.find(w=>w.id===receipt.workflow_id)??null,operation,source_channel:sourceChannels[0]??null,source_channels:sourceChannels,source_binding:sourceBindings[0]??null,source_bindings:sourceBindings,status:operation.status==='completed'?'succeeded':operation.status} as ProjectResearchInitialIntakeResponse
  },
  workflows: (projectId: string) =>
    get<ProjectResearchWorkflow[]>(`/projects/${encodeURIComponent(projectId)}/research/workflow`),
  scanSummaries: (projectId: string, limit = 30) =>
    get<import('../types/api').ProjectResearchScanSummary[]>(
      `/projects/${encodeURIComponent(projectId)}/research/scan-summaries?limit=${limit}`,
    ),
  runStage: async (projectId: string, workflowId: string, stageKey: string, body: { run_id?: string } = {}, key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.workflow.stage.record',{project_id:projectId,workflow_id:workflowId,stage_key:stageKey,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research stage command did not complete');
    const rows=await get<ProjectResearchWorkflow[]>(`/projects/${encodeURIComponent(result.data.project_id)}/research/workflow`,{spaceId:result.data.space_id});
    const row=rows.find(r=>r.id===result.data.id);if(!row)throw new Error('Research workflow no longer available');return row;
  },
  /** `body.idempotency_key` is the update's business key; `key` is this request's transport key. */
  triggerIncremental: async (projectId: string, workflowId: string, body: { source_item_ids?: string[]; idempotency_key?: string } = {}, key:string=crypto.randomUUID()) =>
    researchOperation(await commandReceipt('research.workflow.trigger',{project_id:projectId,workflow_id:workflowId,...body},key)),
  historyBackfill: async (projectId: string, workflowId: string, body: { from: string; to?: string; max_items?: number; idempotency_key?: string }, key:string=crypto.randomUUID()) =>
    researchOperation(await commandReceipt('research.workflow.history_backfill',{project_id:projectId,workflow_id:workflowId,...body},key)),
  updateInitialItemLimit: async (projectId:string,max_items:number,workflowId?:string|null,key:string=crypto.randomUUID())=>{
    const result=await callOperation('research.intake.limit',{project_id:projectId,max_items,workflow_id:workflowId??null},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research limit command did not complete');
    const rows=await get<ProjectResearchWorkflow[]>(`/projects/${encodeURIComponent(result.data.project_id)}/research/workflow`,{spaceId:result.data.space_id});
    const row=rows.find(r=>r.id===result.data.id);if(!row)throw new Error('Research workflow no longer available');return row;
  },
  applyQuestionForward: (projectId: string, workflowId: string, key:string=crypto.randomUUID()) =>
    projectResearchApi.resolveQuestionChange(projectId, workflowId, 'apply_forward', key),
  questionChangeImpact: (projectId: string, workflowId: string) =>
    get<import('../types/api').ProjectResearchQuestionImpact>(
      `/projects/${encodeURIComponent(projectId)}/research/question/impact?workflow_id=${encodeURIComponent(workflowId)}`,
    ),
  resolveQuestionChange: async (projectId: string, workflowId: string, strategy: import('../types/api').ProjectResearchQuestionResolutionStrategy, key:string=crypto.randomUUID()):Promise<{ workflow: ProjectResearchWorkflow; operation?: ProjectOperation }> => {
    const receipt=await commandReceipt('research.question.resolve',{project_id:projectId,workflow_id:workflowId,strategy},key)
    const [workflows,operation]=await Promise.all([
      get<ProjectResearchWorkflow[]>(`/projects/${encodeURIComponent(receipt.project_id)}/research/workflow`,{spaceId:receipt.space_id}),
      receipt.operation_id?researchOperation({...receipt,id:receipt.operation_id}):Promise.resolve(undefined),
    ])
    const workflow=workflows.find(w=>w.id===receipt.id);if(!workflow)throw new Error('Research workflow no longer available')
    return {workflow,...(operation?{operation}:{})}
  },
  retryOperation: async (projectId: string, operationId: string, key:string=crypto.randomUUID()) =>
    researchOperation(await commandReceipt('research.operation.retry',{project_id:projectId,operation_id:operationId},key)),
  cancelOperation: (projectId: string, operationId: string, reason?: string) =>
    post<{ operation_id: string; status: 'cancelled'; already_terminal: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/research/operations/${encodeURIComponent(operationId)}/cancel`,
      reason ? { reason } : {},
    ),
  reconcileOperation: async (projectId: string, operationId: string, key:string=crypto.randomUUID()) => {
    const receipt=await commandReceipt('research.operation.reconcile',{project_id:projectId,operation_id:operationId},key)
    return {...await researchOperation(receipt),reconcile_diagnostic:{before_status:receipt.before_status,after_status:receipt.after_status}}
  },
  updateItemLimit: async (projectId: string, operationId: string, max_items: number, key:string=crypto.randomUUID()) =>
    researchOperation(await commandReceipt('research.operation.item_limit',{project_id:projectId,operation_id:operationId,max_items},key)),
  rescanBackfill: async (projectId: string, operationId: string, key:string=crypto.randomUUID()) =>
    researchOperation(await commandReceipt('research.operation.rescan',{project_id:projectId,operation_id:operationId},key)),
  checkpoints: (projectId: string, workflowId: string) =>
    get<ProjectResearchCheckpoint[]>(
      `/projects/${encodeURIComponent(projectId)}/research/workflow/${encodeURIComponent(workflowId)}/checkpoints`,
    ),
  decideCheckpoint: async (projectId: string, workflowId: string, checkpointId: string, body: { decision: 'approved' | 'rejected' | 'waived'; reason?: string | null }, key:string=crypto.randomUUID()) => {
    const receipt=await commandReceipt('research.checkpoint.decide',{project_id:projectId,workflow_id:workflowId,checkpoint_id:checkpointId,...body},key)
    const rows=await get<ProjectResearchCheckpoint[]>(`/projects/${encodeURIComponent(receipt.project_id)}/research/workflow/${encodeURIComponent(receipt.workflow_id)}/checkpoints`,{spaceId:receipt.space_id})
    const row=rows.find(r=>r.id===receipt.id);if(!row)throw new Error('Research checkpoint no longer available');return row
  },
  screeningCriteria: (projectId: string) =>
    get<ProjectResearchScreeningCriteria>(`/projects/${encodeURIComponent(projectId)}/research/screening-criteria`),
  upsertScreeningCriteria: async (projectId: string, body: Partial<Pick<
    ProjectResearchScreeningCriteria,
    'include_keywords' | 'exclude_keywords' | 'domain_criteria' | 'date_range_start' | 'date_range_end' | 'source_restrictions' | 'required_evidence_fields'
  >>, key:string=crypto.randomUUID()) => {
    const result=await callOperation('research.screening.configure',{project_id:projectId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Research screening command did not complete');
    return get<ProjectResearchScreeningCriteria>(`/projects/${encodeURIComponent(result.data.project_id)}/research/screening-criteria`,{spaceId:result.data.space_id});
  },
  evidenceMatrix: (projectId: string) =>
    get<ProjectResearchEvidenceMatrixItem[]>(`/projects/${encodeURIComponent(projectId)}/research/evidence-matrix`),
  rebuildEvidenceMatrix: async (projectId: string, key:string=crypto.randomUUID()) => {
    const receipt=await commandReceipt('project.corpus.backfill_sources',{project_id:projectId},key)
    return get<ProjectResearchEvidenceMatrixItem[]>(`/projects/${encodeURIComponent(receipt.project_id)}/research/evidence-matrix`,{spaceId:receipt.space_id})
  },
  reportPage:(project:string,after?:string)=>get<{items:ProjectResearchReport[];next_cursor:string|null}>(`/projects/${encodeURIComponent(project)}/research/report-page${after?`?after_report_id=${encodeURIComponent(after)}`:''}`),
  reports: (projectId: string) =>
    get<ProjectResearchReport[]>(`/projects/${encodeURIComponent(projectId)}/research/reports`),
  report: (projectId: string, reportId: string) =>
    get<ProjectResearchReport>(`/projects/${encodeURIComponent(projectId)}/research/reports/${encodeURIComponent(reportId)}`),
  runReportIntegrity: (projectId: string, reportId: string, key:string=crypto.randomUUID()) =>
    commandReceipt('research.report.integrity',{project_id:projectId,report_id:reportId},key),
}

export const researchDiscoveryApi = {
  evaluate: (body: { project_id: string; research_context_version_id: string; providers: ResearchProviderKey[]; candidate_budget: number; execution?: { model_provider_id?: string; model_name?: string }; credentials?: Record<string, string> },key:string=crypto.randomUUID()) =>
    operationAt<OperationOutput<'research.strategy.evaluate'>>('POST','/research/query-strategies/evaluate',body,key),
  materialize: (strategyId: string, body: { provider_keys: ResearchProviderKey[]; credentials?: Record<string, string> }, key:string=crypto.randomUUID()) =>
    operationAt<OperationOutput<'research.strategy.materialize'>>('POST',`/research/query-strategies/${encodeURIComponent(strategyId)}/materialize`,body,key),
  activate: (strategyId:string,body:{reason:'manual'|'rollback'},key:string=crypto.randomUUID()) =>
    operationAt<OperationOutput<'research.strategy.activate'>>('POST',`/research/query-strategies/${encodeURIComponent(strategyId)}/activate`,body,key),
  retryProvider: (strategyId: string, providerKey: ResearchProviderKey, body: { project_id: string; execution?: { model_provider_id?: string; model_name?: string }; credentials?: Record<string, string> },key:string=crypto.randomUUID()) =>
    operationAt<OperationOutput<'research.strategy.retry'>>('POST',`/research/query-strategies/${encodeURIComponent(strategyId)}/providers/${encodeURIComponent(providerKey)}/retry`,body,key),
  waitEvaluation:async(receipt:ResearchQueryEvaluationAcceptedJob):Promise<{strategy: import('@rainver/protocol').ResearchQueryStrategy}>=>{
    const started=Date.now(),authGeneration=_authContextGeneration,spaceId=_spaceId
    for(;;){
      if(authGeneration!==_authContextGeneration||spaceId!==_spaceId)throw new ApiRequestError('The session changed while evaluation was running',401,'authentication_required')
      const view=await researchDiscoveryApi.evaluationResult(receipt.job_id)
      if(view.strategy_id!==receipt.strategy_id||view.run_id!==receipt.run_id)throw new Error('Evaluation receipt changed')
      if(view.status==='succeeded'&&view.result)return view.result
      if(view.status==='failed'||view.status==='cancelled')throw new Error('Research evaluation did not complete; sent work will not be repeated')
      if(Date.now()-started>180000)throw new Error('Research evaluation is still running; refresh later')
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
  },
  evaluationResult:(jobId:string)=>get<ResearchQueryEvaluationResult>(`/research/query-evaluations/${encodeURIComponent(jobId)}`),
  /** One page of a provider plan's attempts, newest first. */
  listAttempts: (strategyId: string, providerKey: ResearchProviderKey, query: { project_id: string; limit: number; offset: number }) =>
    get<ListResearchQueryAttemptsResponse>(`/research/query-strategies/${encodeURIComponent(strategyId)}/providers/${encodeURIComponent(providerKey)}/attempts?${new URLSearchParams({ project_id: query.project_id, limit: String(query.limit), offset: String(query.offset) })}`),
}

/**
 * Whose knowledge-retrieval switch: a direct conversation names its scope; a
 * Room conversation names its session independently of addressed Agents.
 */
export type RetrievalSwitchTarget =
  | { scopeId: string }
  | { sessionId: string }

function retrievalSwitchPath(target: RetrievalSwitchTarget): string {
  return 'scopeId' in target
    ? `/runtime-context/work-contexts/${encodeURIComponent(target.scopeId)}/retrieval`
    : `/runtime-context/room-conversations/${encodeURIComponent(target.sessionId)}/retrieval`
}

/** A conversation's knowledge-retrieval switch, kept per person and conversation. */
export const runtimeContextApi = {
  retrievalSwitch: (target: RetrievalSwitchTarget, options: RequestOptions = {}) =>
    get<WorkRetrievalSwitch>(retrievalSwitchPath(target), options),
  /** Keyed command; the switch is read back through its reader. */
  setRetrievalSwitch: async (target: RetrievalSwitchTarget, body: WorkRetrievalSwitchRequest, options: RequestOptions = {}, idempotencyKey: string = crypto.randomUUID()): Promise<WorkRetrievalSwitch> => {
    const receipt = 'scopeId' in target
      ? await commandReceipt('runtime_context.work_context.retrieval.set', { ...body, work_context_scope_id: target.scopeId }, idempotencyKey, options)
      : await commandReceipt('runtime_context.room_conversation.retrieval.set', { ...body, session_id: target.sessionId }, idempotencyKey, options)
    return get<WorkRetrievalSwitch>(retrievalSwitchPath(target), { ...options, spaceId: receipt.space_id })
  },
}

export const instanceOperationsApi = {
  get: () => get<InstanceOperationsSettings>('/system/instance-settings'),
  update: (body: InstanceOperationsSettingsUpdate, key: string = crypto.randomUUID()) =>
    operationAt<InstanceOperationsSettings>('PUT', '/system/instance-settings', body, key),
}

// ── Instance update (ADR 0020; instance admin only) ───────────────────────
export const deploymentApi = {
  status: () => get<DeploymentStatus>('/deployments/status'),
  /** Creating the job is the administrator's approval; it takes no arguments. */
  createJob: (jobType: DeploymentJobType, key: string = crypto.randomUUID()) =>
    operationAt<DeploymentJob>('POST', '/deployments/jobs', { job_type: jobType }, key),
  job: (jobId: string) => get<DeploymentJobDetail>(`/deployments/jobs/${jobId}`),
  /** Only from `queued`: once the deployer has it, the job runs to its end. */
  cancelJob: (jobId: string, key: string = crypto.randomUUID()) => operationAt<DeploymentJob>('POST', `/deployments/jobs/${encodeURIComponent(jobId)}/cancel`, {}, key),
}

// ── Auth / Identity ───────────────────────────────────────────────────────
export const authApi = {
  me:          ()                  => get<CurrentUser>('/me'),
  mySpaces:    ()                  => get<SpaceWithMembership[]>('/me/spaces'),
  configuration: ()                 => get<AuthConfiguration>('/auth/config'),
  passwordLogin: (body: { email: string; password: string; rememberMe: boolean }) => post<{ user: CurrentUser }>('/auth/sign-in/email', body),
  registrationIntent: (body: { email: string; invitation_token?: string }) => post<{ intentId: string; claimSecret: string; authority: string; email: string }>('/auth/registration-intents', body),
  register: (body: { intent_id: string; claim_secret: string; email: string; password: string; name?: string; remember_me?: boolean }) => post<{ ok: boolean; user_id: string }>('/auth/register', body),
  registerGoogle: (body: { intent_id: string; claim_secret: string }) => post<{ url: string }>('/auth/register/google', body),
  completeRegistration: (body: { intent_id: string; claim_secret?: string; name?: string }) => post<{ ok: boolean; userId: string }>('/auth/register/complete', body),
  logout:      ()                  => post<null>('/auth/logout'),
  googleLogin: (next?: string)     => {
    const url = next
      ? `/api/v1/auth/google?next=${encodeURIComponent(next)}`
      : '/api/v1/auth/google'
    window.location.href = url
  },
  reauth: (password: string) => post<{ ok: boolean; expires_in: number }>('/auth/reauth', { password }),
  reauthStatus: () => get<{ expires_at: string | null }>('/auth/reauth/status'),
  googleReauth: () => post<{ url: string }>('/auth/reauth/google', {}),
  completeGoogleReauth: () => post<{ ok: boolean; expires_in: number }>('/auth/reauth/google/complete', {}),
  setPassword: (newPassword: string) => post<{ ok: boolean }>('/auth/password/set', { new_password: newPassword }),
  changePassword: (body: { current_password: string; new_password: string; revoke_other_sessions?: boolean }) => post<{ ok: boolean }>('/auth/password/change', body),
  accounts: () => get<AuthAccount[]>('/auth/accounts'),
  sessions: () => get<AuthSession[]>('/auth/sessions'),
  revokeSession: (sessionId: string) => post<{ ok: boolean }>(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {}),
  revokeOtherSessions: () => post<{ ok: boolean }>('/auth/sessions/revoke-others', {}),
  linkGoogle: () => post<{ url: string }>('/auth/google/link', {}),
  unlinkGoogle: (accountId: string) => post<{ ok: boolean }>('/auth/google/unlink', { account_id: accountId }),
  requestPasswordReset: (email: string) => post<{ ok: boolean }>('/auth/recovery/request', { email }),
  completePasswordReset: (token: string, newPassword: string) => post<{ ok: boolean }>('/auth/recovery/complete', { token, new_password: newPassword }),
  adminInvite: (email: string) => post<InstanceInvitationResponse>('/auth/admin/invitations', { email }),
  adminUsers: () => get<AdminAuthUser[]>('/auth/admin/users'),
  adminDisableUser: (userId: string, key: string = crypto.randomUUID()) => operationAt<OperationOutput<'auth.user.disable'>>('POST', `/auth/admin/users/${encodeURIComponent(userId)}/disable`, {}, key),
  adminEnableUser: (userId: string, key: string = crypto.randomUUID()) => operationAt<OperationOutput<'auth.user.enable'>>('POST', `/auth/admin/users/${encodeURIComponent(userId)}/enable`, {}, key),
  adminResetLink: (userId: string) => post<{ reset_link: string }>(`/auth/admin/users/${encodeURIComponent(userId)}/reset-link`, {}),
  adminRegistrationIntents: () => get<RegistrationIntentAdmin[]>('/auth/admin/registration-intents'),
}

// ── Spaces ────────────────────────────────────────────────────────────────
export const spacesApi = {
  acceptInvitation: async (token: string, idempotencyKey: string = crypto.randomUUID()): Promise<{ space_id: string | null }> =>
    commandReceipt('space.invitation.accept', { token }, idempotencyKey),
  /** Keyed creation; the new Space is read back with the creator's membership. */
  create: async (data: { name: string; type: Exclude<SpaceWithMembership['type'], 'personal'>; oversight_mode?: SpaceOversightMode }, idempotencyKey: string = crypto.randomUUID()): Promise<SpaceWithMembership> => {
    const receipt = await commandReceipt('space.create', data, idempotencyKey)
    return get<SpaceWithMembership>(`/spaces/${encodeURIComponent(receipt.space_id)}`, { spaceId: receipt.space_id })
  },
  get:                  (spaceId: string)                              => get<SpaceWithMembership>(`/spaces/${spaceId}`),
  members:              (spaceId: string)                              => get<SpaceMember[]>(`/spaces/${spaceId}/members`),
  /**
   * The invitation secret is generated here and kept to build the claim link;
   * the server stores only its hash, so a receipt (or a replay) never carries it.
   */
  invite: async (spaceId: string, data: { email: string; role: string }, idempotencyKey: string = crypto.randomUUID(), token: string = invitationSecret()): Promise<SpaceInvitationOut> => {
    const receipt = await commandReceipt('space.invitation.create', { ...data, role: data.role as OperationInput<'space.invitation.create'>['role'], token, space_id: spaceId }, idempotencyKey, { spaceId })
    return { id: receipt.invitation_id, space_id: receipt.space_id, invited_email: receipt.invited_email, role: receipt.role, token, status: receipt.status as SpaceInvitationOut['status'], expires_at: receipt.expires_at }
  },
  getSnapshotDefaults:  (spaceId: string)                              => get<SpaceSnapshotDefaults>(`/spaces/${spaceId}/snapshot-defaults`),
  updateSnapshotDefaults: async (spaceId: string, data: SpaceSnapshotDefaults, idempotencyKey: string = crypto.randomUUID()): Promise<SpaceSnapshotDefaults> => {
    await commandReceipt('space.snapshot_defaults.update', { ...data, space_id: spaceId }, idempotencyKey, { spaceId })
    return spacesApi.getSnapshotDefaults(spaceId)
  },
  getRetrievalSettings: (spaceId: string) =>
    get<SpaceRetrievalSettings>(`/spaces/${spaceId}/retrieval-settings`),
  updateRetrievalSettings: async (spaceId: string, data: SpaceRetrievalSettingsUpdate, idempotencyKey: string = crypto.randomUUID()): Promise<SpaceRetrievalSettings> => {
    await commandReceipt('space.retrieval_settings.update', { ...data, space_id: spaceId }, idempotencyKey, { spaceId })
    return spacesApi.getRetrievalSettings(spaceId)
  },
}

/** 256 random bits, base64url: the Space invitation secret the claim link carries. */
function invitationSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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

/** How a Provider is deployed, as declared by its owner; see the server's provider policy. */
export type ProviderDeployment = 'cloud' | 'trusted_local'

export interface ModelProviderOut {
  id: string
  space_id: string
  home_space_id?: string
  owner_user_id?: string | null
  grant_id?: string | null
  name: string
  provider_type: ProviderType | string
  base_url: string
  deployment: ProviderDeployment
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

interface ModelProviderModelsOut {
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

interface ProviderFromPresetCreateRequest {
  preset_id: string
  api_key?: string | null
  name?: string
  network_profile_id?: string | null
  default_model?: string | null
  available_models?: string[]
  embedding_dimensions?: number
  is_default?: boolean
}

interface ProviderFromPresetCreateResponse {
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

interface ProviderTaskPolicyPutRequest {
  chain: ProviderTaskChainEntry[]
  enabled?: boolean
}

/**
 * The server-owned vendor registry. The client reads these facts. Do not keep
 * a second copy.
 */
export interface ProviderVendorOut {
  id: ProviderType
  display_name: string
  protocol: string
  supports_chat: boolean
  supports_structured_output: boolean
  supports_embedding: boolean
  supports_rerank: boolean
  default_base_url: string | null
  api_key_required: boolean
  subscription_only: boolean
  self_hostable: boolean
}

interface TestConnectionOut {
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
  planUsageProviders: () => get<{ items: ApiPlanUsageProvider[] }>('/providers/plan-usage'),
  refreshPlanUsage: (id: string, key?: string) => systemCommand<ApiPlanUsageSnapshot>('POST', `/providers/${encodeURIComponent(id)}/plan-usage`, {}, 'Plan usage refresh', key, 3 * 60 * 1000),
  /** Every Provider this person may see here, including the ones they own and disabled. For management. */
  list: () => get<ModelProviderOut[]>('/providers'),
  /** The Providers a run can use here: enabled, with an enabled grant. For pickers. */
  usable: () => get<ModelProviderOut[]>('/providers')
    .then(rows => rows.filter(row => row.enabled && row.grant_enabled !== false)),

  presets: () => get<ProviderPresetOut[]>('/providers/presets'),

  create: (data: {
    name: string
    provider_type: ProviderType | string
    api_key?: string
    default_model?: string
    available_models?: string[]
    base_url: string
    deployment?: ProviderDeployment
    network_profile_id?: string | null
    claude_compatible_base_url?: string
    openai_compatible_base_url?: string
    enabled?: boolean
    is_default?: boolean
  }, key: string = crypto.randomUUID()) => operationAt<ModelProviderOut>('POST', '/providers', data, key),

  createFromPreset: (data: ProviderFromPresetCreateRequest, key: string = crypto.randomUUID()) =>
    operationAt<ProviderFromPresetCreateResponse>('POST', '/providers/from-preset', data, key),

  patch: (id: string, data: Partial<{
    name: string
    provider_type: ProviderType | string
    api_key: string
    /** null clears the default; undefined leaves it. */
    default_model: string | null
    available_models: string[]
    base_url: string
    deployment: ProviderDeployment
    network_profile_id: string | null
    claude_compatible_base_url: string | null
    openai_compatible_base_url: string | null
    enabled: boolean
    is_default: boolean
  }>, key: string = crypto.randomUUID()) => operationAt<ModelProviderOut>('PATCH', `/providers/${encodeURIComponent(id)}`, data, key),

  delete: async (id: string, key: string = crypto.randomUUID()): Promise<void> => { await operationAt('DELETE', `/providers/${encodeURIComponent(id)}`, undefined, key) },

  models: (id: string) => get<ModelProviderModelsOut>(`/providers/${id}/models`),

  /** A connection test spends one small completion; it runs after commit and is never resubmitted. */
  test: (id: string, key?: string) => systemCommand<TestConnectionOut>('POST', `/providers/${encodeURIComponent(id)}/test`, {}, 'Connection test', key, 3 * 60 * 1000),

  refreshSubscriptionQuota: (id: string, key?: string) =>
    systemCommand<ModelProviderOut>('POST', `/providers/${encodeURIComponent(id)}/subscription/quota`, {}, 'Subscription quota refresh', key, 3 * 60 * 1000),

  /** Where the Space draws the subscription warning and reserve lines. */
  subscriptionQuotaPolicy: () => get<SubscriptionQuotaPolicy>('/providers/subscription-quota-policy'),
  updateSubscriptionQuotaPolicy: (body: SubscriptionQuotaPolicyUpdate, key: string = crypto.randomUUID()) =>
    operationAt<SubscriptionQuotaPolicy>('PUT', '/providers/subscription-quota-policy', body, key),

  disconnectSubscription: (id: string, key: string = crypto.randomUUID()) =>
    operationAt<ModelProviderOut>('DELETE', `/providers/${encodeURIComponent(id)}/subscription`, undefined, key),

  sendSubscriptionLoginInput: (type: ManagedSubscriptionType, input: string) =>
    post<{ status: string }>(`/providers/subscriptions/login/input?type=${encodeURIComponent(type)}`, { input }),

  // The server ends the login session only when this response closes, and
  // allows one session per user and type: the caller aborts when it leaves,
  // as hostsApi.loginStream's callers do.
  async *subscriptionLoginStream(type: ManagedSubscriptionType, signal?: AbortSignal): AsyncGenerator<ManagedSubscriptionLoginEvent> {
    const url = `${BASE}/providers/subscriptions/login/stream?type=${encodeURIComponent(type)}`
    const headers: Record<string, string> = {}
    if (_apiKey) headers['Authorization'] = `Bearer ${_apiKey}`
    headers['X-Rainver-Space-Id'] = _spaceId
    const response = await fetch(url, { headers, signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    if (!response.body) throw new Error('No response body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
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
    } catch (caught) {
      // An abort is the caller leaving, not a failure to report.
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) throw caught
    } finally {
      // A consumer that stops iterating lands here too; release the connection.
      void reader.cancel().catch(() => undefined)
    }
  },

  taskPolicies: () => get<ProviderTaskPolicyOut[]>('/providers/task-policies'),

  putTaskPolicy: (task: string, data: ProviderTaskPolicyPutRequest, key: string = crypto.randomUUID()) =>
    operationAt<ProviderTaskPolicyOut>('PUT', `/providers/task-policies/${encodeURIComponent(task)}`, data, key),

  deleteTaskPolicy: async (task: string, key: string = crypto.randomUUID()): Promise<void> => {
    await operationAt('DELETE', `/providers/task-policies/${encodeURIComponent(task)}`, undefined, key)
  },

  grant: (id: string, data: {
    space_id: string
    enabled?: boolean
    is_default?: boolean
    network_profile_id?: string | null
  }, key: string = crypto.randomUUID()) => operationAt<unknown>('PUT', `/providers/${encodeURIComponent(id)}/grants`, data, key),

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
  list: (options:RequestOptions={}) => get<{ items: import('@rainver/protocol').OfficialPluginListItem[] }>('/plugins',options),
  effective: (options:RequestOptions={}) => get<OfficialPluginEffectiveResponse>('/plugins/effective',options),
  get: (pluginId: string) => get<unknown>(`/plugins/${encodeURIComponent(pluginId)}`),
  /** Installation runs the plugin's migrations after commit; `{ install, item }` comes from the command status. */
  install: (pluginId: string, key?: string) =>
    systemCommand<{ install: unknown; item: unknown }>('POST', `/plugins/${encodeURIComponent(pluginId)}/install`, {}, 'Plugin installation', key, 5 * 60 * 1000),
  enable: (pluginId: string, body: { settings?: Record<string, unknown> } = {}, key: string = crypto.randomUUID()) =>
    operationAt<unknown>('POST', `/plugins/${encodeURIComponent(pluginId)}/enable`, body, key),
  disable: (pluginId: string, body: Record<string, never> = {}, key: string = crypto.randomUUID()) =>
    operationAt<unknown>('POST', `/plugins/${encodeURIComponent(pluginId)}/disable`, body, key),
  patchSettings: (pluginId: string, settings: Record<string, unknown>, key: string = crypto.randomUUID()) =>
    operationAt<unknown>('PATCH', `/plugins/${encodeURIComponent(pluginId)}/settings`, { settings }, key),
}

export const dailyReportApi = {
  getSettings: () =>
    get<DailyCaptureReportSettingOut>('/daily-capture-report/settings'),

  updateSettings: (data: DailyCaptureReportSettingUpdate,key:string=crypto.randomUUID()) =>
    commandReceipt('daily_capture.settings.patch', data,key),
  setSettings:(data:OperationInput<'daily_capture.settings.set'>,key:string=crypto.randomUUID())=>commandReceipt('daily_capture.settings.set',data,key),

  run: (data: OperationInput<'daily_capture.run'>,key:string=crypto.randomUUID()) =>
    commandReceipt('daily_capture.run', data,key),

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

export type FinanceImportEntryStatus =
  | 'imported'
  | 'pending_mapping'
  | 'needs_review'
  | 'duplicate'
  | 'error'
  | 'excluded'

export interface FinanceImportSource {
  id: string
  source_type: string
  source_name: string | null
  content_hash: string | null
  created_at: string
}

export interface FinanceImportEntry {
  id: string
  entry_key: string
  identity_kind: 'external_id' | 'content_occurrence'
  external_id: string | null
  entry_type: string
  entry_date: string | null
  source_lineno: number
  raw_text: string
  status: FinanceImportEntryStatus
  status_reason: string | null
  directive_id: string | null
  duplicate_of_entry_id: string | null
  missing_accounts: string[]
  missing_commodities: string[]
  account_mapping: Record<string, string>
  mapping_version: number
  errors: FinanceLedgerError[]
}

export type FinanceImportSummary = Record<FinanceImportEntryStatus, number>

export interface FinanceImportResult {
  import_source: FinanceImportSource
  batch_existed: boolean
  created_directives: number
  summary: FinanceImportSummary
  entries: FinanceImportEntry[]
  errors: FinanceLedgerError[]
}

export interface FinanceImportBatch extends FinanceImportSource {
  summary: FinanceImportSummary
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
  importBeancount: (bookId: string, input: { text: string }) =>
    post<FinanceImportResult>(`/finance/books/${encodeURIComponent(bookId)}/import/beancount`, input),
  listImports: (bookId: string) =>
    get<{ imports: FinanceImportBatch[] }>(`/finance/books/${encodeURIComponent(bookId)}/imports`),
  getImport: (bookId: string, importSourceId: string) =>
    get<FinanceImportResult>(`/finance/books/${encodeURIComponent(bookId)}/imports/${encodeURIComponent(importSourceId)}`),
  retryImport: (bookId: string, importSourceId: string) =>
    post<FinanceImportResult>(`/finance/books/${encodeURIComponent(bookId)}/imports/${encodeURIComponent(importSourceId)}/retry`),
  mapImportEntry: (bookId: string, importSourceId: string, entryId: string, accountMapping: Record<string, string>) =>
    post<FinanceImportResult>(
      `/finance/books/${encodeURIComponent(bookId)}/imports/${encodeURIComponent(importSourceId)}/entries/${encodeURIComponent(entryId)}/mapping`,
      { account_mapping: accountMapping },
    ),
  reviewImportEntries: (bookId: string, importSourceId: string, decision: 'import' | 'duplicate', entryIds?: string[]) =>
    post<FinanceImportResult>(
      `/finance/books/${encodeURIComponent(bookId)}/imports/${encodeURIComponent(importSourceId)}/review`,
      entryIds ? { decision, entry_ids: entryIds } : { decision },
    ),
  exportBeancount: (bookId: string) =>
    post<FinanceExportResult>(`/finance/books/${encodeURIComponent(bookId)}/export/beancount`),
}

export const diaryApi = {
  saveContextKey: () => `${_authContextGeneration}:${_spaceId}`,
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


export const projectMonitoringApi = {
  reconcile:async(projectId:string,key:string=crypto.randomUUID())=>{
    const receipt=await commandReceipt('project.monitoring.reconcile',{project_id:projectId},key)
    // Stopped work is reconciled either way; an active coordinator still needs the person to wait or cancel.
    if(receipt.coordinator_active)throw new Error('Coordinator or child Run is still active; wait or cancel the child Run before retrying')
    return get<ProjectMonitoringState>(`/projects/${encodeURIComponent(receipt.project_id)}/information-monitoring`,{spaceId:receipt.space_id})
  },
  state:(projectId:string,offset=0)=>get<ProjectMonitoringState>(`/projects/${projectId}/information-monitoring?offset=${offset}`),
  setup:(projectId:string,query:string,provider_key:'arxiv'|'rss'|'atom'|'web_page'='arxiv',key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.source.setup',{project_id:projectId,query,provider_key,idempotency_key:key},key),
  propose:(projectId:string,config:ProjectMonitoringConfig,active:string|null,key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.proposal.create',{project_id:projectId,config,expected_active_version_id:active,idempotency_key:key},key),
  details:async(projectId:string,body:{expected_version_id:string;recommendation_count:number;language:string},key:string=crypto.randomUUID())=>{
    const result=await callOperation('project.monitoring.details.update',{project_id:projectId,...body},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Monitoring details command did not complete');
    const state=await get<ProjectMonitoringState>(`/projects/${encodeURIComponent(result.data.project_id)}/information-monitoring`,{spaceId:result.data.space_id});
    if(!state.active)throw new Error('Monitoring version no longer available');return state.active;
  },
  paused:async(projectId:string,versionId:string,paused:boolean,key:string=crypto.randomUUID())=>{
    const result=await callOperation('project.monitoring.state.update',{project_id:projectId,expected_version_id:versionId,paused},key);
    if(!('status' in result)||result.status!=='succeeded')throw new Error('Monitoring state command did not complete');
    return get<ProjectMonitoringState>(`/projects/${encodeURIComponent(result.data.project_id)}/information-monitoring`,{spaceId:result.data.space_id});
  },
  run:(projectId:string,version:MonitoringVersion,kind:'initial'|'check'='initial',key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.run.start',{project_id:projectId,version_id:version.id,config_hash:version.config_hash,kind,idempotency_key:key},key),
  feedback:(projectId:string,itemId:string,feedback:'read'|'relevant'|'not_relevant',key:string=crypto.randomUUID())=>
    commandReceipt('project.monitoring.feedback',{project_id:projectId,item_id:itemId,feedback},key),
};

// Goal collection uses the same scoped transport and canonical Run stream.
// Commands are core operations with a fresh transport key per attempt; the
// domain keys in their bodies (message, follow, edit, save, feedback) still dedupe.
const goalCall=<Id extends import('@rainver/protocol').SourceGoalOperationId>(id:Id,input:import('@rainver/protocol').OperationInput<Id>,options:RequestOptions={})=>sourceObjectCall(id,input,crypto.randomUUID(),options) as Promise<import('@rainver/protocol').OperationOutput<Id>>;
export type SourceGoalAction='edit'|'explore'|'preview'|'save'|'follow'|'feedback'|'check'|'resume'|'pause'|'delete'|'rollback';
const SOURCE_GOAL_ACTION_OPERATIONS={edit:'source.goal.edit',explore:'source.goal.explore',preview:'source.goal.preview.request',save:'source.goal.save',follow:'source.goal.follow',feedback:'source.goal.feedback',check:'source.goal.check',resume:'source.goal.resume',pause:'source.goal.pause',delete:'source.goal.delete',rollback:'source.goal.binding.rollback'} as const satisfies Record<SourceGoalAction,import('@rainver/protocol').SourceGoalOperationId>;
export const sourceGoalsApi={
 edit:(id:string,body:import('@rainver/protocol').SourceGoalEdit,options:RequestOptions={})=>goalCall('source.goal.edit',{goal_id:id,...body},options),
 check:(id:string,body:{expected_version_id:string|null;retry_failed?:true},options:RequestOptions={})=>goalCall('source.goal.check',{goal_id:id,...body},options),
 nativeAvailability:(profile:string,options:RequestOptions={})=>get<{supported:boolean;reason?:string;supported_modes?:string[]}>(`/sources/goal-setup/agent-search/${encodeURIComponent(profile)}`,options),
 findLegacy:(channel:string,options:RequestOptions={})=>get<{goal_id:string|null}>(`/sources/goal-setup/legacy/${encodeURIComponent(channel)}`,options),
 /** The secret is sent once with an explicit key; the receipt is the credential's metadata only. */
 storeCredential:async(data:{name:string;secret:string},options:RequestOptions={},key:string=crypto.randomUUID()):Promise<CustomSourceCredentialDTO>=>(await sourceObjectCall('source.custom.credential.create',data,key,options)) as CustomSourceCredentialDTO,
 list:(options:RequestOptions={})=>get<{goals:import('@rainver/protocol').SourceGoalDetail['goal'][]}>('/sources/goals',options),
 read:(id:string,options:RequestOptions={})=>get<import('@rainver/protocol').SourceGoalDetail>(`/sources/goals/${encodeURIComponent(id)}`,options),
 /** Creates a topic; with `follow`, creation and its one follow confirmation commit together. */
 begin:(data:import('@rainver/protocol').SourceGoalBeginRequest,options:RequestOptions={})=>goalCall('source.goal.setup.begin',data,options),
 /** Owner-only lookup of a committed creation by its idempotency key. */
 findCreation:(key:string,projectId:string|null,options:RequestOptions={})=>get<{goal_id:string|null;space_id?:string}>(`/sources/goal-setup/begin/${encodeURIComponent(key)}${projectId?`?project_id=${encodeURIComponent(projectId)}`:''}`,options),
 message:(goal_id:string,content:string,idempotency_key:string,options:RequestOptions={},execution?:{search_path?:'agent'|'api';agent_id?:string;runtime_profile_id?:string;session_config?:import('@rainver/protocol').RuntimeSessionConfigSelection[]})=>goalCall('source.goal.setup.message',{goal_id,content,idempotency_key,...execution},options),
 /** Maps a Monitor to a topic; the receipt names the goal (`goal_id`). */
 legacy:(channel_id:string,options:RequestOptions={})=>goalCall('source.goal.setup.legacy',{channel_id},options),
 /** One goal control. The preview is queued as a Job; its result appears on the goal (`previews`). */
 action:(id:string,action:SourceGoalAction,body:Record<string,unknown>={},options:RequestOptions={})=>goalCall(SOURCE_GOAL_ACTION_OPERATIONS[action],{goal_id:id,...body} as never,options),
 /** A binding stopped because its Source changed: the Source as it is now and what changed (see the server's reconfirm.ts). */
 sourceConfirmation:(id:string,bindingId:string,options:RequestOptions={})=>get<import('@rainver/protocol').SourceGoalBindingReconfirmation>(`/sources/goals/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}/source-confirmation`,options),
 /** The owner confirms exactly the state shown (binding revision and its token). */
 confirmSource:(id:string,bindingId:string,body:import('@rainver/protocol').SourceGoalBindingConfirmRequest,options:RequestOptions={})=>goalCall('source.goal.binding.confirm_source',{goal_id:id,binding_id:bindingId,...body},options),
 /** One confirmation starts continuous following; no manual preview is required. */
 /** Tightening-only owner feedback on a followed topic. */
 feedback:(id:string,body:import('@rainver/protocol').SourceGoalFeedbackRequest,options:RequestOptions={})=>goalCall('source.goal.feedback',{goal_id:id,...body},options),
 follow:(id:string,body:import('@rainver/protocol').SourceGoalFollowRequest,options:RequestOptions={})=>goalCall('source.goal.follow',{goal_id:id,...body},options),
}

// Reading method workspace: all writes remain explicit; GET never starts a trial.
export const readingMethodsApi={
 generate:async(body:unknown,key:string=crypto.randomUUID())=>readingMethodsApi.generation((await commandReceipt('reading_method.generation.start',body as OperationInput<'reading_method.generation.start'>,key)).generation_id),
 generation:(id:string)=>get<import('@rainver/protocol').ReadingMethodGenerationView>(`/prompts/reading-method/generations/${encodeURIComponent(id)}`),
 cancelGeneration:async(id:string,key:string=crypto.randomUUID())=>readingMethodsApi.generation((await commandReceipt('reading_method.generation.cancel',{generation_id:id},key)).generation_id),
 readSample:(id:string)=>get<{name:string;pages:Array<{url:string;text:string}>}>(`/prompts/reading-method/samples/${encodeURIComponent(id)}`),
 entry:(projectId?:string|null)=>get<{can_manage:boolean;project_id:string|null}>(`/prompts/reading-method/entry?${new URLSearchParams(projectId?{project_id:projectId}:{})}`),
 cliOptions:(projectId?:string|null)=>get<import('@rainver/protocol').ReadingMethodContext['runtimes']>(`/prompts/reading-method/cli-options${projectId?`?${new URLSearchParams({project_id:projectId})}`:''}`),
 context:(itemId:string|null,projectId?:string|null,artifactId?:string|null,targetKey?:string)=>get<import('@rainver/protocol').ReadingMethodContext>(`/prompts/reading-method?${new URLSearchParams({...(itemId?{item_id:itemId}:{}),...(projectId?{project_id:projectId}:{}),...(artifactId?{artifact_id:artifactId}:{}),...(targetKey?{target_key:targetKey}:{})})}`),
 // Keyed commands; content is read back through the GET readers above.
 initialize:(key:string=crypto.randomUUID())=>commandReceipt('reading_method.initialize',{},key),
 draft:async(body:unknown,key:string=crypto.randomUUID()):Promise<{id:string}>=>({id:(await commandReceipt('reading_method.draft.save',body as OperationInput<'reading_method.draft.save'>,key)).version_id}),
 sample:async(body:unknown,key:string=crypto.randomUUID()):Promise<{id:string}>=>({id:(await commandReceipt('reading_method.sample.save',body as OperationInput<'reading_method.sample.save'>,key)).case_id}),
 trial:async(body:unknown,key:string=crypto.randomUUID())=>readingMethodsApi.readTrial((await commandReceipt('reading_method.trial.start',body as OperationInput<'reading_method.trial.start'>,key)).trial_id),
 readTrial:(id:string)=>get<import('@rainver/protocol').ReadingMethodTrialView>(`/prompts/reading-method/trials/${encodeURIComponent(id)}`),
 judge:(id:string,body:{judgment:string;reason:string},key:string=crypto.randomUUID())=>commandReceipt('reading_method.trial.judge',{...body,trial_id:id} as OperationInput<'reading_method.trial.judge'>,key),
 cancel:(id:string,key:string=crypto.randomUUID())=>commandReceipt('reading_method.trial.cancel',{trial_id:id},key),
 promote:async(body:unknown,key:string=crypto.randomUUID()):Promise<{id:string;proposal_id?:string}>=>{const receipt=await commandReceipt('reading_method.promotion.propose',body as OperationInput<'reading_method.promotion.propose'>,key);return {id:receipt.proposal_id,proposal_id:receipt.proposal_id};},
 rollback:(body:unknown,key:string=crypto.randomUUID())=>commandReceipt('reading_method.rollback',body as OperationInput<'reading_method.rollback'>,key),
}


// Project Reading consumes the durable stage-two and private operation contracts.
export const projectReadingApi={
 favoriteStatus:(space:string,project:string,item:string,options:RequestOptions={})=>get<{item_id:string;favorite:boolean}>(`/spaces/${space}/projects/${project}/reading/items/${item}/favorite`,{...options,spaceId:space}),
 composition:(space:string,project:string,version?:string,options:RequestOptions&{date?:string}={})=>{const {date,...request}=options;return get<import('@rainver/protocol').ProjectReadingResponse>(`/spaces/${space}/projects/${project}/reading-compositions${version?`/${encodeURIComponent(version)}/export`:''}${date?`?date=${encodeURIComponent(date)}`:''}`,{...request,spaceId:space})},
 archivedTheme:(space:string,project:string,id:string,options:RequestOptions={})=>get<import('@rainver/protocol').Briefing>(`/spaces/${space}/projects/${project}/reading-compositions/analyses/${encodeURIComponent(id)}`,{...options,spaceId:space}),
 history:(space:string,project:string,cursor?:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectReadingHistory>(`/spaces/${space}/projects/${project}/reading-compositions/history${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`,{...options,spaceId:space}),
 retryComposition:(space:string,project:string,key:string=crypto.randomUUID())=>commandReceipt('reading.composition.retry',{space_id:space,project_id:project},key,{spaceId:space}),
 themes:(goal:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectThemeRoundsResponse>(`/sources/goals/${encodeURIComponent(goal)}/theme-rounds`,options),
 /** Receipts only; the rounds are read again through `themes`. */
 retryTheme:(goal:string,round:string,options:RequestOptions={})=>goalCall('source.goal.theme.retry',{goal_id:goal,round_id:round},options),
 consent:(goal:string,body:Omit<import('@rainver/protocol').OperationInput<'source.goal.theme.configure'>,'goal_id'>,options:RequestOptions={})=>goalCall('source.goal.theme.configure',{goal_id:goal,...body} as import('@rainver/protocol').OperationInput<'source.goal.theme.configure'>,options),
 operations:(space:string,project:string,offset=0,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectDeepReadList>(`/spaces/${space}/projects/${project}/reading/deep-reads?offset=${offset}`,{...options,spaceId:space}),
 purposes:(space:string,project:string,item:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectDeepReadPurposes>(`/spaces/${space}/projects/${project}/reading/items/${item}/purposes`,{...options,spaceId:space}),
 start:(space:string,project:string,item:string,body:Omit<import('@rainver/protocol').OperationInput<'reading.deep_read.start'>,'space_id'|'project_id'|'item_id'>,key:string=crypto.randomUUID()):Promise<{status:string;run_id?:string;processing_id?:string;source_id?:string;source_name?:string;can_request_consent?:boolean}>=>commandReceipt('reading.deep_read.start',{...body,space_id:space,project_id:project,item_id:item},key,{spaceId:space}),
 cancel:(space:string,project:string,id:string,key:string=crypto.randomUUID())=>commandReceipt('reading.deep_read.cancel',{space_id:space,project_id:project,operation_id:id},key,{spaceId:space}),
 favorite:async(space:string,project:string,item:string,favorite:boolean,key:string=crypto.randomUUID())=>{const result=await commandReceipt('reading.favorite.set',{space_id:space,project_id:project,item_id:item,favorite},key,{spaceId:space});return {item_id:result.item_id,favorite:result.favorite}},
 record:(space:string,project:string,item:string,snapshot:string,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectReadingRecords>(`/reader/source-items/${item}/records?project_id=${project}&snapshot_id=${encodeURIComponent(snapshot)}`,{...options,spaceId:space}),
 records:(space:string,project:string,item:string,offset=0,options:RequestOptions={})=>get<import('@rainver/protocol').ProjectReadingRecords>(`/reader/source-items/${item}/records?project_id=${project}&offset=${offset}`,{...options,spaceId:space}),
}

/** Generic query adapter. Discovery is a real core consumer; no automatic retries. */
export function queryOperation<Id extends OperationId>(id:Id,input:OperationInput<Id>,options:RequestOptions={}):Promise<OperationOutcome<OperationOutput<Id>>> {
  return request('GET',`/queries/${encodeURIComponent(id)}?input=${encodeURIComponent(JSON.stringify(input))}`,undefined,options)
}

export function callOperation<Id extends OperationId>(id:Id,input:OperationInput<Id>,key:string,options:RequestOptions={}):Promise<OperationOutcome<OperationOutput<Id>>> {
  if(!key)throw new Error('An explicit idempotency key is required')
  return request('POST',`/actions/${encodeURIComponent(id)}`,input,{...options,idempotencyKey:key})
}
/** One explicit-key command attempt; never retried. Returns only the body-free receipt. */
async function commandReceipt<Id extends OperationId>(id:Id,input:OperationInput<Id>,key:string,options:RequestOptions={}):Promise<OperationOutput<Id>> {
  const result=await callOperation(id,input,key,options)
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Command did not complete')
  return result.data
}
/** A read-only core query sent to its retained POST URL (no key; bodies can exceed a query string). */
async function queryAt<T>(path:string,body:unknown,options:RequestOptions={}):Promise<T>{
  const result=await post<OperationOutcome<T>>(path,body,options)
  if(!('status' in result)||result.status!=='succeeded')throw new Error('Query did not complete')
  return result.data
}
function found<T extends {id:string}>(rows:readonly T[],id:string,label:string):T{
  const row=rows.find(r=>r.id===id);if(!row)throw new Error(`${label} is no longer available`);return row
}
const assetVersionOf=async(receipt:{space_id:string;asset_id:string;version_id:string})=>
  found(await get<EvolvableAssetVersion[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/versions`,{spaceId:receipt.space_id}),receipt.version_id,'Asset version')
const evaluationCaseOf=async(receipt:{space_id:string;asset_id:string;case_id:string})=>
  found(await get<EvolvableAssetEvaluationCase[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/evaluation-cases`,{spaceId:receipt.space_id}),receipt.case_id,'Evaluation case')
const evaluationRunOf=async(receipt:{space_id:string;asset_id:string;evaluation_run_id:string})=>
  found(await get<EvolvableAssetEvaluationRun[]>(`/evolution/assets/${encodeURIComponent(receipt.asset_id)}/evaluation-runs`,{spaceId:receipt.space_id}),receipt.evaluation_run_id,'Evaluation run')
const researchOperation=(receipt:{id:string;project_id:string;space_id:string})=>
  get<ProjectOperation>(`/projects/${encodeURIComponent(receipt.project_id)}/operations/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id})

/** Local manifest adapters use the same transport and mandatory explicit command keys as core operations. */
export function queryPluginOperation<T>(id:import('@rainver/protocol').PluginOperationId,input:unknown,options:RequestOptions={}):Promise<OperationOutcome<T>>{
 return request('GET',`/queries/${encodeURIComponent(id)}?input=${encodeURIComponent(JSON.stringify(input))}`,undefined,options)
}
export function callPluginOperation<T>(id:import('@rainver/protocol').PluginOperationId,input:unknown,key:string,options:RequestOptions={}):Promise<OperationOutcome<T>>{
 if(!key)throw new Error('An explicit idempotency key is required')
 return request('POST',`/actions/${encodeURIComponent(id)}`,input,{...options,idempotencyKey:key})
}

/** Personal receipt storage grants no destination authority. Keep the key for an explicit retry. */
export const captureFilingApi = {
  file: (body: import('@rainver/protocol').OperationInput<'capture.file'>, key: string) => operationAt<OperationOutput<'capture.file'>>('POST','/me/filings',body,key),
};

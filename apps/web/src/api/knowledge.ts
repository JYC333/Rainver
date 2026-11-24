import { sessionEpoch } from '../lib/sessionResidue'
import type {
  ClaimCandidatePacketCreateRequestInput,
  ClaimCandidatePacketCreateResponse,
  ClaimContradictionScanRequestInput,
  ClaimContradictionScanResponse,
  ContentAccessLogList,
  ContentAccessPolicy,
  ContentAccessUpdate,
  ContentDemotionDisclosure,
  ContentVisibility,
  EntityLink,
  FocusArea,
  FocusAreaContents,
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
  MemoryMaintenanceScanRequestInput,
  MemoryProposalRevisionRequest,
  MemoryVersion,
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
  NoteSummary,
  NoteUpdateBody,
  NotesTreeReorderBody,
  ObjectSchemaExportManifest,
  ObjectSchemaImportRequestInput,
  ObjectSchemaImportResponse,
  ObjectSchemaSuggestionScanRequestInput,
  ObjectSchemaSuggestionScanResponse,
  Page,
  Proposal,
  RelationDiscoveryScanRequestInput,
  RelationDiscoveryScanResponse,
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
  SpaceObjectProfileCreateProposalRequestInput,
  SpaceObjectProfilePage,
  SpaceObjectProfileStatus,
  SpaceObjectProfileUpdateProposalRequestInput,
} from '../types/api'
import { proposalsApi } from './artifacts'
import { contentRequest } from './jobReads'
import { callOperation, commandReceipt, noteObjectCall, projectManagementCall, operationAt } from './operations'
import { pollRead, READ_PENDING } from './pollRead'
import { get } from './transport'
import type {
  ContentPublication,
  ContentPublicationList,
  CreatePublicationRequest,
  GraphProjection,
  GraphProjectionViewMode,
  OperationInput,
  PublicationImport,
} from '@rainver/protocol'

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
    const epoch = sessionEpoch()
    const receipt=await projectManagementCall('project.notebook.chat',{project_id:projectId,...body},key)
    return pollRead({
      epoch, timeoutMs: 120_000, intervalMs: 500,
      sessionChanged: 'The session changed while waiting for the notebook reply',
      timedOut: () => new Error('The reply is still being prepared. Reopen this conversation shortly.'),
    }, signal => get<NotebookChatReply & { pending: boolean }>(
      `/projects/${encodeURIComponent(receipt.project_id)}/notebook-chat/${encodeURIComponent(receipt.run_id)}`,
      { spaceId: receipt.space_id, signal },
    ), result => result.pending ? READ_PENDING : result)
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

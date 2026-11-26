import { sessionEpoch } from '../lib/sessionResidue'
import type {
  HostExecutionTargetsResponse,
  Page,
  Project,
  ProjectBoard,
  ProjectBriefVersion,
  ProjectConversationsResponse,
  ProjectCorpusBackfillResult,
  ProjectCorpusItem,
  ProjectCreate,
  ProjectExtractionProfile,
  ProjectInstructionVersion,
  ProjectMainlineRoomResponse,
  ProjectOperation,
  ProjectOverview,
  ProjectPublicSummary,
  ProjectPublicSummaryDraft,
  ProjectPublicSummaryEditorState,
  ProjectPublicSummaryUpsertBody,
  ProjectReadersResponse,
  ProjectSourceBinding,
  ProjectUpdate,
  ProjectWorkUpdatesResponse,
  Proposal,
  RetrievalBriefRequest,
  RetrievalBriefResponse,
  RetrievalFeedbackRequest,
  RetrievalFeedbackResponse,
  SourceHealth,
} from '../types/api'
import { waitForJobResult, waitForProviderRun } from './jobReads'
import { callOperation, commandReceipt, projectManagementCall } from './operations'
import { sourcesApi } from './sources'
import { readServerSentEvents } from './streams'
import type { RequestOptions } from './transport'
import { _spaceId, accountFetch, accountHeaders, ApiRequestError, BASE, get, pageQuery, streamRefusal } from './transport'
import type {
  OperationInput,
  ProjectAgent,
  ProjectAgentCandidatesResponse,
  ProjectAgentListResponse,
  ProjectMember,
  ProjectMemberInput,
  ProjectRoomsResponse,
} from '@rainver/protocol'
import { ProjectUpdateFrameSchema } from '@rainver/protocol'

// ── Projects ──────────────────────────────────────────────────────────────
async function currentProjectVersion<T extends {id:string}>(kind:'brief'|'instruction',receipt:{project_id:string;id:string;space_id:string}){
  const rows=await get<T[]>(`/projects/${encodeURIComponent(receipt.project_id)}/${kind}-versions`,{spaceId:receipt.space_id});
  const row=rows.find(r=>r.id===receipt.id);if(!row)throw new Error('Project version no longer available');return row;
}

export const projectsApi = {
  streamUpdates: async(id:string,onFrame:(frame:import('@rainver/protocol').ProjectUpdateFrame)=>void,options:RequestOptions={})=>{
    const headers:Record<string,string>={Accept:'text/event-stream','X-Rainver-Space-Id':options.spaceId??_spaceId,...accountHeaders()}
    const startedIn=sessionEpoch()
    const response=await accountFetch(`${BASE}/projects/${encodeURIComponent(id)}/updates/stream`,{headers,signal:options.signal})
    if(!response.ok||!response.body)throw await streamRefusal(response,'Project stream unavailable',startedIn,options.signal)
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

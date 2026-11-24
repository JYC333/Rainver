import { sessionEpoch } from '../lib/sessionResidue'
import type {
  ProjectOperation,
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
  ProjectResearchWorkflow,
  ProjectSourceBinding,
  ResearchArea,
  ResearchChecklistItem,
  ResearchEvidenceCard,
  ResearchProviderKey,
  ResearchReadingList,
  SourceChannel,
} from '../types/api'
import { callOperation, commandReceipt, operationAt } from './operations'
import { pollRead, READ_PENDING } from './pollRead'
import type { RequestOptions } from './transport'
import { ApiRequestError, _spaceId, get, post } from './transport'
import type {
  ListResearchQueryAttemptsResponse,
  OperationInput,
  OperationOutput,
  ResearchQueryEvaluationAcceptedJob,
  ResearchQueryEvaluationResult,
  ResearchResultSchema,
  WorkRetrievalSwitch,
  WorkRetrievalSwitchRequest,
} from '@rainver/protocol'

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
  }, key:string=crypto.randomUUID(), options: RequestOptions = {}):Promise<ProjectResearchQuestionRefinementResponse> => {
    const epoch = sessionEpoch()
    const receipt=await commandReceipt('research.question.refine',{project_id:projectId,...body},key,options)
    const path=`/projects/${encodeURIComponent(receipt.project_id)}/research/question/assessment?thread_id=${encodeURIComponent(receipt.thread_id)}`
    return pollRead({
      signal: options.signal, epoch, timeoutMs: 180_000, intervalMs: 700,
      sessionChanged: 'The session changed while the question was being assessed',
      timedOut: () => new Error('Question assessment is still running; refresh later'),
    }, signal => get<ProjectResearchQuestionAssessmentSession|null>(path,{spaceId:receipt.space_id,signal}), session => {
      const turn=session?.messages.find(message=>message.id===receipt.id)
      // This receipt's own answer: another concurrent turn may own latest_refinement.
      const answer=turn?.status==='complete'?session?.messages.find(message=>message.role==='assistant'&&message.turn_index===turn.turn_index&&message.status==='complete')?.refinement:undefined
      if(session&&answer)return {...answer,assessment_session:session} as ProjectResearchQuestionRefinementResponse
      if(!turn||turn.status==='failed')throw new Error([...(turn?.processing_events??[])].reverse().find(event=>event.status==='failed')?.message??'Question assessment did not complete')
      return READ_PENDING
    })
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
  waitEvaluation: (receipt: ResearchQueryEvaluationAcceptedJob, options: RequestOptions = {}): Promise<{strategy: import('@rainver/protocol').ResearchQueryStrategy}> => {
    const spaceId = options.spaceId ?? _spaceId
    const requireSpace = () => {
      if (!options.spaceId && spaceId !== _spaceId) throw new ApiRequestError('The session changed while evaluation was running',401,'authentication_required')
    }
    return pollRead({
      signal: options.signal, timeoutMs: 180_000, intervalMs: 1000,
      sessionChanged: 'The session changed while evaluation was running',
      timedOut: () => new Error('Research evaluation is still running; refresh later'),
    }, signal => {
      requireSpace()
      return researchDiscoveryApi.evaluationResult(receipt.job_id, { spaceId, signal })
    }, view => {
      requireSpace()
      if(view.strategy_id!==receipt.strategy_id||view.run_id!==receipt.run_id)throw new Error('Evaluation receipt changed')
      if(view.status==='succeeded'&&view.result)return view.result
      if(view.status==='failed'||view.status==='cancelled')throw new Error('Research evaluation did not complete; sent work will not be repeated')
      return READ_PENDING
    })
  },
  evaluationResult: (jobId: string, options?: RequestOptions) =>
    get<ResearchQueryEvaluationResult>(`/research/query-evaluations/${encodeURIComponent(jobId)}`, options),
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

const researchOperation=(receipt:{id:string;project_id:string;space_id:string})=>
  get<ProjectOperation>(`/projects/${encodeURIComponent(receipt.project_id)}/operations/${encodeURIComponent(receipt.id)}`,{spaceId:receipt.space_id})

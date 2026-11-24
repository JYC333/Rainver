import type {
  ExperimentDefinition,
  ExperimentInterpretation,
  ExperimentObservation,
  ExperimentRun,
  ExperimentVersion,
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
} from '../types/api'
import { noteObjectCall, callOperation, commandReceipt, projectManagementCall } from './operations'
import { get } from './transport'
import type {
  GraphProjection,
  OperationInput,
  ProblemCloseRoundRequest,
  ProblemLinkedTasksPage,
  ProblemProjectionSchema,
  ProblemTaskResult,
  ProblemWorkRequest,
} from '@rainver/protocol'
import { INQUIRY_OPERATION_SCHEMAS } from '@rainver/protocol'

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
  /** `summary`: the server withheld framing, Options, Criteria, scores and Commitments. */
  effective_access_level: 'full' | 'summary'
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

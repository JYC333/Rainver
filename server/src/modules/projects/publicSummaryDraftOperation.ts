import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError,objectValue,optionalString,withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {withRunTerminalOwner} from '../systemActions/operations/proposalTransitions.js';
import {canonicalRunOutput} from '../runs/orchestrationResults.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {PgRunRepository} from '../runs/repository.js';
import {enqueueProviderTaskRunJob,providerTaskRunPreparers} from '../runs/providerTaskRunHandler.js';
import {BoundedProviderTaskError} from '../runs/boundedProviderTaskRun.js';
import {assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation,ProjectArchivedMutationError} from './access.js';
import {ProjectManagementMutationError} from './managementErrors.js';
import {ProjectPublicSummaryGenerator,type PreparedPublicSummaryDraft} from './publicSummaryGenerator.js';
import {lockPublicSummaryProjects} from './publicSummarySourceClosure.js';

const OPERATION='project.public_summary.draft.generate';
/** The bounded task's capability identity on its Run. */
export const PUBLIC_SUMMARY_DRAFT_CAPABILITY='project_public_summary_draft';
const TASK='project_public_summary';
type Input={project_id:string;model_provider_id?:string|null;model?:string|null};
type Frozen=Pick<PreparedPublicSummaryDraft,'allowedSourceRefs'|'sourceCounts'>&Partial<Pick<PreparedPublicSummaryDraft,'sourceAccess'>>&{system:string};

/**
 * Admits one draft generation: authorized context and prompt are frozen on a
 * queued private ProviderTask Run and its Job commit with the core receipt.
 * The provider is called only by the worker; the draft is written there.
 */
export function publicSummaryDraftRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration{return {
 definition:definitions.get(OPERATION)!,successStatus:202,
 async resolve(_db,raw){const i=raw as Input;return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id},resourceType:'project',resourceId:i.project_id};},
 async authorize(db,raw,a){const i=raw as Input;
  await assertProjectWriter(db,a.space_id,i.project_id,a.on_behalf_of_user_id!,{allowArchived:true});
  try{await lockActiveProjectForMutation(db,a.space_id,i.project_id);}catch(e){if(e instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409,false,'projects');throw e;}
  await assertProjectWriterForMutation(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);
 },
 async authorizeResult(db,raw,a){const out=raw as {space_id:string;project_id:string;run_id:string};if(out.space_id!==a.space_id)throw hidden();
  await assertProjectWriterForMutation(db,a.space_id,out.project_id,a.on_behalf_of_user_id!);
  if(!(await db.query("SELECT id FROM runs WHERE id=$1 AND space_id=$2 AND project_id=$3 AND capability_id=$4 AND instructed_by_user_id=$5",[out.run_id,a.space_id,out.project_id,PUBLIC_SUMMARY_DRAFT_CAPABILITY,a.on_behalf_of_user_id])).rows.length)throw hidden();
 },
 async execute(db,raw,a:OperationActor){const i=raw as Input,identity={spaceId:a.space_id,userId:a.on_behalf_of_user_id!};
  const generator=new ProjectPublicSummaryGenerator(db,config.databaseUrl??null);
  const prepared=await generator.prepareDraft(identity,i.project_id,{providerId:i.model_provider_id??null,model:i.model??null});
  const frozen:Frozen={system:prepared.prompt.system,allowedSourceRefs:prepared.allowedSourceRefs,sourceAccess:prepared.sourceAccess,sourceCounts:prepared.sourceCounts};
  const run=await new PgRunRepository(db).createQueuedProviderTaskRun({
   space_id:a.space_id,user_id:identity.userId,trigger_origin:'manual',run_type:'agent',task:TASK,
   prompt:'Generate a public summary draft',instruction:prepared.prompt.user,project_id:i.project_id,
   capability_id:PUBLIC_SUMMARY_DRAFT_CAPABILITY,visibility:'private',
   contract_snapshot:{source:{kind:'direct',id:i.project_id},project_id:i.project_id,
    workflow_input_json:{public_summary_draft:frozen},
    route_hints_json:{owner_domain:'projects',stage:PUBLIC_SUMMARY_DRAFT_CAPABILITY,provider_id:prepared.providerId,model:prepared.model}},
  });
  const job=await enqueueProviderTaskRunJob(db,{run_id:run.id,space_id:a.space_id,user_id:identity.userId,project_id:i.project_id});
  return {id:run.id,project_id:i.project_id,space_id:a.space_id,run_id:run.id,job_id:job.id};
 },
 classifyError(e){if(e instanceof ProjectManagementMutationError)return new OperationBusinessError(e.statusCode===409?'operation_conflict':'operation_invalid_input',e.statusCode===409?409:422,'projects');return undefined;},
};}

/** How the shared provider_task worker performs a queued draft Run: everything comes from the Run. */
export function registerPublicSummaryDraftRuns(config:ServerConfig):void{
 providerTaskRunPreparers.register(PUBLIC_SUMMARY_DRAFT_CAPABILITY,async({db,run})=>{
  const contract=objectValue(run.contract_snapshot_json),hints=objectValue(contract.route_hints_json),frozen=objectValue(objectValue(contract.workflow_input_json).public_summary_draft) as unknown as Frozen;
  const userId=optionalString(run.instructed_by_user_id),projectId=run.project_id;
  if(!userId||!projectId||typeof frozen.system!=='string'||!Array.isArray(frozen.allowedSourceRefs))throw new Error('Public summary draft Run is missing its frozen authority');
  const identity={spaceId:run.space_id,userId};
  return {completion:'text',spaceId:run.space_id,userId,projectId,task:TASK,capabilityId:PUBLIC_SUMMARY_DRAFT_CAPABILITY,
   providerId:optionalString(hints.provider_id)??'',model:optionalString(hints.model),
   system:frozen.system,messages:[{role:'user',content:run.instruction??''}],prompt:run.prompt??'',instruction:run.instruction??null,
   runType:run.run_type??'agent',triggerOrigin:run.trigger_origin??'manual',spend:{kind:'person',user_id:userId},
   // Each attempt spends the frozen prompt, so the person must still write an
   // active Project and still reach every source frozen into it (no oversight).
   authorizeAttempt:async attemptDb=>{await authorizeDraft(attemptDb,config,identity,projectId,frozen);},
   finalize:async(completion,runId)=>{
    try{
     await publishDraft(db,config,identity,projectId,completion,frozen,runId);
    }catch(error){if(error instanceof HttpError&&[403,404,409,422,502].includes(error.statusCode))throw new BoundedProviderTaskError('public_summary_draft_rejected',error.message);throw error;}
    await draftWriter(db,config).auditGeneration(identity,projectId,{providerId:completion.providerId,model:completion.model,sourceCounts:frozen.sourceCounts??{}});
    return null;
   }};
 });
}

/**
 * One transaction's authority for the frozen prompt: the active Project, the
 * person's writer role, and the whole source closure share-locked and then
 * re-read, at the level each frozen body needs. Used by every attempt (before
 * the provider is spent) and by publication (in the draft's own transaction),
 * so a revocation racing either one is serialized against it.
 *
 * Every Project the closure names is admitted first, in id order, the draft's
 * own Project exclusively (`lockPublicSummaryProjects`): two drafts whose
 * research reads each other's Project Sources queue instead of deadlocking.
 */
async function authorizeDraft(db:Queryable,config:ServerConfig,identity:{spaceId:string;userId:string},projectId:string,frozen:Frozen):Promise<void>{
 const projects=await lockPublicSummaryProjects(db,identity.spaceId,projectId,frozen.allowedSourceRefs);
 await assertProjectWriterForMutation(db,identity.spaceId,projectId,identity.userId);
 await draftWriter(db,config).assertFrozenSourcesReadable(identity,projectId,frozen.allowedSourceRefs,frozen.sourceAccess,projects);
}

/**
 * The draft and the Run's success commit together under the Run terminal
 * owner, so a crash leaves either both or neither: a retried job then finds a
 * settled Run and never calls the model again over a person's later edits.
 * Only a still-running Run publishes; a cancelled or settled one is left as
 * its owner ended it.
 */
async function publishDraft(db:Queryable,config:ServerConfig,identity:{spaceId:string;userId:string},projectId:string,completion:{text:string;providerId:string;model:string},frozen:Frozen,runId:string):Promise<void>{
 await withRunTerminalOwner(db,async()=>[{space_id:identity.spaceId,id:runId}],async owner=>withQueryableTransaction(owner,async tx=>{
  const run=(await tx.query<{status:string}>('SELECT status FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE',[runId,identity.spaceId])).rows[0];
  if(run?.status!=='running')return;
  await authorizeDraft(tx,config,identity,projectId,frozen);
  const summary=await draftWriter(tx,config).applyDraft(identity,projectId,completion,frozen,runId);
  await new PgRunRepository(tx).markRunTerminal({run_id:runId,space_id:identity.spaceId,status:'succeeded',
   output_json:canonicalRunOutput({success:true,outputText:'',outputJson:{draft_version:summary.draft_version??null}}),completed_at:new Date().toISOString()});
 }));
}
const draftWriter=(db:Queryable,config:ServerConfig)=>new ProjectPublicSummaryGenerator(db,config.databaseUrl??null);

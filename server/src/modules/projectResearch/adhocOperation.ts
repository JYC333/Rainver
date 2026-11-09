import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import type {Queryable,SpaceUserIdentity} from '../routeUtils/common.js';
import {objectValue,withQueryableTransaction,HttpError} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationError,OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {ProjectArchivedMutationError,lockProjectAudience} from '../projects/access.js';
import {ProjectResearchAreaService,RESEARCH_ADHOC_DAILY_RUN_LIMIT} from './areaService.js';
import {NotebookChatBudgetError} from './notebookChatErrors.js';
import {ResearchContentReadAuditError} from './workspaceErrors.js';
import {discoverNotebookChat,authorizeNotebookChat} from './notebookChatAdmission.js';
import {assertWritableSpaceObject} from '../knowledge/knowledgeWriteAccess.js';
import {assertResearchProviderSourceEgress,assertResearchNoteSourceAudience} from './providerSourceAccess.js';
type Input={project_id:string;section_key:string;source_item_ids:string[]};
const person=(actor:OperationActor)=>({spaceId:actor.space_id,userId:actor.on_behalf_of_user_id!});
async function discover(db:Queryable,input:Input,identity:SpaceUserIdentity,config:ServerConfig){
 const note=await new ProjectResearchAreaService(db,config).resolveAdhocNoteId(identity,input.project_id,input.section_key);
 return {note,context:await discoverNotebookChat(db,identity,input.project_id,input.source_item_ids,note?[note]:[])};
}
/** Ad-hoc analysis already uses the canonical ProviderTask Job; this command owns admission only. */
export function researchAdhocRegistration(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration{return {
 definition:definitions.get('research.ask_ai')!,successStatus:201,
 async resolve(db,raw,actor){const input=raw as Input;return {authority:`project:${input.project_id}`,resourceType:'project',resourceId:input.project_id,targets:{project_id:input.project_id,section_key:input.section_key},closure:await discover(db,input,person(actor),config)};},
 async authorize(db,raw,actor,scope){const input=raw as Input,before=(scope as typeof scope&{closure:Awaited<ReturnType<typeof discover>>}).closure;
  await authorizeNotebookChat(db,person(actor),input.project_id,before.context.sources.map(source=>source.id),before.context,undefined,before.note?[before.note]:[]);
  if(canonical(await discover(db,input,person(actor),config))!==canonical(before))throw new OperationError('operation_conflict',409,false,'research');
  if(before.note)await assertWritableSpaceObject(db,person(actor),before.note,'Note not found');
 },
 async authorizeResult(db,raw,actor){const receipt=raw as {run_id:string;note_id:string;space_id:string;project_id:string};if(receipt.space_id!==actor.space_id||!(await db.query('SELECT id FROM runs WHERE id=$1 AND space_id=$2 AND project_id=$3 AND instructed_by_user_id=$4',[receipt.run_id,actor.space_id,receipt.project_id,actor.on_behalf_of_user_id])).rows.length)throw hidden();await authorizeResearchAdhocAttempt(db,config,receipt.run_id);},
 async execute(db,raw,actor){const input=raw as Input,result=await new ProjectResearchAreaService(db,config).askAi(person(actor),input.project_id,raw as Record<string,unknown>);return {...result,space_id:actor.space_id,project_id:input.project_id};},
 classifyError(error){if(error instanceof ResearchContentReadAuditError)return new OperationError('operation_audit_unavailable',503,true,'research');if(error instanceof ProjectArchivedMutationError)return new OperationBusinessError('operation_conflict',409,'research');if(error instanceof NotebookChatBudgetError)return new AdhocLimitError();return undefined;},
};}
class AdhocLimitError extends OperationError {
 constructor(){super('operation_limit_exceeded',429,false,'research');}
 override body(requestId:string){const body=super.body(requestId);body.error.message='The Project ad-hoc Research budget is spent for today';body.error.metadata={code:'research_daily_limit',limit:RESEARCH_ADHOC_DAILY_RUN_LIMIT};return body;}
}
/** Recheck only frozen, actually copied context before a provider attempt and before publication. */
export async function authorizeResearchAdhocAttempt(db:Queryable,config:ServerConfig,runId:string):Promise<void>{
 await withQueryableTransaction(db,async tx=>{
  const run=(await tx.query<{space_id:string;project_id:string|null;instructed_by_user_id:string|null;owner_user_id:string|null;contract_snapshot_json:unknown}>('SELECT space_id,project_id,instructed_by_user_id,owner_user_id,contract_snapshot_json FROM runs WHERE id=$1',[runId])).rows[0];
  const who=run?.instructed_by_user_id??run?.owner_user_id;if(!run?.project_id||!who)throw new HttpError(404,'Research ProviderTask not found');
  const identity={spaceId:run.space_id,userId:who},contract=objectValue(run.contract_snapshot_json),frozen=objectValue(objectValue(contract.workflow_input_json).research_adhoc),hints=objectValue(contract.route_hints_json),note=typeof frozen.note_id==='string'?frozen.note_id:null,provider=typeof hints.provider_id==='string'?hints.provider_id:null;
  if(!note||!provider)throw new HttpError(409,'Research ProviderTask context is incomplete');
  if(!(await tx.query("SELECT 1 FROM users person JOIN space_memberships member ON member.user_id=person.id WHERE person.id=$1 AND person.status='active' AND member.space_id=$2 AND member.status='active'",[who,run.space_id])).rows.length)throw new HttpError(404,'Research requester is no longer active');
  const sources=Array.isArray(frozen.source_item_ids)?frozen.source_item_ids.filter((id):id is string=>typeof id==='string'):[];
  const before=await discoverNotebookChat(tx,identity,run.project_id,sources,[note]);
  await authorizeNotebookChat(tx,identity,run.project_id,sources,before,undefined,[note]);
  await lockProjectAudience(tx,identity.spaceId,run.project_id);
  await assertWritableSpaceObject(tx,identity,note,'Note not found');
  await assertResearchProviderSourceEgress(tx,config,identity,{providerId:provider,modelName:typeof hints.model==='string'?hints.model:null},sources,[note]);
  await assertResearchNoteSourceAudience(tx,identity,note,sources);
 });
}

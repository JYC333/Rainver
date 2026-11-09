import type {OperationRegistration} from '../systemActions/operations/types.js';
import type {OperationActor,RegisteredSystemActionDefinition,OperationInput} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {OperationError,OperationBusinessError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {assertProjectWriter,lockActiveProjectForMutation,assertProjectWriterForMutation,ProjectArchivedMutationError} from '../projects/access.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {RunCreateValidationError} from '../runs/repository.js';
import {KnowledgeExtractionService} from './extractionService.js';
import {CandidateMutationError} from './candidateErrors.js';
type Input=OperationInput<'knowledge.candidate.extract'>;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
async function discover(db:Queryable,i:Input,a:OperationActor){
 const table=i.source_kind==='experiment_interpretation'?'experiment_interpretations':'space_objects';
 const source=(await db.query<{id:string;project_id:string|null;object_type?:string}>(table==='space_objects'?'SELECT id,primary_project_id AS project_id,object_type FROM space_objects WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL':'SELECT id,project_id FROM experiment_interpretations WHERE id=$1 AND space_id=$2',[i.source_id,a.space_id])).rows[0];
 if(!source||i.source_kind==='note'&&source.object_type!=='note'||i.source_kind==='inquiry_thread'&&source.object_type!=='inquiry_thread')throw hidden();return source;
}
export function knowledgeExtractionRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{return {
 definition:defs.get('knowledge.candidate.extract')!,successStatus:202,
 async resolve(db,raw,a){const i=raw as Input;return {authority:`project:${i.project_id}`,targets:{project_id:i.project_id,source_kind:i.source_kind,source_id:i.source_id,agent_id:i.agent_id},resourceType:'knowledge_promotion_candidate',resourceId:i.source_id,source:await discover(db,i,a)};},
 async authorize(db,raw,a,scope){const i=raw as Input,before=(scope as typeof scope&{source:Awaited<ReturnType<typeof discover>>}).source;
  if(await contentDecisionFromDb(db,person(a),'agent',i.agent_id,{includeOversight:false})!=='full'||i.source_kind!=='experiment_interpretation'&&await contentDecisionFromDb(db,person(a),'space_object',i.source_id,{includeOversight:false})!=='full')throw hidden();
  try {
  await assertProjectWriter(db,a.space_id,i.project_id,a.on_behalf_of_user_id!);
  for(const project of [...new Set([i.project_id,before.project_id].filter((p):p is string=>!!p))].sort()){
   if(project===i.project_id){await lockActiveProjectForMutation(db,a.space_id,project);await assertProjectWriterForMutation(db,a.space_id,project,a.on_behalf_of_user_id!);}else await db.query('SELECT id FROM projects WHERE id=$1 AND space_id=$2 FOR SHARE',[project,a.space_id]);
  }
  }catch(error){if(error instanceof ProjectArchivedMutationError)throw new OperationError('operation_conflict',409);throw error;}
  await db.query('SELECT id FROM project_members WHERE space_id=$1 AND user_id=$2 AND project_id=ANY($3::varchar[]) ORDER BY id FOR SHARE',[a.space_id,a.on_behalf_of_user_id,[i.project_id,before.project_id].filter(Boolean)]);
  await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND grantee_user_id=$2 AND resource_id=ANY($3::varchar[]) ORDER BY id FOR SHARE',[a.space_id,a.on_behalf_of_user_id,[i.source_id,i.agent_id]]);
  if((await db.query("SELECT id FROM agents WHERE id=$1 AND space_id=$2 AND status='active' FOR SHARE",[i.agent_id,a.space_id])).rows.length===0||await contentDecisionFromDb(db,person(a),'agent',i.agent_id,{includeOversight:false})!=='full')throw hidden();
  await db.query(`SELECT id FROM ${i.source_kind==='experiment_interpretation'?'experiment_interpretations':'space_objects'} WHERE id=$1 AND space_id=$2 FOR SHARE`,[i.source_id,a.space_id]);
  if(canonical(await discover(db,i,a))!==canonical(before))throw new OperationError('operation_conflict',409);
  if(i.source_kind!=='experiment_interpretation'&&await contentDecisionFromDb(db,person(a),'space_object',i.source_id,{includeOversight:false})!=='full')throw hidden();
 },
 async authorizeResult(db,raw,a){const out=raw as {run_id:string;space_id:string};if(out.space_id!==a.space_id||await contentDecisionFromDb(db,person(a),'run',out.run_id,{includeOversight:false})==='deny')throw hidden();},
 async execute(db,raw,a){const i=raw as Input,out=await new KnowledgeExtractionService(db).queue(person(a),i.project_id,i);return {run_id:out.run_id,space_id:a.space_id,status:'queued'};},
 classifyError(error){if(error instanceof CandidateMutationError||error instanceof ProjectArchivedMutationError||error instanceof RunCreateValidationError&&[409,422].includes(error.statusCode))return new OperationBusinessError(error instanceof ProjectArchivedMutationError||error.statusCode===409?'operation_conflict':'operation_invalid_input',error instanceof ProjectArchivedMutationError||error.statusCode===409?409:422,'knowledge');return undefined;},
};}

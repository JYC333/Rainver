import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {objectValue,type Queryable} from '../routeUtils/common.js';
import {ContentAccessAuditService} from '../contentAccess/audit.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {OperationBusinessError,OperationError,hidden} from '../systemActions/operations/errors.js';
import {canonical} from '../systemActions/operations/repository.js';
import {researchGraphRunRefs} from '../systemActions/operations/proposalTransitions.js';
import {discoverCorpusScope,authorizeCorpusScope} from '../projects/corpusOperationAdmission.js';
import {assertProjectWriterForMutation} from '../projects/access.js';
import {assertThreadReadable} from '../inquiry/threadAccess.js';
import {researchWorkflowProjection} from './workflowOntology.js';
import {ProjectResearchOrchestrator} from './orchestrator.js';
import {ResearchWorkspaceMutationError,ResearchContentReadAuditError} from './workspaceErrors.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Input={project_id:string};
async function discoverSnapshot(db:Queryable,input:Input,actor:OperationActor){
 const projection=researchWorkflowProjection();
 const workflow=(await db.query<{id:string;state_json:unknown;primary_thread_id:string|null}>(`SELECT w.object_id AS id,w.state_json,pin.primary_thread_id FROM ${projection.from} WHERE w.space_id=$1 AND w.project_id=$2 AND w.status IN ('active','paused') ORDER BY workflow_object.updated_at DESC LIMIT 1`,[actor.space_id,input.project_id])).rows[0]??null;
 const state=objectValue(workflow?.state_json),threads=[...new Set([workflow?.primary_thread_id,...(Array.isArray(state.thread_scope)?state.thread_scope.flatMap(raw=>{const value=objectValue(raw);return typeof value.thread_id==='string'?[value.thread_id]:[];}):[])].filter((id):id is string=>!!id))].sort();
 return {workflow,threads,corpus:await discoverCorpusScope(db,input,actor,true)};
}
async function authorizeWorkflow(db:Queryable,actor:OperationActor,project:string,workflow:string,threads:readonly string[]){
 const roots=[...new Set([workflow,...threads])].sort();
 await db.query('SELECT id FROM space_objects WHERE space_id=$1 AND id=ANY($2::varchar[]) ORDER BY id FOR UPDATE',[actor.space_id,roots]);
 await db.query('SELECT id FROM content_access_grants WHERE space_id=$1 AND resource_id=ANY($2::varchar[]) ORDER BY id FOR SHARE',[actor.space_id,roots]);
 const projection=researchWorkflowProjection({viewerPlaceholder:'$4'});
 if(!(await db.query(`SELECT w.object_id FROM ${projection.from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3 AND ${projection.visibilityPredicate} FOR UPDATE OF w`,[workflow,actor.space_id,project,actor.on_behalf_of_user_id])).rows.length)throw hidden();
 for(const thread of threads)await assertThreadReadable(db,person(actor),project,thread,'read_content');
}
/** The existing two-node Workflow queues execution; this adapter owns only its durable admission. */
export function researchExecutionRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{return [{
 definition:definitions.get('research.report.snapshot')!,successStatus:202,
 runTerminalOwner:{discover:(db,raw,actor)=>researchGraphRunRefs(db,actor.space_id,(raw as Input).project_id)},
 async resolve(db,raw,actor){const input=raw as Input;return {authority:`project:${input.project_id}`,resourceType:'project',resourceId:input.project_id,targets:{project_id:input.project_id},closure:await discoverSnapshot(db,input,actor)};},
 async authorize(db,raw,actor,scope){const input=raw as Input,before=(scope as typeof scope&{closure:Awaited<ReturnType<typeof discoverSnapshot>>}).closure;
  await authorizeCorpusScope(db,input,actor,before.corpus);
  if(before.workflow)await authorizeWorkflow(db,actor,input.project_id,before.workflow.id,before.threads);
  if(canonical(await discoverSnapshot(db,input,actor))!==canonical(before))throw new OperationError('operation_conflict',409,false,'research');
 },
 async authorizeResult(db,raw,actor){const out=raw as {id:string;project_id:string;space_id:string};if(out.space_id!==actor.space_id)throw hidden();await assertProjectWriterForMutation(db,actor.space_id,out.project_id,actor.on_behalf_of_user_id!);
  const operation=(await db.query<{workflow_id:string|null}>('SELECT progress_json->>\'workflow_id\' AS workflow_id FROM project_operations WHERE id=$1 AND space_id=$2 AND project_id=$3 AND kind=\'research\'',[out.id,actor.space_id,out.project_id])).rows[0];if(!operation?.workflow_id)throw hidden();
  const projection=researchWorkflowProjection({viewerPlaceholder:'$4'});if(!(await db.query(`SELECT w.object_id FROM ${projection.from} WHERE w.object_id=$1 AND w.space_id=$2 AND w.project_id=$3 AND ${projection.visibilityPredicate}`,[operation.workflow_id,actor.space_id,out.project_id,actor.on_behalf_of_user_id])).rows.length)throw hidden();
 },
 async execute(db,raw,actor){const input=raw as Input,before=await discoverSnapshot(db,input,actor);
  try{await new ContentAccessAuditService(db).recordReads({spaceId:actor.space_id,viewerUserId:actor.on_behalf_of_user_id!,resourceType:'space_object',resourceIds:[...before.threads,...(before.workflow?[before.workflow.id]:[])],accessType:'research_report_snapshot'});}catch{throw new ResearchContentReadAuditError();}
  const result=await new ProjectResearchOrchestrator(db,config).generateReportSnapshot(person(actor),input.project_id);return {id:result.id,space_id:actor.space_id,project_id:input.project_id};},
 classifyError(error){if(error instanceof ResearchContentReadAuditError)return new OperationError('operation_audit_unavailable',503,true,'research');if(error instanceof ResearchWorkspaceMutationError)return new OperationBusinessError(error.statusCode===409?'operation_conflict':'operation_invalid_input',error.statusCode===409?409:422,'research');return undefined;},
}];}

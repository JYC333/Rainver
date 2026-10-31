import type {Pool,Queryable,SpaceUserIdentity} from '../../routeUtils/common.js';
import {HttpError} from '../../routeUtils/common.js';
import {WorkContextService} from '../../runtimeContext/workContextService.js';
export async function closeReadingContext(db:Queryable,identity:SpaceUserIdentity,runId:string,agentId:string,profileId:string,projectId:string|null=null){
 await new WorkContextService(db as Pool).create(identity,{work_context_scope_id:runId,scope_kind:'root_task',project_id:projectId,project_folder_id:null,agent_id:agentId,runtime_ref:{type:'runtime_profile',id:profileId},pinned_refs:[],excluded_refs:[],retrieval_preferences:{enabled:false},continuity_preferences:{},base_version:null,reason:'Reading investigation: only the frozen authorized request and explicitly fetched evidence'});
}
export async function assertClosedReadingContext(db:Queryable,spaceId:string,runId:string,projectId:string|null=null){
 const row=(await db.query<{retrieval_preferences_json:{enabled?:boolean};pinned_refs_json:unknown[];project_id:string|null}>(`SELECT retrieval_preferences_json,pinned_refs_json,project_id FROM work_context_setups WHERE space_id=$1 AND work_context_scope_id=$2 ORDER BY version DESC LIMIT 1`,[spaceId,runId])).rows[0];
 if(!row||row.retrieval_preferences_json?.enabled!==false||row.pinned_refs_json?.length||row.project_id!==projectId)throw new HttpError(403,'Reading context was widened');
}

export function isReadingMethodExecutor(run:{contract_snapshot_json?:unknown}){
 const w=(run.contract_snapshot_json as {workflow_input_json?:{reading_method_executor_only?:boolean;reading_method_generation?:unknown;reading_method_trial?:unknown}}|null)?.workflow_input_json;
 return w?.reading_method_executor_only===true&&!!(w.reading_method_generation||w.reading_method_trial);
}

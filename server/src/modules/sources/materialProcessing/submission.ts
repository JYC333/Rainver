import {materialRunExpired} from './executionBudget.js';
import {isDeepStrictEqual} from 'node:util';
import {SourceMaterialSubmissionSchema, type SourceMaterialSubmission} from '@rainver/protocol';
import type {ServerConfig} from '../../../config.js';
import {getDbPool} from '../../../db/pool.js';
import type {RunRecord} from '../../runs/repository.js';
import {HttpError,withDbTransaction,type Queryable} from '../../routeUtils/common.js';
import {assertSafeGoalMessage} from '../goals/messageSafety.js';
import {agentReadingPolicy} from './policy.js';
import {assertMaterialProcessingDispatch} from './dispatch.js';
import {materialItemContext} from './items.js';
const MAX_SUBMISSIONS=3;
/** Bound to the authenticated canonical Run, never to caller-supplied identity.
 * Invalid attempts consume the same finite allowance as corrected submissions. */
async function admitted(tx:Queryable,config:ServerConfig,run:RunRecord){
 const current=(await tx.query<RunRecord>(`SELECT * FROM runs WHERE id=$1 AND space_id=$2 FOR SHARE`,[run.id,run.space_id])).rows[0];
 if(!current||current.status!=='running'||!current.started_at||materialRunExpired(current))throw new HttpError(403,'source_material_submission_inactive');
 const grants=(current.permission_snapshot_json as {tool_grants?:{action_id:string}[]}|null)?.tool_grants??[];if(!grants.some(g=>g.action_id==='source.material.submit'))throw new HttpError(403,'source_native_context_refused');
 const itemContext=materialItemContext(current);let audit:{id:string;result_json:{search_submission?:SourceMaterialSubmission;submission_attempts?:number}};
 if(itemContext){
  const row=(await tx.query<{id:string;metadata_json:{material_submission?:SourceMaterialSubmission;submission_attempts?:number}}>("SELECT id,metadata_json FROM extraction_jobs WHERE id=$1 AND space_id=$2 AND metadata_json->>'run_id'=$3 AND status IN ('pending','running') FOR UPDATE",[itemContext.id,current.space_id,current.id])).rows[0];if(!row)throw new HttpError(403,'source_material_context_refused');
  audit={id:row.id,result_json:{...row.metadata_json,search_submission:row.metadata_json.material_submission}};
 }else{
  const context=(current.contract_snapshot_json as {workflow_input_json?:{source_goal?:{purpose?:string;collection_id:string}}})?.workflow_input_json?.source_goal;
  if(context?.purpose!=='collect')throw new HttpError(403,'source_native_context_refused');
  audit=(await tx.query(`SELECT * FROM source_goal_runs WHERE id=$1 AND space_id=$2 AND result_json->>'native_run_id'=$3 AND status='queued' FOR UPDATE`,[context.collection_id,current.space_id,current.id])).rows[0] as typeof audit;
  if(!audit||'goal_stopped'in audit.result_json&&audit.result_json.goal_stopped===true)throw new HttpError(403,'source_material_submission_inactive');
 }
 const source=await assertMaterialProcessingDispatch(config,current,tx);

 return {current,audit,source,itemContext};
}
export async function submitMaterialResults(config:ServerConfig,run:RunRecord,raw:unknown){
 const db=getDbPool(config.databaseUrl!);
 // Commit the attempt even on format error; never increment model/Run attempts.
 const state=await withDbTransaction(db,async tx=>{
  const {current,audit,source,itemContext}=await admitted(tx,config,run);
  const parsedRaw=SourceMaterialSubmissionSchema.safeParse(raw);
  // Validate text against the live Source policy before persisting the submission.
  const canonical=parsedRaw.success?parsedRaw.data:null;
  if(audit.result_json.search_submission){
   if(isDeepStrictEqual(audit.result_json.search_submission,canonical))return {duplicate:true};
   throw Object.assign(new HttpError(409,'source_material_submission_already_recorded'),{code:'source_material_submission_already_recorded'});
  }
  if(Number(audit.result_json.submission_attempts??0)>=MAX_SUBMISSIONS)throw Object.assign(new HttpError(429,'source_material_submission_limit'),{code:'source_material_submission_limit'});
  const table=itemContext?'extraction_jobs':'source_goal_runs',column=itemContext?'metadata_json':'result_json';
  await tx.query(`UPDATE ${table} SET ${column}=jsonb_set(${column},'{submission_attempts}',to_jsonb(COALESCE((${column}->>'submission_attempts')::int,0)+1)) WHERE id=$1`,[audit.id]);
  const parsed=parsedRaw;
  if(!parsed.success)return {issues:parsed.error.issues.map(i=>({field:i.path.join('.'),message:i.message}))};
  const input=canonical!;
  const policy=source?agentReadingPolicy(source):{summary:true,content:true};
  if(itemContext&&input.status==='succeeded'&&(input.items.length!==1||input.items[0].url!==(await tx.query('SELECT source_uri FROM source_items WHERE id=$1 AND space_id=$2',[itemContext.item_id,current.space_id])).rows[0]?.source_uri))return {issues:[{field:'items',message:'Submit exactly the original item URL; no replacements'}]};
  const denied=input.items.flatMap((item,index)=>[...(!policy.summary&&item.summary?[{field:`items.${index}.summary`,message:'Source policy is metadata-only; use null'}]:[]),...(!policy.content&&item.content?[{field:`items.${index}.content`,message:'Source policy does not allow retained reading content; use null'}]:[])]);if(denied.length)return {issues:denied};
  // The submitter says how content.text is written; an undeclared text would be shown literally, Markdown marks and all.
  const undeclared=input.items.flatMap((item,index)=>item.content&&!item.content.syntax?[{field:`items.${index}.content.syntax`,message:'Required: "markdown" when content.text uses Markdown (# headings, - lists, **bold**, code fences, tables), otherwise "plain"'}]:[]);if(undeclared.length)return {issues:undeclared};
  try{assertSafeGoalMessage(JSON.stringify(input));}catch{return {issues:[{field:"items",message:"Use the secure credential channel; recognizable secret material is not accepted"}]};}
  if(input.processing_id!==audit.id)return {issues:[{field:'processing_id',message:'Use the processing_id bound to this Run'}]};
  const now=Date.now();if(input.items.some(i=>Date.parse(i.observed_at)>now+60000||Date.parse(i.observed_at)<Date.parse(String(current.started_at))-60000))return {issues:[{field:'items.observed_at',message:'Observation must belong to this collection Run, not a guessed publication date'}]};
  await tx.query(`UPDATE ${table} SET ${column}=${column}||$2::jsonb WHERE id=$1`,[audit.id,{[itemContext?'material_submission':'search_submission']:input,result_provenance:'agent_provided_unverified'}]);
  return {duplicate:false};
 });
 if('issues' in state)throw Object.assign(new HttpError(422,JSON.stringify({code:'source_material_submission_invalid',fields:state.issues,remaining_attempts:'At most three submissions per Run'})),{code:'source_material_submission_invalid'});
 return {recorded:true,duplicate:state.duplicate,verification:'agent_provided_unverified'};
}

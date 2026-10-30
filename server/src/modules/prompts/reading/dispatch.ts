import {getDbPool} from '../../../db/pool.js';
import type {ServerConfig} from '../../../config.js';
import type {RunRecord} from '../../runs/repository.js';
import type {Queryable} from '../../routeUtils/common.js';
import {assertClosedReadingContext} from './closedContext.js';
import {HttpError} from '../../routeUtils/common.js';
import {readingMethodOf,assertFrozenReadingMethod} from './runtime.js';
import {trialContext,assertReadingTrialRun,assertReadingTrialReadable} from './trials.js';
import {readingProjectContext,assertReadingAudience,assertReadingRunEgress} from '../../sources/index.js';
export async function readingRunDependencies(db:Queryable,run:RunRecord){
 const trial=trialContext(run);const method=readingMethodOf(run);if(!trial&&!method)return null;
 const workflow=(run.contract_snapshot_json as {workflow_input_json?:{material_processing?:{item_id:string};source_goal?:{goal_id?:string;project_id?:string|null;source_connection_id?:string}}})?.workflow_input_json;
 if(trial){const row=(await db.query<{eval_suite_ref_json:{item_id:string;project_id:string|null;case_id:string}}>(`SELECT eval_suite_ref_json FROM evolvable_asset_evaluation_runs WHERE id=$1 AND space_id=$2`,[trial.evaluation_id,run.space_id])).rows[0];if(!row)throw new HttpError(403,'Trial missing');return {itemId:row.eval_suite_ref_json.item_id,projectId:row.eval_suite_ref_json.project_id,artifactId:((await db.query<{input_json:{authority_proof?:{artifact_id?:string}}}>(`SELECT input_json FROM evaluation_cases WHERE id=$1 AND space_id=$2`,[row.eval_suite_ref_json.case_id,run.space_id])).rows[0]?.input_json.authority_proof?.artifact_id)??null,caseId:row.eval_suite_ref_json.case_id,connectionId:(await db.query<{connection_id:string|null}>(`SELECT connection_id FROM source_items WHERE id=$1 AND space_id=$2`,[row.eval_suite_ref_json.item_id,run.space_id])).rows[0]?.connection_id??null};}
 const goal=workflow?.source_goal;
 const connection=goal?.source_connection_id??(workflow?.material_processing?.item_id?(await db.query<{connection_id:string|null}>(`SELECT connection_id FROM source_items WHERE id=$1 AND space_id=$2`,[workflow.material_processing.item_id,run.space_id])).rows[0]?.connection_id:null);
 return {itemId:workflow?.material_processing?.item_id??null,projectId:goal?.project_id??method!.project_id,connectionId:connection??null,artifactId:null,caseId:null};
}
export async function assertReadingRunDispatch(db:Queryable,run:RunRecord){
 if(trialContext(run)){await assertReadingTrialRun(db,run);return;}
 const frozen=readingMethodOf(run);if(!frozen)return;
 await assertClosedReadingContext(db,run.space_id,run.id,frozen.project_id);
 const deps=await readingRunDependencies(db,run);if(!deps)throw new HttpError(403,'Reading dependencies missing');
 const identity={spaceId:run.space_id,userId:run.instructed_by_user_id!};
 await assertFrozenReadingMethod(db,frozen,await readingProjectContext(db,identity,frozen.project_id));
 if(frozen.project_id){const binding=deps.itemId?(await db.query('SELECT project_id FROM source_items WHERE id=$1 AND space_id=$2',[deps.itemId,run.space_id])).rows[0]:(await db.query('SELECT project_id FROM source_connections WHERE id=$1 AND space_id=$2',[deps.connectionId,run.space_id])).rows[0];if(binding?.project_id!==frozen.project_id)throw new HttpError(409,'Reading output Project scope changed');}
 await assertReadingAudience(db,identity,null,deps.itemId,deps.connectionId);
 await assertReadingRunEgress(db,run,deps.connectionId);
}
export async function readingRunReadable(db:Queryable,run:RunRecord,viewerUserId?:string){
 if(viewerUserId && (trialContext(run)||readingMethodOf(run)) && viewerUserId!==run.instructed_by_user_id)return false;
 try{if(trialContext(run))await assertReadingTrialReadable(db,run);else if(readingMethodOf(run)){const deps=await readingRunDependencies(db,run);const identity={spaceId:run.space_id,userId:run.instructed_by_user_id!};await readingProjectContext(db,identity,deps!.projectId);await assertReadingAudience(db,identity,null,deps!.itemId,deps!.connectionId);await assertReadingRunEgress(db,run,deps!.connectionId);}return true;}
 catch(e){if(e instanceof HttpError&&[403,404,409,422].includes(e.statusCode))return false;throw e;}
}

export async function assertReadingDispatch(config:ServerConfig,run:RunRecord){if(!trialContext(run)&&!readingMethodOf(run))return;if(!config.databaseUrl)throw new HttpError(403,'Reading execution requires canonical storage');await assertReadingRunDispatch(getDbPool(config.databaseUrl),run);}

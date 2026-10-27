import {selectGoalResult} from './selection.js';
import type {ServerConfig} from '../../../config.js';
import type {Pool} from '../../routeUtils/common.js';
import type {GoalRow} from './access.js';
import type {GoalBindingRow} from './worker.js';
import type {GoalExecutionPort} from './service.js';
import {CustomSourceHandlerOutputSchema} from '@rainver/protocol';
import {validateGoalSample} from './validation.js';
import {materializeGoalBatch} from './materialization.js';
/** New material always commits first. At most one bounded old gap is attempted
 * per source/tick, through the identical executor/quota group; no second queue. */
export async function recoverGoalGap(db:Pool,config:ServerConfig,g:GoalRow,b:GoalBindingRow,token:string,runId:string,executor:GoalExecutionPort){
 const gaps=b.gaps_json as {from:Record<string,unknown>;at:string;status?:string;reason:string;recoverable:boolean;cursor?:Record<string,unknown>;retry_at?:string}[];
 const index=gaps.findIndex(x=>!['covered','unrecoverable'].includes(x.status??'') && (!x.retry_at || new Date(x.retry_at).getTime()<=Date.now()));if(index<0)return;
 const gap={...gaps[index]};
 if(!gap.recoverable || !b.spec_json.supports_history){gap.status='unrecoverable';gap.reason='upstream_history_unavailable';}
 else{
  try{
   const window={since:gap.from.watermark??null,until:gap.at};
   const rawRun=await executor.execute({spaceId:g.space_id,userId:g.owner_user_id},{...g,execution_scope:runId},b.spec_json,{...gap.from,...gap.cursor,__goal_history:true,__goal_window:window},AbortSignal.timeout(120000));
   let run;try{run=await selectGoalResult(db,g,b.spec_json,{...gap.from,...gap.cursor,__goal_history:true},rawRun);}catch(e){await rawRun.cleanup();throw e;}
   try{
    const valid=validateGoalSample(run.output,{budget:g.budget_json,...g.intent_json,allowEmpty:true});if(!valid.ok)throw new Error('source_backfill_validation_failed');
    const items=CustomSourceHandlerOutputSchema.parse(run.output).items;
    if(items.some(i=>!i.published_at || Date.parse(i.published_at)>Date.parse(gap.at) || typeof window.since==='string' && Date.parse(i.published_at)<Date.parse(window.since)))throw new Error('source_backfill_window_refused');
    await materializeGoalBatch(db,config,g,b,token,runId,run,true);
    // A bare HTTP200 is never completion. A source-specific implementation
    // must return an exhausted history cursor for this exact bounded window.
    const proof=run.cursor.history_window as {since?:unknown;until?:unknown;exhausted?:unknown}|undefined;
    gap.status=proof?.exhausted===true && proof.since===window.since && proof.until===window.until?'covered':'incomplete';
    gap.cursor=run.cursor;
   }finally{await run.cleanup();}
  }catch(error){gap.status=error instanceof Error&&error.message==='source_history_unavailable'?'unrecoverable':'deferred';gap.reason=error instanceof Error&&/^source_[a-z_]+$/.test(error.message)?error.message:'source_backfill_failed';gap.retry_at=(error as {retryAt?:string}).retryAt??new Date(Date.now()+60000).toISOString();}
 }
 const next=[...gaps];next[index]=gap;
 await db.query('UPDATE source_goal_bindings SET gaps_json=$3 WHERE id=$1 AND lease_token=$2',[b.id,token,JSON.stringify(next)]);
}

import {RUN_OPERATION_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {getDbPool} from '../../db/pool.js';
import type {Queryable} from '../routeUtils/common.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {updateQuotaRecovery} from '../rooms/quotaRecovery.js';
import {RoomMutationError} from '../rooms/roomMutationError.js';
import {PgRunRepository} from './repository.js';
import {authorizeRunCommand,authorizeRunResume,mayHoldRunResume,RunCommandRefusal} from './runCommandAuthority.js';
import {canonicalRunOutput,isHardTerminalRunStatus} from './orchestrationResults.js';
import {RunMaterializationService} from './materializationService.js';
import {buildRunOrchestration} from './orchestrationFactory.js';
import {deliverRunLiveInput,LiveInputRefusal,recordRunLiveInput} from './liveInputService.js';

type Id=keyof typeof RUN_OPERATION_SCHEMAS;
type Input={run_id:string;reason?:string|null;binding_id?:string;content?:string;auto_continue?:boolean;switch_model?:boolean};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
const COMMAND:Record<Id,'stop'|'abandon'|'resume'|'execute'|'finalize'|'steer'>={'run.stop':'stop','run.abandon':'abandon','run.resume':'resume','run.execute':'execute','run.finalize':'finalize','run.quota_recovery.update':'resume','run.live_input.submit':'steer'};

/** Person Run controls over the existing command authority and Run writers. */
export function runOperationRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(RUN_OPERATION_SCHEMAS) as Id[]).map(id=>({
  definition:definitions.get(id)!,
  successStatus:id==='run.abandon'||id==='run.resume'||id==='run.execute'?202:200,
  // Abandoning writes the Run's terminal state; the host admits that Run first.
  ...(id==='run.abandon'?{runTerminalOwner:{discover:async(_db:Queryable,raw:unknown,a:OperationActor)=>[{space_id:a.space_id,id:(raw as Input).run_id}]}}:{}),
  async resolve(_db,raw){const i=raw as Input;return {authority:`run:${i.run_id}`,targets:{run_id:i.run_id},resourceType:'run',resourceId:i.run_id};},
  async authorize(db,raw,a){
   const i=raw as Input,runs=new PgRunRepository(db,config);
   await db.query('SELECT id FROM runs WHERE id=$1 AND space_id=$2 FOR UPDATE',[i.run_id,a.space_id]);
   try{
    // A resume's waiting state is its first execution's precondition, checked there:
    // after it succeeds the Run is queued, and a same-key replay must still find its receipt.
    if(id==='run.resume'){if(!await runs.getVisibleRun(a.space_id,a.on_behalf_of_user_id!,i.run_id))throw hidden();return;}
    await authorizeRunCommand(runs,person(a),i.run_id,COMMAND[id]);
   }catch(error){
    // A state refusal found while authorizing is the same deterministic answer execution would give.
    if(error instanceof RunCommandRefusal)throw markedRefusal(error,'runs');
    throw error;
   }
  },
  async authorizeResult(db,raw,a){
   const out=raw as {space_id:string;run_id:string;resume_kind?:'new_attempt'|'same_attempt'};
   const run=out.space_id===a.space_id?await new PgRunRepository(db,config).getVisibleRun(a.space_id,a.on_behalf_of_user_id!,out.run_id):null;
   if(!run)throw hidden();
   // A resume receipt is released only to someone who could give that resume now.
   if(id==='run.resume'&&!await mayHoldRunResume(db,run,person(a),out.resume_kind))throw hidden();
  },
  async execute(db,raw,a){
   const i=raw as Input,p=person(a),runs=new PgRunRepository(db,config),base={id:i.run_id,space_id:a.space_id,run_id:i.run_id};
   switch(id){
    case 'run.stop':{
     // The durable cancellation intent commits here; the process stop happens after commit.
     const run=await authorizeRunCommand(runs,p,i.run_id,'stop');
     if(isHardTerminalRunStatus(run.status))return {...base,status:run.status};
     const marked=await runs.markRunCancelling({run_id:i.run_id,space_id:a.space_id,requested_at:new Date().toISOString(),reason:i.reason??null,requested_by_user_id:p.userId});
     return {...base,status:marked?.status??run.status};
    }
    case 'run.abandon':{
     const run=await authorizeRunCommand(runs,p,i.run_id,'abandon');
     if(run.status!=='waiting_for_review')throw new RunCommandRefusal(`Run is not waiting for review (current status: ${run.status})`);
     const abandonedAt=new Date().toISOString();
     const updated=await runs.markRunTerminal({run_id:i.run_id,space_id:a.space_id,status:'cancelled',
      output_json:canonicalRunOutput({success:false,outputText:'',outputJson:{error_code:'run_abandoned'}}),
      error_json:{error_code:'run_abandoned',error_text:i.reason??'Run abandoned after supervisor review.',abandoned_by_user_id:p.userId},exit_code:1,completed_at:abandonedAt});
     if(!updated)throw new RunCommandRefusal('Run could not be abandoned (status may have changed)');
     return {...base,status:'cancelled' as const,abandoned_at:abandonedAt};
    }
    case 'run.resume':{
     const authorized=await authorizeRunResume(db,runs,p,i.run_id),grantedAt=new Date().toISOString(),review=authorized.kind==='supervisor_review';
     // The requeue and its Job commit together; a queued Run without one has nothing left to run it.
     const requeued=review
      ?await runs.resumeRunAfterSupervisorReview({run_id:i.run_id,space_id:a.space_id,resumed_by_user_id:p.userId,resumed_at:grantedAt})
      :await runs.grantRunApprovalAndRequeue({run_id:i.run_id,space_id:a.space_id,granted_by_user_id:p.userId,granted_at:grantedAt});
     if(!requeued)throw new RunCommandRefusal('Run could not be resumed (status may have changed)');
     await new PgJobQueueRepository(db).ensureAgentRunJob({job_type:'agent_run',space_id:a.space_id,user_id:p.userId,agent_id:authorized.run.agent_id,project_folder_id:authorized.run.project_folder_id,payload:{run_id:i.run_id}});
     return {...base,status:requeued.status,resumed_at:grantedAt,resume_kind:review?'new_attempt' as const:'same_attempt' as const};
    }
    case 'run.execute':{
     // Execution is the Run Job's; this records the durable request instead of executing in the request.
     const run=await authorizeRunCommand(runs,p,i.run_id,'execute');
     if(run.status!=='queued')throw new RunCommandRefusal(`Only a queued Run can be executed (current status: ${run.status})`);
     const job=await new PgJobQueueRepository(db).ensureAgentRunJob({job_type:'agent_run',space_id:a.space_id,user_id:p.userId,agent_id:run.agent_id,project_folder_id:run.project_folder_id,payload:{run_id:i.run_id}});
     return {...base,job_id:job.id};
    }
    case 'run.finalize':{
     const run=await authorizeRunCommand(runs,p,i.run_id,'finalize');
     if(!isHardTerminalRunStatus(run.status))throw new RunCommandRefusal(`Run '${i.run_id}' is not terminal (status='${run.status}').`,422);
     return base;
    }
    case 'run.quota_recovery.update':{
     const result=await updateQuotaRecovery(db,a.space_id,i.run_id,i.auto_continue===true,new Date(),i.switch_model===true);
     await runs.appendRunEvent({run_id:i.run_id,space_id:a.space_id,event_type:'state_transition',status:'succeeded',metadata_json:{action:'quota_recovery_updated',auto_continue:result.auto_continue,switched_model:result.switched_model??null}});
     return base;
    }
    case 'run.live_input.submit':{
     const out=await recordRunLiveInput(db,config,p,i.run_id,i.binding_id!,i.content!);
     return {...base,id:out.message_id,message_id:out.message_id,binding_id:i.binding_id!};
    }
   }
  },
  ...(['run.stop','run.abandon','run.finalize','run.live_input.submit'].includes(id)?{async afterCommit(raw:unknown,a:OperationActor){
   const out=raw as {run_id:string;message_id?:string;binding_id?:string},pool=getDbPool(config.databaseUrl!);
   const run=await new PgRunRepository(pool,config).getRun(a.space_id,out.run_id);
   if(!run)return;
   // Process, Host and finalization work runs on the committed state, outside any transaction.
   // Each is recovered if this process stops first: stale cancelling Runs and owed finalizations are swept.
   if(id==='run.stop'){
    // The person's reason was frozen with the cancellation intent.
    const recorded=(run.error_json as {error_code?:string;error_text?:string}|null);
    const reason=recorded?.error_code==='run_cancel_requested'&&recorded.error_text!=='Run cancellation requested.'?recorded.error_text??null:null;
    await buildRunOrchestration(config).orchestration.cancelRun({run_id:out.run_id,space_id:a.space_id,requested_by_user_id:a.on_behalf_of_user_id,reason});
   }
   else if(id==='run.live_input.submit')await deliverRunLiveInput(pool,config,person(a),out.run_id,out.binding_id!,out.message_id!);
   else await RunMaterializationService.fromConfig(config).finalizeRun(run);
  }}:{}),
  classifyError(e){
   if(e instanceof RunCommandRefusal||e instanceof LiveInputRefusal||e instanceof RoomMutationError)return markedRefusal(e,'runs');
   return undefined;
  },
 }));
}

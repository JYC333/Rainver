import {AUTOMATION_FIRE_JOB,type AutomationFireReceipt} from '@rainver/protocol';
import type {Queryable} from '../routeUtils/common.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {AutomationTargetExecutionContext} from './targetRegistry.js';
import {automationFireSnapshot} from './fireSnapshot.js';
/** Manual core and scheduled cursor owners both commit this same intent. */
export async function enqueueAutomationFire(db:Queryable,c:AutomationTargetExecutionContext):Promise<AutomationFireReceipt>{
 const a=c.automation,i=c.fireInput;
 const input={space_id:a.space_id,automation_id:a.id,...(i.prompt!=null?{prompt:i.prompt}:{}),...(i.instruction!=null?{instruction:i.instruction}:{})};
 const snapshot=await automationFireSnapshot(db,c);
 const job=await new PgJobQueueRepository(db).enqueue({job_type:AUTOMATION_FIRE_JOB,space_id:a.space_id,user_id:i.actorUserId,max_attempts:1,
  payload:{input,snapshot,trigger_type:c.triggerType,trigger_context:i.triggerContext??null,schedule_slot:c.triggerType==='schedule'?a.next_run_at:null}});
 return {space_id:a.space_id,automation_id:a.id,job_id:job.id,status:'pending'};
}

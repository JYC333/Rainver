import {AUTOMATION_FIRE_JOB,AutomationFireInputSchema,AutomationFireRequestSchema,type RegisteredSystemActionDefinition,type AutomationFireReceipt} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {dbPool,HttpError,params,resolveIdentity,sendRouteError,withQueryableTransaction} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {enqueueAutomationFire} from './fireIntent.js';
import {lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {executeSourceDispatch} from '../sources/sourceDispatchExecution.js';
import {AutomationService} from './service.js';
import {PgAutomationRepository} from './repository.js';
import {lockAutomationFire} from './configurationAuthority.js';
type Input=ReturnType<typeof AutomationFireInputSchema.parse>;
const fireInput=(i:Input,user:string)=>({spaceId:i.space_id,automationId:i.automation_id,actorUserId:user,prompt:i.prompt,instruction:i.instruction,triggerType:'manual'});
type Scope=ResolvedOperation&{context?:Record<string,unknown>};
export function automationFireRegistration(config:ServerConfig,defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 return {definition:defs.get('automation.fire')!,successStatus:202,
  async resolve(_db,raw,a){const i=raw as Input;return {authority:`space:${a.space_id}`,targets:{automation_id:i.automation_id},resourceType:'automation',resourceId:i.automation_id};},
  async authorize(db,raw,a,scope){
   const i=raw as Input;
   (scope as Scope).context=await lockAutomationFire(db,a.space_id,a.on_behalf_of_user_id!,i);
   await AutomationService.forFireAdmissionTransaction(config,db).prepareFire(fireInput(i,a.on_behalf_of_user_id!));
  },
  policyContext(_i,_a,s){return (s as Scope).context;},
  async authorizeResult(db,raw,a){const out=raw as AutomationFireReceipt;
   if(out.space_id!==a.space_id||!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4 AND payload_json->\'input\'->>\'automation_id\'=$5',[out.job_id,a.space_id,a.on_behalf_of_user_id,AUTOMATION_FIRE_JOB,out.automation_id])).rows.length)throw hidden();
  },
  classifyError(e){return e instanceof HttpError?markedRefusal(e,'automations'):undefined;},
  async execute(db,raw,a){
   const input=raw as Input,c=await AutomationService.forFireAdmissionTransaction(config,db).prepareFire(fireInput(input,a.on_behalf_of_user_id!));
   return enqueueAutomationFire(db,c);
  },
 };
}
export function registerAutomationFireJob(registry:JobHandlerRegistry,config:ServerConfig):void{
 if(!config.databaseUrl)return;
 registry.register(AUTOMATION_FIRE_JOB,async job=>{
  const input=AutomationFireInputSchema.parse(job.payload.input);
  if(!job.user_id||input.space_id!==job.space_id||typeof job.payload.snapshot!=='string'||job.max_attempts!==1)throw new Error('Invalid Automation fire Job');
  const trigger=job.payload.trigger_type;
  if(trigger!=='manual'&&trigger!=='schedule')throw new Error('Invalid Automation trigger');
  const db=dbPool(config);
  return executeSourceDispatch(db,job,async()=>{
   const value=await new AutomationService(config,new PgAutomationRepository(db)).fire({...fireInput(input,job.user_id!),triggerType:trigger,triggerContext:job.payload.trigger_context as Record<string,unknown>|null},{snapshot:job.payload.snapshot as string,job,scheduleSlot:typeof job.payload.schedule_slot==='string'?job.payload.schedule_slot:null});
   return withQueryableTransaction(db,async tx=>{
    await lockAutomationFire(tx,job.space_id,job.user_id!,input);
    await lockCurrentJobClaim(tx,job);
    const receipt={value};
    await tx.query('UPDATE jobs SET result_json=$2::jsonb WHERE id=$1',[job.job_id,JSON.stringify(receipt)]);
    return receipt;
   });
  });
 });
}
/** Results contain private Automation/Run content; generic Jobs never release it. */
export function registerAutomationFireResultRoute(app:FastifyInstance,context:ModuleContext):void{
 app.get('/api/v1/spaces/:spaceId/automations/:automationId/fire-requests/:jobId',async(request,reply)=>{
  const p=await resolveIdentity(context.config,request,reply);if(!p)return reply;
  try{
   const out=await withQueryableTransaction(dbPool(context.config),async tx=>{
    const ids=params(request);
    if(ids.spaceId!==p.spaceId)throw hidden();
    const job=(await tx.query<{status:string;payload_json:{input:Input};result_json:{value?:Record<string,unknown>;source_dispatch?:string;effect_started?:boolean}|null}>(
     'SELECT status,payload_json,result_json FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4 AND payload_json->\'input\'->>\'automation_id\'=$5',
     [ids.jobId,p.spaceId,p.userId,AUTOMATION_FIRE_JOB,ids.automationId])).rows[0];
    if(!job)throw new HttpError(404,'Automation fire request not found');
    await lockAutomationFire(tx,p.spaceId,p.userId,job.payload_json.input);
    const value=job.result_json?.value??null;
    const terminal=['failed','cancelled'].includes(job.status);
    const outcome=value?'completed':terminal?(job.result_json?.source_dispatch==='started'?'unknown':'failed'):'pending';
    return AutomationFireRequestSchema.parse({status:job.status,result:value,outcome,error:terminal&&!value?(outcome==='unknown'?'Execution outcome unknown; fire will not be repeated':'Automation fire did not complete'):null});
   });
   return reply.header('cache-control','private, no-store').send(out);
  }catch(e){return sendRouteError(reply,e);}
 });
}

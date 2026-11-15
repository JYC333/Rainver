import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {basename,extname,join} from 'node:path';
import {ACTIVITY_OPERATION_SCHEMAS,type OperationInput,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {applyContentCreationContext,resolveContentCreationContext} from '../access/creationContext.js';
import {dbPool,HttpError,withQueryableTransaction,type Queryable} from '../routeUtils/common.js';
import {sessionActor,assertCurrentActor} from '../systemActions/operations/actor.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {canonical} from '../systemActions/operations/repository.js';
import {enforce} from '../policy/service.js';
import {loadActionRegistry} from '../policy/actionRegistry.js';
import {loadSystemActionRegistry} from '../systemActions/registry.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {JobEffectLeaseLost,lockCurrentJobClaim,withJobEffectAuthority,authorizeJobEffect} from '../jobs/effectAuthority.js';
import {activityCreateRegistration} from './createOperation.js';
import {PgActivityRepository} from './repository.js';

export const ACTIVITY_UPLOAD_JOB='activity_upload';
type Input=OperationInput<'activity.upload'>;
type Metadata=Omit<Input,'content_base64'>;
const identity=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
function bytes(input:Input){
 const out=Buffer.from(input.content_base64,'base64');
 if(!out.length||out.length>25*1024*1024||out.toString('base64')!==input.content_base64)throw new HttpError(422,'Invalid upload bytes');
 return out;
}
function capture(input:Metadata,size:number,path?:string){
 const name=basename(input.filename),voice=input.kind==='voice';
 return {source_type:voice?'voice_capture':'file_capture',project_id:input.project_id,project_folder_id:input.project_id?input.project_folder_id:undefined,
  title:input.title||name||(voice?'Voice capture':'Uploaded file'),
  content:input.note||(voice?`Voice capture (${input.content_type}, ${size} bytes)`:`File capture: ${name||'Uploaded file'} (${input.content_type}, ${size} bytes)`),
  metadata_json:{capture_kind:input.kind,filename:name||null,mime_type:input.content_type,size_bytes:size,...(path?{stored_path:path}:{})}};
}
function hash(input:Input){return createHash('sha256').update(canonical(input)).digest('hex');}
export function activityUploadRegistration(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration{
 const owner=activityCreateRegistration(defs);
 return {
  definition:defs.get('activity.upload')!,userContentCreation:true,successStatus:202,
  normalizeInput(raw){const i={...raw as Input};i.filename=basename(i.filename);if(!i.project_id)delete i.project_folder_id;return i;},
  resolve:owner.resolve,
  async authorize(db,raw,a,scope){const input=raw as Input;await owner.authorize(db,capture(input,bytes(input).length),a,scope);},
  async authorizeResult(db,raw,a){
   const out=raw as {job_id:string;activity_id:string};
   const job=await new PgJobQueueRepository(db).getJob(out.job_id);
   if(!job||job.job_type!==ACTIVITY_UPLOAD_JOB||job.space_id!==a.space_id||job.user_id!==a.on_behalf_of_user_id||job.payload_json.activity_id!==out.activity_id)throw hidden();
   await owner.authorize(db,capture(job.payload_json.metadata as Metadata,Number(job.payload_json.size)),a,{} as ResolvedOperation);
   if(job.status==='completed')await owner.authorizeResult!(db,{space_id:a.space_id,id:out.activity_id},a);
  },
  async execute(db,raw,a){
   const input=raw as Input,data=bytes(input),activity_id=randomUUID(),{content_base64,...metadata}=input;
   const job=await new PgJobQueueRepository(db).enqueue({job_type:ACTIVITY_UPLOAD_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,payload:{activity_id,input_hash:hash(input)},max_attempts:1});
   // These are bounded private transport bytes, not diagnostic evidence.
   // Generic enqueue sanitizes/truncates evidence strings; this named owner
   // keeps exact input only in its newly admitted Job, hidden by Job readers.
   // Scrub the second byte copy in the atomic domain settlement below.
   await db.query('UPDATE jobs SET payload_json=$2::jsonb WHERE id=$1 AND job_type=$3',[job.id,JSON.stringify({input,input_hash:hash(input),metadata,size:data.length,activity_id}),ACTIVITY_UPLOAD_JOB]);
   return {job_id:job.id,activity_id,status:'queued'};
  },
  classifyError:error=>error instanceof HttpError?markedRefusal(error,'activity'):undefined,
 };
}
export function registerActivityUploadJob(registry:JobHandlerRegistry,config:ServerConfig){
 registry.register(ACTIVITY_UPLOAD_JOB,async job=>{
  const pool=dbPool(config),defs=await loadSystemActionRegistry(config),owner=activityCreateRegistration(defs),actor=sessionActor({spaceId:job.space_id,userId:job.user_id!});
  async function admit(tx:Queryable){
   const current=await new PgJobQueueRepository(tx).getJob(job.job_id);
   if(!job.user_id||!current||current.job_type!==ACTIVITY_UPLOAD_JOB||current.space_id!==job.space_id||current.user_id!==job.user_id)throw new JobEffectLeaseLost();
   const input=ACTIVITY_OPERATION_SCHEMAS['activity.upload'].input.parse(current.payload_json.input);
   if(hash(input)!==current.payload_json.input_hash)throw new JobEffectLeaseLost();
   const data=bytes(input);
   await owner.authorize(tx,capture(input,data.length),actor,{} as ResolvedOperation);
   await assertCurrentActor(tx,actor,true);
   await lockCurrentJobClaim(tx,job);
   const policy=await enforce({...config,auditTransaction:tx},await loadActionRegistry(config),{action:'activity.upload',force_record:true,actor_type:'user',actor_id:job.user_id,space_id:job.space_id,resource_space_id:job.space_id,resource_type:'space',resource_id:job.space_id});
   if(policy.status!=='allow'||!policy.policy_decision_record_id)throw hidden();
   return {input,data,activityId:String(current.payload_json.activity_id)};
  }
  let storedPath:string|undefined,fileWritten=false;
  try{
  const frozen=await withQueryableTransaction(pool,async tx=>{
   const admitted=await admit(tx);
   const started=await tx.query(`UPDATE jobs SET result_json=COALESCE(result_json,'{}'::jsonb)||'{"source_dispatch":"started"}'::jsonb WHERE id=$1 AND NOT(COALESCE(result_json,'{}'::jsonb) ? 'source_dispatch') RETURNING id`,[job.job_id]);
   if(!started.rows.length)throw new JobEffectLeaseLost('Upload already started; no replacement file write');
   return admitted;
  });
  const storedName=job.job_id+extname(basename(frozen.input.filename)).slice(0,16),relative=job.space_id+'/'+storedName;
  const directory=join(config.rainverHome,'storage','uploads',job.space_id);
  // This is transport storage, never a domain transaction or trusted client path.
  // A single-attempt, claim-authorized write may leave an unreachable file after
  // a crash/uncertain commit; it cannot create an unaudited Activity or resend.
  storedPath=join(directory,storedName);
  await mkdir(directory,{recursive:true});
  return await withJobEffectAuthority(pool,job,async()=>{
   await authorizeJobEffect();
   await writeFile(join(directory,storedName),frozen.data,{flag:'wx',mode:0o600});
   fileWritten=true;
   return withQueryableTransaction(pool,async tx=>{
    const current=await admit(tx);
    if(hash(current.input)!==hash(frozen.input)||current.activityId!==frozen.activityId)throw new JobEffectLeaseLost();
    const creation=await resolveContentCreationContext(tx,{userId:job.user_id!,requestSpaceId:job.space_id,projectId:current.input.project_id});
    const activity=await new PgActivityRepository(tx).create(identity(actor),applyContentCreationContext(capture(current.input,current.data.length,relative),creation),current.activityId);
    await owner.authorizeResult!(tx,activity,actor);
    const result={activity_id:activity.id};
    // Do not retain a second byte archive in generic Job payloads.
    await tx.query("UPDATE jobs SET payload_json=payload_json-'input' WHERE id=$1",[job.job_id]);
    if(!await new PgJobQueueRepository(tx).completeJob(job.job_id,result,job.worker_id))throw new JobEffectLeaseLost();
    return result;
   });
  },async()=>{await withQueryableTransaction(pool,async tx=>{await admit(tx);});});
  }catch(error){
   // Resolve an uncertain commit under the same Job lock before removing
   // transport storage. If the database cannot prove absence, retain the file.
   const unreferenced=await withQueryableTransaction(pool,async tx=>{
    const current=(await tx.query<{status:string;claimed_by:string|null;attempts:number;max_attempts:number;payload_json:Record<string,unknown>;result_json:Record<string,unknown>}>(
     'SELECT status,claimed_by,attempts,max_attempts,payload_json,result_json FROM jobs WHERE id=$1 AND job_type=$2 AND space_id=$3 FOR UPDATE',
     [job.job_id,ACTIVITY_UPLOAD_JOB,job.space_id])).rows[0];
    if(!current)return false;
    const activityId=current.payload_json.activity_id;
    if(typeof activityId!=='string'||activityId!==job.payload.activity_id)return false;
    const committedActivity=!!(await tx.query('SELECT id FROM activity_records WHERE id=$1 AND space_id=$2',[activityId,job.space_id])).rows.length;
    const terminal=['completed','failed','cancelled'].includes(current.status);
    const owned=current.status==='running'&&current.claimed_by===job.worker_id&&current.attempts===job.attempts;
    // An exact owned single attempt/started dispatch cannot resend. A stale
    // worker never erases another live owner's transport, even after its I/O.
    if(terminal||committedActivity||(owned&&(current.attempts>=current.max_attempts||current.result_json.source_dispatch==='started')))
     await tx.query("UPDATE jobs SET payload_json=payload_json-'input' WHERE id=$1",[job.job_id]);
    return !committedActivity;
   }).catch(()=>false);
   if(unreferenced&&fileWritten&&storedPath)await unlink(storedPath).catch(()=>undefined);
   throw error;
  }
 });
}

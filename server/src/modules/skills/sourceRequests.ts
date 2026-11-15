import {SKILL_IO_JOB,SKILL_IO_OPERATION_SCHEMAS,SkillImportRequestSchema,SkillImportPreviewRequestSchema,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {FastifyInstance} from 'fastify';
import type {ServerConfig} from '../../config.js';
import type {ModuleContext} from '../../gateway/routeRegistry.js';
import {dbPool,HttpError,params,resolveIdentity,sendRouteError,withQueryableTransaction,type Queryable,type SpaceUserIdentity} from '../routeUtils/common.js';
import {lockActivePerson} from '../access/activePerson.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {lockCurrentJobClaim} from '../jobs/effectAuthority.js';
import type {JobHandlerRegistry} from '../jobs/handlerRegistry.js';
import {executeSourceDispatch} from '../sources/sourceDispatchExecution.js';
import {assertSkillHostAccess,scanHostSkillSource} from './skillHostImport.js';
import {resolveSkillImportPreview} from './service.js';
import {PgSkillsRepository} from './repository.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Kind=keyof typeof SKILL_IO_OPERATION_SCHEMAS;
type Source=Record<string,unknown>;

async function authorizeSource(db:Queryable,config:ServerConfig,p:SpaceUserIdentity,input:Source){
 await lockActivePerson(db,p.spaceId,p.userId);
 if(typeof input.host_id==='string')await assertSkillHostAccess(config,p,input.host_id,db);
}
export function skillSourceRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>,config:ServerConfig):OperationRegistration[]{
 return (Object.keys(SKILL_IO_OPERATION_SCHEMAS) as Kind[]).map(id=>({
  definition:defs.get(id)!,successStatus:202,
  async resolve(_db,raw,a){const i=raw as Source;return {authority:`space:${a.space_id}`,targets:{host_id:i.host_id??null},resourceType:'skill_source',resourceId:typeof i.host_id==='string'?i.host_id:null};},
  async authorize(db,raw,a){await authorizeSource(db,config,person(a),raw as Source);},
  async authorizeResult(db,raw,a){const out=raw as {space_id:string;job_id:string};
   if(out.space_id!==a.space_id||!(await db.query('SELECT id FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',[out.job_id,a.space_id,a.on_behalf_of_user_id,SKILL_IO_JOB])).rows.length)throw hidden();
  },
  classifyError(e){return e instanceof HttpError?markedRefusal(e,'skills'):undefined;},
  async execute(db,raw,a){
   const job=await new PgJobQueueRepository(db).enqueue({job_type:SKILL_IO_JOB,space_id:a.space_id,user_id:a.on_behalf_of_user_id!,max_attempts:1,payload:{kind:id,input:raw}});
   return {space_id:a.space_id,job_id:job.id,status:'pending'};
  },
 }));
}

/** One external attempt. A crashed/unknown acquisition is never retried. The
 * immutable package and derived receipt settle under the queue's current
 * claim in the same short transaction, after IO and current authority checks. */
export function registerSkillSourceJob(registry:JobHandlerRegistry,config:ServerConfig){
 if(!config.databaseUrl)return;
 registry.register(SKILL_IO_JOB,async job=>{
  const kind=job.payload.kind as Kind,schema=SKILL_IO_OPERATION_SCHEMAS[kind];
  if(!schema||!job.user_id)throw new Error('Invalid Skill source Job');
  const input=schema.input.parse(job.payload.input) as Source,db=dbPool(config),p={spaceId:job.space_id,userId:job.user_id};
  return executeSourceDispatch(db,job,async()=>{
   await withQueryableTransaction(db,tx=>authorizeSource(tx,config,p,input));
   let value:unknown;
   let preview:Awaited<ReturnType<typeof resolveSkillImportPreview>>|undefined;
   if(kind==='skill.source.scan')value=await scanHostSkillSource(config,p,String(input.host_id));
   else {
    const source=kind==='skill.source.import'?SkillImportRequestSchema.parse(input):SkillImportPreviewRequestSchema.parse(input);
    const {package_hash:_hash,...acquisition}=source as Source;
    preview=await resolveSkillImportPreview(acquisition,undefined,p,config);
    if(kind==='skill.source.import'&&preview.package_hash!==input.package_hash)throw new HttpError(409,'Skill package changed since preview');
    const {raw_content:_raw,package_contents:_contents,...safe}=preview;value=safe;
   }
   return withQueryableTransaction(db,async tx=>{
    await authorizeSource(tx,config,p,input);
    await lockCurrentJobClaim(tx,job);
    if(kind==='skill.source.import')value=await new PgSkillsRepository(tx).saveImportedSkill(p,preview!);
    const receipt={value};
    await tx.query('UPDATE jobs SET result_json=$2::jsonb WHERE id=$1',[job.job_id,JSON.stringify(receipt)]);
    return receipt;
   });
  });
 });
}

/** A Job is a private receipt, not perpetual Host authority. The generic Job
 * reader hides these results; this reader pins current person/Host authority. */
export function registerSkillSourceResultRoute(app:FastifyInstance,context:ModuleContext){
 app.get('/api/v1/skill-sources/requests/:jobId',async(request,reply)=>{
  const identity=await resolveIdentity(context.config,request,reply);if(!identity)return reply;
  try{
   const result=await withQueryableTransaction(dbPool(context.config),async tx=>{
    const job=(await tx.query<{status:string;error:string|null;payload_json:{input:Source};result_json:{value?:unknown}|null}>(
     'SELECT status,error,payload_json,result_json FROM jobs WHERE id=$1 AND space_id=$2 AND user_id=$3 AND job_type=$4',
     [params(request).jobId,identity.spaceId,identity.userId,SKILL_IO_JOB])).rows[0];
    if(!job)throw new HttpError(404,'Skill source request not found');
    await authorizeSource(tx,context.config,identity,job.payload_json.input);
    return {status:job.status,result:job.status==='completed'?job.result_json?.value??null:null,
      error:job.error==='Skill package changed since preview'?{code:'skill_package_changed',message:'Skill package changed since preview'}:null};
   });
   return reply.header('cache-control','private, no-store').send(result);
  }catch(error){return sendRouteError(reply,error);}
 });
}

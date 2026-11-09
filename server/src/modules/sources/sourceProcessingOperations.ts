import {canReadAgent} from '../agents/agentAccess.js';
import type {OperationActor,RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {ServerConfig} from '../../config.js';
import {HttpError,dbPool,type Queryable} from '../routeUtils/common.js';
import {PgAgentRepository} from '../agents/repository.js';
import {PgJobQueueRepository} from '../jobs/repository.js';
import {assertProjectReadableLocked,assertProjectWriter,assertProjectWriterForMutation,lockActiveProjectForMutation} from '../projects/access.js';
import {hidden,OperationBusinessError} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {discoverMonitorParent,lockMonitorParent,SourceMonitorScopeConflict,type MonitorParent} from './sourceMonitorParent.js';
import {SourcePostProcessingService} from './postProcessing/service.js';
import {sourceProcessingRuleFingerprint,PgSourcePostProcessingRepository} from './postProcessing/repository.js';
import {SourceProcessingInputError} from './postProcessing/commandErrors.js';
import {SourceGovernanceInputError} from './sourceConsent.js';
import {sourceJobReadableClause} from './sourceJobAccess.js';
import {assertSourceConnectionReadable} from './sourceConnectionAccess.js';
const ids=['source.processing.rule.create','source.processing.rule.update','source.processing.rule.dispatch','source.extraction.dispatch'] as const;
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Input={source_channel_id?:string;rule_id?:string;mode?:'run'|'drain';rule?:Record<string,unknown>;changes?:Record<string,unknown>;extraction_job_id?:string};
type Job={id:string;connection_id:string|null;source_item_id:string|null;job_type:string;status:string;effective_connection_id:string|null;item_project_id:string|null};
async function job(db:Queryable,a:OperationActor,id:string){const r=(await db.query<Job>(`SELECT id,connection_id,source_item_id,job_type,status,COALESCE(connection_id,(SELECT connection_id FROM source_items WHERE id=extraction_jobs.source_item_id AND space_id=extraction_jobs.space_id)) AS effective_connection_id,(SELECT project_id FROM source_items WHERE id=extraction_jobs.source_item_id AND space_id=extraction_jobs.space_id) AS item_project_id FROM extraction_jobs WHERE id=$1 AND space_id=$2 AND ${sourceJobReadableClause('extraction_jobs','$3',false)}`,[id,a.space_id,a.on_behalf_of_user_id])).rows[0];if(!r)throw hidden();return r;}
export function sourceProcessingRegistrations(config:ServerConfig,defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 const repository=new PgAgentRepository(dbPool(config));
 // PgAgentRepository's general constructor requires a Pool. Only its audited
 // transaction writers are exposed to Source command work, never that Pool.
 const agents={createInTransaction:repository.createInTransaction.bind(repository),publishSystemManagedPromptInTransaction:repository.publishSystemManagedPromptInTransaction.bind(repository)};
 return ids.map(id=>({definition:defs.get(id)!,successStatus:id.endsWith('create')?201:id.endsWith('dispatch')?202:200,
  async resolve(db,raw,a){const i=raw as Input;
   if(i.extraction_job_id){const target=await job(db,a,i.extraction_job_id);const parent=target.effective_connection_id?await discoverExtractionParent(db,a,{...target,connection_id:target.effective_connection_id}):null;return {authority:`extraction_job:${target.id}`,targets:{extraction_job_id:target.id},resourceType:'extraction_job',resourceId:target.id,target,parent};}
   const channel=i.source_channel_id!,r=i.rule_id?await new PgSourcePostProcessingRepository(db).getRule(a.space_id,i.rule_id):null;
   if(i.rule_id&&(!r||r.source_channel_id!==channel))throw hidden();
   const ref=(await db.query<{source_connection_id:string}>('SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2',[channel,a.space_id])).rows[0];if(!ref)throw hidden();
   const parent=await discoverMonitorParent(db,person(a),ref.source_connection_id);
   return {authority:`source_processing:${channel}`,targets:{source_channel_id:channel,...(i.rule_id?{rule_id:i.rule_id}:{})},resourceType:'source_channel',resourceId:channel,parent,ruleProject:r?.project_id??null};
  },
  async authorize(db,raw,a,resolved){const i=raw as Input,s=resolved as typeof resolved&{parent:MonitorParent|null;target?:Job;ruleProject?:string|null};
   if(i.extraction_job_id){const expected=s.target!;
    if(expected.job_type!=='connection_scan')for(const p of [...new Set([s.parent?.project_id,expected.item_project_id].filter((x):x is string=>!!x))].sort())await assertProjectReadableLocked(db,a.space_id,p,person(a).userId);
    if(s.parent){if(expected.job_type==='connection_scan')await lockMonitorParent(db,person(a),s.parent);else{await db.query('SELECT id FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL FOR SHARE',[s.parent.id,a.space_id]);await assertSourceConnectionReadable(db,person(a),s.parent.id);const actual=await discoverExtractionParent(db,a,{...expected,connection_id:s.parent.id});if(actual.project_id!==s.parent.project_id||actual.visibility!==s.parent.visibility||actual.owner_user_id!==s.parent.owner_user_id)throw new SourceMonitorScopeConflict();}}
    if(expected.source_item_id)await db.query('SELECT id FROM source_items WHERE id=$1 AND space_id=$2 FOR SHARE',[expected.source_item_id,a.space_id]);
    await db.query('SELECT id FROM extraction_jobs WHERE id=$1 AND space_id=$2 FOR UPDATE',[expected.id,a.space_id]);
    const current=await job(db,a,expected.id);if(current.connection_id!==expected.connection_id||current.source_item_id!==expected.source_item_id||current.effective_connection_id!==expected.effective_connection_id||current.item_project_id!==expected.item_project_id)throw new SourceMonitorScopeConflict();return;
   }
   const parent=s.parent!,body=i.rule??i.changes??{},projects=[...new Set([parent.project_id,s.ruleProject,typeof body.project_id==='string'?body.project_id:null].filter((x):x is string=>!!x))].sort();
   for(const p of projects){await assertProjectWriter(db,a.space_id,p,person(a).userId,{allowArchived:true});try{await lockActiveProjectForMutation(db,a.space_id,p);}catch(e){if(e instanceof HttpError&&e.statusCode===409)throw new SourceMonitorScopeConflict();throw e;}await assertProjectWriterForMutation(db,a.space_id,p,person(a).userId);}
   await lockMonitorParent(db,person(a),parent);
   const child=(await db.query('SELECT id FROM source_channels WHERE id=$1 AND space_id=$2 AND source_connection_id=$3 FOR SHARE',[i.source_channel_id,a.space_id,parent.id])).rows[0];if(!child)throw new SourceMonitorScopeConflict();
   if(i.rule_id){await db.query('SELECT id FROM source_post_processing_rules WHERE id=$1 AND space_id=$2 FOR UPDATE',[i.rule_id,a.space_id]);const r=await new PgSourcePostProcessingRepository(db).getRule(a.space_id,i.rule_id);if(!r||r.source_channel_id!==i.source_channel_id)throw hidden();if(r.project_id!==s.ruleProject)throw new SourceMonitorScopeConflict();if(!await canReadAgent(db,person(a),r.agent_id))throw hidden();}
  },
  async authorizeResult(db,raw,a){const r=raw as {id?:string;project_id?:string|null;source_channel_id:string|null;extraction_job_id?:string|null};if(r.id){const current=await new PgSourcePostProcessingRepository(db).getRule(a.space_id,r.id);if(!current||current.source_channel_id!==r.source_channel_id)throw hidden();if(current.project_id!==r.project_id)throw new SourceMonitorScopeConflict();if(current.project_id)await assertProjectWriter(db,a.space_id,current.project_id,person(a).userId);}if(r.extraction_job_id){await job(db,a,r.extraction_job_id);return;}if(r.source_channel_id){const conn=(await db.query<{source_connection_id:string}>('SELECT source_connection_id FROM source_channels WHERE id=$1 AND space_id=$2',[r.source_channel_id,a.space_id])).rows[0];if(!conn)throw hidden();await discoverMonitorParent(db,person(a),conn.source_connection_id);}},
  async execute(db,raw,a){const i=raw as Input,service=new SourcePostProcessingService(db,config,agents);
   if(id==='source.processing.rule.create')return service.createRule(person(a),i.source_channel_id!,i.rule!);
   if(id==='source.processing.rule.update')return service.updateRule(person(a),i.source_channel_id!,i.rule_id!,i.changes!);
   const target=i.extraction_job_id?await job(db,a,i.extraction_job_id):null;
   if(target?.status==='running')throw new OperationBusinessError('operation_conflict',409,'sources');
   if(target&&target.status!=='pending')return {job_id:null,status:'noop',source_channel_id:null,extraction_job_id:target.id,extraction_status:target.status};
   if(target){const existing=(await db.query<{id:string}>("SELECT id FROM jobs WHERE space_id=$1 AND user_id=$2 AND job_type='source_extraction_manual' AND payload_json->>'extraction_job_id'=$3 AND status IN ('pending','claimed','running') ORDER BY created_at LIMIT 1",[a.space_id,person(a).userId,target.id])).rows[0];if(existing)return {job_id:existing.id,status:'pending',source_channel_id:null,extraction_job_id:target.id,extraction_status:target.status};}
   const queued=await new PgJobQueueRepository(db).enqueue({space_id:a.space_id,user_id:person(a).userId,job_type:target?'source_extraction_manual':'source_post_processing_event',max_attempts:1,payload:target?{extraction_job_id:target.id,user_id:person(a).userId}:{phase:'manual_dispatch',user_id:person(a).userId,source_channel_id:i.source_channel_id,rule_id:i.rule_id,mode:i.mode,expected_config_sha256:sourceProcessingRuleFingerprint((await new PgSourcePostProcessingRepository(db).getRule(a.space_id,i.rule_id!))!)}});
   return {job_id:queued.id,status:'pending',source_channel_id:i.source_channel_id??null,extraction_job_id:target?.id??null,extraction_status:target?.status??null};
  },
  classifyError(e){if(e instanceof SourceMonitorScopeConflict)return e;if(e instanceof SourceProcessingInputError||e instanceof SourceGovernanceInputError)return new OperationBusinessError('operation_invalid_input',422,'sources');return undefined;}
 }));
}
async function discoverExtractionParent(db:Queryable,a:OperationActor,target:Job):Promise<MonitorParent>{
 if(target.job_type==='connection_scan')return discoverMonitorParent(db,person(a),target.connection_id!);
 await assertSourceConnectionReadable(db,person(a),target.connection_id!);
 const row=(await db.query<MonitorParent>('SELECT id,project_id,owner_user_id,visibility FROM source_connections WHERE id=$1 AND space_id=$2 AND deleted_at IS NULL',[target.connection_id,a.space_id])).rows[0];if(!row)throw hidden();return row;
}
